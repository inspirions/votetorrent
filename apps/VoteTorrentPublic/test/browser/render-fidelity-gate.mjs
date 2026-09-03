#!/usr/bin/env node
/**
 * render-fidelity-gate.mjs — the browser-tier proof that the public election
 * page RENDERS what 54-06's reads return, against a database seeded with real
 * rows (54-16 Task 3; D-11, D-14, D-18, D-19).
 *
 * WHY THIS FILE EXISTS AT ALL, which is the thing a later reader will get
 * wrong first. Every rung below could be written as a source scan, and every
 * one of those scans would be worthless. This repository has shipped an
 * 84-character code that clipped silently and an entire screen with no styling
 * applied, both past green gates, because those gates asserted PRESENCE —
 * a class attribute is in the markup, a component is in the tree — rather than
 * RENDERING. Presence is not rendering. A computed `border-top-style`, a
 * measured `scrollWidth`, and the exact string sitting in a `td` are the only
 * evidence that a reader would actually experience what the CSS declares, and
 * none of the three can be obtained without a browser holding a real layout.
 *
 * WHAT IT MEASURES, and against what. The harness's
 * `?fixture=public-surface` branch seeds a real browser-side database and
 * mounts the shell with NO injected election, so the page under measurement is
 * produced by the genuine read path. The harness then publishes the FIXTURE's
 * own exported values on `__UI_GATE__.fixture`. Every data-derived expectation
 * below is read from that channel — this file hard-codes no registrant name,
 * no district, no marker and no release count. The three column headings are
 * the one exception and they are not fixture data: the UI spec records them as
 * the single place a raw schema identifier renders verbatim, so they are the
 * spec's literals, asserted here as literals.
 *
 * THE DIVISION OF LABOUR WITH 54-18, recorded so that plan does not duplicate
 * this one. `--prove-matchers` proves every COMPARATOR in this file can
 * report failure, by running each against a synthetic input built to violate
 * it. It deliberately does NOT rebuild a mutated product: 53-D20's rule is
 * that a build-level negative control REBUILDS rather than injecting at
 * runtime, and that a dist-level control must mutate a symbol in an
 * object-literal property-key position because the minifier renames bare
 * local bindings. Those controls belong to `mutations.mjs`, which is 54-18's
 * file. This file proves the comparators can fail; 54-18 proves the built
 * product can fail them. 54-18 also owns rehoming these rungs into the shared
 * runner, `run-ui-gates.mjs` — until then this script is standalone and
 * self-running so it is verifiable now.
 *
 * WHAT IS COPIED FROM `run-ui-gates.mjs` RATHER THAN INVENTED: the Playwright
 * import (the full package, never the core-only sibling, never a named browser
 * channel, never a hardcoded system-Chrome path — that path does not exist on
 * the CI image), `chromium.launch({ headless: true })`, the static server
 * (`lib/serve-dist.mjs`, not a second one), the dist walk that resolves the
 * built entry by SEARCH rather than by predicting the bundler's output path
 * algebra, the frozen rung-id registry, and `record(id, passed, detail)`.
 * A rung id may never interpolate a value under test into its own name: a
 * check named after something computed is a check nobody else can invert.
 *
 * PORT POLICY. `5193`, distinct from every port the phase already binds
 * (`5180`/`5181` dev and preview, `5183` the dashboard gate, `5191` the public
 * app's own gate run). Distinct from `5191` specifically so this gate and
 * `test:browser` can run concurrently. A bound port fails the run loudly —
 * `serve-dist.mjs` propagates the listen error rather than picking another.
 *
 * FLAGS:
 *   --skip-build       Reuse an existing `dist-gate/` rather than rebuilding.
 *   --prove-matchers   Run every comparator against a violating input AND
 *                      against a healthy one, and require the first to FAIL
 *                      and the second to PASS. Needs no browser and no build.
 *   --port <n>         Override the bound port.
 * Any other argument exits 2 naming it — an unknown flag must never be
 * silently ignored into a green run.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readdirSync } from 'node:fs';
import { serveDist } from '../../../../packages/ui-web/scripts/lib/serve-dist.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(__dirname, '..', '..');
const GATE_DIST = path.join(APP_DIR, 'dist-gate');
const GATE_ENTRY = 'election-shell-gate.html';
const GATE_CONFIG = 'vite.gate.config.ts';
const FIXTURE_QUERY = 'fixture=public-surface';
const DEFAULT_PORT = 5193;
const LABEL = 'render-fidelity-gate';

/** The narrow viewport the roll rungs measure at. Overflow is only observable
 * when the content genuinely exceeds its container. */
const NARROW_VIEWPORT = Object.freeze({ width: 380, height: 900 });

/**
 * The published column headings, in order. NOT fixture data: 54-UI-SPEC
 * records these as the one place a raw schema identifier renders verbatim
 * rather than through the copy table, so they are the spec's own literals.
 * @type {ReadonlyArray<string>}
 */
const EXPECTED_HEADERS = Object.freeze(['LastName', 'FirstName', 'District']);

/**
 * The key-release fact's own stable per-card identity, as 54-13 renders it.
 * Model vocabulary, not fixture data and not a measured value — the same
 * status as the headings above.
 * @type {string}
 */
const KEYRELEASE_FACT_ID = 'keyrelease';

/**
 * Frozen rung-id registry, module-level, single source of truth. `record()`
 * throws on any id outside this array — the structural enforcement of "never
 * interpolate a value under test into a check's name".
 * @type {ReadonlyArray<string>}
 */
export const RUNG_IDS = Object.freeze([
	'roll-fields-rendered',
	'roll-overflows-not-clips',
	'roll-hides-extrafields-and-superseded',
	'roll-escapes-authority-text',
	'keyrelease-renders-filled-with-nonzero-released',
	'gap-card-style-diverges',
]);

/** @type {Array<{ id: string, passed: boolean, detail: string }>} */
const rungs = [];

/**
 * @param {string} id
 * @param {boolean} passed
 * @param {string} detail
 */
function record(id, passed, detail) {
	if (!RUNG_IDS.includes(id)) {
		throw new Error(`record(): "${id}" is not a member of RUNG_IDS`);
	}
	rungs.push({ id, passed, detail });
}

/** @param {string} message */
function fail(message) {
	process.stderr.write(`[${LABEL}] FAIL: ${message}\n`);
	process.exit(1);
}

// ---------------------------------------------------------------------------
// THE COMPARATORS.
//
// Every one is a PURE function over values already read out of the page, and
// that is not a style preference: it is what lets `--prove-matchers` exercise
// each of them against a violating input with no browser at all. A comparator
// that could only run inside `page.evaluate` could only ever be proven by
// breaking the product, which is a control nobody runs.
//
// Each returns `{ passed, detail }`, and every failing detail NAMES THE
// CONDITION that failed with the values it saw. "The roll looks wrong" is not
// a detail — a rung that cannot say what diverged cannot be acted on.
// ---------------------------------------------------------------------------

/**
 * @typedef {{ passed: boolean, detail: string }} Verdict
 */

/**
 * The roll renders one table, the three published headings in order, one row
 * per seeded registrant, and no empty cell.
 *
 * @param {{ rollCount: number, headers: string[], rowCount: number, cellCount: number, emptyCellCount: number }} m
 * @param {number} expectedRowCount
 * @returns {Verdict}
 */
export function evaluateRollFields(m, expectedRowCount) {
	/** @type {string[]} */
	const failures = [];
	if (m.rollCount !== 1) failures.push(`wrapper count ${m.rollCount} (want 1)`);
	if (m.headers.length !== EXPECTED_HEADERS.length || m.headers.some((h, i) => h !== EXPECTED_HEADERS[i])) {
		failures.push(`headings ${JSON.stringify(m.headers)} (want ${JSON.stringify(EXPECTED_HEADERS)}, in order)`);
	}
	if (m.rowCount !== expectedRowCount) failures.push(`body rows ${m.rowCount} (want ${expectedRowCount})`);
	if (m.emptyCellCount !== 0) failures.push(`${m.emptyCellCount} of ${m.cellCount} cells have empty text`);
	return failures.length === 0
		? { passed: true, detail: `1 wrapper, headings in order, ${m.rowCount} rows, ${m.cellCount} non-empty cells` }
		: { passed: false, detail: failures.join('; ') };
}

/**
 * The roll SCROLLS rather than clipping, and the full production-length value
 * reached the DOM.
 *
 * Four conditions, and the fourth is the decisive one. A wrapper can report
 * `overflow-x: auto` and still be showing a truncated string if something
 * upstream shortened it, so the rung also requires the LONGEST seeded district
 * to be some cell's text as an EXACT match. Not `includes` — a truncation is a
 * substring of the original, so a containment test would pass on exactly the
 * defect this rung exists to catch.
 *
 * @param {{ overflowX: string, scrollWidth: number, clientWidth: number, cells: Array<{ text: string, textOverflow: string, overflow: string }> }} m
 * @param {string} longestDistrict
 * @returns {Verdict}
 */
export function evaluateRollOverflow(m, longestDistrict) {
	/** @type {string[]} */
	const failures = [];
	if (m.overflowX !== 'auto') failures.push(`computed overflow-x is "${m.overflowX}" (want "auto")`);
	if (!(m.scrollWidth > m.clientWidth)) {
		failures.push(`scrollWidth ${m.scrollWidth} is not greater than clientWidth ${m.clientWidth} — nothing overflows, so scrolling is unproven`);
	}
	const clipped = m.cells.filter((c) => c.textOverflow === 'ellipsis' || c.overflow !== 'visible');
	if (clipped.length > 0) {
		const first = clipped[0];
		failures.push(`${clipped.length} cell(s) clip: first has text-overflow "${first.textOverflow}", overflow "${first.overflow}"`);
	}
	if (!m.cells.some((c) => c.text === longestDistrict)) {
		failures.push(`no cell's text is EXACTLY the longest seeded district (${longestDistrict.length} chars) — it was truncated or never rendered`);
	}
	return failures.length === 0
		? {
				passed: true,
				detail: `overflow-x auto, scrollWidth ${m.scrollWidth} > clientWidth ${m.clientWidth}, ${m.cells.length} cells unclipped, longest district (${longestDistrict.length} chars) present verbatim`,
			}
		: { passed: false, detail: failures.join('; ') };
}

/**
 * Neither of the two strings that must never reach a reader appears anywhere
 * in the rendered page.
 *
 * Both are seeded NON-NULL on purpose upstream — an absent column and an
 * unreissued registrant could never fail this, so the assertion would be
 * green and worthless. The count is reported even on success, so a reader can
 * see the scan actually ran over a non-empty document.
 *
 * @param {string} html
 * @param {Array<{ label: string, needle: string }>} needles
 * @returns {Verdict}
 */
export function evaluateHiddenStrings(html, needles) {
	/** @type {string[]} */
	const failures = [];
	for (const { label, needle } of needles) {
		if (typeof needle !== 'string' || needle === '') {
			failures.push(`${label}: the needle itself is absent from the readout — this scan would be inert`);
			continue;
		}
		const occurrences = html.split(needle).length - 1;
		if (occurrences !== 0) failures.push(`${label} appears ${occurrences} time(s) in the rendered page`);
	}
	return failures.length === 0
		? { passed: true, detail: `${needles.length} forbidden string(s) absent from ${html.length} chars of rendered markup` }
		: { passed: false, detail: failures.join('; ') };
}

/**
 * Authority-supplied text carrying a markup element reaches the DOM as TEXT
 * and never as an element.
 *
 * Both halves are needed. Zero elements alone would pass on a page that simply
 * dropped the value; the value present as a cell's exact text alone would pass
 * on a page that also injected it. Together they are the observable form of
 * "the framework's text-node escaping is doing its job".
 *
 * @param {{ injectedElementCount: number, cellTexts: string[] }} m
 * @param {string} hostileValue
 * @returns {Verdict}
 */
export function evaluateEscaping(m, hostileValue) {
	/** @type {string[]} */
	const failures = [];
	if (typeof hostileValue !== 'string' || hostileValue === '') {
		failures.push('the hostile value is absent from the readout — this check would be inert');
	}
	if (m.injectedElementCount !== 0) {
		failures.push(`${m.injectedElementCount} injected element(s) exist under the roll — the value was parsed as markup`);
	}
	if (hostileValue && !m.cellTexts.includes(hostileValue)) {
		failures.push('the hostile value is not any cell\'s exact text — it was dropped or altered rather than escaped');
	}
	return failures.length === 0
		? { passed: true, detail: `0 injected elements under the roll; the ${hostileValue.length}-char hostile value present as cell text` }
		: { passed: false, detail: failures.join('; ') };
}

/**
 * Does `text` carry both numbers as STANDALONE numbers?
 *
 * Word-boundary matched, so `5` does not match inside `15` or `25`. That is
 * not a refinement — the seeded counts are small integers and a substring
 * scan would match almost any page.
 *
 * @param {string} text
 * @param {number} a
 * @param {number} b
 * @returns {boolean}
 */
export function matchesNumberPair(text, a, b) {
	if (typeof text !== 'string') return false;
	/** @param {number} n */
	const standalone = (n) => new RegExp(`\\b${String(n)}\\b`).test(text);
	return standalone(a) && standalone(b);
}

/**
 * D-14's structural claim: the key-release fact is a FILLED card carrying a
 * non-zero released count, and never a gap card.
 *
 * The second half is the half that would be forgotten. A page that rendered
 * the key-release sentence inside a de-emphasised gap card would satisfy every
 * "the numbers are on the page" check and would still be telling a reader that
 * a fact the system genuinely holds is a fact it does not.
 *
 * 54-13 DID ship a per-fact hook attribute, so this rung scopes tighter than
 * the number-pair match alone: the ONE filled card carrying the pair must also
 * BE the key-release fact. That can only tighten the rung — a page that put
 * the counts on some other card would now fail rather than pass on a
 * coincidence.
 *
 * @param {{ filledMatches: string[], gapMatches: string[], filledTotal: number, gapTotal: number }} m
 * @param {{ released: number, total: number }} counts
 * @param {string} expectedFactId
 * @returns {Verdict}
 */
export function evaluateKeyReleaseCard(m, counts, expectedFactId) {
	/** @type {string[]} */
	const failures = [];
	if (!(counts.released > 0)) failures.push(`seeded released is ${counts.released} — a zero would make this rung vacuous`);
	if (!(counts.released < counts.total)) failures.push(`seeded released ${counts.released} is not strictly below total ${counts.total}`);
	if (m.filledMatches.length !== 1) {
		failures.push(`${m.filledMatches.length} of ${m.filledTotal} filled card(s) carry the pair ${counts.released}/${counts.total} (want exactly 1): ${JSON.stringify(m.filledMatches)}`);
	} else if (m.filledMatches[0] !== expectedFactId) {
		failures.push(`the one filled card carrying the pair is "${m.filledMatches[0]}", not the key-release fact ("${expectedFactId}")`);
	}
	if (m.gapMatches.length !== 0) {
		failures.push(`${m.gapMatches.length} of ${m.gapTotal} gap card(s) carry the pair: ${JSON.stringify(m.gapMatches)}`);
	}
	return failures.length === 0
		? { passed: true, detail: `exactly 1 of ${m.filledTotal} filled cards carries ${counts.released}/${counts.total} and it is "${m.filledMatches[0]}"; 0 of ${m.gapTotal} gap cards do` }
		: { passed: false, detail: failures.join('; ') };
}

/**
 * D-11: the gap card is de-emphasised by ALL THREE cues together.
 *
 * No single cue is sufficient and the rung must fail if any one of the three
 * matches — a card that merely looks slightly different still reads as a fact.
 * The two elements compared are structurally identical apart from the class,
 * the branch attribute and one copy key, so a divergence here isolates
 * STYLING rather than structure.
 *
 * @param {{ borderTopStyle: string, color: string, fontSize: string }} gap
 * @param {{ borderTopStyle: string, color: string, fontSize: string }} plain
 * @returns {Verdict}
 */
export function evaluateGapStyleDivergence(gap, plain) {
	/** @type {string[]} */
	const failures = [];
	if (gap.borderTopStyle !== 'dashed') failures.push(`gap border-top-style is "${gap.borderTopStyle}" (want "dashed")`);
	if (plain.borderTopStyle !== 'solid') failures.push(`plain border-top-style is "${plain.borderTopStyle}" (want "solid")`);
	if (gap.borderTopStyle === plain.borderTopStyle) failures.push(`border-top-style does not diverge (both "${gap.borderTopStyle}")`);
	if (gap.color === plain.color) failures.push(`color does not diverge (both "${gap.color}")`);
	const gapSize = Number.parseFloat(gap.fontSize);
	const plainSize = Number.parseFloat(plain.fontSize);
	if (!Number.isFinite(gapSize) || !Number.isFinite(plainSize)) {
		failures.push(`font-size unreadable (gap "${gap.fontSize}", plain "${plain.fontSize}")`);
	} else if (!(gapSize < plainSize)) {
		failures.push(`font-size is not strictly smaller on the gap card (gap ${gapSize}px, plain ${plainSize}px)`);
	}
	return failures.length === 0
		? {
				passed: true,
				detail: `border-top-style ${gap.borderTopStyle} vs ${plain.borderTopStyle}; color ${gap.color} vs ${plain.color}; font-size ${gapSize}px vs ${plainSize}px`,
			}
		: { passed: false, detail: failures.join('; ') };
}

// ---------------------------------------------------------------------------
// PART C — the matcher positive controls (`--prove-matchers`).
//
// Every comparator above is run TWICE: once against an input built to violate
// it, which must report FAIL, and once against a healthy input, which must
// report PASS. Only the first is what 54-VALIDATION's self-tripping-checker
// rule 2 demands, but a comparator that fails on EVERYTHING is as useless as
// one that fails on nothing, and only the second control can tell them apart.
// ---------------------------------------------------------------------------

const HEALTHY_CELLS = [
	{ text: 'A production-length district value (48 chars long!!)', textOverflow: 'clip', overflow: 'visible' },
	{ text: 'Someothercell', textOverflow: 'clip', overflow: 'visible' },
];
const HEALTHY_LONGEST = HEALTHY_CELLS[0].text;
const CONTROL_MARKER = ['EXTRA', 'FIELDS', 'MUST', 'NOT', 'RENDER'].join('-');
const CONTROL_HOSTILE = `<${'script'}>controlXss()</${'script'}>`;

/**
 * @returns {ReadonlyArray<{ label: string, violating: Verdict, healthy: Verdict }>}
 */
function matcherControls() {
	return Object.freeze([
		{
			label: 'roll-fields comparator vs. a table with two headings and three rows',
			violating: evaluateRollFields({ rollCount: 1, headers: ['LastName', 'District'], rowCount: 3, cellCount: 6, emptyCellCount: 1 }, 4),
			healthy: evaluateRollFields({ rollCount: 1, headers: [...EXPECTED_HEADERS], rowCount: 4, cellCount: 12, emptyCellCount: 0 }, 4),
		},
		{
			label: 'overflow comparator vs. a wrapper that clips (overflow-x hidden, scrollWidth === clientWidth, cell ellipsised)',
			violating: evaluateRollOverflow(
				{
					overflowX: 'hidden',
					scrollWidth: 282,
					clientWidth: 282,
					cells: [{ text: HEALTHY_LONGEST.slice(0, 20), textOverflow: 'ellipsis', overflow: 'hidden' }],
				},
				HEALTHY_LONGEST,
			),
			healthy: evaluateRollOverflow({ overflowX: 'auto', scrollWidth: 384, clientWidth: 282, cells: HEALTHY_CELLS }, HEALTHY_LONGEST),
		},
		{
			label: 'forbidden-string scan vs. markup that really contains the withheld-field marker',
			violating: evaluateHiddenStrings(`<td>a cell</td><span>${CONTROL_MARKER}</span>`, [{ label: 'control marker', needle: CONTROL_MARKER }]),
			healthy: evaluateHiddenStrings('<td>a cell</td><span>nothing to see</span>', [{ label: 'control marker', needle: CONTROL_MARKER }]),
		},
		{
			label: 'escaping check vs. a fragment that really contains an injected element',
			violating: evaluateEscaping({ injectedElementCount: 1, cellTexts: [] }, CONTROL_HOSTILE),
			healthy: evaluateEscaping({ injectedElementCount: 0, cellTexts: [CONTROL_HOSTILE] }, CONTROL_HOSTILE),
		},
		{
			label: 'number-pair matcher vs. a card carrying 15 and 25 (the word boundaries must hold)',
			// The counts are 2 and 5, both of which appear in the control text as
			// SUBSTRINGS of 15 and 25 and neither of which appears standalone.
			// They also satisfy `0 < released < total`, so the ONLY thing left
			// to fail is the word boundary — which is the property this control
			// exists to prove, rather than an incidental count mismatch.
			violating: evaluateKeyReleaseCard(
				{
					filledMatches: matchesNumberPair('15 of 25 keyholders have released their keys.', 2, 5) ? ['control'] : [],
					gapMatches: [],
					filledTotal: 1,
					gapTotal: 0,
				},
				{ released: 2, total: 5 },
				KEYRELEASE_FACT_ID,
			),
			healthy: evaluateKeyReleaseCard(
				{
					filledMatches: matchesNumberPair('3 of 5 keyholders have released their keys.', 3, 5) ? [KEYRELEASE_FACT_ID] : [],
					gapMatches: [],
					filledTotal: 1,
					gapTotal: 0,
				},
				{ released: 3, total: 5 },
				KEYRELEASE_FACT_ID,
			),
		},
		{
			label: 'style comparator vs. two elements with IDENTICAL computed styles',
			violating: evaluateGapStyleDivergence(
				{ borderTopStyle: 'solid', color: 'rgb(233, 236, 242)', fontSize: '14px' },
				{ borderTopStyle: 'solid', color: 'rgb(233, 236, 242)', fontSize: '14px' },
			),
			healthy: evaluateGapStyleDivergence(
				{ borderTopStyle: 'dashed', color: 'rgb(141, 151, 168)', fontSize: '12px' },
				{ borderTopStyle: 'solid', color: 'rgb(233, 236, 242)', fontSize: '14px' },
			),
		},
	]);
}

function runProveMatchers() {
	const controls = matcherControls();
	let inert = 0;
	let indiscriminate = 0;
	for (const control of controls) {
		if (control.violating.passed) {
			inert += 1;
			process.stderr.write(
				`[${LABEL}] matcher is inert — the "${control.label}" positive-control input did not fail. ` +
					'This gate cannot detect a real regression until the comparator is fixed.\n',
			);
		} else {
			process.stdout.write(`[${LABEL}] CAN-FAIL  ${control.label}\n              -> ${control.violating.detail}\n`);
		}
		if (!control.healthy.passed) {
			indiscriminate += 1;
			process.stderr.write(
				`[${LABEL}] matcher is indiscriminate — the "${control.label}" comparator ALSO failed its healthy input: ${control.healthy.detail}\n`,
			);
		}
	}
	if (inert > 0 || indiscriminate > 0) {
		fail(`${inert} comparator(s) inert, ${indiscriminate} indiscriminate, out of ${controls.length}.`);
	}
	process.stdout.write(
		`[${LABEL}] OK: all ${controls.length} comparators reported FAIL on a violating input and PASS on a healthy one — live and discriminating.\n`,
	);
	process.exit(0);
}

// ---------------------------------------------------------------------------
// The build / serve / launch plumbing, copied in shape from `run-ui-gates.mjs`.
// ---------------------------------------------------------------------------

async function buildGate() {
	const viteBin = path.join(APP_DIR, 'node_modules', 'vite', 'bin', 'vite.js');
	if (!existsSync(viteBin)) fail(`vite binary not found at ${viteBin} — run \`yarn install\` first.`);
	await new Promise((resolvePromise, rejectPromise) => {
		const child = spawn(process.execPath, [viteBin, 'build', '--config', GATE_CONFIG], {
			cwd: APP_DIR,
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		child.stdout?.on('data', (d) => process.stdout.write(`[vite build] ${d}`));
		child.stderr?.on('data', (d) => process.stderr.write(`[vite build] ${d}`));
		child.on('error', rejectPromise);
		child.on('exit', (code) => (code === 0 ? resolvePromise(undefined) : rejectPromise(new Error(`vite build exited ${code}`))));
	});
}

/**
 * Resolve the built entry by SEARCHING `dist-gate` for exactly one file of
 * that name, rather than predicting the bundler's output path for a non-root
 * HTML input. Two matches is as much a setup error as none.
 * @returns {string}
 */
function resolveGateEntry() {
	if (!existsSync(GATE_DIST)) fail(`gate dist "${GATE_DIST}" does not exist — run \`yarn build:gate\` or drop --skip-build.`);
	/** @param {string} dir @returns {string[]} */
	function walk(dir) {
		/** @type {string[]} */
		const out = [];
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) out.push(...walk(full));
			else if (entry.name === GATE_ENTRY) out.push(full);
		}
		return out;
	}
	const matches = walk(GATE_DIST);
	if (matches.length !== 1) fail(`expected exactly one "${GATE_ENTRY}" under "${GATE_DIST}", found ${matches.length}.`);
	return path.relative(GATE_DIST, matches[0]).split(path.sep).join('/');
}

/**
 * Everything the rungs need, read out of the live page in ONE evaluate so the
 * whole readout describes a single layout rather than several.
 * @param {import('playwright').Page} page
 */
function readPage(page) {
	return page.evaluate(() => {
		/** @param {Element} el */
		const styleOf = (el) => {
			const cs = getComputedStyle(el);
			return { borderTopStyle: cs.borderTopStyle, color: cs.color, fontSize: cs.fontSize };
		};
		// The harness's ONE readout channel, read through an untyped view of the
		// global object -- this file is checked as JS, and the harness's own
		// `declare global` lives in a `.tsx` the checker does not apply here.
		const gateReadout = /** @type {any} */ (globalThis).__UI_GATE__ ?? null;
		const rolls = [...document.querySelectorAll('#root .registrant-roll')];
		const roll = rolls[0] ?? null;
		const rollStyle = roll ? getComputedStyle(roll) : null;
		const cellEls = roll ? [...roll.querySelectorAll('tbody td')] : [];
		const outcome = document.querySelector('#root [data-fact-group="outcome"]');
		// The pair D-11 is measured on, and neither half is arbitrary. BOTH come
		// from the outcome section, which is the only section rendering a gap
		// card and a filled card together — that is what makes the comparison a
		// comparison of STYLING rather than of two different page regions. The
		// filled half is pinned to the key-release card specifically because
		// 54-13 renders its two branches identically apart from the class, the
		// branch attribute and one copy key, so this pair differs in styling
		// and in nothing else. A missing half fails the rung by name rather
		// than silently substituting some other card.
		const gapCard = outcome ? outcome.querySelector('.fact-card--gap') : null;
		const plainCard = outcome ? outcome.querySelector('.fact-card:not(.fact-card--gap)[data-fact-id="keyrelease"]') : null;
		// A card's text as a READER experiences it, NOT as `textContent`
		// returns it. `textContent` concatenates adjacent block elements with
		// no separator at all, so a heading ending in a letter fuses with a
		// body starting with a digit — the key-release card really does
		// serialise as "...key release3 of 5 keyholders...", which defeats a
		// word-boundary match on the numerator for a reason that has nothing
		// to do with what is on screen. Joining the descendant TEXT NODES with
		// a single space reproduces the visual separation the two block
		// elements already have. This is a fix to the MEASUREMENT, not a
		// loosening of the assertion: the numbers must still be standalone
		// within their own sentence.
		/** @param {Element} el */
		const readerText = (el) => {
			/** @type {string[]} */
			const parts = [];
			/** @param {Node} node */
			const walk = (node) => {
				for (const child of node.childNodes) {
					if (child.nodeType === Node.TEXT_NODE) parts.push(child.nodeValue ?? '');
					else if (child.nodeType === Node.ELEMENT_NODE) walk(child);
				}
			};
			walk(el);
			return parts.join(' ');
		};
		/** @param {Element} el */
		// A card with no per-fact identity is reported as such rather than as
		// `null` — it would be a real defect (54-13 tags every card), and a
		// nameless entry in a failure detail helps nobody.
		const cardText = (el) => ({
			id: el.getAttribute('data-fact-id') ?? '(untagged card)',
			kind: el.getAttribute('data-fact-kind') ?? '(untagged kind)',
			text: readerText(el),
		});
		return {
			gate: gateReadout ? { error: gateReadout.error, fixture: gateReadout.fixture } : null,
			roll: {
				rollCount: rolls.length,
				headers: roll ? [...roll.querySelectorAll('thead th')].map((th) => th.textContent ?? '') : [],
				rowCount: roll ? roll.querySelectorAll('tbody tr').length : 0,
				cellCount: cellEls.length,
				emptyCellCount: cellEls.filter((td) => (td.textContent ?? '').trim() === '').length,
				overflowX: rollStyle ? rollStyle.overflowX : '(no roll)',
				scrollWidth: roll ? roll.scrollWidth : 0,
				clientWidth: roll ? roll.clientWidth : 0,
				cells: cellEls.map((td) => {
					const cs = getComputedStyle(td);
					return { text: td.textContent ?? '', textOverflow: cs.textOverflow, overflow: cs.overflow };
				}),
				injectedElementCount: roll ? roll.querySelectorAll('script').length : 0,
			},
			html: document.body.innerHTML,
			filledCards: [...document.querySelectorAll('#root .fact-card:not(.fact-card--gap)')].map(cardText),
			gapCards: [...document.querySelectorAll('#root .fact-card--gap')].map(cardText),
			gapStyle: gapCard ? { id: gapCard.getAttribute('data-fact-id') ?? '(untagged card)', ...styleOf(gapCard) } : null,
			plainStyle: plainCard ? { id: plainCard.getAttribute('data-fact-id') ?? '(untagged card)', ...styleOf(plainCard) } : null,
		};
	});
}

async function main() {
	const argv = process.argv.slice(2);
	let skipBuild = false;
	let port = Number(process.env.RENDER_FIDELITY_PORT ?? DEFAULT_PORT);
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === '--skip-build') skipBuild = true;
		else if (arg === '--prove-matchers') runProveMatchers();
		else if (arg === '--port') {
			i += 1;
			port = Number(argv[i]);
		} else {
			process.stderr.write(`[${LABEL}] unrecognised argument "${arg}" — refusing to run rather than ignoring it into a green result.\n`);
			process.exit(2);
		}
	}
	if (!Number.isInteger(port) || port <= 0) fail(`--port must be a positive integer, got "${port}".`);

	if (!skipBuild) await buildGate();
	const entryRel = resolveGateEntry();

	let server;
	let browser;
	try {
		server = await serveDist(GATE_DIST, port);
		browser = await chromium.launch({ headless: true });
		const page = await browser.newPage({ viewport: { ...NARROW_VIEWPORT } });
		/** @type {string[]} */
		const console_lines = [];
		page.on('console', (m) => console_lines.push(`[${m.type()}] ${m.text()}`));
		page.on('pageerror', (e) => console_lines.push(`[pageerror] ${e.message}`));

		const url = `${server.url}/${entryRel}?${FIXTURE_QUERY}`;
		process.stdout.write(`[${LABEL}] viewport ${NARROW_VIEWPORT.width}x${NARROW_VIEWPORT.height}, GET ${url}\n`);
		await page.goto(url, { waitUntil: 'load' });
		await page
			.waitForFunction(() => /** @type {any} */ (globalThis).__UI_GATE_DONE__ === true, null, { timeout: 180_000 })
			.catch(() => {});

		const m = await readPage(page);
		// The store plugin logs one upgrade-blocked warning per table while it
		// declares the schema; they resolve on their own and drowning the rung
		// lines in ~60 of them hides anything that matters. Errors are printed
		// in full; the rest are counted, never silently dropped.
		const loud = console_lines.filter((line) => !line.startsWith('[warning]'));
		for (const line of loud) process.stdout.write(`  ${line}\n`);
		process.stdout.write(`  (${console_lines.length - loud.length} store-upgrade warning(s) suppressed, ${loud.length} other console line(s) shown)\n`);

		// Anti-vacuity, BEFORE any rung. A readout that never published, a
		// harness that recorded a render error, or a fixture channel that is
		// null (the default branch) would make every rung below meaningless
		// rather than failing — so each is a hard stop with its own message.
		const gate = m.gate;
		if (gate === null) fail('the harness never published its readout — the page did not finish, so no rung ran.');
		if (gate === null) return;
		if (gate.error !== null) fail(`the harness recorded a render/seed error: ${gate.error}`);
		const fx = gate.fixture;
		if (fx === null || fx === undefined) fail('the readout carries no fixture channel — the page was not built with the fixture parameter.');
		if (!Array.isArray(fx.districts) || fx.districts.length === 0) fail('the fixture channel publishes no districts — every data-derived rung would be inert.');
		if (!Number.isInteger(fx.rollRowCount) || fx.rollRowCount <= 0) fail('the fixture channel publishes no roll row count.');

		const longestDistrict = [...fx.districts].sort((a, b) => b.length - a.length)[0];

		const fields = evaluateRollFields(m.roll, fx.rollRowCount);
		record('roll-fields-rendered', fields.passed, fields.detail);

		const overflow = evaluateRollOverflow(m.roll, longestDistrict);
		record('roll-overflows-not-clips', overflow.passed, overflow.detail);

		const hidden = evaluateHiddenStrings(m.html, [
			{ label: 'the withheld authority-field marker', needle: fx.extraFieldsMarker },
			{ label: 'the superseded surname', needle: fx.supersededLastName },
			{ label: 'the superseded district', needle: fx.supersededDistrict },
		]);
		record('roll-hides-extrafields-and-superseded', hidden.passed, hidden.detail);

		const escaping = evaluateEscaping(
			{ injectedElementCount: m.roll.injectedElementCount, cellTexts: m.roll.cells.map((c) => c.text) },
			fx.xssLastName,
		);
		record('roll-escapes-authority-text', escaping.passed, escaping.detail);

		// 54-13 DID ship a per-fact hook attribute, so both halves are reported
		// by fact id rather than by ordinal — that can only tighten this rung.
		const keyrelease = evaluateKeyReleaseCard(
			{
				filledMatches: m.filledCards.filter((c) => matchesNumberPair(c.text, fx.released, fx.total)).map((c) => c.id),
				gapMatches: m.gapCards.filter((c) => matchesNumberPair(c.text, fx.released, fx.total)).map((c) => c.id),
				filledTotal: m.filledCards.length,
				gapTotal: m.gapCards.length,
			},
			{ released: fx.released, total: fx.total },
			KEYRELEASE_FACT_ID,
		);
		record('keyrelease-renders-filled-with-nonzero-released', keyrelease.passed, keyrelease.detail);

		// Both cards are taken from the SAME rendered section, so the pair
		// differs only in the class, the branch attribute and one copy key —
		// which is what makes the comparison isolate styling from structure.
		if (m.gapStyle === null || m.plainStyle === null) {
			record('gap-card-style-diverges', false, `the outcome section did not render both a gap card and a filled card (gap=${JSON.stringify(m.gapStyle)}, filled=${JSON.stringify(m.plainStyle)})`);
		} else {
			const style = evaluateGapStyleDivergence(m.gapStyle, m.plainStyle);
			record('gap-card-style-diverges', style.passed, `${m.gapStyle.id} vs ${m.plainStyle.id}: ${style.detail}`);
		}
	} finally {
		await browser?.close();
		await server?.close();
	}

	let failed = 0;
	for (const id of RUNG_IDS) {
		const rung = rungs.find((r) => r.id === id);
		if (!rung) {
			failed += 1;
			process.stdout.write(`FAIL  ${id}\n      -> never ran\n`);
			continue;
		}
		if (!rung.passed) failed += 1;
		process.stdout.write(`${rung.passed ? 'PASS' : 'FAIL'}  ${rung.id}\n      -> ${rung.detail}\n`);
	}
	process.stdout.write(`\nRENDER FIDELITY: ${failed === 0 ? 'PASS' : 'FAIL'} (${RUNG_IDS.length - failed}/${RUNG_IDS.length} rungs)\n`);
	process.exitCode = failed === 0 ? 0 : 1;
}

await main();
