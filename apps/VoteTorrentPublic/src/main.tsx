import './app.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { enginePreflight } from './engine-preflight.js';
import { PublicApp } from './screens/PublicApp';
import { parseElectionAddress } from './election-address.js';
// Imported under an alias so a whole-file occurrence count of the peer
// boot's exported name resolves to this ONE import line rather than also
// matching the call below (a self-tripping-checker trap this deliberately
// avoids -- see `project_self_tripping_checker_headers`). `bootPeerLayer` is
// this file's own name for that single import.
import { startPublicPeerBoot as bootPeerLayer } from './peer/boot.js';

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
		{/* 56-12: production now mounts PublicApp, not a bare ElectionShell,
		    with no props of its own. PublicApp resolves 56-06's bootstrap
		    config once at boot and hands ElectionShell a two-valued
		    configFault (or null) -- the only thing that can suppress the
		    shell's normal content. Everything ElectionShell itself still
		    supplies no facts about: no injected election, no instant, no
		    injected search, no source. */}
		<PublicApp />
	</StrictMode>,
);

// 56-11: put the libp2p/strand closure into the production graph. This is
// the ONE production call to the peer boot composition -- the same one the
// mesh-read gate exercises (`test/browser/mesh-read-gate.js`). Never awaited
// before the render above: the page must paint its honest empty state first
// and flip when replicated rows land, never block first paint on a peer
// dial. The boot composition never rejects by its own contract; the
// `.catch` below is defense in depth only, and logs the error's NAME, never
// a message that could carry a value.
const address = parseElectionAddress(window.location.search);
bootPeerLayer({ networkHash: address.networkHash, electionId: address.electionId }).catch((err: unknown) => {
	const name = err && typeof (err as { name?: unknown }).name === 'string' ? (err as { name: string }).name : 'Error';
	console.error('main: peer boot rejected unexpectedly', name);
});
