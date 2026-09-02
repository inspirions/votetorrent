/**
 * engine-reach.test.mjs — D-13's tier-1, pre-build half.
 *
 * Runs before any build, so it catches the INTENT rather than the artefact
 * (`scripts/assert-engine-reach.mjs`'s post-build scan is the expensive,
 * artefact-level half — see this app's Task 2 for the redundancy rationale).
 *
 * Every path is resolved through scripts/lib/source-paths.mjs's
 * `publicSrc(...)`/`publicRoot(...)` (53-01) — never re-derived from
 * `import.meta.url`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { publicSrc, publicRoot } from '../../../../scripts/lib/source-paths.mjs';

/** Same DB-opening symbol matcher as scripts/assert-engine-reach.mjs's dist-level rung. */
const DB_OPENING_SYMBOL_RE = /\b(initDB|prepareDb|registerDbPlugins|isSchemaInitialized)\b|indexedDB|@quereus\/plugin-indexeddb/;

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

// ---------------------------------------------------------------------------
// 1. Positive control, first — the matcher must be able to detect the
//    forbidden symbols before it is trusted to scan real files.
// ---------------------------------------------------------------------------
test('positive control: the DB-opening matcher fires on a planted fixture containing each forbidden identifier', () => {
	const fixture =
		'import { initDB, prepareDb, registerDbPlugins, isSchemaInitialized } from "x";\n' +
		'const db = indexedDB;\nconst pkg = "@quereus/plugin-indexeddb";';
	for (const term of ['initDB', 'prepareDb', 'registerDbPlugins', 'isSchemaInitialized', 'indexedDB', '@quereus/plugin-indexeddb']) {
		assert.ok(fixture.includes(term), `fixture sanity: must literally contain "${term}"`);
	}
	assert.match(fixture, DB_OPENING_SYMBOL_RE, 'matcher is inert against the planted fixture');
});

// ---------------------------------------------------------------------------
// 2. Benign controls — a matcher that fires on everything discriminates
//    nothing, and this app's own engine-preflight.js header comment
//    legitimately explains which symbols it refuses to import.
// ---------------------------------------------------------------------------
test('benign control: the matcher does not fire on a comment discussing the absence, once comments are stripped', () => {
	const commentOnly = [
		'// This module never calls initDB, prepareDb, registerDbPlugins or isSchemaInitialized.',
		'// It opens no indexedDB and declares no @quereus/plugin-indexeddb dependency.',
		'const x = 1;',
	].join('\n');
	assert.match(commentOnly, DB_OPENING_SYMBOL_RE, 'sanity: the RAW comment text should still match (it names the words)');
	assert.doesNotMatch(stripCommentLines(commentOnly), DB_OPENING_SYMBOL_RE, 'comment-stripped source must not trip the matcher');
});

test('benign control: the matcher does not fire on an identifier that merely contains a banned word as a substring', () => {
	const benign = 'const initDBValue = 1; const prepareDbConfigDefaults = {};';
	assert.doesNotMatch(benign, DB_OPENING_SYMBOL_RE, 'matcher is indiscriminate against substring-only identifiers');
});

// ---------------------------------------------------------------------------
// 3. Real source scan — every file under publicSrc(), comments stripped.
// ---------------------------------------------------------------------------
test('no file under src/ references a DB-opening symbol, indexedDB, or the indexeddb plugin package', () => {
	const srcRoot = publicSrc();
	const files = walkAll(srcRoot);
	assert.ok(files.length > 0, 'expected at least one file under src/');

	const offenders = [];
	for (const file of files) {
		const stripped = stripCommentLines(readFileSync(file, 'utf8'));
		const match = stripped.match(DB_OPENING_SYMBOL_RE);
		if (match) {
			offenders.push(`${file}: "${match[0]}"`);
		}
	}
	assert.deepEqual(offenders, [], `these files reference a DB-opening symbol in real code:\n${offenders.join('\n')}`);
});

// ---------------------------------------------------------------------------
// 4. Manifest scan — the structural half of the control.
// ---------------------------------------------------------------------------
test('the manifest declares none of the IndexedDB-capable packages', () => {
	const manifest = JSON.parse(readFileSync(publicRoot('package.json'), 'utf8'));
	const declared = { ...(manifest.dependencies ?? {}), ...(manifest.devDependencies ?? {}) };
	const banned = [
		'@quereus/quereus',
		'@quereus/plugin-indexeddb',
		'@quereus/store',
		'@quereus/isolation',
		'@optimystic/quereus-plugin-crypto',
		'fake-indexeddb',
	];
	const found = banned.filter((dep) => dep in declared);
	assert.deepEqual(found, [], `manifest declares banned IndexedDB-capable package(s): ${found.join(', ')}`);
});

// ---------------------------------------------------------------------------
// 5. The positive half, at tier 1 — engine-preflight.js's named import.
// ---------------------------------------------------------------------------
const NAMESPACE_IMPORT_RE = /import\s*\*\s*as\s+\w+\s+from/;

test('inertness control: the namespace-import matcher fires on a planted "import * as x from \'y\';" fixture', () => {
	assert.match("import * as x from 'y';", NAMESPACE_IMPORT_RE, 'matcher is inert against a planted namespace import');
});

test('engine-preflight.js names VOTETORRENT_SCHEMA_SQL via a named import and contains no namespace import', () => {
	const source = readFileSync(publicSrc('engine-preflight.js'), 'utf8');
	assert.match(
		source,
		/import\s*\{[^}]*\bVOTETORRENT_SCHEMA_SQL\b[^}]*\}\s*from\s*['"]@votetorrent\/vote-engine\/browser['"]/,
		'expected a named import of VOTETORRENT_SCHEMA_SQL from @votetorrent/vote-engine/browser',
	);
	assert.doesNotMatch(source, NAMESPACE_IMPORT_RE, 'engine-preflight.js must not use a namespace import');
});

test('sanity: dist/ (if present from a prior local build) is not itself a src/ file walked above', () => {
	// Guards against a future refactor accidentally pointing publicSrc() at a
	// root that includes build output.
	const srcRoot = publicSrc();
	assert.ok(!srcRoot.includes(`${path.sep}dist${path.sep}`), 'publicSrc() must never resolve into dist/');
	// WR-12 (Phase 53 review): the prior `if (...) { assert.ok(true); }` block
	// was a literal no-op — it contributed to publicTier1's minPassing count
	// while asserting nothing. Assert what this test was presumably meant to:
	// publicSrc() resolves to a real, existing directory.
	assert.ok(statSync(srcRoot, { throwIfNoEntry: false })?.isDirectory(), `${srcRoot} must exist and be a directory`);
});
