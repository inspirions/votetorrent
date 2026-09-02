/**
 * election-phase.test.mjs -- exhaustive boundary, fail-closed and
 * positive-control tests for `src/lifecycle/election-phase.js`, plus the
 * seed fixture's row-count and negative-control assertions.
 *
 * In-memory `new Database()` + `prepareDb` (no IndexedDB) -- these run
 * against the real 59-table schema, not a mock.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Database } from '@quereus/quereus';
import { prepareDb } from '@votetorrent/vote-engine/browser';

import {
	ELECTION_EVENT_ORDER,
	PHASE_IDS,
	assertCanonicalDatetime,
	resolveComparisonInstant,
	computeElectionPhase,
	phaseCopyKey,
} from '../../src/lifecycle/election-phase.js';
import { t } from '@votetorrent/ui-web';
import { seedFoundingAuthority } from '../fixtures/seed-founding-authority.js';
import { seedElectionSurface, SEED_EXPECTED_COUNTS } from '../fixtures/seed-election-surface.js';

const TIMELINE = Object.freeze({
	votingStarts: '2026-11-03T08:00:00',
	tallyingStarts: '2026-11-03T20:00:00',
});

const TIMELINE_NUMBERS = Object.freeze({
	votingStarts: Date.parse('2026-11-03T08:00:00Z'),
	tallyingStarts: Date.parse('2026-11-03T20:00:00Z'),
});

test('ELECTION_EVENT_ORDER deep-equals the seven ElectionEvent values in schema order', () => {
	assert.deepEqual(ELECTION_EVENT_ORDER, [
		'registrationEnds',
		'ballotsFinal',
		'votingStarts',
		'tallyingStarts',
		'validation',
		'certificationStarts',
		'closed',
	]);
});

test('PHASE_IDS is the frozen three-element array', () => {
	assert.deepEqual(PHASE_IDS, ['organizing', 'running', 'released']);
});

// --- Boundary cases, canonical-string timeline -----------------------------

test('boundary (string): one second before votingStarts is organizing', () => {
	assert.deepEqual(computeElectionPhase(TIMELINE, '2026-11-03T07:59:59'), { phase: 'organizing', reason: null });
});

test('boundary (string): exactly at votingStarts is running (later phase wins the boundary)', () => {
	assert.deepEqual(computeElectionPhase(TIMELINE, '2026-11-03T08:00:00'), { phase: 'running', reason: null });
});

test('boundary (string): one second before tallyingStarts is still running', () => {
	assert.deepEqual(computeElectionPhase(TIMELINE, '2026-11-03T19:59:59'), { phase: 'running', reason: null });
});

test('boundary (string): exactly at tallyingStarts is released', () => {
	assert.deepEqual(computeElectionPhase(TIMELINE, '2026-11-03T20:00:00'), { phase: 'released', reason: null });
});

test('boundary (string): well after tallyingStarts is still released', () => {
	assert.deepEqual(computeElectionPhase(TIMELINE, '2027-01-01T00:00:00'), { phase: 'released', reason: null });
});

// --- The same five, epoch-millisecond timeline (inherited-spec item 3) -----

test('boundary (number): one second before votingStarts is organizing', () => {
	assert.deepEqual(computeElectionPhase(TIMELINE_NUMBERS, '2026-11-03T07:59:59'), {
		phase: 'organizing',
		reason: null,
	});
});

test('boundary (number): exactly at votingStarts is running', () => {
	assert.deepEqual(computeElectionPhase(TIMELINE_NUMBERS, '2026-11-03T08:00:00'), {
		phase: 'running',
		reason: null,
	});
});

test('boundary (number): one second before tallyingStarts is still running', () => {
	assert.deepEqual(computeElectionPhase(TIMELINE_NUMBERS, '2026-11-03T19:59:59'), {
		phase: 'running',
		reason: null,
	});
});

test('boundary (number): exactly at tallyingStarts is released', () => {
	assert.deepEqual(computeElectionPhase(TIMELINE_NUMBERS, '2026-11-03T20:00:00'), {
		phase: 'released',
		reason: null,
	});
});

test('boundary (number): well after tallyingStarts is still released', () => {
	assert.deepEqual(computeElectionPhase(TIMELINE_NUMBERS, '2027-01-01T00:00:00'), {
		phase: 'released',
		reason: null,
	});
});

// --- Fail-closed reason codes -----------------------------------------------

test("fail-closed: null timeline -> { phase: null, reason: 'no-timeline' }", () => {
	assert.deepEqual(computeElectionPhase(null, '2026-11-03T08:00:00'), { phase: null, reason: 'no-timeline' });
});

test("fail-closed: undefined timeline -> 'no-timeline'", () => {
	assert.deepEqual(computeElectionPhase(undefined, '2026-11-03T08:00:00'), {
		phase: null,
		reason: 'no-timeline',
	});
});

test("fail-closed: empty-string timeline -> 'no-timeline'", () => {
	assert.deepEqual(computeElectionPhase('', '2026-11-03T08:00:00'), { phase: null, reason: 'no-timeline' });
});

test("fail-closed: a JSON string that does not parse -> 'no-timeline'", () => {
	assert.deepEqual(computeElectionPhase('{not json', '2026-11-03T08:00:00'), {
		phase: null,
		reason: 'no-timeline',
	});
});

test("fail-closed: a timeline missing votingStarts -> 'incomplete-timeline'", () => {
	assert.deepEqual(
		computeElectionPhase({ tallyingStarts: '2026-11-03T20:00:00' }, '2026-11-03T08:00:00'),
		{ phase: null, reason: 'incomplete-timeline' },
	);
});

test("fail-closed: a timeline missing tallyingStarts -> 'incomplete-timeline'", () => {
	assert.deepEqual(
		computeElectionPhase({ votingStarts: '2026-11-03T08:00:00' }, '2026-11-03T08:00:00'),
		{ phase: null, reason: 'incomplete-timeline' },
	);
});

test("fail-closed: tallyingStarts earlier than votingStarts -> 'non-monotonic-timeline'", () => {
	assert.deepEqual(
		computeElectionPhase(
			{ votingStarts: '2026-11-03T20:00:00', tallyingStarts: '2026-11-03T08:00:00' },
			'2026-11-03T09:00:00',
		),
		{ phase: null, reason: 'non-monotonic-timeline' },
	);
});

test("fail-closed: a genuinely unparseable datetime string -> 'invalid-datetime'", () => {
	assert.deepEqual(
		computeElectionPhase(
			{ votingStarts: 'not-a-date', tallyingStarts: '2026-11-03T20:00:00' },
			'2026-11-03T08:00:00',
		),
		{ phase: null, reason: 'invalid-datetime' },
	);
});

test("fail-closed: a non-string/number timeline value -> 'invalid-datetime'", () => {
	assert.deepEqual(
		computeElectionPhase(
			{ votingStarts: { nested: true }, tallyingStarts: '2026-11-03T20:00:00' },
			'2026-11-03T08:00:00',
		),
		{ phase: null, reason: 'invalid-datetime' },
	);
});

test('computeElectionPhase never throws for any of the fail-closed inputs above', () => {
	const foreignInputs = [
		null,
		undefined,
		'',
		'{not json',
		{ tallyingStarts: '2026-11-03T20:00:00' },
		{ votingStarts: '2026-11-03T08:00:00' },
		{ votingStarts: '2026-11-03T20:00:00', tallyingStarts: '2026-11-03T08:00:00' },
		{ votingStarts: 'not-a-date', tallyingStarts: '2026-11-03T20:00:00' },
		42,
		[],
	];
	for (const input of foreignInputs) {
		assert.doesNotThrow(() => computeElectionPhase(input, '2026-11-03T08:00:00'));
	}
});

// --- FINDING: toCanonicalDatetime normalises a Z-suffixed, Date-parseable
// value to the SAME canonical instant a non-Z input produces -- it does not
// surface as 'invalid-datetime' post-normalisation. See the module header.

test('FINDING: a Z-suffixed but Date-parseable timeline value normalises to the same phase as its non-Z form (not invalid-datetime)', () => {
	const zTimeline = { votingStarts: '2026-11-03T08:00:00Z', tallyingStarts: '2026-11-03T20:00:00Z' };
	assert.deepEqual(computeElectionPhase(zTimeline, '2026-11-03T08:00:00'), { phase: 'running', reason: null });
});

// --- assertCanonicalDatetime -----------------------------------------------

test('assertCanonicalDatetime accepts a canonical 19-character value', () => {
	assert.equal(assertCanonicalDatetime('2026-11-03T08:00:00', 'x'), '2026-11-03T08:00:00');
});

test('positive control: assertCanonicalDatetime throws naming the label and the exact Z-suffixed value', () => {
	assert.throws(() => assertCanonicalDatetime('2026-11-03T08:00:00Z', 'myLabel'), (err) => {
		assert.ok(err instanceof Error);
		assert.match(err.message, /myLabel/);
		assert.match(err.message, /2026-11-03T08:00:00Z/);
		return true;
	});
});

test('assertCanonicalDatetime throws for a non-string value', () => {
	assert.throws(() => assertCanonicalDatetime(12345, 'x'));
});

// --- resolveComparisonInstant -----------------------------------------------

test('resolveComparisonInstant returns a canonical value unchanged', () => {
	assert.equal(resolveComparisonInstant('2026-11-03T08:00:00'), '2026-11-03T08:00:00');
});

test('resolveComparisonInstant falls back to nowCanonicalDatetime() for null', () => {
	const result = resolveComparisonInstant(null);
	assert.match(result, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
});

test('resolveComparisonInstant falls back to nowCanonicalDatetime() for undefined', () => {
	const result = resolveComparisonInstant(undefined);
	assert.match(result, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
});

test('resolveComparisonInstant throws via assertCanonicalDatetime for a non-canonical non-nullish value', () => {
	assert.throws(() => resolveComparisonInstant('2026-11-03T08:00:00Z'));
});

// --- phaseCopyKey ------------------------------------------------------------

test('phaseCopyKey resolves all three frozen lifecycle copy keys to non-empty strings', () => {
	for (const phase of PHASE_IDS) {
		const key = phaseCopyKey(phase);
		assert.equal(key, `lifecycle.${phase}`);
		const resolved = t(key);
		assert.equal(typeof resolved, 'string');
		assert.ok(resolved.length > 0);
	}
});

test('phaseCopyKey(null) returns null', () => {
	assert.equal(phaseCopyKey(null), null);
});

// --- Seed fixture ------------------------------------------------------------

test('seedElectionSurface: row counts match SEED_EXPECTED_COUNTS on a founding-seeded database', async () => {
	const db = new Database();
	await prepareDb(db);
	await seedFoundingAuthority(db);
	await seedElectionSurface(db);

	for (const [table, expected] of Object.entries(SEED_EXPECTED_COUNTS)) {
		// eslint-disable-next-line no-await-in-loop
		const row = await db.prepare(`select count(*) as c from ${table}`).get({});
		assert.equal(row?.c, expected, `expected ${expected} rows in ${table}, got ${row?.c}`);
	}
});

test('seedElectionSurface: negative control -- a nonce-less Election insert fails naming InsertValid on the same database where the ceremony path succeeds', async () => {
	const db = new Database();
	await prepareDb(db);
	await seedFoundingAuthority(db);
	await seedElectionSurface(db);

	await assert.rejects(
		() =>
			db.exec(
				`insert into Election (Id,AuthorityId,Title,Date,RevisionDeadline,BallotDeadline,Type)
				 with context SigningNonce = null, Tid = 999, now = '2026-03-01T00:00:00'
				 values ('e2','a1','Unsigned Election','2026-11-03T00:00:00','2026-10-01T00:00:00','2026-10-01T00:00:00','o')`,
			),
		/InsertValid/,
	);

	// The ceremony path on this SAME database already succeeded above --
	// re-confirm the row is still there, proving the rejection above is
	// discriminating rather than a broken/poisoned fixture.
	const row = await db.prepare(`select count(*) as c from Election`).get({});
	assert.equal(row?.c, 1);
});
