import './app.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { enginePreflight } from './engine-preflight.js';
import { t } from './i18n/copy.js';

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
	// First real consumer of the copy table — proves the import path works
	// through both Vite and tsc. This placeholder screen is replaced by the
	// real bootstrap flow in a later plan; the copy itself does not change
	// (contract C2 — this plan owns the table, no later plan edits it).
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
