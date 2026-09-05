import { useEffect, useState } from 'react';
import { CONFIG_FAULT, loadBootstrapConfig } from '../peer/config.js';
import { ElectionShell } from './ElectionShell';

/**
 * PublicApp.tsx — the production composition (56-12, D-13's fault-UI half).
 *
 * `56-06` shipped `src/peer/config.js`: a zero-import, never-throws loader
 * that resolves the deployment's bootstrap address list into `{ ok: true,
 * bootstrapNodes }` or `{ ok: false, fault: 'missing' | 'malformed', reason
 * }`. `56-12` renders that result for the first time. This file is the ONE
 * boot effect that resolves the config; `main.tsx` mounts it in place of a
 * bare `<ElectionShell />`, and every existing browser harness keeps
 * mounting `ElectionShell` directly with no `configFault` prop — so it sees
 * a byte-identical page.
 *
 * WHY THE FAULT RESOLVES HERE AND NOT IN `ElectionShell.tsx` OR IN
 * `use-public-election.ts`. Loading a config is an effect with an `await`,
 * and `ElectionShell.tsx` holds zero `useEffect` and zero `await ` by
 * construction (`election-shell.test.mjs` case 12b) — a second `return` in
 * that file is the cheapest way to make `AdvisoryDisclosure` conditional by
 * accident, so no effect may live there. It cannot live in
 * `use-public-election.ts`'s attach effect either: that effect is gated on
 * `shouldReadFor`, so it never runs on the election-less index page, and the
 * config fault must be answerable there too — a deployment that cannot
 * learn where to dial cannot look up ANY election, addressed or not.
 *
 * WHY EVERY EXISTING HARNESS STAYS UNAFFECTED. `dist-gate/`, `dist-live/`
 * and every `dist-mutant-` variant directory are all `publicDir: false`
 * builds with no `config.json` on disk. If `ElectionShell.tsx` itself resolved a config,
 * every one of those pages would render the fault box the instant this plan
 * landed, and `test:browser`/`test:render-fidelity`/`test:live-read`/
 * `test:empty-state` would all go red on a page they never intended to
 * change. Composing the boot effect in a NEW file that only `main.tsx`
 * mounts is what keeps every harness page byte-identical.
 *
 * THE PENDING STATE RENDERS NOTHING, NOT A SPINNER, NOT A SKELETON. This
 * app's `.skeleton` means "a space left empty ON PURPOSE, nothing is
 * loading" (D-18) — the opposite of what is happening during the fetch — and
 * flashing a fault box that then clears a moment later would be a false
 * statement briefly shown to a reader. Rendering nothing for the (typically
 * sub-second, same-origin) interval before the fetch settles is the honest
 * choice available.
 */

/**
 * The two fault values `src/peer/config.js` can report, typed from
 * `CONFIG_FAULT`'s own values so a change to that module's fault vocabulary
 * is a compile error here rather than a silently stale type.
 */
export type BootstrapConfigFault = (typeof CONFIG_FAULT)[keyof typeof CONFIG_FAULT];

/**
 * The frozen, two-member map from `CONFIG_FAULT`'s values to the copy-key
 * pair the config-fault box resolves through `t()`. This IS the entire
 * rendering contract, stated as a closed set of four string literals -- the
 * same structural containment `56-10` used to make document echo
 * impossible rather than merely absent (`packages/web-data`'s public-audience
 * boundary). `loadBootstrapConfig`'s `reason` field is never read anywhere
 * in this file, never passed to `t()`, and never logged: it is a
 * developer-facing diagnostic that has no reader-facing counterpart.
 *
 * Not imported by `ElectionShell.tsx` on purpose: this module already
 * imports `ElectionShell`, and a reverse import would make the pair a
 * circular one. `ElectionShell.tsx` resolves the identical two keys through
 * its own `public.config.${configFault}.title`/`.body` template instead --
 * see that file's own comment at the fault arm. This map is kept here as
 * the canonical, source-scannable declaration of the closed set (proven by
 * `test/node/offline-surfaces.test.mjs`) rather than as a value either
 * component consumes at runtime.
 */
export const FAULT_COPY_KEYS: Readonly<Record<BootstrapConfigFault, Readonly<{ title: string; body: string }>>> = Object.freeze({
	[CONFIG_FAULT.MISSING]: Object.freeze({ title: 'public.config.missing.title', body: 'public.config.missing.body' }),
	[CONFIG_FAULT.MALFORMED]: Object.freeze({ title: 'public.config.malformed.title', body: 'public.config.malformed.body' }),
});

/** The loader's own signature -- the injectable seam. Defaults to the real
 * `loadBootstrapConfig`, so the hook is exercisable at Node tier with no
 * browser and no build. */
export interface UseBootstrapConfigFaultOptions {
	loader?: typeof loadBootstrapConfig;
}

/**
 * Resolve the deployment's bootstrap config exactly once at boot.
 *
 * Returns `'pending'` before the fetch settles, `null` on a valid config,
 * or one of `CONFIG_FAULT`'s two values on a fault. Because
 * `loadBootstrapConfig` never throws and never rejects, there is no
 * `try`/`catch` here and no third error state -- the result union IS the
 * error handling, and adding a catch would invent a fourth state nothing
 * upstream can produce.
 *
 * Commits behind the same cancelled-mount guard the rest of this app already
 * uses (`use-public-election.ts`'s attach effect, `ElectionsPanel.tsx`'s
 * shape): a `cancelled` flag set in the cleanup, checked before the commit.
 */
export function useBootstrapConfigFault({ loader = loadBootstrapConfig }: UseBootstrapConfigFaultOptions = {}): 'pending' | BootstrapConfigFault | null {
	const [fault, setFault] = useState<'pending' | BootstrapConfigFault | null>('pending');

	useEffect(() => {
		let cancelled = false;
		// `loadBootstrapConfig`'s own `FetchLike` typedef is deliberately
		// looser than the DOM `Response` type (its own header explains why),
		// so the real `fetch` is handed through a thin wrapper rather than
		// passed directly -- the two signatures are structurally close but
		// not identical enough for the checker to unify them.
		const fetchImpl = (url: string, init: { credentials: string; cache: string; redirect: string }) => fetch(url, init as RequestInit);
		loader({ fetchImpl, pageProtocol: window.location.protocol }).then((result) => {
			if (cancelled) return;
			setFault(result.ok ? null : result.fault);
		});
		return () => {
			cancelled = true;
		};
	}, [loader]);

	return fault;
}

/**
 * The production entry `main.tsx` mounts in place of a bare `<ElectionShell
 * />`. Resolves the config once at boot and hands `ElectionShell` a
 * two-valued fault, or `null`. Renders NOTHING else -- no `AppChrome`, no
 * advisory, no caveats of its own: those live in the shell, and the fault
 * box must render INSIDE them, not beside them.
 */
export function PublicApp() {
	const fault = useBootstrapConfigFault();
	if (fault === 'pending') return null;
	return <ElectionShell configFault={fault} />;
}

export default PublicApp;
