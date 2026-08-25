#!/usr/bin/env node
/**
 * assert-no-node-polyfills.mjs — the D-19 / T-50-04-03 purity gate.
 *
 * Proves the dashboard's Vite build never pulls a Node builtin (or a polyfill for one)
 * into the browser bundle. Runs its own positive control FIRST — a purity gate that
 * cannot detect impurity is worse than no gate.
 *
 * Standalone Node script, no new dependencies.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const ROOT = process.cwd();
const DIST_ASSETS = path.join(ROOT, 'dist', 'assets');

/** Denylist matcher shared by the positive control and the real bundle scan. */
const NODE_TOKEN_RE = /\bnode:(crypto|fs|path|buffer|stream|util|os|child_process)\b/;
const REQUIRE_TOKEN_RE = /require\(\s*["'](crypto|fs|path|buffer|stream)["']\s*\)/;

/** @param {string} message */
function fail(message) {
	process.stderr.write(`[assert-no-node-polyfills] FAIL: ${message}\n`);
	process.exit(1);
}

/** @param {string} message */
function ok(message) {
	process.stdout.write(`[assert-no-node-polyfills] OK: ${message}\n`);
}

// ---------------------------------------------------------------------------
// 1. Positive control — the matcher must be able to detect impurity, or the
//    gate proves nothing. Run this BEFORE touching the build.
// ---------------------------------------------------------------------------
const POSITIVE_CONTROL_FIXTURE = 'import c from "node:crypto";';
if (!NODE_TOKEN_RE.test(POSITIVE_CONTROL_FIXTURE)) {
	fail(
		'matcher is inert — the node:crypto positive-control fixture did not match. ' +
			'This gate cannot detect a real regression until the matcher is fixed.',
	);
}
ok('positive control matched the node:crypto fixture — matcher is live.');

// ---------------------------------------------------------------------------
// 2. Spawn `vite build` and capture output.
// ---------------------------------------------------------------------------
const viteBin = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
if (!existsSync(viteBin)) {
	fail(`vite binary not found at ${viteBin} — run \`yarn install\` first.`);
}

const buildResult = spawnSync(process.execPath, [viteBin, 'build'], {
	encoding: 'utf8',
	cwd: ROOT,
});

const buildOutput = `${buildResult.stdout ?? ''}\n${buildResult.stderr ?? ''}`;

if (buildResult.status !== 0) {
	fail(`vite build exited ${buildResult.status}.\n--- captured output ---\n${buildOutput}`);
}
ok('vite build exited 0.');

// ---------------------------------------------------------------------------
// 3. Vite's own externalization warning is a direct tell that a Node builtin
//    reached the browser graph.
// ---------------------------------------------------------------------------
if (buildOutput.includes('has been externalized for browser compatibility')) {
	fail(
		'vite build output contains "has been externalized for browser compatibility" — ' +
			'a Node builtin reached the browser module graph.\n' +
			`--- captured output ---\n${buildOutput}`,
	);
}
ok('no "externalized for browser compatibility" warning in build output.');

// ---------------------------------------------------------------------------
// 4. Scan every emitted bundle for a Node builtin token or a bare require() of one.
// ---------------------------------------------------------------------------
if (!existsSync(DIST_ASSETS)) {
	fail(`${DIST_ASSETS} does not exist — the build did not emit the expected assets directory.`);
}

const emittedFiles = readdirSync(DIST_ASSETS).filter((f) => f.endsWith('.js'));
if (emittedFiles.length === 0) {
	fail(`no .js files found under ${DIST_ASSETS} — the build emitted nothing to scan.`);
}

let totalBytes = 0;
for (const file of emittedFiles) {
	const filePath = path.join(DIST_ASSETS, file);
	totalBytes += statSync(filePath).size;
	const contents = readFileSync(filePath, 'utf8');

	const nodeTokenMatch = contents.match(NODE_TOKEN_RE);
	if (nodeTokenMatch) {
		fail(`${filePath} contains the Node builtin token "${nodeTokenMatch[0]}".`);
	}

	const requireMatch = contents.match(REQUIRE_TOKEN_RE);
	if (requireMatch) {
		fail(`${filePath} contains a bare require() of a Node builtin: "${requireMatch[0]}".`);
	}
}
ok(`scanned ${emittedFiles.length} emitted file(s) under dist/assets — no Node builtin token found.`);

// ---------------------------------------------------------------------------
// 5. The dashboard's own manifest must not declare a polyfill package.
// ---------------------------------------------------------------------------
const DENYLISTED_DEPS = [
	'buffer',
	'process',
	'crypto-browserify',
	'stream-browserify',
	'path-browserify',
	'readable-stream',
	'node-stdlib-browser',
	'vite-plugin-node-polyfills',
	'events',
	'util',
	'assert',
];

const manifest = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const declaredDeps = {
	...(manifest.dependencies ?? {}),
	...(manifest.devDependencies ?? {}),
};

const foundPolyfillDeps = DENYLISTED_DEPS.filter((dep) => dep in declaredDeps);
if (foundPolyfillDeps.length > 0) {
	fail(`package.json declares denylisted polyfill dependency(ies): ${foundPolyfillDeps.join(', ')}.`);
}
ok('package.json declares no Node-polyfill dependency.');

// ---------------------------------------------------------------------------
// 6. Secrets hygiene (T-50-04-02) — no .env* file, no import.meta.env.VITE_ read.
//    This app has no server, no session and no secret to hold.
// ---------------------------------------------------------------------------
/** @param {string} dir */
function walk(dir) {
	/** @type {string[]} */
	const out = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name === 'node_modules' || entry.name === 'dist') continue;
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			out.push(...walk(full));
		} else {
			out.push(full);
		}
	}
	return out;
}

const appFiles = walk(ROOT).filter((f) => {
	const base = path.basename(f);
	return base.startsWith('.env');
});
if (appFiles.length > 0) {
	fail(`found .env* file(s) under ${ROOT}: ${appFiles.join(', ')}. This app has no secret to hold.`);
}
ok('no .env* file found under the workspace member.');

const srcDir = path.join(ROOT, 'src');
if (existsSync(srcDir)) {
	const srcFiles = walk(srcDir);
	for (const f of srcFiles) {
		const contents = readFileSync(f, 'utf8');
		if (contents.includes('import.meta.env.VITE_')) {
			fail(`${f} reads "import.meta.env.VITE_" — a bundled VITE_* value would be public.`);
		}
	}
	ok(`scanned ${srcFiles.length} file(s) under src/ — no import.meta.env.VITE_ read found.`);
}

// ---------------------------------------------------------------------------
// 7. Informational — module count and gzip total, next to the spike-075 bar
//    (654 modules / 551 KB gzip). Does not gate.
// ---------------------------------------------------------------------------
const moduleCountMatch = buildOutput.match(/transforming\.\.\.\s*\n?.*?(\d+)\s+modules? transformed/s);
const moduleCount = moduleCountMatch ? moduleCountMatch[1] : 'unknown';
const gzipKb = (totalBytes / 1024).toFixed(0);
process.stdout.write(
	`[assert-no-node-polyfills] INFO: modules transformed = ${moduleCount}, ` +
		`emitted dist/assets size = ${gzipKb} KB (raw, not gzip) — spike-075 bar: 654 modules / 551 KB gzip.\n`,
);

ok('all checks passed — the bundle needs zero Node polyfills.');
process.exit(0);
