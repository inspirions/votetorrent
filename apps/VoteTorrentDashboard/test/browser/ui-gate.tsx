/**
 * ui-gate.tsx — the dashboard's ONE new D-24 styled harness entry, and the
 * subject of the D-19 shared runner's `harness-readout` and
 * `shared-components-mounted` rungs.
 *
 * Its ONLY stylesheet import is `../../src/app.css` — the app's own
 * stylesheet, never `@votetorrent/ui-web/tokens.css` directly. That is
 * deliberate, and it is the whole reason this file's D-23 token probe can
 * catch anything: if this harness imported the tokens itself, it would
 * render correctly even on a build where the app FORGOT its own
 * `@import '@votetorrent/ui-web/tokens.css';` — the probe would then pass on
 * the one failure it exists to catch. Observing the app's own wiring, not
 * re-declaring it, is what makes this harness a genuine test of the app.
 *
 * Mounts every named export of `@votetorrent/ui-web/components` inside a
 * wrapper carrying `data-ui-gate="<ExportName>"`, driving props so each
 * renders non-empty output:
 *   - `AdvisoryDisclosure` receives `variant="authority"` — the dashboard's
 *     own voice (D-07).
 *   - `LifecyclePill` receives the determinate phase `"voting"` — it
 *     returns `null` for a `null` phase, and a rung that accepted an empty
 *     container would be inert. (`"voting"` is 54-02's rename of the retired
 *     mid-election id; this harness was not updated with it, which left the
 *     dashboard workspace typecheck red for two waves — the browser gate
 *     could not see it because Vite's esbuild transform strips types without
 *     checking them. Logged as DEF-54-01, closed here by 54-07.)
 *   - `DetailsToggle` — 53-05's designated hook-calling component — is
 *     mounted in its interactive form. `DetailsToggle`'s own props (summary,
 *     children, defaultOpen) carry no room for an extra DOM attribute on its
 *     internal button, so this harness sets `data-ui-gate-action` on that
 *     button IMPERATIVELY, once, right after mount — the button itself is
 *     never re-rendered by that call, and 53-09's browser gate is left to
 *     read (never set) the state this exposes: this plan only guarantees
 *     the component is genuinely mounted and interactive.
 *
 * After `createRoot(...).render(...)`, a bounded `requestAnimationFrame`
 * poll (never a fixed sleep) waits for the DOM to settle, then builds
 * `mounted` from the `[data-ui-gate]` attribute values ACTUALLY FOUND IN THE
 * DOCUMENT — never from this file's own static render list, so a component
 * that threw during render is reported ABSENT rather than asserted present.
 *
 * 53-09 ADDITION — the D-19 React-identity rung's subject. A SEPARATE
 * `[data-ui-gate="hook-root"]` region is mounted in its OWN React root (a
 * container `appendChild`-ed to `document.body`, never nested under `#root`)
 * so a hook-dispatcher render throw in that region cannot unmount or blank
 * the token-probe/presentational region above — the structural half of the
 * measured 19/19 → 8/12 PARTIAL failure signature (the runner-side half is
 * `run-ui-gates.mjs`'s per-rung `try`/`catch`). It mounts `DetailsToggle` a
 * SECOND time, independent of `DetailsToggleHarness` above (unchanged, still
 * the `shared-components-mounted` rung's subject): its one `.dt-toggle`
 * button is what the identity rung clicks, and its body — rendered only
 * while open — is what makes that click change `[data-ui-gate="hook-root"]`'s
 * own `textContent`, the real state transition the rung asserts rather than
 * a mere mount. `computeReactIdentity()` compares this app's own `react`
 * import against `@votetorrent/ui-web/components`'s `packageReactIdentity()`
 * and is published as `window.__UI_GATE__.identity`.
 */
import { StrictMode, useEffect, useRef, useState } from 'react';
import * as AppReact from 'react';
import { createRoot } from 'react-dom/client';
import '../../src/app.css';
import { AdvisoryDisclosure, LifecyclePill, DetailsToggle, packageReactIdentity } from '@votetorrent/ui-web/components';

const win = window as unknown as Record<string, unknown>;

/** Frame budget for the settle poll below — generous, still bounded. */
const SETTLE_FRAMES = 60;

/**
 * React 19's client-internals holder property name — the dispatcher holder
 * a real hook call reads through. See
 * `packages/ui-web/src/react-identity.js`'s own header for the measured
 * reason comparing THIS (not the version string, not a namespace-object
 * identity) is the sound measure.
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

function settle(maxFrames: number): Promise<void> {
	return new Promise((resolve) => {
		let frames = 0;
		function tick() {
			frames += 1;
			if (frames >= maxFrames) {
				resolve();
				return;
			}
			requestAnimationFrame(tick);
		}
		requestAnimationFrame(tick);
	});
}

function DetailsToggleHarness() {
	const wrapperRef = useRef<HTMLDivElement>(null);
	const [mountedOnce, setMountedOnce] = useState(false);

	useEffect(() => {
		if (mountedOnce) return;
		const button = wrapperRef.current?.querySelector<HTMLButtonElement>('button.dt-toggle');
		button?.setAttribute('data-ui-gate-action', 'DetailsToggle-toggle');
		setMountedOnce(true);
	}, [mountedOnce]);

	return (
		<div data-ui-gate="DetailsToggle" ref={wrapperRef}>
			<DetailsToggle summary={<span>ui-gate harness details</span>}>
				<p>Harness body content for the D-19 hook-identity gate.</p>
			</DetailsToggle>
		</div>
	);
}

function UiGateHarness() {
	return (
		<div className="ui-gate-harness">
			<div data-ui-gate="AdvisoryDisclosure">
				<AdvisoryDisclosure variant="authority" />
			</div>
			<div data-ui-gate="LifecyclePill">
				<LifecyclePill phase="voting" />
			</div>
			<DetailsToggleHarness />
		</div>
	);
}

/**
 * The hook-root region (53-09, D-19) — mounted in ITS OWN root, separate
 * from `UiGateHarness`'s (see this file's header). Renders `DetailsToggle`
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

async function main() {
	const container = document.getElementById('root');
	let renderError: string | null = null;

	if (container) {
		try {
			const root = createRoot(container);
			root.render(
				<StrictMode>
					<UiGateHarness />
				</StrictMode>,
			);
		} catch (err) {
			renderError = String((err as { message?: unknown })?.message ?? err);
		}
	} else {
		renderError = 'ui-gate.html is missing #root';
	}

	// The hook-root region's own SEPARATE root and container — appended to
	// document.body, never nested under #root, so a render throw here cannot
	// unmount or blank the region above (this file's header). A throw here
	// is deliberately swallowed: identity:hook-mounted reads the DOM
	// directly and reports this region ABSENT rather than asserting it
	// present, and the readout below must still publish either way.
	const hookRootContainer = document.createElement('div');
	document.body.appendChild(hookRootContainer);
	try {
		createRoot(hookRootContainer).render(
			<StrictMode>
				<HookRootHarness />
			</StrictMode>,
		);
	} catch {
		// intentionally swallowed — see comment above.
	}

	await settle(SETTLE_FRAMES);

	const mounted = [...document.querySelectorAll('[data-ui-gate]')]
		.map((el) => el.getAttribute('data-ui-gate'))
		.filter((name): name is string => name != null);

	const detailsButton = document.querySelector<HTMLButtonElement>('[data-ui-gate="DetailsToggle"] button.dt-toggle');

	win.__UI_GATE__ = Object.freeze({
		mounted,
		hook: {
			component: 'DetailsToggle',
			initial: detailsButton?.getAttribute('aria-expanded') === 'true',
		},
		identity: computeReactIdentity(),
		error: renderError,
	});
	win.__UI_GATE_DONE__ = true;
}

main();
