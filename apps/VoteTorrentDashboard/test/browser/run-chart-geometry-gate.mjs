#!/usr/bin/env node
/**
 * run-chart-geometry-gate.mjs — the D-24 browser-tier proof that a chart
 * "rendered" is a MEASURED claim (a bar's height proportional to its value,
 * stacked segments summing to their column, a meter's fill ratio matching
 * value/total), not a node-presence claim (60-07).
 *
 * Modelled in shape on `apps/VoteTorrentPublic/test/liveness/run-liveness-gate.mjs`:
 * the Playwright import, `chromium.launch({ headless: true })`, `serveDist`,
 * the dist walk that resolves the built entry by SEARCH, the frozen
 * `RUNG_IDS` registry with `record(id, passed, detail)` throwing on any
 * unregistered id, pure exported comparators exercised by `--prove-matchers`
 * against both a violating and a healthy input, and a flag parser that
 * exits 2 on an unrecognised argument.
 *
 * THE BOUNDARY THIS GATE DOES AND DOES NOT CARRY. The panel CHROME is real —
 * `PanelFrame`, its header switch, its denied-body guard, the real
 * `ChartViewProvider` and `usePanelView()` — and the four chart primitives
 * are real. The panel BODIES are fixture-fed reproductions of
 * `60-05`/`60-10`'s Chart/Grid ternary, not `RegistrationsPanel` or
 * `KeyholdersPanel` themselves — this gate does not prove either panel
 * issues its own reads, and it does not re-prove `60-05`/`60-10`'s own
 * source-tier rungs. The fixture path is the only one available for the
 * intake time series: `RegistrationRequest` carries a row-level
 * `SignatureValid` CHECK, so an intake row cannot be seeded without a
 * signing dependency, which a gate may not take.
 *
 * PORT POLICY: this gate takes **5199** — verified free among the ports
 * already bound on this project (5180-5183, 5191-5198). A bound port fails
 * loudly; `serveDist` rejects on `EADDRINUSE` rather than silently choosing
 * another.
 *
 * TWO PAGE LOADS, DELIBERATELY. The view flag is read once, at mount, so a
 * behavioural proof of the switch needs a SECOND, genuinely fresh
 * navigation — never a single-navigation check. Do not add one.
 *
 * FLAGS:
 *   --skip-build       Reuse an existing `dist-chart-geometry/` rather than
 *                       rebuilding. Local iteration only — never in CI.
 *   --prove-matchers   Run every comparator against a violating input AND a
 *                      healthy one, requiring the first to FAIL and the
 *                      second to PASS. Needs no browser and no build.
 *   --port <n>         Override the bound port.
 * Any other argument exits 2 naming it.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readdirSync } from 'node:fs';
import { serveDist } from '../../../../packages/ui-web/scripts/lib/serve-dist.mjs';
import { panelViewStorageKey } from '../../src/screens/panels/panel-view-storage.js';
import { STATUS_FIXTURE, REQUEST_FIXTURE, INTAKE_FIXTURE, METER_FIXTURES, FIXTURE_META } from './chart-geometry-fixtures.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(__dirname, '..', '..');
const DIST = path.join(APP_DIR, 'dist-chart-geometry');
const GATE_ENTRY = 'chart-geometry-gate.html';
const GATE_CONFIG = 'test/browser/vite.chart-geometry.config.ts';
const DEFAULT_PORT = 5199;
const LABEL = 'run-chart-geometry-gate';

/** @type {ReadonlyArray<string>} */
export const RUNG_IDS = Object.freeze([
	'c1-status-bars-proportional',
	'c1-status-labels-unclipped',
	'c2-stacked-segments-sum-to-total',
	'c3-marks-match-buckets-no-gaps',
	'c5-meter-fill-ratio-proportional',
	'panel-body-free-of-controls',
	'view-switch-swaps-representations',
]);

/** Relative-tolerance/pixel-tolerance constants, named rather than scattered as magic numbers. */
export const PROPORTIONALITY_TOLERANCE = 0.02;
export const ZERO_EXTENT_TOLERANCE_PX = 0.5;
export const SUM_TOLERANCE_PX = 1.5;
export const RATIO_TOLERANCE = 0.02;
export const BASELINE_TOLERANCE_PX = 1.0;
export const MIN_PRODUCTION_LABEL_CHARS = 8;

/** The six selector terms `panel-body-free-of-controls` queries with, shared by both `*ByTerm` maps. @type {ReadonlyArray<string>} */
const BODY_CHECK_TERMS = Object.freeze(['button', 'input', 'select', 'textarea', '[onclick]', 'a[href]']);
/**
 * The probe deliberately carries no raw `button` — D-13's real header switch
 * (`switchButtons`) is this rung's own proof that the `button` term reaches
 * a real control; re-planting one inside the probe would test nothing the
 * switch does not already prove. React attaches its `onClick` handlers
 * programmatically (never as a literal DOM attribute), so the `[onclick]`
 * term catches only a raw HTML attribute — the element-type terms below
 * carry this rung's real force.
 * @type {ReadonlyArray<string>}
 */
const PROBE_CHECK_TERMS = Object.freeze(['input', 'select', 'textarea', '[onclick]', 'a[href]']);

/** @type {Array<{ id: string, passed: boolean, detail: string }>} */
const rungs = [];

/** @param {string} id @param {boolean} passed @param {string} detail */
function record(id, passed, detail) {
	if (!RUNG_IDS.includes(id)) throw new Error(`record(): "${id}" is not a member of RUNG_IDS`);
	rungs.push({ id, passed, detail });
}

/** @param {string} message */
function fail(message) {
	process.stderr.write(`[${LABEL}] FAIL: ${message}\n`);
	process.exit(1);
}

// ---------------------------------------------------------------------------
// THE COMPARATORS — pure functions over values already measured off the
// page, so `--prove-matchers` can exercise each with no browser at all.
// ---------------------------------------------------------------------------

/** @typedef {{ passed: boolean, detail: string }} Verdict */

/**
 * C1 proportionality (D-16's "does a zero-count status still get a bar" is
 * folded in here too, via the zero-extent check).
 * @param {ReadonlyArray<{ key: string, value: number, height: number }>} bars
 * @returns {Verdict}
 */
export function evaluateBarsProportional(bars) {
	/** @type {string[]} */
	const failures = [];
	if (bars.length < 3) failures.push(`only ${bars.length} bar(s) supplied (want >= 3)`);
	const zeroBars = bars.filter((b) => b.value === 0);
	if (zeroBars.length === 0) failures.push('no bar has value 0 — the planted zero-count control is missing, so this rung would be vacuous');
	const nonZeroBars = bars.filter((b) => b.value !== 0);
	const distinctValues = new Set(nonZeroBars.map((b) => b.value));
	if (distinctValues.size < 2) failures.push(`only ${distinctValues.size} distinct non-zero value(s) — proportionality would be untested`);
	for (const bar of zeroBars) {
		if (bar.height > ZERO_EXTENT_TOLERANCE_PX) failures.push(`bar "${bar.key}" has value 0 but measures ${bar.height}px tall`);
	}
	for (const bar of nonZeroBars) {
		if (!(bar.height > 0)) failures.push(`bar "${bar.key}" has value ${bar.value} but measures ${bar.height}px tall`);
	}
	if (nonZeroBars.length >= 2 && nonZeroBars.every((b) => b.height > 0)) {
		const ratios = nonZeroBars.map((b) => b.height / b.value);
		const mean = ratios.reduce((a, b) => a + b, 0) / ratios.length;
		nonZeroBars.forEach((bar, i) => {
			const ratio = ratios[i];
			const relDiff = mean === 0 ? Math.abs(ratio) : Math.abs(ratio - mean) / mean;
			if (relDiff > PROPORTIONALITY_TOLERANCE) {
				failures.push(`bar "${bar.key}" height/value ratio ${ratio.toFixed(4)} diverges ${(relDiff * 100).toFixed(1)}% from the mean ${mean.toFixed(4)}`);
			}
		});
	}
	return failures.length === 0
		? { passed: true, detail: `${bars.length} bars, ${zeroBars.length} zero-valued at <= ${ZERO_EXTENT_TOLERANCE_PX}px, non-zero heights proportional within ${PROPORTIONALITY_TOLERANCE * 100}%` }
		: { passed: false, detail: failures.join('; ') };
}

/**
 * C1 label containment (D-16). Each label carries the text a real render
 * produced AND the text the fixture expects, so a mismatch is a rung
 * failure rather than a silent pass on whatever text happened to be there.
 * @param {ReadonlyArray<{ role: string, text: string, expectedText: string, box: { left: number, right: number, top: number, bottom: number, width: number, height: number } }>} labels
 * @param {{ left: number, right: number, top: number, bottom: number }} svgBox
 * @returns {Verdict}
 */
export function evaluateLabelsUnclipped(labels, svgBox) {
	/** @type {string[]} */
	const failures = [];
	const EXPECTED_LABEL_COUNT = 6; // three axis ticks + three count labels, C1's fixed shape
	if (labels.length < EXPECTED_LABEL_COUNT) failures.push(`only ${labels.length} label(s) supplied (want ${EXPECTED_LABEL_COUNT}) — an expected label is missing`);
	let longest = 0;
	for (const label of labels) {
		if (label.text !== label.expectedText) failures.push(`label "${label.role}" reads "${label.text}" (want "${label.expectedText}")`);
		if (label.text.length > longest) longest = label.text.length;
		if (!(label.box.width > 0) || !(label.box.height > 0)) failures.push(`label "${label.role}" measures ${label.box.width}x${label.box.height}px`);
		const escapesLeft = svgBox.left - label.box.left > 0.5;
		const escapesRight = label.box.right - svgBox.right > 0.5;
		const escapesTop = svgBox.top - label.box.top > 0.5;
		const escapesBottom = label.box.bottom - svgBox.bottom > 0.5;
		if (escapesLeft || escapesRight || escapesTop || escapesBottom) {
			failures.push(`label "${label.role}" box escapes the chart's own SVG box (label ${JSON.stringify(label.box)}, svg ${JSON.stringify(svgBox)})`);
		}
	}
	if (longest < MIN_PRODUCTION_LABEL_CHARS) failures.push(`the longest supplied label is ${longest} character(s) (want >= ${MIN_PRODUCTION_LABEL_CHARS}) — too short to prove clipping`);
	return failures.length === 0
		? { passed: true, detail: `${labels.length} labels, longest ${longest} chars, all fully contained in the chart's own SVG box` }
		: { passed: false, detail: failures.join('; ') };
}

/**
 * C2 segment sum. Each segment's measured height is compensated by its OWN
 * measured `strokeWidth` (`StackedBarSeries` strokes each segment at 2px —
 * a hard-coded 2 would be an assumption where a measurement is available),
 * and each category's own extent is compensated by that category's stroke
 * width once.
 * @param {ReadonlyArray<{ key: string, segments: ReadonlyArray<{ seriesKey: string, value: number, height: number, strokeWidth: number }>, columnExtent: number }>} categories
 * @returns {Verdict}
 */
export function evaluateSegmentsSumToTotal(categories) {
	/** @type {string[]} */
	const failures = [];
	let anyZeroSegment = false;
	for (const category of categories) {
		if (category.segments.length === 0) {
			failures.push(`category "${category.key}" has no segments`);
			continue;
		}
		const strokeWidth = category.segments[0].strokeWidth;
		let compensatedSum = 0;
		for (const segment of category.segments) {
			const compensatedHeight = segment.height - segment.strokeWidth;
			compensatedSum += compensatedHeight;
			if (segment.value === 0) {
				anyZeroSegment = true;
				if (segment.height > ZERO_EXTENT_TOLERANCE_PX) failures.push(`category "${category.key}" segment "${segment.seriesKey}" is zero-valued but measures ${segment.height}px`);
			} else if (!(segment.height > 0)) {
				failures.push(`category "${category.key}" segment "${segment.seriesKey}" has value ${segment.value} but measures ${segment.height}px`);
			}
		}
		const compensatedExtent = category.columnExtent - strokeWidth;
		if (Math.abs(compensatedSum - compensatedExtent) > SUM_TOLERANCE_PX) {
			failures.push(
				`category "${category.key}" compensated segment sum ${compensatedSum.toFixed(2)}px does not match compensated column extent ${compensatedExtent.toFixed(2)}px (tolerance ${SUM_TOLERANCE_PX}px)`,
			);
		}
	}
	if (!anyZeroSegment) failures.push('no segment anywhere has value 0 — the planted control is missing, so this rung would be vacuous');
	return failures.length === 0
		? { passed: true, detail: `${categories.length} categories, every compensated segment sum matches its compensated column extent within ${SUM_TOLERANCE_PX}px` }
		: { passed: false, detail: failures.join('; ') };
}

/**
 * C3 mark-count-equals-bucket-count, no gaps. `path.vertices`/`subpathCount`
 * come from parsing the rendered `<path d="…">`; `expected.values` is the
 * fixture's own bucket-count array (INTAKE_FIXTURE-shaped).
 * @param {{ vertices: ReadonlyArray<{ x: number, y: number }>, subpathCount: number, box: { width: number, height: number } }} path
 * @param {{ values: ReadonlyArray<number> }} expected
 * @returns {Verdict}
 */
export function evaluateMarksMatchBuckets(path, expected) {
	/** @type {string[]} */
	const failures = [];
	if (path.vertices.length !== expected.values.length) {
		failures.push(`${path.vertices.length} vertex(es) on the rendered path, want ${expected.values.length} (one per bucket)`);
	}
	if (path.subpathCount !== 1) {
		failures.push(`${path.subpathCount} subpath(s) on the rendered path (want exactly 1) — a second subpath is what a gap-rendering implementation emits`);
	}
	if (!(path.box.width > 0) || !(path.box.height > 0)) failures.push(`path box measures ${path.box.width}x${path.box.height}px`);
	const interiorZeroIndices = expected.values
		.map((v, i) => (v === 0 && i > 0 && i < expected.values.length - 1 ? i : -1))
		.filter((i) => i !== -1);
	if (interiorZeroIndices.length === 0) failures.push('the expected bucket values contain no INTERIOR zero — the planted control is missing, so this rung would be vacuous');
	if (path.vertices.length === expected.values.length && path.vertices.length > 0) {
		const maxY = Math.max(...path.vertices.map((v) => v.y));
		for (const i of interiorZeroIndices) {
			const vertex = path.vertices[i];
			if (Math.abs(vertex.y - maxY) > BASELINE_TOLERANCE_PX) {
				failures.push(`bucket ${i} (value 0) vertex y=${vertex.y} is not on the baseline (max y=${maxY}, tolerance ${BASELINE_TOLERANCE_PX}px) — a gap-rendering implementation would drop or displace this point`);
			}
		}
		const anyAboveBaseline = path.vertices.some((v) => maxY - v.y > BASELINE_TOLERANCE_PX);
		if (!anyAboveBaseline) failures.push('no vertex sits above the baseline — the line is flat and this rung would pass vacuously');
	}
	return failures.length === 0
		? { passed: true, detail: `${path.vertices.length} vertices in 1 subpath, ${interiorZeroIndices.length} interior zero bucket(s) on the baseline` }
		: { passed: false, detail: failures.join('; ') };
}

/**
 * C5 meter fill ratio, at both extremes and an interior point.
 * @param {ReadonlyArray<{ id: string, value: number, total: number, fillWidth: number, trackWidth: number }>} meters
 * @returns {Verdict}
 */
export function evaluateMeterRatios(meters) {
	/** @type {string[]} */
	const failures = [];
	if (meters.length < 3) failures.push(`only ${meters.length} meter(s) supplied (want >= 3)`);
	const hasZero = meters.some((m) => m.value === 0);
	const hasFull = meters.some((m) => m.value === m.total);
	if (!hasZero) failures.push('no meter has value 0 — the zero extreme is missing');
	if (!hasFull) failures.push('no meter has value === total — the full extreme is missing');
	for (const meter of meters) {
		if (meter.trackWidth === 0) {
			failures.push(`meter "${meter.id}" has trackWidth 0`);
			continue;
		}
		if (meter.fillWidth - meter.trackWidth > ZERO_EXTENT_TOLERANCE_PX) {
			failures.push(`meter "${meter.id}" fillWidth ${meter.fillWidth}px exceeds trackWidth ${meter.trackWidth}px`);
		}
		const actualRatio = meter.fillWidth / meter.trackWidth;
		const expectedRatio = meter.total === 0 ? 0 : meter.value / meter.total;
		if (Math.abs(actualRatio - expectedRatio) > RATIO_TOLERANCE) {
			failures.push(`meter "${meter.id}" fill ratio ${actualRatio.toFixed(4)} (fillWidth/trackWidth) diverges from value/total ${expectedRatio.toFixed(4)} by more than ${RATIO_TOLERANCE}`);
		}
	}
	return failures.length === 0
		? { passed: true, detail: `${meters.length} meters, zero and full extremes present, every fill ratio matches value/total within ${RATIO_TOLERANCE}` }
		: { passed: false, detail: failures.join('; ') };
}

/**
 * D-11/D-12: zero controls inside the real `.panel-body`, the same query
 * demonstrably finding D-13's real header switch and every planted probe
 * term outside it.
 * @param {{ bodyTotal: number, bodyByTerm: Readonly<Record<string, number>>, switchButtons: number, probeByTerm: Readonly<Record<string, number>> }} counts
 * @returns {Verdict}
 */
export function evaluateControlAbsence(counts) {
	/** @type {string[]} */
	const failures = [];
	if (counts.bodyTotal !== 0) {
		const offending = BODY_CHECK_TERMS.filter((term) => (counts.bodyByTerm[term] ?? 0) > 0).map((term) => `${term}=${counts.bodyByTerm[term]}`);
		failures.push(`.panel-body contains ${counts.bodyTotal} control(s): ${offending.join(', ') || 'unattributed'}`);
	}
	if (counts.switchButtons < 2) {
		failures.push(`only ${counts.switchButtons} button(s) found via ".panel-view-switch button" outside any .panel-body (want >= 2 — D-13's real header switch)`);
	}
	for (const term of PROBE_CHECK_TERMS) {
		if ((counts.probeByTerm[term] ?? 0) === 0) {
			failures.push(`probe term "${term}" matched zero elements inside .chart-geometry-control-probe — this selector term is not demonstrably live`);
		}
	}
	return failures.length === 0
		? { passed: true, detail: `0 controls in .panel-body, ${counts.switchButtons} real switch button(s) found outside it, every probe term matched >= 1 planted element` }
		: { passed: false, detail: failures.join('; ') };
}

/**
 * D-13/D-17/D-18/D-19: the stored-flag chain, proven behaviourally across
 * two genuinely fresh navigations. `storedKeyholders` and `meterTrackWidth`
 * held constant in EITHER pass is D-17's own named example — an officer
 * charts registrations while keeping keyholders as numbers.
 * @param {{ storedRegistrations: string | null, storedKeyholders: string | null, barCount: number, gridPresent: boolean, gridHeight: number, meterTrackWidth: number }} defaultPass
 * @param {{ storedRegistrations: string | null, storedKeyholders: string | null, barCount: number, gridPresent: boolean, gridHeight: number, meterTrackWidth: number }} gridPass
 * @returns {Verdict}
 */
export function evaluateViewSwitchSwapsRepresentations(defaultPass, gridPass) {
	/** @type {string[]} */
	const failures = [];
	if (defaultPass.storedRegistrations !== null) {
		failures.push(`default pass: stored registrations view is "${defaultPass.storedRegistrations}" (want null — D-18's chart-first default was never exercised)`);
	}
	if (defaultPass.barCount < 3) failures.push(`default pass: only ${defaultPass.barCount} C1 bar(s) (want >= 3)`);
	if (defaultPass.gridPresent) failures.push('default pass: the grid representation is present (want absent — 60-10 unmounts, never hides, the unselected representation)');
	if (gridPass.storedRegistrations !== 'grid') failures.push(`grid pass: stored registrations view is "${gridPass.storedRegistrations}" (want "grid")`);
	if (gridPass.barCount !== 0) failures.push(`grid pass: ${gridPass.barCount} C1 bar(s) still present (want 0 — unmounted, not merely zero-sized)`);
	if (!gridPass.gridPresent) failures.push('grid pass: the grid representation is absent (want present)');
	if (!(gridPass.gridHeight > 0)) failures.push(`grid pass: grid height is ${gridPass.gridHeight} (want > 0)`);
	for (const [label, pass] of /** @type {const} */ ([['default', defaultPass], ['grid', gridPass]])) {
		if (pass.storedKeyholders !== null) failures.push(`${label} pass: stored keyholders view is "${pass.storedKeyholders}" (want null — this frame's flag must stay unset in every pass)`);
		if (!(pass.meterTrackWidth > 0)) failures.push(`${label} pass: keyholders meter trackWidth is ${pass.meterTrackWidth} (want > 0 — D-17's named example: keyholders stays charted while registrations switches)`);
	}
	return failures.length === 0
		? { passed: true, detail: `default pass: null flag, ${defaultPass.barCount} bars, no grid; grid pass: "grid" flag, 0 bars, grid present (height ${gridPass.gridHeight}px); keyholders untouched in both passes` }
		: { passed: false, detail: failures.join('; ') };
}

// ---------------------------------------------------------------------------
// PART C — matcher positive/negative controls (`--prove-matchers`). Every
// comparator gets TWO violating cases: a wrong-defect-shape input, and an
// under-specified input missing its own planted anti-vacuity control — plus
// one shared healthy input.
// ---------------------------------------------------------------------------

/** @returns {ReadonlyArray<{ label: string, violating: Verdict, healthy: Verdict }>} */
function matcherControls() {
	const healthyBars = [
		{ key: 'a', value: 1847, height: 147.76 },
		{ key: 's', value: 612, height: 48.96 },
		{ key: 'r', value: 0, height: 0 },
	];
	const healthyLabels = [
		{ role: 'axis:a', text: 'Active', expectedText: 'Active', box: { left: 10, right: 70, top: 140, bottom: 156, width: 60, height: 16 } },
		{ role: 'axis:s', text: 'Suspended', expectedText: 'Suspended', box: { left: 90, right: 170, top: 140, bottom: 156, width: 80, height: 16 } },
		{ role: 'axis:r', text: 'Revoked', expectedText: 'Revoked', box: { left: 190, right: 260, top: 140, bottom: 156, width: 70, height: 16 } },
		{ role: 'count:a', text: '1,847', expectedText: '1,847', box: { left: 20, right: 60, top: 10, bottom: 26, width: 40, height: 16 } },
		{ role: 'count:s', text: '612', expectedText: '612', box: { left: 100, right: 140, top: 100, bottom: 116, width: 40, height: 16 } },
		{ role: 'count:r', text: '0', expectedText: '0', box: { left: 200, right: 240, top: 130, bottom: 146, width: 40, height: 16 } },
	];
	const healthySvgBox = { left: 0, top: 0, right: 600, bottom: 160 };
	const healthyCategories = [
		{ key: 'p', columnExtent: 166.1, segments: [{ seriesKey: 'registrant', value: 1263, height: 126.3, strokeWidth: 2 }, { seriesKey: 'bridge', value: 418, height: 41.8, strokeWidth: 2 }] },
		{ key: 'a', columnExtent: 99.9, segments: [{ seriesKey: 'registrant', value: 902, height: 92.2, strokeWidth: 2 }, { seriesKey: 'bridge', value: 77, height: 9.7, strokeWidth: 2 }] },
		{ key: 'r', columnExtent: 16.5, segments: [{ seriesKey: 'registrant', value: 145, height: 16.5, strokeWidth: 2 }, { seriesKey: 'bridge', value: 0, height: 0, strokeWidth: 0 }] },
	];
	const healthyPathValues = [37, 52, 0, 64, 91, 128, 73, 46, 0, 19];
	const baselineY = 132;
	const healthyPath = {
		vertices: healthyPathValues.map((v, i) => ({ x: i * 60, y: baselineY - v * 0.6 })),
		subpathCount: 1,
		box: { width: 540, height: 128 * 0.6 },
	};
	const healthyMeters = [
		{ id: 'zero', value: 0, total: 12, fillWidth: 0, trackWidth: 120 },
		{ id: 'partial', value: 7, total: 12, fillWidth: 70, trackWidth: 120 },
		{ id: 'full', value: 12, total: 12, fillWidth: 120, trackWidth: 120 },
	];
	const healthyCounts = {
		bodyTotal: 0,
		bodyByTerm: { button: 0, input: 0, select: 0, textarea: 0, '[onclick]': 0, 'a[href]': 0 },
		switchButtons: 2,
		probeByTerm: { input: 1, select: 1, textarea: 1, '[onclick]': 1, 'a[href]': 1 },
	};
	const healthyDefaultPass = { storedRegistrations: null, storedKeyholders: null, barCount: 3, gridPresent: false, gridHeight: 0, meterTrackWidth: 120 };
	const healthyGridPass = { storedRegistrations: 'grid', storedKeyholders: null, barCount: 0, gridPresent: true, gridHeight: 80, meterTrackWidth: 120 };

	return Object.freeze([
		{
			label: 'c1-status-bars-proportional vs. two non-proportional heights',
			violating: evaluateBarsProportional([{ key: 'a', value: 1847, height: 100 }, { key: 's', value: 612, height: 100 }, { key: 'r', value: 0, height: 0 }]),
			healthy: evaluateBarsProportional(healthyBars),
		},
		{
			label: 'c1-status-bars-proportional vs. no zero-valued bar (planted control missing)',
			violating: evaluateBarsProportional([{ key: 'a', value: 1847, height: 147.76 }, { key: 's', value: 612, height: 48.96 }, { key: 'r', value: 5, height: 0.4 }]),
			healthy: evaluateBarsProportional(healthyBars),
		},
		{
			label: 'c1-status-labels-unclipped vs. a label box escaping the SVG on the right',
			violating: evaluateLabelsUnclipped(
				healthyLabels.map((l, i) => (i === 1 ? { ...l, box: { ...l.box, right: 650 } } : l)),
				healthySvgBox,
			),
			healthy: evaluateLabelsUnclipped(healthyLabels, healthySvgBox),
		},
		{
			label: 'c1-status-labels-unclipped vs. labels shorter than MIN_PRODUCTION_LABEL_CHARS (too short to prove clipping)',
			violating: evaluateLabelsUnclipped(
				healthyLabels.map((l) => ({ ...l, text: l.text.slice(0, 1), expectedText: l.text.slice(0, 1) })),
				healthySvgBox,
			),
			healthy: evaluateLabelsUnclipped(healthyLabels, healthySvgBox),
		},
		{
			label: 'c2-stacked-segments-sum-to-total vs. a category 6px short of its column',
			violating: evaluateSegmentsSumToTotal(healthyCategories.map((c) => (c.key === 'p' ? { ...c, columnExtent: c.columnExtent + 6 } : c))),
			healthy: evaluateSegmentsSumToTotal(healthyCategories),
		},
		{
			label: 'c2-stacked-segments-sum-to-total vs. no zero-valued segment anywhere (planted control missing)',
			violating: evaluateSegmentsSumToTotal(
				healthyCategories.map((c) =>
					c.key === 'r'
						? { ...c, columnExtent: 16.8, segments: [c.segments[0], { seriesKey: 'bridge', value: 3, height: 0.3, strokeWidth: 0 }] }
						: c,
				),
			),
			healthy: evaluateSegmentsSumToTotal(healthyCategories),
		},
		{
			label: 'c3-marks-match-buckets-no-gaps vs. two subpaths and two missing vertices',
			violating: evaluateMarksMatchBuckets(
				{ vertices: healthyPath.vertices.filter((_, i) => i !== 2 && i !== 8), subpathCount: 2, box: healthyPath.box },
				{ values: healthyPathValues },
			),
			healthy: evaluateMarksMatchBuckets(healthyPath, { values: healthyPathValues }),
		},
		{
			label: 'c3-marks-match-buckets-no-gaps vs. no interior zero bucket (planted control missing)',
			violating: evaluateMarksMatchBuckets(
				{
					vertices: [37, 52, 44, 64, 91, 128, 73, 46, 55, 19].map((v, i) => ({ x: i * 60, y: baselineY - v * 0.6 })),
					subpathCount: 1,
					box: healthyPath.box,
				},
				{ values: [37, 52, 44, 64, 91, 128, 73, 46, 55, 19] },
			),
			healthy: evaluateMarksMatchBuckets(healthyPath, { values: healthyPathValues }),
		},
		{
			label: 'c5-meter-fill-ratio-proportional vs. a meter at 50% value with an 80% fill',
			violating: evaluateMeterRatios([{ id: 'zero', value: 0, total: 12, fillWidth: 0, trackWidth: 120 }, { id: 'partial', value: 6, total: 12, fillWidth: 96, trackWidth: 120 }, { id: 'full', value: 12, total: 12, fillWidth: 120, trackWidth: 120 }]),
			healthy: evaluateMeterRatios(healthyMeters),
		},
		{
			label: 'c5-meter-fill-ratio-proportional vs. no meter at the full extreme (planted control missing)',
			violating: evaluateMeterRatios([{ id: 'zero', value: 0, total: 12, fillWidth: 0, trackWidth: 120 }, { id: 'partial', value: 7, total: 12, fillWidth: 70, trackWidth: 120 }, { id: 'other', value: 10, total: 12, fillWidth: 100, trackWidth: 120 }]),
			healthy: evaluateMeterRatios(healthyMeters),
		},
		{
			label: 'panel-body-free-of-controls vs. one textarea planted inside .panel-body',
			violating: evaluateControlAbsence({ bodyTotal: 1, bodyByTerm: { ...healthyCounts.bodyByTerm, textarea: 1 }, switchButtons: 2, probeByTerm: healthyCounts.probeByTerm }),
			healthy: evaluateControlAbsence(healthyCounts),
		},
		{
			label: 'panel-body-free-of-controls vs. a probe term matching zero elements (planted control missing)',
			violating: evaluateControlAbsence({ ...healthyCounts, probeByTerm: { ...healthyCounts.probeByTerm, select: 0 } }),
			healthy: evaluateControlAbsence(healthyCounts),
		},
		{
			label: 'view-switch-swaps-representations vs. a grid pass whose barCount is still 3',
			violating: evaluateViewSwitchSwapsRepresentations(healthyDefaultPass, { ...healthyGridPass, barCount: 3 }),
			healthy: evaluateViewSwitchSwapsRepresentations(healthyDefaultPass, healthyGridPass),
		},
		{
			label: 'view-switch-swaps-representations vs. a pre-seeded default-pass flag (D-18 default never exercised)',
			violating: evaluateViewSwitchSwapsRepresentations({ ...healthyDefaultPass, storedRegistrations: 'chart' }, healthyGridPass),
			healthy: evaluateViewSwitchSwapsRepresentations(healthyDefaultPass, healthyGridPass),
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
			process.stderr.write(`[${LABEL}] matcher is inert — "${control.label}" did not fail its violating input.\n`);
		} else {
			process.stdout.write(`[${LABEL}] CAN-FAIL  ${control.label}\n              -> ${control.violating.detail}\n`);
		}
		if (!control.healthy.passed) {
			indiscriminate += 1;
			process.stderr.write(`[${LABEL}] matcher is indiscriminate — "${control.label}" ALSO failed its healthy input: ${control.healthy.detail}\n`);
		}
	}
	if (inert > 0 || indiscriminate > 0) fail(`${inert} comparator(s) inert, ${indiscriminate} indiscriminate, out of ${controls.length} control(s).`);
	process.stdout.write(`[${LABEL}] OK: all ${controls.length} controls FAIL on a violating input and PASS on a healthy one.\n`);
	process.stdout.write(`RECEIPT chart-geometry-dashboard-matchers-fired comparators=${RUNG_IDS.length} canfail=${controls.length}\n`);
	process.exit(0);
}

// ---------------------------------------------------------------------------
// Build / serve / drive plumbing — the browser half. Completed in a later
// task of this same plan; until then this is a SAFE stub: it exits
// non-zero rather than falsely reporting green.
// ---------------------------------------------------------------------------

/** @returns {Promise<void>} */
async function runBrowserGate() {
	fail('the browser half is not yet authored');
}

async function main() {
	const argv = process.argv.slice(2);
	let skipBuild = false;
	let port = DEFAULT_PORT;
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === '--skip-build') skipBuild = true;
		else if (arg === '--prove-matchers') return runProveMatchers();
		else if (arg === '--port') {
			i += 1;
			port = Number(argv[i]);
		} else {
			process.stderr.write(`[${LABEL}] unrecognised argument "${arg}" — refusing to run rather than ignoring it into a green result.\n`);
			process.exit(2);
		}
	}
	if (!Number.isInteger(port) || port <= 0) fail(`--port must be a positive integer, got "${port}".`);

	await runBrowserGate();
	void skipBuild;
}

await main();
