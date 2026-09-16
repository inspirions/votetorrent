/**
 * dashboard-signin-code.ts — the D-05 bearer sign-in code for the authority web
 * dashboard: mint, single staged-code store, atomic single-use claim, and the
 * filesystem-binding staging documents.
 *
 * TWO PATHS LIVE IN THIS FILE, and a reader should establish which half they
 * are in before anything else:
 *
 *   1. **The push path (the rendezvous service).** {@link mintDashboardSignInCode}
 *      called WITH an `uploader`: it seals the snapshot and uploads it, and the
 *      phone keeps no payload at all. Redemption happens between the browser
 *      and the service; this phone is not involved in it.
 *   2. **The filesystem-binding path.** {@link stageForFilesystemBinding} plus
 *      {@link redeemStagedSignInCode}, with {@link registerDashboardSnapshotProvider}
 *      feeding the latter's cold-start fallback. On that path this module IS
 *      the producer-side redemption authority. It has no production caller in
 *      this app today and is retained deliberately; every entry point that
 *      belongs to it alone says so in its own first line.
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
 * ON THE PUSH PATH (an `uploader` supplied to {@link mintDashboardSignInCode})
 * the guarantee is strictly stronger still: the payload is NEVER assigned to
 * {@link stagedSnapshotJson} at all and is never written to `AsyncStorage`.
 * It exists only as a local `const` for the duration of one `sealPayload`
 * call, and what leaves this process is ciphertext. The record is therefore
 * BORN in the tombstone shape at the instant the uploader acknowledges — it
 * has the tombstone SHAPE while the code is still live, which is intentional:
 * under push-at-mint this phone is no longer the redemption authority for
 * that code, so the only thing it needs to keep is the FACT of the code, not
 * the export it describes.
 *
 * `lookupId` is also persisted from now on. That is not a weakening: the
 * record already persists `secret`, from which `lookupId` is derivable in one
 * step, so storing it discloses nothing new. The half that actually decrypts
 * — `contentKey` — is derived transiently at mint and is never persisted,
 * never returned and never logged. `lookupId` is kept because the NEXT mint
 * needs it to revoke this code at the rendezvous service, which cannot infer
 * that two codes belong to one authority.
 *
 * It is kept ACROSS A DISCARD too, and that is not the same statement. The
 * producer screen shows no generate control while a code is live, so the
 * sequence an officer actually performs is mint -> DISCARD -> mint — and
 * {@link clearStagedSignInCode} destroys the very record the next mint would
 * read the prior `lookupId` from. So a discard leaves behind a
 * {@link PendingRevokeMarker} under its own key, carrying the `lookupId` and
 * `expiresAt` and NOTHING ELSE: never the `code`, the `secret`, the `digest`,
 * the `snapshotName` or the payload. A discard is supposed to destroy a
 * credential; a marker that kept the secret alive would be a worse defect than
 * the missing revoke it exists to fix. The marker is dropped once an upload has
 * actually delivered its revoke, and survives a refused one.
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
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js';
import {
	assertCanonicalBootstrapDatetime,
	deriveBootstrapKeys,
	parseSnapshot,
	sealPayload,
	serializeSnapshot,
} from '@votetorrent/vote-engine/bootstrap';
import type {
	BootstrapRedemptionStatus,
	BootstrapSnapshot,
	SealedPayload,
} from '@votetorrent/vote-engine/bootstrap';

/** The single source of the expiry-duration number. The i18n copy interpolates
 * THIS value; a literal number anywhere in a product string is a defect. */
export const DASHBOARD_SIGNIN_CODE_SPAN_MINUTES = 10;

const STAGED_CODE_STORAGE_KEY = 'votetorrent.dashboardBootstrap.stagedCode';

/**
 * The pending-revoke marker's key — a SECOND, deliberately separate key rather
 * than a field on the staged record, because the fact it holds has to OUTLIVE
 * that record's destruction. See {@link PendingRevokeMarker}.
 */
const PENDING_REVOKE_STORAGE_KEY = 'votetorrent.dashboardBootstrap.pendingRevoke';

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
	/** The base64url (43-character) `lookupId` this code was uploaded under —
	 * the PUBLIC half of the key split derived from {@link StagedSignInCode.secret}'s
	 * raw bytes. Persisted so the NEXT mint can revoke this code at the
	 * rendezvous service, which cannot infer that two codes belong to one
	 * authority. Persisting it is NOT a new disclosure: the record already
	 * persists `secret`, from which this value is derivable in one step. The
	 * PRIVATE half of the split — `contentKey`, the one that actually decrypts
	 * — is derived transiently at mint and is never persisted, never returned
	 * and never logged. Derived on BOTH paths (push and filesystem), so the
	 * revoke chain survives a mixed history. */
	lookupId: string;
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

/**
 * The body handed to a {@link BootstrapSealedUploader}, and therefore the wire
 * shape the rendezvous service must accept. Exactly four members, the fourth
 * optional.
 *
 * The service is handed `lookupId` and `expiresAt` and NOTHING else that could
 * identify the network, the authority, or the size of the roll: the payload is
 * ciphertext sealed under a `contentKey` that never leaves this phone, and the
 * service can derive nothing from `lookupId` beyond "some record exists".
 *
 * `revokeLookupId` exists because the service cannot infer that two codes
 * belong to one authority — the whole point of handing it nothing that
 * correlates them. Revocation of a superseded code therefore has to be
 * EXPLICIT and phone-driven, and it rides on the same request as the new mint
 * so that one round trip keeps the "biometric -> mint -> seal -> upload ->
 * render" sequence linear. The key is ABSENT (not present-and-undefined) when
 * there is no prior mint to revoke.
 */
export interface BootstrapUploadRequest {
	/** base64url, 43 characters, from `deriveBootstrapKeys`. */
	lookupId: string;
	/** 19-char canonical datetime, no `Z`. */
	expiresAt: string;
	/** The `{ v, nonce, ciphertext }` wrapper, passed through untouched. */
	sealed: SealedPayload;
	/** The PRIOR mint's `lookupId`. Absent when there is no prior mint. */
	revokeLookupId?: string;
}

/**
 * Performs the network I/O for one upload; resolves on the service's ack and
 * rejects on anything else. It is INJECTED — this module performs no network
 * I/O of its own and holds no base URL, no bearer token and no fetch call, so
 * the ordering guarantee it enforces (nothing persisted before the ack) is
 * testable with a fake and independent of any transport.
 */
export type BootstrapSealedUploader = (request: BootstrapUploadRequest) => Promise<void>;

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
 * FILESYSTEM-BINDING PATH ONLY. The regeneration fallback this feeds exists
 * solely to serve {@link redeemStagedSignInCode}'s cold-start path, and is
 * therefore INERT for the push path — on that path the phone holds no payload,
 * performs no redemption, and has nothing to regenerate. It is harmless to
 * leave registered and is retained for the filesystem binding.
 *
 * One interaction a later reader will otherwise trip over: a push-path record
 * is persisted in the tombstone shape while its code is STILL LIVE, so a
 * {@link redeemStagedSignInCode} call against a push-minted secret takes the
 * regeneration branch below and can answer `'ok'` with a freshly regenerated,
 * digest-matched snapshot. That is not a leak — it is the same payload the
 * service already holds under the same code — but it is reachable only through
 * the filesystem binding, which no code path currently constructs against this
 * app.
 *
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
	/** Optional for exactly one reason: a record written by a PRE-`lookupId`
	 * build never had one, and a tombstone made from it must have the key
	 * ABSENT rather than present-and-undefined. */
	lookupId?: string;
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
		// Conditional-spread, exactly like `redeemedAt` above: a legacy record
		// with no `lookupId` must produce a tombstone with the key absent, not
		// present-and-undefined.
		...(record.lookupId !== undefined ? { lookupId: record.lookupId } : {}),
	};
}

/**
 * WHAT SURVIVES A DISCARD, and why anything does.
 *
 * A second mint revokes the first AT THE SERVICE by riding a `revokeLookupId`
 * on the new upload: the service cannot infer that two codes belong to one
 * authority — it is handed nothing that correlates them — so revocation has to
 * be explicit and phone-driven. That chain reads the prior `lookupId` off the
 * staged record. But {@link clearStagedSignInCode} DESTROYS the staged record,
 * and the producer screen offers no generate control while a code is live, so
 * the sequence an officer actually performs is mint -> DISCARD -> mint. Without
 * this marker the second mint finds no prior record, sends no `revokeLookupId`,
 * and the discarded code stays redeemable at the service until its own expiry —
 * the phone has forgotten a code the service still holds and honours, which is
 * precisely the hazard the revoke exists to close. The revoke path would be
 * implemented, tested, and unreachable.
 *
 * The marker is the MINIMUM that keeps that chain alive, and nothing more. Both
 * of its fields were already handed to the service in the clear at upload time,
 * so retaining them past a discard discloses nothing the service does not
 * already hold. It must NEVER carry `code`, `secret`, `digest`, `snapshotName`
 * or `snapshotJson`: a discard's stated purpose is that it destroys a
 * credential, so preserving the bearer secret past one would be a strictly
 * worse defect than the missing revoke it is meant to fix. That is exactly why
 * this is a separate key with a separate two-field shape and NOT a
 * {@link TombstoneRecord} — a tombstone keeps `code`, `secret` and `digest`.
 *
 * AT MOST ONE marker exists, mirroring the at-most-one staged record: a later
 * discard overwrites an earlier marker, because only one revoke can ride one
 * upload.
 */
interface PendingRevokeMarker {
	/** The base64url (43-character) `lookupId` of the code a discard destroyed. */
	lookupId: string;
	/** The discarded code's own 19-char canonical `expiresAt`, no `Z` — recorded
	 * as the FACT of when the named code stops mattering, and deliberately NOT
	 * used to suppress a revoke: the expiry DECISION belongs to the service,
	 * whose clock is not this phone's, so a phone that skipped a revoke it
	 * judged moot could leave live at the service a code it had already
	 * forgotten. A revoke that arrives after expiry is harmless; one that is
	 * never sent is the defect. Optional purely for read-side robustness — a
	 * marker missing this field still names a code that must be revoked, and
	 * discarding the whole marker over an absent diagnostic field would trade a
	 * security property for a cosmetic one. */
	expiresAt?: string;
}

/**
 * Reads the pending-revoke marker. NEVER throws: an absent, unreadable or
 * shapeless marker is simply "no revoke pending", which degrades the revoke
 * chain rather than failing a mint.
 */
async function readPendingRevoke(): Promise<PendingRevokeMarker | undefined> {
	try {
		const raw = await AsyncStorage.getItem(PENDING_REVOKE_STORAGE_KEY);
		if (raw === null) {
			return undefined;
		}
		const parsed = JSON.parse(raw) as Record<string, unknown> | null;
		if (typeof parsed !== 'object' || parsed === null) {
			return undefined;
		}
		const { lookupId, expiresAt } = parsed;
		if (typeof lookupId !== 'string' || lookupId.length === 0) {
			return undefined;
		}
		return {
			lookupId,
			...(typeof expiresAt === 'string' ? { expiresAt } : {}),
		};
	} catch {
		return undefined;
	}
}

/**
 * Record `record`'s `lookupId` as the revoke the NEXT mint must carry. NEVER
 * throws and never blocks the discard that calls it: a discard destroys a
 * credential, and failing to destroy it because a marker write faulted would be
 * strictly worse than losing one revoke. A fault is reported by error CLASS
 * only — never the upstream message.
 */
async function writePendingRevoke(record: StagedSignInCode): Promise<void> {
	if (typeof record.lookupId !== 'string' || record.lookupId.length === 0) {
		// A record written by a PRE-`lookupId` build names nothing the service
		// could revoke. Write NO marker at all rather than an empty one, which
		// would be indistinguishable from a real pending revoke.
		return;
	}
	const marker: PendingRevokeMarker = {
		lookupId: record.lookupId,
		// Conditional-spread, exactly like `toTombstone`'s: absent, never
		// present-and-undefined.
		...(typeof record.expiresAt === 'string' ? { expiresAt: record.expiresAt } : {}),
	};
	try {
		await AsyncStorage.setItem(PENDING_REVOKE_STORAGE_KEY, JSON.stringify(marker));
	} catch (error) {
		console.warn(
			'dashboard-signin-code: could not record the pending revoke;',
			error instanceof Error ? error.name : typeof error,
		);
	}
}

/** Drops the pending-revoke marker once its revoke has been DELIVERED. NEVER
 * throws: a failed removal only means the next mint re-sends the same revoke,
 * which the service treats identically. */
async function clearPendingRevoke(): Promise<void> {
	try {
		await AsyncStorage.removeItem(PENDING_REVOKE_STORAGE_KEY);
	} catch (error) {
		console.warn(
			'dashboard-signin-code: could not drop the delivered revoke marker;',
			error instanceof Error ? error.name : typeof error,
		);
	}
}

/**
 * Mint a new bearer sign-in code for `snapshot` and persist it as the ONE
 * staged record, replacing whatever was staged before (see the security note on
 * {@link StagedSignInCode} above — the replaced code becomes instantly
 * unredeemable). `spanMinutes` and `now` exist ONLY so tests can pin the span
 * and the clock; production callers pass neither.
 *
 * TWO PATHS, selected by whether `uploader` is supplied:
 *
 *   - **`uploader` ABSENT — the filesystem-binding path.** Behaviour is
 *     unchanged from before the rendezvous service existed, except that
 *     `lookupId` is now also derived and persisted. The RETURNED record carries
 *     `snapshotJson` in memory (so {@link stageForFilesystemBinding} works in
 *     the same session); the PERSISTED record never does.
 *   - **`uploader` PRESENT — the push path.** NOTHING about the new code
 *     reaches `AsyncStorage` until the uploader acknowledges. The snapshot is
 *     sealed under the `contentKey` derived from this mint's own secret and the
 *     wrapper is handed to the uploader FIRST; only on the ack is a record
 *     written, and it is born in the tombstone shape plus `lookupId`. The
 *     returned record carries no `snapshotJson`. A rejection writes nothing at
 *     all, so a refused upload is a complete no-op.
 */
export async function mintDashboardSignInCode(
	snapshot: BootstrapSnapshot,
	options?: { spanMinutes?: number; now?: Date; uploader?: BootstrapSealedUploader },
): Promise<StagedSignInCode> {
	const spanMinutes = options?.spanMinutes ?? DASHBOARD_SIGNIN_CODE_SPAN_MINUTES;
	const now = options?.now ?? new Date();
	const uploader = options?.uploader;

	// Read the PRIOR record before anything is generated or written: its
	// `lookupId` is the value the rendezvous service needs in order to retire
	// the superseded code, and the service cannot infer it. Reading first also
	// means the failure path below has nothing to undo.
	const previous = await readStagedSignInCode();
	// ...and, when there is no live record to read it from, fall back to the
	// marker a DISCARD left behind. This fallback is what makes the revoke
	// REACHABLE AT ALL rather than merely implemented: the producer screen shows
	// no generate control while a code is live, so every re-mint in the real
	// product goes through a discard first — and a discard destroys the record
	// the line above reads. Read only when the record yields nothing, so a live
	// record always wins; the marker is the older fact of the two.
	const pendingRevoke = previous?.lookupId === undefined ? await readPendingRevoke() : undefined;
	const previousLookupId = previous?.lookupId ?? pendingRevoke?.lookupId;

	// The secret, generated in one confined block. Deliberately
	// `crypto.getRandomValues` raw output, NEVER `secp256k1.utils.randomSecretKey()`
	// — see the module header's "NOT A KEY" paragraph.
	const secretBytes = new Uint8Array(20);
	globalThis.crypto.getRandomValues(secretBytes);

	// Derive the key split from the RAW BYTES, here, while they still exist —
	// never from the hex rendering below. The rendering is a presentation
	// detail; the bytes are the secret. Deriving from the rendering would
	// silently move BOTH halves of the split on any future encoding change,
	// producing a lookupId the service has never seen and a contentKey that
	// cannot open the document already sealed under the old one.
	const keys = deriveBootstrapKeys(secretBytes);

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
		lookupId: keys.lookupId,
		expiresAt,
		mintedAt,
		snapshotName,
		snapshotJson,
	};

	if (uploader === undefined) {
		// ---- the filesystem-binding path, unchanged apart from `lookupId` ----
		// The payload lives in memory ONLY — a second mint overwrites it,
		// instantly stranding whatever the first mint staged.
		stagedSnapshotJson = snapshotJson;

		const persisted: PersistedStagedRecord = {
			code,
			secret,
			digest,
			lookupId: keys.lookupId,
			expiresAt,
			mintedAt,
			snapshotName,
		};
		await AsyncStorage.setItem(STAGED_CODE_STORAGE_KEY, JSON.stringify(persisted));
		return record;
	}

	// ------------------------------- the push path -------------------------------
	// Validate the one value that crosses the wire before it crosses it, rather
	// than writing a fourth reimplementation of the canonical-datetime check.
	assertCanonicalBootstrapDatetime(expiresAt, 'mintDashboardSignInCode');

	const sealed = sealPayload(snapshotJson, keys);

	const request: BootstrapUploadRequest = {
		lookupId: keys.lookupId,
		expiresAt,
		sealed,
		// Conditional spread so the key is ABSENT, not present-and-undefined,
		// when there is no prior mint to revoke.
		...(previousLookupId !== undefined ? { revokeLookupId: previousLookupId } : {}),
	};

	try {
		await uploader(request);
	} catch (error) {
		// The error CLASS only — never the upstream message, which may embed a
		// URL, a bearer token, or a response body.
		console.warn(
			'dashboard-signin-code: the sealed payload upload was refused;',
			error instanceof Error ? error.name : typeof error,
		);
		// A FRESH error with a fixed message and deliberately NO `cause`. A
		// `cause` is precisely the vector by which a raw upstream message
		// reaches a log line or a crash report, which is the thing the
		// class-only rule forbids — so do not "improve" this by attaching one.
		const failure = new Error('dashboard-signin-code: the sealed payload upload was refused');
		failure.name = 'BootstrapUploadFailedError';
		throw failure;
	}

	// NOTHING above this line touched storage: not the new record, not the
	// previous one, not `stagedSnapshotJson`. A refused upload therefore leaves
	// the phone exactly as it was — and because the revoke rides on this same
	// request, it also leaves the SERVICE exactly as it was, so the two stay
	// consistent for free and only by writing nothing.

	// Drop whatever payload a PREVIOUS (filesystem-path) mint left in memory.
	// The new payload is never assigned to it at all, which is strictly
	// stronger than "drop it on ack": on this path the whole-database export
	// never occupies a module-level slot for even one tick.
	stagedSnapshotJson = undefined;

	// The record is BORN in the tombstone shape while its code is still live.
	// That is intentional — under push-at-mint this phone is no longer the
	// redemption authority for this code, so the only thing worth keeping is
	// the fact of the code, not the export it describes.
	await AsyncStorage.setItem(
		STAGED_CODE_STORAGE_KEY,
		JSON.stringify({ ...toTombstone(record), lookupId: keys.lookupId }),
	);

	// The revoke this upload carried has now been DELIVERED, so the marker that
	// held it has done its job. Two deliberate constraints on this removal:
	//
	//   - It happens AFTER the record write, never before. A crash in between
	//     leaves the marker in place and the next mint re-sends the same
	//     revoke, which the service treats identically — the safe direction.
	//   - It happens ONLY when the revoke actually came FROM the marker
	//     (`pendingRevoke` is read above only in that case). If it came from a
	//     live staged record instead, the marker still names an older code
	//     whose revoke has never been delivered, and it must survive to be
	//     attempted again rather than be dropped undelivered.
	//
	// A REFUSED upload never reaches this line at all, so a failed mint leaves
	// the marker intact and the revoke is attempted again next time.
	if (pendingRevoke !== undefined) {
		await clearPendingRevoke();
	}

	// Strip the payload from the RETURNED value by omission, so the key is
	// genuinely absent rather than present-and-undefined: nothing a caller can
	// serialize carries the export. `snapshotName` stays because the interface
	// requires it; it is simply absent from storage.
	const returned: StagedSignInCode = { ...record };
	delete returned.snapshotJson;
	return returned;
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

/** What one {@link purgeLegacyStagedPayload} pass found and did. A closed
 * four-member vocabulary, safe to log verbatim: no member names a record
 * field and none can carry a byte of a payload. */
export type LegacyStagedPayloadSweepOutcome = 'absent' | 'clean' | 'legacy-payload' | 'unreadable';

/**
 * Collapse any staged record written by a PRE-FIX build — one that still
 * carries `snapshotJson` — to its tombstone shape. Designed to be called
 * unconditionally at app start, because it is a no-op on every record any
 * current build can write. NEVER throws: it runs during app start, where a
 * rejection would take the shell down with it.
 *
 * WHY IT EXISTS, in measured terms. Two of two real devices checked were
 * still holding a pre-fix record: 5533 and 5472 bytes, against the 312 bytes a
 * correct post-fix record occupies, with a 4689-byte `snapshotJson` carrying
 * populated Admin / Authority / Network / Officer / User / UserKey rows — read
 * roughly fifteen hours PAST each record's own `expiresAt`. Nothing in the
 * tree migrates them: the only three paths that ever rewrite the key are a
 * redemption attempt, a fresh mint, and {@link clearStagedSignInCode}, and an
 * expired code nobody tries to redeem is touched by none of them. So the
 * payload simply sits there, beside the bearer secret that unlocks it, with
 * both of the bounds that gave that secret its security value already gone.
 *
 * Tombstone rather than delete: a device that keeps the FACT of the code can
 * still answer `'used'` / `'expired'` precisely instead of degrading to
 * `'unknown'`, which is the discipline the rest of this module already
 * follows.
 *
 * There is deliberately NO module-level "already ran" flag. The function is
 * naturally idempotent, and a flag would only add module state that
 * {@link __resetInMemoryStateForTests} would then have to know about.
 */
export async function purgeLegacyStagedPayload(): Promise<LegacyStagedPayloadSweepOutcome> {
	let raw: string | null;
	try {
		raw = await AsyncStorage.getItem(STAGED_CODE_STORAGE_KEY);
	} catch {
		// A storage fault is not a crash here — report it and let app start
		// continue.
		return 'unreadable';
	}
	if (raw === null) return 'absent';

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		// Removal rather than tombstoning: an unparseable value may still
		// contain a readable payload FRAGMENT, and there is no record left to
		// preserve — nothing can be reduced to a tombstone that cannot first be
		// read as a record.
		try {
			await AsyncStorage.removeItem(STAGED_CODE_STORAGE_KEY);
		} catch {
			// Best effort; still report what was found.
		}
		return 'unreadable';
	}
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
		// Parseable JSON that is not a record object — same reasoning as an
		// unparseable value: it cannot be tombstoned, so it is removed.
		try {
			await AsyncStorage.removeItem(STAGED_CODE_STORAGE_KEY);
		} catch {
			// Best effort.
		}
		return 'unreadable';
	}

	// Read the parsed value as a bare record, NOT through
	// {@link readStagedSignInCode}: that function's documented contract is that
	// its result never carries `snapshotJson` — which is exactly the field this
	// sweep exists to find. Routing through it would hide the thing being
	// looked for.
	const fields = parsed as Record<string, unknown>;
	if (!Object.prototype.hasOwnProperty.call(fields, 'snapshotJson')) {
		// Write nothing on the clean path: rewriting a live record on every app
		// start, for no reason, is its own defect.
		return 'clean';
	}

	// Reuse `toTombstone` rather than spelling a second reduction out here —
	// that is what guarantees this sweep and the redemption path can never
	// drift into two different tombstone shapes.
	const redeemedAt = typeof fields.redeemedAt === 'string' ? fields.redeemedAt : undefined;
	try {
		await AsyncStorage.setItem(
			STAGED_CODE_STORAGE_KEY,
			JSON.stringify(toTombstone(parsed as StagedSignInCode, redeemedAt)),
		);
	} catch {
		return 'unreadable';
	}
	return 'legacy-payload';
}

/**
 * Drops the staged record (idle-state reset) and clears the in-memory payload,
 * preserving ONLY the discarded code's `lookupId` — in a separate
 * {@link PendingRevokeMarker}, never a tombstone — so the next mint can still
 * revoke that code at the rendezvous service. See {@link PendingRevokeMarker}
 * for why the marker exists, and for why it carries nothing else: the
 * credential this function's caller means to destroy must not survive it.
 *
 * ORDER IS LOAD-BEARING. The marker is written BEFORE the record is removed,
 * so the fact is captured while the record that carries it still exists. The
 * marker write can neither block nor fail the discard: destroying the
 * credential is the point, and it must happen even if nothing about the revoke
 * could be recorded.
 */
export async function clearStagedSignInCode(): Promise<void> {
	stagedSnapshotJson = undefined;
	const record = await readStagedSignInCode();
	if (record !== undefined) {
		await writePendingRevoke(record);
	}
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
 * The result of a PRODUCER-SIDE staged-code redemption.
 *
 * Deliberately declared HERE rather than borrowed from the bootstrap transport
 * seam. `redeemStagedSignInCode` is not a transport: it resolves a staged code
 * to a plaintext envelope in memory, on the phone, on the trusted side of the
 * boundary. It only ever shared the seam's shape by coincidence, and the seam
 * has since moved on — a courier now carries a SEALED wrapper, which is
 * precisely the thing this function is not doing. Reusing the seam's type here
 * would silently re-couple a producer to a courier contract that no longer
 * describes it.
 *
 * `snapshot` is present IF AND ONLY IF `status === 'ok'`.
 */
type StagedSignInCodeRedemption = {
	status: BootstrapRedemptionStatus;
	snapshot?: BootstrapSnapshot;
};

/**
 * FILESYSTEM-BINDING PATH ONLY. This function has ZERO non-test callers in
 * production source. Under encrypted push-at-mint the phone is not involved in
 * redemption at all: the browser redeems against the rendezvous service, which
 * serves ciphertext this phone uploaded and then dropped. It remains live and
 * correct as the filesystem binding's producer-side redemption authority, and
 * is kept for that reason alone — deleting it would delete that authority with
 * no replacement. Its payload-before-stamp ordering below is still fully
 * load-bearing on that path.
 *
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
 * `snapshot` is OMITTED on every refusal: it is present if and only if the
 * status is `'ok'`, so a caller can never consume a partial artifact.
 */
export async function redeemStagedSignInCode(
	secret: string,
	options?: { now?: Date },
): Promise<StagedSignInCodeRedemption> {
	const attempt = redemptionChain.then(async (): Promise<StagedSignInCodeRedemption> => {
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
 * FILESYSTEM-BINDING PATH ONLY.
 *
 * Emit the TWO documents the shipped `filesystem-bootstrap-transport.ts`
 * reads — `codes/<secret>.json` and `snapshots/<snapshotName>.json` — WITHOUT
 * performing any I/O: this app has no filesystem dependency, and the
 * standalone receiver service that would eventually write these bytes is
 * explicitly not built in this phase. An operator or a future service writes
 * them verbatim.
 *
 * The snapshot document is a SEALED WRAPPER (`{ v, nonce, ciphertext }`), not a
 * serialized envelope: the receiver unseals it with the `contentKey` derived
 * from the code's secret half, exactly as the binding's own on-disk-layout
 * block now describes.
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

	// The hex round trip is acceptable HERE and forbidden at mint. At mint the
	// raw `secretBytes` still exist, so deriving from the rendering would let a
	// future encoding change silently move BOTH halves of the split. By the
	// time a record reaches this function the hex string is the only surviving
	// representation of the secret, so there is nothing else to derive from.
	// The two derivations are held together by the spec case
	// "the snapshot document is a SEALED WRAPPER that unseals to the envelope,
	// and the hex round trip reproduces the mint own key split", which asserts
	// that this `lookupId` equals the one the mint derived from the raw bytes —
	// so an encoding change breaks that test rather than silently producing a
	// document the binding cannot open.
	const keys = deriveBootstrapKeys(hexToBytes(record.secret));

	// `snapshots/current.json` is DELETED, not sealed. `pullSnapshot` was
	// removed from the seam and from both bindings, so nothing reads it; and a
	// document shared across codes has no single `contentKey` to be sealed
	// under, so under sealing it is not merely dead but incoherent. The side
	// benefit is worth stating plainly: it was a SECOND full-plaintext copy of
	// the authority's whole database on disk, and dropping it is the same
	// posture this module applies to `AsyncStorage`.
	const documents = [
		{ path: `codes/${record.secret}.json`, contents: JSON.stringify(codeDocument) },
		{
			path: `snapshots/${record.snapshotName}.json`,
			contents: JSON.stringify(sealPayload(snapshotJson, keys)),
		},
	];

	record.stagedAt = toCanonical(new Date());
	return documents;
}
