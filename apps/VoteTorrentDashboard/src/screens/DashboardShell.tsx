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
 * THE OFFICER-SWAP DIALOG'S REACHABILITY (50-18 closed this; history kept
 * for the next reader). Through 50-17, this file built the full officer-swap
 * confirm dialog and its confirmed path, and `pendingSwap` was the seam a
 * caller populated to raise it -- but nothing populated it: `Bootstrap.tsx`
 * exposed no completion callback and no injectable transport, so a code for
 * an ALREADY-HELD network could only ever resolve as `already-bootstrapped`,
 * burning the single-use code without ever surfacing the verified envelope
 * this dialog needs to classify. 50-18 gave `Bootstrap.tsx` an
 * `onAlreadyBootstrapped` seam carrying the SAME single-flight transport
 * whose cache already holds that envelope; `main.tsx` forwards it here as
 * `pendingSwapContext`, and the effect below replays the transport (no
 * second redemption -- the single-use code is spent exactly once),
 * classifies it, and populates `pendingSwap` for `officer-swap`, silently
 * performs a `same-officer-refresh` (no confirmation needed to replace an
 * officer's own data with their own newer copy), and fails closed --
 * WITHOUT deleting anything -- for `officer-indeterminate` or the
 * structurally-unreachable `new-network`.
 */
import { useEffect, useRef, useState } from 'react';
import type { Database } from '@quereus/quereus';
import { t } from '@votetorrent/ui-web';
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
import { classifyRedemption, performOfficerSwap, OfficerIndeterminateError } from '../lifecycle/officer-swap.js';
import type { SingleFlightTransport } from '../lifecycle/officer-swap.js';
import { splitSignInCode, redeemSignInCode } from '../transport/bootstrap-transport-client.js';
import type { AlreadyBootstrappedContext } from './Bootstrap.js';
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
	/** The officer-swap context `main.tsx` hands over the moment `Bootstrap`'s
	 * `onAlreadyBootstrapped` fires -- `null` when no swap is pending. This
	 * shell replays the carried single-flight transport, classifies the
	 * result, and either raises the confirm dialog (`officer-swap`), performs
	 * a silent same-officer refresh, or fails closed (`officer-indeterminate`
	 * / the structurally-unreachable `new-network`). */
	pendingSwapContext?: AlreadyBootstrappedContext | null;
	/** Called once `pendingSwapContext` has been classified (regardless of
	 * outcome), so the caller can clear it and avoid reprocessing the same
	 * context on a later render. */
	onSwapContextConsumed?: () => void;
}

/**
 * MODULE-LEVEL (survives across DashboardShell mounts, unlike component
 * state or a ref): a strict FIFO chain of every open/close operation against
 * a given networkHash's IndexedDB database, so any number of overlapping
 * DashboardShell instances (including React StrictMode's deliberate
 * double-invocation of effects, which this project runs everywhere -- see
 * `main.tsx`) can never race each other's opens and closes against the same
 * underlying database.
 *
 * WHY THIS EXISTS (found by 50-18's compose-swap browser leg, not assumed):
 * `main.tsx` unmounts DashboardShell entirely while `Bootstrap` is shown, and
 * both an explicit snapshot-refresh round trip AND a confirmed D-14 swap's
 * cancel-then-retry round trip take EXACTLY that path -- shell unmounts,
 * Bootstrap mounts, Bootstrap's `onAlreadyBootstrapped` fires, shell
 * remounts, all for the SAME networkHash. The unmount-only cleanup below
 * fires `closeNetworkDb` but cannot block React's commit to wait for it, so
 * a fast round trip can open a BRAND NEW handle to the same IndexedDB
 * database while a prior instance's close (or, under StrictMode, more than
 * one prior instance's) is still in flight. A single "last close" slot was
 * tried first and was NOT sufficient -- StrictMode's double mount/unmount of
 * BOTH the outgoing and incoming instances can leave more than one close
 * outstanding at once, and a single slot only ever waits for the latest one.
 * Observed failure mode either way: `createIndex ... One of the specified
 * object stores was not found` -- connections racing the same database's
 * schema reconcile. Every open and close for a given hash is now queued onto
 * the SAME chain, so they always run one at a time, in the order requested.
 *
 * FOUR OPERATION FAMILIES SHARE THIS ONE QUEUE (CR-04, 50-22): attach
 * (`attachNetworkDb`), close (`closeNetworkDb`), forget (`forgetNetwork` --
 * delete-and-remove), and swap/refresh (`performOfficerSwap` -- delete then
 * recreate, from both `handleConfirmSwap` and the classify effect's
 * same-officer-refresh branch). Forget and swap/refresh are the two most
 * destructive operations the app performs against a given `networkHash`, and
 * before this they ran OUTSIDE the queue entirely -- able to race an attach or
 * close from another (real or StrictMode-phantom) `DashboardShell` instance
 * for the SAME hash. `compose-gate.tsx`'s compose-swap browser leg reproduced
 * this as a roughly-1-in-3 `MisuseError` and was "fixed" by removing
 * `StrictMode` from that one mount -- A HARNESS CHANGE IS NOT AN ACCEPTABLE
 * SUBSTITUTE for closing this coverage gap in the product itself.
 */
const dbLifecycleChains = new Map<string, Promise<unknown>>();

/**
 * Queue `task` onto networkHash `hash`'s FIFO chain -- it will not start
 * until every previously-queued open/close for that SAME hash has settled,
 * regardless of how many DashboardShell instances (real or StrictMode
 * phantom) queued them. A prior task's rejection is swallowed before
 * chaining (never awaited by the caller here) so one failed close/open can
 * never permanently wedge the queue for that network.
 *
 * @template T
 * @param {string} hash
 * @param {() => Promise<T>} task
 * @returns {Promise<T>}
 */
function withNetworkDbLifecycleLock<T>(hash: string, task: () => Promise<T>): Promise<T> {
	const prior = dbLifecycleChains.get(hash) ?? Promise.resolve();
	const next = prior.catch(() => undefined).then(task);
	dbLifecycleChains.set(hash, next);
	return next;
}

interface PendingSwap {
	networkHash: string;
	pastedCode: string;
	transport: SingleFlightTransport;
	incomingOfficerUserId: string;
	authorityName: string;
}

export function DashboardShell({
	onRedeemAnother,
	pendingSwapContext = null,
	onSwapContextConsumed,
}: DashboardShellProps) {
	const [networks, setNetworks] = useState<NetworkRegistryEntry[]>(() => listNetworks());
	const [activeNetworkHash, setActiveNetworkHash] = useState<string | undefined>(() => networks[0]?.networkHash);
	const activeNetwork = networks.find((entry) => entry.networkHash === activeNetworkHash);

	const [db, setDb] = useState<Database | null>(null);
	const [grantedScopes, setGrantedScopes] = useState<ScopeCode[]>([]);
	// Gates the "Preview as" control's nine checkboxes and Reset button --
	// true only once grantedScopes has resolved at least once for the
	// active network (D-18); re-closed on every re-attach.
	const [scopesResolved, setScopesResolved] = useState(false);
	const [attachError, setAttachError] = useState<unknown>(null);
	const dbRef = useRef<Database | null>(null);
	// The networkHash the CURRENT dbRef.current handle actually belongs to --
	// tracked separately from `activeNetwork` because the unmount cleanup
	// below runs after this component's own state/props are gone, and needs
	// to know which entry in `closingHandlesByNetwork` to register.
	const dbNetworkHashRef = useRef<string | undefined>(undefined);

	const [revealDenied, setRevealDenied] = useState(false);
	const [switcherOpen, setSwitcherOpen] = useState(false);
	const [kebabOpen, setKebabOpen] = useState(false);
	const [toast, setToast] = useState<string | null>(null);

	const [forgetConfirmationInput, setForgetConfirmationInput] = useState('');
	const [forgetError, setForgetError] = useState<unknown>(null);
	const forgetDialogRef = useRef<HTMLDialogElement | null>(null);
	// The forget path's twin of `swapAttemptedRef` below (WR-10): same defect,
	// same ref-plus-state shape, DIFFERENT lifetime. Two clicks inside the
	// `await` window queued two `forgetNetwork` calls on the lock; the second
	// ran after the registry entry was already gone, threw `UnknownNetworkError`
	// and set `forgetError` on a dialog the first invocation had already closed
	// -- an error state the officer can never see, on a destructive action.
	//
	// Cleared in a `finally`, unlike the swap's, and that difference is
	// deliberate: a failed forget burns nothing (no single-use code is spent,
	// the network stays listed and the dialog stays open), so a retry is a
	// legitimate affordance here and must remain available.
	const forgettingRef = useRef(false);
	const [forgetting, setForgetting] = useState(false);

	const [pendingSwap, setPendingSwap] = useState<PendingSwap | null>(null);
	const [swapError, setSwapError] = useState<unknown>(null);
	const swapDialogRef = useRef<HTMLDialogElement | null>(null);
	// ONE CONFIRMED ATTEMPT PER RAISED DIALOG, EVER (CR-02). The confirm CTA
	// spends a SINGLE-USE code, and `performOfficerSwap` empties the
	// single-flight cache in a `finally` that runs on success AND on failure
	// (`officer-swap.js`) -- so the SECOND press of that button reaches
	// `redeemAndBootstrap` with a cold cache, falls through to the real wire,
	// and the backend answers `used`. The officer's code is burned.
	//
	// TWO STATES, DELIBERATELY, BECAUSE THEY GUARD DIFFERENT THINGS:
	//   - the REF is the correctness guard. A double-click dispatches both
	//     clicks from the same task; a `useState` flag cannot help, because
	//     the second handler closure was created by a render in which the
	//     flag was still false. Only a ref is already true by then.
	//   - the STATE is the affordance. It disables the CTA so the officer is
	//     not shown a control that does nothing (in-flight) or that would
	//     spend a spent code (after a terminal failure).
	//
	// IT IS NOT CLEARED ON FAILURE, AND THAT IS THE POINT. The failure this
	// file anticipates is `DeleteBlockedError`, a transient timeout -- so the
	// dialog deliberately stays open with the error rendered, which used to
	// invite a retry that COULD NOT SUCCEED: the cache was already gone, so
	// the retry hit the wire and burned the code for nothing. Round 3 named
	// the choice explicitly: either the cache survives a failure, or no retry
	// is offered. `performOfficerSwap`'s unconditional reset is a security
	// property of that module (a redeemable whole-database snapshot must not
	// outlive an attempt), so this is the other half: after one attempt the
	// CTA stays disabled, and the officer's route forward is a NEW code.
	// Cleared only where a genuinely fresh attempt begins -- a new
	// `pendingSwap`, or a cancel.
	const swapAttemptedRef = useRef(false);
	const [swapAttempted, setSwapAttempted] = useState(false);

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
		setScopesResolved(false);
		setAttachError(null);
		// `swapError` GETS THE SAME RESET DISCIPLINE AS `attachError`, and for
		// the same reason: the branch in the main region below renders a banner
		// INSTEAD of `PanelGrid` whenever `swapError && !pendingSwap`, so a
		// stale value does not merely add a message -- it decides whether the
		// officer sees any panels at all. Every path that sets `swapError`
		// (the fail-closed replay, `officer-indeterminate`, `new-network`, the
		// classify `catch`, and a failed `same-officer-refresh`) does so with
		// NO dialog open, so `handleCancelSwap` -- reachable only from the swap
		// dialog's own `onCancel` -- could never clear any of them. A
		// classification failure on network A therefore latched, survived a
		// switcher click, and rendered A's failure over network B's nine
		// healthy panels: the phase's headline symptom (zero panels for a
		// fully-privileged officer) arriving from an entirely different
		// network's error. This effect re-runs on exactly the transitions that
		// should clear it -- a switch to another network, and a swap that
		// actually landed (both change the dependency list below).
		setSwapError(null);

		async function attach() {
			if (dbRef.current && dbNetworkHashRef.current) {
				const priorHandle = dbRef.current;
				const priorHash = dbNetworkHashRef.current;
				dbRef.current = null;
				dbNetworkHashRef.current = undefined;
				await withNetworkDbLifecycleLock(priorHash, () => closeNetworkDb(priorHandle));
			}
			if (!activeNetwork) return;
			if (cancelled) return;
			try {
				// Queued onto the SAME per-network lock a close registers --
				// this open cannot start until every previously-queued
				// open/close for this hash (including one a just-unmounted
				// sibling instance registered) has settled. See
				// `withNetworkDbLifecycleLock`'s module-level doc comment.
				const handle = await withNetworkDbLifecycleLock(activeNetwork.networkHash, () =>
					attachNetworkDb(activeNetwork.networkHash),
				);
				if (cancelled) {
					await withNetworkDbLifecycleLock(activeNetwork.networkHash, () => closeNetworkDb(handle));
					return;
				}
				dbRef.current = handle;
				dbNetworkHashRef.current = activeNetwork.networkHash;
				const scopes = await readGrantedScopes(handle, activeNetwork.officerUserId);
				if (cancelled) return;
				setDb(handle);
				setGrantedScopes(scopes);
				setScopesResolved(true);
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
	// Queues the close onto the SAME per-network FIFO lock the attach effect
	// uses, so a fast remount for the SAME network (an explicit refresh, or a
	// swap's Bootstrap<->shell round trip -- and React StrictMode's own
	// deliberate double-invocation of every effect) can never open a new
	// handle before this close has actually run. See
	// `withNetworkDbLifecycleLock`'s module-level doc comment.
	useEffect(
		() => () => {
			if (dbRef.current && dbNetworkHashRef.current) {
				const handle = dbRef.current;
				const hash = dbNetworkHashRef.current;
				dbRef.current = null;
				dbNetworkHashRef.current = undefined;
				void withNetworkDbLifecycleLock(hash, () => closeNetworkDb(handle));
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
		// The ref, not the state, is what makes this re-entrancy-safe -- a
		// double-click dispatches both clicks from the same task, before any
		// re-render could have disabled the control. See `forgettingRef`'s
		// declaration above (WR-10).
		if (!activeNetwork || forgettingRef.current) return;
		forgettingRef.current = true;
		setForgetting(true);
		try {
			// Queued onto the SAME per-network lock attach/close/swap already
			// share -- see `withNetworkDbLifecycleLock`'s module-level doc
			// comment (CR-04).
			const result = await withNetworkDbLifecycleLock(activeNetwork.networkHash, () =>
				forgetNetwork({
					networkHash: activeNetwork.networkHash,
					typedConfirmation: forgetConfirmationInput,
					db: dbRef.current ?? undefined,
				}),
			);
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
		} finally {
			// Released on BOTH outcomes -- a failed forget is retryable (see the
			// declaration note), so the officer must get the control back.
			forgettingRef.current = false;
			setForgetting(false);
		}
	}

	async function handleConfirmSwap() {
		// The ref, not the state, is what makes this re-entrancy-safe -- see
		// `swapAttemptedRef`'s declaration above. Read and set BEFORE the first
		// `await`, so a second click dispatched from the same task cannot get
		// past it.
		if (!pendingSwap || swapAttemptedRef.current) return;
		swapAttemptedRef.current = true;
		setSwapAttempted(true);
		// Captured into a local BEFORE the awaits below -- `pendingSwap` is
		// component state and this async function keeps running after a
		// re-render could have changed or cleared it, but the handed-off
		// single-flight cache must still be reset on every terminal path.
		const swapTransport = pendingSwap.transport;
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
			// Queued onto the SAME per-network lock attach/close/forget already
			// share -- see `withNetworkDbLifecycleLock`'s module-level doc
			// comment (CR-04).
			const result = await withNetworkDbLifecycleLock(pendingSwap.networkHash, () =>
				performOfficerSwap({
					networkHash: pendingSwap.networkHash,
					pastedCode: pendingSwap.pastedCode,
					transport: pendingSwap.transport,
					db: handoverDb,
				}),
			);
			if (result.outcome !== 'ok') {
				setSwapError(result);
				swapTransport.reset();
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
			// A swap that SUCCEEDED after an earlier failure must not show the
			// success toast and the failure banner at the same time. The attach
			// effect above also clears it (this `setNetworks` advances
			// `bootstrappedAt`, which it keys on), but a success path that
			// depends on a sibling effect's dependency list to un-say a failure
			// is exactly the kind of implicit ownership this file has been bitten
			// by; say it here, where the success is known.
			setSwapError(null);
			setToast(t('snapshot.verifiedToast'));
			swapTransport.reset();
		} catch (err) {
			setSwapError(err);
			swapTransport.reset();
		}
	}

	function handleCancelSwap() {
		pendingSwap?.transport.reset();
		setPendingSwap(null);
		setSwapError(null);
		// A cancel ends this attempt entirely (the cache is reset above), so
		// the next raised dialog starts from a clean guard.
		swapAttemptedRef.current = false;
		setSwapAttempted(false);
		swapDialogRef.current?.close();
	}

	useEffect(() => {
		if (pendingSwap) {
			swapDialogRef.current?.showModal();
		}
	}, [pendingSwap]);

	// Classify an incoming `pendingSwapContext` the moment `main.tsx` hands one
	// over -- replaying the SAME single-flight transport (no second
	// redemption: the single-use code is spent exactly once across
	// classify-then-confirm) and routing per `classifyRedemption`'s four-row
	// table. `officer-swap` raises the existing confirm dialog;
	// `same-officer-refresh` needs no confirmation -- the officer is
	// replacing their own data with their own newer copy -- and runs
	// immediately; `officer-indeterminate` and the structurally-unreachable
	// `new-network` fail closed WITHOUT ever calling `performOfficerSwap`, so
	// nothing is deleted on either path. That table describes the four
	// SUCCESSFUL classification outcomes, not the whole space: ANY rejection
	// along the way -- a malformed code, a transport failure, a refused
	// replay, or a throw from `performOfficerSwap` on the same-officer-refresh
	// branch (reached AFTER `dbRef.current` has already been relinquished) --
	// is caught below and surfaced as its own banner (CR-03), never left to
	// escape as an unhandled promise rejection.
	useEffect(() => {
		if (!pendingSwapContext) return undefined;
		// Captured into a local so TS's null-narrowing survives the closure
		// below -- `pendingSwapContext` itself is a prop and TS cannot prove a
		// re-render won't null it out between now and when `classify` runs.
		const swapContext = pendingSwapContext;
		let cancelled = false;

		// OWNERSHIP OF THE HANDED-OFF SINGLE-FLIGHT CACHE: it holds a
		// redeemable whole-database snapshot, `Bootstrap` deliberately does
		// NOT reset it once handed off (D-14), and this component resets it
		// on every terminal path below EXCEPT `officer-swap`, which is still
		// waiting for the officer to confirm.
		async function classify() {
			try {
				const { secret } = splitSignInCode(swapContext.pastedCode);
				// Routed through `redeemSignInCode` rather than calling
				// `transport.redeem` directly: the transport now returns a SEALED
				// payload (D-06), and `redeemSignInCode` is the one shared place
				// that opens one. Calling the transport directly here would need a
				// second unseal site, and a second definition of what "opened
				// correctly" means. The catch below already covers its refusal.
				const redemption = await redeemSignInCode(swapContext.transport, secret);
				if (redemption.status !== 'ok' || !redemption.snapshot) {
					// `createSingleFlightTransport` caches ONLY an `ok` result --
					// reaching here would mean the cache was cleared between
					// `Bootstrap.tsx` handing this context over and this effect
					// running. Fail closed rather than guess why.
					if (!cancelled) {
						setSwapError(new Error('pendingSwapContext: replay did not return a cached ok redemption'));
					}
					swapContext.transport.reset();
					return;
				}
				const envelope = redemption.snapshot;
				const classification = classifyRedemption({ envelope });
				if (cancelled) return;

				switch (classification.kind) {
					case 'officer-swap':
						// A PRIOR attempt's error renders inside this very dialog
						// (`sh-dialog-error` below), and nothing else clears it when a
						// FRESH `pendingSwap` is raised -- an officer would be shown
						// the previous failure's error class in the dialog they are
						// being asked to confirm. Cleared here, on the one transition
						// the attach effect above cannot see (no registry field
						// changes when a dialog merely opens).
						setSwapError(null);
						// A FRESH classification is a fresh attempt on a fresh,
						// unspent code -- re-arm the one-attempt guard (CR-02) here,
						// the same transition that clears the stale error above.
						swapAttemptedRef.current = false;
						setSwapAttempted(false);
						setPendingSwap({
							networkHash: classification.networkHash,
							pastedCode: swapContext.pastedCode,
							transport: swapContext.transport,
							incomingOfficerUserId: classification.incomingOfficerUserId ?? '',
							authorityName: classification.authorityName,
						});
						break;
					case 'same-officer-refresh': {
						// HAND THE HANDLE OVER BEFORE THE SWAP, same reason as
						// handleConfirmSwap: an open connection blocks
						// indexedDB.deleteDatabase.
						const handoverDb = dbRef.current ?? undefined;
						dbRef.current = null;
						setDb(null);
						// Queued onto the SAME per-network lock attach/close/forget
						// already share -- see `withNetworkDbLifecycleLock`'s
						// module-level doc comment (CR-04).
						const result = await withNetworkDbLifecycleLock(classification.networkHash, () =>
							performOfficerSwap({
								networkHash: classification.networkHash,
								pastedCode: swapContext.pastedCode,
								transport: swapContext.transport,
								db: handoverDb,
							}),
						);
						if (cancelled) return;
						if (result.outcome !== 'ok') {
							// eslint-disable-next-line no-console
							console.error('performOfficerSwap (same-officer-refresh) did not complete:', result.outcome);
							setSwapError(result);
							swapContext.transport.reset();
							break;
						}
						// Same single owner of the transition as the confirmed-swap
						// path: refreshing `networks` advances bootstrappedAt, and
						// the attach effect above (keyed on it) tears down and
						// re-attaches on its own.
						setNetworks(listNetworks());
						// Same reason as the confirmed-swap success path below: a
						// refresh that succeeded must not leave a prior failure's
						// banner standing over the data it just replaced.
						setSwapError(null);
						setToast(t('snapshot.verifiedToast'));
						swapContext.transport.reset();
						break;
					}
					case 'officer-indeterminate': {
						// Fails closed -- performOfficerSwap is never called, so
						// nothing is deleted for an envelope this shell cannot
						// attribute to a single officer.
						const err = new OfficerIndeterminateError(classification.networkHash);
						// eslint-disable-next-line no-console
						console.error('pendingSwapContext classified as officer-indeterminate:', err.name);
						setSwapError(err);
						swapContext.transport.reset();
						break;
					}
					case 'new-network': {
						// Structurally unreachable from this seam:
						// `pendingSwapContext` only ever arrives via
						// `already-bootstrapped`, which by definition means the
						// registry already holds this hash. Fail loudly rather than
						// silently falling through.
						const err = new Error(
							`pendingSwapContext: unexpected 'new-network' classification for held network "${classification.networkHash}"`,
						);
						// eslint-disable-next-line no-console
						console.error(err.name);
						setSwapError(err);
						swapContext.transport.reset();
						break;
					}
					default:
						break;
				}
			} catch (err) {
				// A rejection anywhere in the try above -- a malformed code
				// from splitSignInCode, a transport failure, a refused replay,
				// or a throw from performOfficerSwap on the
				// same-officer-refresh branch -- lands here instead of
				// escaping unhandled. See the main region below: a swapError
				// set with no pendingSwap open renders its own banner instead
				// of letting PanelGrid stand in for a database failure.
				if (!cancelled) setSwapError(err);
				swapContext.transport.reset();
			} finally {
				if (!cancelled) onSwapContextConsumed?.();
			}
		}

		void classify();

		return () => {
			cancelled = true;
		};
	}, [pendingSwapContext, onSwapContextConsumed]);

	if (!activeNetwork) {
		return null;
	}

	// An EMPTY expected name leaves nothing to confirm against, so the
	// destructive control stays disabled rather than being enabled on open by
	// an untouched input. `forgetNetwork` refuses the same case independently;
	// this is the affordance, that is the guarantee.
	const forgetExpectedName = activeNetwork.authorityName.trim();
	const forgetConfirmDisabled =
		forgetting || forgetExpectedName.length === 0 || forgetConfirmationInput.trim() !== forgetExpectedName;

	return (
		<PreviewAsProvider realScopes={grantedScopes} scopesResolved={scopesResolved}>
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
					) : swapError && !pendingSwap ? (
						/*
						 * A CLASSIFICATION failure must never be represented by
						 * nine panels each quietly showing their own empty copy
						 * -- the same reasoning as the attach banner above, for
						 * a different failure surface. This branch renders ONLY
						 * when no swap dialog is open: a confirmed-swap failure
						 * belongs in the dialog the officer is already looking
						 * at, and continues to render there unchanged.
						 */
						<div className="sh-error-banner">
							<p>{t('network.swapErrorHeading')}</p>
							<p>{t('network.swapErrorBody')}</p>
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
					<button
						type="button"
						className="sh-dialog-cta--primary"
						disabled={swapAttempted}
						onClick={handleConfirmSwap}
					>
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
