/**
 * capabilities.test.mjs — schema-parity, generator-staleness and copy-key
 * cross-check assertions for the generated capability matrix.
 *
 * Deliberately does NOT `import 'fake-indexeddb/auto'` — this file touches
 * no IndexedDB, and importing the shim would imply a persistence claim this
 * tier cannot make (50-04's gate-contract test states that limit).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
	extractFromSchema,
	generateSource,
	SCHEMA_PATH,
	OUTPUT_PATH,
} from '../../scripts/generate-capabilities.mjs';
import { CAPABILITIES, PANEL_GROUPS, SCOPE_CODES } from '../../src/auth/capabilities.js';
import { t } from '@votetorrent/ui-web';

const SCHEMA_TEXT = readFileSync(SCHEMA_PATH, 'utf8');

const EXPECTED_ID_ORDER = [
	'registrations',
	'elections',
	'ballotsQuestions',
	'networkSettings',
	'authorityProfile',
	'authorityPeers',
	'administrationOfficers',
	'keyholders',
	'inviteAuthorities',
];

const EXPECTED_SITES_BY_SCOPE = {
	vrg: 18,
	mel: 12,
	ceb: 7,
	rn: 3,
	uai: 2,
	cap: 2,
	rad: 1,
	iad: 0,
	ik: 0,
};

test('generateSource() output begins with an AUTO-GENERATED header naming the generator and schema path', () => {
	const source = generateSource(SCHEMA_TEXT);
	assert.match(source, /AUTO-GENERATED/);
	assert.match(source, /scripts\/generate-capabilities\.mjs/);
	assert.match(source, /votetorrent\.qsql/);
});

test('CAPABILITIES has exactly 9 entries', () => {
	assert.equal(CAPABILITIES.length, 9);
});

test('the capability scope set deep-equals the code set parsed out of view Scope (size 9)', () => {
	const { declared } = extractFromSchema(SCHEMA_TEXT);
	const schemaCodes = new Set(declared.map((d) => d.code));
	assert.equal(schemaCodes.size, 9);
	const capabilityScopes = new Set(CAPABILITIES.map((c) => c.scope));
	assert.deepEqual(capabilityScopes, schemaCodes);
});

test('CAPABILITIES ids are in the binding registration-first order', () => {
	assert.deepEqual(
		CAPABILITIES.map((c) => c.id),
		EXPECTED_ID_ORDER,
	);
});

test('per-scope sites match the measured baseline and sum to 45', () => {
	const bySopce = Object.fromEntries(CAPABILITIES.map((c) => [c.scope, c.sites]));
	assert.deepEqual(bySopce, EXPECTED_SITES_BY_SCOPE);
	const total = CAPABILITIES.reduce((sum, c) => sum + c.sites, 0);
	assert.equal(total, 45, `expected 45 total enforcement sites, measured ${total}`);
});

test('tier is derived correctly: sites > 0 => tier 1, sites === 0 => tier 2; keyholders and inviteAuthorities are the only tier-2 entries', () => {
	const tier2Ids = [];
	for (const c of CAPABILITIES) {
		if (c.sites > 0) {
			assert.equal(c.tier, 1, `${c.id} has sites > 0 but tier !== 1`);
		} else {
			assert.equal(c.tier, 2, `${c.id} has sites === 0 but tier !== 2`);
			tier2Ids.push(c.id);
		}
	}
	assert.deepEqual(tier2Ids.sort(), ['inviteAuthorities', 'keyholders']);
});

test('administrationOfficers carries a non-empty siteCountCaveat mentioning OfficerRequired; every other entry is null', () => {
	for (const c of CAPABILITIES) {
		if (c.id === 'administrationOfficers') {
			assert.ok(typeof c.siteCountCaveat === 'string');
			assert.ok(c.siteCountCaveat.length > 0);
			assert.match(c.siteCountCaveat, /OfficerRequired/);
		} else {
			assert.equal(c.siteCountCaveat, null, `${c.id} should have a null siteCountCaveat`);
		}
	}
});

test('every generated titleKey and emptyKey resolves through the frozen COPY table', () => {
	let checked = 0;
	for (const c of CAPABILITIES) {
		const title = t(c.titleKey);
		const empty = t(c.emptyKey);
		assert.ok(typeof title === 'string' && title.length > 0, `t(${c.titleKey}) must be non-empty`);
		assert.ok(typeof empty === 'string' && empty.length > 0, `t(${c.emptyKey}) must be non-empty`);
		checked += 2;
	}
	assert.equal(checked, 18, 'expected to cross-check exactly 18 generated copy keys (9 titles + 9 empties)');
});

test('staleness check: the committed capabilities.js is byte-identical to a fresh generation from the live schema', () => {
	const committed = readFileSync(OUTPUT_PATH, 'utf8');
	const fresh = generateSource(SCHEMA_TEXT);
	assert.equal(
		committed,
		fresh,
		'src/auth/capabilities.js is stale relative to the current schema — re-run `node scripts/generate-capabilities.mjs` (or `yarn workspace votetorrent-dashboard capabilities:generate`) and commit the result. Do NOT hand-edit the output.',
	);
});

test('mutating a returned CAPABILITIES entry throws (each entry and the array are frozen)', () => {
	assert.ok(Object.isFrozen(CAPABILITIES));
	const entry = CAPABILITIES[0];
	assert.ok(Object.isFrozen(entry));
	assert.throws(() => {
		'use strict';
		/** @type {any} */ (entry).tier = 99;
	});
});

test('PANEL_GROUPS is the frozen two-entry array and every capability group is one of its ids', () => {
	assert.deepEqual(
		PANEL_GROUPS.map((g) => ({ id: g.id, titleKey: g.titleKey })),
		[
			{ id: 'electionOperations', titleKey: 'nav.groupElectionOperations' },
			{ id: 'authorityAdministration', titleKey: 'nav.groupAuthorityAdministration' },
		],
	);
	const groupIds = new Set(PANEL_GROUPS.map((g) => g.id));
	for (const c of CAPABILITIES) {
		assert.ok(groupIds.has(c.group), `${c.id}'s group "${c.group}" is not one of PANEL_GROUPS' ids`);
	}
});

test('SCOPE_CODES is the frozen nine-code array matching the schema set', () => {
	assert.ok(Object.isFrozen(SCOPE_CODES));
	assert.equal(SCOPE_CODES.length, 9);
	const { declared } = extractFromSchema(SCHEMA_TEXT);
	assert.deepEqual(new Set(SCOPE_CODES), new Set(declared.map((d) => d.code)));
});

test('positive control: a synthetic schema carrying a tenth scope code throws an error naming it', () => {
	const start = SCHEMA_TEXT.indexOf('view Scope as');
	const end = SCHEMA_TEXT.indexOf(';', start);
	assert.ok(start !== -1 && end !== -1, 'could not locate "view Scope as ... ;" in the real schema for the synthetic mutation');

	const injected =
		SCHEMA_TEXT.slice(0, end) +
		`\n\t\tunion all select 'zzz' as Code, 'Fake' as Name` +
		SCHEMA_TEXT.slice(end);

	assert.throws(
		() => generateSource(injected),
		/zzz/,
		'generateSource() must throw naming the unmapped scope code "zzz"',
	);

	// The real schema file on disk must never be touched by this test.
	assert.equal(readFileSync(SCHEMA_PATH, 'utf8'), SCHEMA_TEXT);
});

test('reverse positive control: a synthetic schema missing a scope the PRESENTATION map still names throws, naming that code', () => {
	// Remove the 'ik' row from a copy of the view Scope block only.
	const withoutIk = SCHEMA_TEXT.replace(
		/\n\s*union all select 'ik' as Code, 'Invite Keyholders' as Name;/,
		';',
	);
	assert.notEqual(withoutIk, SCHEMA_TEXT, 'the synthetic mutation did not change the schema text — fixture is broken');
	assert.throws(() => generateSource(withoutIk), /ik/);
});
