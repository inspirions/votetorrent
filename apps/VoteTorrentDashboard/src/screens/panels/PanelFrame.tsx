/**
 * PanelFrame.tsx — the shared panel chrome, COMPOSED AROUND a panel by
 * 50-09's `PanelGrid` — never rendered by a panel itself (contract C7). This
 * file ships in this plan because it is shared, and because the
 * denied-body guard below is a security control (T-50-06-03) that must
 * exist before any panel content does; its only *caller* arrives in wave 5.
 *
 * This frame renders NO partial-access-versus-full-access indicator of any
 * kind. Neither of those two states exists in this phase: D-17 drops the
 * write-window gate entirely (there is nothing to write), so the only two
 * panel states this frame can produce are visible and denied. See
 * 50-06-PLAN.md's inherited-spec reconciliation for the "why" behind that
 * omission.
 */
import type { ReactNode } from 'react';
import type { Capability } from '../../auth/capabilities.js';
import type { GateResult } from '../../auth/gate.js';
import { t } from '../../i18n/copy.js';
import './panels.css';

export interface PanelFrameProps {
	capability: Capability;
	evaluation: GateResult;
	children: ReactNode;
}

export function PanelFrame({ capability, evaluation, children }: PanelFrameProps) {
	return (
		<section className={`panel${evaluation.visible ? '' : ' panel--denied'}`}>
			<header className="panel-header">
				<span className="panel-icon" aria-hidden="true">
					{capability.icon}
				</span>
				<h3 className="panel-title">{t(capability.titleKey)}</h3>
			</header>
			<div className="panel-pills">
				<span className="pill pill-scope" title={capability.schemaName}>
					{capability.scope}
				</span>
				{/* Both pills render through `t()`. They used to be authored
				    English -- "tier", "site", and the add-an-s pluralisation
				    rule -- living outside the frozen copy table that contract
				    C2 makes the ONLY place a user-facing string may live. The
				    Spanish locale the producer half ships had no path to
				    translate either word. */}
				<span className="pill pill-tier">{t('panelFrame.tierPill', { tier: String(capability.tier) })}</span>
				<span
					className="pill pill-sites"
					title={capability.siteCountCaveat ?? undefined}
				>
					{t(capability.sites === 1 ? 'panelFrame.sitePill' : 'panelFrame.sitesPill', {
						count: String(capability.sites),
					})}
				</span>
			</div>
			{/*
			 * Binding guard (T-50-06-03): a denied panel's children are not
			 * rendered AT ALL, not merely hidden with CSS. Hiding a rendered
			 * body would leave the officer's data in the DOM — an
			 * information-disclosure failure this frame exists to prevent.
			 */}
			{evaluation.visible ? <div className="panel-body">{children}</div> : null}
		</section>
	);
}
