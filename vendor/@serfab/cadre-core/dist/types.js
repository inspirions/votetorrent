/**
 * Default hibernation timeouts per latency hint.
 *
 * `checkInInterval` is the BASE delay; `checkInMaxInterval` is the per-hint
 * ceiling the exponential backoff escalates toward (interactive minutes→~1h,
 * background minutes→~6h, archive ~1h→~3 days).
 */
export const HIBERNATION_TIMEOUTS = {
    realtime: {
        idleTimeout: Infinity, // Never idle
        hibernateTimeout: Infinity, // Never hibernate
        checkInInterval: Infinity, // N/A
        checkInBackoffFactor: 2,
        checkInMaxInterval: Infinity // N/A
    },
    interactive: {
        idleTimeout: 5 * 60 * 1000, // 5 minutes
        hibernateTimeout: 15 * 60 * 1000, // 15 minutes after idle
        checkInInterval: 30 * 1000, // base: 30 seconds
        checkInBackoffFactor: 2,
        checkInMaxInterval: 60 * 60 * 1000 // cap: ~1 hour
    },
    background: {
        idleTimeout: 1 * 60 * 1000, // 1 minute
        hibernateTimeout: 5 * 60 * 1000, // 5 minutes after idle
        checkInInterval: 5 * 60 * 1000, // base: 5 minutes
        checkInBackoffFactor: 2,
        checkInMaxInterval: 6 * 60 * 60 * 1000 // cap: ~6 hours
    },
    archive: {
        idleTimeout: 10 * 1000, // 10 seconds
        hibernateTimeout: 30 * 1000, // 30 seconds after idle
        checkInInterval: 60 * 60 * 1000, // base: 1 hour
        checkInBackoffFactor: 2,
        checkInMaxInterval: 3 * 24 * 60 * 60 * 1000 // cap: ~3 days
    }
};
/**
 * The connection-monitor settings every cadre node runs with when
 * {@link NetworkConfig.connectionMonitor} is unset: a 30 second ping deadline in place
 * of libp2p's 5 second one, and a 35 second gap between pings so a ping is never
 * outstanding when the next one starts.
 *
 * WHY this is a default and not opt-in. libp2p's monitor pings every connection and,
 * with its own `abortConnectionOnPingFailure: true`, aborts the connection on the FIRST
 * timeout. A peer whose event loop is saturated by pure-JS Noise crypto — a slow phone
 * under React Native, see {@link NetworkConfig.noiseCrypto} — misses that deadline while
 * perfectly healthy; the other end aborts, the peer redials, and the new handshake
 * saturates it further. Measured on gotchoices/sereus#13 at a Galaxy S7's crypto cost, a
 * two-party bring-up failed 3 of 3 runs on stock settings, with 30 `aborting connection
 * due to ping failure` entries in the relay's log for one run, and passed 4 of 4 in about
 * 90 seconds once the deadline was widened on every node. The monitor runs on BOTH ends
 * of a connection and either end's abort closes it for both, so a setting the phone alone
 * applies does not cover the peer dropping it. That is what rules out scoping this to
 * React Native.
 *
 * WHY `pingInterval` MOVES WITH THE DEADLINE, and is not left at libp2p's 10 seconds.
 * The monitor opens a ping stream per connection per interval whether or not the previous
 * ping has answered, and `/ipfs/ping/1.0.0` is registered by `@libp2p/ping` with
 * `maxOutboundStreams: 1`. A second concurrent ping stream on one connection therefore
 * fails in `Connection.newStream` with `TooManyOutboundProtocolStreamsError`, which
 * reaches the monitor's own catch and aborts the connection exactly as a timeout does. A
 * widened deadline alone is thus capped by the ping interval: measured against two local
 * libp2p 3.1.3 nodes whose ping handler answered 600ms late, an interval of 300ms with a
 * 900ms deadline aborted the connection, while a 900ms interval with the same deadline
 * kept it (the same pair aborted at a 200ms stall only when the deadline was 300ms). An
 * interval strictly above the deadline is what makes the 30 seconds real.
 *
 * WHAT THE LINK NEEDS OF IT. One ping opens a fresh stream and echoes over it: a protocol
 * negotiation plus the echo, two link round trips by `link-budget.ts`'s counts (a `newStream`
 * over a relayed circuit measured 3016 ms at 1500 ms one-way). At the slowest link sereus
 * supports, a 3-second relayed round trip, that is about 6 s — well inside the 30 s deadline,
 * which exists for the phone's CPU rather than the link.
 *
 * WHAT IT COSTS. A dead peer is reclaimed 30 to 65 seconds after it stops answering — the
 * deadline, plus up to one interval of waiting for the ping that will fail — where
 * libp2p's defaults took about 5 to 15 seconds. `db-p2p` caps a node at 16 connections,
 * so the worst case is those slots held about a minute longer than before; at that scale
 * it is not a starvation risk.
 *
 * WHY THE DEADLINE IS PINNED rather than given room to adapt. `pingTimeout` is an
 * adaptive-timeout init, and equal `minTimeout`/`maxTimeout` clamp it to one value on
 * every libp2p version. Under libp2p 3.1.3, which sereus resolves today, it is already
 * flat at `minTimeout`: `ConnectionMonitor` asks its `AdaptiveTimeout` for a deadline but
 * never calls `cleanUp` to report how long the ping took, so the moving average the
 * deadline derives from stays at zero. libp2p 3.3 does report ping durations back, and a
 * ceiling above `pingInterval` would then let the deadline grow past the interval and put
 * the overlapping-ping abort above straight back. Pinning both ends keeps the interval's
 * margin true on the version bump instead of making it something to remember. It also
 * sidesteps 3.3's other surprise: the monitor keeps one `AdaptiveTimeout` for all of a
 * node's connections, so one slow peer would otherwise lengthen the deadline for every
 * connection on that node.
 */
export const DEFAULT_CONNECTION_MONITOR = Object.freeze({
    // Strictly greater than the deadline below, so the previous ping is always resolved or
    // aborted before the next one opens a stream. `types.spec.ts` holds the two apart.
    pingInterval: 35000,
    // Frozen at both levels, as `CONTROL_CLUSTER_POLICY` is: one object reaches every
    // libp2p node this process builds, so a mutation anywhere would move the deadline
    // for all of them.
    pingTimeout: Object.freeze({ minTimeout: 30000, maxTimeout: 30000 })
});
/**
 * Default duration of the resume-and-probe window during a strand check-in.
 * See {@link HibernationConfig.checkInWindowMs}.
 */
export const DEFAULT_CHECKIN_WINDOW_MS = 15 * 1000;
/**
 * Replication-breadth constants, both networks' cluster policies, and the strand
 * resolver, re-exported so cadre embedders, the SQL plugin and the integration
 * harness share one definition. Defined in `@serfab/quereus-plugin-sereus`
 * because that package also creates libp2p nodes and cannot depend on this one.
 * The control network's breadth is fixed ({@link CONTROL_REPLICATION_BREADTH},
 * not configurable) and so is its consensus policy ({@link CONTROL_CLUSTER_POLICY}
 * — notably the super-majority threshold, which it leaves at Optimystic's default
 * by omission); the strand breadth defaults to
 * {@link CadreNodeConfig.strandClusterSize} while its policy is the fixed
 * {@link STRAND_CLUSTER_POLICY}.
 *
 * The two `*ClusterPolicy` BUILDERS are the same objects with the block-repair
 * corroboration yardstick declared from the machines enrolled in this party
 * ({@link resolveRepairYardstick}) and, if the host set one or declared its link, a
 * per-peer read deadline in place of {@link COHORT_READ_DEADLINE_MS}
 * (`declaredCohortReadDeadlineMs` in `link-budget.ts` settles which). Both arrive in one
 * named declarations object, because both are plain numbers meaning unrelated things;
 * declaring neither returns the frozen base constant unchanged. A network picks the
 * derived numbers up when its libp2p node is built, which for a strand is every wake
 * from hibernation.
 */
export { MIN_CLUSTER_SIZE, COHORT_READ_DEADLINE_MS, CONTROL_REPLICATION_BREADTH, CONTROL_CLUSTER_POLICY, DEFAULT_STRAND_CLUSTER_SIZE, STRAND_CLUSTER_POLICY, resolveStrandClusterSize, resolveRepairYardstick, controlClusterPolicy, strandClusterPolicy } from '@serfab/quereus-plugin-sereus';
/**
 * The declared link round trip every cadre-owned dial and reservation deadline is derived from,
 * re-exported beside {@link NetworkConfig.linkRoundTripMs} so a host reading the setting finds
 * the default it replaces. The counts, the measurement and the derivation live in
 * `link-budget.ts`.
 */
export { DECLARED_LINK_ROUND_TRIP_MS } from './link-budget.js';
//# sourceMappingURL=types.js.map