/**
 * dashboard-signin-code.ts — the D-05 bearer sign-in code for the authority web
 * dashboard: mint, single staged-code store, atomic single-use claim, and the
 * filesystem-binding staging documents.
 *
 * WHAT THE CODE IS. The code is a **bearer secret** — short-expiry
 * (`DASHBOARD_SIGNIN_CODE_SPAN_MINUTES`) and single-use — because together those
 * two properties bound the exposure window and are the ONLY thing standing
 * between a leaked code and an unauthorized party pulling an authority's whole
 * database. It is deliberately NOT an `InviteSlot`: there is no signing ceremony
 * anywhere in this file, no `AdminSigning` row, no scope claim. Modelling it as
 * an invite would drag a WRITE ceremony into a phase that is read-only by design
 * and would reopen the nine-code scope set that was just reconciled. It carries
 * an identity assertion plus a data bootstrap and NEVER a key (D-04) — the
 * browser holds no key and can never sign, mirroring the registration
 * transport's never-raw-key rule.
 *
 * THE TWO-HALF FORMAT (restated from 50-07-PLAN.md's `<the_code_format>` — this
 * module docstring is the reference 50-08 reads; keep it accurate):
 *
 *   secret . digest
 *
 * `secret` is 40 lowercase hex characters — 20 bytes of `crypto.getRandomValues`
 * output — and is the ONLY half ever handed to a transport binding
 * (`IBootstrapTransport.redeem(code)`'s argument is this half alone). `digest`
 * is the minted snapshot's `envelope.digest` verbatim (base64url SHA-256, 43
 * characters) and is NEVER sent to any transport — the dashboard splits it off
 * locally and passes it as `verifySnapshot`'s `expectedDigest` option. This
 * shape buys three things:
 *
 *   1. The digest travels OUT-OF-BAND, on the same slip of paper the officer
 *      reads the secret from — never from the endpoint that serves the
 *      payload. That is the entire reason `verifySnapshot` accepts
 *      `expectedDigest` as an option instead of trusting the envelope's own
 *      `digest` field: an endpoint that controls the payload controls that
 *      field too.
 *   2. The party being verified (the transport / endpoint) is never handed the
 *      expected value — defence in depth on top of SHA-256 second-preimage
 *      resistance, at the cost of one string split.
 *   3. Both halves are safe path/URL segments (hex and base64url are subsets of
 *      `filesystem-bootstrap-transport.ts`'s `assertSafeBootstrapIdentifier`
 *      pattern), and neither half can contain a `..` traversal segment.
 *
 * NOT A KEY. The secret is raw `crypto.getRandomValues` output — deliberately
 * NOT `secp256k1.utils.randomSecretKey()`, the idiom `AuthorityEngine
 * .createOfficerInvite` uses for its bearer-secret mint (this module mirrors
 * that mint's SHAPE only, never its curve-key idiom). A secp256k1 secret key IS
 * key material; a later reader who found one here would reasonably conclude the
 * browser can sign. It cannot: no signing key exists outside Android Keystore,
 * no key backup or restore feature exists anywhere in this repo, and the
 * browser holds nothing to sign with (D-04).
 *
 * WHAT IS PERSISTED, AND FOR HOW LONG. `AsyncStorage` is an ORDINARY
 * on-device value — on Android that is the RKStorage SQLite file: unencrypted,
 * included in ADB backups where `allowBackup` is set, and readable from any
 * root or forensic image. The whole-database payload (`snapshotJson`) is
 * therefore NEVER written there, at any point in a code's lifetime — not at
 * mint, not while the code is live, not after it is spent. It lives ONLY in
 * the module-level {@link stagedSnapshotJson} variable, in this process's
 * memory, for exactly as long as the code that unlocks it is redeemable:
 * {@link mintDashboardSignInCode} sets it and persists a record with the
 * payload OMITTED; {@link redeemStagedSignInCode} reads it (or, if this
 * process restarted and lost it, asks the registered
 * {@link registerDashboardSnapshotProvider} provider to regenerate an
 * equivalent snapshot, accepted only on an exact digest match with the one the
 * officer is holding on paper) and clears it the instant the code stops being
 * redeemable — on a successful redemption, and on an expiry refusal. At that
 * same instant the PERSISTED record itself collapses to a tombstone —
 * `{ code, secret, digest, expiresAt, mintedAt, redeemedAt? }` — dropping even
 * `snapshotName`, so nothing about the record continues to describe an export
 * that no longer exists. {@link clearStagedSignInCode} drops the record
 * outright and is wired to a discard control on the producer screen.
 *
 * A spent or expired code must never leave a plaintext copy of the voter roll
 * sitting beside the bearer secret that unlocks it: the secret's entire
 * security value is that short-expiry plus single-use bound the exposure
 * window, and leaving the payload behind removes both bounds for anyone with
 * storage access, who then does not need the code at all.
 *
 * No GSD phase number or decision ID may appear in any string this module can
 * surface to a user — code comments only.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { bytesToHex } from '@noble/curves/utils.js';
import {
	parseSnapshot,
	serializeSnapshot,
} from '@votetorrent/vote-engine/bootstrap';
import type {
	BootstrapRedemptionResult,
	BootstrapSnapshot,
} from '@votetorrent/vote-engine/bootstrap';

/** The single source of the expiry-duration number. The i18n copy interpolates
 * THIS value; a literal number anywhere in a product string is a defect. */
export const DASHBOARD_SIGNIN_CODE_SPAN_MINUTES = 10;

const STAGED_CODE_STORAGE_KEY = 'votetorrent.dashboardBootstrap.stagedCode';

/**
 * The staged sign-in code record. AT MOST ONE exists at a time, BY
 * CONSTRUCTION — {@link mintDashboardSignInCode} always replaces whatever was
 * previously staged, so a superseded code is instantly unredeemable, with no
 * separate revocation step required. That is a SECURITY property (bounds how
 * many codes can simultaneously grant access to the same whole-database
 * payload), not merely an implementation convenience.
 */
export interface StagedSignInCode {
	/** `${secret}.${digest}` — the value shown to the officer and split by the dashboard. */
	code: string;
	/** 40 lowercase hex characters. The ONLY half ever sent to a transport binding. */
	secret: string;
	/** `snapshot.digest` verbatim. NEVER sent to a transport — travels out-of-band only. */
	digest: string;
	/** 19-char canonical datetime, no `Z` suffix. */
	expiresAt: string;
	/** 19-char canonical datetime, no `Z` suffix. */
	mintedAt: string;
	/** `snapshot-` + the first 16 characters of `secret` — a per-code filename so two
	 * staged exports can never collide, and safe under the filesystem binding's
	 * `assertSafeBootstrapIdentifier` pattern. Present on the value
	 * {@link mintDashboardSignInCode} returns and on the persisted record WHILE
	 * the code is still live; dropped from the persisted record the moment the
	 * code stops being redeemable (see {@link toTombstone}) since a spent
	 * record no longer names anything worth staging. */
	snapshotName: string;
	/** `serializeSnapshot(snapshot)` — the exact bytes a filesystem/REST binding
	 * couriers, and an authority's WHOLE DATABASE in the clear. Present ONLY on
	 * the value {@link mintDashboardSignInCode} RETURNS — it is held in the
	 * module-level {@link stagedSnapshotJson} variable, in memory only, and is
	 * NEVER written to `AsyncStorage` at any point in the code's lifetime. See
	 * the module header's "what is persisted, and for how long". A reader must
	 * therefore never expect this field to be present on a value read back via
	 * {@link readStagedSignInCode}. */
	snapshotJson?: string;
	/** Set the instant a redemption succeeds. Present iff the code has been redeemed. */
	redeemedAt?: string;
	/** Set by {@link stageForFilesystemBinding} (in-memory only — that function performs
	 * no I/O). A SECOND stage attempt for the same record object throws, because two
	 * independent single-use claims for one code could otherwise diverge. */
	stagedAt?: string;
}

/** Canonical `YYYY-MM-DDTHH:MM:SS` with NO trailing `Z` — the same 19-character,
 * no-`Z` form `filesystem-bootstrap-transport.ts` compares against with a raw
 * string comparison. Constructing both sides with this exact idiom (rather than
 * `Temporal`, which `vote-engine` depends on but this app does NOT declare) is
 * what guarantees the comparison agrees; a `Z` here would make every `Digest`
 * mismatch and surface as a bare `InsertValid` failure elsewhere, indistinguishable
 * from a real authorization failure. */
function toCanonical(date: Date): string {
	return date.toISOString().slice(0, 19);
}

/**
 * THE in-memory-only payload slot. AsyncStorage on Android is the unencrypted
 * RKStorage SQLite file, and this payload is an authority's whole database
 * including registrant PII — it must never reach that file, so it lives here,
 * in this process's memory, instead. {@link mintDashboardSignInCode} sets it;
 * {@link redeemStagedSignInCode} clears it the instant the code it belongs to
 * stops being redeemable (a successful redemption, or an expiry refusal);
 * {@link clearStagedSignInCode} clears it on an explicit discard. A second
 * mint overwrites it, which is also why a superseded code's payload becomes
 * unreachable immediately (see {@link StagedSignInCode}'s security note).
 */
let stagedSnapshotJson: string | undefined;

/**
 * Registered by the app shell (see `AppProvider.tsx`) so a redemption that
 * finds no in-memory payload — a cold start, or any process restart between
 * mint and redemption — can regenerate an equivalent snapshot rather than
 * ever having persisted one. The regenerated snapshot is accepted only when
 * its digest EXACTLY matches the one the officer is holding on paper (the
 * code's right half); anything else is treated as "no payload available",
 * never as "close enough". Pass `undefined` to unregister (e.g. on unmount).
 */
type DashboardSnapshotProvider = () => Promise<BootstrapSnapshot>;
let dashboardSnapshotProvider: DashboardSnapshotProvider | undefined;

export function registerDashboardSnapshotProvider(provider: DashboardSnapshotProvider | undefined): void {
	dashboardSnapshotProvider = provider;
}

/**
 * TEST-ONLY. Resets the two module-level, in-memory-only slots
 * ({@link stagedSnapshotJson} and the registered provider) WITHOUT touching
 * `AsyncStorage` — the two live in this module's process memory, which
 * `AsyncStorage.clear()` cannot reach, and Jest does not otherwise reset
 * module-level state between tests in the same file. Used to simulate a
 * process restart between mint and redemption: the persisted record survives
 * (it was never in memory), the in-memory payload does not. Never called by
 * production code.
 */
export function __resetInMemoryStateForTests(): void {
	stagedSnapshotJson = undefined;
	dashboardSnapshotProvider = undefined;
}

/** The shape actually written to `AsyncStorage` while a code is still live —
 * every {@link StagedSignInCode} field EXCEPT the in-memory-only payload. */
type PersistedStagedRecord = Omit<StagedSignInCode, 'snapshotJson'>;

/** The shape written to `AsyncStorage` once a code stops being redeemable —
 * see the module header's "what is persisted, and for how long". Deliberately
 * drops `snapshotName` too: a spent record no longer names anything worth
 * staging, and the acceptance contract is that its keys are EXACTLY this set. */
type TombstoneRecord = Pick<StagedSignInCode, 'code' | 'secret' | 'digest' | 'expiresAt' | 'mintedAt'> & {
	redeemedAt?: string;
};

/**
 * Reduce `record` to its tombstone shape (see {@link TombstoneRecord}) —
 * `redeemedAt` is included only when the caller supplies one, so an expired
 * (never-redeemed) tombstone and a used (redeemed) tombstone differ by
 * exactly that one key, and neither carries `snapshotName` or any trace of
 * the payload.
 */
function toTombstone(record: StagedSignInCode, redeemedAt?: string): TombstoneRecord {
	return {
		code: record.code,
		secret: record.secret,
		digest: record.digest,
		expiresAt: record.expiresAt,
		mintedAt: record.mintedAt,
		...(redeemedAt !== undefined ? { redeemedAt } : {}),
	};
}

/**
 * Mint a new bearer sign-in code for `snapshot` and persist it as the ONE
 * staged record, replacing whatever was staged before (see the security note on
 * {@link StagedSignInCode} above — the replaced code becomes instantly
 * unredeemable). `options` exist ONLY so tests can pin the span and the clock;
 * production callers pass nothing.
 *
 * The RETURNED record carries `snapshotJson` in memory (so
 * `stageForFilesystemBinding` works unchanged in the same session); the
 * PERSISTED record never does — see the module header.
 */
export async function mintDashboardSignInCode(
	snapshot: BootstrapSnapshot,
	options?: { spanMinutes?: number; now?: Date },
): Promise<StagedSignInCode> {
	const spanMinutes = options?.spanMinutes ?? DASHBOARD_SIGNIN_CODE_SPAN_MINUTES;
	const now = options?.now ?? new Date();

	// The secret, generated in one confined block. Deliberately
	// `crypto.getRandomValues` raw output, NEVER `secp256k1.utils.randomSecretKey()`
	// — see the module header's "NOT A KEY" paragraph.
	const secretBytes = new Uint8Array(20);
	globalThis.crypto.getRandomValues(secretBytes);
	const secret = bytesToHex(secretBytes);

	const mintedAt = toCanonical(now);
	const expiresAt = toCanonical(new Date(now.getTime() + spanMinutes * 60_000));
	const snapshotName = `snapshot-${secret.slice(0, 16)}`;
	const snapshotJson = serializeSnapshot(snapshot);
	const digest = snapshot.digest;
	const code = `${secret}.${digest}`;

	const record: StagedSignInCode = {
		code,
		secret,
		digest,
		expiresAt,
		mintedAt,
		snapshotName,
		snapshotJson,
	};

	// The payload lives in memory ONLY — a second mint overwrites it,
	// instantly stranding whatever the first mint staged.
	stagedSnapshotJson = snapshotJson;

	const persisted: PersistedStagedRecord = {
		code,
		secret,
		digest,
		expiresAt,
		mintedAt,
		snapshotName,
	};
	await AsyncStorage.setItem(STAGED_CODE_STORAGE_KEY, JSON.stringify(persisted));
	return record;
}

/** Reads the one staged record. Returns `undefined` on absent or unparseable
 * content — NEVER throws, so a screen can always fall back to the idle state.
 * The returned value never carries `snapshotJson` — that field only ever
 * exists on the value {@link mintDashboardSignInCode} returns directly. */
export async function readStagedSignInCode(): Promise<StagedSignInCode | undefined> {
	try {
		const raw = await AsyncStorage.getItem(STAGED_CODE_STORAGE_KEY);
		if (raw === null) return undefined;
		return JSON.parse(raw) as StagedSignInCode;
	} catch {
		return undefined;
	}
}

/** Drops the staged record (idle-state reset) and clears the in-memory payload. */
export async function clearStagedSignInCode(): Promise<void> {
	stagedSnapshotJson = undefined;
	await AsyncStorage.removeItem(STAGED_CODE_STORAGE_KEY);
}

const SECRET_PATTERN = /^[0-9a-f]{40}$/;
const DIGEST_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * Split a pasted/scanned code into its two halves. Throws on a structural
 * fault — no dot, more than one dot, a non-hex secret, or an empty/malformed
 * digest — with a message describing the fault and containing NEITHER half:
 * the secret is a credential and the digest identifies the payload, and
 * neither belongs in a log line or a crash report.
 */
export function splitDashboardSignInCode(code: string): { secret: string; digest: string } {
	const parts = code.split('.');
	if (parts.length !== 2) {
		throw new Error(
			`dashboard-signin-code: malformed code — expected exactly one '.' separator, found ${parts.length - 1}`,
		);
	}
	const [secret, digest] = parts as [string, string];
	if (!SECRET_PATTERN.test(secret)) {
		throw new Error('dashboard-signin-code: malformed code — secret half is not 40 lowercase hex characters');
	}
	if (digest.length === 0 || !DIGEST_PATTERN.test(digest)) {
		throw new Error('dashboard-signin-code: malformed code — digest half is empty or not base64url');
	}
	return { secret, digest };
}

/**
 * Serializes every {@link redeemStagedSignInCode} call behind a module-level
 * promise chain, so two calls issued without an intervening `await` can never
 * both observe `redeemedAt` absent — the exact race a naive read-modify-write
 * would reopen. Contrast with `filesystem-bootstrap-transport.ts`'s single-use
 * claim: THAT binding needs `link()` because `rename()` silently overwrites
 * (multiple OS processes could touch the same file); THIS module runs on one JS
 * thread, so explicit in-process serialization is the equivalent atomicity
 * guarantee — an unserialized read-modify-write here would reintroduce exactly
 * the replay hole `link()` exists to close on the filesystem side.
 */
let redemptionChain: Promise<unknown> = Promise.resolve();

/**
 * The PRODUCER-side authority for a code's expiry and single-use state.
 * Whichever binding eventually fronts this app (filesystem or REST) delegates
 * its redemption claim here; a staged filesystem copy additionally carries its
 * own independent marker (see {@link stageForFilesystemBinding}), which is why
 * that function refuses to stage the same record twice.
 *
 * Order of decisions (part of the contract, mirroring
 * `filesystem-bootstrap-transport.ts`'s own order):
 *
 *   1. No staged record, or its secret does not match -> `'unknown'`
 *   2. The record already has `redeemedAt`           -> `'used'`
 *   3. `now >= expiresAt` (RAW STRING comparison — canonical form sorts
 *      lexicographically; NEVER `Date.parse` either side, since two strings
 *      that parse to the same instant are still different values) -> `'expired'`
 *   4. Otherwise, RESOLVE THE PAYLOAD (this order is load-bearing — see below)
 *      BEFORE stamping `redeemedAt`: prefer the in-memory
 *      {@link stagedSnapshotJson}; if it is absent (a cold start lost it),
 *      call the registered {@link registerDashboardSnapshotProvider} provider
 *      and accept the result only on an EXACT `digest` match with the
 *      record's. A miss of either kind -> `'unknown'`, WITHOUT writing
 *      anything — a failure to produce the payload must never burn the
 *      code's single use. Only once a matching payload is in hand: set
 *      `redeemedAt`, persist the tombstone, and return `'ok'` with the
 *      snapshot.
 *
 * `snapshot` is OMITTED on every refusal — 50-03's `BootstrapRedemptionResult`
 * states it is present iff the status is `'ok'`, and a caller must not be able
 * to consume a partial artifact.
 */
export async function redeemStagedSignInCode(
	secret: string,
	options?: { now?: Date },
): Promise<BootstrapRedemptionResult> {
	const attempt = redemptionChain.then(async (): Promise<BootstrapRedemptionResult> => {
		const now = options?.now ?? new Date();
		const nowCanonical = toCanonical(now);

		const record = await readStagedSignInCode();
		if (record === undefined || record.secret !== secret) {
			return { status: 'unknown' };
		}
		if (record.redeemedAt !== undefined) {
			return { status: 'used' };
		}
		if (nowCanonical >= record.expiresAt) {
			// An expired code can never be redeemed again, so the in-memory
			// payload (if any) has no remaining purpose — drop it, and collapse
			// the persisted record to its tombstone, but KEEP the tombstone so a
			// second attempt still answers 'expired' rather than the weaker
			// 'unknown'.
			stagedSnapshotJson = undefined;
			await AsyncStorage.setItem(STAGED_CODE_STORAGE_KEY, JSON.stringify(toTombstone(record)));
			return { status: 'expired' };
		}

		// PAYLOAD RESOLUTION, strictly before the `redeemedAt` stamp below — see
		// this function's doc comment on why the order is load-bearing. Never
		// write anything on a miss of either kind: a failed regeneration or an
		// unregistered provider must not burn the code's single use.
		let resolvedSnapshotJson: string | undefined = stagedSnapshotJson;
		if (resolvedSnapshotJson === undefined) {
			if (dashboardSnapshotProvider === undefined) {
				return { status: 'unknown' };
			}
			let regenerated: BootstrapSnapshot;
			try {
				regenerated = await dashboardSnapshotProvider();
			} catch {
				// A regeneration failure is "no payload available", not a crash —
				// the code must remain live for a subsequent attempt.
				return { status: 'unknown' };
			}
			// Never `'ok'` with bytes the code's out-of-band digest does not pin.
			if (regenerated.digest !== record.digest) {
				return { status: 'unknown' };
			}
			resolvedSnapshotJson = serializeSnapshot(regenerated);
		}

		const parsed = parseSnapshot(resolvedSnapshotJson);
		if (!parsed.ok) {
			throw new Error(`dashboard-signin-code: could not parse the staged snapshot (key ${STAGED_CODE_STORAGE_KEY})`);
		}

		// Stamp `redeemedAt` and collapse to the tombstone in the SAME write:
		// the code is spent from this instant, so nothing describing the export
		// belongs in storage beyond that instant.
		stagedSnapshotJson = undefined;
		await AsyncStorage.setItem(STAGED_CODE_STORAGE_KEY, JSON.stringify(toTombstone(record, nowCanonical)));

		return { status: 'ok', snapshot: parsed.envelope };
	});

	// Keep the chain alive regardless of this attempt's outcome — a rejected
	// attempt must not permanently wedge every subsequent redemption behind it.
	redemptionChain = attempt.catch(() => undefined);
	return attempt;
}

/** The `codes/{code}.json` shape `filesystem-bootstrap-transport.ts` parses,
 * spelled with EXACTLY that binding's field names — `expiresAt` and
 * `snapshotFile` (never `snapshotName`, this module's own internal field). */
interface FilesystemCodeRecordDocument {
	expiresAt: string;
	snapshotFile: string;
}

/**
 * Emit the three documents the shipped `filesystem-bootstrap-transport.ts`
 * reads — `codes/<secret>.json`, `snapshots/<snapshotName>.json` and
 * `snapshots/current.json` — WITHOUT performing any I/O: this app has no
 * filesystem dependency, and the standalone receiver service that would
 * eventually write these bytes is explicitly not built in this phase. An
 * operator or a future service writes them verbatim.
 *
 * Throws if `record.stagedAt` is already set (two independent single-use
 * claims for one code could otherwise diverge), then marks `record.stagedAt`
 * in place — an in-memory-only mutation, not a persisted write — so a SECOND
 * call with the SAME record object throws. Also throws if `record.snapshotJson`
 * is absent — only the value {@link mintDashboardSignInCode} returns directly
 * carries it (see the module header); a record read back via
 * {@link readStagedSignInCode} never does, and staging that would emit a
 * filesystem document with no content.
 */
export function stageForFilesystemBinding(
	record: StagedSignInCode,
): Array<{ path: string; contents: string }> {
	if (record.stagedAt !== undefined) {
		throw new Error('dashboard-signin-code: stageForFilesystemBinding called twice for the same record');
	}
	const { snapshotJson } = record;
	if (snapshotJson === undefined) {
		throw new Error('dashboard-signin-code: stageForFilesystemBinding requires the in-memory mint result, not a re-read record');
	}

	const codeDocument: FilesystemCodeRecordDocument = {
		expiresAt: record.expiresAt,
		snapshotFile: record.snapshotName,
	};

	const documents = [
		{ path: `codes/${record.secret}.json`, contents: JSON.stringify(codeDocument) },
		{ path: `snapshots/${record.snapshotName}.json`, contents: snapshotJson },
		{ path: 'snapshots/current.json', contents: snapshotJson },
	];

	record.stagedAt = toCanonical(new Date());
	return documents;
}
