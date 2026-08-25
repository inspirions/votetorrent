/**
 * refresh.js -- D-12's explicit refresh: replace this browser's copy of a
 * network wholesale, verifying completely before discarding anything, never
 * merging.
 *
 * WHY A REFRESH ASKS FOR A NEW CODE, RATHER THAN CALLING THE TRANSPORT'S
 * OTHER, PULL-STYLE METHOD: that method carries no session credential -- a
 * refreshable one is an explicitly deferred idea, not an oversight. The
 * entire integrity story of this phase is the OUT-OF-BAND digest: the
 * 43-character right half of the officer's code, which reached the browser
 * on their phone rather than from the endpoint that served the payload.
 * `verifySnapshot`'s `expectedDigest` is what makes a snapshot AUTHENTIC
 * rather than merely self-consistent -- the envelope's own `digest` member
 * authenticates nothing, since whoever controls the payload controls that
 * field too. A pull-style refresh would have no digest to check against
 * (the officer never read one for that new payload), which would collapse
 * verification to self-consistency -- exactly the property a hostile
 * endpoint can manufacture. Therefore EVERY REFRESH IS A FRESH REDEMPTION,
 * and that other transport method must appear nowhere in this dashboard's
 * `src/` except inside `officer-swap.js`'s single-flight decorator, where it
 * exists only to throw.
 *
 * THE D-12 RULE, AS A RULE: verify completely, then and only then touch
 * storage; never merge. This module reuses 50-08's `redeemAndBootstrap`
 * with `replace: true` -- the phase's ONE destructive implementation, with
 * verify-before-delete already baked in. Writing a second one is forbidden
 * by 50-08's handoff.
 *
 * THE HONEST RESIDUAL, not buried: verification precedes destruction, so a
 * CORRUPT payload is harmless -- the existing network is never touched. But
 * a VERIFIED payload whose restore fails midway (`restore-incomplete`)
 * leaves the network unbootstrapped, and the officer needs a fresh code.
 * That state fails CLOSED: `attachNetworkDb` raises `MissingRowCountsError`
 * rather than rendering a partial database, and merge was rejected outright
 * as a way to avoid this residual -- see `<the_officer_swap_seam>` and
 * `<why_a_refresh_needs_a_new_code>` in 50-09-PLAN.md for the full
 * reasoning this header summarizes.
 */

import { redeemAndBootstrap } from './bootstrap.js';
import { closeNetworkDb } from '../db/open-db.js';
import { attachNetworkDb, readRowCounts, readRowCountsRecord, writeRowCounts } from '../db/reattach.js';
import { findNetwork } from '../db/networks-registry.js';

/** The post-swap row-count record (contract 6's obligation to 50-05) was
 * absent or diverged from the newly verified manifest after a successful
 * refresh -- a regression in the replace path, surfaced loudly rather than
 * left as a silently unverifiable network. */
export class RowCountRecordNotUpdatedError extends Error {
	/** @param {string} networkHash */
	constructor(networkHash) {
		super(`refreshNetwork: the row-count record for network "${networkHash}" was not correctly updated after a successful swap`);
		this.name = 'RowCountRecordNotUpdatedError';
		this.networkHash = networkHash;
	}
}

/**
 * Stable-key JSON comparison for the small, JSON-shaped objects this module
 * compares (row counts, row-count records, registry entries). Deliberately
 * NOT `node:assert` -- this file is bundled into the browser graph (via
 * `officer-swap.js` -> `DashboardShell.tsx`), and `assert:no-polyfills`
 * forbids a Node builtin anywhere in that graph.
 *
 * @param {unknown} value
 * @returns {string}
 */
function stableStringify(value) {
	if (value === null || typeof value !== 'object') return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
	const keys = Object.keys(/** @type {Record<string, unknown>} */ (value)).sort();
	return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(/** @type {Record<string, unknown>} */ (value)[k])}`).join(',')}}`;
}

/**
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
function sameShape(a, b) {
	return stableStringify(a) === stableStringify(b);
}

/**
 * @typedef {object} NetworkStateSnapshot
 * @property {Record<string, number>} counts
 * @property {import('../db/reattach.js').RowCountsRecord | undefined} record
 * @property {import('../db/networks-registry.js').NetworkRegistryEntry | undefined} registryEntry
 */

/**
 * Capture the three facts a byte-intact control compares: live per-table row
 * counts, the persisted row-count record, and the registry entry. Exported
 * from `src/` (not a test file) precisely so the tier-2 gate (Task 4) can
 * use the IDENTICAL instrument across a page boundary.
 *
 * @param {string} networkHash
 * @param {import('../db/networks-registry.js').StorageAdapter} storage
 * @param {string[]} tableNames
 * @returns {Promise<Readonly<NetworkStateSnapshot>>}
 */
export async function captureNetworkState(networkHash, storage, tableNames) {
	// `expectedCounts: {}` deliberately bypasses attachNetworkDb's own
	// row-count-record read and assertion -- this function does its OWN
	// counts/record/registry reads below, explicitly, so a caller can see
	// exactly which of the three diverged rather than getting a thrown
	// RowCountMismatchError naming only one table.
	const db = await attachNetworkDb(networkHash, { storage, expectedCounts: {} });
	/** @type {Record<string, number>} */
	let counts;
	try {
		counts = await readRowCounts(db, tableNames);
	} finally {
		await closeNetworkDb(db);
	}

	const record = await readRowCountsRecord(networkHash, storage);
	const registryEntry = findNetwork(networkHash, storage);

	return Object.freeze({
		counts: Object.freeze({ ...counts }),
		record: record ? Object.freeze({ ...record, counts: Object.freeze({ ...record.counts }) }) : undefined,
		registryEntry: registryEntry ? Object.freeze({ ...registryEntry }) : undefined,
	});
}

/**
 * Assert two captured states are IDENTICAL, throwing an `Error` naming
 * WHICH of counts / record / registry entry diverged -- for counts, naming
 * the table plus both numbers. Exact equality throughout, never a floor.
 *
 * @param {Readonly<NetworkStateSnapshot>} before
 * @param {Readonly<NetworkStateSnapshot>} after
 * @returns {void}
 */
export function assertNetworkStateUnchanged(before, after) {
	for (const table of Object.keys(before.counts)) {
		if (before.counts[table] !== after.counts[table]) {
			throw new Error(
				`assertNetworkStateUnchanged: table "${table}" diverged -- expected ${before.counts[table]}, got ${after.counts[table]}`,
			);
		}
	}
	if (!sameShape(before.record, after.record)) {
		throw new Error('assertNetworkStateUnchanged: the row-count record diverged');
	}
	if (!sameShape(before.registryEntry, after.registryEntry)) {
		throw new Error('assertNetworkStateUnchanged: the registry entry diverged');
	}
}

/**
 * @typedef {object} RefreshNetworkOptions
 * @property {string} networkHash
 * @property {string} pastedCode
 * @property {import('@votetorrent/vote-engine/bootstrap').IBootstrapTransport} transport
 * @property {import('../db/networks-registry.js').StorageAdapter} [storage]
 * @property {(phase: string) => void} [onPhase]
 */

/**
 * Replace this browser's copy of an ALREADY-HELD network: verify completely,
 * then and only then discard the old copy -- never merge.
 *
 * @param {RefreshNetworkOptions} options
 * @returns {Promise<import('./bootstrap.js').RedeemAndBootstrapResult>}
 */
export async function refreshNetwork(options) {
	const { networkHash, pastedCode, transport, storage, onPhase } = options;

	// A code for an unheld network is a BOOTSTRAP, not a refresh -- the shell
	// routes it to Bootstrap.tsx instead. Reaching this function for an
	// unheld hash is a programming error, not an expected refusal.
	const existing = findNetwork(networkHash, storage);
	if (!existing) {
		throw new Error(`refreshNetwork: no registry entry for network "${networkHash}" -- this is a bootstrap, not a refresh`);
	}

	// The table set does not change across a refresh (same schema) -- read
	// BEFORE the swap so the post-swap check below knows what to re-read
	// even if the record itself is missing or diverges after the swap.
	const priorRecord = await readRowCountsRecord(networkHash, storage);
	const tableNames = priorRecord ? Object.keys(priorRecord.counts) : [];

	// 50-08's ONE destructive implementation, verify-before-delete already
	// baked in. Writing a second one here is forbidden by 50-08's handoff.
	const result = await redeemAndBootstrap({
		pastedCode,
		transport,
		storage,
		replace: true,
		expectedNetworkHash: networkHash,
		onPhase,
	});

	if (result.outcome !== 'ok') {
		// The outcome vocabulary, the status, the reason and the copy mapping
		// all belong to 50-08 -- this module adds no member to any of them.
		return result;
	}

	// Contract 6's post-swap obligation: `redeemAndBootstrap`'s own step 9
	// already wrote the freshly-verified manifest as the row-count record
	// (or this whole call would have rejected before reaching `outcome: 'ok'`
	// at all). Read the live counts and the persisted record independently
	// and compare -- if they already agree, the obligation was discharged by
	// the single implementation above, and nothing more is written here.
	const db = await attachNetworkDb(networkHash, { storage, expectedCounts: {} });
	/** @type {Record<string, number>} */
	let liveCounts;
	try {
		liveCounts = await readRowCounts(db, tableNames);
	} finally {
		await closeNetworkDb(db);
	}

	const record = await readRowCountsRecord(networkHash, storage);
	if (record && sameShape(record.counts, liveCounts)) {
		return result;
	}

	// Absent or divergent: repair, then throw loudly. A regression in the
	// replace path must surface as a named error, never as a silently
	// unverifiable network left for `attachNetworkDb` to discover later.
	await writeRowCounts(networkHash, liveCounts, storage);
	throw new RowCountRecordNotUpdatedError(networkHash);
}
