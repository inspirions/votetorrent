/**
 * device-signer.selfverify.test.ts: createDeviceSigner verifies every native signature against the
 * recorded signerKey with the schema's own verifier (verifySigP256). A mismatch is the Keystore/
 * metadata desync and throws KEY_INVALIDATED_REASSOCIATE before any engine write sees the signature.
 */

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
	// 49-14 follow-up: defaults to "no recovery in progress" so this suite's pre-existing
	// happy-path/rejection assertions are unaffected; the dedicated coverage for the marker
	// itself overrides this per-test.
	isRecoveryInProgress: jest.fn().mockResolvedValue(false),
}))

import type { User } from '@votetorrent/vote-core'
import { UserKeyType } from '@votetorrent/vote-core'
import { p256 } from '@noble/curves/nist.js'
import { createDeviceSigner } from '../device-signer'
import { getDeviceUser, isRecoveryInProgress } from '../device-user'

// eslint-disable-next-line @typescript-eslint/no-var-requires -- reach the fake exposed by the react-native mock above.
const { __attestationNativeFake: nativeFake } = require('react-native') as {
	__attestationNativeFake: { signWithDeviceKey: jest.Mock }
}

const mockGetDeviceUser = getDeviceUser as jest.MockedFunction<typeof getDeviceUser>

const hex = (b: Uint8Array) => Array.from(b, x => x.toString(16).padStart(2, '0')).join('')
const keyA = (() => { const priv = p256.utils.randomSecretKey(); return { priv, pub: hex(p256.getPublicKey(priv, true)) } })()
const keyB = (() => { const priv = p256.utils.randomSecretKey(); return { priv, pub: hex(p256.getPublicKey(priv, true)) } })()
const DIGEST = Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + 3) & 0xff)
// compact low-S hex over the digest bytes (noble v2 default prehash = sha256, same as the schema verifier)
const sign = (priv: Uint8Array) => hex(p256.sign(DIGEST, priv, { lowS: true }))

const userWith = (key: string, type: UserKeyType = UserKeyType.p256): User => ({
	id: 'user-1',
	name: 'Officer One',
	activeKeys: [{ key, type, expiration: Date.now() + 1000 }],
})

describe('device-signer self-verify (UAT 62 gap 2)', () => {
	beforeEach(() => {
		nativeFake.signWithDeviceKey.mockReset()
		mockGetDeviceUser.mockReset()
		;(isRecoveryInProgress as jest.Mock).mockResolvedValue(false)
	})

	it('V1: a signature made by the recorded key passes through unchanged', async () => {
		mockGetDeviceUser.mockResolvedValue(userWith(keyA.pub))
		const sig = sign(keyA.priv)
		nativeFake.signWithDeviceKey.mockResolvedValue({ signatureHex: sig })
		const signer = await createDeviceSigner('x')
		await expect(signer(DIGEST)).resolves.toEqual({ signerUserId: 'user-1', signerKey: keyA.pub, signature: sig })
	})

	it('V2: a signature made by a different key rejects with KEY_INVALIDATED_REASSOCIATE and returns no signature', async () => {
		mockGetDeviceUser.mockResolvedValue(userWith(keyA.pub))
		nativeFake.signWithDeviceKey.mockResolvedValue({ signatureHex: sign(keyB.priv) })
		const signer = await createDeviceSigner('x')
		await expect(signer(DIGEST)).rejects.toMatchObject({ code: 'KEY_INVALIDATED_REASSOCIATE' })
	})

	it('V3: a recorded key that is not p256 rejects with KEY_INVALIDATED_REASSOCIATE without a native call', async () => {
		mockGetDeviceUser.mockResolvedValue(userWith(keyA.pub, UserKeyType.mobile))
		const signer = await createDeviceSigner('x').catch(e => e)
		if (typeof signer === 'function') {
			await expect(signer(DIGEST)).rejects.toMatchObject({ code: 'KEY_INVALIDATED_REASSOCIATE' })
		} else {
			expect(signer).toMatchObject({ code: 'KEY_INVALIDATED_REASSOCIATE' })
		}
		expect(nativeFake.signWithDeviceKey).not.toHaveBeenCalled()
	})

	it('V4: a native rejection reaches the caller unwrapped', async () => {
		mockGetDeviceUser.mockResolvedValue(userWith(keyA.pub))
		nativeFake.signWithDeviceKey.mockRejectedValue(Object.assign(new Error('cancelled'), { code: 'BIOMETRIC_CANCELLED' }))
		const signer = await createDeviceSigner('x')
		await expect(signer(DIGEST)).rejects.toMatchObject({ code: 'BIOMETRIC_CANCELLED' })
	})
})
