/**
 * file-share.test.ts — jest guard for `@votetorrent/attestation-native`'s file-share wrapper
 * (writeShareFile / shareFileAndroid). The TurboModule is faked the same way secret-wrap.test.ts
 * fakes it, so the REAL validation and error mapping in file-share.ts is exercised.
 */
const mockState = { shouldThrow: false, omitMethods: false, os: 'android' }

jest.mock('react-native', () => {
	const actual: Record<string, unknown> = jest.requireActual('react-native')
	const fake = { writeShareFile: jest.fn(), shareFile: jest.fn() }
	const registry = actual.TurboModuleRegistry as { getEnforcing: (name: string) => unknown }
	const registryProxy = new Proxy(registry, {
		get(target, prop, receiver) {
			if (prop === 'getEnforcing') {
				return (name: string) => {
					if (name !== 'AttestationNative') return target.getEnforcing(name)
					if (mockState.shouldThrow) throw new Error('AttestationNative TurboModule is not registered')
					return mockState.omitMethods ? {} : fake
				}
			}
			return Reflect.get(target, prop, receiver)
		},
	})
	const platformProxy = new Proxy(actual.Platform as object, {
		get(target, prop, receiver) {
			if (prop === 'OS') return mockState.os
			return Reflect.get(target, prop, receiver)
		},
	})
	return new Proxy(actual, {
		get(target, prop, receiver) {
			if (prop === 'TurboModuleRegistry') return registryProxy
			if (prop === 'Platform') return platformProxy
			if (prop === '__fake') return fake
			return Reflect.get(target, prop, receiver)
		},
	})
})

import { FileShareError, shareFileAndroid, writeShareFile } from '@votetorrent/attestation-native'

// eslint-disable-next-line @typescript-eslint/no-var-requires -- reach the fake exposed by the mock above.
const { __fake: fake } = require('react-native') as { __fake: { writeShareFile: jest.Mock; shareFile: jest.Mock } }

const SHARE_OPTS = { mimeType: 'application/json', subject: 's', dialogTitle: 't' }

describe('file-share wrapper', () => {
	beforeEach(() => {
		fake.writeShareFile.mockReset()
		fake.shareFile.mockReset()
		mockState.shouldThrow = false
		mockState.omitMethods = false
		mockState.os = 'android'
	})

	// Runs first: the module is cached after the first successful/failed require inside getNative().
	it('maps a getEnforcing throw to unavailable', async () => {
		mockState.shouldThrow = true
		await expect(writeShareFile('a.json', '{}')).rejects.toMatchObject({ name: 'FileShareError', code: 'unavailable' })
	})

	it('returns the uri the native write resolves', async () => {
		fake.writeShareFile.mockResolvedValue({ uri: 'file:///cache/vt-share/a.founding.json' })
		await expect(writeShareFile('a.founding.json', '{}')).resolves.toBe('file:///cache/vt-share/a.founding.json')
		expect(fake.writeShareFile).toHaveBeenCalledWith('a.founding.json', '{}')
	})

	it.each([
		['INVALID_NAME', 'invalid-name'],
		['WRITE_FAILED', 'write-failed'],
		['SHARE_FAILED', 'share-failed'],
		['UNSUPPORTED', 'unsupported'],
	])('maps native reject %s to %s', async (nativeCode, code) => {
		const err = Object.assign(new Error('boom'), { code: nativeCode })
		fake.writeShareFile.mockRejectedValue(err)
		fake.shareFile.mockRejectedValue(err)
		await expect(writeShareFile('a.json', '{}')).rejects.toMatchObject({ code })
		await expect(shareFileAndroid('file:///x', SHARE_OPTS)).rejects.toBeInstanceOf(FileShareError)
		await expect(shareFileAndroid('file:///x', SHARE_OPTS)).rejects.toMatchObject({ code })
	})

	it('reports unavailable (not a TypeError) when the binary predates the methods', async () => {
		// The module object is cached by the earlier tests, so exercise the missing-method guard by
		// temporarily removing the methods from the cached fake.
		const w = fake.writeShareFile
		const s = fake.shareFile
		delete (fake as Partial<typeof fake>).writeShareFile
		delete (fake as Partial<typeof fake>).shareFile
		try {
			await expect(writeShareFile('a.json', '{}')).rejects.toMatchObject({ code: 'unavailable' })
			await expect(shareFileAndroid('file:///x', SHARE_OPTS)).rejects.toMatchObject({ code: 'unavailable' })
		} finally {
			fake.writeShareFile = w
			fake.shareFile = s
		}
	})

	it.each(['a/b.json', '../a.json', 'a..json', 'a b.json', '', 'é.json', 'x'.repeat(101)])(
		'refuses file name %j before calling native',
		async name => {
			await expect(writeShareFile(name, '{}')).rejects.toMatchObject({ code: 'invalid-name' })
			expect(fake.writeShareFile).not.toHaveBeenCalled()
		},
	)

	it('shareFileAndroid on ios is unsupported without calling native', async () => {
		mockState.os = 'ios'
		await expect(shareFileAndroid('file:///x', SHARE_OPTS)).rejects.toMatchObject({ code: 'unsupported' })
		expect(fake.shareFile).not.toHaveBeenCalled()
	})

	it('shareFileAndroid forwards its arguments on android', async () => {
		fake.shareFile.mockResolvedValue({ launched: true })
		await shareFileAndroid('file:///x', SHARE_OPTS)
		expect(fake.shareFile).toHaveBeenCalledWith('file:///x', 'application/json', 's', 't')
	})
})
