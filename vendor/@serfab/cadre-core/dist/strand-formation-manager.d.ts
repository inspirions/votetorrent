import type { Libp2p } from '@libp2p/interface';
import type { OpenInvitation, FormStrandResult, StrandFormationDisclosure, StrandMembershipInvite } from './types.js';
import type { DisclosureValidator, FormationUsageRecorder, StrandProvisioner, FormationResponseValidator } from './strand-solicitation.js';
/**
 * How long a formation-issued strand membership invitation stays redeemable (7 days).
 * The responder's {@link StrandFormationManagerOptions.issueMembershipInvite} hook stamps
 * `now + this` as the `Strand.Invite.Expiration`. Long enough for a slow joiner to bring
 * its strand node up and redeem; short enough that a lost formation result does not leave
 * a live bearer credential in the strand forever. An expired invitation rolls the
 * redemption back cleanly (the schema's `NotExpired` gate) — the joiner's recovery is a
 * fresh formation, which issues a fresh invitation.
 */
export declare const MEMBERSHIP_INVITE_TTL_MS: number;
/**
 * Rejection reason for a bound CLOSED-strand redemption whose responder could not issue
 * the joiner's membership invitation — the host strand runtime not live on this
 * responder (never launched, mid-start, or a hibernating one that did not wake within the
 * provisioning budget; a hibernating runtime is woken, not refused), no party identity key
 * yet, or the strand DB refusing the `Strand.Invite` write. Retryable on purpose, and
 * rejected BEFORE the consent row is recorded, so the formation token stays unspent:
 * approving without an invitation would admit a joiner that looks joined but can never
 * become a member, and a responder not running the strand cannot serve the joiner's sync
 * anyway. The one permanent failure, a pre-split host strand, gets
 * {@link HOST_STRAND_MUST_BE_RECREATED_REASON} instead.
 */
export declare const MEMBERSHIP_INVITE_UNAVAILABLE_REASON = "Strand membership invitation unavailable, retry";
/**
 * Rejection reason for a bound CLOSED-strand redemption whose host strand was founded
 * before the per-party identity split: the responder's founder launch refused it
 * (`PreSplitStrandIdentityError`), so no invitation can ever be issued into it. Not
 * retryable — the host must recreate the strand and issue a fresh invitation. Like
 * {@link MEMBERSHIP_INVITE_UNAVAILABLE_REASON}, rejected before consent is recorded, so
 * the formation token stays unspent.
 */
export declare const HOST_STRAND_MUST_BE_RECREATED_REASON = "Host strand must be recreated";
/**
 * Responder-side seam that issues a bound joiner's membership invitation — see
 * {@link StrandFormationManagerOptions.issueMembershipInvite} for the contract. `signal`
 * is the responder's provisioning budget: the issuer stops waiting (and throws) once it
 * aborts.
 */
export type MembershipInviteIssuer = (strandId: string, signal?: AbortSignal) => Promise<StrandMembershipInvite | null>;
/**
 * Configuration for StrandFormationManager
 */
export interface StrandFormationManagerConfig {
    /**
     * This machine's declared link round trip (`NetworkConfig.linkRoundTripMs`), from which
     * every formation deadline is derived (`formationDeadlines` in
     * `strand-formation-deadlines.ts`). `CadreNode` fills it from its network config; the
     * fields below override single rungs of that ladder.
     */
    linkRoundTripMs?: number;
    /** Whole-session budget, both roles, in milliseconds. */
    sessionTimeoutMs?: number;
    /** The responder's contact-frame read, in milliseconds. */
    stepTimeoutMs?: number;
    /** The initiator's dial-connect (open the connection, negotiate the protocol), in milliseconds. */
    dialTimeoutMs?: number;
    /**
     * Provisioning budget in milliseconds for the RESPONDER's `provisionStrand` hook call.
     * The initiator's `await-response` wait is derived automatically from this value plus the
     * travel margin of the derived ladder (`responseTravelMarginMs`) — never set directly — so
     * the ordering documented there (approval hook < responder provisioning < initiator
     * await-response < session) cannot collapse when this is configured.
     */
    provisionTimeoutMs?: number;
    /** Maximum concurrent sessions */
    maxConcurrentSessions?: number;
    /** Enable debug logging */
    enableDebugLogging?: boolean;
    /** Protocol ID override */
    protocolId?: string;
}
/**
 * Options for creating a StrandFormationManager
 */
export interface StrandFormationManagerOptions {
    /** Validates disclosures from initiators (responder side) */
    disclosureValidator?: DisclosureValidator;
    /** Records and validates token usage (responder side) */
    formationUsageRecorder?: FormationUsageRecorder;
    /** Provisions strands after validation (responder side) */
    strandProvisioner?: StrandProvisioner;
    /** Validates the responder's result (initiator side); defaults to a structural check */
    formationResponseValidator?: FormationResponseValidator;
    /** This party's ID for identification */
    partyId: string;
    /** This party's cadre peer addresses */
    cadrePeerAddrs?: string[];
    /**
     * This node's live STRAND-network multiaddrs for a strand it is running (responder
     * side). Wired by `CadreNode` to its own per-strand address lookup; the manager has no
     * route to the strand runtime itself.
     *
     * A hook, not a `config` knob, so it sits with the other responder-side seams
     * (`strandProvisioner`, `formationUsageRecorder`) rather than among the timeouts. Left
     * unwired — every mock/transport test — the responder simply discloses no strand
     * addresses and cross-party joiners fall back to an empty seed.
     */
    resolveStrandAddrs?: (strandId: string) => string[];
    /**
     * Issue a single-use `Strand.Invite` against the live host strand a BOUND redemption
     * resolved to (responder side) — the seam that gets the JOINER its own membership.
     * Like {@link resolveStrandAddrs}, the formation layer cannot reach the strand
     * runtime itself, so `CadreNode` wires this to its own running-instance +
     * `StrandPartyKey` lookup.
     *
     * Contract: return the issued invitation for a CLOSED host strand; return `null`
     * for an open one (no members, nothing to invite into); THROW when a closed strand's
     * invitation cannot be issued (runtime not live, no party key, strand DB write
     * rejected) — the manager then rejects the whole redemption with
     * {@link MEMBERSHIP_INVITE_UNAVAILABLE_REASON} BEFORE recording consent, so the
     * formation token stays unspent and the joiner can retry. Throw a
     * `PreSplitStrandIdentityError` for a host strand that can never issue one; that maps
     * to the non-retryable {@link HOST_STRAND_MUST_BE_RECREATED_REASON}.
     *
     * A hibernating host runtime is not a reason to throw: the issuer wakes it first,
     * bounded by `signal` (the responder's provisioning budget), and throws only when the
     * wake does not finish in time or fails.
     *
     * Left unwired — mock/transport tests — the bound path approves with no invitation,
     * mirroring the unwired {@link resolveStrandAddrs} posture. Production
     * (`CadreNode.initializeStrandSolicitation`) always wires it.
     */
    issueMembershipInvite?: MembershipInviteIssuer;
    /** Configuration options */
    config?: StrandFormationManagerConfig;
}
/**
 * StrandFormationManager drives the native cadre-core formation transport
 * (`strand-formation-protocol.ts`) from cadre-core's strand-solicitation interfaces.
 *
 * Responder side: a {@link FormationListener} wires the inbound protocol to
 * {@link FormationUsageRecorder} (token), {@link DisclosureValidator} (identity),
 * and {@link StrandProvisioner} (provisioning), disclosing this party's real
 * identity + cadre only after validation.
 *
 * Initiator side: {@link formStrand} dials the responder carrying the real
 * disclosure/token/cadre, then validates the responder's result via the
 * {@link FormationResponseValidator} (or a built-in structural check).
 */
export declare class StrandFormationManager {
    private readonly disclosureValidator?;
    private readonly formationUsageRecorder?;
    private readonly strandProvisioner?;
    private readonly formationResponseValidator?;
    private readonly partyId;
    private readonly cadrePeerAddrs;
    private readonly resolveStrandAddrs?;
    private readonly issueMembershipInvite?;
    private readonly config;
    private readonly listener;
    private readonly registeredNodes;
    private dialerSessions;
    constructor(options: StrandFormationManagerOptions);
    /**
     * Register this manager as a protocol handler on a libp2p node.
     * Call this on the control network node to handle incoming formation requests.
     */
    registerResponder(node: Libp2p, protocolId?: string): Promise<void>;
    /**
     * Unregister the protocol handler from a libp2p node.
     */
    unregisterResponder(node: Libp2p, protocolId?: string): Promise<void>;
    /**
     * Form a strand with a responder via an open invitation (initiator side).
     *
     * Builds a contact message carrying the real token + disclosure + this party's
     * real cadre addresses + the joiner's consent (minted and signed by the
     * solicitation layer — this manager only places it on the contact), dials the
     * responder over the native protocol, and validates the responder's result
     * before returning.
     */
    formStrand(invitation: OpenInvitation, disclosure: StrandFormationDisclosure, consent: {
        peerKey: string;
        usageStampId: string;
        peerSignature: string;
    }, node: Libp2p): Promise<FormStrandResult>;
    /**
     * Get the number of active sessions
     */
    getActiveSessionCounts(): {
        listeners: number;
        dialers: number;
    };
    /**
     * The provision result's membership invitation, iff well-formed — a malformed one
     * (possible only past a custom {@link FormationResponseValidator} that skipped the
     * structural check) is dropped with a log rather than cached: it could never redeem
     * anyway, and carrying an unbounded hostile object outlives the session.
     */
    private membershipInviteFrom;
    /**
     * Derive the initiator's await-response budget from the configured RESPONDER budget —
     * never the same number (see `StrandFormationManagerConfig.provisionTimeoutMs`): the
     * configured value plus the travel margin the ladder derives at this machine's link.
     * Mirrors `resolveProvisionTimeoutMs`'s own "`0`/negative means unset" rule so an unset
     * config still lets both sides fall back to their own derived defaults; must NOT
     * reproduce the derived default here, or the per-role clamping downstream is defeated.
     * A value too large for the session is clamped per role, and the responder's ceiling holds
     * the margin back, so the ordering survives there too.
     */
    private initiatorProvisionTimeoutMs;
    private validateToken;
    private validateDisclosure;
    /**
     * Responder-side provisioning. Routes on how the invite resolves
     * ({@link ResolvedHostStrand}), and can REJECT post-validation by returning a
     * {@link ResponderProvisionOutcome} with `approved: false` — `runSession` turns that
     * into a clean, non-disclosing reply instead of a dropped result frame.
     *
     * - **bound** (host strand present): provision-then-record, in three steps —
     *   (1) authorize ({@link authorizeBoundUsage}: the outside approval when the invite
     *   demands one, and a seat pre-check), so a refused join writes nothing into the host
     *   strand; (2) issue the joiner's single-use strand membership invitation via the wired
     *   `issueMembershipInvite` seam ({@link issueBoundMembershipInvite}; a closed strand whose
     *   invitation cannot be issued rejects retryably HERE, before any consent row spends the
     *   token); (3) write the single `FormationUsage` consent row against the pre-existing
     *   strand (record-only) and return it + its membership key + the invitation (all
     *   read-gating secrets disclosed only here, behind the token + disclosure validation
     *   `runSession` already enforced).
     * - **missing** (invite names a host strand absent on this responder, e.g. unconverged):
     *   reject cleanly + retryably, writing NO usage row — recording usage here would fail the
     *   deferred `StrandExists` CHECK at commit and drop the frame.
     * - **unbound** (no binding): the responder-provisions fallback — see {@link provisionUnbound}.
     *
     * Defense-in-depth: known provisioning/redeem failures are caught and mapped to a logged
     * protocol rejection rather than a thrown insert + a silently-closed stream. The mapping is
     * per-failure, NOT blanket retry-suggesting: an exhausted invitation
     * ({@link InvitationExhaustedError}, raised by `ControlDatabase` when the count of recorded
     * uses has reached the invite's seat budget — which is how the loser of a same-node race
     * surfaces, the local write queue having serialized the two writes) is reported as
     * `'Invalid token'`, because retrying it can never succeed. Concurrent redemptions never
     * contend for a shared row key — each writes under its own `UsageStampId` — so there is no
     * key collision to surface here at all. The LOG-before-reject keeps this a deliberate
     * internal-error→protocol-rejection conversion (AGENTS.md: don't eat exceptions silently),
     * not control-flow-by-exception.
     */
    private provisionAsResponder;
    /**
     * Authorize a BOUND redemption without writing it, through the recorder's optional
     * {@link FormationUsageRecorder.authorizeUsage}. A recorder without it has nothing to ask up
     * front, so its handle defers everything to `recordUsage`.
     */
    private authorizeBoundUsage;
    /**
     * Issue the joiner's membership invitation for a BOUND redemption via the wired
     * {@link StrandFormationManagerOptions.issueMembershipInvite} seam. Runs after the
     * redemption is authorized ({@link authorizeBoundUsage}) and before consent is recorded.
     *
     * - Hook unwired (mock/transport tests): approve with no invitation, the same posture
     *   as an unwired `resolveStrandAddrs`.
     * - Hook returns an invitation (closed host strand): carry it on the approval.
     * - Hook returns `null` (open host strand): approve with no invitation.
     * - Hook throws (runtime not live — including a hibernating one whose wake outran
     *   `signal` — no party key, strand-DB write rejected): report
     *   `ok: false` with {@link MEMBERSHIP_INVITE_UNAVAILABLE_REASON} — the caller rejects
     *   BEFORE any consent row is written, so the formation token stays unspent.
     * - Hook throws `PreSplitStrandIdentityError` (the host strand was founded before the
     *   per-party identity split and can never issue one): same, but with the
     *   non-retryable {@link HOST_STRAND_MUST_BE_RECREATED_REASON}.
     *
     * The LOG-before-reject keeps both a deliberate internal-error→protocol-rejection
     * conversion, same as the catch-all in {@link provisionAsResponder}.
     */
    private issueBoundMembershipInvite;
    /**
     * Responder-provisions fallback (invite binds no host strand). Precedence:
     *
     * 1. `recorder.provisionAndRecord` present (a real DB recorder) → atomic create-strand +
     *    record-consent, so the unbound redemption is single-use just like the bound path.
     *    Returns the new strand (+ key, null for an open responder-provisioned strand).
     * 2. else `strandProvisioner` present → the mock/transport-test contract: provision a bare
     *    strand, NO inline usage write (those callers record usage explicitly via
     *    `recordFormationComplete`, or assert transport invariants only). Threads the invite's
     *    REAL `sAppId`.
     * 3. else → a structural placeholder (no recorder + no provisioner ⇒ no single-use semantics
     *    exist to enforce).
     *
     * NOTE: accepted tradeoff — the plan chose (a) "record usage on the fallback" over (b)
     * "remove the fallback", so arm 2 (`strandProvisioner`, no recorder) is kept. (a) closes the
     * single-use hole with a targeted atomic create+record and leaves the `StrandProvisioner`
     * mock-transport tests untouched; (b) would delete the provisioner surface and churn ~6 unit
     * + ~6 integration sites for ZERO production benefit (production — `cadre-web.ts` /
     * `cadre-phone.ts` — always publishes strand-BOUND invites and treats the
     * responder-provisions placeholder as failure). Revisit if production starts publishing
     * unbound invites, or the mock-transport tests go away.
     */
    private provisionUnbound;
    /** Wrap a provision result as an approving {@link ResponderProvisionOutcome}. */
    private approve;
    /**
     * The invite's authoritative `sAppId` for the responder-provisions fallback, read back
     * from the recorder's `isTokenValid` invitation (the real `FormationInvite.sAppId`).
     * Empty string when no recorder is wired or the invitation omits it.
     */
    private resolveInviteSAppId;
    private validateResponse;
}
/**
 * Create a StrandFormationManager with the given options
 */
export declare function createStrandFormationManager(options: StrandFormationManagerOptions): StrandFormationManager;
