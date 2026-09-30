import type { Connection, Libp2p, PrivateKey } from '@libp2p/interface';
/** Protocol id of the strand peer book swap, registered on every running strand node. */
export declare const STRAND_PEER_BOOK_PROTOCOL = "/sereus/strand-peers/1.0.0";
/** Version tag inside every signed payload, so a later payload shape cannot verify as this one. */
export declare const SIGNED_STRAND_PEER_ENTRY_VERSION = 1;
/**
 * How far ahead of the receiver's clock a signed entry's `issuedAt` may be. Skew
 * between honest machines is seconds; a stamp further ahead than this is a broken
 * clock or an attempt to pin an entry, and is rejected rather than held.
 */
export declare const STRAND_PEER_ISSUED_AT_SKEW_MS: number;
/**
 * Cap on one frame's bytes. A typical full frame — {@link MAX_STRAND_PEERS} entries of
 * {@link MAX_STRAND_ADDRS} addresses at roughly 150 bytes each, plus a peer id and
 * signature per entry — is about 40 KiB, but nothing bounds a multiaddr's length (a
 * long DNS name can take one past 300 bytes), so a sender trims its forwarded
 * entries to fit ({@link trimBookFrameToFit}) rather than trusting the arithmetic;
 * {@link assertBookFrameFits} is then the invariant check.
 */
export declare const MAX_BOOK_FRAME_SIZE: number;
/**
 * One peer's own signed statement of where it is: a `StrandPeerEntry` without the
 * receiver-local `lastSeenAt`. `addrs` may be empty — a peer that lost its relay
 * reservation truthfully says "not reachable now", and that displaces a stale
 * reachable list at every receiver.
 */
export interface SignedStrandPeerEntry {
    /** The signer's strand transport peer id (Ed25519, so it embeds the verifying key). */
    peerId: string;
    /** Bound to `peerId`, signaling-first, at most `MAX_STRAND_ADDRS`. */
    addrs: string[];
    /** Signer's clock, ms. Greater wins between two statements by the same signer. */
    issuedAt: number;
    /** base64url Ed25519 signature over {@link signedStrandPeerEntryPayload}. */
    sig: string;
}
/** Request and response of the swap: the sender's signed book for one strand. */
export interface StrandPeerBookFrame {
    /** Must name the strand whose network the frame arrived on; anything else is refused. */
    strandId: string;
    /** At most {@link MAX_STRAND_PEERS}. */
    entries: SignedStrandPeerEntry[];
}
/** The bytes a signed entry's signature covers. */
export declare function signedStrandPeerEntryPayload(strandId: string, entry: Pick<SignedStrandPeerEntry, 'peerId' | 'addrs' | 'issuedAt'>): Uint8Array;
/**
 * Sign this node's own entry with its strand transport key. `addrs` must already be
 * bound to the key's peer id (`dialableAddrs` in `strand-peer-observer.ts` does that);
 * a receiver rejects an entry whose addresses do not all attribute to the signer.
 */
export declare function signStrandPeerEntry(privateKey: PrivateKey, strandId: string, addrs: string[], issuedAt: number): Promise<SignedStrandPeerEntry>;
/** Why a received entry was dropped — for logs and for the verification test. */
export type StrandPeerEntryVerdict = {
    ok: true;
    entry: SignedStrandPeerEntry;
} | {
    ok: false;
    reason: string;
};
/**
 * Verify one received entry: well-formed, an Ed25519 peer id, every address bound to
 * that peer id, `issuedAt` not further ahead of `now` than the skew ceiling, and a
 * valid self-signature. Never throws: junk from a peer is a verdict, not an error.
 */
export declare function verifySignedStrandPeerEntry(strandId: string, raw: unknown, now: number): Promise<StrandPeerEntryVerdict>;
/**
 * Verify a whole received frame. A frame-level violation — the wrong strand, entries
 * not a list, more entries than {@link MAX_STRAND_PEERS} — throws, and the caller
 * refuses the frame. An entry that fails {@link verifySignedStrandPeerEntry} is
 * dropped INDIVIDUALLY with a debug line; its siblings are kept. An entry naming
 * `selfPeerId` is dropped too: this node's own statement is authoritative locally
 * and a remote copy of it is at best redundant. One entry per peer id (the first).
 */
export declare function verifyStrandPeerBookFrame(strandId: string, raw: unknown, selfPeerId: string, now: number): Promise<SignedStrandPeerEntry[]>;
/**
 * The frame with its LAST entries dropped until it encodes within
 * {@link MAX_BOOK_FRAME_SIZE} and {@link MAX_STRAND_PEERS}. Callers list the entries
 * in the order they would rather keep them (the own entry first, then freshest
 * first), so what goes is the stalest forwarded statement, and a frame that fits is
 * returned as is. Dropping an entry is logged: a forwarded peer the recipient never
 * learns of is worth seeing in a trace.
 */
export declare function trimBookFrameToFit(frame: StrandPeerBookFrame): StrandPeerBookFrame;
/**
 * Refuse to send a frame the receiver would reject: over the entry cap, or over
 * {@link MAX_BOOK_FRAME_SIZE} once encoded. A caller that built its frame through
 * {@link trimBookFrameToFit} cannot trip this; it is the invariant check, not a
 * runtime condition to handle.
 */
export declare function assertBookFrameFits(frame: StrandPeerBookFrame): void;
/** What the {@link StrandPeerBookService} receiver needs from its host, injected so it is testable without a node. */
export interface StrandPeerBookServiceDeps {
    strandId: string;
    /** This strand node's own peer id: a received entry naming it is never merged. */
    selfPeerId: string;
    /**
     * The entries to answer `forPeerId` with — this node's own signed entry plus every
     * signed entry it holds, minus `forPeerId`'s own (the asker knows where it is).
     */
    localEntries(forPeerId: string): SignedStrandPeerEntry[];
    /** The asker's VERIFIED entries, for the host to merge. Must not throw. */
    onEntries(entries: SignedStrandPeerEntry[], fromPeerId: string): void;
    /** Clock, for tests. Default `Date.now`. */
    now?: () => number;
    /**
     * How long the receiver waits for the inbound request frame (ms). Required for the same
     * reason as {@link ExchangeStrandPeerBookOptions.timeoutMs}: the swap gives both sides one
     * link-derived deadline.
     */
    readTimeoutMs: number;
    /** Default {@link DEFAULT_MAX_CONCURRENT}. Over it, an empty frame is returned unread. */
    maxConcurrent?: number;
}
/**
 * Receiver side: registers the protocol on a strand node and, per inbound frame,
 * verifies and hands over the asker's entries, then answers with the local book.
 * Registered through `node.handle`, so on a closed strand every inbound stream
 * passes the revocation gate first — a revoked machine cannot push addresses into
 * anyone's book.
 */
export declare class StrandPeerBookService {
    private readonly deps;
    private readonly readTimeoutMs;
    private readonly maxConcurrent;
    private readonly now;
    private node;
    private activeStreams;
    constructor(deps: StrandPeerBookServiceDeps);
    /** In-flight inbound streams. */
    get activeCount(): number;
    /** Register the handler. Resolves once libp2p has recorded the protocol on the self record. */
    initialize(node: Libp2p): Promise<void>;
    /** Unregister the handler and release the node reference. */
    shutdown(): Promise<void>;
    /**
     * Read the request, merge what verifies, answer with the local book. Every failure
     * (cap, malformed or oversized frame, wrong strand, read timeout) answers an empty
     * frame rather than hanging or dropping the stream, so the asker's exchange settles.
     *
     * NOTE: the concurrency cap bounds streams in flight, not frames per peer per unit
     * time — the ten-minute throttle is the CLIENT's, so a connected peer can push a
     * verified frame, and the persist it costs, as fast as it likes; see
     * `backlog/debt-strand-peer-book-remote-write-bounds`.
     */
    private handleStream;
    private reply;
}
/** Options for {@link exchangeStrandPeerBook}. */
export interface ExchangeStrandPeerBookOptions {
    /** This strand node's own peer id: a returned entry naming it is dropped. */
    selfPeerId: string;
    /**
     * Whole-exchange deadline (ms). Required, with no fallback here: the exchange crosses the
     * link, so its deadline derives from the declared link round trip (`link-budget.ts`), and
     * the caller is the one that knows the declaration. A default in this module would be a
     * second number free to drift from that derivation.
     */
    timeoutMs: number;
    /** Clock, for tests. Default `Date.now`. */
    now?: () => number;
}
/**
 * Client side: open one stream on `connection` — the live connection to the peer,
 * relayed or not — send `request`, and return the peer's VERIFIED entries. Throws on
 * any failure (the peer does not speak the protocol, a deadline, a refused frame);
 * the caller logs and moves on, never retrying before its throttle expires.
 */
export declare function exchangeStrandPeerBook(connection: Connection, request: StrandPeerBookFrame, options: ExchangeStrandPeerBookOptions): Promise<SignedStrandPeerEntry[]>;
