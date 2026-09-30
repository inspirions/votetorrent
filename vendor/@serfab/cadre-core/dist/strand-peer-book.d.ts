import { type DurableSlot } from './node-local-snapshot.js';
/**
 * Cap on the peers remembered per strand. When full, the entry with the smallest
 * `max(issuedAt, lastSeenAt)` is evicted. Sixteen is generous for the parties a
 * strand has today (two, occasionally a few), and it bounds the worst case of a
 * launch dialing dead entries: a failed relayed dial costs up to 16 s at the
 * declared link, so the cap — with aging — is what keeps a stale book from
 * stalling bring-up for minutes.
 */
export declare const MAX_STRAND_PEERS = 16;
/**
 * Default age after which an entry nobody has refreshed is dropped: 14 days from
 * `max(issuedAt, lastSeenAt)`. A live peer refreshes its entry on every connection,
 * so only a peer this node has not reached in two weeks ages out. Overridable per
 * store via {@link StrandPeerBookOptions.maxAgeMs}.
 */
export declare const STRAND_PEER_MAX_AGE_MS: number;
/**
 * One strand peer this node knows an address for. `sig` is set only on an entry the
 * peer signed itself and the book swap carried here (`strand-peer-book-protocol.ts`),
 * or on this node's own entry, which the swap files under the node's own strand
 * transport id; a formation-carried or observed entry is unsigned and local-only.
 */
export interface StrandPeerEntry {
    /** The peer's STRAND transport peer id (never a control peer id). */
    peerId: string;
    /**
     * Multiaddr strings, each bound to `peerId` (trailing `/p2p/<peerId>`, a relay
     * hop only with that destination behind it), signaling-first, at most
     * `MAX_STRAND_ADDRS`. Anything that does not attribute to `peerId` is dropped
     * at merge.
     */
    addrs: string[];
    /**
     * Signer's clock, ms: when the peer itself issued these addresses. 0 for an
     * entry this node observed or was handed unsigned.
     */
    issuedAt: number;
    /**
     * base64url Ed25519 signature by the peer's strand transport key over the canonical
     * JSON of `{ v, strandId, peerId, addrs, issuedAt }` (`signedStrandPeerEntryPayload`);
     * absent = local-only, never forwarded.
     */
    sig?: string;
    /**
     * This node's clock, ms: when it last held a connection to the peer — or, for a
     * formation-carried entry, when the responder disclosed the addresses live — and 0
     * for an entry it has never connected to. Local, never on the wire.
     */
    lastSeenAt: number;
}
export interface StrandPeerBookStore {
    /** Party this store is scoped to. */
    readonly partyId: string;
    /**
     * Snapshot of one strand's LIVE entries, freshest first
     * (`max(issuedAt, lastSeenAt)` descending). Empty for an unknown strand. Aged-out
     * entries are never returned. Every backend copies the entries per call, so the
     * result is decoupled from later {@link merge} / {@link forget} calls.
     */
    entries(strandId: string): StrandPeerEntry[];
    /**
     * Insert or replace by `(strandId, entry.peerId)` under the merge rule
     * ({@link mergeStrandPeerEntry}): a signed entry never yields to an unsigned
     * one; between two signed the greater `issuedAt` wins; between two unsigned the
     * greater `lastSeenAt` wins; `lastSeenAt` is always the max of old and new. Then
     * the strand's aged-out entries are dropped and, past {@link MAX_STRAND_PEERS},
     * the stalest evicted.
     *
     * Implementations MUST reflect the merge in {@link entries} SYNCHRONOUSLY; the
     * returned promise tracks durability only. An entry whose peer id does not parse
     * is logged and dropped rather than thrown — every writer is a best-effort event
     * handler.
     */
    merge(strandId: string, entry: StrandPeerEntry): Promise<void>;
    /**
     * Drop one peer, or the whole strand when `peerId` is omitted — for a strand this
     * node unpublished or left, whose peers must not stay dial targets. Forgetting
     * something absent is a no-op. Same contract as {@link merge}: reflected
     * synchronously, the promise tracks durability.
     */
    forget(strandId: string, peerId?: string): Promise<void>;
}
/** Tuning shared by every backend. */
export interface StrandPeerBookOptions {
    /** Age after which an unrefreshed entry is dropped. Default {@link STRAND_PEER_MAX_AGE_MS}. */
    maxAgeMs?: number;
    /** Clock, for tests. Default `Date.now`. */
    now?: () => number;
}
/** The moment an entry was last vouched for, by whichever clock spoke last. */
export declare function strandPeerFreshness(entry: StrandPeerEntry): number;
/**
 * The merge rule, in one place. Returns the entry to hold for `incoming.peerId`
 * given what is already held — always a NEW object, so a held entry is never mutated
 * in place (the persistent backend's snapshot `put` replaces rather than patches).
 * `incoming` is assumed sanitized ({@link sanitizeStrandPeerEntry}).
 *
 * - A signed entry never yields to an unsigned one for the same peer: the peer's own
 *   statement outranks this node's observation of it.
 * - Between two signed entries the greater `issuedAt` wins; between two unsigned
 *   entries the greater `lastSeenAt` wins. A tie goes to `incoming`.
 * - `lastSeenAt` is always the max of old and new whichever entry wins, because it
 *   is this node's own observation and no remote statement can lower it.
 */
export declare function mergeStrandPeerEntry(existing: StrandPeerEntry | undefined, incoming: StrandPeerEntry): StrandPeerEntry;
/**
 * Shape an entry for storage: the peer id must parse (else `undefined` — not a dial
 * target at all), and `addrs` is reduced to the entries that attribute to `peerId`
 * under `groupAddrsByPeerId`'s rule, de-duplicated, capped at `MAX_STRAND_ADDRS`, and
 * — for an UNSIGNED entry only — reordered signaling-first. A signed entry keeps the
 * signer's order: its signature covers the address list as signed, and the swap
 * forwards the stored copy, so any reordering here would make every forwarded entry
 * fail verification at the next peer (every signer already orders signaling-first). An
 * entry may legitimately end up with NO addresses — a signed "not reachable right
 * now" from the swap protocol is truthful and displaces a stale reachable list — so
 * an empty list is kept, not rejected.
 */
export declare function sanitizeStrandPeerEntry(entry: StrandPeerEntry): StrandPeerEntry | undefined;
/**
 * Ephemeral in-memory book for nodes without durable storage (tests, and the
 * default when nothing is injected). Same contract, no disk: a node using this
 * forgets every strand peer on restart — the #18 shape.
 */
export declare class MemoryStrandPeerBookStore implements StrandPeerBookStore {
    readonly partyId: string;
    private readonly strands;
    private readonly options;
    constructor(partyId: string, options?: StrandPeerBookOptions);
    entries(strandId: string): StrandPeerEntry[];
    merge(strandId: string, entry: StrandPeerEntry): Promise<void>;
    forget(strandId: string, peerId?: string): Promise<void>;
}
/**
 * Durable {@link StrandPeerBookStore} over an app-supplied {@link DurableSlot} —
 * the cross-platform half of every persistent backend (the Node
 * `FileStrandPeerBookStore` is this class over a file slot).
 *
 * Construct via {@link open}. Load and persist policy — what an absent, corrupt,
 * foreign-party or unreadable slot does (the last one THROWS, as
 * `PersistentBootstrapPeerStore.open` does), and what a failed persist does — is
 * documented once on `NodeLocalSnapshot`; this class only supplies the payload shape
 * and the drop-the-bad-entry policy above. Writes are serialised in-process by the
 * snapshot's write chain, so several strands' identify handlers merging at once
 * cannot interleave partial snapshots.
 */
export declare class PersistentStrandPeerBookStore implements StrandPeerBookStore {
    private readonly snapshot;
    private readonly options;
    private constructor();
    /** Load (or cold-start) the party's book from `slot`. */
    static open(slot: DurableSlot, partyId: string, options?: StrandPeerBookOptions): Promise<PersistentStrandPeerBookStore>;
    get partyId(): string;
    entries(strandId: string): StrandPeerEntry[];
    /** Merge, visible via {@link entries} synchronously, then the full snapshot is persisted. */
    merge(strandId: string, entry: StrandPeerEntry): Promise<void>;
    /** Forget, gone from {@link entries} synchronously, then persisted — unless nothing was there. */
    forget(strandId: string, peerId?: string): Promise<void>;
}
