/**
 * election-ops-panels.test.mjs -- source-level assertions over the three
 * Election Operations panel bodies plus `LifecyclePill.tsx`: no mutating
 * affordance, no forbidden column, no dropped panel state, copy-keys-only.
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

const FILES = ['RegistrationsPanel.tsx', 'ElectionsPanel.tsx', 'BallotsQuestionsPanel.tsx', 'LifecyclePill.tsx'];

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
const ALLOWED_T_KEYS = new Set([
	'panels.registrations.empty',
	'panels.elections.empty',
	'panels.ballotsQuestions.empty',
	'lifecycle.organizing',
	'lifecycle.running',
	'lifecycle.released',
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

// --- Panel-owned queries: only src/screens/panels/ imports from src/reads/ -

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

test('no module outside src/screens/panels/ imports from src/reads/', () => {
	const srcDir = dashboardSrc();
	/** @type {string[]} */
	const offenders = [];
	for (const file of walkSourceFiles(srcDir)) {
		if (file.startsWith(PANELS_DIR)) continue;
		const contents = readFileSync(file, 'utf8');
		if (/from ['"].*reads\//.test(contents)) {
			offenders.push(path.relative(srcDir, file));
		}
	}
	assert.deepEqual(offenders, []);
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

test('RegistrationsPanel imports from ../../reads/registrations.js', () => {
	assert.match(STRIPPED['RegistrationsPanel.tsx'], /from ['"]\.\.\/\.\.\/reads\/registrations\.js['"]/);
});

test('ElectionsPanel imports from ../../reads/elections.js', () => {
	assert.match(STRIPPED['ElectionsPanel.tsx'], /from ['"]\.\.\/\.\.\/reads\/elections\.js['"]/);
});

test('BallotsQuestionsPanel imports from ../../reads/ballots.js and selectActiveElection from ../../reads/elections.js', () => {
	assert.match(STRIPPED['BallotsQuestionsPanel.tsx'], /from ['"]\.\.\/\.\.\/reads\/ballots\.js['"]/);
	assert.match(STRIPPED['BallotsQuestionsPanel.tsx'], /selectActiveElection[\s\S]*from ['"]\.\.\/\.\.\/reads\/elections\.js['"]/);
});

// --- LifecyclePill renders nothing for a null phase --------------------------

test('LifecyclePill.tsx returns null for a null phase', () => {
	assert.match(STRIPPED['LifecyclePill.tsx'], /if \(key === null\)/);
	assert.match(STRIPPED['LifecyclePill.tsx'], /return null/);
});
