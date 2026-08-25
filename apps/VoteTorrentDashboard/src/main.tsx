import './app.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { enginePreflight } from './engine-preflight.js';
import { t } from './i18n/copy.js';
import { listNetworks } from './db/networks-registry.js';
import { Bootstrap } from './screens/Bootstrap';

declare global {
	interface Window {
		__DASHBOARD__?: Readonly<{ engineExportCount: number; engineExportNames: string[] }>;
	}
}

const { exportCount: engineExportCount, exportNames: engineExportNames } = enginePreflight();

// Stable, frozen readout hook — 50-05's two-page gate and 50-12's model↔DOM
// cross-check read this, mirroring the spikes' `window.__SPIKE076__` /
// `window.__SPIKE078__` convention.
window.__DASHBOARD__ = Object.freeze({ engineExportCount, engineExportNames });

function App() {
	// listNetworks() is synchronous (localStorage-backed), so this decision
	// is made directly at render time with no loading state. An empty
	// registry means this browser holds no network yet — render the
	// bootstrap flow. 50-09 replaces the branch below with the real shell +
	// router; the copy itself does not change (contract C2 — this plan owns
	// the table, no later plan edits it).
	if (listNetworks().length === 0) {
		return <Bootstrap />;
	}

	return (
		<main>
			<h1>{t('bootstrap.emptyNetworksHeading')}</h1>
			<p>{t('bootstrap.emptyNetworksBody')}</p>
			<p>vote-engine browser exports: {engineExportCount}</p>
		</main>
	);
}

const rootElement = document.getElementById('root');
if (!rootElement) {
	throw new Error('#root element not found');
}

createRoot(rootElement).render(
	<StrictMode>
		<App />
	</StrictMode>,
);
