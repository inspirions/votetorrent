/**
 * dev-seed.test.ts — Phase 44-06 integration proof.
 *
 * Runs against the REAL RegistrationEngine + a local in-memory Quereus DB
 * (same pattern as `packages/vote-engine/test/registration.spec.ts`) — the
 * engine layer is pure TS, so this builds the EngineContext directly via
 * `seedDevNetwork`'s own `NetworksEngine`, rather than through the RN
 * CadreNode boot. No on-device dependency.
 *
 * Asserts the five 44-06 behaviors, plus 51-12's D-09/D-20 scope-drop guard:
 *   1. A founding-officer-signed register() persists a real Registrant.
 *   2. register() signed by an UNREGISTERED key is rejected (AdminSigning /
 *      MutationValid / UserIdValid).
 *   3. getElectionRegistrationFields(electionId) is non-empty (Pitfall 5 —
 *      proves the policy is actually loaded before asserting enforcement).
 *   4. A required-tier-violating submission throws FieldPolicyViolationError.
 *   5. A conforming submission succeeds and creates a RegistrantSelective row
 *      for 'party'.
 *   6. (51-12, D-09/D-20) The seeded officer's Scopes is exactly ['mel'] — the
 *      registration-ceremony scope is deliberately withheld from the device's
 *      own voter identity.
 */

import AsyncStorage from '@react-native-async-storage/async-storage'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js'
import type { RegisterInit, Signature } from '@votetorrent/vote-core'
import { NetworksEngine, RegistrationEngine, AssociationEngine, LocalStorageReact } from '@votetorrent/vote-engine/rn'
import { FieldPolicyViolationError } from '@votetorrent/vote-engine'
import { seedDevNetwork, DEV_SEED_NETWORK_NAME } from '../dev-seed'
import { resolveAttestationProducer } from '../attestation-producer'

/** Build a signer for an UNREGISTERED identity — not a row in Officer for this authority. */
function makeUnregisteredSigner(): (digest: Uint8Array) => Promise<Signature> {
	const privBytes = secp256k1.utils.randomSecretKey()
	const publicHex = bytesToHex(secp256k1.getPublicKey(privBytes))
	const privHex = bytesToHex(privBytes)
	const unregisteredUserId = 'unregistered-user-not-an-officer'
	return async (digest: Uint8Array): Promise<Signature> => ({
		signerUserId: unregisteredUserId,
		signerKey: publicHex,
		signature: bytesToHex(secp256k1.sign(digest, hexToBytes(privHex))),
	})
}

let registrantSeq = 0
function nextRegistrantId(): string {
	registrantSeq += 1
	return `dev-seed-registrant-${Date.now()}-${registrantSeq}`
}

const FUTURE_EXPIRATION = Date.now() + 365 * 86_400_000

describe('dev-seed — D-05/D-07/D-08 founding-officer seed + real signed register', () => {
	// Test isolation: the RN AsyncStorage jest mock is a module-scope singleton
	// store shared across every `it()` in this file (unlike the fresh in-memory
	// Quereus Database each `new NetworksEngine(...)` gets). Without clearing it,
	// a later test's brand-new (schema-less) in-memory NetworksEngine would hit
	// dev-seed's idempotent "existingRef" re-attach branch against a
	// `recentNetworks` entry left over from an EARLIER test's AsyncStorage state
	// — throwing "Network not opened in this session". Mirrors
	// `createTestNetwork()`'s own `AsyncStorage.clear()` in
	// packages/vote-engine/test/fixtures/test-context.ts.
	beforeEach(async () => {
		await AsyncStorage.clear()
	})

	async function setup() {
		const networksEngine = new NetworksEngine(new LocalStorageReact())
		const seeded = await seedDevNetwork(networksEngine)
		const ctx = networksEngine.getEstablishedContext(seeded.networkReference.hash)
		if (!ctx) throw new Error('test setup: no established context after seedDevNetwork')
		const registrationEngine = new RegistrationEngine(ctx)
		const authorityRow = await ctx.db
			.prepare('select AuthorityId from Election where Id = :electionId')
			.get({ electionId: seeded.electionId })
		const authorityId = authorityRow!.AuthorityId as string
		return { seeded, ctx, registrationEngine, authorityId }
	}

	it('is __DEV__-guarded — throws when __DEV__ is false', async () => {
		const original = (globalThis as { __DEV__?: boolean }).__DEV__
		;(globalThis as { __DEV__?: boolean }).__DEV__ = false
		try {
			const networksEngine = new NetworksEngine(new LocalStorageReact())
			await expect(seedDevNetwork(networksEngine)).rejects.toThrow(/__DEV__/)
		} finally {
			;(globalThis as { __DEV__?: boolean }).__DEV__ = original
		}
	})

	it('seeds a network whose device user is the founding officer, and an election', async () => {
		const { seeded, ctx } = await setup()
		expect(seeded.networkReference.name).toBe(DEV_SEED_NETWORK_NAME)
		expect(seeded.electionId).toEqual(expect.any(String))

		const officerRow = await ctx.db
			.prepare('select UserId, Scopes from Officer where UserId = :userId')
			.get({ userId: seeded.deviceUser.id })
		expect(officerRow).toBeTruthy()
		expect(JSON.parse(officerRow!.Scopes as string)).toEqual(['mel'])
	})

	it('does NOT grant the officer the registration-ceremony scope — a regression re-granting it is exactly the D-01 defect this phase closed (D-09/D-20)', async () => {
		const { seeded, ctx } = await setup()

		const officerRow = await ctx.db
			.prepare('select Scopes from Officer where UserId = :userId')
			.get({ userId: seeded.deviceUser.id })
		expect(officerRow).toBeTruthy()
		const scopes = JSON.parse(officerRow!.Scopes as string) as string[]
		// The authority's own registration-ceremony scope ("Validate registrations",
		// votetorrent.qsql:59) is deliberately withheld from the device's own voter
		// identity — granting it is what let the voter app run the authority's
		// admin-signed ceremony (D-01, 51-CONTEXT.md). 'mel' ("Manage Elections")
		// stays per D-20 — this seed's own election + policy-row ceremonies need it,
		// and D-12's ElectionRecordValidityPolicy row is 'mel'-scoped. Deleting this
		// test later would be an obvious removal of a guard.
		expect(scopes).not.toContain('vrg')
		expect(scopes).toContain('mel')
	})

	it('getElectionRegistrationFields(electionId) is non-empty (Pitfall 5 — policy actually loaded)', async () => {
		const { seeded, registrationEngine } = await setup()
		const fields = await registrationEngine.getElectionRegistrationFields(seeded.electionId)
		expect(fields.length).toBeGreaterThan(0)
		const byName = new Map(fields.map((f) => [f.fieldName, f]))
		expect(byName.get('firstname')).toMatchObject({ tier: 'public', requirement: 'required' })
		expect(byName.get('email')).toMatchObject({ tier: 'private', requirement: 'required' })
		expect(byName.get('party')).toMatchObject({ tier: 'selective', requirement: 'optional' })
	})

	it('register() signed by the seeded founding-officer device signer succeeds and persists a real Registrant', async () => {
		const { seeded, registrationEngine, authorityId } = await setup()
		const registrantId = nextRegistrantId()

		const init: RegisterInit = {
			electionId: seeded.electionId,
			registrant: { id: registrantId, authorityId, expiration: FUTURE_EXPIRATION },
			public: { firstName: 'Jane' },
			private: { expiration: FUTURE_EXPIRATION, details: [{ name: 'email', value: 'jane@example.com' }] },
		}

		await registrationEngine.register(init, seeded.sign)

		const registrant = await registrationEngine.getRegistrant(registrantId)
		expect(registrant).toBeDefined()
		expect(registrant!.authorityId).toBe(authorityId)
	})

	it('register() signed by an UNREGISTERED key is rejected (AdminSigning/UserIdValid)', async () => {
		const { seeded, registrationEngine, authorityId } = await setup()
		const registrantId = nextRegistrantId()
		const unregisteredSign = makeUnregisteredSigner()

		const init: RegisterInit = {
			electionId: seeded.electionId,
			registrant: { id: registrantId, authorityId, expiration: FUTURE_EXPIRATION },
			public: { firstName: 'Unregistered' },
			private: { expiration: FUTURE_EXPIRATION, details: [{ name: 'email', value: 'unreg@example.com' }] },
		}

		await expect(registrationEngine.register(init, unregisteredSign)).rejects.toThrow()

		const registrant = await registrationEngine.getRegistrant(registrantId)
		expect(registrant).toBeUndefined()
	})

	it('a submission violating a required field policy throws FieldPolicyViolationError', async () => {
		const { seeded, registrationEngine, authorityId } = await setup()
		const registrantId = nextRegistrantId()

		// Omits 'firstname' (public, required) and 'email' (private, required) entirely.
		const init: RegisterInit = {
			electionId: seeded.electionId,
			registrant: { id: registrantId, authorityId, expiration: FUTURE_EXPIRATION },
			private: { expiration: FUTURE_EXPIRATION, details: [] },
		}

		await expect(registrationEngine.register(init, seeded.sign)).rejects.toThrow(FieldPolicyViolationError)

		// A policy-rejected submission must not persist a Registrant.
		const registrant = await registrationEngine.getRegistrant(registrantId)
		expect(registrant).toBeUndefined()
	})

	it('a conforming submission succeeds and creates a RegistrantSelective row for party', async () => {
		const { seeded, registrationEngine, authorityId } = await setup()
		const registrantId = nextRegistrantId()

		const init: RegisterInit = {
			electionId: seeded.electionId,
			registrant: { id: registrantId, authorityId, expiration: FUTURE_EXPIRATION },
			public: { firstName: 'Conforming' },
			private: { expiration: FUTURE_EXPIRATION, details: [{ name: 'email', value: 'conforming@example.com' }] },
			selective: { expiration: FUTURE_EXPIRATION, details: [{ name: 'party', value: 'IND' }] },
		}

		await registrationEngine.register(init, seeded.sign)

		const registrant = await registrationEngine.getRegistrant(registrantId)
		expect(registrant).toBeDefined()
		expect(registrant!.selectiveCid).toEqual(expect.any(String))

		const selective = await registrationEngine.getRegistrantSelective(registrantId)
		expect(selective).toBeDefined()
		expect(selective!.selectiveDetails?.some((leaf) => leaf.name === 'party' && leaf.value === 'IND')).toBe(true)
	})

	it('D-23(f): the registered state is reachable end-to-end from the device key alone (no cached id) — one row, status "a"', async () => {
		const { seeded, ctx } = await setup()
		const associationEngine = new AssociationEngine(ctx)
		const registrationEngine = new RegistrationEngine(ctx)

		const { publicKey: deviceKey } = await resolveAttestationProducer().provisionDeviceKey()
		const rows = await associationEngine.getAssociationsByDeviceKey(deviceKey)
		expect(rows).toHaveLength(1)

		const registrant = await registrationEngine.getRegistrant(rows[0]!.registrantId)
		expect(registrant).toBeDefined()
		expect(registrant!.status).toBe('a')
		expect(new Date(registrant!.expiration as string).getTime()).toBeGreaterThan(Date.now())
		// Sanity: the seeded registrant belongs to THIS seed's own authority/network.
		expect(registrant!.authorityId).toBe(
			(
				await ctx.db
					.prepare('select AuthorityId from Election where Id = :electionId')
					.get({ electionId: seeded.electionId })
			)!.AuthorityId,
		)
	})

	it('D-23(f): an unrelated device key reads not-registered — []', async () => {
		const { ctx } = await setup()
		const associationEngine = new AssociationEngine(ctx)
		const rows = await associationEngine.getAssociationsByDeviceKey('dev-seed-test-unrelated-device-key-never-seeded')
		expect(rows).toEqual([])
	})

	it('dev-seed.ts has no import of @react-native-async-storage/async-storage (import-graph assertion — inspects the resolved require() module graph, not a text/token scan)', () => {
		// Genuine import-GRAPH assertion: after this test file's own top-level `import
		// '../dev-seed'` has resolved it, Jest's CommonJS module registry (`require.cache`)
		// records dev-seed.ts's DIRECT `children` — the modules it itself required. This
		// cannot be falsely tripped by a doc comment merely NAMING the package (unlike a
		// text/token scan): only an actual resolved `require`/`import` edge appears here.
		// This RN app's ambient `NodeRequire` type (from @types/react-native) declares only the
		// callable form (matching the existing `require('...')` value-import pattern elsewhere in
		// this codebase) — `.resolve`/`.cache` are real Jest/CommonJS runtime properties this
		// project's minimal type does not surface, hence the narrow `as any` escape below.
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const nodeRequire = require as any
		const devSeedModulePath = nodeRequire.resolve('../dev-seed')
		const devSeedCacheEntry = nodeRequire.cache[devSeedModulePath]
		expect(devSeedCacheEntry).toBeDefined()
		const childIds: string[] = (devSeedCacheEntry?.children ?? []).map((c: { id: string }) => c.id)
		expect(childIds.some((id) => id.includes('@react-native-async-storage/async-storage'))).toBe(false)
	})

	it('is idempotent — re-running seedDevNetwork re-attaches the same network and election without duplicating policy rows', async () => {
		const networksEngine = new NetworksEngine(new LocalStorageReact())
		const first = await seedDevNetwork(networksEngine)
		const second = await seedDevNetwork(networksEngine)

		expect(second.networkReference.hash).toBe(first.networkReference.hash)
		expect(second.electionId).toBe(first.electionId)

		const ctx = networksEngine.getEstablishedContext(second.networkReference.hash)!
		const registrationEngine = new RegistrationEngine(ctx)
		const fields = await registrationEngine.getElectionRegistrationFields(second.electionId)
		// Exactly the 3 seeded rows (firstname/email/party) — not 6, proving the
		// second call did not re-insert (which would violate the PK anyway).
		expect(fields.length).toBe(3)

		// D-23(f): the registered-state fixture is also idempotent across re-attach —
		// exactly one Association row for the seeded device key, not two.
		const associationEngine = new AssociationEngine(ctx)
		const { publicKey: deviceKey } = await resolveAttestationProducer().provisionDeviceKey()
		const rows = await associationEngine.getAssociationsByDeviceKey(deviceKey)
		expect(rows).toHaveLength(1)
	})
})
