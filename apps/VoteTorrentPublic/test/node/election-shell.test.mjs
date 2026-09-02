/**
 * election-shell.test.mjs — the eleven lettered assertions from 53-07 Task 2
 * over `src/screens/ElectionShell.tsx` and its neighbours. Every path is
 * resolved through `scripts/lib/source-paths.mjs`'s `publicSrc()`/
 * `publicRoot()` and `uiWebSrc()` (D-25/53-01) — never re-derived from
 * `import.meta.url`. Every matcher gets a planted-fixture positive control
 * BEFORE it runs against real source, per this repo's own standing rule
 * that a comment merely DISCUSSING a forbidden term must never trip a
 * matcher (so every scan below strips comment lines first).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { publicSrc, publicRoot, uiWebSrc, uiWebRoot } from '../../../../scripts/lib/source-paths.mjs';
import { COPY } from '../../../../packages/ui-web/src/index.js';

/** @param {string} source @returns {string} */
function stripCommentLines(source) {
	return source
		.split('\n')
		.filter((line) => {
			const trimmed = line.trim();
			return !(trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*'));
		})
		.join('\n');
}

/** @param {string} dir @returns {string[]} */
function walkAll(dir) {
	/** @type {string[]} */
	const out = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			out.push(...walkAll(full));
		} else {
			out.push(full);
		}
	}
	return out;
}

const SHELL_PATH = publicSrc('screens', 'ElectionShell.tsx');
const SHELL_SOURCE_RAW = readFileSync(SHELL_PATH, 'utf8');
const SHELL_SOURCE = stripCommentLines(SHELL_SOURCE_RAW);

// ---------------------------------------------------------------------------
// 1. Single return.
// ---------------------------------------------------------------------------

/** @param {string} source @returns {number} */
function countReturns(source) {
	return (source.match(/\breturn\b/g) ?? []).length;
}

test('positive control: the single-return matcher fires (counts 2) on a planted two-return fixture', () => {
	const fixture = 'function Foo() {\n\tif (x) {\n\t\treturn null;\n\t}\n\treturn <div />;\n}';
	assert.equal(countReturns(fixture), 2, 'matcher is inert against a planted two-return fixture');
});

test('ElectionShell.tsx contains exactly one `return` statement', () => {
	assert.equal(countReturns(SHELL_SOURCE), 1, 'expected exactly one return statement in ElectionShell.tsx');
});

// ---------------------------------------------------------------------------
// 2. Genuine mounts.
// ---------------------------------------------------------------------------

test('ElectionShell.tsx mounts <LifecyclePill, <AdvisoryDisclosure and <DetailsToggle each exactly once, with the literal variant="public"', () => {
	assert.equal((SHELL_SOURCE.match(/<LifecyclePill\b/g) ?? []).length, 1);
	assert.equal((SHELL_SOURCE.match(/<AdvisoryDisclosure\b/g) ?? []).length, 1);
	assert.equal((SHELL_SOURCE.match(/<DetailsToggle\b/g) ?? []).length, 1);
	assert.match(SHELL_SOURCE, /variant="public"/, 'expected the literal variant="public" (not a variable) so a grep can see it');
});

// ---------------------------------------------------------------------------
// 3. The toggle is never wrapped around the advisory.
// ---------------------------------------------------------------------------

/** @param {string} source @returns {boolean} true if <AdvisoryDisclosure appears between a <DetailsToggle open tag and its matching close tag. */
function advisoryNestedInToggle(source) {
	const openIdx = source.indexOf('<DetailsToggle');
	if (openIdx === -1) return false;
	const closeIdx = source.indexOf('</DetailsToggle>', openIdx);
	if (closeIdx === -1) return false;
	const between = source.slice(openIdx, closeIdx);
	return between.includes('<AdvisoryDisclosure');
}

test('positive control: the nesting matcher fires on a planted <DetailsToggle>...<AdvisoryDisclosure />...</DetailsToggle> fixture', () => {
	const fixture = '<DetailsToggle summary="x"><AdvisoryDisclosure variant="public" /></DetailsToggle>';
	assert.ok(advisoryNestedInToggle(fixture), 'matcher is inert against a planted nested fixture');
});

test('ElectionShell.tsx never nests <AdvisoryDisclosure inside <DetailsToggle (D-16 consumer-side half)', () => {
	assert.equal(advisoryNestedInToggle(SHELL_SOURCE), false);
});

// ---------------------------------------------------------------------------
// 4. A hook-calling component is mounted — classified by NAME, not
//    hard-coded to DetailsToggle.
// ---------------------------------------------------------------------------

const HOOK_CALL_RE = /\buse[A-Z]\w*\(/;

/** @param {string} name @returns {string} the .tsx source of a component re-exported from components.js by that name. */
function readComponentSource(name) {
	return stripCommentLines(readFileSync(uiWebSrc('components', `${name}.tsx`), 'utf8'));
}

/** @returns {string[]} every component name re-exported from packages/ui-web/src/components.js. */
function listExportedComponentNames() {
	const barrel = stripCommentLines(readFileSync(uiWebSrc('components.js'), 'utf8'));
	const names = [];
	const re = /export\s*\{\s*(\w+)\s*\}\s*from\s*'\.\/components\/\1\.js'/g;
	let m;
	while ((m = re.exec(barrel))) names.push(m[1]);
	return names;
}

test('positive control: the hook-call classifier identifies a planted useState( fixture as hook-calling and a planted hook-free fixture as not', () => {
	assert.match('function X() { const [a, setA] = useState(0); return null; }', HOOK_CALL_RE);
	assert.doesNotMatch('function X() { return null; }', HOOK_CALL_RE);
});

test('at least one hook-calling component re-exported from components.js has its JSX tag mounted in ElectionShell.tsx', () => {
	const names = listExportedComponentNames();
	assert.ok(names.length > 0, 'sanity: components.js must re-export at least one component');
	const classified = names.map((name) => ({ name, hookCalling: HOOK_CALL_RE.test(readComponentSource(name)) }));
	const hookCallingNames = classified.filter((c) => c.hookCalling).map((c) => c.name);
	const nonHookCallingNames = classified.filter((c) => !c.hookCalling).map((c) => c.name);
	assert.ok(hookCallingNames.length > 0, `no hook-calling component found among: ${JSON.stringify(classified)}`);
	const mountedHookCalling = hookCallingNames.filter((name) => SHELL_SOURCE.includes(`<${name}`));
	assert.ok(
		mountedHookCalling.length > 0,
		`ElectionShell.tsx mounts none of the classified hook-calling components (${hookCallingNames.join(', ')}); ` +
			`non-hook-calling set was (${nonHookCallingNames.join(', ')})`,
	);
});

// ---------------------------------------------------------------------------
// 5. No dangerouslySetInnerHTML anywhere under src/ or test/.
// ---------------------------------------------------------------------------

const RAW_HTML_ESCAPE_HATCH_RE = /dangerouslySetInnerHTML/;

test('positive control: the raw-HTML-injection matcher fires on a planted occurrence', () => {
	assert.match('<div dangerouslySetInnerHTML={{ __html: x }} />', RAW_HTML_ESCAPE_HATCH_RE);
});

test('no file under src/ or test/ (excluding test/node/*.test.mjs, whose own positive-control fixture literally plants the sentinel) uses the raw-HTML-injection escape hatch', () => {
	// test/node/ is this app's OWN scanner tooling — this very file, and
	// app-shape.test.mjs, each plant the sentinel string as a positive-control
	// fixture literal (never as real JSX usage), so excluding that one
	// directory is what keeps this check from permanently self-tripping on
	// its own control. The real subject of this scan is application code
	// (src/) and any browser-harness/fixture code Task 3 adds under
	// test/browser/ and test/fixtures/ — neither of which may plant the
	// escape hatch for real.
	const testNodeDir = publicRoot('test', 'node');
	const files = [...walkAll(publicSrc()), ...walkAll(publicRoot('test'))].filter((f) => !f.startsWith(testNodeDir));
	const offenders = [];
	for (const file of files) {
		const stripped = stripCommentLines(readFileSync(file, 'utf8'));
		if (RAW_HTML_ESCAPE_HATCH_RE.test(stripped)) offenders.push(file);
	}
	assert.deepEqual(offenders, [], `these files use the raw-HTML-injection escape hatch: ${offenders.join(', ')}`);
});

// ---------------------------------------------------------------------------
// 6. One URL parameter only, under src/.
// ---------------------------------------------------------------------------

test('the only URL parameter name reachable anywhere under src/ is "election" (test/browser/ is excluded from this scan — its own ?phase= selector lives there, never in src/)', () => {
	const files = walkAll(publicSrc());
	/** @type {Map<string, string>} */
	const contents = new Map();
	for (const file of files) contents.set(file, stripCommentLines(readFileSync(file, 'utf8')));

	const CALL_SITE_RE = /\.(?:get|getAll)\(\s*([\w$]+|(['"`])([\w-]+)\2)\s*\)/g;
	/** @type {Set<string>} */
	const resolvedNames = new Set();
	const forbidden = ['at', 'phase', 'now'];

	for (const [, source] of contents) {
		let m;
		const re = new RegExp(CALL_SITE_RE.source, 'g');
		while ((m = re.exec(source))) {
			if (m[3] !== undefined) {
				resolvedNames.add(m[3]);
				continue;
			}
			const identifier = m[1];
			let found = null;
			for (const [, otherSource] of contents) {
				const constMatch = otherSource.match(new RegExp(`\\b${identifier}\\s*=\\s*(['"\`])([\\w-]+)\\1`));
				if (constMatch) {
					found = constMatch[2];
					break;
				}
			}
			resolvedNames.add(found ?? `<unresolved:${identifier}>`);
		}
	}

	assert.deepEqual([...resolvedNames].sort(), ['election'], `expected the only URL parameter name in src/ to be "election", found: ${[...resolvedNames].join(', ')}`);

	for (const name of forbidden) {
		assert.ok(!resolvedNames.has(name), `"${name}" must not be reachable from the URL anywhere in src/ (T-53-07-04)`);
	}
});

// ---------------------------------------------------------------------------
// 7. D-18 inertness, CSS side.
// ---------------------------------------------------------------------------

const CSS_ANIMATION_RE = /(@keyframes|animation(?:-name)?\s*:|transition\s*:|linear-gradient\()/;

test('positive control: the CSS-animation matcher fires on planted @keyframes and transition fixtures', () => {
	assert.match('@keyframes shimmer{}', CSS_ANIMATION_RE);
	assert.match('transition: opacity .3s;', CSS_ANIMATION_RE);
});

test('no *.css file under src/ contains @keyframes, animation, animation-name, transition or linear-gradient (D-18)', () => {
	const cssFiles = walkAll(publicSrc()).filter((f) => f.endsWith('.css'));
	assert.ok(cssFiles.length > 0, 'sanity: expected at least one .css file under src/');
	const offenders = [];
	for (const file of cssFiles) {
		const stripped = stripCommentLines(readFileSync(file, 'utf8'));
		if (CSS_ANIMATION_RE.test(stripped)) offenders.push(file);
	}
	assert.deepEqual(offenders, [], `these CSS files carry an animation/transition/gradient construct: ${offenders.join(', ')}`);
});

// ---------------------------------------------------------------------------
// 8. D-18 inertness, DOM side.
// ---------------------------------------------------------------------------

test('ElectionShell.tsx contains no busy/status/progress/alert role and no spinner/shimmer/pulse/loading/pending identifier', () => {
	assert.doesNotMatch(SHELL_SOURCE, /aria-busy/);
	assert.doesNotMatch(SHELL_SOURCE, /role="status"/);
	assert.doesNotMatch(SHELL_SOURCE, /role="progressbar"/);
	assert.doesNotMatch(SHELL_SOURCE, /role="alert"/);
	assert.doesNotMatch(SHELL_SOURCE, /<progress/);
	assert.doesNotMatch(SHELL_SOURCE, /spinner|shimmer|pulse|loading|pending/i);
});

// ---------------------------------------------------------------------------
// 9. D-08 key totality, both directions.
// ---------------------------------------------------------------------------

const PUBLIC_VOICE_KEY_RE = /^(public\.|advisory\.public\.)/;
const KEY_LITERAL_RE = /['"`](public\.[\w.]+|advisory\.public\.[\w.]+)['"`]/g;

test('the public-voice key set in COPY equals, in both directions, the set of public-voice keys literally mounted under src/ and packages/ui-web/src/components/', () => {
	const declaredKeys = new Set(Object.keys(COPY).filter((k) => PUBLIC_VOICE_KEY_RE.test(k)));

	const scanDirs = [publicSrc(), uiWebRoot('src', 'components')];
	/** @type {Set<string>} */
	const mountedKeys = new Set();
	for (const dir of scanDirs) {
		for (const file of walkAll(dir)) {
			const source = readFileSync(file, 'utf8');
			let m;
			const re = new RegExp(KEY_LITERAL_RE.source, 'g');
			while ((m = re.exec(source))) mountedKeys.add(m[1]);
			// advisory.public.body is never spelled out as a literal — it is
			// resolved by AdvisoryDisclosure's `advisory.${variant}.body`
			// TEMPLATE (D-07's whole mechanism is that there is nowhere in a
			// template literal to put a silent fallback). The literal mount
			// evidence for that key is `variant="public"` itself.
			if (/variant="public"/.test(source)) mountedKeys.add('advisory.public.body');
		}
	}

	const declaredNotMounted = [...declaredKeys].filter((k) => !mountedKeys.has(k));
	const mountedNotDeclared = [...mountedKeys].filter((k) => !declaredKeys.has(k));

	assert.deepEqual(declaredNotMounted, [], `declared public-voice key(s) never mounted: ${declaredNotMounted.join(', ')}`);
	assert.deepEqual(mountedNotDeclared, [], `mounted public-voice key(s) never declared in COPY: ${mountedNotDeclared.join(', ')}`);
});

// ---------------------------------------------------------------------------
// 10. Phase-54 boundary.
// ---------------------------------------------------------------------------

const PHASE_54_FORBIDDEN_RE = /\b(derivePhase|threeBucket|facts\.js|listPublicNetworks|initDB|prepareDb|registerDbPlugins|indexedDB|settling)\b/;

test('positive control: the phase-54-boundary matcher fires on a planted derivePhase occurrence', () => {
	assert.match('const x = derivePhase(y);', PHASE_54_FORBIDDEN_RE);
});

test('zero occurrences under src/ of derivePhase/threeBucket/facts.js/listPublicNetworks/initDB/prepareDb/registerDbPlugins/indexedDB/"settling"', () => {
	const offenders = [];
	for (const file of walkAll(publicSrc())) {
		const stripped = stripCommentLines(readFileSync(file, 'utf8'));
		if (PHASE_54_FORBIDDEN_RE.test(stripped)) offenders.push(file);
	}
	assert.deepEqual(offenders, [], `these files reach into Phase 54's territory: ${offenders.join(', ')}`);
});

// ---------------------------------------------------------------------------
// 11. 53-06's invariants survive.
// ---------------------------------------------------------------------------

test("53-06's invariants survive: app.css's leading @import, no :root/custom property, main.tsx's frozen __PUBLIC_APP__ and app.css-first import, AppChrome.tsx's wordlessness", () => {
	const cssSource = readFileSync(publicSrc('app.css'), 'utf8');
	const lines = cssSource.split('\n');
	let firstMeaningfulLine;
	let inBlockComment = false;
	for (const rawLine of lines) {
		const line = rawLine.trim();
		if (line === '') continue;
		if (inBlockComment) {
			if (line.includes('*/')) inBlockComment = false;
			continue;
		}
		if (line.startsWith('/*')) {
			if (!line.includes('*/')) inBlockComment = true;
			continue;
		}
		firstMeaningfulLine = line;
		break;
	}
	assert.equal(firstMeaningfulLine, "@import '@votetorrent/ui-web/tokens.css';");
	assert.doesNotMatch(cssSource, /:root/);
	assert.doesNotMatch(cssSource, /^\s*--/m);

	const mainSource = readFileSync(publicSrc('main.tsx'), 'utf8');
	assert.equal(mainSource.trim().split('\n')[0].trim(), "import './app.css';");
	assert.match(mainSource, /window\.__PUBLIC_APP__\s*=\s*Object\.freeze\(/);

	const JSX_TEXT_RUN_RE = /[>][^<>{}]*[A-Za-z]{2,}[^<>{}]*[<]/;
	const chromeSource = readFileSync(publicSrc('screens', 'AppChrome.tsx'), 'utf8');
	const offendingLines = chromeSource.split('\n').filter((line) => JSX_TEXT_RUN_RE.test(line));
	assert.deepEqual(offendingLines, [], `AppChrome.tsx contains a JSX text run: ${JSON.stringify(offendingLines)}`);
});
