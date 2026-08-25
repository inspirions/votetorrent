/**
 * BallotsQuestionsPanel.tsx — stub. Filled by 50-10 (Election Operations).
 *
 * Renders only its own body content — this panel does not wrap or import
 * the shared chrome component (contract C7: that frame is composed around
 * this panel by 50-09's `PanelGrid`, which is the only place that calls
 * `evaluate()`). No database query, no action
 * affordance, no gating decision — this is the honest Empty state: no
 * snapshot has been bootstrapped yet at this wave, so there is genuinely
 * nothing to show.
 */
import type { PanelComponent } from './types.js';
import { t } from '../../i18n/copy.js';

const BallotsQuestionsPanel: PanelComponent = ({ capability }) => (
	<p className="panel-empty">{t(capability.emptyKey)}</p>
);

export default BallotsQuestionsPanel;
