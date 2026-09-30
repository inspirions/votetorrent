/**
 * Control-network strand-address RPC.
 *
 * A strand runs as its own libp2p node (`strand-<id>`, random port), separate
 * from the control node (`control-<partyId>`), with its own transport peerId
 * derived from the cadre identity key (`strand-transport-key.ts`). To seed a
 * strand's mesh, a node needs a sibling's **strand-network** address — but
 * `CadrePeer.Multiaddr` only stores the **control** node's addresses, and a
 * control address now names a different peer entirely, not merely a different
 * port. This protocol resolves the strand address on demand: a node asks its
 * connected co-cadre siblings "what are your live strand-`X` multiaddrs?" and
 * uses the union of their answers as the seed.
 *
 * Modeled directly on `strand-wake-protocol.ts`: a dedicated libp2p protocol id,
 * 4-byte big-endian length-prefixed JSON frames, `node.handle` for the receiver,
 * `node.dialProtocol` for the client, and the shared `ControlStream` primitives
 * from `control-stream.ts`. The exchange is a single request → single response on
 * one stream, so each side reads to EOF (under a read timeout) and decodes one
 * frame via the shared {@link decodeLengthPrefixedFrame} guard.
 *
 * **Authorization (v1):** like wake, the receiver defers entirely to the injected
 * `isMember` predicate and requires no further signature; a peer it rejects gets
 * a `refused` reply with no addresses. `CadreNode` injects its AUTHORIZED-membership predicate
 * (`isAuthorizedMember`: voucher on the requester's `CadrePeer` row verified
 * against the node-local trusted-owner anchor), so an outsider that published its
 * own rows into the replicated control DB cannot harvest live strand addresses.
 * Cross-party strand bootstrap is a different mechanism (strand formation /
 * `MemberPeer`) and is out of scope here.
 */
import type { Libp2p } from '@libp2p/interface';
import type { Multiaddr } from '@multiformats/multiaddr';
import type { StrandAddrRequest, StrandAddrResponse } from './types.js';
/** Protocol id for the control-network strand-address RPC (parallel to `/sereus/strand-wake/1.0.0`). */
export declare const STRAND_ADDR_PROTOCOL = "/sereus/strand-addr/1.0.0";
/**
 * Dependencies the {@link StrandAddrService} receiver needs from its host
 * (`CadreNode`), injected so the service is testable without a full node.
 */
export interface StrandAddrServiceOptions {
    /** Membership gate: is the remote peer a `CadrePeer` member of this cadre? */
    isMember(remotePeerId: string): Promise<boolean>;
    /**
     * The local strand instance's dialable strand-network multiaddrs, ordered
     * signaling-first. Returns `[]` when the strand is not running / has no live
     * node (hibernating, quiescing, or never participated). Kept injectable so the
     * decision logic is unit-testable without a full node.
     */
    getStrandMultiaddrs(strandId: string): string[];
    /**
     * Called when a member's request carries a `delegatePeerId` — the derived
     * transport peerId its strand-`strandId` node runs as. Invoked only AFTER the
     * `isMember` gate passed, with a validated (parseable, non-self) peerId.
     * `CadreNode` injects its delegate-admission grant recorder so this node's
     * connection gate — and thus its circuit-relay server, when it runs one —
     * admits that peerId (see `delegate-admission.ts`). Optional: absent, an
     * announce is ignored and the address lookup proceeds unchanged.
     */
    onDelegateAnnounce?(announcerPeerId: string, strandId: string, delegatePeerId: string): void;
    /**
     * Time to wait for the inbound request frame before aborting the read (ms).
     * Defaults to {@link DEFAULT_ADDR_READ_TIMEOUT_MS}. Bounds a buggy/compromised
     * own-cadre node that opens a stream and never half-closes its write end.
     */
    readTimeoutMs?: number;
    /**
     * Cap on concurrent inbound strand-addr streams (defaults to
     * {@link DEFAULT_MAX_CONCURRENT_ADDRS}). Over the cap, an `unavailable` reply is
     * returned without looking up any strand address.
     */
    maxConcurrent?: number;
}
/**
 * Receiver side of the strand-address RPC. Registers a `STRAND_ADDR_PROTOCOL`
 * handler on the control node and, for each inbound {@link StrandAddrRequest},
 * gates on cadre membership, then replies with the local strand instance's live
 * multiaddrs — `ok` with an empty list when the strand is not running, `refused`
 * for a non-member, `unavailable` when it could not answer at all.
 */
export declare class StrandAddrService {
    private readonly options;
    private readonly readTimeoutMs;
    private readonly maxConcurrent;
    private node;
    /** In-flight inbound strand-addr streams, used to enforce {@link maxConcurrent}. */
    private activeStreams;
    constructor(options: StrandAddrServiceOptions);
    /** Number of in-flight inbound strand-addr streams. */
    get activeCount(): number;
    /**
     * Register the strand-addr protocol handler on the control node. Rejects when
     * libp2p refuses the registration (a duplicate handler, a peer-store write
     * failure); the node reference is kept only once the handler is in place.
     */
    initialize(node: Libp2p): Promise<void>;
    /** Unregister the handler and release the node reference. */
    shutdown(): Promise<void>;
    /**
     * Read the inbound request, decide the response, and write it back.
     *
     * Three hardening layers, all reported as an `unavailable`
     * {@link StrandAddrResponse} rather than a dropped/hung stream: a concurrency cap
     * (over {@link maxConcurrent}, reply without looking up any address), a read
     * timeout (a peer that never half-closes is aborted inside {@link readFrame}/
     * `readStreamToEnd`), and the existing malformed/oversized-frame guard. A
     * lookup that throws — the membership read failing, say — is `unavailable` too,
     * never a `refused` or an empty `ok` the asker would wait ten minutes on.
     */
    private handleStream;
    /** Read and decide one inbound request; any failure becomes an `unavailable` response. */
    private answerStream;
    /**
     * Decide the response for a decoded request. Exposed (not private) so the
     * decision matrix can be unit-tested directly (mirrors wake's
     * `processWakeRequest`).
     *
     * - Non-member sender → `refused`, no delegate grant.
     * - Member request carrying a `delegatePeerId` → recorded via
     *   {@link StrandAddrServiceOptions.onDelegateAnnounce} before the lookup.
     * - Strand not running locally → `ok` with empty `multiaddrs` (`getStrandMultiaddrs` → `[]`).
     * - Member + running strand → `ok` with the strand's live, signaling-first multiaddrs.
     *
     * A throwing `isMember` propagates; {@link handleStream} answers it `unavailable`.
     */
    processAddrRequest(request: StrandAddrRequest, remotePeerId: string): Promise<StrandAddrResponse>;
    /**
     * Validate and forward a member's delegate announcement. A malformed field
     * (unparsable peerId) and a self-announcement (`delegatePeerId` equal to the
     * announcer's own peerId — a member is admitted directly, never by grant)
     * are logged and dropped; the address lookup proceeds either way.
     */
    private recordDelegateAnnounce;
}
/** A sibling to ask for its strand address. */
export interface StrandAddrPeer {
    /** The sibling's control-network peer id (also its strand-node peer id). */
    peerId: string;
    /**
     * Pre-resolved control-network multiaddrs, used as a fallback when no control
     * connection is already open. Dialing by {@link peerId} is preferred (it
     * reuses an existing connection); these are tried only if that fails.
     */
    addrs?: Multiaddr[];
}
/** Options for {@link collectStrandAddrs}. */
export interface CollectStrandAddrsOptions {
    /**
     * The asker's declared link round trip (`NetworkConfig.linkRoundTripMs`), from which the
     * per-dial timeout is derived when {@link timeoutMs} is not given. Unset means the declared
     * default.
     */
    linkRoundTripMs?: number;
    /** Per-dial timeout in ms (default: {@link attemptTimeoutMs}). */
    timeoutMs?: number;
    /** Override the protocol id (defaults to {@link STRAND_ADDR_PROTOCOL}). */
    protocolId?: string;
    /**
     * The derived transport peerId the caller's own strand-`strandId` node runs
     * (or is about to run) as. Set on every request this collection sends, so
     * each receiver records a delegate admission grant for it — see
     * {@link StrandAddrRequest.delegatePeerId}. Omit for a pure address lookup.
     */
    delegatePeerId?: string;
}
/**
 * What asking one sibling produced, as {@link collectStrandAddrs} reports it.
 *
 * - `answered` — status `ok` with at least one address.
 * - `empty` — status `ok` with no address: the sibling does not run the strand
 *   right now, a normal steady state.
 * - `unavailable` — the sibling replied that it could not answer.
 * - `refused` — the sibling does not (yet) count the asker as an authorized member.
 * - `unreachable` — no reply at all: every dial target failed or timed out, or
 *   the reply was malformed.
 */
export type StrandAddrOutcome = 'answered' | 'empty' | 'unavailable' | 'refused' | 'unreachable';
/** Result of {@link collectStrandAddrs}. */
export interface StrandAddrCollection {
    /** Deduplicated union of every answer, signaling-first. */
    addrs: string[];
    /** One entry per candidate (self excluded), keyed by the sibling's control peerId. */
    outcomes: Map<string, StrandAddrOutcome>;
}
/**
 * Client side: ask each candidate sibling for its live strand-`strandId`
 * multiaddrs and return the **deduplicated union** of every answer, ordered
 * signaling-first, alongside each sibling's {@link StrandAddrOutcome}.
 *
 * Best-effort per peer: a failed/timed-out/empty sibling contributes no address
 * and never fails the collection — an empty union (no sibling online or running
 * the strand) is an acceptable seed that self-heals on the next resume/reconcile
 * pass. `outcomes` is what lets a caller retry the siblings that could not answer
 * sooner than the ones that answered with nothing. The local node (`node.peerId`)
 * is excluded so we never RPC ourselves or seed with our own strand address.
 *
 * Dials run concurrently but the union preserves candidate order, so the result
 * is deterministic regardless of which sibling answers first.
 */
export declare function collectStrandAddrs(node: Libp2p, peers: StrandAddrPeer[], strandId: string, options?: CollectStrandAddrsOptions): Promise<StrandAddrCollection>;
