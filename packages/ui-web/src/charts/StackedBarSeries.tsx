/**
 * StackedBarSeries.tsx — C2 (registration request breakdown): status on the
 * axis, `IssuerType` as the two stacked segments. Colour therefore encodes
 * issuer only, never status (D-03) — two hues, a genuine 2-slot categorical.
 *
 * The 2px `stroke`/`strokeWidth` on each segment is 60-UI-SPEC's mandated
 * surface-coloured separator between touching segments — explicitly not a
 * border drawn around a mark.
 */
import { Bar, BarChart, CartesianGrid, Legend, Tooltip, XAxis, YAxis } from 'recharts';
import { ChartFrame, ChartLegend, ChartTooltip } from './chart-frame.js';
import {
	CHART_SERIES_1,
	CHART_SERIES_2,
	DATA_END_RADIUS_PX,
	MAX_BAR_THICKNESS_PX,
	SEGMENT_GAP_PX,
	STACKED_BAR_HEIGHT_PX,
	SURFACE_GAP,
} from './chart-contracts.js';
import type { ChartSeries, StackedDatum } from './chart-contracts.js';

export interface StackedBarSeriesProps {
	data: StackedDatum[];
	series: ChartSeries[];
	height?: number;
	emptyCopyKey: string;
}

export function StackedBarSeries({ data, series, height = STACKED_BAR_HEIGHT_PX, emptyCopyKey }: StackedBarSeriesProps) {
	const isEmpty = data.length === 0;
	const chartData = data.map((datum) => {
		const row: Record<string, unknown> = { key: datum.key, label: datum.label, segments: datum.segments };
		for (const segment of datum.segments) {
			row[segment.seriesKey] = segment.value;
		}
		return row;
	});

	return (
		<ChartFrame variantClassName="vt-chart--stacked-bar" height={height} isEmpty={isEmpty} emptyCopyKey={emptyCopyKey}>
			<BarChart data={chartData} margin={{ top: 24, right: 8, bottom: 8, left: 8 }}>
				<CartesianGrid className="vt-chart__grid" vertical={false} />
				<XAxis type="category" dataKey="label" tick={{ className: 'vt-chart__axis' }} axisLine={{ className: 'vt-chart__grid' }} tickLine={false} />
				<YAxis type="number" tick={{ className: 'vt-chart__axis' }} axisLine={{ className: 'vt-chart__grid' }} tickLine={false} />
				<Tooltip cursor={false} content={ChartTooltip} />
				{/* Two or more series always carry a legend — rendered unconditionally. */}
				<Legend content={ChartLegend} />
				{series.map((s, index) => {
					const isSecondSeries = index === 1;
					const segmentClassName = isSecondSeries ? 'vt-chart__segment--series-2' : 'vt-chart__segment--series-1';
					const segmentFill = isSecondSeries ? CHART_SERIES_2 : CHART_SERIES_1;
					return (
						<Bar
							key={s.key}
							dataKey={s.key}
							name={s.label}
							stackId="requests"
							className={segmentClassName}
							fill={segmentFill}
							stroke={SURFACE_GAP}
							strokeWidth={SEGMENT_GAP_PX}
							maxBarSize={MAX_BAR_THICKNESS_PX}
							radius={[DATA_END_RADIUS_PX, DATA_END_RADIUS_PX, 0, 0]}
							isAnimationActive={false}
						/>
					);
				})}
			</BarChart>
		</ChartFrame>
	);
}

export default StackedBarSeries;
