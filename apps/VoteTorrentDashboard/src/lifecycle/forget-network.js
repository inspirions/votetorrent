/**
 * forget-network.js -- D-15's "forget this network": delete a browser's
 * local copy of one network's data, in an ordering where a failure leaves
 * the network listed and retryable rather than invisible and still on disk.
 *
 * THE ORDERING IS THE MITIGATION, stated in full:
 *
 *   1. `findNetwork` -- absent is `UnknownNetworkError` naming the hash.
 *   2. Compare the officer's typed confirmation against the entry's
 *      `authorityName` (both trimmed, exact case-sensitive equality).
 *      Mismatch is `ForgetConfirmationMismatchError`, naming neither value.
 *   3. `deleteNetworkDb(networkHash, { db })` -- the live handle is passed
 *      so it is closed first; `indexedDB.deleteDatabase` blocks while a
 *      connection stays open, and a blocked delete is exactly the failure
 *      this ordering exists to surface, never to swallow.
 *   4. `clearRowCounts` -- called explicitly, even though `deleteNetworkDb`
 *      already clears it, so contract 6's clear-on-delete obligation is
 *      local to this file and greppable. Idempotent.
 *   5. `removeNetwork` -- LAST.
 *
 * DATA BEFORE REGISTRY, AND WHY: if the registry entry were removed first
 * and the delete then failed, the result would be an unlisted database
 * still on disk -- a network the officer believes is gone, with no UI left
 * to try again from. That is precisely the threat D-15 owns. With this
 * ordering a failed delete leaves the network listed and retryable, which
 * is the truthful state -- 50-08's 9-before-10 discipline applied in the
 * opposite direction, for the same reason: prefer the recoverable
 * inconsistency over the invisible one.
 *
 * `onblocked` IS A FAILURE, NEVER A RESOLVE. Spike 076's `deleteIdb()`
 * resolved on it; copying that would report "forgotten" while the
 * officer's whole database -- registrant PII included -- is still on the
 * machine. `src/db/open-db.js`'s `deleteNetworkDb` already rejects
 * `DeleteBlockedError` rather than resolving, and this module inherits
 * that posture rather than re-deciding it.
 *
 * A FAILURE IS PROPAGATED, NEVER CONVERTED: `forgetNetwork` contains no
 * exception-handling block around `deleteNetworkDb`'s call, so a rejection
 * leaves this function by rethrow -- there is no path by which a blocked or
 * otherwise-failed delete can be turned into a success shape.
 *
 * THE HONEST LIMIT: there is no automatic expiry by design. Nothing in
 * this dashboard disappears unexpectedly -- the only thing that ends an
 * officer's local copy is the officer choosing to end it, through this
 * module. A browser that is never told to forget a network keeps that
 * network's whole database, registrant PII included, indefinitely.
 */

import { deleteNetworkDb, dbNameFor } from '../db/open-db.js';
import { clearRowCounts, readRowCountsRecord } from '../db/reattach.js';
import { findNetwork, removeNetwork, listNetworks } from '../db/networks-registry.js';

/** The officer typed a confirmation that does not match the network's
 * `authorityName`. Never carries either value -- both are snapshot content. */
export class ForgetConfirmationMismatchError extends Error {
	constructor() {
		super("forgetNetwork: typed confirmation does not match this network's authorityName");
		this.name = 'ForgetConfirmationMismatchError';
	}
}

/** `forgetNetwork` was asked to forget a hash the registry has no entry for. */
export class UnknownNetworkError extends Error {
	/** @param {string} networkHash */
	constructor(networkHash) {
		super(`forgetNetwork: no registry entry for network "${networkHash}"`);
		this.name = 'UnknownNetworkError';
		this.networkHash = networkHash;
	}
}

/** `assertNetworkForgotten` found one of the three artefacts still present. */
export class NetworkStillPresentError extends Error {
	/** @param {'IndexedDB database' | 'registry entry' | 'row-count record'} survivor */
	constructor(survivor) {
		super(`assertNetworkForgotten: the ${survivor} for this network is still present`);
		this.name = 'NetworkStillPresentError';
		this.survivor = survivor;
	}
}

/**
 * @typedef {object} ForgetNetworkOptions
 * @property {string} networkHash
 * @property {string} typedConfirmation
 * @property {import('@quereus/quereus').Database} [db] - an already-open handle, closed first
 * @property {import('../db/networks-registry.js').StorageAdapter} [storage]
 * @property {number} [timeoutMs] - forwarded to `deleteNetworkDb`'s blocked-delete
 *   timeout; a minor, additive passthrough beyond the five-step ordering above,
 *   present only so a caller (including this file's own test suite) can bound
 *   how long a blocked delete is waited out. Omitting it uses
 *   `deleteNetworkDb`'s own default.
 */

/**
 * Delete this browser's local copy of one network's data: the IndexedDB
 * database, the contract-C5 row-count record, and the registry entry, in
 * that order. Returns the registry's remaining entries so the caller can
 * route to the next network or to the bootstrap screen when it was the
 * last one.
 *
 * @param {ForgetNetworkOptions} options
 * @returns {Promise<{ networkHash: string, remaining: import('../db/networks-registry.js').NetworkRegistryEntry[] }>}
 */
export async function forgetNetwork(options) {
	const { networkHash, typedConfirmation, db, storage, timeoutMs } = options;

	// 1. Registry lookup -- absent is a programming error from this entry
	//    point (the UI never offers "forget" for a network it does not list).
	const entry = findNetwork(networkHash, storage);
	if (!entry) {
		throw new UnknownNetworkError(networkHash);
	}

	// 2. Typed confirmation, trimmed, exact case-sensitive equality against
	//    the entry's OWN authorityName -- never the value the officer typed,
	//    and never the expected value, appear in the thrown error.
	const typed = String(typedConfirmation ?? '').trim();
	if (typed !== entry.authorityName.trim()) {
		throw new ForgetConfirmationMismatchError();
	}

	// 3. Delete the database. No exception-handling wraps this call -- a
	//    rejection (most importantly DeleteBlockedError) must leave this
	//    function by propagation, never be converted into a success shape.
	await deleteNetworkDb(networkHash, timeoutMs === undefined ? { db } : { db, timeoutMs });

	// 4. Explicit clear, even though step 3 already clears this key --
	//    contract 6's clear-on-delete obligation stays local to this file
	//    and greppable rather than an implicit side effect of step 3.
	await clearRowCounts(networkHash, storage);

	// 5. Registry removal LAST -- see the file header's data-before-registry
	//    reasoning.
	removeNetwork(networkHash, storage);

	return { networkHash, remaining: listNetworks(storage) };
}

/**
 * The mechanically checkable definition of "gone": no IndexedDB database, no
 * registry entry, no row-count record. Throws `NetworkStillPresentError`
 * naming whichever of the three survived. Used by the tier-2 gate's fresh
 * page load (Task 4) and exported so a later phase can reuse it rather than
 * re-deriving what "gone" means.
 *
 * @param {string} networkHash
 * @param {import('../db/networks-registry.js').StorageAdapter} [storage]
 * @returns {Promise<void>}
 */
export async function assertNetworkForgotten(networkHash, storage) {
	// `indexedDB.databases()` absence is non-fatal -- some environments (a
	// handful of older browsers, some test doubles) do not expose it, and
	// this check is simply skipped there; the registry and row-count checks
	// below still run regardless.
	if (typeof indexedDB !== 'undefined' && typeof indexedDB.databases === 'function') {
		const remaining = await indexedDB.databases();
		const name = dbNameFor(networkHash);
		if (remaining.some((entry) => entry.name === name)) {
			throw new NetworkStillPresentError('IndexedDB database');
		}
	}

	if (findNetwork(networkHash, storage)) {
		throw new NetworkStillPresentError('registry entry');
	}

	if (await readRowCountsRecord(networkHash, storage)) {
		throw new NetworkStillPresentError('row-count record');
	}
}
