/**
 * RegistrationsPanel.tsx -- the `vrg` panel body, the deepest of the three
 * per the registration-weighting constraint (18 of 45 enforcement sites,
 * 39% of the whole authorization surface, all twelve `vrg` tables covered).
 *
 * Renders no control of any kind (rule R2). Never selects a private-tier
 * or payload column (rule R3) -- the never-disclosed private detail column
 * on `RegistrantPrivate`, the salted selective-disclosure leaves on
 * `RegistrantSelective`, the raw intake payload and its content hash on
 * `RegistrationRequest`, the unbounded authority-specific field bag on
 * `RegistrantPublic`, and every payload column on the private association
 * table never reach `@votetorrent/web-data`'s `src/officer/registrations.js`
 * (moved out of this workspace's own `src/reads/` by 54-03b), let alone
 * this component -- see that module's own header for the exact column
 * allowlist.
 *
 * Issues its own reads from an effect against `props.db` (rule R6) --
 * nothing pre-fetches on its behalf. 50-09's `PanelGrid` mounts this
 * component's tree only when the officer's own scope grants `vrg`, so an
 * officer without it never runs this effect and its rows never enter the
 * DOM.
 */
import { useEffect, useState } from 'react';
import type { PanelComponent } from './types.js';
import { t } from '@votetorrent/ui-web';
import { BarSeries, StackedBarSeries, TimeSeries } from '@votetorrent/ui-web/components';
import {
	readRegistrantStatusBreakdown,
	readRegistrationRequestBreakdown,
	readRegistrantRoster,
	readRegistrationSurfaceCounts,
	readRegistrationIntakeSeries,
	hasAnyRegistrationData,
	selectActiveElection,
} from '@votetorrent/web-data/officer';
import './election-ops.css';

// Field labels reproduced VERBATIM from the schema (rule R1: a column name
// is data, not authored prose) -- rendered as JSX EXPRESSIONS below, never
// as a literal JSX text node.
const COL = Object.freeze({
	id: 'Id',
	expiration: 'Expiration',
});

// RegistrantStatus codes reproduced VERBATIM from the schema -- a status
// with no registrants still maps to its own tone, so the bar renders at
// zero height rather than being dropped. An unknown code resolves to
// `undefined` and falls through to the chart primitive's own default tone.
const STATUS_TONE: Readonly<Record<string, 'ok' | 'warn' | 'fail'>> = Object.freeze({
	a: 'ok',
	s: 'warn',
	r: 'fail',
});

// RegistrationRequestIssuer codes, in the fixed order every C2 datum's two
// segments are built in.
const ISSUER_CODES: readonly string[] = Object.freeze(['registrant', 'bridge']);

// RegistrationRequestIssuer codes mapped to chart tones -- colour encodes
// issuer only (never status), a genuine two-slot categorical.
const ISSUER_SERIES: Readonly<Record<string, 'series-1' | 'series-2'>> = Object.freeze({
	registrant: 'series-1',
	bridge: 'series-2',
});

// The schema's own RegistrationRequestIssuer display names, reproduced
// verbatim -- a zero-valued segment (the absent issuer for a status) still
// needs a label, and no row supplies one for it.
const ISSUER_NAME: Readonly<Record<string, string>> = Object.freeze({
	registrant: 'Registrant',
	bridge: 'Bridge',
});

// RegistrationRequestStatus's own code sequence. readRegistrationRequestBreakdown
// carries no `order by`, so without this the category-axis order would be
// engine-dependent; a status code outside this sequence sorts after it, by
// code, so an added schema code degrades to a stable position.
const REQUEST_STATUS_ORDER: readonly string[] = Object.freeze(['p', 'a', 'r']);

function compareRequestStatusCodes(a: string, b: string): number {
	const ai = REQUEST_STATUS_ORDER.indexOf(a);
	const bi = REQUEST_STATUS_ORDER.indexOf(b);
	if (ai !== -1 && bi !== -1) return ai - bi;
	if (ai !== -1) return -1;
	if (bi !== -1) return 1;
	return a < b ? -1 : a > b ? 1 : 0;
}

// The `series` argument StackedBarSeries needs -- two hues, encoding issuer
// only; status rides the category axis, so colour never re-encodes it.
const REQUEST_CHART_SERIES = ISSUER_CODES.map((code) =>
	Object.freeze({ key: code, label: ISSUER_NAME[code], tone: ISSUER_SERIES[code] }),
);

interface RegistrationsData {
	statusBreakdown: Awaited<ReturnType<typeof readRegistrantStatusBreakdown>>;
	requestBreakdown: Awaited<ReturnType<typeof readRegistrationRequestBreakdown>>;
	roster: Awaited<ReturnType<typeof readRegistrantRoster>>;
	surfaceCounts: Awaited<ReturnType<typeof readRegistrationSurfaceCounts>>;
	intakeSeries: Awaited<ReturnType<typeof readRegistrationIntakeSeries>>;
	empty: boolean;
}

// A four-arm discriminated union, not a loading/data pair: `data` is
// declared on the `ready` arm only, so TypeScript narrows every render
// branch below with no non-null assertion and no fallback that could
// re-conflate a failed read with a genuinely empty election.
type RegistrationsState =
	| { status: 'unavailable' }
	| { status: 'loading' }
	| { status: 'failed' }
	| { status: 'ready'; data: RegistrationsData };

// A pure reshape of an already-aggregated read -- maps, never filters, so a
// status with zero registrants still renders as a zero-height mark rather
// than a missing bar (that read drives FROM RegistrantStatus).
function toStatusData(rows: RegistrationsData['statusBreakdown']) {
	return rows.map((row) => ({
		key: row.Code,
		label: row.Name,
		value: row.Count,
		tone: STATUS_TONE[row.Code],
		tooltip: t('panels.registrations.statusChart.tooltip', { status: row.Name, count: String(row.Count) }),
	}));
}

// A pure pivot of the flat (status, issuer) read into one datum per status
// with exactly two segments, always -- the absent issuer for a status
// zero-fills rather than being omitted, so the chart never promises a
// series it does not draw.
function toRequestData(rows: RegistrationsData['requestBreakdown']) {
	const byStatus = new Map<string, { label: string; byIssuer: Map<string, { count: number; issuerName: string }> }>();
	for (const row of rows) {
		const entry = byStatus.get(row.Status) ?? { label: row.StatusName, byIssuer: new Map<string, { count: number; issuerName: string }>() };
		entry.byIssuer.set(row.IssuerType, { count: row.Count, issuerName: row.IssuerName });
		byStatus.set(row.Status, entry);
	}

	return [...byStatus.entries()]
		.sort(([a], [b]) => compareRequestStatusCodes(a, b))
		.map(([code, entry]) => ({
			key: code,
			label: entry.label,
			segments: ISSUER_CODES.map((issuerCode) => {
				const found = entry.byIssuer.get(issuerCode);
				const value = found ? found.count : 0;
				const issuerName = found ? found.issuerName : ISSUER_NAME[issuerCode];
				return {
					seriesKey: issuerCode,
					value,
					tooltip: t('panels.registrations.requestChart.tooltip', {
						status: entry.label,
						issuer: issuerName,
						count: String(value),
					}),
				};
			}),
		}));
}

// A 19-character bucketStart is the hour form (YYYY-MM-DDTHH:00:00); its
// axis label is the HH:00 slice. Everything else is the ten-character
// YYYY-MM-DD form (day or week -- both serialise identically), whose label
// is the whole string. The read returns no unit field, and this length test
// is the complete unit handling this panel needs.
const HOUR_BUCKET_START_LENGTH = 19;

// A pure reshape of the intake read -- `count` is deliberately lower-case,
// unlike every other read in this module. Zero-count buckets arrive as rows
// with `count: 0` and pass through untouched, rendering as points on the
// baseline rather than gaps.
function toIntakeData(rows: RegistrationsData['intakeSeries']) {
	return rows.map((row) => ({
		key: row.bucketStart,
		label: row.bucketStart.length === HOUR_BUCKET_START_LENGTH ? row.bucketStart.slice(11, 16) : row.bucketStart,
		value: row.count,
		tooltip: t('panels.registrations.intakeChart.tooltip', { bucket: row.bucketStart, count: String(row.count) }),
	}));
}

const RegistrationsPanel: PanelComponent = ({ capability, db }) => {
	const [state, setState] = useState<RegistrationsState>({ status: 'loading' });

	useEffect(() => {
		let cancelled = false;

		if (!db) {
			setState({ status: 'unavailable' });
			return () => {
				cancelled = true;
			};
		}

		setState({ status: 'loading' });

		const boundDb = db;
		(async () => {
			try {
				const activeElection = await selectActiveElection(boundDb);
				const electionId = activeElection ? activeElection.Id : '';
				const statusBreakdown = await readRegistrantStatusBreakdown(boundDb);
				const requestBreakdown = await readRegistrationRequestBreakdown(boundDb);
				const roster = await readRegistrantRoster(boundDb);
				const surfaceCounts = await readRegistrationSurfaceCounts(boundDb, electionId);
				const intakeSeries = await readRegistrationIntakeSeries(boundDb);
				const anyData = await hasAnyRegistrationData(boundDb);
				if (!cancelled) {
					setState({
						status: 'ready',
						data: { statusBreakdown, requestBreakdown, roster, surfaceCounts, intakeSeries, empty: !anyData },
					});
				}
			} catch (err) {
				// The error CLASS only, never the message. `err` comes from a query
				// against tables full of registrant information, and Quereus and its
				// constraint layer routinely embed the offending row and column values
				// in an error message. The browser console is a durable, exportable,
				// screenshot-able sink; a message must name table names, column names
				// and integer counts only.
				// eslint-disable-next-line no-console
				console.error('RegistrationsPanel: a read failed:', (err as { name?: string })?.name ?? 'Error');
				if (!cancelled) {
					setState({ status: 'failed' });
				}
			}
		})();

		return () => {
			cancelled = true;
		};
	}, [db]);

	if (state.status === 'unavailable') {
		return <p className="panel-empty">{t('panels.registrations.unavailable')}</p>;
	}

	if (state.status === 'loading') {
		return <p className="panel-empty">{t('panels.registrations.loading')}</p>;
	}

	if (state.status === 'failed') {
		return <p className="panel-empty">{t('panels.registrations.readFailed')}</p>;
	}

	if (state.data.empty) {
		return <p className="panel-empty">{t(capability.emptyKey)}</p>;
	}

	const { statusBreakdown, requestBreakdown, roster, surfaceCounts, intakeSeries } = state.data;
	const rosterFigure = `${roster.rows.length} / ${roster.total}`;

	return (
		<>
			<section className="eo-section">
				<h4 className="eo-heading">{t('panels.registrations.statusHeading')}</h4>
				<BarSeries data={toStatusData(statusBreakdown)} />
				<div className="eo-count-grid">
					{statusBreakdown.map((row) => (
						<div key={row.Code}>
							<span className="eo-datum">{row.Name}</span>
							<span>{row.Count}</span>
						</div>
					))}
				</div>
			</section>

			<section className="eo-section">
				<h4 className="eo-heading">{t('panels.registrations.requestsHeading')}</h4>
				<StackedBarSeries
					data={toRequestData(requestBreakdown)}
					series={REQUEST_CHART_SERIES}
					emptyCopyKey="panels.registrations.requestChart.empty"
				/>
				<div className="eo-count-grid">
					{requestBreakdown.map((row) => {
						const label = `${row.StatusName} / ${row.IssuerName}`;
						return (
							<div key={`${row.Status}-${row.IssuerType}`}>
								<span className="eo-datum">{label}</span>
								<span>{row.Count}</span>
							</div>
						);
					})}
				</div>
			</section>

			<section className="eo-section">
				<TimeSeries data={toIntakeData(intakeSeries)} emptyCopyKey="panels.registrations.intakeChart.empty" />
			</section>

			<section className="eo-section">
				<h4 className="eo-heading">{t('panels.registrations.rosterHeading')}</h4>
				<span className="eo-datum">{rosterFigure}</span>
				{roster.rows.map((row) => (
					<div className="eo-row" key={row.Id}>
						<span>{row.LastName}</span>
						<span>{row.FirstName}</span>
						<span className="eo-datum">{row.District}</span>
						<span>{row.Status}</span>
						<span className="pill" title={COL.id}>
							{row.Id}
						</span>
						<span className="eo-datum" title={COL.expiration}>
							{row.Expiration}
						</span>
					</div>
				))}
			</section>

			<section className="eo-section">
				<h4 className="eo-heading">{t('panels.registrations.surfaceCountsHeading')}</h4>
				<div className="eo-count-grid">
					{surfaceCounts.map((entry) => (
						<div key={entry.table}>
							<span className="eo-datum">{entry.table}</span>
							<span>{entry.count}</span>
						</div>
					))}
				</div>
			</section>
		</>
	);
};

export default RegistrationsPanel;
