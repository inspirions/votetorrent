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
 * `?phase=pre|voting|settling|closed` selects which of
 * `FIXTURE_INSTANTS`' four canonical instants this page renders against,
 * defaulting to `voting`. This is THIS PAGE's own URL parameter, read by
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
 *
 * 53-09 EXTENSION — the shared runner's second invocation. Adds:
 * (a) imperative `data-ui-gate="<ExportName>"` tagging of the elements
 *     `ElectionShell` already genuinely rendered (`AdvisoryDisclosure`,
 *     `LifecyclePill`, `DetailsToggle`) — `AdvisoryDisclosure`/`LifecyclePill`
 *     render only a text node with no child element, so each is WRAPPED in a
 *     harness-only container element (never restructuring `ElectionShell`'s
 *     own tree, which this file never imports for editing) so the runner's
 *     `shared-components-mounted` rung's `childElementCount > 0` check has a
 *     genuine child to see; `DetailsToggle`'s own `.dt-toggle-group` wrapper
 *     already contains its button as a child element and is tagged directly.
 * (b) a SEPARATE `[data-ui-gate="hook-root"]` region, mounted in its OWN
 *     React root (a container `appendChild`-ed to `document.body`, never
 *     nested under `#root`) so a hook-dispatcher render throw there cannot
 *     unmount or blank the `ElectionShell` region — the structural half of
 *     the measured 19/19 → 8/12 PARTIAL failure signature (the runner-side
 *     half is `run-ui-gates.mjs`'s per-rung `try`/`catch`). Mounts
 *     `DetailsToggle` a SECOND time, independent of the instance
 *     `ElectionShell` renders internally, exactly mirroring
 *     `apps/VoteTorrentDashboard/test/browser/ui-gate.tsx`'s own hook-root.
 * (c) `window.__UI_GATE__` — the ONE channel the shared runner reads
 *     (`mounted`, `error`, `identity`), nesting 53-07's own
 *     `window.__ELECTION_SHELL_GATE__` readout unchanged under `.election`.
 *     There is one readout the runner reads; the other is 53-07's own DOM
 *     read-back record, which grades nothing — both stay assigned, neither
 *     replaces the other.
 */
import { StrictMode } from 'react';
import * as AppReact from 'react';
import { createRoot } from 'react-dom/client';
import '../../src/app.css';
import { ElectionShell } from '../../src/screens/ElectionShell';
import { DetailsToggle, packageReactIdentity } from '@votetorrent/ui-web/components';
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

const win = window as unknown as Record<string, unknown>;

/**
 * React 19's client-internals holder property name — see
 * `packages/ui-web/src/react-identity.js`'s own header for why comparing
 * this (not the version string, not a namespace-object identity) is the
 * sound measure.
 */
const CLIENT_INTERNALS_KEY = '__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE';

/**
 * `sameUseState`/`sameInternals` are the two SOUND measures; the version
 * string and the namespace-object equality are DECOYS, computed and
 * published only so the runner's run log can show them true even when
 * identity reads false — see `react-identity.js`'s own header for the
 * measured reasons neither may ever gate a verdict.
 */
function computeReactIdentity() {
	const pkg = packageReactIdentity();
	let appInternals: unknown = null;
	try {
		appInternals = (AppReact as unknown as Record<string, unknown>)[CLIENT_INTERNALS_KEY] ?? null;
	} catch {
		appInternals = null;
	}
	return {
		sameUseState: AppReact.useState === pkg.useState,
		sameInternals: appInternals != null && pkg.internals != null && appInternals === pkg.internals,
		versionsMatch: AppReact.version === pkg.version,
		sameNamespace: (AppReact as unknown) === pkg.reactNamespace,
	};
}

/**
 * The hook-root region (53-09, D-19) — mounted in ITS OWN root, separate
 * from `ElectionShell`'s (see this file's header). Renders `DetailsToggle`
 * a second time: its single `.dt-toggle` button is the "exactly one button"
 * the identity rung clicks, and its body — rendered only while open — is
 * what makes that click change `[data-ui-gate="hook-root"]`'s own
 * `textContent`.
 */
function HookRootHarness() {
	return (
		<div data-ui-gate="hook-root">
			<DetailsToggle summary={<span>hook-root toggle</span>}>
				<p>hook-root body content for the D-19 identity gate&apos;s click assertion.</p>
			</DetailsToggle>
		</div>
	);
}

/**
 * Wraps `el` in a new harness-only container element carrying
 * `data-ui-gate="{gateName}"`, WITHOUT restructuring `ElectionShell`'s own
 * tree (`el` itself is never removed or re-parented outside its original
 * parent, only newly enclosed) — for the two shared components whose own
 * rendered root is a childless text-only element
 * (`AdvisoryDisclosure`'s `<p>`, `LifecyclePill`'s `<span>`), so the
 * runner's `shared-components-mounted` rung's `childElementCount > 0` check
 * has a genuine child element to see.
 */
function wrapForGate(el: Element, gateName: string): void {
	const wrapper = document.createElement('span');
	wrapper.setAttribute('data-ui-gate', gateName);
	el.parentNode?.insertBefore(wrapper, el);
	wrapper.appendChild(el);
}

type FixturePhase = keyof typeof FIXTURE_INSTANTS;

function resolvePhase(): FixturePhase {
	const params = new URLSearchParams(window.location.search);
	const requested = params.get('phase');
	if (requested === 'pre' || requested === 'voting' || requested === 'settling' || requested === 'closed') {
		return requested;
	}
	return 'voting';
}

const phase = resolvePhase();

const rootElement = document.getElementById('root');
if (!rootElement) {
	throw new Error('election-shell-gate.tsx: #root element not found in election-shell-gate.html');
}

/**
 * Wrapped so a render throw here cannot prevent `window.__UI_GATE__` from
 * publishing below (53-09) — `identity:hook-mounted` and
 * `shared-components-mounted` then read the DOM directly and report the
 * affected region ABSENT rather than the process crashing before any rung
 * ran (this file's header, point (b), and `run-ui-gates.mjs`'s own header
 * "THE PARTIAL FAILURE SIGNATURE" note).
 */
let renderError: string | null = null;
try {
	createRoot(rootElement).render(
		<StrictMode>
			<ElectionShell
				search={`?election=${FIXTURE_ELECTION_ID}`}
				at={FIXTURE_INSTANTS[phase]}
				election={FIXTURE_ELECTION}
			/>
		</StrictMode>,
	);
} catch (err) {
	renderError = String((err as { message?: unknown })?.message ?? err);
}

// The hook-root region's own SEPARATE root and container — appended to
// document.body, never nested under #root, so a render throw here cannot
// unmount or blank the ElectionShell region above (this file's header,
// point (b)). A throw here is deliberately swallowed into `renderError`
// rather than re-thrown.
const hookRootContainer = document.createElement('div');
document.body.appendChild(hookRootContainer);
try {
	createRoot(hookRootContainer).render(
		<StrictMode>
			<HookRootHarness />
		</StrictMode>,
	);
} catch (err) {
	renderError = renderError ?? String((err as { message?: unknown })?.message ?? err);
}

/**
 * Bounded `requestAnimationFrame` poll — NEVER a fixed sleep — that resolves
 * once a `.dt-toggle` button exists **inside `#root`** (proof the shell has
 * committed its first render), or once `maxFrames` have elapsed. Scoped to
 * `#root` (53-09) rather than the bare `.dt-toggle` class 53-07 used, since
 * the hook-root region above (mounted outside `#root`) now also renders a
 * `.dt-toggle` button — an unscoped selector could resolve on the hook-root
 * instance before `ElectionShell` itself ever committed.
 */
function settleUntilMounted(maxFrames: number): Promise<void> {
	return new Promise((resolve) => {
		let frames = 0;
		function tick() {
			frames += 1;
			if (document.querySelector('#root .dt-toggle') || frames >= maxFrames) {
				resolve();
				return;
			}
			requestAnimationFrame(tick);
		}
		requestAnimationFrame(tick);
	});
}

settleUntilMounted(120).then(() => {
	// 53-09: imperative data-ui-gate tagging of ElectionShell's own rendered
	// output — see wrapForGate's own header for why AdvisoryDisclosure and
	// LifecyclePill need a wrapper while DetailsToggle's own wrapper is
	// tagged directly. Scoped to #root so the hook-root region's own,
	// independent DetailsToggle instance is never mistaken for this one.
	const advisoryTarget = document.querySelector('#root .pv-disclosure');
	if (advisoryTarget) wrapForGate(advisoryTarget, 'AdvisoryDisclosure');
	const lifecycleTarget = document.querySelector('#root .lifecycle-pill');
	if (lifecycleTarget) wrapForGate(lifecycleTarget, 'LifecyclePill');
	const detailsGroup = document.querySelector('#root .dt-toggle-group');
	detailsGroup?.setAttribute('data-ui-gate', 'DetailsToggle');

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
				// Scoped to #root (53-09) — see settleUntilMounted's own comment
				// above: the hook-root region also renders a `.dt-toggle` button,
				// and this getter must read ElectionShell's own, not either one
				// document order happens to put first.
				const el = document.querySelector('#root .dt-toggle');
				return el ? el.getAttribute('aria-expanded') === 'true' : null;
			},
		},
	);

	window.__ELECTION_SHELL_GATE__ = Object.freeze(readout) as Window['__ELECTION_SHELL_GATE__'];

	// 53-09: the ONE channel the shared runner (run-ui-gates.mjs) reads.
	// `mounted` is built from the `[data-ui-gate]` attribute values ACTUALLY
	// FOUND IN THE DOCUMENT (never a static list), exactly mirroring
	// apps/VoteTorrentDashboard/test/browser/ui-gate.tsx's own convention —
	// a component that threw during render, or a wrapForGate call that never
	// ran because its target was absent, is reported ABSENT rather than
	// asserted present.
	const mounted = [...document.querySelectorAll('[data-ui-gate]')]
		.map((el) => el.getAttribute('data-ui-gate'))
		.filter((name): name is string => name != null);

	win.__UI_GATE__ = Object.freeze({
		mounted,
		error: renderError,
		identity: computeReactIdentity(),
		election: window.__ELECTION_SHELL_GATE__,
	});
	win.__UI_GATE_DONE__ = true;
});
