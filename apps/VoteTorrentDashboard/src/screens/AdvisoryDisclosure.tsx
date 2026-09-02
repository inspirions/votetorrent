/**
 * AdvisoryDisclosure.tsx — the D-16 binding advisory-gate disclosure.
 *
 * No props, no state, no branch. An officer must read this sentence in the
 * DEFAULT (un-simulated, un-touched) state exactly as much as in a
 * previewed one — the moment this component can be conditioned on
 * anything, it can be hidden, and that is the one failure mode D-16 exists
 * to prevent. Read authorization in this phase is UI-only and advisory:
 * there is no CHECK constraint behind it, and anyone holding this browser's
 * bootstrapped snapshot holds the whole database regardless of what
 * renders. This component is the on-screen statement of exactly that fact,
 * and it must never itself become conditional on the fact it describes.
 */
import { t } from '@votetorrent/ui-web';

export function AdvisoryDisclosure() {
	return <p className="pv-disclosure">{t('gate.advisoryDisclosure')}</p>;
}

export default AdvisoryDisclosure;
