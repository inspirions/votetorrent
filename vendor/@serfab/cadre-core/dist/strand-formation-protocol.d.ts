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
import type { Libp2p } from '@libp2p/interface';
import type { StrandFormationDisclosure, StrandMembershipInvite } from './types.js';
/** Protocol id for the native formation transport (parallel to `/sereus/seed/1.0.0`). */
export declare const FORMATION_PROTOCOL = "/sereus/formation/1.0.0";
/**
 * Rejection reason for an invitation that cannot be redeemed at all — unknown, expired, or
 * fully spent. Shared with `StrandFormationManager`, which reports an
 * `InvitationExhaustedError` (an invite spent out from under a redemption already in flight)
 * with this SAME wording on purpose: a joiner that lost the race must be indistinguishable
 * from a non-racing latecomer, so the two sites must never drift apart.
 */
export declare const INVALID_TOKEN_REASON = "Invalid token";
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
export declare const MAX_STRAND_ADDRS = 16;
export type FormationParty = 'initiator' | 'responder';
export interface FormationStrandInfo {
    strandId: string;
    createdBy: FormationParty;
}
export interface FormationDbConnectionInfo {
    endpoint: string;
    credentialsRef: string;
}
export interface FormationProvisionResult {
    strand: FormationStrandInfo;
    /**
     * The strand's membership key (closed-strand read-gating secret), delivered to a
     * validated invitee for provision-then-record formation. Disclosed only AFTER token
     * + disclosure validation, exactly like the responder identity/cadre — a rejected or
     * already-used token discloses neither identity nor key. Absent for open strands.
     */
    memberPrivateKey?: string;
    /**
     * The joiner's single-use membership invitation into the (closed, bound) host
     * strand — issued by the responder's live strand runtime against `Strand.Invite`
     * just before the consent row was recorded. Same disclosure timing as
     * {@link memberPrivateKey}: present only on an approved result, absent for open
     * strands and the responder-provisions path. Bounded and shape-checked on the
     * initiator side ({@link isWellFormedMembershipInvite}) — a hostile responder's
     * malformed field fails validation rather than crashing the initiator.
     */
    membershipInvite?: StrandMembershipInvite;
    dbConnectionInfo: FormationDbConnectionInfo;
}
/**
 * Outcome of the responder's provisioning hook.
 *
 * Distinct from a bare {@link FormationProvisionResult} so the hook can REJECT a
 * formation AFTER token + disclosure validation — e.g. a bound invite naming a host
 * strand this responder has not yet converged on, or a concurrent-redemption collision.
 * Without this channel such cases threw inside provisioning, the stream closed with no
 * result frame, and the initiator saw a read-error/timeout instead of a clean
 * `approved: false`. A rejection still discloses NO responder identity/cadre.
 */
export type ResponderProvisionOutcome = {
    approved: true;
    result: FormationProvisionResult;
} | {
    approved: false;
    reason: string;
};
/** Initiator → Responder: carries the real token + disclosure + initiator cadre. */
export interface FormationContactMessage {
    /** The real invitation token. */
    token: string;
    /** Initiator's member key (peer id) — human-facing identity in logs and `FormStrandResult.memberKey`. */
    partyId: string;
    /**
     * Initiator's base64url ed25519 public key — the key behind `partyId`, written to
     * `FormationUsage.PeerKey` and covered by BOTH signed digests.
     */
    peerKey: string;
    /** Joiner-minted single-use nonce for THIS redemption; both signed digests cover it. */
    usageStampId: string;
    /**
     * The joiner's signature over the `'consent'` digest (see `formationConsentMessage`
     * in control-database.ts) — proof the named peer agreed to this redemption.
     */
    peerSignature: string;
    /** The real disclosure, carried verbatim. */
    disclosure: StrandFormationDisclosure;
    /** Initiator's real multiaddrs. */
    cadrePeerAddrs: string[];
}
/** Responder → Initiator: responder identity/cadre disclosed only after validation. */
export interface FormationResultMessage {
    approved: boolean;
    /** Present iff `approved === false`. */
    reason?: string;
    /** Responder's real party id (disclosed only after validation). */
    partyId?: string;
    /** Responder's real multiaddrs (omitted on rejection). */
    cadrePeerAddrs?: string[];
    /**
     * The responder's live STRAND-network multiaddrs for the provisioned strand — the
     * initiator's only cross-party discovery seed, since the strand-addr RPC that resolves
     * a sibling's strand addrs is membership-gated and answers own-party callers only.
     *
     * Disclosed on the same terms as `partyId`/`cadrePeerAddrs`: only after token +
     * disclosure validation AND an approving provisioning outcome; a rejection carries
     * none. Signaling-first, each entry ending in `/p2p/<responder strand transport
     * peerId>` so the initiator can attribute it. OMITTED when the responder holds no live
     * strand node for the provisioned strand (the responder-provisions path mints a strand
     * that has not launched yet) — an absent or empty list is legal and means "no
     * cross-party seed", never a protocol error.
     */
    strandAddrs?: string[];
    /** The provisioned strand/db result (always present on approval). */
    provisionResult?: FormationProvisionResult;
}
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
export declare function sanitizeStrandAddrs(addrs: unknown): string[];
/**
 * Is `value` a well-formed {@link StrandMembershipInvite} — exactly two bounded
 * base64url strings? The initiator-side shape check for the one attacker-influenced
 * OBJECT the formation result carries (`strandAddrs` gets the equivalent treatment in
 * {@link sanitizeStrandAddrs}): a malformed field from a hostile responder must fail
 * validation, never crash the initiator or be carried into the joiner's invite cache.
 * `undefined` is NOT well-formed — absence is legal on the result and callers gate on
 * presence first.
 */
export declare function isWellFormedMembershipInvite(value: unknown): value is StrandMembershipInvite;
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
export declare function isValidResponderCreatesResult(response: FormationResultMessage): boolean;
export interface FormationListenerOptions {
    /** Validate the invitation token; returns whether it is valid. */
    validateToken(token: string): Promise<{
        valid: boolean;
    }>;
    /** Validate the initiator's disclosure with the REAL token + disclosure. */
    validateDisclosure(token: string, disclosure: StrandFormationDisclosure): Promise<boolean>;
    /**
     * Provision (or, for provision-then-record, resolve + record consent against) the
     * strand (`responderCreates`) for the given initiator. The WHOLE contact message is
     * threaded in: the hook needs the REAL token to map the bound host strand, and the
     * joiner's `peerKey`/`usageStampId`/`peerSignature` to write the consent columns.
     *
     * Returns a {@link ResponderProvisionOutcome}: the hook may REJECT post-validation
     * (e.g. an unconverged host strand) and the listener turns that into a clean,
     * non-disclosing `approved: false` reply rather than dropping the result frame.
     *
     * `signal` is aborted when the listener's work budget expires: a hook that observes it
     * BEFORE writing abandons the redemption and leaves the invite unspent. Optional so
     * signal-unaware hooks (tests, mocks) stay assignable.
     */
    provisionStrand(contact: FormationContactMessage, signal?: AbortSignal): Promise<ResponderProvisionOutcome>;
    /** Responder identity, disclosed only AFTER token + disclosure validation passes. */
    getResponderIdentity(): {
        partyId: string;
        cadrePeerAddrs: string[];
    };
    /**
     * This node's live STRAND-network multiaddrs for a provisioned strand, read on the
     * approval path only (same disclosure timing as {@link getResponderIdentity}) and
     * carried back as {@link FormationResultMessage.strandAddrs}.
     *
     * Optional, and an empty answer is legal: the strand may not be running here yet (the
     * responder-provisions path mints it during this very session). The listener cannot
     * reach the strand runtime itself, so this is the seam `CadreNode` wires to its own
     * per-strand address lookup.
     */
    resolveStrandAddrs?(strandId: string): string[];
    /**
     * This machine's declared link round trip (`NetworkConfig.linkRoundTripMs`), from which
     * every deadline below takes its default ({@link formationDeadlines}). The default
     * declaration when omitted.
     */
    linkRoundTripMs?: number;
    /** Whole-session budget; default `sessionMs` of the derived ladder. */
    sessionTimeoutMs?: number;
    /** Budget for the contact-frame read; default `awaitContactMs` of the derived ladder. */
    stepTimeoutMs?: number;
    /**
     * Budget for the `provisionStrand` hook call, work plus settle grace — distinct from
     * `stepTimeoutMs` because provisioning is real work, not a bare wire read. Default
     * `provisionWorkMs + provisionGraceMs` of the derived ladder (171 s at the default
     * declaration); `0`/unset uses the default; a value that would outlive the session is
     * clamped ({@link resolveProvisionTimeoutMs}). See {@link formationDeadlines} for the ordering.
     */
    provisionTimeoutMs?: number;
    maxConcurrentSessions?: number;
}
/**
 * Responder side of the native formation protocol. Registers a libp2p handler and
 * drives each inbound stream through token + disclosure validation, provisioning,
 * and result delivery — enforcing the cadre-disclosure timing rule (responder cadre
 * is revealed only after validation; rejections disclose nothing).
 */
export declare class FormationListener {
    private readonly options;
    private readonly sessionTimeoutMs;
    private readonly awaitContactMs;
    private readonly provisionWorkMs;
    private readonly provisionGraceMs;
    private readonly maxConcurrentSessions;
    private readonly registered;
    private activeSessions;
    private sessionCounter;
    constructor(options: FormationListenerOptions);
    /** Number of in-flight inbound sessions. */
    get activeCount(): number;
    /** Register the formation handler on `node`. Rejects when libp2p refuses the registration. */
    register(node: Libp2p, protocolId?: string): Promise<void>;
    unregister(node: Libp2p, protocolId?: string): Promise<void>;
    private handleStream;
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
    private provision;
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
    private settleWithinGrace;
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
    private isJoinerConsentValid;
    /**
     * The strand addresses to disclose for an APPROVED provisioning, sanitized and capped.
     *
     * Never throws: a hook that fails (a strand runtime torn down mid-session) costs the
     * joiner its cross-party seed, not the formation it has already earned — the seed is
     * an optimization, the consent row is the commitment.
     */
    private strandAddrsFor;
    private runSession;
}
export interface FormationDialOptions {
    /** The contact message to send (real token, partyId, disclosure, initiator cadre). */
    contact: FormationContactMessage;
    /** Responder multiaddrs to dial. */
    responderAddrs: string[];
    /** Validate the responder's result; a false return aborts the formation. */
    validateResponse(response: FormationResultMessage): Promise<boolean>;
    /**
     * This machine's declared link round trip (`NetworkConfig.linkRoundTripMs`), from which
     * every deadline below takes its default ({@link formationDeadlines}). The default
     * declaration when omitted.
     */
    linkRoundTripMs?: number;
    /** Whole-session budget; default `sessionMs` of the derived ladder. */
    sessionTimeoutMs?: number;
    /**
     * Budget for `dial-connect`: opening the connection, through a relay if need be, and
     * negotiating the formation protocol. Default `dialMs` of the derived ladder.
     */
    dialTimeoutMs?: number;
    /**
     * Budget for the `await-response` read only (the responder's provisioning plus the reply's
     * travel time). Default `initiatorAwaitResponseMs` of the derived ladder; `0`/unset uses
     * the default; a value that would outlive the session is clamped. See
     * {@link formationDeadlines} for the ordering.
     */
    provisionTimeoutMs?: number;
    protocolId?: string;
}
/**
 * What one successful formation dial yields the initiator.
 *
 * The provisioned strand travels in {@link FormationProvisionResult}, but the responder's
 * strand-network addresses are NOT part of that structure — they are a disclosure of the
 * responder's live runtime, alongside `partyId`/`cadrePeerAddrs`, not a property of the
 * strand row. Returning them beside the provision result keeps that separation while
 * still handing the caller the one thing it needs to seed a cross-party mesh.
 *
 * `strandAddrs` is always an array and is frequently EMPTY — see
 * {@link FormationResultMessage.strandAddrs}.
 */
export interface FormationDialResult {
    provision: FormationProvisionResult;
    /** Sanitized + capped ({@link sanitizeStrandAddrs}); `[]` when the responder sent none. */
    strandAddrs: string[];
}
/**
 * Initiator side of the native formation protocol. Dials the responder, sends the
 * contact (carrying the real disclosure/token/cadre), validates the responder's
 * result, and returns the strand the responder provisioned plus the responder's
 * strand-network addresses (see {@link FormationDialResult}).
 */
export declare function dialFormation(node: Libp2p, options: FormationDialOptions): Promise<FormationDialResult>;
