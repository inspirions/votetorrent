import type { Connection, Libp2p, PeerId } from '@libp2p/interface';
/** Minimum gap between two reports of ONE peer with an unchanged address set. */
export declare const STRAND_PEER_OBSERVE_THROTTLE_MS: number;
/** One strand peer seen live: its strand transport peer id and the addresses it is dialable at. */
export interface StrandPeerObservation {
    peerId: string;
    /** Bound to `peerId`, signaling-first, at most `MAX_STRAND_ADDRS`. */
    addrs: string[];
}
export interface StrandPeerObserverDeps {
    /** For logs (the strand id). */
    label: string;
    /** The strand's libp2p node. */
    libp2p: Libp2p;
    /** This strand network's `/optimystic/<networkName>` prefix — the block-transfer gate. */
    protocolPrefix: string;
    /** Called for every (throttled) observation; must not throw. */
    onObserved: (observation: StrandPeerObservation) => void;
}
export interface StrandPeerObserverOptions {
    /** Default {@link STRAND_PEER_OBSERVE_THROTTLE_MS}. */
    throttleMs?: number;
    /** Clock, for tests. Default `Date.now`. */
    now?: () => number;
}
/**
 * Anything that prints as a multiaddr. libp2p's identify result and peer store hand
 * back its nested `@multiformats/multiaddr` copy, a structurally different type from
 * this package's, so addresses are taken by their string form and re-parsed here.
 */
export interface AddrLike {
    toString(): string;
}
/** One connected peer as the peer store knows it: what identify recorded, plus its open connections. */
export interface ConnectedIdentifiedPeer {
    peerId: PeerId;
    protocols: string[];
    /** The stored addresses: identify-announced, plus whatever else was merged in. */
    addrs: AddrLike[];
    connections: Connection[];
}
/**
 * Every peer `libp2p` holds a connection to AND has already identified (it is in the
 * peer store), grouped per peer. A connected peer whose identify has not finished is
 * left out: its `peer:identify` event is still to come, and every listener that walks
 * this list at start subscribes to that event too. Shared by the peer-book observer
 * and the book swap (`strand-peer-book-swap.ts`), which both arm right after the
 * node exists and may already have missed an early peer's identify.
 */
export declare function connectedIdentifiedPeers(libp2p: Libp2p, label: string): Promise<ConnectedIdentifiedPeer[]>;
export declare class StrandPeerObserver {
    private readonly deps;
    private readonly throttleMs;
    private readonly now;
    private readonly lastReports;
    private readonly onPeerIdentify;
    private started;
    private stopped;
    constructor(deps: StrandPeerObserverDeps, options?: StrandPeerObserverOptions);
    /** Subscribe to `peer:identify` and report the peers already connected and identified. */
    start(): void;
    /** Unsubscribe; later identify results are ignored. */
    stop(): void;
    /**
     * Report every connected peer the peer store already knows speaks this strand's
     * protocol, with its stored addresses. A peer not yet in the store (identify has
     * not finished) is left to the `peer:identify` handler. Returns the number of
     * identified peers considered.
     *
     * NOTE: the stored addresses include what `CadreNode.mergeStrandPeerAddrs` merged
     * INTO the peer store from the book, so this walk can re-vouch a dead address the
     * book already held, until the peer's next `peer:identify` replaces the set with
     * what it announces now. Bounded by the address cap; if a dead address ever shows
     * up surviving across resumes, read only the peer store's identify-sourced
     * addresses here rather than shortening the age.
     */
    private observeConnectedPeers;
    /** Shape, throttle and report one peer. Never throws. */
    private observe;
    /** One report per peer per throttle window, unless the address set changed. */
    private shouldReport;
}
/**
 * The addresses to file for `peerId`: its announced listen addrs plus every relayed
 * connection addr, each bound to `peerId`, de-duplicated, signaling-first, capped.
 * Re-parsed through this package's own `multiaddr` (see {@link AddrLike}).
 */
export declare function dialableAddrs(peerId: string, listenAddrs: AddrLike[], connections: Connection[]): string[];
