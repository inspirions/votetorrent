/**
 * real-attestation-producer.ts — JS orchestration for the D-11 two-step attestation producer
 * (Phase 45-05). This is the JS half of the device-side attestation producer; all platform-API
 * calls (StrongBox/TEE/BiometricPrompt/Play Integrity) live in the 45-01/45-02 Kotlin
 * TurboModule (`./specs/NativeAttestation`) — this module owns the crypto-decision +
 * orchestration layer that must emit exactly the bytes Phase 43's shipped
 * `PlayIntegrityVerifier` consumes (`packages/vote-engine/ATTESTATION-CONTRACT.md`).
 *
 * IMPORTANT (testability): this file's TOP-LEVEL evaluation is kept pure — it does NOT import
 * the native TurboModule spec's default export at module scope, because
 * `TurboModuleRegistry.getEnforcing(...)` throws in any environment where the native module
 * isn't registered (Node/jest). The native module is accessed LAZILY (see
 * `createRealAttestationProducer` below) so that merely importing this module — and running
 * `computeBoundDigest` + the D-16b probe — works under Node/jest without the native module
 * present.
 */

import { digestFields, resolveHasher, resolveOutputEncoder } from '@optimystic/quereus-plugin-crypto'
import { cborDecode, type CborValue } from '@votetorrent/vote-core'
import type { AttestationChallenge, DeviceAttestation, IOSAttestationDetails } from '@votetorrent/vote-core'
// Type-only import — erased at compile time (isolatedModules requires this to be explicit), so
// it produces NO runtime require of './specs/NativeAttestation' and therefore does not trigger
// that module's top-level `TurboModuleRegistry.getEnforcing(...)` call. The runtime value is
// obtained lazily via `require(...)` inside `getNative()` below.
import type { Spec as NativeAttestationSpec } from './specs/NativeAttestation'

// Resolved ONCE at module scope — must match packages/vote-engine/ATTESTATION-CONTRACT.md §1 and
// database/initialize.ts's registered SQL Digest() config exactly, or the producer's digest
// silently diverges from the SQL/verifier path (SIGN-05, D-06).
const hasher = resolveHasher('sha256')
const encode = resolveOutputEncoder('base64url')

/**
 * Compute the canonical injective digest binding a challenge nonce to a device's voting public
 * key: `Digest(nonce, deviceKey)`, sha256/base64url. Field ORDER is `[nonce, deviceKey]`, never
 * reversed; never hand-roll `sha256(nonce + deviceKey)` (the encoding is length-prefixed and
 * type-tagged, not concatenation) — mirrors
 * `packages/vote-engine/src/association/verifiers/digest-binding.ts`'s `recomputeChallengeDigest`
 * byte-for-byte.
 */
export function computeBoundDigest(nonce: string, deviceKey: string): string {
	return digestFields([nonce, deviceKey], hasher, encode) as string
}

/**
 * D-16b module-load probe: assert this runtime's `digestFields` binding matches a known-good,
 * Node-computed vector BEFORE any real use. Runs at MODULE-EVALUATION time (not per-call) so a
 * multi-copy `@noble/hashes` binding anomaly (spike finding 013's class of bug) is caught loudly
 * here — fail-closed — rather than silently producing a corrupt digest that only fails
 * cryptically at the authority verifier. Real enforcement is on Hermes on-device (45-09); a
 * Node/jest pass proves the contract shape only, not the Hermes binding.
 */
const PROBE_VECTOR = { nonce: 'probe-nonce-v1', deviceKey: 'probe-devicekey-v1' }
const PROBE_EXPECTED = 'epUx8O72zVpRIQl1WGnqZSQpvFJjJPPZtmgqJBcUfzI' // Node-computed literal; do NOT recompute dynamically

const probeResult = digestFields([PROBE_VECTOR.nonce, PROBE_VECTOR.deviceKey], hasher, encode)
if (probeResult !== PROBE_EXPECTED) {
	throw new Error(
		`real-attestation-producer: Digest() module-load probe FAILED on this runtime ` +
			`(got ${String(probeResult)}, expected ${PROBE_EXPECTED}) — likely a multi-copy ` +
			`@noble/hashes binding anomaly (spike finding 013's class of bug). Refusing to produce ` +
			`attestations with an unverified digest implementation.`,
	)
}

/**
 * Stable module-level Keystore alias.
 *
 * CORRECTED 2026-08-24 — the previous rationale here ("D-13 requires a STABLE alias so
 * enrollment-change invalidation is detectable") was a non-sequitur and is removed. The ALIAS is
 * stable; the KEY UNDER IT IS NOT. `produce()` below calls native `produceAttestation`, which
 * routes to `KeyAttestationHelper.regenerateAttested` — and that function `deleteEntry`s this
 * alias and generates a brand-new key pair BEFORE it ever calls `initSign`. So the key that gets
 * signed with is always microseconds old, no biometric enrolment can invalidate it, and the
 * `KeyPermanentlyInvalidatedException` catch on that path is unreachable. Alias stability buys
 * nothing for invalidation detection.
 *
 * What the stable alias actually buys: one well-known slot, so a ceremony never strands an
 * orphaned key under a generated name, and so `exportPublicKeyCompressedHex` has a fixed address
 * to read the post-regeneration key back from.
 *
 * The security property this path actually provides is KEY NON-REUSE — no attested key survives
 * across ceremonies — which is stronger than detect-then-recover. Do not re-introduce an
 * invalidation-detection claim here. Full analysis:
 * `.planning/todos/pending/2026-08-03-attestation-d13-key-invalidation-leg.md`.
 *
 * (`setInvalidatedByBiometricEnrollment(true)` remains load-bearing for the AUTHORITY app's
 * persistent signing key, reached via `signWithDeviceKey`, which does NOT regenerate first — that
 * is D-24 leg 3, hardware-proven 2026-08-18.)
 */
const KEY_ALIAS = 'VOTETORRENT_DEVICE_KEY_V1'

/**
 * Lazily resolve the native TurboModule via a plain CommonJS `require()` — NOT a top-level
 * `import` and NOT `import()` (bundler-dependent: a single-file bundler without code-splitting
 * can hoist a dynamic `import()` of a local relative module into a top-level static import,
 * defeating the deferral). `require()` inside a function body is unambiguously lazy under both
 * Metro's CommonJS-based module runtime and Jest/Babel's CommonJS transform — the module factory
 * only executes when this function is actually called. NEVER call this at module scope —
 * `getEnforcing(...)` throws in any environment where `AttestationNative` isn't registered
 * (Node/jest), which would break importing this module (and therefore `computeBoundDigest` + the
 * D-16b probe above) under test.
 */
function getNative(): NativeAttestationSpec {
	// eslint-disable-next-line @typescript-eslint/no-var-requires -- deliberate lazy require, see comment above.
	return require('./specs/NativeAttestation').default as NativeAttestationSpec
}

/**
 * `TextEncoder`/`btoa` ARE globals on Hermes/RN and Node (used as bare globals elsewhere in the
 * codebase — e.g. `packages/vote-engine/src/utils.ts`'s `bytesToBase64url` — proven available
 * on-device; RN/Hermes has no `Buffer`, but these two are proven present). This package ships
 * SOURCE directly (no build step) and is type-checked as part of MULTIPLE consuming programs with
 * different `compilerOptions.types` (this package's own `tsconfig.json` includes `"node"`; the
 * app's `@react-native/typescript-config`-based program does not) — a bare, undeclared-ambient
 * reference to `TextEncoder`/`btoa` fails to compile under the latter. Accessing them via a
 * `globalThis` cast (rather than declaring ambient globals, which would collide with `@types/node`
 * wherever it IS present) compiles identically under both.
 */
type Base64GlobalEnv = {
	TextEncoder: new () => { encode(input: string): Uint8Array }
	btoa: (data: string) => string
	atob: (data: string) => string
}
const { TextEncoder: TextEncoderCtor, btoa: btoaFn, atob: atobFn } = globalThis as unknown as Base64GlobalEnv

/**
 * Base64-encode the UTF-8 bytes of a string (STANDARD alphabet, no URL-safe substitution) — the
 * native side decodes this with `Base64.decode(boundDigestUtf8Base64, Base64.NO_WRAP)`
 * (`AttestationNativeModule.kt`), which expects the standard `+`/`/` alphabet, not base64url.
 * Mirrors `packages/vote-engine/src/utils.ts`'s `bytesToBase64url` pattern (minus the URL-safe
 * substitution).
 */
function base64FromUtf8(value: string): string {
	const bytes = new TextEncoderCtor().encode(value)
	let binary = ''
	for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!)
	return btoaFn(binary)
}

/** Standard-alphabet base64 of raw bytes (NOT base64url) — `signWithDeviceKey`'s digest contract. */
function base64FromBytes(bytes: Uint8Array): string {
	let binary = ''
	for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!)
	return btoaFn(binary)
}

/** Decode standard-alphabet base64 to bytes. */
function bytesFromBase64(value: string): Uint8Array {
	const binary = atobFn(value)
	const out = new Uint8Array(binary.length)
	for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
	return out
}

// ---- iOS domain-separation tags (ATTESTATION-CONTRACT-IOS.md §3.1 / §4) ----
// These strings are part of the wire contract. The authority RECOMPUTES both digests from its own
// held values; changing a tag here without changing the verifier silently breaks every iOS
// association with an opaque signature failure.
const IOS_ASSERTION_TAG = 'votetorrent/ios-assertion/v1'
const IOS_POP_TAG = 'votetorrent/ios-pop/v1'

/**
 * §3.1 ASSERTION_DIGEST — the value `generateAssertion` cross-signs, binding `K_vote` to the
 * attested identity. Field 3 restates the vote key even though BOUND_DIGEST already commits to it,
 * so the binding is self-evident to a verifier holding the submitted key rather than transitive.
 *
 * Computed HERE, in JS, and passed to Swift finished — `digestFields`' length-prefixed, type-tagged
 * encoding must never be re-derived in a second language (SIGN-05). Mirrors
 * `verifyAssertion`'s recomputation in vote-engine.
 */
export function computeAssertionDigest(boundDigest: string, voteKeyCompressedHex: string): string {
	return digestFields([IOS_ASSERTION_TAG, boundDigest, voteKeyCompressedHex], hasher, encode) as string
}

/**
 * §4 POP_DIGEST — proof that the device holds `K_vote`'s PRIVATE key. Neither the attestation nor
 * the assertion proves this: both are signed by `K_att`. Without it a device could attest and
 * assert over a `K_vote` it does not control. No Android counterpart (§6).
 */
export function computePopDigest(boundDigest: string): string {
	return digestFields([IOS_POP_TAG, boundDigest], hasher, encode) as string
}

/**
 * Read the replay counter out of an App Attest assertion.
 *
 * The assertion is CBOR `{ signature, authenticatorData }`; `authenticatorData` is
 * `rpIdHash(32) || flags(1) || counter(4 big-endian)`. The byte offsets below are the SAME ones
 * `verifyAssertion` uses (`app-attest-assertion.ts` §8.10) — they must stay in step.
 *
 * The authority does NOT trust this value: it reads its own counter from the assertion. Carrying it
 * lets `AssociationAssociateBuilder` reject a malformed submission early and legibly.
 */
function readAssertionCounter(assertionBase64: string): number {
	const decoded = cborDecode(bytesFromBase64(assertionBase64))
	if (!(decoded instanceof Map)) throw new Error('iOS assertion is not a CBOR map')
	const authenticatorData = (decoded as Map<CborValue, CborValue>).get('authenticatorData')
	if (!(authenticatorData instanceof Uint8Array) || authenticatorData.length < 37) {
		throw new Error('iOS assertion authenticatorData is missing or too short')
	}
	return ((authenticatorData[33]! << 24) >>> 0) + (authenticatorData[34]! << 16) +
		(authenticatorData[35]! << 8) + authenticatorData[36]!
}

/**
 * `Platform.OS`, read through a scoped require for the SAME reason `getNative()` uses one: this
 * module's top-level evaluation is kept pure so importing it under Node/jest (for
 * `computeBoundDigest` and the D-16b probe) never touches the React Native runtime.
 */
function getPlatformOS(): string {
	// eslint-disable-next-line @typescript-eslint/no-var-requires -- deliberate lazy require, see above.
	return (require('react-native') as { Platform: { OS: string } }).Platform.OS
}

/** Package-local two-method producer shape (D-08 — structurally, not nominally, typed). */
interface RealAttestationProducer {
	provisionDeviceKey(): Promise<{ publicKey: string }>
	produce(challenge: AttestationChallenge): Promise<DeviceAttestation>
}

/**
 * iOS production path (ATTESTATION-CONTRACT-IOS.md §3.4). Deliberately a separate function rather
 * than inline branches: almost nothing about the iOS ceremony resembles Android's. Android's
 * Keystore key both carries the attestation AND signs votes; Apple's App Attest key can ONLY
 * produce assertions, so iOS manages TWO keys and must cross-sign them together (§0).
 *
 * Call order is REQUIRED and encoded here:
 *   1. BOUND_DIGEST, then ASSERTION_DIGEST (both in JS, both passed down finished).
 *   2. produceAttestation — native does attestKey (§2) then generateAssertion (§3.2).
 *   3. signWithDeviceKey over POP_DIGEST (§4) — a SEPARATE call, because it needs the biometric
 *      prompt the App Attest path never raises.
 */
async function produceIos(
	native: NativeAttestationSpec,
	challenge: AttestationChallenge,
	boundDigest: string,
	enableDeviceCheck: boolean,
): Promise<DeviceAttestation> {
	// challenge.deviceKey IS K_vote in compressed SEC1 hex — the same form provisionDeviceKey
	// returned and the authority issued the challenge against.
	const assertionDigest = computeAssertionDigest(boundDigest, challenge.deviceKey)

	const result = (await native.produceAttestation(KEY_ALIAS, boundDigest, assertionDigest, enableDeviceCheck)) as {
		attestationObjectBase64: string
		assertionBase64: string
		appAttestKeyId: string
		publicKeyCompressedHex: string
		attestationTimeMillis: number
		deviceCheckToken: string
	}

	// §3.4 CALLER OBLIGATION. Native reads whatever key currently sits under the vote alias; if that
	// is not the key we hashed into assertionDigest, the assertion binds the WRONG key and the
	// authority rejects with an opaque "K_vote is not bound to this attestation". Catch it here,
	// where the message can say what actually happened. This is reachable in practice: a biometric
	// re-enrolment invalidates the vote key, and a re-provision mints a different one.
	if (result.publicKeyCompressedHex !== challenge.deviceKey) {
		throw new Error(
			'iOS attestation aborted: the vote key under the alias no longer matches the key this ' +
				'challenge was issued against (the device key was likely re-provisioned after a ' +
				'biometric change). Request a fresh challenge for the current key.',
		)
	}

	// §4 proof of possession — signWithDeviceKey takes PLAIN base64 of the RAW 32 digest bytes,
	// never base64url and never UTF-8-of-a-string (its byte contract is identical on both platforms).
	const popDigest = computePopDigest(boundDigest)
	const popInput = base64FromBytes(hasher(new TextEncoderCtor().encode(popDigest)))
	const pop = (await native.signWithDeviceKey(
		KEY_ALIAS,
		popInput,
		'Confirm your device',
		'Prove this device holds your voting key',
		'Cancel',
	)) as { signatureHex: string }

	const { certificateChain, environment } = readAttestationObject(result.attestationObjectBase64)

	const platformDetails: IOSAttestationDetails = {
		type: 'iOS',
		secureEnclavePublicKey: challenge.deviceKey,
		appAttestKeyId: result.appAttestKeyId,
		assertion: result.assertionBase64,
		assertionCounter: readAssertionCounter(result.assertionBase64),
		popSignature: pop.signatureHex,
		boundDigest,
		environment,
	}
	// Bar A excludes DeviceCheck (it would need an authority->Apple round trip, breaking the offline
	// verifier posture). Native returns '' when the leg is off; omit the field rather than submit an
	// empty string that reads as "a token was produced".
	if (result.deviceCheckToken !== '') platformDetails.deviceCheckToken = result.deviceCheckToken

	return {
		publicKey: challenge.deviceKey,
		// iOS has no stable device id by design; the App Attest key id IS the app-install identity,
		// which is exactly what DeviceAttestation.deviceId documents for this platform.
		deviceId: result.appAttestKeyId,
		attestationTime: result.attestationTimeMillis,
		attestationStatement: result.attestationObjectBase64,
		certificateChain,
		platformDetails,
	}
}

/**
 * Pull the two things the model needs out of the CBOR attestation object: `x5c` (so
 * `DeviceAttestation.certificateChain` carries the chain, §7) and the environment implied by the
 * authData `aaguid`.
 *
 * The environment is DERIVED, never assumed. Measured 2026-08-25 (spike 085): a build with no
 * entitlements file still received a `development` attestation — the provisioning profile decides,
 * not the plist and not a documented default. The aaguid is the only thing that distinguishes the
 * two, and a development attestation must NEVER be accepted by a production authority.
 */
function readAttestationObject(attestationObjectBase64: string): {
	certificateChain: string[]
	environment: 'development' | 'production'
} {
	const decoded = cborDecode(bytesFromBase64(attestationObjectBase64))
	if (!(decoded instanceof Map)) throw new Error('iOS attestation object is not a CBOR map')
	const map = decoded as Map<CborValue, CborValue>

	const attStmt = map.get('attStmt')
	if (!(attStmt instanceof Map)) throw new Error('iOS attestation object has no attStmt map')
	const x5c = (attStmt as Map<CborValue, CborValue>).get('x5c')
	if (!Array.isArray(x5c) || x5c.length === 0) throw new Error('iOS attestation attStmt.x5c is missing or empty')
	const certificateChain = (x5c as CborValue[]).map(c => {
		if (!(c instanceof Uint8Array)) throw new Error('iOS attestation x5c entry is not a byte string')
		return base64FromBytes(c)
	})

	const authData = map.get('authData')
	if (!(authData instanceof Uint8Array) || authData.length < 53) {
		throw new Error('iOS attestation authData is missing or too short to carry an aaguid')
	}
	// authData: rpIdHash(32) | flags(1) | counter(4) | aaguid(16) | credIdLen(2) | credId...
	let aaguid = ''
	for (let i = 37; i < 53; i++) aaguid += String.fromCharCode(authData[i]!)
	const environment = aaguid.startsWith('appattestdevelop') ? 'development' : 'production'

	return { certificateChain, environment }
}

/**
 * Injectable factory driving the D-11 two-step TurboModule seam. Takes a plain
 * `{ enablePlayIntegrity: boolean }` and passes it STRAIGHT into native `produceAttestation` —
 * this package holds NO app-level flag constant; the boolean is the ONLY injection point (D-12),
 * wired by the app call site (45-08's `resolvePlayIntegrityEnabled()`).
 */
export function createRealAttestationProducer(opts: {
	enablePlayIntegrity: boolean
	/**
	 * iOS DeviceCheck leg, the analogue of `enablePlayIntegrity` (D-12). Defaults to FALSE: integrity
	 * bar A (the settled decision, spike 082) excludes DeviceCheck because it requires an
	 * authority->Apple round trip that would break D-04's offline verifier posture. Present so a
	 * future move to bar B is a flag, not a code change.
	 */
	enableDeviceCheck?: boolean
}): RealAttestationProducer {
	return {
		async provisionDeviceKey() {
			const native = getNative()
			const result = (await native.provisionDeviceKey(KEY_ALIAS)) as { publicKeyBase64: string; keyAlias: string }
			return { publicKey: result.publicKeyBase64 }
		},

		async produce(challenge: AttestationChallenge): Promise<DeviceAttestation> {
			// BOUND_DIGEST is IDENTICAL on both platforms (ATTESTATION-CONTRACT-IOS.md §1) — it is the
			// one value the two contracts share. Everything after this point diverges.
			const boundDigest = computeBoundDigest(challenge.nonce, challenge.deviceKey)
			const native = getNative()

			if (getPlatformOS() === 'ios') {
				return await produceIos(native, challenge, boundDigest, opts.enableDeviceCheck ?? false)
			}

			// ---- Android ----
			// Three distinct nonce forms (Pitfall 5) — never reuse one variable for two:
			//   (1) challenge.nonce            — RAW authority nonce, used ONLY for platformDetails.nonce below.
			//   (2) boundDigest                — BOUND_DIGEST base64url string, sent AS-IS to Play Integrity setNonce (§2).
			//   (3) boundDigestUtf8Base64      — base64(utf8(BOUND_DIGEST)), sent to Keystore setAttestationChallenge (§3).
			// Do not symmetrize (2) and (3) — this asymmetry is intentional and matches the shipped verifier exactly.
			const boundDigestUtf8Base64 = base64FromUtf8(boundDigest)

			const result = (await native.produceAttestation(KEY_ALIAS, boundDigest, boundDigestUtf8Base64, opts.enablePlayIntegrity)) as {
				certificateChainBase64: string[]
				integrityToken: string
				androidId: string
				attestationTimeMillis: number
			}

			return {
				publicKey: challenge.deviceKey,
				deviceId: result.androidId,
				attestationTime: result.attestationTimeMillis,
				// Native side already drops the trailing root (D-15b) — forward verbatim.
				certificateChain: result.certificateChainBase64,
				platformDetails: {
					type: 'Android',
					safetyNetAttestation: result.integrityToken,
					keystorePublicKey: challenge.deviceKey,
					// RAW challenge.nonce — NOT BOUND_DIGEST (Pitfall 5; AssociationAssociateBuilder's
					// validateNonceCrossField rejects BOUND_DIGEST here with NONCE_MISMATCH).
					nonce: challenge.nonce,
				},
			}
		},
	}
}
