import type { DurableSlot } from './node-local-snapshot.js';
export interface EnrolledMachineStore {
    /** Party this store is scoped to. */
    readonly partyId: string;
    /**
     * Machines last recorded for this party, or `undefined` when nothing usable was
     * ever recorded — a brand-new node, or a slot that could not be read. Callers
     * pass this straight to `controlClusterPolicy`, whose `undefined` branch returns
     * the frozen base policy unchanged, so "this node does not know" and "this node
     * has never run" are the same declaration: none.
     */
    count(): number | undefined;
    /**
     * Record the current count. Reflected by {@link count} SYNCHRONOUSLY; the
     * returned promise resolves once the persist attempt has settled.
     *
     * **Never rejects.** Its sole caller is
     * `CadreNode.refreshAuthorizedControlPeers`, whose contract is never-rejects and
     * which leaves the promise un-awaited (`void`) — so a rejection here would
     * surface as an unhandled rejection in the embedder's process, over a hint that
     * re-lands on the next refresh anyway. A failed persist is LOGGED, and the
     * in-memory count stays correct for this session.
     *
     * A count that is not a positive integer is a caller bug: it is logged and
     * IGNORED rather than persisted, so a degenerate value can never reach the slot
     * and be read back as a declaration nobody chose.
     */
    record(count: number): Promise<void>;
}
/**
 * Ephemeral in-memory store — the default when no store is injected via
 * `CadreNodeConfig.enrolledMachines`. A node using this cold-starts on every
 * launch: `count()` is `undefined` at `start()`, so its control node declares
 * nothing and runs at today's behaviour, exactly as before this record existed.
 */
export declare class MemoryEnrolledMachineStore implements EnrolledMachineStore {
    readonly partyId: string;
    private current;
    constructor(partyId: string);
    count(): number | undefined;
    record(count: number): Promise<void>;
}
/**
 * Durable {@link EnrolledMachineStore} over an app-supplied {@link DurableSlot} —
 * the cross-platform half of every persistent backend (the Node
 * `FileEnrolledMachineStore` is this class over a file slot).
 *
 * Construct via {@link open}. Load policy is the module comment's: every failure
 * mode cold-starts, and `open` never rejects.
 */
export declare class PersistentEnrolledMachineStore implements EnrolledMachineStore {
    private readonly slot;
    readonly partyId: string;
    /** Serialises persists so the last count recorded is the last one written. */
    private writeChain;
    /** Last count accepted, whether or not it has reached the slot yet. */
    private current;
    /** Last count believed to BE in the slot; drives the unchanged-write skip. */
    private persisted;
    private constructor();
    /** Load (or cold-start) the party's last recorded machine count from `slot`. */
    static open(slot: DurableSlot, partyId: string): Promise<PersistentEnrolledMachineStore>;
    count(): number | undefined;
    /**
     * Record the count: visible via {@link count} synchronously, then persisted.
     *
     * Writes are SKIPPED when the slot already holds this number, because the sole
     * caller runs on every committed membership write *and* every timed reconcile
     * pass — a party whose membership is stable would otherwise rewrite the same
     * integer forever. The skip is keyed off {@link persisted} rather than
     * {@link current}, so a write that FAILED is retried by the next refresh instead
     * of being suppressed as "unchanged".
     */
    record(count: number): Promise<void>;
    /**
     * Write whatever {@link current} holds when this link of the chain runs — so a
     * burst of records collapses into one write of the latest value — and never
     * throw (see {@link EnrolledMachineStore.record}).
     */
    private persistCurrent;
}
