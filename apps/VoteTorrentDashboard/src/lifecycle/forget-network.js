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
 *
 * A REAL-BROWSER SETTLE RACE, FOUND BY THE TIER-2 GATE (Task 4), NOT
 * REPRODUCIBLE UNDER `fake-indexeddb`: in a genuine browser, an UN-AWAITED
 * background operation left over from the very read that produced the `db`
 * handle passed into `deleteNetworkDb` (a query-planner statistics write,
 * observed empirically -- the resurrected shell carries exactly the two
 * system stores such a write would need, and nothing else) can still be
 * in flight the moment `deleteNetworkDb`'s own delete-then-confirm sequence
 * completes. Because the underlying store plugin transparently reopens
 * (and, per IndexedDB's own no-version-supplied semantics, thereby
 * RECREATES) a database by name on any access, this background write can
 * silently resurrect an EMPTY shell of the just-deleted database moments
 * after `deleteNetworkDb` itself reported success. `fake-indexeddb` has no
 * such shared-connection-singleton plugin internals to race against, which
 * is exactly why this was invisible to every tier-1 test in this project.
 *
 * THAT ATTRIBUTION IS NOT SETTLED, AND IS RECORDED AS UNSETTLED. Code review
 * observed that the evidence above -- "the resurrected shell carries exactly
 * the two system stores such a write would need, and nothing else" -- fits an
 * equally simple alternative: `listObjectStores`, exported from
 * `src/db/open-db.js` and called by both the tier-1 suite and the tier-2
 * gate, used a bare `indexedDB.open(name)`, which CREATES a database that
 * does not exist. That probe no longer creates (it checks
 * `indexedDB.databases()` first), so the two explanations are now
 * distinguishable -- but the settle-race measurement has NOT been re-run
 * since, so the background-write story above is a hypothesis this file still
 * carries, not a conclusion. `deleteNetworkDbSettled` stays either way: it is
 * bounded, it calls the one sanctioned primitive, and it verifies against the
 * same truth `assertNetworkForgotten` trusts.
 *
 * `deleteNetworkDbSettled` (below) is NOT a second destructive
 * implementation -- it calls the ONE sanctioned `deleteNetworkDb` primitive,
 * possibly more than once, and verifies against the SAME
 * `indexedDB.databases()` truth `assertNetworkForgotten` already trusts.
 * Between rounds it yields to the browser's task queue via a `MessageChannel`
 * round trip -- a real macrotask, like the background write it is waiting
 * out, but NOT `setTimeout`: this file holds itself to the same no-timer
 * discipline as `freshness.js` (D-22), and a `MessageChannel` port round
 * trip is not a polling interval, a subscription or a liveness construct --
 * it is a single bounded wait inside one destructive action, never
 * repeating once that action either completes or gives up. Bounded at
 * `DELETE_SETTLE_MAX_ROUNDS` rounds; a genuine failure to converge is a
 * `DeleteBlockedError`, the SAME name `deleteNetworkDb` itself uses, so a
 * caller never has to distinguish "blocked on the first attempt" from
 * "would not stay deleted after settling."
 */

import { deleteNetworkDb, dbNameFor } from '../db/open-db.js';
import { clearRowCounts, readRowCountsRecord } from '../db/reattach.js';
import { findNetwork, removeNetwork, listNetworks } from '../db/networks-registry.js';

/** How many delete-then-settle rounds `deleteNetworkDbSettled` will run
 * before giving up and reporting `DeleteBlockedError`. Empirically the
 * observed resurrection converges within 1-3 rounds; this leaves a wide
 * margin without risking an unbounded loop. */
const DELETE_SETTLE_MAX_ROUNDS = 8;
/** How many macrotask round trips to wait, per round, before re-checking. */
const DELETE_SETTLE_YIELDS_PER_ROUND = 40;

/**
 * Yield once to the browser's task queue via a `MessageChannel` round trip
 * -- a real macrotask, the same category of task a background IndexedDB
 * write completes as, without adding `setTimeout` to this file (see the
 * header's D-22 note above).
 *
 * @returns {Promise<void>}
 */
function yieldToTaskQueue() {
	return new Promise((resolve) => {
		const channel = new MessageChannel();
		channel.port2.onmessage = () => resolve(undefined);
		channel.port1.postMessage(null);
	});
}

/**
 * Call the sanctioned `deleteNetworkDb` primitive, then verify against
 * `indexedDB.databases()` that the database actually stayed gone --
 * re-deleting (bounded) if a real-browser settle race resurrected an empty
 * shell in the moment after a reported-successful delete. See the file
 * header's "real-browser settle race" note.
 *
 * A rejection from `deleteNetworkDb` ITSELF (e.g. a genuinely blocked
 * delete on the first attempt) is never caught here -- it propagates
 * immediately, exactly as a bare `deleteNetworkDb` call would.
 *
 * @param {string} networkHash
 * @param {import('../db/open-db.js').DeleteNetworkDbOptions} [options]
 * @returns {Promise<void>}
 */
async function deleteNetworkDbSettled(networkHash, options) {
	await deleteNetworkDb(networkHash, options);

	// `indexedDB.databases()` absence is non-fatal -- see the same note in
	// `assertNetworkForgotten` below. Nothing further to verify here.
	if (typeof indexedDB === 'undefined' || typeof indexedDB.databases !== 'function') {
		return;
	}

	const name = dbNameFor(networkHash);
	let remaining = await indexedDB.databases();
	let round = 0;
	while (remaining.some((entry) => entry.name === name) && round < DELETE_SETTLE_MAX_ROUNDS) {
		for (let y = 0; y < DELETE_SETTLE_YIELDS_PER_ROUND; y += 1) {
			// eslint-disable-next-line no-await-in-loop -- deliberately serial, waiting out a real macrotask each time
			await yieldToTaskQueue();
		}
		// The SAME options as the first attempt. Passing none reverted to the
		// 5000ms default and, more importantly, dropped the storage adapter --
		// so a caller that injected one had its row-count record cleared from
		// `globalThis.localStorage` instead on eight of nine attempts.
		await deleteNetworkDb(networkHash, options);
		remaining = await indexedDB.databases();
		round += 1;
	}

	if (remaining.some((entry) => entry.name === name)) {
		const err = new Error(
			`deleteNetworkDbSettled: "${name}" is still listed by indexedDB.databases() after ${DELETE_SETTLE_MAX_ROUNDS} settle-and-retry rounds`,
		);
		err.name = 'DeleteBlockedError';
		throw err;
	}
}

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

	// 3. Delete the database, settling out the real-browser resurrection
	//    race documented in the file header. No exception-handling wraps
	//    this call -- a rejection (most importantly DeleteBlockedError,
	//    whether from the first attempt or from settling never converging)
	//    must leave this function by propagation, never be converted into a
	//    success shape.
	await deleteNetworkDbSettled(networkHash, timeoutMs === undefined ? { db, storage } : { db, storage, timeoutMs });

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
