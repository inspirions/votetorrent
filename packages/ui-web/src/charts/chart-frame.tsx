/**
 * chart-frame.tsx — the internal scaffolding every chart primitive in this
 * directory shares (60-03): the D-21 empty-frame branch, the shared
 * tooltip/legend `content` renderers (so Recharts' own tooltip/legend DOM
 * never renders inside a panel body — D-11/D-12), and the one hook in this
 * directory, `useContainerWidth`, which resolves 60-UI-SPEC's tick-density
 * rule (at most 6 ticks at or above 400px, at most 4 below it).
 *
 * NOT exported from `../components.js` — the barrel re-exports only the
 * four public primitives (`BarSeries`, `StackedBarSeries`, `TimeSeries`,
 * `Meter`); this module is their shared internal.
 *
 * `ChartTooltip`/`ChartLegend` render only the caller-supplied `label` /
 * `tooltip` strings a hovered payload already carries (in `--muted`/`--text`,
 * never the series hue — "text never wears the data colour") — this file
 * authors no English of its own either.
 */
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ResponsiveContainer } from 'recharts';
import { t } from '../copy.js';
import { NARROW_CONTAINER_PX, TICKS_NARROW, TICKS_WIDE } from './chart-contracts.js';
import type { StackedSegment } from './chart-contracts.js';

export interface ChartFrameProps {
	variantClassName: string;
	height: number;
	isEmpty: boolean;
	emptyCopyKey?: string;
	children: ReactNode;
}

/**
 * D-21: an empty chart renders its own frame plus explicit copy, never a
 * blank region — an officer must be able to tell an empty chart from a
 * broken one.
 */
export function ChartFrame({ variantClassName, height, isEmpty, emptyCopyKey, children }: ChartFrameProps) {
	const rootClassName = ['vt-chart', variantClassName].join(' ');
	return (
		<div className={rootClassName}>
			{isEmpty ? (
				<div className="vt-chart__empty-frame" style={{ height }}>
					{emptyCopyKey ? <p className="vt-chart__empty">{t(emptyCopyKey)}</p> : null}
				</div>
			) : (
				<ResponsiveContainer width="100%" height={height}>
					{children}
				</ResponsiveContainer>
			)}
		</div>
	);
}

/** `dataKey` mirrors Recharts' own `DataKey<any>` union (string | number | accessor function) — widened here only so this content renderer accepts whatever shape Recharts hands it, never narrowed back down by this file. */
interface ChartTooltipPayloadEntry {
	dataKey?: string | number | ((obj: any) => unknown);
	payload?: {
		label?: string;
		tooltip?: string;
		segments?: ReadonlyArray<StackedSegment>;
	};
}

export interface ChartTooltipProps {
	active?: boolean;
	label?: string | number;
	payload?: ReadonlyArray<ChartTooltipPayloadEntry>;
}

/**
 * The shared `content` renderer for every `<Tooltip>` in this directory.
 * Supplying `content` is deliberate and load-bearing twice: it keeps
 * tooltip text off the series hue, and it means Recharts' own default
 * tooltip DOM never renders inside a panel body (D-11/D-12).
 */
export function ChartTooltip(props: ChartTooltipProps) {
	const { active, payload, label } = props;
	if (!active || !payload || payload.length === 0) return null;
	const entry = payload[payload.length - 1];
	const datum = entry?.payload;
	const segmentTooltip = datum?.segments?.find((segment) => segment.seriesKey === entry?.dataKey)?.tooltip;
	const tooltipText = segmentTooltip ?? datum?.tooltip ?? '';
	const labelText = datum?.label ?? label ?? '';
	return (
		<div className="vt-chart__tooltip">
			<span className="vt-chart__tooltip-label">{labelText}</span>
			<span className="vt-chart__tooltip-value">{tooltipText}</span>
		</div>
	);
}

export interface ChartLegendProps {
	payload?: ReadonlyArray<{ value?: string; dataKey?: string | number | ((obj: any) => unknown) }>;
}

/**
 * The shared `content` renderer for every `<Legend>` in this directory
 * (StackedBarSeries only, today). No clickable element and no navigation
 * target, no handler — the swatch is a styled `<span>`, so no legend-
 * filtering affordance exists (D-11).
 */
export function ChartLegend(props: ChartLegendProps) {
	const items = props.payload ?? [];
	return (
		<ul className="vt-chart__legend">
			{items.map((item, index) => {
				const swatchModifier = index === 0 ? 'vt-chart__legend-swatch--series-1' : 'vt-chart__legend-swatch--series-2';
				const swatchClassName = ['vt-chart__legend-swatch', swatchModifier].join(' ');
				return (
					<li className="vt-chart__legend-item" key={String(item.dataKey ?? item.value ?? index)}>
						<span className={swatchClassName} />
						<span className="vt-chart__legend-label">{item.value}</span>
					</li>
				);
			})}
		</ul>
	);
}

/**
 * `tickCountFor` — 60-UI-SPEC's hard narrow-viewport constraint: at most 6
 * ticks at or above 400px, at most 4 below it.
 */
export function tickCountFor(width: number): number {
	return width < NARROW_CONTAINER_PX ? TICKS_NARROW : TICKS_WIDE;
}

/**
 * The one hook in this directory. Reports the wrapper element's own px
 * width via a `ResizeObserver`, disconnecting on cleanup. Falls back to the
 * wide branch (the default state below is already `>= NARROW_CONTAINER_PX`)
 * when `ResizeObserver` is unavailable.
 */
export function useContainerWidth() {
	const ref = useRef<HTMLDivElement | null>(null);
	const [width, setWidth] = useState(NARROW_CONTAINER_PX);

	useEffect(() => {
		const el = ref.current;
		if (el == null) return undefined;
		if (typeof ResizeObserver === 'undefined') {
			setWidth(el.getBoundingClientRect().width || NARROW_CONTAINER_PX);
			return undefined;
		}
		const observer = new ResizeObserver((entries) => {
			const entry = entries[0];
			if (entry) setWidth(entry.contentRect.width);
		});
		observer.observe(el);
		return () => observer.disconnect();
	}, []);

	return { ref, width };
}
