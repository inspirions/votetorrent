/**
 * gap-probe.tsx — throwaway measurement harness for three Nyquist gaps
 * (G8/G9/G10, phase 60 `deferred-items.md` WR-01/WR-02/WR-03). Mounts the
 * REAL `BarSeries`/`StackedBarSeries`/`TimeSeries` primitives (via the public
 * `@votetorrent/ui-web/components` barrel, exactly as production callers do)
 * against three edge shapes no existing fixture reaches:
 *
 *  - all-zero-bar / all-zero-stacked / all-zero-time: every row's `value` is
 *    0 (non-empty array) — `domain={[0, 'dataMax']}`'s `dataMax === 0` edge.
 *  - legend-mismatch: a `StackedBarSeries` `series` entry toned `warn`, a
 *    valid `ChartTone` per `chart-contracts.ts` but one
 *    `LEGEND_SWATCH_CLASS_BY_TONE` does not cover.
 *  - tall-label-bar: a `BarSeries` (vertical) with an extreme production-
 *    scale count, to measure the top `LabelList`'s real clearance against
 *    the fixed 24px top margin.
 *
 * This file is NOT wired into `run-chart-geometry-gate.mjs`'s rung registry
 * and NOT referenced by `web-gates.yml` — it is a measurement-only artifact.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../../src/app.css';
import { BarSeries, StackedBarSeries, TimeSeries } from '@votetorrent/ui-web/components';

const win = window as unknown as Record<string, unknown>;

const SETTLE_FRAMES = 60;

function settle(maxFrames: number): Promise<void> {
	return new Promise((resolve) => {
		let frames = 0;
		function tick() {
			frames += 1;
			if (frames >= maxFrames) {
				resolve();
				return;
			}
			requestAnimationFrame(tick);
		}
		requestAnimationFrame(tick);
	});
}

const ALL_ZERO_BAR = [
	{ key: 'a', label: 'Active', value: 0, tone: 'ok' as const },
	{ key: 's', label: 'Suspended', value: 0, tone: 'warn' as const },
	{ key: 'r', label: 'Revoked', value: 0, tone: 'fail' as const },
];

const ALL_ZERO_STACKED = [
	{
		key: 'p',
		label: 'Pending',
		segments: [
			{ seriesKey: 'registrant', value: 0 },
			{ seriesKey: 'bridge', value: 0 },
		],
	},
	{
		key: 'a',
		label: 'Approved',
		segments: [
			{ seriesKey: 'registrant', value: 0 },
			{ seriesKey: 'bridge', value: 0 },
		],
	},
];

const REQUEST_SERIES = [
	{ key: 'registrant', label: 'Registrant', tone: 'series-1' as const },
	{ key: 'bridge', label: 'Bridge', tone: 'series-2' as const },
];

const ALL_ZERO_TIME = [
	{ key: 't1', label: 'Wk 1', value: 0 },
	{ key: 't2', label: 'Wk 2', value: 0 },
	{ key: 't3', label: 'Wk 3', value: 0 },
	{ key: 't4', label: 'Wk 4', value: 0 },
];

// A ChartTone the LEGEND_SWATCH_CLASS_BY_TONE map does NOT cover, on a
// StackedBarSeries -- reaches ChartLegend through the real component, not a
// hand-built literal.
const LEGEND_MISMATCH_DATA = [
	{
		key: 'p',
		label: 'Pending',
		segments: [
			{ seriesKey: 'registrant', value: 5 },
			{ seriesKey: 'flagged', value: 3 },
		],
	},
	{
		key: 'a',
		label: 'Approved',
		segments: [
			{ seriesKey: 'registrant', value: 8 },
			{ seriesKey: 'flagged', value: 1 },
		],
	},
];

const LEGEND_MISMATCH_SERIES = [
	{ key: 'registrant', label: 'Registrant', tone: 'series-1' as const },
	// A tone valid per ChartTone but uncovered by LEGEND_SWATCH_CLASS_BY_TONE.
	{ key: 'flagged', label: 'Flagged', tone: 'warn' as const },
];

// Extreme production-scale counts -- a seven-digit county roll, well past
// any real election, to stress the top LabelList's clearance against the
// fixed 24px margin as far as a realistic fixture can push it.
const TALL_LABEL_BAR = [
	{ key: 'a', label: 'Active', value: 9876543, tone: 'ok' as const },
	{ key: 's', label: 'Suspended', value: 612345, tone: 'warn' as const },
	{ key: 'r', label: 'Revoked', value: 0, tone: 'fail' as const },
];

function GapProbeHarness() {
	return (
		<div className="gap-probe-harness" style={{ width: '420px' }}>
			<div data-gap-probe="all-zero-bar">
				<BarSeries data={ALL_ZERO_BAR} />
			</div>
			<div data-gap-probe="all-zero-stacked">
				<StackedBarSeries data={ALL_ZERO_STACKED} series={REQUEST_SERIES} emptyCopyKey="panels.registrations.requestChart.empty" />
			</div>
			<div data-gap-probe="all-zero-time">
				<TimeSeries data={ALL_ZERO_TIME} emptyCopyKey="panels.registrations.intakeChart.empty" />
			</div>
			<div data-gap-probe="legend-mismatch">
				<StackedBarSeries data={LEGEND_MISMATCH_DATA} series={LEGEND_MISMATCH_SERIES} emptyCopyKey="panels.registrations.requestChart.empty" />
			</div>
			<div data-gap-probe="tall-label-bar">
				<BarSeries data={TALL_LABEL_BAR} />
			</div>
		</div>
	);
}

async function main() {
	const container = document.getElementById('root');
	let renderError: string | null = null;

	if (container) {
		try {
			const root = createRoot(container);
			root.render(
				<StrictMode>
					<GapProbeHarness />
				</StrictMode>,
			);
		} catch (err) {
			renderError = String((err as { message?: unknown })?.message ?? err);
		}
	} else {
		renderError = 'gap-probe.html is missing #root';
	}

	await settle(SETTLE_FRAMES);

	win.__GAP_PROBE_DONE__ = true;
	win.__GAP_PROBE_ERROR__ = renderError;
}

main();
