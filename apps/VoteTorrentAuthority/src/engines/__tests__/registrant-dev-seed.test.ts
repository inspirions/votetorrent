/**
 * registrant-dev-seed.test.ts — Phase 47-23 Task 1 static contract proof,
 * plus the 47-23 continuation's completion-marker regression test.
 *
 * Mostly does NOT construct a real Quereus DB: most of this suite proves the
 * module's CONTRACT (flag-gating, __DEV__ guard, the reserved-range shape
 * of its private literals, that it never hand-rolls signing SQL, and that
 * it never logs a private value) — not the real engine ceremonies, which
 * 47-06/47-07/47-08 already cover against the real engine, and which the
 * on-device walkthrough (47-23 Task 2) exercises for real.
 *
 * The one exception is the 'a partial seed...' test below, which DOES drive
 * `seedRegistrantFixtures` against a hand-built fake `ctx.db` (never a real
 * Quereus DB) with `RegistrationEngine`/`AssociationEngine` mocked via
 * `jest.mock`. It exists to lock the fix for the 47-23 continuation's
 * root-caused bug: the ORIGINAL design gated "already seeded" on
 * `Registrant.Id` for the first registrant existing — a row written in step
 * (3) — so a seed that threw anywhere in steps (4)-(8) was permanently and
 * silently treated as complete. This test constructs exactly that partial
 * state (all registrant rows present, nothing else) and asserts the seed
 * proceeds past step (3) rather than short-circuiting. It is a RED-then-
 * GREEN test: run against the pre-fix module (marker = registrant-0 row
 * existence) it fails, because that design returns at step (1) and never
 * calls `changeStatus`/`enrollElectionRegistrant`/`setElectionAttestationPolicy`/
 * `issueAttestationChallenge`/`associate` at all.
 */

import * as fs from 'fs'
import * as path from 'path'
import AsyncStorage from '@react-native-async-storage/async-storage'
import type { NetworkReference, Signature, User } from '@votetorrent/vote-core'
import type { NetworksEngine } from '@votetorrent/vote-engine/rn'
import {
	maybeSeedRegistrantFixtures,
	seedRegistrantFixtures,
	SEED_PRIVATE_LITERALS,
} from '../registrant-dev-seed'

const MODULE_PATH = path.join(__dirname, '../registrant-dev-seed.ts')
const FLAGS_PATH = path.join(__dirname, '../proof-flags.generated.ts')
const MODULE_SOURCE = fs.readFileSync(MODULE_PATH, 'utf8')

/** A Proxy that throws on ANY property access — proves a value was never touched. */
function throwingStub<T extends object>(label: string): T {
	return new Proxy(
		{},
		{
			get() {
				throw new Error(`unexpected access to ${label}`)
			},
		},
	) as T
}

function throwingSign(): (digest: Uint8Array) => Promise<Signature> {
	return (() => {
		throw new Error('sign should not be called')
	}) as unknown as (digest: Uint8Array) => Promise<Signature>
}

/**
 * A signer FACTORY that throws when invoked — the stand-in for
 * `createDeviceSigner`, which really does throw when the device user is
 * missing or its stored key blob is corrupt.
 */
function throwingSignFactory(): () => Promise<(digest: Uint8Array) => Promise<Signature>> {
	return () => {
		throw new Error('createSign should not be called')
	}
}

// Mocks RegistrationEngine/AssociationEngine so the completion-marker
// regression test below can observe how far seedRegistrantFixtures
// progresses without touching a real Quereus DB or a real signing ceremony.
jest.mock('@votetorrent/vote-engine/rn', () => {
	const registerMock = jest.fn(async () => undefined)
	const changeStatusMock = jest.fn(async () => undefined)
	const enrollElectionRegistrantMock = jest.fn(async () => undefined)
	const setElectionAttestationPolicyMock = jest.fn(async () => undefined)
	const issueAttestationChallengeMock = jest.fn(
		async (registrantId: string, deviceKey: string) => ({
			nonce: `nonce-for-${deviceKey}`,
			authorityId: 'authority-1',
			registrantId,
			deviceKey,
			electionId: 'election-1',
			expiration: '2999-01-01T00:00:00.000Z',
		}),
	)
	const associateMock = jest.fn(async () => undefined)

	return {
		__esModule: true,
		RegistrationEngine: jest.fn().mockImplementation(() => ({
			register: registerMock,
			changeStatus: changeStatusMock,
			enrollElectionRegistrant: enrollElectionRegistrantMock,
			setElectionAttestationPolicy: setElectionAttestationPolicyMock,
		})),
		AssociationEngine: jest.fn().mockImplementation(() => ({
			issueAttestationChallenge: issueAttestationChallengeMock,
			associate: associateMock,
		})),
		NetworksEngine: class {},
		__mock: {
			registerMock,
			changeStatusMock,
			enrollElectionRegistrantMock,
			setElectionAttestationPolicyMock,
			issueAttestationChallengeMock,
			associateMock,
		},
	}
})

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { __mock } = require('@votetorrent/vote-engine/rn') as {
	__mock: {
		registerMock: jest.Mock
		changeStatusMock: jest.Mock
		enrollElectionRegistrantMock: jest.Mock
		setElectionAttestationPolicyMock: jest.Mock
		issueAttestationChallengeMock: jest.Mock
		associateMock: jest.Mock
	}
}

/**
 * A fake `ctx.db` that always reports every Registrant row as ALREADY
 * PRESENT (simulating a prior run that completed step (3) — 12 real
 * `register()` ceremonies — but crashed somewhere in steps (4)-(8)) and
 * every other table as EMPTY (nothing from steps (4)-(8) exists yet). Only
 * `select` statements — this proves nothing beyond the module's own
 * `ctx.db.prepare(...).get(...)` read contract.
 */
function makePartialSeedCtx() {
	return {
		db: {
			prepare: (sql: string) => ({
				get: async (params?: Record<string, unknown>) => {
					if (sql.includes('from Election where AuthorityId')) {
						return { Id: 'election-1' }
					}
					if (sql.startsWith('select Id from Registrant where Id')) {
						// Every registrant from step (3) already exists.
						return { Id: params?.id }
					}
					if (sql.startsWith('select Status from Registrant where Id')) {
						// Reached only by ensureStatus — no status row implies "not yet transitioned".
						return undefined
					}
					if (sql.includes('from ElectionRegistrant where')) {
						return undefined
					}
					if (sql.includes('from AttestationChallenge where')) {
						return undefined
					}
					if (sql.includes('from Association where')) {
						return undefined
					}
					throw new Error(`makePartialSeedCtx: unexpected query: ${sql}`)
				},
			}),
		},
	}
}

function makeFakeNetworksEngine(ctx: ReturnType<typeof makePartialSeedCtx>): NetworksEngine {
	return {
		getEstablishedContext: () => ctx,
		open: async () => ({
			getDetails: async () => ({ network: { primaryAuthorityId: 'authority-1' } }),
		}),
	} as unknown as NetworksEngine
}

describe('registrant-dev-seed — Phase 47-23 Task 1 static contract', () => {
	it('maybeSeedRegistrantFixtures is a no-op while REGISTRANT_SEED_ENABLED is false', async () => {
		const networksEngine = throwingStub<NetworksEngine>('networksEngine')
		const networkRef = throwingStub<NetworkReference>('networkRef')
		const user = throwingStub<User>('user')
		const createSign = throwingSignFactory()

		// REGISTRANT_SEED_ENABLED is false in the committed tree — this must
		// resolve without ever touching any of the four throwing stubs above.
		await expect(
			maybeSeedRegistrantFixtures(networksEngine, networkRef, user, createSign),
		).resolves.toBeUndefined()
	})

	it('the gated-off path never INVOKES the signer factory (the release boot-path lock)', async () => {
		// The defect this locks: AppProvider resolved `createDeviceSigner(...)`
		// BEFORE calling this gate, so every release cold start read the device's
		// secp256k1 private key out of AsyncStorage for a call that always
		// no-ops — and a throw from it (missing/corrupt device user) surfaced as
		// the blocking "Failed to load network" screen even though the network
		// re-attach had SUCCEEDED. Passing a lazy factory moves that work behind
		// the gate; this asserts it is never called.
		const createSign = jest.fn(async () => throwingSign())

		await maybeSeedRegistrantFixtures(
			throwingStub<NetworksEngine>('networksEngine'),
			throwingStub<NetworkReference>('networkRef'),
			throwingStub<User>('user'),
			createSign,
		)

		expect(createSign).not.toHaveBeenCalled()
	})

	it('with the gate OPEN, a signer-factory rejection is swallowed, never rethrown at the caller', async () => {
		// The second half of the same defect: once the gate is open, a
		// createDeviceSigner rejection still must not escape into AppProvider's
		// re-attach catch, where it rendered "Failed to load network" over a
		// network that had opened fine. Re-imports the module with
		// REGISTRANT_SEED_ENABLED forced true so the gate is genuinely open —
		// the previous test only proves the closed path.
		const createSign = jest.fn(async (): Promise<(digest: Uint8Array) => Promise<Signature>> => {
			throw new Error('Device user not initialised — cannot sign')
		})

		let gatedSeed: typeof maybeSeedRegistrantFixtures = maybeSeedRegistrantFixtures
		jest.isolateModules(() => {
			jest.doMock('../proof-flags.generated', () => ({
				...jest.requireActual('../proof-flags.generated'),
				REGISTRANT_SEED_ENABLED: true,
			}))
			// eslint-disable-next-line @typescript-eslint/no-var-requires
			gatedSeed = require('../registrant-dev-seed').maybeSeedRegistrantFixtures
		})

		try {
			await expect(
				gatedSeed(
					throwingStub<NetworksEngine>('networksEngine'),
					throwingStub<NetworkReference>('networkRef'),
					throwingStub<User>('user'),
					createSign,
				),
			).resolves.toBeUndefined()
			// The factory WAS reached this time — otherwise the assertion above
			// would pass vacuously, exactly as it would with the gate closed.
			expect(createSign).toHaveBeenCalledTimes(1)
		} finally {
			jest.dontMock('../proof-flags.generated')
		}
	})

	it('seedRegistrantFixtures throws outside __DEV__', async () => {
		const original = (globalThis as { __DEV__?: boolean }).__DEV__
		;(globalThis as { __DEV__?: boolean }).__DEV__ = false
		try {
			const networksEngine = throwingStub<NetworksEngine>('networksEngine')
			const networkRef = throwingStub<NetworkReference>('networkRef')
			const user = throwingStub<User>('user')
			const sign = throwingSign()

			await expect(seedRegistrantFixtures(networksEngine, networkRef, user, sign)).rejects.toThrow(/__DEV__/)
		} finally {
			;(globalThis as { __DEV__?: boolean }).__DEV__ = original
		}
	})

	it('SEED_PRIVATE_LITERALS are all drawn from reserved ranges', () => {
		expect(SEED_PRIVATE_LITERALS.length).toBe(36)
		expect(new Set(SEED_PRIVATE_LITERALS).size).toBe(SEED_PRIVATE_LITERALS.length)

		const ssnPattern = /^900-86-\d{4}$/
		const dobPattern = /^1970-01-\d{2}$/
		const phonePattern = /^\+1-555-01\d{2}$/

		for (const literal of SEED_PRIVATE_LITERALS) {
			const matchesOne = ssnPattern.test(literal) || dobPattern.test(literal) || phonePattern.test(literal)
			expect(matchesOne).toBe(true)
		}
	})

	it('the module logs no private literal', () => {
		const lines = MODULE_SOURCE.split('\n')
		const consoleLines = lines.filter((line) => line.includes('console.'))
		// Sanity: the module DOES log (otherwise this assertion would be
		// vacuously true and prove nothing).
		expect(consoleLines.length).toBeGreaterThan(0)

		for (const literal of SEED_PRIVATE_LITERALS) {
			for (const line of consoleLines) {
				expect(line.includes(literal)).toBe(false)
			}
		}

		// No console. line may interpolate a variable whose name suggests it
		// carries the private payload itself (as opposed to a count/id/label).
		const forbiddenInterpolation = /\$\{[^}]*\b(private|details|init|ssn|dob|phone)\b[^}]*\}/i
		for (const line of consoleLines) {
			expect(forbiddenInterpolation.test(line)).toBe(false)
		}
	})

	it('the module hand-rolls no signing SQL', () => {
		expect(MODULE_SOURCE).not.toMatch(/AdminSigning/)
		expect(MODULE_SOURCE).not.toMatch(/AdminSignature/)
		expect(MODULE_SOURCE).not.toMatch(/seedSignedMutation/)
		expect(MODULE_SOURCE).not.toMatch(/insert into/)

		expect(MODULE_SOURCE).toMatch(/RegistrationEngine/)
		expect(MODULE_SOURCE).toMatch(/AssociationEngine/)
		expect(MODULE_SOURCE).toMatch(/register\(/)
	})

	it('the fixture is flag-gated in the committed tree', () => {
		const flagsSource = fs.readFileSync(FLAGS_PATH, 'utf8')
		expect(flagsSource).toContain('REGISTRANT_SEED_ENABLED = false')
	})

	it('a partial seed (registrants present, no completion marker) resumes past step 3 instead of short-circuiting', async () => {
		Object.values(__mock).forEach((mock) => mock.mockClear())
		await AsyncStorage.clear()

		const networkRef = { hash: 'network-hash-partial-seed-test', name: 'n', imageUrl: undefined } as unknown as NetworkReference
		const user = { id: 'user-1', name: 'Dev Officer' } as unknown as User
		const sign = (async (_digest: Uint8Array) => ({}) as unknown as Signature) as (
			digest: Uint8Array,
		) => Promise<Signature>

		const ctx = makePartialSeedCtx()
		const networksEngine = makeFakeNetworksEngine(ctx)

		// First call: registrant rows already exist (step 3 done by a prior,
		// interrupted run); nothing from steps (4)-(8) exists yet, and no
		// completion marker has ever been written. Under the ORIGINAL design
		// (marker = registrant-0's row existing) this would short-circuit HERE
		// and every mock below would still read 0 calls — that is the RED case
		// this test locks against.
		const result = await seedRegistrantFixtures(networksEngine, networkRef, user, sign)

		expect(__mock.registerMock).not.toHaveBeenCalled() // all 12 already existed — the per-registrant guard skipped every one
		expect(__mock.changeStatusMock).toHaveBeenCalled() // step (4) — proves the seed did NOT stop at step (3)'s old gate point
		expect(__mock.enrollElectionRegistrantMock).toHaveBeenCalledTimes(5) // step (5)
		expect(__mock.setElectionAttestationPolicyMock).toHaveBeenCalledTimes(1) // step (6)
		expect(__mock.issueAttestationChallengeMock).toHaveBeenCalledTimes(2) // step (7)
		expect(__mock.associateMock).toHaveBeenCalledTimes(1) // step (8)
		expect(result.seeded).toBe(true)

		const callCountsAfterFirstRun = Object.fromEntries(
			Object.entries(__mock).map(([name, mock]) => [name, mock.mock.calls.length]),
		)

		// Second call, SAME networkRef: the dedicated completion marker written
		// at the end of the first call must now short-circuit this call with NO
		// further engine writes — proving the fix's marker is honored once it
		// is genuinely set (not merely that the old gate was removed).
		const secondResult = await seedRegistrantFixtures(networksEngine, networkRef, user, sign)

		for (const [name, mock] of Object.entries(__mock)) {
			expect(mock.mock.calls.length).toBe(callCountsAfterFirstRun[name])
		}
		expect(secondResult.seeded).toBe(false)
	})
})
