import debug from 'debug';
import { toString as uint8ArrayToString } from 'uint8arrays';
import { generateKeyPair, privateKeyToProtobuf } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { sign } from '@optimystic/quereus-plugin-crypto';
// control-database does not import this service, so these imports introduce no cycle.
import { generateStampId, formationConsentMessage } from './control-database.js';
import { canonicalJson } from './canonical-json.js';
import { ed25519KeyPairFromLibp2p } from './ed25519-key.js';
import { mintPlaceholderStrandId } from './strand-id.js';
import { StrandFormationManager } from './strand-formation-manager.js';
import { isValidResponderCreatesResult } from './strand-formation-protocol.js';
const log = debug('sereus:cadre:solicitation');
/**
 * Built-in structural {@link FormationResponseValidator}.
 *
 * `validateResponse` rejects when the responder did not approve, omitted a disclosed
 * identity, returned no/placeholder cadre addresses, or returned a missing/empty or
 * non-responder-created strand (see {@link isValidResponderCreatesResult}).
 * Apps can supply a stricter validator via {@link StrandSolicitationServiceOptions}.
 */
export function createDefaultFormationResponseValidator() {
    return {
        async validateResponse({ response }) {
            return isValidResponderCreatesResult(response);
        }
    };
}
/**
 * Strand Solicitation API for forming strands via open invitations.
 *
 * This service handles the high-level API defined in api.md:
 * - formStrand(invitation, disclosure, node) - called by initiator
 *
 * Outside approval of a redemption (an invite's `ValidationUrl`) is NOT here: it belongs to
 * the redeeming node, which alone mints the nonce the approval is bound to. See
 * `formation-approval.ts`.
 *
 * When a libp2p node is provided, the underlying protocol is handled by the
 * native cadre-core formation transport via StrandFormationManager.
 */
export class StrandSolicitationService {
    constructor(options) {
        /**
         * Tokens this process has minted (or published), mapped to their expiry
         * epoch-ms — the in-memory half of {@link hasOutstandingInvitation}. Dies with
         * the process, exactly like `CadreNode`'s enrollment window; a token that also
         * reached the durable `FormationInvite` table survives via the recorder.
         *
         * NOTE: pruned only while {@link hasOutstandingInvitation} runs, so a node that
         * mints steadily and never receives an inbound stranger retains every entry for
         * the process's life. Bounded by mint rate today; if a host ever mints at scale,
         * prune on a timer (or cap the map) instead of only on read.
         */
        this.mintedInvitations = new Map();
        this.disclosureValidator = options?.disclosureValidator;
        this.formationUsageRecorder = options?.formationUsageRecorder;
        this.strandProvisioner = options?.strandProvisioner;
        this.formationResponseValidator = options?.formationResponseValidator;
        this.partyId = options?.partyId ?? `party-${Date.now()}`;
        this.cadrePeerAddrs = options?.cadrePeerAddrs ?? [];
        this.resolveStrandAddrs = options?.resolveStrandAddrs;
        this.issueMembershipInvite = options?.issueMembershipInvite;
        this.formationConfig = options?.formationConfig;
        log('StrandSolicitationService created for party: %s', this.partyId);
    }
    /**
     * Get or create the StrandFormationManager.
     * Lazily initialized to allow configuration after construction.
     */
    getFormationManager() {
        if (!this.formationManager) {
            this.formationManager = new StrandFormationManager({
                disclosureValidator: this.disclosureValidator,
                formationUsageRecorder: this.formationUsageRecorder,
                strandProvisioner: this.strandProvisioner,
                formationResponseValidator: this.formationResponseValidator,
                partyId: this.partyId,
                cadrePeerAddrs: this.cadrePeerAddrs,
                resolveStrandAddrs: this.resolveStrandAddrs,
                issueMembershipInvite: this.issueMembershipInvite,
                config: this.formationConfig
            });
        }
        return this.formationManager;
    }
    /**
     * Register as a responder on a libp2p node.
     * This enables the node to handle incoming strand formation requests.
     */
    async registerResponder(node) {
        await this.getFormationManager().registerResponder(node);
        log('Registered as responder');
    }
    /**
     * Unregister as a responder from a libp2p node.
     */
    async unregisterResponder(node) {
        await this.getFormationManager().unregisterResponder(node);
        log('Unregistered as responder');
    }
    /**
     * Form a strand with a responder via an open invitation.
     *
     * Called by the initiator (the party who received an out-of-band invitation).
     * This generates a member key, contacts the responder's cadre, and negotiates
     * strand formation.
     *
     * @param invitation The open invitation
     * @param disclosure Identity/context information to share with the responder
     * @param node Optional libp2p node for real protocol handling
     * @returns The member key and strand info if successful
     */
    async formStrand(invitation, disclosure, node) {
        const token = invitation.token;
        log('Forming strand with token: %s', token);
        // Generate a new keypair for this strand membership
        const privateKey = await generateKeyPair('Ed25519');
        const peerId = peerIdFromPrivateKey(privateKey);
        const privateKeyBytes = privateKeyToProtobuf(privateKey);
        const memberKey = peerId.toString();
        const invitePrivateKey = uint8ArrayToString(privateKeyBytes, 'base64');
        log('Generated member key: %s', memberKey);
        // If we have a node, use the real protocol
        if (node) {
            log('Using native cadre-core formation transport');
            const { privateKeyB64, publicKeyB64 } = ed25519KeyPairFromLibp2p(privateKey);
            const usageStampId = generateStampId(memberKey);
            // Built ONCE, AFTER the partyId override: this exact object travels to the
            // responder, and its canonical serialization is the disclosure text the consent
            // signature covers and the responder writes to `FormationUsage.Disclosure`.
            const fullDisclosure = { ...disclosure, partyId: memberKey };
            const peerSignature = sign(formationConsentMessage({
                token,
                usageStampId,
                peerKey: publicKeyB64,
                disclosure: canonicalJson(fullDisclosure)
            }), privateKeyB64, 'ed25519', 'bytes', 'base64url', 'base64url');
            const result = await this.getFormationManager().formStrand(invitation, fullDisclosure, { peerKey: publicKeyB64, usageStampId, peerSignature }, node);
            return {
                memberKey,
                invitePrivateKey,
                strandId: result.strandId,
                // Carry the host strand's membership key delivered over the protocol (closed-strand
                // provision-then-record). invitePrivateKey stays the initiator's generated signing key.
                memberPrivateKey: result.memberPrivateKey,
                // The joiner's own single-use membership invitation into a closed host strand
                // (already shape-checked by the manager); absent for open/unbound.
                membershipInvite: result.membershipInvite,
                // The responder's live strand-network addresses, or `[]` when it had none to give.
                strandAddrs: result.strandAddrs
            };
        }
        // Fallback: placeholder strandId (for testing without network)
        log('No node provided, using placeholder strandId');
        const strandId = mintPlaceholderStrandId();
        return {
            memberKey,
            invitePrivateKey,
            strandId,
            // No wire, so nothing was disclosed — an empty seed, never absent.
            strandAddrs: []
        };
    }
    /**
     * Create an open invitation for others to form strands with this party.
     *
     * @param sAppId The sApp to use for formed strands
     * @param expirationMs How long the invitation is valid (ms from now)
     * @param bootstrap Bootstrap addresses for contacting this party's cadre
     * @returns The open invitation to share out-of-band
     */
    async createOpenInvitation(sAppId, expirationMs, bootstrap) {
        // Generate a unique token
        const token = `invite-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
        const expiration = new Date(Date.now() + expirationMs);
        this.registerMintedInvitation(token, expiration.getTime());
        log('Created open invitation: %s (expires %s)', token, expiration.toISOString());
        return {
            token,
            sAppId,
            expiration,
            bootstrap
        };
    }
    /**
     * Remember a token this node minted (or published) so
     * {@link hasOutstandingInvitation} can answer "yes" before the durable
     * `FormationInvite` row is readable — or when there is no durable store at
     * all. `expiresAtMs` may be `Number.POSITIVE_INFINITY` for an invitation that
     * never expires.
     */
    registerMintedInvitation(token, expiresAtMs) {
        this.mintedInvitations.set(token, expiresAtMs);
        log('Registered minted invitation %s (expires %d)', token, expiresAtMs);
    }
    /**
     * Does this node currently expect a stranger — i.e. is at least one open
     * invitation unexpired and not yet fully consumed? Sole input to the
     * control-network connection gate's formation exemption.
     *
     * Two sources, in order:
     *
     *  1. The local mint registry ({@link registerMintedInvitation}), which is
     *     in-memory and dies with the process. Expired entries are dropped. With
     *     no {@link FormationUsageRecorder} configured there is no consumption
     *     oracle, so an unexpired minted token counts as outstanding by
     *     construction; with one, a token it reports used is deleted (consumption
     *     is permanent, so the registry never reconsiders it).
     *  2. The recorder's optional {@link FormationUsageRecorder.hasOutstandingInvitation},
     *     which survives restarts and sees invitations replicated in from siblings.
     *
     * Re-entrant: concurrent inbound connections each call this independently and
     * the only mutation is deleting expired/consumed entries, which is monotonic.
     */
    async hasOutstandingInvitation() {
        const now = Date.now();
        for (const [token, expiresAtMs] of this.mintedInvitations) {
            if (expiresAtMs <= now) {
                this.mintedInvitations.delete(token);
                continue;
            }
            if (!this.formationUsageRecorder) {
                return true;
            }
            if (!(await this.formationUsageRecorder.isTokenUsed(token))) {
                return true;
            }
            this.mintedInvitations.delete(token);
        }
        return (await this.formationUsageRecorder?.hasOutstandingInvitation?.()) ?? false;
    }
    /**
     * Record that a formation was completed successfully.
     * Called after strand provisioning to track usage.
     *
     * `consent` carries the joiner-signed fields `recordUsage` now requires
     * (see {@link FormationUsageRecorder.recordUsage}); this helper only passes them through.
     *
     * NOTE: this reaches `recordUsage` without passing through
     * `StrandFormationManager.provisionAsResponder`, so `disclosure` skips that path's
     * `MAX_DISCLOSURE_BYTES` cap. Harmless today — its only callers are integration-test mocks
     * that all default to `''` — but if a production caller ever passes a real disclosure here,
     * cap it too (the approver signs those bytes verbatim).
     */
    async recordFormationComplete(token, peerKey, strandId, consent, disclosure = '') {
        if (this.formationUsageRecorder) {
            await this.formationUsageRecorder.recordUsage({
                token,
                peerKey,
                peerSignature: consent.peerSignature,
                usageStampId: consent.usageStampId,
                strandId,
                disclosure
            });
            log('Recorded formation usage: token=%s strand=%s', token, strandId);
        }
    }
}
//# sourceMappingURL=strand-solicitation.js.map