/**
 * VoteTorrent patch (public-observer-protocol): control-network strand-address
 * RPC for an UNAUTHENTICATED observer.
 *
 * A mirror of `strand-addr-protocol.js`'s receiver half, with the authorization
 * question replaced: the original gates on the REQUESTER's cadre membership
 * (`isMember`); this variant gates on the STRAND ITSELF being on a node-local,
 * operator-configured observable allowlist, and asks nothing about the peer at
 * all. A peer refused here (unlisted strand, or no allowlist configured) gets
 * the exact same empty address list an unauthorized peer gets from strand-addr
 * today — the response shape carries no signal that distinguishes "you are not
 * a member" from "this strand is not observable" from "no observability is
 * configured on this node".
 *
 * Deliberately absent from this module, and this is the point of it existing
 * separately rather than adding a branch to `strand-addr-protocol.js`: any read
 * of a delegate-announcement field, and any path that could reach the
 * connection-and-relay-reservation admission grant a member's announce can
 * mint in the original. Inheriting that path here would let an anonymous
 * stranger mint the same grant.
 */
import debug from 'debug';
import { decodeLengthPrefixedFrame } from './seed-bootstrap.js';
import { writeFrame, readStreamToEnd } from './control-stream.js';
const log = debug('sereus:cadre:strand-observer');
/** Protocol id for the control-network public-observer strand-address RPC. */
export const STRAND_OBSERVER_PROTOCOL = '/sereus/public-observer/1.0.0';
/**
 * Maximum observer-request frame size. Responses are tiny (a strand id + a few
 * multiaddrs), so this is a defensive cap that bounds the bytes a peer can make
 * the receiver buffer per stream — same reasoning and same value as the
 * members-only strand-addr protocol.
 */
const MAX_ADDR_SIZE = 64 * 1024;
/** Default time the receiver waits for an inbound request frame before aborting (ms). */
const DEFAULT_ADDR_READ_TIMEOUT_MS = 10000;
/** Default cap on concurrent inbound observer streams a single peer can pin open. */
const DEFAULT_MAX_CONCURRENT_ADDRS = 100;
/**
 * Read a libp2p stream to EOF and decode the single length-prefixed JSON frame
 * it carries. Bounded by `timeoutMs` (a never-half-closing peer is aborted, not
 * awaited forever) and capped at {@link MAX_ADDR_SIZE}.
 */
async function readFrame(stream, timeoutMs) {
    const data = await readStreamToEnd(stream, { maxBytes: MAX_ADDR_SIZE, timeoutMs, label: 'Strand-observer' });
    const body = decodeLengthPrefixedFrame(data, MAX_ADDR_SIZE);
    return JSON.parse(new TextDecoder().decode(body));
}
/** Empty response used on every reject/error path (cap, malformed frame, unobservable strand). */
function emptyResponse(strandId) {
    return { strandId, multiaddrs: [] };
}
/**
 * Receiver side of the public-observer strand-address RPC. Registers a
 * handler on the control node and, for each inbound request, gates on the
 * requested strand id being on the node-local observable allowlist — never on
 * who is asking — then replies with the local strand instance's live
 * multiaddrs (or an empty list when not observable / not running).
 */
export class StrandObserverService {
    constructor(options) {
        this.node = null;
        /** In-flight inbound observer streams, used to enforce {@link maxConcurrent}. */
        this.activeStreams = 0;
        this.options = options;
        this.readTimeoutMs = options.readTimeoutMs ?? DEFAULT_ADDR_READ_TIMEOUT_MS;
        this.maxConcurrent = options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT_ADDRS;
    }
    /** Number of in-flight inbound observer streams. */
    get activeCount() {
        return this.activeStreams;
    }
    /** Register the public-observer protocol handler on the control node. */
    initialize(node) {
        this.node = node;
        // `runOnLimitedConnection: true` for the same relay reason strand-addr
        // documents: a NAT'd peer may be reached only over a circuit-relay
        // connection, which libp2p marks "limited" — without this the receiver
        // would refuse the inbound stream on exactly the connection the protocol
        // is meant to use.
        void node.handle(STRAND_OBSERVER_PROTOCOL, async (rawStream, rawConnection) => {
            const remotePeerId = rawConnection.remotePeer.toString();
            await this.handleStream(rawStream, remotePeerId);
        }, { runOnLimitedConnection: true });
        log('StrandObserverService registered handler');
    }
    /** Unregister the handler and release the node reference. */
    async shutdown() {
        if (this.node) {
            await this.node.unhandle(STRAND_OBSERVER_PROTOCOL);
            this.node = null;
            log('StrandObserverService shutdown');
        }
    }
    /**
     * Read the inbound request, decide the response, and write it back.
     *
     * Three hardening layers, all reported as an empty response rather than a
     * dropped/hung stream: a concurrency cap (over {@link maxConcurrent}, reply
     * without looking up any address), a read timeout (a peer that never
     * half-closes is aborted inside {@link readFrame}/`readStreamToEnd`), and
     * the existing malformed/oversized-frame guard.
     */
    async handleStream(stream, remotePeerId) {
        log('Incoming observer request from: %s', remotePeerId);
        if (this.activeStreams >= this.maxConcurrent) {
            log('Rejecting observer request from %s: %d concurrent streams at cap %d', remotePeerId, this.activeStreams, this.maxConcurrent);
            // The request frame is unread here, so the strand id is unknown — reply
            // with an empty list under an empty strand id; the client treats any
            // empty response as "no addrs" and skips this sibling.
            try {
                writeFrame(stream, emptyResponse(''));
            }
            catch {
                // Ignore send errors on the reject path.
            }
            try {
                await stream.close();
            }
            catch {
                // Ignore close errors.
            }
            return;
        }
        this.activeStreams++;
        try {
            const request = await readFrame(stream, this.readTimeoutMs);
            const response = await this.processObserverRequest(request, remotePeerId);
            writeFrame(stream, response);
        }
        catch (err) {
            log('Error handling observer request from %s: %o', remotePeerId, err);
            // Malformed/oversized/timed-out request: strand id is unknown, so reply
            // with an empty list under an empty strand id rather than hanging.
            try {
                writeFrame(stream, emptyResponse(''));
            }
            catch {
                // Ignore send errors on the error path.
            }
        }
        finally {
            this.activeStreams--;
            try {
                await stream.close();
            }
            catch {
                // Ignore close errors.
            }
        }
    }
    /**
     * Decide the response for a decoded request. Exposed (not private), the
     * same reason strand-addr's `processAddrRequest` gives, so the decision
     * matrix can be unit-tested directly without a live node.
     *
     * - The requester's identity plays no role in this decision at all — the
     *   gate is on the STRAND, not the peer.
     * - A missing/non-string `strandId` is treated as not-observable rather
     *   than a throw or a lookup.
     * - An unlisted strand → empty `multiaddrs` (refused), same as an
     *   unauthorized member gets from strand-addr today.
     * - Strand not running locally → empty `multiaddrs` (`getStrandMultiaddrs` → `[]`).
     * - Listed + running strand → the strand's live multiaddrs, exactly the
     *   projection strand-addr already returns to members — no wider surface.
     */
    async processObserverRequest(request, remotePeerId) {
        const strandId = request && typeof request.strandId === 'string' ? request.strandId : undefined;
        if (strandId === undefined || !this.options.isObservableStrand(strandId)) {
            log('Refusing observer request for strand %o from %s', strandId, remotePeerId);
            return emptyResponse(strandId ?? '');
        }
        const multiaddrs = this.options.getStrandMultiaddrs(strandId);
        log('Observer strand-addr for %s → %d addr(s)', strandId, multiaddrs.length);
        return { strandId, multiaddrs };
    }
}
//# sourceMappingURL=strand-observer-protocol.js.map
