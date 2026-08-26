/**
 * AuthorityPeersPanel.tsx -- the `cap` panel body.
 *
 * Renders its own body content only -- this panel does not wrap or import
 * the shared chrome component (contract C7). Issues its own read from an
 * effect against `props.db`, owned by this component alone (see
 * `NetworkSettingsPanel.tsx`'s header for the shared reasoning, not
 * repeated per file).
 *
 * One `aa-row` per peer, each a single `PeerId` (binding decision A: the
 * schema column identifier) pair, `aa-mono`.
 */
import { useEffect, useState } from 'react';
import type { PanelComponent } from './types.js';
import { t } from '../../i18n/copy.js';
import { fetchAuthorityPeers } from './authority-admin-queries.js';
import './authority-admin.css';

interface AuthorityPeersState {
	status: 'loading' | 'ready' | 'error';
	peerIds: string[];
}

const AuthorityPeersPanel: PanelComponent = ({ capability, db }) => {
	const [state, setState] = useState<AuthorityPeersState>({ status: 'loading', peerIds: [] });

	useEffect(() => {
		let mounted = true;

		if (!db) {
			setState({ status: 'ready', peerIds: [] });
			return () => {
				mounted = false;
			};
		}

		setState({ status: 'loading', peerIds: [] });
		const boundDb = db;

		(async () => {
			try {
				const peerIds = await fetchAuthorityPeers(boundDb);
				if (mounted) setState({ status: 'ready', peerIds });
			} catch (err) {
				// The error CLASS only, never the message. `err` comes from a query
				// against tables full of registrant information, and Quereus and its
				// constraint layer routinely embed the offending row and column values
				// in an error message. The browser console is a durable, exportable,
				// screenshot-able sink; a message must name table names, column names
				// and integer counts only.
				// eslint-disable-next-line no-console
				console.error('AuthorityPeersPanel: read failed:', (err as { name?: string })?.name ?? 'Error');
				if (mounted) setState({ status: 'error', peerIds: [] });
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

	if (state.peerIds.length === 0) {
		return <p className="aa-empty">{t(capability.emptyKey)}</p>;
	}

	return (
		<>
			{state.peerIds.map((peerId) => (
				<div className="aa-row" key={peerId}>
					<dl className="aa-kv">
						<dt>PeerId</dt>
						<dd className="aa-mono">{peerId}</dd>
					</dl>
				</div>
			))}
		</>
	);
};

export default AuthorityPeersPanel;
