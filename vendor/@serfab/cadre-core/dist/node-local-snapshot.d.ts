/**
 * A single durable text slot, supplied by the embedding app. The only
 * platform-specific part of a persistent node-local store.
 */
export interface DurableSlot {
    /**
     * The slot's persisted text, or `undefined` when it was never written.
     *
     * MUST throw (not return `undefined`) when the slot exists but cannot be
     * read. That distinction is load-bearing: `undefined` means "cold start,
     * nothing was ever here", and callers snapshot-write the whole record, so a
     * failed read reported as `undefined` silently converts a recoverable error
     * (permissions, a blocked database upgrade, an I/O fault) into destruction
     * of a still-intact record on the next save.
     *
     * A slot always reports the fault; what a READER does with it is the
     * reader's policy. The two records here rethrow it; the enrolled-machine
     * count catches it and cold-starts, because losing a repair hint must not
     * stop a node. So an implementation must never soften this to `undefined`
     * on a reader's behalf.
     */
    load(): Promise<string | undefined>;
    /**
     * Durably replace the slot's text. Callers snapshot-write the whole record,
     * so an implementation never needs to merge.
     */
    save(text: string): Promise<void>;
}
/**
 * What one unusable entry means for its siblings — the single intentional
 * difference between the records:
 *
 *  - `'discard-all'` (the trusted-owner anchor): a record that cannot be read
 *    in full is not an anchor. Trusting a *subset* of the keys a file claims is
 *    a silent, security-relevant downgrade, so the whole record is discarded
 *    and the node trusts no one until re-seeded out of band.
 *  - `'drop-entry'` (the bootstrap-peer store and the strand peer book): the
 *    record is a best-effort dial list and nothing in it is trust-bearing, so one
 *    junk entry must not discard a stranded node's only remaining way back to
 *    its party or its strand's peers.
 */
export type UnusableEntryPolicy = 'discard-all' | 'drop-entry';
/** What a particular node-local record persists, and how it validates it. */
export interface NodeLocalSnapshotSpec<E> {
    /** Human name of the record, used in load errors and logs. */
    readonly label: string;
    /** Envelope property holding the `key -> entry` record (`owners`, `peers`). */
    readonly payloadKey: string;
    /** See {@link UnusableEntryPolicy}. */
    readonly unusableEntry: UnusableEntryPolicy;
    /**
     * Validate one persisted entry, returning the value to hold in memory
     * (copied, so later mutation of the parsed JSON cannot reach it) or
     * `undefined` when the entry is unusable.
     */
    readonly acceptEntry: (key: string, entry: unknown) => E | undefined;
}
/**
 * A loaded node-local record over a {@link DurableSlot}: an in-memory
 * `key -> entry` map plus a serialised full-snapshot write chain.
 *
 * NOTE: writes are serialised in-process only. Two processes (or two browser
 * tabs) sharing ONE slot for ONE party would each snapshot-write their own
 * view, so the loser's entries are dropped. Fine for every backend today —
 * each node gets its own directory / origin database — but a single slot
 * backing two concurrent nodes of one party needs a lock or a merge-on-write,
 * not a snapshot replace.
 */
export declare class NodeLocalSnapshot<E> {
    private readonly slot;
    readonly partyId: string;
    private readonly spec;
    private readonly entries;
    /**
     * Serialises persists: every write ({@link put}, {@link remove}) snapshot-writes
     * the full entry set, so chaining writes keeps them ordered and the last landed
     * snapshot complete.
     */
    private writeChain;
    private constructor();
    /**
     * Load (or cold-start) the party's record from `slot`. Failure policy, per
     * the trust model of the anchor this was first written for: only a real,
     * well-formed, matching-party record yields entries.
     *
     * A *decidable* non-record — slot never written, unparsable JSON, unknown
     * envelope shape, `partyId` mismatch (a slot reused for a different party
     * must not leak into this one) — yields an EMPTY record, the safe direction:
     * the node holds nothing until it is re-seeded, rather than acting on stale
     * or foreign state.
     *
     * A slot that is *present but unreadable* ({@link DurableSlot.load} threw)
     * is NOT decidable and **throws** instead — mirroring `FileKeyStore.get`.
     * Loading empty there would both hide a real misconfiguration and let the
     * next {@link put} snapshot-write silently destroy a still-intact record.
     */
    static open<E>(slot: DurableSlot, partyId: string, spec: NodeLocalSnapshotSpec<E>): Promise<NodeLocalSnapshot<E>>;
    has(key: string): boolean;
    /** Fresh copy of the keys — a snapshot decoupled from later {@link put} / {@link remove} calls. */
    keySnapshot(): Set<string>;
    /**
     * Fresh copy of the `key -> entry` map — a snapshot decoupled from later
     * {@link put} / {@link remove} calls. The entries themselves need no copy:
     * {@link put} REPLACES an entry rather than mutating it in place.
     */
    entrySnapshot(): Map<string, E>;
    /**
     * Add or replace an entry: the in-memory map updates SYNCHRONOUSLY (so a
     * synchronous caller may consult the store the moment this returns), then
     * the full snapshot is persisted. A persist failure rejects the returned
     * promise but leaves the entry in memory — this session's decision stands,
     * and any later successful write re-lands the complete set.
     */
    put(key: string, entry: E): Promise<void>;
    /**
     * Remove an entry, with {@link put}'s contract: the in-memory map updates
     * SYNCHRONOUSLY, then the full snapshot is persisted. Removing an absent key
     * changes nothing, so it writes nothing.
     */
    remove(key: string): Promise<void>;
    /** Chain a full-snapshot write behind every earlier one (see {@link put}). */
    private queuePersist;
    private persistSnapshot;
}
