/**
 * PanelGrid.tsx — the nine-panel grid, in `CAPABILITIES`' frozen order.
 *
 * The scope set `evaluate()` is asked about arrives from exactly ONE place —
 * `useEffectiveScopes()` — and is never computed here. This seam is
 * unchanged in spirit from 50-06's own gate contract, precisely so a
 * "preview as" control can vary it without editing this file and without
 * this gate ever being stubbed. There is deliberately NO `grantedScopes`
 * prop beside that hook: one existed, was threaded in by `DashboardShell`,
 * and was never read — a dead second source of the same answer that made a
 * real defect (the provider freezing an empty real-scope set) hard to see
 * from the call site. `snapshotInstant` is an ADDITION beside it,
 * not a replacement: the 19-character canonical instant this browser's
 * snapshot was taken at, supplied by `DashboardShell` (which already holds
 * it for the freshness indicator) and passed straight through to every
 * mounted panel. This component neither reads nor formats that instant —
 * it is a pure pass-through, so the grid keeps exactly one job.
 *
 * COMPOSITION, NOT DELEGATION: this file calls `evaluate()` and composes
 * `PanelFrame` around each registry component -- a panel never renders its
 * own frame (contract C7). A denied capability that is not revealed emits
 * NOTHING; a denied capability that IS revealed emits a frame with no
 * children, so the registry component never mounts and no query ever runs
 * against the officer's data for something they cannot see. This is real
 * behaviour, and its honest limit is the same one `src/auth/gate.js`
 * states: it is NOT enforcement. Read authorization here is advisory —
 * there is no CHECK behind it, and anyone holding this browser's
 * bootstrapped copy holds the whole database regardless of what is
 * rendered.
 */
import type { Database } from '@quereus/quereus';
import { CAPABILITIES } from '../auth/capabilities.js';
import { evaluate } from '../auth/gate.js';
import { useEffectiveScopes } from './GrantedScopesContext.js';
import { PanelFrame } from './panels/PanelFrame.js';
import { PANEL_REGISTRY } from './panels/registry.js';
import { t } from '@votetorrent/ui-web';

export interface PanelGridProps {
	db: Database | null;
	revealDenied: boolean;
	onToggleReveal: () => void;
	/** The instant this browser's snapshot was taken at — see the file header. */
	snapshotInstant?: string | null;
}

export function PanelGrid({ db, revealDenied, onToggleReveal, snapshotInstant }: PanelGridProps) {
	const effective = useEffectiveScopes();
	return (
		<div className="sh-panel-grid-wrap">
			<button type="button" className="sh-reveal-toggle" aria-pressed={revealDenied} onClick={onToggleReveal}>
				{t('gate.revealDeniedCta')}
			</button>
			<div className="panel-grid">
				{CAPABILITIES.map((capability) => {
					const evaluation = evaluate(capability, effective);
					const Component = PANEL_REGISTRY[capability.id];

					if (evaluation.visible) {
						return (
							<div key={capability.id} id={`panel-${capability.id}`}>
								<PanelFrame capability={capability} evaluation={evaluation}>
									<Component capability={capability} db={db} snapshotInstant={snapshotInstant} />
								</PanelFrame>
							</div>
						);
					}

					if (revealDenied) {
						// No children -- the registry component is never mounted for a
						// denied capability, so no query ever runs against the
						// officer's data on its behalf.
						return (
							<div key={capability.id} id={`panel-${capability.id}`}>
								<PanelFrame capability={capability} evaluation={evaluation} children={null} />
							</div>
						);
					}

					return null;
				})}
			</div>
		</div>
	);
}

export default PanelGrid;
