import { useEffect, useState } from 'react';
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
 */

export type PublicElectionState = 'reading' | 'ready' | 'notHeld' | 'unreadable';

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

		readAddressedElection({ status: 'ok', networkHash: networkKey, electionId: electionKey }, source)
			.then((next) => {
				handle = next.db;
				if (cancelled) {
					// The address moved on while the attach was in flight. The
					// facts are discarded AND the handle is released, so a
					// superseded read never leaks a connection.
					void closeQuietly(source, next.db);
					return;
				}
				setResolved({ state: next.state, election: next.election, db: next.db, keyRelease: next.keyRelease ?? null });
			})
			.catch(() => {
				// `readAddressedElection` never rejects, so this branch is
				// unreachable today. It exists because a future edit to the
				// seam could reintroduce a throw, and the failure mode then
				// would be a blank page rather than an honest one. It degrades
				// to the FAULT state, never to the finding.
				if (!cancelled) setResolved({ state: PUBLIC_ELECTION_STATE.UNREADABLE, election: null, db: null, keyRelease: null });
			});

		return () => {
			cancelled = true;
			// 54-15 EXTENDS THIS CLEANUP to unsubscribe `db.onDataChange`
			// before the close — one lifecycle, not two.
			void closeQuietly(source, handle);
		};
	}, [reads, networkKey, electionKey, source]);

	if (!reads) {
		// The injected override, and every address that names no election.
		// No effect ran, no database was opened, no member of `source` was
		// called.
		return election !== null && election !== undefined
			? { state: PUBLIC_ELECTION_STATE.READY, election, db: null, keyRelease: null }
			: { state: PUBLIC_ELECTION_STATE.NOT_HELD, election: null, db: null, keyRelease: null };
	}

	return resolved ?? { state: PUBLIC_ELECTION_STATE.READING, election: null, db: null, keyRelease: null };
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
