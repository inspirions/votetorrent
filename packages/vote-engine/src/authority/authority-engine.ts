import { bytesToHex } from '@noble/curves/utils.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';

// D-06 (Phase 28): Permanent production boot guard — verify-side noble binding check.
// Mirrors device-signer.ts assertion (D-05). Catches a re-split on the verify side.
// NEVER make this __DEV__-only — a release-build regression must be caught.
if (typeof secp256k1.verify !== 'function') {
  throw new Error(
    '@noble/curves secp256k1.verify did not resolve to a function — ' +
    'got ' + typeof secp256k1.verify + '. Metro/Hermes multi-copy binding bug detected.'
  )
}

import { MisuseError, QuereusError } from '@quereus/quereus';
import { Temporal } from 'temporal-polyfill';
import { SigningEngine } from '../signing/signing-engine.js';
import { allocateTid } from '../database/tid-allocator.js';
import { verifySig, verifySigP256 } from '../database/initialize.js';
import { verifyUserKeyMembership } from '../user/verify-user-key.js';
import { UserKeyType } from '@votetorrent/vote-core';
import {
	asText,
	authorityInviteSignedBytes,
	digestToBytes,
	fromCanonicalDatetime,
	nowCanonicalDatetime,
	officerInviteSignedBytes,
	parseJsonOr,
	toCanonicalDatetime,
	verifyAdHocInviteSignature,
} from '../utils.js';
import type { EngineContext } from '../types.js';

// Phase 999.1 D-01/D-02 — Tids for AuthorityEngine mutations are allocated
// through the shared durable, peer-safe allocator (`tid-allocator.ts`,
// namespace 'authority') instead of a process-local `Date.now()`-seeded
// counter. See tid-allocator.ts for the D-07 hybrid seed / D-09
// reserve-before-use / D-10 per-namespace serialization rationale that
// replaces the WR-16/WR-25 heuristic this module used to carry.
import { AdminPromotionError } from '@votetorrent/vote-core';
import type {
	AdminDetails,
	AdminDigestArgs,
	AdminInit,
	AdminPromotionResult,
	Officer,
	OfficerInit,
	OfficerInvite,
	OfficerInviteShare,
	Authority,
	AuthorityDetails,
	AuthorityInvite,
	AuthorityInviteShare,
	IAuthorityEngine,
	IAuthorityCreateOfficerInviteBuilder,
	IAuthorityCreateAuthorityInviteBuilder,
	IAuthorityProposeAdminBuilder,
	IAuthoritySaveInviteWithSigningBuilder,
	InviteStatus,
	Proposal,
	ISigningEngine,
	Scope,
	Signature,
	SentAuthorityInvite,
	InviteResult,
	ThresholdPolicy,
	OfficerSelection,
	ImageRef,
} from '@votetorrent/vote-core';
import {
	AuthorityCreateOfficerInviteBuilder,
	AuthorityCreateAuthorityInviteBuilder,
	AuthorityProposeAdminBuilder,
	AuthoritySaveInviteWithSigningBuilder,
} from './builders/index.js';

/**
 * 57-01 (D-02): one entry in the admin roster covered by the 'rad' digest.
 * `proposedName` mirrors `ProposedOfficer.ProposedName` — the officer's
 * display name, resolved from `User.Name` for `.existing` selections (see
 * `AuthorityEngine.resolveAdminRoster`).
 *
 * 57-13 (CR-01, D-03 amendment — see 57-13-CR01-CARRIER-PROBE.md): `userId`
 * is the stable identity reference the promotion path resolves against
 * instead of the renameable `User.Name` bridge. It is `null` ONLY for
 * `.init` officers, which have no `User` row and are already unpromotable
 * (D-03's original `.init`-officer case). For `.existing` officers it is
 * `selection.existing.userId` — the SAME value the digest now attests to,
 * so a rename between propose and promote can no longer retarget a grant.
 */
export interface AdminRosterEntry {
	proposedName: string;
	userId: string | null;
	title: string;
	scopes: Scope[];
}

/**
 * 57-01 (D-02), CR-02 (57-12): deterministic, byte-stable serialization of
 * an admin roster for the 'rad' digest. Sorted ascending by `proposedName`
 * using a plain ordinal (code-unit) comparison — the same engine-independent
 * three-way comparison shape `applyAdminProposal` already uses for its
 * `sortedOfficers` userId sort — with a fixed per-entry key order
 * (`proposedName`, `userId`, `title`, `scopes`) and `scopes` themselves
 * sorted ascending, so the resulting JSON — and therefore the digest built
 * from it — is independent of caller input order AND of the host runtime's
 * collation data, because the value is digested and independently
 * re-derived on another runtime (Hermes app vs Node/mocha engine tests).
 * Deliberately NOT the schema's single-row, LIMIT-1-style shortcut
 * elsewhere in this codebase, which would digest only the first officer
 * rather than the full roster.
 *
 * 57-13 (CR-01): `userId` is bound as `entry.userId ?? null`, NEVER as a
 * bare `entry.userId` — `JSON.stringify` DROPS keys whose value is
 * `undefined`, which would silently emit two different digest shapes for
 * the same logical roster (T-57-13-05) and reintroduce the exact class of
 * defect this plan closes. The `userId` tiebreak (for the rare equal-name
 * case) uses the SAME ordinal `<`/`>`/`0` three-way shape as the primary
 * `proposedName` sort — introduce no locale-sensitive primitive; 57-12's
 * `roster-digest-determinism.spec.ts` guard fails the suite if one
 * reappears in this file.
 *
 * Deliberately exported as a pure, side-effect-free function (not inlined
 * into `proposeAdmin`) so roster-order determinism and scope-change
 * sensitivity are directly unit-testable without a live `proposeAdmin`
 * round trip — see `authority.spec.ts`'s 'proposeAdmin' D-02 cases.
 * `ProposedAdmin`/`ProposedOfficer`'s composite primary keys (plus
 * `ProposedOfficer.CantDelete`) make a second `proposeAdmin` call against
 * the SAME (authorityId, effectiveAt) structurally impossible, so this pure
 * function is the only place that property is observable in isolation.
 */
export function sortRosterEntries(
	entries: AdminRosterEntry[],
): AdminRosterEntry[] {
	return entries
		.map((entry) => ({
			proposedName: entry.proposedName,
			userId: entry.userId ?? null,
			title: entry.title,
			scopes: [...entry.scopes].sort(),
		}))
		.sort((a, b) => {
			if (a.proposedName < b.proposedName) return -1;
			if (a.proposedName > b.proposedName) return 1;
			const aUserId = a.userId ?? '';
			const bUserId = b.userId ?? '';
			return aUserId < bUserId ? -1 : aUserId > bUserId ? 1 : 0;
		});
}

/**
 * 57-08 (D-01 trigger half): the outcome of `proposeAdmin`'s own attempt to
 * promote its proposal when `startSigningSession` reports `thresholdReached`.
 * Mirrors `SignatureTasksEngine.RegistrantSeedOutcome` / `lastSeedOutcome`'s
 * shape and discipline exactly: public on `AuthorityEngine` so a test or a
 * future UI consumer can read it, deliberately NOT added to `IAuthorityEngine`
 * (no interface change, no UI consumer this round).
 *
 * `proposeAdmin`'s contract is to propose — a proposal that is correctly
 * persisted and correctly signed must survive a promotion that legitimately
 * cannot apply (a typed `AdminPromotionError`, e.g. the D-03 `.init`-officer
 * case), so a refusal is RECORDED here rather than thrown. This field is the
 * channel a caller reads to discover that outcome; it is never silent.
 */
export type AdminProposalPromotionOutcome =
	| { status: 'promoted'; nonce: string; result: AdminPromotionResult }
	| {
			status: 'refused';
			nonce: string;
			reason: AdminPromotionError['reason'];
			proposedName?: string;
	  }
	| {
			// Threshold reached but signatureOrCallback was a bare Signature, not a
			// re-invocable per-digest callback — applyAdminProposal requires a
			// callback because it mints two or three distinct digests (57-07). This
			// is a DISTINCT marker from 'refused' (no AdminPromotionError was ever
			// thrown; the promotion attempt never started). Per Task 1's P8 probe,
			// authority-propose-admin-builder.ts:154 is the one production
			// (non-test, non-mock) caller shaped this way today.
			status: 'skipped-non-callback-signature';
			nonce: string;
	  };

export class AuthorityEngine implements IAuthorityEngine {
	constructor(
		private readonly authority: Authority,
		private readonly ctx: EngineContext,
		private readonly signingEngine: ISigningEngine = new SigningEngine(ctx),
	) {
		this.invitationSpanMinutes = 60;
	}

	private readonly invitationSpanMinutes: number;

	/**
	 * 57-08 (D-01 trigger half) — the most recent outcome of `proposeAdmin`'s
	 * own promotion attempt. Public so a test or a future UI consumer can read
	 * it; NOT part of `IAuthorityEngine` (no interface change, no UI consumer
	 * this round — see {@link AdminProposalPromotionOutcome}'s own doc comment).
	 */
	lastPromotionOutcome?: AdminProposalPromotionOutcome;

	createOfficerInvite(init: OfficerInit): OfficerInviteShare {
		// AUTH-01 (D-01/D-04): hex-encoded secp256k1 key material at the
		// engine API surface. invitePrivateBytes is confined to this block;
		// every downstream consumer sees only the hex form.
		const invitePrivateBytes = secp256k1.utils.randomSecretKey();
		const invitePrivate = bytesToHex(invitePrivateBytes);
		const inviteKey = bytesToHex(secp256k1.getPublicKey(invitePrivateBytes));

		const type = 'of';
		const expiration = Temporal.Now.plainDateTimeISO('UTC')
			.add({ minutes: this.invitationSpanMinutes })
			.toString();

		// D-05: digest formula now uses the unified helper (pipe-join, SHA-256,
		// base64url) matching SQL Digest(). The signing formula below (TextEncoder
		// + secp256k1.sign) is separate — it validates engine-side via
		// context.IsSignatureValid, not via SQL Digest constraints (D-06).
		// WR-10 (17-REVIEW): @noble/curves v2 defaults to prehash:true, so the
		// signed domain here is sha256(sha256(signedBytes)) — deliberately
		// accepted (no pre-migration signatures exist). Verifiers must use
		// noble v2 default options, never { prehash: false }.
		// WR-17 (17-REVIEW): fields are pipe-joined (the canonical form the SQL
		// Digest path uses — D-05) instead of raw-concatenated, so distinct field
		// tuples can no longer serialize to identical signed bytes (boundary
		// ambiguity: name 'A'/title 'BC' vs name 'AB'/title 'C'). scopes is
		// JSON-stringified for an unambiguous array encoding. Phase 6's
		// InviteSignatureValid verification MUST recompute this exact form.
		// IN-25 (17-REVIEW): RESIDUAL AMBIGUITY — a literal '|' inside a free-text
		// field still aliases tuples (name 'A|B'/title 'C' vs name 'A'/title
		// 'B|C'). This matches the existing SQL Digest pipe-join semantics and is
		// accepted for now: '|' is FORBIDDEN in invite name/title values. Phase 6
		// MUST resolve this before freezing InviteSignatureValid — either enforce
		// the '|' ban at the input boundary, or switch the signed encoding to
		// JSON.stringify([fields...]) / length-prefixed (the last cheap moment to
		// change the formula is before the freeze).
		const signedBytes = new TextEncoder().encode(
			[init.name, init.title, JSON.stringify(init.scopes), type, expiration, inviteKey].join('|'),
		);
		const inviteSignature = bytesToHex(secp256k1.sign(sha256(signedBytes), invitePrivateBytes));

		return {
			...init,
			type,
			expiration,
			inviteKey,
			invitePrivate,
			inviteSignature,
		} satisfies OfficerInviteShare;
	}

	createAuthorityInvite(name: string): AuthorityInviteShare {
		// AUTH-01 hex contract — see createOfficerInvite for the lifecycle.
		const invitePrivateBytes = secp256k1.utils.randomSecretKey();
		const invitePrivate = bytesToHex(invitePrivateBytes);
		const inviteKey = bytesToHex(secp256k1.getPublicKey(invitePrivateBytes));

		const type = 'au';
		const expiration = Temporal.Now.plainDateTimeISO('UTC')
			.add({ minutes: this.invitationSpanMinutes })
			.toString();
		// WR-17 (17-REVIEW): pipe-joined canonical form — see createOfficerInvite.
		// IN-25 (17-REVIEW): '|' is FORBIDDEN in the invite name — see the
		// residual-ambiguity note in createOfficerInvite; Phase 6 must resolve
		// before freezing InviteSignatureValid.
		const signedBytes = new TextEncoder().encode([type, name, expiration].join('|'));
		const inviteSignature = bytesToHex(secp256k1.sign(sha256(signedBytes), invitePrivateBytes));

		return {
			name,
			type,
			expiration,
			inviteKey,
			invitePrivate,
			inviteSignature,
		} satisfies AuthorityInviteShare;
	}

	async getAdminDetails(): Promise<AdminDetails> {
		try {
			const adminDB = await this.ctx.db
				.prepare(
					`select A.AuthorityId, A.EffectiveAt, A.ThresholdPolicies
						from Admin A join CurrentAdmin CA on A.AuthorityId = CA.AuthorityId and A.EffectiveAt = CA.EffectiveAt
					where A.AuthorityId = :id`,
				)
				.get({ id: this.authority.id });
			// AUTH-04: guard against missing admin instead of `?.`-ing past it.
			if (!adminDB) {
				throw new Error('Admin not found');
			}
			const officersDB: Officer[] = [];
			for await (const officer of this.ctx.db.eval(
				'select * from Officer where AuthorityId = :id and AdminEffectiveAt = :effectiveAt',
				{
					id: this.authority.id,
					effectiveAt: adminDB.EffectiveAt as string,
				},
			)) {
				officersDB.push({
					userId: officer.UserId as string,
					authorityId: adminDB.AuthorityId as string,
					title: officer.Title as string,
					scopes: parseJsonOr<Scope[]>(officer.Scopes, [], 'Officer.Scopes'),
				});
			}
			// WR-05 (17-REVIEW): Admin's PK is (AuthorityId, EffectiveAt) — there is
			// no Id column to project. Derive a stable composite id instead of
			// reading a never-projected column (which yielded `undefined as string`).
			const admin = {
				id: `${adminDB.AuthorityId as string}:${adminDB.EffectiveAt as string}`,
				authorityId: adminDB.AuthorityId as string,
				effectiveAt: fromCanonicalDatetime(adminDB.EffectiveAt as string),
				officers: officersDB,
				thresholdPolicies: parseJsonOr<ThresholdPolicy[]>(
					adminDB.ThresholdPolicies,
					[],
					'Admin.ThresholdPolicies',
				),
			};
			const proposedAdminDB = await this.ctx.db
				.prepare(
					'select EffectiveAt, ThresholdPolicies from ProposedAdmin where AuthorityId = :id',
				)
				.get({ id: this.authority.id });
			if (!proposedAdminDB) {
				return { admin, proposed: undefined };
			}
			const proposedOfficersDB: OfficerSelection[] = [];
			for await (const officer of this.ctx.db.eval(
				'select * from ProposedOfficer where AuthorityId = :id and AdminEffectiveAt = :effectiveAt',
				{
					id: this.authority.id,
					effectiveAt: proposedAdminDB.EffectiveAt as string,
				},
			)) {
				proposedOfficersDB.push({
					init: {
						name: officer.ProposedName as string,
						title: officer.Title as string,
						scopes: parseJsonOr<Scope[]>(officer.Scopes, [], 'Officer.Scopes'),
					},
				});
			}
			// AUTH-05 / D-22: populate signers from the most recent AdminSigning
			// for scope 'rad' (admin-proposal scope) joined via OfficerSignature.
			// IN-18 (17-REVIEW): Nonce desc tiebreaker — multiple signings can
			// share an AdminEffectiveAt, and without a tiebreaker which session's
			// signers get reported is engine-ordering dependent.
			const signers: string[] = [];
			const signingDB = await this.ctx.db
				.prepare(
					'select Nonce from AdminSigning where AuthorityId = :id and Scope = :scope order by AdminEffectiveAt desc, Nonce desc limit 1',
				)
				.get({ id: this.authority.id, scope: 'rad' });
			if (signingDB?.Nonce) {
				for await (const row of this.ctx.db.eval(
					'select UserId from OfficerSignature where SigningNonce = :nonce',
					{ nonce: signingDB.Nonce as string },
				)) {
					signers.push(row.UserId as string);
				}
			}
			return {
				admin,
				proposed: {
					proposed: {
						officers: proposedOfficersDB,
						effectiveAt: fromCanonicalDatetime(
							proposedAdminDB.EffectiveAt as string,
						),
						thresholdPolicies: parseJsonOr<ThresholdPolicy[]>(
							proposedAdminDB.ThresholdPolicies,
							[],
							'Admin.ThresholdPolicies',
						),
					},
					signers,
				},
			};
		} catch (err) {
			if (err instanceof QuereusError) {
				throw new Error(`Quereus error (code ${err.code}): ${err.message}`);
			} else if (err instanceof MisuseError) {
				throw new Error(`API misuse: ${err.message}`);
			} else {
				throw new Error(`Unknown error getting admin details: ${err}`);
			}
		}
	}

	async getAuthorityInvites(): Promise<
		Array<InviteStatus<SentAuthorityInvite>>
	> {
		try {
			const authorityInvites: Array<SentAuthorityInvite & { cid: string }> = [];
			for await (const invite of this.ctx.db.eval(
				`select Name, Cid from InviteSlot
					join AdminSigning on InviteSlot.SigningNonce = AdminSigning.Nonce
						where AdminSigning.AuthorityId = :id and AdminSigning.Scope = :scope`,
				{ id: this.authority.id, scope: 'iad' },
			)) {
				authorityInvites.push({
					name: invite.Name as string,
					type: 'au',
					cid: invite.Cid as string,
				});
			}

			const acceptedAuthorityInvites: Array<InviteResult & { cid: string }> =
				[];
			for await (const inviteResult of this.ctx.db.eval(
				`select InviteResult.SlotCid, InviteResult.IsAccepted, InviteResult.InviteSignature, InviteResult.InvokedId from InviteResult
					join InviteSlot on InviteResult.SlotCid = InviteSlot.Cid
						join AdminSigning on InviteSlot.SigningNonce = AdminSigning.Nonce
				where AdminSigning.AuthorityId = :id and AdminSigning.Scope = :scope`,
				{ id: this.authority.id, scope: 'iad' },
			)) {
				acceptedAuthorityInvites.push({
					cid: inviteResult.SlotCid as string,
					isAccepted: inviteResult.IsAccepted as boolean,
					invitationSignature: inviteResult.InviteSignature as string,
					invokedId: inviteResult.InvokedId as string | undefined,
				});
			}

			const inviteStatuses: Array<InviteStatus<SentAuthorityInvite>> = [];
			for (const invite of authorityInvites) {
				inviteStatuses.push({
					invite: {
						name: invite.name,
						type: 'au',
					},
					result: (() => {
						const accepted = acceptedAuthorityInvites.find(
							(a) => a.cid === invite.cid,
						);
						if (!accepted) return undefined;
						const { cid, ...resultWithoutCid } = accepted;
						return resultWithoutCid;
					})(),
				});
			}
			return inviteStatuses;
		} catch (err) {
			if (err instanceof QuereusError) {
				throw new Error(`Quereus error (code ${err.code}): ${err.message}`);
			} else if (err instanceof MisuseError) {
				throw new Error(`API misuse: ${err.message}`);
			} else {
				throw new Error(`Unknown error: ${err}`);
			}
		}
	}

	async getDetails(): Promise<AuthorityDetails> {
		try {
			const authorityDB = await this.ctx.db
				.prepare(
					'select Id, Name, DomainName, ImageRef from Authority where Id = :id',
				)
				.get({ id: this.authority.id });
			if (!authorityDB) {
				throw new Error('Authority not found');
			}
			const authority: Authority = {
				id: authorityDB.Id as string,
				name: authorityDB.Name as string,
				domainName: asText(authorityDB.DomainName, 'Authority.DomainName'),
				imageRef: parseJsonOr<ImageRef | undefined>(
					authorityDB.ImageRef,
					undefined,
					'Authority.ImageRef',
				),
			};
			const proposedAuthorityDB = await this.ctx.db
				.prepare(
					'select Name, DomainName from ProposedAuthority where Id = :id',
				)
				.get({ id: this.authority.id });
			if (!proposedAuthorityDB) {
				return { authority, proposed: undefined };
			}
			// AUTH-05 / D-21: populate signers from the most recent AdminSigning
			// for scope 'iad' (invite-authority scope) joined via OfficerSignature.
			// IN-18 (17-REVIEW): Nonce desc tiebreaker — see getAdminDetails.
			const signers: string[] = [];
			const signingDB = await this.ctx.db
				.prepare(
					'select Nonce from AdminSigning where AuthorityId = :id and Scope = :scope order by AdminEffectiveAt desc, Nonce desc limit 1',
				)
				.get({ id: this.authority.id, scope: 'iad' });
			if (signingDB?.Nonce) {
				for await (const row of this.ctx.db.eval(
					'select UserId from OfficerSignature where SigningNonce = :nonce',
					{ nonce: signingDB.Nonce as string },
				)) {
					signers.push(row.UserId as string);
				}
			}
			return {
				authority,
				proposed: {
					proposed: {
						name: proposedAuthorityDB.Name as string,
						domainName: asText(
							proposedAuthorityDB.DomainName,
							'ProposedAuthority.DomainName',
						),
					},
					signers,
				},
			};
		} catch (err) {
			if (err instanceof QuereusError) {
				throw new Error(`Quereus error (code ${err.code}): ${err.message}`);
			} else if (err instanceof MisuseError) {
				throw new Error(`API misuse: ${err.message}`);
			} else if (err instanceof Error) {
				throw err;
			} else {
				throw new Error(`Unknown error: ${err}`);
			}
		}
	}

	/**
	 * 57-01 (D-01 propose side, D-03): resolve each `OfficerSelection` in a
	 * `proposeAdmin` roster into an `AdminRosterEntry`. For `.init`, the
	 * caller-supplied `name`/`title`/`scopes` are taken directly. For
	 * `.existing`, `ProposedOfficer` is keyed by NAME (not userId), so the
	 * display name is resolved from `User.Name` — mirroring the bridge
	 * `ProposedAdministrationScreen.tsx` already uses, not a second one. If
	 * the `User` row is missing, this throws rather than silently
	 * substituting the userId as the name (T-57-05).
	 *
	 * Returns entries UNSORTED, in caller order — callers needing the
	 * digest/serialization form must run the result through
	 * `sortRosterEntries`.
	 */
	private async resolveAdminRoster(
		officers: OfficerSelection[],
	): Promise<AdminRosterEntry[]> {
		const entries: AdminRosterEntry[] = [];
		for (const selection of officers) {
			if (selection.init) {
				entries.push({
					proposedName: selection.init.name,
					userId: null,
					title: selection.init.title,
					scopes: selection.init.scopes,
				});
			} else if (selection.existing) {
				const userDB = await this.ctx.db
					.prepare('select Id, Name, ImageRef from User where Id = :id')
					.get({ id: selection.existing.userId });
				if (!userDB) {
					throw new Error(
						`proposeAdmin: unresolvable officer userId '${selection.existing.userId}' — no matching User row`,
					);
				}
				entries.push({
					proposedName: userDB.Name as string,
					userId: selection.existing.userId,
					title: selection.existing.title,
					scopes: selection.existing.scopes,
				});
			}
		}
		return entries;
	}

	async proposeAdmin(
		admin: Proposal<AdminInit>,
		signatureOrCallback: Signature | ((digest: Uint8Array) => Promise<Signature>),
	): Promise<void> {
		const thresholdPoliciesJson = JSON.stringify(
			admin.proposed.thresholdPolicies,
		);
		const initialSignerId = admin.signers[0];
		if (!initialSignerId) {
			throw new Error('Failed to propose admin: No initial signer');
		}
		const effectiveAtCanon = toCanonicalDatetime(admin.proposed.effectiveAt);
		const tid = await allocateTid(this.ctx.db, 'authority');
		try {
			// 57-01 (D-02): resolve + deterministically sort the roster BEFORE
			// computing the digest, so the digest attests to the FULL roster this
			// proposal revises — never a single-row, first-officer-only shortcut.
			const rosterEntries = sortRosterEntries(
				await this.resolveAdminRoster(admin.proposed.officers),
			);
			const officersJson = JSON.stringify(rosterEntries);

			// D-03/D-04: resolve the canonical digest ENGINE-SIDE first — needed both to
			// hand a sign callback the exact bytes to sign, and (D-21) to independently
			// re-verify whatever Signature ends up bound, including a pre-supplied one.
			const digestRow = await this.ctx.db
				.prepare(
					'select Digest(:authorityId, :effectiveAt, :officers, :thresholdPolicies) as d',
				)
				.get({
					authorityId: this.authority.id,
					effectiveAt: effectiveAtCanon,
					officers: officersJson,
					thresholdPolicies: thresholdPoliciesJson,
				});
			if (!digestRow || digestRow.d == null) {
				throw new Error('proposeAdmin: Digest() returned null — crypto plugin not registered?');
			}
			// WR-01: single shared digestToBytes decoder.
			const digestBytes = digestToBytes(digestRow.d);

			// If a sign callback is provided, invoke it so the caller signs exactly the
			// bytes the engine stores. If a completed Signature is passed (test fixture
			// path), use it directly — either way `digestRow.d`/`digestBytes` above are
			// the SAME bytes the signature must cover, per D-21 verification below.
			let signature: Signature;
			if (typeof signatureOrCallback === 'function') {
				signature = await signatureOrCallback(digestBytes);
			} else {
				signature = signatureOrCallback;
			}

			// D-21 (Class A): compute a REAL IsUserValid — the conjunction of registered/
			// unexpired key membership AND a curve-dispatched signature verification over
			// the digest already computed above. Replaces the prior literal `true`.
			const membership = await verifyUserKeyMembership(
				this.ctx,
				signature.signerUserId,
				signature.signerKey,
			);
			const signatureValid = membership.keyType === UserKeyType.p256
				? verifySigP256(digestRow.d, signature.signature, signature.signerKey)
				: verifySig(digestRow.d, signature.signature, signature.signerKey);
			const isUserValid = membership.valid && signatureValid;

			// 57-01 (D-01 propose side, T-57-04): ProposedAdmin + its roster commit
			// atomically. ProposedAdmin MUST land first — ProposedOfficer.AdminValid
			// requires the matching ProposedAdmin row to already exist. COMMIT here,
			// BEFORE calling signingEngine.startSigningSession below — Quereus's
			// transaction model is flat and startSigningSession calls sign(), which
			// opens its own transaction by default.
			const nowCanon = nowCanonicalDatetime();
			await this.ctx.db.exec('BEGIN');
			try {
				await this.ctx.db.exec(
					`insert into ProposedAdmin (
						AuthorityId,
						EffectiveAt,
						ThresholdPolicies
					)
						with context UserId = :signerUserId, UserKey = :signerKey, Signature = :signature, Tid = ${tid}, now = :now, IsUserValid = :isUserValid
					values (
						:authorityId,
						:effectiveAt,
						:thresholdPolicies
					)`,
					{
						authorityId: this.authority.id,
						effectiveAt: effectiveAtCanon,
						thresholdPolicies: thresholdPoliciesJson,
						signerUserId: signature.signerUserId,
						signerKey: signature.signerKey,
						signature: signature.signature,
						now: nowCanon,
						isUserValid,
					},
				);

				// 57-13 (CR-01, D-03 AMENDMENT — see 57-13-CR01-CARRIER-PROBE.md):
				// D-03 originally left ProposedOfficerUser unpopulated because 57-01's
				// read-side probe found no reader. That no longer holds — 57-14's
				// applyAdminProposal Step 4 is a genuinely NEW reader that needs a
				// stable identity reference instead of the renameable User.Name
				// bridge — but the carrier probe (Task 1) found ProposedOfficerUser
				// itself unusable: its UserSignature column is NOT NULL with no
				// legitimate non-fabricated value available at propose time (Q2),
				// and an officer seeded through the ordinary invite path has no live
				// UserKey row at all (Q3). The FALLBACK carrier persists the same
				// fact directly on ProposedOfficer.UserId instead (a column-only
				// schema addition, no new constraint) — ProposedOfficerUser itself
				// stays unpopulated, same as before, just for a different reason.
				for (const entry of rosterEntries) {
					await this.ctx.db.exec(
						`insert into ProposedOfficer (
							AuthorityId,
							AdminEffectiveAt,
							ProposedName,
							Title,
							Scopes,
							UserId
						)
							with context UserId = :signerUserId, UserKey = :signerKey, Signature = :signature, Tid = ${tid}, now = :now, IsUserValid = :isUserValid
						values (
							:authorityId,
							:effectiveAt,
							:proposedName,
							:title,
							:scopes,
							:entryUserId
						)`,
						{
							authorityId: this.authority.id,
							effectiveAt: effectiveAtCanon,
							proposedName: entry.proposedName,
							title: entry.title,
							scopes: JSON.stringify(entry.scopes),
							entryUserId: entry.userId ?? null,
							signerUserId: signature.signerUserId,
							signerKey: signature.signerKey,
							signature: signature.signature,
							now: nowCanon,
							isUserValid,
						},
					);
				}

				await this.ctx.db.exec('COMMIT');
			} catch (innerErr) {
				await this.ctx.db.exec('ROLLBACK');
				throw innerErr;
			}

			const adminDigestArgs: AdminDigestArgs = {
				authorityId: this.authority.id,
				effectiveAt: effectiveAtCanon,
				officers: officersJson,
				thresholdPolicies: thresholdPoliciesJson,
			};
			// WR-06 (17-REVIEW): proposeAdmin only STARTS the signing session with
			// the instigator's signature. For threshold policies > 1, the remaining
			// signers complete the proposal via separate per-signer calls to
			// `signingEngine.sign(nonce, signature)` — each signer must produce
			// their OWN signature, so completion cannot happen inside this method
			// (a previously commented-out loop here would have re-applied the
			// instigator's signature for every signer, which is wrong).
			const { nonce, thresholdReached } =
				await this.signingEngine.startSigningSession(
					this.authority.id,
					adminDigestArgs,
					'rad',
					signature,
				);

			// 57-08 (D-01 trigger half, Trigger A): the instigator's own signature
			// can already reach threshold here — the only administration shape the
			// current data model supports is threshold 1 (WR-05: every seeded
			// officer carries ctx.user.id), so proposeAdmin is where the FIRST and,
			// today, ONLY signature-completing event for a 'rad' session happens.
			// Promote only when threshold is genuinely reached AND a re-invocable
			// per-digest callback is available — applyAdminProposal mints two or
			// three distinct digests (57-07) and a single pre-computed Signature
			// cannot cover them.
			if (thresholdReached) {
				if (typeof signatureOrCallback === 'function') {
					try {
						const result = await this.applyAdminProposal(
							nonce,
							signatureOrCallback,
							{ ownsTransaction: true }, // 57-01 already COMMITted ProposedAdmin/
							// ProposedOfficer above, and startSigningSession's sign() call
							// (just above) owns and closes its OWN transaction — there is no
							// open transaction at this point, so this trigger opens its own.
						);
						this.lastPromotionOutcome = { status: 'promoted', nonce, result };
					} catch (promotionErr) {
						if (promotionErr instanceof AdminPromotionError) {
							// A promotion that legitimately cannot apply (e.g. the D-03
							// .init-officer case) must not destroy a correctly persisted,
							// correctly signed proposal. RECORD the refusal — never silent,
							// never thrown — proposeAdmin's contract is to propose.
							this.lastPromotionOutcome = {
								status: 'refused',
								nonce,
								reason: promotionErr.reason,
								proposedName: promotionErr.proposedName,
							};
							console.warn(
								`AuthorityEngine.proposeAdmin: promotion refused for nonce ${nonce}: ${promotionErr.reason}. The proposal itself was NOT affected — see lastPromotionOutcome.`,
							);
						} else {
							// Any OTHER error is unexpected and must not be downgraded to a
							// warning.
							throw promotionErr;
						}
					}
				} else {
					// Threshold reached but the caller supplied a bare Signature, not a
					// callback. Per Task 1's P8 probe, this shape has a production
					// (non-test, non-mock) caller — authority-propose-admin-builder.ts:154
					// — with no current app-level UI consumer. Record and warn; do NOT
					// throw and do NOT substitute/reuse the single supplied signature for
					// the two or three distinct digests the promotion needs to mint.
					this.lastPromotionOutcome = {
						status: 'skipped-non-callback-signature',
						nonce,
					};
					console.warn(
						`AuthorityEngine.proposeAdmin: threshold reached for nonce ${nonce} but a bare Signature (not a re-invocable per-digest callback) was supplied — promotion needs a callback because it mints two or three distinct digests. The proposal itself was NOT affected; this surface cannot promote until it supplies a callback.`,
					);
				}
			}
		} catch (err) {
			if (err instanceof QuereusError) {
				throw new Error(`Quereus error (code ${err.code}): ${err.message}`);
			} else if (err instanceof MisuseError) {
				throw new Error(`API misuse: ${err.message}`);
			} else {
				throw new Error(`Unknown error: ${err}`);
			}
		}
	}

	/**
	 * 57-07 (D-01 promotion half): promote a threshold-reached 'rad'
	 * AdminSigning/AdminSignature session into live Admin + Officer rows.
	 *
	 * Read-then-verify-then-write, modelled on
	 * SignatureTasksEngine.finalizeBallot's read-a-Proposed*-row-after-
	 * threshold-and-promote shape. Steps 1-5 (identification + refusal
	 * checks) run BEFORE any write and BEFORE any transaction opens.
	 *
	 * quereus finding (T-57-07-01..06, pinned by 57-07's P4 probe): the
	 * deferred-constraint queue mis-evaluates the self-referential
	 * `Admin.MutationValid` / `Officer.InsertValid` subqueries when MORE
	 * THAN ONE deferred entry is pending at COMMIT (matches the open
	 * "deferred-CHECK sibling-row visibility" class of quereus issue) — a
	 * live `select` inside the same open transaction shows the correct,
	 * self-visible digest, but the deferred evaluator computes something
	 * else and the CHECK spuriously fails. Workaround: drain the queue via
	 * `this.ctx.db.runDeferredRowConstraints()` immediately after EACH
	 * Admin/Officer insert, while still inside the one open transaction —
	 * every deferred CHECK then evaluates alone (the single-entry case,
	 * proven self-visible), and the surrounding BEGIN…COMMIT/ROLLBACK still
	 * provides real, whole-transaction atomicity.
	 */
	async applyAdminProposal(
		nonce: string,
		sign: (digest: Uint8Array) => Promise<Signature>,
		options?: { ownsTransaction?: boolean },
	): Promise<AdminPromotionResult> {
		const ownsTransaction = options?.ownsTransaction ?? true;
		try {
			// Step 1: read the session.
			const sessionRow = await this.ctx.db
				.prepare(
					'select Nonce, AuthorityId, AdminEffectiveAt, Scope, Digest from AdminSigning where Nonce = :nonce',
				)
				.get({ nonce });
			if (
				!sessionRow ||
				sessionRow.Scope !== 'rad' ||
				sessionRow.AuthorityId !== this.authority.id
			) {
				throw new AdminPromotionError('wrong-scope', nonce);
			}

			// Step 2: threshold gate. AdminSignature is sign()'s own authoritative
			// "threshold reached" marker — do not re-derive the arithmetic.
			const signedRow = await this.ctx.db
				.prepare('select 1 as x from AdminSignature where SigningNonce = :nonce')
				.get({ nonce });
			if (!signedRow) {
				throw new AdminPromotionError('not-signed', nonce);
			}

			// Step 3: identify the proposal by re-deriving 57-01's roster-covering
			// digest over each persisted ProposedAdmin + its ProposedOfficer roster,
			// and matching byte-for-byte against the session's stored Digest.
			// Exactly one row may match (T-57-07-02, repudiation control).
			let matched:
				| {
						effectiveAtCanon: string;
						thresholdPoliciesJson: string;
						rosterEntries: AdminRosterEntry[];
				  }
				| undefined;
			// WR-XX (57-07): materialize the outer cursor into a plain array BEFORE
			// issuing any nested db call. `Database.eval()` holds the exec mutex for
			// the whole iteration (documented on `_acquireExecMutex`) — a nested
			// `eval`/`prepare().get()` issued from inside an still-open outer `eval`
			// iterator re-enters the same mutex and deadlocks (never rejects; the
			// call simply never resolves). Every per-row nested read below runs
			// AFTER this array is fully collected, once the outer cursor has
			// released the mutex.
			const proposedAdminRows: Array<{ effectiveAtCanon: string; thresholdPoliciesJson: string }> = [];
			for await (const proposedRow of this.ctx.db.eval(
				'select AuthorityId, EffectiveAt, ThresholdPolicies from ProposedAdmin where AuthorityId = :id',
				{ id: this.authority.id },
			)) {
				proposedAdminRows.push({
					effectiveAtCanon: proposedRow.EffectiveAt as string,
					thresholdPoliciesJson: proposedRow.ThresholdPolicies as string,
				});
			}
			for (const { effectiveAtCanon, thresholdPoliciesJson } of proposedAdminRows) {
				const rosterRaw: AdminRosterEntry[] = [];
				// 57-13-TASK2-TEMP: Step 3 does not yet read the persisted UserId back
				// (that is Task 3) — binding `userId: null` for every entry here means
				// this re-derived roster will NOT match a roster proposeAdmin (Task 2's
				// producer) signed with a non-null userId. This is the plan's
				// deliberate expected-RED intermediate between Task 2 and Task 3.
				for await (const officerRow of this.ctx.db.eval(
					'select ProposedName, Title, Scopes from ProposedOfficer where AuthorityId = :id and AdminEffectiveAt = :e',
					{ id: this.authority.id, e: effectiveAtCanon },
				)) {
					rosterRaw.push({
						proposedName: officerRow.ProposedName as string,
						userId: null,
						title: officerRow.Title as string,
						scopes: parseJsonOr<Scope[]>(officerRow.Scopes as string, [], 'ProposedOfficer.Scopes'),
					});
				}
				const rosterEntries = sortRosterEntries(rosterRaw);
				const officersJson = JSON.stringify(rosterEntries);
				const candidateDigestRow = await this.ctx.db
					.prepare(
						'select Digest(:authorityId, :effectiveAt, :officers, :thresholdPolicies) as d',
					)
					.get({
						authorityId: this.authority.id,
						effectiveAt: effectiveAtCanon,
						officers: officersJson,
						thresholdPolicies: thresholdPoliciesJson,
					});
				if (candidateDigestRow?.d != null && candidateDigestRow.d === sessionRow.Digest) {
					matched = { effectiveAtCanon, thresholdPoliciesJson, rosterEntries };
					break;
				}
			}
			if (!matched) {
				throw new AdminPromotionError('roster-mismatch', nonce);
			}

			// Step 4: reverse 57-01's name bridge — resolve each ProposedName to a
			// UserId. D-03 consequence: ProposedOfficerUser stays unpopulated, so an
			// officer proposed as `.init` (no matching User row) cannot be promoted.
			// Refuse loudly rather than silently promoting a smaller roster than the
			// one that was signed (T-57-07-07).
			const resolvedOfficers: Array<{ userId: string; title: string; scopes: Scope[] }> = [];
			for (const entry of matched.rosterEntries) {
				const userIds: string[] = [];
				for await (const userRow of this.ctx.db.eval('select Id from User where Name = :name', {
					name: entry.proposedName,
				})) {
					userIds.push(userRow.Id as string);
				}
				if (userIds.length !== 1) {
					throw new AdminPromotionError('unresolvable-officer', nonce, entry.proposedName);
				}
				resolvedOfficers.push({ userId: userIds[0]!, title: entry.title, scopes: entry.scopes });
			}

			// Step 5: refuse a roster with no 'rad'-scoped officer — Admin.OfficerRequired
			// fires `check on update`, so an administration promoted without a 'rad'
			// officer could never be revised again (T-57-07-08). Then the idempotent-
			// replay short-circuit: a live Admin row already covering this
			// (authorityId, effectiveAt) means this nonce was already promoted
			// (T-57-07-06) — return without opening a transaction.
			const hasRadOfficer = resolvedOfficers.some((o) => o.scopes.includes('rad' as Scope));
			if (!hasRadOfficer) {
				throw new AdminPromotionError('no-rad-officer', nonce);
			}
			const existingAdminRow = await this.ctx.db
				.prepare('select 1 as x from Admin where AuthorityId = :id and EffectiveAt = :e')
				.get({ id: this.authority.id, e: matched.effectiveAtCanon });
			if (existingAdminRow) {
				return {
					authorityId: this.authority.id,
					effectiveAt: fromCanonicalDatetime(matched.effectiveAtCanon),
					officersPromoted: 0,
					alreadyApplied: true,
				};
			}

			// Step 6: allocate one Tid for the whole promotion; sort the resolved
			// roster ascending by UserId (Officer.AdminValid's strong branch requires
			// Admin to exist first when InviteSlotCid is null — D-07d).
			const tid = await allocateTid(this.ctx.db, 'authority');
			const sortedOfficers = [...resolvedOfficers].sort((a, b) =>
				a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0,
			);
			const minOfficer = sortedOfficers[0]!;

			// Session 1 — Admin-side digest. No Officer row exists yet for this
			// brand-new EffectiveAt (under ANY UserId), so the officer part is null
			// (57-07 P1/P2 probe verdict).
			const adminDigestRow = await this.ctx.db
				.prepare(
					'select Digest(:tid, :authorityId, Digest(:effectiveAt, :thresholdPolicies), :officerPart) as d',
				)
				.get({
					tid,
					authorityId: this.authority.id,
					effectiveAt: matched.effectiveAtCanon,
					thresholdPolicies: matched.thresholdPoliciesJson,
					officerPart: null,
				});
			if (!adminDigestRow || adminDigestRow.d == null) {
				throw new Error('applyAdminProposal: Digest() returned null for the Admin-side session');
			}
			const adminDigest = adminDigestRow.d as string;
			const adminSignature = await sign(digestToBytes(adminDigest));

			// AdminSigning.AdminEffectiveAt is the CURRENT admin's effective date
			// (never the promoted proposal's) — resolved via the same CurrentAdmin
			// join Officer lookup startSigningSession uses, keyed to the promoting
			// signer (key fact 4).
			const currentAdminRow = await this.ctx.db
				.prepare(
					`select CurrentAdmin.EffectiveAt from CurrentAdmin join Officer
						on CurrentAdmin.AuthorityId = Officer.AuthorityId
							and CurrentAdmin.EffectiveAt = Officer.AdminEffectiveAt
								where Officer.UserId = :userId and Officer.AuthorityId = :authorityId`,
				)
				.get({ userId: adminSignature.signerUserId, authorityId: this.authority.id });
			if (!currentAdminRow) {
				throw new Error(
					'applyAdminProposal: the promoting signer is not a current Officer of this authority',
				);
			}
			const currentAdminEffectiveAt = currentAdminRow.EffectiveAt as string;

			// Session 2 — ONE shared officer-side digest for EVERY officer,
			// including the first: 57-07's P4 probe proved that draining the
			// deferred-constraint queue after each insert makes every officer's
			// deferred CHECK resolve as self-visible, so the officer part is always
			// the minimum-UserId officer's own tuple (never null, never per-officer).
			const officerPartRow = await this.ctx.db
				.prepare('select Digest(:effectiveAt, :userId, :title, :scopes) as d')
				.get({
					effectiveAt: matched.effectiveAtCanon,
					userId: minOfficer.userId,
					title: minOfficer.title,
					scopes: JSON.stringify(minOfficer.scopes),
				});
			if (!officerPartRow || officerPartRow.d == null) {
				throw new Error('applyAdminProposal: Digest() returned null for the officer-part tuple');
			}
			const officerPart = officerPartRow.d as string;
			const officerDigestRow = await this.ctx.db
				.prepare(
					'select Digest(:tid, :authorityId, Digest(:effectiveAt, :thresholdPolicies), :officerPart) as d',
				)
				.get({
					tid,
					authorityId: this.authority.id,
					effectiveAt: matched.effectiveAtCanon,
					thresholdPolicies: matched.thresholdPoliciesJson,
					officerPart,
				});
			if (!officerDigestRow || officerDigestRow.d == null) {
				throw new Error('applyAdminProposal: Digest() returned null for the Officer-side session');
			}
			const officerDigest = officerDigestRow.d as string;
			const officerSignature = await sign(digestToBytes(officerDigest));

			const adminNonce = crypto.randomUUID();
			const officerNonce = crypto.randomUUID();
			const nowCanon = nowCanonicalDatetime();

			if (ownsTransaction) await this.ctx.db.exec('BEGIN');
			try {
				// Mint + insert the Admin row. Never IsPlaceholderSignature = true —
				// this method supplies real crypto (T-57-07-03).
				await this.ctx.db.exec(
					`insert into AdminSigning (
						Nonce, AuthorityId, AdminEffectiveAt, Scope, Digest, UserId, SignerKey, Signature
					)
						with context now = :now, IsSignerKeyValid = true, IsPlaceholderSignature = false
					values (
						:nonce, :authorityId, :adminEffectiveAt, 'rad', :digest, :userId, :signerKey, :signature
					)`,
					{
						nonce: adminNonce,
						authorityId: this.authority.id,
						adminEffectiveAt: currentAdminEffectiveAt,
						digest: adminDigest,
						userId: adminSignature.signerUserId,
						signerKey: adminSignature.signerKey,
						signature: adminSignature.signature,
						now: nowCanon,
					},
				);
				await this.signingEngine.sign(adminNonce, adminSignature, { ownsTransaction: false });
				await this.ctx.db.exec(
					`insert into Admin (AuthorityId, EffectiveAt, ThresholdPolicies)
						with context SigningNonce = :nonce, InviteSlotCid = null, InviteSignature = null, Tid = ${tid}
					values (:authorityId, :effectiveAt, :thresholdPolicies)`,
					{
						nonce: adminNonce,
						authorityId: this.authority.id,
						effectiveAt: matched.effectiveAtCanon,
						thresholdPolicies: matched.thresholdPoliciesJson,
					},
				);
				// Workaround for the deferred-CHECK sibling-row-visibility class of
				// quereus issue (see method doc comment) — drain before the next insert
				// enqueues its own deferred entry.
				await this.ctx.db.runDeferredRowConstraints();

				// Mint the ONE shared officer-side session, then insert every officer
				// row ascending by UserId, draining after each.
				await this.ctx.db.exec(
					`insert into AdminSigning (
						Nonce, AuthorityId, AdminEffectiveAt, Scope, Digest, UserId, SignerKey, Signature
					)
						with context now = :now, IsSignerKeyValid = true, IsPlaceholderSignature = false
					values (
						:nonce, :authorityId, :adminEffectiveAt, 'rad', :digest, :userId, :signerKey, :signature
					)`,
					{
						nonce: officerNonce,
						authorityId: this.authority.id,
						adminEffectiveAt: currentAdminEffectiveAt,
						digest: officerDigest,
						userId: officerSignature.signerUserId,
						signerKey: officerSignature.signerKey,
						signature: officerSignature.signature,
						now: nowCanon,
					},
				);
				await this.signingEngine.sign(officerNonce, officerSignature, { ownsTransaction: false });

				for (const officer of sortedOfficers) {
					await this.ctx.db.exec(
						`insert into Officer (AuthorityId, AdminEffectiveAt, UserId, Title, Scopes)
							with context SigningNonce = :nonce, InviteSlotCid = null, InviteSignature = null, Tid = ${tid}
						values (:authorityId, :effectiveAt, :userId, :title, :scopes)`,
						{
							nonce: officerNonce,
							authorityId: this.authority.id,
							effectiveAt: matched.effectiveAtCanon,
							userId: officer.userId,
							title: officer.title,
							scopes: JSON.stringify(officer.scopes),
						},
					);
					await this.ctx.db.runDeferredRowConstraints();
				}

				if (ownsTransaction) await this.ctx.db.exec('COMMIT');
			} catch (innerErr) {
				if (ownsTransaction) await this.ctx.db.exec('ROLLBACK');
				throw innerErr;
			}

			return {
				authorityId: this.authority.id,
				effectiveAt: fromCanonicalDatetime(matched.effectiveAtCanon),
				officersPromoted: sortedOfficers.length,
				alreadyApplied: false,
			};
		} catch (err) {
			if (err instanceof AdminPromotionError) {
				throw err;
			} else if (err instanceof QuereusError) {
				throw new Error(`Quereus error (code ${err.code}): ${err.message}`);
			} else if (err instanceof MisuseError) {
				throw new Error(`API misuse: ${err.message}`);
			} else if (err instanceof Error) {
				throw err;
			} else {
				throw new Error(`Unknown error: ${err}`);
			}
		}
	}

	// ---- SURF-03: pending-invite read + cancel/resend (non-signing, D-05/06/07) ----

	/**
	 * SURF-03 read surface: return the Cids of pending officer-invite InviteSlots
	 * (Type = 'of') for this authority's signing scope, filtered to drop any slot
	 * that has been responded to (InviteResult) OR cancelled (InviteCancellation).
	 *
	 * The cancellation filter is the second `NOT EXISTS` clause appended to the
	 * existing `getPendingOfficerInvites` template (invitation-engine.ts:35-38):
	 * a slot with a matching InviteCancellation marker drops off the list while
	 * the append-only marker — and the slot itself — persist for audit (D-06).
	 *
	 * Scoped to this authority via the AdminSigning join used by
	 * getAuthorityInvites (scope 'rad' = officer-invite admin approval).
	 */
	async getPendingInviteCids(): Promise<string[]> {
		try {
			const cids: string[] = [];
			for await (const row of this.ctx.db.eval(
				`select IS_.Cid from InviteSlot IS_
					join AdminSigning ADS on IS_.SigningNonce = ADS.Nonce
				where IS_.Type = 'of'
					and ADS.AuthorityId = :id
					and not exists (select 1 from InviteResult IR where IR.SlotCid = IS_.Cid)
					and not exists (select 1 from InviteCancellation C where C.SlotCid = IS_.Cid)`,
				{ id: this.authority.id },
			)) {
				cids.push(row.Cid as string);
			}
			return cids;
		} catch (err) {
			this.rethrow(err, 'getPendingInviteCids');
		}
	}

	/**
	 * SURF-03 (D-05/D-06): cancel a pending invitation by inserting an append-only
	 * InviteCancellation marker keyed by the InviteSlot Cid. NON-signing: the
	 * context envelope carries only Tid + now. The InviteSlot is never mutated
	 * (InviteSlot is InsertOnly); the slot simply drops off getPendingInviteCids
	 * on the next read because of the InviteCancellation NOT EXISTS filter.
	 *
	 * Throws when the slot does not exist (the marker's SlotExists CHECK also
	 * enforces this at the schema boundary — belt and suspenders).
	 */
	async cancelInvite(slotCid: string): Promise<void> {
		try {
			const slot = await this.ctx.db
				.prepare('select Cid from InviteSlot where Cid = :slotCid')
				.get({ slotCid });
			if (!slot) {
				throw new Error(`InviteSlot not found: ${slotCid}`);
			}
			// Allocate to a local first, then interpolate (the site sits inside a
			// `with context` string, not a bound param).
			const tid = await allocateTid(this.ctx.db, 'authority');
			await this.ctx.db.exec(
				`insert into InviteCancellation (SlotCid, CancelledAt)
					with context Tid = ${tid}, now = :now
				values (:slotCid, :now)`,
				{ slotCid, now: nowCanonicalDatetime() },
			);
		} catch (err) {
			this.rethrow(err, 'cancelInvite');
		}
	}

	/**
	 * SURF-03 (D-05/D-07): re-emit a pending invitation as a FRESH InviteSlot.
	 * NON-signing (A2): reuses the original slot's already-approved SigningNonce
	 * and InviteSignature, so NO new signing round runs (no saveInviteWithSigning,
	 * no SigningEngine.sign). A fresh, unique Cid is derived by Digesting the
	 * original fields together with the resend timestamp + a per-process Tid salt
	 * (so the new row never PK-collides with the original). No marker links
	 * old→new and there is no auto-supersede — both old and new may legitimately
	 * appear in the pending list. Returns the new slot's Cid.
	 *
	 * D-03 Option B (Phase 36): the resend salt is persisted as a real
	 * `InviteSlot.ResendSalt` column (not just fed into the Digest arg list) so
	 * the schema's CidValid CHECK can fully re-derive this row's Cid from its
	 * own columns alone — no structural-only acceptance window for resend rows.
	 *
	 * Throws when the original slot does not exist.
	 */
	async resendInvite(slotCid: string): Promise<string> {
		try {
			const orig = await this.ctx.db
				.prepare(
					`select Cid, Type, Name, Expiration, InviteKey, InviteSignature, SigningNonce
						from InviteSlot where Cid = :slotCid`,
				)
				.get({ slotCid });
			if (!orig) {
				throw new Error(`InviteSlot not found: ${slotCid}`);
			}
			const tid = await allocateTid(this.ctx.db, 'authority');
			const now = nowCanonicalDatetime();
			const resendSalt = `resend|${tid}|${now}`;
			// WR-02: pre-compute the new row's Cid deterministically (same
			// 7-field order the CidValid resend branch re-derives) instead of
			// discovering it via a post-insert SELECT. Once a SigningNonce
			// chain has 3+ rows, `Cid <> :origCid` matches more than one row
			// and a non-unique lookup can non-deterministically return a
			// stale Cid from an earlier resend in the chain.
			const newCidRow = await this.ctx.db
				.prepare(
					`select cid(Digest(:expiration, :inviteKey, :inviteSignature, :name, :nonce, :type, :resendSalt)) as c`,
				)
				.get({
					expiration: orig.Expiration as string,
					inviteKey: orig.InviteKey as string,
					inviteSignature: orig.InviteSignature as string,
					name: orig.Name as string,
					nonce: orig.SigningNonce as string,
					type: orig.Type as string,
					resendSalt,
				});
			const newCid = newCidRow!.c as string;
			// Fresh, unique Cid: same fields as the original PLUS the resend
			// timestamp and Tid salt, so the Digest (and therefore the Cid PK)
			// differs from the original while the approval-bearing SigningNonce /
			// InviteSignature are reused verbatim (A2 — no new signing round).
			//
			// 999.1 R-03: no new signing round happens on resend, so there is no
			// fresh byte domain to verify against for an 'au' or 'of' invite the
			// same way saveAuthorityInvite/saveOfficerInvite do. 'au' invites are
			// fully re-verifiable (InviteSlot persists Type/Name/Expiration —
			// createAuthorityInvite's whole [type, name, expiration] domain).
			// 'of' invites are NOT: InviteSlot never persists Title/Scopes (see
			// the getPendingOfficerInvites doc comment — "InviteSlot stores only
			// Name"), so createOfficerInvite's [name, title, scopes, type,
			// expiration, inviteKey] domain cannot be reconstructed from stored
			// columns alone. This is a genuine data-availability gap, not a
			// fabricated `true`: the InviteSignature/InviteKey pair being
			// re-inserted here is copied byte-for-byte from `orig`, an
			// immutable (InsertOnly CHECK), already-real-signature-verified row
			// — not a fresh unverified claim. Documented limitation (999.1-09
			// SUMMARY); a full fix needs InviteSlot to persist Title/Scopes.
			const isSignatureValid = orig.Type === 'au'
				? verifyAdHocInviteSignature(
					authorityInviteSignedBytes({
						type: orig.Type as string,
						name: orig.Name as string,
						expiration: orig.Expiration as string,
					}),
					orig.InviteSignature as string,
					orig.InviteKey as string,
				)
				: true;
			await this.ctx.db.exec(
				`insert into InviteSlot (
					Cid,
					Type,
					Name,
					Expiration,
					InviteKey,
					InviteSignature,
					SigningNonce,
					ResendSalt
					)
					with context Tid = ${tid}, now = :now, IsSignatureValid = :isSignatureValid, IsInsertValid = true
				values (
					:cid,
					:type,
					:name,
					:expiration,
					:inviteKey,
					:inviteSignature,
					:nonce,
					:resendSalt
					)`,
				{
					cid: newCid,
					type: orig.Type as string,
					name: orig.Name as string,
					expiration: orig.Expiration as string,
					inviteKey: orig.InviteKey as string,
					inviteSignature: orig.InviteSignature as string,
					nonce: orig.SigningNonce as string,
					resendSalt,
					now,
					isSignatureValid,
				},
			);
			return newCid;
		} catch (err) {
			this.rethrow(err, 'resendInvite');
		}
	}

	/**
	 * Shared error funnel mirroring InvitationEngine.rethrow — maps Quereus /
	 * misuse errors to plain Errors with full detail and re-wraps the rest.
	 */
	private rethrow(err: unknown, method: string): never {
		if (err instanceof QuereusError) {
			throw new Error(`Quereus error (code ${err.code}): ${err.message}`);
		} else if (err instanceof MisuseError) {
			throw new Error(`API misuse: ${err.message}`);
		} else if (err instanceof Error) {
			throw new Error(`AuthorityEngine.${method}: ${err.message}`);
		} else {
			throw new Error(`AuthorityEngine.${method}: unknown error: ${String(err)}`);
		}
	}

	async saveInviteWithSigning(
		invite: AuthorityInvite | OfficerInvite,
		scope: Scope, // either 'iad' for authority invites or 'rad' for officer invites
		signatureOrCallback: Signature | ((digest: Uint8Array) => Promise<Signature>),
	): Promise<void> {
		// D-19: nonce first, InviteSlots second, AdminSigning (startSigningSession) third
		const nonce = this.signingEngine.generateSigningNonce();
		if (invite.type === 'au') {
			// assume threshold for authority invites is 1
			await this.saveAuthorityInvite(invite, nonce);
		} else {
			// assume threshold for officer invites is 1
			await this.saveOfficerInvite(invite, nonce);
		}

		// D-03/D-04: if a sign callback is provided (screen-layer device-signer pattern),
		// compute the invite-slot Digest engine-side and call the callback with the digest
		// bytes — the engine stays digest-authoritative (D-03). The callback returns a
		// completed Signature without ever seeing the private key hex (D-01).
		// If a completed Signature is passed (test fixture path), use it directly.
		let signature: Signature;
		if (typeof signatureOrCallback === 'function') {
			const digestRow = await this.ctx.db
				.prepare('select Digest(Cid) as d from InviteSlot where SigningNonce = :nonce')
				.get({ nonce });
			if (!digestRow || digestRow.d == null) {
				throw new Error('saveInviteWithSigning: Digest() returned null — crypto plugin not registered?');
			}
			// Convert the Digest() output to Uint8Array via the shared decoder (WR-01 single
			// source of truth — same helper seedElectionSigning / addKey use).
			const digestBytes = digestToBytes(digestRow.d);
			signature = await signatureOrCallback(digestBytes);
		} else {
			signature = signatureOrCallback;
		}

		await this.signingEngine.startSigningSession(
			this.authority.id,
			null,
			scope,
			signature,
			nonce,
		);
	}

	private async saveAuthorityInvite(
		invite: AuthorityInvite,
		nonce: string,
	): Promise<void> {
		try {
			const tid = await allocateTid(this.ctx.db, 'authority');
			// 999.1 R-03: verify InviteSignature engine-side (via
			// verifyAdHocInviteSignature -> the shared verifySig() primitive,
			// see database/initialize.ts) against the exact ad-hoc byte domain
			// createAuthorityInvite signed — NOT SQL Digest() (Pitfall 2). A
			// real computed boolean, not a hardcoded `true`, gates
			// InviteSlot.InviteSignatureValid.
			const isSignatureValid = verifyAdHocInviteSignature(
				authorityInviteSignedBytes({ type: 'au', name: invite.name, expiration: invite.expiration }),
				invite.inviteSignature,
				invite.inviteKey,
			);
			await this.ctx.db.exec(
				`
				insert into InviteSlot (
					Cid,
					Type,
					Name,
					Expiration,
					InviteKey,
					InviteSignature,
					SigningNonce
					)
					with context Tid = :tid, now = :now, IsSignatureValid = :isSignatureValid, IsInsertValid = true
					values (
						cid(Digest(:expiration, :inviteKey, :inviteSignature, :name, :nonce, :type)),
						:type,
						:name,
						:expiration,
						:inviteKey,
						:inviteSignature,
						:nonce
						)`,
				{
					type: 'au',
					name: invite.name,
					expiration: invite.expiration,
					inviteKey: invite.inviteKey,
					inviteSignature: invite.inviteSignature,
					nonce,
					tid,
					now: nowCanonicalDatetime(),
					isSignatureValid,
				},
			);
		} catch (err) {
			if (err instanceof QuereusError) {
				throw new Error(`Quereus error (code ${err.code}): ${err.message}`);
			} else if (err instanceof MisuseError) {
				throw new Error(`API misuse: ${err.message}`);
			} else {
				throw new Error(`Unknown error: ${err}`);
			}
		}
	}

	private async saveOfficerInvite(
		invite: OfficerInvite,
		nonce: string,
	): Promise<void> {
		try {
			const tid = await allocateTid(this.ctx.db, 'authority');
			// 999.1 R-03: verify InviteSignature engine-side against the exact
			// ad-hoc byte domain createOfficerInvite signed — NOT SQL Digest()
			// (Pitfall 2). A real computed boolean, not a hardcoded `true`, gates
			// InviteSlot.InviteSignatureValid.
			const isSignatureValid = verifyAdHocInviteSignature(
				officerInviteSignedBytes({
					name: invite.name,
					title: invite.title,
					scopes: invite.scopes,
					type: invite.type,
					expiration: invite.expiration,
					inviteKey: invite.inviteKey,
				}),
				invite.inviteSignature,
				invite.inviteKey,
			);
			await this.ctx.db.exec(
				`
				insert into InviteSlot (
					Cid,
					Type,
					Name,
					Expiration,
					InviteKey,
					InviteSignature,
					SigningNonce
					)
				with context Tid = :tid, now = :now, IsSignatureValid = :isSignatureValid, IsInsertValid = true
				values (
					cid(Digest(:expiration, :inviteKey, :inviteSignature, :name, :nonce, :type)),
					:type,
					:name,
					:expiration,
					:inviteKey,
					:inviteSignature,
					:nonce
				)`,
				{
					type: invite.type,
					name: invite.name,
					expiration: invite.expiration,
					inviteKey: invite.inviteKey,
					inviteSignature: invite.inviteSignature,
					nonce,
					tid,
					now: nowCanonicalDatetime(),
					isSignatureValid,
				},
			);
		} catch (err) {
			// WR-07 (17-REVIEW): map errors with full detail (same as
			// saveAuthorityInvite) instead of swallowing the cause — a
			// CHECK-constraint failure must remain diagnosable.
			if (err instanceof QuereusError) {
				throw new Error(
					`Failed to save officer invitation — Quereus error (code ${err.code}): ${err.message}`,
				);
			} else if (err instanceof MisuseError) {
				throw new Error(
					`Failed to save officer invitation — API misuse: ${err.message}`,
				);
			} else {
				throw new Error(`Failed to save officer invitation: ${err}`, {
					cause: err,
				});
			}
		}
	}

	// ---- builder factories (BUILD-AUTH-01 / FACT-04) ----

	buildCreateOfficerInvite(): IAuthorityCreateOfficerInviteBuilder {
		return new AuthorityCreateOfficerInviteBuilder(this);
	}

	buildCreateAuthorityInvite(): IAuthorityCreateAuthorityInviteBuilder {
		return new AuthorityCreateAuthorityInviteBuilder(this);
	}

	buildProposeAdmin(): IAuthorityProposeAdminBuilder {
		return new AuthorityProposeAdminBuilder(this);
	}

	buildSaveInviteWithSigning(): IAuthoritySaveInviteWithSigningBuilder {
		return new AuthoritySaveInviteWithSigningBuilder(this);
	}
}
