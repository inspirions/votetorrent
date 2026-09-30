import { Database } from '@quereus/quereus';
import type { SqlParameters } from '@quereus/quereus';
import type { Libp2p } from '@libp2p/interface';
import type { IRepo } from '@optimystic/db-core';
import type { StrandRow, PeerAddressRecord, CadrePeerRow, RevocationRow, RevocationLedgerOpenResult, DeviceTokenRecord, DeviceTokenRow } from './types.js';
import type { ControlTable, RevocableTable, ControlDomain, ControlAction } from './control-authorization.js';
import type { ControlRetryAbandonment } from './control-retry.js';
export type { ControlTable, RevocableTable, ControlDomain, ControlAction } from './control-authorization.js';
/**
 * Generate a unique stamp ID for transaction authorization.
 * Format: 32 bytes base64url encoded
 * - First 16 bytes: SHA-256 hash of peer ID (for distributed uniqueness)
 * - Last 16 bytes: Random bytes (for collision resistance)
 */
export declare function generateStampId(peerId: string): string;
/**
 * A `FormationUsage` was to be recorded against a host `Strand` row that is not
 * present locally.
 *
 * Consent is bound to the strand's one-off `StampId` (see the consent branch of
 * `Strand.AuthorizedInsert`), so the writer must read the live row before inserting.
 * The ordinary "host strand has not converged on this responder yet" case is caught
 * earlier and reported as `missing` by `ControlFormationUsageRecorder.resolveStrand`;
 * reaching here means the row vanished between that check and the write, which is a
 * genuine race and is surfaced rather than left to fail the deferred `StrandExists`
 * CHECK at commit (which would drop the write with a far less legible error).
 */
export declare class MissingHostStrandError extends Error {
    readonly strandId: string;
    readonly token: string;
    constructor(strandId: string, token: string);
}
/**
 * A formation write was abandoned because the caller's `AbortSignal` fired BEFORE the
 * `FormationUsage` insert was issued — the invite's single use is NOT spent.
 *
 * Thrown by the formation write paths ({@link ControlDatabase.recordFormationUsage},
 * {@link ControlDatabase.redeemInvitation}) and by `ControlFormationUsageRecorder`'s
 * pre-approval checks when the responder's provisioning budget expires while the work is
 * still queued (e.g. behind the write lock) or still asking the approval hook. Never
 * thrown once the insert has been issued: a half-issued write must be allowed to land,
 * and the formation listener's settle grace then adopts it as a successful join. The
 * manager rethrows this error instead of mapping it to a retryable conflict — the
 * listener's timeout path owns the reply.
 */
export declare class FormationAbortedError extends Error {
    readonly token: string;
    constructor(token: string, operation: string, options?: {
        cause?: unknown;
    });
}
/**
 * The invitation's seat budget is already spent: the count of recorded `FormationUsage` rows
 * for the token has reached `FormationInvite.TotalUses`, so this redemption cannot be given a
 * seat.
 *
 * Raised off the committed-count check ({@link ControlDatabase.assertSeatRemains}) ahead of
 * the write, inside {@link ControlDatabase.redeemInvitation} /
 * {@link ControlDatabase.recordFormationUsage}, and off the unlocked pre-check
 * `ControlFormationUsageRecorder.authorizeUsage` runs before the manager issues a membership
 * pass — and off nothing else. It exists because
 * without it the refusal surfaces as a generic `CHECK constraint failed: Authorized` from the
 * schema's own count-based cap clause, which the manager reports as a retryable
 * `Formation conflict, retry` — telling the joiner to retry something that can never succeed.
 * Two redemptions of one token racing on the SAME node serialize behind the local write
 * queue, so the loser reads the winner's committed row and is refused here by name —
 * `StrandFormationManager.validateToken`'s `isTokenUsed` check cannot catch that, since it
 * ran before either redemption wrote anything.
 */
export declare class InvitationExhaustedError extends Error {
    readonly token: string;
    readonly usesRecorded: number;
    readonly totalUses: number;
    constructor(token: string, usesRecorded: number, totalUses: number);
}
/**
 * What a recorded `FormationUsage` row came out as.
 *
 * `usageStampId` is echoed back so a caller that obtained an approver sign-off can prove the
 * nonce it signed over is the one that landed — the two must match or
 * `FormationUsage.Authorized` rejects the row (see {@link formationVouchMessage}).
 */
export interface FormationUsageResult {
    /** The single-use nonce written to `UsageStampId` (the row's primary key) — the caller's, or a freshly minted one. */
    usageStampId: string;
}
/**
 * Build the canonical authorization message that owner signatures are bound to.
 *
 * The message is a SINGLE framed SHA-256 digest over the ordered field vector from
 * {@link controlAuthorizationFields} (the crypto plugin's injective multi-field
 * encoding): two fixed literals — the domain tag naming the table rule and the action
 * tag — followed by the row fields in the schema's fixed order, with the single-use
 * StampId as the final field where the table has one:
 *
 *   message = sha256(encodeFields([domain, action, field_1, ..., StampId]))   // raw digest bytes
 *
 * ed25519 signs these raw digest bytes DIRECTLY (no second hash). The SQL constraints
 * verify the identical bytes with one variadic call
 * (`verify(digest('CadreControl.X', 'add', field_1, ...), context.Signature, A.Key, 'ed25519')`):
 * SQL `digest(...)` returns the base64url string of the same digest, which `verify`'s default
 * base64url input encoding decodes back to those raw bytes — so signer and verifier
 * operate on the same bytes. Every field is TEXT on both sides (the SQL columns are
 * `cast(... as text)` / `coalesce(...,'')`; the TS args are strings), so the per-field
 * type tags agree. Binding the row contents closes captured-stamp replay; the leading
 * domain/action tags scope the signature to ONE table rule, so an approval minted for
 * one constraint can never satisfy another (e.g. a ValidationKey enrollment can no
 * longer double as an OwnerKey enrollment). Single source of truth: every signed writer
 * (and every test/harness signer) MUST build the message through this function with the
 * schema's tags and field order, or `verify` will reject the row.
 */
export declare function buildAuthorizationMessage(domain: ControlDomain, action: ControlAction, rowFields: string[]): Uint8Array;
/**
 * The exact bytes an outside approver signs to authorize ONE redemption of a
 * `ValidationUrl`-bearing `FormationInvite` — the TS mirror of the `'vouch'` digest in
 * `FormationUsage.Authorized`, in the schema's field order.
 *
 * The approval covers the whole redemption: the invitation (`token`), the single-use nonce
 * the JOINING peer minted for THIS redemption (`usageStampId`), the network being joined
 * (`strandId`), the joining peer's own ed25519 public key (`peerKey`), and the disclosure
 * text. That makes it non-transferable — an approval cannot be re-presented for another use
 * of the same invitation, another network, or another joiner — and the nonce's `unique`
 * column makes a verbatim re-presentation a duplicate-row rejection. The joiner mints the
 * nonce ({@link generateStampId}) and sends it in its contact message; sign these bytes over
 * that same nonce, then pass BOTH the nonce and the signature to
 * {@link ControlDatabase.redeemInvitation} / {@link ControlDatabase.recordFormationUsage}:
 * signing one nonce and inserting another fails the CHECK.
 */
export declare function formationVouchMessage(fields: {
    token: string;
    usageStampId: string;
    strandId: string;
    peerKey: string;
    disclosure: string;
}): Uint8Array;
/**
 * The exact bytes the JOINING peer signs to consent to ONE redemption of a
 * `FormationInvite` — the TS mirror of the `'consent'` digest in the schema's
 * `FormationUsage.PeerConsented` constraint, in its field order.
 *
 * A sibling of {@link formationVouchMessage}, not a replacement: the approver's vouch
 * says the redemption may proceed, this says the joiner itself agreed to it, and the
 * two are signed by different keys over the same nonce so neither can stand in for
 * the other. Verify the result with `peer-authorization.ts`'s
 * `verifyFormationConsent`, whose `formationConsentDigest` is the base64url twin of
 * this vector — the two must stay in lockstep.
 *
 * `strandId` is deliberately absent, unlike its vouch sibling: the joiner cannot know
 * the strand when it signs (a bound invite's host strand arrives only in the result
 * frame; an unbound strand is minted by the responder). The responder cannot
 * substitute one anyway — a bound invite is pinned to its own strand by `Authorized`,
 * and an unbound redemption mints a fresh strand, so there is no victim to name.
 */
export declare function formationConsentMessage(fields: {
    token: string;
    usageStampId: string;
    peerKey: string;
    disclosure: string;
}): Uint8Array;
/** The control tables keyed by a strand id whose repeat insert a caller may treat as idempotent. */
type StrandIdTable = Extract<RevocableTable, 'Strand' | 'JoinedStrand'>;
/**
 * Did this write to `table` fail because the strand id is already seated there?
 *
 * {@link CadreNode.publishStrand} uses this to tell "my own earlier publish already
 * landed" (re-read, and no-op when the row matches) apart from every other rejection —
 * an unauthorized signer, a retired stamp — which must keep surfacing. For `JoinedStrand`
 * the same test tells "another machine of this party already published this join" apart.
 *
 * Matched by TEXT, not by type: the typed engine error does not survive the trip out of
 * optimystic (same constraint the retry classifiers in `control-write-retry.ts` document).
 * Fails CLOSED — a rewording upstream turns the idempotent branch back into the raw
 * uniqueness error the caller saw before, never into a silent overwrite. The
 * `publish-strand.spec.ts` repeat-publish cases assert against the live engine error, so a
 * reword reddens there.
 */
export declare function isStrandIdConflict(error: unknown, table: StrandIdTable): boolean;
/**
 * The one `CadreControl.Revocation` row that retires nothing, filed once by an owner
 * ({@link ControlDatabase.openRevocationLedger}) so the table is never a never-written
 * block. The schema's table comment says why that matters and why the row can never read
 * as a retirement; `RowIsGone` pins this exact triple.
 */
export declare const REVOCATION_LEDGER_MARKER: {
    readonly tableName: "Revocation";
    readonly rowKey: "ledger";
    readonly stampId: "opened";
};
/**
 * Guarded tables a node may reap locally once their tombstone has committed — the
 * tables whose `AuthorizedDelete` carries the REAP branch (see the constraint comment on
 * `CadrePeer.AuthorizedDelete` in the schema). `Strand` and `StrandPartyKey` are
 * deliberately absent: their rows carry `MemberPrivateKey` / `PrivateKey` — party
 * secrets stored nowhere else (tickets/backlog/debt-strand-tombstone-reap.md owns any
 * future change). `JoinedStrand` also carries a `MemberPrivateKey` but IS reapable: that
 * secret is the joined strand's shared read key, which its founding party and every member
 * hold, so a reaped row is recoverable by re-forming. `OwnerKey` has no production removal
 * path and `MinOneOwner` makes an automated owner-key reap a party-bricking hazard.
 */
export declare const REAPABLE_TABLES: readonly ["CadrePeer", "DeviceToken", "ValidationKey", "JoinedStrand"];
export type ReapableTable = (typeof REAPABLE_TABLES)[number];
/**
 * Notified after a `CadreControl.CadrePeer` row write has COMMITTED.
 *
 * The one hook the party-membership snapshot a node admits control-DB traffic
 * against ({@link CadreNode.refreshMembershipGate}) hangs off, so that snapshot
 * is refreshed by the WRITE rather than by whoever remembered to ask. `reason`
 * only labels the log line. Must not reject (the notifier swallows and logs
 * anyway — a committed write never fails because a snapshot refresh did).
 */
export type MembershipChangeListener = (reason: string) => Promise<void>;
/**
 * Identity of the tombstone a committed guarded delete wrote — a
 * {@link RevocationRow} minus its `ReissuedAt` counter, which a fresh tombstone
 * always seats at 0 (`FreshTombstone`) and so carries no information.
 */
export type RevokedRowRef = Omit<RevocationRow, 'reissuedAt'>;
/**
 * Notified after a guarded-table delete — and the `CadreControl.Revocation`
 * tombstone it writes in the same transaction — has COMMITTED.
 *
 * The seam the write-while-alone re-replication queue hangs off
 * ({@link CadreNode.noteGuardedDelete}): one listener covers all four guarded
 * tables (`CadrePeer` / `DeviceToken` / `Strand` / `ValidationKey`) because every
 * owner delete funnels through {@link deleteGuardedRow}. Synchronous — the
 * handler only records the tombstone's identity; it must not throw (the notifier
 * swallows and logs anyway — a committed delete never fails because bookkeeping did).
 */
export type GuardedDeleteListener = (revocation: RevokedRowRef) => void;
/**
 * Notified when the control-write retry funnel GIVES UP on a local control write — the
 * classifier declined the failure as non-transient, or every attempt / the elapsed budget
 * ran out. Carries the operation label, how far it got and the error
 * ({@link ControlRetryAbandonment}).
 *
 * The seam that stops an abandoned BACKGROUND write from disappearing: those are `void`-ed
 * with a `debug`-only catch, and that namespace is off unless somebody set `DEBUG=`, so
 * without this the write, the operator and the embedding app all learn nothing. Synchronous
 * and must not throw — the retry loop swallows and logs if it does, because the write's own
 * failure is what has to reach the caller.
 */
export type ControlWriteAbandonedListener = (abandonment: ControlRetryAbandonment) => void;
export interface ControlDatabaseConfig {
    /** Party ID for the control network */
    partyId: string;
    /**
     * Optional path to the control schema file.
     * If not provided, uses the embedded schema for cross-platform compatibility.
     * Only use this if you need to override the default schema (e.g., for testing).
     */
    schemaPath?: string;
    /** Libp2p node for the control network (injected) */
    libp2pNode: Libp2p;
    /** Coordinated repo from the libp2p node */
    coordinatedRepo: IRepo;
}
/**
 * ControlDatabase manages the CadreControl schema using Quereus with Optimystic backend.
 * It provides typed query methods for accessing control network data.
 */
export declare class ControlDatabase {
    private db;
    private collectionFactory;
    private readonly config;
    private initialized;
    private membershipListener;
    private guardedDeleteListener;
    private controlWriteAbandonedListener;
    /** Tail of the local-write chain — see {@link withWriteLock}. */
    private writeQueue;
    /**
     * Locked write bodies currently running (see {@link runWriteBody}); what
     * {@link readRowsOnce} consults to route an unlocked read around a write that has
     * started but not yet opened its transaction. At most 1 while every writer takes the
     * lock — a count rather than a flag so it stays truthful if that ever stops holding.
     */
    private runningWriteBodies;
    /**
     * Pacing seams for {@link lockedWithRetry}. Production leaves this empty (real backoff,
     * real clock); specs inject a recorded `sleep` / fake `now` so no test waits out a real
     * backoff. Applied OVER the call site's policy, so it overrides pacing without a spec
     * having to restate the policy's attempts or classifier.
     */
    private controlWriteRetryPacing;
    /**
     * Pacing seams for {@link readRows}'s retry — the read twin of
     * {@link controlWriteRetryPacing}, with the same contract: production leaves this
     * empty, specs inject a recorded `sleep` / fake `now` so no test waits out a real
     * backoff. Applied OVER the read policy's defaults but UNDER the call site's `label`.
     */
    private controlReadRetryPacing;
    constructor(config: ControlDatabaseConfig);
    /**
     * Initialize the database - load schema and register plugins
     */
    initialize(): Promise<void>;
    private loadSchema;
    /**
     * One UNRETRIED drain of a control read to rows — every read in this class bottoms out
     * here (almost all via {@link readRows}, which adds the transient-failure retry), and
     * this is the ONE place the committed-read opt-in is spelled.
     *
     * Reached only through {@link readRows}, which drops straight here for the call sites
     * that pass `retry: false` — reads issued from INSIDE a locked write body, where a
     * backoff sleep would hold the write lock and the write funnel re-runs the read anyway
     * (see the NOTE on {@link readRows}).
     *
     * A control read normally queues on the database's exec mutex, so it does not answer
     * until whatever statement holds that mutex finishes. When a control WRITE is parked
     * against an unresponsive cohort member that is minutes, and a read that only wants
     * the last committed state waits the whole time for no reason
     * (`complete/control-reads-blocked-by-stalled-write`).
     *
     * Quereus's remedy is `readConcurrency: 'committed'` — a PER-CALL opt-in
     * (`Statement.tryRouteConcurrent` refuses anything that did not ask for it by name)
     * that runs an eligible read off the mutex against each table's last committed state.
     * Routing is best-effort and never an error: an ineligible statement falls back to
     * the serialized path silently — any side-effecting node, any table-valued function
     * call (pure ones included), any table whose module does not declare
     * `readCommittedSnapshot`, or an EXPLICIT transaction being open on this database.
     *
     * **It is asked for only while a write is in flight, and that condition is the whole
     * point.** The opt-in does not merely move the read off the mutex: it connects the
     * table with `_readCommitted`, and the optimystic vtab serves such a connection from
     * a pinned pre-transaction snapshot that NEVER refreshes from the network, where an
     * ordinary read calls `update()` on the collection first. Taking that path
     * unconditionally therefore trades "reads block behind a stalled write" for "reads
     * stop seeing what other machines wrote" — measured, not theorised: with every read
     * opted in, `control-write-degraded-cohort-member` could no longer observe a sibling
     * publishing its own `CadrePeer` row and failed at suite setup on two runs out of two.
     *
     * "A write is in flight" is {@link writeInFlight}, and it needs TWO signals because a
     * write is invisible to `getAutocommit()` for part of its life. `Database.exec` takes
     * the exec mutex first; the implicit transaction — the moment `getAutocommit()` turns
     * false — opens only after the write has acquired the mutex, planned the statement,
     * and awaited `begin()` on every connection. While the write WAITS for the mutex (a
     * serialized read holds it, say) it still reports autocommit, so a read routed on
     * `getAutocommit()` alone queued behind the write and answered only after its whole
     * commit — tens of seconds against a slow cohort member, which is what timed out the
     * degraded-cohort scenario's `isMember` read (verified against the engine directly;
     * `complete/control-read-queues-behind-a-write-waiting-for-the-database`). So an
     * UNLOCKED read also takes the committed path while any locked write body is running
     * ({@link runningWriteBodies}), which covers that queued window and everything else a
     * body does before its transaction opens. A read issued INSIDE a locked body
     * (`underWriteLock`) must not: that body is the one being counted, and its guard reads
     * need the refreshing path — so it keeps the transaction-only test.
     *
     * Both signals are sampled synchronously just before `eval`, which claims its place
     * on the mutex in that same tick, so the only race left is a body starting or ending
     * in between: a body that starts after the sample queues its statements BEHIND this
     * read, and one that ended before it has nothing left to queue behind.
     *
     * Residual gaps, both of which still queue a read behind a write:
     * - an EXPLICIT transaction ({@link inTransaction}) disqualifies the committed path in
     *   Quereus itself, so a read overlapping such a body's `COMMIT` falls back to the
     *   serialized path and waits for it;
     * - a writer that bypasses {@link withWriteLock} is not counted (in this repo only
     *   `reference-app-web`'s deliberately-rejected diagnostics insert does).
     *
     * What a committed read gives up is observing a write that has not finished
     * committing, and that is safe for every caller here: an AWAITED write is committed by
     * the time it returns, and a read inside {@link inTransaction} is disqualified by the
     * open explicit transaction and stays serialized, so it still sees its own
     * transaction's rows. A read after an UNAWAITED write on this database would be wrong
     * — no such caller exists, and {@link withWriteLock} is what keeps it that way.
     *
     * NOTE: counting whole bodies widens the stale (non-refreshing) window from "a
     * transaction is open" to "a locked body is running", which adds a body's pre-transaction
     * work and its post-commit tail (a `CadrePeer` write's membership-listener read). The
     * slow part of a write against a degraded cohort is its commit, already inside the old
     * window, so the added time is short; if a poller for replicated rows ever starves
     * behind back-to-back local writes, narrow the count to the span from a body's first
     * statement to its transaction opening.
     */
    private readRowsOnce;
    /**
     * Whether a control read should ask for a committed read — see {@link readRowsOnce}.
     * `getAutocommit()` reports the whole `Database` (the property
     * {@link assertCommitBoundary} leans on), so false means some writer's transaction is
     * open. An unlocked read also counts a running locked body that has not opened its
     * transaction yet; a read inside such a body does not, since it is that body.
     */
    private writeInFlight;
    /**
     * {@link readRowsOnce} plus the bounded transient-failure retry
     * ({@link retryControlRead}) — the funnel every UNLOCKED control read goes through, so a
     * read that failed because the cluster could not be asked properly (a stream reset
     * mid-scan, a partially unreachable cohort) is re-presented a moment later instead of
     * surfacing to every reader.
     *
     * MATERIALIZES the read rather than returning a lazy iterator, and that shape is what
     * makes the retry possible at all: the failure happens during ITERATION, not at call
     * time, and a half-consumed iterator cannot be retried without re-yielding rows the
     * caller already saw. Materializing is safe here — every caller either drains to an
     * array anyway or takes the first row of a statement that yields at most one (a
     * primary-key lookup or a `count(1)`); nothing streams.
     *
     * Each ATTEMPT is a fresh {@link readRowsOnce} call, so the committed-read opt-in
     * ({@link writeInFlight}) is re-evaluated per attempt — a write can finish between
     * attempts and change the right answer.
     *
     * The retry's budget ({@link CONTROL_READ_RETRY_BUDGET_MS}, 1.5 s) is deliberately far
     * under the write funnel's: the tightest caller deadline over a control read is the
     * inbound admission gate's 2 s FAIL-OPEN timeout, and a read that outlives it spends its
     * retries after the gate has already admitted (see `control-read-retry.ts`).
     *
     * `label` names the read in the retry loop's `Control read [<label>] …` debug lines and
     * nothing else; several reads are in flight concurrently in a real party, so an
     * unlabelled line cannot be attributed — keep new call sites labelled.
     *
     * `retry: false` drops straight to {@link readRowsOnce}: reads issued from INSIDE a
     * locked write body must not retry on their own. `retryControlWrite`'s contract is that
     * backoff sleeps happen with NO lock held; a read retrying its own backoff inside a
     * locked body would sleep holding the write lock (stalling every other local writer),
     * and the write funnel already re-runs the body's reads when it re-runs the body. See
     * {@link queryStampId} / {@link assertSeatRemains} / {@link queryCadrePeers} for the
     * per-call opt-outs.
     *
     * NOTE: nothing structural enforces that opt-out — it is per-call because an unlocked
     * read runs CONCURRENTLY with a locked body, so `this`-state cannot tell the two apart,
     * and there is no async-context primitive available on every target platform (browser,
     * React Native) to carry the answer. Reads reached through a CALLBACK invoked under the
     * lock are the easy miss: `notifyMembershipChanged` runs its listener with the lock
     * held, and its membership read is opted out at {@link queryCadrePeers}. If another
     * under-lock callback seam is ever added, audit its read graph the same way.
     */
    private readRows;
    /**
     * Query all strands from the control database
     */
    queryStrands(): Promise<StrandRow[]>;
    /**
     * Read a single strand row by id, or null when absent. Single-row sibling of
     * {@link queryStrands}; the responder uses it to read a host strand's
     * `MemberPrivateKey` (the closed-strand read-gating secret) for delivery to a
     * validated invitee during provision-then-record formation.
     */
    queryStrand(strandId: string): Promise<StrandRow | null>;
    /**
     * Every strand this party joined from another party (`CadreControl.JoinedStrand`), shaped
     * as a {@link StrandRow} so a reader can treat it like one of the party's own. A joiner
     * never founds, so `FounderOwnerKey` is always null. Read raw, like {@link queryStrands}:
     * no retired-stamp filter.
     */
    queryJoinedStrands(): Promise<StrandRow[]>;
    /** Single-row sibling of {@link queryJoinedStrands}: the joined strand with this id, or null. */
    queryJoinedStrand(strandId: string): Promise<StrandRow | null>;
    /**
     * Count rows in a CadreControl table as seen by THIS database instance.
     *
     * `table` is validated against {@link CONTROL_TABLE_SET} before it is interpolated
     * into the `from` clause: the names are not user input, but the check keeps the
     * dynamic query off the injection surface and fails loudly on a typo instead of
     * emitting a malformed statement. The count reflects only the rows this node's
     * control DB has converged on — in the integration harness that is the owner
     * node (one ControlDatabase per party), i.e. the authoritative control-network
     * view, not a per-drone convergence guarantee.
     */
    countRows(table: ControlTable): Promise<number>;
    /**
     * Get the underlying database for advanced queries
     */
    getDatabase(): Database;
    /**
     * Check whether any owner key exists in the control database.
     * Used to decide whether a fresh-party genesis insert is required.
     */
    hasOwnerKey(): Promise<boolean>;
    /**
     * Idempotent genesis: insert `key` as the founding owner key only when
     * the party has none yet. Returns true if it inserted, false if an owner
     * key already existed (so a repeat `--owner` start is a no-op).
     */
    ensureOwnerKey(key: string): Promise<boolean>;
    /**
     * Collect every owner key (`CadreControl.OwnerKey.Key`) as a set.
     *
     * This is the steady-state trust anchor for seeds: a seed's signer key is
     * trusted only if it is already enrolled here (see `SeedTrustPolicy`). It is
     * also the owner-identity source for `queryPeers`, decoupling owner
     * status from the libp2p transport peer ID.
     */
    getOwnerKeys(): Promise<Set<string>>;
    /**
     * Enumerate the CadrePeer rows (cadre membership) for admin/membership reads.
     * Includes the persisted voucher columns, which
     * {@link CadreNode.listAuthorizedMembers} re-checks against its node-local anchor.
     *
     * Rows whose `StampId` is retired in `CadreControl.Revocation` are excluded HERE, so
     * every membership reader inherits the exclusion — a revoked peer is neither
     * authorizable nor addressable (a replayed row planted at a retired stamp must not
     * be RPC'd or handed out as an address). Reads the retired set through
     * {@link queryRevokedStamps} rather than inlining the SQL, so tests can interpose on
     * that seam to model the replicated live-row-plus-tombstone merge state.
     *
     * NOTE: runs a second query (the retired-stamp set) per call, on the membership-gate
     * refresh path. Its cost is storage consults, not rows (see {@link queryRevokedStamps}):
     * while `Revocation` has never been written every call consults the cohort about it, and
     * the ledger marker ({@link openRevocationLedger}) is what makes it a held block. Folding
     * the exclusion into one statement would not help (it reads the same block), and caching
     * the set would hide a tombstone arriving by replication.
     *
     * NOTE: this filter is HAND-MIRRORED by the gate suites' fake control databases
     * (`test/membership-gate-helpers.ts` and `test/cadre-node-authorized-surface.spec.ts`),
     * which feed the node rows directly. Nothing enforces that the copies stay true, so a
     * change to the filter's SHAPE here (what it keys on, which table it consults) must be
     * carried into both, or those suites keep passing against a contract the database no
     * longer honours. Fine while the filter is one `Set.has` on `StampId`; if it grows a
     * second dimension, give the fakes a shared fixture or a contract test instead.
     *
     * `retry: false` is passed by exactly one caller —
     * `CadreNode.refreshAuthorizedControlPeers`, the membership-gate snapshot refresh —
     * because {@link notifyMembershipChanged} invokes that listener with the write lock
     * HELD, and a retrying read there would sleep its backoff holding the lock (see the
     * NOTE on {@link readRows}). It costs nothing: that refresh is best-effort, keeps the
     * previous snapshot on failure, and is re-driven by the next write and by the timed
     * reconcile. BOTH of this method's reads take the flag — retrying either one under the
     * lock is the same defect.
     */
    queryCadrePeers(retry?: boolean): Promise<CadrePeerRow[]>;
    /**
     * Every approver public key currently enrolled in `CadreControl.ValidationKey` — the
     * set a `ValidationUrl` redemption's approval signature must be signed by (see
     * {@link ControlFormationUsageRecorder}, which checks one key at a time via
     * {@link queryValidationKeyStampId}).
     *
     * Sorted in TypeScript rather than SQL so the order is stable regardless of storage
     * order; the enrolled set is a handful of keys, so the sort is free.
     */
    queryValidationKeys(): Promise<string[]>;
    /**
     * Read one guarded row's single-use `StampId` nonce (null when the row does not
     * exist). Every owner-signed delete / re-touch path must bind its signature to the
     * row's CURRENT nonce, so they all read through here first.
     *
     * Deliberately RAW — no `Revocation` filtering (unlike {@link queryCadrePeers} /
     * {@link queryPeerRecord}): {@link deleteGuardedRow} and the insert-if-absent guard
     * in the `CadrePeer` upsert need to see a physically present row. Filtering here
     * would make an insert-if-absent guard read "absent" for a row that exists and
     * collide on the primary key.
     *
     * `table` and its {@link GUARDED_KEY_COLUMN} column are interpolated into the SQL; both
     * come from closed literal unions — no caller-supplied string can reach the statement
     * (same injection-surface discipline as {@link countRows}'s `CONTROL_TABLE_SET` guard).
     *
     * NOTE: `retry: false` is passed by exactly the call sites that run INSIDE a locked
     * write body — {@link deleteGuardedRow} and {@link insertCadrePeer}'s insert-if-absent
     * guard. A read retrying there would sleep its backoff HOLDING the write lock
     * (`retryControlWrite`'s contract is that backoff sleeps happen with no lock held), and
     * the write funnel already re-runs the body's reads when it re-runs the body. The
     * unlocked callers — the public stamp readers, {@link reauthorizeCadrePeer} and
     * {@link reapRevokedRow}, whose stamp reads run BEFORE their locks are taken — keep the
     * default retried path. Explicit per call rather than an ambient flag: unlocked reads
     * run concurrently with a locked body, so `this`-state cannot tell the two apart.
     */
    private queryStampId;
    /**
     * `CadrePeer` stamp nonce — read by {@link SeedBootstrapService.removePeer} as its
     * row-present gate before it delegates to {@link deleteCadrePeer}. The in-class
     * `CadrePeer` writers ({@link insertCadrePeer}, {@link reauthorizeCadrePeer}) go
     * straight to {@link queryStampId}.
     */
    queryCadrePeerStampId(peerId: string): Promise<string | null>;
    /**
     * `DeviceToken` stamp nonce. {@link deleteDeviceToken} reads the stamp itself, so this
     * is the reader for callers that need to observe a live row's nonce — asserting a token
     * was seated, or that a removal retired the stamp it named.
     */
    queryDeviceTokenStampId(peerId: string): Promise<string | null>;
    /** `Strand` stamp nonce — bound into {@link deleteStrand}'s remove digest. */
    queryStrandStampId(strandId: string): Promise<string | null>;
    /** `StrandPartyKey` stamp nonce — bound into {@link deleteStrandPartyKey}'s remove digest. */
    queryStrandPartyKeyStampId(strandId: string): Promise<string | null>;
    /** `JoinedStrand` stamp nonce — bound into {@link deleteJoinedStrand}'s remove digest. */
    queryJoinedStrandStampId(strandId: string): Promise<string | null>;
    /**
     * Read THIS party's own strand membership private key (base64 protobuf; decode with
     * `strandMemberKeyPair`) for one strand, or null when no `StrandPartyKey` row exists.
     * The identity source the closed-strand founder bootstrap derives its `Member.Key` /
     * `Manager.MemberKey` from — deliberately NOT `Strand.MemberPrivateKey`, the
     * strand-wide read secret every joining party receives.
     */
    queryStrandPartyKey(strandId: string): Promise<string | null>;
    /** `ValidationKey` stamp nonce — bound into {@link deleteValidationKey}'s remove digest. */
    queryValidationKeyStampId(key: string): Promise<string | null>;
    /**
     * Collect the retired `StampId` nonces recorded in `CadreControl.Revocation` for one
     * {@link RevocableTable}. A stamp
     * lands here when its row is removed ({@link SeedBootstrapService.removePeer},
     * {@link deleteValidationKey}, {@link deleteStrand}), and retirement is permanent —
     * rows are never deleted (only their `ReissuedAt` counter moves, via
     * {@link reissueRevocations}). Read-side mitigation for the write-time race: the
     * schema's `NotRevoked` CHECK only sees locally visible tombstones, so a node that
     * converged on a resurrected row before its tombstone can hold both; readers
     * ({@link queryCadrePeers}, {@link queryPeerRecord},
     * {@link CadreNode.resolveDeviceToken}) drop any row whose stamp appears here.
     *
     * NOTE: the per-call cost that matters is the storage layer's, not the row count. While
     * `Revocation` has never been written, this node does not hold its block, and Optimystic
     * consults a block's cohort on every read of a block it does not hold: 1 consult per
     * call (measured), each a round trip to every other member on a multi-machine party. The
     * ledger marker ({@link openRevocationLedger}) ends that — a held block is re-consulted
     * at most once per read-repair window (10 s). Do not cache the set instead: a cache
     * cannot see a tombstone arriving by replication, so it would delay a revocation. The
     * row count only grows (append-only) but stays small while removals are rare; revisit if
     * removals become routine and the scan itself shows up in a profile.
     *
     * An isolated node that has never received the `Revocation` block reads it as holding no
     * revocations instead of throwing — see {@link readRevokedStampRows}.
     *
     * `retry: false` is forwarded by {@link queryCadrePeers} for the one caller that reads
     * under the write lock — see that method's note.
     */
    queryRevokedStamps(tableName: RevocableTable, retry?: boolean): Promise<Set<string>>;
    /**
     * The `Revocation` scan behind {@link queryRevokedStamps}, answering NO ROWS when the read
     * fails `cohort-unreachable` ({@link isCohortUnreachableRead}): this node does not hold
     * the block and could ask no other cohort member about it. Every other failure rethrows.
     * The retry in {@link readRows} runs first, so a node whose connectivity returns within
     * the read budget still gets the real answer.
     *
     * Without this, a machine cut off from every other machine in its party before it ever
     * received the block — the block does not exist anywhere until the owner files the
     * ledger marker ({@link openRevocationLedger}) on a connected reconcile pass — cannot
     * answer ANY membership, peer-record or device-token lookup, although it holds those
     * rows locally.
     *
     * NOTE: accepted tradeoff — `cohort-unreachable` on THIS read, and only this read, is
     * treated as "no revocations known". It adds no fail-open that does not already exist:
     * an isolated node holding a stale `Revocation` block is served it silently (the consult
     * reaches nobody, so no doubt is raised), and a revocation authored elsewhere is invisible
     * to it either way until connectivity returns. The other reasons still throw:
     * `peers-unreachable` means part of the cohort answered, and `claimed-elsewhere` /
     * `unmaterializable` mean the block exists, so an empty answer could admit a revoked
     * member. Do not move this into {@link readRows}: an empty answer is known-safe only for
     * a table whose empty state is its never-written state; decide any other table in its
     * own reader. Revisit if optimystic starts reporting a held-but-stale block distinctly
     * (the equivalence above then breaks), or if revocation enforcement must fail closed
     * under partition.
     *
     * NOTE: an isolated node pays the whole read retry (up to
     * `CONTROL_READ_RETRY_BUDGET_MS`, plus the slow attempt that exhausted it) before this
     * answers, and {@link queryPeerRecord} then issues its row scan on top. If an isolated
     * node's lookups are seen exceeding the admission gate's 2 s deadline
     * (`ADMISSION_DECISION_TIMEOUT_MS`), skip the retry for this read when the first attempt
     * fails `cohort-unreachable`.
     */
    private readRevokedStampRows;
    /**
     * Every locally-held `CadreControl.Revocation` tombstone — identity triple plus its
     * `ReissuedAt` counter. Consumed by the cohort-growth re-issue sweep, which
     * enumerates what this node holds before {@link reissueRevocations} re-broadcasts
     * it, and by the reap sweep ({@link reapRevokedRows}). Plain scan with no `where`, so
     * the composite-primary-key point-lookup hazard (see the statement comment in
     * {@link reissueRevocations}) does not arise. Unlocked, like every other read.
     *
     * Skips the ledger marker ({@link REVOCATION_LEDGER_MARKER}): it retires nothing, so
     * neither sweep may reap or re-sign it, and skipping it keeps `RevocationRow.tableName`
     * a {@link RevocableTable}. Filtered on `TableName` alone, in TypeScript: `RowIsGone`
     * admits no other row under `'Revocation'`.
     */
    queryRevocations(): Promise<RevocationRow[]>;
    /**
     * Read a single peer's address record (the full `CadrePeer` row) by PeerId.
     *
     * Returns null when no row exists, or when the row's `StampId` is retired in
     * `CadreControl.Revocation` — a revoked peer reads as absent, so the resolver
     * ({@link CadreNode.resolvePeerAddrs}) never hands out a revoked peer's addresses.
     * The stamp is read for that check only and then dropped; the returned
     * {@link PeerAddressRecord} shape is unchanged. Reads the retired set through
     * {@link queryRevokedStamps} rather than inlining the SQL, so tests can interpose on
     * that seam (see {@link queryCadrePeers}).
     *
     * Missing/null column values are coalesced
     * to their empty form (`''` key/sig, `[]` addrs, `0` stamp) so the caller's
     * verify/freshness gates uniformly reject an unpublished or malformed row.
     * The split `addrs` re-join to the exact stored `Multiaddr` (split-on-`,` is
     * the inverse of join-on-`,`), so the resolver re-verifies over the same bytes
     * the publisher signed.
     */
    queryPeerRecord(peerId: string): Promise<PeerAddressRecord | null>;
    /**
     * Apply a peer's own self-signed address-record update to an existing row.
     *
     * Authorization is carried entirely by the record: the `Sig` column (verified
     * by the `AuthorizedUpdate` self-branch against the stored `PublicKey`) plus
     * the strictly-increasing `UpdatedAt`. No owner key is involved, so this
     * is the refresh path for any member — owner or drone — once its row
     * exists. `PublicKey` is intentionally not in the SET list (it is immutable on
     * self-update and the constraint enforces `new.PublicKey = old.PublicKey`).
     *
     * Deliberately NOT wrapped in {@link mutateCadrePeer}, the one `CadrePeer` mutator that
     * is not: it only ever touches THIS node's own row (sole caller
     * `CadreNode.publishSelfRecord`), and `CadreNode.listAuthorizedMembers` filters self out
     * of the membership snapshot, so it cannot change that snapshot. It also runs on the
     * periodic self-registration refresh, where a notify would add a recurring membership
     * read for nothing.
     *
     * Its INSERT counterpart (`SeedBootstrapService.insertSelfPeerRecord`) does notify. Not an
     * inconsistency: it shares the one owner-signed insert path with every other member's
     * row, and a self insert happens once at startup, so the wasted refresh is a single read
     * — cheaper than a conditional carve-out inside the shared writer. Only the repeating
     * path is worth exempting.
     */
    updateSelfPeerRecord(record: PeerAddressRecord): Promise<void>;
    /**
     * Read a single peer's device push token (the full `DeviceToken` row) by PeerId.
     *
     * Returns null when no row exists. Missing/null column values are coalesced to
     * their empty form (`''` token/sig, `0` stamp) so the caller's verify/freshness
     * gates uniformly reject an unpublished or malformed row. `platform` is returned
     * verbatim (the resolver validates it against {@link PushPlatform} and re-verifies
     * the self-signature, which covers the platform field).
     *
     * `stampId` rides along ({@link DeviceTokenRow}) because the resolver must drop a
     * row whose stamp is retired in `CadreControl.Revocation`; it is NOT part of
     * {@link DeviceTokenRecord}, which is the self-signed shape the peer's `Sig` covers.
     */
    queryDeviceToken(peerId: string): Promise<DeviceTokenRow | null>;
    /**
     * Apply a peer's own self-signed device-token update to an existing row.
     *
     * Authorization is carried entirely by the record: the `Sig` column (verified by
     * the `DeviceToken.AuthorizedUpdate` self-branch against the stored
     * `CadrePeer.PublicKey`) plus the strictly-increasing `UpdatedAt`. No owner key
     * is involved, so this is the refresh / rotation path for any member once both its
     * `CadrePeer` row (for the PublicKey) and its `DeviceToken` row exist. `PeerId` is
     * intentionally not in the SET list (immutable; the constraint enforces
     * `new.PeerId = old.PeerId`). Mirrors {@link updateSelfPeerRecord}.
     */
    updateSelfDeviceToken(record: DeviceTokenRecord): Promise<void>;
    /**
     * Insert the initial owner key (bootstrap - no existing owners required)
     */
    insertOwnerKey(key: string): Promise<void>;
    /**
     * Insert a strand into the control database using an owner signature.
     *
     * Fails with a `Strand.Id` uniqueness violation when the id is already seated — the
     * caller decides whether that is a duplicate of its own earlier write (idempotent) or a
     * genuine conflict; see {@link isStrandIdConflict} and `CadreNode.publishStrand`.
     *
     * The owner signs the canonical row-bound authorization message (see
     * {@link buildAuthorizationMessage}) — NOT a bare stamp — so the signature is bound to
     * this strand's contents and cannot be transplanted onto an attacker-chosen row. The
     * StampId is persisted as a unique column for single-use anti-replay.
     *
     * @param strandId - Unique identifier for the strand
     * @param type - Strand type: 'o' for open, 'c' for closed
     * @param ownerKey - Public key of the authorizing owner
     * @param signMessage - Function that ed25519-signs the raw message bytes (no pre-hash)
     *   with the owner's private key, returning a base64url signature
     * @param memberPrivateKey - Optional private key for membership in closed strands
     */
    insertStrand(strandId: string, type: 'o' | 'c', ownerKey: string, signMessage: (message: Uint8Array) => string, memberPrivateKey?: string): Promise<void>;
    /**
     * Delete a strand from the control database using an owner signature.
     *
     * Mirrors {@link insertStrand}'s row-bound approach for the delete half: the owner
     * signs the canonical `'remove'`-tagged authorization message over (Id, StampId) — the
     * schema's `Strand.AuthorizedDelete` verifies this DISTINCT digest, so the insert
     * approval (which never expires) can never be replayed as a removal. The delete and
     * the `Revocation` tombstone retiring the row's StampId commit in ONE transaction —
     * `Strand.RevocationRecorded` refuses a bare delete, and without the tombstone the
     * stamp would free up and the original formation approval could re-seat the strand.
     * Body shared with every other guarded delete via {@link deleteGuardedRow}.
     *
     * The remove digest binds only (Id, StampId) — not Type/MemberPrivateKey — so this
     * works identically for open and closed strands.
     *
     * When the strand has a `StrandPartyKey` row (this party's own membership identity for
     * the strand — minted at publish for closed strands), it is deleted IN THE SAME
     * transaction, with its own `'remove'`-tagged signature and its own `Revocation`
     * tombstone, so a re-published strand always mints fresh identity and no crash window
     * can orphan the key row. The party-key delete happens ONLY alongside an actual strand
     * row delete: a `StrandPartyKey` row with no local `Strand` row is a JOINER's identity
     * (the joiner never holds the strand row) and is not this method's to destroy — that
     * is {@link deleteStrandPartyKey}'s.
     *
     * A no-op (no throw, no tombstone) when the row does not exist — `false` then, `true`
     * when a row was actually removed.
     */
    deleteStrand(strandId: string, ownerKey: string, signMessage: (message: Uint8Array) => string): Promise<boolean>;
    /**
     * The locked body of {@link deleteStrand}: the `Strand` delete + tombstone, plus — when
     * one exists — the strand's `StrandPartyKey` delete + tombstone, all in ONE
     * transaction. A two-table sibling of {@link deleteGuardedRow} (see that method for the
     * per-clause security rationale: stamp read inside the locked body, `'remove'`-tagged
     * digests, mandatory same-transaction tombstones); kept separate rather than
     * generalizing the shared body because no other guarded table has a companion row.
     *
     * NOTE: that duplication is a drift risk, not a correctness one — a future tightening of
     * {@link deleteGuardedRow}'s discipline (an extra precondition, a different digest shape)
     * will NOT reach this body. Grep for both when you change either; if a second guarded
     * table ever gains a companion row, generalize instead of copying this a third time.
     *
     * Not wrapped in {@link withWriteLock} — the caller holds the (non-re-entrant) lock.
     */
    private deleteStrandAndPartyKey;
    /**
     * Insert this party's own strand membership identity key (`StrandPartyKey` row) using
     * an owner signature.
     *
     * Mirrors {@link insertStrand}: the owner signs the canonical row-bound authorization
     * message over (Id, PrivateKey, StampId) — binding the key material means a captured
     * approval can only ever reproduce the exact key it approved — and the StampId is
     * persisted as a unique column for single-use anti-replay.
     *
     * @param strandId - The strand this key is the party's identity for.
     * @param privateKey - The party's ed25519 strand member private key, base64 protobuf
     *   (same encoding as `Strand.MemberPrivateKey`; mint with `generateStrandMemberKey`).
     * @param ownerKey - Public key of the authorizing owner.
     * @param signMessage - Function that ed25519-signs the raw message bytes (no pre-hash)
     *   with the owner's private key, returning a base64url signature.
     */
    insertStrandPartyKey(strandId: string, privateKey: string, ownerKey: string, signMessage: (message: Uint8Array) => string): Promise<void>;
    /**
     * Owner-signed removal of one `StrandPartyKey` row — the party's own membership
     * identity for that strand, stored nowhere else, so this is as destructive as
     * {@link deleteStrand} on a closed strand. {@link deleteStrand} already removes the
     * founder's row alongside the `Strand` row in one transaction; this standalone form
     * exists for a party-key row with NO local `Strand` row (a joiner's identity — the
     * shape the formation tickets build on).
     *
     * Mirrors {@link deleteValidationKey}: `'remove'`-tagged digest over (Id, StampId),
     * `Revocation` tombstone in the same transaction. A no-op (no throw, no tombstone)
     * when the row does not exist — `false` then, `true` when a row was actually removed.
     */
    deleteStrandPartyKey(strandId: string, ownerKey: string, signMessage: (message: Uint8Array) => string): Promise<boolean>;
    /**
     * Record, party-wide, a strand this party joined from another party (`JoinedStrand` row),
     * using an owner signature.
     *
     * Mirrors {@link insertStrand}: the owner signs the canonical row-bound authorization
     * message over (Id, Type, MemberPrivateKey, StampId) — binding the read secret, so a
     * captured approval can only reproduce the row it approved — and the StampId is persisted
     * as a unique column for single-use anti-replay.
     *
     * Fails with a `JoinedStrand.Id` uniqueness violation when the id is already recorded;
     * `isStrandIdConflict(error, 'JoinedStrand')` identifies that case.
     */
    insertJoinedStrand(row: Pick<StrandRow, 'Id' | 'Type' | 'MemberPrivateKey'>, ownerKey: string, signMessage: (message: Uint8Array) => string): Promise<void>;
    /**
     * Owner-signed removal of one `JoinedStrand` row. Mirrors {@link deleteStrandPartyKey}:
     * `'remove'`-tagged digest over (Id, StampId), `Revocation` tombstone in the same
     * transaction. A no-op (no throw, no tombstone) when the row does not exist — `false`
     * then, `true` when a row was actually removed.
     */
    deleteJoinedStrand(strandId: string, ownerKey: string, signMessage: (message: Uint8Array) => string): Promise<boolean>;
    /**
     * Insert a validation key into the control database using an owner signature.
     *
     * Mirrors {@link insertStrand}: the owner signs the canonical row-bound
     * authorization message over (Key, StampId), and the StampId is persisted as a unique
     * column for single-use anti-replay. A `ValidationKey` authorizes verifying strand
     * formation disclosures.
     *
     * @param key - The validation public key to enroll
     * @param ownerKey - Public key of the authorizing owner
     * @param signMessage - Function that ed25519-signs the raw message bytes (no pre-hash)
     *   with the owner's private key, returning a base64url signature
     */
    insertValidationKey(key: string, ownerKey: string, signMessage: (message: Uint8Array) => string): Promise<void>;
    /**
     * Delete a validation key from the control database using an owner signature.
     *
     * Mirrors {@link insertValidationKey}'s row-bound approach for the delete half: the
     * owner signs the canonical `'remove'`-tagged authorization message over (Key,
     * StampId) — the schema's `ValidationKey.AuthorizedDelete` verifies this DISTINCT
     * digest, so the enrollment approval (which never expires) can never be replayed as a
     * removal. The delete and the `Revocation` tombstone retiring the row's StampId commit
     * in ONE transaction — `ValidationKey.RevocationRecorded` refuses a bare delete, and
     * without the tombstone the stamp would free up and the original enrollment approval
     * could re-seat the key. Body shared with every other guarded delete via
     * {@link deleteGuardedRow}.
     *
     * A no-op (no throw, no tombstone) when the row does not exist — `false` then, `true`
     * when a row was actually removed.
     */
    deleteValidationKey(key: string, ownerKey: string, signMessage: (message: Uint8Array) => string): Promise<boolean>;
    /**
     * Owner-vouched INSERT of one `CadrePeer` membership row, notifying the membership
     * listener once it has committed.
     *
     * Mints a fresh single-use `StampId` and signs the `'vouch'`-tagged authorization
     * message over (PeerId, StampId) — see {@link buildAuthorizationMessage} — satisfying
     * the schema's `CadrePeer.AuthorizedInsert`. Binding the peer id to the nonce means a
     * captured insert approval cannot be replayed (live rows are blocked by the unique
     * `StampId` column, removed rows by `Revocation` retirement via `CadrePeer.NotRevoked`)
     * and cannot be repurposed as a delete (which signs a distinct `'remove'`-tagged digest).
     *
     * The owner signature does NOT cover the address columns — those are vouched only as far
     * as the owner asserts them, and a peer's own `Sig` (when present) is what makes the row
     * resolvable.
     *
     * The {@link mutateCadrePeer} wrapper lives here rather than in the caller so no
     * `CadrePeer` inserter can forget it — the write itself is what lets the admitted peer's
     * traffic in.
     *
     * Idempotent on an already-present row: two writers can legitimately race the SAME peer's
     * first row — the node's own background self-publish ({@link CadreNode.registerSelf})
     * against a foreground {@link SeedBootstrapService.authorizePeer} of that node's id — and
     * the write lock only serializes them; the loser would hit the `CadrePeer.PeerId` UNIQUE
     * constraint. The existence check runs INSIDE the locked body, so it sees the winner's
     * committed row (a pre-lock check would re-open the read-then-insert window). The existing
     * row — voucher, addresses, self-`Sig` — is left untouched; re-touching a live row is
     * {@link reauthorizeCadrePeer}'s job.
     *
     * @param row - the membership row's columns; `multiaddr` is the comma-joined address list.
     * @param ownerKey - public key of the vouching owner, persisted into `VouchOwner`.
     * @param signMessage - ed25519-signs the raw message bytes (no pre-hash) with that owner's
     *   private key, returning a base64url signature.
     * @returns `true` when this call performed the INSERT, `false` when the in-lock existence
     *   check found the row already seated. The loser needs to know: an authorize seats a row
     *   with a null `Sig`, so a self-publish that lost the race must fall through to a
     *   self-update or its record never lands.
     */
    insertCadrePeer(row: {
        peerId: string;
        publicKey: string | null;
        multiaddr: string;
        updatedAt: number;
        sig: string | null;
    }, ownerKey: string, signMessage: (message: Uint8Array) => string): Promise<boolean>;
    /**
     * Owner "re-touch" of an existing `CadrePeer` membership row: bump `UpdatedAt` and
     * rewrite `VouchOwner`/`VouchSig` under the owner branch of `CadrePeer.AuthorizedUpdate`
     * (a signature over the SAME `'vouch'`-tagged digest {@link insertCadrePeer} builds), so
     * the row is re-emitted as a fresh, broadcasting transaction.
     *
     * This is the write-while-alone re-replication primitive: a membership row that committed
     * local-only (its block's cluster ≤1 at insert) is pushed to the cohort once it grows, by
     * re-issuing this monotonic bump. It is an UPDATE (not the original INSERT) because the row
     * already exists locally; a re-INSERT would hit the `PeerId` PK. Only the freshness stamp
     * and voucher change — `PublicKey` / `Multiaddr` / `Sig` are left intact — so it is safe
     * over a row whose peer has not self-published (`Sig` null); the caller must skip a row
     * that already carries a self-`Sig` (that row is the owning peer's to refresh, and bumping
     * `UpdatedAt` without re-signing would invalidate its self-signature).
     *
     * Signs over the row's CURRENT `StampId` (unchanged by the re-touch), read BEFORE the lock
     * is taken. An absent row returns `false` WITHOUT notifying: nothing was written, so the
     * membership snapshot cannot have changed.
     *
     * NOTE: that stamp read is outside the lock, same as {@link deleteGuardedRow}'s. A writer
     * that removes the row in between makes the `update` match nothing, and this still returns
     * `true` and notifies — harmless today (the sole caller, the write-while-alone drain, only
     * logs the result, and a spurious notify just re-reads the member set), and a remove-then-
     * re-add in the same window fails loudly instead, since the signature binds the retired
     * stamp. If a caller ever acts on `true` as proof the row was written, fold the stamp read
     * into the locked body.
     *
     * Notifies like the insert/remove paths even though this is "only" a re-touch: it rewrites
     * VouchOwner/VouchSig, which the authorized-membership predicate judges on, so it CAN
     * change the member set. Keeping the rule uniform ("every CadrePeer mutator notifies")
     * beats a per-method exception the next reader has to relearn.
     *
     * NOTE: this rebinds VouchOwner to the CALLING owner's key, and the authorized-membership
     * predicate (`CadreNode.listAuthorizedMembers`) now judges rows by that column against each
     * reader's node-local anchor. Benign today because the only caller — the write-while-alone
     * drain — re-touches solely rows this node itself authored (`pendingPeerWrites`), so the
     * voucher is rewritten to the key that already signed it. If a future path ever lets one
     * owner re-touch a row a DIFFERENT owner vouched, the voucher silently flips: readers that
     * anchor the original owner but not this one would drop a legitimate member. Such a path
     * must re-vouch deliberately (or preserve the existing VouchOwner/VouchSig) rather than
     * inherit this rebinding.
     *
     * @param peerId - the membership row to re-touch.
     * @param updatedAt - the strictly-increasing freshness stamp to write.
     * @param ownerKey - public key of the re-vouching owner, rewritten into `VouchOwner`.
     * @param signMessage - ed25519-signs the raw message bytes with that owner's private key.
     * @returns `true` when the row was re-touched, `false` when no row exists (no notify).
     */
    reauthorizeCadrePeer(peerId: string, updatedAt: number, ownerKey: string, signMessage: (message: Uint8Array) => string): Promise<boolean>;
    /**
     * Owner-signed removal of one `CadrePeer` membership row, notifying the membership
     * listener once it has committed.
     *
     * Mirrors {@link deleteStrand} for the membership table: the owner signs the DISTINCT
     * `'remove'`-tagged digest over (PeerId, StampId), so the row's stored `VouchSig` can
     * never be replayed to delete it, and the `Revocation` tombstone retiring the stamp
     * lands in the SAME transaction — `CadrePeer.RevocationRecorded` refuses a bare delete,
     * and without the tombstone the never-expiring admission approval (which the removed
     * peer holds a copy of) could re-seat the row.
     *
     * The {@link mutateCadrePeer} wrapper lives here rather than in the caller so no
     * `CadrePeer` remover can forget it. It notifies whenever the body resolves, including
     * the absent-row no-op below — a caller that must not notify for an already-absent peer
     * gates on {@link queryCadrePeerStampId} first (see
     * {@link SeedBootstrapService.removePeer}).
     *
     * A no-op (no throw, no tombstone) when the row does not exist — `false` then, `true`
     * when a row was actually removed.
     */
    deleteCadrePeer(peerId: string, ownerKey: string, signMessage: (message: Uint8Array) => string): Promise<boolean>;
    /**
     * Owner-signed removal of one peer's `DeviceToken` row (logout / token invalidation).
     *
     * Mirrors {@link deleteStrand}: the owner signs the DISTINCT `'remove'`-tagged digest
     * over (PeerId, StampId), so the insert approval can never be replayed to clear a token,
     * and the `Revocation` tombstone retiring the stamp lands in the SAME transaction —
     * `DeviceToken.RevocationRecorded` refuses a bare delete, and without the tombstone the
     * never-expiring insert approval (which the cleared device holds a copy of) could
     * re-seat the token.
     *
     * A no-op (no throw, no tombstone) when the row does not exist — `false` then, `true`
     * when a row was actually removed.
     */
    deleteDeviceToken(peerId: string, ownerKey: string, signMessage: (message: Uint8Array) => string): Promise<boolean>;
    /**
     * Owner-signed delete of one guarded row plus the `Revocation` tombstone retiring its
     * stamp, in ONE transaction. The single body behind EVERY guarded delete —
     * {@link deleteStrand}, {@link deleteValidationKey}, {@link deleteCadrePeer},
     * {@link deleteDeviceToken}; see any of them for the per-table security rationale. Each
     * of those is a thin named wrapper, so callers never pass a table name and this
     * generic shape stays off the public surface.
     *
     * `OwnerKey` is excluded from `table` only because no owner-key removal path exists in
     * production yet — the schema has the `'remove'` branch (`OwnerKey.Authorized`, which
     * requires a DIFFERENT owner as signer) and `control-revocation-replay.spec.ts` drives
     * it with hand-rolled SQL. Widen this and add a wrapper when that path lands; the body
     * needs no change.
     *
     * The row's CURRENT stamp is read first and signed over, so the remove digest binds to
     * this exact row instance. A no-op (no throw, no tombstone) when the row is absent —
     * reported as `false` so a caller can tell "removed" from "was never there" without a
     * second read (e.g. {@link CadreNode.unpublishStrand}'s committed-while-alone warning,
     * which must not fire for a no-op).
     *
     * NOTE: the stamp read is outside the transaction. A concurrent writer that removes
     * the row in between makes the signature bind a stamp that is no longer live; the
     * delete then matches nothing and the tombstone insert collides with the other
     * writer's on `Revocation`'s (TableName, StampId) primary key, so the transaction
     * fails rather than silently half-applying. If concurrent owner-device removals ever
     * become routine, fold the stamp read into the transaction instead.
     *
     * Deliberately NOT wrapped in {@link withWriteLock}: every public entry point already
     * holds the (non-re-entrant) lock, so taking it again here would self-deadlock.
     *
     * `table` and its {@link GUARDED_KEY_COLUMN} column are interpolated into the SQL; both
     * come from closed literal unions — no caller-supplied string reaches the statement.
     */
    private deleteGuardedRow;
    /**
     * Fire the guarded-delete listener for one committed tombstone, swallowing (and
     * logging) a listener throw — a committed delete never fails because bookkeeping did.
     * Shared by {@link deleteGuardedRow} and {@link deleteStrandAndPartyKey} (which files
     * up to two tombstones per transaction).
     */
    private notifyGuardedDelete;
    /**
     * Delete one guarded row that an ALREADY-COMMITTED `Revocation` tombstone retires —
     * the local catch-up for a node that converged on a removal's tombstone while still
     * holding the removed row. That live-row-plus-tombstone state is reachable only by
     * replication merge (local writes cannot build it: `Revocation.RowIsGone` refuses a
     * tombstone while the row is live), and replication cannot carry the delete itself —
     * replaying a delete of a row that is already gone locally is a no-op — so without
     * this the stale row is permanent garbage on every node that held it at revocation
     * time. Authorized by the REAP branch of the table's `AuthorizedDelete`: the
     * tombstone is itself owner-signed (`Revocation.Authorized`), so no owner key is
     * needed HERE — any node holding row + tombstone may reap, drones included.
     *
     * Returns whether a row was removed: `false` without writing when the row is absent
     * locally (the common case on most nodes), or when its live stamp is not `stampId`
     * (a fresh incarnation the owner re-seated, which the old tombstone must not touch).
     *
     * The delete's WHERE clause binds `StampId` too — required, not belt-and-braces: an
     * owner may re-seat the row (fresh stamp) between the stamp read below and the
     * statement, and without the clause the reap would delete the owner's brand-new row.
     * With it the statement matches nothing and the reap is a silent no-op (the schema
     * branch would also refuse that delete, but as a constraint error thrown into a
     * background sweep — matched-nothing is the better failure mode). Like
     * {@link reauthorizeCadrePeer}, a race lost AFTER the guard still returns `true`;
     * harmless — nothing was deleted, and the next sweep re-reads.
     *
     * Writes NOTHING to `Revocation`: `RevocationRecorded` is satisfied by the same
     * committed tombstone that authorizes the reap, so a reap files no second tombstone.
     * It therefore does NOT fire the guarded-delete listener either — that seam exists to
     * queue a tombstone for re-issue when it committed while alone, and a reap has no
     * tombstone of its own to re-issue. A reap that commits while alone needs no
     * re-replication at all: every OTHER node either already lacks the row, or holds the
     * same committed tombstone and reaps its own copy.
     *
     * NOTE: the reap delete is keyed on the primary key; the `StampId` predicate is applied
     * where the statement runs. If a reap on one node ever has to be reconciled against an
     * owner re-seat of the same key that landed on another node, whether the delete or the
     * re-seat wins is decided by the collection's merge order, not by this clause — the same
     * ordering question the owner-signed delete path already carries
     * (`tickets/blocked/forked-control-collection-sync-livelocks.md`). Only matters once a
     * sweep drives this automatically on connected nodes; if that reconcile ever drops a
     * freshly re-seated row, this is the site.
     *
     * `table` and its {@link GUARDED_KEY_COLUMN} column come from closed literal unions —
     * no caller-supplied string reaches the statement (same injection-surface discipline
     * as {@link deleteGuardedRow}). The `with context` clause is PRESENT and bound to
     * nulls, never omitted: Quereus cannot resolve `context.OwnerKey` at plan time when
     * the clause is absent while a constraint references `context.*` (nulls through a
     * present clause are the shape {@link redeemInvitation}'s consent-branch insert ships).
     *
     * Driven automatically by {@link reapRevokedRows}, which the periodic control-cohort
     * reconcile pass runs while the node has at least one control connection.
     */
    reapRevokedRow(table: ReapableTable, rowKey: string, stampId: string): Promise<boolean>;
    /**
     * Sweep every locally-held `Revocation` tombstone and {@link reapRevokedRow} the guarded
     * row each one retires, returning how many rows were actually removed.
     *
     * This is the enumeration half of the reap: replication carries the tombstone but cannot
     * carry the delete (replaying a delete of an already-absent row is a no-op), so a node
     * that converged on a removal while holding the removed row keeps that row as inert
     * garbage until something walks the tombstones and drops it. `CadreNode`'s periodic
     * control-cohort reconcile pass is that something, gated on the node having at least one
     * control connection (a reap is a write, and a write committed alone is local-only).
     *
     * Enumerated UNLOCKED, deleted per-row LOCKED: {@link reapRevokedRow} takes the write
     * lock itself (via {@link mutateCadrePeer} / {@link execWrite}) and the lock is not
     * re-entrant, so this loop must not hold it. Same structure as
     * `CadreNode.reissueAuthoredMembershipRows`.
     *
     * Two rows are deliberately left alone:
     *
     * - **Tables outside {@link REAPABLE_TABLES}** (`Strand`, `StrandPartyKey`, `OwnerKey`)
     *   — no reap branch exists on their `AuthorizedDelete`, so the delete would throw
     *   rather than no-op.
     * - **This node's OWN `CadrePeer` / `DeviceToken` row** (`selfPeerId`). Reaping it would
     *   fight this node's own re-registration: `registerSelf` / `retouchSelfDeviceToken` run
     *   on the heartbeat and the growth drain, and after a self-reap their insert-if-absent
     *   guard takes the INSERT path — which needs an owner signature `NotRevoked` refuses for
     *   a retired stamp, and which a revoked drone cannot produce at all. The trade is
     *   recurring failure noise every cycle against removing the one stale row nobody else
     *   reads from this node (every other node already filters it by tombstone). A revoked
     *   node therefore keeps its own copy of its own row; "a node that learns it has been
     *   revoked should shut itself down" is a distinct behaviour and its own ticket.
     *   `ValidationKey` and `JoinedStrand` have no self notion and are not special-cased.
     *
     * A per-row failure is logged and skipped rather than aborting the sweep: an abort would
     * starve every tombstone after the failing one on every subsequent pass, and each row is
     * independent. Returns the count so far if the database is closed mid-sweep.
     *
     * `selfPeerId` is a parameter rather than read from the injected libp2p node so the
     * skip-self rule is exercisable without one.
     *
     * NOTE: cost is O(tombstones), not O(live rows) — one {@link queryRevocations} scan plus
     * one {@link queryStampId} point lookup per tombstone, and the empty early return makes
     * the common case (a party that has never revoked anyone; {@link queryRevocations} skips
     * the ledger marker) a single scan per pass. That scan consults the cohort on every pass
     * only while `Revocation` has never been written; the ledger marker
     * ({@link openRevocationLedger}), filed by the same connected pass, makes it a held block.
     * But `Revocation` is append-only and unbounded, so this is O(all tombstones ever) point
     * lookups on every reconcile tick. Fine while revocations stay rare for a cadre-sized
     * party; if the table ever grows, persist a node-local high-water mark of what has
     * already been reaped instead of re-scanning everything (the same bound the sweep in
     * `CadreNode.drainPendingRevocations` wants).
     */
    reapRevokedRows(selfPeerId: string): Promise<number>;
    /**
     * Owner-signed re-issue of a batch of `Revocation` tombstones: bump each row's
     * `ReissuedAt` to `reissuedAt` in ONE transaction. Re-writing the row is what makes
     * the storage layer re-broadcast it — a tombstone that committed while the node was
     * alone is local-only, and unlike an insert a delete cannot be replayed (the guarded
     * row is already gone locally), so the tombstone is the half of a removal that can
     * still carry it to the rest of the party.
     *
     * One transaction, not one per row: a sweep may cover every tombstone in the table,
     * and each separate commit is a separate round of network work. One owner signature
     * per row: `AuthorizedReissue`'s digest binds (TableName, RowKey, StampId,
     * ReissuedAt). `reissuedAt` must be STRICTLY above every affected row's current
     * value (`ReissueOnly`); callers derive it as `Math.max(Date.now(), max(existing) + 1)`,
     * mirroring {@link CadreNode.reissuePeerAuthorize}'s monotonic bump. Re-issuing a
     * tombstone whose guarded row was never present locally is the normal case (a node
     * that converged on the tombstone but never held the row) — a re-issue files no
     * delete, so `RowIsGone` / `RevocationRecorded` are not involved.
     *
     * A constraint failure on any row rolls the WHOLE batch back and propagates —
     * {@link lockedWithRetry}'s classifier only re-presents transient cluster failures,
     * so a real refusal (non-owner signer, or a stale counter when two owner devices
     * sweep concurrently and the loser's `ReissueOnly` CHECK fails) surfaces to the
     * caller, which retries with a fresh counter on its next sweep. A row whose
     * `StampId` matches nothing locally is a silent no-op statement; callers enumerate
     * via {@link queryRevocations} first, so they only name stamps they hold.
     *
     * Returns how many UPDATE statements ran (`rows.length` on success).
     */
    reissueRevocations(rows: readonly RevocationRow[], reissuedAt: number, ownerKey: string, signMessage: (message: Uint8Array) => string): Promise<number>;
    /**
     * Owner-signed filing of the singleton `Revocation` ledger marker
     * ({@link REVOCATION_LEDGER_MARKER}), the one row in that table that retires nothing.
     *
     * Why it exists: while `Revocation` has never been written, this node does not hold its
     * block, and Optimystic consults a block's cohort on EVERY read of a block it does not
     * hold — and every membership lookup, and every guarded insert's `NotRevoked` check,
     * reads this table. Once any row exists the block is held and re-checked at most once per
     * read-repair window, like every other populated table. The schema's table comment says
     * why the row can never read as a retirement.
     *
     * Insert-if-absent, shaped like {@link reissueRevocations}: the signature is minted
     * OUTSIDE the locked body so a retried attempt re-presents the same one, and the guard
     * runs INSIDE it so it sees a concurrent local writer's committed row. The guard scans
     * the `'Revocation'` rows and compares the stamp in TypeScript rather than seeking the
     * full composite primary key, which is served as a point lookup that can miss an existing
     * row on a networked database (tickets/backlog/debt-composite-pk-point-lookup-unreliable-untracked).
     *
     * Two owners filing at once: the loser either sees the marker in its guard or is refused
     * on the primary key, and both answer `'already-open'`.
     *
     * The caller decides WHEN. A marker committed while the node is alone is local-only and
     * can fork the collection, so {@link CadreNode} files it only while connected; this
     * method does not look at connectivity.
     *
     * @param ownerKey - owner public key for the write context (`Revocation.Authorized`).
     * @param signMessage - ed25519-signs the raw message bytes (no pre-hash) with that owner's
     *   private key, returning a base64url signature.
     * @returns `'opened'` when this call filed the marker, `'already-open'` when it was
     *   already there.
     */
    openRevocationLedger(ownerKey: string, signMessage: (message: Uint8Array) => string): Promise<RevocationLedgerOpenResult>;
    /**
     * Whether the ledger marker is present locally: a scan of the `'Revocation'` rows with the
     * stamp compared in TypeScript (see {@link openRevocationLedger} for why not a seek).
     * Called only inside the locked write body, so never retried (see queryStampId's NOTE).
     */
    private revocationLedgerFiled;
    /**
     * Run `body` between `beginTransaction` and `commit`, rolling back on failure.
     *
     * A failed `commit()` has already torn the transaction down, so the `rollback()` in
     * the failure path would itself throw "No transaction active" and mask the real
     * cause — that secondary throw is logged and swallowed, and the original error always
     * propagates.
     *
     * It opens a transaction unconditionally (Quereus hard-throws on a nested
     * `beginTransaction`), so a caller already inside one must not call it. A `CadrePeer`
     * write nests this INSIDE {@link mutateCadrePeer}, never the reverse — see
     * {@link assertCommitBoundary}.
     *
     * Private: every multi-statement control write lives in this class (the owner-signed
     * delete/tombstone pairs all go through {@link deleteGuardedRow}), so needing to widen
     * this is a sign the writer that wants it belongs in here too.
     *
     * Deliberately NOT wrapped in {@link withWriteLock}: callers already hold the
     * (non-re-entrant) lock, so taking it again here would self-deadlock.
     *
     * @param label - What the transaction was doing, for the rollback log line.
     */
    private inTransaction;
    /**
     * Wire (or clear, with null) the single listener notified after every committed
     * `CadreControl.CadrePeer` row write.
     *
     * At most one listener: a ControlDatabase instance belongs to exactly one
     * {@link CadreNode}, which wires this in `start()` and clears it on teardown. A
     * second call replaces the first rather than fanning out, so a stale node can
     * never keep receiving notifications for a database it no longer owns.
     */
    setMembershipChangeListener(listener: MembershipChangeListener | null): void;
    /**
     * Wire (or clear, with null) the single listener notified after every committed
     * guarded-table delete. Same ownership contract as
     * {@link setMembershipChangeListener}: one CadreNode, one listener, a second
     * call replaces the first.
     */
    setGuardedDeleteListener(listener: GuardedDeleteListener | null): void;
    /**
     * Wire (or clear, with null) the single listener notified when {@link lockedWithRetry}
     * ABANDONS a control write. Same ownership contract as
     * {@link setMembershipChangeListener}: one CadreNode, wired in `start()` and cleared on
     * teardown, and a second call replaces the first rather than fanning out.
     *
     * Covers every write that reaches the funnel, foreground and background alike. A
     * foreground caller also sees the rethrown error; a background one often does not, which
     * is the whole reason this exists.
     */
    setControlWriteAbandonedListener(listener: ControlWriteAbandonedListener | null): void;
    /**
     * Run a `CadrePeer` row mutation and notify the membership listener once it has
     * COMMITTED.
     *
     * EVERY `CadrePeer` writer goes through here, with one documented exception
     * ({@link updateSelfPeerRecord}, which cannot change the snapshot) — that is what makes
     * the party-membership snapshot refresh automatic rather than a caller obligation. A
     * writer necessarily holds the target node's ControlDatabase (the `SeedBootstrapService`'s
     * event callbacks are NOT a viable seam: the temp services `CadreNode.applySeed`/
     * `dialInvite` build, and services constructed outside `CadreNode` entirely, never get
     * callbacks wired), so this is the one point on the write path that cannot be bypassed.
     *
     * `body` owns its own transaction if it needs one and must COMMIT before returning, so
     * the notification never makes the listener read uncommitted state. A throwing `body`
     * propagates and does NOT notify: nothing changed.
     *
     * That contract is enforced, not merely documented — see {@link assertCommitBoundary}.
     *
     * Runs under {@link withWriteLock}, notification included: with the lock held through
     * the notify, no other local writer can have a transaction open while the listener
     * reads, so the listener always sees exactly the committed state it was told about.
     * The listener itself only READS (it re-materializes the membership snapshot) — a
     * listener that wrote through a locked method would deadlock.
     *
     * Reaches the lock through {@link lockedWithRetry}, so after a transient cluster
     * failure the WHOLE locked body re-runs — `body` must be atomic and re-runnable (the
     * contract on {@link withWriteLock}). The notify sits after a successful `body` inside
     * the same attempt and a throwing attempt never reaches it, so a retried mutation
     * still notifies exactly once: on the attempt that commits, and not at all on
     * exhaustion.
     *
     * @param reason - Label for the log line only (e.g. `'peer-insert'`).
     */
    mutateCadrePeer<T>(reason: string, body: () => Promise<T>): Promise<T>;
    /**
     * Run one local write under the database-wide write lock, serializing it against
     * every other local writer on this ControlDatabase.
     *
     * Quereus tracks transaction state per `Database` (`getAutocommit()`), and a write
     * statement's implicit transaction stays open across the awaits inside `exec`. Two
     * local writers interleaving mid-statement therefore either trip
     * {@link assertCommitBoundary} (any `CadrePeer` path) or silently join each other's
     * open transaction — a torn commit if either side rolls back. This lock closes that
     * class: every public write method of this class runs its statement(s) under it, and
     * `SeedBootstrapService` reaches it through {@link execWrite} rather than touching the
     * `Database` directly, so it is covered too. The race is
     * real, not theoretical: the background self-record publish on a control connection
     * opening (`CadreNode.drainPendingControlReplication` → `registerSelf`) collided with
     * a foreground `authorizePeer` — both `CadrePeer` inserts — and tripped the boundary
     * assert.
     *
     * Reads are deliberately not locked: they take no transaction of their own, and
     * serializing them here would let a listener that reads during a notify (see
     * {@link mutateCadrePeer}) deadlock. The lock is NOT re-entrant — a locked writer's
     * body must never call another locked public method; the private bodies it composes
     * ({@link deleteGuardedRow}, {@link inTransaction}) stay bare for exactly that reason.
     *
     * NOTE: re-entry fails SILENTLY and PERMANENTLY. A locked body that calls another
     * locked public method (including a {@link mutateCadrePeer} body, which runs an
     * arbitrary caller-supplied callback) queues behind its own tail and never resolves —
     * no error, and it strands the whole write queue, not only that call. There is no
     * cheap fail-fast: a "held" flag cannot tell re-entry from a legitimately queued
     * concurrent writer. Compose bare private bodies instead.
     *
     * A locked body must also be ATOMIC and RE-RUNNABLE: the public write surface reaches
     * this lock through {@link lockedWithRetry}, which re-runs the WHOLE body after a
     * transient cluster failure. Atomic holds for every body today — one statement, or
     * wrapped in {@link inTransaction} — so a failed attempt leaves nothing half-applied;
     * re-runnable means a retry re-runs the body's reads too, which is what makes it safe.
     * Signatures and stamp ids minted OUTSIDE the body are deliberately NOT re-minted per
     * attempt: a retry re-presents the exact signed message the first attempt presented.
     */
    withWriteLock<T>(fn: () => Promise<T>): Promise<T>;
    /**
     * Run one locked body, counted in {@link runningWriteBodies} from the moment it takes
     * the lock until it settles — so an unlocked read routes around it even while its
     * first statement is still waiting for the database's exec mutex, before
     * `getAutocommit()` can show it (see {@link readRowsOnce}).
     */
    private runWriteBody;
    /**
     * {@link withWriteLock} plus the bounded transient-failure retry
     * ({@link retryControlWrite}) — the wrapper the whole public write surface goes
     * through, so a control write that failed because the cluster cohort did not answer is
     * re-presented a moment later instead of surfacing to ~19 callers that are not
     * uniformly written to retry.
     *
     * The retry wraps the LOCK, it does not live inside it: each attempt takes and
     * releases the lock, and the backoff sleeps with NO lock held, so a write parked in
     * backoff never stalls the other local writers queued behind it. Safe because every
     * locked body is atomic and re-runnable (the contract on {@link withWriteLock}).
     *
     * Also carries {@link loadSchema}'s distributed DDL, the one caller that runs BEFORE
     * `initialized` is set — so it reaches this method directly rather than through
     * {@link execWrite}, whose {@link ensureInitialized} would reject it. The write queue is
     * necessarily empty at that point, so the lock is uncontended there; it is taken anyway
     * rather than carving out a lockless path. It is also the ONLY caller that passes a
     * `policy` — everything else takes the default, whose classifier and attempt count are
     * unchanged by that call site existing.
     *
     * `label` names the operation in this loop's debug lines and nothing else
     * ({@link ControlWriteRetryOptions.label}). Every call site in this class supplies one:
     * several writes retry CONCURRENTLY in a real party, so an unlabelled line cannot be
     * attributed to a write — keep new call sites labelled. It is also the only thing that
     * attributes an abandonment reported through {@link setControlWriteAbandonedListener}.
     *
     * The abandonment observer lands LAST, after both the policy and the spec-injected
     * pacing, so this class's single listener is the one seam for it — a caller that
     * smuggled its own in through `policy` would be displaced here rather than fanning out.
     */
    private lockedWithRetry;
    /**
     * One-statement local write, serialized by {@link withWriteLock} and retried on a
     * transient cluster failure via {@link lockedWithRetry}. Prefer this over a bare
     * `getDatabase().exec` so a new writer cannot forget the lock — the hazard
     * {@link assertCommitBoundary} can only catch after the fact.
     *
     * Public so `SeedBootstrapService`'s direct `CadrePeer`/`DeviceToken` SQL writes go
     * through the same seam. Must NOT be called from inside an already-locked body (the
     * lock is not re-entrant); such a caller uses a bare `getDatabase().exec` instead.
     *
     * `label` names the write in the retry loop's debug lines (see {@link lockedWithRetry});
     * optional only because it is log-only, but every caller in this repo passes one.
     */
    execWrite(sql: string, params?: SqlParameters, label?: string): Promise<void>;
    /**
     * Throw unless the database sits at a committed boundary — `getAutocommit()` is false
     * exactly while a transaction is open.
     *
     * Both ends of a {@link mutateCadrePeer} body are checked, because either open
     * transaction would notify a listener that then reads PRE-commit state and materializes
     * a membership snapshot silently missing the write it was told about:
     *
     * - open on entry: the wrapper sits INSIDE an enclosing transaction and must be moved
     *   out to enclose that outer commit.
     * - open on return: the body opened a transaction and never committed it.
     *
     * Neither is reachable from today's callers, so this is a fail-fast guard on a future
     * mistake rather than a live code path.
     *
     * NOTE: `getAutocommit()` reports the whole `Database`, not this call. Local writers
     * serialize through {@link withWriteLock}, so with every writer locked this can only
     * trip on the two misuses above. A writer that bypasses the lock (a new method that
     * forgets it, or raw `getDatabase().exec` outside a locked wrapper) re-opens the
     * concurrent-writer window, and this assert is what catches it — it throws instead of
     * silently joining the other write's transaction.
     */
    private assertCommitBoundary;
    /**
     * Best-effort notify. A listener that throws is logged and swallowed: the write has
     * already committed, and it must never be reported as failed because a downstream
     * snapshot refresh did. A null listener (no `CadreNode` attached — e.g. the service
     * unit tests drive a bare control DB) is a silent no-op.
     */
    private notifyMembershipChanged;
    /**
     * Insert an owner-signed `FormationInvite` (open invitation token).
     *
     * The invite is the on-network record that later authorizes an
     * owner-signature-FREE `Strand` creation: an invited cadre peer redeems it
     * by inserting a matching `FormationUsage` row (see {@link redeemInvitation}),
     * which satisfies the consent branch of `Strand.AuthorizedInsert`.
     *
     * Like {@link insertStrand}/{@link insertValidationKey}, the owner signs the
     * canonical row-bound authorization message (see {@link buildAuthorizationMessage})
     * over (Token, sAppId, ExpiresAt, TotalUses, ValidationUrl, StrandId, StampId) — NOT a
     * bare stamp — so the signature is bound to this invite's contents and cannot be
     * transplanted onto an attacker-chosen row. The StampId is persisted as a unique
     * column for single-use anti-replay. `FormationInvite.AuthorizedInsert` gates insert
     * over an `'add'`-tagged digest; deletes verify a DISTINCT `'remove'`-tagged digest
     * (`AuthorizedDelete`), so this insert approval can never be replayed as a revocation.
     *
     * `StrandId` binds the invite to a pre-existing host strand (provision-then-record):
     * when set, a responder redeeming this token records a `FormationUsage` against that
     * strand and returns it (see {@link ControlFormationUsageRecorder.resolveStrand}); a
     * null `StrandId` (the default) takes the unbound responder-provisions path: the
     * responder provisions a fresh open strand and atomically records its one consent row.
     * Like ValidationUrl it is a nullable bound field, signed as `''` when absent.
     *
     * The ExpiresAt and TotalUses message fields must byte-match what the (auto-deferred,
     * because it has a subquery) CHECK sees AFTER column coercion: TotalUses becomes a
     * decimal string (`String(totalUses)` ⇔ `cast(new.TotalUses as text)`) and ExpiresAt
     * becomes the engine's canonical `PlainDateTime` string — sourced here from
     * {@link canonicalDatetime} (a `select datetime(?)` round-trip) rather than a hand-rolled
     * ISO formatter, so signer and verifier agree exactly. A null ExpiresAt / TotalUses /
     * ValidationUrl signs as `''`, matching the schema's `coalesce(..., '')`.
     *
     * @param token - Invitation token (the `FormationInvite` primary key)
     * @param sAppId - The sApp a redeemed strand will use
     * @param ownerKey - Public key of the authorizing owner
     * @param signMessage - ed25519-signs the raw message bytes (no pre-hash),
     *   returning a base64url signature — the same callback shape {@link insertStrand} uses
     * @param options - Optional `expiresAtMs` (epoch ms), `totalUses`, `validationUrl`,
     *   `strandId` (bind to a pre-existing host strand for provision-then-record)
     */
    insertFormationInvite(token: string, sAppId: string, ownerKey: string, signMessage: (message: Uint8Array) => string, options?: {
        expiresAtMs?: number;
        totalUses?: number;
        validationUrl?: string;
        strandId?: string;
    }): Promise<void>;
    /**
     * Redeem a `FormationInvite` by inserting the `Strand` row and a matching
     * `FormationUsage` row **atomically, in one transaction**.
     *
     * The two CHECK constraints are mutually circular under immediate evaluation:
     * `Strand.AuthorizedInsert`'s consent branch requires a `FormationUsage` row naming
     * this strand's `(Id, StampId)`, while `FormationUsage.StrandExists` requires a
     * `Strand` row matching that same pair — the ONE freshly-minted `strandStampId` below
     * satisfies both, which is what binds the consent record to this specific strand ROW
     * (so a later owner-signed, tombstoned removal cannot be undone by re-inserting the
     * id with a fresh stamp). Both CHECKs contain
     * subqueries, so Quereus auto-defers them to transaction commit — wrapping both
     * inserts in a single explicit `begin … commit` lets both deferred CHECKs see
     * both rows at commit. The strand is authorised WITHOUT an owner signature
     * (the `FormationUsage` branch of `Strand.AuthorizedInsert`) but still gets a fresh,
     * unique `StampId` column to satisfy the not-null/unique anti-replay column.
     *
     * The seated strand is always open (`'o'`) and keyless — the consent branch of
     * `Strand.AuthorizedInsert` accepts nothing else, the invite must be UNBOUND
     * (`FormationInvite.StrandId` null; a bound invite's host strand is owner-provisioned
     * and only ever record-only, see {@link recordFormationUsage}), and a given strand id
     * may be consent-seated once, EVER: after an owner-signed removal, re-joining that id
     * takes an owner re-seat ({@link insertStrand}) plus a bound invite, never another
     * redemption.
     *
     * The usage row is keyed by the joiner's own nonce (`UsageStampId` is the primary key), so
     * concurrent redemptions of one token never contend for a shared row key — there is no
     * lost race to retry and no second trip through the approval hook. The invite's seat
     * budget is checked by COUNT ({@link assertSeatRemains}) inside the write lock, ahead of
     * the write, so a spent invite is refused by name (`InvitationExhaustedError`) instead of
     * as the schema cap clause's generic `Authorized` CHECK failure.
     */
    redeemInvitation(params: {
        token: string;
        strandId: string;
        /** The joining peer's own ed25519 public key. Required: it is inside BOTH signed digests (see {@link formationVouchMessage} / {@link formationConsentMessage}). */
        peerKey: string;
        disclosure?: string;
        /** Single-use nonce for this redemption, minted by the JOINER; both signed digests cover it. */
        usageStampId: string;
        /** The joiner's signature over the `'consent'` digest — verified by the `PeerConsented` CHECK. */
        peerSignature: string;
        nowMs?: number;
        validationKey?: string;
        validationSignature?: string;
        /**
         * Aborted when the caller has given up. Checked once PER ATTEMPT, inside the write lock,
         * before that attempt's transaction is opened — never between the two inserts — throwing
         * {@link FormationAbortedError} with the invite unspent.
         */
        signal?: AbortSignal;
        /**
         * The invite's seat budget, when the caller already has it in hand (e.g. it already read
         * the `FormationInvite` row to get here). Passed through to {@link assertSeatRemains} so
         * the seat check needs no extra read. `undefined` falls back to a fresh
         * {@link queryFormationInvite} read; `null` means "no invite row" / unlimited.
         */
        totalUses?: number | null;
    }): Promise<FormationUsageResult>;
    /**
     * Record a `FormationUsage` against an **already-existing** `Strand` (no strand
     * insert). This is the redemption path when the strand was provisioned
     * separately (e.g. owner-signed) and the consent record is added after the
     * fact: the single insert auto-commits, and the deferred `StrandExists` CHECK
     * is satisfied by the pre-existing committed strand row. Echoes back the
     * redemption's `usageStampId` (the row's primary key).
     *
     * Use {@link redeemInvitation} instead when the strand must be created by
     * consent atomically with the usage.
     *
     * The strand's live `StampId` is read first and written onto the usage row:
     * `FormationUsage.StrandExists` matches the (id, stamp) PAIR, and
     * `Strand.AuthorizedInsert`'s consent branch reads the same pair back, so a consent
     * record authorizes exactly the strand ROW it was recorded against. A missing strand
     * THROWS here rather than being left to the deferred `StrandExists` CHECK — the
     * ordinary "host strand has not converged yet" case is already reported as `missing`
     * by {@link ControlFormationUsageRecorder.resolveStrand}, so an absent row at this
     * point is a genuine race and deserves a named error, not a silent rollback.
     *
     * The row is keyed by the joiner's own nonce (`UsageStampId` is the primary key), so this
     * path — the one production actually races on (a bound invite published by `cadre-web` /
     * `cadre-phone` is always record-only) — never contends with another redemption for a
     * shared row key: there is no lost race to retry and no second trip through the approval
     * hook. The invite's seat budget is checked by COUNT ({@link assertSeatRemains}) inside
     * the write lock, ahead of the write.
     */
    recordFormationUsage(params: {
        token: string;
        strandId: string;
        /** The joining peer's own ed25519 public key. Required: it is inside BOTH signed digests (see {@link formationVouchMessage} / {@link formationConsentMessage}). */
        peerKey: string;
        disclosure?: string;
        /** Single-use nonce for this redemption, minted by the JOINER; both signed digests cover it. */
        usageStampId: string;
        /** The joiner's signature over the `'consent'` digest — verified by the `PeerConsented` CHECK. */
        peerSignature: string;
        nowMs?: number;
        validationKey?: string;
        validationSignature?: string;
        /**
         * Aborted when the caller has given up. Checked inside the write lock, before the insert
         * is issued, throwing {@link FormationAbortedError} with the invite unspent. Never
         * checked once the insert has been issued.
         */
        signal?: AbortSignal;
        /**
         * The invite's seat budget, when the caller already has it in hand (e.g. it already read
         * the `FormationInvite` row to get here). Passed through to {@link assertSeatRemains} so
         * the seat check needs no extra read. `undefined` falls back to a fresh
         * {@link queryFormationInvite} read; `null` means "no invite row" / unlimited.
         */
        totalUses?: number | null;
    }): Promise<FormationUsageResult>;
    /**
     * Refuse a redemption that would consume a seat the invite does not have.
     *
     * The schema's count-based cap clause (`FormationUsage.Authorized`) refuses an over-limit
     * write at the database anyway — but it fails as a generic `CHECK constraint failed:
     * Authorized`, which the manager reports as a retryable conflict. Catching it here as
     * {@link InvitationExhaustedError} lets the joiner be told the invitation is spent instead
     * of being sent around a loop that can never close. Runs inside the write lock, so on a
     * same-node race the loser reads the winner's committed row and is refused by name.
     *
     * `knownTotalUses` lets a caller that already read the `FormationInvite` row (both
     * production callers in `ControlFormationUsageRecorder` do) skip a second read on the common,
     * non-racing path. `undefined` falls back to a fresh read here.
     *
     * NOTE: a passed-in budget is a value read BEFORE the write lock (and, for a validating
     * invite, before an outbound approval call). Safe today because `FormationInvite` is
     * insert/delete only (its `Immutable` constraint), so the only way to stale it is an owner
     * revoking the token and re-issuing it with MORE seats mid-redemption; if invites ever gain
     * an update path, drop the parameter and read here instead.
     */
    private assertSeatRemains;
    /** Parameterised `FormationUsage` insert shared by redeem + record paths. */
    private execFormationUsageInsert;
    /**
     * Read a `FormationInvite` row by token, or null when absent. `expiresAtMs` is
     * the parsed epoch-ms of the stored `datetime` (null when the invite never
     * expires); the caller compares it against the wall clock for freshness.
     *
     * `retry: false` is passed only by {@link assertSeatRemains}, which runs INSIDE a
     * locked write body — same per-call opt-out, and for the same reason, as
     * {@link queryStampId}'s. Every unlocked caller keeps the default retried path.
     */
    queryFormationInvite(token: string, retry?: boolean): Promise<{
        token: string;
        sAppId: string;
        expiresAtMs: number | null;
        totalUses: number | null;
        validationUrl: string | null;
        strandId: string | null;
    } | null>;
    /**
     * Count `FormationUsage` rows recorded against a token (uses consumed so far).
     *
     * Served by a seek through the `FormationUsageByToken` index rather than a full scan of
     * the table, which is append-only and grows for the life of the party.
     *
     * This read is NOT the seat cap. The authoritative cap is the deferred `Authorized` CHECK
     * in `schemas/control.qsql` — `FI.TotalUses > (select count(1) from
     * committed.FormationUsage U where U.Token = new.Token)` — evaluated by the validating
     * cohort against the committed snapshot at commit time. Every caller of this method is a
     * permissive PRE-check that runs ahead of it, and a transiently short read costs each of
     * them only a worse outcome for the ATTEMPT, never a seat the invitation did not pay for:
     * {@link assertSeatRemains} loses its named exhaustion error and falls back to the CHECK's
     * generic refusal; `ControlFormationUsageRecorder.isTokenUsed` reports not-used and lets
     * the redemption proceed to the CHECK, which decides; {@link hasOutstandingFormationInvite}
     * holds the stranger-admission door open slightly longer.
     *
     * NOTE: index convergence still gates the cap — just at the CHECK, not here, since the
     * CHECK's own count is served by the same `FormationUsageByToken` index. That convergence
     * failed from 2026-08-04 to 2026-08-25: a descent on a second machine returned only the
     * rows that machine had written, and the index was removed until the engine was fixed
     * upstream (re-measured 2026-09-17, `complete/restore-formation-usage-token-index`). The
     * live guard is the integration-tests scenario `strand-formation-concurrent-redemption`,
     * which asserts both machines' views of a raced redemption. If it fails on BOTH views
     * again, index convergence has regressed — fix the engine or take this read off the index,
     * and do not weaken that scenario's assertions to get a green run. A failure on ONE view is
     * NOT automatically that scenario being slow: one-way convergence lag, and the 2026-08 defect
     * itself, both present that way whenever only the sibling node wrote the rows. What separates
     * them is the failure message, which prints both nodes' rows and counts — a sibling holding
     * rows the failing view is missing is a convergence problem, not a slow run.
     *
     * `retry: false` is passed only by {@link assertSeatRemains}, which runs INSIDE a
     * locked write body — same per-call opt-out, and for the same reason, as
     * {@link queryStampId}'s. Every unlocked caller keeps the default retried path.
     */
    countFormationUsage(token: string, retry?: boolean): Promise<number>;
    /**
     * Is any `FormationInvite` row still redeemable — unexpired AND with usage
     * below its `TotalUses`? A null `ExpiresAt` never expires and a null
     * `TotalUses` is unlimited, matching {@link ControlFormationUsageRecorder}'s
     * per-token semantics (`isTokenValid` / `isTokenUsed`).
     *
     * Answers the control-network connection gate's coarse "does this node expect
     * a stranger?" question, which has no token to ask about. The expiry
     * comparison is `expiresAtMs <= now` — identical to `isTokenValid`'s — so an
     * invite the formation handler would reject can never hold the gate open.
     *
     * The scan is deliberately not pushed into SQL: nothing else here compares a
     * stored `datetime` with an inequality, so the parse stays in JS via the
     * shared {@link parseNullableStoredDatetimeMs}. Only invites that are
     * unexpired AND use-metered cost a {@link countFormationUsage} read, and an
     * unlimited-use invite anywhere in the scan short-circuits all of them.
     */
    hasOutstandingFormationInvite(nowMs?: number): Promise<boolean>;
    /**
     * Close the database and cleanup resources.
     *
     * Drains the local-write chain first: {@link withWriteLock} can park a write behind
     * others across an await, and a queued closure evaluates `this.db!` only when it
     * finally runs — so nulling the handle out from under it would throw a TypeError on a
     * null handle instead of committing. The tail never rejects (it swallows both
     * outcomes), so the bare await is safe.
     *
     * NOTE: this makes `close()` wait on a stuck write. Acceptable today — every locked
     * body is a bounded local `exec` — but revisit (bounded drain, or abandon after a
     * deadline) if a write can ever hang.
     */
    close(): Promise<void>;
    private ensureInitialized;
}
