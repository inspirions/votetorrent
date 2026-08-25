#!/usr/bin/env node
/**
 * lint-copy.mjs — the D-21 copy-discipline gate; the workspace's `lint` script.
 *
 * Enforces that every user-facing string lives in EXACTLY ONE file
 * (`src/i18n/copy.js`) and that the table itself obeys the standing rules:
 * frozen, non-empty string values, no GSD phase number or decision ID, and no
 * `read-only` panel-state string (contract C3 / D-17).
 *
 * Runs its own positive control FIRST — a lint that cannot detect a violation
 * proves nothing. Standalone Node script, no new dependencies.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const ROOT = process.cwd();
const SRC_DIR = path.join(ROOT, 'src');
const COPY_FILE = path.join(SRC_DIR, 'i18n', 'copy.js');

/** @param {string} message */
function fail(message) {
	process.stderr.write(`[lint-copy] FAIL: ${message}\n`);
	process.exit(1);
}

/** @param {string} message */
function ok(message) {
	process.stdout.write(`[lint-copy] OK: ${message}\n`);
}

// ---------------------------------------------------------------------------
// 1. Positive control — run the sentinel matcher over a fixture BEFORE
//    scanning real files.
// ---------------------------------------------------------------------------
const SENTINEL_STRINGS = [
	'answered by the database',
	'simulated scope set',
	'Redeem Code',
	'Forget this network',
	'Reveal denied panels',
	'More options',
	'Refresh snapshot',
];

const POSITIVE_CONTROL_FIXTURE = 'const x = "simulated scope set";';
const sentinelHit = SENTINEL_STRINGS.some((s) => POSITIVE_CONTROL_FIXTURE.includes(s));
if (!sentinelHit) {
	fail(
		'matcher is inert — the "simulated scope set" positive-control fixture did not match. ' +
			'This gate cannot detect a real regression until the matcher is fixed.',
	);
}
ok('positive control matched the sentinel fixture — matcher is live.');

// ---------------------------------------------------------------------------
// 2. Import COPY and assert its own discipline.
// ---------------------------------------------------------------------------
const { COPY } = await import(`file://${COPY_FILE}`);

if (!Object.isFrozen(COPY)) {
	fail(`${COPY_FILE} exports a COPY object that is not frozen.`);
}

const DECISION_ID_RE = /\bD-\d{2}\b/;
const PHASE_NUMBER_RE = /\bPhase\s+\d+\b/;
const READ_ONLY_RE = /read-only/i;

for (const [key, value] of Object.entries(COPY)) {
	if (typeof value !== 'string' || value.length === 0) {
		fail(`COPY.${key} must be a non-empty string, got: ${JSON.stringify(value)}`);
	}
	if (DECISION_ID_RE.test(value)) {
		fail(`COPY.${key} contains a GSD decision ID: "${value}"`);
	}
	if (PHASE_NUMBER_RE.test(value)) {
		fail(`COPY.${key} contains a GSD phase number: "${value}"`);
	}
	if (READ_ONLY_RE.test(value)) {
		fail(`COPY.${key} matches /read-only/i (contract C3 / D-17 forbids this): "${value}"`);
	}
}
ok(`COPY is frozen and every one of its ${Object.keys(COPY).length} values passes the discipline checks.`);

// ---------------------------------------------------------------------------
// 3. Walk src/ (except copy.js itself) and fail if a binding sentinel string
//    has leaked outside the copy table. This is what makes "copy lives in ONE
//    place" enforceable rather than aspirational as later plans add screens.
// ---------------------------------------------------------------------------
const ADVISORY_DISCLOSURE_PREFIX = COPY['gate.advisoryDisclosure'].slice(0, 40);
const scanSentinels = [...SENTINEL_STRINGS, ADVISORY_DISCLOSURE_PREFIX];

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

const srcFiles = walk(SRC_DIR).filter((f) => f !== COPY_FILE);
let leakFound = false;
for (const file of srcFiles) {
	const contents = readFileSync(file, 'utf8');
	for (const sentinel of scanSentinels) {
		if (contents.includes(sentinel)) {
			process.stderr.write(
				`[lint-copy] FAIL: ${file} contains the copy-table sentinel string "${sentinel}" — ` +
					`copy must live only in ${path.relative(ROOT, COPY_FILE)}.\n`,
			);
			leakFound = true;
		}
	}
}
if (leakFound) {
	process.exit(1);
}
ok(`scanned ${srcFiles.length} file(s) under src/ (excluding copy.js) — no leaked copy sentinel found.`);

ok('all checks passed — copy discipline is intact.');
process.exit(0);
