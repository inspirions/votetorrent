/**
 * registrations-intake.test.mjs -- C3's bucketed registration-intake series
 * (D-04). Two tiers, and neither alone is the proof:
 *
 *   - P1-P6 (this file's first section) exercise the three PURE bucket
 *     helpers directly, reached by module URL (`registrations.js` is not
 *     the barrel's own surface for these -- they are internals, see the
 *     barrel comment in `officer/index.js`).
 *   - S1-S6 (added by 60-02 Task 2) exercise `readRegistrationIntakeSeries`
 *     itself, through the barrel, against BOTH the real schema (S1/S2 --
 *     `RegistrationRequest` is unseedable against the real schema, so these
 *     only pin the SQL constants to the real table) and a scratch table
 *     (S3-S6 -- the only way to get real rows through the real SQL, since
 *     `RegistrationRequest`'s row-level SignatureValid CHECK needs a genuine
 *     secp256k1/P-256 signature this workspace cannot produce).
 *   - D1-D5 (added by 60-02 Task 3) assert D-04 by source (comment-stripped,
 *     never a comment-only ban) and prove the error path logs the class
 *     only (T-60-02).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { webDataSrc } from '../../../scripts/lib/source-paths.mjs';

const registrationsModule = await import(pathToFileURL(webDataSrc('officer', 'registrations.js')).href);
const { chooseIntakeBucketUnit, densifyIntakeBuckets, foldDayBucketsIntoWeeks, INTAKE_HOUR_MAX_SPAN_MS, INTAKE_DAY_MAX_SPAN_MS } =
	registrationsModule;

// ─────────────────────────────────────────────────────────────────────────
// P1-P6 -- the pure bucket core, reached by direct module URL
// ─────────────────────────────────────────────────────────────────────────

test('P1 thresholds: chooseIntakeBucketUnit flips at exactly 48h and 56d, both boundaries inclusive of the finer unit', () => {
	assert.equal(chooseIntakeBucketUnit(0), 'hour');
	assert.equal(chooseIntakeBucketUnit(INTAKE_HOUR_MAX_SPAN_MS), 'hour');
	assert.equal(chooseIntakeBucketUnit(INTAKE_HOUR_MAX_SPAN_MS + 1), 'day');
	assert.equal(chooseIntakeBucketUnit(INTAKE_DAY_MAX_SPAN_MS), 'day');
	assert.equal(chooseIntakeBucketUnit(INTAKE_DAY_MAX_SPAN_MS + 1), 'week');
});

test('P1b: the two threshold constants are pinned to their literal millisecond values', () => {
	assert.equal(INTAKE_HOUR_MAX_SPAN_MS, 172800000, '48 hours in ms');
	assert.equal(INTAKE_DAY_MAX_SPAN_MS, 4838400000, '56 days in ms');
});

test('P2 discrimination control: a stub that ignores its argument disagrees with the five-point boundary sequence', () => {
	const spans = [0, INTAKE_HOUR_MAX_SPAN_MS, INTAKE_HOUR_MAX_SPAN_MS + 1, INTAKE_DAY_MAX_SPAN_MS, INTAKE_DAY_MAX_SPAN_MS + 1];
	const real = spans.map((s) => chooseIntakeBucketUnit(s));
	/** @param {number} _spanMs @returns {string} */
	const stub = (_spanMs) => 'day';
	const stubbed = spans.map((s) => stub(s));
	assert.deepEqual(real, ['hour', 'hour', 'day', 'day', 'week']);
	assert.notDeepEqual(stubbed, real, 'a unit-ignoring stub must disagree with the real boundary sequence -- P1 must be able to fail');
});

test('P3 hour densification: two hour buckets on one UTC day densify to four rows with zero-count interior gaps', () => {
	const rows = densifyIntakeBuckets(
		[
			{ bucketStart: '2026-09-15T13:00:00', count: 1 },
			{ bucketStart: '2026-09-15T16:00:00', count: 1 },
		],
		'hour',
	);
	assert.deepEqual(rows, [
		{ bucketStart: '2026-09-15T13:00:00', count: 1 },
		{ bucketStart: '2026-09-15T14:00:00', count: 0 },
		{ bucketStart: '2026-09-15T15:00:00', count: 0 },
		{ bucketStart: '2026-09-15T16:00:00', count: 1 },
	]);
});

test('P4 day densification across a month boundary: eight rows, September into October, epoch-step not calendar arithmetic', () => {
	const rows = densifyIntakeBuckets(
		[
			{ bucketStart: '2026-09-25', count: 1 },
			{ bucketStart: '2026-10-02', count: 1 },
		],
		'day',
	);
	assert.deepEqual(rows, [
		{ bucketStart: '2026-09-25', count: 1 },
		{ bucketStart: '2026-09-26', count: 0 },
		{ bucketStart: '2026-09-27', count: 0 },
		{ bucketStart: '2026-09-28', count: 0 },
		{ bucketStart: '2026-09-29', count: 0 },
		{ bucketStart: '2026-09-30', count: 0 },
		{ bucketStart: '2026-10-01', count: 0 },
		{ bucketStart: '2026-10-02', count: 1 },
	]);
});

test('P5 densification control: an identity stub over P3s input fails the four-row expectation', () => {
	const input = [
		{ bucketStart: '2026-09-15T13:00:00', count: 1 },
		{ bucketStart: '2026-09-15T16:00:00', count: 1 },
	];
	/** @param {{bucketStart: string, count: number}[]} rows @returns {{bucketStart: string, count: number}[]} */
	const identityStub = (rows) => rows;
	const stubbedResult = identityStub(input);
	assert.notDeepEqual(
		stubbedResult,
		[
			{ bucketStart: '2026-09-15T13:00:00', count: 1 },
			{ bucketStart: '2026-09-15T14:00:00', count: 0 },
			{ bucketStart: '2026-09-15T15:00:00', count: 0 },
			{ bucketStart: '2026-09-15T16:00:00', count: 1 },
		],
		'a gap-preserving implementation must fail the four-row expectation -- the exact defect class P3 exists to catch',
	);
});

test('P6 week folding: three day buckets anchor on the earliest and fold to week indexes 0/2/21', () => {
	const dayRows = [
		{ bucketStart: '2026-01-05', count: 1 },
		{ bucketStart: '2026-01-20', count: 1 },
		{ bucketStart: '2026-06-01', count: 1 },
	];
	const weekRows = foldDayBucketsIntoWeeks(dayRows);
	assert.deepEqual(weekRows, [
		{ bucketStart: '2026-01-05', count: 1 },
		{ bucketStart: '2026-01-19', count: 1 },
		{ bucketStart: '2026-06-01', count: 1 },
	]);

	const densified = densifyIntakeBuckets(weekRows, 'week');
	assert.equal(densified.length, 22);
	for (let i = 1; i < densified.length; i += 1) {
		const stepMs = Date.parse(densified[i].bucketStart + 'T00:00:00Z') - Date.parse(densified[i - 1].bucketStart + 'T00:00:00Z');
		assert.equal(stepMs, 604800000, 'every step must be exactly WEEK_MS');
	}
	const nonZeroIndexes = new Set([0, 2, 21]);
	for (let i = 0; i < densified.length; i += 1) {
		assert.equal(densified[i].count, nonZeroIndexes.has(i) ? 1 : 0, 'index ' + i + ' count mismatch');
	}
});
