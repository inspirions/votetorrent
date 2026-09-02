/**
 * election-shell-gate.tsx — the built harness entry 53-09's gates run
 * against (53-07 builds this page; 53-09 owns the runner invocation, the
 * identity and token rungs, and `test:browser`'s wiring — see this app's
 * package.json and 53-07-PLAN.md's Interface Contract for the split).
 *
 * WHAT A GREEN RUN HERE IS NOT EVIDENCE OF — read this before quoting it:
 * this page mounts `ElectionShell` with a FIXTURE election it was handed
 * directly as a prop. It says nothing about a real data path (there is
 * none in this phase), and it carries no pass/fail verdict of its own —
 * grading what it renders is 53-09's runner's job, not this page's. A
 * harness that graded itself would be a rung nobody else could invert.
 *
 * `?phase=organizing|running|released` selects which of
 * `FIXTURE_INSTANTS`' three canonical instants this page renders against,
 * defaulting to `running`. This is THIS PAGE's own URL parameter, read by
 * this file only — it is never forwarded into `ElectionShell`'s own
 * address, which is why `search` is passed explicitly below rather than
 * left to default to `window.location.search` (T-53-07-04's harness-side
 * proof: the shell's address input is genuinely injectable, not just
 * theoretically so).
 *
 * Deliberately calls no engine preflight step and assigns no production
 * readout global of any kind — that global belongs to `main.tsx` (53-06),
 * and forging it here would make the D-17 token list ambiguous about what
 * counts as a harness artefact.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../../src/app.css';
import { ElectionShell } from '../../src/screens/ElectionShell';
import { FIXTURE_ELECTION, FIXTURE_ELECTION_ID, FIXTURE_INSTANTS } from '../fixtures/election-fixture.js';

declare global {
	interface Window {
		__ELECTION_SHELL_GATE__?: Readonly<{
			harness: string;
			phase: string;
			lifecycleText: string | null;
			addressText: string | null;
			advisoryText: string | null;
			toggleExpanded: boolean | null;
			skeletonSlots: string[];
		}>;
	}
}

type FixturePhase = keyof typeof FIXTURE_INSTANTS;

function resolvePhase(): FixturePhase {
	const params = new URLSearchParams(window.location.search);
	const requested = params.get('phase');
	if (requested === 'organizing' || requested === 'running' || requested === 'released') {
		return requested;
	}
	return 'running';
}

const phase = resolvePhase();

const rootElement = document.getElementById('root');
if (!rootElement) {
	throw new Error('election-shell-gate.tsx: #root element not found in election-shell-gate.html');
}

createRoot(rootElement).render(
	<StrictMode>
		<ElectionShell
			search={`?election=${FIXTURE_ELECTION_ID}`}
			at={FIXTURE_INSTANTS[phase]}
			election={FIXTURE_ELECTION}
		/>
	</StrictMode>,
);

/**
 * Bounded `requestAnimationFrame` poll — NEVER a fixed sleep — that resolves
 * once a `.dt-toggle` button exists in the document (proof the shell has
 * committed its first render), or once `maxFrames` have elapsed.
 */
function settleUntilMounted(maxFrames: number): Promise<void> {
	return new Promise((resolve) => {
		let frames = 0;
		function tick() {
			frames += 1;
			if (document.querySelector('.dt-toggle') || frames >= maxFrames) {
				resolve();
				return;
			}
			requestAnimationFrame(tick);
		}
		requestAnimationFrame(tick);
	});
}

settleUntilMounted(120).then(() => {
	const lifecycleEl = document.querySelector('.lifecycle-pill');
	const addressEl = document.querySelector('.election-address code');
	const advisoryEl = document.querySelector('.pv-disclosure');
	const skeletonSlots = [...document.querySelectorAll('.skeleton')].map(
		(el) => el.getAttribute('data-slot') ?? '',
	);

	// `toggleExpanded` is defined as a GETTER, not a snapshot value — 53-09's
	// identity rung clicks the real `.dt-toggle` button and needs this field
	// to re-read the DOM's live `aria-expanded` attribute on every access, not
	// the value at the moment this object was published. `Object.freeze`
	// below still applies (it prevents reconfiguring or replacing this
	// property, not the getter function itself from running fresh each time
	// it is read) — freezing an accessor property does not freeze what its
	// getter returns.
	const readout = Object.defineProperty(
		{
			harness: 'election-shell-gate',
			phase,
			lifecycleText: lifecycleEl ? lifecycleEl.textContent : null,
			addressText: addressEl ? addressEl.textContent : null,
			advisoryText: advisoryEl ? advisoryEl.textContent : null,
			skeletonSlots,
		},
		'toggleExpanded',
		{
			enumerable: true,
			get(): boolean | null {
				const el = document.querySelector('.dt-toggle');
				return el ? el.getAttribute('aria-expanded') === 'true' : null;
			},
		},
	);

	window.__ELECTION_SHELL_GATE__ = Object.freeze(readout) as Window['__ELECTION_SHELL_GATE__'];
});
