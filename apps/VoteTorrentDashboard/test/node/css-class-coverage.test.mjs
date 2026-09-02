/**
 * css-class-coverage.test.mjs — CR-01's tier-1, dependency-free half: every
 * class name this app's own `src/` renders, plus every class name a mounted
 * `@votetorrent/ui-web/components` export renders, must resolve to a real
 * selector somewhere in this app's own reachable CSS (`scripts/lib/
 * css-class-coverage.mjs`'s `checkClassNameCoverage`). See that module's own
 * header for what "reachable" means and why it is scoped the way it is.
 *
 * The dashboard was NOT the app CR-01 found broken (its own `preview-as.css`/
 * `election-ops.css` always declared `.pv-disclosure`/`.lifecycle-pill`), but
 * this check runs here too — a shared checker is only trustworthy if it
 * clears the consumer it was never written against, not just the one that
 * was broken.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { dashboardSrc, uiWebRoot, uiWebSrc } from '../../../../scripts/lib/source-paths.mjs';
import { checkClassNameCoverage } from '../../../../scripts/lib/css-class-coverage.mjs';

const UI_WEB_ROOT_DIR = uiWebRoot();

const componentClassNamesModule = await import(pathToFileURL(uiWebSrc('component-class-names.js')).href);
/** @type {Readonly<Record<string, ReadonlyArray<string>>>} */
const COMPONENT_CLASS_NAMES = componentClassNamesModule.COMPONENT_CLASS_NAMES;

/**
 * PRE-EXISTING, out-of-scope gaps this checker measured while landing CR-01
 * (53-CR01 gap-closure round) — NOT introduced by this task, NOT one of
 * CR-01's five reviewed selectors, and deliberately NOT fixed here per the
 * SCOPE BOUNDARY rule (only auto-fix issues directly caused by the current
 * task's changes). Logged in this phase's `deferred-items.md`. Each is a
 * genuinely rendered class with zero CSS rule anywhere in the repo:
 *   - `PanelFrame.tsx` renders `pill-scope`/`pill-tier`/`pill-sites` alongside
 *     the base `pill` class, which alone carries every visual rule -- these
 *     three modifiers may be semantic-only hooks with no distinct look, or
 *     may be an unrelated latent gap; undetermined, out of scope to decide
 *     here.
 *   - `PanelGrid.tsx` renders `sh-panel-grid-wrap`, a layout-grouping `<div>`
 *     with no rule of its own (`.panel-grid` inside it is the one styled
 *     child) -- plausibly intentional, undetermined, out of scope here.
 * This list must shrink, never silently grow -- see this constant's own
 * `ignoreClassNames` contract in scripts/lib/css-class-coverage.mjs.
 */
const PRE_EXISTING_UNSTYLED_CLASSES = ['pill-scope', 'pill-tier', 'pill-sites', 'sh-panel-grid-wrap'];

test('real check: every rendered class name in apps/VoteTorrentDashboard/src resolves to a real CSS selector (pre-existing, out-of-scope gaps excepted — see PRE_EXISTING_UNSTYLED_CLASSES above)', () => {
	const { missing, renderedCount, declaredCount } = checkClassNameCoverage({
		appSrcDir: dashboardSrc(),
		uiWebRootDir: UI_WEB_ROOT_DIR,
		componentClassNames: COMPONENT_CLASS_NAMES,
		ignoreClassNames: PRE_EXISTING_UNSTYLED_CLASSES,
	});
	assert.ok(renderedCount > 0, 'sanity: expected at least one rendered class name under src/');
	assert.ok(declaredCount > 0, 'sanity: expected at least one declared CSS selector reachable from src/');
	assert.deepEqual(missing, [], `these rendered class names have no matching CSS selector: ${missing.join(', ')}`);
});

test('sanity: the shared-component classes this app mounts are all declared (pv-disclosure, lifecycle-pill + modifiers, dt-toggle-group)', () => {
	const { missing } = checkClassNameCoverage({
		appSrcDir: dashboardSrc(),
		uiWebRootDir: UI_WEB_ROOT_DIR,
		componentClassNames: COMPONENT_CLASS_NAMES,
		ignoreClassNames: PRE_EXISTING_UNSTYLED_CLASSES,
	});
	for (const cls of ['pv-disclosure', 'lifecycle-pill', 'lifecycle-pill--organizing', 'dt-toggle-group']) {
		assert.ok(!missing.includes(cls), `${cls} regressed`);
	}
});

test('the pre-existing allowlist names only classes that are actually otherwise-missing (no stale entries)', () => {
	const { missing } = checkClassNameCoverage({
		appSrcDir: dashboardSrc(),
		uiWebRootDir: UI_WEB_ROOT_DIR,
		componentClassNames: COMPONENT_CLASS_NAMES,
		ignoreClassNames: [],
	});
	for (const cls of PRE_EXISTING_UNSTYLED_CLASSES) {
		assert.ok(missing.includes(cls), `"${cls}" is no longer missing — remove it from PRE_EXISTING_UNSTYLED_CLASSES (it was fixed, this allowlist entry is now stale)`);
	}
});

// ---------------------------------------------------------------------------
// Inertness controls — see apps/VoteTorrentPublic's own copy of this file for
// the full rationale; both apps carry the same controls independently so
// neither app's suite depends on the other's for coverage.
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
		tsx: "import { AdvisoryDisclosure } from '@votetorrent/ui-web/components';\nexport function Fixture() { return <AdvisoryDisclosure variant=\"authority\" />; }",
		css: '.unrelated { color: red; }',
	});
	try {
		const { missing } = checkClassNameCoverage({
			appSrcDir,
			uiWebRootDir: UI_WEB_ROOT_DIR,
			componentClassNames: COMPONENT_CLASS_NAMES,
		});
		assert.ok(missing.includes('pv-disclosure'), `expected "pv-disclosure" to be reported missing, got: ${missing.join(', ')}`);
	} finally {
		rmSync(appSrcDir, { recursive: true, force: true });
	}
});
