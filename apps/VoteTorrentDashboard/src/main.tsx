import './app.css';
import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { enginePreflight } from './engine-preflight.js';
import { listNetworks } from './db/networks-registry.js';
import { Bootstrap } from './screens/Bootstrap';
import type { AlreadyBootstrappedContext } from './screens/Bootstrap';
import { DashboardShell } from './screens/DashboardShell';

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

type View = 'bootstrap' | 'shell';

function App() {
	// listNetworks() is synchronous (localStorage-backed), so this decision
	// is made directly at render time with no loading state. An empty
	// registry means this browser holds no network yet.
	const [view, setView] = useState<View>(() => (listNetworks().length === 0 ? 'bootstrap' : 'shell'));
	// The optional refresh target recorded when the shell's "Refresh
	// snapshot" action (or a re-bootstrap prompt) routes here with a
	// network hash already known, so a completed redemption can be matched
	// back to it. `undefined` means an ordinary first bootstrap. Retained for
	// callers that still want to know which network prompted the trip to
	// this screen -- no longer used to detect completion (see below).
	const [refreshTargetNetworkHash, setRefreshTargetNetworkHash] = useState<string | undefined>(undefined);
	// The officer-swap context `Bootstrap`'s `onAlreadyBootstrapped` hands
	// over when a code redeems cleanly for a network this browser already
	// holds -- `DashboardShell` classifies it and, on confirmation, performs
	// the swap. `null` means no swap is pending.
	const [swapContext, setSwapContext] = useState<AlreadyBootstrappedContext | null>(null);

	// THE COMPLETION SEAM. `Bootstrap.tsx` now exposes a real completion
	// callback (`onComplete`) and an `onAlreadyBootstrapped` seam, so the
	// dashboard needs no polling interval to detect the end of a one-shot
	// user action -- the screen tells this component directly. This is a
	// D-22 improvement, not a cosmetic one: the file used to carry a
	// digit-qualified carve-out in the project's own no-timer grep
	// discipline purely to accommodate the interval this replaces.
	function handleBootstrapComplete() {
		setRefreshTargetNetworkHash(undefined);
		setSwapContext(null);
		setView('shell');
	}

	function handleAlreadyBootstrapped(context: AlreadyBootstrappedContext) {
		setRefreshTargetNetworkHash(undefined);
		setSwapContext(context);
		setView('shell');
	}

	function handleSwapContextConsumed() {
		setSwapContext(null);
	}

	function handleRedeemAnother(hash?: string) {
		setRefreshTargetNetworkHash(hash);
		setSwapContext(null);
		setView('bootstrap');
	}

	if (view === 'bootstrap') {
		return <Bootstrap onComplete={handleBootstrapComplete} onAlreadyBootstrapped={handleAlreadyBootstrapped} />;
	}

	return (
		<DashboardShell
			onRedeemAnother={handleRedeemAnother}
			pendingSwapContext={swapContext}
			onSwapContextConsumed={handleSwapContextConsumed}
		/>
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
