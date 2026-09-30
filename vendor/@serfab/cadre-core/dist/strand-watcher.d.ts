import type { StrandFilter, StrandRow } from './types.js';
/**
 * Extended strand row that includes the sAppId for filtering purposes.
 * The sAppId is provided by the hosting application, not from the control network.
 */
export interface StrandRowWithApp extends StrandRow {
    /** sApp ID if known (for filtering) */
    sAppId?: string;
}
/**
 * Callback for strand changes
 */
export interface StrandWatcherCallbacks {
    onStrandAdded: (strand: StrandRow) => Promise<void>;
    onStrandRemoved: (strandId: string) => Promise<void>;
}
/**
 * Interface for querying strands from control network
 */
export interface StrandQueryable {
    queryStrands(): Promise<StrandRow[]>;
}
/**
 * Interface for looking up sAppId for a strand (for filtering)
 */
export interface SAppIdLookup {
    /** Get the sAppId for a strand, if known */
    getSAppId(strandId: string): string | undefined;
}
/**
 * Watches the control network's Strand table for changes and triggers
 * strand instance start/stop via callbacks.
 *
 * Uses polling until Optimystic supports reactive subscriptions.
 */
export declare class StrandWatcher {
    private readonly filter;
    private readonly pollInterval;
    private readonly callbacks;
    private readonly queryable;
    private readonly sAppIdLookup?;
    /**
     * Wall-clock source for the retry backoff. Read fresh at each use rather than
     * snapshotted per poll: a poll awaits `onStrandAdded`, and a launch that fails
     * slowly (e.g. a dial timeout) would otherwise be scheduled off the clock as it
     * read *before* the attempt, putting `nextAttemptAt` in the past. Injectable so
     * tests can advance time deterministically without fake timers.
     */
    private readonly now;
    private knownStrands;
    /** Ids admitted under a `defer` decision; re-evaluated each poll until they resolve. */
    private provisional;
    /** Ids whose last launch attempt threw, with the backoff gating their retry. */
    private failureStates;
    /**
     * Ids a deliberate local stop has withdrawn from offer for the rest of the session
     * (see {@link suppressStrand}). Before {@link forgetStrand} existed, `knownStrands`
     * retention alone made a stop permanent; now that a failed claim can un-know a
     * strand, the permanence has to be recorded explicitly.
     */
    private suppressed;
    private pollTimer;
    private initialPollTimer;
    private running;
    constructor(queryable: StrandQueryable, callbacks: StrandWatcherCallbacks, filter?: StrandFilter, pollInterval?: number, sAppIdLookup?: SAppIdLookup, now?: () => number);
    /**
     * Evaluate a strand against the current filter, distinguishing a not-yet-known
     * sAppId (`defer`) from a known non-match (`reject`). A `defer` admission is
     * provisional and re-checked on subsequent polls.
     */
    private evaluateFilter;
    /**
     * Record a failed launch attempt and schedule when the strand may be retried:
     * `pollInterval * 2^(failures-1)`, capped at {@link MAX_RETRY_BACKOFF_MS}.
     */
    private recordFailure;
    /**
     * Poll for strand changes.
     */
    private poll;
    /**
     * Start watching for strand changes
     */
    start(): Promise<void>;
    /**
     * Stop watching for strand changes
     */
    stop(): Promise<void>;
    /**
     * Forget a strand whose launch failed outside this watcher, so a later poll
     * re-offers it — gated by the same backoff a watcher-driven failure gets.
     *
     * A failed launch normally leaves nothing running (StrandInstanceManager drops the
     * record), which is what makes re-offering it correct. One case does leave something
     * running: a row this machine published lands on an instance something else already
     * attached, and honouring the founder request on it (CadreNode.launchStrand →
     * StrandInstanceManager.foundExistingStrand) throws. The instance stays up as a joiner
     * and the retry re-attempts the bootstrap on it, which is what should happen — but do
     * not read the line above as "nothing is running".
     */
    forgetStrand(strandId: string): void;
    /**
     * Never offer this strand again this session. Two callers, both meaning "the retry
     * ladder cannot help here": a deliberate local stop, and a launch that can never
     * succeed — a strand whose id is unusable as a storage scope key
     * (`CadreNode.handleStrandAdded`), which every later attempt would reject identically.
     * A launch that merely FAILED is not one of them; that goes to {@link forgetStrand}.
     *
     * Cleared when the strand's control row disappears, because a row that reappears is a
     * strand the party re-published and the stop said nothing about it; also cleared by
     * {@link stop}, since sApp configs do not survive it either, and by
     * {@link unsuppressStrand} when the caller claims the strand again.
     */
    suppressStrand(strandId: string): void;
    /**
     * Revoke a {@link suppressStrand}: a deliberate local claim overrides the deliberate
     * local stop that preceded it.
     *
     * Not cosmetic — the suppression check runs before the `knownStrands` one, so a
     * suppressed id is never re-recorded there, and the removed-strand loop iterates
     * `knownStrands`. A strand re-claimed while still suppressed would therefore run with
     * the watcher blind to it: a party-wide removal would never stop it locally. That is
     * reachable whenever the stop found the id already un-known — after a claim that
     * failed, or for a strand the filter never admitted.
     */
    unsuppressStrand(strandId: string): void;
    /**
     * Get currently known strands
     */
    getKnownStrands(): Map<string, StrandRow>;
    /**
     * Force an immediate poll (useful for testing)
     */
    forcePoll(): Promise<void>;
}
