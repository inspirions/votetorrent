/**
 * registrant-dev-seed.ts — `__DEV__`-guarded, flag-gated registrant fixture
 * (Phase 47-23 Task 1).
 *
 * WHY THIS EXISTS (47-23-PLAN.md `<blocking_precondition>`): zero UI in this
 * app can create a registrant — `IRegistrationEngine.register()` is a real,
 * fully-implemented `'vrg'`-signed multi-row ceremony, but registration
 * request/approval flows are Phase 48's scope. Six of the nine Phase 47
 * surfaces (registrants list, registrant detail, private tier, status
 * change, associations, challenges, and the election roster's filtered rows)
 * are therefore unwalkable on a fresh device without seeded data. This
 * module is that data — nothing more. It is never reachable from any UI
 * control, and the committed tree ships it OFF (`REGISTRANT_SEED_ENABLED`
 * in `proof-flags.generated.ts`).
 *
 * Direct analog: `apps/VoteTorrentVoter/src/engines/dev-seed.ts` (Phase
 * 44-06) — same `__DEV__` throw guard, same idempotency-by-marker-id
 * discipline, same "no hand-rolled signing SQL" rule. This module differs in
 * one structural way: it does NOT create the network/authority/election —
 * the D-15 walkthrough creates those through the real Add Network / Create
 * Election UI (47-23-PLAN.md leg A0), because a successful network creation
 * under the nine-code `FOUNDING_OFFICER_SCOPES` seed IS the D-15 evidence
 * this walkthrough exists to capture. This module only seeds what happens
 * AFTER that: registrants, a status spread, an election enrollment, an
 * attestation policy, two challenges, and one association.
 *
 * Do NOT hand-roll any signing-ceremony SQL here — every mutation below goes
 * through a real `vote-engine` method (`RegistrationEngine.register` /
 * `changeStatus` / `enrollElectionRegistrant`, `AssociationEngine.
 * issueAttestationChallenge` / `associate`, `RegistrationEngine.
 * setElectionAttestationPolicy`) that owns its own Digest / admin-signing /
 * admin-signature ceremony internally. The app layer only ever supplies a
 * `SignCallback` — never a raw private key, never a raw admin-signing row
 * write, and never a schema-CHECK-context signature bypass flag. A
 * hand-rolled row write would bypass the very CHECK this walkthrough is
 * trying to prove (T-47-23-07).
 *
 * Logging discipline (T-47-23-02, a hard constraint, not a style note):
 * every `console.*` line this module emits carries counts, registrant ids,
 * and step names ONLY. No `PrivateDetail`, no `RegisterInit`, and no caught
 * error object that could embed one may ever be passed to `console.*` — a
 * caught error is always logged as `err instanceof Error ? err.message :
 * String(err)`. If this module's own output leaked a private value, it
 * would poison Task 2's logcat grep and either manufacture a false T-47-02
 * failure or mask a real one.
 */

import type {
	DeviceAttestation,
	NetworkReference,
	PrivateDetail,
	RegisterInit,
	Signature,
	User,
} from '@votetorrent/vote-core'
import {
	AssociationEngine,
	NetworksEngine,
	RegistrationEngine,
} from '@votetorrent/vote-engine/rn'
// Static import ONLY — dynamic require() breaks Metro (Phase 16-07 lesson).
import { REGISTRANT_SEED_ENABLED } from './proof-flags.generated'

/** App-layer sign callback shape — mirrors `device-signer.ts`'s `SignCallback`. */
type SignCallback = (digest: Uint8Array) => Promise<Signature>

/** Deterministic id prefix — every id/key this module writes derives from this, never `crypto.randomUUID()` (idempotency must be structural). */
const SEED_ID_PREFIX = 'authority-47-23-dev-seed'

/** The marker registrant id — its presence is the idempotency gate (checked BEFORE any write). */
const MARKER_REGISTRANT_ID = `${SEED_ID_PREFIX}-registrant-0`

const REGISTRANT_COUNT = 12

/**
 * SEED_PRIVATE_LITERALS — the EXHAUSTIVE list of every private-tier VALUE
 * this fixture writes (36 = 12 registrants x 3 fields). This is the grep
 * corpus 47-23 Task 2's leg B logcat/Metro check uses; exporting it as a
 * single source of truth means the grep list can never drift from the
 * fixture. Every value is drawn from a reserved/never-issued range so it is
 * realistic in SHAPE (the reveal UI renders what an officer would really
 * see) but cannot collide with real data and is unambiguous as a grep
 * token:
 *   - SSN: the `900-86-XXXX` block (the 900-series is never issued by SSA).
 *   - DateOfBirth: `1970-01-XX` (an arbitrary but plausible epoch-adjacent date).
 *   - Phone: `+1-555-01XX` (the `555-0100`..`555-0199` fiction-reserved block).
 * A change to this constant requires re-running Task 2's leg B logcat check
 * — the grep list and the fixture's actual writes must never diverge.
 */
export const SEED_PRIVATE_LITERALS: readonly string[] = (() => {
	const literals: string[] = []
	for (let i = 0; i < REGISTRANT_COUNT; i++) {
		literals.push(`900-86-${String(4000 + i).padStart(4, '0')}`) // SSN
		literals.push(`1970-01-${String(10 + i).padStart(2, '0')}`) // DateOfBirth
		literals.push(`+1-555-01${String(10 + i).padStart(2, '0')}`) // Phone
	}
	return literals
})()

/** Deterministic per-index registrant id. */
function registrantId(i: number): string {
	return `${SEED_ID_PREFIX}-registrant-${i}`
}

/** Per-index district — at least THREE distinct values across 12 registrants. */
const DISTRICTS = ['North', 'South', 'East']

/** Per-index surname — 12 distinct surnames so both a non-empty and a provably-empty name search exist. */
const SURNAMES = [
	'Adler', 'Baxter', 'Cole', 'Drake', 'Ellison', 'Farrow',
	'Grant', 'Hale', 'Ibarra', 'Jasper', 'Kwan', 'Lane',
]

const FIRST_NAMES = [
	'Ada', 'Ben', 'Cora', 'Dane', 'Eve', 'Finn',
	'Gia', 'Hugo', 'Iris', 'Jax', 'Kira', 'Leo',
]

/** Per-index private-tier values (SSN/DateOfBirth/Phone) — sourced from SEED_PRIVATE_LITERALS, never re-derived. */
function privateDetailsFor(i: number): PrivateDetail[] {
	return [
		{ name: 'SSN', value: SEED_PRIVATE_LITERALS[i * 3]! },
		{ name: 'DateOfBirth', value: SEED_PRIVATE_LITERALS[i * 3 + 1]! },
		{ name: 'Phone', value: SEED_PRIVATE_LITERALS[i * 3 + 2]! },
	]
}

/** Result handed back to the AppProvider boot block. */
export interface SeedRegistrantFixturesResult {
	/** Whether this call performed writes (`false` on the idempotent re-attach branch). */
	seeded: boolean
	electionId: string
	registrantIds: string[]
	/** Registrant ids set to 'a' (active) — 9 of 12. */
	activeRegistrantIds: string[]
	/** Registrant ids set to 's' (suspended) — 2 of 12. */
	suspendedRegistrantIds: string[]
	/** Registrant ids set to 'r' (revoked) — 1 of 12. */
	revokedRegistrantIds: string[]
	/** Registrant ids enrolled in the election — a strict 5-of-12 subset (D-07 filter). */
	enrolledRegistrantIds: string[]
	/** The registrant id whose association was attempted (step 8) — undefined if that step never ran. */
	associationRegistrantId?: string
	/** Whether the single association write (step 8) succeeded — false on its non-fatal failure. */
	associationSucceeded: boolean
	/** The nonce of the challenge left outstanding (step 7's second challenge, never consumed). */
	outstandingChallengeNonce?: string
}

/**
 * Seed (or, if already seeded, report) the registrant fixtures against an
 * ALREADY-OPEN network. `__DEV__`-guarded with a throw (voter `dev-seed.ts`
 * precedent, `:93-95`) so Metro dead-code-eliminates this from a release
 * bundle and a release build can never reach it even if the flag were
 * mistakenly left on.
 *
 * `networksEngine` is caller-supplied so this module stays DB-factory-
 * agnostic, mirroring the voter seed's `networksEngine` parameter.
 */
export async function seedRegistrantFixtures(
	networksEngine: NetworksEngine,
	networkRef: NetworkReference,
	user: User,
	sign: SignCallback,
): Promise<SeedRegistrantFixturesResult> {
	if (!(globalThis as { __DEV__?: boolean }).__DEV__) {
		throw new Error('seedRegistrantFixtures: must never run outside __DEV__ — this is a dev-only fixture (47-23)')
	}

	const ctx = networksEngine.getEstablishedContext(networkRef.hash)
	if (!ctx) {
		throw new Error('seedRegistrantFixtures: no established context for the given networkRef — open the network first')
	}

	const registrationEngine = new RegistrationEngine(ctx)
	const associationEngine = new AssociationEngine(ctx)

	// (1) Idempotency gate — FIRST, before any write. The AppProvider boot
	// effect re-fires on [initNonce, node] (47-23-PLAN.md read_first), so the
	// seed WILL run more than once per launch; a non-idempotent seed would
	// throw on the second pass (PK collision) and take the boot path into
	// setInitError.
	const marker = await ctx.db
		.prepare('select Id from Registrant where Id = :markerId')
		.get({ markerId: MARKER_REGISTRANT_ID })
	if (marker) {
		console.log('[seed] already seeded — re-attaching, no writes')
		const electionRowReattach = await ctx.db
			.prepare('select Id from Election where AuthorityId = (select AuthorityId from Registrant where Id = :markerId)')
			.get({ markerId: MARKER_REGISTRANT_ID })
		return {
			seeded: false,
			electionId: (electionRowReattach?.Id as string) ?? '',
			registrantIds: Array.from({ length: REGISTRANT_COUNT }, (_, i) => registrantId(i)),
			activeRegistrantIds: [],
			suspendedRegistrantIds: [],
			revokedRegistrantIds: [],
			enrolledRegistrantIds: [],
			associationSucceeded: false,
		}
	}

	// (2) Election lookup. The walkthrough's operator creates the election
	// through the real UI (47-23-PLAN.md leg A0) — this fixture never creates
	// one, so a fixture that silently manufactured an election could hide a
	// broken create-election path behind the seed.
	const details = await (await networksEngine.open(networkRef, user)).getDetails()
	const authorityId = details.network.primaryAuthorityId
	const electionRow = await ctx.db
		.prepare('select Id from Election where AuthorityId = :authorityId limit 1')
		.get({ authorityId })
	if (!electionRow) {
		console.log('[seed] SKIPPED — create an Election in the app first, then relaunch')
		return {
			seeded: false,
			electionId: '',
			registrantIds: [],
			activeRegistrantIds: [],
			suspendedRegistrantIds: [],
			revokedRegistrantIds: [],
			enrolledRegistrantIds: [],
			associationSucceeded: false,
		}
	}
	const electionId = electionRow.Id as string

	// (3) 12 registrants, all three tiers.
	const farFutureExpiration = new Date(Date.now() + 3 * 365 * 86_400_000).toISOString().replace(/\.\d{3}Z$/, 'Z')
	const nearTermExpiration = new Date(Date.now() + 30 * 86_400_000).toISOString().replace(/\.\d{3}Z$/, 'Z')

	const registrantIds: string[] = []
	for (let i = 0; i < REGISTRANT_COUNT; i++) {
		const id = registrantId(i)
		registrantIds.push(id)
		// At least one near-term and one far-future — indices 0 and 1 are
		// near-term, giving the expiration filter a real partition.
		const expiration = i < 2 ? nearTermExpiration : farFutureExpiration
		const init: RegisterInit = {
			// electionId deliberately OMITTED — including it would gate this
			// write on ElectionRegistrationField policy rows this fixture
			// deliberately does not create.
			registrant: { id, authorityId, expiration },
			public: {
				firstName: FIRST_NAMES[i % FIRST_NAMES.length],
				lastName: SURNAMES[i]!,
				district: DISTRICTS[i % DISTRICTS.length]!,
			},
			private: {
				expiration,
				details: privateDetailsFor(i),
			},
			selective: {
				expiration,
				// The engine generates the salts (D-13) — this fixture must
				// never construct or pass one.
				details: [
					{ name: 'Party', value: i % 2 === 0 ? 'Independent' : 'Unaffiliated' },
					{ name: 'BirthYear', value: 1970 + (i % 5) },
				],
			},
		}
		await registrationEngine.register(init, sign)
	}
	console.log(`[seed] registered ${registrantIds.length} registrants`)

	// (4) Status spread — 9 active (default 'a', untouched), 2 suspended, 1 revoked.
	const suspendedRegistrantIds = [registrantIds[9]!, registrantIds[10]!]
	const revokedRegistrantIds = [registrantIds[11]!]
	for (const id of suspendedRegistrantIds) {
		await registrationEngine.changeStatus(id, 's', sign)
	}
	for (const id of revokedRegistrantIds) {
		await registrationEngine.changeStatus(id, 'r', sign)
	}
	const activeRegistrantIds = registrantIds.filter(
		(id) => !suspendedRegistrantIds.includes(id) && !revokedRegistrantIds.includes(id),
	)
	console.log(`[seed] status spread applied — active=${activeRegistrantIds.length} suspended=${suspendedRegistrantIds.length} revoked=${revokedRegistrantIds.length}`)

	// (5) Election enrollment — a STRICT 5-of-12 subset. If all 12 were
	// enrolled, the roster surface would render identically to the
	// unfiltered roster and the pre-applied D-07 filter would be
	// unfalsifiable on device.
	const enrolledRegistrantIds = registrantIds.slice(0, 5)
	for (const id of enrolledRegistrantIds) {
		await registrationEngine.enrollElectionRegistrant(electionId, id, sign)
	}
	console.log(`[seed] enrolled ${enrolledRegistrantIds.length} of ${registrantIds.length} registrants in the election`)

	// (6) Attestation policy — the ONLY way associate() can succeed on a
	// device with unprovisioned Play Console keys: it makes
	// association-engine.ts's fail-closed gate skip verifier.verify()
	// entirely. Consequence: no AttestationVerdict row will be written for
	// the resulting association below, so the badge will show the
	// no-verdict state — that is correct behavior, not a defect.
	await registrationEngine.setElectionAttestationPolicy(electionId, false, sign)
	console.log('[seed] attestation policy set — AttestationRequired=false (non-attested path)')

	// (7) Two attestation challenges for two ACTIVE registrants — the
	// AttestationChallenge.RegistrantIdValid CHECK additionally requires
	// R.Status = 'a', so a suspended/revoked registrant would be rejected.
	const challengeExpiration = new Date(Date.now() + 7 * 86_400_000).toISOString().replace(/\.\d{3}Z$/, 'Z')
	const firstChallengeDeviceKey = `${SEED_ID_PREFIX}-device-0`
	const secondChallengeDeviceKey = `${SEED_ID_PREFIX}-device-1`
	const firstChallenge = await associationEngine.issueAttestationChallenge(
		activeRegistrantIds[0]!,
		firstChallengeDeviceKey,
		challengeExpiration,
		sign,
		electionId,
	)
	const secondChallenge = await associationEngine.issueAttestationChallenge(
		activeRegistrantIds[1]!,
		secondChallengeDeviceKey,
		challengeExpiration,
		sign,
		electionId,
	)
	console.log(`[seed] issued 2 attestation challenges — nonces=${firstChallenge.nonce.slice(0, 8)}…,${secondChallenge.nonce.slice(0, 8)}…`)

	// (8) One association, consuming the FIRST challenge — the SECOND is
	// left outstanding so the challenges section has a row to inspect and
	// expire. This step is wrapped in its own try/catch (non-fatal): it is
	// the single most environment-sensitive step, and losing the
	// associations row must not cost the walkthrough its other eleven
	// surfaces.
	let associationSucceeded = false
	try {
		const attestation: DeviceAttestation = {
			publicKey: firstChallengeDeviceKey,
			deviceId: `${SEED_ID_PREFIX}-android-device-0`,
			attestationTime: Date.now(),
			certificateChain: [],
			// No attestationStatement — the non-attested path never reads one.
		}
		await associationEngine.associate(
			{
				registrantId: activeRegistrantIds[0]!,
				deviceKey: firstChallengeDeviceKey,
				deviceHash: `${SEED_ID_PREFIX}-device-hash-0`,
				nonce: firstChallenge.nonce,
				attestation,
			},
			sign,
		)
		associationSucceeded = true
		console.log(`[seed] association created for registrant ${activeRegistrantIds[0]}`)
	} catch (err) {
		console.log('[seed] association step failed (non-fatal)', err instanceof Error ? err.message : String(err))
	}

	return {
		seeded: true,
		electionId,
		registrantIds,
		activeRegistrantIds,
		suspendedRegistrantIds,
		revokedRegistrantIds,
		enrolledRegistrantIds,
		associationRegistrantId: activeRegistrantIds[0],
		associationSucceeded,
		outstandingChallengeNonce: secondChallenge.nonce,
	}
}

/**
 * The flag gate. Returns immediately unless `__DEV__ && REGISTRANT_SEED_ENABLED`
 * (static import of the flag only; a dynamic `require()` breaks Metro, Phase
 * 16-07). Wraps `seedRegistrantFixtures` in try/catch, logging `[seed]
 * FATAL —` with the error MESSAGE only and swallowing it, so a seed failure
 * can never take down the app's boot path (the `signing-proof-runner.ts`
 * convention).
 */
export async function maybeSeedRegistrantFixtures(
	networksEngine: NetworksEngine,
	networkRef: NetworkReference,
	user: User,
	sign: SignCallback,
): Promise<void> {
	if (!(__DEV__ && REGISTRANT_SEED_ENABLED)) {
		return
	}
	try {
		await seedRegistrantFixtures(networksEngine, networkRef, user, sign)
	} catch (err) {
		console.log('[seed] FATAL —', err instanceof Error ? err.message : String(err))
	}
}
