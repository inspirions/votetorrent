/**
 * election-address.test.mjs — total coverage of `parseElectionAddress` over
 * all three statuses (D-14, ASVS V5). This file's SUBJECT is
 * `src/election-address.js` itself, imported directly by relative path —
 * the same D-25 idiom `packages/ui-web/test/election-phase.test.mjs` uses
 * for a module it executes rather than merely scans.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { ELECTION_ADDRESS_PARAM, ELECTION_ID_PATTERN, parseElectionAddress } from '../../src/election-address.js';

test('ELECTION_ADDRESS_PARAM is the single query parameter name', () => {
	assert.equal(ELECTION_ADDRESS_PARAM, 'election');
});

test('ELECTION_ID_PATTERN is the deliberately loose 1-128 char unreserved-URL-safe form, not the 43-char base64url digest idiom', () => {
	assert.match('a'.repeat(128), ELECTION_ID_PATTERN);
	assert.doesNotMatch('a'.repeat(129), ELECTION_ID_PATTERN);
	assert.doesNotMatch('', ELECTION_ID_PATTERN);
});

// ---------------------------------------------------------------------------
// Inertness control — a parser that returned 'malformed' for everything
// (or 'missing' for everything) must not be able to pass this suite.
// ---------------------------------------------------------------------------
test('inertness control: a well-formed single election id is "ok" (proves the suite can discriminate)', () => {
	const result = parseElectionAddress('?election=abc');
	assert.equal(result.status, 'ok');
	assert.equal(result.electionId, 'abc');
	assert.ok(Object.isFrozen(result));
});

// ---------------------------------------------------------------------------
// 'missing' cases — never an error, never echoes a value.
// ---------------------------------------------------------------------------
const MISSING_CASES = [
	['no search string at all', ''],
	['a bare question mark', '?'],
	['an empty election value', '?election='],
	['a different, unrelated parameter', '?other=x'],
];
for (const [label, input] of MISSING_CASES) {
	test(`'missing': ${label}`, () => {
		const result = parseElectionAddress(input);
		assert.equal(result.status, 'missing');
		assert.equal(result.electionId, null);
		assert.ok(Object.isFrozen(result));
	});
}

const MISSING_NON_STRING_CASES = [
	['undefined', undefined],
	['null', null],
	['a number', 42],
];
for (const [label, input] of MISSING_NON_STRING_CASES) {
	test(`'missing', non-string input never throws: ${label}`, () => {
		assert.doesNotThrow(() => parseElectionAddress(input));
		const result = parseElectionAddress(input);
		assert.equal(result.status, 'missing');
		assert.equal(result.electionId, null);
	});
}

// ---------------------------------------------------------------------------
// 'malformed' cases — the offending value is NEVER returned.
// ---------------------------------------------------------------------------
const MALFORMED_CASES = [
	['a duplicated parameter', '?election=a&election=b'],
	['leading percent-encoded whitespace', '?election=%20abc'],
	['trailing percent-encoded whitespace', '?election=abc%20'],
	['a "+" decoding to an embedded space', '?election=a+b'],
	['an embedded slash', '?election=a/b'],
	['an embedded dot', '?election=a.b'],
	['a script-shaped payload', '?election=%3Cscript%3Ealert(1)%3C%2Fscript%3E'],
	['a path-traversal-shaped payload', '?election=..%2F..%2Fetc%2Fpasswd'],
	['a percent-encoded NUL byte', '?election=%00'],
	['a 129-character value (one over the limit)', '?election=' + 'a'.repeat(129)],
];
for (const [label, input] of MALFORMED_CASES) {
	test(`'malformed': ${label}`, () => {
		const result = parseElectionAddress(input);
		assert.equal(result.status, 'malformed', `expected 'malformed' for ${JSON.stringify(input)}`);
		assert.equal(result.electionId, null, 'a malformed value must never be echoed back');
		assert.ok(Object.isFrozen(result));
	});
}

// ---------------------------------------------------------------------------
// 'ok' cases.
// ---------------------------------------------------------------------------
test(`'ok': a 128-character value (exactly at the limit)`, () => {
	const value = 'a'.repeat(128);
	const result = parseElectionAddress(`?election=${value}`);
	assert.equal(result.status, 'ok');
	assert.equal(result.electionId, value);
});

test(`'ok': an ordinary mixed-charset id`, () => {
	const result = parseElectionAddress('?election=vtx-Ab3_9');
	assert.equal(result.status, 'ok');
	assert.equal(result.electionId, 'vtx-Ab3_9');
});

// ---------------------------------------------------------------------------
// Never throws, over every case above plus a few more hostile inputs.
// ---------------------------------------------------------------------------
test('parseElectionAddress never throws, over every case in this file', () => {
	const inputs = [
		...MISSING_CASES.map(([, input]) => input),
		...MISSING_NON_STRING_CASES.map(([, input]) => input),
		...MALFORMED_CASES.map(([, input]) => input),
		'?election=abc',
		'not-even-a-query-string',
		'?election=' + 'a'.repeat(10000),
	];
	for (const input of inputs) {
		assert.doesNotThrow(() => parseElectionAddress(input), `threw on ${JSON.stringify(input)}`);
	}
});
