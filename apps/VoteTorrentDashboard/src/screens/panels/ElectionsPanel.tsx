/**
 * ElectionsPanel.tsx -- the `mel` panel body plus the computed lifecycle
 * pill mount point.
 *
 * Reads `snapshotInstant` from ITS OWN PROPS (contract C7, 50-09's
 * `PanelGrid` threads it through unconditionally) -- no React context, no
 * hook, no import from another screen. `resolveComparisonInstant` supplies
 * the `nowCanonicalDatetime()` fallback when the prop is absent; that
 * branch is unit-tested in `packages/ui-web/test/election-phase.test.mjs`
 * (moved there alongside the module itself) and is not duplicated here.
 *
 * Renders no control of any kind (rule R2) and issues its own reads from an
 * effect against `props.db` (rule R6) -- see `RegistrationsPanel.tsx`'s
 * header for the shared reasoning.
 */
import { useEffect, useState } from 'react';
import type { PanelComponent } from './types.js';
import { t } from '@votetorrent/ui-web';
import {
	selectActiveElection,
	readElectionOverview,
	readElectionPolicies,
	countElections,
} from '../../reads/elections.js';
import {
	ELECTION_EVENT_ORDER,
	computeElectionPhase,
	resolveComparisonInstant,
} from '@votetorrent/ui-web/lifecycle';
import { toCanonicalDatetime } from '@votetorrent/vote-engine/browser';
import { LifecyclePill } from '@votetorrent/ui-web/components';
import './election-ops.css';

const EM_DASH = '—';
const CANONICAL_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;

// Field labels reproduced VERBATIM from the schema (rule R1), rendered as
// JSX EXPRESSIONS, never as literal JSX text.
const COL = Object.freeze({
	type: 'Type',
	date: 'Date',
	revisionDeadline: 'RevisionDeadline',
	ballotDeadline: 'BallotDeadline',
	revision: 'Revision',
	revisionTimestamp: 'RevisionTimestamp',
	keyholderThreshold: 'KeyholderThreshold',
	tags: 'Tags',
	registrationFieldCount: 'ElectionRegistrationField',
	disclosurePolicyCount: 'ElectionDisclosurePolicy',
	attestationRequired: 'AttestationRequired',
});

/**
 * Normalise one raw `Timeline` event value for display/comparison. Never
 * throws: an un-normalisable value (or an absent event) resolves to `null`,
 * and the caller renders the em dash for it.
 */
function normalizeTimelineValue(raw: unknown): string | null {
	if (raw === undefined || raw === null) return null;
	if (typeof raw !== 'string' && typeof raw !== 'number') return null;
	const normalized = toCanonicalDatetime(raw);
	return CANONICAL_RE.test(normalized) ? normalized : null;
}

interface ElectionsData {
	active: NonNullable<Awaited<ReturnType<typeof selectActiveElection>>>;
	overview: NonNullable<Awaited<ReturnType<typeof readElectionOverview>>>;
	policies: Awaited<ReturnType<typeof readElectionPolicies>>;
	totalElections: number;
}

interface ElectionsState {
	loading: boolean;
	data: ElectionsData | null;
}

const ElectionsPanel: PanelComponent = ({ capability, db, snapshotInstant }) => {
	const [state, setState] = useState<ElectionsState>({ loading: true, data: null });

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
				const active = await selectActiveElection(boundDb);
				if (!active) {
					if (!cancelled) setState({ loading: false, data: null });
					return;
				}
				const overview = await readElectionOverview(boundDb, active.Id);
				if (!overview) {
					if (!cancelled) setState({ loading: false, data: null });
					return;
				}
				const policies = await readElectionPolicies(boundDb, active.Id);
				const totalElections = await countElections(boundDb);
				if (!cancelled) {
					setState({ loading: false, data: { active, overview, policies, totalElections } });
				}
			} catch (err) {
				// The error CLASS only, never the message. `err` comes from a query
				// against tables full of registrant information, and Quereus and its
				// constraint layer routinely embed the offending row and column values
				// in an error message. The browser console is a durable, exportable,
				// screenshot-able sink; a message must name table names, column names
				// and integer counts only.
				// eslint-disable-next-line no-console
				console.error('ElectionsPanel: a read failed:', (err as { name?: string })?.name ?? 'Error');
				if (!cancelled) {
					setState({ loading: false, data: null });
				}
			}
		})();

		return () => {
			cancelled = true;
		};
	}, [db]);

	if (!db || state.loading || !state.data) {
		return <p className="panel-empty">{t(capability.emptyKey)}</p>;
	}

	const { active, overview, policies, totalElections } = state.data;
	const atCanonical = resolveComparisonInstant(snapshotInstant);
	const { phase } = computeElectionPhase(overview.Timeline, atCanonical);

	let timeline: Record<string, unknown> = {};
	try {
		const parsed = typeof overview.Timeline === 'string' ? JSON.parse(overview.Timeline) : overview.Timeline;
		if (parsed && typeof parsed === 'object') {
			timeline = parsed as Record<string, unknown>;
		}
	} catch {
		timeline = {};
	}

	const tagsJoined = overview.Tags.join(', ');
	const electionsFigure = `1 / ${totalElections}`;

	return (
		<>
			<section className="eo-section">
				<div className="eo-row">
					<span>{active.Title}</span>
					<LifecyclePill phase={phase} />
				</div>
			</section>

			<section className="eo-section">
				<dl className="eo-kv">
					<dt>{COL.type}</dt>
					<dd>{active.TypeName ?? EM_DASH}</dd>
					<dt>{COL.date}</dt>
					<dd>{active.Date}</dd>
					<dt>{COL.revisionDeadline}</dt>
					<dd>{active.RevisionDeadline}</dd>
					<dt>{COL.ballotDeadline}</dt>
					<dd>{active.BallotDeadline}</dd>
					<dt>{COL.revision}</dt>
					<dd>{overview.Revision}</dd>
					<dt>{COL.revisionTimestamp}</dt>
					<dd>{overview.RevisionTimestamp}</dd>
					<dt>{COL.keyholderThreshold}</dt>
					<dd>{overview.KeyholderThreshold}</dd>
					<dt>{COL.tags}</dt>
					<dd>{tagsJoined}</dd>
				</dl>
			</section>

			<section className="eo-section">
				<ul className="eo-timeline">
					{ELECTION_EVENT_ORDER.map((event) => {
						const normalized = normalizeTimelineValue(timeline[event]);
						const display = normalized ?? EM_DASH;
						const isPast = normalized !== null && normalized < atCanonical;
						return (
							<li key={event} className={isPast ? 'eo-tl--past' : 'eo-tl--future'}>
								<span>{event}</span>
								<span>{display}</span>
							</li>
						);
					})}
				</ul>
			</section>

			<section className="eo-section">
				<p className="eo-datum">{overview.Instructions}</p>
			</section>

			<section className="eo-section">
				<div className="eo-count-grid">
					<div>
						<span className="eo-datum">{COL.registrationFieldCount}</span>
						<span>{policies.registrationFieldCount}</span>
					</div>
					<div>
						<span className="eo-datum">{COL.disclosurePolicyCount}</span>
						<span>{policies.disclosurePolicyCount}</span>
					</div>
					<div>
						<span className="eo-datum">{COL.attestationRequired}</span>
						<span>{policies.attestationRequired ?? EM_DASH}</span>
					</div>
				</div>
				{policies.registrationFieldBreakdown.map((row) => (
					<div className="eo-row" key={`${row.Tier}-${row.Requirement}`}>
						<span>{row.TierName}</span>
						<span>{row.RequirementName}</span>
						<span>{row.Count}</span>
					</div>
				))}
			</section>

			{totalElections > 1 ? <span className="eo-datum">{electionsFigure}</span> : null}
		</>
	);
};

export default ElectionsPanel;
