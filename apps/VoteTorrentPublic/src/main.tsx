import './app.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { enginePreflight } from './engine-preflight.js';
import { AppChrome } from './screens/AppChrome';

declare global {
	interface Window {
		__PUBLIC_APP__?: Readonly<{ schemaByteLength: number; schemaLineCount: number }>;
	}
}

const { schemaByteLength, schemaLineCount } = enginePreflight();

// Stable, frozen readout hook, adapted from the dashboard's `__DASHBOARD__`
// convention (not copied — the fields are this app's own D-13 preflight
// fields). This is a PRODUCTION readout, not a test-harness global: 53-09's
// `assert-no-test-harness-in-dist.mjs` instance for this app must not list
// `__PUBLIC_APP__` among the harness tokens it forbids in `dist/`.
//
// Assigning to a global is a side effect Rollup preserves, which is the
// second half of why the schema string cannot be shaken out of the bundle
// (see engine-preflight.js's header for the first half).
window.__PUBLIC_APP__ = Object.freeze({ schemaByteLength, schemaLineCount });

const rootElement = document.getElementById('root');
if (!rootElement) {
	throw new Error('main.tsx: #root element not found in index.html');
}

createRoot(rootElement).render(
	<StrictMode>
		<AppChrome />
	</StrictMode>,
);
