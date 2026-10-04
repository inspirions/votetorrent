/**
 * invite-share.ts - parse a pasted invitation share and resolve its InviteSlot.
 *
 * Why the slot Cid must be RESOLVED: the share carries {invitePrivate, inviteKey, expiration, type,
 * name}, but the slot Cid digests ElectionId, InviteSignature and SigningNonce, which the share does
 * not carry. The invitee therefore cannot recompute it; it is looked up engine-side by
 * (InviteKey, Type) via `IInvitationEngine.resolveInviteSlotCid`.
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

export type InviteShareErrorCode = 'malformed' | 'wrong-type' | 'not-found';

const MESSAGES: Record<InviteShareErrorCode, string> = {
	malformed: 'Invitation text is malformed',
	'wrong-type': 'Invitation is for a different role',
	'not-found': 'Invitation not found on this device',
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
	engine: Pick<IInvitationEngine, 'resolveInviteSlotCid'>,
	text: string,
	expectedType: InviteType
): Promise<{ slotCid: string; invitePrivate: string; share: ParsedInviteShare }> {
	const share = parseInviteShare(text);
	if (!share) throw new InviteShareError('malformed');
	if (share.type !== undefined && share.type !== expectedType) throw new InviteShareError('wrong-type');
	const slotCid = await engine.resolveInviteSlotCid(share.inviteKey, expectedType);
	if (!slotCid) throw new InviteShareError('not-found');
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
	}
}
