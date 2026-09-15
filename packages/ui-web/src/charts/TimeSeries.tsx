/**
 * TimeSeries.tsx — C3 (registration-intake bucketed time series): a single
 * blue line with a hover crosshair and adaptive tick density.
 *
 * The crosshair is a `cursor` OBJECT handed to `<Tooltip>`, not a handler —
 * D-11's "hover tooltips plus a crosshair on the time series" is satisfied
 * with no click path anywhere. Zero-count buckets arrive from the caller as
 * rows with `value: 0` and must render as points on the baseline, never as
 * gaps — this component never filters the array and never sets
 * `connectNulls`.
 */
import { CartesianGrid, Line, LineChart, Tooltip, XAxis, YAxis } from 'recharts';
import { ChartFrame, ChartTooltip, tickCountFor, useContainerWidth } from './chart-frame.js';
import { CHART_SERIES_1, END_DOT_RADIUS_PX, GRID_STROKE_WIDTH_PX, LINE_STROKE_WIDTH_PX, TIME_SERIES_HEIGHT_PX } from './chart-contracts.js';
import type { ChartDatum } from './chart-contracts.js';

export interface TimeSeriesProps {
	data: ChartDatum[];
	height?: number;
	emptyCopyKey: string;
}

export function TimeSeries({ data, height = TIME_SERIES_HEIGHT_PX, emptyCopyKey }: TimeSeriesProps) {
	const { ref, width } = useContainerWidth();
	const isEmpty = data.length === 0;

	return (
		<div ref={ref}>
			<ChartFrame variantClassName="vt-chart--time-series" height={height} isEmpty={isEmpty} emptyCopyKey={emptyCopyKey}>
				<LineChart data={data} margin={{ top: 8, right: 16, bottom: 8, left: 8 }}>
					<CartesianGrid className="vt-chart__grid" vertical={false} />
					<XAxis
						dataKey="label"
						tick={{ className: 'vt-chart__axis' }}
						axisLine={{ className: 'vt-chart__grid' }}
						tickLine={false}
						tickCount={tickCountFor(width)}
						interval="preserveStartEnd"
					/>
					<YAxis tick={{ className: 'vt-chart__axis' }} axisLine={{ className: 'vt-chart__grid' }} tickLine={false} />
					<Tooltip cursor={{ className: 'vt-chart__crosshair', strokeWidth: GRID_STROKE_WIDTH_PX }} content={ChartTooltip} />
					<Line
						type="linear"
						dataKey="value"
						dot={false}
						className="vt-chart__line"
						stroke={CHART_SERIES_1}
						strokeWidth={LINE_STROKE_WIDTH_PX}
						strokeLinejoin="round"
						strokeLinecap="round"
						activeDot={{ className: 'vt-chart__dot', r: END_DOT_RADIUS_PX }}
						isAnimationActive={false}
					/>
				</LineChart>
			</ChartFrame>
		</div>
	);
}

export default TimeSeries;
