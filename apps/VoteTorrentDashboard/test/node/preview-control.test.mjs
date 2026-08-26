/**
 * preview-control.test.mjs — source-level assertions over the "Preview as"
 * control, its provider, the advisory disclosure, `GrantedScopesContext.ts`,
 * `preview-as.css`, and the bounded wiring into 50-09's `DashboardShell.tsx`
 * / `PanelGrid.tsx`. `node --test` cannot import `.tsx`, so this suite reads
 * each file as TEXT and strips `//` / `/* *\/`-style comment lines where a
 * behavior item says "comment-stripped" — the same shape
 * `test/node/registry.test.mjs` (50-06) and
 * `authority-admin-panels.test.mjs` (50-11) both already established.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(__dirname, '..', '..');
const SCREENS_DIR = path.join(APP_ROOT, 'src', 'screens');

/** Same shape as gate.test.mjs's own helper.
 * @param {string} source @returns {string} */
function stripComments(source) {
	return source
		.split('\n')
		.filter((line) => {
			const trimmed = line.trim();
			return !(trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*'));
		})
		.join('\n');
}

/** @param {string} dir @returns {string[]} */
function walkFiles(dir) {
	/** @type {string[]} */
	const out = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name === 'node_modules' || entry.name === 'dist') continue;
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			out.push(...walkFiles(full));
		} else {
			out.push(full);
		}
	}
	return out;
}

/** The six files this suite reads — the four this plan creates, plus the two 50-09 files this plan's bounded edit touches. @type {Record<string, string>} */
const FILES = {
	context: 'GrantedScopesContext.ts',
	control: 'PreviewAsControl.tsx',
	disclosure: 'AdvisoryDisclosure.tsx',
	css: 'preview-as.css',
	shell: 'DashboardShell.tsx',
	grid: 'PanelGrid.tsx',
};

/** @type {Record<string, string>} */
const RAW = {};
/** @type {Record<string, string>} */
const STRIPPED = {};
for (const [key, file] of Object.entries(FILES)) {
	RAW[key] = readFileSync(path.join(SCREENS_DIR, file), 'utf8');
	STRIPPED[key] = stripComments(RAW[key]);
}

// --- GrantedScopesContext.ts -------------------------------------------------

test('GrantedScopesContext.ts creates a context with an empty-array default and exports both hooks', () => {
	assert.match(STRIPPED.context, /createContext/);
	assert.match(STRIPPED.context, /effective:\s*Object\.freeze\(\[\]\)/);
	assert.match(STRIPPED.context, /export function useEffectiveScopes/);
	assert.match(STRIPPED.context, /export function usePreview/);
});

test('positive control: the default-effective matcher hits a synthetic fixture', () => {
	const fixture = 'effective: Object.freeze([])';
	assert.match(fixture, /effective:\s*Object\.freeze\(\[\]\)/, 'matcher is inert');
});

// --- PreviewAsControl.tsx -----------------------------------------------------

test('PreviewAsControl renders a fieldset legended "preview.title" and drives its rows from CAPABILITIES.map', () => {
	assert.match(STRIPPED.control, /<fieldset/);
	assert.match(STRIPPED.control, /t\('preview\.title'\)/);
	assert.match(STRIPPED.control, /CAPABILITIES\.map/);
});

test('each row carries type="checkbox", a capability.titleKey label, and a pv-scope chip with the schemaName tooltip', () => {
	assert.match(RAW.control, /type="checkbox"/);
	assert.match(STRIPPED.control, /t\(capability\.titleKey\)/);
	assert.match(STRIPPED.control, /className="pv-scope"/);
	assert.match(STRIPPED.control, /title=\{capability\.schemaName\}/);
});

test('both badge copy keys are present in source, backing the rendered t() call', () => {
	assert.ok((RAW.control.match(/gate\.badgeSimulated/g) ?? []).length >= 1, 'gate.badgeSimulated not found');
	assert.ok((RAW.control.match(/gate\.badgeReal/g) ?? []).length >= 1, 'gate.badgeReal not found');
});

test('the reset button renders t(\'gate.resetScopesCta\')', () => {
	assert.match(STRIPPED.control, /t\('gate\.resetScopesCta'\)/);
});

test('PreviewAsControl.tsx contains no literal binding copy string -- every string arrives through t()', () => {
	const BANNED = /answered by the database|simulated scope set|Preview as|Reset to my scopes/;
	assert.doesNotMatch(STRIPPED.control, BANNED);
});

test('positive control: the literal-copy matcher hits a synthetic hardcoded fixture', () => {
	assert.match('const x = "simulated scope set";', /answered by the database|simulated scope set|Preview as|Reset to my scopes/, 'matcher is inert');
});

test('PreviewAsControl.tsx imports nothing from ../auth/gate.js -- it decides no visibility', () => {
	assert.equal((STRIPPED.control.match(/from ['"]\.\.\/auth\/gate\.js['"]/g) ?? []).length, 0);
});

test('PreviewAsControl.tsx imports toggleScope, resetToReal, resyncRealScopes and badgeKey from ../auth/preview-scopes.js', () => {
	assert.match(STRIPPED.control, /from ['"]\.\.\/auth\/preview-scopes\.js['"]/);
	assert.match(STRIPPED.control, /\btoggleScope\b/);
	assert.match(STRIPPED.control, /\bresetToReal\b/);
	assert.match(STRIPPED.control, /\bresyncRealScopes\b/);
	assert.match(STRIPPED.control, /\bbadgeKey\b/);
});

// --- AdvisoryDisclosure.tsx ----------------------------------------------------

test('AdvisoryDisclosure.tsx renders gate.advisoryDisclosure exactly once with no branch around it', () => {
	assert.equal((STRIPPED.disclosure.match(/gate\.advisoryDisclosure/g) ?? []).length, 1);
	assert.doesNotMatch(STRIPPED.disclosure, /\?|&&|isSimulated|simulated/);
});

test('positive control: the branch-around-disclosure matcher hits a synthetic {simulated && ...} fixture', () => {
	const fixture = "{simulated && <p>{t('gate.advisoryDisclosure')}</p>}";
	assert.match(fixture, /\?|&&|isSimulated|simulated/, 'matcher is inert');
});

// --- Wiring: the bounded shell edit --------------------------------------------

test('PanelGrid.tsx calls useEffectiveScopes() and still imports evaluate from ../auth/gate.js exactly once', () => {
	assert.match(STRIPPED.grid, /useEffectiveScopes/);
	assert.equal((STRIPPED.grid.match(/from ['"]\.\.\/auth\/gate\.js['"]/g) ?? []).length, 1);
});

test('PreviewAsProvider re-seeds from realScopes in an effect via resyncRealScopes, not only in the useState initializer', () => {
	// The defect this pins: `useState(() => createPreviewState(realScopes))`
	// alone runs on the FIRST render only, and `DashboardShell` supplies `[]`
	// there because the officer's scopes are read asynchronously. Without a
	// re-seed the provider froze an empty set and every capability evaluated
	// as denied. The re-seed DECISION (including the sticky `touched` guard
	// so a late arrival cannot discard an in-progress preview) lives in the
	// pure, tier-1-tested `resyncRealScopes` (../auth/preview-scopes.js) --
	// this effect must delegate to it, not re-implement the decision inline.
	assert.match(STRIPPED.control, /useEffect\(/, 'PreviewAsProvider has no effect at all');
	assert.match(STRIPPED.control, /resyncRealScopes\(prev,\s*realScopes\)/);
	assert.match(STRIPPED.control, /\}, \[realKey\]\);/);
});

test('positive control: the re-seed matcher does NOT hit an initializer-only fixture', () => {
	const fixture = 'const [state, setState] = useState(() => createPreviewState(realScopes));';
	assert.doesNotMatch(fixture, /resyncRealScopes\(prev,\s*realScopes\)/, 'matcher is inert');
});

test('PanelGrid.tsx takes no grantedScopes prop -- the context hook is its only scope source', () => {
	// A dead prop that duplicated the context value is what made the frozen
	// empty-scope defect above hard to see from `DashboardShell`'s call site.
	assert.doesNotMatch(STRIPPED.grid, /grantedScopes/);
	assert.doesNotMatch(STRIPPED.shell, /grantedScopes=\{/);
});

test('positive control: the dead-prop matcher hits a synthetic <PanelGrid grantedScopes={x} /> fixture', () => {
	assert.match('<PanelGrid grantedScopes={scopes} />', /grantedScopes=\{/, 'matcher is inert');
});

test('DashboardShell.tsx renders PreviewAsProvider, PreviewAsControl and AdvisoryDisclosure', () => {
	assert.match(STRIPPED.shell, /<PreviewAsProvider/);
	assert.match(STRIPPED.shell, /<PreviewAsControl/);
	assert.match(STRIPPED.shell, /<AdvisoryDisclosure/);
});

// --- Elevation-of-privilege confinement (T-50-12-01) ---------------------------

const CONFINEMENT_RE = /preview|simulat|effectiveScopes|GrantedScopesContext/i;

test('no file under src/db, src/transport or src/lifecycle mentions preview, simulat, effectiveScopes or GrantedScopesContext, comment-stripped', () => {
	// Comment-stripped, per this behavior group's own header -- 50-10's
	// election-phase.js documents (in prose) why it does NOT add a phase
	// picker, using the word "simulation"; that is a design note, not a
	// leak of this plan's previewed value into a lifecycle module.
	const DIRS = ['src/db', 'src/transport', 'src/lifecycle'];
	/** @type {string[]} */
	const offenders = [];
	for (const rel of DIRS) {
		const abs = path.join(APP_ROOT, rel);
		for (const file of walkFiles(abs)) {
			if (CONFINEMENT_RE.test(stripComments(readFileSync(file, 'utf8')))) {
				offenders.push(path.relative(APP_ROOT, file));
			}
		}
	}
	assert.deepEqual(offenders, [], `the previewed value leaked into: ${offenders.join(', ')}`);
});

test('positive control: the confinement matcher hits a synthetic "const s = effectiveScopes(state)" fixture', () => {
	assert.match('const s = effectiveScopes(state)', CONFINEMENT_RE, 'matcher is inert');
});

// --- Storage hygiene and unreachable-state hygiene -----------------------------

test('the four new src/screens/ files contain no localStorage, sessionStorage, indexedDB or writeRowCounts reference', () => {
	const RE = /localStorage|sessionStorage|indexedDB|writeRowCounts/;
	for (const key of ['context', 'control', 'disclosure', 'css']) {
		assert.doesNotMatch(STRIPPED[key], RE, `${FILES[key]} references storage`);
	}
});

test('none of the four new files or the two edited shell files names read-only, ◐ or writable -- comments included', () => {
	const RE = /read-only|◐|writable/i;
	for (const key of Object.keys(FILES)) {
		assert.doesNotMatch(RAW[key], RE, `${FILES[key]} names the unreachable panel state`);
	}
});

// --- preview-as.css -------------------------------------------------------------

test('every class selector in preview-as.css starts with pv-, has no hex literal, and --ok/--warn each appear exactly once', () => {
	const classSelectors = [...STRIPPED.css.matchAll(/\.([A-Za-z][\w-]*)/g)].map((m) => m[1]);
	assert.ok(classSelectors.length >= 5, 'expected at least 5 class selectors in preview-as.css');
	for (const cls of classSelectors) {
		assert.ok(cls.startsWith('pv-'), `.${cls} does not start with pv-`);
	}
	assert.doesNotMatch(STRIPPED.css, /#[0-9a-fA-F]{3,6}/, 'preview-as.css contains a hex colour literal');
	assert.equal((RAW.css.match(/--ok\b/g) ?? []).length, 1);
	assert.equal((RAW.css.match(/--warn\b/g) ?? []).length, 1);
});
