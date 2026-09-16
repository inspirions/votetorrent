#!/usr/bin/env node
/**
 * measure-gap-probe.mjs — throwaway Playwright driver for `gap-probe.tsx`
 * (G8/G9/G10, phase 60 `deferred-items.md` WR-01/WR-02/WR-03). Serves the
 * ALREADY-BUILT `dist-gap-probe/` (run `vite build --config
 * test/browser/vite.gap-probe.config.ts` first), loads the page in headless
 * Chromium, and prints a raw JSON measurement transcript -- no pass/fail
 * assertions here, this is the "measure first" step the deferred-items
 * entries say was never taken.
 *
 * G8/WR-01 MEASURED RESULT — DEFECTIVE, escalated (no passing test written
 * against it; see the phase's VALIDATION report): for an all-zero,
 * non-empty dataset, `domain={[0, 'dataMax']}` (dataMax === 0) makes
 * Recharts render ZERO bar marks at all on `BarSeries` and
 * `StackedBarSeries` (`.recharts-bar-rectangles` is empty for every series),
 * and collapses the numeric axis to a single "0" tick positioned at the
 * PLOT AREA'S VERTICAL MIDPOINT, not its baseline. `TimeSeries` is worse:
 * its line still renders, but as a flat line running through the plot
 * area's midpoint (`d="M68,55L180,55L292,55L404,55"` at height 94, midpoint
 * 55) — visually indistinguishable from a genuine mid-range constant value,
 * actively misleading for an all-zero intake week. None of the three
 * primitives falls back to the `isEmpty`/D-21 empty-frame copy (that branch
 * requires `data.length === 0`, not all-zero), so an officer sees a chart
 * that looks either broken (no bars) or wrong (a false mid-height line),
 * with no error and no explanatory copy.
 *
 * G9/WR-02 MEASURED RESULT — DEFECTIVE, escalated: a `StackedBarSeries`
 * `series` entry toned `warn` (a valid `ChartTone`, per `chart-contracts.ts`,
 * that `LEGEND_SWATCH_CLASS_BY_TONE` does not cover) resolves its legend
 * swatch to ONLY the base `vt-chart__legend-swatch` class (no tone
 * modifier), computed background `rgb(141, 151, 168)` (`var(--muted)`,
 * confirmed against `components.css`) -- a generic grey, not the `--warn`
 * amber a real "warn"-toned series should read as, and not an error of any
 * kind. This is exactly the silent-miss WR-02 describes: reachable through
 * the real public component API today (no future rename required), and
 * invisible to a screenshot review sitting next to a correctly-toned sibling
 * swatch (`series-1`, `rgb(57, 135, 229)`, which resolves correctly).
 *
 * G10/WR-03's finding was NOT defective on measurement (positive, if tight,
 * clearance) and is closed with a real, mutation-proven passing test
 * instead -- see `label-headroom-gate.mjs`, not this file.
 *
 * Not wired into any package.json script, not part of any CI gate.
 */
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serveDist } from '../../../../packages/ui-web/scripts/lib/serve-dist.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(__dirname, '..', '..');
const DIST = path.join(APP_DIR, 'dist-gap-probe');
const PORT = 5299;

async function main() {
	const { url, close } = await serveDist(DIST, PORT);
	const browser = await chromium.launch({ headless: true });
	try {
		const page = await browser.newPage();
		const consoleMessages = [];
		page.on('console', (msg) => consoleMessages.push(`${msg.type()}: ${msg.text()}`));
		const pageErrors = [];
		page.on('pageerror', (err) => pageErrors.push(String(err)));

		await page.goto(`${url}/test/browser/gap-probe.html`, { waitUntil: 'load' });
		await page.waitForFunction(() => window.__GAP_PROBE_DONE__ === true, { timeout: 10_000 });

		const renderError = await page.evaluate(() => window.__GAP_PROBE_ERROR__ ?? null);

		const measured = await page.evaluate(() => {
			/** @param {string} name */
			function probe(name) {
				return document.querySelector(`[data-gap-probe="${name}"]`);
			}

			/** @param {Element} root */
			function measureAxes(root) {
				if (!root) return null;
				const svg = root.querySelector('svg');
				const svgBox = svg ? svg.getBoundingClientRect() : null;
				const xTicks = [...root.querySelectorAll('.recharts-xAxis .recharts-cartesian-axis-tick text')].map((el) => el.textContent);
				const yTicks = [...root.querySelectorAll('.recharts-yAxis .recharts-cartesian-axis-tick text')].map((el) => el.textContent);
				const bars = [...root.querySelectorAll('.recharts-bar-rectangle path, .recharts-bar-rectangle rect')].map((el) => {
					const box = el.getBoundingClientRect();
					return { height: box.height, width: box.width, top: box.top, bottom: box.bottom };
				});
				const line = root.querySelector('.recharts-line-curve, path.vt-chart__line');
				const lineD = line ? line.getAttribute('d') : null;
				return {
					svgBox: svgBox ? { width: svgBox.width, height: svgBox.height, top: svgBox.top, bottom: svgBox.bottom } : null,
					xTicks,
					yTicks,
					bars,
					lineD,
					innerHTMLLength: root.innerHTML.length,
					hasNaNInSvg: svg ? /NaN/.test(svg.outerHTML) : null,
				};
			}

			const allZeroBar = measureAxes(probe('all-zero-bar'));
			const allZeroStacked = measureAxes(probe('all-zero-stacked'));
			const allZeroTime = measureAxes(probe('all-zero-time'));

			// legend-mismatch: read the legend swatch's real computed background
			// colour for BOTH series, plus the base (no-modifier) swatch colour
			// measured off a synthetic control span for comparison.
			const legendRoot = probe('legend-mismatch');
			const legendItems = legendRoot
				? [...legendRoot.querySelectorAll('.vt-chart__legend-item')].map((item) => {
						const label = item.querySelector('.vt-chart__legend-label')?.textContent ?? null;
						const swatch = item.querySelector('.vt-chart__legend-swatch');
						const swatchClassName = swatch ? swatch.className : null;
						const swatchColor = swatch ? getComputedStyle(swatch).backgroundColor : null;
						return { label, swatchClassName, swatchColor };
					})
				: null;

			// tall-label-bar: measure the top LabelList count text's box vs the
			// chart's own SVG box AND vs the plot area's own top (y=0 gridline).
			const tallRoot = probe('tall-label-bar');
			let tallLabel = null;
			if (tallRoot) {
				const svg = tallRoot.querySelector('svg');
				const svgBox = svg ? svg.getBoundingClientRect() : null;
				const labelTexts = [...tallRoot.querySelectorAll('.vt-chart__label')].map((el) => {
					const box = el.getBoundingClientRect();
					return { text: el.textContent, box: { top: box.top, bottom: box.bottom, left: box.left, right: box.right, height: box.height } };
				});
				// The first (top) horizontal gridline drawn by CartesianGrid marks
				// the plot area's own y=0 line -- read directly rather than assumed.
				const gridLines = [...tallRoot.querySelectorAll('.recharts-cartesian-grid-horizontal line')].map((el) => el.getBoundingClientRect().top);
				const plotAreaTop = gridLines.length > 0 ? Math.min(...gridLines) : null;
				tallLabel = {
					svgBox: svgBox ? { top: svgBox.top, bottom: svgBox.bottom, height: svgBox.height } : null,
					labelTexts,
					plotAreaTop,
				};
			}

			return { allZeroBar, allZeroStacked, allZeroTime, legendItems, tallLabel };
		});

		process.stdout.write(
			JSON.stringify(
				{
					renderError,
					consoleMessages,
					pageErrors,
					measured,
				},
				null,
				2,
			) + '\n',
		);
	} finally {
		await browser.close();
		await close();
	}
}

main().catch((err) => {
	process.stderr.write(`measure-gap-probe: ${err?.stack ?? err}\n`);
	process.exit(1);
});
