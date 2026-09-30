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
export declare class TurnRelayTracker {
    private readonly queue;
    private OriginalRTCPeerConnection;
    /** One settlement record per connection; guards against repeated `connected` events. */
    private readonly observed;
    /**
     * Wrap `globalThis.RTCPeerConnection` with a subclass that records each
     * connection's TURN-relay verdict when it settles. Idempotent. A NOP when no
     * `RTCPeerConnection` exists (Node.js / no WebRTC polyfill) — the tracker stays
     * inert and {@link consume} always returns `null`.
     */
    install(): void;
    /**
     * Pop the most recent settled entry within `windowMs` ms of now, returning its
     * relay verdict (`true`/`false`); `null` when the queue has no matching entry.
     * Also prunes entries older than the window (they can never match a later
     * consume). Synchronous and safe to call from a `connection:open` handler.
     */
    consume(windowMs: number): boolean | null;
    /** Restore the original `RTCPeerConnection` and clear the queue. Idempotent. */
    dispose(): void;
    /**
     * Inspect a settled connection's stats and queue its TURN-relay verdict. Any
     * failure (stats API absent, rejected promise, malformed report) is caught and
     * recorded as `isRelay: false` — the safe default (unknown → not relayed) keeps
     * the connection counted rather than dropping it.
     */
    private recordSettlement;
    /** Drop queued entries settled before `cutoffMs` (the queue is in push order). */
    private pruneOlderThan;
}
