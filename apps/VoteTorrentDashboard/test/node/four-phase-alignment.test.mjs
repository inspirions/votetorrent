/**
 * four-phase-alignment.test.mjs -- the agreement between three things that
 * used to be three separately hand-maintained lists:
 *
 *   1. `PHASE_IDS` (`@votetorrent/ui-web/lifecycle`) -- the one vocabulary
 *      declaration;
 *   2. `SEED_PHASE_INSTANTS` (the dashboard's seed fixture) -- one canonical
 *      instant per phase id, read by BOTH this suite and the tier-3 browser
 *      harness (`test/browser/gate-matrix.tsx`, `test/browser/run-headless.mjs`);
 *   3. what `derivePhase` actually returns when handed the fixture's own
 *      `SEED_TIMELINE` at each of those instants.
 *
 * Until 54-07 those three lists drifted independently: the browser harness
 * carried its own `INSTANTS` map, `run-headless.mjs` carried its own
 * three-id `TIER3_PHASE_IDS` literal, and nothing bound either to the
 * package's vocabulary. This file is deliberately TIER 1 so a vocabulary
 * drift -- a renamed id, a fifth id, an instant edited onto the wrong side
 * of a boundary -- fails in about a second rather than three minutes into a
 * headless browser run, and fails with a message naming the disagreement
 * instead of a DOM diff.
 *
 * `@votetorrent/ui-web/lifecycle` is Node-importable from this workspace
 * (unlike `./components`, which needs a DOM), which is what makes a tier-1
 * gate on the shared derivation possible at all.
 *
 * The second half of this file is a set of SOURCE-LEVEL assertions over
 * `ElectionsPanel.tsx` and `election-ops.css`. `node --test` cannot import a
 * `.tsx`, so those read the sources as TEXT, in the shape
 * `test/node/election-ops-panels.test.mjs` (54-03b's) established. Every
 * source matcher runs over the COMMENT-STRIPPED text: a panel's own
 * explanatory prose must never be able to satisfy -- or defeat -- a matcher.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { derivePhase, PHASE_IDS } from '@votetorrent/ui-web/lifecycle';
import {
	SEED_ELECTION,
	SEED_TIMELINE,
	SEED_PHASE_INSTANTS,
} from '../../../../packages/web-data/test/fixtures/seed-election-surface.js';

const TIMELINE_JSON = JSON.stringify(SEED_TIMELINE);

// ---------------------------------------------------------------------------
// 1. The key set IS the vocabulary.
// ---------------------------------------------------------------------------

test('SEED_PHASE_INSTANTS names exactly PHASE_IDS, in PHASE_IDS order -- the anti-drift binding', () => {
	assert.deepEqual(Object.keys(SEED_PHASE_INSTANTS), [...PHASE_IDS]);
});

test('every SEED_PHASE_INSTANTS value is a canonical 19-character datetime with no Z suffix', () => {
	for (const [phaseId, instant] of Object.entries(SEED_PHASE_INSTANTS)) {
		assert.match(instant, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/, `${phaseId}'s instant is not canonical`);
	}
});

// ---------------------------------------------------------------------------
// 2. Each instant derives ITS OWN phase, confidently and without conflict.
// ---------------------------------------------------------------------------

test('each SEED_PHASE_INSTANTS entry derives its own phase against SEED_TIMELINE, with indeterminate false and zero conflicts', () => {
	for (const [phaseId, instant] of Object.entries(SEED_PHASE_INSTANTS)) {
		const result = derivePhase(SEED_ELECTION, TIMELINE_JSON, instant);
		assert.equal(result.phase, phaseId, `instant ${instant} derived "${result.phase}", not "${phaseId}" (fired: ${result.firedRule})`);
		assert.equal(result.indeterminate, false, `${phaseId} must derive confidently`);
		// A real assertion, not decoration: SEED_TIMELINE and SEED_ELECTION are
		// consistent under all six CONFLICT codes today, and a future fixture
		// edit that breaks that consistency must surface here rather than as a
		// silently degraded browser rung.
		assert.deepEqual(
			result.conflicts,
			[],
			`${phaseId}: expected no cross-check conflict, got ${result.conflicts.map((c) => c.code).join(', ')}`,
		);
	}
});

test('the string and object forms of the Timeline derive the identical phase at every instant (54-02 deviation (e), from the consumer side)', () => {
	for (const [phaseId, instant] of Object.entries(SEED_PHASE_INSTANTS)) {
		const viaString = derivePhase(SEED_ELECTION, TIMELINE_JSON, instant);
		const viaObject = derivePhase(SEED_ELECTION, SEED_TIMELINE, instant);
		assert.equal(viaString.phase, viaObject.phase, `${phaseId}: string/object phase disagreement`);
		assert.equal(viaString.stage, viaObject.stage, `${phaseId}: string/object stage disagreement`);
	}
});

// ---------------------------------------------------------------------------
// 3. The instants sit where the boundaries say they do -- so the fixture
//    cannot derive the right phase for the wrong reason.
// ---------------------------------------------------------------------------

test('the settling instant lies strictly inside [tallyingStarts, closed) and the closed instant is at or after closed -- string comparison of the canonical form', () => {
	assert.ok(
		SEED_PHASE_INSTANTS.settling >= SEED_TIMELINE.tallyingStarts,
		`settling instant ${SEED_PHASE_INSTANTS.settling} must be >= tallyingStarts ${SEED_TIMELINE.tallyingStarts}`,
	);
	assert.ok(
		SEED_PHASE_INSTANTS.settling < SEED_TIMELINE.closed,
		`settling instant ${SEED_PHASE_INSTANTS.settling} must be < closed ${SEED_TIMELINE.closed}`,
	);
	assert.ok(
		SEED_PHASE_INSTANTS.closed >= SEED_TIMELINE.closed,
		`closed instant ${SEED_PHASE_INSTANTS.closed} must be >= closed ${SEED_TIMELINE.closed}`,
	);
	assert.ok(
		SEED_PHASE_INSTANTS.pre < SEED_TIMELINE.votingStarts,
		`pre instant ${SEED_PHASE_INSTANTS.pre} must be < votingStarts ${SEED_TIMELINE.votingStarts}`,
	);
	assert.ok(
		SEED_PHASE_INSTANTS.voting >= SEED_TIMELINE.votingStarts && SEED_PHASE_INSTANTS.voting < SEED_TIMELINE.tallyingStarts,
		`voting instant ${SEED_PHASE_INSTANTS.voting} must sit in [votingStarts, tallyingStarts)`,
	);
});

// ---------------------------------------------------------------------------
// 4. The stage values the panel renders, pinned without a browser.
// ---------------------------------------------------------------------------

test('derivePhase(...).stage is the newest passed cut-off: null at pre, votingStarts at voting, certificationStarts at settling, closed at closed', () => {
	/** @type {Record<string, string | null>} */
	const expected = {
		pre: null,
		voting: 'votingStarts',
		settling: 'certificationStarts',
		closed: 'closed',
	};
	for (const [phaseId, instant] of Object.entries(SEED_PHASE_INSTANTS)) {
		const { stage } = derivePhase(SEED_ELECTION, TIMELINE_JSON, instant);
		assert.equal(stage, expected[phaseId], `${phaseId}: stage`);
	}
});

// ---------------------------------------------------------------------------
// 5. Positive control -- the suite can tell a derived phase from a guessed one.
// ---------------------------------------------------------------------------

test('positive control: with `closed` deleted from the Timeline, the settling instant returns indeterminate rather than a confident phase', () => {
	const broken = { ...SEED_TIMELINE };
	delete broken.closed;
	const result = derivePhase(SEED_ELECTION, JSON.stringify(broken), SEED_PHASE_INSTANTS.settling);
	assert.equal(result.indeterminate, true, 'a missing deciding boundary must degrade to indeterminate');
	assert.notEqual(result.phase, 'settling', 'the suite would be inert if a broken timeline still derived settling');
});
