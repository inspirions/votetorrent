/**
 * DashboardShell.tsx — the chrome around a bootstrapped network's data:
 * whose data it is, how old it is, which other networks this browser
 * holds, how to replace a copy without risking the one already held, and
 * — behind a kebab and a typed confirmation — how to end it for good.
 *
 * NO TIMER, NO SUBSCRIPTION, NO STORAGE LISTENER, NO CrossTabSync, NO
 * `.watch(`. The freshness value is computed at MOUNT and after each
 * successful swap (the effect below keys on `bootstrappedAt`, which only
 * changes after a swap actually lands) — never on an interval. Reactivity
 * is deferred to its own future spike and is not a dependency of this
 * phase; a ticking age beside static data would imply a liveness this
 * dashboard does not have.
 *
 * THE OFFICER-SWAP DIALOG'S CURRENT REACHABILITY, STATED HONESTLY: this
 * file builds the full officer-swap confirm dialog and its confirmed path
 * (`performOfficerSwap`, then closing the handle, clearing granted scopes
 * and the selection, and remounting `PanelGrid` under a key derived from
 * `networkHash:officerUserId:bootstrappedAt`), and `pendingSwap` is the
 * seam a caller populates to raise it. Nothing in this wave populates it:
 * `src/screens/Bootstrap.tsx` (50-08, frozen) always calls
 * `redeemAndBootstrap` with no `replace` flag and exposes no completion
 * callback, so a code for an ALREADY-HELD network can only ever resolve as
 * `already-bootstrapped` through that screen today — burning the single-use
 * code without ever surfacing the verified envelope this dialog needs to
 * classify. Closing that gap requires a change to `Bootstrap.tsx` itself
 * (an injectable transport, or a completion callback), which is out of
 * this plan's scope (50-08's file). Recorded here and in the plan's
 * SUMMARY rather than silently pretended away.
 */
import { useEffect, useRef, useState } from 'react';
import type { Database } from '@quereus/quereus';
import { t } from '../i18n/copy.js';
import type { ScopeCode } from '../auth/capabilities.js';
import { CAPABILITIES, PANEL_GROUPS } from '../auth/capabilities.js';
import { readGrantedScopes } from '../auth/is-privileged.js';
import { closeNetworkDb } from '../db/open-db.js';
import {
	attachNetworkDb,
	MissingRowCountsError,
	NotBootstrappedError,
	RowCountMismatchError,
} from '../db/reattach.js';
import type { NetworkRegistryEntry } from '../db/networks-registry.js';
import { listNetworks } from '../db/networks-registry.js';
import { formatStaleThreshold, snapshotFreshness } from '../lifecycle/freshness.js';
import type { SnapshotFreshness } from '../lifecycle/freshness.js';
import { forgetNetwork } from '../lifecycle/forget-network.js';
import { performOfficerSwap } from '../lifecycle/officer-swap.js';
import type { SingleFlightTransport } from '../lifecycle/officer-swap.js';
import { AdvisoryDisclosure, PreviewAsControl, PreviewAsProvider } from './PreviewAsControl.js';
import { PanelGrid } from './PanelGrid.js';
import './shell.css';

export interface DashboardShellProps {
	/** Switches the top-level view to the code-entry screen. When called with
	 * a network hash (the refresh action), the caller records it
	 * as the refresh target so a completed redemption can be matched back to
	 * this network; called with no argument (the switcher's "+ Redeem another
	 * code" row), it is an ordinary first bootstrap. */
	onRedeemAnother: (refreshTargetNetworkHash?: string) => void;
}

interface PendingSwap {
	networkHash: string;
	pastedCode: string;
	transport: SingleFlightTransport;
	incomingOfficerUserId: string;
	authorityName: string;
}

export function DashboardShell({ onRedeemAnother }: DashboardShellProps) {
	const [networks, setNetworks] = useState<NetworkRegistryEntry[]>(() => listNetworks());
	const [activeNetworkHash, setActiveNetworkHash] = useState<string | undefined>(() => networks[0]?.networkHash);
	const activeNetwork = networks.find((entry) => entry.networkHash === activeNetworkHash);

	const [db, setDb] = useState<Database | null>(null);
	const [grantedScopes, setGrantedScopes] = useState<ScopeCode[]>([]);
	const [attachError, setAttachError] = useState<unknown>(null);
	const dbRef = useRef<Database | null>(null);

	const [revealDenied, setRevealDenied] = useState(false);
	const [switcherOpen, setSwitcherOpen] = useState(false);
	const [kebabOpen, setKebabOpen] = useState(false);
	const [toast, setToast] = useState<string | null>(null);

	const [forgetConfirmationInput, setForgetConfirmationInput] = useState('');
	const [forgetError, setForgetError] = useState<unknown>(null);
	const forgetDialogRef = useRef<HTMLDialogElement | null>(null);

	const [pendingSwap, setPendingSwap] = useState<PendingSwap | null>(null);
	const [swapError, setSwapError] = useState<unknown>(null);
	const swapDialogRef = useRef<HTMLDialogElement | null>(null);

	// Computed at mount and re-computed only when the ACTIVE NETWORK or its
	// OWN `bootstrappedAt` changes (i.e. after a successful swap) -- never on
	// a timer. See the file header's no-reactivity note.
	const [freshness, setFreshness] = useState<SnapshotFreshness | null>(() =>
		activeNetwork ? snapshotFreshness(activeNetwork.bootstrappedAt) : null,
	);
	useEffect(() => {
		setFreshness(activeNetwork ? snapshotFreshness(activeNetwork.bootstrappedAt) : null);
	}, [activeNetwork?.networkHash, activeNetwork?.bootstrappedAt]);

	// Attach the active network's handle and read its officer's granted
	// scopes. Closes the PREVIOUS handle before opening the next -- an open
	// connection blocks `indexedDB.deleteDatabase` and would manufacture a
	// `DeleteBlockedError` on a subsequent forget.
	useEffect(() => {
		let cancelled = false;
		setDb(null);
		setGrantedScopes([]);
		setAttachError(null);

		async function attach() {
			if (dbRef.current) {
				await closeNetworkDb(dbRef.current);
				dbRef.current = null;
			}
			if (!activeNetwork) return;
			try {
				const handle = await attachNetworkDb(activeNetwork.networkHash);
				if (cancelled) {
					await closeNetworkDb(handle);
					return;
				}
				dbRef.current = handle;
				const scopes = await readGrantedScopes(handle, activeNetwork.officerUserId);
				if (cancelled) return;
				setDb(handle);
				setGrantedScopes(scopes);
			} catch (err) {
				if (!cancelled) setAttachError(err);
			}
		}

		void attach();

		return () => {
			cancelled = true;
		};
		// officerUserId AND bootstrappedAt, not networkHash alone. This effect
		// READS activeNetwork.officerUserId to compute grantedScopes, and a
		// successful officer swap replaces the registry entry's officerUserId
		// and bootstrappedAt while KEEPING the same networkHash -- so with a
		// hash-only dependency the effect never re-ran, never re-attached, and
		// left db at null with no scopes for the rest of the page's life.
		// PanelGrid's remount key already includes both, so the grid remounted
		// around a dead handle. A dependency list must cover everything the
		// effect body reads.
	}, [activeNetwork?.networkHash, activeNetwork?.officerUserId, activeNetwork?.bootstrappedAt]);

	// Unmount-only cleanup, distinct from the per-network effect above.
	useEffect(
		() => () => {
			if (dbRef.current) {
				void closeNetworkDb(dbRef.current);
				dbRef.current = null;
			}
		},
		[],
	);

	// An unbootstrapped network (the schema-init marker is missing) has
	// nothing this shell can show -- route straight to the code-entry screen
	// rather than rendering a dead panel grid.
	useEffect(() => {
		if (attachError instanceof NotBootstrappedError && activeNetwork) {
			onRedeemAnother(activeNetwork.networkHash);
		}
	}, [attachError, activeNetwork, onRedeemAnother]);

	function handleSelectNetwork(hash: string) {
		setActiveNetworkHash(hash);
		setSwitcherOpen(false);
	}

	function handleOpenForgetDialog() {
		setForgetConfirmationInput('');
		setForgetError(null);
		setKebabOpen(false);
		forgetDialogRef.current?.showModal();
	}

	async function handleConfirmForget() {
		if (!activeNetwork) return;
		try {
			const result = await forgetNetwork({
				networkHash: activeNetwork.networkHash,
				typedConfirmation: forgetConfirmationInput,
				db: dbRef.current ?? undefined,
			});
			dbRef.current = null;
			setDb(null);
			forgetDialogRef.current?.close();
			setNetworks(result.remaining);
			if (result.remaining.length > 0) {
				setActiveNetworkHash(result.remaining[0]?.networkHash);
			} else {
				onRedeemAnother(undefined);
			}
		} catch (err) {
			// The dialog stays open and the network stays listed -- the
			// truthful state is "still here". The failure detail goes to
			// `console.error` naming the error class and the database name,
			// and NO row value -- there is no dedicated copy key for this
			// state in the frozen table (a recorded finding, not an
			// invented string).
			// eslint-disable-next-line no-console
			console.error('forgetNetwork failed:', (err as { name?: string })?.name, activeNetwork.networkHash);
			setForgetError(err);
		}
	}

	async function handleConfirmSwap() {
		if (!pendingSwap) return;
		// HAND THE HANDLE OVER BEFORE THE SWAP, NEVER AFTER.
		// `performOfficerSwap` -> `refreshNetwork` -> `redeemAndBootstrap({
		// replace: true })` deletes this exact database, and
		// `indexedDB.deleteDatabase` blocks while any connection is open --
		// `deleteNetworkDb` deliberately refuses to resolve on `onblocked` and
		// throws `DeleteBlockedError` after its timeout. This function used to
		// close `dbRef.current` only AFTER the swap returned, so the shell was
		// racing its own delete and every confirmed swap failed, burning the
		// officer's single-use code. `forgetNetwork` already got this right by
		// passing `{ db }`; this path is the one that forgot.
		const handoverDb = dbRef.current ?? undefined;
		dbRef.current = null;
		setDb(null);
		try {
			const result = await performOfficerSwap({
				networkHash: pendingSwap.networkHash,
				pastedCode: pendingSwap.pastedCode,
				transport: pendingSwap.transport,
				db: handoverDb,
			});
			if (result.outcome !== 'ok') {
				setSwapError(result);
				return;
			}
			swapDialogRef.current?.close();
			// Session termination happens in ONE place: refreshing `networks`
			// advances this entry's officerUserId and bootstrappedAt, and the
			// attach effect above keys on both -- so it tears the old handle
			// down and re-attaches as the new officer on its own. Doing it
			// here as well meant two owners for one transition, and it was the
			// one that ran: the effect's hash-only dependency never fired, so
			// the local `setDb(null)` / `setGrantedScopes([])` were the LAST
			// word and the session simply ended. `PanelGrid` still remounts
			// under a fresh key, so no panel retains a prior-officer row.
			setNetworks(listNetworks());
			setPendingSwap(null);
			setToast(t('snapshot.verifiedToast'));
		} catch (err) {
			setSwapError(err);
		}
	}

	function handleCancelSwap() {
		pendingSwap?.transport.reset();
		setPendingSwap(null);
		setSwapError(null);
		swapDialogRef.current?.close();
	}

	useEffect(() => {
		if (pendingSwap) {
			swapDialogRef.current?.showModal();
		}
	}, [pendingSwap]);

	if (!activeNetwork) {
		return null;
	}

	const forgetConfirmDisabled = forgetConfirmationInput.trim() !== activeNetwork.authorityName.trim();

	return (
		<PreviewAsProvider realScopes={grantedScopes}>
		<div className="sh-layout">
			<div className="sh-topbar">
				<div className="sh-identity">
					<span className="sh-authority-name">{activeNetwork.authorityName}</span>
					<span className="sh-domain">{activeNetwork.domain}</span>
				</div>

				<div className="sh-topbar-actions">
					<div className="sh-switcher">
						<button type="button" className="sh-switcher-button" onClick={() => setSwitcherOpen((open) => !open)}>
							{activeNetwork.authorityName}
						</button>
						{switcherOpen ? (
							<div className="sh-switcher-list" role="menu">
								{networks.map((entry) => {
									const entryFreshness = snapshotFreshness(entry.bootstrappedAt);
									return (
										<button
											key={entry.networkHash}
											type="button"
											className={`sh-switcher-row${entry.networkHash === activeNetworkHash ? ' sh-switcher-row--active' : ''}`}
											onClick={() => handleSelectNetwork(entry.networkHash)}
										>
											<span className="sh-switcher-row-name">{entry.authorityName}</span>
											<span className="sh-switcher-row-meta">{entry.domain}</span>
											<span className="sh-switcher-row-meta">
												{t('snapshot.asOf', { relativeTime: entryFreshness.relativeTime })}
											</span>
										</button>
									);
								})}
								<button type="button" className="sh-switcher-redeem" onClick={() => onRedeemAnother(undefined)}>
									{t('network.redeemAnotherCta')}
								</button>
							</div>
						) : null}
					</div>

					{freshness ? (
						<div className="sh-freshness" title={freshness.absolute}>
							{t('snapshot.asOf', { relativeTime: freshness.relativeTime })}
							{freshness.stale ? (
								<span className="sh-stale-banner">
									{t('snapshot.staleBanner', { threshold: formatStaleThreshold() })}
								</span>
							) : null}
						</div>
					) : null}

					<button type="button" className="sh-refresh-cta" onClick={() => onRedeemAnother(activeNetwork.networkHash)}>
						{t('snapshot.refreshCta')}
					</button>

					<PreviewAsControl /><AdvisoryDisclosure />
					<div className="sh-kebab">
						<button
							type="button"
							className="sh-kebab-button"
							aria-label={t('chrome.moreOptionsAriaLabel')}
							onClick={() => setKebabOpen((open) => !open)}
						>
							⋮
						</button>
						{kebabOpen ? (
							<div className="sh-kebab-menu" role="menu">
								<button type="button" className="sh-kebab-item--destructive" onClick={handleOpenForgetDialog}>
									{t('network.forgetCta')}
								</button>
							</div>
						) : null}
					</div>
				</div>
			</div>

			<div className="sh-body">
				<nav className="sh-sidebar">
					{PANEL_GROUPS.map((group) => (
						<div key={group.id} className="sh-sidebar-group">
							<div className="sh-sidebar-heading">{t(group.titleKey)}</div>
							{CAPABILITIES.filter((capability) => capability.group === group.id).map((capability) => (
								<a key={capability.id} className="sh-sidebar-row" href={`#panel-${capability.id}`}>
									{t(capability.titleKey)}
								</a>
							))}
						</div>
					))}
				</nav>

				<main>
					{/*
					 * THE BANNER IS THE DEFAULT FOR ANY ATTACH FAILURE, and the
					 * panel grid is reserved for a CLEAN attach. It used to be
					 * the other way round: only MissingRowCountsError and
					 * RowCountMismatchError got a banner, so every other failure
					 * -- InvalidRowCountRecordError from a corrupt record, a
					 * Quereus DDL reconcile error, a QuotaExceededError, a
					 * structured-clone failure, a plugin registration error --
					 * left `db` at null and fell through to render the grid,
					 * where every panel showed its own empty copy. An officer
					 * whose local store failed to open was told, in plain
					 * language, that their authority has no registrants. For
					 * election infrastructure that is the worst available
					 * confusion.
					 *
					 * The two integrity errors keep the verification wording;
					 * anything else gets its own, because "your data failed its
					 * checksum" is a wrong answer for a database that simply
					 * would not open.
					 */}
					{attachError ? (
						<div className="sh-error-banner">
							{attachError instanceof MissingRowCountsError || attachError instanceof RowCountMismatchError ? (
								<>
									<p>{t('snapshot.errorVerificationHeading')}</p>
									<p>{t('snapshot.errorVerificationBody')}</p>
								</>
							) : (
								<>
									<p>{t('snapshot.errorAttachHeading')}</p>
									<p>{t('snapshot.errorAttachBody')}</p>
								</>
							)}
							<button type="button" className="sh-refresh-cta" onClick={() => onRedeemAnother(activeNetwork.networkHash)}>
								{t('snapshot.refreshCta')}
							</button>
						</div>
					) : (
						<PanelGrid
							key={`${activeNetwork.networkHash}:${activeNetwork.officerUserId}:${activeNetwork.bootstrappedAt}`}
							db={db}
							revealDenied={revealDenied}
							onToggleReveal={() => setRevealDenied((value) => !value)}
							snapshotInstant={activeNetwork.bootstrappedAt}
						/>
					)}
				</main>
			</div>

			{/*
			 * Neither dialog renders an invented cancel/dismiss label
			 * (<the_copy_table_gaps> item 1 -- the frozen copy table has no
			 * such key). Dismissal is the platform's own: the Esc key fires
			 * the native `cancel` event on an open <dialog>, handled below by
			 * `onCancel`. The destructive control is disabled until the typed
			 * confirmation matches (forget) or is the dialog's only
			 * affirmative control (swap).
			 */}
			<dialog ref={forgetDialogRef} className="sh-dialog" onCancel={() => setForgetError(null)}>
				<h2>{t('network.forgetCta')}</h2>
				<p>{t('network.forgetConfirmBody', { authorityName: activeNetwork.authorityName })}</p>
				<label htmlFor="sh-forget-confirmation">{activeNetwork.authorityName}</label>
				<input
					id="sh-forget-confirmation"
					className="sh-dialog-input"
					type="text"
					value={forgetConfirmationInput}
					onChange={(event) => setForgetConfirmationInput(event.target.value)}
				/>
				{forgetError ? <p className="sh-dialog-error">{(forgetError as { name?: string })?.name ?? 'error'}</p> : null}
				<div className="sh-dialog-actions">
					<button
						type="button"
						className="sh-dialog-cta--destructive"
						disabled={forgetConfirmDisabled}
						onClick={handleConfirmForget}
					>
						{t('network.forgetCta')}
					</button>
				</div>
			</dialog>

			<dialog ref={swapDialogRef} className="sh-dialog" onCancel={handleCancelSwap}>
				<h2>{t('network.swapConfirmHeading')}</h2>
				<p>{t('network.swapConfirmBody', { authorityName: pendingSwap?.authorityName ?? '' })}</p>
				{swapError ? <p className="sh-dialog-error">{(swapError as { name?: string })?.name ?? 'error'}</p> : null}
				<div className="sh-dialog-actions">
					<button type="button" className="sh-dialog-cta--primary" onClick={handleConfirmSwap}>
						{t('network.swapConfirmCta')}
					</button>
				</div>
			</dialog>

			{toast ? (
				<div className="sh-toast">
					<span>{toast}</span>
				</div>
			) : null}
		</div>
		</PreviewAsProvider>
	);
}

export default DashboardShell;
