/**
 * Delegate-peer admission grants for a party control node that also runs the
 * circuit-relay server.
 *
 * A strand node runs as its own libp2p instance with its own transport peerId,
 * derived from the cadre identity key + strandId (`strand-transport-key.ts`).
 * That derivation uses the member's PRIVATE seed by design, so no third party —
 * including a co-cadre relay — can recompute it: a sibling's relay sees an
 * unknown peerId it has no way to place as a member.
 *
 * The resolution (docs/strands.md → "Relay willingness"): a party control
 * node running a relay is party-private infrastructure — it relays for its own
 * party's nodes, including the extra transport identities its members' strand
 * nodes run as. The mechanism is a **member-announced delegate grant**: before
 * a member's control node starts a strand node, it tells its siblings (over the
 * already-authenticated `/sereus/strand-addr/1.0.0` RPC) the derived peerId
 * that strand node will use, and the receiver holds a short-lived, in-memory
 * admission grant for exactly that peerId. The grant is consulted by the
 * connection-level gate (`CadreNode.admitInboundControlConnection`) and by the
 * relay-reservation admission (`CadreNode.admitControlRelayReservation`) — a
 * granted delegate is admitted outright, never drawing on the small
 * unauthorized-reservation budget that unplaced peers share
 * (`membership-connection-gater.ts` → "The relay-reservation seam") and never
 * racing its not-reserving connection deadline. The fail-closed per-stream gate
 * (`authorizeInboundControlStream`) never honors a grant, so a delegate gets
 * the connection and its reservation (all a circuit-relay `hop` needs) and
 * nothing more.
 *
 * A grant is a delegation of trust to an already-trusted member: the receiver
 * cannot verify that the announced peerId really is the member's strand node,
 * so an authorized member can hand CONNECTION-level access to a peerId of its
 * choosing for up to {@link DELEGATE_GRANT_TTL_MS}. The caps below bound how
 * far a buggy or compromised member can stretch that.
 *
 * The receiver side is {@link DelegateAdmissionStore}. The announcer side keeps
 * its own throttle state (a "last announced at" map that `CadreNode` owns) and
 * decides from it, per reconcile pass, which relays are due a re-announce —
 * {@link dueRelayAnnounces} and {@link prunePeerStrandKeys} are that
 * decision, pure and testable, kept here beside the TTL they are derived from.
 */
/**
 * How long one announced delegate grant stays valid without a re-announce.
 * Announcers refresh at half this (`CadreNode`'s reconcile pass), so a live
 * strand's grant never lapses while its control node can still reach the relay.
 */
export declare const DELEGATE_GRANT_TTL_MS: number;
/** Cap on live grants per announcing member (soonest-expiry evicted first). */
export declare const MAX_DELEGATE_GRANTS_PER_MEMBER = 32;
/** Cap on live grants in total (soonest-expiry evicted first). */
export declare const MAX_DELEGATE_GRANTS = 256;
/**
 * Composite map key for per-(peer, strand) state: the receiver's
 * replace-per-(announcer, strand) grant, the announcer's per-(target, strand)
 * throttle timestamp, and `CadreNode`'s per-(sibling, strand) strand-addr ask
 * due time.
 */
export declare function peerStrandKey(peerId: string, strandId: string): string;
/**
 * In-memory store of delegate admission grants, keyed by (announcer, strandId)
 * so a re-announce REPLACES the previous delegate peerId rather than
 * accumulating — a restarted strand cannot leak grants. Expired entries are
 * pruned lazily on every read/write. Injectable `now` keeps expiry testable
 * without fake timers.
 */
export declare class DelegateAdmissionStore {
    private readonly grants;
    private readonly ttlMs;
    constructor(ttlMs?: number);
    /** Number of live (unexpired at last prune) grants — test/diagnostic surface. */
    get size(): number;
    /**
     * Record (or refresh) a grant: `delegatePeerId` acts on behalf of
     * `announcerPeerId` for `strandId`, valid for the store's TTL from `now`.
     * Enforces {@link MAX_DELEGATE_GRANTS_PER_MEMBER} and
     * {@link MAX_DELEGATE_GRANTS}, evicting the soonest-expiry grant first —
     * biased against the stalest delegation, never against the fresh announce.
     */
    grant(announcerPeerId: string, strandId: string, delegatePeerId: string, now?: number): void;
    /**
     * Drop every grant. Called when the owning node stops: grants are scoped to
     * the session that recorded them, and outliving it would admit delegates
     * announced against a node that no longer exists.
     */
    clear(): void;
    /** Is `remotePeerId` covered by a live grant? Prunes expired entries as it goes. */
    has(remotePeerId: string, now?: number): boolean;
    /** Drop every grant whose expiry has passed. */
    private prune;
    /**
     * If the grants matching `filter` are at `cap`, evict the soonest-expiry one
     * among them to make room for the insert the caller is about to do.
     */
    private evictAtCap;
}
/** A circuit relay named by a multiaddr, as an announce target. */
export interface CircuitRelayTarget {
    /** The relay's peerId — the `<relay>` in `…/p2p/<relay>/p2p-circuit…`. */
    relayPeerId: string;
    /**
     * The relay's DIRECT dial multiaddr (the prefix before `/p2p-circuit`),
     * usable as a dial fallback when no connection to the relay is open yet.
     */
    relayAddr: string;
}
/**
 * Extract the circuit relays named by a multiaddr list — for each
 * `…/p2p/<relay>/p2p-circuit…` entry, the relay's peerId and its direct dial
 * prefix. A bare `/p2p-circuit` (no relay named), a non-circuit addr, an
 * unparsable addr, and an unparsable relay peerId are all skipped. A trailing
 * `/p2p/<dst>` after the circuit component names the DESTINATION, never the
 * relay, and is ignored. Deduplicated by relay peerId (first addr wins).
 */
export declare function extractCircuitRelayTargets(addrs: string[]): CircuitRelayTarget[];
/**
 * Of `relays`, the ones whose grant for `strandId` is due a re-announce: never
 * announced to, or last announced at least half the TTL ago. Half, so a failed
 * refresh has one more attempt before the grant lapses — a lapsed grant means
 * the relay denies the strand node's reservation re-dial.
 *
 * `announceAt` is the announcer-side "last announced at" map, keyed by
 * {@link peerStrandKey} on the peer announced TO.
 */
export declare function dueRelayAnnounces(announceAt: ReadonlyMap<string, number>, relays: readonly CircuitRelayTarget[], strandId: string, now: number, ttlMs?: number): CircuitRelayTarget[];
/**
 * Drop the entries of a {@link peerStrandKey}-keyed map whose strand is no longer
 * running, and — when `livePeerIds` is given — whose peer is not among them. A
 * stopped strand needs no refresh, a departed peer is owed a fresh start when it
 * returns, and without this the map grows for the node's lifetime. Mutates in
 * place.
 */
export declare function prunePeerStrandKeys(byKey: Map<string, number>, runningStrandIds: ReadonlySet<string>, livePeerIds?: ReadonlySet<string>): void;
/**
 * The circuit relay named by `addr`, throwing when `addr` is unparsable or names
 * no relay. The throwing form exists for CONFIG-facing callers (`relay-addrs.ts`),
 * where a typo must fail loudly rather than cost the node its reachability;
 * {@link extractCircuitRelayTargets} reads runtime-discovered addrs instead and
 * logs-and-skips.
 */
export declare function circuitRelayTargetOrThrow(addr: string): CircuitRelayTarget;
