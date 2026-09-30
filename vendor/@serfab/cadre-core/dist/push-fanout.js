/**
 * push-fanout.ts — the server-side push-wake **trigger policy + fan-out**.
 *
 * The delivery half (`push-notifier.ts`) knows *how* to send one strand-wake to
 * one device; this module owns *who* to wake and *when*. On strand activity it
 * enumerates the cadre's hibernating mobile members, prefers a direct
 * control-network `pushWake`, falls back to FCM/APNs platform push only when the
 * direct dial cannot reach the (suspended) peer, and dedups/cooldowns per
 * `(peer, strand)` so a chatty strand cannot spam wakes.
 *
 * It owns no transport and no DB access: every node primitive (member
 * enumeration, participation check, direct dial, token resolve, stale-token
 * expiry) and the `PushNotifier` are injected, so the whole policy is unit-tested
 * with fakes and never throws to its trigger (a dropped wake is recoverable — the
 * hibernation check-in wake is the backstop).
 *
 * Cross-platform-clean by construction: it imports only the `PushNotifier`
 * *type* (erased at emit) and the dependency-free `STRAND_WAKE_TYPE` value, so it
 * carries no `node:http2`/`node:crypto` edge. The Node-only notifier is built by
 * `CadreNode` (via a guarded dynamic import) and injected here.
 */
import debug from 'debug';
import { STRAND_WAKE_TYPE } from './strand-wake-payload.js';
const log = debug('sereus:cadre:push-fanout');
/** Default per-`(peer, strand)` minimum gap between wakes. */
export const DEFAULT_PUSH_COOLDOWN_MS = 5 * 60000;
/** Default per-strand burst-coalescing window. */
export const DEFAULT_PUSH_DEBOUNCE_MS = 10000;
/**
 * Server-side push-wake fan-out (see module header). One per participating
 * {@link CadreNode}, constructed only when push credentials are configured.
 */
export class PushFanoutService {
    constructor(options) {
        /** Per-strand leading-edge debounce: last fan-out start time (epoch ms). */
        this.lastFanoutAt = new Map();
        /** Per-strand in-flight pass, so two near-simultaneous triggers coalesce into one. */
        this.inFlight = new Map();
        /** Per-`(peer, strand)` last-wake time (epoch ms); the anti-spam cooldown. */
        this.cooldownAt = new Map();
        /**
         * Peers whose `DeviceToken` a platform reported unregistered. Consulted before
         * every resolve→send so we stop pushing to a dead token. In-memory and
         * acceptably lossy: a restart re-learns staleness on the next failed send.
         */
        this.deadTokens = new Set();
        this.deps = options;
        this.now = options.now ?? (() => Date.now());
        this.cooldownMs = options.cooldownMs ?? DEFAULT_PUSH_COOLDOWN_MS;
        this.debounceMs = options.debounceMs ?? DEFAULT_PUSH_DEBOUNCE_MS;
    }
    /**
     * Fan a wake out to the cadre's hibernating mobile members for a strand that
     * just saw activity. Best-effort: never throws to the trigger (the check-in
     * wake is the backstop). No-ops when this node does not participate in the
     * strand, when the strand was already fanned out within `debounceMs`, or — by
     * joining — when a pass for the strand is already in flight.
     *
     * @param strandId - the strand whose activity should wake hibernating peers.
     * @param reason - free-form cause hint carried in the wake (default `activity`).
     */
    async notify(strandId, reason = 'activity') {
        try {
            // 1. Participation gate — never push for a strand we do not participate in.
            if (!this.deps.getStrand(strandId)) {
                log('notify: not participating in strand %s; no-op', strandId);
                return;
            }
            // Concurrent trigger coalescing: a second near-simultaneous notify joins the
            // in-flight pass rather than enumerating + sending again (mirrors
            // CadreNode.serviceWakePromises). The stored promise is guarded (see below),
            // so a joiner that adopts it via `return inflight` never observes a rejection
            // — the "never throws to the trigger" guarantee holds on the join path too
            // (a rejection here would otherwise escape this try/catch, since the returned
            // promise settles in the caller's `void notify(...)` context).
            const inflight = this.inFlight.get(strandId);
            if (inflight) {
                log('notify: joining in-flight fan-out for strand %s', strandId);
                return inflight;
            }
            // 2. Per-strand debounce — coalesce bursts after a pass has completed.
            const now = this.now();
            const last = this.lastFanoutAt.get(strandId);
            if (last !== undefined && now - last < this.debounceMs) {
                log('notify: debounced fan-out for strand %s', strandId);
                return;
            }
            this.lastFanoutAt.set(strandId, now);
            // Guard the pass so neither the originator nor a concurrent joiner can see a
            // rejection (e.g. listMembers throwing on a control-DB hiccup): a dropped
            // fan-out is recoverable via the check-in wake backstop.
            const op = this.runFanout(strandId, reason).catch((error) => {
                log('notify: fan-out pass for strand %s failed (best-effort): %o', strandId, error);
            });
            this.inFlight.set(strandId, op);
            try {
                await op;
            }
            finally {
                this.inFlight.delete(strandId);
            }
        }
        catch (error) {
            // The trigger must never see a throw — failures are logged best-effort.
            log('notify: fan-out for strand %s failed (best-effort): %o', strandId, error);
        }
    }
    /** Release the notifier's transport resources (e.g. the APNs HTTP/2 session). */
    async close() {
        await this.deps.notifier.close();
    }
    /**
     * One fan-out pass: enumerate members, drop self and any peer still cooling
     * down for this strand, and wake the survivors concurrently. Each
     * {@link wakePeer} is self-contained (never rejects), so one peer's failure
     * never aborts the others.
     */
    async runFanout(strandId, reason) {
        const members = await this.deps.listMembers();
        const self = this.deps.selfPeerId();
        const targets = members.filter((m) => m.peerId !== self && !this.isCoolingDown(m.peerId, strandId));
        log('fanout: strand %s — %d candidate(s) after self/cooldown filter', strandId, targets.length);
        await Promise.all(targets.map((m) => this.wakePeer(m.peerId, strandId, reason)));
    }
    /**
     * Wake one candidate: try the direct control-network dial first, falling back
     * to a platform push only when the dial cannot reach the (suspended) peer.
     *
     * A resolved {@link WakeAck} means the control path REACHED the peer — even an
     * ack with `accepted:false` (the receiver declined, e.g. non-member/unknown
     * strand) counts as reached, so we do NOT also send a platform push (that would
     * double-wake). Only a dial/transport REJECTION means the phone is suspended
     * and unreachable over the control network, which is the one case that falls
     * through to FCM/APNs.
     *
     * NOTE: the platform push waits for the whole direct dial to fail, up to
     * `DEFAULT_WAKE_DIAL_BUDGET_MS` (46 s at the default declared link). A suspended
     * phone typically fails its relay address fast and spends the rest on its direct
     * one. If that delay shows up, start the platform push in parallel with the dial,
     * or after its first attempt.
     */
    async wakePeer(peerId, strandId, reason) {
        // A wake of either kind is now being attempted → arm the cooldown up front.
        this.markCooldown(peerId, strandId);
        try {
            const ack = await this.deps.pushWake(peerId, strandId, reason);
            log('wakePeer: direct pushWake reached %s for strand %s (accepted=%s); no platform fallback', peerId, strandId, ack.accepted);
            return;
        }
        catch (error) {
            // Dial/transport failure ⇒ suspended phone ⇒ fall through to platform push.
            log('wakePeer: direct pushWake could not reach %s; trying platform push: %o', peerId, error);
        }
        try {
            await this.platformPush(peerId, strandId, reason);
        }
        catch (error) {
            log('wakePeer: platform push for %s failed (best-effort): %o', peerId, error);
        }
    }
    /**
     * Deliver a platform push (FCM/APNs) to a suspended peer. Skips a peer with a
     * known-dead token, no-ops for a non-mobile peer (`resolveDeviceToken` → null),
     * and — on an `unregistered` send — marks the token dead and expires the row.
     */
    async platformPush(peerId, strandId, reason) {
        if (this.deadTokens.has(peerId)) {
            log('platformPush: %s has a known-stale token; skipping resolve→send', peerId);
            return;
        }
        const record = await this.deps.resolveDeviceToken(peerId);
        if (!record) {
            log('platformPush: %s is not a registered mobile peer; no platform push', peerId);
            return;
        }
        const result = await this.deps.notifier.send({
            token: record.token,
            platform: record.platform,
            payload: { type: STRAND_WAKE_TYPE, strandId, reason },
        });
        if (!result.ok && result.unregistered) {
            // Permanently-invalid token: stop pushing to it this process (the set), and
            // expire the row (authority delete; non-authority logs re-registration).
            this.deadTokens.add(peerId);
            await this.deps.expireDeviceToken(peerId);
            log('platformPush: expired stale token for %s (platform=%s)', peerId, record.platform);
        }
    }
    /** Whether `peerId` was woken for `strandId` within `cooldownMs`. */
    isCoolingDown(peerId, strandId) {
        const last = this.cooldownAt.get(cooldownKey(peerId, strandId));
        return last !== undefined && this.now() - last < this.cooldownMs;
    }
    /** Arm the per-`(peer, strand)` cooldown at the current clock time. */
    markCooldown(peerId, strandId) {
        this.cooldownAt.set(cooldownKey(peerId, strandId), this.now());
    }
}
/** Composite key for the per-`(peer, strand)` cooldown map. */
function cooldownKey(peerId, strandId) {
    return `${peerId} ${strandId}`;
}
//# sourceMappingURL=push-fanout.js.map