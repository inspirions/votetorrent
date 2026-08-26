/**
 * AdministrationOfficersPanel.tsx -- the `rad` panel body.
 *
 * Renders its own body content only -- this panel does not wrap or import
 * the shared chrome component (contract C7). Issues its own read from an
 * effect against `props.db`, owned by this component alone (see
 * `NetworkSettingsPanel.tsx`'s header for the shared reasoning, not
 * repeated per file).
 *
 * THERE ARE NO ROLES AND NO GROUPS IN THIS SYSTEM. `Officer.Title` is free
 * text enforced by nothing -- it is rendered as one data field among the
 * others below, never grouped, sorted or badged by. The `Scopes` chips are
 * what carry authority: a later reader looking at "County Clerk" will
 * assume otherwise, which is exactly why this comment exists.
 *
 * When `admin` is null (the `CurrentAdmin` wall-clock fail-closed branch a
 * future-dated `AdminEffectiveAt` produces -- already pinned in
 * `authority-admin-queries.js`'s JSDoc), the empty sentence covers the
 * whole panel.
 */
import { useEffect, useState } from 'react';
import type { PanelComponent } from './types.js';
import { t } from '../../i18n/copy.js';
import { fetchAdministrationOfficers } from './authority-admin-queries.js';
import './authority-admin.css';

const EM_DASH = '—';

type AdministrationOfficersData = Awaited<ReturnType<typeof fetchAdministrationOfficers>>;

interface AdministrationOfficersState {
	status: 'loading' | 'ready' | 'error';
	data: AdministrationOfficersData | null;
}

function formatThresholdPolicy(entry: unknown): string {
	if (entry && typeof entry === 'object' && 'policy' in entry && 'threshold' in entry) {
		const policy = (entry as { policy: unknown }).policy;
		const threshold = (entry as { threshold: unknown }).threshold;
		return `${String(policy)} → ${String(threshold)}`;
	}
	return EM_DASH;
}

const AdministrationOfficersPanel: PanelComponent = ({ capability, db }) => {
	const [state, setState] = useState<AdministrationOfficersState>({ status: 'loading', data: null });

	useEffect(() => {
		let mounted = true;

		if (!db) {
			setState({ status: 'ready', data: null });
			return () => {
				mounted = false;
			};
		}

		setState({ status: 'loading', data: null });
		const boundDb = db;

		(async () => {
			try {
				const data = await fetchAdministrationOfficers(boundDb);
				if (mounted) setState({ status: 'ready', data });
			} catch (err) {
				// The error CLASS only, never the message. `err` comes from a query
				// against tables full of registrant information, and Quereus and its
				// constraint layer routinely embed the offending row and column values
				// in an error message. The browser console is a durable, exportable,
				// screenshot-able sink; a message must name table names, column names
				// and integer counts only.
				// eslint-disable-next-line no-console
				console.error('AdministrationOfficersPanel: read failed:', (err as { name?: string })?.name ?? 'Error');
				if (mounted) setState({ status: 'error', data: null });
			}
		})();

		return () => {
			mounted = false;
		};
	}, [db]);

	if (!db || state.status === 'loading') return null;

	if (state.status === 'error') {
		return <p className="aa-empty">{t(capability.emptyKey)}</p>;
	}

	if (!state.data || !state.data.admin) {
		return <p className="aa-empty">{t(capability.emptyKey)}</p>;
	}

	const { admin, officers } = state.data;
	const policiesDisplay = admin.ThresholdPolicies.length > 0 ? admin.ThresholdPolicies.map(formatThresholdPolicy).join(', ') : EM_DASH;

	return (
		<>
			<section className="aa-section">
				<dl className="aa-kv">
					<dt>EffectiveAt</dt>
					<dd>{admin.EffectiveAt}</dd>
					<dt>ThresholdPolicies</dt>
					<dd>{policiesDisplay}</dd>
				</dl>
			</section>

			<section className="aa-section">
				{officers.map((officer) => (
					<div className="aa-row" key={officer.UserId}>
						<dl className="aa-kv">
							<dt>Name</dt>
							<dd>{officer.Name ?? EM_DASH}</dd>
							<dt>Title</dt>
							<dd>{officer.Title}</dd>
							<dt>UserId</dt>
							<dd className="aa-mono">{officer.UserId}</dd>
							<dt>Scopes</dt>
							<dd>
								{officer.Scopes.length === 0 ? (
									EM_DASH
								) : (
									<span className="aa-scope-list">
										{officer.Scopes.map((scope) => (
											<span className="aa-scope" key={String(scope)}>
												{String(scope)}
											</span>
										))}
									</span>
								)}
							</dd>
						</dl>
					</div>
				))}
			</section>
		</>
	);
};

export default AdministrationOfficersPanel;
