/**
 * The ONE seed both gates use — the tier-1 node suite (`test/node/db.test.mjs`)
 * and the tier-2 browser gate (`test/browser/db-gate.js`) import this SAME
 * module by relative path, so the two tiers can never drift apart (the skill
 * doc's "the SAME module the browser uses" discipline).
 *
 * TEST SCAFFOLDING, NOT A PRODUCTION WRITE PATH. Phase 50's dashboard makes NO
 * writes (D-01); these four rows exist only so the gates have something real
 * to persist and re-read.
 *
 * This seeds through the schema's own unsigned founding shoe-in path (raw
 * SQL) rather than through `vote-engine`. The standing "write through
 * vote-engine, never the raw handle" rule exists because `iad`/`ik` have zero
 * schema sites — but the engine entry point that would honour it
 * (`NetworksEngine.create`) is exactly what outline contract 2 forbids the
 * dashboard from importing. This is a deliberate, recorded exception for TEST
 * FIXTURES ONLY; it is not a precedent for any production write path in this
 * dashboard.
 *
 * Do NOT "fix" the datetime literal below. It ends in `Z`, and that is
 * correct here: it is a plain `datetime` column validated by
 * `isISODatetime`, which REQUIRES the `Z`, and the founding path runs with
 * `SigningNonce = null` so no `Digest`-bound CHECK ever evaluates it. The
 * 19-character, no-`Z` canonical form applies only to values THIS DASHBOARD
 * PRODUCES (contract C5's `capturedAt`, which must come from
 * `nowCanonicalDatetime()` — see `../../src/db/reattach.js`).
 */

/** The fixed network hash both gates seed and verify against. @type {string} */
export const GATE_NETWORK_HASH = 'gate50network';

/** The four tables this fixture inserts one row into each. @type {string[]} */
export const SEED_TABLES = ['Authority', 'User', 'Admin', 'Officer'];

/** The row counts a correctly-seeded, never-mutated store must report. @type {Record<string, number>} */
export const EXPECTED_COUNTS = { Authority: 1, User: 1, Admin: 1, Officer: 1 };

const EFFECTIVE_AT = '2026-01-01T00:00:00.000Z';
const GRANTED_SCOPES = ['mel', 'ceb'];

/**
 * Seed the founding Authority + User + Admin + Officer through the schema's
 * own unsigned first-authority shoe-in path (`InsertValid`'s
 * `(select count(*) from Authority) = 1` clause and its User/Officer
 * counterparts).
 *
 * @param {import('@quereus/quereus').Database} db
 * @returns {Promise<void>}
 */
export async function seedFoundingAuthority(db) {
	const noCtx =
		'with context SigningNonce = null, InviteSlotCid = null, InviteSignature = null, Tid = 1';
	await db.exec(
		`insert into Authority (Id, Name, DomainName, ImageRef) ${noCtx} values ('a1','Gate County Elections','gate50.example',null)`,
	);
	await db.exec(`insert into User (Id, Name, ImageRef) ${noCtx} values ('u1','Ada Officer',null)`);
	await db.exec(
		`insert into Admin (AuthorityId, EffectiveAt, ThresholdPolicies) ${noCtx} values ('a1','${EFFECTIVE_AT}','[]')`,
	);
	await db.exec(
		`insert into Officer (AuthorityId, AdminEffectiveAt, UserId, Title, Scopes) ${noCtx} values ('a1','${EFFECTIVE_AT}','u1','Clerk','${JSON.stringify(GRANTED_SCOPES)}')`,
	);
}
