/**
 * LifecyclePill.tsx -- the computed, non-interactive lifecycle status pill.
 *
 * The phase is computed from the election's own timeline
 * (`../lifecycle/election-phase.js`) and never chosen by an officer --
 * there is deliberately no control anywhere in this app to change it.
 * Renders nothing when the phase is indeterminate: a foreign, absent,
 * incomplete or non-monotonic timeline earns no pill rather than a
 * confident wrong phase.
 *
 * Not a `PanelComponent` -- it takes a single `phase` prop and is mounted
 * by `ElectionsPanel`, not by the registry.
 *
 * Moved from apps/VoteTorrentDashboard/src/screens/panels/LifecyclePill.tsx
 * into this shared package under D-01/D-02 (53-05). The only change at that
 * time was the two import specifiers below, now direct package-relative
 * siblings rather than a dashboard-relative path.
 *
 * `.lifecycle-pill` and its three modifiers moved again at 53-CR01, into this
 * package's own `../components.css` (exported as `./components.css`) -- the
 * D-15 revision: the package that owns a shared component's markup now also
 * owns that component's default CSS, for exactly the class names it renders.
 * CR-01 measured the prior rule ("each app owns its own component styles")
 * leaving `.lifecycle-pill` with zero rules in `apps/VoteTorrentPublic`,
 * invisible to every gate this phase had built. See
 * `packages/ui-web/README.md`'s "Shared component default styles" section.
 *
 * `phaseCopyKey` is imported from `../lifecycle/phase-ids.js`, NOT
 * `../lifecycle/election-phase.js` (WR-11, Phase 53 review): the latter's
 * only external dependency is `@votetorrent/vote-engine/browser` -- a
 * database engine -- and importing it from here would transitively pull that
 * engine into `./components` (this file's own barrel, per
 * `src/components.js`), contradicting `src/index.js`'s stated reason for
 * keeping `./lifecycle` a separate, plain-JS-only exports entry. See
 * `phase-ids.js`'s own header for the full split rationale.
 */
import { phaseCopyKey } from '../lifecycle/phase-ids.js';
import { t } from '../copy.js';

export interface LifecyclePillProps {
	phase: 'organizing' | 'running' | 'released' | null;
}

export function LifecyclePill({ phase }: LifecyclePillProps) {
	const key = phaseCopyKey(phase);
	if (key === null) {
		return null;
	}
	return <span className={`lifecycle-pill lifecycle-pill--${phase}`}>{t(key)}</span>;
}

export default LifecyclePill;
