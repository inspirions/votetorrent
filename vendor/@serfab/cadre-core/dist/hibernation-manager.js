import debug from 'debug';
import { HIBERNATION_TIMEOUTS } from './types.js';
const log = debug('sereus:cadre:hibernation');
/**
 * Manages strand hibernation state transitions based on activity.
 *
 * State machine:
 *   active → idle (after idleTimeout with no activity)
 *   idle → hibernating (after hibernateTimeout with no activity)
 *   idle → active (on activity)
 *   hibernating → active (on wake signal or check-in with pending activity)
 */
export class HibernationManager {
    constructor(config, callbacks) {
        this.timers = new Map();
        /**
         * Pending check-in timers, one per hibernating strand. Unlike the old fixed
         * `setInterval`, these are single-shot `setTimeout`s rescheduled by
         * {@link runCheckIn} with an escalating delay — so a long-running `onCheckIn`
         * can never overlap the next tick, and the period adapts to the backoff.
         */
        this.checkInTimers = new Map();
        /**
         * In-flight wake promises keyed by strandId. Coalesces overlapping wake
         * triggers (two near-simultaneous activities, or activity racing a force wake)
         * so `onWake` — and the libp2p-node rebuild it drives — runs at most once per
         * concurrent wake.
         */
        this.wakePromises = new Map();
        /**
         * Hibernating strands whose armed check-in a wake cancelled, held until that wake
         * settles. A failed wake re-arms the chain from here ({@link restoreCheckInChain});
         * without it the strand is left with no runtime and nothing scheduled to retry.
         */
        this.checkInsCancelledByWake = new Map();
        this.running = false;
        this.config = config;
        this.callbacks = callbacks;
        log('HibernationManager created, enabled=%s', config.enabled);
    }
    /**
     * Get effective timeouts for a latency hint
     */
    getTimeouts(hint) {
        const defaults = HIBERNATION_TIMEOUTS[hint];
        const custom = this.config.customTimeouts?.[hint];
        if (!custom)
            return defaults;
        return {
            idleTimeout: custom.idleTimeout ?? defaults.idleTimeout,
            hibernateTimeout: custom.hibernateTimeout ?? defaults.hibernateTimeout,
            checkInInterval: custom.checkInInterval ?? defaults.checkInInterval,
            checkInBackoffFactor: custom.checkInBackoffFactor ?? defaults.checkInBackoffFactor,
            checkInMaxInterval: custom.checkInMaxInterval ?? defaults.checkInMaxInterval
        };
    }
    /**
     * Start managing hibernation for all strands
     */
    start() {
        if (this.running)
            return;
        this.running = true;
        log('HibernationManager started');
    }
    /**
     * Stop managing hibernation
     */
    stop() {
        if (!this.running)
            return;
        this.running = false;
        // Clear all timers
        for (const timer of this.timers.values()) {
            clearTimeout(timer);
        }
        this.timers.clear();
        for (const { timer } of this.checkInTimers.values()) {
            clearTimeout(timer);
        }
        this.checkInTimers.clear();
        // In-flight wakes clean themselves up via their finally; drop the references
        // so a fresh start coalesces cleanly.
        this.wakePromises.clear();
        this.checkInsCancelledByWake.clear();
        log('HibernationManager stopped');
    }
    /**
     * Whether a strand with this instance's latency hint ever hibernates — `false`
     * for realtime (Infinity idle timeout, see {@link HIBERNATION_TIMEOUTS}), also
     * honouring any per-hint `customTimeouts` override. Imperative callers
     * (`CadreNode.hibernateStrand` / `hibernateAll`) use this as the single source
     * of truth for "skip realtime", consistent with {@link trackStrand} declining
     * to track Infinity-timeout strands.
     */
    hibernates(instance) {
        return this.getTimeouts(instance.latencyHint).idleTimeout !== Infinity;
    }
    /**
     * Imperatively hibernate a tracked strand now, bypassing the idle/hibernate
     * timers — the mobile background-entry path. Cancels the strand's pending
     * idle/hibernate AND check-in timers so none can later re-fire `onHibernate`
     * on the already-quiesced strand or resurrect one the caller means to keep
     * down, then invokes `onHibernate` (quiesce + mark hibernating).
     *
     * Unlike the timer path ({@link handleHibernateTimeout}) it deliberately does
     * NOT re-arm the check-in chain: a force-hibernate keeps the strand down until
     * the caller drives the next wake on demand (push-delivered on mobile), so a
     * stray check-in timer must not bring it back up.
     *
     * @returns `true` if the strand was hibernated, `false` (no-op) for a realtime
     *   strand that never hibernates.
     */
    async forceHibernate(instance) {
        if (!this.hibernates(instance)) {
            log('forceHibernate: strand %s is realtime; no-op', instance.strandId);
            return false;
        }
        // Cancel idle/hibernate + check-in timers BEFORE quiescing so nothing fights
        // the imperative hibernate (a stale hibernate timer firing on the quiesced
        // strand, or a check-in resuming a strand the caller wants kept down) — including
        // a chain an in-flight wake would restore on failure.
        this.clearTimers(instance.strandId);
        this.checkInsCancelledByWake.delete(instance.strandId);
        await this.callbacks.onHibernate(instance.strandId);
        log('forceHibernate: strand %s hibernated (timers cancelled, not re-armed)', instance.strandId);
        return true;
    }
    /**
     * Register a strand for hibernation management
     */
    trackStrand(instance) {
        if (!this.config.enabled || !this.running)
            return;
        const { strandId, latencyHint } = instance;
        const timeouts = this.getTimeouts(latencyHint);
        // Don't track strands that never hibernate
        if (timeouts.idleTimeout === Infinity) {
            log('Strand %s has realtime latency hint - no hibernation', strandId);
            return;
        }
        log('Tracking strand %s for hibernation (hint=%s)', strandId, latencyHint);
        this.scheduleIdleTransition(instance);
    }
    /**
     * Untrack a strand from hibernation management
     */
    untrackStrand(strandId) {
        this.clearTimers(strandId);
        this.checkInsCancelledByWake.delete(strandId);
        log('Untracked strand %s from hibernation', strandId);
    }
    /**
     * Record activity on a strand - resets idle timer
     */
    recordActivity(instance) {
        if (!this.config.enabled || !this.running)
            return;
        const { strandId, status, latencyHint } = instance;
        instance.lastActivity = new Date();
        // If idle or hibernating, wake up. Coalesce so two near-simultaneous
        // activities don't each fire onWake (which would rebuild two libp2p nodes).
        if (status === 'idle' || status === 'hibernating') {
            log('Activity on %s strand %s - waking', status, strandId);
            this.clearTimersForWake(strandId);
            // Fire-and-forget; force-wake awaiters see errors, so swallow (and log)
            // here to avoid an unhandled rejection on this best-effort path.
            //
            // Once the wake settles (CadreNode rebuilds the runtime and marks the
            // strand `active`), re-arm the idle→hibernate→check-in cycle. Without this
            // a strand that wakes then goes quiet stays `active` forever and never
            // re-hibernates — so the check-in backoff could never restart at base.
            // Guarded on `active` so a wake that did not transition (a coalesced
            // no-op, or a still-mid-flight rebuild) never arms a stray timer.
            void this.beginWake(strandId).then(() => {
                if (this.running && instance.status === 'active') {
                    const timeouts = this.getTimeouts(instance.latencyHint);
                    if (timeouts.idleTimeout !== Infinity) {
                        this.scheduleIdleTransition(instance);
                    }
                }
            }).catch((err) => {
                log('Activity-driven wake failed for strand %s: %o', strandId, err);
            });
            return;
        }
        // Reschedule idle transition if active
        if (status === 'active') {
            const timeouts = this.getTimeouts(latencyHint);
            if (timeouts.idleTimeout !== Infinity) {
                this.scheduleIdleTransition(instance);
            }
        }
    }
    /**
     * Force wake a hibernating strand
     */
    async wakeStrand(strandId) {
        this.clearTimersForWake(strandId);
        await this.beginWake(strandId);
    }
    /**
     * Begin a wake for a strand, or coalesce with one already in flight. Ensures
     * `onWake` runs at most once per concurrent wake — the returned promise is
     * shared by all overlapping callers and cleared once it settles. Force-wake
     * callers await it; activity-driven callers fire-and-forget. A failed wake
     * restores the check-in chain its callers cancelled, then rejects.
     */
    beginWake(strandId) {
        const existing = this.wakePromises.get(strandId);
        if (existing) {
            return existing;
        }
        const wake = (async () => {
            try {
                await this.callbacks.onWake(strandId);
            }
            catch (error) {
                this.restoreCheckInChain(strandId);
                throw error;
            }
            finally {
                this.checkInsCancelledByWake.delete(strandId);
                this.wakePromises.delete(strandId);
            }
        })();
        this.wakePromises.set(strandId, wake);
        return wake;
    }
    /**
     * {@link clearTimers} for a wake, first remembering an armed check-in so a failed wake
     * can restore the chain. Only an ARMED chain is remembered: a strand force-hibernated
     * without one (the mobile background path) must not gain one from a failed wake, and a
     * check-in that is mid-run reschedules itself once the strand reads `hibernating` again.
     */
    clearTimersForWake(strandId) {
        const pending = this.checkInTimers.get(strandId);
        if (pending) {
            this.checkInsCancelledByWake.set(strandId, pending.instance);
        }
        this.clearTimers(strandId);
    }
    /**
     * Re-arm, at the base delay, the check-in chain a failed wake's callers cancelled — only
     * while the strand reads `hibernating` again (CadreNode re-hibernates a failed wake), so
     * a strand the failure left in any other state is not probed.
     */
    restoreCheckInChain(strandId) {
        const instance = this.checkInsCancelledByWake.get(strandId);
        if (!instance || !this.running || instance.status !== 'hibernating') {
            return;
        }
        log('Wake of strand %s failed; restoring its check-in chain', strandId);
        this.scheduleCheckIn(instance);
    }
    scheduleIdleTransition(instance) {
        const { strandId, latencyHint } = instance;
        const timeouts = this.getTimeouts(latencyHint);
        // Clear existing timer
        this.clearTimer(strandId);
        // Schedule idle transition
        const timer = setTimeout(() => {
            this.handleIdleTimeout(instance);
        }, timeouts.idleTimeout);
        this.timers.set(strandId, timer);
    }
    handleIdleTimeout(instance) {
        const { strandId, latencyHint } = instance;
        if (!this.running)
            return;
        log('Idle timeout for strand %s', strandId);
        // Transition to idle. The callback can reject (e.g. a future idle handler
        // that releases resources); catch so the timer chain never unhandled-rejects.
        void this.callbacks.onIdle(strandId).then(() => {
            // Schedule hibernate transition
            const timeouts = this.getTimeouts(latencyHint);
            if (timeouts.hibernateTimeout !== Infinity) {
                this.scheduleHibernateTransition(instance);
            }
        }).catch((err) => {
            log('onIdle failed for strand %s: %o', strandId, err);
        });
    }
    scheduleHibernateTransition(instance) {
        const { strandId, latencyHint } = instance;
        const timeouts = this.getTimeouts(latencyHint);
        // Clear existing timer
        this.clearTimer(strandId);
        // Schedule hibernate transition
        const timer = setTimeout(() => {
            this.handleHibernateTimeout(instance);
        }, timeouts.hibernateTimeout);
        this.timers.set(strandId, timer);
    }
    handleHibernateTimeout(instance) {
        const { strandId, latencyHint } = instance;
        if (!this.running)
            return;
        log('Hibernate timeout for strand %s', strandId);
        // Transition to hibernating. onHibernate now releases strand-network
        // resources (quiesce), so its close()/stop() can reject — catch so a failed
        // hibernate logs instead of producing an unhandled rejection.
        void this.callbacks.onHibernate(strandId).then(() => {
            // Schedule periodic check-ins
            const timeouts = this.getTimeouts(latencyHint);
            if (timeouts.checkInInterval !== Infinity) {
                this.scheduleCheckIn(instance);
            }
        }).catch((err) => {
            log('onHibernate failed for strand %s: %o', strandId, err);
        });
    }
    /**
     * Arm the next check-in for a hibernating strand. Each call is a single-shot
     * `setTimeout` (not a fixed `setInterval`) so the period escalates per
     * {@link runCheckIn} and a slow `onCheckIn` never overlaps the next tick.
     *
     * `delay` is omitted by the chain start ({@link handleHibernateTimeout}),
     * defaulting to the base `checkInInterval` — which is why backoff naturally
     * resets to base each fresh hibernation cycle, with no per-strand counter to
     * clear on wake. Subsequent ticks pass the escalated, capped delay.
     */
    scheduleCheckIn(instance, delay) {
        const { strandId, latencyHint } = instance;
        const timeouts = this.getTimeouts(latencyHint);
        const currentDelay = delay ?? timeouts.checkInInterval;
        // Replace any existing check-in timer.
        this.clearCheckInTimer(strandId);
        const timer = setTimeout(() => {
            // Only ARMED check-ins stay in the map, so a wake during this run does not take it
            // for a chain to restore (see clearTimersForWake) — the run reschedules itself.
            this.checkInTimers.delete(strandId);
            void this.runCheckIn(instance, currentDelay);
        }, currentDelay);
        this.checkInTimers.set(strandId, { timer, instance });
        instance.nextCheckIn = new Date(Date.now() + currentDelay);
    }
    /**
     * Run a single check-in tick: invoke `onCheckIn` (a real resume → bounded
     * sync window → re-hibernate-if-idle cycle in `CadreNode`) and AWAIT it before
     * deciding the next step.
     *
     * - If the strand woke during the check-in (`onCheckIn` left it non-
     *   `hibernating`), stop the chain and restart the idle countdown; the next
     *   hibernation restarts the chain at the base delay (backoff reset).
     * - Otherwise escalate the delay by `checkInBackoffFactor`, capped at
     *   `checkInMaxInterval`, and reschedule.
     */
    async runCheckIn(instance, currentDelay) {
        const { strandId, latencyHint } = instance;
        if (!this.running)
            return;
        log('Check-in for hibernating strand %s (delay=%dms)', strandId, currentDelay);
        try {
            await this.callbacks.onCheckIn(strandId);
        }
        catch (err) {
            // A failed check-in (e.g. resume threw) must not break the chain — log and
            // fall through to reschedule the next, longer-delayed attempt.
            log('onCheckIn failed for strand %s: %o', strandId, err);
        }
        if (!this.running)
            return;
        // The check-in either woke the strand (CadreNode left it active) or left it
        // hibernating. Inspect the shared instance the callback just mutated.
        if (instance.status !== 'hibernating') {
            log('Check-in woke strand %s; backoff resets on next hibernation', strandId);
            this.clearCheckInTimer(strandId);
            // The chain is stopping; drop the now-stale next-check-in advertisement so
            // `getStrand` doesn't report a phantom check-in for a strand that is awake.
            instance.nextCheckIn = undefined;
            this.rearmIdleAfterCheckIn(instance);
            return;
        }
        const timeouts = this.getTimeouts(latencyHint);
        const nextDelay = Math.min(currentDelay * timeouts.checkInBackoffFactor, timeouts.checkInMaxInterval);
        this.scheduleCheckIn(instance, nextDelay);
    }
    /**
     * Start the idle countdown for a strand a check-in left live. Activity recorded while the
     * check-in was still rebuilding found the strand neither idle nor active, so it armed
     * nothing — without this the strand would stay up until the next activity. Only for a live
     * status: a strand stopped mid-check-in must not gain a timer chain.
     */
    rearmIdleAfterCheckIn(instance) {
        const live = instance.status === 'active' || instance.status === 'syncing';
        if (live && this.getTimeouts(instance.latencyHint).idleTimeout !== Infinity) {
            this.scheduleIdleTransition(instance);
        }
    }
    clearTimer(strandId) {
        const timer = this.timers.get(strandId);
        if (timer) {
            clearTimeout(timer);
            this.timers.delete(strandId);
        }
    }
    clearCheckInTimer(strandId) {
        const pending = this.checkInTimers.get(strandId);
        if (pending) {
            clearTimeout(pending.timer);
            this.checkInTimers.delete(strandId);
            // `getStrand` must not advertise a check-in that is no longer scheduled.
            pending.instance.nextCheckIn = undefined;
        }
    }
    clearTimers(strandId) {
        this.clearTimer(strandId);
        this.clearCheckInTimer(strandId);
    }
    /**
     * Get the current status of hibernation tracking
     */
    getStatus() {
        return {
            enabled: this.config.enabled && this.running,
            trackedStrands: this.timers.size + this.checkInTimers.size
        };
    }
}
//# sourceMappingURL=hibernation-manager.js.map