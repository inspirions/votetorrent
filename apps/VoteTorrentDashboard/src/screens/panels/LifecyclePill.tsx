/**
 * LifecyclePill.tsx -- the computed, non-interactive lifecycle status pill.
 *
 * The phase is computed from the election's own timeline
 * (`src/lifecycle/election-phase.js`) and never chosen by an officer --
 * there is deliberately no control anywhere in this app to change it.
 * Renders nothing when the phase is indeterminate: a foreign, absent,
 * incomplete or non-monotonic timeline earns no pill rather than a
 * confident wrong phase.
 *
 * Not a `PanelComponent` -- it takes a single `phase` prop and is mounted
 * by `ElectionsPanel`, not by the registry.
 */
import { phaseCopyKey } from '../../lifecycle/election-phase.js';
import { t } from '../../i18n/copy.js';

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
