/**
 * registrant-roll.test.mjs — the tier-1 gates for the published voter roll:
 * D-23's fail-closed disclosure resolver, and the source-scan half of D-18/
 * D-19/D-20.
 *
 * Every path is resolved through `scripts/lib/source-paths.mjs` (53-01's rule)
 * and never re-derived from `import.meta.url`. The one module this file RUNS is
 * imported by a direct relative specifier rather than through a resolver-built
 * dynamic `import()`: `tsc --noEmit` covers `test/` with `noImplicitAny`, and a
 * dynamically imported module is untyped, so every callback over its exports
 * fails typecheck. `election-address.test.mjs` states the same rule; the
 * resolver is still what locates every file read as TEXT.
 *
 * WHAT NO RUNG IN THIS FILE CAN PROVE, stated up front so a green here is not
 * over-read: nothing below renders. That three columns actually appear, that a
 * production-length district scrolls rather than clipping, and that the
 * authority-supplied text reaches the DOM escaped are browser-tier assertions
 * and belong to 54-16. Presence is not rendering — this repo has shipped two
 * defects on exactly that gap.
 *
 * SELF-TRIPPING-CHECKER DISCIPLINE. Every literal this file hunts for lives in
 * one frozen array and is never restated in prose, and every scan strips
 * comment lines before matching. A checker whose own comment spells the token
 * it greps for is permanently green; that failure has now been manufactured
 * eight times in this phase.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { publicSrc } from '../../../../scripts/lib/source-paths.mjs';
import {
	ROLL_FIELDS,
	DISCLOSURE_AUDIENCE_CODES,
	ANONYMOUS_AUDIENCE,
	ROLL_DISCLOSURE_POLICY,
	resolveRollColumns,
} from '../../src/roll-disclosure.js';

/** @param {string} source @returns {string} */
function stripCommentLines(source) {
	return source
		.split('\n')
		.filter((line) => {
			const trimmed = line.trim();
			return !(trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*'));
		})
		.join('\n');
}

/** @param {...string} segs @returns {string} */
const strippedSrc = (...segs) => stripCommentLines(readFileSync(publicSrc(...segs), 'utf8'));

const ROLL_DISCLOSURE = strippedSrc('roll-disclosure.js');

// ---------------------------------------------------------------------------
// 1. Sanity — anti-vacuous. Without this every scan below could pass on an
//    empty string, and every set rung on an empty model.
// ---------------------------------------------------------------------------

test('1. sanity: every source this file scans is non-empty after comment stripping', () => {
	for (const [label, source] of [['roll-disclosure.js', ROLL_DISCLOSURE]]) {
		assert.ok(source.trim().length > 0, `${label} is empty after comment stripping — every scan over it would pass vacuously`);
	}
});

// ---------------------------------------------------------------------------
// 2. The constants are exactly what the schema and D-19 say.
// ---------------------------------------------------------------------------

test('2. ROLL_FIELDS is the frozen three-column published set, in schema order', () => {
	assert.deepEqual([...ROLL_FIELDS], ['LastName', 'FirstName', 'District']);
	assert.ok(Object.isFrozen(ROLL_FIELDS), 'ROLL_FIELDS is not frozen — a caller could widen the published field set at runtime');
});

test('2a. DISCLOSURE_AUDIENCE_CODES is the frozen two-code vocabulary transcribed from the schema view, and ANONYMOUS_AUDIENCE is the one an anonymous reader satisfies', () => {
	assert.deepEqual([...DISCLOSURE_AUDIENCE_CODES], ['district', 'everyone']);
	assert.ok(Object.isFrozen(DISCLOSURE_AUDIENCE_CODES));
	assert.equal(ANONYMOUS_AUDIENCE, 'everyone');
	assert.ok(DISCLOSURE_AUDIENCE_CODES.includes(ANONYMOUS_AUDIENCE), 'the anonymous audience is not one of the recognised codes');
});

test('2b. ROLL_DISCLOSURE_POLICY declares exactly one frozen entry per published field, every one of them the anonymous audience', () => {
	assert.ok(Object.isFrozen(ROLL_DISCLOSURE_POLICY));
	assert.equal(ROLL_DISCLOSURE_POLICY.length, ROLL_FIELDS.length);
	assert.deepEqual(
		ROLL_DISCLOSURE_POLICY.map((e) => e.field),
		[...ROLL_FIELDS],
	);
	for (const entry of ROLL_DISCLOSURE_POLICY) {
		assert.ok(Object.isFrozen(entry), `policy entry for ${entry.field} is not frozen`);
		assert.equal(entry.audience, ANONYMOUS_AUDIENCE);
	}
});

// ---------------------------------------------------------------------------
// 3. The happy path, and the inertness control that proves the fault-mode
//    rungs below are not merely passing because the resolver reports
//    everything unreadable.
// ---------------------------------------------------------------------------

test('3. the declared policy publishes all three columns in ROLL_FIELDS order with nothing unreadable', () => {
	const { columns, unreadable } = resolveRollColumns(ROLL_DISCLOSURE_POLICY);
	assert.deepEqual([...columns], [...ROLL_FIELDS]);
	assert.deepEqual([...unreadable], []);
});

test('3a. inertness control: a hand-built valid policy DISTINCT from the declared one also yields nothing unreadable — the resolver is not simply reporting every field unreadable', () => {
	const handBuilt = [
		{ field: 'District', audience: 'everyone' },
		{ field: 'FirstName', audience: 'everyone' },
		{ field: 'LastName', audience: 'everyone' },
	];
	assert.notDeepEqual(
		handBuilt.map((e) => e.field),
		[...ROLL_FIELDS],
		'fixture sanity: the hand-built policy must differ from the declared one, or this control re-tests rung 3',
	);
	const { columns, unreadable } = resolveRollColumns(handBuilt);
	assert.deepEqual([...unreadable], []);
	// Ordered by ROLL_FIELDS, never by the policy's own order — a reordered
	// policy cannot reorder the table.
	assert.deepEqual([...columns], [...ROLL_FIELDS]);
});

// ---------------------------------------------------------------------------
// 4. D-23's fault modes. Each withholds its column AND records the field as
//    unreadable, so a policy fault is never indistinguishable from a
//    deliberate withholding.
// ---------------------------------------------------------------------------

/**
 * The declared policy with one field's entry replaced by an arbitrary value —
 * or removed entirely when `replacement` is `undefined`.
 * @param {string} field
 * @param {unknown} replacement
 * @returns {unknown[]}
 */
function policyWith(field, replacement) {
	/** @type {unknown[]} */
	const out = [];
	for (const entry of ROLL_DISCLOSURE_POLICY) {
		if (entry.field !== field) {
			out.push({ field: entry.field, audience: entry.audience });
			continue;
		}
		if (replacement !== undefined) out.push(replacement);
	}
	return out;
}

test('4. missing entry: the field is withheld and named unreadable, and the other two still publish', () => {
	const { columns, unreadable } = resolveRollColumns(policyWith('District', undefined));
	assert.deepEqual([...columns], ['LastName', 'FirstName']);
	assert.deepEqual([...unreadable], ['District']);
});

test('4a. malformed entry, shape 1: the entry is null', () => {
	const { columns, unreadable } = resolveRollColumns(policyWith('District', null));
	assert.ok(!columns.includes('District'));
	assert.deepEqual([...unreadable], ['District']);
});

test('4b. malformed entry, shape 2: the entry is a string rather than an object', () => {
	const { columns, unreadable } = resolveRollColumns(policyWith('District', 'District'));
	assert.ok(!columns.includes('District'));
	assert.deepEqual([...unreadable], ['District']);
});

test('4c. malformed entry, shape 3: `field` is an empty string', () => {
	const { columns, unreadable } = resolveRollColumns([
		{ field: '', audience: 'everyone' },
		{ field: 'LastName', audience: 'everyone' },
		{ field: 'FirstName', audience: 'everyone' },
	]);
	assert.deepEqual([...columns], ['LastName', 'FirstName']);
	assert.deepEqual([...unreadable], ['District']);
});

test('4d. malformed entry, shape 4: `audience` is not a string', () => {
	const { columns, unreadable } = resolveRollColumns(policyWith('District', { field: 'District', audience: 42 }));
	assert.ok(!columns.includes('District'));
	assert.deepEqual([...unreadable], ['District']);
});

test('4e. unknown audience: a code outside the schema vocabulary is withheld, not trusted', () => {
	const unknown = 'friends';
	assert.ok(!DISCLOSURE_AUDIENCE_CODES.includes(unknown), 'fixture sanity: the probe audience must not be a recognised code');
	const { columns, unreadable } = resolveRollColumns(policyWith('District', { field: 'District', audience: unknown }));
	assert.ok(!columns.includes('District'));
	assert.deepEqual([...unreadable], ['District']);
});

test('4f. known-but-unsatisfiable audience: `district` is a recognised code an anonymous reader cannot satisfy, and it fails closed the same way', () => {
	const other = DISCLOSURE_AUDIENCE_CODES.filter((code) => code !== ANONYMOUS_AUDIENCE);
	assert.equal(other.length, 1, 'fixture sanity: the schema view declares exactly one non-anonymous audience');
	const { columns, unreadable } = resolveRollColumns(policyWith('District', { field: 'District', audience: other[0] }));
	assert.ok(!columns.includes('District'));
	assert.deepEqual([...unreadable], ['District']);
});

test('4g. every fault mode leaves the OTHER two columns publishing — the resolver withholds one field, never the table', () => {
	for (const replacement of [undefined, null, 'District', { field: 'District', audience: 42 }, { field: 'District', audience: 'friends' }]) {
		const { columns } = resolveRollColumns(policyWith('District', replacement));
		assert.deepEqual([...columns], ['LastName', 'FirstName'], `a District fault collapsed the whole table for replacement ${JSON.stringify(replacement)}`);
	}
});

// ---------------------------------------------------------------------------
// 5. Fail-closed on garbage, and the intersection against ROLL_FIELDS.
// ---------------------------------------------------------------------------

test('5. six garbage inputs each yield no columns and every field unreadable, and none of them throws', () => {
	for (const input of [null, undefined, [], {}, 'x', 42]) {
		const verdict = resolveRollColumns(/** @type {any} */ (input));
		assert.deepEqual([...verdict.columns], [], `a column published for garbage input ${JSON.stringify(input) ?? 'undefined'}`);
		assert.deepEqual([...verdict.unreadable], [...ROLL_FIELDS], `the all-withheld verdict is incomplete for ${JSON.stringify(input) ?? 'undefined'}`);
	}
});

test('5a. a policy entry naming a field outside ROLL_FIELDS never produces a column', () => {
	const widened = [
		...ROLL_DISCLOSURE_POLICY.map((e) => ({ field: e.field, audience: e.audience })),
		{ field: 'ExtraFields', audience: 'everyone' },
		{ field: 'RegistrantId', audience: 'everyone' },
	];
	const { columns, unreadable } = resolveRollColumns(widened);
	assert.deepEqual([...columns], [...ROLL_FIELDS], 'a fourth policy entry widened the published column set');
	assert.deepEqual([...unreadable], []);
	for (const column of columns) {
		assert.ok(ROLL_FIELDS.includes(column), `${column} is not a member of the published field set`);
	}
});

test('5b. a duplicated or reordered policy cannot duplicate or reorder the table — the FIRST matching entry decides and the output is ROLL_FIELDS-ordered', () => {
	const duplicated = [
		{ field: 'District', audience: 'everyone' },
		{ field: 'District', audience: 'friends' },
		{ field: 'FirstName', audience: 'everyone' },
		{ field: 'LastName', audience: 'everyone' },
	];
	const { columns, unreadable } = resolveRollColumns(duplicated);
	assert.deepEqual([...columns], [...ROLL_FIELDS]);
	assert.deepEqual([...unreadable], []);
});

// ---------------------------------------------------------------------------
// 6. Purity — frozen output, repeatable, and the input is never mutated.
// ---------------------------------------------------------------------------

test('6. both returned arrays are frozen, the verdict is frozen, two calls agree, and the input object is unmutated', () => {
	const input = [
		{ field: 'LastName', audience: 'everyone' },
		{ field: 'FirstName', audience: 'district' },
		{ field: 'District', audience: 'everyone' },
	];
	const before = structuredClone(input);
	const first = resolveRollColumns(input);
	const second = resolveRollColumns(input);

	assert.ok(Object.isFrozen(first), 'the verdict object is not frozen');
	assert.ok(Object.isFrozen(first.columns), 'the columns array is not frozen');
	assert.ok(Object.isFrozen(first.unreadable), 'the unreadable array is not frozen');
	assert.deepEqual(first, second, 'two calls on the same input disagree');
	assert.deepEqual(input, before, 'resolveRollColumns mutated its input');
	assert.deepEqual([...first.columns], ['LastName', 'District']);
	assert.deepEqual([...first.unreadable], ['FirstName']);
});

// ---------------------------------------------------------------------------
// 7. The module's own shape: no import, no throw, no read.
// ---------------------------------------------------------------------------

test('7. roll-disclosure.js imports nothing, throws nothing and queries nothing — content selection is all it does', () => {
	for (const construct of ['import ', 'require(', 'throw ', 'db.', 'await ']) {
		assert.ok(!ROLL_DISCLOSURE.includes(construct), `roll-disclosure.js contains "${construct}" in executable source`);
	}
});
