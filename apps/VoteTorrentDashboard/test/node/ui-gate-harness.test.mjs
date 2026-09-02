/**
 * ui-gate-harness.test.mjs — tier-1 source proof for the D-19/D-24 styled
 * harness: `test/browser/ui-gate.tsx`, `test/browser/vite.gate.config.ts`
 * and the app's own `gate:ui` script/`app.css`/`index.html` wiring, keeping
 * each honest without spending a browser run.
 *
 * This file merely READS the source tree (D-25), so it stays with the
 * dashboard and is repointed through the 53-01 resolver rather than
 * re-deriving its own root.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dashboardRoot, dashboardSrc, uiWebSrc } from '../../../../scripts/lib/source-paths.mjs';

const UI_GATE_TSX = readFileSync(dashboardRoot('test', 'browser', 'ui-gate.tsx'), 'utf8');
const VITE_GATE_CONFIG = readFileSync(dashboardRoot('test', 'browser', 'vite.gate.config.ts'), 'utf8');
const PACKAGE_JSON = JSON.parse(readFileSync(dashboardRoot('package.json'), 'utf8'));
const APP_CSS = readFileSync(dashboardSrc('app.css'), 'utf8');
const INDEX_HTML = readFileSync(dashboardRoot('index.html'), 'utf8');
const COMPONENTS_JS = readFileSync(uiWebSrc('components.js'), 'utf8');

/**
 * Line-based comment stripper, same shape as `app-css-split.test.mjs`'s and
 * `election-ops-panels.test.mjs`'s own `stripComments` idiom — a match must
 * not be satisfiable by prose in a header comment.
 * @param {string} source
 * @returns {string}
 */
function stripComments(source) {
	return source
		.split('\n')
		.filter((line) => {
			const trimmed = line.trim();
			return !(trimmed.startsWith('/*') || trimmed.startsWith('*') || trimmed.startsWith('//'));
		})
		.join('\n');
}

const UI_GATE_TSX_STRIPPED = stripComments(UI_GATE_TSX);
const VITE_GATE_CONFIG_STRIPPED = stripComments(VITE_GATE_CONFIG);

// --- (1) exactly one stylesheet import, and it is ../../src/app.css -----------------

test('(1) ui-gate.tsx contains exactly one stylesheet import, and it is ../../src/app.css', () => {
	const importLines = [...UI_GATE_TSX_STRIPPED.matchAll(/^import\s+['"]([^'"]+\.css)['"];?$/gm)];
	assert.equal(importLines.length, 1, `expected exactly one bare stylesheet import, found ${importLines.length}`);
	assert.equal(importLines[0][1], '../../src/app.css');
});

// --- (2) zero occurrences of tokens.css, with a positive control --------------------

test('(2) ui-gate.tsx contains zero occurrences of tokens.css (comment-stripped)', () => {
	assert.equal((UI_GATE_TSX_STRIPPED.match(/tokens\.css/g) ?? []).length, 0);
});

test('(2 control) the tokens.css matcher DOES fire on a planted @votetorrent/ui-web/tokens.css import', () => {
	const fixture = "import '@votetorrent/ui-web/tokens.css';\n";
	assert.ok((fixture.match(/tokens\.css/g) ?? []).length > 0, 'matcher must be able to detect the real regression shape');
});

// --- (3) vite.gate.config.ts imports ../../vite.config and declares no dedupe ------

test('(3) vite.gate.config.ts imports ../../vite.config, and contains zero occurrences of dedupe (comment-stripped)', () => {
	assert.match(VITE_GATE_CONFIG_STRIPPED, /from ['"]\.\.\/\.\.\/vite\.config['"]/);
	assert.equal((VITE_GATE_CONFIG_STRIPPED.match(/dedupe/g) ?? []).length, 0);
});

test('(3 control) the dedupe matcher DOES fire on a planted resolve.dedupe — keeps 53-11\'s inversion control non-inert', () => {
	const fixture = "resolve: { dedupe: ['react', 'react-dom'] },\n";
	assert.ok((fixture.match(/dedupe/g) ?? []).length > 0, 'matcher must be able to detect a re-declared dedupe');
});

// --- (4) outDir names test/browser/dist, input names ui-gate.html ------------------

test('(4) vite.gate.config.ts\'s build.outDir names test/browser/dist and its build.rollupOptions.input names ui-gate.html', () => {
	assert.match(VITE_GATE_CONFIG_STRIPPED, /outDir:\s*fileURLToPath\(new URL\('\.\/dist'/);
	assert.match(VITE_GATE_CONFIG_STRIPPED, /input:\s*fileURLToPath\(new URL\('\.\/ui-gate\.html'/);
});

// --- (5) package.json scripts contain an entry invoking run-ui-gates.mjs -----------

test('(5) package.json scripts contain an entry invoking run-ui-gates.mjs', () => {
	const scriptValues = Object.values(PACKAGE_JSON.scripts ?? {});
	assert.ok(
		scriptValues.some((v) => typeof v === 'string' && v.includes('run-ui-gates.mjs')),
		'expected at least one script invoking run-ui-gates.mjs (the entry D-21/53-12 will require of every consumer)',
	);
});

// --- (6) the canonical token form, asserted rather than assumed --------------------

test('(6) app.css contains the @votetorrent/ui-web/tokens.css @import, and index.html contains no tokens.css reference', () => {
	assert.match(stripComments(APP_CSS), /@import\s+['"]@votetorrent\/ui-web\/tokens\.css['"];/);
	assert.equal((INDEX_HTML.match(/tokens\.css/g) ?? []).length, 0);
});

// --- (7) every named export of components.js appears in ui-gate.tsx ---------------

test('(7) every named export of packages/ui-web/src/components.js appears in ui-gate.tsx — a cheap tier-1 echo of the runner\'s shared-components-mounted rung', () => {
	const exportNames = [...COMPONENTS_JS.matchAll(/^export \{ (\w+) \} from '\.\/components\/\1\.js';$/gm)].map((m) => m[1]);
	assert.ok(exportNames.length > 0, 'components.js must declare at least one export for this echo to mean anything');
	for (const name of exportNames) {
		assert.ok(
			new RegExp(`\\b${name}\\b`).test(UI_GATE_TSX),
			`ui-gate.tsx does not reference "${name}" — the D-19 shared-components-mounted rung would fail against this build`,
		);
	}
});
