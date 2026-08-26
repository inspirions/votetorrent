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
import ts from 'typescript';

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

// ---------------------------------------------------------------------------
// 4. Authored prose rendered as a JSX text node, anywhere under src/.
//
//    The sentinel scan above can only find the seven strings it was told
//    about. It could not see `tier {capability.tier}` or `{n} site{s}` in
//    PanelFrame.tsx, or the raw phase identifiers Bootstrap.tsx used to
//    render — all of them authored user-facing text living outside the one
//    file contract C2 says is the ONLY place a user-facing string may live.
//
//    This uses TypeScript's OWN parser (already a devDependency of this
//    workspace — no new dependency) rather than a regex, because a regex
//    cannot tell a JSX text node from the `>`...`<` of a generic type
//    argument: `useState<string | undefined>(undefined)` looks exactly like
//    JSX text to a matcher and produced nothing but false positives. A lint
//    that cries wolf gets disabled, which is worse than not having it.
// ---------------------------------------------------------------------------

/**
 * WHAT COUNTS AS AUTHORED PROSE IN A JSX TEXT NODE, and why it is not simply
 * "any word".
 *
 * The panels deliberately label rows with SCHEMA COLUMN NAMES -- `<dt>Hash</dt>`,
 * `<dt>PrimaryAuthorityId</dt>` -- because this dashboard's whole reporting
 * discipline is "table names, column names and integer counts only". Those are
 * identifiers, not translatable prose, and a rule that banned every word would
 * demand they be moved into the copy table, which is the wrong answer.
 *
 * So a JSX text node is flagged when EITHER:
 *
 *   1. it contains two letter-runs separated by non-letters (multi-word
 *      prose: "Enter your sign-in code"), or
 *   2. it sits in the same element as a `{...}` expression -- i.e. authored
 *      words interleaved with interpolation.
 *
 * (2) is what catches the defect this check was added for. JSX splits a text
 * node at every expression container, so `tier {capability.tier}` parses as
 * the single JsxText `"tier "`, and `{n} site{n === 1 ? '' : 's'}` as the
 * single JsxText `" site"`. A word-PAIR rule alone sails past both -- it would
 * have passed the very code it exists to catch, which is how a gate ends up
 * proving nothing. Each shape has its own positive control below.
 */
const JSX_MULTIWORD_RE = /[A-Za-z]{2,}[^A-Za-z]+[A-Za-z]{2,}/;
const JSX_WORD_RE = /[A-Za-z]{2,}/;

/** @param {string} source @param {string} fileName @returns {string[]} */
function jsxProseIn(source, fileName) {
	const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
	/** @type {string[]} */
	const found = [];
	/** @param {import('typescript').Node} node */
	function visit(node) {
		if (ts.isJsxText(node)) {
			const text = node.text.trim();
			const parent = node.parent;
			const siblings = parent && 'children' in parent ? /** @type {any} */ (parent).children ?? [] : [];
			const mixedWithExpression = [...siblings].some(
				(/** @type {import('typescript').Node} */ sibling) =>
					ts.isJsxExpression(sibling) && sibling.expression !== undefined,
			);
			if (text.length > 0 && (JSX_MULTIWORD_RE.test(text) || (mixedWithExpression && JSX_WORD_RE.test(text)))) {
				found.push(text);
			}
		}
		ts.forEachChild(node, visit);
	}
	visit(sourceFile);
	return found;
}

// Positive controls FIRST, as everywhere else in this script -- one per shape.
const JSX_CONTROL_FIXTURES = [
	['multi-word prose', 'export const X = () => <span className="pill">tier and sites</span>;'],
	['prose split by an interpolation', 'export const X = () => <span>tier {capability.tier}</span>;'],
	['pluralisation suffix beside two interpolations', "export const X = () => <span>{n} site{n === 1 ? '' : 's'}</span>;"],
];
for (const [label, fixture] of JSX_CONTROL_FIXTURES) {
	if (jsxProseIn(fixture, 'control.tsx').length === 0) {
		fail(
			`matcher is inert — the "${label}" JSX positive-control fixture did not match. ` +
				'This gate cannot detect a real regression until the matcher is fixed.',
		);
	}
}
// Inertness controls in the other direction. A matcher that fires on
// everything gets disabled, which is worse than not having it.
const JSX_BENIGN_FIXTURES = [
	// A generic type argument is not JSX at all -- this is the false positive
	// that makes a regex-based version of this check unusable.
	'const [v, setV] = useState<string | undefined>(undefined);',
	// A rendered copy KEY, which is the shape this whole gate is steering toward.
	"export const X = () => <span>{t('panelFrame.tierPill', { tier: '2' })}</span>;",
	// A bare glyph.
	'export const X = () => <span aria-hidden="true">⋮</span>;',
	// A schema column name as a row label, alone in its element -- deliberate,
	// and not translatable prose.
	'export const X = () => <dt>PrimaryAuthorityId</dt>;',
];
for (const benign of JSX_BENIGN_FIXTURES) {
	const hits = jsxProseIn(benign, 'benign.tsx');
	if (hits.length > 0) {
		fail(`matcher is indiscriminate — it flagged ${JSON.stringify(hits)} in the benign fixture ${JSON.stringify(benign)}.`);
	}
}
ok(
	`JSX-prose matcher matched all ${JSX_CONTROL_FIXTURES.length} positive controls and none of ` +
		`${JSX_BENIGN_FIXTURES.length} benign fixtures.`,
);

const tsxFiles = srcFiles.filter((f) => f.endsWith('.tsx'));
let jsxProseFound = false;
for (const file of tsxFiles) {
	for (const text of jsxProseIn(readFileSync(file, 'utf8'), file)) {
		process.stderr.write(
			`[lint-copy] FAIL: ${file} renders the authored text ${JSON.stringify(text)} as a JSX text node — ` +
				`every user-facing string must come from ${path.relative(ROOT, COPY_FILE)} through t().\n`,
		);
		jsxProseFound = true;
	}
}
if (jsxProseFound) {
	process.exit(1);
}
ok(`parsed ${tsxFiles.length} .tsx file(s) under src/ — no authored prose rendered outside t().`);

ok('all checks passed — copy discipline is intact.');
process.exit(0);
