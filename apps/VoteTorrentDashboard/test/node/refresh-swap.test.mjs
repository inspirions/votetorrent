/**
 * Tier-1 coverage of `src/lifecycle/refresh.js` (D-12's byte-intact refresh)
 * and `src/lifecycle/officer-swap.js` (D-14's single-flight classify-then-
 * replace seam).
 *
 * HONESTY NOTE (mirrors Task 1's suite): `fake-indexeddb` proves the
 * ORDERING, the CLASSIFICATION and the byte-intact guarantee this module
 * enforces -- NOT durability across a real page load. That further proof is
 * Task 4's two-page browser gate.
 *
 * `import 'fake-indexeddb/auto'` first, then `node:test` + `node:assert/strict`,
 * then 50-08's fixture module and a `Map`-backed storage double. Sequential
 * and stateful, one network hash per test, `deleteNetworkDb` at the top of
 * each.
 */
import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSnapshot } from '@votetorrent/vote-engine/bootstrap';
import { deleteNetworkDb, closeNetworkDb } from '../../src/db/open-db.js';
import { attachNetworkDb, readRowCounts, rowCountsKeyFor } from '../../src/db/reattach.js';
import { findNetwork } from '../../src/db/networks-registry.js';
import { redeemAndBootstrap } from '../../src/lifecycle/bootstrap.js';
import { redeemSignInCode } from '../../src/transport/bootstrap-transport-client.js';
import {
	buildFixtureEnvelope,
	withDroppedRows,
	withMutatedCell,
	withForeignSchemaHash,
	withExtraUserRow,
	makeFakeTransport,
} from '../fixtures/bootstrap-envelope.js';
import {
	RowCountRecordNotUpdatedError,
	refreshNetwork,
	captureNetworkState,
	assertNetworkStateUnchanged,
} from '../../src/lifecycle/refresh.js';
import {
	SWAP_KINDS,
	createSingleFlightTransport,
	deriveOfficerUserIdFromEnvelope,
	classifyRedemption,
	performOfficerSwap,
} from '../../src/lifecycle/officer-swap.js';

const SECRET = 'a'.repeat(40);
const SECRET_2 = 'b'.repeat(40);

/** A `Map`-backed localStorage-shaped fake, exposing its raw key set for
 * test-only inspection (Node 22 has no real `localStorage`). */
function makeFakeStorage() {
	/** @type {Map<string, string>} */
	const map = new Map();
	return {
		getItem: (/** @type {string} */ key) => (map.has(key) ? /** @type {string} */ (map.get(key)) : null),
		setItem: (/** @type {string} */ key, /** @type {string} */ value) => {
			map.set(key, value);
		},
		removeItem: (/** @type {string} */ key) => {
			map.delete(key);
		},
		/** Test-only escape hatch. @returns {string[]} */
		_keys: () => [...map.keys()],
	};
}

/**
 * A storage double that can be told, at an explicit point in a test, to start
 * reporting `rowCountsKey` as absent -- simulating the row-count record not
 * surviving to refresh.js's post-swap check while the registry entry does.
 * Writes ALWAYS land in the real underlying map, and `_raw` reads that map
 * directly, so a test can distinguish "the reader could not see it" from
 * "something overwrote it".
 *
 * Deliberately armed by an explicit `_vanish()` call rather than by counting
 * reads: a read-count trigger silently couples the instrument to how many
 * times the implementation happens to read the key, which is exactly how the
 * previous version of this double kept passing after refresh.js stopped
 * reading it pre-swap.
 *
 * @param {string} rowCountsKey
 */
function makeVanishingRowCountsStorage(rowCountsKey) {
	/** @type {Map<string, string>} */
	const map = new Map();
	let vanished = false;
	return {
		getItem: (/** @type {string} */ key) => {
			if (key === rowCountsKey && vanished) return null;
			return map.has(key) ? map.get(key) : null;
		},
		setItem: (/** @type {string} */ key, /** @type {string} */ value) => {
			map.set(key, value);
		},
		removeItem: (/** @type {string} */ key) => {
			map.delete(key);
		},
		/** Test-only: start reporting `rowCountsKey` as absent from here on. */
		_vanish: () => {
			vanished = true;
		},
		/** Test-only: read the underlying map, bypassing the vanish. @returns {string | null} */
		_raw: (/** @type {string} */ key) => (map.has(key) ? /** @type {string} */ (map.get(key)) : null),
	};
}

/** @param {import('@votetorrent/vote-engine/bootstrap').BootstrapSnapshot} envelope @param {string} [secret] */
function codeFor(envelope, secret = SECRET) {
	return `${secret}.${envelope.digest}`;
}

/**
 * Rebuild a fixture envelope for the SAME network with a DIFFERENT officer
 * (`User.Id` = 'u2' instead of 'u1'), rebuilt through `buildSnapshot` so the
 * manifest/digest/schemaHash stay internally consistent -- this envelope
 * VERIFIES successfully; only the officer it carries differs.
 *
 * @param {import('@votetorrent/vote-engine/bootstrap').BootstrapSnapshot} baseEnvelope
 */
function buildSwapOfficerEnvelope(baseEnvelope) {
	const firstUser = /** @type {Record<string, unknown>} */ (baseEnvelope.tables.User?.[0]);
	const firstOfficer = /** @type {Record<string, unknown>} */ (baseEnvelope.tables.Officer?.[0]);
	const tables = {
		...baseEnvelope.tables,
		User: [{ ...firstUser, Id: 'u2' }],
		Officer: [{ ...firstOfficer, UserId: 'u2' }],
	};
	return buildSnapshot({ networkHash: baseEnvelope.networkHash, tables, generatedAt: baseEnvelope.generatedAt });
}

/**
 * Rebuild a fixture envelope for the SAME network with a changed
 * `Registrant.PrivateCid`, rebuilt through `buildSnapshot` so the
 * manifest/digest/schemaHash stay internally consistent -- a legitimately
 * DIFFERENT, self-verifying "new snapshot" for the successful-refresh case.
 * `withMutatedCell` (used elsewhere in this file) is deliberately NOT this:
 * it keeps the OLD digest to simulate corruption, which is the opposite of
 * what a successful refresh's positive control needs.
 *
 * @param {import('@votetorrent/vote-engine/bootstrap').BootstrapSnapshot} baseEnvelope
 */
function buildRefreshedEnvelope(baseEnvelope) {
	const firstRegistrant = /** @type {Record<string, unknown>} */ (baseEnvelope.tables.Registrant?.[0]);
	const tables = {
		...baseEnvelope.tables,
		Registrant: [{ ...firstRegistrant, PrivateCid: 'cid-private-refreshed' }],
	};
	return buildSnapshot({ networkHash: baseEnvelope.networkHash, tables, generatedAt: baseEnvelope.generatedAt });
}

/** Bootstrap the fixture network successfully, returning the storage double,
 * the envelope and the table-name list `captureNetworkState` needs. */
async function bootstrapFixtureNetwork() {
	const envelope = buildFixtureEnvelope();
	await deleteNetworkDb(envelope.networkHash).catch(() => undefined);
	const storage = makeFakeStorage();
	const transport = makeFakeTransport({ codeToResult: { [SECRET]: { status: 'ok', snapshot: envelope } } });
	const result = await redeemAndBootstrap({ pastedCode: codeFor(envelope), transport, storage });
	assert.equal(result.outcome, 'ok');
	return { envelope, storage, tableNames: Object.keys(envelope.manifest) };
}

// ---------------------------------------------------------------------------
// createSingleFlightTransport
// ---------------------------------------------------------------------------

test('createSingleFlightTransport: forwards on the first call and replays a deeply-equal result on the second call, without a second inner call', async () => {
	const envelope = buildFixtureEnvelope();
	const inner = makeFakeTransport({ codeToResult: { [SECRET]: { status: 'ok', snapshot: envelope } } });
	const singleFlight = createSingleFlightTransport(inner);

	const r1 = await singleFlight.transport.redeem(SECRET);
	const r2 = await singleFlight.transport.redeem(SECRET);

	assert.deepEqual(r1, r2);
	assert.equal(inner.calls.length, 1);
	assert.equal(singleFlight.innerCallCount, 1);
});

test('createSingleFlightTransport: a refused code is never cached -- two calls reach the inner transport twice, unchanged', async () => {
	const inner = makeFakeTransport({ codeToResult: { [SECRET]: { status: 'used' } } });
	const singleFlight = createSingleFlightTransport(inner);

	const r1 = await singleFlight.transport.redeem(SECRET);
	const r2 = await singleFlight.transport.redeem(SECRET);

	assert.equal(r1.status, 'used');
	assert.equal(r2.status, 'used');
	assert.equal(inner.calls.length, 2);
});

test('createSingleFlightTransport: reset() clears the cache -- a third call after reset() reaches the inner transport again', async () => {
	const envelope = buildFixtureEnvelope();
	const inner = makeFakeTransport({ codeToResult: { [SECRET]: { status: 'ok', snapshot: envelope } } });
	const singleFlight = createSingleFlightTransport(inner);

	await singleFlight.transport.redeem(SECRET);
	await singleFlight.transport.redeem(SECRET);
	assert.equal(inner.calls.length, 1);

	singleFlight.reset();
	await singleFlight.transport.redeem(SECRET);
	assert.equal(inner.calls.length, 2);
});

test('createSingleFlightTransport: the transport\'s pull-style method throws by name', async () => {
	const inner = makeFakeTransport({ codeToResult: {} });
	const singleFlight = createSingleFlightTransport(inner);
	await assert.rejects(() => singleFlight.transport.pullSnapshot());
});

test('createSingleFlightTransport: takes no storage argument at all -- structurally cannot persist the cache', () => {
	assert.equal(createSingleFlightTransport.length, 1);
});

// ---------------------------------------------------------------------------
// deriveOfficerUserIdFromEnvelope
// ---------------------------------------------------------------------------

test('deriveOfficerUserIdFromEnvelope: returns the single User row\'s Id for a well-formed envelope', () => {
	assert.equal(deriveOfficerUserIdFromEnvelope(buildFixtureEnvelope()), 'u1');
});

test('deriveOfficerUserIdFromEnvelope: null for zero User rows', () => {
	const envelope = buildFixtureEnvelope();
	const zeroUsers = { ...envelope, tables: { ...envelope.tables, User: [] } };
	assert.equal(deriveOfficerUserIdFromEnvelope(zeroUsers), null);
});

test('deriveOfficerUserIdFromEnvelope: null for two User rows', () => {
	assert.equal(deriveOfficerUserIdFromEnvelope(withExtraUserRow(buildFixtureEnvelope())), null);
});

test('deriveOfficerUserIdFromEnvelope: null for a missing User table', () => {
	const envelope = buildFixtureEnvelope();
	const tables = { ...envelope.tables };
	delete tables.User;
	assert.equal(deriveOfficerUserIdFromEnvelope({ ...envelope, tables }), null);
});

// ---------------------------------------------------------------------------
// classifyRedemption -- all four SWAP_KINDS
// ---------------------------------------------------------------------------

test('classifyRedemption: new-network for a hash absent from the registry', () => {
	const envelope = buildFixtureEnvelope();
	const storage = makeFakeStorage();
	const classification = classifyRedemption({ envelope, storage });
	assert.equal(classification.kind, 'new-network');
	assert.equal(SWAP_KINDS.includes(classification.kind), true);
	assert.equal(classification.heldOfficerUserId, null);
	assert.equal(classification.incomingOfficerUserId, 'u1');
});

test('classifyRedemption: same-officer-refresh when the derived officer equals the held entry\'s officer', async () => {
	const baseline = await bootstrapFixtureNetwork();
	const classification = classifyRedemption({ envelope: baseline.envelope, storage: baseline.storage });
	assert.equal(classification.kind, 'same-officer-refresh');
	assert.equal(classification.heldOfficerUserId, 'u1');
	assert.equal(classification.incomingOfficerUserId, 'u1');
	await deleteNetworkDb(baseline.envelope.networkHash);
});

test('classifyRedemption: officer-swap when the derived officer differs from the held entry\'s officer', async () => {
	const baseline = await bootstrapFixtureNetwork();
	const swapEnvelope = buildSwapOfficerEnvelope(baseline.envelope);
	const classification = classifyRedemption({ envelope: swapEnvelope, storage: baseline.storage });
	assert.equal(classification.kind, 'officer-swap');
	assert.equal(classification.heldOfficerUserId, 'u1');
	assert.equal(classification.incomingOfficerUserId, 'u2');
	assert.equal(classification.authorityName, 'Fixture County Elections');
	await deleteNetworkDb(baseline.envelope.networkHash);
});

test('classifyRedemption: officer-indeterminate when the envelope\'s User table does not hold exactly one row', () => {
	const envelope = withExtraUserRow(buildFixtureEnvelope());
	const classification = classifyRedemption({ envelope, storage: makeFakeStorage() });
	assert.equal(classification.kind, 'officer-indeterminate');
	assert.equal(classification.incomingOfficerUserId, null);
});

// ---------------------------------------------------------------------------
// refreshNetwork -- the byte-intact control, once per failing outcome
// ---------------------------------------------------------------------------

test('refreshNetwork: digest-mismatch leaves the network byte-intact', async () => {
	const { envelope, storage, tableNames } = await bootstrapFixtureNetwork();
	const before = await captureNetworkState(envelope.networkHash, storage, tableNames);

	const transport = makeFakeTransport({ codeToResult: { [SECRET_2]: { status: 'ok', snapshot: envelope } } });
	const wrongDigestCode = `${SECRET_2}.${'z'.repeat(43)}`;
	const result = await refreshNetwork({ networkHash: envelope.networkHash, pastedCode: wrongDigestCode, transport, storage });

	assert.equal(result.outcome, 'verify-failed');
	assert.ok(result.outcome === 'verify-failed' && result.reason === 'digest-mismatch');
	const after = await captureNetworkState(envelope.networkHash, storage, tableNames);
	assert.doesNotThrow(() => assertNetworkStateUnchanged(before, after));
	await deleteNetworkDb(envelope.networkHash);
});

test('refreshNetwork: manifest-mismatch (dropped rows, untouched manifest) leaves the network byte-intact, and is NOT digest-mismatch', async () => {
	const { envelope, storage, tableNames } = await bootstrapFixtureNetwork();
	const before = await captureNetworkState(envelope.networkHash, storage, tableNames);

	const truncated = withDroppedRows(envelope, 'Registrant', 1);
	const transport = makeFakeTransport({ codeToResult: { [SECRET_2]: { status: 'ok', snapshot: truncated } } });
	const result = await refreshNetwork({ networkHash: envelope.networkHash, pastedCode: codeFor(envelope, SECRET_2), transport, storage });

	assert.equal(result.outcome, 'verify-failed');
	assert.ok(result.outcome === 'verify-failed' && result.reason === 'manifest-mismatch');
	assert.notEqual(/** @type {any} */ (result).reason, 'digest-mismatch');
	const after = await captureNetworkState(envelope.networkHash, storage, tableNames);
	assert.doesNotThrow(() => assertNetworkStateUnchanged(before, after));
	await deleteNetworkDb(envelope.networkHash);
});

test('refreshNetwork: schema-hash-mismatch leaves the network byte-intact', async () => {
	const { envelope, storage, tableNames } = await bootstrapFixtureNetwork();
	const before = await captureNetworkState(envelope.networkHash, storage, tableNames);

	const foreign = withForeignSchemaHash(envelope);
	const transport = makeFakeTransport({ codeToResult: { [SECRET_2]: { status: 'ok', snapshot: foreign } } });
	const result = await refreshNetwork({ networkHash: envelope.networkHash, pastedCode: codeFor(envelope, SECRET_2), transport, storage });

	assert.equal(result.outcome, 'verify-failed');
	assert.ok(result.outcome === 'verify-failed' && result.reason === 'schema-hash-mismatch');
	const after = await captureNetworkState(envelope.networkHash, storage, tableNames);
	assert.doesNotThrow(() => assertNetworkStateUnchanged(before, after));
	await deleteNetworkDb(envelope.networkHash);
});

test('refreshNetwork: code-refused leaves the network byte-intact', async () => {
	const { envelope, storage, tableNames } = await bootstrapFixtureNetwork();
	const before = await captureNetworkState(envelope.networkHash, storage, tableNames);

	const transport = makeFakeTransport({ codeToResult: { [SECRET_2]: { status: 'expired' } } });
	const result = await refreshNetwork({ networkHash: envelope.networkHash, pastedCode: codeFor(envelope, SECRET_2), transport, storage });

	assert.equal(result.outcome, 'code-refused');
	assert.ok(result.outcome === 'code-refused' && result.status === 'expired');
	const after = await captureNetworkState(envelope.networkHash, storage, tableNames);
	assert.doesNotThrow(() => assertNetworkStateUnchanged(before, after));
	await deleteNetworkDb(envelope.networkHash);
});

test('refreshNetwork: transport-unreachable leaves the network byte-intact', async () => {
	const { envelope, storage, tableNames } = await bootstrapFixtureNetwork();
	const before = await captureNetworkState(envelope.networkHash, storage, tableNames);

	const transport = makeFakeTransport({ codeToResult: { [SECRET_2]: new Error('network is down') } });
	const result = await refreshNetwork({ networkHash: envelope.networkHash, pastedCode: codeFor(envelope, SECRET_2), transport, storage });

	assert.equal(result.outcome, 'transport-unreachable');
	const after = await captureNetworkState(envelope.networkHash, storage, tableNames);
	assert.doesNotThrow(() => assertNetworkStateUnchanged(before, after));
	await deleteNetworkDb(envelope.networkHash);
});

test('refreshNetwork: officer-indeterminate leaves the network byte-intact', async () => {
	const { envelope, storage, tableNames } = await bootstrapFixtureNetwork();
	const before = await captureNetworkState(envelope.networkHash, storage, tableNames);

	const twoUsers = withExtraUserRow(envelope);
	const transport = makeFakeTransport({ codeToResult: { [SECRET_2]: { status: 'ok', snapshot: twoUsers } } });
	const result = await refreshNetwork({ networkHash: envelope.networkHash, pastedCode: codeFor(twoUsers, SECRET_2), transport, storage });

	assert.equal(result.outcome, 'officer-indeterminate');
	const after = await captureNetworkState(envelope.networkHash, storage, tableNames);
	assert.doesNotThrow(() => assertNetworkStateUnchanged(before, after));
	await deleteNetworkDb(envelope.networkHash);
});

// ---------------------------------------------------------------------------
// refreshNetwork -- the successful path rewrites the record AFTER the swap
// ---------------------------------------------------------------------------

test('refreshNetwork: on success, the row-count record is rewritten to the new manifest and bootstrappedAt advances', async () => {
	const { envelope, storage, tableNames } = await bootstrapFixtureNetwork();
	const preRefreshRecordKey = rowCountsKeyFor(envelope.networkHash);
	const preRefreshRecord = JSON.parse(/** @type {string} */ (storage.getItem(preRefreshRecordKey)));
	const preRefreshEntry = findNetwork(envelope.networkHash, storage);

	// A mutated cell (same row counts, new digest) is a legitimate "new
	// snapshot" for this test's purposes -- refreshNetwork does not care
	// WHY the content differs, only that it verifies.
	const newSnapshot = buildRefreshedEnvelope(envelope);
	const transport = makeFakeTransport({ codeToResult: { [SECRET_2]: { status: 'ok', snapshot: newSnapshot } } });
	const result = await refreshNetwork({
		networkHash: envelope.networkHash,
		pastedCode: codeFor(newSnapshot, SECRET_2),
		transport,
		storage,
	});

	assert.equal(result.outcome, 'ok');

	const postRefreshRecord = JSON.parse(/** @type {string} */ (storage.getItem(preRefreshRecordKey)));
	assert.deepEqual(postRefreshRecord.counts, newSnapshot.manifest);
	assert.ok(postRefreshRecord.capturedAt >= preRefreshRecord.capturedAt);

	const postRefreshEntry = findNetwork(envelope.networkHash, storage);
	assert.ok(/** @type {string} */ (postRefreshEntry?.bootstrappedAt) >= /** @type {string} */ (preRefreshEntry?.bootstrappedAt));

	const db = await attachNetworkDb(envelope.networkHash, { storage, expectedCounts: {} });
	const liveCounts = await readRowCounts(db, tableNames);
	assert.deepEqual(liveCounts, newSnapshot.manifest);
	await closeNetworkDb(db);

	await deleteNetworkDb(envelope.networkHash);
});

test('refreshNetwork: RowCountRecordNotUpdatedError names the network when the post-swap record vanishes, paired with the unmodified positive control above', async () => {
	const envelope = buildFixtureEnvelope();
	await deleteNetworkDb(envelope.networkHash).catch(() => undefined);
	const key = rowCountsKeyFor(envelope.networkHash);
	const storage = makeVanishingRowCountsStorage(key);

	const bootstrapTransport = makeFakeTransport({ codeToResult: { [SECRET]: { status: 'ok', snapshot: envelope } } });
	const bootstrapResult = await redeemAndBootstrap({ pastedCode: codeFor(envelope), transport: bootstrapTransport, storage });
	assert.equal(bootstrapResult.outcome, 'ok');
	storage._vanish();

	const newSnapshot = buildRefreshedEnvelope(envelope);
	const refreshTransport = makeFakeTransport({ codeToResult: { [SECRET_2]: { status: 'ok', snapshot: newSnapshot } } });

	await assert.rejects(
		() => refreshNetwork({ networkHash: envelope.networkHash, pastedCode: codeFor(newSnapshot, SECRET_2), transport: refreshTransport, storage }),
		(/** @type {any} */ err) => {
			assert.ok(err instanceof RowCountRecordNotUpdatedError);
			assert.equal(err.networkHash, envelope.networkHash);
			return true;
		},
	);

	// AND -- the anti-repair property this rejection exists to protect. The
	// old implementation derived its table set from a possibly-absent PRIOR
	// record, so an unreadable key produced `readRowCounts(db, [])` === `{}`,
	// and it then WROTE that `{}` over the correct manifest the swap had just
	// persisted. `assertRowCounts` iterates zero keys, so the network's
	// truncation check was silently disabled from then on. The stored record
	// must still be the real manifest, never an empty object.
	const persisted = JSON.parse(/** @type {string} */ (storage._raw(key)));
	assert.deepEqual(persisted.counts, newSnapshot.manifest);
	assert.notDeepEqual(persisted.counts, {});

	await deleteNetworkDb(envelope.networkHash);
});

// ---------------------------------------------------------------------------
// performOfficerSwap -- one code, one network call; identity and data
// change together; storage carries nothing extra.
// ---------------------------------------------------------------------------

test('performOfficerSwap: completes the classify-then-replace sequence with exactly ONE inner redeem call', async () => {
	const baseline = await bootstrapFixtureNetwork();
	const swapEnvelope = buildSwapOfficerEnvelope(baseline.envelope);
	const inner = makeFakeTransport({ codeToResult: { [SECRET_2]: { status: 'ok', snapshot: swapEnvelope } } });
	const singleFlight = createSingleFlightTransport(inner);

	// The classify pass -- the ONLY network round trip this whole sequence makes.
	const redemption = await redeemSignInCode(singleFlight.transport, SECRET_2);
	assert.equal(redemption.status, 'ok');
	const classification = classifyRedemption({
		envelope: /** @type {any} */ (redemption).snapshot,
		storage: baseline.storage,
	});
	assert.equal(classification.kind, 'officer-swap');

	const result = await performOfficerSwap({
		networkHash: baseline.envelope.networkHash,
		pastedCode: codeFor(swapEnvelope, SECRET_2),
		transport: singleFlight.transport,
		storage: baseline.storage,
	});

	assert.equal(result.outcome, 'ok');
	assert.equal(inner.calls.length, 1);
	assert.equal(singleFlight.innerCallCount, 1);

	// Identity AND data changed together, asserted in the same test.
	const entry = findNetwork(baseline.envelope.networkHash, baseline.storage);
	assert.equal(entry?.officerUserId, 'u2');
	const db = await attachNetworkDb(baseline.envelope.networkHash, { storage: baseline.storage, expectedCounts: {} });
	const liveCounts = await readRowCounts(db, baseline.tableNames);
	assert.deepEqual(liveCounts, swapEnvelope.manifest);
	await closeNetworkDb(db);

	// The storage double carries nothing beyond what redeemAndBootstrap
	// itself writes -- the two keys, no more.
	const keys = baseline.storage._keys().sort();
	assert.deepEqual(keys, [rowCountsKeyFor(baseline.envelope.networkHash), 'votetorrent.dashboard.networks'].sort());

	await deleteNetworkDb(baseline.envelope.networkHash);
});

test('a cancelled swap (classification computed, performOfficerSwap never called) leaves the prior database, record and registry entry all unchanged', async () => {
	const baseline = await bootstrapFixtureNetwork();
	const before = await captureNetworkState(baseline.envelope.networkHash, baseline.storage, baseline.tableNames);

	const swapEnvelope = buildSwapOfficerEnvelope(baseline.envelope);
	const classification = classifyRedemption({ envelope: swapEnvelope, storage: baseline.storage });
	assert.equal(classification.kind, 'officer-swap');
	// CANCELLED: performOfficerSwap is never called.

	const after = await captureNetworkState(baseline.envelope.networkHash, baseline.storage, baseline.tableNames);
	assert.doesNotThrow(() => assertNetworkStateUnchanged(before, after));

	await deleteNetworkDb(baseline.envelope.networkHash);
});
