/**
 * AuthorityProfilePanel.tsx -- the `uai` panel body.
 *
 * Renders its own body content only -- this panel does not wrap or import
 * the shared chrome component (contract C7). Issues its own read from an
 * effect against `props.db`, owned by this component alone (see
 * `NetworkSettingsPanel.tsx`'s header for the shared reasoning, not
 * repeated per file).
 *
 * `<dt>` labels are the schema column identifiers `Name`, `DomainName`,
 * `Id` and `ImageRef` (binding decision A). `Id` is `aa-mono` because its
 * value IS the authority's SID.
 */
import { useEffect, useState } from 'react';
import type { PanelComponent } from './types.js';
import { t } from '../../i18n/copy.js';
import { fetchAuthorityProfile } from './authority-admin-queries.js';
import './authority-admin.css';

const EM_DASH = '—';

type AuthorityProfileData = NonNullable<Awaited<ReturnType<typeof fetchAuthorityProfile>>>;

interface AuthorityProfileState {
	status: 'loading' | 'ready' | 'error';
	data: AuthorityProfileData | null;
}

function formatImageRef(imageRef: string | null): string {
	if (!imageRef) return EM_DASH;
	try {
		const parsed = JSON.parse(imageRef) as { url?: unknown; cid?: unknown };
		if (typeof parsed.url === 'string') return parsed.url;
		if (typeof parsed.cid === 'string') return parsed.cid;
		return EM_DASH;
	} catch {
		return EM_DASH;
	}
}

const AuthorityProfilePanel: PanelComponent = ({ capability, db }) => {
	const [state, setState] = useState<AuthorityProfileState>({ status: 'loading', data: null });

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
				const data = await fetchAuthorityProfile(boundDb);
				if (mounted) setState({ status: 'ready', data });
			} catch (err) {
				// The error CLASS only, never the message. `err` comes from a query
				// against tables full of registrant information, and Quereus and its
				// constraint layer routinely embed the offending row and column values
				// in an error message. The browser console is a durable, exportable,
				// screenshot-able sink; a message must name table names, column names
				// and integer counts only.
				// eslint-disable-next-line no-console
				console.error('AuthorityProfilePanel: read failed:', (err as { name?: string })?.name ?? 'Error');
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

	return (
		<dl className="aa-kv">
			<dt>Name</dt>
			<dd>{data.Name}</dd>
			<dt>DomainName</dt>
			<dd>{data.DomainName ?? EM_DASH}</dd>
			<dt>Id</dt>
			<dd className="aa-mono">{data.Id}</dd>
			<dt>ImageRef</dt>
			<dd>{formatImageRef(data.ImageRef)}</dd>
		</dl>
	);
};

export default AuthorityProfilePanel;
