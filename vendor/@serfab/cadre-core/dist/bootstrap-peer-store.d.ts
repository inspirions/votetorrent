import { type DurableSlot } from './node-local-snapshot.js';
/**
 * One retained dial target learned out of band: an owner peer a seed nominated,
 * or a node this node added.
 */
export interface BootstrapPeerEntry {
    /** Multiaddr strings exactly as they were handed over (parsed at dial time). */
    addrs: string[];
    /** Wall-clock ms the entry was last recorded (diagnostics / future eviction). */
    recordedAt: number;
}
export interface BootstrapPeerStore {
    /** Party this store is scoped to. */
    readonly partyId: string;
    /**
     * Every retained target, peerId -> entry. Every backend copies the map per call,
     * so the result is a snapshot decoupled from later {@link record} and
     * {@link forget} calls and is safe to iterate while recording. The entry objects
     * need no copy: `record` REPLACES an entry rather than mutating it in place.
     */
    all(): ReadonlyMap<string, BootstrapPeerEntry>;
    /**
     * Retain (or REPLACE) a peer's dial addresses. Replace, not merge, so a
     * re-seed after an owner's address changed drops the stale address instead of
     * accumulating dead ones.
     *
     * Implementations MUST reflect the entry in {@link all} SYNCHRONOUSLY; the
     * returned promise tracks durability only. That is what lets the synchronous
     * `CadreNode.recordSeedBootstrapPeers` keep its signature while a file
     * backend persists in the background.
     *
     * NOTE: entries are never evicted (only a local `removePeer` {@link forget}s
     * one), and a persistent backend's file therefore grows across the node's whole
     * lifetime rather than one process. Fine while a seed nominates one or a few
     * owners, a node adds a handful of machines, and entries are keyed by peer id;
     * if a node ever applies seeds naming many distinct owners or adds many
     * machines, add eviction (oldest {@link BootstrapPeerEntry.recordedAt} first, or
     * a cap) rather than letting the file grow unbounded — `recordedAt` exists so
     * eviction has something to sort by.
     */
    record(peerId: string, addrs: readonly string[]): Promise<void>;
    /**
     * Drop a peer's retained dial addresses — for a peer this node removed from the
     * party, which must not stay a dial target. Forgetting a peer with no entry is a
     * no-op.
     *
     * Same contract as {@link record}: the removal is reflected in {@link all}
     * SYNCHRONOUSLY, and the returned promise tracks durability only.
     */
    forget(peerId: string): Promise<void>;
}
/**
 * Ephemeral in-memory store for nodes without durable storage (tests, browser
 * demos, not-yet-persisted mobile). Same contract, no disk: a node using this
 * loses its retry targets on restart and must be re-seeded to rejoin.
 */
export declare class MemoryBootstrapPeerStore implements BootstrapPeerStore {
    readonly partyId: string;
    private readonly peers;
    constructor(partyId: string);
    all(): ReadonlyMap<string, BootstrapPeerEntry>;
    record(peerId: string, addrs: readonly string[]): Promise<void>;
    forget(peerId: string): Promise<void>;
}
/**
 * Durable {@link BootstrapPeerStore} over an app-supplied {@link DurableSlot} —
 * the cross-platform half of every persistent backend (the Node
 * `FileBootstrapPeerStore` is this class over a file slot).
 *
 * Construct via {@link open}. Load and persist policy — what an absent, corrupt,
 * foreign-party or unreadable slot does, and what a failed persist does — is
 * documented once on `NodeLocalSnapshot`; this class only supplies the payload
 * shape and the drop-the-bad-entry policy above.
 */
export declare class PersistentBootstrapPeerStore implements BootstrapPeerStore {
    private readonly snapshot;
    private constructor();
    /** Load (or cold-start) the party's retained dial targets from `slot`. */
    static open(slot: DurableSlot, partyId: string): Promise<PersistentBootstrapPeerStore>;
    get partyId(): string;
    all(): ReadonlyMap<string, BootstrapPeerEntry>;
    /**
     * Retain a peer's dial addresses: visible via {@link all} synchronously, then
     * the full snapshot is persisted (see `NodeLocalSnapshot.put`).
     */
    record(peerId: string, addrs: readonly string[]): Promise<void>;
    /**
     * Drop a peer's dial addresses: gone from {@link all} synchronously, then the
     * full snapshot is persisted — unless there was no entry, which writes nothing
     * (see `NodeLocalSnapshot.remove`).
     */
    forget(peerId: string): Promise<void>;
}
