/**
 * Native cadre-core strand-formation transport.
 *
 * Mirrors the `seed-bootstrap.ts` protocol service: a dedicated
 * libp2p protocol id, length-prefixed JSON frames, and small single-purpose
 * session helpers. It replaces the removed `@serfab/strand-proto` package's transport,
 * carrying the caller's REAL invitation token + disclosure and BOTH parties'
 * real cadre peer addresses end-to-end (no `{ partyId: sessionId }` / `cadre-*.local`
 * placeholders), and validating the responder's result on the initiator side.
 *
 * Provisioning flow (`responderCreates`, 2 messages): the responder provisions (or, for
 * provision-then-record, resolves + records consent against) the strand and returns the
 * result on approval.
 *
 * Cadre-disclosure timing: the responder reveals its own party id + cadre addresses
 * — and, for a closed strand returned via provision-then-record, that strand's
 * membership key — ONLY after the token and disclosure validate; a rejection
 * discloses none of them.
 */
import debug from 'debug';
import { multiaddr } from '@multiformats/multiaddr';
import { writeFrame, withDeadline, withTimeout } from './control-stream.js';
import { canonicalJson } from './canonical-json.js';
import { requireEd25519PublicKeyB64 } from './ed25519-key.js';
import { verifyFormationConsent } from './peer-authorization.js';
// seed-bootstrap imports neither this protocol nor the manager/solicitation layers,
// so this import introduces no cycle.
import { ed25519PublicKeyB64FromPeerId } from './seed-bootstrap.js';
import { formationDeadlines, resolveProvisionTimeoutMs, responderClampReserveMs, splitProvisionBudget } from './strand-formation-deadlines.js';
const log = debug('sereus:cadre:formation-proto');
/** Protocol id for the native formation transport (parallel to `/sereus/seed/1.0.0`). */
export const FORMATION_PROTOCOL = '/sereus/formation/1.0.0';
/**
 * Rejection reason for an invitation that cannot be redeemed at all — unknown, expired, or
 * fully spent. Shared with `StrandFormationManager`, which reports an
 * `InvitationExhaustedError` (an invite spent out from under a redemption already in flight)
 * with this SAME wording on purpose: a joiner that lost the race must be indistinguishable
 * from a non-racing latecomer, so the two sites must never drift apart.
 */
export const INVALID_TOKEN_REASON = 'Invalid token';
/** Maximum formation message size (1MB). */
const MAX_FORMATION_MSG_SIZE = 1024 * 1024;
/**
 * Default cap on concurrent inbound formation sessions.
 *
 * NOTE: a session holds its slot for its whole provisioning budget, 171 s at the default
 * declared link ({@link formationDeadlines}), so a slow hook or commit holds slots for
 * minutes. Only a caller holding a valid token AND a valid consent signature reaches
 * provisioning — a stranger is cut at the contact wait (7 s at the default) or at the first
 * validation read — so the exposure is one invitee opening many sessions with one token. If
 * invitation tokens are ever published where untrusted parties can read them, cap in-flight
 * sessions per token rather than lowering this.
 */
const DEFAULT_MAX_CONCURRENT_SESSIONS = 100;
/**
 * Cap on the strand-network addresses a formation result carries
 * ({@link FormationResultMessage.strandAddrs}). A node's own strand multiaddrs are a
 * handful of entries (one per listen transport, plus a circuit-relay reservation), so
 * 16 is generous for the honest case while keeping the result frame bounded against a
 * peer that would pad it — either direction, since both sides run the list through
 * {@link sanitizeStrandAddrs}. Exported because the same bound has to hold on the
 * initiator's stored copy: `CadreNode` accumulates across repeat formations against one
 * strand, so it caps the accumulation rather than only each arriving list.
 */
export const MAX_STRAND_ADDRS = 16;
/**
 * Normalize a strand-address list arriving from — or heading to — the wire: keep only
 * parsable multiaddr strings, drop duplicates, and cap at {@link MAX_STRAND_ADDRS}.
 * Order is preserved, so the responder's signaling-first ordering survives.
 *
 * Applied on BOTH sides on purpose. The responder bounds what it sends; the initiator
 * bounds what it stores, because a peer is free to ignore the cap. A malformed entry is
 * SKIPPED rather than fatal — these are runtime-discovered addresses (same posture as
 * `extractCircuitRelayTargets` in `delegate-admission.ts`), and one bad entry must not
 * cost a formation that has otherwise succeeded.
 */
export function sanitizeStrandAddrs(addrs) {
    if (!Array.isArray(addrs))
        return [];
    const out = [];
    const seen = new Set();
    for (const entry of addrs) {
        if (out.length >= MAX_STRAND_ADDRS)
            break;
        if (typeof entry !== 'string' || entry.length === 0) {
            log('strandAddrs: skipping non-string entry %o', entry);
            continue;
        }
        if (seen.has(entry))
            continue;
        try {
            multiaddr(entry);
        }
        catch (error) {
            // Deliberately not echoing the raw value at error level: it arrived from a remote
            // peer. The log line below is the observability for a responder announcing junk.
            log('strandAddrs: skipping unparsable entry: %o', error);
            continue;
        }
        seen.add(entry);
        out.push(entry);
    }
    return out;
}
// ── Stream framing helpers ───────────────────────────────────────────────────
/**
 * Reads length-prefixed JSON frames from a libp2p stream one frame at a time.
 *
 * Unlike seed delivery (which reads a stream to EOF then parses once), formation
 * is request/response on a single live stream, so reading must stop at each frame
 * boundary. The reader buffers across chunk boundaries and retains any overflow
 * (a following frame coalesced into the same chunk) for the next read.
 */
class FrameReader {
    constructor(stream, maxLength = MAX_FORMATION_MSG_SIZE) {
        this.buffer = new Uint8Array(0);
        this.iterator = stream[Symbol.asyncIterator]();
        this.maxLength = maxLength;
    }
    append(chunk) {
        const next = new Uint8Array(this.buffer.length + chunk.length);
        next.set(this.buffer, 0);
        next.set(chunk, this.buffer.length);
        this.buffer = next;
    }
    /** Pull chunks until the buffer holds ≥ `need` bytes; false if the stream ended first. */
    async fill(need) {
        while (this.buffer.length < need) {
            const { value, done } = await this.iterator.next();
            if (done)
                return false;
            const bytes = value instanceof Uint8Array
                ? value
                : value.subarray();
            this.append(bytes);
        }
        return true;
    }
    async read() {
        if (!(await this.fill(4))) {
            throw new Error('Formation stream closed before length prefix');
        }
        const length = new DataView(this.buffer.buffer, this.buffer.byteOffset, this.buffer.byteLength).getUint32(0, false);
        if (length > this.maxLength) {
            throw new Error(`Formation frame declares length ${length} exceeding max ${this.maxLength}`);
        }
        if (!(await this.fill(4 + length))) {
            throw new Error(`Formation frame declares length ${length} but stream ended early`);
        }
        const json = new TextDecoder().decode(this.buffer.subarray(4, 4 + length));
        this.buffer = this.buffer.subarray(4 + length);
        return JSON.parse(json);
    }
}
// ── Result validation ────────────────────────────────────────────────────────
/** Matches the placeholder cadre addrs (`cadre-a-1.local`, …) of the removed strand-proto transport. */
const PLACEHOLDER_CADRE_ADDR = /^cadre-[ab]-\d+\.local$/;
/**
 * Both halves of a {@link StrandMembershipInvite} are base64url ed25519 key encodings —
 * 43 chars for 32 bytes. The bound is deliberately loose (a future encoding change must
 * not silently strand joiners) while still capping what a hostile responder can make the
 * initiator retain.
 */
const MAX_MEMBERSHIP_INVITE_KEY_LENGTH = 256;
const BASE64URL_KEY = /^[A-Za-z0-9_-]+$/;
/**
 * Is `value` a well-formed {@link StrandMembershipInvite} — exactly two bounded
 * base64url strings? The initiator-side shape check for the one attacker-influenced
 * OBJECT the formation result carries (`strandAddrs` gets the equivalent treatment in
 * {@link sanitizeStrandAddrs}): a malformed field from a hostile responder must fail
 * validation, never crash the initiator or be carried into the joiner's invite cache.
 * `undefined` is NOT well-formed — absence is legal on the result and callers gate on
 * presence first.
 */
export function isWellFormedMembershipInvite(value) {
    if (typeof value !== 'object' || value === null)
        return false;
    const { inviteKey, invitePrivateKey } = value;
    const wellFormedKey = (key) => typeof key === 'string' && key.length > 0 && key.length <= MAX_MEMBERSHIP_INVITE_KEY_LENGTH && BASE64URL_KEY.test(key);
    return wellFormedKey(inviteKey) && wellFormedKey(invitePrivateKey);
}
/**
 * Structural check on a `responderCreates` result: the responder must have approved,
 * disclosed a non-empty real identity + cadre (not the legacy `cadre-*.local`
 * placeholders), and returned a strand vouched for by the responder party with a real id.
 *
 * `createdBy: 'responder'` means "the responder party vouches for / returns this strand."
 * Under provision-then-record that strand was minted owner-signed earlier (not created
 * in-session), but it is still the responder party returning its own strand, so the marker
 * — and this structural validator — stay unchanged.
 *
 * The behavioral floor for the initiator: a responder that returns an arbitrary/empty
 * `strandId` or omits its disclosed identity is rejected, not silently accepted.
 */
export function isValidResponderCreatesResult(response) {
    if (!response.approved)
        return false;
    if (!response.partyId)
        return false;
    const addrs = response.cadrePeerAddrs;
    if (!addrs || addrs.length === 0)
        return false;
    if (addrs.some((a) => PLACEHOLDER_CADRE_ADDR.test(a)))
        return false;
    const provision = response.provisionResult;
    if (!provision?.strand?.strandId)
        return false;
    if (provision.strand.createdBy !== 'responder')
        return false;
    // Optional, but when present it must be well-formed: a malformed invitation is a
    // membership the joiner can never redeem, so reject the result rather than accept a
    // formation that would leave a half-member.
    if (provision.membershipInvite !== undefined && !isWellFormedMembershipInvite(provision.membershipInvite)) {
        return false;
    }
    return true;
}
/**
 * Responder side of the native formation protocol. Registers a libp2p handler and
 * drives each inbound stream through token + disclosure validation, provisioning,
 * and result delivery — enforcing the cadre-disclosure timing rule (responder cadre
 * is revealed only after validation; rejections disclose nothing).
 */
export class FormationListener {
    constructor(options) {
        this.registered = new Set();
        this.activeSessions = 0;
        this.sessionCounter = 0;
        this.options = options;
        const deadlines = formationDeadlines(options.linkRoundTripMs);
        this.sessionTimeoutMs = options.sessionTimeoutMs ?? deadlines.sessionMs;
        this.awaitContactMs = options.stepTimeoutMs ?? deadlines.awaitContactMs;
        const split = splitProvisionBudget(resolveProvisionTimeoutMs(options.provisionTimeoutMs, deadlines.provisionWorkMs + deadlines.provisionGraceMs, this.sessionTimeoutMs, this.awaitContactMs + deadlines.validationMs, 'FormationListener', responderClampReserveMs(deadlines, this.awaitContactMs)), deadlines.provisionGraceMs);
        this.provisionWorkMs = split.workMs;
        this.provisionGraceMs = split.graceMs;
        this.maxConcurrentSessions = options.maxConcurrentSessions ?? DEFAULT_MAX_CONCURRENT_SESSIONS;
    }
    /** Number of in-flight inbound sessions. */
    get activeCount() {
        return this.activeSessions;
    }
    /** Register the formation handler on `node`. Rejects when libp2p refuses the registration. */
    async register(node, protocolId = FORMATION_PROTOCOL) {
        if (this.registered.has(node)) {
            log('node already registered');
            return;
        }
        await node.handle(protocolId, async (rawStream, _connection) => {
            await this.handleStream(rawStream);
        });
        this.registered.add(node);
        log('formation listener registered (%s)', protocolId);
    }
    async unregister(node, protocolId = FORMATION_PROTOCOL) {
        if (!this.registered.has(node))
            return;
        await node.unhandle(protocolId);
        this.registered.delete(node);
        log('formation listener unregistered (%s)', protocolId);
    }
    async handleStream(stream) {
        if (this.activeSessions >= this.maxConcurrentSessions) {
            const rejection = { approved: false, reason: 'Too many concurrent formation sessions' };
            try {
                writeFrame(stream, rejection);
            }
            catch { /* best effort */ }
            try {
                await stream.close();
            }
            catch { /* ignore */ }
            return;
        }
        const id = ++this.sessionCounter;
        this.activeSessions++;
        try {
            await withTimeout(this.sessionTimeoutMs, `Formation session#${id}`, () => this.runSession(id, stream));
        }
        catch (err) {
            log('formation session #%d failed: %o', id, err);
        }
        finally {
            this.activeSessions--;
            try {
                await stream.close();
            }
            catch { /* ignore */ }
        }
    }
    /**
     * Run the provisioning hook under its WORK budget — the provisioning budget minus the
     * trailing settle grace ({@link splitProvisionBudget}).
     *
     * When the work budget expires the hook's signal is aborted, then
     * {@link settleWithinGrace} waits out the grace for the aborted work to settle anyway.
     * Returns `undefined` for "timed out" — which the caller turns into a retryable rejection
     * frame — and rethrows every other failure so it reaches the internal-error path.
     *
     * Deliberately not `withDeadline`: that exposes neither the timed-out flag nor the signal
     * outside its `op`, and both are needed here.
     */
    async provision(id, contact) {
        const controller = new AbortController();
        let timedOut = false;
        const pending = this.options.provisionStrand(contact, controller.signal);
        try {
            return await withTimeout(this.provisionWorkMs, `Formation provisioning#${id}`, () => pending, () => { timedOut = true; controller.abort(); });
        }
        catch (err) {
            if (!timedOut)
                throw err;
            log('formation session #%d provisioning work budget expired after %dms; aborted, settling up to %dms', id, this.provisionWorkMs, this.provisionGraceMs);
            return await this.settleWithinGrace(id, pending);
        }
    }
    /**
     * Wait out the settle grace for an ABORTED provisioning, adopting a late success.
     *
     * A hook that observed the abort before issuing its `FormationUsage` insert rejects (with
     * `FormationAbortedError`) and leaves the invite unspent → reported as a timeout. A hook
     * that had already written cannot be un-written (the table is append-only), so if it lands
     * inside the grace its outcome is ADOPTED — the joiner is told the truth (approved, or the
     * hook's own rejection reason) rather than "timed out" over a spent invite.
     *
     * The grace is derived to contain one seat read plus one commit at the declared link
     * ({@link formationDeadlines}), which is exactly what runs after the insert attempt passes
     * its abort check, so at that link the late outcome lands inside it.
     *
     * NOTE: a commit that outlasts even the derived grace (a link slower than declared, or a
     * configured `provisionTimeoutMs` whose half-cap shrank the grace) still tells the joiner
     * 'timed out' while its one-time invite is in fact spent, and since every retry mints a
     * fresh keypair no recovery path can match it. Nothing can un-spend an append-only row, so
     * the late-settle logging below is the observability for it; if it is seen in the wild,
     * raise the declared link rather than this grace.
     */
    async settleWithinGrace(id, pending) {
        let stillPending = false;
        try {
            const outcome = await withTimeout(this.provisionGraceMs, `Formation settle#${id}`, () => pending, () => { stillPending = true; });
            log('formation session #%d provisioning settled within its grace: approved=%s — adopting', id, outcome.approved);
            return outcome;
        }
        catch (err) {
            if (!stillPending) {
                log('formation session #%d provisioning failed after its abort: %o', id, err);
                return undefined;
            }
            log('formation session #%d provisioning still pending after its %dms grace', id, this.provisionGraceMs);
            // Log how it eventually settled so a late failure is not swallowed by the two
            // abandoned `withTimeout` calls.
            void pending.then((late) => log('formation session #%d provisioning settled after its grace: approved=%s', id, late.approved), (err2) => log('formation session #%d provisioning failed after its grace: %o', id, err2));
            return undefined;
        }
    }
    /**
     * Joiner-consent pre-check — the legibility twin of the schema's
     * `FormationUsage.PeerConsented` CHECK, exactly as `verifyFormationApproval` is for the
     * approver's vouch. The database constraint stays the authority; this turns a bad consent
     * into a clean 'Invalid joiner consent' rejection instead of an opaque CHECK failure at
     * commit. Runs BEFORE token/disclosure validation: it is the cheapest check (pure local
     * crypto, no DB read) and a rejection discloses nothing.
     *
     * Also pins `partyId` to `peerKey`: an ed25519 peer id is an identity multihash of the
     * very key, and this is the ONLY layer that can check the match — SQL cannot unwrap a
     * multihash, and `partyId` itself is never stored.
     */
    isJoinerConsentValid(id, contact) {
        try {
            requireEd25519PublicKeyB64(contact.peerKey, 'joiner peer key');
        }
        catch {
            // Deliberately not rethrown or echoed: the helper's error message embeds the whole
            // rejected value, and this one arrived from a remote peer (the cap-the-echo case its
            // own NOTE warns about). Log without the raw value instead.
            log('formation session #%d: joiner peer key is not a base64url ed25519 public key', id);
            return false;
        }
        const embedded = ed25519PublicKeyB64FromPeerId(contact.partyId);
        if (!embedded || embedded !== contact.peerKey) {
            log('formation session #%d: partyId does not embed the presented peer key', id);
            return false;
        }
        const consentOk = verifyFormationConsent({
            token: contact.token,
            usageStampId: contact.usageStampId,
            peerKey: contact.peerKey,
            disclosure: canonicalJson(contact.disclosure),
            peerSig: contact.peerSignature
        });
        if (!consentOk) {
            log('formation session #%d: joiner consent signature failed verification', id);
            return false;
        }
        return true;
    }
    /**
     * The strand addresses to disclose for an APPROVED provisioning, sanitized and capped.
     *
     * Never throws: a hook that fails (a strand runtime torn down mid-session) costs the
     * joiner its cross-party seed, not the formation it has already earned — the seed is
     * an optimization, the consent row is the commitment.
     */
    strandAddrsFor(id, strandId) {
        if (!this.options.resolveStrandAddrs)
            return [];
        try {
            return sanitizeStrandAddrs(this.options.resolveStrandAddrs(strandId));
        }
        catch (err) {
            log('formation session #%d: strand-addr lookup for %s failed (continuing): %o', id, strandId, err);
            return [];
        }
    }
    async runSession(id, stream) {
        // Track whether ANY frame has been written so the catch below can convert an
        // unexpected internal error into a non-disclosing rejection ONLY when nothing has
        // gone out yet. This closes the "stream closed with no result frame" class of bug.
        let wroteFrame = false;
        const send = (msg) => {
            writeFrame(stream, msg);
            wroteFrame = true;
        };
        try {
            const reader = new FrameReader(stream);
            const contact = await withTimeout(this.awaitContactMs, `Formation await-contact#${id}`, () => reader.read());
            log('formation session #%d contact: token=%s party=%s', id, contact.token, contact.partyId);
            if (!this.isJoinerConsentValid(id, contact)) {
                send({ approved: false, reason: 'Invalid joiner consent' });
                return;
            }
            const tokenResult = await this.options.validateToken(contact.token);
            if (!tokenResult.valid) {
                send({ approved: false, reason: INVALID_TOKEN_REASON });
                return;
            }
            const disclosureOk = await this.options.validateDisclosure(contact.token, contact.disclosure);
            if (!disclosureOk) {
                send({ approved: false, reason: 'Invalid disclosure' });
                return;
            }
            const outcome = await this.provision(id, contact);
            if (!outcome) {
                // Reported as its own retryable reason rather than falling through to the generic
                // catch below, which would report the misleading 'Internal formation error'.
                send({ approved: false, reason: 'Formation provisioning timed out' });
                return;
            }
            if (!outcome.approved) {
                // A post-validation rejection still discloses NEITHER identity NOR cadre,
                // exactly like the token/disclosure rejections above.
                send({ approved: false, reason: outcome.reason });
                return;
            }
            // Validation + provisioning passed → safe to disclose responder identity/cadre.
            const identity = this.options.getResponderIdentity();
            const strandAddrs = this.strandAddrsFor(id, outcome.result.strand.strandId);
            send({
                approved: true,
                partyId: identity.partyId,
                cadrePeerAddrs: identity.cadrePeerAddrs,
                // Omitted rather than sent empty: an absent field and an empty list mean the same
                // thing to the initiator, and omitting keeps every rejection-parity assertion a
                // plain `toBeUndefined()`.
                ...(strandAddrs.length > 0 ? { strandAddrs } : {}),
                provisionResult: outcome.result
            });
        }
        catch (err) {
            // Defense-in-depth: if an unexpected internal error escapes BEFORE any frame was
            // written (e.g. a future provisionStrand-hook bug), convert it into a non-disclosing
            // protocol rejection so the initiator sees a clean error instead of a read-error/
            // timeout. If a frame was already sent, leave the stream as-is and let handleStream
            // log + close. Re-throw either way so the failure is still recorded — this is a
            // deliberate, logged conversion, not silent.
            if (!wroteFrame) {
                const internalError = { approved: false, reason: 'Internal formation error' };
                try {
                    writeFrame(stream, internalError);
                }
                catch { /* stream already broken */ }
            }
            throw err;
        }
    }
}
/**
 * Open the formation stream under the dial deadline, cancelling the dial when it expires.
 *
 * The deadline's signal goes into `dialProtocol`, so an expired dial is abandoned by libp2p
 * rather than left running. A dial that settles in the same tick the deadline fires loses
 * the race to the timeout rejection and would leave its stream open with nobody to close
 * it, so a stream that arrives after the signal aborted is reset here — the same treatment
 * `exchangeFrame` (`control-stream.ts`) gives a stream dialed past its deadline. A late
 * rejection is the abort itself, or reaches the caller through the awaited copy, so the
 * handler below only stops it being reported as unhandled.
 */
function openFormationStream(node, addr, protocolId, dialTimeoutMs) {
    return withDeadline(dialTimeoutMs, 'Formation dial-connect', (signal) => {
        const pending = node.dialProtocol(addr, protocolId, { signal });
        void pending.then((stream) => {
            if (signal.aborted) {
                stream.abort(new Error('Formation dial-connect resolved after its deadline'));
            }
        }, () => { });
        return pending;
    });
}
/**
 * Initiator side of the native formation protocol. Dials the responder, sends the
 * contact (carrying the real disclosure/token/cadre), validates the responder's
 * result, and returns the strand the responder provisioned plus the responder's
 * strand-network addresses (see {@link FormationDialResult}).
 */
export async function dialFormation(node, options) {
    if (options.responderAddrs.length === 0) {
        throw new Error('No responder addresses available for formation');
    }
    const protocolId = options.protocolId ?? FORMATION_PROTOCOL;
    const deadlines = formationDeadlines(options.linkRoundTripMs);
    const sessionTimeoutMs = options.sessionTimeoutMs ?? deadlines.sessionMs;
    const dialTimeoutMs = options.dialTimeoutMs ?? deadlines.dialMs;
    const provisionTimeoutMs = resolveProvisionTimeoutMs(options.provisionTimeoutMs, deadlines.initiatorAwaitResponseMs, sessionTimeoutMs, dialTimeoutMs, 'dialFormation');
    const addr = multiaddr(options.responderAddrs[0]);
    return withTimeout(sessionTimeoutMs, 'Formation dial', async () => {
        const stream = await openFormationStream(node, addr, protocolId, dialTimeoutMs);
        try {
            const reader = new FrameReader(stream);
            writeFrame(stream, options.contact);
            const response = await withTimeout(provisionTimeoutMs, 'Formation await-response', () => reader.read());
            if (!response.approved) {
                throw new Error(`Formation rejected: ${response.reason ?? 'no reason provided'}`);
            }
            const ok = await options.validateResponse(response);
            if (!ok)
                throw new Error('Responder result failed validation');
            if (!response.provisionResult)
                throw new Error('Missing provision result for responderCreates mode');
            // Sanitized HERE — the wire boundary — so nothing above this call ever handles an
            // unvalidated, unbounded address list from a remote peer.
            return { provision: response.provisionResult, strandAddrs: sanitizeStrandAddrs(response.strandAddrs) };
        }
        finally {
            try {
                await stream.close();
            }
            catch { /* ignore */ }
        }
    });
}
//# sourceMappingURL=strand-formation-protocol.js.map