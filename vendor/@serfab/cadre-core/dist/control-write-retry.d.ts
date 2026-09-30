import type { ControlRetryOptions } from './control-retry.js';
/**
 * Bounded retry for TRANSIENT control-write failures — the classifier and loop behind
 * `ControlDatabase.lockedWithRetry`, the single funnel every local control write passes
 * through.
 *
 * Why this exists: the control database replicates every block to the whole party, so a
 * three-machine party commits control writes unanimously (`ceil(3 × 0.75) = 3` approvals) —
 * and no `superMajorityThreshold` can lower that bar without violating Optimystic's
 * partition-safety condition at the shipped admission fraction (the arithmetic lives in
 * `docs/architecture.md` → "Replication cluster size"). Cadre therefore accepts unanimity
 * and absorbs the transient half of its cost here: a write that failed because the cohort
 * did not ANSWER (a stream reset mid-connection-formation, zero approvals) is re-presented
 * a moment later, which the degraded-cohort-member scenario measured as safe (a failed
 * write rolls back, nothing half-commits) and effective (the next write commits in ~1 s).
 *
 * A write somebody actually REJECTED is never retried on the strength of the rejection itself —
 * no matcher here claims a rejection message, at any phase, because re-presenting one would
 * re-present a spent signature against a cohort that already said no. Rejections are re-presented
 * anyway when they arrive inside the transactor's promise-phase `[block:` aggregate, which
 * {@link isUncommittedTransactorAggregate} claims on the WRAPPER alone, whatever the cause inside
 * says. Safe because nothing has committed at that phase, and deliberately kept — one of the
 * remaining promise-phase rejections is exactly the kind a re-presentation fixes. See the
 * accepted-tradeoff `NOTE:` there for which, and why no blanket rejection veto is wanted.
 *
 * A failure that says some of the write may be STORED is a different matter, and never
 * re-presented whatever text it carries: {@link reportsPossiblyStoredWrite} vetoes it by type
 * before any matcher runs. The one half-landed write that IS re-presented is a torn write the
 * library marks final — not saved and unable to land ({@link isFinalTornWrite}).
 *
 * TWO policies ship from here, and the split is deliberate: the default
 * ({@link isRetriableControlWriteFailure}, {@link CONTROL_WRITE_ATTEMPTS}) sits under every
 * control write, and {@link SCHEMA_INIT_RETRY_POLICY} is opted into by
 * `ControlDatabase.loadSchema` alone. The widened one absorbs one extra failure class whose
 * re-run safety holds for schema DDL and NOT for writes in general; anything added to the default
 * list must be safe for all ~19 callers.
 *
 * Lives outside `control-database.ts` so a spec can drive the classifier against real engine
 * errors without importing the whole database class. The loop itself lives in
 * `control-retry.ts`, shared with the READ policy (`control-read-retry.ts`) — this module
 * owns the write policies: their classifiers, attempt counts, backoff and budget.
 */
/**
 * Attempts allowed per control write: the first, plus two retries of a transiently-failed
 * cluster commit. Bounded so a genuinely unreachable cohort terminates in the transactor's
 * own error rather than spinning; two retries covers the observed failure (a stream still
 * forming when the write fired) with margin.
 */
export declare const CONTROL_WRITE_ATTEMPTS = 3;
/**
 * Attempts allowed for {@link SCHEMA_INIT_RETRY_POLICY}, the one call site that also absorbs a
 * self-coordination refusal.
 *
 * Two more than {@link CONTROL_WRITE_ATTEMPTS} because what this retry buys is wall-clock for a
 * cold-starting node's bootstrap dials to land, and because the refusal is cheap to re-provoke
 * relative to a cluster round-trip: `findCoordinator` already spends its own bounded wait before
 * raising (3 attempts, 500 ms apart, `db-p2p/src/libp2p-key-network.ts` ~422) and then decides
 * LOCALLY that it may not elect itself, so no peer is contacted and no cohort deadline is
 * consumed.
 *
 * Note that the ~1 s `findCoordinator` spends internally is real, on top of this policy's own
 * backoff — which is exactly why {@link CONTROL_WRITE_RETRY_BUDGET_MS} and not this count is what
 * actually terminates the loop in the worst case.
 */
export declare const SCHEMA_INIT_ATTEMPTS = 5;
/**
 * Elapsed-time ceiling on the whole retry loop, measured from the START of the first
 * attempt and checked after a failed attempt BEFORE sleeping.
 *
 * This budget — not the attempt count — is what makes the policy safe to sit under every
 * control write. A transient failure (stream reset while a connection is still forming)
 * surfaces in well under a second, so it is retried and the loop adds at most ~2.2 s. A
 * genuinely silent cohort member fails at ~20 s (two 10 s `ClusterClient` response-deadline
 * attempts, measured in `control-write-degraded-cohort-member.integration.ts`), which
 * already exceeds this budget when attempt 1 returns — so that case is surfaced immediately
 * and retry adds ZERO latency to the case where it cannot help.
 *
 * It cuts the loop off by design, so it does not grow with the link: its job is to end the
 * retries of slow attempts, and the caller gets the last attempt's error unchanged. An attempt
 * whose read phase consulted a silent peer ends at about one per-peer read deadline
 * (`cohortReadDeadlineMs` in `link-budget.ts`: 7 s at the default declared link, 5 s before it
 * was derived, 1 s at Optimystic's own default), so it still gets one retry inside this budget
 * where it once got two; an attempt that runs into the 10 s
 * `ClusterClient` response deadline still gets none. See `docs/cadre-consistency.md` →
 * "Deadlines Over Optimystic's Reads and Commits".
 *
 * NOTE: a failed commit attempt now also pays a cancel discharge before its error returns
 * (optimystic `TransactorSource.transact`'s catch, added by upstream
 * `1-a-failed-attempt-must-discharge-its-own-pend`) — bounded by six rounds and
 * `abortOrCancelTimeoutMs`, which every collection this repo opens sets to 5 s
 * (`../optimystic/packages/quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts`).
 * Two failed attempts whose cancels each run their full budget would consume this whole 10 s
 * ceiling and cut the three-attempt policy to two. Not observed — every measured round of the
 * transient-reset case committed on attempt 3 of 3 — so this is a condition to watch, not work
 * to do: if that case ever starts failing with `failed after 2/3 attempt(s)`, the cancel
 * discharge is where the time went.
 */
export declare const CONTROL_WRITE_RETRY_BUDGET_MS = 10000;
/**
 * Is this a transactor aggregate from a phase where nothing can have committed yet?
 *
 * The transactor raises `Some peers did not complete:` from three sites
 * (`db-core/src/transactor/network-transactor.ts`), and only two of them are safe to
 * re-present:
 *
 * - `get` (a block read, which a write body also performs) and `pend` (phase 1) fail before
 *   anything commits, so the write is known not to have landed;
 * - `commitBlocks` (phase 2) is REACHABLE here and NOT safe. `commitBlock` throws the
 *   aggregate when a header/tail commit got NO response at all — precisely the transient
 *   class this retry targets — and that escapes `commit()`, survives `TransactorSource`'s
 *   cancel-and-rethrow (cancel reaches PENDING actions only; a peer that already committed
 *   stays committed) and `Collection.syncInternal` (which retries StaleFailure RETURN values,
 *   not throws), reaching this funnel QuereusError-wrapped. The tail commit is one batch to
 *   one coordinator running consensus internally, so a no-response there is INDETERMINATE:
 *   the commit may have completed with only the response lost. Re-running the write body over
 *   a write that landed turns a success into a constraint failure (e.g.
 *   `UNIQUE constraint failed: CadrePeer.PeerId`). Surfacing the transient error instead lets
 *   the caller re-read committed state and decide. Commit-phase messages are vetoed by
 *   {@link reportsIndeterminateCommit}, not here.
 *
 * The `cause` chain does not discriminate the phases — a commit-phase aggregate carries the
 * same stream-reset/dial error a pend-phase one does. The per-batch DETAIL text does: `get`
 * and `pend` format `<peerId>[block:<id>](<status>)`, `commitBlocks` formats
 * `<peerId>[blocks:<count>](<status>)`. `[block:` cannot occur inside `[blocks:`, so the two
 * tokens are disjoint and separate the phases.
 *
 * NOTE: the discriminator is a formatting detail of another repo. If Optimystic ever reformats
 * those per-batch details, this fails CLOSED — the aggregate stops matching and control writes
 * simply stop being retried, silently losing the absorption rather than doing anything unsafe.
 * The guard against that is live: `control-write-degraded-cohort-member.integration.ts` asserts
 * this classifier against the real degraded-cohort failure object and asserts the `[block:`
 * token on the live aggregate; if it reddens there, an upstream reformat is the first thing to
 * check.
 *
 * NOTE: the discriminator is the prefix AND the token within ONE message — never relax it to
 * "contains `[block:`". Beyond the `get` and `pend` sites above, Optimystic renders `[block:` in
 * one further place — a third formatter, outside the aggregate's three sites — `dischargeCancel`
 * (`Cancel of action <id> did not discharge <n> block(s): …`), which does not raise the
 * `Some peers did not complete:` prefix; only the conjunction keeps a cancel fault from
 * classifying as a retriable get/pend (checked against optimystic `c56c2bd4`, 2026-09-16).
 *
 * NOTE: accepted tradeoff — a REJECTION raised while promises are still being collected reaches
 * this repo wrapped in this same aggregate, and this matcher claims it on the wrapper alone,
 * whatever the cause inside says. That re-presents such a rejection up to two more times inside
 * the 10 s budget. Kept deliberately, and re-decided on 2026-09-17 against the current upstream
 * behaviour rather than inherited:
 *
 *  - Contention is no longer a rejection at all. "Another write holds this block right now"
 *    (`pending conflict`) is now a `held` verdict that counts toward neither approvals nor
 *    rejections (`validatePendOperations`,
 *    `../optimystic/packages/db-p2p/src/cluster/cluster-repo.ts`), so the rejection this tradeoff
 *    was originally written about does not arrive any more. It reaches this funnel as
 *    `SyncRetryExhaustedError` instead, which {@link reportsPossiblyStoredWrite} declines by type
 *    — upstream documents resubmitting after it as unsafe (the attempt that spent the budget may
 *    have left its log entry standing), and its collection sync has already spent ten retries on
 *    the race. The torn-write rule beside it: a `TornActionError` is re-presented only when
 *    `final` is true; any other torn write is declined.
 *  - What remains rejectable at the promise phase is stale revision, block-unavailable,
 *    membership-not-admitted, and a configured validator's refusal. Only the first is worth a
 *    retry — and it is worth one: this loop re-runs the WHOLE write body, reads included
 *    (`ControlDatabase.withWriteLock`'s contract), so attempt 2 presents a pend against the
 *    revision that made attempt 1 stale. A blanket "decline any chain reporting a validator
 *    rejection" rule would remove that retry to save two wasted attempts on the other three.
 *
 * Revisit if a re-presentation ever becomes expensive relative to what it buys — a rejection class
 * that costs a full cohort round-trip to re-present, or a write body whose reads are no longer
 * cheap — or when upstream offers a typed refusal surface to classify on instead of this text
 * (`../optimystic/tickets/backlog/debt-a-downstream-repo-classifies-retries-by-parsing-our-error-text`).
 * Contention is no longer the reason to revisit.
 *
 * An aggregate whose details came out EMPTY (possible when `formatBatchStatuses` has no
 * batches to format) carries neither token, matches nothing here, and is not retried — an
 * unattributable failure is not a proven non-commit.
 *
 * Exported for the READ classifier (`control-read-retry.ts`), which reuses it verbatim: a
 * `get` batch formats the same single-block `[block:` token, and a read can never produce
 * the commit-phase `[blocks:` shape at all.
 */
export declare function isUncommittedTransactorAggregate(message: string): boolean;
/**
 * Did this control write fail because the cluster cohort did not ANSWER — i.e. is
 * re-presenting the SAME signed write a moment later the right response?
 *
 * Classifies the transient cases by MESSAGE, walking the `cause` chain with the shared
 * {@link chainMessages} (Quereus' own `unwrapError` underneath) — the transactor and the
 * coordinator both throw bare `Error`s, not recognisable by type. By the time one reaches
 * `ControlDatabase` it is wrapped in a `QuereusError` (the real chain is `QuereusError` → `Error`
 * → `Error`), so the match must work at any depth. Anything that is not an `Error` is never
 * retried.
 *
 * Two vetoes run over the whole chain before any matcher: {@link reportsPossiblyStoredWrite}
 * (by type — a spent sync budget, a non-final torn write, a partial commit) and
 * {@link reportsIndeterminateCommit} (by text — a commit-phase batch). A chain either veto flags,
 * at any level, is never retried on the strength of some other level looking transient. The one
 * typed failure claimed as retriable is a final torn write ({@link isFinalTornWrite}).
 *
 * NOTE: this depends on engine/transactor error TEXT. The messages producible without a
 * network are driven from the REAL engine in `control-formation-seat-budget.spec.ts`, so
 * a rewording reddens a spec rather than silently disabling the retry. The two RETRIABLE
 * messages need a real multi-node cluster to produce; the degraded-cohort scenario
 * (`control-write-degraded-cohort-member.integration.ts`) asserts this classifier against
 * both LIVE — the super-majority shortfall from a real silent member, and the transactor
 * aggregate from a real stream reset, which the retry there absorbs end to end.
 */
export declare function isRetriableControlWriteFailure(error: unknown): boolean;
/**
 * {@link isRetriableControlWriteFailure} widened by exactly one class — the self-coordination
 * grace refusal ({@link RETRIABLE_SCHEMA_INIT_MATCHERS}) — for `ControlDatabase.loadSchema`.
 *
 * Opt-in per call site, via {@link SCHEMA_INIT_RETRY_POLICY}. Every other control write keeps the
 * default classifier untouched.
 */
export declare function isRetriableSchemaInitFailure(error: unknown): boolean;
/**
 * Policy and pacing overrides for {@link retryControlWrite}. Production callers pass nothing
 * (or a named policy such as {@link SCHEMA_INIT_RETRY_POLICY}); specs inject a recorded
 * `sleep`, a shorter delay list, or a fake clock so no test ever waits out a real backoff.
 *
 * Every field defaults to the shipped control-write policy ({@link CONTROL_WRITE_ATTEMPTS},
 * {@link CONTROL_WRITE_RETRY_DELAYS_MS}, {@link isRetriableControlWriteFailure}), so an
 * omitted field is byte-identical to the behaviour before per-call-site policies existed.
 * The field shapes and semantics live on the shared {@link ControlRetryOptions}.
 */
export type ControlWriteRetryOptions = ControlRetryOptions;
/**
 * The one non-default retry policy: `ControlDatabase.loadSchema`'s distributed DDL, which
 * additionally absorbs optimystic's self-coordination grace refusal and gets more attempts over a
 * longer backoff to do it (see {@link SCHEMA_INIT_ATTEMPTS} and
 * {@link SCHEMA_INIT_RETRY_DELAYS_MS}). Still bounded by the shared
 * {@link CONTROL_WRITE_RETRY_BUDGET_MS}.
 *
 * NOTE: exactly one call site opts in today, and the re-run safety this policy assumes is that
 * site's, not a general property — `apply schema` is a diff, and a failed apply is unwound whole
 * and verified against the pre-apply catalog (full argument at the `loadSchema` call site in
 * `control-database.ts`). A second opt-in must re-derive that argument for its own write body
 * first; if this policy ever grows a third consumer, rename it for what the callers share rather
 * than widening it by default.
 */
export declare const SCHEMA_INIT_RETRY_POLICY: Readonly<ControlWriteRetryOptions>;
/**
 * Run `attempt` up to {@link CONTROL_WRITE_ATTEMPTS} times (or `options.attempts`), retrying only
 * failures the policy's classifier — {@link isRetriableControlWriteFailure} by default —
 * calls transient, and only while {@link CONTROL_WRITE_RETRY_BUDGET_MS} has not elapsed.
 *
 * `attempt` must be atomic and re-runnable: a failed cluster write rolls back (nothing is
 * half-applied), and re-running the body re-runs its reads too — `ControlDatabase`'s
 * locked write bodies all satisfy this (see the contract on
 * `ControlDatabase.withWriteLock`). The backoff sleeps happen with NO lock held; the caller
 * takes and releases its lock inside `attempt`.
 *
 * On exhaustion (attempts or budget) the LAST error is rethrown unchanged — never wrapped,
 * so the exact messages downstream code and the degraded-cohort-member scenario assert on
 * survive. A non-retriable failure propagates from the attempt that raised it.
 *
 * Either way — declined or exhausted — an `options.onAbandon` observer is notified exactly
 * once before the rethrow (a `ControlRetryAbandonment`). Only WRITES pass one: an abandoned
 * read throws to a caller that is awaiting it, so nothing is lost silently there
 * (`control-read-retry.ts` says so at its own seam), while an abandoned write may have no
 * caller at all — a background self-record republish is `void`-ed with a `debug` catch, so
 * its failure reaches nobody unless something is listening here.
 * `ControlDatabase.setControlWriteAbandonedListener` is the only thing that passes one in
 * production; `retryControlWrite` itself neither supplies nor requires an observer.
 */
export declare function retryControlWrite<T>(attempt: () => Promise<T>, options?: ControlWriteRetryOptions): Promise<T>;
