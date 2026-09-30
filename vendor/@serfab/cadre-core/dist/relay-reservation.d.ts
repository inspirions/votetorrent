/**
 * Relay reservation for nodes that reserve through the SEARCH listen addr — the
 * dial, the explicit reservation request, the retry loop that keeps it, and the
 * (live) status derivation.
 *
 * `@libp2p/circuit-relay-v2`'s listener branches on the SHAPE of the listen
 * address:
 *
 * | listen addr                                       | libp2p behaviour                                                                     | unreachable relay          |
 * | ------------------------------------------------- | ------------------------------------------------------------------------------------ | -------------------------- |
 * | `<dial addr>/p2p/<relayPeerId>/p2p-circuit`        | CONFIGURED reservation: dial that exact relay and reserve, or fail                     | `listen()` throws          |
 * | bare `/p2p-circuit`                                | SEARCH mode: register a pending reservation, to be filled by relay discovery           | nothing throws, no reserve |
 *
 * A search listener needs someone to (a) dial the relay and (b) fill the pending
 * reservation it created, then report whether one actually landed. That is this
 * module. It is **fail-soft by construction**: nothing here throws.
 *
 * EVERY cadre CONTROL node now takes that route — `network.relayAddrs` resolves
 * to the bare search entry (`relay-addrs.ts` → `resolveListenAddrs`) and
 * `CadreNode.start()` drives this module once the control database is up. The
 * configured shape would dial the relay from inside `libp2p.start()`, putting a
 * sibling in this node's cohort before its own control database existed, and a
 * sibling that has not yet replicated this node's `CadrePeer` row correctly
 * refuses its control-DB streams — which killed `start()` outright.
 *
 * So the two shapes are no longer alternative ROUTES, only alternative failure
 * postures on top of the same drive: a node that names `network.relayAddrs` gets
 * a `RelayReservationFailedError` out of `start()` when the first attempt lands
 * nothing (fail-fast, the operator asked for this relay), while a node that calls
 * `CadreNode.reserveRelays()` itself gets a non-`reserved` status and stays up
 * (fail-soft, the browser-tab posture). `network.requireRelay: false` gives a
 * CONFIGURED relay the fail-soft posture too, for a node that must boot with no
 * network at all — same drive, same supervisor, only the throw is dropped.
 * Configuring both is now redundant, not fatal.
 *
 * STRAND nodes take the same route, ONE supervisor PER RELAY
 * (`strand-instance-manager.ts` → `buildStrandRuntime`): each configured relay
 * gets its own bare `/p2p-circuit` listener (`strand-network-config.ts`) and its
 * own {@link superviseRelayReservation} over just that relay's addr, fail-soft
 * like the browser tab. The configured shape they used to take
 * (`<relay>/p2p-circuit`, reserved from inside `libp2p.start()`) is gone from
 * cadre-built nodes entirely, because it loses its address and never recovers in
 * three situations — the relay restarts, either side hangs up the relay
 * connection, and libp2p's OWN reservation refresh (which removes the reservation
 * before re-creating it, and a configured listener republishes only from inside
 * its own `listen()`). The last one needs no network event at all: at the relay
 * default TTL of two hours every configured-shape node went undialable ~1 h 55 min
 * after reserving. A search listener republishes on `relay:created-reservation`
 * for its own pending id, which the refresh re-queues, and the supervisor covers
 * the other two.
 *
 * Because a strand node runs one supervisor per relay, "is the reservation held"
 * is asked PER RELAY ({@link circuitMultiaddrsVia}): relay X's supervisor must not
 * be satisfied by relay Y's circuit addr, or it would never re-drive X.
 *
 * ⚠️ WHY THE RESERVATION IS REQUESTED EXPLICITLY RATHER THAN LEFT TO DISCOVERY.
 * libp2p fills a search listener's pending reservation from `RelayDiscovery`,
 * which nominates a peer only once it can see the relay-hop protocol id in that
 * peer's PEER-STORE protocol list — and that list is written exclusively by the
 * IDENTIFY handshake. `@optimystic/db-p2p` gives every cadre node a
 * network-namespaced identify protocol id (`/optimystic/control-<partyId>/id/1.0.0`)
 * while the relay `ops/docker/libp2p-infra` deploys runs stock identify
 * (`/ipfs/id/1.0.0`), so the two never identify each other, the peer store stays
 * empty of protocols, and discovery never nominates the relay. The TCP/WebSocket
 * connection itself is fine, which is why leaving it to discovery surfaced as a
 * generic timeout.
 *
 * Identify is incidental to relaying, though: the reservation
 * (`/libp2p/circuit/relay/0.2.0/hop`), a third peer's CONNECT through the relay,
 * and the STOP handler on this node all use STOCK, un-namespaced protocol ids the
 * deployed relay already serves. Discovery's only job is to GUESS which connected
 * peer is a relay, and this module does not need to guess — it was handed the
 * relay's address. So it asks the relay for a slot directly, via the
 * circuit-relay transport's own reservation store.
 *
 * Status is derived from the node's LIVE multiaddrs on every read rather than
 * cached at drive time: when a relay restarts or the connection drops, libp2p's
 * listener clears its listening addrs and the circuit multiaddr disappears, so a
 * cached snapshot would keep claiming `reserved` for a node nothing can dial.
 *
 * And because discovery is out of reach, nothing would ever ASK again either —
 * so {@link driveRelayReservation} stays a single-shot primitive and
 * {@link superviseRelayReservation} owns the retry cadence on top of it. That
 * loop is what makes a lost reservation recover without a page reload. Single-shot
 * but not unstoppable: the primitive takes an `AbortSignal` and the loop trips it
 * from `stop()`, because a drive left running against a node being torn down both
 * logs failures that read as real and — through the timers it still holds — keeps
 * the process alive for the rest of its `timeoutMs`.
 *
 * One measured refinement to "out of reach": libp2p 3.1.3's `connection.newStream`
 * records every protocol OUR OWN outbound stream negotiated into the peer store, so
 * the explicit reservation request writes the relay-hop protocol id against the
 * relay itself. From then on, discovery CAN refill a freed slot on its own — but
 * only when the relay answers at that moment (a hangup while the relay stays up;
 * measured at ~25 ms). A relay that is down when the slot frees fails that one
 * discovery attempt, which poisons the store's `relayFilter` against it, and
 * nothing in libp2p tries again: a relay RESTART still needs the supervisor, which
 * un-poisons the filter before every attempt ({@link clearRelayFilterEntry}). Two
 * mechanisms in production, one guarantee; the specs disable discovery's half
 * (`forgetRelayProtocol` in `relay-reservation.spec.ts`) so they prove the
 * supervisor's.
 */
import type { Libp2p, PeerId } from '@libp2p/interface';
/**
 * Relay-reservation posture for a node that reserves through the SEARCH listen
 * addr (bare `/p2p-circuit`) — every cadre control node, whether its relays came
 * from `network.relayAddrs` or from an explicit `CadreNode.reserveRelays()` call.
 *  - `none`     — no relay addrs supplied; the node is undialable by design.
 *  - `dialing`  — a drive is in flight.
 *  - `reserved` — the node currently holds at least one `/p2p-circuit` addr.
 *  - `retrying` — no reservation right now, but a {@link RelayReservationSupervisor}
 *                 has the next attempt scheduled. Recoverable without a caller.
 *  - `error`    — no reservation, and NOBODY IS GOING TO TRY AGAIN: no supervisor
 *                 is running (or there is no node at all).
 */
export type RelayReservationStatus = 'none' | 'dialing' | 'reserved' | 'retrying' | 'error';
export interface RelayReservationState {
    status: RelayReservationStatus;
    /** The relay multiaddrs this node was asked to reserve through. */
    addrs: string[];
    /** LIVE `/p2p-circuit` multiaddrs, recomputed on every read. */
    circuitAddrs: string[];
    error: string | null;
    /**
     * Epoch ms of the supervisor's next scheduled tick, or `null` when a drive is
     * in flight, no supervisor is running, or no addrs were supplied. A UI can turn
     * this into "reconnecting, next try in 8s" rather than showing a bare error for
     * a node that is in fact recovering.
     */
    retryAtMs: number | null;
}
/**
 * How long {@link driveRelayReservation} waits for a reservation to appear, at the DEFAULT
 * declared link round trip: `RELAY_RESERVATION_ROUND_TRIPS` (4) x `DECLARED_LINK_ROUND_TRIP_MS`
 * (3500 ms), plus 2 x `ADMISSION_DECISION_TIMEOUT_MS` (2000 ms) for a party-run relay's
 * connection and reservation decisions, = 18 000 ms (`relayReservationBudgetMs`), where it was a
 * fixed 10_000 before it was derived.
 *
 * Counted rather than chosen because this one deadline bounds the whole drive — dial the relay,
 * request the reservation, wait — and each of those costs a fixed number of exchanges, not a
 * fixed number of milliseconds. `link-budget.ts` carries the counts, the measurement behind
 * them, and what still fails at the supported link whatever this says.
 *
 * A host on a slower link moves it by declaring `NetworkConfig.linkRoundTripMs`, which both
 * call sites thread in (`CadreNode.reserveRelays` for the control node,
 * `StrandInstanceManager`'s per-relay supervisors for a strand). This constant is the fallback
 * for a caller that declares nothing.
 */
export declare const DEFAULT_RELAY_RESERVE_TIMEOUT_MS: number;
export declare const DEFAULT_RELAY_RESERVE_POLL_MS = 250;
export interface RelayReserveOptions {
    timeoutMs?: number;
    pollMs?: number;
    /**
     * Ends an in-flight drive early. Aborting is not a failure: the drive returns
     * `{ error: null, cancelled: true }` and clears every timer it holds, so the
     * process is free to exit immediately instead of trailing the teardown that
     * cancelled it.
     */
    signal?: AbortSignal;
}
/** What one {@link driveRelayReservation} came back with. */
export interface RelayReserveResult {
    /** Why no reservation landed; `null` when one did — or when the drive was cancelled. */
    error: string | null;
    /**
     * The drive ended because its caller's `signal` tripped, not because of anything
     * the relay did. Separate from `error` because `error: null` means "a reservation
     * landed" and a cancelled drive landed nothing: folded together, a caller would
     * read cancellation as success. `cancelled: true` always implies `error: null`.
     */
    cancelled: boolean;
}
/**
 * The slice of `@libp2p/utils`' `Filter` (a cuckoo filter) that the reservation
 * store uses to remember relays whose reservation request failed. `remove` is
 * OPTIONAL on that interface, so every use here has to cope with its absence —
 * see {@link clearRelayFilterEntry}.
 */
export interface RelayFilterLike {
    has(item: Uint8Array): boolean;
    remove?(item: Uint8Array): boolean;
}
/**
 * The slice of `@libp2p/circuit-relay-v2`'s `ReservationStore` this module drives.
 * Declared structurally because the class is internal to that package: naming only
 * the members we call keeps the coupling small, explicit and greppable, and lets
 * {@link findCircuitRelayTransport} duck-type rather than brand-match.
 *
 * `relayFilter` is optional because it is not required to DRIVE a reservation,
 * only to RE-drive one (see {@link clearRelayFilterEntry}); a libp2p version that
 * renames or drops it must degrade, not break.
 */
export interface RelayReservationStoreLike {
    addRelay(peerId: PeerId, type: 'discovered' | 'configured'): Promise<unknown>;
    hasReservation(peerId: PeerId): boolean;
    relayFilter?: RelayFilterLike;
}
/** The slice of libp2p's circuit-relay transport that owns the reservation store. */
export interface CircuitRelayTransportLike {
    reservationStore: RelayReservationStoreLike;
}
/**
 * The node's `/p2p-circuit` multiaddrs — the addresses a peer can dial it at
 * while it holds a relay reservation. Empty means "not dialable via a relay
 * right now", which is exactly what makes {@link resolveRelayReservationState}
 * live rather than a stale snapshot.
 */
export declare function circuitMultiaddrs(node: Libp2p): string[];
/**
 * The node's `/p2p-circuit` multiaddrs THROUGH the relays `addrs` name — the ones
 * whose `/p2p/<relayPeerId>/p2p-circuit` component names one of them. This is the
 * "held" question a supervisor over a SUBSET of the node's relays has to ask: a
 * strand node runs one supervisor per relay, and relay X's supervisor must not be
 * satisfied by relay Y's addr, or a lost X is never re-driven.
 *
 * Falls back to EVERY circuit addr when any entry names no relay peer id (no
 * `/p2p/` component, or unparsable): such an addr can still be dialed and reserved
 * through, but the addr it earns cannot be attributed to it, so "any circuit addr"
 * is the only answer that does not mark a live reservation as lost. The control
 * node passes its whole relay list, so its answer is the same either way.
 */
export declare function circuitMultiaddrsVia(node: Libp2p, addrs: readonly string[]): string[];
/**
 * The running node's circuit-relay transport, or `null` when it has none.
 *
 * There is no public libp2p API for "reserve on THIS specific relay", so this
 * reaches through `node.components.transportManager` — libp2p's internal layout.
 * That coupling is deliberate and bounded: every step is optional-chained and the
 * whole thing returns `null` rather than throwing, and a spec pins the seam so a
 * libp2p upgrade that moves it fails loudly instead of silently reverting this
 * module to the discovery wait that never fires.
 */
export declare function findCircuitRelayTransport(node: Libp2p): CircuitRelayTransportLike | null;
/**
 * Dial every relay in `addrs`, ask the first one that answers for a reservation
 * slot, then wait until a `/p2p-circuit` address appears.
 *
 * Never throws — a dial rejection, a rejected reservation, a MALFORMED address,
 * or a timeout all come back as an `error` string. A dial that throws does NOT
 * cost the rest of the list: one dead relay among two must not cost the
 * reservation on the live one, so every addr is dialed and the first error (in
 * list order) is kept. A reservation that lands wins over any earlier error
 * (`error: null`).
 *
 * `timeoutMs` bounds the WHOLE drive — dials, reservation requests and the wait
 * share one deadline. `opts.signal` bounds it from the other side: every phase
 * below returns as soon as it trips, and the drive reports `cancelled` rather than
 * inventing a failure for a relay that was never given a chance to answer.
 */
export declare function driveRelayReservation(node: Libp2p, addrs: readonly string[], opts?: RelayReserveOptions): Promise<RelayReserveResult>;
/** Gap between liveness checks while a reservation is held. */
export declare const DEFAULT_RELAY_CHECK_MS = 5000;
/** Backoff before the first re-drive after a failed attempt. */
export declare const DEFAULT_RELAY_MIN_BACKOFF_MS = 2000;
/** Ceiling the backoff doubles up to. */
export declare const DEFAULT_RELAY_MAX_BACKOFF_MS = 60000;
/**
 * Everything one drive takes, minus its `signal`, plus the loop's own cadence.
 *
 * `signal` is omitted rather than inherited because these options are handed
 * straight to every drive: a caller-supplied one would cancel each attempt without
 * the loop knowing, leaving it to reschedule drives that return immediately and
 * forever. The way to cancel a supervisor is
 * {@link RelayReservationSupervisor.stop}, which owns the signal it passes down.
 */
export interface RelayReservationSupervisorOptions extends Omit<RelayReserveOptions, 'signal'> {
    /** Gap between liveness checks while a reservation is held. Default 5_000. */
    checkMs?: number;
    /** Backoff before the first re-drive after a failure. Default 2_000. */
    minBackoffMs?: number;
    /** Backoff ceiling. Default 60_000. */
    maxBackoffMs?: number;
    /**
     * Awaited before every drive AFTER the first — never before the first attempt,
     * which the caller has typically prepared for already. A hook that throws or
     * rejects is logged and the drive still runs: the hook is preparation, and a
     * failed preparation must not cost the attempt itself.
     *
     * What a strand node uses it for: re-announcing its delegate peer id to the relay
     * about to be re-dialed. A party control node running the relay server admits a
     * strand node on an in-memory delegate grant, and a relay restart drops every
     * grant it held — so a re-drive that did not re-announce first would be denied
     * at the relay's connection gate.
     */
    beforeRedrive?: () => Promise<void> | void;
}
/**
 * A running retry loop for one node + relay list. Obtained from
 * {@link superviseRelayReservation}; its only imperative is {@link stop}.
 */
export interface RelayReservationSupervisor {
    /**
     * Resolves once the FIRST attempt has settled — so a caller can await startup
     * exactly as it awaited a single {@link driveRelayReservation}, and the retries
     * carry on in the background afterwards. Also resolves on {@link stop}, so an
     * awaiting caller is never left hanging.
     */
    readonly firstAttempt: Promise<void>;
    /** True while a drive is in flight. */
    readonly driving: boolean;
    /** Epoch ms of the next scheduled tick; `null` while a drive is running. */
    readonly retryAtMs: number | null;
    /** Reason the last drive produced no reservation; `null` once one is held. */
    readonly lastError: string | null;
    /**
     * Idempotent. Clears the timer so no further drive is scheduled, and CANCELS the
     * drive already in flight: it stops dialing or polling, clears every timer it
     * holds and reports `cancelled`, so a teardown does not trail an attempt against
     * the node it is dismantling. That result is discarded — a cancelled drive is
     * not a failure — and nothing follows it.
     */
    stop(): void;
}
/**
 * Keep asking for a relay reservation until one is held, then keep watching that
 * it still is — the thing that makes a lost reservation recover on its own.
 *
 * Needed because nothing else re-drives: libp2p re-fills a search listener's
 * freed slot from relay DISCOVERY, and a cadre node's namespaced identify puts
 * discovery permanently out of reach (see the module header). Without this loop a
 * relay restart left a browser tab undialable until the user reloaded the page.
 *
 * Per tick:
 *  - a reservation is held → reset the backoff, clear the error, re-check in
 *    `checkMs`. No drive: a healthy node must not re-request every few seconds.
 *  - otherwise → un-poison the reservation store's relay filter (see
 *    {@link clearRelayFilterEntry}) and run ONE {@link driveRelayReservation}.
 *    If that lands a reservation, rejoin the healthy path above; if not, sleep
 *    the current backoff and double it up to `maxBackoffMs`.
 *
 * "Held" is judged PER RELAY — a circuit addr through one of `addrs`' relays
 * ({@link circuitMultiaddrsVia}) — so several loops over one node, one relay each
 * (a strand node), each re-drive exactly the relay they own. Every drive after the
 * first is preceded by the optional `beforeRedrive` hook
 * ({@link RelayReservationSupervisorOptions}).
 *
 * Starts immediately; the first tick runs before this returns.
 */
export declare function superviseRelayReservation(node: Libp2p, addrs: readonly string[], opts?: RelayReservationSupervisorOptions): RelayReservationSupervisor;
/**
 * Forget that `addr`'s peer ever failed a reservation request, so the next
 * attempt is actually made rather than refused out of hand.
 *
 * `ReservationStore` records a peer in `relayFilter` when its reservation request
 * fails with `DialError` or `UnsupportedProtocolError`, and NOTHING on that path
 * ever clears it: the reset lives in `#checkReservationCount`, which only runs
 * when a reservation is genuinely removed, and `#removeReservation` early-returns
 * when there was never one. So a relay that was briefly not-a-relay (or died
 * between our dial and the hop request) stays permanently rejected with
 * `The relay was previously invalid` — measured, not inferred.
 *
 * Fails soft in every direction: no `relayFilter`, no `remove`, an addr with no
 * peer id, a malformed addr — all mean "no un-poisoning", never a throw. The
 * retry loop still recovers the common case without this, because a relay that is
 * simply DOWN fails our own dial first and never reaches the filter.
 *
 * Returns whether an entry was actually removed (for specs; callers ignore it).
 */
export declare function clearRelayFilterEntry(store: RelayReservationStoreLike, addr: string): boolean;
/**
 * Derive the reservation posture, reading the node's circuit addrs LIVE. Pure
 * apart from that read, so the precedence is testable on its own:
 *
 * | condition                | status                                          |
 * | ------------------------ | ----------------------------------------------- |
 * | no addrs supplied        | `none`                                          |
 * | live circuit addrs held  | `reserved` (`error: null`)                      |
 * | a drive is in flight     | `dialing`                                       |
 * | a retry is scheduled     | `retrying`                                      |
 * | otherwise                | `error`                                         |
 *
 * `reserved` is checked BEFORE `error` on purpose: the circuit addrs are read
 * live, so a reservation that lands by ANY route supersedes a stale error string
 * without a second drive.
 *
 * `retrying` sits between the two so that `error` carries a sharper meaning:
 * NOBODY IS GOING TO TRY AGAIN. A lost reservation does come back on its own now,
 * as long as a {@link RelayReservationSupervisor} is running — that loop is the
 * only thing that re-drives, since libp2p re-fills a search listener's freed slot
 * from relay DISCOVERY, which a cadre node's namespaced identify puts permanently
 * out of reach (see the module header). So `error` means the supervisor was
 * stopped, was never started, or there is no node at all.
 *
 * `retryAtMs` is the supervisor's next scheduled tick (`null` while a drive runs
 * or when there is no supervisor); it both selects `retrying` and is passed
 * through so a UI can count down to the next attempt.
 */
export declare function resolveRelayReservationState(node: Libp2p | null, addrs: readonly string[], lastError: string | null, driving: boolean, retryAtMs: number | null): RelayReservationState;
