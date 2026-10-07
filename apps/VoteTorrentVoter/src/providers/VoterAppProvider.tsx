/**
 * VoterAppProvider — the app-wide composition root (Phase 44-07, D-02/D-04/D-07).
 *
 * Rewritten from the Phase-39/40/42 mock provider into a REAL composition root mirroring the
 * authority app's `AppProvider` (44-PATTERNS.md "Composition-root useRef-stable factory +
 * isInitialized gate"): one `EngineFactory` via `useRef` (never recreated), `useCadreNode()`
 * wired via `setNode`/`setGetPeerCount`, `selectNetwork` for runtime network switching, and the
 * `initError`/"Try Again"/"Start Fresh" recovery UI.
 *
 * D-07: in `__DEV__` the boot effect AWAITS `seedDevNetwork(...)` BEFORE opening the network (so
 * the seeded network exists when the voter reads it — never fire-and-forget), then captures the
 * seed's returned `electionId` onto context as `seededElectionId` — the registration seam
 * (`ConfirmationScreen`) reads it as `RegisterInit.electionId`.
 *
 * `getElection`/`getBallot` are REAL engine reads (`engines/election-read.ts`) against the same
 * election every other tab resolves (`pickElectionId`, falling back to the `__DEV__` seeded
 * election). `lifecycleOverride` is the `__DEV__`-only design-review cycler: it forces a card
 * state and overlays that state's `DEV_LIFECYCLE_CONTENT`, and is inert in a release build. The
 * `isRegistered`/`registeredAt`/`hasVoted` mock booleans are REMOVED — the real registration flow
 * (real `Registrant` rows via `RegistrationEngine`) replaces them (D-02).
 *
 * 51-12 (D-09/D-20): does NOT capture `seedDevNetwork`'s `sign` (the founding-officer device
 * signer) onto context — `ConfirmationScreen.tsx` was rewritten by 51-11 to never destructure
 * `useVoterApp().sign`, so exposing it here is dead plumbing that only offers a future
 * contributor a convenient, officer-capable signer to wire back into a reintroduced admin-signed
 * ceremony (T-51-12-02).
 *
 * MUST have a `CadreNodeProvider` ancestor (mounted in `App.tsx`) — `useCadreNode()` throws
 * otherwise, mirroring the authority app's requirement.
 */
import React, {createContext, useCallback, useContext, useEffect, useRef, useState} from 'react';
import type {PropsWithChildren} from 'react';
import {ActivityIndicator, Text, TouchableOpacity, View} from 'react-native';
import {useTranslation} from 'react-i18next';
import {hideSplash} from 'react-native-splash-view';
import type {IDefaultUserEngine, NetworkReference} from '@votetorrent/vote-core';
import {EngineFactory} from '../engines/engine-factory';
import {LocalStorageReact} from '@votetorrent/vote-engine/rn';
import {rnDbFactory} from '../engines/rn-db-factory';
import {
	getOrCreateDeviceUser,
	migrateLegacyPlaintextIdentityKey,
	replaceUnrecoverableDeviceIdentity,
} from '../engines/device-user';
import {isIdentityNotReplaceable, isReplaceableIdentityError} from '../engines/identity-errors';
import {errorClassName} from '../utils/errorClassName';
import {IdentityRecoveryView} from '../components/IdentityRecoveryView';
import {seedDevNetwork} from '../engines/dev-seed';
import {useCadreNode} from './CadreNodeProvider';
import {readVoterBallot, readVoterElection} from '../engines/election-read';
import type {LifecycleState, VoterBallot, VoterElection, VoterAppContextType} from './types';
import {DEV_LIFECYCLE_CONTENT} from './devLifecycleFixtures';

const VoterAppContext = createContext<VoterAppContextType | null>(null);

export function useVoterApp(): VoterAppContextType {
	const context = useContext(VoterAppContext);
	if (!context) {
		throw new Error('useVoterApp must be used within a VoterAppProvider');
	}
	return context;
}

export function VoterAppProvider({children}: PropsWithChildren) {
	// 'common' namespace (D-11 feature-namespaced resource tree) — syncSyncing lives
	// there alongside the app's other cross-screen shell copy.
	const {t} = useTranslation('common');
	const [isInitialized, setIsInitialized] = useState(false);
	const [hasNetwork, setHasNetwork] = useState(false);
	// The caught boot error, kept as an object so the render can classify it. It is NEVER
	// rendered as text (translated copy only); console output carries the class name only.
	const [initError, setInitError] = useState<{error: unknown} | null>(null);
	// CR-02 parity: bump this to re-run the init effect ("Try Again"). The init effect's dep
	// array includes initNonce; setIsInitialized(false) alone cannot re-fire it.
	const [initNonce, setInitNonce] = useState(0);
	// Quick task 260928-kkf ("Syncing + escape button", locked decision, mirrors the
	// authority app's AppProvider): flips true once the CURRENT boot's first-sync wait
	// has rejected once with StrandAwaitingFirstSyncError (~300s budget elapsed) — the
	// signal that gates the Start Fresh escape under the Syncing label. Reset to false
	// at the start of every non-cancelled init run (see the [initNonce, node] effect).
	const [firstSyncBudgetElapsed, setFirstSyncBudgetElapsed] = useState(false);
	// The currently-running init effect's own cancellation flag, published here so the
	// escape's onPress can mark a superseded run BEFORE calling startFresh().
	const cancelInitRunRef = useRef<(() => void) | undefined>(undefined);

	// D-07: the dev-seeded election id, captured from seedDevNetwork's return once the boot
	// effect resolves. Only populated in __DEV__ (undefined otherwise). 51-12 (D-09/D-20): does
	// NOT also capture seedDevNetwork's `sign` (the founding-officer device signer) — see the
	// module doc comment above.
	const [seededElectionId, setSeededElectionId] = useState<string | undefined>(undefined);

	// D-03: the __DEV__ cycler's forced card state. null = live (derived from the timeline). The
	// setter ignores writes outside __DEV__, so a release build can never leave live mode.
	const [lifecycleOverride, setLifecycleOverrideState] = useState<LifecycleState | null>(null);
	const setLifecycleOverride = useCallback((state: LifecycleState | null) => {
		if (__DEV__) {
			setLifecycleOverrideState(state);
		}
	}, []);

	// D-02: the one shared __DEV__ clock (Timeline, Home and the vote window gate all read it).
	// The setter is inert outside __DEV__ and ignores non-finite input; nowMs() re-checks __DEV__
	// as defence in depth, so a release build always reads the real clock.
	const [clockOffsetMs, setClockOffsetMsState] = useState(0);
	const setClockOffsetMs = useCallback((ms: number) => {
		if (__DEV__ && Number.isFinite(ms)) {
			setClockOffsetMsState(ms);
		}
	}, []);
	const nowMs = useCallback(() => Date.now() + (__DEV__ ? clockOffsetMs : 0), [clockOffsetMs]);

	// D-02/D-04: one app-lifetime EngineFactory via useRef (constructed once, stable across
	// renders) — mirrors the authority app's AppProvider (44-PATTERNS.md).
	const engineFactoryRef = useRef<EngineFactory | null>(null);
	if (!engineFactoryRef.current) {
		engineFactoryRef.current = new EngineFactory(new LocalStorageReact(), rnDbFactory);
	}

	// Collapse to factory delegation — empty dep array, factory is stable via useRef.
	const getEngine = useCallback(async <T,>(engineName: string, initParams?: unknown): Promise<T> => {
		return engineFactoryRef.current!.getEngine<T>(engineName, initParams);
	}, []);

	const hasEngine = useCallback((engineName: string) => {
		return engineFactoryRef.current?.hasEngine(engineName) ?? false;
	}, []);

	// Activate a network at runtime (picker "Select") without a reboot. Mirrors the boot
	// re-attach block below so behavior is identical to a restart.
	const selectNetwork = useCallback(async (networkRef: NetworkReference) => {
		const factory = engineFactoryRef.current!;
		const defaultUserEng = await factory.getEngine<IDefaultUserEngine>('defaultUser');
		const defaultUser = await defaultUserEng.get();
		const user = await getOrCreateDeviceUser(defaultUser?.name ?? 'Device User');
		factory.setCurrentUser(user);
		await factory.getNetworksEngine().open(networkRef, user);
		await factory.getEngine('network', networkRef);
		setHasNetwork(true);
	}, []);

	// D-04/D-05: register the CadreNode live peer-count source + booted node with the factory,
	// mirroring the authority app's AppProvider. connectedPeers is keyed by strandId
	// (== networkHash); node is null until CadreNode boots (rnDbFactory stays active until then,
	// solo-safe — P2P-11 stays paused this phase).
	const {connectedPeers, node, syncState} = useCadreNode();
	useEffect(() => {
		engineFactoryRef.current?.setGetPeerCount(connectedPeers);
		engineFactoryRef.current?.setNode(node);
	}, [connectedPeers, node]);

	// Quick task 260928-kkf: register the "first wait budget elapsed" listener for the
	// lifetime of this provider (not just the current init run) — mirrors the authority
	// app's AppProvider. Deregistered on unmount.
	useEffect(() => {
		engineFactoryRef.current?.setFirstSyncListener(() => setFirstSyncBudgetElapsed(true));
		return () => engineFactoryRef.current?.setFirstSyncListener(undefined);
	}, []);

	// Quick task 260928-kkf: hide the splash the moment there is something to show under
	// it — either the early 'syncing' signal or the later "budget elapsed" signal — even
	// though isInitialized is still false and the init effect has not resolved.
	useEffect(() => {
		if (!isInitialized && (syncState === 'syncing' || firstSyncBudgetElapsed)) {
			hideSplash();
		}
	}, [isInitialized, syncState, firstSyncBudgetElapsed]);

	// D-42 (Phase 62 plan 08): the one-shot startup sweep of a legacy plaintext
	// `votingDeviceUser` record (pre-D-42) into the wrapped-at-rest shape. Mirrors the
	// authority app's AppProvider staged-sign-in-code sweep (purgeLegacyStagedPayload):
	// an empty-dependency effect, once, on mount, logging only the closed outcome
	// token — never a record field, never a byte of the key. UI-SPEC Surface 10: zero
	// UI, no state, no splash interaction, no i18n key. Deliberately declared BEFORE
	// the `[initNonce, node]` init effect below, so a legacy key is migrated before
	// anything else in this provider touches `votingDeviceUser`.
	useEffect(() => {
		void migrateLegacyPlaintextIdentityKey().then(outcome => {
			if (outcome === 'migrated') {
				// Device-proof logcat marker (62-30 collects this).
				console.log('VoterAppProvider: identity-key migration outcome: migrated');
			} else if (outcome === 'unreadable' || outcome === 'wrap-unavailable' || outcome === 'read-back-failed') {
				console.warn(`VoterAppProvider: identity-key migration outcome: ${outcome}`);
			}
			// 'absent' and 'already-wrapped' are silent — the overwhelmingly common case.
		});
	}, []);

	// WR-03 (see createNewIdentity below): true from a successful identity replacement until the
	// next boot that succeeds, or until the whole createNewIdentity sequence succeeds. Declared
	// before the init effect, which clears it on every successful boot.
	const replacedThisSessionRef = useRef(false);

	useEffect(() => {
		// Quick task 260928-kkf (mirrors authority AppProvider): a cancelled run has been
		// SUPERSEDED — by unmount, a node change re-running this effect, or the escape
		// action explicitly abandoning the wait — so its state writes must never reach
		// the component after that point. This does NOT stop the background strand wait
		// itself (only cancelPendingStrandWaits does that, in the cleanup below); it
		// stops THIS run's reaction to it.
		let cancelled = false;
		cancelInitRunRef.current = () => {
			cancelled = true;
		};

		async function initialize() {
			// Set when this run surfaces a boot error; a run that ends without one is a successful
			// boot and clears replacedThisSessionRef (62-REVIEW WR-03).
			let bootFailed = false;
			try {
				const factory = engineFactoryRef.current!;

				// RE-ATTACH FIX (mirrors authority AppProvider): synchronise the current
				// CadreNode state into the factory before any DbFactory call — the lazy-dispatch
				// DbFactory selects strand vs solo based on factory.node AT CALL TIME.
				factory.setNode(node);

				const networksEng = factory.getNetworksEngine();

				if (__DEV__) {
					// D-07: AWAIT seedDevNetwork BEFORE opening the network (never
					// fire-and-forget) — creates (or re-attaches to) the dev-seeded network +
					// founding-officer authority + election + field-registration policy, and
					// resolves the SAME device signer used both as founding officer and as the
					// registrant's own signing key (44-06).
					try {
						const seeded = await seedDevNetwork(networksEng);
						// A cancelled run (superseded by the escape action, unmount, or a node
						// change) must not write hasNetwork/initError/seededElectionId, and must
						// not print the boot-smoke PASS marker for a run that is not the one that
						// actually initialized.
						if (cancelled) return;
						// Bind the resolved device user into the factory BEFORE
						// getEngine("network", ...) so the factory's internal open() also uses
						// the real user.
						factory.setCurrentUser(seeded.deviceUser);
						await factory.getEngine('network', seeded.networkReference);
						if (cancelled) return;
						setHasNetwork(true);
						setSeededElectionId(seeded.electionId);
						// 51-12 (D-09/D-20): deliberately does NOT also capture seeded.sign onto
						// context — see the module doc comment above.
						// Clear any initError from a previous failed attempt so the error
						// screen is not shown when a retry succeeds.
						setInitError(null);
						// Deterministic boot marker: the real dev-seed + network open
						// succeeded, so the app is about to render Home against the real
						// engine. Consumed as the logcat PASS token by the on-device
						// cold-start smoke (scripts/voter-boot-smoke.sh). Additive only.
						console.log('[voter-boot] VoterAppProvider isInitialized');
					} catch (seedError) {
						// A cancelled run's rejection (e.g. StrandWaitCancelledError from the
						// cleanup below aborting a pending first-sync wait) must never surface
						// as an error view — the escape action already resolved the UI.
						if (cancelled) return;
						// D-15 parity: surface the recoverable error; spinner resolves to an
						// error view. NEVER fall back to a silent empty in-memory network.
						console.error('seedDevNetwork failed:', errorClassName(seedError));
						bootFailed = true;
						setInitError({error: seedError});
						// fall through to setIsInitialized(true) below so the spinner never
						// hangs.
					}
				}
				// Non-__DEV__ (production) boot: no join flow exists yet (P2P-11 paused, no
				// production seed source) — hasNetwork stays false; screens that need a real
				// network gate on it, mirroring the authority app's cold-start-no-network state.

				if (cancelled) return;
				// 62-REVIEW WR-03: a successful boot ends the retry window of a replacement made
				// earlier in this session (in __DEV__ the seed has just read the identity). A later,
				// separate loss must be replaced again, and a 'readable' refusal must no longer be
				// accepted as "already done".
				if (!bootFailed) {
					replacedThisSessionRef.current = false;
				}
				setIsInitialized(true);
				hideSplash();
				// Quick task 260928-kkf: a fresh run starts with no elapsed-budget escape shown.
				setFirstSyncBudgetElapsed(false);
			} catch (fatalError) {
				if (cancelled) return;
				// Outer catch handles failures before/after the seed/re-attach block (e.g.
				// LocalStorageReact init failure).
				console.error('Fatal init error:', errorClassName(fatalError));
				setInitError({error: fatalError});
				setIsInitialized(true);
				hideSplash();
			}
		}

		initialize();

		return () => {
			cancelled = true;
			// Unmount, a node change re-running this effect, or a superseded boot run:
			// stop waiting on any in-flight first-sync gate so nothing keeps polling in
			// the background.
			engineFactoryRef.current?.cancelPendingStrandWaits();
		};
		// Re-run when initNonce changes (Try Again) or node changes (CadreNode boot race,
		// mirrors authority AppProvider's re-attach-fix dep array).
	}, [initNonce, node]);

	// Start Fresh: clear the engine cache and reset to a clean-slate boot.
	// Extracted (quick task 260928-kkf, mirrors the authority app) so the error view's
	// existing button AND the syncing view's escape button below call the EXACT same
	// handler — same literal copy, same behavior. clearEngineCache() also calls
	// cancelPendingStrandWaits(), so this already aborts any pending first-sync wait;
	// the escape's onPress calls cancelInitRunRef.current() FIRST so the (now-cancelled)
	// run's own rejection never re-surfaces as an error view.
	const startFresh = useCallback(() => {
		engineFactoryRef.current?.clearEngineCache();
		setInitError(null);
		setIsInitialized(true);
	}, []);

	// Explicit, user-confirmed "create a new identity" (IdentityRecoveryView confirm step only —
	// from the boot error view or a registration screen's 'identity-lost' failure; never a boot
	// path). Replaces the permanently unrecoverable identity, drops the dev network the old
	// identity founded (__DEV__ only; release has no seeded network), and re-runs the boot.
	//
	// WR-03: once the replacement has succeeded the record is READABLE, so a second
	// replaceUnrecoverableDeviceIdentity call is refused with reason 'readable'. If a later step
	// fails, the view offers Create again; that retry must finish the remaining (idempotent) steps.
	//
	// 62-REVIEW WR-03: the replacement is ALWAYS attempted (the engine re-checks the record under
	// its lock), so a record that has become permanently locked AGAIN is replaced again rather
	// than skipped. Only a 'readable' refusal is accepted, and only while replacedThisSessionRef
	// says this session's own replacement has not yet been settled by a successful boot (the ref
	// is cleared there, and when this whole sequence succeeds). Any other refusal, or a
	// 'readable' refusal while nothing was replaced (T-62-87-01), propagates to the view's
	// failed state. The decision is keyed on the typed reason, never on the message.
	const createNewIdentity = useCallback(async () => {
		const factory = engineFactoryRef.current!;
		const defaultUserEng = await factory.getEngine<IDefaultUserEngine>('defaultUser');
		const defaultUser = await defaultUserEng.get();
		try {
			await replaceUnrecoverableDeviceIdentity(defaultUser?.name ?? (__DEV__ ? 'Dev Voter' : 'Device User'));
			replacedThisSessionRef.current = true;
		} catch (replaceError) {
			if (!(replacedThisSessionRef.current && isIdentityNotReplaceable(replaceError, 'readable'))) {
				throw replaceError;
			}
		}
		if (__DEV__) {
			await factory.getNetworksEngine().clearRecentNetworks();
		}
		factory.clearEngineCache();
		// The whole sequence succeeded: a later, separate loss in this session is replaced again.
		replacedThisSessionRef.current = false;
		setInitError(null);
		setIsInitialized(false);
		setInitNonce(n => n + 1);
	}, []);

	// Real reads against the same election every tab resolves. `nowMs()` (the shared dev-aware clock) is read per call, so
	// each fetch derives the card state for the moment it runs. Under a __DEV__ override the
	// real title/id stay, and the forced state's review fixture replaces the derived content.
	const getElection = useCallback(async (): Promise<VoterElection> => {
		const election = await readVoterElection(
			{getEngine, fallbackElectionId: __DEV__ ? seededElectionId : undefined},
			nowMs(),
		);
		if (__DEV__ && lifecycleOverride !== null) {
			return {
				id: election.id,
				title: election.title,
				lifecycleState: lifecycleOverride,
				...DEV_LIFECYCLE_CONTENT[lifecycleOverride],
			};
		}
		return election;
	}, [getEngine, seededElectionId, lifecycleOverride, clockOffsetMs, nowMs]);

	// Officer-confirmed ballots only; __DEV__ also admits the dev seed's proposed ballot (the seed
	// cannot run the officer confirmation ceremony).
	const getBallot = useCallback(async (): Promise<VoterBallot> => {
		return readVoterBallot(
			{getEngine, fallbackElectionId: __DEV__ ? seededElectionId : undefined},
			{includeProposed: __DEV__},
		);
	}, [getEngine, seededElectionId]);

	// Only show the spinner while initialization is truly pending.
	// Quick task 260928-kkf ("Syncing + escape button", locked decision, mirrors the
	// authority app's AppProvider): while a boot re-attach is gated on the first-sync
	// wait, this same loading view additionally shows the localized Syncing label (as
	// soon as syncState reports 'syncing', or once the wait's first budget has
	// elapsed) and, ONLY once that budget has elapsed, the existing Start Fresh action
	// — reusing its exact literal copy and handler. Try Again is deliberately NOT
	// offered here: it would just start a new ~300s wait on the same strand, which the
	// background wait is already doing.
	if (!isInitialized) {
		const showSyncing = syncState === 'syncing' || firstSyncBudgetElapsed;
		return (
			<View style={{flex: 1, justifyContent: 'center', alignItems: 'center'}}>
				<ActivityIndicator size="large" />
				{showSyncing && (
					<Text style={{marginTop: 16, textAlign: 'center'}}>{t('syncSyncing')}</Text>
				)}
				{firstSyncBudgetElapsed && (
					<TouchableOpacity
						onPress={() => {
							// Mark THIS boot run cancelled before startFresh() clears the
							// engine cache — so its (now-orphaned) pending seed/open never
							// writes state once cancelPendingStrandWaits() rejects it.
							cancelInitRunRef.current?.();
							startFresh();
						}}
						style={{marginTop: 8}}>
						<Text>{t('bootError.continueWithoutNetwork')}</Text>
					</TouchableOpacity>
				)}
			</View>
		);
	}

	// Recoverable boot-error state — shown INSIDE the existing loading View, no new screen, no
	// visual redesign. Never fabricate an empty in-memory context; user must retry or start
	// fresh. No GSD phase numbers in this user-facing copy (project rule).
	if (initError && !hasNetwork) {
		const tryAgain = () => {
			// Try Again: reset error state and re-run initialize().
			setInitError(null);
			setIsInitialized(false);
			setInitNonce(n => n + 1);
		};
		if (isReplaceableIdentityError(initError.error)) {
			return <IdentityRecoveryView onCreateNewIdentity={createNewIdentity} onRetry={tryAgain} />;
		}
		return (
			<View style={{flex: 1, justifyContent: 'center', alignItems: 'center'}}>
				<Text style={{marginBottom: 16, textAlign: 'center'}}>{t('bootError.generic')}</Text>
				<TouchableOpacity onPress={tryAgain} style={{marginBottom: 8, minHeight: 44, justifyContent: 'center'}}>
					<Text>{t('bootError.tryAgain')}</Text>
				</TouchableOpacity>
				<TouchableOpacity onPress={startFresh} style={{minHeight: 44, justifyContent: 'center'}}>
					<Text>{t('bootError.continueWithoutNetwork')}</Text>
				</TouchableOpacity>
			</View>
		);
	}

	return (
		<VoterAppContext.Provider
			value={{
				isInitialized,
				lifecycleOverride,
				setLifecycleOverride,
				clockOffsetMs,
				setClockOffsetMs,
				nowMs,
				getElection,
				getBallot,
				hasNetwork,
				getEngine,
				hasEngine,
				selectNetwork,
				seededElectionId,
				createNewIdentity,
			}}>
			{children}
		</VoterAppContext.Provider>
	);
}
