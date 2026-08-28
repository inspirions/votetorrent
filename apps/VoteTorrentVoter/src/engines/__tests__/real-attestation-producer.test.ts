/**
 * real-attestation-producer.test.ts — Phase 45-07 jest regression guard for
 * `@votetorrent/attestation-native`'s `RealAttestationProducer`
 * (`packages/attestation-native/src/real-attestation-producer.ts`, created
 * by 45-05).
 *
 * Asserts:
 *   (1) D-11 two-step seam ordering: `produce()` before `provisionDeviceKey()`
 *       rejects; the happy path calls the native `produceAttestation` exactly
 *       once and assembles a `DeviceAttestation` carrying the RAW
 *       `challenge.nonce` (Pitfall 5 — never the bound digest) plus the
 *       faked native's cert chain / integrity token.
 *   (2) D-06 native argument binding: `produce()` passes
 *       `computeBoundDigest(challenge.nonce, challenge.deviceKey)` to the
 *       faked native `produceAttestation` AS-IS, and separately passes the
 *       base64-of-utf8 form of that same digest (ATTESTATION-CONTRACT.md §3
 *       asymmetry — never conflate the two).
 *   (3) D-16b probe throws on a mismatched `digestFields` binding at module
 *       LOAD time (not per-call) — a Hermes-side divergence would be caught
 *       loudly rather than shipping a silently-wrong attestation. A control
 *       assertion proves the real module does NOT throw.
 *   (4) D-16b cross-runtime parity: `computeBoundDigest('probe-nonce-v1',
 *       'probe-devicekey-v1')` strictly equals a hardcoded Node-computed
 *       base64url golden vector.
 *
 * The native TurboModule bridge is faked (react-native's `TurboModuleRegistry
 * .getEnforcing` is overridden for the `'AttestationNative'` name only) so
 * this suite exercises the module's REAL pure-JS parts (`computeBoundDigest`,
 * the D-16b probe, `createRealAttestationProducer`'s orchestration) — it does
 * NOT mock the whole `@votetorrent/attestation-native` package (that would
 * mock away the functions under test).
 */

// NOTE: do NOT `{ ...jest.requireActual('react-native') }` here — react-native's index.js
// exports most modules (DevMenu, DevSettings, ...) as lazy getters, and spreading forces
// Object.assign to evaluate EVERY getter eagerly, including native-bridge accessors
// (`TurboModuleRegistry.getEnforcing('DevMenu')`) that nothing in this suite actually
// touches and that throw outside a real native runtime. A Proxy defers property access to
// exactly what the code under test reads (only `TurboModuleRegistry`), matching how the
// unmocked module behaves.
jest.mock('react-native', () => {
	const actual: Record<string, unknown> = jest.requireActual('react-native')
	const attestationNativeFake = {
		provisionDeviceKey: jest.fn(),
		produceAttestation: jest.fn(),
		signWithDeviceKey: jest.fn(),
	}
	// `produce()` branches on Platform.OS, and the react-native JEST PRESET reports 'ios' — so
	// before this state existed, every "Android" assertion below was silently exercising the iOS
	// branch. (It went unnoticed only because the suite could not even load: see jest.config.js's
	// `uint8arrays` mapping.) Platform is therefore pinned PER TEST, never inherited.
	const platformState = { OS: 'android' as string }
	const actualTurboModuleRegistry = actual.TurboModuleRegistry as { getEnforcing: (name: string) => unknown }
	const turboModuleRegistryProxy = new Proxy(actualTurboModuleRegistry, {
		get(target, prop, receiver) {
			if (prop === 'getEnforcing') {
				return (name: string) => (name === 'AttestationNative' ? attestationNativeFake : target.getEnforcing(name))
			}
			return Reflect.get(target, prop, receiver)
		},
	})
	const platformProxy = new Proxy(actual.Platform as object, {
		get(target, prop, receiver) {
			if (prop === 'OS') return platformState.OS
			return Reflect.get(target, prop, receiver)
		},
	})
	return new Proxy(actual, {
		get(target, prop, receiver) {
			if (prop === 'TurboModuleRegistry') return turboModuleRegistryProxy
			if (prop === 'Platform') return platformProxy
			if (prop === '__attestationNativeFake') return attestationNativeFake
			if (prop === '__platformState') return platformState
			return Reflect.get(target, prop, receiver)
		},
	})
})

import type { AttestationChallenge } from '@votetorrent/vote-core'
import { computeAssertionDigest, computeBoundDigest, createRealAttestationProducer } from '@votetorrent/attestation-native'
// Plan 51-14 (Task 2): real p256 crypto (NOT a mock) so the discrimination assertions below prove
// something — `verify()` is the exact function `packages/vote-engine/src/database/initialize.ts`'s
// `verifySigP256` wraps for the schema-level P-256 check. `verify()`'s DEFAULT is `prehash: true`
// (hashes its `data` argument once internally before checking) — the exact asymmetry this suite's
// `signDeviceKeyDigest` tests below exist to pin.
import { generatePrivateKey, getPublicKey, resolveHasher, verify as p256Verify } from '@optimystic/quereus-plugin-crypto'
// The plugin's own `sign()` wrapper hardcodes `{ lowS: true }` with no `prehash` override (always
// `prehash: true` — @noble/curves' default), so it cannot simulate iOS's native
// `.ecdsaSignatureDigestX962SHA256` (`AttestationNativeModule.swift`'s `signWith`), which signs an
// ALREADY-hashed 32-byte value with `prehash: false` (no internal hash). Reaching for `@noble/curves`
// directly — the SAME library the plugin wraps — is the only way to authentically fake that native
// behavior in this mock.
import { p256 } from '@noble/curves/nist.js'

// eslint-disable-next-line @typescript-eslint/no-var-requires -- reach the fake exposed by the react-native mock above.
const { __attestationNativeFake: nativeFake, __platformState: platformState } = require('react-native') as {
	__attestationNativeFake: { provisionDeviceKey: jest.Mock; produceAttestation: jest.Mock; signWithDeviceKey: jest.Mock }
	__platformState: { OS: string }
}

describe('real-attestation-producer — D-11/D-06/D-16b (Phase 45-07 regression guard)', () => {
	const challenge: AttestationChallenge = {
		nonce: 'challenge-nonce-xyz',
		authorityId: 'authority-1',
		registrantId: 'registrant-1',
		deviceKey: 'device-voting-pubkey-hex',
		expiration: Date.now() + 60_000,
	}

	const fakeProvisionResult = { publicKeyBase64: 'fake-public-key-b64', keyAlias: 'VOTETORRENT_DEVICE_KEY_V1' }
	const fakeProduceResult = {
		certificateChainBase64: ['fake-cert-a', 'fake-cert-b'],
		integrityToken: 'fake-integrity-token',
		androidId: 'fake-android-id',
		attestationTimeMillis: 1_700_000_000_000,
	}

	beforeEach(() => {
		// Every assertion in THIS describe is about the Android branch — say so, rather than
		// inheriting whatever the preset happens to report.
		platformState.OS = 'android'
		nativeFake.provisionDeviceKey.mockReset().mockResolvedValue(fakeProvisionResult)
		nativeFake.produceAttestation.mockReset().mockResolvedValue(fakeProduceResult)
		nativeFake.signWithDeviceKey.mockReset()
	})

	describe('two-step seam ordering (D-11)', () => {
		it('produce() before provisionDeviceKey() rejects (no provisioned key)', async () => {
			// The JS orchestration layer (createRealAttestationProducer) does not itself gate
			// ordering — the D-11 two-step contract is enforced by the NATIVE Keystore, whose
			// `produceAttestation` operates on a key alias that only exists once
			// `provisionDeviceKey()` has actually run. Simulate that real native behavior: with
			// no prior provisionDeviceKey() call, the faked native produceAttestation rejects
			// (no key under KEY_ALIAS), and produce() must propagate that rejection verbatim.
			nativeFake.provisionDeviceKey.mockReset() // never called by this test
			nativeFake.produceAttestation.mockReset().mockRejectedValue(new Error('no key provisioned under this alias'))
			const producer = createRealAttestationProducer({ enablePlayIntegrity: true })

			await expect(producer.produce(challenge)).rejects.toThrow(/no key provisioned/)
			expect(nativeFake.provisionDeviceKey).not.toHaveBeenCalled()
		})

		it('happy path: provisionDeviceKey() then produce() calls native produceAttestation exactly once and preserves the RAW nonce', async () => {
			const producer = createRealAttestationProducer({ enablePlayIntegrity: true })

			const { publicKey } = await producer.provisionDeviceKey()
			expect(publicKey).toBe(fakeProvisionResult.publicKeyBase64)
			expect(nativeFake.provisionDeviceKey).toHaveBeenCalledTimes(1)

			const attestation = await producer.produce(challenge)

			expect(nativeFake.produceAttestation).toHaveBeenCalledTimes(1)
			// Pitfall 5: platformDetails.nonce carries the RAW challenge.nonce, NOT the bound digest.
			expect(attestation.platformDetails?.type).toBe('Android')
			expect(attestation.platformDetails?.type === 'Android' && attestation.platformDetails.nonce).toBe(challenge.nonce)
			expect(attestation.certificateChain).toEqual(fakeProduceResult.certificateChainBase64)
			expect(attestation.platformDetails?.type === 'Android' && attestation.platformDetails.safetyNetAttestation).toBe(
				fakeProduceResult.integrityToken,
			)
			expect(attestation.deviceId).toBe(fakeProduceResult.androidId)
		})
	})

	describe('native bound-digest argument binding (D-06)', () => {
		it('passes computeBoundDigest(nonce, deviceKey) AS-IS and its base64(utf8(...)) form separately (ATTESTATION-CONTRACT.md §3 asymmetry)', async () => {
			const producer = createRealAttestationProducer({ enablePlayIntegrity: false })
			await producer.provisionDeviceKey()
			await producer.produce(challenge)

			const expectedBoundDigest = computeBoundDigest(challenge.nonce, challenge.deviceKey)
			expect(nativeFake.produceAttestation).toHaveBeenCalledTimes(1)
			const callArgs = nativeFake.produceAttestation.mock.calls[0] as [string, string, string, boolean]
			const [keyAlias, boundDigestArg, boundDigestUtf8Base64Arg, enablePlayIntegrityArg] = callArgs

			expect(keyAlias).toBe('VOTETORRENT_DEVICE_KEY_V1')
			// §2 (Play Integrity classic nonce): the BOUND_DIGEST string, verbatim, no transform.
			expect(boundDigestArg).toBe(expectedBoundDigest)
			// §3 (Keystore attestationChallenge): base64-of-the-UTF8-bytes of that SAME string —
			// deliberately NOT equal to boundDigestArg (the asymmetry is intentional).
			expect(boundDigestUtf8Base64Arg).not.toBe(boundDigestArg)
			expect(Buffer.from(boundDigestUtf8Base64Arg, 'base64').toString('utf8')).toBe(expectedBoundDigest)
			expect(enablePlayIntegrityArg).toBe(false)
		})
	})

	describe('D-16b module-load probe', () => {
		it('throws when the digestFields binding diverges from the known-good vector', () => {
			jest.isolateModules(() => {
				jest.doMock('@optimystic/quereus-plugin-crypto', () => ({
					digestFields: () => 'deliberately-wrong-digest-value',
					resolveHasher: (name: string) => name,
					resolveOutputEncoder: (name: string) => name,
				}))

				expect(() => {
					// eslint-disable-next-line @typescript-eslint/no-var-requires
					require('@votetorrent/attestation-native')
				}).toThrow(/probe|digest/i)

				jest.dontMock('@optimystic/quereus-plugin-crypto')
			})
		})

		it('does NOT throw when the real digestFields binding is used (control)', () => {
			jest.isolateModules(() => {
				expect(() => {
					// eslint-disable-next-line @typescript-eslint/no-var-requires
					require('@votetorrent/attestation-native')
				}).not.toThrow()
			})
		})
	})

	describe('cross-runtime parity vector (D-16b)', () => {
		it("computeBoundDigest('probe-nonce-v1', 'probe-devicekey-v1') equals the Node-computed golden vector", () => {
			// Golden vector: computed on Node against the same @optimystic/quereus-plugin-crypto
			// binding the SQL Digest() UDF uses (packages/attestation-native/src/real-attestation-producer.ts's
			// own PROBE_EXPECTED literal). Do NOT recompute this dynamically — a dynamically-computed
			// expected value would defeat the cross-runtime purpose (a Hermes-side divergence must
			// diverge from a FIXED string, not from itself).
			expect(computeBoundDigest('probe-nonce-v1', 'probe-devicekey-v1')).toBe('epUx8O72zVpRIQl1WGnqZSQpvFJjJPPZtmgqJBcUfzI')
		})
	})

	/**
	 * iOS branch — ATTESTATION-CONTRACT-IOS.md §3.4 / §4.
	 *
	 * These guard the seam that a clean `tsc`, a green suite and a successful bundle all missed:
	 * the two platforms resolve DIFFERENT native field names, and nothing asserted which one was
	 * read. Reading the absent one yielded `undefined`, which would have been issued as
	 * `challenge.deviceKey` and only surfaced as an opaque signature failure at the authority.
	 *
	 * Deliberately NOT covered here: the CBOR happy path (x5c extraction, aaguid environment,
	 * assertion counter). Those need an attestation object, and a CBOR fixture hand-authored by the
	 * same person who wrote the parser proves only that the two agree. They are pinned instead
	 * against REAL bytes captured from an iPhone — see `ios-hardware-attestation.spec.ts`.
	 */
	describe('iOS branch (ATTESTATION-CONTRACT-IOS.md §3.4 / §4)', () => {
		// Compressed SEC1: 0x02/0x03 prefix + 32-byte X. The authority parses challenge.deviceKey as
		// exactly this (`hexToBytes(expect.deviceKey)` in verifyCrossSign), which is WHY iOS cannot
		// use the Android field.
		const IOS_VOTE_KEY_HEX = '02' + 'ab'.repeat(32)
		const iosChallenge: AttestationChallenge = { ...challenge, deviceKey: IOS_VOTE_KEY_HEX }
		const iosProvisionResult = {
			publicKeyCompressedHex: IOS_VOTE_KEY_HEX,
			appAttestKeyId: 'fake-appattest-key-id',
			keyAlias: 'VOTETORRENT_DEVICE_KEY_V1',
		}

		beforeEach(() => {
			platformState.OS = 'ios'
			nativeFake.provisionDeviceKey.mockReset().mockResolvedValue(iosProvisionResult)
			nativeFake.produceAttestation.mockReset()
			nativeFake.signWithDeviceKey.mockReset()
		})

		it('provisionDeviceKey() returns publicKeyCompressedHex — the field iOS native actually resolves', async () => {
			const producer = createRealAttestationProducer({ enablePlayIntegrity: false })
			const { publicKey } = await producer.provisionDeviceKey()
			expect(publicKey).toBe(IOS_VOTE_KEY_HEX)
		})

		it('provisionDeviceKey() fails CLOSED when native resolves only the Android-shaped fields', async () => {
			// The exact defect: iOS `provisionDeviceKey` resolves { publicKeyCompressedHex,
			// appAttestKeyId, keyAlias } and no `publicKeyBase64` at all. Reading the Android field
			// returned undefined silently.
			nativeFake.provisionDeviceKey.mockResolvedValue(fakeProvisionResult)
			const producer = createRealAttestationProducer({ enablePlayIntegrity: false })
			await expect(producer.provisionDeviceKey()).rejects.toThrow(/publicKeyCompressedHex/)
		})

		it('produce() passes ASSERTION_DIGEST as the third native argument, not the Android base64(utf8(...)) form', async () => {
			// Mismatch the returned key so the call aborts at the §3.4 gate — the produceAttestation
			// arguments are already captured by then, so this asserts the binding without needing a
			// fabricated attestation object.
			nativeFake.produceAttestation.mockResolvedValue({ publicKeyCompressedHex: '03' + 'cd'.repeat(32) })
			const producer = createRealAttestationProducer({ enablePlayIntegrity: true })
			await expect(producer.produce(iosChallenge)).rejects.toThrow()

			const [keyAlias, boundDigestArg, thirdArg, enableDeviceCheckArg] =
				nativeFake.produceAttestation.mock.calls[0] as [string, string, string, boolean]
			const expectedBoundDigest = computeBoundDigest(iosChallenge.nonce, iosChallenge.deviceKey)

			expect(keyAlias).toBe('VOTETORRENT_DEVICE_KEY_V1')
			expect(boundDigestArg).toBe(expectedBoundDigest)
			// §3.1 — the cross-sign digest committing K_vote to the attested identity. On Android this
			// same slot carries base64(utf8(BOUND_DIGEST)); sending that here would produce an
			// assertion binding nothing.
			expect(thirdArg).toBe(computeAssertionDigest(expectedBoundDigest, IOS_VOTE_KEY_HEX))
			expect(thirdArg).not.toBe(Buffer.from(expectedBoundDigest, 'utf8').toString('base64'))
			// D-12 analogue: enablePlayIntegrity must NOT leak into the DeviceCheck slot. Bar A leaves
			// DeviceCheck off, and this producer was constructed with enablePlayIntegrity: true.
			expect(enableDeviceCheckArg).toBe(false)
		})

		it('§3.4: aborts, legibly and before any biometric prompt, when native returns a different vote key', async () => {
			nativeFake.produceAttestation.mockResolvedValue({ publicKeyCompressedHex: '03' + 'cd'.repeat(32) })
			const producer = createRealAttestationProducer({ enablePlayIntegrity: false })

			await expect(producer.produce(iosChallenge)).rejects.toThrow(/re-provisioned|no longer matches/)
			// Reachable in practice (a biometric re-enrolment invalidates K_vote), so it must not
			// raise a Face ID prompt the user cannot make succeed.
			expect(nativeFake.signWithDeviceKey).not.toHaveBeenCalled()
		})
	})

	/**
	 * `signDeviceKeyDigest` — D-02/D-18 (plan 51-14, closing the 51-11/51-13 Known Gap).
	 *
	 * NOT platform-agnostic — this is the exact defect this suite exists to pin (found while
	 * writing it, before it ever shipped): Android's native `signWithDeviceKey` hashes internally
	 * (`SHA256withECDSA`) and expects the RAW digest bytes; iOS's uses
	 * `.ecdsaSignatureDigestX962SHA256`, which signs an ALREADY-hashed 32-byte value with NO
	 * internal hash, so the caller must pre-hash before calling — exactly what `produceIos`'s own
	 * §4 POP call already does. Passing the same bytes on both platforms would silently sign the
	 * wrong bytes on iOS (both are 32 bytes, so nothing type-level catches it) — see
	 * `real-attestation-producer.ts`'s doc comment on this method for the full analysis.
	 */
	describe('signDeviceKeyDigest (D-02/D-18, plan 51-14)', () => {
		const SIGN_VOTE_KEY_HEX = '02' + 'ef'.repeat(32)
		const sha256 = resolveHasher('sha256')

		beforeEach(() => {
			nativeFake.provisionDeviceKey.mockReset().mockResolvedValue({
				publicKeyCompressedHex: SIGN_VOTE_KEY_HEX,
				publicKeyBase64: 'fake-public-key-b64',
				appAttestKeyId: 'fake-appattest-key-id',
				keyAlias: 'VOTETORRENT_DEVICE_KEY_V1',
			})
			nativeFake.produceAttestation.mockReset()
			nativeFake.signWithDeviceKey.mockReset()
		})

		describe('digest byte-format contract per platform', () => {
			it('Android: passes PLAIN base64 of the RAW digest bytes AS-IS (native hashes internally)', async () => {
				platformState.OS = 'android'
				nativeFake.signWithDeviceKey.mockResolvedValue({ signatureHex: 'ab'.repeat(64) })
				const producer = createRealAttestationProducer({ enablePlayIntegrity: false })
				await producer.provisionDeviceKey()

				const digest = Uint8Array.from({ length: 32 }, (_, i) => i)
				await producer.signDeviceKeyDigest(digest)

				expect(nativeFake.signWithDeviceKey).toHaveBeenCalledTimes(1)
				const [keyAlias, digestBase64] = nativeFake.signWithDeviceKey.mock.calls[0] as [string, string, string, string, string]
				expect(keyAlias).toBe('VOTETORRENT_DEVICE_KEY_V1')
				expect(Buffer.from(digestBase64, 'base64')).toEqual(Buffer.from(digest))
				// NOT base64url — assert equality against the STANDARD encoder's own output.
				expect(digestBase64).toBe(Buffer.from(digest).toString('base64'))
				expect(nativeFake.produceAttestation).not.toHaveBeenCalled()
			})

			it('iOS: pre-hashes the digest (sha256) before calling native — never the raw bytes', async () => {
				platformState.OS = 'ios'
				nativeFake.signWithDeviceKey.mockResolvedValue({ signatureHex: 'ab'.repeat(64) })
				const producer = createRealAttestationProducer({ enablePlayIntegrity: false })
				await producer.provisionDeviceKey()

				const digest = Uint8Array.from({ length: 32 }, (_, i) => i)
				await producer.signDeviceKeyDigest(digest)

				expect(nativeFake.signWithDeviceKey).toHaveBeenCalledTimes(1)
				const [, digestBase64] = nativeFake.signWithDeviceKey.mock.calls[0] as [string, string, string, string, string]
				const sentBytes = Buffer.from(digestBase64, 'base64')
				// MUST be sha256(digest) — NOT the raw digest itself.
				expect(sentBytes).toEqual(Buffer.from(sha256(digest)))
				expect(sentBytes).not.toEqual(Buffer.from(digest))
				expect(nativeFake.produceAttestation).not.toHaveBeenCalled()
			})
		})

		describe('end-to-end verification against the bound device key (discrimination)', () => {
			/**
			 * Signs `bytesGivenToNative` exactly the way the REAL iOS `signWith` does
			 * (`.ecdsaSignatureDigestX962SHA256`, `prehash: false` — no internal hash) — this is the
			 * fake's job: an inaccurate fake (e.g. using the plugin's `sign()` wrapper, which always
			 * hashes internally) would hide the exact defect this test exists to catch.
			 */
			function fakeIosNativeSign(bytesGivenToNative: Uint8Array, privateKeyHex: string): string {
				// p256.sign(...) already returns bytes in `opts.format` (default 'compact') — NOT a
				// `Signature` instance needing `.toBytes()`.
				const sigBytes = p256.sign(bytesGivenToNative, Buffer.from(privateKeyHex, 'hex'), { prehash: false, lowS: true })
				return Buffer.from(sigBytes).toString('hex')
			}

			it('iOS: the returned signature verifies against the SAME P-256 key AssociationRequest.DeviceKey binds — and discriminates against a different key', async () => {
				platformState.OS = 'ios'
				// Real p256 keypairs — NOT opaque mock strings — so verification below proves something.
				const correctPrivateKeyHex = generatePrivateKey('p256', 'hex') as string
				const correctPublicKeyHex = getPublicKey(correctPrivateKeyHex, 'p256', 'hex', 'hex') as string
				const wrongPrivateKeyHex = generatePrivateKey('p256', 'hex') as string
				const wrongPublicKeyHex = getPublicKey(wrongPrivateKeyHex, 'p256', 'hex', 'hex') as string
				expect(wrongPublicKeyHex).not.toBe(correctPublicKeyHex)

				nativeFake.provisionDeviceKey.mockResolvedValue({
					publicKeyCompressedHex: correctPublicKeyHex,
					appAttestKeyId: 'fake-appattest-key-id',
					keyAlias: 'VOTETORRENT_DEVICE_KEY_V1',
				})
				const producer = createRealAttestationProducer({ enablePlayIntegrity: false })
				// This IS `p256DeviceKey` in ConfirmationScreen's ceremony — the exact value assigned to
				// `AssociationRequestInit.deviceKey`.
				const { publicKey: associationRequestDeviceKey } = await producer.provisionDeviceKey()
				expect(associationRequestDeviceKey).toBe(correctPublicKeyHex)

				const digest = Uint8Array.from({ length: 32 }, (_, i) => (i * 7) % 256)
				// The fake signs whatever bytes it ACTUALLY receives (dynamic, not canned) — if the
				// implementation regressed to sending the raw (un-hashed) digest, this fake would sign
				// the WRONG bytes and the "GREEN" assertion below would fail.
				nativeFake.signWithDeviceKey.mockImplementation(async (_alias: string, digestBase64Arg: string) => ({
					signatureHex: fakeIosNativeSign(Buffer.from(digestBase64Arg, 'base64'), correctPrivateKeyHex),
				}))

				const signature = await producer.signDeviceKeyDigest(digest)

				expect(signature.signerKey).toBe(associationRequestDeviceKey)
				// D-02/D-04: no user id on a prospective registrant's self-signature.
				expect(signature.signerUserId).toBe('')

				// RED first: the SAME signature must NOT verify under a DIFFERENT device key — proves
				// this assertion is discriminating, not vacuously true.
				expect(p256Verify(digest, signature.signature, wrongPublicKeyHex, 'p256', 'bytes', 'hex', 'hex')).toBe(false)
				// GREEN: verifies under the SAME key the association request binds
				// (`AssociationRequest.DeviceKey` / `associationRequestDeviceKey`), via `verify()`'s
				// default `prehash: true` — proving `signDeviceKeyDigest` pre-hashed correctly on iOS.
				expect(p256Verify(digest, signature.signature, associationRequestDeviceKey, 'p256', 'bytes', 'hex', 'hex')).toBe(true)
			})

			it('Android: the returned signature verifies against the SAME P-256 key AssociationRequest.DeviceKey binds — and discriminates against a different key', async () => {
				platformState.OS = 'android'
				const correctPrivateKeyHex = generatePrivateKey('p256', 'hex') as string
				const correctPublicKeyHex = getPublicKey(correctPrivateKeyHex, 'p256', 'hex', 'hex') as string
				const wrongPrivateKeyHex = generatePrivateKey('p256', 'hex') as string
				const wrongPublicKeyHex = getPublicKey(wrongPrivateKeyHex, 'p256', 'hex', 'hex') as string

				nativeFake.provisionDeviceKey.mockResolvedValue({
					publicKeyBase64: correctPublicKeyHex,
					keyAlias: 'VOTETORRENT_DEVICE_KEY_V1',
				})
				const producer = createRealAttestationProducer({ enablePlayIntegrity: false })
				const { publicKey: associationRequestDeviceKey } = await producer.provisionDeviceKey()
				expect(associationRequestDeviceKey).toBe(correctPublicKeyHex)

				const digest = Uint8Array.from({ length: 32 }, (_, i) => (i * 3) % 256)
				// Android's real native hashes internally (SHA256withECDSA) — simulate with `prehash: true`
				// over whatever bytes the implementation actually sent (must be the RAW digest here).
				nativeFake.signWithDeviceKey.mockImplementation(async (_alias: string, digestBase64Arg: string) => {
					const bytesGivenToNative = Buffer.from(digestBase64Arg, 'base64')
					const sigBytes = p256.sign(bytesGivenToNative, Buffer.from(correctPrivateKeyHex, 'hex'), { prehash: true, lowS: true })
					return { signatureHex: Buffer.from(sigBytes).toString('hex') }
				})

				const signature = await producer.signDeviceKeyDigest(digest)

				expect(p256Verify(digest, signature.signature, wrongPublicKeyHex, 'p256', 'bytes', 'hex', 'hex')).toBe(false)
				expect(p256Verify(digest, signature.signature, associationRequestDeviceKey, 'p256', 'bytes', 'hex', 'hex')).toBe(true)
			})
		})

		it('falls back to resolving the current key via native.provisionDeviceKey when called before this producer instance provisioned one (a persistent hardware key from a prior session)', async () => {
			platformState.OS = 'ios'
			nativeFake.signWithDeviceKey.mockResolvedValue({ signatureHex: 'cd'.repeat(64) })
			const producer = createRealAttestationProducer({ enablePlayIntegrity: false })
			// Deliberately do NOT call provisionDeviceKey() first.
			const digest = Uint8Array.from({ length: 32 }, () => 7)

			const signature = await producer.signDeviceKeyDigest(digest)

			expect(nativeFake.provisionDeviceKey).toHaveBeenCalledTimes(1)
			expect(signature.signerKey).toBe(SIGN_VOTE_KEY_HEX)
		})
	})

})
