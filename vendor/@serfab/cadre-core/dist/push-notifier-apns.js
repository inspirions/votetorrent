/**
 * push-notifier-apns.ts — APNs HTTP/2 strand-wake delivery.
 *
 * Node-only: signs a provider JWT (ES256, JOSE raw r‖s via `node:crypto`) and
 * sends a background data push over an HTTP/2 session to Apple's gateway. APNs
 * mandates HTTP/2, so `node:http2` is unavoidable here — one reason the push
 * path is injected rather than rebuilt on WebCrypto/`fetch`.
 *
 * Reachable only through the `@serfab/cadre-core/push-node` subpath — never from
 * the cross-platform `./index.js` graph — so the `node:crypto` / `node:http2`
 * imports below are safe: no RN/browser bundler ever resolves this module. (Plain
 * named imports; the old namespace-import-to-only-warn dance is obsolete now that
 * the module is unreachable from a browser build by construction.)
 *
 * The HTTP/2 call is behind an injected `Http2Requester` seam (bundled with a
 * `close` into an {@link ApnsTransport}) so unit tests assert the request shape
 * and map every documented response code with no real network and no credentials.
 * The default transport owns a single lazily-(re)established `node:http2` session.
 *
 * Two single-shot retries guard transient failure without a retry storm: a
 * thrown transport error (session death / GOAWAY mid-send) re-establishes the
 * session and retries the one request once; a 403 `ExpiredProviderToken`
 * re-mints the provider JWT and retries once. A second failure is returned as-is.
 *
 * Secret hygiene: the `.p8` `privateKey`, the minted JWT, and full device tokens
 * are never logged — failure log lines carry only a status/reason and a redacted
 * token prefix.
 */
import { sign } from 'node:crypto';
import { connect } from 'node:http2';
import debug from 'debug';
import { MAX_REASON_LEN, b64urlJson, errText, redact } from './push-notifier-shared.js';
const APNS_PROD_HOST = 'https://api.push.apple.com';
const APNS_SANDBOX_HOST = 'https://api.sandbox.push.apple.com';
/** Apple requires the provider token be 20–60 min old; refresh well inside that. */
const PROVIDER_TOKEN_TTL_MS = 45 * 60000;
const debugApns = debug('sereus:cadre:push:apns');
export function createApnsPushNotifier(creds, deps = {}) {
    const host = creds.production ? APNS_PROD_HOST : APNS_SANDBOX_HOST;
    const transport = deps.transport ?? createHttp2Transport(host);
    const now = deps.now ?? (() => Date.now());
    const log = deps.log ?? ((line) => debugApns(line));
    let cached = null;
    async function send(msg) {
        let jwt;
        try {
            jwt = providerToken(false);
        }
        catch (err) {
            log(`provider-token mint failed: ${errText(err)}`);
            return { ok: false, unregistered: false, error: `apns jwt mint failed: ${errText(err)}` };
        }
        let res = await tryRequest(msg, jwt);
        if (!res)
            return { ok: false, unregistered: false, error: `apns transport failed (token=${redact(msg.token)})` };
        // Provider token expired mid-flight — re-mint once and retry the single send.
        if (res.status === 403 && /ExpiredProviderToken/i.test(res.body)) {
            try {
                jwt = providerToken(true);
            }
            catch (err) {
                log(`provider-token re-mint failed: ${errText(err)}`);
                return { ok: false, unregistered: false, error: `apns jwt re-mint failed: ${errText(err)}` };
            }
            res = await tryRequest(msg, jwt);
            if (!res)
                return { ok: false, unregistered: false, error: `apns transport failed (token=${redact(msg.token)})` };
        }
        return mapResult(res, msg.token);
    }
    /**
     * Send one request with a single re-establish-on-throw retry. A thrown error is
     * a session death / GOAWAY; the default transport recreates its session lazily
     * on the next call, so a second attempt rides a fresh session. Returns `null`
     * when both attempts throw.
     */
    async function tryRequest(msg, jwt) {
        const req = buildRequest(msg, jwt);
        try {
            return await transport.request(req);
        }
        catch (err1) {
            log(`http2 request failed, re-establishing once: ${errText(err1)}`);
            try {
                return await transport.request(req);
            }
            catch (err2) {
                log(`http2 request failed after re-establish: ${errText(err2)}`);
                return null;
            }
        }
    }
    function mapResult(res, deviceToken) {
        if (res.status === 200)
            return { ok: true };
        const reason = apnsReason(res.body);
        const summary = `apns ${res.status}${reason ? ` ${reason}` : ''}`;
        if (res.status === 410 || reason === 'Unregistered' || (res.status === 400 && reason === 'BadDeviceToken')) {
            log(`unregistered token=${redact(deviceToken)} (${summary})`);
            return { ok: false, unregistered: true, error: summary };
        }
        log(`send failed token=${redact(deviceToken)} (${summary})`);
        return { ok: false, unregistered: false, error: summary };
    }
    function buildRequest(msg, jwt) {
        const body = JSON.stringify({
            aps: { 'content-available': 1 },
            type: msg.payload.type,
            strandId: msg.payload.strandId,
            reason: msg.payload.reason.slice(0, MAX_REASON_LEN),
        });
        return {
            path: `/3/device/${msg.token}`,
            headers: {
                authorization: `bearer ${jwt}`,
                'apns-topic': creds.bundleId,
                'apns-push-type': 'background',
                'apns-priority': '5',
                'apns-expiration': '0',
            },
            body,
        };
    }
    function providerToken(forceRefresh) {
        if (!forceRefresh && cached && cached.expiresAt > now())
            return cached.value;
        const iat = Math.floor(now() / 1000);
        const header = { alg: 'ES256', kid: creds.keyId };
        const claims = { iss: creds.teamId, iat };
        const signingInput = `${b64urlJson(header)}.${b64urlJson(claims)}`;
        const sig = sign('SHA256', Buffer.from(signingInput), {
            key: creds.privateKey,
            dsaEncoding: 'ieee-p1363',
        }).toString('base64url');
        const jwt = `${signingInput}.${sig}`;
        cached = { value: jwt, expiresAt: now() + PROVIDER_TOKEN_TTL_MS };
        return jwt;
    }
    async function close() {
        cached = null;
        await transport.close();
    }
    return { send, close };
}
/**
 * Default {@link ApnsTransport}: a single lazily-(re)established `node:http2`
 * session to Apple's gateway. A session that errors / receives GOAWAY / closes is
 * dropped so the next request re-establishes it. Not exercised by unit tests (no
 * network) — tests inject a fake transport; the real path is validated out-of-band.
 */
function createHttp2Transport(host) {
    let session = null;
    function ensureSession() {
        if (session && !session.closed && !session.destroyed)
            return session;
        const s = connect(host);
        // Drop a dead session so ensureSession recreates it on the next request.
        s.on('error', () => { if (session === s)
            session = null; });
        s.on('goaway', () => { s.destroy(); });
        s.on('close', () => { if (session === s)
            session = null; });
        session = s;
        return s;
    }
    async function request(req) {
        const s = ensureSession();
        return await new Promise((resolve, reject) => {
            const stream = s.request({ ':method': 'POST', ':path': req.path, ...req.headers });
            const chunks = [];
            let status = 0;
            stream.on('response', (headers) => { status = Number(headers[':status'] ?? 0); });
            stream.on('data', (chunk) => chunks.push(chunk));
            stream.on('end', () => resolve({ status, body: Buffer.concat(chunks).toString('utf8') }));
            stream.on('error', (err) => reject(err));
            stream.end(req.body);
        });
    }
    async function close() {
        const s = session;
        session = null;
        if (s)
            await new Promise((resolve) => s.close(() => resolve()));
    }
    return { request, close };
}
/** Extract the APNs error `reason` field from a response body, if present. */
function apnsReason(body) {
    if (!body)
        return null;
    try {
        const parsed = JSON.parse(body);
        return typeof parsed.reason === 'string' ? parsed.reason : null;
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=push-notifier-apns.js.map