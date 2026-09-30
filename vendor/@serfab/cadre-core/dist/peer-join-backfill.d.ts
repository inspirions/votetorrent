import type { Libp2p, PeerId } from '@libp2p/interface';
import type { IPeerNetwork } from '@optimystic/db-core';
import { BlockTransferClient, type IRawStorage } from '@optimystic/db-p2p';
/**
 * The block-transfer protocol's hard cap on one length-prefixed message. Mirrors
 * `MAX_BLOCK_MESSAGE_BYTES` in `@optimystic/db-p2p`'s `protocol-limits.ts` (8 MiB), which
 * that package does not re-export from its index — keep the two in sync if upstream ever
 * changes it or starts exporting it.
 */
export declare const MAX_BLOCK_MESSAGE_BYTES: number;
/**
 * Whether an identified peer's protocol list names this network's own block-transfer
 * protocol — the one gate that decides whether {@link PeerJoinBackfill} schedules a peer at
 * all. A peer that lacks it (a bare circuit relay, a bootstrap node, a stranger the control
 * network's inbound gate admitted without membership) cannot receive a push no matter how
 * long it is dialed, since the protocol id is namespaced per network. Exported because a
 * later strand peer-address ticket's identify-driven observation needs the identical test.
 */
export declare function speaksBlockTransfer(protocols: readonly string[], protocolPrefix: string): boolean;
/**
 * Consecutive failed catch-up runs against ONE peer before the module says so on
 * `console.warn` rather than only in its DEBUG log. At the default backoff that is reached
 * about 35 seconds in (5 s + 10 s + 20 s), which is late enough to have ruled out a blip and
 * early enough to be the first thing an operator sees about a machine that is not catching up.
 */
export declare const PEER_JOIN_BACKFILL_WARN_AFTER_FAILURES = 3;
/** Tuning for the per-peer catch-up. Every field optional; defaults in {@link DEFAULT_PEER_JOIN_BACKFILL}. */
export interface PeerJoinBackfillConfig {
    /** Default true. False disables the catch-up entirely (the pre-existing behaviour). */
    enabled?: boolean;
    /** Settle time after a connection opens before catching that peer up, ms. Default 1000. */
    debounceMs?: number;
    /** Ceiling on blocks copied in one catch-up. Default 10_000. Reaching it is LOGGED, never silent. */
    maxBlocks?: number;
    /** Soft byte budget per push message. Default 1 MiB. Protocol hard cap is {@link MAX_BLOCK_MESSAGE_BYTES} (8 MiB). */
    maxChunkBytes?: number;
    /** Max blocks per push message. Default 64. */
    maxChunkBlocks?: number;
    /**
     * Per-push dial deadline, ms. Default {@link peerJoinPushBudget}'s `dialTimeoutMs` — four link
     * round trips at the declared link plus the called machine's admission decision, 16 000 ms as
     * shipped. NOT a fixed number: a relayed dial
     * costs a fixed number of exchanges, so a host on a slower link moves this (and every other
     * cadre dial budget) by declaring `NetworkConfig.linkRoundTripMs`. Naming it here still wins
     * over the derived value — `link-budget.ts` has the counts and the measurement.
     */
    dialTimeoutMs?: number;
    /**
     * Per-push response deadline, ms. Default {@link peerJoinPushBudget}'s `responseTimeoutMs` —
     * two link round trips at the declared link plus a transfer allowance for the chunk's own
     * bytes, 13 000 ms as shipped. Derived differently from {@link dialTimeoutMs} because it
     * bounds a data transfer over a connection that is already open, not a dial.
     */
    responseTimeoutMs?: number;
    /**
     * First wait before re-running a catch-up whose last run did not complete cleanly, ms.
     * Default 5000. Doubles per consecutive failure up to {@link maxRetryBackoffMs}.
     */
    retryBackoffMs?: number;
    /** Ceiling on that doubling wait, ms. Default 60_000. */
    maxRetryBackoffMs?: number;
}
/** The resolved defaults every {@link PeerJoinBackfill} starts from. */
export declare const DEFAULT_PEER_JOIN_BACKFILL: Required<PeerJoinBackfillConfig>;
/**
 * The one capability the catch-up needs from a transfer client. Structural (rather than
 * the concrete `BlockTransferClient`) so unit tests can capture pushes without dialing
 * libp2p — see {@link PeerJoinBackfillDeps.createPushClient}.
 */
export type PeerJoinBackfillPushClient = Pick<BlockTransferClient, 'pushBlocks'>;
export interface PeerJoinBackfillDeps {
    /** Log tag naming which network this catch-up serves (a strand id, or `control-<partyId>`). */
    label: string;
    /** The libp2p node of the network being caught up — source of connection events and peer ids. */
    libp2p: Libp2p;
    /** `node.keyNetwork`, the IPeerNetwork BlockTransferClient dials through. */
    peerNetwork: IPeerNetwork;
    /** This network's own raw block store — the same instance handed to the libp2p node. */
    storage: IRawStorage;
    /** Must equal the prefix the receiver registered its handler under: `/optimystic/<networkName>`. */
    protocolPrefix: string;
    /**
     * Membership gate, consulted at PUSH time (fails closed on a throw). Absent = push to
     * every connected peer — correct for strand networks, NEVER for the control network;
     * see the module comment for why the strand no-gate argument does not carry over.
     */
    authorizePeer?: (peerId: string) => Promise<boolean>;
    /**
     * Test seam: build the per-peer push client. Defaults to a real
     * `BlockTransferClient` over {@link peerNetwork} + {@link protocolPrefix}.
     */
    createPushClient?: (peerId: PeerId) => PeerJoinBackfillPushClient;
}
/** What one peer's catch-up actually did. Returned for tests and logged at the end of each run. */
export interface PeerJoinBackfillResult {
    /** Blocks offered: had a committed `latest` AND materialized content locally. */
    offered: number;
    /** Blocks the remote reported it persisted. */
    accepted: number;
    /** Block ids the remote reported in `missing` (parse or persist failure on its side). */
    rejected: string[];
    /** Skipped: metadata has no `latest` (pending-only — not yet a durability claim here). */
    uncommitted: number;
    /** Skipped: `latest` exists but no materialized block is stored for that actionId. */
    unmaterialized: number;
    /** Not attempted because `maxBlocks` was reached. */
    capped: number;
    /** Skipped: a single block whose wire size alone exceeds {@link MAX_BLOCK_MESSAGE_BYTES}. */
    oversized: string[];
    /** True when the `authorizePeer` gate refused (or threw) — nothing was pushed, peer not memoized. */
    denied: boolean;
}
/**
 * Copies every block in one network's own raw store to each peer its libp2p node connects
 * to, so a peer that joined the network after blocks were committed still ends up holding
 * them physically (the receiver persists each push via `saveReplicatedBlock`, which is
 * monotonic and idempotent — crossing pushes from both ends cannot regress a revision).
 *
 * Best-effort throughout: nothing here throws into a libp2p event handler or into a
 * runtime bring-up; a failed chunk is logged and the run continues. A peer is marked
 * fully caught up ONLY after a run with no thrown chunk and an empty `missing` list, so
 * the next `peer:identify` from a peer whose catch-up failed retries it.
 */
export declare class PeerJoinBackfill {
    private readonly deps;
    private readonly config;
    private readonly createPushClient;
    private started;
    private stopped;
    /** Peers fully caught up this runtime (never retried until the runtime is rebuilt). */
    private readonly done;
    /** Peers with a catch-up currently running (suppresses concurrent duplicates). */
    private readonly inFlight;
    /**
     * Peers whose (re-)schedule arrived while their OWN run was in flight, replayed once
     * that run finishes. Load-bearing for the gated path: the gate's authorization check is
     * a control-database read, so the window between it and the run's end is wide enough for
     * the very membership commit that would have authorized the peer to land inside it —
     * dropping that schedule (rather than deferring it) leaves the denied peer waiting for a
     * reconnect, which is exactly what the re-arm exists to avoid.
     */
    private readonly rearmAfterFlight;
    /** Pending per-peer timers — the debounce, or a backoff re-arm. Cleared on stop. */
    private readonly timers;
    /** Consecutive non-clean runs per peer, cleared when one finishes cleanly. */
    private readonly failures;
    /**
     * Epoch ms before which a peer's catch-up must not be re-run, set alongside a backoff timer
     * that will run it. Its presence is what makes `peer:identify` churn free: a schedule
     * arriving inside the wait is dropped, rather than collapsing the backoff to the debounce.
     */
    private readonly retryAfter;
    /** Peers already reported on `console.warn`; reset when a run finally lands cleanly. */
    private readonly warned;
    private readonly onPeerIdentify;
    private loggedNoListBlockIds;
    constructor(deps: PeerJoinBackfillDeps, config?: PeerJoinBackfillConfig);
    /**
     * Subscribe to `peer:identify` AND schedule a catch-up for already-connected peers whose
     * stored protocols already name this network's block-transfer protocol — a peer that does
     * not speak it (a bare circuit relay, a bootstrap node) is never scheduled at all. See
     * {@link speaksBlockTransfer} and the module comment.
     */
    start(): void;
    /** Unsubscribe, clear timers; in-flight runs observe the stopped flag and bail. */
    stop(): void;
    /**
     * (Re-)schedule a debounced catch-up for every currently-connected peer whose protocols, as
     * already stored in the libp2p peer store, name this network's block-transfer protocol. A
     * peer not yet in the peer store — its identify has not finished — is left to the
     * `peer:identify` handler rather than dialed blind; one whose stored protocols are known
     * and lack ours is skipped outright. Idempotent and cheap otherwise (caught-up peers are
     * skipped before any timer is set, and a peer whose run is in flight is deferred to the end
     * of that run rather than dropped). Driven by {@link start}, and — on a gated network — by
     * the embedder whenever membership changes, so a peer whose first pass was denied (connected
     * before it was authorized: the production join order) is retried without waiting for a
     * reconnect. Returns how many distinct peers were considered (for the start() log) — a peer
     * holding several connections is one peer, and is scheduled once.
     */
    scheduleConnectedPeers(): Promise<number>;
    /** Schedules `peerId` only if the peer store already knows it speaks this network's protocol. */
    private scheduleIfKnownToSpeak;
    /** Debounced entry point for connection churn: one run per peer per settle window. */
    private schedulePeer;
    /**
     * Run one peer's catch-up now, bypassing the debounce. Never rejects. Returns an
     * all-zero result without pushing when the peer is already caught up, already being
     * caught up, or this backfill is stopped.
     */
    catchUpPeer(peerId: PeerId): Promise<PeerJoinBackfillResult>;
    /** Whether this network's libp2p node still holds a connection to that peer. */
    private isConnected;
    /**
     * Re-arm one peer's catch-up after a run whose push failed, on a wait that doubles
     * per consecutive failure up to `maxRetryBackoffMs`. Sets {@link retryAfter} alongside the
     * timer, which is what makes `peer:identify` churn inside the wait free.
     */
    private scheduleRetryWithBackoff;
    /**
     * Say ONCE per peer, outside the DEBUG log, that its catch-up is not landing. Without this a
     * machine on a link too slow for a relayed dial produces no statement that anything is wrong:
     * the peer never appears to hold the blocks, and the only trace is a DEBUG line naming a dial
     * timeout. Reset when a run finally lands cleanly, so a peer that recovers can report again.
     */
    private warnPersistentFailure;
    /**
     * The actual copy. `clean` = every chunk pushed and the remote persisted every block.
     * `pushFailed` = at least one push THREW, which is the only non-clean outcome a retry can
     * change; the others are verdicts (denied, inert store, blocks the receiver refused).
     */
    private runCatchUp;
}
