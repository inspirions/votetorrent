/**
 * KeyholdersPanel.tsx -- the `ik` panel body (tier 2, zero schema
 * enforcement sites).
 *
 * Renders its own body content only -- this panel does not wrap or import
 * the shared chrome component (contract C7). Issues its own read from an
 * effect against `props.db`, owned by this component alone (see
 * `NetworkSettingsPanel.tsx`'s header for the shared reasoning, not
 * repeated per file).
 *
 * THIS PANEL NAMES PEOPLE, NEVER KEY MATERIAL. A `Keyholder` row in the
 * schema carries `(ElectionId, ElectionRevision, UserId)` and nothing
 * else -- there is no key column to leak, and this component must never
 * grow a field that would create one. Displaying that someone holds a key
 * share is a governance fact about the election; it is not, and must never
 * become, exposure of the share itself. The panel's own name invites that
 * confusion, which is exactly why this comment exists.
 *
 * The empty state here is EXPECTED in every real Phase 50 snapshot, not an
 * unfinished panel: a `Keyholder` row needs an `Election`, an
 * `ElectionRevision` and an accepted keyholder invite, and the keyholder
 * invite ceremony is out of scope for this phase (see
 * `authority-admin-queries.js`'s `fetchKeyholders` JSDoc for the full
 * reasoning). Do not "fix" this by inventing a way to populate it.
 */
import { useEffect, useState } from 'react';
import type { PanelComponent } from './types.js';
import { t } from '@votetorrent/ui-web';
import { fetchKeyholders } from './authority-admin-queries.js';
import './authority-admin.css';

const EM_DASH = '—';

type KeyholderRow = Awaited<ReturnType<typeof fetchKeyholders>>[number];

interface KeyholdersState {
	status: 'loading' | 'ready' | 'error';
	rows: KeyholderRow[];
}

const KeyholdersPanel: PanelComponent = ({ capability, db }) => {
	const [state, setState] = useState<KeyholdersState>({ status: 'loading', rows: [] });

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
				const rows = await fetchKeyholders(boundDb);
				if (mounted) setState({ status: 'ready', rows });
			} catch (err) {
				// The error CLASS only, never the message. `err` comes from a query
				// against tables full of registrant information, and Quereus and its
				// constraint layer routinely embed the offending row and column values
				// in an error message. The browser console is a durable, exportable,
				// screenshot-able sink; a message must name table names, column names
				// and integer counts only.
				// eslint-disable-next-line no-console
				console.error('KeyholdersPanel: read failed:', (err as { name?: string })?.name ?? 'Error');
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
				<div className="aa-row" key={`${row.ElectionId}:${row.ElectionRevision}:${row.UserId}`}>
					<dl className="aa-kv">
						<dt>Name</dt>
						<dd>{row.Name ?? EM_DASH}</dd>
						<dt>UserId</dt>
						<dd className="aa-mono">{row.UserId}</dd>
						<dt>ElectionId</dt>
						<dd className="aa-mono">{row.ElectionId}</dd>
						<dt>ElectionRevision</dt>
						<dd>{row.ElectionRevision}</dd>
						<dt>KeyholderThreshold</dt>
						<dd>{row.KeyholderThreshold ?? EM_DASH}</dd>
					</dl>
				</div>
			))}
		</>
	);
};

export default KeyholdersPanel;
