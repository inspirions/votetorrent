/**
 * NetworkSettingsPanel.tsx -- the `rn` panel body.
 *
 * Renders its own body content only -- this panel does not wrap or import
 * the shared chrome component (contract C7: that frame is composed around
 * this panel by 50-09's `PanelGrid`). Issues its own read from an
 * effect against `props.db` -- the fetch lives HERE, never in a parent or a
 * shared prefetch, so a capability the officer cannot see is never mounted
 * and its query never runs. This is the mechanical half of the honesty D-16
 * demands, given that the gate itself protects nobody holding the snapshot.
 *
 * Every rendered `<dt>` label is the schema column identifier the value came
 * from (binding decision A) -- `Name`, `Hash`, `PrimaryAuthorityId`,
 * `Relays`, `TimestampAuthorities`, `NumberRequiredTSAs`, `ElectionType`.
 * These are data read out of `votetorrent.qsql`, not invented copy; the
 * `ElectionType` row's rendered VALUE is the friendly name
 * (`ElectionTypeName`), with the raw code carried in the `title` attribute,
 * while the label itself stays the column identifier.
 */
import { useEffect, useState } from 'react';
import type { PanelComponent } from './types.js';
import { t } from '@votetorrent/ui-web';
import { fetchNetworkSettings } from './authority-admin-queries.js';
import './authority-admin.css';

const EM_DASH = '—';

type NetworkSettingsData = NonNullable<Awaited<ReturnType<typeof fetchNetworkSettings>>>;

interface NetworkSettingsState {
	status: 'loading' | 'ready' | 'error';
	data: NetworkSettingsData | null;
}

function formatTimestampAuthority(entry: unknown): string {
	if (entry && typeof entry === 'object' && 'url' in entry) {
		const url = (entry as { url: unknown }).url;
		return typeof url === 'string' ? url : EM_DASH;
	}
	return EM_DASH;
}

const NetworkSettingsPanel: PanelComponent = ({ capability, db }) => {
	const [state, setState] = useState<NetworkSettingsState>({ status: 'loading', data: null });

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
				const data = await fetchNetworkSettings(boundDb);
				if (mounted) setState({ status: 'ready', data });
			} catch (err) {
				// The error CLASS only, never the message. `err` comes from a query
				// against tables full of registrant information, and Quereus and its
				// constraint layer routinely embed the offending row and column values
				// in an error message. The browser console is a durable, exportable,
				// screenshot-able sink; a message must name table names, column names
				// and integer counts only.
				// eslint-disable-next-line no-console
				console.error('NetworkSettingsPanel: read failed:', (err as { name?: string })?.name ?? 'Error');
				if (mounted) setState({ status: 'error', data: null });
			}
		})();

		return () => {
			mounted = false;
		};
	}, [db]);

	if (!db || state.status === 'loading') return null;

	if (state.status === 'error') {
		return (
			<dl className="aa-kv">
				<dt>Name</dt>
				<dd>{EM_DASH}</dd>
			</dl>
		);
	}

	if (!state.data) {
		return <p className="aa-empty">{t(capability.emptyKey)}</p>;
	}

	const { data } = state;
	const relaysDisplay = data.Relays.length > 0 ? data.Relays.map(String).join(', ') : EM_DASH;
	const tsaDisplay = data.TimestampAuthorities.length > 0 ? data.TimestampAuthorities.map(formatTimestampAuthority).join(', ') : EM_DASH;

	return (
		<dl className="aa-kv">
			<dt>Name</dt>
			<dd>{data.Name}</dd>
			<dt>Hash</dt>
			<dd className="aa-mono">{data.Hash}</dd>
			<dt>PrimaryAuthorityId</dt>
			<dd className="aa-mono">{data.PrimaryAuthorityId}</dd>
			<dt>Relays</dt>
			<dd>{relaysDisplay}</dd>
			<dt>TimestampAuthorities</dt>
			<dd>{tsaDisplay}</dd>
			<dt>NumberRequiredTSAs</dt>
			<dd>{data.NumberRequiredTSAs}</dd>
			<dt>ElectionType</dt>
			<dd title={data.ElectionType}>{data.ElectionTypeName ?? data.ElectionType}</dd>
		</dl>
	);
};

export default NetworkSettingsPanel;
