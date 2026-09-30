import debug from 'debug';
import { concat as uint8ArrayConcat, fromString as uint8ArrayFromString, toString as uint8ArrayToString } from 'uint8arrays';
import { sign, verify } from '@optimystic/quereus-plugin-crypto';
import { formationVouchMessage } from './control-database.js';
const log = debug('sereus:cadre:formation-approval');
/**
 * Abort an unanswered approval request after this long when no `timeoutMs` is supplied.
 * Exported because the formation responder's provisioning budget has to contain it:
 * `formationDeadlines` (`strand-formation-deadlines.ts`) adds it as a flat term, since an HTTP
 * call to the hook does not cross the link between the two parties' machines.
 */
// eslint-disable-next-line no-restricted-syntax -- link-independent: an outbound HTTP call to the approval hook, not the libp2p link between machines
export const DEFAULT_APPROVAL_TIMEOUT_MS = 10000;
/**
 * Largest approval response body this client will read (64 KiB). An approval is two short
 * base64url strings; anything approaching this is a broken or hostile hook, and reading it
 * unbounded would let that hook stream a redeeming node out of memory mid-formation.
 */
const MAX_RESPONSE_BYTES = 64 * 1024;
/**
 * Failure to obtain an approval, carrying the {@link FormationApprovalFailure} category the
 * caller switches on to pick the rejection reason a would-be joiner is told.
 */
export class FormationApprovalError extends Error {
    constructor(failure, message, options) {
        super(message, options);
        this.failure = failure;
        this.name = 'FormationApprovalError';
    }
}
/**
 * The five fields the approver signs, lifted out of the request. Written as an explicit
 * destructure (not a spread-and-delete) so the object posted to the hook can never pick up a
 * field the digest does not cover — in particular the `validationUrl`.
 */
function vouchFields(request) {
    const { token, usageStampId, strandId, peerKey, disclosure } = request;
    return { token, usageStampId, strandId, peerKey, disclosure };
}
/**
 * Approver side: produce the approval for a request. Used by tests, and by anyone writing a
 * hook in TypeScript.
 *
 * `privateKeyB64`'s public half must be the key enrolled as the `ValidationKey` row the
 * redeeming node's control database will verify against — pass that same public key as
 * `validationKey` (derive it with `ed25519PublicKeyFromPrivate` if you only hold the seed).
 * Signing with a key that is not enrolled produces a perfectly valid signature that the
 * database still rejects.
 *
 * Takes the five signed fields, not a full {@link FormationApprovalRequest}: an approver is
 * posted only those five and has no `validationUrl` to hand back. A redeeming node holding a
 * whole request can still pass it straight in.
 *
 * @param fields - The redemption being approved (the five signed fields).
 * @param validationKey - base64url ed25519 public key that this approval claims.
 * @param privateKeyB64 - base64url 32-byte ed25519 seed to sign with.
 */
export function signFormationApproval(fields, validationKey, privateKeyB64) {
    const validationSignature = sign(formationVouchMessage(fields), privateKeyB64, 'ed25519', 'bytes', 'base64url', 'base64url');
    return { validationKey, validationSignature };
}
/**
 * Redeeming side: does this approval actually verify against the bytes we are about to write?
 *
 * A LOCAL PRE-CHECK, not the authority. It turns a bad approval into a legible rejection
 * instead of an opaque `CHECK constraint failed: Authorized` at commit, and it catches the
 * ordinary drift case (the hook signed a different nonce/strand/peer than the one we hold).
 * It cannot substitute for the database check: this verifies against the key the approval
 * itself names, whereas `FormationUsage.Authorized` verifies against the STORED
 * `ValidationKey` row — which is what stops a redeemer approving itself with a key of its own
 * choosing.
 *
 * Returns a boolean and never throws (same contract as `verifyPeerAuthorization`): malformed
 * base64url, a garbage key, or any crypto failure resolves to `false`, logged at debug.
 */
export function verifyFormationApproval(fields, approval) {
    try {
        return verify(formationVouchMessage(fields), approval.validationSignature, approval.validationKey, 'ed25519', 'bytes', 'base64url', 'base64url');
    }
    catch (error) {
        log('verifyFormationApproval failed: %o', error);
        return false;
    }
}
/**
 * Resolve and validate the hook URL before anything is sent.
 *
 * `http:` stays permitted — a self-hosted hook on a LAN is a real deployment — but note that
 * it puts the disclosure text on the wire in clear, and lets anyone on the path see who is
 * joining which strand. Prefer `https:` for a hook reachable off-link.
 */
function parseHookUrl(validationUrl) {
    let url;
    try {
        url = new URL(validationUrl);
    }
    catch (error) {
        throw new FormationApprovalError('misconfigured', `ValidationUrl is not a valid URL: ${validationUrl}`, { cause: error });
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new FormationApprovalError('misconfigured', `ValidationUrl scheme "${url.protocol}" is not supported; use http: or https:`);
    }
    return url;
}
/**
 * The `fetch` this approver will call: the injected one, else the global.
 *
 * Bound to `globalThis` because an unbound global `fetch` is an illegal invocation in browsers
 * (and in any runtime whose `fetch` is a branded method rather than a plain function).
 */
function resolveFetch(fetchImpl) {
    if (fetchImpl) {
        return fetchImpl;
    }
    if (typeof globalThis.fetch !== 'function') {
        throw new FormationApprovalError('misconfigured', 'No fetch implementation: globalThis.fetch is missing and no fetchImpl was supplied');
    }
    return globalThis.fetch.bind(globalThis);
}
/**
 * Read the response body as text, refusing anything over {@link MAX_RESPONSE_BYTES}.
 *
 * Two paths, because `Response.body` is not universally a stream (React Native's fetch has no
 * `body` reader): stream and stop at the cap where possible, otherwise read to completion and
 * measure. The declared `content-length` is checked first so an honest oversized response is
 * rejected without reading it at all — but it is only a hint, so the actual bytes are counted
 * either way.
 *
 * NOTE: on the no-reader path the cap is enforced only AFTER the runtime has buffered the whole
 * body, so a hook that under-declares its `content-length` can still make that runtime hold an
 * arbitrary amount. Harmless where it applies today (React Native clients are not formation
 * responders); if a responder ever runs on a platform without a body reader, that path needs a
 * real streaming read rather than a post-hoc measurement.
 */
async function readCappedText(response, budget) {
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
        throw new FormationApprovalError('malformed', `Approval response declares ${declared} bytes, over the ${MAX_RESPONSE_BYTES}-byte cap`);
    }
    const body = response.body;
    if (!body || typeof body.getReader !== 'function') {
        // NOTE: nothing releases this body when the budget wins — `text()` has already locked it and
        // the runtime owns the buffering. It only applies to readerless-fetch runtimes (React
        // Native), which are not formation responders; a responder on such a platform would need a
        // real streaming read here, as the cap note above already says.
        const text = await budget.race(response.text());
        assertUnderCap(uint8ArrayFromString(text, 'utf8').byteLength);
        return text;
    }
    return readCappedStream(body.getReader(), budget);
}
/** Drain a body stream, aborting the read the moment the accumulated bytes pass the cap. */
async function readCappedStream(reader, budget) {
    const chunks = [];
    let total = 0;
    try {
        for (;;) {
            // Raced, not just aborted: a `fetch` that drops the abort leaves this read pending
            // forever, and the budget is the only thing that ends it. The `finally` below cancels
            // the reader, which is what actually gives the connection back.
            const { done, value } = await budget.race(reader.read());
            if (done) {
                break;
            }
            total += value.byteLength;
            assertUnderCap(total);
            chunks.push(value);
        }
    }
    finally {
        // Releases the connection when we bailed early; a no-op on a fully-drained stream.
        void reader.cancel().catch((error) => log('response cancel failed: %o', error));
    }
    return uint8ArrayToString(uint8ArrayConcat(chunks, total), 'utf8');
}
/**
 * Release a body we are never going to read, so the runtime can put the connection back in its
 * pool. Every failure decided from the status line (a refusal, a 5xx, a redirect) and the
 * declared-oversize rejection throw before touching the body, and an undrained body keeps a
 * socket checked out until GC — a node that asks a flapping hook once per redemption would
 * accumulate them. Skips a body already locked by {@link readCappedStream}, which cancels its
 * own reader.
 *
 * NOTE: awaited by `readApproval`, so it sits OUTSIDE the budget — a runtime whose `cancel()`
 * never settles would hold the caller past `timeoutMs` even though the deadline already fired.
 * Every runtime this ships on settles it promptly. If a request is ever seen outliving its budget
 * despite the budget firing, stop awaiting this; the two tests that assert the body is released
 * by the time the rejection surfaces would then have to poll instead.
 */
async function discardBody(response) {
    const body = response.body;
    if (!body || body.locked) {
        return;
    }
    try {
        await body.cancel();
    }
    catch (error) {
        log('discarding unread response body failed: %o', error);
    }
}
function assertUnderCap(bytes) {
    if (bytes > MAX_RESPONSE_BYTES) {
        throw new FormationApprovalError('malformed', `Approval response exceeds the ${MAX_RESPONSE_BYTES}-byte cap`);
    }
}
/** A blank (or whitespace-only) field is as unusable as a missing one — both are `malformed`. */
function requireField(body, field) {
    const value = body[field];
    if (typeof value !== 'string' || value.trim() === '') {
        throw new FormationApprovalError('malformed', `Approval response is missing a usable "${field}"`);
    }
    return value;
}
/** Parse a 2xx body into an approval, rejecting anything that is not the documented shape. */
function parseApproval(text) {
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch (error) {
        throw new FormationApprovalError('malformed', 'Approval response is not JSON', { cause: error });
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new FormationApprovalError('malformed', 'Approval response is not a JSON object');
    }
    const body = parsed;
    return {
        validationKey: requireField(body, 'validationKey'),
        validationSignature: requireField(body, 'validationSignature')
    };
}
/**
 * Map a response's STATUS — never its body shape — onto a failure. A `403` carrying a
 * well-formed approval is still a refusal: the hook said no, and a redeeming node that read
 * the body anyway would let a hook accidentally approve by echoing.
 */
function assertApprovingStatus(response, origin) {
    if (response.status === 401 || response.status === 403) {
        throw new FormationApprovalError('refused', `Approval hook ${origin} refused this redemption (HTTP ${response.status})`);
    }
    if (!response.ok) {
        throw new FormationApprovalError('unavailable', `Approval hook ${origin} answered HTTP ${response.status}`);
    }
    // Belt and braces for runtimes that ignore `redirect: 'error'` rather than rejecting.
    if (response.redirected) {
        throw new FormationApprovalError('unavailable', `Approval hook ${origin} redirected; re-publish the ValidationUrl instead of chasing it`);
    }
}
/**
 * Turn a response into an approval, releasing the body on every path that rejects it.
 */
async function readApproval(response, origin, budget) {
    try {
        assertApprovingStatus(response, origin);
        return parseApproval(await readCappedText(response, budget));
    }
    catch (error) {
        await discardBody(response);
        throw error;
    }
}
/**
 * Arm the budget for one request. The caller's `signal` is relayed by hand rather than with
 * `AbortSignal.any` (not reliably present on React Native/Hermes; this client commits to
 * `fetch` + `AbortController` only).
 */
function startBudget(timeoutMs, origin, controller, signal) {
    let expired = false;
    let expire;
    const deadline = new Promise((_resolve, reject) => { expire = reject; });
    // The deadline can fire between two raced awaits, with nothing attached to it; a bare handler
    // keeps that from surfacing as an unhandled rejection without hiding it from `race`.
    void deadline.catch(() => { });
    const fire = (reason) => {
        if (expired) {
            return;
        }
        expired = true;
        // Rejected BEFORE the abort, so this reason — not whatever a fetch that DOES honour the
        // abort rejects with — is what the race settles on. Both are queued in the same turn, and
        // the first one queued wins.
        expire(new FormationApprovalError('unavailable', reason));
        // Best-effort, and no longer load-bearing: where the runtime honours it, this hands the
        // socket back instead of leaving it checked out until GC.
        controller.abort();
    };
    const timer = setTimeout(() => fire(`Approval hook ${origin} did not answer within ${timeoutMs}ms`), timeoutMs);
    const onCallerAbort = () => fire(`Formation was cancelled while approval hook ${origin} was being asked`);
    signal?.addEventListener('abort', onCallerAbort, { once: true });
    return {
        race: (work) => Promise.race([work, deadline]),
        expired: () => expired,
        dispose: () => {
            // A leaked abort timer keeps a node's event loop alive.
            clearTimeout(timer);
            signal?.removeEventListener('abort', onCallerAbort);
        }
    };
}
/**
 * Await the response, giving up when the budget expires — and cleaning up after ourselves if it
 * does: a `fetch` that ignored the abort still delivers its response eventually, and an unread
 * body keeps a connection checked out. A late rejection is logged rather than left unhandled.
 */
async function fetchWithinBudget(pending, budget) {
    void pending.then((response) => {
        if (budget.expired()) {
            void discardBody(response);
        }
    }, (error) => {
        if (budget.expired()) {
            log('abandoned approval request rejected after its budget expired: %o', error);
        }
    });
    return budget.race(pending);
}
/**
 * Ask an outside approval service, over HTTP, whether a would-be joiner may redeem an
 * invitation. Contacted by the INVITING party's node (the formation responder) during
 * redemption — never by the joiner, which neither mints the nonce nor performs the write.
 *
 * Wire contract (documented for hook operators in `docs/api.md`):
 *
 * - `POST <ValidationUrl>`, `content-type: application/json`, `accept: application/json`.
 * - Body is exactly the five signed fields — `{ token, usageStampId, strandId, peerKey,
 *   disclosure }` — and nothing else. No owner keys, no bootstrap addresses, no membership
 *   keys ever reach the hook.
 * - `200` with `{ "validationKey": "...", "validationSignature": "..." }` is an approval.
 * - `401` / `403` is a refusal; any other non-2xx, a network error, a timeout, or a redirect
 *   is `unavailable`; a 2xx that is not a usable approval is `malformed`.
 *
 * Cross-platform by construction: global `fetch` + `AbortController` only, no `node:` imports.
 */
export function createHttpFormationApprover(options) {
    const timeoutMs = options?.timeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;
    // A non-positive or non-finite budget would abort every request before it left, turning a
    // config typo into a hook that appears permanently down. Fail where the mistake was made.
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        throw new FormationApprovalError('misconfigured', `timeoutMs must be a positive number of milliseconds, got ${timeoutMs}`);
    }
    const fetchImpl = options?.fetchImpl;
    return {
        async requestApproval(request, signal) {
            const doFetch = resolveFetch(fetchImpl);
            const url = parseHookUrl(request.validationUrl);
            // Origin only in messages: a ValidationUrl's path/query may carry a hook secret, and
            // these strings reach logs and the joiner's rejection reason.
            const origin = url.origin;
            if (signal?.aborted) {
                throw new FormationApprovalError('unavailable', `Formation was cancelled before approval hook ${origin} was asked`);
            }
            const controller = new AbortController();
            const budget = startBudget(timeoutMs, origin, controller, signal);
            try {
                const response = await fetchWithinBudget(doFetch(url.toString(), {
                    method: 'POST',
                    headers: { 'content-type': 'application/json', accept: 'application/json' },
                    body: JSON.stringify(vouchFields(request)),
                    redirect: 'error',
                    signal: controller.signal
                }), budget);
                const approval = await readApproval(response, origin, budget);
                log('approval obtained from %s for token %s', origin, request.token);
                return approval;
            }
            catch (error) {
                // Includes the budget's own rejection, which already carries the timeout/cancellation
                // wording; anything else got here without the budget firing, so the hook is unreachable.
                if (error instanceof FormationApprovalError) {
                    throw error;
                }
                throw new FormationApprovalError('unavailable', `Approval hook ${origin} could not be reached`, { cause: error });
            }
            finally {
                budget.dispose();
            }
        }
    };
}
//# sourceMappingURL=formation-approval.js.map