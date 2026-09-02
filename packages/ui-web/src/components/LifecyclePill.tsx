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
 * into this shared package under D-01/D-02 (53-05). The only change is the
 * two import specifiers below, now direct package-relative siblings rather
 * than a dashboard-relative path -- `.lifecycle-pill` itself stays defined
 * in the dashboard's own `src/screens/panels/election-ops.css` (D-15: each
 * app owns its own component styles).
 */
import { phaseCopyKey } from '../lifecycle/election-phase.js';
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
