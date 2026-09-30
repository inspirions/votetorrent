/**
 * Default policy: trust only keys already in the receiver's node-local
 * trusted-owner anchor. A node whose anchor was never seeded (no genesis, no
 * invite pin, no operator pin) rejects every seed.
 */
export function anchoredTrustPolicy() {
    return {
        evaluate({ signerKey, knownOwnerKeys }) {
            if (knownOwnerKeys.has(signerKey)) {
                return { trusted: true };
            }
            return {
                trusted: false,
                reason: 'Signer key is not an anchored owner (anchored trust policy)',
            };
        },
    };
}
/**
 * Cold-start policy: trust anchored keys plus a set pinned out-of-band
 * (typically `CadreInvite.ownerKeys` or operator config). Lets an unenrolled
 * invitee accept its first seed without the seed vouching for itself.
 *
 * @param anchorAs - provenance under which a pin-only acceptance is persisted
 *   into the node-local anchor ('invite' by default — the invite-redemption
 *   case; pass 'operator' for an operator-supplied pin).
 */
export function pinnedKeyTrustPolicy(pinned, anchorAs = 'invite') {
    const pinnedSet = new Set(pinned);
    return {
        evaluate({ signerKey, knownOwnerKeys }) {
            if (knownOwnerKeys.has(signerKey)) {
                return { trusted: true };
            }
            if (pinnedSet.has(signerKey)) {
                return { trusted: true, anchorAs };
            }
            return {
                trusted: false,
                reason: 'Signer key is neither an anchored nor a pinned owner (pinned-key trust policy)',
            };
        },
    };
}
/**
 * Opt-in interactive policy: trust keys already in the node-local anchor, and
 * on an unknown key invoke `confirm` (e.g. a trust-circle UI prompt). The key is
 * trusted iff `confirm` resolves true, and a confirmed key is persisted into the
 * anchor as an 'operator' pin (a human at the console is the same provenance as
 * an explicit operator pin) so the prompt is not repeated. Not enabled by default.
 */
export function tofuTrustPolicy(confirm) {
    return {
        async evaluate(ctx) {
            if (ctx.knownOwnerKeys.has(ctx.signerKey)) {
                return { trusted: true };
            }
            const accepted = await confirm(ctx);
            return accepted
                ? { trusted: true, anchorAs: 'operator' }
                : { trusted: false, reason: 'TOFU confirmation declined for unknown signer key' };
        },
    };
}
//# sourceMappingURL=seed-trust-policy.js.map