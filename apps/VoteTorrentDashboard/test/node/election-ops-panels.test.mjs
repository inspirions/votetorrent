/**
 * election-ops-panels.test.mjs -- source-level assertions over the three
 * Election Operations panel bodies: no mutating affordance, no forbidden
 * column, no dropped panel state, copy-keys-only. `LifecyclePill.tsx`
 * itself moved to packages/ui-web in 53-05 (D-01/D-02) -- its own
 * null-phase-guard assertion moved with it into
 * packages/ui-web/test/shared-components.test.mjs; what remains here is
 * `ElectionsPanel.tsx mounts LifecyclePill`, whose subject is the
 * dashboard's OWN mount site, not the pill's internals.
 * `node --test` cannot import `.tsx`, so this file reads each source as
 * TEXT, in `test/node/registry.test.mjs`'s (50-06) shape.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { dashboardSrc } from '../../../../scripts/lib/source-paths.mjs';

import { COPY } from '@votetorrent/ui-web';

const PANELS_DIR = dashboardSrc('screens', 'panels');

const FILES = ['RegistrationsPanel.tsx', 'ElectionsPanel.tsx', 'BallotsQuestionsPanel.tsx'];

/** Strip `//` and `/* *\/`-style comment lines -- same shape as registry.test.mjs. @param {string} source @returns {string} */
function stripComments(source) {
	return source
		.split('\n')
		.filter((line) => {
			const trimmed = line.trim();
			return !(trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*'));
		})
		.join('\n');
}

/** @type {Record<string, string>} */
const RAW = {};
/** @type {Record<string, string>} */
const STRIPPED = {};
for (const file of FILES) {
	RAW[file] = readFileSync(path.join(PANELS_DIR, file), 'utf8');
	STRIPPED[file] = stripComments(RAW[file]);
}

// --- No control of any kind (rule R2) ---------------------------------------

const CONTROL_RE = /<button|<form|<input|<select|<textarea|onClick|onSubmit|onChange|href=/;

test('no <button>, <form>, <input>, <select>, <textarea>, onClick, onSubmit, onChange or href= in any of the four files', () => {
	for (const file of FILES) {
		assert.doesNotMatch(STRIPPED[file], CONTROL_RE, `${file} contains a control affordance`);
	}
});

test('positive control: the control matcher hits a synthetic disabled-button fixture', () => {
	const fixture = `<button className="act" disabled>Review requests</button>`;
	assert.match(fixture, CONTROL_RE, 'matcher is inert -- it must hit its own positive-control fixture');
});

// --- No mutation -------------------------------------------------------------

test('no insert into / delete from / update ... set in any of the four files', () => {
	for (const file of FILES) {
		assert.doesNotMatch(STRIPPED[file], /insert into|delete from|update .* set /i, `${file} contains a mutating statement`);
	}
});

// --- No injection surface (rule R5) -----------------------------------------

test('no dangerouslySetInnerHTML, innerHTML or eval( in any of the four files', () => {
	for (const file of FILES) {
		assert.doesNotMatch(STRIPPED[file], /dangerouslySetInnerHTML|innerHTML|eval\(/, `${file} contains an injection surface`);
	}
});

// --- No forbidden column (rule R3) ------------------------------------------

test('no PrivateDetails, SelectiveDetails, PayloadCid, ExtraFields or .Payload in any of the four files', () => {
	for (const file of FILES) {
		assert.doesNotMatch(
			STRIPPED[file],
			/PrivateDetails|SelectiveDetails|PayloadCid|ExtraFields|\.Payload/,
			`${file} references a forbidden column`,
		);
	}
});

// --- No unreachable panel state (comments included) -------------------------

test('no "read-only", "◐" or "writable" anywhere in the four files, comments included', () => {
	for (const file of FILES) {
		assert.doesNotMatch(RAW[file], /read-only|◐|writable/i, `${file} names the unreachable panel state`);
	}
});

// --- No authored prose (rule R1) --------------------------------------------

/**
 * Extract literal JSX text nodes -- an OPEN TAG immediately followed by
 * plain text (no nested tag, no `{...}` expression) immediately followed by
 * a CLOSING tag start (`</`) -- that contain at least one run of
 * two-or-more Latin letters, i.e. something that reads like a word, not
 * bare punctuation. Requiring the immediate `</` (a real JSX closing tag,
 * never present in a TypeScript `interface { ... }` block) is what keeps
 * this pattern from false-matching this file's own `Awaited<ReturnType<...>>`
 * generic-type syntax, which also contains bare `<`/`>` pairs but never a
 * `</`. A `{...}` expression child (a `t(...)` call or a database value) is
 * never captured, because `{` and `}` are excluded from the text class.
 *
 * @param {string} source
 * @returns {string[]}
 */
function extractWordBearingJsxText(source) {
	const matches = [...source.matchAll(/<[a-zA-Z][\w-]*(?:\s[^>]*)?>([^<>{}]*)<\//g)].map((m) => m[1].trim());
	return matches.filter((text) => /[A-Za-z]{2,}/.test(text));
}

test('no word-bearing literal JSX text node in any of the four files -- every rendered word is a t(...) result or a database value', () => {
	for (const file of FILES) {
		const offenders = extractWordBearingJsxText(STRIPPED[file]);
		assert.deepEqual(offenders, [], `${file} has literal JSX text: ${JSON.stringify(offenders)}`);
	}
});

test('positive control: the authored-prose extractor reports a literal sentence in a synthetic fixture', () => {
	const fixture = `<p>No registrants yet.</p>`;
	const offenders = extractWordBearingJsxText(fixture);
	assert.deepEqual(offenders, ['No registrants yet.']);
});

// --- No new copy key ----------------------------------------------------------

const COPY_KEYS = new Set(Object.keys(COPY));
// The five `lifecycle.*` keys, as they stand in packages/ui-web/src/copy.js
// after 54-02's rename (D-06/D-07) -- `organizing`/`running`/`released`
// became `pre`/`voting`/`settling`/`closed` plus the standing
// `indeterminate` sentinel, not the insertion of a fourth into an unchanged
// set. None of the four panel files below calls any `lifecycle.*` key
// literally today (`LifecyclePill` moved to `packages/ui-web` in 53-05, and
// it -- not a panel -- is what calls `t(phaseCopyKey(phase))`), so these
// entries are listed but currently unexercised by the loop below; the
// `COPY_KEYS.has(key)` half two lines down still catches an allow-listed key
// naming a phase that no longer exists, for the day a panel does call one.
const ALLOWED_T_KEYS = new Set([
	'panels.registrations.empty',
	'panels.elections.empty',
	'panels.ballotsQuestions.empty',
	'lifecycle.pre',
	'lifecycle.voting',
	'lifecycle.settling',
	'lifecycle.closed',
	'lifecycle.indeterminate',
]);

test('every literal t(...) argument across the four files is in the exact allow-list and exists in the frozen COPY table', () => {
	for (const file of FILES) {
		const literalCalls = [...STRIPPED[file].matchAll(/\bt\(\s*'([^']+)'/g)].map((m) => m[1]);
		for (const key of literalCalls) {
			assert.ok(ALLOWED_T_KEYS.has(key), `${file} calls t('${key}'), which is outside the allow-list`);
			assert.ok(COPY_KEYS.has(key), `${file} calls t('${key}'), which does not exist in COPY`);
		}
	}
});

test('positive control: an invented copy key call is detected as outside the allow-list', () => {
	const fixtureKeys = [...`t('panels.registrations.subtitle')`.matchAll(/\bt\(\s*'([^']+)'/g)].map((m) => m[1]);
	assert.deepEqual(fixtureKeys, ['panels.registrations.subtitle']);
	assert.ok(!ALLOWED_T_KEYS.has('panels.registrations.subtitle'));
});

// --- No decision ID or phase number -----------------------------------------

test('no D-NN decision id or "Phase N" reference in any of the four files, comments included', () => {
	for (const file of FILES) {
		assert.doesNotMatch(RAW[file], /\bD-[0-9]{2}\b|Phase [0-9]+/, `${file} names a decision id or phase number`);
	}
});

// --- Registry untouched, still nine ------------------------------------------

test('registry.ts still declares exactly 9 *Panel.tsx files on disk, and neither new file matches that glob', () => {
	const registrySource = readFileSync(path.join(PANELS_DIR, 'registry.ts'), 'utf8');
	const importMatches = [...registrySource.matchAll(/from\s+'\.\/(\w+Panel)'/g)].map((m) => m[1]);
	assert.equal(importMatches.length, 9);
	for (const name of importMatches) {
		assert.ok(existsSync(path.join(PANELS_DIR, `${name}.tsx`)), `${name}.tsx missing`);
	}
	assert.ok(!importMatches.includes('LifecyclePill'));
});

// --- No panel imports PanelFrame or a snapshot-instant context --------------

const FRAME_OR_CONTEXT_RE = /PanelFrame|SnapshotInstantContext/;

test('none of the four files imports PanelFrame or a SnapshotInstantContext', () => {
	for (const file of FILES) {
		assert.doesNotMatch(STRIPPED[file], FRAME_OR_CONTEXT_RE, `${file} imports PanelFrame or a snapshot-instant context`);
	}
});

test('positive control: the PanelFrame-detection matcher hits a synthetic self-wrapping import', () => {
	const fixture = `import PanelFrame from './PanelFrame.tsx';`;
	assert.match(fixture, FRAME_OR_CONTEXT_RE);
});

test('no SnapshotInstantContext.ts file exists under src/screens/panels/ -- this plan creates no React context', () => {
	assert.ok(!existsSync(path.join(PANELS_DIR, 'SnapshotInstantContext.ts')));
});

// --- ElectionsPanel reads the instant from its own props, never a hook -----

test('ElectionsPanel.tsx references snapshotInstant and contains no useContext/useSnapshotInstant/phase selector', () => {
	const source = STRIPPED['ElectionsPanel.tsx'];
	assert.match(source, /snapshotInstant/);
	assert.doesNotMatch(source, /useContext|useSnapshotInstant/);
	assert.doesNotMatch(source, /setPhase|PHASES\b|data-phase/);
});

test('ElectionsPanel.tsx mounts LifecyclePill', () => {
	assert.match(STRIPPED['ElectionsPanel.tsx'], /LifecyclePill/);
});

// --- Panel-owned queries: only src/screens/panels/ imports the officer -----
// --- READ SURFACE from @votetorrent/web-data/officer (54-03b) --------------
//
// NOTE on scope, discovered while rewriting this walk: 54-03a already moved
// the audience-neutral CONNECTION layer (createNetworkDb, attachNetworkDb,
// etc.) into this same `./officer` barrel, and several non-panel production
// modules (src/lifecycle/*, src/main.tsx, src/screens/DashboardShell.tsx)
// legitimately import THAT from `@votetorrent/web-data/officer` -- that is
// correct, already-shipped 54-03a work, not a violation. A specifier-only
// match (the literal old `.../reads/` shape ported 1:1) would false-positive
// on all of them. The guarantee this walk actually encodes -- "panel-owned
// queries: only a panel reaches the read layer" -- is preserved by checking
// which NAMES a file imports from the barrel, not merely whether it imports
// the barrel at all.

const OFFICER_IMPORT_RE = /from ['"]@votetorrent\/web-data\/officer['"]/;

/** Every name the officer barrel re-exports from the three moved read modules -- the query surface this walk polices. Deliberately excludes the connection-layer names (createNetworkDb, attachNetworkDb, ...) and CAPABILITY_TABLES, which are audience-neutral / metadata, not a query. @type {ReadonlySet<string>} */
const OFFICER_READ_SURFACE_NAMES = new Set([
	'selectActiveElection',
	'readElectionOverview',
	'readElectionPolicies',
	'countElections',
	'ELECTIONS_TABLES_READ',
	'readBallots',
	'readQuestions',
	'countBallotSigningTasks',
	'BALLOTS_TABLES_READ',
	'readRegistrantStatusBreakdown',
	'readRegistrationRequestBreakdown',
	'readRegistrantRoster',
	'readRegistrationSurfaceCounts',
	'hasAnyRegistrationData',
	'ROSTER_PAGE_SIZE',
	'REGISTRATIONS_TABLES_READ',
]);

/**
 * The named imports pulled from every `@votetorrent/web-data/officer` import
 * statement in `source` -- resolves `Foo as Bar` to the real exported name
 * `Foo`, since that is the name that decides whether the read surface was
 * reached, not the local alias.
 *
 * @param {string} source
 * @returns {string[]}
 */
function officerNamedImports(source) {
	/** @type {string[]} */
	const names = [];
	for (const m of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]@votetorrent\/web-data\/officer['"]/g)) {
		for (const raw of m[1].split(',')) {
			const trimmed = raw.trim();
			if (!trimmed) continue;
			names.push(trimmed.split(/\s+as\s+/)[0].trim());
		}
	}
	return names;
}

/** @param {string} dir @returns {string[]} */
function walkSourceFiles(dir) {
	/** @type {string[]} */
	const out = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			out.push(...walkSourceFiles(full));
		} else if (/\.(js|ts|tsx)$/.test(entry.name)) {
			out.push(full);
		}
	}
	return out;
}

test('no module outside src/screens/panels/ imports an officer read-surface name (a query function or a TABLES_READ constant) from @votetorrent/web-data/officer', () => {
	const srcDir = dashboardSrc();
	/** @type {string[]} */
	const offenders = [];
	for (const file of walkSourceFiles(srcDir)) {
		if (file.startsWith(PANELS_DIR)) continue;
		const contents = stripComments(readFileSync(file, 'utf8'));
		const imported = officerNamedImports(contents);
		if (imported.some((name) => OFFICER_READ_SURFACE_NAMES.has(name))) {
			offenders.push(path.relative(srcDir, file));
		}
	}
	assert.deepEqual(offenders, []);
});

test('positive control: the read-surface-name matcher fires on a synthetic import of selectActiveElection, so a walk that finds nothing is proven discriminating', () => {
	const fixture = `import { selectActiveElection } from '@votetorrent/web-data/officer';`;
	assert.ok(officerNamedImports(fixture).includes('selectActiveElection'));
});

test('negative control: a synthetic import of ONLY connection-layer names (already legitimate outside panels since 54-03a) does not trip the read-surface matcher', () => {
	const fixture = `import { createNetworkDb, attachNetworkDb, CAPABILITY_TABLES } from '@votetorrent/web-data/officer';`;
	const imported = officerNamedImports(fixture);
	assert.ok(imported.length > 0, 'the parser itself must find names, or this control proves nothing');
	assert.ok(imported.every((name) => !OFFICER_READ_SURFACE_NAMES.has(name)));
});

// --- Styling stays on tokens --------------------------------------------------

test('election-ops.css has zero hex colour literals and declares no .panel/.panel-body/.panel--denied rule', () => {
	const cssPath = path.join(PANELS_DIR, 'election-ops.css');
	const css = readFileSync(cssPath, 'utf8');
	const stripped = css
		.split('\n')
		.filter((line) => {
			const trimmed = line.trim();
			return !(trimmed.startsWith('/*') || trimmed.startsWith('*') || trimmed.startsWith('//'));
		})
		.join('\n');
	assert.doesNotMatch(stripped, /#[0-9a-fA-F]{3,6}/);
	assert.doesNotMatch(stripped, /^\.panel\s*\{/m);
	assert.doesNotMatch(stripped, /^\.panel-body\s*\{/m);
	assert.doesNotMatch(stripped, /^\.panel--denied\s*\{/m);
});

test('election-ops.css has no raw px value outside a var(--space-*) reference', () => {
	const cssPath = path.join(PANELS_DIR, 'election-ops.css');
	const css = readFileSync(cssPath, 'utf8');
	const stripped = css
		.split('\n')
		.filter((line) => {
			const trimmed = line.trim();
			return !(trimmed.startsWith('/*') || trimmed.startsWith('*') || trimmed.startsWith('//'));
		})
		.join('\n');
	// Every numeric px literal must be EITHER a `1px` border-width literal
	// (the same structural constant panels.css's own `.panel`/`.pill`
	// already hardcode -- a border width is not a spacing-scale value) OR
	// inside a minmax(...) grid-template track function (panels.css's own
	// 340px card minimum sets this precedent too). Anything else must
	// reference var(--space-*).
	const pxMatches = [...stripped.matchAll(/(-?\d+(?:\.\d+)?)px/g)];
	for (const m of pxMatches) {
		const value = m[1];
		const context = stripped.slice(Math.max(0, m.index - 20), m.index + 10);
		const isBorderWidth = value === '1';
		const isMinmaxTrack = /minmax\(/.test(context);
		assert.ok(isBorderWidth || isMinmaxTrack, `unexpected raw px outside a border-width or minmax(): ${context}`);
	}
});

// --- Each panel imports its own read module ----------------------------------

test('RegistrationsPanel imports its five registration reads, and selectActiveElection, from @votetorrent/web-data/officer', () => {
	assert.match(STRIPPED['RegistrationsPanel.tsx'], OFFICER_IMPORT_RE);
	// Naming the functions, not just the specifier: the collapse from two
	// relative specifiers to one bare one must not cost this test its ability
	// to say WHICH read surface the panel pulls.
	for (const name of [
		'readRegistrantStatusBreakdown',
		'readRegistrationRequestBreakdown',
		'readRegistrantRoster',
		'readRegistrationSurfaceCounts',
		'hasAnyRegistrationData',
		'selectActiveElection',
	]) {
		assert.ok(
			officerNamedImports(STRIPPED['RegistrationsPanel.tsx']).includes(name),
			`RegistrationsPanel.tsx no longer imports ${name} from @votetorrent/web-data/officer`,
		);
	}
});

test('ElectionsPanel imports its four election reads from @votetorrent/web-data/officer', () => {
	assert.match(STRIPPED['ElectionsPanel.tsx'], OFFICER_IMPORT_RE);
	for (const name of ['selectActiveElection', 'readElectionOverview', 'readElectionPolicies', 'countElections']) {
		assert.ok(
			officerNamedImports(STRIPPED['ElectionsPanel.tsx']).includes(name),
			`ElectionsPanel.tsx no longer imports ${name} from @votetorrent/web-data/officer`,
		);
	}
});

test('BallotsQuestionsPanel imports readBallots and readQuestions, and selectActiveElection, from @votetorrent/web-data/officer', () => {
	assert.match(STRIPPED['BallotsQuestionsPanel.tsx'], /readBallots[\s\S]*readQuestions[\s\S]*from ['"]@votetorrent\/web-data\/officer['"]/);
	assert.match(STRIPPED['BallotsQuestionsPanel.tsx'], /selectActiveElection[\s\S]*from ['"]@votetorrent\/web-data\/officer['"]/);
});

// LifecyclePill's own null-phase-guard assertion moved to
// packages/ui-web/test/shared-components.test.mjs in 53-05, alongside the
// component itself.
