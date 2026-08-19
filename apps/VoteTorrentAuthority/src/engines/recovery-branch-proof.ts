/**
 * recovery-branch-proof.ts — D-26a leg 5, LOCAL half (49-CONTEXT D-26/D-26a)
 *
 * WHY THIS EXISTS
 * D-26a requires the `KeyguardManager` recovery branch (API 24-29) to be demonstrated on the
 * Redmi 8. As originally specified, that leg is folded into D-24 leg 3's revoke-then-add
 * ceremony, whose success criterion is a replacement key landing in the network `UserKey`
 * table — so it cannot run until a network exists whose `User` resolves with BOTH keys
 * registered. That precondition has been blocked behind an unrelated P2P/relay chain.
 *
 * But the branch itself needs no network. Splitting the leg:
 *
 *   LOCAL  (this file)  — the recovery key signs, via the API-appropriate branch, after the
 *                         signing key has been invalidated, and the signature is accepted by
 *                         the SAME verifier the schema uses. No network, no relay, no drone.
 *   DEFERRED            — `UserKey.DeleteValid`/`InsertValid` accept the revoke+add round trip.
 *                         Genuinely needs network state; rides along whenever one next exists.
 *
 * WHAT THE LOCAL HALF DOES AND DOES NOT PROVE
 * It DOES prove the load-bearing D-26a claim (the branch runs and produces a valid P-256
 * signature) AND the encoding agreement that D-24 leg 1's second sub-claim is about — because
 * it verifies with `verifySigP256`, which IS the function `SignatureValidP256` calls. A
 * hand-rolled noble verify would prove nothing about schema agreement.
 * It does NOT prove the DB write path. Do not record it as closing D-24 leg 3.
 *
 * BRANCH ATTRIBUTION IS MEASURED, NOT INFERRED
 * The ceremony script's existing `recover-branch` sub-leg records PASS for SDK<30 on
 * "source-guaranteed" dispatch — it would print PASS on a device where the KeyguardManager path
 * never executed. Below API 30 that path calls
 * `KeyguardManager.createConfirmDeviceCredentialIntent` via `startActivityForResult`, and an OS
 * activity launch is observable in logcat independently of anything this app logs. The
 * accompanying script gates on that, so the branch is measured.
 */

import { verifySigP256 } from '@votetorrent/vote-engine/rn';
import { getDeviceProvisioningRecord } from './device-user';

const TAG = '[d26a-local]';

/** Plain base64 of RAW digest bytes — the `digestBase64` contract (NEVER base64url). */
function base64FromDigestBytes(digest: Uint8Array): string {
	let binary = '';
	for (let i = 0; i < digest.length; i++) binary += String.fromCharCode(digest[i]!);
	const { btoa: btoaFn } = globalThis as unknown as { btoa: (data: string) => string };
	return btoaFn(binary);
}

/**
 * base64url of the same raw bytes — what `verifySigP256` expects for its digest argument.
 * The two encodings are deliberately different at the two call sites; getting this wrong is
 * exactly the class of defect this proof is meant to catch, so both are derived here from the
 * SAME source bytes rather than converted from one another.
 */
function base64UrlFromDigestBytes(digest: Uint8Array): string {
	return base64FromDigestBytes(digest).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** A fixed, non-canonical digest. Deterministic so repeat runs are comparable. */
const PROOF_DIGEST = new Uint8Array(32).fill(0x5a);

export interface RecoveryBranchProofResult {
	passed: boolean;
	sdkInt?: number;
	branch?: 'keyguard-manager' | 'biometric-prompt-device-credential';
}

/**
 * Drive the recovery-key signing branch locally and verify the result.
 *
 * `native` is injected rather than imported so this module stays testable and does not pull the
 * TurboModule into a Node test graph.
 */
export async function runRecoveryBranchProof(
	native: {
		provisionRecoveryKey(alias: string): Promise<unknown>;
		signWithRecoveryKey(
			alias: string,
			digestBase64: string,
			promptTitle: string,
			promptSubtitle: string,
			promptNegativeButton: string,
		): Promise<unknown>;
	},
	recoveryKeyAlias: string,
	sdkInt: number,
	prompts: { title: string; subtitle: string; negative: string },
): Promise<RecoveryBranchProofResult> {
	const branch = sdkInt >= 30 ? 'biometric-prompt-device-credential' : 'keyguard-manager';
	console.info(`${TAG} starting`, JSON.stringify({ sdkInt, branch, recoveryKeyAlias }));

	try {
		// Source the PUBLIC value from the persisted provisioning record first, and fall back to
		// the native call only if absent. `provisionRecoveryKey` is idempotent as of 49-14's
		// `reuseExistingRecoveryKey` fix, but preferring the recorded value keeps this proof from
		// depending on that fix being present — a device on an older native build would otherwise
		// have its alias regenerated here and orphan whatever a network already holds.
		const record = await getDeviceProvisioningRecord().catch(() => undefined);
		let recoveryPubHex = record?.recoveryPublicKeyCompressedHex;
		if (!recoveryPubHex) {
			const provisioned = (await native.provisionRecoveryKey(recoveryKeyAlias)) as {
				publicKeyCompressedHex?: string;
			};
			recoveryPubHex = provisioned?.publicKeyCompressedHex;
			console.info(`${TAG} recovery key sourced from native (no provisioning record)`);
		} else {
			console.info(`${TAG} recovery key sourced from the provisioning record`);
		}
		if (!recoveryPubHex) {
			console.error(`${TAG} FAIL — no recovery public key available`);
			return { passed: false, sdkInt, branch };
		}

		// This raises the real credential UI: KeyguardManager below 30, BiometricPrompt
		// DEVICE_CREDENTIAL at 30+. A human must satisfy it with the DEVICE CREDENTIAL
		// (PIN/pattern/password) — never a fingerprint; the fingerprint is what invalidated the
		// signing key in the first place.
		console.info(`${TAG} ACTION REQUIRED — satisfy the DEVICE CREDENTIAL prompt (not a fingerprint)`);
		const signed = (await native.signWithRecoveryKey(
			recoveryKeyAlias,
			base64FromDigestBytes(PROOF_DIGEST),
			prompts.title,
			prompts.subtitle,
			prompts.negative,
		)) as { signatureHex?: string };

		const signatureHex = signed?.signatureHex;
		if (!signatureHex) {
			console.error(`${TAG} FAIL — native returned no signatureHex`);
			return { passed: false, sdkInt, branch };
		}
		console.info(`${TAG} signature obtained, hexLen=${signatureHex.length}`);

		// THE assertion: the schema's own verifier accepts a real Keystore P-256 signature.
		const valid = verifySigP256(
			base64UrlFromDigestBytes(PROOF_DIGEST),
			signatureHex,
			recoveryPubHex,
		);
		console.info(`${TAG} verifySigP256 =`, valid);
		console.info(`${TAG} ========== D-26A LOCAL VERDICT: ${valid === true ? 'PASS' : 'FAIL'} ==========`);
		return { passed: valid === true, sdkInt, branch };
	} catch (err) {
		// A cancellation is a legitimate outcome of a human-driven prompt, not a defect — log the
		// raw value so it is distinguishable from a genuine verification failure (the 49-14 lesson
		// about generic copy masking real faults).
		console.error(`${TAG} raw error —`, err);
		console.info(`${TAG} ========== D-26A LOCAL VERDICT: FAIL ==========`);
		return { passed: false, sdkInt, branch };
	}
}
