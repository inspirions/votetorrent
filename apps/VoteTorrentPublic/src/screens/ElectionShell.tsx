import type { ReactNode } from 'react';
import { t } from '@votetorrent/ui-web';
import { AdvisoryDisclosure, DetailsToggle, LifecyclePill } from '@votetorrent/ui-web/components';
// computeElectionPhase still has live callers (ElectionsPanel.tsx,
// gate-matrix.tsx) — 54-07 removes it; do not "tidy" it away for looking unused.
import { derivePhase, resolveComparisonInstant } from '@votetorrent/ui-web/lifecycle';
import { AppChrome } from './AppChrome';
import { parseElectionAddress } from '../election-address.js';

/**
 * ElectionShell.tsx — the empty election shell (53-07, D-12/D-14/D-16/D-18).
 *
 * `timeline` is `unknown` on purpose: `ElectionRevision.Timeline`
 * (votetorrent.qsql:840,:891) carries a standing `-- TODO: constrain
 * Timeline` and zero CHECK constraints, so it is unvalidated JSON that only
 * `derivePhase` (packages/ui-web/src/lifecycle/election-phase.js)
 * is permitted to interpret. Nothing in this file inspects it directly.
 */
export interface PublicElectionFacts {
	title: string | null;
	timeline: unknown;
}

export interface ElectionShellProps {
	/** Defaults to `window.location.search`. Injectable so the harness's own
	 * `?phase=` never becomes this shell's address (T-53-07-04's consumer-side
	 * half: the harness proves the address input is injectable rather than
	 * this component reaching for `window` unconditionally). */
	search?: string;
	/** A canonical 19-character instant, or `null` to let
	 * `resolveComparisonInstant` fall back to the real clock. NEVER read from
	 * the URL — see election-address.js's header, point 4, and T-53-07-04:
	 * a URL-controlled instant would let a link author choose which
	 * lifecycle phase any visitor is shown. */
	at?: string | null;
	/** The D-17 seam. Production renders `<ElectionShell />` with no
	 * `election` prop at all, so no election fact exists anywhere in the
	 * production import graph — there is no default fixture and no fallback
	 * demo timeline here. Only `test/browser/election-shell-gate.tsx`
	 * supplies one, from `test/fixtures/election-fixture.js`. */
	election?: PublicElectionFacts | null;
}

/**
 * The empty election shell: chrome words, genuine mounts of the three
 * shared components, inert placeholders (D-18), and an honest
 * unreadable-address state that never echoes the offending value (D-14).
 *
 * Exactly ONE `return` statement, deliberately — not style. `AdvisoryDisclosure`'s
 * own header states that the moment it can be conditioned on anything it can
 * be hidden, and `DetailsToggle`'s live hook is what makes the D-19 identity
 * gate and the D-20 dedupe control observable at all. A single return makes
 * both structurally unbranchable: neither can ever sit inside a conditional
 * branch this function takes.
 */
export function ElectionShell({ search, at = null, election = null }: ElectionShellProps) {
	const address = parseElectionAddress(search ?? window.location.search);

	let body: ReactNode;
	if (address.status === 'malformed') {
		// The offending value is never rendered — parseElectionAddress already
		// returns electionId: null for this status, so there is nothing here
		// to escape and nothing to leak (T-53-07-02).
		body = (
			<section className="election-unreadable">
				<h2>{t('public.election.unreadableAddress.title')}</h2>
				<p>{t('public.election.unreadableAddress.body')}</p>
			</section>
		);
	} else {
		// `election ?? {}`, never `?? null` — parseTimeline reads
		// `election.ballotDeadline` unguarded, so `null` throws.
		const crossCheck = (election ?? {}) as unknown as Parameters<typeof derivePhase>[0];
		const { phase } = derivePhase(crossCheck, election?.timeline, resolveComparisonInstant(at ?? undefined));
		body = (
			<section className="election">
				{address.status === 'ok' ? (
					<p className="election-address">
						{t('public.election.addressLabel')} <code>{address.electionId}</code>
					</p>
				) : null}
				<LifecyclePill phase={phase} />
				{election?.title ? (
					<p className="election-title">{election.title}</p>
				) : (
					<div className="skeleton" data-slot="title">
						<span className="skeleton-label">{t('public.election.slot.title')}</span>
					</div>
				)}
				{/* holding measure; 54-12 owns D-10's explicit unknown state */}
				{phase === null || phase === 'indeterminate' ? (
					<div className="skeleton" data-slot="lifecycle">
						<span className="skeleton-label">{t('public.election.slot.lifecycle')}</span>
					</div>
				) : null}
				{election === null ? (
					<div className="skeleton" data-slot="timeline">
						<span className="skeleton-label">{t('public.election.slot.timeline')}</span>
					</div>
				) : null}
			</section>
		);
	}

	return (
		<AppChrome title={t('public.chrome.appName')}>
			{body}
			{/* A sibling of the toggle below, never a child of it — D-16 forbids
			    the advisory ever becoming conditional on anything, including
			    being hideable inside a collapsible. */}
			<AdvisoryDisclosure variant="public" />
			<DetailsToggle summary={t('public.details.summary')}>{t('public.details.body')}</DetailsToggle>
		</AppChrome>
	);
}

export default ElectionShell;
