import type { Database } from '@quereus/quereus';
import type { SAppConfig } from './types.js';
import type { Ed25519KeyPair } from './ed25519-key.js';
/**
 * The engine (rules-logic system) assumed to manage every strand. Persisted in
 * `Strand.Header.Engine`.
 *
 * PLACEHOLDER SEAM: there is no engine-selection mechanism yet — Quereus is the
 * only engine. When a real engine-config seam lands, the founder bootstrap should
 * read the strand's chosen engine from there instead of this constant. Documented
 * deliberately so the column is non-null and self-describing in the meantime.
 */
export declare const STRAND_ENGINE = "quereus";
/**
 * The pinned engine version recorded in `Strand.Header.EngineVersion`. A pinned
 * string for the same reason as {@link STRAND_ENGINE}: it is a documented
 * placeholder until an engine-selection seam supplies the real running version.
 */
export declare const STRAND_ENGINE_VERSION = "0.1.0";
/**
 * The single-payload ed25519 signer the `Strand.Invite`/`Strand.ConsumedInvite`
 * handshake constraints verify against.
 *
 * Those constraints sign a single SHA-256 digest over a `'|'`-joined payload
 * (e.g. `InviteValid` verifies
 * `verify(digest(new.Key || '|' || coalesce(new.Expiration, '')), ...)`).
 * So the signer hashes the payload to raw bytes and ed25519-signs *those bytes*:
 * SQL `digest(...)`'s default output is base64url and `verify(...)`'s default
 * `inputEncoding` is base64url, so signer and verifier operate on identical bytes.
 * The membership/RBAC tables (Member/Manager/MemberPeer/Revocation) instead use
 * domain/action-tagged VARIADIC digests — see {@link signStrandApproval}.
 *
 * All strand keys are ed25519, so the explicit `'ed25519'` curve arg is mandatory
 * (the crypto plugin otherwise defaults to secp256k1). Mirrors the proven
 * `signItem` helper in the `rbac-signed-write` integration scenario.
 *
 * @param payload - The `'|'`-joined payload the matching constraint hashes.
 * @param privateKeyB64 - The signer's base64url ed25519 private seed.
 * @returns The base64url ed25519 signature over the payload's SHA-256 digest.
 */
export declare function signStrandPayload(payload: string, privateKeyB64: string): string;
/**
 * The verifier counterpart to {@link signStrandPayload}.
 *
 * Mirrors what the single-payload `Strand.*` constraints compute:
 * `verify(digest(payload), signature, publicKey, 'ed25519')`.
 * SQL `digest`'s default output and `verify`'s default `inputEncoding`/`sigEncoding`/
 * `keyEncoding` are all base64url, so the off-engine check operates on the exact
 * same bytes the in-engine CHECK does. Used by the off-engine `MemberVerifier`
 * (pre-flight registration checks) so the on-engine constraint is not the only
 * place a member self-proof is validated.
 *
 * @param payload - The `'|'`-joined payload the matching constraint hashes.
 * @param signatureB64 - The base64url ed25519 signature to check.
 * @param publicKeyB64 - The base64url ed25519 public key to verify against.
 * @returns `true` iff the signature is valid for the payload under that key.
 */
export declare function verifyStrandPayload(payload: string, signatureB64: string, publicKeyB64: string): boolean;
/**
 * Sign a domain/action-tagged `Strand.*` membership/RBAC approval.
 *
 * Every `Authorized` branch on `Member`/`Manager`/`MemberPeer`/`Revocation`
 * verifies a VARIADIC digest — `digest('<domain>', '<action>', <field>, ...,
 * <StampId>)` — whose leading two elements are fixed literals (the domain tag,
 * e.g. `'Strand.Member'`, and an action tag, e.g. `'add'`) and whose trailing
 * element is the row's per-incarnation StampId. The tags keep an approval from
 * verifying against any rule but the one it was minted for (the idiom of the
 * control layer's `buildAuthorizationMessage`); the StampId binding makes it
 * single-use — it authorizes exactly one incarnation of one row, and dies when
 * that row's stamp is retired into `Strand.Revocation`.
 *
 * The caller passes the digest elements exactly as the matching SQL constraint
 * lists them (each SQL argument = one array element), PRESERVING TYPE: the
 * crypto plugin's digest framing is type-tagged (INTEGER 1 and TEXT '1' encode
 * differently, deliberately), so `Manager.Authorized`'s promotion branch —
 * whose digest includes the INTEGER `new.Generation` — must be signed over the
 * NUMBER, not its string form. Integer `number` and `bigint` encode
 * identically in that framing, so JS-side numbers match however the engine
 * represents the SQL integer.
 *
 * Like {@link signStrandPayload}, the raw digest BYTES are ed25519-signed
 * directly, matching SQL `verify(...)`'s default base64url input decoding.
 *
 * @param fields - The digest elements, in constraint order (tags first, StampId last).
 * @param privateKeyB64 - The signer's base64url ed25519 private seed.
 * @returns The base64url ed25519 signature over the tagged digest.
 */
export declare function signStrandApproval(fields: ReadonlyArray<string | number>, privateKeyB64: string): string;
/**
 * Mint a fresh per-row authorization nonce (StampId) for a `Strand.Member`,
 * `Strand.Manager`, or `Strand.MemberPeer` row.
 *
 * 256 bits of CSPRNG output, base64url-encoded — enough entropy that a future
 * legitimate stamp cannot be guessed and pre-planted into `Strand.Revocation`
 * (the `RowIsGone` comment in `schemas/strand.qsql` leans on exactly this).
 * Plain randomness, deliberately NOT the control layer's peer-derived
 * `generateStampId`: strand rows are not per-peer, so entropy alone carries
 * the uniqueness.
 *
 * @returns A fresh base64url stamp (43 chars for 32 bytes).
 */
export declare function generateStrandStampId(): string;
/**
 * A membership writer that runs only in a transaction of its own found another
 * transaction already open on the strand database, and wrote nothing. Raised only
 * under `joinOpenTransaction: false` (see {@link StrandWriteOptions}) — the background
 * callers, which treat it as "the app is mid-transaction; try again later".
 */
export declare class StrandTransactionBusyError extends Error {
    constructor(options?: ErrorOptions);
}
/** Options every transactional membership writer accepts. */
export interface StrandWriteOptions {
    /**
     * Default true: when a transaction is already open on the database, run the writer's
     * statements inside it. The caller composes several writers in one transaction (e.g. a
     * resign + revoke pair that must land together) and owns its commit and rollback, so
     * the deferred constraints fire once, at the caller's commit.
     *
     * Background callers (the membership reconciler, the unpublish binding cleanup) pass
     * false: they share the database with the app and must never join a transaction
     * someone else opened, so the writer throws {@link StrandTransactionBusyError} instead.
     */
    joinOpenTransaction?: boolean;
}
/** Parameters for {@link bootstrapFounderMembership}. */
export interface FounderBootstrapParams {
    /** The strand id — written to `Header.Id`. */
    strandId: string;
    /** Strand type: `'o'` (open, Header only) or `'c'` (closed, Header+Member+Manager). */
    type: 'o' | 'c';
    /** The sApp config whose id/version/schema/signature populate the Header. */
    sApp: SAppConfig;
    /**
     * The founder's derived strand keypair (from {@link strandMemberKeyPair}). Its
     * `publicKeyB64` becomes the founding `Member.Key` and `Manager.MemberKey`.
     * Required for a closed strand; ignored for an open strand.
     */
    founderKeyPair?: Ed25519KeyPair;
    /**
     * The public key derived from the strand row's SHARED `MemberPrivateKey` (the read
     * secret every joining party holds). When supplied for a closed strand, a
     * `Strand.Member` or `Strand.Manager` row holding it refuses the bootstrap with
     * {@link PreSplitStrandIdentityError} (see {@link assertNotPreSplitStrand}): nothing
     * seats that key since the per-party identity split, so its presence is exactly the
     * fingerprint of a strand founded before it. Omitted, no such check runs (a caller that
     * holds no shared key has nothing to compare against). Ignored for an open strand.
     */
    sharedMemberPublicKey?: string;
}
/**
 * A closed strand founded BEFORE the per-party identity split: its founding
 * `Strand.Member` (and, unless handed on, `Strand.Manager`) is the key derived from the
 * shared `MemberPrivateKey`, which every joining party holds, so any member can sign as
 * the founder. There is no repair — rewriting the membership cannot be trusted, since any
 * joiner could already have admitted or revoked anyone, or could race the rewrite — so
 * the strand must be recreated. Thrown by {@link assertNotPreSplitStrand} (a founder
 * bootstrap, or membership-invite issuance); the formation layer maps it to a
 * non-retryable rejection.
 */
export declare class PreSplitStrandIdentityError extends Error {
    readonly strandId: string;
    constructor(strandId: string);
}
/**
 * Refuse a closed strand whose membership still holds the key derived from the shared
 * `MemberPrivateKey` (see {@link FounderBootstrapParams.sharedMemberPublicKey}). `Member`
 * is the primary probe — every manager is a member (`Manager.MemberExists`), so it also
 * catches a pre-split founder who handed management to another key and resigned, or a
 * sealed pre-split strand. `Manager` is probed too, for the partition case the schema
 * notes on `MemberExists` (a Manager row converged without its Member row). Cannot
 * misfire: nothing seats the shared-derived key since the split, and rows not yet loaded
 * read as absent.
 *
 * @throws {PreSplitStrandIdentityError} when a `Strand.Member` or `Strand.Manager` row is
 *   the shared-derived key.
 */
export declare function assertNotPreSplitStrand(db: Database, strandId: string, sharedMemberPublicKey: string): Promise<void>;
/**
 * Founder-only one-time bootstrap of a strand's `Strand.*` membership/RBAC rows.
 *
 * Runs once at bring-up on the strand's FOUNDER (the party that provisioned and
 * published the strand). A joiner never calls this — it receives these rows via
 * Optimystic sync. Every write is insert-if-absent (guarded by a row count) so a
 * restart / founder re-`addStrand` is a no-op and never double-inserts.
 *
 * Behavior by strand type:
 * - **Open (`'o'`)**: insert `Header` only. `Member`/`Manager`/`Invite` are
 *   `OnlyClosed` and would trip that constraint — they are skipped entirely.
 * - **Closed (`'c'`)**: insert `Header(Type='c')`, then the founding `Member`
 *   (`Key = founderKeyPair.publicKeyB64`), then the founding `Manager`
 *   (`MemberKey = founderKeyPair.publicKeyB64`). Insert order matters: the
 *   Header must commit before the deferred `OnlyClosed` checks on Member/Manager
 *   evaluate at commit.
 *
 * A closed strand with no `founderKeyPair` throws: a closed strand with no founding
 * Manager could never admit anyone, so failing loudly here (which propagates out
 * of `StrandDatabase.initialize()` and triggers the runtime's rollback) is correct.
 *
 * A closed strand whose membership holds `sharedMemberPublicKey` throws
 * {@link PreSplitStrandIdentityError} before writing anything: the insert-if-absent
 * guards would otherwise skip over its pre-split founding rows and leave the shared
 * key seated.
 *
 * @param db - The strand's Quereus database (schema already applied).
 * @param params - Strand id/type, the sApp config for the Header, and (closed only)
 *   the derived founder keypair and the shared-derived public key to refuse.
 * @throws If `type === 'c'` and no `founderKeyPair` is supplied.
 * @throws {PreSplitStrandIdentityError} If `type === 'c'` and a `Strand.Member` or
 *   `Strand.Manager` row is `sharedMemberPublicKey`.
 */
export declare function bootstrapFounderMembership(db: Database, params: FounderBootstrapParams): Promise<void>;
/** Parameters for {@link issueInvite}. */
export interface IssueInviteParams {
    /**
     * The issuing manager's strand keypair. Its `publicKeyB64` must already be a
     * `Strand.Manager` row (the `InviteValid` constraint rejects a non-manager).
     */
    managerKeyPair: Ed25519KeyPair;
    /**
     * Optional invite expiry as epoch milliseconds. When set, it is canonicalised
     * via {@link canonicalDatetime} so the signed payload segment byte-matches the
     * `datetime`-coerced `Invite.Expiration` the deferred CHECK sees. When omitted,
     * the invite never expires and the signed segment is `''` (matching the schema's
     * `coalesce(new.Expiration, '')`).
     */
    expiration?: number;
}
/** The minted invite: a public key (the `Invite.Key`) plus its private seed. */
export interface IssuedInvite {
    /** The invite ed25519 PUBLIC key (base64url) — the `Invite.Key` primary key. */
    inviteKey: string;
    /**
     * The invite ed25519 PRIVATE seed (base64url). Handed out-of-band to the
     * invitee; whoever holds it can {@link consumeInvite} exactly once. NEVER
     * persisted in the strand — only the public key is.
     */
    invitePrivateKey: string;
}
/**
 * Issue a single-use invitation to join a closed strand.
 *
 * Generates a fresh invite ed25519 keypair (the public key becomes `Invite.Key`),
 * builds the constraint's payload (`Key || '|' || coalesce(Expiration, '')`), and
 * signs it TWICE: with the manager private key (→ `ManagerSignature`, proving
 * a manager issued it) and with the invite private key (→ `InviteSignature`,
 * proving the issuer actually holds the invite secret). Both signatures plus the
 * manager public key are bound as constraint context for the `Invite` insert.
 *
 * The returned `invitePrivateKey` is the only secret the invitee needs to redeem
 * the invite — it is NOT stored in the strand (only `Invite.Key`, the public half,
 * is). Single-use is enforced at consumption time: `ConsumedInvite`'s primary key
 * is `InviteKey`, so a given invite can be consumed at most once.
 *
 * @param db - The closed strand's database (founder already bootstrapped).
 * @param params - The issuing manager keypair and optional expiry.
 * @returns The invite public key and the out-of-band private seed.
 */
export declare function issueInvite(db: Database, params: IssueInviteParams): Promise<IssuedInvite>;
/** Parameters for {@link consumeInvite}. */
export interface ConsumeInviteParams {
    /** The `Invite.Key` (invite PUBLIC key, base64url) being redeemed. */
    inviteKey: string;
    /** The matching invite PRIVATE seed (base64url) received out-of-band. */
    invitePrivateKey: string;
    /** The joining member's ed25519 PUBLIC key (base64url) — the new `Member.Key`. */
    memberKey: string;
    /**
     * The instant (epoch ms) to compare against the invite's `Expiration` for the
     * `NotExpired` gate. Defaults to `Date.now()`; tests pin it so the comparison is
     * deterministic. Mirrors the control-layer `redeemInvitation`'s `nowMs` convention.
     */
    nowMs?: number;
}
/**
 * Redeem an invite to admit a new `Member`, atomically.
 *
 * `Member.Authorized`'s invite branch needs a `ConsumedInvite` row, while
 * `ConsumedInvite`'s `MemberExists` needs the `Member` row — a circular
 * dependency. Both are deferred (subquery-bearing) checks that evaluate
 * at COMMIT, so inserting `Member` then `ConsumedInvite` inside one explicit
 * transaction lets both rows exist when the deferred checks fire. This mirrors
 * `ControlDatabase.redeemInvitation` (Strand + FormationUsage in one txn).
 *
 * The `ConsumedInvite` insert carries an `InviteSignature` over
 * `InviteKey || '|' || MemberKey`, proving the consumer holds the invite private
 * key (the on-engine `ValidUsage` gate). The `Member` insert needs no member
 * signature — its admission is the existence of the matching `ConsumedInvite` —
 * but still mints a fresh StampId (NOT NULL on every path; a revoked-then-
 * re-invited member is a fresh incarnation under a fresh stamp).
 *
 * Single-use: `ConsumedInvite`'s primary key is `InviteKey`, so a second consume
 * of the same invite is rejected by the PK (a distinct layer from the control
 * network's `FormationUsage` single-use, which gates strand FORMATION, not the
 * per-strand member join enforced here).
 *
 * Expiry: the `ConsumedInvite.NotExpired` deferred check rejects redeeming an invite
 * whose `Expiration` is at or before `context.Now`. `Now` is supplied here as a
 * canonical-datetime string from `canonicalDatetime(db, nowMs)` — the SAME transform
 * `issueInvite` uses to store `Invite.Expiration` — so both sides of the schema's
 * `I.Expiration > context.Now` comparison are byte-identical canonical strings and
 * the lexical `>` orders chronologically at any granularity. (This intentionally
 * diverges from the control layer, which passes `Now` as a JS ISO string; Quereus
 * does not coerce context params, so an ISO `Now` would be compared lexically against
 * the canonical, T-separated `Expiration` and could mis-order near-same-instant
 * timestamps (due to a trailing `.000Z` suffix). The control tests only use far-future/far-past expiries, so that latent
 * skew never bites there — the strand layer avoids it outright.) A null `Expiration`
 * never expires. Like `ValidUsage`, `NotExpired` defers to commit, so an expired
 * invite rolls back the whole txn — neither the `Member` nor the `ConsumedInvite`
 * row survives.
 *
 * @param db - The closed strand's database.
 * @param params - The invite key/secret, the joining member's public key, and an
 *   optional `nowMs` instant for the expiry comparison (default `Date.now()`).
 * @param options - Whether to join an already-open transaction (see {@link StrandWriteOptions}).
 * @throws If any constraint rejects (bad signature, missing invite, or an expired
 *   invite); the whole transaction rolls back (neither the `Member` nor the
 *   `ConsumedInvite` row survives).
 * @throws {StrandTransactionBusyError} Under `joinOpenTransaction: false`, when another
 *   transaction is open; nothing was written.
 */
export declare function consumeInvite(db: Database, params: ConsumeInviteParams, options?: StrandWriteOptions): Promise<void>;
/**
 * Burn an invitation against an ALREADY-SEATED member: insert the
 * `Strand.ConsumedInvite` row alone, naming the existing `Member.Key`, so the bearer
 * credential can never be spent by anyone else.
 *
 * The already-member arm of the bring-up membership reconciler
 * (`strand-membership-reconciler.ts`): a machine that finds its party's `Member` row
 * already present (a sibling machine redeemed the invitation's twin first, or a
 * manager admitted the party directly) may still hold an UNSPENT formation-delivered
 * invitation — a bearer credential whoever presents can join with. Every
 * `ConsumedInvite` constraint is satisfiable without a same-transaction `Member`
 * insert (`MemberExists` reads the live table), so this is one statement whose
 * deferred checks fire at its own commit. It seats nobody now or later:
 * `Member.Authorized`'s invite branch requires a same-transaction FRESH consumption,
 * so the row it leaves is exactly as inert as any other spent invitation's.
 *
 * @param db - The closed strand's database (the member already exists).
 * @param params - The invite key/secret and the EXISTING member's public key, plus the
 *   optional `nowMs` instant for the expiry gate (default `Date.now()`).
 * @param options - Whether to join an already-open transaction (see {@link StrandWriteOptions}).
 * @throws If any constraint rejects — already consumed (the `InviteKey` primary key),
 *   cancelled, expired, or a sealed strand — or the cohort refuses the write. The
 *   reconciler routes these through the same classifier as a `consumeInvite` rejection:
 *   a dead invitation is dropped, a refused write keeps it staged for a retry.
 * @throws {StrandTransactionBusyError} Under `joinOpenTransaction: false`, when another
 *   transaction is open; nothing was tried, so the invitation is exactly as live as before.
 */
export declare function burnInvite(db: Database, params: ConsumeInviteParams, options?: StrandWriteOptions): Promise<void>;
/** Parameters for {@link cancelInvite}. */
export interface CancelInviteParams {
    /**
     * The cancelling manager's strand keypair. Its `publicKeyB64` must be a
     * PRE-EXISTING `Strand.Manager` row — `CancelledInvite.Authorized` reads
     * `committed.Manager`, so a manager seated in the SAME transaction cannot cancel.
     */
    managerKeyPair: Ed25519KeyPair;
    /** The `Invite.Key` to kill. */
    inviteKey: string;
}
/**
 * Cancel an outstanding invitation, permanently: it may never be consumed.
 *
 * Files a `Strand.CancelledInvite` tombstone carrying a manager signature over
 * `digest('Strand.CancelledInvite', 'cancel', InviteKey)`. The digest binds the exact
 * invite key, so an approval minted for one invitation cannot cancel another.
 *
 * One row, one statement — no transaction needed. `CancelledInvite.Authorized` is a
 * deferred (subquery-bearing) check, so it fires at this statement's own auto-commit.
 *
 * Insert-if-absent, matching {@link registerMemberPeer}'s and {@link revokeMember}'s
 * restart-safe shape: a repeat cancellation logs and returns rather than throwing on the
 * primary key. (Check-then-write is not atomic; the primary key is the real backstop —
 * the guard is for the sequential repeat/restart path.)
 *
 * Cancellation is what makes removal a re-entry gate: it is the `ConsumedInvite` insert
 * that `NotCancelled` blocks, and `Member.Authorized`'s invite branch needs a
 * same-transaction FRESH `ConsumedInvite` row, so a cancelled invitation rolls the whole
 * join back. Un-cancelling is impossible (`CancelledInvite.Immutable`) — to re-invite a
 * party, {@link issueInvite} a fresh invitation.
 *
 * Enumerate what there is to cancel with {@link listOutstandingInvites}: an invitation
 * names no invitee, so the strand cannot tell a manager WHICH invitations a departing
 * member holds. Invitee binding is tracked as `feat-strand-invitee-bound-invites`.
 *
 * @param db - The closed strand's database.
 * @param params - The cancelling manager's keypair and the invite key to kill.
 * @throws If `CancelledInvite.Authorized` rejects (a non-manager, a manager seated in
 *   this transaction, or an approval minted for a different invite key) or `OnlyClosed`
 *   rejects (an open strand); the insert rolls back, leaving no tombstone.
 */
export declare function cancelInvite(db: Database, params: CancelInviteParams): Promise<void>;
/** One redeemable invitation, as reported by {@link listOutstandingInvites}. */
export interface OutstandingInvite {
    /** The `Invite.Key` (invite public key, base64url). */
    inviteKey: string;
    /**
     * The expiry as the engine's canonical `datetime` string
     * (`YYYY-MM-DDTHH:MM:SS[.frac]`, no zone suffix — see {@link canonicalDatetime}), or
     * `null` for never-expires.
     *
     * Deliberately the STORED form, not the epoch-ms {@link IssueInviteParams.expiration}
     * takes: it is what compares like-for-like against another canonicalised instant, and
     * what the on-engine `NotExpired` gate sees. It is NOT a JS-parseable ISO instant —
     * pass it through the engine (or `canonicalDatetime`) rather than `Date.parse`.
     */
    expiration: string | null;
}
/**
 * The invitations that are still redeemable: neither consumed, nor cancelled, nor
 * expired at `nowMs`.
 *
 * `Strand.Invite` is insert-only and carries no state column, so "outstanding" is not a
 * property of the row — it is the `Invite` set minus the `ConsumedInvite` keys, minus
 * the `CancelledInvite` keys, minus anything whose `Expiration` has passed. All three
 * exclusions mirror gates a consume would hit anyway (`ConsumedInvite`'s primary key,
 * `NotCancelled`, `NotExpired`).
 *
 * Reads via unfiltered scans and compares in JavaScript — see {@link scanInviteKeys} for
 * why a full-PK where-equality is not reliable on a networked strand.
 *
 * Expiry is compared as `expiration > canonicalDatetime(nowMs)`: the same transform
 * {@link issueInvite} uses to STORE `Invite.Expiration`, so the string comparison orders
 * chronologically, and the same strict `>` the on-engine `NotExpired` gate uses (expiry
 * is exclusive — an invitation is dead at its expiry instant, not after it).
 *
 * This is the manager's enumeration side of {@link cancelInvite}, and the "door is open"
 * pre-flight behind `StrandMemberVerifier.isAuthorizedToJoin`.
 *
 * @param db - The closed strand's database.
 * @param nowMs - The instant (epoch ms) to compare expiries against; defaults to
 *   `Date.now()`. Tests pin it so the comparison is deterministic, mirroring
 *   {@link consumeInvite}'s `nowMs` convention.
 * @returns The redeemable invitations, in NO guaranteed order (the scans promise only a
 *   superset of the live rows, not a stable sequence — sort by `expiration` if order
 *   matters); empty if none.
 */
export declare function listOutstandingInvites(db: Database, nowMs?: number): Promise<OutstandingInvite[]>;
/**
 * Whether `memberKey` holds a live `Strand.Member` row, as seen by THIS database
 * instance — the membership probe behind the bring-up reconciler
 * (`strand-membership-reconciler.ts`). Reads via {@link memberStampId}'s unfiltered
 * scan + JavaScript compare (the {@link scanMemberPeers} argument for why a PK point
 * lookup is not reliable on a networked strand). Local visibility only: `false` can
 * mean "not replicated here yet", never a durable verdict about the strand.
 */
export declare function isStrandMember(db: Database, memberKey: string): Promise<boolean>;
/** Parameters for {@link addMemberByManager}. */
export interface AddMemberByManagerParams {
    /**
     * The admitting manager's strand keypair. Its `publicKeyB64` must be a
     * `Strand.Manager` row; it signs the add-tagged digest over the new member key
     * and its fresh stamp.
     */
    managerKeyPair: Ed25519KeyPair;
    /** The joining member's ed25519 PUBLIC key (base64url) — the new `Member.Key`. */
    memberKey: string;
}
/**
 * Admit a `Member` directly by manager signature — the sibling of the invite
 * path on `Member.Authorized`'s direct-manager branch.
 *
 * The constraint verifies the add-tagged digest
 * `digest('Strand.Member', 'add', new.Key, new.StampId)` against a pre-existing
 * (`committed.Manager`) row matching `context.ManagerKey`. The stamp is minted
 * fresh here and bound inside the signed digest, so the approval seats exactly
 * this incarnation: once the member is removed (retiring the stamp), the captured
 * approval can never re-seat it. No `ConsumedInvite` is involved: this is the
 * path a manager uses to seat a member it already trusts (e.g. a manager-side
 * enrollment that admits a party already authorised out-of-band).
 *
 * @param db - The closed strand's database.
 * @param params - The admitting manager keypair and the new member key.
 * @param options - Whether to join an already-open transaction (see {@link StrandWriteOptions}).
 * @throws If `Member.Authorized` rejects (e.g. a non-manager key); the insert
 *   rolls back, leaving no `Member` row.
 */
export declare function addMemberByManager(db: Database, params: AddMemberByManagerParams, options?: StrandWriteOptions): Promise<void>;
/** Parameters for {@link revokeMember}. */
export interface RevokeMemberParams {
    /**
     * The revoking manager's strand keypair. Its `publicKeyB64` must be a
     * PRE-EXISTING `Strand.Manager` row (the manager-removal branch of
     * `Member.Authorized` reads `committed.Manager` — a manager seated in the same
     * transaction cannot authorize); it signs the remove-tagged digest over the
     * target row's key and live stamp, and files the accompanying tombstone.
     */
    managerKeyPair: Ed25519KeyPair;
    /** The `Member.Key` row to delete. */
    memberKey: string;
}
/**
 * Revoke a `Member` on the signature of an existing manager.
 *
 * Reads the target row's live StampId first (a quiet no-op if the row is already
 * absent — a repeated or restarted revocation should not throw), then runs ONE
 * transaction pairing the delete with its `Strand.Revocation` tombstone: the
 * schema's `Member.RevocationRecorded` requires the tombstone in the same
 * transaction, and the tombstone is what permanently retires the stamp so the
 * captured admission approval can never re-seat this incarnation.
 *
 * The manager-removal branch of `Member.Authorized` verifies the remove-tagged
 * digest `digest('Strand.Member', 'remove', old.Key, old.StampId)` against a
 * `committed.Manager` row matching `context.ManagerKey` — distinct from the
 * add-tagged admission payload, and bound to the live stamp, so neither a
 * captured admission nor a captured PRIOR removal (whose stamp differs) replays.
 *
 * A revoked member cannot re-admit itself off the invite it ALREADY SPENT: that
 * `ConsumedInvite` row is stale, and the invite branch requires a
 * same-transaction FRESH consumption. Re-admission normally takes a fresh
 * manager action ({@link addMemberByManager} or a new invite).
 *
 * An UNSPENT invite the revoked party holds is killed EXPLICITLY, by the manager
 * calling {@link cancelInvite} on it (enumerate the candidates with
 * {@link listOutstandingInvites}); a cancelled invitation can never be consumed,
 * and cancellation is permanent. This removal does NOT cascade into cancellation:
 * an invitation names no invitee, so there is nothing to match the removed member
 * against — the strand cannot tell which invitations were meant for it, or whether
 * it holds any. Binding an invitation to its invitee is tracked as
 * `feat-strand-invitee-bound-invites`.
 *
 * A manager must resign its `Manager` row before (or in the same transaction
 * as) losing membership — `Member.NotAManager` rejects un-membering a key that
 * still holds a Manager row. And the strand never drops to zero members
 * (`Member.MinOneMember`, a local-count floor with the cross-node caveat its
 * schema NOTE states).
 *
 * Callers running inside a cadre runtime should follow this write with
 * `CadreNode.refreshRevocationEnforcement(strandId)`. The removed party's
 * machines are refused at the network layer by the strand's revoked-peer gate
 * (`strand-revocation-enforcer.ts`), which polls for membership changes because
 * this bare `Database` handle raises no event the runtime can hook — so without
 * that call the cut lands up to one poll interval (default 30 s) later.
 *
 * @param db - The closed strand's database.
 * @param params - The revoking manager keypair and the target member key.
 * @param options - Whether to join an already-open transaction (see {@link StrandWriteOptions}).
 * @throws If `Member.Authorized` rejects (a non-manager or same-transaction
 *   signer), `Member.NotAManager` rejects (the target still holds a Manager
 *   row), or `Member.MinOneMember` rejects (the removal would empty the member
 *   set); the whole delete+tombstone transaction rolls back.
 */
export declare function revokeMember(db: Database, params: RevokeMemberParams, options?: StrandWriteOptions): Promise<void>;
/** Parameters for {@link leaveStrand}. */
export interface LeaveStrandParams {
    /**
     * The departing member's OWN strand keypair. Its `publicKeyB64` is the
     * `Member.Key` row being deleted; it self-signs the leave-tagged digest —
     * the self-departure branch verifies the signature against `old.Key` itself,
     * so only the departing key's holder can produce it — and files the
     * accompanying tombstone (it is still a committed member until this very
     * transaction removes it, which is what `Revocation.Authorized` checks). No
     * manager is involved.
     */
    memberKeyPair: Ed25519KeyPair;
}
/**
 * A member leaves the strand by deleting its own `Member` row.
 *
 * The self-departure branch of `Member.Authorized` verifies
 * `digest('Strand.Member', 'leave', old.Key, old.StampId)` against `old.Key`
 * itself via `context.MemberSignature`. The `'leave'` tag (vs the manager
 * branch's `'remove'`) is belt-and-braces only — the two branches verify against
 * different keys; the anti-replay fix is the stamp binding. Like
 * {@link revokeMember}, the live stamp is read first (absent row → quiet no-op)
 * and the delete pairs with its `Strand.Revocation` tombstone in one transaction.
 *
 * The same floors as {@link revokeMember} apply: a manager must resign first
 * (`NotAManager`) and the last member cannot leave (`MinOneMember`).
 *
 * Like {@link revokeMember}, a caller inside a cadre runtime should follow this
 * with `CadreNode.refreshRevocationEnforcement(strandId)` — here it is what
 * makes the departing node notice its own departure promptly (the gate emits
 * `strand:revoked` when it finds this node's own peer id revoked).
 *
 * @param db - The closed strand's database.
 * @param params - The departing member's own keypair.
 * @param options - Whether to join an already-open transaction (see {@link StrandWriteOptions}).
 * @throws If `Member.Authorized`, `Member.NotAManager`, or `Member.MinOneMember`
 *   rejects; the whole delete+tombstone transaction rolls back.
 */
export declare function leaveStrand(db: Database, params: LeaveStrandParams, options?: StrandWriteOptions): Promise<void>;
/** Parameters for {@link registerMemberPeer}. */
export interface RegisterMemberPeerParams {
    /**
     * The member's OWN strand keypair (`{ privateKeyB64, publicKeyB64 }`). Its
     * `publicKeyB64` becomes `MemberPeer.MemberKey` and it self-signs the binding —
     * `MemberPeer.Authorized` verifies the signature against `MemberKey` itself, so a
     * peer can only be registered by the very member it belongs to (no manager
     * involved). The founder passes its `strandMemberKeyPair`; an invited member
     * passes its own keypair. Typed as {@link Ed25519KeyPair} only for the shared
     * base64url keypair shape — no manager privilege is implied.
     */
    memberKeyPair: Ed25519KeyPair;
    /** The peer/node id (libp2p peer id string) to associate with the member. */
    peerId: string;
}
/**
 * Register a network node (`PeerId`) as acting on behalf of a member.
 *
 * The member self-signs the add-tagged digest
 * `digest('Strand.MemberPeer', 'add', new.MemberKey, new.PeerId, new.StampId)`
 * with its OWN key; the schema's `MemberPeer.Authorized` verifies that signature
 * against `new.MemberKey` — i.e. the member key itself — so only the member that
 * owns the key can register peers for it. The stamp is minted fresh here and
 * bound inside the digest, so a captured registration approval neither
 * re-registers a cleared binding (its stamp is retired) nor authorizes a removal
 * (wrong tag). A deferred `MemberExists` additionally requires the `Member` row
 * to already exist, so a peer for a non-member is rejected at commit.
 *
 * Insert-if-absent: a re-register on restart (or a redundant call) is a no-op. The
 * platform DOES reject a duplicate-PK insert, but a restart-safe re-register should
 * succeed quietly rather than throw, so the writer guards on existence instead of
 * catching. The guard ({@link memberPeerStampId}) scans the member's peers and compares
 * both key columns in JavaScript rather than seeking the composite primary key — see
 * {@link scanMemberPeers} for why a full-PK point lookup is not reliable on a networked
 * strand. A member may register multiple DISTINCT `PeerId`s (multi-device); each is its
 * own row (and its own stamp) under the same `MemberKey`.
 *
 * Peer DELETION is signature-checked too, not rejected outright: `Authorized` carries
 * distinct delete branches (self + manager), each over its own action-tagged digest
 * bound to the row's stamp. Both removal paths live in {@link removeMemberPeer}.
 * UPDATE is refused outright by `NoUpdate`: a re-binding is a remove plus a fresh
 * register (under a fresh stamp).
 *
 * @param db - The closed strand's database (the member already exists).
 * @param params - The member's own keypair and the peer id to bind.
 * @param options - Whether to join an already-open transaction (see {@link StrandWriteOptions}).
 * @throws If `MemberPeer.Authorized`/`MemberExists` rejects (wrong signer, or no
 *   matching `Member` row); the insert rolls back, leaving no `MemberPeer` row.
 * @throws {StrandTransactionBusyError} Under `joinOpenTransaction: false`, when another
 *   transaction is open; nothing was written.
 */
export declare function registerMemberPeer(db: Database, params: RegisterMemberPeerParams, options?: StrandWriteOptions): Promise<void>;
/**
 * Every `PeerId` currently bound to `memberKey`, in storage order.
 *
 * The enumeration side of {@link removeMemberPeer}: a manager cleaning up after a
 * revocation knows only the departed member's key, never which devices it registered, so
 * cleanup is `listMemberPeers` then one `removeMemberPeer` per id. Reads only — the rows
 * it returns may name a `MemberKey` with no `Member` row (see the `MemberPeer` table NOTE
 * in the schema), so this is NOT a membership test.
 *
 * @param db - The closed strand's database.
 * @param memberKey - The `MemberPeer.MemberKey` to enumerate.
 * @returns The bound peer ids, empty if the member has none.
 */
export declare function listMemberPeers(db: Database, memberKey: string): Promise<string[]>;
/** Parameters for the SELF branch of {@link removeMemberPeer}. */
export interface RemoveOwnPeerParams {
    /**
     * The member's OWN strand keypair. Its `publicKeyB64` is the `MemberPeer.MemberKey`
     * of the row being deleted, and it signs the remove-tagged digest
     * `digest('Strand.MemberPeer', 'remove', MemberKey, PeerId, StampId)` — the self
     * branch of `MemberPeer.Authorized` verifies against the row's own member key, so
     * no OTHER member's row is reachable this way, and the tag + stamp binding keep a
     * captured registration approval from doubling as a removal (and vice versa).
     */
    memberKeyPair: Ed25519KeyPair;
    /** The `PeerId` of the binding to delete. */
    peerId: string;
}
/** Parameters for the MANAGER branch of {@link removeMemberPeer}. */
export interface RemoveMemberPeerByManagerParams {
    /**
     * The clearing manager's strand keypair. Its `publicKeyB64` must be a PRE-EXISTING
     * `Strand.Manager` row (the manager branch reads `committed.Manager`, so a manager
     * seated in the same transaction cannot authorize); it signs the
     * manager-remove-tagged digest over the exact row and its live stamp, and files
     * the accompanying tombstone.
     */
    managerKeyPair: Ed25519KeyPair;
    /** The `MemberPeer.MemberKey` whose binding is being cleared. */
    memberKey: string;
    /** The `PeerId` of the binding to delete. */
    peerId: string;
}
/**
 * Either shape accepted by {@link removeMemberPeer}. A discriminated union rather than
 * one opaque keypair: the two branches sign DIFFERENT action tags (`'remove'` self vs
 * `'manager-remove'`), so each case carries exactly the fields its payload needs.
 */
export type RemoveMemberPeerParams = RemoveOwnPeerParams | RemoveMemberPeerByManagerParams;
/**
 * Delete a `MemberPeer` binding — either the member clearing its own, or a manager
 * clearing another member's.
 *
 * Reads the row's live StampId first (absent → quiet no-op, mirroring
 * {@link registerMemberPeer}'s insert-if-absent, so a repeated or restarted cleanup
 * is not a silent zero-row "success" the caller cannot distinguish from a real one),
 * then runs ONE transaction pairing the delete with its `Strand.Revocation`
 * tombstone — `MemberPeer.RevocationRecorded` requires it, and the retirement is
 * what keeps the captured registration approval from re-binding the cleared row.
 *
 * `MemberPeer` rows do NOT cascade when the member is revoked (`MemberExists` runs on
 * insert only, and nothing deletes them), so a removed member's peer bindings survive
 * as orphans — enumerate them with {@link listMemberPeers}, which is how a manager
 * discovers what to clear. Only that member can sign the self branch, and a member being
 * removed against its will has no reason to cooperate — hence the manager branch, which
 * is the cleanup path after a revocation.
 *
 * The manager branch is deliberately NOT gated on the member already being gone: a
 * manager may clear a still-present member's binding too, matching "any manager can
 * remove any member". It verifies the manager-remove-tagged
 * `digest('Strand.MemberPeer', 'manager-remove', old.MemberKey, old.PeerId, old.StampId)`
 * against a `committed.Manager` row; the self branch verifies the remove-tagged
 * sibling against the row's own member key.
 *
 * Cleanup is an explicit follow-up call by the revoking manager, never a cascade inside
 * {@link revokeMember}: a revocation that also had to clear an unbounded number of peer
 * rows in the same transaction would couple two concerns and make its failure modes
 * harder to reason about.
 *
 * @param db - The closed strand's database.
 * @param params - Either the owning member's keypair, or a manager's keypair plus the
 *   target member key.
 * @param options - Whether to join an already-open transaction (see {@link StrandWriteOptions}).
 * @throws If `MemberPeer.Authorized` rejects (neither branch satisfied), or if the row
 *   is still present after the delete (see the point-lookup note below).
 * @throws {StrandTransactionBusyError} Under `joinOpenTransaction: false`, when another
 *   transaction is open; nothing was written.
 */
export declare function removeMemberPeer(db: Database, params: RemoveMemberPeerParams, options?: StrandWriteOptions): Promise<void>;
/** Parameters for {@link addManager}. */
export interface AddManagerParams {
    /**
     * An EXISTING manager's strand keypair. Its `publicKeyB64` must already be a
     * `Strand.Manager` row (the existing-manager branch of `Manager.Authorized`
     * rejects a non-manager once the founder manager exists); it signs the
     * add-tagged digest over the new manager key, generation, and fresh stamp,
     * and is bound as `context.ManagerKey`.
     */
    byManagerKeyPair: Ed25519KeyPair;
    /** The member key to promote — the new `Manager.MemberKey` row. */
    newManagerKey: string;
}
/**
 * Promote a key that is ALREADY a `Strand.Member` to `Manager` on the signature of
 * an existing manager — use {@link admitManager} to admit and promote atomically.
 *
 * The promotion branch of `Manager.Authorized` requires the authorizer to be a
 * `Manager` row of STRICTLY SMALLER `Generation` than the new row, verifying
 * `digest('Strand.Manager', 'add', new.MemberKey, new.Generation, new.StampId)`
 * against `context.ManagerKey`. So this writer reads the authorizer's generation,
 * seats the new manager at that value + 1 (the natural successor; the schema
 * enforces only the strict ordering), mints a fresh stamp, and signs the
 * add-tagged digest over all three: the generation inside the signed digest keeps
 * a captured promotion from replaying at a different generation, and the stamp
 * keeps it from re-seating a second incarnation once this one is removed.
 * `new.Generation` is an SQL INTEGER digest arg — the digest framing is
 * type-tagged, so the TS side signs over the NUMBER itself
 * (see {@link signStrandApproval}).
 *
 * The strict ordering — not this writer — is what makes a same-transaction takeover
 * impossible; the `Manager.Generation` column comment in `schemas/strand.qsql` carries
 * that argument. All this writer owes it is a generation strictly above the
 * authorizer's, inside the signed payload.
 *
 * When the authorizer has NO `Manager` row (a non-manager signer, or an open
 * strand with no managers at all), the scan finds nothing and the writer falls
 * back to generation 1 and issues the insert anyway — deliberately letting the
 * SCHEMA be the rejector (`Manager.Authorized` / `OnlyClosed`), not a
 * writer-thrown error, so enforcement is pinned where it actually lives.
 *
 * @param db - The closed strand's database (founder manager already seated).
 * @param params - The authorizing manager's keypair and the new manager key.
 * @param options - Whether to join an already-open transaction (see {@link StrandWriteOptions}).
 * @throws If `Manager.Authorized` rejects, or if `Manager.MemberExists` rejects because
 *   `newManagerKey` holds no `Member` row (admit it first, or use
 *   {@link admitManager}); the insert rolls back.
 */
export declare function addManager(db: Database, params: AddManagerParams, options?: StrandWriteOptions): Promise<void>;
/** Parameters for {@link admitManager} — the same shape as {@link AddManagerParams}. */
export type AdmitManagerParams = AddManagerParams;
/**
 * Admit a key as a `Member` AND promote it to `Manager`, atomically — the one-step
 * pair for a key that is not in the strand yet. {@link addManager} alone promotes a
 * key that is already a member.
 *
 * ONE transaction, because `Manager.MemberExists` is a deferred check reading the LIVE
 * `Member` table: the sibling `Member` insert satisfies it at the shared commit, and a
 * rejection of either half rolls BOTH rows back — never a `Member` row seated by a
 * failed promotion, nor a `Manager` row with no member behind it.
 *
 * NO new authority: both halves are signed by the SAME manager, over two distinct
 * action-tagged digests — `digest('Strand.Member', 'add', …)` for the admission and
 * `digest('Strand.Manager', 'add', …)` for the promotion — each bound to its own row's
 * fresh stamp. This composes exactly the two approvals that manager could already
 * issue separately.
 *
 * The promoting manager must be a PRE-transaction manager: the direct-admit branch of
 * `Member.Authorized` reads `committed.Manager`, so `admitManager` cannot be chained —
 * a manager seated by an `admitManager` earlier in the SAME transaction cannot admit
 * the next one. (A same-transaction promotion CHAIN rooted at a pre-existing manager
 * is fine; only the `Member` half needs the committed authorizer.)
 *
 * NOT insert-if-absent: a repeat call for a key that is already a member fails on the
 * `Member` primary key, matching {@link addMemberByManager}'s unguarded shape.
 *
 * @param db - The closed strand's database (founder manager already seated).
 * @param params - The authorizing manager's keypair and the key to admit + promote.
 * @param options - Whether to join an already-open transaction (see {@link StrandWriteOptions}).
 * @throws If either half is rejected (`Member.Authorized`, `Manager.Authorized`, a
 *   duplicate `Member` key, …); the whole transaction rolls back, leaving neither row.
 */
export declare function admitManager(db: Database, params: AdmitManagerParams, options?: StrandWriteOptions): Promise<void>;
/** Parameters for {@link removeManager}. */
export interface RemoveManagerParams {
    /**
     * The keypair authorizing the removal, bound as `context.ManagerKey`. For an
     * ADMIN removal this is a DIFFERENT existing manager, signing the
     * remove-tagged digest (satisfying the existing-manager branch); for a
     * SELF-resignation it is the target's OWN keypair (`publicKeyB64 ===
     * targetManagerKey`), signing the resign-tagged digest (satisfying the
     * former-manager self branch). The writer picks the tag by comparing the keys —
     * see {@link removeManager}. Either way this keypair also files the
     * accompanying tombstone, which requires it to be a PRE-transaction MEMBER
     * (`Revocation.Authorized` reads `committed.Member`) — true for every manager,
     * since managers are members.
     */
    byManagerKeyPair: Ed25519KeyPair;
    /** The `Manager.MemberKey` row to delete. */
    targetManagerKey: string;
}
/**
 * Remove a `Manager` row — either an admin removing a different manager or a
 * manager resigning itself.
 *
 * Reads the target row's live `(Generation, StampId)` first (absent → quiet
 * no-op, same restart-safe shape as {@link revokeMember}), then runs ONE
 * transaction pairing the delete with its `Strand.Revocation` tombstone
 * (`Manager.RevocationRecorded`). The two delete-side branches of
 * `Manager.Authorized` verify DIFFERENT action-tagged digests, each bound to
 * `(old.MemberKey, old.StampId)`:
 * - **Admin removal** (`byManagerKeyPair` is a different existing manager): the
 *   removal branch verifies `digest('Strand.Manager', 'remove', old.MemberKey,
 *   old.StampId)` against `A.MemberKey = context.ManagerKey`. Deliberately NO
 *   generation condition: a later-generation manager may remove an
 *   earlier-generation one (generation is lineage, not privilege), and deletes
 *   are safe once inserts are — every accepting branch requires a `Manager` row
 *   in the post-image, and the promotion branch's generation ordering keeps
 *   attacker rows out of it. The stamp binding is what makes a captured removal
 *   single-use: a re-promoted manager carries a fresh stamp the old approval
 *   does not match — closing the removal half of
 *   `bug-strand-manager-authority-antireplay` (the insert half was already
 *   closed by the generation-bearing promotion payload).
 * - **Self-resignation** (`byManagerKeyPair` IS the target): the former-manager
 *   self branch verifies `digest('Strand.Manager', 'resign', old.MemberKey,
 *   old.StampId)` against `old.MemberKey` itself. The distinct `'resign'` tag is
 *   belt-and-braces (different verifying keys); the anti-replay fix is the stamp.
 *
 * The caller selects the case purely by which keypair it passes; the only
 * branching here is the action tag, chosen by comparing the signer to the target.
 *
 * Deferred (subquery-bearing) CHECK constraints are evaluated on DELETE as well
 * as INSERT by Quereus plus the Optimystic vtab session — enforcement lives above
 * the transactor (proven on the network transactor by
 * `strand-membership-network-transactor-parity.spec.ts`), so `Manager.Authorized`
 * — deferred — IS enforced here: a signer that is neither an existing manager nor
 * the target itself is rejected at commit.
 *
 * THE SOLE MANAGER CANNOT ORDINARILY RESIGN — it SEALS instead. The `'resign'`
 * branch of `Manager.Authorized` requires at least one manager in the POST-delete
 * image, so a resignation that would empty the `Manager` table is schema-rejected;
 * emptying it deliberately is a distinct, self-signed act — {@link sealStrand} —
 * that permanently freezes admission. This writer refuses the sole-manager
 * self-resignation up front with an error naming `sealStrand`; that TS guard is UX,
 * not the trust boundary — the schema rejects a mis-counted `'resign'` approval
 * regardless. Reading the count inside a caller-joined transaction is correct: an
 * add-then-resign hand-off composed in one transaction sees 2 and passes, while
 * the already-rejected delete-then-add swap sees 1 and is refused here as well as
 * by the schema. The bootstrap branch of `Manager.Authorized` is gated to INSERTs
 * (`old.MemberKey is null`), so it does not waive the signature check on a delete
 * that drops the count toward zero: a second-to-last removal is authorized
 * exactly like any other.
 *
 * HAND-OFF ORDER: a sole manager transferring control must ADD the successor FIRST
 * and resign SECOND. A same-transaction delete-then-insert swap is rejected — the
 * bootstrap branch is gated to the founding state (at most one `Member`), and the
 * successor's insert has no other manager to authorize it once the sole manager's
 * row is gone.
 *
 * Cross-node caveat: the `'resign'`/`'seal'` branches count rows visible to THIS
 * transaction, so two nodes concurrently removing different managers can each see
 * a survivor and still converge to zero — an unintended seal. Noted in the schema
 * (the `Manager` table's seal-propagation NOTE); a cross-node floor is not
 * attempted here.
 *
 * @param db - The closed strand's database.
 * @param params - The authorizing keypair and the target manager key.
 * @param options - Whether to join an already-open transaction (see {@link StrandWriteOptions}).
 * @throws If the signer IS the target and it is the sole manager (before writing —
 *   the operation the caller wants is {@link sealStrand}), or if `Manager.Authorized`
 *   rejects (a signer that is neither another existing manager nor the target
 *   itself, or a raw sole-manager `'resign'` whose post-image count is zero); the
 *   whole delete+tombstone transaction rolls back.
 */
export declare function removeManager(db: Database, params: RemoveManagerParams, options?: StrandWriteOptions): Promise<void>;
/** Parameters for {@link sealStrand}. */
export interface SealStrandParams {
    /**
     * The SOLE manager's strand keypair. Its `publicKeyB64` must be the one live
     * `Strand.Manager` row; it signs the seal-tagged digest over its own key and
     * live stamp, and files the accompanying tombstone (it is still a committed
     * member, which is what `Revocation.Authorized` checks).
     */
    managerKeyPair: Ed25519KeyPair;
}
/**
 * Seal the strand: the SOLE manager deliberately steps down, permanently freezing
 * membership.
 *
 * A sealed strand has zero `Manager` rows, and every admission path — issuing or
 * cancelling an invitation, consuming one issued BEFORE the seal
 * (`ConsumedInvite.NotSealed`), admitting a member, promoting a manager — requires
 * one, so nobody can ever be let in again. That freeze is a privacy guarantee to
 * everyone who contributed: no key holds the power to admit a party who would then
 * read the strand's whole history. Sealing is irreversible — the founding branch
 * of `Manager.Authorized` closes for good once any manager stamp is retired into
 * `Strand.Revocation`. What remains possible: members may {@link leaveStrand}
 * (floored by `MinOneMember`), manage their own `MemberPeer` rows, and file
 * `Revocation` tombstones.
 *
 * The `'seal'` branch of `Manager.Authorized` accepts a self-signed delete only
 * when the POST-image manager count is ZERO — a distinct action tag from
 * `'resign'`, so a captured resignation approval can never seal and a raw writer
 * cannot seal by accident. Like {@link removeManager}, the delete pairs with its
 * `Strand.Revocation` tombstone in one transaction.
 *
 * The TS count/identity checks below are UX guards, not the trust boundary — the
 * schema rejects a mis-tagged or mis-counted approval regardless of what this
 * writer (or any raw writer) presents.
 *
 * NOTE: a seal approval is a bearer token for its row incarnation, like every other
 * self-signed approval here — but the `'seal'` branch's post-image count of 0 is
 * satisfied for EVERY row deleted in the same transaction, so N managers each
 * presenting a valid `'seal'` approval seal jointly (pinned as an accepted case in
 * `strand-seal.spec.ts`). Unreachable today: this writer mints a seal signature only
 * while its caller is the SOLE manager, and spends it immediately, so a second
 * manager never has one to combine. If seal-approval MINTING is ever split from
 * spending — offline signing, a two-phase seal, a queued approval — one manager
 * holding another's unspent seal approval could freeze the strand irreversibly
 * without its current consent; re-gate here (or narrow the schema branch) then.
 *
 * @param db - The closed strand's database.
 * @param params - The sole manager's own keypair.
 * @param options - Whether to join an already-open transaction (see {@link StrandWriteOptions}).
 * @throws If more than one manager exists (the caller wants {@link removeManager}),
 *   or the supplied keypair holds no `Manager` row while one exists, or the strand
 *   holds no `Manager` row and has never retired one (not founded yet — see
 *   {@link isStrandSealed}), or any schema constraint rejects; the whole
 *   delete+tombstone transaction rolls back. A strand that is ALREADY sealed logs
 *   and returns quietly (restart-safe, matching {@link bootstrapFounderMembership}
 *   and {@link removeManager}'s absent-row no-op).
 */
export declare function sealStrand(db: Database, params: SealStrandParams, options?: StrandWriteOptions): Promise<void>;
/**
 * The sApp id the strand's singleton `Strand.Header` names, or `undefined` when no
 * Header row is held yet. A storage replica reads it to learn which app the strand it
 * hosts belongs to (`CadreNode.getSAppId`).
 */
export declare function readStrandHeaderSAppId(db: Database): Promise<string | undefined>;
/**
 * Whether the strand is sealed: a CLOSED strand that holds no `Manager` rows AND
 * has retired at least one `Manager` stamp into `Strand.Revocation`.
 *
 * All three conjuncts are load-bearing:
 * - `Header.Type` — an OPEN strand never holds `Manager` rows at all
 *   (`Manager.OnlyClosed`), so a bare manager-count test would report every open
 *   strand as sealed.
 * - the manager count — sealing IS the empty `Manager` table.
 * - the retired `Manager` stamp — "sealed" means admission is frozen FOREVER, and
 *   what makes it permanent is the founding branch of `Manager.Authorized`
 *   refusing to re-seat a generation-0 manager once any `Manager` stamp has been
 *   retired. Without this conjunct a closed strand that is merely NOT FOUNDED YET
 *   reads as sealed: {@link bootstrapFounderMembership} commits `Header`,
 *   `Member` and `Manager` as three sequential statements, so the window between
 *   the first and the last is exactly "closed, zero managers, still foundable".
 *
 * Reads locally visible rows — a node that has not yet converged on the seal
 * still reports `false` (the schema's seal-propagation NOTE).
 *
 * @param db - The strand's database.
 * @returns `true` iff the strand is closed, holds zero `Manager` rows, and has
 *   permanently closed its founding branch.
 */
export declare function isStrandSealed(db: Database): Promise<boolean>;
