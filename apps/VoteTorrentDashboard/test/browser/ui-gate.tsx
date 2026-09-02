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
 *   - `LifecyclePill` receives the determinate phase `"running"` — it
 *     returns `null` for a `null` phase, and a rung that accepted an empty
 *     container would be inert.
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
 */
import { StrictMode, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../../src/app.css';
import { AdvisoryDisclosure, LifecyclePill, DetailsToggle } from '@votetorrent/ui-web/components';

const win = window as unknown as Record<string, unknown>;

/** Frame budget for the settle poll below — generous, still bounded. */
const SETTLE_FRAMES = 60;

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
				<LifecyclePill phase="running" />
			</div>
			<DetailsToggleHarness />
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
		error: renderError,
	});
	win.__UI_GATE_DONE__ = true;
}

main();
