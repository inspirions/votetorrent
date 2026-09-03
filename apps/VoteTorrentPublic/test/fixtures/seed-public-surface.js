/**
 * seed-public-surface.js — TEST-ONLY (D-17). The ONE composition both tiers
 * call, so the tier-1 suite and the browser gate can never drift apart. Same
 * discipline `packages/web-data/test/fixtures/seed-founding-authority.js`'s
 * header states: one module, imported by every tier, rather than a seed per
 * tier that nothing reconciles.
 *
 * This is the ONLY module in this plan that reaches outside the app, and it
 * does so by relative specifier into `packages/web-data/test/fixtures/` — the
 * paths 54-03b relocated those fixtures to. A package importing an app's test
 * fixture would be a layering inversion; this direction is the sanctioned one.
 */

import { seedFoundingAuthority, EXPECTED_COUNTS } from '../../../../packages/web-data/test/fixtures/seed-founding-authority.js';
import {
	ceremony,
	seedElectionSurface,
	SEED_NOW,
	SEED_ELECTION,
	SEED_TIMELINE,
	SEED_EXPECTED_COUNTS,
} from '../../../../packages/web-data/test/fixtures/seed-election-surface.js';
import { ROLL_EXPECTED_COUNTS, seedRegistrantRoll } from './registrant-roll-fixture.js';
import { KEYRELEASE_EXPECTED_COUNTS, seedKeyReleaseTasks } from './keyrelease-fixture.js';

/**
 * A fixed hash DISTINCT from the dashboard's `GATE_NETWORK_HASH`
 * (`gate50network`), so the two apps' fake/real IndexedDB databases can never
 * collide. Carries the `vtx-fixture`-adjacent `vtxfixture` token so a scan has
 * something to name.
 * @type {string}
 */
export const FIXTURE_NETWORK_HASH = 'vtxfixture54';

/** The election every read in this surface is scoped to. @type {string} */
export const FIXTURE_ELECTION_DB_ID = SEED_ELECTION.id;

/**
 * The `ElectionRevision.Revision` value `seedElectionSurface` inserts.
 *
 * `seed-election-surface.js` does NOT export it — it is the internal literal
 * `R.revision = 0` in that module's founding-revision block — so it is
 * re-declared here rather than imported. `public-fixtures.test.mjs` asserts
 * `select Revision from ElectionRevision where ElectionId = :eid` equals this
 * value, so a divergence is a TEST FAILURE rather than a silently empty
 * key-release aggregate.
 * @type {number}
 */
export const FIXTURE_REVISION = 0;

/**
 * The instant a page rendered against this surface is read at.
 *
 * Canonical 19 characters, no `Z`. It sits strictly inside `SEED_TIMELINE`'s
 * `tallyingStarts` → `closed` interval, so the page is in the SETTLING phase —
 * the only phase where D-14's key-release fact is live. The containment is
 * asserted in the tier-1 suite by comparing against `SEED_TIMELINE`'s own
 * values rather than by restating them here.
 * @type {string}
 */
export const FIXTURE_SETTLING_INSTANT = '2026-11-10T12:00:00';

/** Re-exported so the tier-1 suite can assert containment against the source of truth. */
export { SEED_TIMELINE, SEED_NOW, SEED_ELECTION };

/**
 * The merged row-count expectation for the whole public surface.
 *
 * THE SPREAD ORDER IS LOAD-BEARING: `KEYRELEASE_EXPECTED_COUNTS` must come LAST
 * so its `User: 5` overrides the founding fixture's `User: 1`. A spread written
 * in the wrong order would silently expect 1 and fail far from its cause, so
 * `public-fixtures.test.mjs` asserts `PUBLIC_SURFACE_EXPECTED_COUNTS.User === 5`
 * directly.
 * @type {Readonly<Record<string, number>>}
 */
export const PUBLIC_SURFACE_EXPECTED_COUNTS = Object.freeze({
	...EXPECTED_COUNTS,
	...SEED_EXPECTED_COUNTS,
	...ROLL_EXPECTED_COUNTS,
	...KEYRELEASE_EXPECTED_COUNTS,
});

/**
 * Seed the entire public surface, in dependency order: founding authority →
 * election surface → the vrg-signed registrant roll → the release-key tasks.
 *
 * Takes an already-prepared handle (one from `createNetworkDb`, so the crypto
 * plugin and the `SignatureValid` / `isISODatetime` scalar functions the seed's
 * CHECKs call are registered). Opens nothing and registers nothing.
 *
 * @param {import('@quereus/quereus').Database} db
 * @returns {Promise<void>}
 */
export async function seedPublicSurface(db) {
	await seedFoundingAuthority(db);
	await seedElectionSurface(db);
	await seedRegistrantRoll(db, ceremony, {
		electionId: FIXTURE_ELECTION_DB_ID,
		seedNow: SEED_NOW,
	});
	await seedKeyReleaseTasks(db, {
		electionId: FIXTURE_ELECTION_DB_ID,
		revision: FIXTURE_REVISION,
		seedNow: SEED_NOW,
	});
}
