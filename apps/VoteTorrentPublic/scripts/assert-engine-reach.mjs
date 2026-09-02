#!/usr/bin/env node
/**
 * assert-engine-reach.mjs — D-13's post-build proof, paired.
 *
 * D-13: this app declares the engine and proves the schema reaches its
 * bundle, and it opens no database; the two halves are asserted together
 * here because "the engine is reachable" and "the engine is not used to open
 * storage" are only meaningful as a pair — proving reach alone would say
 * nothing about whether that reach also smuggled in a database-opening
 * symbol, and proving the storage-absence alone would say nothing about
 * whether the schema import is real or dead code that never survived the
 * build.
 *
 * Standalone Node script, no new dependencies. Follows the repo's established
 * one-self-contained-script-per-assertion idiom (see
 * apps/VoteTorrentDashboard/scripts/assert-no-node-polyfills.mjs and
 * assert-no-test-harness-in-dist.mjs): this script spawns its own `vite
 * build` rather than relying on a shared, possibly-stale `dist/`.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { VOTETORRENT_SCHEMA_SQL } from '@votetorrent/vote-engine/browser';

const ROOT = process.cwd();
const DIST = path.join(ROOT, 'dist');
const DIST_ASSETS = path.join(DIST, 'assets');

/** @param {string} message */
function fail(message) {
	process.stderr.write(`[assert-engine-reach] FAIL: ${message}\n`);
	process.exit(1);
}

/** @param {string} message */
function ok(message) {
	process.stdout.write(`[assert-engine-reach] OK: ${message}\n`);
}

// ---------------------------------------------------------------------------
// `.map`-excluding walk, reused verbatim (body and comment) from
// assert-no-node-polyfills.mjs / assert-no-test-harness-in-dist.mjs.
// ---------------------------------------------------------------------------
/**
 * `.map` files are DELIBERATELY excluded: a source map embeds the original
 * sources of the whole graph, including files that merely DISCUSS a marker
 * or a DB-opening symbol in a comment, so scanning them would report prose
 * as evidence either way. What ships and executes is the `.js`/`.html`/
 * `.css`, which is what this scan covers.
 * @param {string} dir @returns {string[]}
 */
function walkDist(dir) {
	/** @type {string[]} */
	const out = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			out.push(...walkDist(full));
			continue;
		}
		if (entry.name.endsWith('.map')) continue;
		if (/\.(js|mjs|cjs|html|css)$/.test(entry.name)) out.push(full);
	}
	return out;
}

// ---------------------------------------------------------------------------
// Marker derivation — the heart of the check. Derived from the value ACTUALLY
// SHIPPED (VOTETORRENT_SCHEMA_SQL, imported above in this Node process),
// never from a second hand-maintained list that could drift.
//
// Markers are maximal runs of characters drawn only from ASCII letters,
// digits, underscore and space, of at least forty characters. Restricting
// markers to that character class is deliberate: such a run is emitted
// byte-identically inside the bundle's JavaScript string literal with no
// escaping ambiguity (no quote, backslash, newline or non-ASCII byte that a
// minifier's string-literal encoder might re-escape differently), so a
// marker miss means the text is genuinely absent rather than merely escaped
// differently.
// ---------------------------------------------------------------------------
const MARKER_CHARSET_RUN_RE = /[A-Za-z0-9_ ]{40,}/g;
const MIN_MARKERS = 8;

/**
 * @param {string} schema
 * @returns {string[]}
 */
function deriveMarkers(schema) {
	const runs = schema.match(MARKER_CHARSET_RUN_RE) ?? [];
	if (runs.length < MIN_MARKERS) {
		fail(
			`marker derivation itself broke — found only ${runs.length} qualifying run(s) of >=40 ` +
				`ASCII letter/digit/underscore/space characters in VOTETORRENT_SCHEMA_SQL, need at least ${MIN_MARKERS}.`,
		);
	}
	// Sample evenly across the whole run list (including the final third) so
	// markers are not clustered at the string's start.
	/** @type {string[]} */
	const markers = [];
	const step = runs.length / MIN_MARKERS;
	for (let i = 0; i < MIN_MARKERS; i++) {
		const idx = Math.min(runs.length - 1, Math.floor(i * step));
		markers.push(runs[idx]);
	}
	return markers;
}

const MARKERS = deriveMarkers(VOTETORRENT_SCHEMA_SQL);
ok(`derived ${MARKERS.length} marker(s) from the live VOTETORRENT_SCHEMA_SQL value (${VOTETORRENT_SCHEMA_SQL.length} chars, ${runsCount()} qualifying run(s) available).`);

/** @returns {number} */
function runsCount() {
	return (VOTETORRENT_SCHEMA_SQL.match(MARKER_CHARSET_RUN_RE) ?? []).length;
}

// ---------------------------------------------------------------------------
// Positive control, first, before the build: prove the marker matcher fires
// on a fixture containing every derived marker.
// ---------------------------------------------------------------------------
const ALL_MARKERS_FIXTURE = MARKERS.join(' | ');
const positiveMatchCount = MARKERS.filter((m) => ALL_MARKERS_FIXTURE.includes(m)).length;
if (positiveMatchCount !== MARKERS.length) {
	fail(
		`positive control failed — the all-markers fixture matched only ${positiveMatchCount}/${MARKERS.length} ` +
			'derived markers. The matcher cannot be trusted to scan the real bundle.',
	);
}
ok(`positive control: the all-markers fixture matched every one of ${MARKERS.length} derived marker(s).`);

// ---------------------------------------------------------------------------
// Negative control, and it is the discriminating one: a fixture containing
// ONLY the schema's own short first line must match NONE of the derived
// markers. This is the guard against a vacuous check: if the minifier ever
// constant-folded a short prefix into the bundle while tree-shaking the real
// ~132 KB string away, a check greping for the first line would pass on an
// engine that never actually shipped.
// ---------------------------------------------------------------------------
const FIRST_LINE_ONLY_FIXTURE = 'declare schema main';
const negativeMatchCount = MARKERS.filter((m) => FIRST_LINE_ONLY_FIXTURE.includes(m)).length;
if (negativeMatchCount !== 0) {
	fail(
		`negative control failed — the schema's-first-line-only fixture matched ${negativeMatchCount} ` +
			'derived marker(s). The matcher is not discriminating between the real schema and its short prefix.',
	);
}
ok(
	`negative control: the schema's-first-line-only fixture matched 0/${MARKERS.length} derived marker(s) — ` +
		'matcher is live and discriminating.',
);

// ---------------------------------------------------------------------------
// DB-opening symbol matcher — D-13's negative half, enforced on the artefact
// that ships. This rung and the tier-1 source scan (test/node/engine-reach.test.mjs)
// are deliberately redundant and cover different failure modes: the tier-1
// scan catches the intent before any build, while this one catches a symbol
// that arrived transitively — for example through a namespace-style import
// someone re-introduced into engine-preflight.js.
// ---------------------------------------------------------------------------
const DB_OPENING_SYMBOL_RE = /\b(initDB|prepareDb|registerDbPlugins|isSchemaInitialized)\b|indexedDB|@quereus\/plugin-indexeddb/;

const DB_SYMBOL_POSITIVE_FIXTURE =
	'import { initDB, prepareDb, registerDbPlugins, isSchemaInitialized } from "x"; const x = indexedDB; const y = "@quereus/plugin-indexeddb";';
if (!DB_OPENING_SYMBOL_RE.test(DB_SYMBOL_POSITIVE_FIXTURE)) {
	fail('DB-opening symbol matcher is inert — the planted positive-control fixture did not match any of its five terms.');
}
ok('DB-opening symbol matcher: positive control matched.');

// Benign control 1: an identifier that merely CONTAINS one of the four
// word-bounded terms as a substring must not fire the word-bounded branch of
// the matcher (the plain "indexedDB"/"@quereus/plugin-indexeddb" branches are
// deliberately substring matchers and are not exercised by this fixture).
const DB_SYMBOL_BENIGN_SUBSTRING_FIXTURE = 'const initDBValue = 1; const prepareDbConfigDefaults = {};';
if (DB_OPENING_SYMBOL_RE.test(DB_SYMBOL_BENIGN_SUBSTRING_FIXTURE)) {
	fail('DB-opening symbol matcher is indiscriminate — it fired on an identifier that merely contains a banned word as a substring.');
}
ok('DB-opening symbol matcher: benign control (word-as-substring identifiers) did not fire.');

// Benign control 2: a truly unrelated benign fixture with none of the words at all.
const TRULY_UNRELATED_BENIGN_FIXTURE = 'const total = a + b; export function sum(x, y) { return x + y; }';
if (DB_OPENING_SYMBOL_RE.test(TRULY_UNRELATED_BENIGN_FIXTURE)) {
	fail('DB-opening symbol matcher is indiscriminate — it fired on ordinary, unrelated source.');
}
ok('DB-opening symbol matcher: benign control (unrelated source) did not fire.');

// ---------------------------------------------------------------------------
// Build.
// ---------------------------------------------------------------------------
const viteBin = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
if (!existsSync(viteBin)) {
	fail(`vite binary not found at ${viteBin} — run \`yarn install\` first.`);
}

const buildResult = spawnSync(process.execPath, [viteBin, 'build'], {
	encoding: 'utf8',
	cwd: ROOT,
});
if (buildResult.status !== 0) {
	fail(`vite build exited ${buildResult.status}.\n--- captured output ---\n${buildResult.stdout ?? ''}\n${buildResult.stderr ?? ''}`);
}
ok('vite build exited 0.');

if (!existsSync(DIST_ASSETS)) {
	fail(`${DIST_ASSETS} does not exist — the build did not emit the expected assets directory.`);
}

const emittedFiles = walkDist(DIST);
const emittedJs = emittedFiles.filter((f) => f.endsWith('.js'));
if (emittedJs.length === 0) {
	fail(`no .js files found under ${DIST} — the build emitted nothing to scan.`);
}

let concatenatedJs = '';
for (const filePath of emittedJs) {
	concatenatedJs += readFileSync(filePath, 'utf8');
}

// ---------------------------------------------------------------------------
// Real scan, positive half: every derived marker must be present in the
// emitted JavaScript.
// ---------------------------------------------------------------------------
const missingMarkers = [];
MARKERS.forEach((marker, index) => {
	if (!concatenatedJs.includes(marker)) {
		missingMarkers.push({ index, marker });
	}
});
if (missingMarkers.length > 0) {
	fail(
		`${missingMarkers.length}/${MARKERS.length} derived marker(s) missing from the emitted JavaScript:\n` +
			missingMarkers.map(({ index }) => `  - marker at derivation index ${index}`).join('\n'),
	);
}
ok(`all ${MARKERS.length} derived marker(s) found in the emitted JavaScript (${emittedJs.length} .js file(s), ${concatenatedJs.length} chars concatenated).`);

// ---------------------------------------------------------------------------
// Real scan, negative half: zero DB-opening symbols in the emitted
// JavaScript.
// ---------------------------------------------------------------------------
const dbSymbolMatch = concatenatedJs.match(DB_OPENING_SYMBOL_RE);
if (dbSymbolMatch) {
	fail(`the emitted JavaScript contains a DB-opening symbol: "${dbSymbolMatch[0]}".`);
}
ok('zero DB-opening symbols found in the emitted JavaScript.');

ok('D-13 proven: the schema reaches the built bundle and no DB-opening symbol does.');
process.exit(0);
