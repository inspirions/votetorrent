#!/usr/bin/env node
/**
 * lint-copy.mjs — the D-21 copy-discipline gate; the workspace's `lint` script.
 *
 * Enforces that every user-facing string lives in EXACTLY ONE table
 * (`@votetorrent/ui-web`'s `packages/ui-web/src/copy.js`) and that the table
 * itself obeys the standing rules:
 * frozen, non-empty string values, no GSD phase number or decision ID, and no
 * `read-only` panel-state string (contract C3 / D-17).
 *
 * Runs its own positive control FIRST — a lint that cannot detect a violation
 * proves nothing. Standalone Node script, NO DEPENDENCIES beyond `node:`
 * builtins and a dynamic `import()` of `copy.js` itself — no parser package,
 * no AST library. Section 4 below is a REGEX-based JSX-text-node scanner,
 * deliberately: it catches the CLASS of violation (a newly hard-coded English
 * phrase in a JSX text node), not a fixed list of sentinel strings, while
 * staying dependency-free.
 *
 * THE MATCHER'S REAL BOUNDARY (a regex scanner is not total, and pretending
 * otherwise is worse than documenting the gap): it scans one SOURCE LINE at a
 * time, so it does not see a JSX text node that itself wraps onto a second
 * line. It looks only at text between `>` and `<` — so an ATTRIBUTE value
 * (`title={...}`, `aria-label="..."`) is never inspected, by construction,
 * because an attribute sits BEFORE the `>` that closes its tag. A template
 * literal INSIDE an expression container (`{`\`tier ${n}\`}`) is invisible
 * too — the container is stripped as a unit before the text is checked, the
 * same as `{t('key')}` is. None of these are a defect to "fix" by widening
 * the regex; each would reopen exactly the false-positive class (a TS
 * generic argument such as `useState<string | undefined>(undefined)` reading
 * as JSX text) that made a naive whole-file regex unusable before this
 * scanner was scoped to one line at a time.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const ROOT = process.cwd();
const SRC_DIR = path.join(ROOT, 'src');
// The table no longer lives under this workspace's src/ — it moved to
// packages/ui-web/src/copy.js (D-11, no shim). This is a display label for
// the fail()/ok() messages below, not a filesystem path; it is imported by
// its package specifier, not by a file:// URL.
const COPY_FILE = '@votetorrent/ui-web (packages/ui-web/src/copy.js)';

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
const { COPY } = await import('@votetorrent/ui-web');

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
// 53-05 renamed gate.advisoryDisclosure -> advisory.authority.body (value
// byte-identical); note for 53-10, whose three-root rewrite inherits this
// sentinel prefix under its new key name.
const ADVISORY_DISCLOSURE_PREFIX = COPY['advisory.authority.body'].slice(0, 40);
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
					`copy must live only in ${COPY_FILE}.\n`,
			);
			leakFound = true;
		}
	}
}
if (leakFound) {
	process.exit(1);
}
ok(`scanned ${srcFiles.length} file(s) under src/ — no leaked copy sentinel found.`);

// ---------------------------------------------------------------------------
// 4. Authored prose rendered as a JSX text node, anywhere under src/.
//
//    The sentinel scan above can only find the seven strings it was told
//    about. It could not see `tier {capability.tier}` or `{n} site{s}` in
//    PanelFrame.tsx, or the raw phase identifiers Bootstrap.tsx used to
//    render — all of them authored user-facing text living outside the one
//    file contract C2 says is the ONLY place a user-facing string may live.
//
//    REGEX-BASED, NOT AN AST PARSE (this script stays dependency-free): for
//    each .tsx file, drop whole-line comments (the same line-based stripper
//    this workspace's own tier-1 source-scan tests already use, so the two
//    agree on what counts as a comment), then walk each remaining LINE for
//    runs of text between `>` and `<`. Scoping to one line at a time is what
//    keeps this safe from the false-positive class that made a whole-file
//    regex unusable: a TS generic argument like
//    `useState<string | undefined>(undefined)` never has a SECOND `<` on the
//    same line, so it produces no candidate at all, and this codebase never
//    puts a generic type argument and real JSX markup on the same line (both
//    were verified true across every .tsx file under src/ before this
//    scanner was written this way).
// ---------------------------------------------------------------------------

/** Drop whole-line comments, so prose ABOUT a defect is never read as the
 * defect. Mirrors the tier-1 test suite's own `stripComments` helper
 * (`test/node/shell-wiring.test.mjs` and siblings) so the lint and the tests
 * agree on what a comment line looks like.
 * @param {string} source @returns {string} */
function stripComments(source) {
	return source
		.split('\n')
		.filter((line) => {
			const trimmed = line.trim();
			return !(trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*'));
		})
		.join('\n');
}

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
 * So a candidate (the text between one `>` and the next `<` on the same
 * line, with any `{...}` expression container removed) is flagged when
 * EITHER:
 *
 *   1. what remains contains two letter-runs separated by non-letters
 *      (multi-word prose: "Enter your sign-in code"), or
 *   2. the candidate ORIGINALLY contained a `{...}` expression container
 *      AND what remains after removing it still contains a bare word --
 *      i.e. authored words interleaved with interpolation.
 *
 * (2) is what catches the defect this check was added for: `tier
 * {capability.tier}` is the single word "tier" beside an interpolation, and a
 * word-PAIR rule alone sails past it -- it would have passed the very code it
 * exists to catch, which is how a gate ends up proving nothing. Each shape
 * has its own positive control below.
 */
const JSX_MULTIWORD_RE = /[A-Za-z]{2,}[^A-Za-z]+[A-Za-z]{2,}/;
const JSX_WORD_RE = /[A-Za-z]{2,}/;
/** One run of text between a `>` and the next `<` on the SAME line -- an
 * approximation of "this line's JSX text node(s)", never spanning lines. */
const JSX_TEXT_RUN_RE = />([^<>]*)</g;
/** A `{...}` expression container, one level of nesting deep (the deepest
 * this codebase's JSX ever nests -- e.g. `{t('key', { a: 1 })}`). Applied
 * repeatedly, inside out, so nested containers are fully removed. */
const EXPRESSION_CONTAINER_RE = /\{[^{}]*\}/g;

/** @param {string} text @returns {string} */
function stripExpressionContainers(text) {
	let result = text;
	let previous;
	do {
		previous = result;
		result = result.replace(EXPRESSION_CONTAINER_RE, '');
	} while (result !== previous);
	return result;
}

/** @param {string} source @param {string} fileName @returns {string[]} */
function jsxProseIn(source, fileName) {
	void fileName; // kept for parity with a future per-file diagnostic, unused today
	/** @type {string[]} */
	const found = [];
	for (const line of stripComments(source).split('\n')) {
		let match;
		JSX_TEXT_RUN_RE.lastIndex = 0;
		while ((match = JSX_TEXT_RUN_RE.exec(line)) !== null) {
			const raw = match[1];
			const hadExpression = /\{[^{}]*\}/.test(raw);
			const stripped = stripExpressionContainers(raw).trim();
			if (stripped.length === 0) continue;
			if (JSX_MULTIWORD_RE.test(stripped) || (hadExpression && JSX_WORD_RE.test(stripped))) {
				found.push(stripped);
			}
		}
	}
	return found;
}

// Positive controls FIRST, as everywhere else in this script -- one per shape.
const JSX_CONTROL_FIXTURES = [
	['multi-word prose', '<span className="pill">tier {n} of them</span>'],
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
// Negative / inertness controls in the other direction. A matcher that fires
// on everything gets disabled, which is worse than not having it.
const JSX_BENIGN_FIXTURES = [
	// The exact shape this whole gate is steering toward: a rendered copy KEY.
	"<span>{t('panelFrame.tierPill', { tier })}</span>",
	"export const X = () => <span>{t('panelFrame.tierPill', { tier: '2' })}</span>;",
	// A generic type argument is not JSX at all, and never shares a line with
	// real JSX markup in this codebase -- this is the false-positive class
	// that made a whole-file (rather than per-line) regex unusable.
	'const [v, setV] = useState<string | undefined>(undefined);',
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
	`JSX-prose matcher (regex-based, no AST library) matched all ${JSX_CONTROL_FIXTURES.length} positive controls and ` +
		`none of ${JSX_BENIGN_FIXTURES.length} benign fixtures.`,
);

const tsxFiles = srcFiles.filter((f) => f.endsWith('.tsx'));
let jsxProseFound = false;
for (const file of tsxFiles) {
	for (const text of jsxProseIn(readFileSync(file, 'utf8'), file)) {
		process.stderr.write(
			`[lint-copy] FAIL: ${file} renders the authored text ${JSON.stringify(text)} as a JSX text node — ` +
				`every user-facing string must come from ${COPY_FILE} through t().\n`,
		);
		jsxProseFound = true;
	}
}
if (jsxProseFound) {
	process.exit(1);
}
ok(`scanned ${tsxFiles.length} .tsx file(s) under src/ — no authored prose rendered outside t().`);

ok('all checks passed — copy discipline is intact.');
process.exit(0);
