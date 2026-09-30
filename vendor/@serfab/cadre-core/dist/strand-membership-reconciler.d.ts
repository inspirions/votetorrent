/**
 * Strand membership reconciliation: the per-instance background loop that finishes a
 * party's join at strand bring-up. Every machine of a party that runs a closed strand
 * ends up with (1) the party's `Strand.Member` row seated — redeeming the
 * formation-staged invitation if one is pending — and (2) its own durable
 * machine→party binding (`Strand.MemberPeer`) written, which is what revocation
 * enforcement and future admission control key on.
 *
 * ## Contract
 *
 * - **Never blocks or fails bring-up.** Armed by `StrandInstanceManager.buildStrandRuntime`
 *   right after the strand database initializes (launch AND hibernation resume — the one
 *   seam where a transport peer id and a live `Database` both exist), and every pass is
 *   fully contained: a joiner at that instant has typically not synced the founder's rows
 *   and may lack write quorum, so failure means "retry next tick", never a throw.
 * - **Kicked the moment its database appears.** A joining machine's first pass runs while
 *   the first-sync write gate still withholds `instance.database`, so it finds no database
 *   and returns at once. `StrandInstanceManager.publishDatabase` calls `reconcile()` as it
 *   hands the database to the app, which is what makes the join finish about a second after
 *   the strand becomes writable rather than on the next timer.
 * - **Retries fast while the join is unfinished, slowly while it is only waiting.** A pass
 *   that leaves the join unfinished re-arms on a ladder starting at
 *   {@link INITIAL_JOIN_RETRY_INTERVAL_MS} and doubling, capped at the configured poll
 *   interval (default {@link DEFAULT_REVOCATION_POLL_INTERVAL_MS}; an embedder's
 *   `revocationEnforcement.pollIntervalMs` is mirrored here by the instance manager). A pass
 *   that finds no member row AND no staged invitation is not an unfinished join but a wait
 *   for someone to admit this party — nothing this machine can do faster — so it re-arms on
 *   the flat poll interval and resets the ladder. The loop stops on the done state.
 * - **Done state**: the party's member row is visible locally, this machine's own binding
 *   is in place, AND no invitation is still staged — the loop stops. A LATER revocation is
 *   the enforcer's business, not this loop's; a resume rebuilds the reconciler and
 *   re-verifies from scratch (every write is idempotent, so re-running is free), and a
 *   fresh invitation staged on a done loop re-arms it in place ({@link rearm}).
 *
 * ## One pass
 *
 * 1. **Self-revocation check.** If the enforcer flags this node's own party as revoked and
 *    no invitation is staged, stop rather than fight — re-admission arrives (if ever) via
 *    a fresh formation, which re-arms the loop. With an invitation staged the loop reports
 *    the dead end (below) and carries on: the redemption is attempted like any other, and a
 *    manager's re-admission lets a later pass finish it.
 * 2. **Ensure membership.** Member row visible → done with this step; if a staged
 *    invitation is still unspent, BURN it ({@link burnInvite} — the `ConsumedInvite` row
 *    alone) so the bearer credential cannot be spent by anyone else. A burn refused by the
 *    cohort keeps the invitation staged for the next pass (it is the same write gate a
 *    redemption faces, and the local member row may be stale — see "Re-arming"); a dead
 *    invitation is dropped. Member row absent + staged invitation → {@link consumeInvite}
 *    under the party's own key, retried across passes until the `Invite` row has
 *    replicated here and the write commits. Absent with no invitation (founder rows not
 *    yet synced, or a machine whose party never joined) → keep waiting, escalating to one
 *    visible warning after {@link IDLE_PASSES_BEFORE_ESCALATION} passes, never throwing.
 * 3. **Ensure the binding.** {@link registerMemberPeer} (insert-if-absent, restart-safe)
 *    with this node's own strand transport peer id — only after step 2 sees the member
 *    row locally (its deferred `MemberExists` reads the live local table). Done only once
 *    the binding is in place AND nothing is staged; a binding written while a burn keeps
 *    being refused leaves the loop live to settle the invitation later.
 *
 * ## Stops, and re-arming
 *
 * Two kinds of stop. A RE-ARMABLE stop is one a fresh invitation should reopen:
 *
 * - **Done** (above).
 * - **Self-revoked with nothing staged** (step 1 above).
 *
 * A PERMANENT stop is one a fresh invitation changes nothing about — {@link rearm} is a
 * no-op after it:
 *
 * - **Sealed strand**: `consumeInvite` rejected by `ConsumedInvite.NotSealed` — nobody
 *   can ever be admitted, so retrying forever is noise. Terminal-with-log.
 * - **Undecodable party key**: nothing can be signed; loud log, stop.
 * - **The public {@link stop}**: `StrandInstanceManager.releaseRuntime` and
 *   `clearOwnMemberPeerBinding` both call it and mean it — the latter stops the loop and
 *   awaits {@link settle} precisely so no pass can re-register the binding it is about to
 *   delete, and a re-arm that restarted the loop would undo that.
 *
 * `CadreNode.adoptFormationMembershipInvite` stages every fresh invitation and notifies
 * the instance manager, which calls {@link rearm}: a done loop reopens and runs one pass
 * at once; a running loop is merely kicked. This is what lets a party that was REMOVED
 * from the strand, and then handed a new invitation, actually attempt it — the loop
 * finished during its first join, long before the removal.
 *
 * On a removed party the local replica is usually stale: the cohort cut this machine off
 * at about the moment the removal was written, so `isStrandMember` still answers true and
 * a re-armed pass lands in the already-member arm. That is why the burn arm keeps a
 * refused invitation staged and why the done state requires nothing staged — otherwise
 * the fresh credential would be dropped on the first refused burn and the loop would latch
 * done again, with the only trace a debug line.
 *
 * A DEAD invitation that is not terminal for the loop — expired, cancelled, or already
 * consumed by someone else (`ConsumedInvite`'s primary key) — is dropped with a log and
 * the loop keeps idling: a fresh formation stages a new invitation, and a manager-side
 * admission (`addMemberByManager`) seats the member row without one.
 *
 * ## Reporting a blocked re-join
 *
 * Redeeming (or burning) writes into the strand, and the machines that would carry that
 * write are exactly the ones the remaining members refuse once this party is removed. So
 * the attempt is expected to fail, and the failure is REPORTED rather than left to the
 * ladder: one `console.warn` plus the {@link StrandMembershipReconcilerDeps.onRejoinBlocked}
 * callback (`CadreNode`'s `strand:rejoin-blocked` event), at most once per re-arm cycle.
 * Two triggers:
 *
 * - **Confirmed** — a pass finds this party self-revoked AND an invitation staged. The node
 *   knows it was removed and is holding a credential it cannot spend.
 * - **Probable** — {@link UNFINISHED_PASSES_BEFORE_ESCALATION} consecutive attempted passes
 *   left the invitation staged. The case that matters most in the field: a removed party
 *   that never learned it was removed (the removal did not replicate here before the cut).
 *   It is a suspicion, not a verdict — the invitation's `Invite` row may simply not have
 *   replicated here yet — and the warning names both causes.
 *
 * The remedy in either case is a remaining manager admitting this party's member key
 * directly (`addMemberByManager`): that lifts the refusal, replication resumes, and the
 * still-running loop sees the member row, burns the leftover credential and finishes by
 * itself.
 *
 * ## Sharing the database with the app
 *
 * The strand `Database` this loop writes to is the one the app holds. Every write here
 * passes `joinOpenTransaction: false`, so it runs as a transaction of its own and never
 * joins one the app has open: the writer refuses with `StrandTransactionBusyError`, having
 * written nothing, and the pass retries on the ladder. A busy refusal is never read as a
 * dead invitation, and a busy burn leaves the invitation staged for the next pass.
 *
 * ## Half-committed join
 *
 * On a networked strand optimystic commits `Member` and `ConsumedInvite` as separate
 * collections and can report that only some of them were saved (`CoordinatorPartialCommitError`,
 * or the plugin's legacy `PartialCommitError`). When `ConsumedInvite` is saved and `Member` is
 * not, the invitation is spent and the schema seats a `Member` through an invitation only in the
 * same transaction as a fresh consumption, so this loop can never seat the party from it. Such a
 * failure is recognised by TYPE before any message text is read (its message names the
 * `ConsumedInvite` collection, which a text match once mistook for a dead invitation), reported
 * with ONE `console.warn`, and the invitation is dropped. The loop keeps running like it does
 * after a dead invitation: a manager admission, or a `Member` row that did land, is picked up by
 * the next pass, which then writes the binding. Whether sereus should repair such a join itself
 * is `blocked/strand-half-committed-join-recovery`.
 */
import type { Database } from '@quereus/quereus';
import type { StrandMembershipInvite } from './types.js';
import { type TimeoutScheduler } from './timeout-scheduler.js';
/**
 * Idle passes (no member row, no staged invitation) before ONE `console.warn`
 * escalation — at the default 30 s cadence, about five minutes of waiting. The loop
 * keeps retrying quietly after it; the warning exists so a joiner stuck waiting on
 * founder-row replication is visible without the debug namespace enabled.
 */
export declare const IDLE_PASSES_BEFORE_ESCALATION = 10;
/**
 * Consecutive passes that ran against a live database and ended with the staged
 * invitation still unsettled — whatever refused it — before the loop reports a probable
 * blocked re-join (see "Reporting a blocked re-join" in the module doc). The same order
 * as {@link IDLE_PASSES_BEFORE_ESCALATION}: about three minutes at the default cadence
 * (the ladder's five doubling rungs, then five passes at the 30 s cap). Counted by outcome
 * rather than by classified failure because a cut-off machine can fail before any write is
 * classified: its membership READ may already throw.
 */
export declare const UNFINISHED_PASSES_BEFORE_ESCALATION = 10;
/**
 * First retry delay, ms, for a pass that left the join UNFINISHED — a `consumeInvite`
 * whose `Strand.Invite` row has not replicated to this machine yet, a cohort briefly
 * unwritable, a database not yet published. Doubles per such pass up to the configured
 * poll interval. Sized for what it retries: invite-row replication resolves in about a
 * second over a direct connection and a few over a relay. The poll interval is NOT sized
 * for that — it is the revocation enforcer's deny-set refresh cadence, mirrored here for
 * the idle case (waiting to be admitted at all), which is why this ladder exists instead
 * of a shorter interval.
 */
export declare const INITIAL_JOIN_RETRY_INTERVAL_MS = 1000;
/**
 * A redemption only part of which was saved: the collections (or, on the plugin's legacy
 * path, tree labels) that were saved and those that were not, as the error reports them.
 */
export interface HalfCommittedJoin {
    kind: 'half-committed';
    saved: readonly string[];
    unsaved: readonly string[];
}
/** Where {@link classifyConsumeFailure} routes a failed `consumeInvite` or `burnInvite`. */
export type ConsumeFailure = HalfCommittedJoin
/** The app had a transaction open, so nothing was tried — keep the invitation, retry. */
 | {
    kind: 'busy';
}
/** The strand is sealed — terminal for a non-member; a member's leftover invitation is merely dead. */
 | {
    kind: 'sealed';
}
/** Expired, cancelled, or consumed by someone else — drop the invitation, keep waiting. */
 | {
    kind: 'dead-invite';
}
/**
 * Anything else — the `Invite` row has not replicated here yet, or the cohort refused the
 * write (a removed party's machines are denied) — keep the invitation, retry.
 */
 | {
    kind: 'retry';
};
/**
 * Route a `consumeInvite` or `burnInvite` rejection. Both write the `Strand.ConsumedInvite`
 * row under the same `NotExpired` / `NotCancelled` / `NotSealed` / primary-key constraints
 * (a burn writes that row alone), so one classifier serves both. Typed checks run before any
 * text check: a busy refusal (another transaction was open, so nothing ran) and a
 * half-committed join are recognised by their error's type anywhere in the `cause` chain.
 * The busy refusal carries Quereus's own refusal as its cause, and a half-committed join's
 * message embeds collection names and the underlying failure's text, either of which a text
 * matcher can misread. The sealed and dead-invitation checks then read the top-level message.
 *
 * A second loaded copy of `@optimystic/db-core` (or of the plugin) would fail `instanceof`; the
 * half-commit then falls through the anchored texts to `retry`, and once the saved `ConsumedInvite`
 * row is visible here a later attempt fails on its primary key and drops the invitation quietly —
 * the old silent outcome, a few passes later, never a wrong write.
 */
export declare function classifyConsumeFailure(error: unknown): ConsumeFailure;
/**
 * The staged formation invitation seam — `CadreNode`'s in-memory
 * `pendingMembershipInvites` cache, scoped to one strand. Read lazily per pass (a
 * re-formation may replace the entry between passes) and cleared by the reconciler once
 * the invitation is spent, burned, or dead — the invalidation half the cache itself
 * deliberately does not own.
 */
export interface PendingMembershipInviteSource {
    /** The staged invitation, or `undefined` when none is pending for this strand. */
    get(): StrandMembershipInvite | undefined;
    /**
     * Drop `settled` (spent, burned, or dead) — only if it is still the staged one. A
     * re-formation can replace the entry between a pass's {@link get} and this call, and
     * the fresh invitation it staged must survive the older one being settled.
     */
    clear(settled: StrandMembershipInvite): void;
}
export interface StrandMembershipReconcilerDeps {
    /** Log tag naming which strand this reconciler serves (the strand id). */
    label: string;
    /**
     * THIS party's own strand membership private key (base64 protobuf, the control-layer
     * `StrandPartyKey` row's content). Decoded LAZILY on the first pass, so a malformed
     * key stops the loop with a log instead of failing bring-up.
     */
    partyMemberPrivateKey: string;
    /**
     * The live strand `Database`, read per pass, never captured — the instance's handle
     * is dropped on quiesce, and `undefined` means "no live database this instant" (the
     * pass simply waits for the next tick).
     */
    getDatabase: () => Database | undefined;
    /**
     * This node's own strand transport peer id — the `MemberPeer.PeerId` to bind. Read
     * per pass for the same lifecycle reason as {@link getDatabase}.
     */
    getOwnPeerId: () => string | undefined;
    /** The staged invitation seam. Absent for flows with no invitation (e.g. tests). */
    pendingInvite?: PendingMembershipInviteSource;
    /**
     * Whether the revocation enforcer currently flags THIS node's own party as revoked.
     * When it does and nothing is staged, the loop stops rather than fight the enforcer;
     * with an invitation staged it reports the blocked re-join and keeps trying — see the
     * module doc. Absent (enforcement disarmed) means "not known revoked".
     */
    isSelfRevoked?: () => boolean;
    /**
     * Called when the loop reports a blocked re-join (see "Reporting a blocked re-join" in
     * the module doc) — at most once per re-arm cycle, after the `console.warn`. `CadreNode`
     * wires it to its `strand:rejoin-blocked` event.
     */
    onRejoinBlocked?: () => void;
    /**
     * Timer seam for the retry ladder; omit for real (unref'd) timeouts. Timeouts rather
     * than the enforcer's repeating interval because the delay changes per pass and the next
     * pass is armed only once the previous one settles, so a slow pass never stacks ticks
     * behind it — the same seam the first-sync gate's probe loop uses.
     */
    scheduler?: TimeoutScheduler;
}
/** Embedder-facing tuning, threaded by `StrandInstanceManager`. */
export interface StrandMembershipReconciliationConfig {
    /**
     * Default true. False disarms the loop entirely — meant for test fixtures that
     * hand-drive the membership writers and assert exact row sets; a production
     * node that disarms it never seats a joiner's member row or binds its machines.
     */
    enabled?: boolean;
    /**
     * Idle cadence, ms — how often the loop re-checks while nobody has admitted this party
     * yet — and the CAP of the unfinished-join retry ladder. When omitted the instance
     * manager mirrors the revocation enforcer's configured cadence; default
     * {@link DEFAULT_REVOCATION_POLL_INTERVAL_MS}.
     */
    pollIntervalMs?: number;
}
/**
 * The per-strand membership reconciliation loop. Lifecycle mirrors
 * `StrandRevocationEnforcer`: created in `StrandInstanceManager.buildStrandRuntime`
 * (closed strands with a party key only), started right after the strand database
 * initializes, stopped and dropped in `releaseRuntime` — so quiesce → resume rebuilds
 * it and re-runs the (idempotent) ladder from scratch.
 */
export declare class StrandMembershipReconciler {
    private readonly deps;
    private readonly scheduler;
    private readonly pollIntervalMs;
    /** Tail of the pass chain — serializes passes (no two in flight). */
    private tail;
    private timer;
    private started;
    private stoppedFlag;
    /**
     * Whether the last stop was one {@link rearm} may not undo — see "Stops, and re-arming"
     * in the module doc. Latched by the public {@link stop} and the permanent terminal
     * states, never cleared.
     */
    private permanentlyStopped;
    private doneFlag;
    /** Lazily decoded party keypair — see {@link StrandMembershipReconcilerDeps.partyMemberPrivateKey}. */
    private keyPair;
    private idlePasses;
    private idleEscalated;
    /** Consecutive attempted passes that left the invitation staged — see {@link UNFINISHED_PASSES_BEFORE_ESCALATION}. */
    private unfinishedPasses;
    /** Whether the blocked re-join was already reported this re-arm cycle (one report, either trigger). */
    private rejoinBlockedReported;
    /**
     * Whether the pass that just ran found nothing to act on — no member row and no staged
     * invitation. That is a wait to be admitted, not an unfinished join, so it re-arms on the
     * flat poll interval; every other unfinished outcome climbs the ladder.
     *
     * NOTE: the ladder is therefore the DEFAULT for any outcome nobody classified — a new
     * early return added to {@link doPass} inherits the fast retry unless it calls
     * {@link noteIdlePass}. Right for every outcome that exists today (each is an unfinished
     * join this machine can make progress on). If an early return is ever added for a
     * condition retrying cannot resolve, classify it idle.
     */
    private lastPassIdle;
    /** Current rung of the unfinished-join retry ladder, ms; unset before the first retry. */
    private retryDelayMs;
    constructor(deps: StrandMembershipReconcilerDeps, config?: StrandMembershipReconciliationConfig);
    /**
     * True once member row + own binding were both confirmed with nothing staged and the
     * loop stopped. Cleared again by {@link rearm}.
     */
    get done(): boolean;
    /** True while the loop is stopped — done, terminal, or externally stopped. */
    get stopped(): boolean;
    /**
     * Kick an immediate pass (not awaited — bring-up never blocks on it). Every later pass
     * is armed only once the previous one settles — see the retry ladder in the module doc —
     * so there is no repeating interval to arm here.
     */
    start(): void;
    /**
     * Resolve once no pass is in flight. {@link stop} only disarms the retry TIMER — a pass
     * already past its stopped check runs to completion, so a caller that must know the
     * loop can no longer write (`StrandInstanceManager.clearOwnMemberPeerBinding`, which
     * would otherwise have its removal undone by a racing `registerMemberPeer`) awaits
     * this after stopping. Never rejects: the pass chain contains every failure.
     */
    settle(): Promise<void>;
    /**
     * Disarm the retry timer, for good: a later {@link rearm} is refused. A pass already in
     * flight completes but writes idempotently — {@link settle} is what waits it out.
     */
    stop(): void;
    /**
     * A fresh invitation was staged: reopen a loop that stopped on a re-armable state (done,
     * or self-revoked with nothing staged) and run one pass at once; merely kick a loop that
     * is still running; do nothing after a permanent stop. Never rejects, and serialized
     * like {@link reconcile}: the reopen happens when the queued pass STARTS, after any pass
     * in flight has settled, so a `done` that pass latches cannot swallow the re-arm — and a
     * public {@link stop} that lands first still wins, because the queued pass re-checks it.
     */
    rearm(): Promise<void>;
    /**
     * Run one pass now. Never rejects. Serialized: concurrent calls chain, so no two
     * passes overlap and each explicit call gets a pass that STARTS after the call. On a
     * started loop the pass re-arms the retry timer where it settles, so an explicit call —
     * `StrandInstanceManager.publishDatabase`'s kick when a joiner's database is finally
     * published — REPLACES the pending timer rather than running alongside it.
     */
    reconcile(): Promise<void>;
    /** Chain `pass` after every pass already queued; the tail never rejects. */
    private enqueue;
    /**
     * The re-arm itself, run at the head of the queued pass: `false` refuses the pass (a
     * permanent stop), a running loop is left as it is, and a re-armable stop is reopened
     * with the idle and unfinished counters, both escalation latches and the retry ladder
     * reset — a fresh invitation is a fresh cycle.
     */
    private reopen;
    /** One serialized pass; contains every failure (contract: never rejects). */
    private doPass;
    /**
     * Steps 2 and 3 against a live database, with the outcome counted toward the probable
     * blocked re-join report whether the attempt returned or threw.
     */
    private attempt;
    /**
     * Arm the next pass, now that this one has settled — so a slow pass never stacks ticks
     * behind it. Only a STARTED loop schedules: a caller driving {@link reconcile} by hand
     * (the unit tests, and the publish kick on a launch whose `start()` has not run yet) gets
     * exactly the passes it asks for and no background timer.
     */
    private scheduleNext;
    /**
     * The delay before the next pass: the flat poll interval while the loop is merely idling
     * (no member row, no staged invitation — {@link noteIdlePass}), otherwise the next rung
     * of the doubling ladder from {@link INITIAL_JOIN_RETRY_INTERVAL_MS}, capped at the poll
     * interval. A pass that lands idle resets the ladder, so a later unfinished join starts
     * over at the bottom rung.
     */
    private nextDelayMs;
    private clearTimer;
    /**
     * Step 2 of the pass: `true` iff the party's member row is visible locally by the
     * time this returns (already present, or seated by redeeming the staged invitation).
     */
    private ensureMembership;
    /**
     * The already-member arm: spend a still-staged invitation so nobody else can. The stage
     * is cleared once the burn lands or the invitation is known dead (already spent,
     * cancelled, expired, or the strand sealed around a party that is still a member) — with
     * the member row present a dead credential has no further local use, and keeping it
     * staged would leave `getPendingMembershipInvite` lying. A refused burn keeps it staged:
     * a busy refusal tried nothing, and a write the cohort refused is the removed-party shape
     * ("Stops, and re-arming" in the module doc), where the local member row is stale and the
     * credential is the one thing a later manager admission lets this loop settle.
     *
     * NOTE: this REPLACES an earlier accepted tradeoff that never retried a burn which failed
     * for a transient reason and dropped the invitation instead. That decision was made when
     * this arm could only ever see an invitation staged before the first join finished, so a
     * dropped credential cost nothing but a spendable bearer token. {@link rearm} makes the
     * arm reachable with a freshly issued invitation the app wants redeemed, and dropping
     * that one on the first refused write is the silent failure this loop exists to avoid.
     */
    private burnLeftoverInvite;
    /**
     * Act on a `burnInvite` rejection as {@link classifyConsumeFailure} routes it. Unlike a
     * redemption, a sealed strand is not terminal here — the member row is present, so this
     * party is a member of the sealed strand and only its leftover credential is dead — and a
     * half-committed burn (one collection, so a report of it means the commit's durability
     * was in doubt) is retried: the next pass either lands it or fails on the row's primary
     * key, which drops it as dead.
     */
    private handleBurnFailure;
    /**
     * Step 3 of the pass: write this machine's own `MemberPeer` binding (insert-if-absent)
     * and, once it is in place with nothing staged, latch the done state and stop the loop.
     * A missing transport peer id (a quiesce racing the pass) defers to the next tick; a
     * write failure — a busy refusal included — is contained by the pass's outer catch and
     * retried. A binding written while an invitation is still staged (its burn keeps being
     * refused) is not done: the loop stays live so a later pass can settle the credential.
     */
    private ensureBinding;
    /**
     * Act on a `consumeInvite` rejection as {@link classifyConsumeFailure} routes it: busy → keep
     * the invitation and retry; half-committed → warn and drop; sealed → terminal; dead
     * invitation → drop; anything else → retry.
     */
    private handleConsumeFailure;
    /**
     * Count an attempted pass that left the invitation staged (whatever stopped it — a
     * refused or busy write, or a read that threw on a cut-off machine); one that settled
     * it, or finished, ends the streak. At {@link UNFINISHED_PASSES_BEFORE_ESCALATION}
     * report the PROBABLE blocked re-join.
     */
    private noteAttemptOutcome;
    /**
     * Step 1's CONFIRMED trigger: self-revoked with an invitation staged. Reports (once per
     * re-arm cycle) and answers `true` so the pass carries on — the redemption is attempted
     * and refused like any other write, and a manager's re-admission lets a later pass finish.
     * `false` (nothing staged) means step 1 stops the loop as before.
     */
    private stagedInviteBlockedBySelfRevocation;
    /**
     * ONE `console.warn` and one callback per re-arm cycle, whichever trigger fires first —
     * see "Reporting a blocked re-join" in the module doc. `cause` is the trigger's own
     * sentence; the remedy and the loop's posture are the same for both.
     */
    private reportRejoinBlocked;
    /**
     * A redemption only part of which was saved (see "Half-committed join" in the module doc):
     * ONE visible warning naming both halves, and the staged invitation dropped. The pass is not
     * marked idle, so the next one runs a ladder rung later and either finds a `Member` row (a
     * saved one, or a manager's admission) and writes the binding, or idles flat.
     *
     * NOTE: the invitation is dropped whichever half was saved. In the observed shape
     * (`ConsumedInvite` saved, `Member` not) it is spent and a retry could only fail on
     * `ConsumedInvite`'s primary key. In the opposite shape (`Member` saved, `ConsumedInvite` not)
     * keeping it would let the already-member arm burn it; dropping it leaves that bearer
     * credential spendable until it expires — the state the burn arm's accepted tradeoff already
     * lands in. Not branched on, because telling the shapes apart means parsing the lists, which
     * are collection ids on the coordinator path but free-form tree labels on the plugin's legacy
     * path. Revisit if a `Member`-saved half-commit is ever observed, or when
     * `blocked/strand-half-committed-join-recovery` is decided.
     */
    private reportHalfCommittedJoin;
    /** Decode the party key once; an undecodable key is terminal (nothing can be signed). */
    private resolveKeyPair;
    /**
     * Count a no-member/no-invitation pass; escalate to ONE visible warning at the bound.
     *
     * NOTE: an idling loop never gives up — a machine whose party is never admitted keeps
     * polling for the life of the process, one `Strand.Member` scan per strand per
     * interval (30 s by default). Negligible at the handful of strands a device runs and
     * the handful of members a strand has; if a node ever runs strands by the hundred, or
     * a strand's member set grows large, bound the idle phase (give up after N passes and
     * surface it) rather than shortening the interval.
     */
    private noteIdlePass;
    /**
     * Stop with a reason — the terminal and done paths' shared exit. `permanent` says whether
     * a fresh invitation may reopen the loop ("Stops, and re-arming" in the module doc).
     */
    private finish;
    /** Latch the stop and disarm the timer; a permanent latch sticks even on an already-stopped loop. */
    private halt;
}
