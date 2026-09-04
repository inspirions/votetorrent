import { useCallback, useEffect, useState } from 'react';
import { enableChangePropagation, subscribeToPublicChanges } from '@votetorrent/web-data/public';
import {
	PUBLIC_ELECTION_STATE,
	DEFAULT_PUBLIC_SOURCE,
	readAddressedElection,
	shouldReadFor,
} from '../public-election-source.js';
import type { AddressedElectionFacts, PublicSourceDeps } from '../public-election-source.js';

/**
 * Re-exported, not re-implemented. `shouldReadFor` is the decision that keeps
 * 53-D17 true and it lives beside the read it gates (see its own header for
 * the measured reason it is not defined here); this re-export is what lets the
 * hook's consumers treat it as part of this module's surface.
 */
export { shouldReadFor };

/**
 * use-public-election.ts — the hook that owns EVERY effect, EVERY await, every
 * cleanup closure and every helper `return` in this feature.
 *
 * WHY THIS FILE EXISTS AT ALL, which is the thing a later reader will get
 * wrong first: `election-shell.test.mjs`'s case 1 counts `\breturn\b` in
 * comment-stripped `ElectionShell.tsx` and requires the count to be EXACTLY
 * ONE. That is not a style rule. `AdvisoryDisclosure`'s own header states that
 * the moment it can be conditioned on anything it can be hidden, and a second
 * `return` is the cheapest way to make it conditional by accident. So the
 * shell gains hooks and never gains a second `return`, and everything that
 * needs one lives here.
 *
 * WHY TypeScript (`.ts`) RATHER THAN THE JSDoc `.js` THIS SURFACE OTHERWISE
 * USES (`election-address.js`, `engine-preflight.js`, `public-election-source.js`):
 * the state union and the result shape are the part the checker actually
 * earns its keep on, and this module is consumed only from `.tsx`. The
 * dependency-injected read seam stays plain `.js` because its consumers
 * include node test files.
 *
 * THE INJECTED `election` PROP SHORT-CIRCUITS EVERYTHING, and that is a
 * correctness requirement rather than an optimisation. 53-D17 requires that
 * production renders `<ElectionShell />` with NO `election` prop, so that no
 * election fact exists anywhere in the production import graph, and that
 * `test/browser/election-shell-gate.tsx` is the only supplier of one. If this
 * hook read a database anyway whenever a prop happened to be present, every
 * existing browser rung would be measuring a page it did not think it was
 * measuring — the harness would silently be exercising the real path. The
 * decision is factored into `shouldReadFor` so a test can assert it
 * BEHAVIOURALLY rather than by matching source text.
 *
 * THE CANCELLED-MOUNT GUARD is the `ElectionsPanel.tsx` shape: a `cancelled`
 * flag set in the effect's cleanup and checked before every state commit.
 * Without it a slow attach resolving after the address changed would commit
 * the PREVIOUS election's facts onto the CURRENT address — a page showing the
 * wrong election is worse than a page showing none, and on a verifiability
 * page it is a false claim rather than a glitch.
 *
 * THE CLEANUP CLOSES THE HANDLE. `readAddressedElection` deliberately returns
 * it open (its own header point 6), because D-27 (54-15) subscribes to that
 * handle's change feed. 54-15 EXTENDS THIS SAME CLEANUP to unsubscribe, so
 * that plan extends one lifecycle rather than adding a second one beside it.
 *
 * D-27 LANDED HERE, NOT IN `ElectionShell.tsx`, and the difference matters
 * enough to record. 54-15's plan named the shell as the file to wire; the shell
 * on disk holds ZERO effects and ZERO awaits and is held to that by
 * `election-shell.test.mjs` case 12b, precisely so its single `return` — and
 * therefore `AdvisoryDisclosure`'s unbranchability — cannot be broken by an
 * async read. A subscription is an effect with a cleanup, so it belongs in the
 * one place that already owns an effect with a cleanup over the same handle:
 * this file, exactly as the paragraph above predicted before either plan was
 * written.
 *
 * THE SUBSCRIPTION SHARES THE ATTACH EFFECT, deliberately. A second effect
 * would have its own lifetime, and either a listener would outlive the handle
 * it holds or the handle would close while a listener still pointed at it —
 * both are the leak this one-effect rule exists to foreclose. `unsubscribe()`
 * and `stop()` therefore run in THIS cleanup, before the close, in that order.
 *
 * WHY A NOTICE ONLY INVALIDATES AND NEVER READS. `dataVersion` is a counter in
 * the read effect's dependency list; a change notice increments it and nothing
 * else. If the notice performed a read of its own it would be reading through
 * a handle whose lifetime this effect owns, racing this cleanup — the same
 * argument `public-election-source.js` header point 7 makes for the key-release
 * aggregate, one level up.
 *
 * `connection`/`observedAt` PROMOTE THIS SIGNAL TO RENDERED STATE (56-12,
 * D-17), superseding the paragraph that used to stand here. What is
 * rendered, and under which state: `ElectionShell.tsx` renders an amber,
 * worded staleness banner exactly when `read.state === 'ready'` AND
 * `read.connection === 'down'` -- never on `reading`, `notHeld` or
 * `unreadable`, and never as a standing "connected" claim on any other path.
 * The rendered claim is scoped to the CHANGE CHANNEL this handle exposes,
 * nothing wider.
 *
 * STATE THE LIMIT, NOT A CAVEAT. A live change channel is not proof of mesh
 * connectivity: `subscription.live` reports only whether the attached handle
 * exposes an `onDataChange` function, which says nothing about whether any
 * peer is actually reachable. A browser holding cached rows while the mesh
 * is unreachable still reports `live` and shows no banner. The missing
 * conjunct is a running peer feed, and nothing in this production tree
 * starts one today -- 56-09's reactivity bridge is imported by no production
 * file, by that plan's own design. `56-14` is the plan that widens this
 * predicate, once it observes a real peer write landing; until then
 * `connection` answers the one honest question this hook can answer today
 * ("does this handle expose a change channel"), and no wider one. No
 * standing positive "connected" claim is made anywhere on this page -- see
 * `public.freshness.body`, which stays true in both states.
 */

export type PublicElectionState = 'reading' | 'ready' | 'notHeld' | 'unreadable';

/**
 * 56-12/D-17. `'unknown'` on every path that observes nothing -- the
 * injected-election seam, an address naming no election, the `reading`
 * placeholder, the `catch` degrade and a resolve whose handle was nullish.
 * `'live'`/`'down'` are set at exactly one site, immediately after the
 * `subscribeToPublicChanges` call, from the same boolean the pre-existing
 * `console.debug` guard already reads. See this module's own header for the
 * limit this signal carries.
 */
export type PublicConnectionState = 'unknown' | 'live' | 'down';

export interface PublicElectionAddress {
	status: string;
	electionId: string | null;
	networkHash: string | null;
}

export interface UsePublicElectionArgs {
	/** The parsed address. Only the `'ok'` shape triggers a read. */
	address: PublicElectionAddress | null;
	/** 53-D17's injected override. When present, NOTHING is read. */
	election?: AddressedElectionFacts | null;
	/** The test seam over the real modules; defaults to the real bindings. */
	source?: PublicSourceDeps;
}

export interface UsePublicElectionResult {
	state: PublicElectionState;
	election: AddressedElectionFacts | null;
	db: unknown;
	/** D-14's three numbers, or `null` when the aggregate could not be read —
	 * and `null` on every path that opens no database at all, including the
	 * injected-election seam. The card says so rather than vanishing (D-23);
	 * see `public-election-source.js` header point 7 for why the read lives
	 * beside the election read rather than in a second hook. */
	keyRelease: KeyReleaseProgress | null;
	/** The published voter roll, or `null` when it could not be read — and
	 * `null` on every path that opens no database at all, including the
	 * injected-election seam. The card renders the same honest empty state for
	 * both; see `public-election-source.js` header point 8 for why this read
	 * lives beside the election read rather than in a second hook. */
	roll: ReadonlyArray<Readonly<Record<string, string | null>>> | null;
	/** 56-12/D-17: the change-channel signal, promoted to rendered state. See
	 * this module's own header for what it can and cannot see. */
	connection: PublicConnectionState;
	/** The canonical instant `connection` was observed at, or `null` when
	 * `connection` is `'unknown'`. Captured from `source.nowCanonical()` at
	 * the same site `connection` is set. */
	observedAt: string | null;
}

/** Structural, not imported: `use-public-election.ts` is the only TypeScript
 * file on this path and the read seam is plain JSDoc `.js`. */
export interface KeyReleaseProgress {
	released: number;
	total: number;
	keyholderCount: number;
}

export function usePublicElection({ address, election = null, source = DEFAULT_PUBLIC_SOURCE }: UsePublicElectionArgs): UsePublicElectionResult {
	const [resolved, setResolved] = useState<UsePublicElectionResult | null>(null);
	/** D-27's invalidation counter. A change notice increments it; nothing else
	 * reads it, and it is never rendered. Its ONLY job is to be a dependency of
	 * the read effect below. */
	const [dataVersion, setDataVersion] = useState(0);
	/** Stable across renders, so handing it to the seam does not itself become
	 * a reason for the effect to re-run. */
	const bumpDataVersion = useCallback(() => setDataVersion((n) => n + 1), []);

	const reads = shouldReadFor(election, address);
	// Both effect keys are PRIMITIVE, so an address object rebuilt on every
	// render (which `parseElectionAddress` does — it returns a fresh frozen
	// object each call) cannot re-trigger the read on every commit.
	const networkKey = address && typeof address.networkHash === 'string' ? address.networkHash : '';
	const electionKey = address && typeof address.electionId === 'string' ? address.electionId : '';

	useEffect(() => {
		if (!reads) return undefined;
		let cancelled = false;
		let handle: unknown = null;
		/** D-27. Both live in THIS closure and are released by THIS cleanup —
		 * see the module header. */
		let subscription: { live: boolean; unsubscribe: () => void } | null = null;
		let propagation: { active: boolean; stop: () => void } | null = null;

		readAddressedElection({ status: 'ok', networkHash: networkKey, electionId: electionKey }, source)
			.then((next) => {
				handle = next.db;
				if (cancelled) {
					// The address moved on while the attach was in flight. The
					// facts are discarded AND the handle is released, so a
					// superseded read never leaks a connection. Nothing was
					// subscribed on this handle — the cleanup has already run,
					// so starting a subscription here would create one nobody
					// would ever release.
					void closeQuietly(source, next.db);
					return;
				}
				// 56-12/D-17. Set at exactly this one site: 'unknown' unless a
				// subscription was actually created below, in which case the
				// same boolean the pre-existing console.debug guard reads maps
				// to 'live'/'down', observed at the moment the subscription was
				// created.
				let connection: PublicConnectionState = 'unknown';
				let observedAt: string | null = null;
				if (next.db !== null && next.db !== undefined) {
					// D-27. Propagation FIRST, so the bridge is listening before
					// the subscription that consumes it exists; both are started
					// against the handle this effect owns and released together
					// below. `enableChangePropagation` is the same function a
					// WRITER calls — that symmetry is what keeps the browser
					// gate free of test-only plumbing.
					propagation = enableChangePropagation(next.db, networkKey);
					subscription = subscribeToPublicChanges(next.db, bumpDataVersion);
					connection = subscription.live ? 'live' : 'down';
					observedAt = source.nowCanonical();
					if (!subscription.live) {
						// No identifier, no error text: the fact that this handle
						// exposes no change channel, and nothing else. The page
						// still renders; it simply stops updating (D-27's
						// degrade-to-static).
						console.debug('use-public-election: this handle exposes no change channel; the view will not update on its own');
					}
				}
				setResolved({
					state: next.state,
					election: next.election,
					db: next.db,
					keyRelease: next.keyRelease ?? null,
					roll: next.roll ?? null,
					connection,
					observedAt,
				});
			})
			.catch(() => {
				// `readAddressedElection` never rejects, so this branch is
				// unreachable today. It exists because a future edit to the
				// seam could reintroduce a throw, and the failure mode then
				// would be a blank page rather than an honest one. It degrades
				// to the FAULT state, never to the finding.
				if (!cancelled)
					setResolved({
						state: PUBLIC_ELECTION_STATE.UNREADABLE,
						election: null,
						db: null,
						keyRelease: null,
						roll: null,
						connection: 'unknown',
						observedAt: null,
					});
			});

		return () => {
			cancelled = true;
			// 54-15: unsubscribe, then stop the bridge, then close — one
			// lifecycle, not two. Both releases are idempotent, so a cleanup
			// that runs before the attach resolved is a no-op rather than a
			// throw.
			subscription?.unsubscribe();
			propagation?.stop();
			void closeQuietly(source, handle);
		};
	}, [reads, networkKey, electionKey, source, dataVersion, bumpDataVersion]);

	if (!reads) {
		// The injected override, and every address that names no election.
		// No effect ran, no database was opened, no member of `source` was
		// called. 56-12/D-17: 'unknown' on both branches -- no connection was
		// ever observed here.
		return election !== null && election !== undefined
			? { state: PUBLIC_ELECTION_STATE.READY, election, db: null, keyRelease: null, roll: null, connection: 'unknown', observedAt: null }
			: { state: PUBLIC_ELECTION_STATE.NOT_HELD, election: null, db: null, keyRelease: null, roll: null, connection: 'unknown', observedAt: null };
	}

	return (
		resolved ?? {
			state: PUBLIC_ELECTION_STATE.READING,
			election: null,
			db: null,
			keyRelease: null,
			roll: null,
			connection: 'unknown',
			observedAt: null,
		}
	);
}

/**
 * Best-effort close. Tolerates a nullish handle and an already-closed one; a
 * close failure is never surfaced, because there is no reader-visible fact it
 * could honestly report.
 */
async function closeQuietly(source: PublicSourceDeps, db: unknown): Promise<void> {
	if (db === null || db === undefined) return;
	try {
		await source.closeNetworkDb(db);
	} catch {
		// Intentionally silent — see this function's own header.
	}
}
