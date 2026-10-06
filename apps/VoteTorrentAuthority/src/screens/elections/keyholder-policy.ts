/**
 * Keyholder policy guard for Create / Edit Election.
 *
 * Mirrors vote-engine's `assertDkgThreshold` (2 <= threshold <= participants): no device ever
 * holds the full key, and a threshold of 1 would let a single keyholder decrypt results early.
 * An election proposed below 2-of-2 can never generate its key, so the UI refuses it up front.
 * The ElectionRevision schema is deliberately not tightened; the DKG is the backstop.
 *
 * Operates on already-trimmed, non-empty keyholder names.
 */
export type KeyholderPolicyReason = "too-few-keyholders" | "threshold-too-low" | "threshold-above-count";

export type KeyholderPolicyResult = { ok: true } | { ok: false; reason: KeyholderPolicyReason };

export function validateKeyholderPolicy(keyholders: string[], threshold: number): KeyholderPolicyResult {
	if (keyholders.length < 2) return { ok: false, reason: "too-few-keyholders" };
	if (threshold < 2) return { ok: false, reason: "threshold-too-low" };
	if (threshold > keyholders.length) return { ok: false, reason: "threshold-above-count" };
	return { ok: true };
}

/** i18n key for a refusal reason. */
export const KEYHOLDER_POLICY_ERROR_KEY: Record<KeyholderPolicyReason, string> = {
	"too-few-keyholders": "keyholderPolicyTooFewKeyholders",
	"threshold-too-low": "keyholderPolicyThresholdTooLow",
	"threshold-above-count": "keyholderPolicyThresholdAboveCount",
};
