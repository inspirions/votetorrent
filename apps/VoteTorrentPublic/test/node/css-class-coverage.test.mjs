/**
 * css-class-coverage.test.mjs — CR-01's tier-1, dependency-free half: every
 * class name this app's own `src/` renders, plus every class name a mounted
 * `@votetorrent/ui-web/components` export renders, must resolve to a real
 * selector somewhere in this app's own reachable CSS (`scripts/lib/
 * css-class-coverage.mjs`'s `checkClassNameCoverage`). See that module's own
 * header for what "reachable" means and why it is scoped the way it is.
 *
 * This is the cheaper, no-browser-needed sibling of
 * `packages/ui-web/scripts/run-ui-gates.mjs`'s new `resolved-component-styles`
 * browser rung — either alone would have caught CR-01's measured defect
 * (`.pv-disclosure`, `.lifecycle-pill` + 3 modifiers, `.election-title`,
 * `.dt-toggle-group` all resolving to zero rules in this app); this one
 * catches it before any browser ever runs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { publicSrc, uiWebRoot, uiWebSrc } from '../../../../scripts/lib/source-paths.mjs';
import { checkClassNameCoverage } from '../../../../scripts/lib/css-class-coverage.mjs';

const UI_WEB_ROOT_DIR = uiWebRoot();

const componentClassNamesModule = await import(pathToFileURL(uiWebSrc('component-class-names.js')).href);
/** @type {Readonly<Record<string, ReadonlyArray<string>>>} */
const COMPONENT_CLASS_NAMES = componentClassNamesModule.COMPONENT_CLASS_NAMES;

test('real check: every rendered class name in apps/VoteTorrentPublic/src resolves to a real CSS selector', () => {
	const { missing, renderedCount, declaredCount } = checkClassNameCoverage({
		appSrcDir: publicSrc(),
		uiWebRootDir: UI_WEB_ROOT_DIR,
		componentClassNames: COMPONENT_CLASS_NAMES,
	});
	assert.ok(renderedCount > 0, 'sanity: expected at least one rendered class name under src/');
	assert.ok(declaredCount > 0, 'sanity: expected at least one declared CSS selector reachable from src/');
	assert.deepEqual(missing, [], `these rendered class names have no matching CSS selector: ${missing.join(', ')}`);
});

test('sanity: the five CR-01 selectors are all declared and rendered (the specific regression this check exists to catch)', () => {
	const { missing } = checkClassNameCoverage({
		appSrcDir: publicSrc(),
		uiWebRootDir: UI_WEB_ROOT_DIR,
		componentClassNames: COMPONENT_CLASS_NAMES,
	});
	for (const cls of ['pv-disclosure', 'lifecycle-pill', 'lifecycle-pill--organizing', 'election-title', 'dt-toggle-group']) {
		assert.ok(!missing.includes(cls), `${cls} regressed — this is exactly CR-01's original defect`);
	}
});

// ---------------------------------------------------------------------------
// Inertness controls — a check that cannot detect a planted violation proves
// nothing about the real app. Built against throwaway fixture directories, so
// these controls never depend on (or risk mutating) real repo state.
// ---------------------------------------------------------------------------

/**
 * @param {{ tsx?: string, css?: string }} files
 * @returns {string} the fixture app src dir
 */
function makeFixtureAppSrc(files) {
	const root = mkdtempSync(path.join(os.tmpdir(), 'css-class-coverage-fixture-'));
	mkdirSync(root, { recursive: true });
	if (files.tsx !== undefined) writeFileSync(path.join(root, 'Fixture.tsx'), files.tsx);
	if (files.css !== undefined) writeFileSync(path.join(root, 'fixture.css'), files.css);
	return root;
}

test('inertness control: a rendered class with NO matching CSS selector is reported missing', () => {
	const appSrcDir = makeFixtureAppSrc({
		tsx: 'export function Fixture() { return <p className="phantom-fixture-class">x</p>; }',
		css: '.some-other-class { color: red; }',
	});
	try {
		const { missing } = checkClassNameCoverage({
			appSrcDir,
			uiWebRootDir: UI_WEB_ROOT_DIR,
			componentClassNames: COMPONENT_CLASS_NAMES,
		});
		assert.deepEqual(missing, ['phantom-fixture-class']);
	} finally {
		rmSync(appSrcDir, { recursive: true, force: true });
	}
});

test('benign control: a rendered class WITH a matching CSS selector is not reported missing', () => {
	const appSrcDir = makeFixtureAppSrc({
		tsx: 'export function Fixture() { return <p className="real-fixture-class">x</p>; }',
		css: '.real-fixture-class { color: red; }',
	});
	try {
		const { missing } = checkClassNameCoverage({
			appSrcDir,
			uiWebRootDir: UI_WEB_ROOT_DIR,
			componentClassNames: COMPONENT_CLASS_NAMES,
		});
		assert.deepEqual(missing, []);
	} finally {
		rmSync(appSrcDir, { recursive: true, force: true });
	}
});

test('inertness control: a mounted shared component with no CSS import for its class names is reported missing', () => {
	const appSrcDir = makeFixtureAppSrc({
		tsx: "import { LifecyclePill } from '@votetorrent/ui-web/components';\nexport function Fixture() { return <LifecyclePill phase=\"running\" />; }",
		css: '.unrelated { color: red; }',
	});
	try {
		const { missing } = checkClassNameCoverage({
			appSrcDir,
			uiWebRootDir: UI_WEB_ROOT_DIR,
			componentClassNames: COMPONENT_CLASS_NAMES,
		});
		assert.ok(missing.includes('lifecycle-pill'), `expected "lifecycle-pill" to be reported missing, got: ${missing.join(', ')}`);
		assert.ok(missing.includes('lifecycle-pill--running'));
	} finally {
		rmSync(appSrcDir, { recursive: true, force: true });
	}
});

test('a fixture app.css @importing @votetorrent/ui-web/components.css resolves the shared components classes', () => {
	const appSrcDir = makeFixtureAppSrc({
		tsx: "import { AdvisoryDisclosure } from '@votetorrent/ui-web/components';\nexport function Fixture() { return <AdvisoryDisclosure variant=\"public\" />; }",
		css: "@import '@votetorrent/ui-web/components.css';\n",
	});
	try {
		const { missing } = checkClassNameCoverage({
			appSrcDir,
			uiWebRootDir: UI_WEB_ROOT_DIR,
			componentClassNames: COMPONENT_CLASS_NAMES,
		});
		assert.deepEqual(missing, []);
	} finally {
		rmSync(appSrcDir, { recursive: true, force: true });
	}
});
