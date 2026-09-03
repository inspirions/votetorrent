/**
 * authority-admin-panels.test.mjs -- source-level assertions over the six
 * Authority Administration panel bodies: no mutating affordance, no
 * invented copy, no key material, no self-gating. `node --test` cannot
 * import `.tsx`, so this file reads each source as TEXT, in
 * `test/node/registry.test.mjs`'s (50-06) shape, and strips `//` / `/* *\/`
 * comment lines before matching an unfiltered scan would be tripped by this
 * plan's own explanatory comments.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { dashboardSrc, workspacePath } from '../../../../scripts/lib/source-paths.mjs';
import { stripComments } from '../../../../scripts/lib/strip-comments.mjs';

const PANELS_DIR = dashboardSrc('screens', 'panels');
const SCHEMA_PATH = workspacePath('packages/vote-core', 'schema', 'votetorrent.qsql');

/** All six Authority Administration panel files this suite covers. A later
 * edit that quietly shrinks this list fails the length assertion below.
 * @type {string[]} */
export const FILES = [
	'NetworkSettingsPanel.tsx',
	'AuthorityProfilePanel.tsx',
	'AuthorityPeersPanel.tsx',
	'AdministrationOfficersPanel.tsx',
	'KeyholdersPanel.tsx',
	'InviteAuthoritiesPanel.tsx',
];

/** Parse the set of schema column identifiers: column declarations inside
 * `table` blocks (leading whitespace, an identifier, a recognised column
 * type keyword) plus `as <Name>` aliases inside `view` blocks.
 * @param {string} source @returns {Set<string>} */
function extractSchemaColumnIdentifiers(source) {
	const identifiers = new Set();
	const colRe = /^[ \t]*([A-Z][A-Za-z0-9]*)[ \t]+(text|integer|datetime|boolean)\b/gm;
	for (const m of source.matchAll(colRe)) identifiers.add(m[1]);
	const asRe = /\bas\s+([A-Z][A-Za-z0-9]*)\b/g;
	for (const m of source.matchAll(asRe)) identifiers.add(m[1]);
	return identifiers;
}

/** Extract every literal `<dt>...</dt>` text node.
 * @param {string} source @returns {string[]} */
function extractDtLabels(source) {
	return [...source.matchAll(/<dt>([^<]*)<\/dt>/g)].map((m) => m[1].trim()).filter((s) => s.length > 0);
}

const SCHEMA_SOURCE = readFileSync(SCHEMA_PATH, 'utf8');
const SCHEMA_COLUMN_IDENTIFIERS = extractSchemaColumnIdentifiers(SCHEMA_SOURCE);

/** @type {Record<string, string>} */
const RAW = {};
/** @type {Record<string, string>} */
const STRIPPED = {};
for (const file of FILES) {
	RAW[file] = readFileSync(path.join(PANELS_DIR, file), 'utf8');
	STRIPPED[file] = stripComments(RAW[file]);
}

test('FILES names exactly the six Authority Administration panels', () => {
	assert.equal(FILES.length, 6);
	assert.deepEqual(FILES, [
		'NetworkSettingsPanel.tsx',
		'AuthorityProfilePanel.tsx',
		'AuthorityPeersPanel.tsx',
		'AdministrationOfficersPanel.tsx',
		'KeyholdersPanel.tsx',
		'InviteAuthoritiesPanel.tsx',
	]);
});

// --- 1. No mutating affordance ----------------------------------------------

const CONTROL_RE = /<button|<form|<input|<select|<textarea|onClick|onSubmit|onChange|href=/;

test('no <button>, <form>, <input>, <select>, <textarea>, onClick, onSubmit, onChange or href= in any of the six files', () => {
	for (const file of FILES) {
		assert.doesNotMatch(STRIPPED[file], CONTROL_RE, `${file} contains a control affordance`);
	}
});

test('positive control: the control matcher hits a synthetic fixture', () => {
	const fixture = `<button onClick={go}>Add peer</button>`;
	assert.match(fixture, CONTROL_RE, 'matcher is inert -- it must hit its own positive-control fixture');
});

// --- 2. No unreachable panel state (comments included) ----------------------

test('no "read-only", "readonly", "writable", "disabled" or "◐" anywhere in the six files, comments included', () => {
	for (const file of FILES) {
		assert.doesNotMatch(RAW[file], /read-only|readonly|writable|disabled|◐/i, `${file} names the unreachable panel state`);
	}
});

// --- 3. No raw HTML seam -----------------------------------------------------

test('no dangerouslySetInnerHTML in any of the six files', () => {
	for (const file of FILES) {
		assert.doesNotMatch(STRIPPED[file], /dangerouslySetInnerHTML/, `${file} contains an injection surface`);
	}
});

// --- 4. No self-gating -------------------------------------------------------

test('no import of ../../auth/gate.js, no evaluate(, no grantedScopes reference in any of the six files', () => {
	for (const file of FILES) {
		assert.doesNotMatch(STRIPPED[file], /auth\/gate\.js|evaluate\(|grantedScopes/, `${file} makes its own visibility decision`);
	}
});

// --- 4b. No self-composition (50-06 contract C7) -----------------------------

const PANEL_FRAME_RE = /PanelFrame/;

test('none of the six files references PanelFrame -- 50-09\'s PanelGrid composes the frame', () => {
	for (const file of FILES) {
		assert.doesNotMatch(STRIPPED[file], PANEL_FRAME_RE, `${file} imports or renders PanelFrame`);
	}
});

test('positive control: the PanelFrame-detection matcher hits a synthetic self-wrapping import', () => {
	const fixture = `import PanelFrame from './PanelFrame.tsx';`;
	assert.match(fixture, PANEL_FRAME_RE, 'matcher is inert -- it must hit its own positive-control fixture');
});

// --- 5. No shared prefetch ----------------------------------------------------

/** @type {Record<string, string>} */
const FETCHER_NAMES = {
	'NetworkSettingsPanel.tsx': 'fetchNetworkSettings',
	'AuthorityProfilePanel.tsx': 'fetchAuthorityProfile',
	'AuthorityPeersPanel.tsx': 'fetchAuthorityPeers',
	'AdministrationOfficersPanel.tsx': 'fetchAdministrationOfficers',
	'KeyholdersPanel.tsx': 'fetchKeyholders',
	'InviteAuthoritiesPanel.tsx': 'fetchAuthorityInvites',
};

test('each file contains exactly one fetcher call, and it is its own', () => {
	for (const file of FILES) {
		const fetcherName = FETCHER_NAMES[/** @type {keyof typeof FETCHER_NAMES} */ (file)];
		const importMatches = [...STRIPPED[file].matchAll(/from ['"]\.\/authority-admin-queries\.js['"]/g)];
		assert.equal(importMatches.length, 1, `${file} must import authority-admin-queries.js exactly once`);
		const callMatches = [...STRIPPED[file].matchAll(new RegExp(`\\b${fetcherName}\\(`, 'g'))];
		assert.equal(callMatches.length, 1, `${file} must call ${fetcherName} exactly once`);
		for (const otherName of Object.values(FETCHER_NAMES)) {
			if (otherName === fetcherName) continue;
			assert.doesNotMatch(STRIPPED[file], new RegExp(`\\b${otherName}\\(`), `${file} calls ${otherName}, which is not its own fetcher`);
		}
	}
});

// --- 6. Empty state wired to the frozen table ---------------------------------

test('each file contains t(capability.emptyKey) and no other t( call', () => {
	for (const file of FILES) {
		const tCalls = [...STRIPPED[file].matchAll(/\bt\(([^)]*)\)/g)].map((m) => m[1].trim());
		assert.ok(tCalls.length >= 1, `${file} must call t(...) at least once`);
		for (const arg of tCalls) {
			assert.equal(arg, 'capability.emptyKey', `${file} calls t(${arg}), which is not capability.emptyKey`);
		}
	}
});

// --- 7. Labels are schema identifiers (binding decision A) --------------------

test('every <dt> label in the six files is a schema column identifier parsed from votetorrent.qsql', () => {
	for (const file of FILES) {
		const labels = extractDtLabels(STRIPPED[file]);
		for (const label of labels) {
			assert.ok(SCHEMA_COLUMN_IDENTIFIERS.has(label), `${file} renders <dt>${label}</dt>, which is not a schema column identifier`);
		}
	}
});

test('positive control: the label extractor reports a literal invented label as not-a-column', () => {
	const fixture = `<dt>Relay servers</dt>`;
	const labels = extractDtLabels(fixture);
	assert.deepEqual(labels, ['Relay servers']);
	assert.ok(!SCHEMA_COLUMN_IDENTIFIERS.has('Relay servers'), 'a label check that cannot detect invented copy is not a label check');
});

// --- 8. CSS scoping ------------------------------------------------------------

test('every class selector in authority-admin.css starts with aa-, and the file has no hex colour literal', () => {
	const cssPath = path.join(PANELS_DIR, 'authority-admin.css');
	const css = readFileSync(cssPath, 'utf8');
	const stripped = stripComments(css);
	const classSelectors = [...stripped.matchAll(/\.([A-Za-z][\w-]*)/g)].map((m) => m[1]);
	assert.ok(classSelectors.length >= 5, 'expected at least 5 class selectors in authority-admin.css');
	for (const cls of classSelectors) {
		assert.ok(cls.startsWith('aa-'), `.${cls} does not start with aa-`);
	}
	assert.doesNotMatch(stripped, /#[0-9a-fA-F]{3,6}/, 'authority-admin.css contains a hex colour literal');
});

// --- Registry untouched, still nine, sibling panels untouched ------------------

test('registry.ts still declares exactly 9 *Panel.tsx files on disk', () => {
	const registrySource = readFileSync(path.join(PANELS_DIR, 'registry.ts'), 'utf8');
	const importMatches = [...registrySource.matchAll(/from\s+'\.\/(\w+Panel)'/g)].map((m) => m[1]);
	assert.equal(importMatches.length, 9);
});

// --- No role/group concept invented around Officer.Title -----------------------

test('AdministrationOfficersPanel.tsx invents no role/group concept around Title', () => {
	const source = STRIPPED['AdministrationOfficersPanel.tsx'];
	assert.doesNotMatch(source, /\brole\b|permission group|user group/i);
});

test('AdministrationOfficersPanel.tsx renders Scopes as chips', () => {
	assert.match(STRIPPED['AdministrationOfficersPanel.tsx'], /aa-scope/);
});

// --- Task 3: no key material in the two tier-2 panels --------------------------

const TIER2_FILES = ['KeyholdersPanel.tsx', 'InviteAuthoritiesPanel.tsx'];
const KEY_MATERIAL_RE = /UserKey|PubKey|PrivateKey|ReleaseKey|SignerKey|InviteKey|InviteSignature|Signature/i;

test('no key-material column in either tier-2 panel -- InviteKey/InviteSignature are real InviteSlot columns, excluded on purpose', () => {
	for (const file of TIER2_FILES) {
		assert.doesNotMatch(STRIPPED[file], KEY_MATERIAL_RE, `${file} references a key-material column`);
	}
});

test('positive control: the key-material matcher hits a synthetic InviteKey reference', () => {
	const fixture = `<dd>{row.InviteKey}</dd>`;
	assert.match(fixture, KEY_MATERIAL_RE, 'matcher is inert -- it must hit its own positive-control fixture');
});

// --- Task 3: no ceremony affordance ---------------------------------------------

// Assertion 6 (over all six files, including these two) already pins that the
// only `t(...)` call either file may make is `t(capability.emptyKey)` -- no
// second copy key can smuggle in a call-to-action sentence. This assertion
// covers the remaining surface: no literal JSX text node may read as an
// invite-shaped call-to-action ("Invite", "Send", "Create", "Add an
// authority", etc). Schema-column `<dt>` labels (binding decision A) are
// exempt by construction -- none of them contain these words.
const CEREMONY_CTA_RE = /\binvite\b|\bsend\b|\bcreate\b|\badd\b/i;

test('neither tier-2 file renders literal JSX text that reads as an invite-shaped call-to-action', () => {
	for (const file of TIER2_FILES) {
		const literalTextNodes = [...STRIPPED[file].matchAll(/<[a-zA-Z][\w-]*(?:\s[^>]*)?>([^<>{}]*)<\//g)]
			.map((m) => m[1].trim())
			.filter((s) => /[A-Za-z]{2,}/.test(s));
		for (const text of literalTextNodes) {
			assert.doesNotMatch(text, CEREMONY_CTA_RE, `${file} renders "${text}", which reads as a ceremony call-to-action`);
		}
	}
});

test('positive control: the ceremony call-to-action matcher hits a synthetic "Invite an authority" fixture', () => {
	assert.match('Invite an authority', CEREMONY_CTA_RE, 'matcher is inert -- it must hit its own positive-control fixture');
});

// --- Task 3: tier is not restated as prose --------------------------------------

test('neither tier-2 file names "tier", "engine-delegated" or "schema CHECK" outside comments -- the tier pill is the only place that fact is surfaced', () => {
	for (const file of TIER2_FILES) {
		assert.doesNotMatch(STRIPPED[file], /\btier\b|engine-delegated|schema CHECK/i, `${file} restates tier as prose`);
	}
});
