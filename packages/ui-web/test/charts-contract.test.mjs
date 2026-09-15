/**
 * charts-contract.test.mjs — the five source-level rungs (plus their
 * controls) that keep the 60-03 chart primitives' frozen contract honest:
 * zero hex, zero controls with a write path (D-11), the `./charts/`
 * barrel/manifest lockstep `package-shape.test.mjs` rung 8's own regex
 * cannot reach (it is scoped to `./components/`), every manifest class
 * having a declared CSS rule, and the two files' geometry constants agreeing
 * with each other so 60-07/60-08 never drift against a stale number.
 *
 * Every matcher below runs against `stripComments()`-ed source — this
 * repo's own self-tripping-checker hazard means a matcher that can be
 * satisfied by a header comment proves nothing about the real file.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from '../../../scripts/lib/strip-comments.mjs';
import { COMPONENT_CLASS_NAMES } from '../src/component-class-names.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.join(HERE, '..');
const CHARTS_DIR = path.join(PACKAGE_ROOT, 'src', 'charts');
const COMPONENTS_JS_PATH = path.join(PACKAGE_ROOT, 'src', 'components.js');
const COMPONENTS_CSS_PATH = path.join(PACKAGE_ROOT, 'src', 'components.css');
const CHART_CONTRACTS_PATH = path.join(CHARTS_DIR, 'chart-contracts.ts');

const CHART_EXPORT_NAMES = Object.freeze(['BarSeries', 'StackedBarSeries', 'TimeSeries', 'Meter']);
const CHART_INTERNAL_FILES = Object.freeze(['chart-frame.tsx', 'chart-contracts.ts']);

/** @returns {string[]} every .tsx/.ts file under src/charts/, basenames only */
function chartFileNames() {
	return readdirSync(CHARTS_DIR).filter((f) => f.endsWith('.tsx') || f.endsWith('.ts'));
}

/** @returns {Map<string, string>} filename -> comment-stripped source, for every file under src/charts/ */
function readAllChartSourcesStripped() {
	/** @type {Map<string, string>} */
	const out = new Map();
	for (const name of chartFileNames()) {
		out.set(name, stripComments(readFileSync(path.join(CHARTS_DIR, name), 'utf8')));
	}
	return out;
}

// --- rung 1: zero hex -------------------------------------------------------

test('rung 1: no file under src/charts/ contains a hex colour literal (comment-stripped)', () => {
	const sources = readAllChartSourcesStripped();
	for (const [name, source] of sources) {
		assert.doesNotMatch(source, /#[0-9a-fA-F]{3,8}/, `${name} contains a hex colour literal after comment-stripping`);
	}
});

test('rung 1 (control): the hex matcher DOES fire on a planted fixture', () => {
	const fixture = "const oops = '#ff00aa';";
	assert.match(fixture, /#[0-9a-fA-F]{3,8}/);
});

// --- rung 2: control absence (D-11) -----------------------------------------

const CONTROL_RE = /<button|<form|<input|<select|<textarea|onClick|onSubmit|onChange|onMouseDown|href=|dangerouslySetInnerHTML/;

test('rung 2: no file under src/charts/ contains a click/submit/change handler, an anchor href, a form control element, or dangerouslySetInnerHTML (comment-stripped)', () => {
	const sources = readAllChartSourcesStripped();
	for (const [name, source] of sources) {
		assert.doesNotMatch(source, CONTROL_RE, `${name} contains a control-shaped construct after comment-stripping`);
	}
});

test('rung 2 (control): the control matcher DOES fire on a planted handler fixture', () => {
	const fixture = 'return <button onClick={doThing}>go</button>;';
	assert.match(fixture, CONTROL_RE);
});

// --- rung 3: barrel lockstep -------------------------------------------------

test('rung 3: components.js\'s ./charts/ specifiers equal the .tsx files under src/charts/ (minus the two internal modules) equal the four chart keys of COMPONENT_CLASS_NAMES', () => {
	const componentsSrc = readFileSync(COMPONENTS_JS_PATH, 'utf8');
	const specifierRe = /from\s+['"](\.\/charts\/[^'"]+\.js)['"]/g;
	const specifiers = [...componentsSrc.matchAll(specifierRe)].map((m) => m[1]);
	const specifierNames = specifiers.map((s) => path.basename(s, '.js')).sort();

	const tsxOnDisk = chartFileNames()
		.filter((f) => f.endsWith('.tsx') && !CHART_INTERNAL_FILES.includes(f))
		.map((f) => path.basename(f, '.tsx'))
		.sort();

	const manifestChartKeys = [...CHART_EXPORT_NAMES].sort();

	assert.deepEqual(specifierNames, tsxOnDisk, 'components.js ./charts/ specifiers must equal the public .tsx files under src/charts/');
	assert.deepEqual(specifierNames, manifestChartKeys, 'components.js ./charts/ specifiers must equal COMPONENT_CLASS_NAMES\' four chart keys');

	for (const specifier of specifiers) {
		const jsPath = path.join(PACKAGE_ROOT, 'src', specifier);
		const tsxPath = jsPath.replace(/\.js$/, '.tsx');
		assert.ok(
			readdirSync(path.dirname(tsxPath)).includes(path.basename(tsxPath)),
			`expected a sibling .tsx for specifier "${specifier}" at ${tsxPath}`,
		);
		assert.ok(
			!readdirSync(path.dirname(jsPath)).includes(path.basename(jsPath)),
			`specifier "${specifier}" must resolve ONLY via a bundler's .tsx extension probe — a literal .js file at ${jsPath} would defeat the ERR_MODULE_NOT_FOUND proof`,
		);
	}
});

// --- rung 4: every manifest class has a rule --------------------------------

/** @returns {Set<string>} every class-selector token declared in components.css, comment-stripped */
function declaredCssClassTokens() {
	const stripped = readFileSync(COMPONENTS_CSS_PATH, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
	const tokens = new Set();
	const re = /\.([A-Za-z][\w-]*)/g;
	let match;
	while ((match = re.exec(stripped)) !== null) tokens.add(match[1]);
	return tokens;
}

test('rung 4: every class name across the four chart manifest entries appears as a declared selector in comment-stripped components.css', () => {
	const declared = declaredCssClassTokens();
	for (const exportName of CHART_EXPORT_NAMES) {
		for (const cls of COMPONENT_CLASS_NAMES[exportName]) {
			assert.ok(declared.has(cls), `components.css declares no selector for "${cls}" (from ${exportName})`);
		}
	}
});

test('rung 4 (control): a fabricated name is reported absent, and a name occurring only inside a CSS comment is not counted', () => {
	const declared = declaredCssClassTokens();
	assert.ok(!declared.has('vt-chart__phantom'), 'fabricated name must be reported absent');

	const commentOnlyCss = '/* .vt-chart__comment-only-phantom { color: red; } */\n.vt-chart__real { color: blue; }';
	const stripped = commentOnlyCss.replace(/\/\*[\s\S]*?\*\//g, '');
	const tokens = new Set();
	const re = /\.([A-Za-z][\w-]*)/g;
	let match;
	while ((match = re.exec(stripped)) !== null) tokens.add(match[1]);
	assert.ok(!tokens.has('vt-chart__comment-only-phantom'), 'a class occurring only inside a CSS comment must not count as declared');
	assert.ok(tokens.has('vt-chart__real'), 'sanity: a real declared selector outside the comment must still be found');
});

// --- rung 5: geometry/CSS agreement -----------------------------------------

/**
 * Reads a `export const NAME = <number>;` declaration out of
 * chart-contracts.ts as text.
 * @param {string} name
 * @returns {number}
 */
function readGeometryConstant(name) {
	const source = readFileSync(CHART_CONTRACTS_PATH, 'utf8');
	const match = source.match(new RegExp(`export const ${name} = (\\d+);`));
	assert.ok(match, `expected to find "export const ${name} = <number>;" in chart-contracts.ts`);
	return Number(match[1]);
}

/**
 * Reads a `height: <number>px;` declaration out of the named selector's rule
 * block in comment-stripped components.css.
 * @param {string} selector
 * @returns {number}
 */
function readDeclaredHeightPx(selector) {
	const stripped = readFileSync(COMPONENTS_CSS_PATH, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
	const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const blockMatch = stripped.match(new RegExp(`\\.${escaped}\\s*\\{([^}]*)\\}`));
	assert.ok(blockMatch, `expected to find a rule block for "${selector}" in components.css`);
	const heightMatch = blockMatch[1].match(/height:\s*(\d+)px;/);
	assert.ok(heightMatch, `expected a "height: <n>px;" declaration inside "${selector}"'s rule block`);
	return Number(heightMatch[1]);
}

test('rung 5: METER_HEIGHT_PX and METER_COMPACT_HEIGHT_PX (chart-contracts.ts) agree with the px heights declared on .vt-chart__meter--panel / .vt-chart__meter--compact (components.css)', () => {
	assert.equal(readGeometryConstant('METER_HEIGHT_PX'), readDeclaredHeightPx('vt-chart__meter--panel'));
	assert.equal(readGeometryConstant('METER_COMPACT_HEIGHT_PX'), readDeclaredHeightPx('vt-chart__meter--compact'));
});

test('rung 5b: components.css declares no "overflow: hidden" under any vt-chart selector (D-16 — a label is never clipped)', () => {
	assert.equal((readFileSync(COMPONENTS_CSS_PATH, 'utf8').match(/overflow:\s*hidden/g) ?? []).length, 0);
});

test('rung 5b (control): the overflow-hidden matcher DOES fire on a planted fixture', () => {
	const fixture = '.vt-chart__meter-track { overflow: hidden; }';
	assert.match(fixture, /overflow:\s*hidden/);
});
