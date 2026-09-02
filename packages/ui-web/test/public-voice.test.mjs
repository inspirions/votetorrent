/**
 * public-voice.test.mjs — the D-07/D-08 lints over every public-voice `COPY`
 * value (53-07). Travels with the table (D-25), not with any one consumer:
 * this file reads only `COPY` from `../src/index.js` and does no
 * source-tree read of its own.
 *
 * Two lints, each proven live BEFORE it is trusted against the real table:
 *
 * 1. Banned lexemes -- no public-voice value may claim officer/permission/
 *    scope/login/account/dashboard/snapshot/simulation words, because this
 *    app has none of those concepts.
 * 2. No authority derivation -- no public-voice value may share a
 *    contiguous 6-word run with the authority-voiced corpus
 *    (`advisory.authority.*`, `gate.*`, `bootstrap.*`). This is the
 *    mechanical proxy for "authored fresh, never found-and-replaced" --
 *    spike 091's defect was exactly a shared component rendering the
 *    authority's own sentence, verbatim, on the public page.
 *
 * Neither lint interpolates a value under test into its own name, and
 * neither is an always-true disjunct -- both traps this repo has already
 * hit once, one of which shipped on a completely dead page.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { COPY } from '../src/index.js';

// ---------------------------------------------------------------------------
// Key-set definitions.
// ---------------------------------------------------------------------------

/** Every COPY key this file treats as "public voice" (D-08). @type {RegExp} */
const PUBLIC_VOICE_KEY_RE = /^(public\.|advisory\.public\.)/;

/** Every COPY key this file treats as "authority voice" (the corpus a
 * public-voice value must never derive from). @type {RegExp} */
const AUTHORITY_KEY_RE = /^(advisory\.authority\.|gate\.|bootstrap\.)/;

const publicVoiceEntries = Object.entries(COPY).filter(([key]) => PUBLIC_VOICE_KEY_RE.test(key));
const authorityEntries = Object.entries(COPY).filter(([key]) => AUTHORITY_KEY_RE.test(key));

test('sanity: both the public-voice and authority-voice key sets are non-empty (an empty set would make every scan below vacuously pass)', () => {
	assert.ok(publicVoiceEntries.length > 0, 'expected at least one public.*/advisory.public.* key');
	assert.ok(authorityEntries.length > 0, 'expected at least one advisory.authority.*/gate.*/bootstrap.* key');
});

test('the public-voice key set is exactly the ten keys 53-07 added', () => {
	const keys = publicVoiceEntries.map(([key]) => key).sort();
	assert.deepEqual(keys, [
		'advisory.public.body',
		'public.chrome.appName',
		'public.details.body',
		'public.details.summary',
		'public.election.addressLabel',
		'public.election.slot.lifecycle',
		'public.election.slot.timeline',
		'public.election.slot.title',
		'public.election.unreadableAddress.body',
		'public.election.unreadableAddress.title',
	]);
});

// ---------------------------------------------------------------------------
// Lint 1 — banned lexemes.
// ---------------------------------------------------------------------------

/** @type {ReadonlyArray<string>} */
const BANNED_LEXEMES = Object.freeze([
	'officer',
	'permission',
	'scope',
	'sign in',
	'sign-in',
	'signed in',
	'log in',
	'login',
	'account',
	'dashboard',
	'snapshot',
	'simulated',
]);

/** @param {string} value @returns {string | null} */
function findBannedLexeme(value) {
	const lower = value.toLowerCase();
	for (const lexeme of BANNED_LEXEMES) {
		if (lower.includes(lexeme)) return lexeme;
	}
	return null;
}

test('positive control: the banned-lexeme matcher fires on the literal spike-091 defect sentence', () => {
	const fixture = "What's shown here follows the officer's permissions";
	const hit = findBannedLexeme(fixture);
	assert.ok(hit, 'matcher is inert -- cannot detect the exact spike-091 defect it exists to catch');
});

test('benign control: an ordinary public-voice-shaped sentence does not trip the banned-lexeme matcher (a matcher that fires on everything discriminates nothing)', () => {
	const benign = 'Anyone can open this page and see the same election record, published exactly as it stands.';
	assert.equal(findBannedLexeme(benign), null);
});

test('no public-voice COPY value contains a banned lexeme', () => {
	const offenders = [];
	for (const [key, value] of publicVoiceEntries) {
		const hit = findBannedLexeme(value);
		if (hit) offenders.push(`${key}: contains "${hit}"`);
	}
	assert.deepEqual(offenders, [], `banned-lexeme lint failed:\n${offenders.join('\n')}`);
});

// ---------------------------------------------------------------------------
// Lint 2 — no authority derivation (shared 6-word run).
// ---------------------------------------------------------------------------

/** @param {string} value @returns {string[]} */
function toWords(value) {
	return value
		.toLowerCase()
		.replace(/[’']/g, '')
		.replace(/[^a-z0-9\s]+/g, ' ')
		.split(/\s+/)
		.filter((w) => w.length > 0);
}

/** @param {string[]} wordList @returns {Set<string>} */
function sixWordRuns(wordList) {
	const runs = new Set();
	for (let i = 0; i + 6 <= wordList.length; i += 1) {
		runs.add(wordList.slice(i, i + 6).join(' '));
	}
	return runs;
}

const authorityRuns = new Set();
for (const [, value] of authorityEntries) {
	for (const run of sixWordRuns(toWords(value))) authorityRuns.add(run);
}

test('positive control: substituting the REAL advisory.authority.body value in place of a public-voice value trips the 6-word-run matcher', () => {
	const authorityValue = COPY['advisory.authority.body'];
	assert.ok(typeof authorityValue === 'string' && authorityValue.length > 0, 'sanity: advisory.authority.body must exist and be non-empty');
	const runsOfAuthorityValue = sixWordRuns(toWords(authorityValue));
	const hit = [...runsOfAuthorityValue].some((run) => authorityRuns.has(run));
	assert.ok(
		hit,
		'matcher is inert -- rendering the real authority.body value AS IF it were a public-voice value must be detectable, ' +
			'because that is exactly the spike-091 defect this lint exists to catch',
	);
});

test('no public-voice COPY value shares a contiguous 6-word run with the authority-voiced corpus (advisory.authority.*, gate.*, bootstrap.*)', () => {
	const offenders = [];
	for (const [key, value] of publicVoiceEntries) {
		const runs = sixWordRuns(toWords(value));
		for (const run of runs) {
			if (authorityRuns.has(run)) {
				offenders.push(`${key}: shares run "${run}" with the authority-voiced corpus`);
				break;
			}
		}
	}
	assert.deepEqual(offenders, [], `no-authority-derivation lint failed:\n${offenders.join('\n')}`);
});
