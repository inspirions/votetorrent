import type { Libp2p, PrivateKey } from '@libp2p/interface';
import type { StrandPeerBookStore } from './strand-peer-book.js';
import { type SignedStrandPeerEntry } from './strand-peer-book-protocol.js';
/** Minimum gap between two exchanges with ONE peer, unless this node's own entry was re-signed. */
export declare const STRAND_PEER_BOOK_SWAP_THROTTLE_MS: number;
/** How long after the last `self:peer:update` the own entry is rebuilt — the event fires in bursts. */
export declare const OWN_ENTRY_RESIGN_DEBOUNCE_MS = 1000;
export interface StrandPeerBookSwapDeps {
    strandId: string;
    /** The strand's libp2p node. */
    libp2p: Libp2p;
    /** This strand network's `/optimystic/<networkName>` prefix — the block-transfer gate. */
    protocolPrefix: string;
    /** The node-local book this strand's entries live in. */
    store: StrandPeerBookStore;
    /**
     * The strand transport key the node runs under. Absent — or not the node's own
     * key — means no own entry is signed; the node still receives and forwards.
     */
    privateKey?: PrivateKey;
    /** The host's declared link round trip, for the exchange deadline (`link-budget.ts`). */
    linkRoundTripMs?: number;
}
export interface StrandPeerBookSwapOptions {
    /** Default {@link STRAND_PEER_BOOK_SWAP_THROTTLE_MS}. */
    throttleMs?: number;
    /** Default {@link OWN_ENTRY_RESIGN_DEBOUNCE_MS}. */
    debounceMs?: number;
    /** Whole-exchange deadline; default derived from `linkRoundTripMs`. */
    timeoutMs?: number;
    /** Clock, for tests. Default `Date.now`. */
    now?: () => number;
}
export declare class StrandPeerBookSwap {
    private readonly deps;
    private readonly service;
    private readonly selfPeerId;
    private readonly signingKey;
    private readonly throttleMs;
    private readonly debounceMs;
    private readonly timeoutMs;
    private readonly now;
    /** Last exchange per peer id, for the throttle. */
    private readonly exchangedAt;
    /** Peers with an exchange in flight, so identify and a walk cannot double up. */
    private readonly inFlight;
    /**
     * Peers whose in-flight exchange carries a since-replaced own entry: one more
     * exchange follows the moment it settles. Without this a re-sign that lands while
     * the identify exchange is still on the wire — the relay reservation arriving a
     * second after the bootstrap dials do, which is routine — would never reach that
     * peer until the next connection.
     */
    private readonly resendAfter;
    private own;
    /** The address set the own entry was signed over, canonicalised for comparison. */
    private ownAddrKey;
    /** Serialises own-entry refreshes: a burst of triggers signs at most once per change. */
    private selfChain;
    private debounceTimer;
    private readonly onPeerIdentify;
    private readonly onSelfUpdate;
    private started;
    private stopped;
    constructor(deps: StrandPeerBookSwapDeps, options?: StrandPeerBookSwapOptions);
    /** This node's current signed entry, or `undefined` before the first signing or without a key. */
    get ownEntry(): SignedStrandPeerEntry | undefined;
    /**
     * Register the receiver, subscribe, sign the own entry, and exchange with the strand
     * peers already connected — identify for an early peer may have fired before this
     * object existed.
     */
    start(): void;
    /** Unsubscribe and unregister; an exchange in flight finishes on its own. */
    stop(): Promise<void>;
    /** A strand peer that also speaks the swap; never self. */
    private isSwapPeer;
    private queueSelfRefresh;
    /** Re-sign the own entry if the address set changed, then exchange — unthrottled after a re-sign. */
    private refreshSelf;
    /** Returns whether a new own entry was signed. */
    private refreshOwnEntry;
    /** The greatest `issuedAt` this node has signed: in memory, else the stored own entry's, else 0. */
    private lastOwnIssuedAt;
    /** Exchange with every connected, identified strand peer that speaks the swap. */
    private exchangeWithConnected;
    /**
     * One exchange with one peer over `connection`, throttled unless told otherwise (a
     * re-sign) — in which case an exchange already in flight, which carries the old
     * entry, is followed by one more once it settles. Never throws.
     */
    private exchangeWith;
    /**
     * What this node sends `remotePeerId`: its own entry first, then every signed entry
     * held for anyone else, freshest first, minus the recipient's own — trimmed from the
     * stale end to the frame's entry and byte caps (the own entry can push the store's
     * cap over by one, and long addresses can push the bytes over).
     */
    private frameFor;
    /** File verified entries: the sender's own as seen now, a forwarded third party's as never seen. */
    private accept;
    /** Fire-and-log, like every book write: visible synchronously, the promise tracks durability. */
    private remember;
}
