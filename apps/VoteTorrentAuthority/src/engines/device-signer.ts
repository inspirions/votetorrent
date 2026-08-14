/**
 * device-signer.ts — App-layer device signing module (D-01/D-09, Phase 49 hardware rewrite).
 *
 * SECURITY NOTES:
 *   D-01 (key boundary): The device private key NEVER crosses into JS, and — as of this
 *     rewrite — is never even READABLE by JS. Signing happens entirely inside the Android
 *     Keystore via the native `signWithDeviceKey` TurboModule method
 *     (`packages/attestation-native`, 49-04). `createDeviceSigner` resolves the device user's
 *     PUBLIC identity only; the returned callback sends nothing but the digest across the
 *     bridge and receives back a signature. No vote-engine method, and no JS code in this app,
 *     ever sees a private-key byte.
 *
 *   WR-10 (prehash contract): the native side signs via
 *     `Signature.getInstance("SHA256withECDSA")` against the AndroidKeyStore-resident P-256 key
 *     — the Keystore/JCA equivalent of `@noble/curves` v2's `prehash: true` default (signed
 *     domain = sha256(digest)). The returned signature is already compact, low-S hex
 *     (`derToCompactLowS`, 49-04) — this module does NOT re-normalize it.
 *
 *   D-01/D-06/D-17 (key storage — MIGRATED, this is the discharge of the old "v1.3 hardening
 *     task" deferral): the device signing key is hardware-backed (StrongBox/TEE) and
 *     biometric-gated per use (`BiometricPrompt.CryptoObject` binding, enforced natively). It is
 *     generated and held entirely inside the Android Keystore — this module never reads,
 *     writes, or holds the private key in JS, in memory, or in AsyncStorage.
 *
 *   D-03 (digest source): The engine computes the canonical SQL `Digest()` and passes the
 *     resulting bytes to this callback. The callback signs EXACTLY those bytes — it does NOT
 *     recompute a canonical form app-side.
 *
 *   D-14: this module performs NO key generation. An unprovisioned device rejects with
 *     `NO_KEY_PROVISIONED` before any native call is attempted — provisioning is a dedicated,
 *     biometric-gated ceremony (`ProvisionSigningKeyScreen`, 49-10), not something that can
 *     happen silently inside a generic signing call.
 */

import type { Signature } from '@votetorrent/vote-core'
import i18n from '../i18n'
import { getDeviceUser } from './device-user'
// Type-only import — erased at compile time (isolatedModules requires this to be explicit), so
// it produces NO runtime require of '@votetorrent/attestation-native/src/specs/NativeAttestation'
// and therefore does not trigger that module's top-level `TurboModuleRegistry.getEnforcing(...)`
// call. The runtime value is obtained lazily via `require(...)` inside `getNative()` below —
// mirrors `packages/attestation-native/src/real-attestation-producer.ts`'s own `getNative()` and
// its documented reason: `getEnforcing(...)` throws in any environment where the native module
// isn't registered (Node/jest). This file is imported TRANSITIVELY — without any native-bridge
// mock — by at least two real jest suites in this app (`KeyholderInvitationScreen.test.tsx`,
// `App.test.tsx`'s full eagerly-required navigation tree), so an eager top-level touch of the
// native module here would break them, exactly as `packages/attestation-native/src/index.ts`'s
// own barrel-export doc comment explains for the identical reason.
import type { Spec as NativeAttestationSpec } from '@votetorrent/attestation-native/src/specs/NativeAttestation'

/** Stable Keystore alias for the Authority app's primary device signing key (49-06). */
const SIGNING_KEY_ALIAS = 'VOTETORRENT_AUTHORITY_SIGNING_KEY_V1'

/**
 * App-layer sign callback type: receives canonical digest bytes from the engine and returns a
 * `Signature { signerUserId, signerKey, signature }`.
 *
 * D-09 frozen shape: every one of this app's ~22 non-test call sites depends on this signature
 * staying byte-identical across the hardware-signing rewrite.
 */
export type SignCallback = (digest: Uint8Array) => Promise<Signature>

/**
 * Lazily resolve the native TurboModule via a plain CommonJS `require()` — NOT a top-level
 * `import` and NOT `import()`. `require()` inside a function body is unambiguously lazy under
 * both Metro's CommonJS-based module runtime and Jest/Babel's CommonJS transform — the module
 * factory only executes when this function is actually called. NEVER call this at module scope
 * — see the top-level `import type` comment above for why.
 */
function getNative(): NativeAttestationSpec {
	// eslint-disable-next-line @typescript-eslint/no-var-requires -- deliberate lazy require, see comment above.
	return require('@votetorrent/attestation-native/src/specs/NativeAttestation').default as NativeAttestationSpec
}

/**
 * D-05 (Phase 28 discipline, carried forward): permanent production boot guard — fail loud if
 * the native module fails to resolve, or resolves but does not expose a callable
 * `signWithDeviceKey`, naming the Metro/autolinking failure mode. This is the direct successor
 * to the Phase 28 boot guard that asserted the @noble/curves signing function resolved to a
 * callable (`typeof <curve>.sign !== 'function'`), which is no longer meaningful now that this
 * file never touches `@noble/curves` at all.
 *
 * PLACEMENT DEVIATION FROM THE ORIGINAL D-05 PATTERN, DOCUMENTED DELIBERATELY: the original
 * guard ran at RAW MODULE-EVALUATION time (the top of the file), because `@noble/curves` has no
 * native bridge and resolves identically under Node/jest and Hermes — an eager check there was
 * safe everywhere. The `signWithDeviceKey` TurboModule spec is NOT safe to touch that early:
 * `TurboModuleRegistry.getEnforcing(...)` throws under Node/jest whenever the module is not
 * registered (documented in `packages/attestation-native/src/index.ts` and
 * `real-attestation-producer.ts`'s own header), and — per this file's own top-level comment —
 * this module is imported transitively, without any native-bridge mock, by real jest suites in
 * this app. An eager top-level call here would break them. This guard therefore runs as the
 * FIRST statement of `createDeviceSigner` instead of at file-parse time: still before ANY
 * prompt, before ANY key resolution, and still never `__DEV__`-gated — the earliest point at
 * which touching the native module is safe under this codebase's established jest-safety
 * discipline. See the 49-07 SUMMARY's Decisions Made section for the full rationale.
 */
function assertNativeSigningAvailable(): NativeAttestationSpec {
	let native: NativeAttestationSpec
	try {
		native = getNative()
	} catch (err) {
		throw new Error(
			'device-signer: @votetorrent/attestation-native TurboModule ("AttestationNative") did not ' +
				'resolve — the native module is not linked for this build (a Metro/autolinking failure, ' +
				'or a build that skipped the native rebuild required after this dependency was added). ' +
				'Original error: ' + (err instanceof Error ? err.message : String(err)),
		)
	}
	if (typeof native.signWithDeviceKey !== 'function') {
		throw new Error(
			'device-signer: @votetorrent/attestation-native resolved but signWithDeviceKey is not a ' +
				'function — got ' + typeof native.signWithDeviceKey + '. Stale codegen artifacts ' +
				'(regenerate via `./gradlew :app:generateCodegenArtifactsFromSchema`) or a ' +
				'Metro/autolinking mismatch are the likely cause.',
		)
	}
	return native
}

/**
 * Plain base64 (`Base64.NO_WRAP` equivalent) of the RAW digest bytes — never base64url, and
 * emphatically never the UTF-8 bytes of a base64url STRING. This is deliberately UNLIKE
 * `real-attestation-producer.ts`'s `base64FromUtf8` (which encodes the UTF-8 bytes of a
 * string): here the input is already raw bytes, and `signWithDeviceKey`'s documented contract
 * (`NativeAttestation.ts`) is plain base64 of those bytes directly. Repeating the
 * UTF-8-of-a-string asymmetry here would silently sign the wrong bytes — `verify()` swallows
 * exceptions and returns `false`, so a wrong-bytes signature looks like an ordinary "invalid
 * signature" rejection, not a crash.
 *
 * `btoa` IS a global on Hermes/RN and Node (proven available on-device elsewhere in this
 * codebase — see `real-attestation-producer.ts`'s identical `globalThis` cast and its comment on
 * why a cast, not an ambient declaration, is required under this app's `dom`-lib-free
 * `tsconfig.json`).
 */
function base64FromDigestBytes(digest: Uint8Array): string {
	let binary = ''
	for (let i = 0; i < digest.length; i++) binary += String.fromCharCode(digest[i]!)
	const { btoa: btoaFn } = globalThis as unknown as { btoa: (data: string) => string }
	return btoaFn(binary)
}

/**
 * Create a `SignCallback` that signs with the Authority app's hardware-backed, biometric-gated
 * device signing key (D-01/D-06/D-17).
 *
 * No key generation happens here — provisioning is 49-10's screen (D-14). If no device user is
 * provisioned at all, this rejects with `code: 'NO_KEY_PROVISIONED'` BEFORE any native call is
 * attempted (49-UI-SPEC.md's explicitly-flagged sixth condition). If a device user exists but
 * the Keystore alias itself is missing (e.g. Keystore was wiped independently of AsyncStorage),
 * the native `signWithDeviceKey` call itself rejects the SAME `NO_KEY_PROVISIONED` code — via
 * `keyStore.containsAlias`, checked native-side before any biometric prompt (49-04) — and that
 * rejection propagates unwrapped, per the "do not catch/wrap" rule below.
 *
 * @param displayName - kept for D-09 signature compatibility with all pre-existing call sites.
 *   Not used to create anything: the device user (if any) is already provisioned before this is
 *   called, and its already-stored `name` is authoritative.
 * @returns A `SignCallback` whose callback sends only the digest across the native bridge and
 *   returns the resulting signature. The private key itself never crosses into this function or
 *   its returned callback.
 * @throws A `NO_KEY_PROVISIONED`-coded error if no device user is provisioned.
 */
export async function createDeviceSigner (displayName: string): Promise<SignCallback> {
	void displayName
	const native = assertNativeSigningAvailable()

	const user = await getDeviceUser()
	if (!user) {
		const err = new Error('device-signer: no device signing key provisioned — cannot sign') as Error & { code: string }
		err.code = 'NO_KEY_PROVISIONED'
		throw err
	}
	const signerKey = user.activeKeys[0]?.key
	if (!signerKey) {
		const err = new Error('device-signer: device user has no active key — cannot sign') as Error & { code: string }
		err.code = 'NO_KEY_PROVISIONED'
		throw err
	}

	return async (digest: Uint8Array): Promise<Signature> => {
		const digestBase64 = base64FromDigestBytes(digest)

		// Do NOT catch, wrap, or re-map native rejections here. A native rejection's typed `code`
		// (D-13) must reach the call site UNWRAPPED so `deviceSigningError.ts`'s
		// `mapDeviceSigningError` can classify it — the same layering
		// `real-attestation-producer.ts` uses relative to `attestation-failure.ts`.
		const result = (await native.signWithDeviceKey(
			SIGNING_KEY_ALIAS,
			digestBase64,
			i18n.t('deviceSigningPromptTitle'),
			i18n.t('deviceSigningPromptSubtitle'),
			i18n.t('deviceSigningPromptNegativeButton'),
		)) as { signatureHex: string }

		return {
			signerUserId: user.id,
			signerKey,
			// Already compact, low-S hex (derToCompactLowS, 49-04) — do NOT re-normalize.
			signature: result.signatureHex,
		}
	}
}
