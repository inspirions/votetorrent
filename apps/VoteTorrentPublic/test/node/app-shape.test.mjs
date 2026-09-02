/**
 * app-shape.test.mjs — the per-app configuration D-16 says a shared package
 * cannot enforce for itself, asserted here at tier 1 in this app's own
 * suite. (53-12 adds the repo-root assertion that generalises this to
 * EVERY consumer; this file is the app-local half and is not made redundant
 * by it — 53-12 cannot run until wave 6.)
 *
 * Every path is resolved through scripts/lib/source-paths.mjs's
 * `publicRoot(...)`/`publicSrc(...)` (53-01) — never re-derived from
 * `import.meta.url`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { publicRoot, publicSrc, repoRoot } from '../../../../scripts/lib/source-paths.mjs';

/** Same line-based comment-stripping idiom the repo's other tier-1 assertions use.
 * @param {string} source @returns {string} */
function stripCommentLines(source) {
	return source
		.split('\n')
		.filter((line) => {
			const trimmed = line.trim();
			return !(trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*'));
		})
		.join('\n');
}

const VITE_CONFIG_SOURCE = readFileSync(publicRoot('vite.config.ts'), 'utf8');
const VITE_CONFIG_STRIPPED = stripCommentLines(VITE_CONFIG_SOURCE);

// ---------------------------------------------------------------------------
// 1. resolve.dedupe (D-16).
// ---------------------------------------------------------------------------
test('vite.config.ts declares resolve.dedupe: [\'react\', \'react-dom\']', () => {
	assert.match(VITE_CONFIG_STRIPPED, /dedupe:\s*\['react',\s*'react-dom'\]/, 'expected the exact dedupe form');
});

test('inertness control: a config that only DISCUSSES dedupe in a comment does not satisfy the matcher', () => {
	const commentOnly = stripCommentLines('// resolve: { dedupe: [\'react\', \'react-dom\'] } is discussed here only\nexport default {};');
	assert.doesNotMatch(commentOnly, /dedupe:\s*\['react',\s*'react-dom'\]/, 'comment-only mention must not satisfy the matcher');
});

// ---------------------------------------------------------------------------
// 2. No forbidden build escapes.
// ---------------------------------------------------------------------------
/** @type {ReadonlyArray<readonly [string, RegExp]>} */
const FORBIDDEN_BUILD_ESCAPES = [
	['define:', /\bdefine\s*:/],
	['envPrefix:', /\benvPrefix\s*:/],
	['alias:', /\balias\s*:/],
];
for (const [label, re] of FORBIDDEN_BUILD_ESCAPES) {
	test(`positive control: the "${label}" matcher fires on a planted fixture`, () => {
		assert.match(`export default defineConfig({ ${label} {} });`, re, `matcher for "${label}" is inert`);
	});

	test(`vite.config.ts contains no "${label}" (forbidden build escape)`, () => {
		assert.doesNotMatch(VITE_CONFIG_STRIPPED, re, `vite.config.ts must not declare "${label}"`);
	});
}

// ---------------------------------------------------------------------------
// 3. Port binding.
// ---------------------------------------------------------------------------
test('vite.config.ts binds both server and preview to port 5181 with strictPort: true', () => {
	const portMatches = VITE_CONFIG_STRIPPED.match(/port:\s*5181/g) ?? [];
	const strictPortMatches = VITE_CONFIG_STRIPPED.match(/strictPort:\s*true/g) ?? [];
	assert.equal(portMatches.length, 2, `expected exactly 2 "port: 5181" bindings (server + preview), found ${portMatches.length}`);
	assert.equal(strictPortMatches.length, 2, `expected exactly 2 "strictPort: true" bindings, found ${strictPortMatches.length}`);
});

// ---------------------------------------------------------------------------
// 4. Shared tsconfig base (D-16).
// ---------------------------------------------------------------------------
test('tsconfig.json extends packages/ui-web/tsconfig.base.json by relative path, no local compilerOptions, and the target exists on disk', () => {
	const tsconfig = JSON.parse(readFileSync(publicRoot('tsconfig.json'), 'utf8'));
	assert.equal(tsconfig.extends, '../../packages/ui-web/tsconfig.base.json', 'extends path drifted');
	assert.ok(!('compilerOptions' in tsconfig), 'tsconfig.json must declare no local compilerOptions');
	const resolvedBase = path.join(repoRoot, 'packages', 'ui-web', 'tsconfig.base.json');
	assert.ok(existsSync(resolvedBase), `the extends target must exist on disk at ${resolvedBase} — an extends pointing at nothing is a silently-empty config`);
});

test('would-fail control: an extends pointing at a non-existent sibling path is detectably absent', () => {
	const bogus = path.join(repoRoot, 'packages', 'ui-web', 'does-not-exist.json');
	assert.ok(!existsSync(bogus), 'sanity: the bogus path used to prove the existence check discriminates must not exist');
});

// ---------------------------------------------------------------------------
// 5. The single canonical stylesheet import, and its position (D-15).
// ---------------------------------------------------------------------------
test('app.css opens with exactly one correctly-positioned @import of @votetorrent/ui-web/tokens.css, and declares no custom property', () => {
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
	assert.equal(firstMeaningfulLine, "@import '@votetorrent/ui-web/tokens.css';", 'the first non-comment, non-blank line must be exactly the canonical import');

	const occurrences = cssSource.match(/@import\s+['"]@votetorrent\/ui-web\/tokens\.css['"]/g) ?? [];
	assert.equal(occurrences.length, 1, `expected exactly one canonical tokens import, found ${occurrences.length}`);

	assert.doesNotMatch(cssSource, /:root/, 'app.css must declare no :root block');
	assert.doesNotMatch(cssSource, /^\s*--/m, 'app.css must declare no custom property');
});

test('positive control: a stylesheet with the import positioned AFTER a layout rule would fail the position assertion', () => {
	const wrongOrder = ".foo { color: red; }\n@import '@votetorrent/ui-web/tokens.css';\n";
	const lines = wrongOrder.split('\n').map((l) => l.trim()).filter((l) => l !== '');
	assert.notEqual(lines[0], "@import '@votetorrent/ui-web/tokens.css';", 'sanity: proves position, not mere presence, is what this assertion checks');
});

// ---------------------------------------------------------------------------
// 6. The declared browser gate (the D-21 hook).
// ---------------------------------------------------------------------------
test('package.json declares a test:browser script pointing at a file under test/browser/ that exists on disk', () => {
	const manifest = JSON.parse(readFileSync(publicRoot('package.json'), 'utf8'));
	assert.ok('test:browser' in manifest.scripts, 'package.json scripts must declare test:browser');
	const scriptValue = manifest.scripts['test:browser'];
	const match = scriptValue.match(/test\/browser\/([\w.-]+)/);
	assert.ok(match, `test:browser script value "${scriptValue}" does not reference a path under test/browser/`);
	const targetPath = publicRoot('test', 'browser', match[1]);
	assert.ok(existsSync(targetPath), `test:browser's declared target ${targetPath} does not exist on disk — a declared script pointing at a missing file is exactly the failure this catches`);
});

// ---------------------------------------------------------------------------
// 7. Standing dangerouslySetInnerHTML absence scan.
// ---------------------------------------------------------------------------
const RAW_HTML_ESCAPE_HATCH_RE = /dangerouslySetInnerHTML/;

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

test('positive control: the raw-HTML-injection matcher fires on a planted occurrence', () => {
	assert.match('<div dangerouslySetInnerHTML={{ __html: x }} />', RAW_HTML_ESCAPE_HATCH_RE, 'matcher is inert');
});

test('no file under src/ uses the raw-HTML-injection escape hatch (this lands before 53-07 introduces URL-derived input for ElectionShell to be dangerous with)', () => {
	const files = walkAll(publicSrc());
	const offenders = [];
	for (const file of files) {
		const stripped = stripCommentLines(readFileSync(file, 'utf8'));
		if (RAW_HTML_ESCAPE_HATCH_RE.test(stripped)) offenders.push(file);
	}
	assert.deepEqual(offenders, [], `these files use the raw-HTML-injection escape hatch: ${offenders.join(', ')}`);
});

// ---------------------------------------------------------------------------
// 8. No prose in the chrome.
// ---------------------------------------------------------------------------
const JSX_TEXT_RUN_RE = /[>][^<>{}]*[A-Za-z]{2,}[^<>{}]*[<]/;

test('positive control: the JSX-text-run matcher fires on a planted text run', () => {
	assert.match('<div>Hello world</div>', JSX_TEXT_RUN_RE, 'matcher is inert against a planted JSX text run');
});

test('benign control: the matcher does not fire on text that lives only inside an attribute or an expression container', () => {
	const benign = '<div className="public-app">{children}</div>';
	assert.doesNotMatch(benign, JSX_TEXT_RUN_RE, 'matcher must not fire on attribute values or expression containers');
});

test('AppChrome.tsx renders no JSX text run (D-08 admits only the public.* keys 53-07 actually mounts)', () => {
	const source = readFileSync(publicSrc('screens', 'AppChrome.tsx'), 'utf8');
	const offendingLines = source.split('\n').filter((line) => JSX_TEXT_RUN_RE.test(line));
	assert.deepEqual(offendingLines, [], `AppChrome.tsx contains a JSX text run: ${JSON.stringify(offendingLines)}`);
});
