/**
 * webrtc-turn-tracker.ts — observe whether ICE selected a TURN relay candidate
 * for each WebRTC session, so a TURN-relayed `/webrtc` connection can be
 * reclassified `relayed`/`webrtc-turn` instead of silently counted `direct`.
 *
 * `@libp2p/webrtc` keeps the underlying `RTCPeerConnection` private and never
 * surfaces it on the libp2p `Connection`, so the multiaddr classifier
 * (`connection-path.ts`) cannot see the ICE candidate types. This tracker hooks
 * `globalThis.RTCPeerConnection` at install time: every connection that reaches
 * `connectionState === 'connected'` is inspected via `getStats()`, and the
 * relay/not-relay verdict for the selected candidate pair is pushed onto a FIFO
 * queue. {@link CadreNode} drains that queue on each `connection:open` to tag the
 * matching peer (see {@link consume}).
 *
 * The correlation between a queued settlement and a `connection:open` is
 * timing-based and best-effort — it degrades gracefully (unknown → treated as not
 * relayed, a safe default that never produces a false `relayed`). It is inert on
 * Node.js / any runtime with no `RTCPeerConnection`.
 */
import debug from 'debug';
const log = debug('sereus:cadre:turn-tracker');
/**
 * Hard cap on the FIFO queue. In steady state every settlement is consumed by a
 * `connection:open`, so the queue stays tiny; the cap only bounds a pathological
 * leak (settlements that never get a matching consume).
 */
const MAX_QUEUE = 64;
export class TurnRelayTracker {
    constructor() {
        this.queue = [];
        /** One settlement record per connection; guards against repeated `connected` events. */
        this.observed = new WeakSet();
    }
    /**
     * Wrap `globalThis.RTCPeerConnection` with a subclass that records each
     * connection's TURN-relay verdict when it settles. Idempotent. A NOP when no
     * `RTCPeerConnection` exists (Node.js / no WebRTC polyfill) — the tracker stays
     * inert and {@link consume} always returns `null`.
     */
    install() {
        if (this.OriginalRTCPeerConnection) {
            return; // already installed
        }
        const Original = globalThis.RTCPeerConnection;
        if (typeof Original !== 'function') {
            log('install: no globalThis.RTCPeerConnection — tracker inert (Node.js / no polyfill)');
            return;
        }
        this.OriginalRTCPeerConnection = Original;
        // eslint-disable-next-line @typescript-eslint/no-this-alias
        const tracker = this;
        class TrackedRTCPeerConnection extends Original {
            constructor(...args) {
                super(...args);
                try {
                    this.addEventListener('connectionstatechange', () => {
                        try {
                            if (this.connectionState === 'connected' && !tracker.observed.has(this)) {
                                tracker.observed.add(this);
                                void tracker.recordSettlement(this);
                            }
                        }
                        catch (error) {
                            log('connectionstatechange handler failed: %o', error);
                        }
                    });
                }
                catch (error) {
                    log('install: failed to attach connectionstatechange listener: %o', error);
                }
            }
        }
        globalThis.RTCPeerConnection = TrackedRTCPeerConnection;
        log('install: wrapped globalThis.RTCPeerConnection');
    }
    /**
     * Pop the most recent settled entry within `windowMs` ms of now, returning its
     * relay verdict (`true`/`false`); `null` when the queue has no matching entry.
     * Also prunes entries older than the window (they can never match a later
     * consume). Synchronous and safe to call from a `connection:open` handler.
     */
    consume(windowMs) {
        const now = Date.now();
        let result = null;
        // Walk newest → oldest; the most recent in-window settlement is the best
        // correlation for a just-opened connection.
        for (let i = this.queue.length - 1; i >= 0; i--) {
            if (now - this.queue[i].settledAtMs <= windowMs) {
                result = this.queue[i].isRelay;
                this.queue.splice(i, 1);
                break;
            }
        }
        this.pruneOlderThan(now - windowMs);
        return result;
    }
    /** Restore the original `RTCPeerConnection` and clear the queue. Idempotent. */
    dispose() {
        if (this.OriginalRTCPeerConnection) {
            globalThis.RTCPeerConnection = this.OriginalRTCPeerConnection;
            this.OriginalRTCPeerConnection = undefined;
        }
        this.queue.length = 0;
    }
    /**
     * Inspect a settled connection's stats and queue its TURN-relay verdict. Any
     * failure (stats API absent, rejected promise, malformed report) is caught and
     * recorded as `isRelay: false` — the safe default (unknown → not relayed) keeps
     * the connection counted rather than dropping it.
     */
    async recordSettlement(pc) {
        // Defaults to not-relayed (the safe "unknown" verdict); only the success path
        // below overrides it, so a getStats failure leaves it false.
        let isRelay = false;
        try {
            const report = await pc.getStats();
            isRelay = selectedCandidatePairIsRelay(statsToMap(report));
        }
        catch (error) {
            log('recordSettlement: getStats failed, keeping not-relayed default: %o', error);
        }
        this.queue.push({ settledAtMs: Date.now(), isRelay });
        if (this.queue.length > MAX_QUEUE) {
            this.queue.shift();
        }
    }
    /** Drop queued entries settled before `cutoffMs` (the queue is in push order). */
    pruneOlderThan(cutoffMs) {
        while (this.queue.length > 0 && this.queue[0].settledAtMs < cutoffMs) {
            this.queue.shift();
        }
    }
}
/** Materialise an `RTCStatsReport` into a plain map keyed by stats id. */
function statsToMap(report) {
    const map = new Map();
    report.forEach((value, key) => {
        map.set(key, value);
    });
    return map;
}
/**
 * Whether the selected ICE candidate pair used a TURN relay candidate on either
 * end. The pair is the transport's `selectedCandidatePairId` when present, else
 * the nominated succeeded pair, else any succeeded pair.
 */
function selectedCandidatePairIsRelay(stats) {
    const pair = findSelectedPair(stats);
    if (!pair) {
        return false;
    }
    const local = pair.localCandidateId ? stats.get(pair.localCandidateId) : undefined;
    const remote = pair.remoteCandidateId ? stats.get(pair.remoteCandidateId) : undefined;
    return isRelayCandidate(local) || isRelayCandidate(remote);
}
function isRelayCandidate(stat) {
    return stat?.type === 'local-candidate' || stat?.type === 'remote-candidate'
        ? stat.candidateType === 'relay'
        : false;
}
function findSelectedPair(stats) {
    const selectedId = selectedPairIdFromTransport(stats);
    if (selectedId) {
        const stat = stats.get(selectedId);
        if (stat?.type === 'candidate-pair') {
            return stat;
        }
    }
    let succeeded;
    for (const stat of stats.values()) {
        if (stat.type !== 'candidate-pair') {
            continue;
        }
        const pair = stat;
        if (pair.state !== 'succeeded') {
            continue;
        }
        if (pair.nominated) {
            return pair; // nominated succeeded pair wins outright
        }
        succeeded ?? (succeeded = pair);
    }
    return succeeded;
}
function selectedPairIdFromTransport(stats) {
    for (const stat of stats.values()) {
        if (stat.type === 'transport') {
            const id = stat.selectedCandidatePairId;
            if (typeof id === 'string') {
                return id;
            }
        }
    }
    return undefined;
}
//# sourceMappingURL=webrtc-turn-tracker.js.map