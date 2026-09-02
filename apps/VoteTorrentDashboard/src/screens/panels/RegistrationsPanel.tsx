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
import {
	readRegistrantStatusBreakdown,
	readRegistrationRequestBreakdown,
	readRegistrantRoster,
	readRegistrationSurfaceCounts,
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

interface RegistrationsData {
	statusBreakdown: Awaited<ReturnType<typeof readRegistrantStatusBreakdown>>;
	requestBreakdown: Awaited<ReturnType<typeof readRegistrationRequestBreakdown>>;
	roster: Awaited<ReturnType<typeof readRegistrantRoster>>;
	surfaceCounts: Awaited<ReturnType<typeof readRegistrationSurfaceCounts>>;
	empty: boolean;
}

interface RegistrationsState {
	loading: boolean;
	data: RegistrationsData | null;
}

const RegistrationsPanel: PanelComponent = ({ capability, db }) => {
	const [state, setState] = useState<RegistrationsState>({ loading: true, data: null });

	useEffect(() => {
		let cancelled = false;

		if (!db) {
			setState({ loading: false, data: null });
			return () => {
				cancelled = true;
			};
		}

		setState({ loading: true, data: null });

		const boundDb = db;
		(async () => {
			try {
				const activeElection = await selectActiveElection(boundDb);
				const electionId = activeElection ? activeElection.Id : '';
				const statusBreakdown = await readRegistrantStatusBreakdown(boundDb);
				const requestBreakdown = await readRegistrationRequestBreakdown(boundDb);
				const roster = await readRegistrantRoster(boundDb);
				const surfaceCounts = await readRegistrationSurfaceCounts(boundDb, electionId);
				const anyData = await hasAnyRegistrationData(boundDb);
				if (!cancelled) {
					setState({
						loading: false,
						data: { statusBreakdown, requestBreakdown, roster, surfaceCounts, empty: !anyData },
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
					setState({ loading: false, data: null });
				}
			}
		})();

		return () => {
			cancelled = true;
		};
	}, [db]);

	if (!db || state.loading || !state.data || state.data.empty) {
		return <p className="panel-empty">{t(capability.emptyKey)}</p>;
	}

	const { statusBreakdown, requestBreakdown, roster, surfaceCounts } = state.data;
	const rosterFigure = `${roster.rows.length} / ${roster.total}`;

	return (
		<>
			<section className="eo-section">
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
