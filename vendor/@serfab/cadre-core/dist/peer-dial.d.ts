/**
 * Dialing one peer from a list of candidate addresses, so that an address that
 * never answers cannot use up the time the others needed.
 *
 * libp2p's own multi-address dial (`libp2p.dial(addrs)`, libp2p 3.1.3's
 * `DialQueue.dialPeer`) tries the addresses ONE AT A TIME under ONE signal, with
 * no time limit per address. An address whose connection attempt is silently
 * dropped — a firewall, a subnet the dialer cannot route to, a virtual adapter's
 * address a Windows host reports alongside its real ones — holds that dial until
 * the whole signal expires, and every address sorted after it is never tried. It
 * also sorts the list itself (`defaultAddressSorter`), putting loopback addresses
 * last, behind exactly the LAN addresses most likely to be dropped. A phone
 * borrowing a node from a cadre-host whose only reachable address was the
 * forwarded loopback one never connected for this reason.
 *
 * So the addresses are dialed here, each as its own `dial()` with its own time
 * limit ({@link PeerDialBudget.perAddressMs}), inside a limit for the whole peer
 * ({@link PeerDialBudget.totalMs}). One address per call also means libp2p's
 * sorter has nothing to reorder, so the order is chosen here
 * ({@link directBeforeRelayed}).
 *
 * Dependency-free apart from `control-stream.ts`, so any module may import it
 * without creating an import cycle.
 */
import type { Connection, PeerId } from '@libp2p/interface';
import type { Multiaddr } from '@multiformats/multiaddr';
/**
 * Default limit on ONE address's dial attempt, in ms, at the DEFAULT declared link round trip:
 * `RELAYED_DIAL_ROUND_TRIPS` (4) x `DECLARED_LINK_ROUND_TRIP_MS` (3500 ms) plus the called
 * machine's `ADMISSION_DECISION_TIMEOUT_MS` (2000 ms) = 16 000 ms (`relayedDialBudgetMs`). It
 * was a fixed 8000 ms before it was derived.
 *
 * It has to cover the slowest address that should succeed, because an attempt
 * that needs longer fails the same way on every retry. That is a relayed dial on
 * a mobile link: connect to the relay (transport, encryption and multiplexer
 * handshakes, when no relay connection is open yet), open the circuit, then run
 * both handshakes again end to end through the relay. `link-budget.ts` is where that
 * reasoning is now a measured count instead of an estimate — four link round trips, measured at
 * 12 094 ms on a link whose round trip is 3 s — so the value MOVES with a host's
 * `NetworkConfig.linkRoundTripMs` rather than pinning the band this node can reach to whatever
 * number was typed here. A direct dial that works is far quicker — a phone's WebSocket dial to
 * a node forwarded over `adb reverse` measured 1.6 s end to end.
 *
 * Deriving it rather than leaving it fixed is deliberate: at 8000 ms fixed, the per-address
 * limit — not libp2p's own 10 s dial timeout — was the first thing to cut a relayed dial off,
 * from about 1000 ms of one-way link delay upward. Nothing said so, and a reader raising
 * `DEFAULT_CONTROL_COHORT_DIAL_TIMEOUT_MS` below would not have found it.
 *
 * NOTE: a `/p2p-circuit/webrtc` address also negotiates a WebRTC session after
 * the relay leg. If such dials are ever seen failing at exactly this limit, raise
 * the declared link round trip (or `network.controlCohort.perAddressDialTimeoutMs` on the
 * affected nodes) rather than the per-peer limit, which cannot help an address that is itself
 * cut off.
 *
 * Override per node with `network.controlCohort.perAddressDialTimeoutMs`.
 */
export declare const DEFAULT_CONTROL_COHORT_PER_ADDRESS_DIAL_TIMEOUT_MS: number;
/**
 * How many whole per-address dial attempts {@link DEFAULT_CONTROL_COHORT_DIAL_TIMEOUT_MS}
 * budgets for: the address that works plus the three dead ones a lent cadre-host node is
 * observed to report ahead of it (loopback and LAN WebSocket addresses, plus virtual adapters).
 */
export declare const CONTROL_COHORT_DIAL_ADDRESS_ATTEMPTS = 4;
/**
 * Default limit on dialing ONE peer — every candidate address together — in ms.
 *
 * Without it, an offline peer costs (address count × up to
 * {@link DEFAULT_CONTROL_COHORT_PER_ADDRESS_DIAL_TIMEOUT_MS}), a number that
 * depends on how many addresses the peer happens to report. Callers dial peers
 * one after another (the control-cohort reconcile pass dials each sibling in
 * turn), so that cost also delays every later peer. With the limit, a reconcile
 * pass costs at most (dialed siblings) × this.
 *
 * Sized to fit a typical list with dead addresses ahead of the one that works:
 * a lent cadre-host node reports two to four addresses a phone can dial
 * (loopback and LAN WebSocket addresses, plus any virtual adapters). So it is
 * {@link CONTROL_COHORT_DIAL_ADDRESS_ATTEMPTS} whole per-address budgets — three silently
 * dropped addresses, then the one that works, each getting the FULL per-address limit. A peer
 * whose working address sits behind four or more dropped ones does not fit, and fails each pass
 * the same way; if that shows up, the remedy is ordering (try the address that last connected
 * first), not a larger number here.
 *
 * Counted as whole per-address budgets rather than the flat 30_000 it was before, because the
 * old number left only 6 s after three dropped addresses — enough for the 1.6 s direct dial the
 * phone measured, but NOT for the relayed dial the per-address limit is sized to cover. A peer
 * whose only working address was a relayed one behind two dead ones therefore could not be
 * dialled at all, and the arithmetic in this comment was what said otherwise.
 *
 * Override per node with `network.controlCohort.dialTimeoutMs` — tests that
 * drive dead addresses on purpose set it low so a pass's duration is a chosen
 * number rather than a transitive libp2p default stretched by machine load.
 */
export declare const DEFAULT_CONTROL_COHORT_DIAL_TIMEOUT_MS: number;
/** Time limits for dialing one peer from a list of candidate addresses. */
export interface PeerDialBudget {
    /** Limit on one address's attempt, in ms. */
    perAddressMs: number;
    /** Limit on the whole peer — every address together — in ms. */
    totalMs: number;
}
/** {@link PeerDialBudget} built from the two defaults above. */
export declare const DEFAULT_PEER_DIAL_BUDGET: Readonly<PeerDialBudget>;
/** The slice of a libp2p node {@link dialPeerAddrs} uses. */
export interface AddrDialer {
    /** This node's id, to recognise an address that relays through this node ({@link relaysThrough}). */
    readonly peerId: PeerId;
    dial(addr: Multiaddr, options: {
        signal: AbortSignal;
    }): Promise<Connection>;
}
/**
 * Thrown by {@link dialPeerAddrs} when it was given addresses but every one reaches the peer by
 * relaying through this node, so none was dialed.
 *
 * This is where a relay lands for a peer that holds a reservation on it (a phone, or any node that
 * cannot listen): the address that peer publishes is `/<relay transport>/p2p/<relay>/p2p-circuit/p2p/<peer>`,
 * and dialing it from the relay itself fails with libp2p's `Can not dial self`. Nothing this node
 * does can repair it; once the peer's connection drops, only the peer can reconnect. Callers log it
 * as that rather than as a dial failure.
 */
export declare class SelfRelayOnlyError extends Error {
    constructor(label: string);
}
/**
 * Dial one peer from `addrs`, one address per `dial()` call, and return the
 * first connection that forms. Direct addresses are tried before relayed ones
 * ({@link directBeforeRelayed}); otherwise the given order is kept.
 *
 * Addresses that relay through this node are dropped first ({@link relaysThrough}):
 * dialing one could only fail with `Can not dial self`. When that leaves nothing
 * of a non-empty list, this throws {@link SelfRelayOnlyError} without dialing.
 *
 * Addresses naming a transport this node lacks are not filtered out first: a
 * one-address `dial()` rejects those at once (`NoValidAddressesError`), so they
 * cost a log line, not time.
 *
 * Otherwise throws when no address connects — see {@link tryAddrsInTurn} for the error.
 *
 * @param label Names the dial in timeout messages and logs, e.g.
 *   `reconcileControlCohort dial of sibling <peerId>`; each attempt reads
 *   `<label> via <addr>`.
 */
export declare function dialPeerAddrs(dialer: AddrDialer, addrs: readonly Multiaddr[], budget: PeerDialBudget, label: string): Promise<Connection>;
/**
 * Run `attempt` against each address in the given order until one succeeds, and
 * return its result.
 *
 * Each attempt is limited to `budget.perAddressMs`, or to whatever remains of
 * `budget.totalMs` when that is less. The attempt's signal is aborted when its
 * limit passes, so a dial in progress is cancelled rather than left running.
 * Addresses the total leaves no time for are reported as not tried.
 *
 * Throws when every address fails. With one address the error is that attempt's
 * own, unchanged. With several it is one error naming each address and why it
 * failed, in order, with the first failure as `cause` — so the report shows the
 * address that mattered, not only whichever happened to be tried last.
 *
 * Between attempts this waits for one macrotask (`setTimeout(0)`). libp2p's dial
 * queue lets a new `dial()` join any queued dial job for the same peer id
 * WITHOUT checking whether that job has already finished, and an aborted job
 * leaves the queue a few microtasks after its callers are rejected. Timing out
 * one address and immediately dialing the next for the same peer therefore
 * joins the dying job, which rejects the new dial with `AbortError` before it
 * touches the network — the next address is never tried. Seen against libp2p
 * 3.1.3; `test/peer-dial.spec.ts` dials real nodes so an upgrade that changes it
 * shows up there. All of the queue's cleanup runs as microtasks, so it has
 * finished by the time a macrotask runs.
 */
export declare function tryAddrsInTurn<T>(addrs: readonly Multiaddr[], budget: PeerDialBudget, label: string, attempt: (addr: Multiaddr, signal: AbortSignal, attemptMs: number) => Promise<T>): Promise<T>;
/**
 * `addrs` with every circuit-relay address (one containing `/p2p-circuit`) moved
 * after every direct one, each group keeping its given order.
 *
 * The one part of libp2p's own ordering worth keeping: a relayed connection is
 * slower and limited in how much data and time it may carry, so a direct
 * address is always worth trying first. libp2p's other rules are deliberately
 * dropped — it puts loopback addresses last and public ones before private ones,
 * which is how a forwarded loopback address ended up behind addresses that
 * never answer. With a per-address limit, trying a dead address first costs a
 * bounded amount of time, so the caller's order is the better guide.
 */
export declare function directBeforeRelayed(addrs: readonly Multiaddr[]): Multiaddr[];
