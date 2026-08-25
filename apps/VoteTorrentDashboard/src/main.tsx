import './app.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { enginePreflight } from './engine-preflight.js';

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
	// TODO(Task 2): replace this placeholder text with t('bootstrap.emptyNetworksHeading')
	// and t('bootstrap.emptyNetworksBody') from ./i18n/copy.js.
	return (
		<main>
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
