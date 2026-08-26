/**
 * InviteAuthoritiesPanel.tsx -- the `iad` panel body (tier 2, zero schema
 * enforcement sites).
 *
 * Renders its own body content only -- this panel does not wrap or import
 * the shared chrome component (contract C7). Issues its own read from an
 * effect against `props.db`, owned by this component alone (see
 * `NetworkSettingsPanel.tsx`'s header for the shared reasoning, not
 * repeated per file).
 *
 * THIS PANEL DISPLAYS EXISTING INVITE STATE; IT DOES NOT OFFER TO CREATE
 * ONE. The multi-officer invite ceremony is out of scope for this phase,
 * and the schema admits exactly one user through the unsigned shoe-in --
 * `User.InsertValid` requires `count(*) from User = 1`, so a second `User`
 * is rejected and its `Officer` then fails `UserIdValid` (measured
 * empirically). There is no "Create authority invite" control of any kind,
 * whether it could be interacted with or not -- its absence is a decision
 * recorded here, not an omission.
 */
import { useEffect, useState } from 'react';
import type { PanelComponent } from './types.js';
import { t } from '../../i18n/copy.js';
import { fetchAuthorityInvites } from './authority-admin-queries.js';
import './authority-admin.css';

const EM_DASH = '—';

type AuthorityInviteRow = Awaited<ReturnType<typeof fetchAuthorityInvites>>[number];

interface InviteAuthoritiesState {
	status: 'loading' | 'ready' | 'error';
	rows: AuthorityInviteRow[];
}

function formatIsAccepted(value: boolean | null): string {
	if (value === null) return EM_DASH;
	return value ? 'true' : 'false';
}

const InviteAuthoritiesPanel: PanelComponent = ({ capability, db }) => {
	const [state, setState] = useState<InviteAuthoritiesState>({ status: 'loading', rows: [] });

	useEffect(() => {
		let mounted = true;

		if (!db) {
			setState({ status: 'ready', rows: [] });
			return () => {
				mounted = false;
			};
		}

		setState({ status: 'loading', rows: [] });
		const boundDb = db;

		(async () => {
			try {
				const rows = await fetchAuthorityInvites(boundDb);
				if (mounted) setState({ status: 'ready', rows });
			} catch (err) {
				// The error CLASS only, never the message. `err` comes from a query
				// against tables full of registrant information, and Quereus and its
				// constraint layer routinely embed the offending row and column values
				// in an error message. The browser console is a durable, exportable,
				// screenshot-able sink; a message must name table names, column names
				// and integer counts only.
				// eslint-disable-next-line no-console
				console.error('InviteAuthoritiesPanel: read failed:', (err as { name?: string })?.name ?? 'Error');
				if (mounted) setState({ status: 'error', rows: [] });
			}
		})();

		return () => {
			mounted = false;
		};
	}, [db]);

	if (!db || state.status === 'loading') return null;

	if (state.status === 'error' || state.rows.length === 0) {
		return <p className="aa-empty">{t(capability.emptyKey)}</p>;
	}

	return (
		<>
			{state.rows.map((row) => (
				<div className="aa-row" key={row.Cid}>
					<dl className="aa-kv">
						<dt>Name</dt>
						<dd>{row.Name}</dd>
						<dt>Type</dt>
						<dd title={row.Type}>{row.TypeName ?? row.Type}</dd>
						<dt>Expiration</dt>
						<dd>{row.Expiration}</dd>
						<dt>IsAccepted</dt>
						<dd>{formatIsAccepted(row.IsAccepted)}</dd>
						<dt>CancelledAt</dt>
						<dd>{row.CancelledAt ?? EM_DASH}</dd>
						<dt>Cid</dt>
						<dd className="aa-mono">{row.Cid}</dd>
					</dl>
				</div>
			))}
		</>
	);
};

export default InviteAuthoritiesPanel;
