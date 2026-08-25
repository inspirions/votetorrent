import './app.css';
import { StrictMode, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { enginePreflight } from './engine-preflight.js';
import { listNetworks } from './db/networks-registry.js';
import { Bootstrap } from './screens/Bootstrap';
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
	// back to it. `undefined` means an ordinary first bootstrap.
	const [refreshTargetNetworkHash, setRefreshTargetNetworkHash] = useState<string | undefined>(undefined);
	const baselineRef = useRef<{ count: number; targetBootstrappedAt: string | undefined } | null>(null);

	// THE COMPLETION SEAM. `Bootstrap.tsx` is 50-08's and exposes no
	// completion callback -- adding one would edit another plan's file. So,
	// and ONLY while the Bootstrap view is mounted, this is the dashboard's
	// ONE `setInterval`: it reads `listNetworks().length` and the refresh
	// target's own `bootstrappedAt` from web storage, and switches back to
	// the shell the moment either changes. It reads NO snapshot data,
	// performs no I/O beyond that one synchronous `localStorage` read, and
	// is cleared on unmount. THIS IS NOT A LIVENESS MECHANISM -- it exists
	// only to detect the end of a one-shot user action, never to keep
	// anything current, and it must be replaced the moment `Bootstrap.tsx`
	// gains a real completion callback (see `DashboardShell.tsx`'s header
	// for the related, currently-unreachable officer-swap seam this same
	// gap causes).
	useEffect(() => {
		if (view !== 'bootstrap') return undefined;

		const startingNetworks = listNetworks();
		baselineRef.current = {
			count: startingNetworks.length,
			targetBootstrappedAt: refreshTargetNetworkHash
				? startingNetworks.find((entry) => entry.networkHash === refreshTargetNetworkHash)?.bootstrappedAt
				: undefined,
		};

		const interval = window.setInterval(() => {
			const baseline = baselineRef.current;
			if (!baseline) return;
			const current = listNetworks();
			const currentTargetBootstrappedAt = refreshTargetNetworkHash
				? current.find((entry) => entry.networkHash === refreshTargetNetworkHash)?.bootstrappedAt
				: undefined;
			const countChanged = current.length !== baseline.count;
			const targetAdvanced =
				refreshTargetNetworkHash !== undefined && currentTargetBootstrappedAt !== baseline.targetBootstrappedAt;
			if (countChanged || targetAdvanced) {
				setRefreshTargetNetworkHash(undefined);
				setView('shell');
			}
		}, 500);

		return () => window.clearInterval(interval);
	}, [view, refreshTargetNetworkHash]);

	function handleRedeemAnother(hash?: string) {
		setRefreshTargetNetworkHash(hash);
		setView('bootstrap');
	}

	if (view === 'bootstrap') {
		return <Bootstrap />;
	}

	return <DashboardShell onRedeemAnother={handleRedeemAnother} />;
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
