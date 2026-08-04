/**
 * registrant-dev-seed.test.ts — Phase 47-23 Task 1 static contract proof.
 *
 * Deliberately does NOT construct a real Quereus DB: this suite proves the
 * module's CONTRACT (flag-gating, __DEV__ guard, the reserved-range shape
 * of its private literals, that it never hand-rolls signing SQL, and that
 * it never logs a private value) — not the real engine ceremonies, which
 * 47-06/47-07/47-08 already cover against the real engine, and which the
 * on-device walkthrough (47-23 Task 2) exercises for real.
 */

import * as fs from 'fs'
import * as path from 'path'
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

describe('registrant-dev-seed — Phase 47-23 Task 1 static contract', () => {
	it('maybeSeedRegistrantFixtures is a no-op while REGISTRANT_SEED_ENABLED is false', async () => {
		const networksEngine = throwingStub<NetworksEngine>('networksEngine')
		const networkRef = throwingStub<NetworkReference>('networkRef')
		const user = throwingStub<User>('user')
		const sign = throwingSign()

		// REGISTRANT_SEED_ENABLED is false in the committed tree — this must
		// resolve without ever touching any of the four throwing stubs above.
		await expect(maybeSeedRegistrantFixtures(networksEngine, networkRef, user, sign)).resolves.toBeUndefined()
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
})
