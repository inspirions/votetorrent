/**
 * device-signer.hardware.test.ts — 49-07 jest regression guard for the hardware-backed
 * `createDeviceSigner` rewrite (D-01/D-09/D-13).
 *
 * Jest CANNOT exercise the real Android Keystore, the real `BiometricPrompt`, or the
 * byte-level agreement between Kotlin's `derToCompactLowS` and `@noble/curves`'s `p256.verify()`
 * — those are D-24 leg 1 and leg 2, proven only on real hardware in 49-13/49-14. This suite
 * proves only what jest CAN reach: the JS-side plumbing around a mocked native module.
 *
 * The native TurboModule bridge is faked the same way
 * `packages/attestation-native/src/real-attestation-producer.ts`'s own jest suite fakes it:
 * react-native's `TurboModuleRegistry.getEnforcing` is overridden for the `'AttestationNative'`
 * name only, via a Proxy, so the REAL `device-signer.ts` module (including its module-load
 * guard) is exercised, not a stand-in.
 */

// NOTE: do NOT `{ ...jest.requireActual('react-native') }` here — see
// real-attestation-producer.test.ts's identical comment: react-native's index.js exports most
// modules as lazy getters, and spreading forces every one to evaluate eagerly, including
// native-bridge accessors nothing in this suite touches. A Proxy defers property access to
// exactly what the code under test reads (only `TurboModuleRegistry`).
jest.mock('react-native', () => {
	const actual: Record<string, unknown> = jest.requireActual('react-native')
	const attestationNativeFake = {
		signWithDeviceKey: jest.fn(),
	}
	const actualTurboModuleRegistry = actual.TurboModuleRegistry as { getEnforcing: (name: string) => unknown }
	const turboModuleRegistryProxy = new Proxy(actualTurboModuleRegistry, {
		get(target, prop, receiver) {
			if (prop === 'getEnforcing') {
				return (name: string) => (name === 'AttestationNative' ? attestationNativeFake : target.getEnforcing(name))
			}
			return Reflect.get(target, prop, receiver)
		},
	})
	return new Proxy(actual, {
		get(target, prop, receiver) {
			if (prop === 'TurboModuleRegistry') return turboModuleRegistryProxy
			if (prop === '__attestationNativeFake') return attestationNativeFake
			return Reflect.get(target, prop, receiver)
		},
	})
})

jest.mock('../device-user', () => ({
	getDeviceUser: jest.fn(),
}))

import type { User } from '@votetorrent/vote-core'
import { UserKeyType } from '@votetorrent/vote-core'
import { createDeviceSigner } from '../device-signer'
import { getDeviceUser } from '../device-user'

// eslint-disable-next-line @typescript-eslint/no-var-requires -- reach the fake exposed by the react-native mock above.
const { __attestationNativeFake: nativeFake } = require('react-native') as {
	__attestationNativeFake: { signWithDeviceKey: jest.Mock }
}

const mockGetDeviceUser = getDeviceUser as jest.MockedFunction<typeof getDeviceUser>

const PROVISIONED_USER: User = {
	id: 'user-1',
	name: 'Officer One',
	activeKeys: [{ key: 'aabbccdd', type: UserKeyType.p256, expiration: Date.now() + 1000 }],
}

describe('device-signer.ts — hardware rewrite (49-07)', () => {
	beforeEach(() => {
		nativeFake.signWithDeviceKey.mockReset()
		mockGetDeviceUser.mockReset()
	})

	it('(a) base64-encodes the digest and passes the alias + three prompt strings through unchanged', async () => {
		mockGetDeviceUser.mockResolvedValue(PROVISIONED_USER)
		nativeFake.signWithDeviceKey.mockResolvedValue({ signatureHex: 'deadbeef' })

		const sign = await createDeviceSigner('Officer One')
		const digest = new Uint8Array([1, 2, 3, 4])
		const signature = await sign(digest)

		expect(nativeFake.signWithDeviceKey).toHaveBeenCalledTimes(1)
		const [alias, digestBase64, title, subtitle, negativeButton] = nativeFake.signWithDeviceKey.mock.calls[0] as [
			string,
			string,
			string,
			string,
			string,
		]
		expect(alias).toBe('VOTETORRENT_AUTHORITY_SIGNING_KEY_V1')
		// Plain (standard-alphabet) base64 of the RAW digest bytes — never base64url.
		expect(digestBase64).toBe(Buffer.from(digest).toString('base64'))
		expect(typeof title).toBe('string')
		expect(typeof subtitle).toBe('string')
		expect(typeof negativeButton).toBe('string')

		expect(signature).toEqual({
			signerUserId: PROVISIONED_USER.id,
			signerKey: PROVISIONED_USER.activeKeys[0]!.key,
			// Returned hex is passed through verbatim — never re-normalized.
			signature: 'deadbeef',
		})
	})

	it('(b) propagates a native CANCELED rejection with its code intact, never converted to a generic error', async () => {
		mockGetDeviceUser.mockResolvedValue(PROVISIONED_USER)
		const rejection = Object.assign(new Error('user canceled the biometric prompt'), { code: 'CANCELED' })
		nativeFake.signWithDeviceKey.mockRejectedValue(rejection)

		const sign = await createDeviceSigner('Officer One')
		await expect(sign(new Uint8Array([9, 9, 9]))).rejects.toMatchObject({ code: 'CANCELED' })
	})

	it('(c) rejects NO_KEY_PROVISIONED before any native call when no device user is provisioned', async () => {
		mockGetDeviceUser.mockResolvedValue(undefined)

		await expect(createDeviceSigner('Officer One')).rejects.toMatchObject({ code: 'NO_KEY_PROVISIONED' })
		expect(nativeFake.signWithDeviceKey).not.toHaveBeenCalled()
	})
})
