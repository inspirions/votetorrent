/**
 * invite-share.ts - parse a pasted invitation share and resolve its InviteSlot.
 *
 * Why the slot Cid must be RESOLVED: the share carries {invitePrivate, inviteKey, expiration, type,
 * name}, but the slot Cid digests ElectionId, InviteSignature and SigningNonce, which the share does
 * not carry. The invitee therefore cannot recompute it; it is looked up engine-side by
 * (InviteKey, Type) via `IInvitationEngine.resolveInviteSlot`, which resolves a resent share to the
 * live head of its resend chain (62-REVIEW.md CR-01) and reports a withdrawn or expired share as
 * `no-longer-valid` instead of handing back a stale slot (CR-02).
 *
 * Cross-device precondition: the lookup only finds a slot whose InviteSlot row is present in this
 * device's database. Replication of that row to the invitee's strand is a separate (P2P) concern.
 *
 * No-raw-text rule: error messages are FIXED strings per code. They never include the key, the Cid,
 * or the name, and nothing in this module logs share content.
 */

import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js';
import type { IInvitationEngine, InviteType } from '@votetorrent/vote-core';

export type InviteShareErrorCode = 'malformed' | 'wrong-type' | 'not-found' | 'already-answered' | 'no-longer-valid';

const MESSAGES: Record<InviteShareErrorCode, string> = {
	malformed: 'Invitation text is malformed',
	'wrong-type': 'Invitation is for a different role',
	'not-found': 'Invitation not found on this device',
	'already-answered': 'Invitation has already been answered',
	'no-longer-valid': 'Invitation was withdrawn or has expired',
};

export class InviteShareError extends Error {
	readonly code: InviteShareErrorCode;
	constructor(code: InviteShareErrorCode) {
		super(MESSAGES[code]);
		this.name = 'InviteShareError';
		this.code = code;
	}
}

export interface ParsedInviteShare {
	invitePrivate: string;
	inviteKey: string;
	type?: InviteType;
	name?: string;
}

const HEX64 = /^[0-9a-f]{64}$/i;
const TYPES: readonly string[] = ['au', 'of', 'k', 'r'];

function deriveInviteKey(invitePrivate: string): string | undefined {
	if (!HEX64.test(invitePrivate)) return undefined;
	try {
		return bytesToHex(secp256k1.getPublicKey(hexToBytes(invitePrivate)));
	} catch {
		return undefined;
	}
}

export function parseInviteShare(text: string): ParsedInviteShare | undefined {
	const trimmed = (text ?? '').trim();
	if (!trimmed) return undefined;

	if (HEX64.test(trimmed)) {
		const inviteKey = deriveInviteKey(trimmed);
		return inviteKey ? { invitePrivate: trimmed, inviteKey } : undefined;
	}

	let obj: unknown;
	try {
		obj = JSON.parse(trimmed);
	} catch {
		return undefined;
	}
	if (typeof obj !== 'object' || obj === null) return undefined;
	const rec = obj as Record<string, unknown>;
	if (typeof rec.invitePrivate !== 'string') return undefined;
	const derived = deriveInviteKey(rec.invitePrivate);
	if (!derived) return undefined;
	if (rec.inviteKey !== undefined && (typeof rec.inviteKey !== 'string' || rec.inviteKey.toLowerCase() !== derived.toLowerCase())) {
		return undefined;
	}
	const parsed: ParsedInviteShare = { invitePrivate: rec.invitePrivate, inviteKey: derived };
	if (typeof rec.type === 'string' && TYPES.includes(rec.type)) parsed.type = rec.type as InviteType;
	if (typeof rec.name === 'string') parsed.name = rec.name;
	return parsed;
}

export async function resolveInviteFromShare(
	engine: Pick<IInvitationEngine, 'resolveInviteSlot' | 'getKeyholderInvite' | 'getOfficerInvite' | 'getAuthorityInvite'>,
	text: string,
	expectedType: InviteType
): Promise<{ slotCid: string; invitePrivate: string; share: ParsedInviteShare }> {
	const share = parseInviteShare(text);
	if (!share) throw new InviteShareError('malformed');
	if (share.type !== undefined && share.type !== expectedType) throw new InviteShareError('wrong-type');
	const resolution = await engine.resolveInviteSlot(share.inviteKey, expectedType);
	let slotCid: string;
	switch (resolution.status) {
		case 'live':
			slotCid = resolution.cid;
			break;
		case 'answered':
			throw new InviteShareError('already-answered');
		case 'no-longer-valid':
			throw new InviteShareError('no-longer-valid');
		case 'not-found':
		case 'ambiguous':
			throw new InviteShareError('not-found');
		default: {
			// A future status must never fall through to success.
			const _exhaustive: never = resolution;
			void _exhaustive;
			throw new InviteShareError('not-found');
		}
	}
	// Refuse an already-answered slot (accepted OR declined) BEFORE any caller provisions keys or
	// signs: respondToInvite does not refuse it up front, so the biometric prompts would fire first.
	const status =
		expectedType === 'k'
			? await engine.getKeyholderInvite(slotCid)
			: expectedType === 'of'
				? await engine.getOfficerInvite(slotCid)
				: expectedType === 'au'
					? await engine.getAuthorityInvite(slotCid)
					: undefined;
	if (status?.result !== undefined) throw new InviteShareError('already-answered');
	return { slotCid, invitePrivate: share.invitePrivate, share };
}

export function inviteShareErrorKey(err: unknown): string | undefined {
	if (!(err instanceof InviteShareError)) return undefined;
	switch (err.code) {
		case 'malformed':
			return 'invitationAcceptMalformed';
		case 'wrong-type':
			return 'invitationAcceptWrongType';
		case 'not-found':
			return 'invitationAcceptNotFound';
		case 'already-answered':
			return 'invitationAcceptAlreadyAnswered';
		case 'no-longer-valid':
			return 'invitationAcceptNoLongerValid';
	}
}
