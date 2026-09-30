import debug from 'debug';
import { unwrapError } from '@quereus/quereus';
const log = debug('sereus:cadre:control-db');
/**
 * Run `attempt` up to the policy's attempt count, retrying only failures its classifier
 * calls transient, and only while its elapsed budget has not run out.
 *
 * `attempt` must be safe to re-run — for writes that means atomic (a failed cluster write
 * rolls back, nothing half-applies; the contract on `ControlDatabase.withWriteLock`), for
 * reads it holds trivially. The backoff sleeps happen with NO lock held; a caller that
 * locks takes and releases its lock inside `attempt`.
 *
 * On exhaustion (attempts or budget) the LAST error is rethrown unchanged — never
 * wrapped, so the exact messages downstream code and the integration scenarios assert on
 * survive. A non-retriable failure propagates from the attempt that raised it.
 *
 * Both give-up exits also notify {@link ControlRetryOptions.onAbandon}, when the call
 * supplies one, exactly once before the rethrow. The debug line each exit already wrote is
 * off unless somebody set `DEBUG=`, and a background write has no caller to surface the
 * rethrown error — so without an observer the loss is silent everywhere.
 */
export async function retryControlOperation(attempt, policy, options = {}) {
    const attempts = Math.max(1, options.attempts ?? policy.attempts);
    const delays = options.delaysMs ?? policy.delaysMs;
    const isRetriable = options.isRetriable ?? policy.isRetriable;
    const sleep = options.sleep ?? defaultSleep;
    const now = options.now ?? Date.now;
    const prefix = policy.logPrefix ?? 'Control write';
    const onAbandon = options.onAbandon;
    // Empty when unlabelled, so an unlabelled line is byte-identical to what the write
    // loop logged before labels existed.
    const tag = options.label ? ` [${options.label}]` : '';
    const start = now();
    let lastError;
    let attemptsMade = 0;
    // Which exit the loop leaves by. Only the budget check below moves it off the default,
    // so an unmodified `break` is the attempts exit.
    let exhaustedBy = 'attempts';
    for (let attemptNumber = 1; attemptNumber <= attempts; attemptNumber++) {
        attemptsMade = attemptNumber;
        try {
            const result = await attempt();
            if (attemptNumber > 1) {
                log('%s%s committed on attempt %d/%d', prefix, tag, attemptNumber, attempts);
            }
            return result;
        }
        catch (error) {
            if (!isRetriable(error)) {
                // The ONLY trace that this funnel saw a failure and declined it. Without it the
                // log is silent either way, so "the classifier vetoed this one" is
                // indistinguishable from "the retry is not wired into this path at all".
                log('%s%s failed non-transiently on attempt %d/%d, not retried here: %s', prefix, tag, attemptNumber, attempts, error);
                notifyAbandoned(onAbandon, prefix, tag, {
                    ...(options.label !== undefined ? { label: options.label } : {}),
                    attemptsMade, attemptsAllowed: attempts, elapsedMs: now() - start,
                    reason: 'declined', error
                });
                throw error;
            }
            lastError = error;
            if (attemptNumber === attempts) {
                break;
            }
            const elapsed = now() - start;
            if (elapsed >= policy.budgetMs) {
                exhaustedBy = 'budget';
                break;
            }
            const delay = jitteredDelay(delays, attemptNumber);
            log('%s%s failed transiently (attempt %d/%d), retrying in %d ms: %s', prefix, tag, attemptNumber, attempts, delay, error);
            await sleep(delay);
        }
    }
    log('%s%s failed after %d/%d attempt(s): %s', prefix, tag, attemptsMade, attempts, lastError);
    notifyAbandoned(onAbandon, prefix, tag, {
        ...(options.label !== undefined ? { label: options.label } : {}),
        attemptsMade, attemptsAllowed: attempts, elapsedMs: now() - start,
        reason: exhaustedBy, error: lastError
    });
    throw lastError;
}
/**
 * Tell the observer the operation was abandoned, and never let that replace the failure.
 *
 * A throwing observer is a bug in the observer, not in the write: the loop is on its way to
 * rethrowing the real error, and letting the observer's `TypeError` out instead would erase
 * the very failure it was notified about. Logged and swallowed — the same treatment
 * `CadreNode.emit` gives a throwing event handler.
 */
function notifyAbandoned(listener, prefix, tag, abandonment) {
    if (!listener) {
        return;
    }
    try {
        listener(abandonment);
    }
    catch (listenerError) {
        log('%s%s abandonment listener threw (the write\'s own failure is unaffected): %s', prefix, tag, listenerError);
    }
}
/**
 * Every message in the failure's `cause` chain — the shared substrate both retry classifiers
 * match against. They match text (why, in `control-read-retry.ts`'s module comment); every
 * wrap on the way out of optimystic and Quereus embeds the inner message, so the text of
 * the deepest failure is visible at every level.
 *
 * `unwrapError` declares its `message` as `string`, but it follows `.cause` without checking
 * what that holds — a chain link that is not an `Error` (a stream rejected with a bare string
 * reason, an `AbortSignal.reason` that is a plain object) yields `undefined` there, and
 * calling `.includes` on it would throw a `TypeError` out of a classifier, INSIDE
 * {@link retryControlOperation}'s catch, replacing the real failure with a confusing one.
 * Non-strings are dropped: a link nobody can read is a link that matches nothing, which is
 * already the conservative answer.
 *
 * NOTE: a cause chain with a CYCLE would spin forever inside `unwrapError` itself. No error
 * in this repo builds one; if a hang ever localises to a control retry path, look there.
 */
export function chainMessages(error) {
    return unwrapError(error)
        .map(({ message }) => message)
        .filter(message => typeof message === 'string');
}
/**
 * `error` and every `cause` below it, outermost first — the substrate for the classifiers that
 * match by TYPE rather than text (the read side's cohort-unreachable check, the write side's
 * possibly-stored veto). Stops at a non-`Error` link (it can carry no further `cause` worth
 * trusting) and at a repeat, so a cyclic chain terminates.
 */
export function causeChain(error) {
    const links = [];
    let current = error;
    while (current instanceof Error && !links.includes(current)) {
        links.push(current);
        current = current.cause;
    }
    return links;
}
/**
 * Backoff for the retry that follows attempt `attemptNumber`: the matching base delay
 * (last entry repeats), jittered ±50%, then capped at the list's largest base so no single
 * sleep exceeds it (see {@link ControlRetryPolicy.delaysMs} for why). `Math.random` is
 * fine here — the jitter only de-synchronizes concurrent retriers, nothing is derived
 * from it.
 *
 * NOTE: the cap bites on the LAST delay, whose base IS the largest, so ~half of those sleeps
 * land exactly on the cap rather than spread — de-synchronization is only partial there.
 * Harmless while retriers are a handful of party nodes whose attempts already start seconds
 * apart; if a party ever retries in a tight synchronized herd, raise the cap above the
 * largest base instead of jittering about it.
 */
function jitteredDelay(delays, attemptNumber) {
    if (delays.length === 0) {
        return 0;
    }
    const base = delays[Math.min(attemptNumber - 1, delays.length - 1)];
    const jittered = base * (0.5 + Math.random());
    return Math.min(jittered, Math.max(...delays));
}
function defaultSleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
//# sourceMappingURL=control-retry.js.map