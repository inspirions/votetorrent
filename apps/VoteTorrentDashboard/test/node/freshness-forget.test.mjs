/**
 * Tier-1 coverage of `src/lifecycle/freshness.js` (D-10's age arithmetic)
 * and `src/lifecycle/forget-network.js` (D-15's ordered delete).
 *
 * HONESTY NOTE: `fake-indexeddb` cannot demonstrate genuine durability of
 * data across a real browser reload, and it cannot demonstrate that a
 * deleted network is truly gone from disk. It can prove the ORDERING this
 * module enforces and the error classes it throws. That further proof is
 * Task 4's two-page browser gate, and no test name or assertion message in
 * this file may suggest otherwise.
 *
 * `import 'fake-indexeddb/auto'` first, then `node:test` + `node:assert/strict`.
 * Sequential and stateful against one shared fake IDB, per this project's
 * tier-1 discipline: a distinct network hash per test, with `deleteNetworkDb`
 * at the top of each.
 */
import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
	createNetworkDb,
	closeNetworkDb,
	deleteNetworkDb,
	dbNameFor,
	attachNetworkDb,
	readRowCounts,
	readRowCountsRecord,
	writeRowCounts,
	upsertNetwork,
	findNetwork,
	removeNetwork,
	listNetworks,
} from '@votetorrent/web-data/officer';
import { seedFoundingAuthority, SEED_TABLES } from '../fixtures/seed-founding-authority.js';
import { nowCanonicalDatetime } from '@votetorrent/vote-engine/browser';
import {
	STALE_THRESHOLD_HOURS,
	InvalidSnapshotInstantError,
	assertCanonicalInstant,
	snapshotAgeMillis,
	formatSnapshotAge,
	formatStaleThreshold,
	isSnapshotStale,
	snapshotFreshness,
} from '../../src/lifecycle/freshness.js';
import {
	ForgetConfirmationMismatchError,
	UnknownNetworkError,
	NetworkStillPresentError,
	forgetNetwork,
	assertNetworkForgotten,
} from '../../src/lifecycle/forget-network.js';

/** A tiny Map-backed localStorage-shaped fake -- Node 22 has no real `localStorage`. */
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
	};
}

/**
 * Seed a network directly (no full sign-in-code round trip needed here --
 * that path is 50-08's own suite) and register it, so `forgetNetwork` has
 * something real to delete.
 *
 * @param {string} hash
 * @param {string} authorityName
 */
async function setupNetwork(hash, authorityName) {
	await deleteNetworkDb(hash).catch(() => undefined);
	const storage = makeFakeStorage();
	const db = await createNetworkDb(hash);
	await seedFoundingAuthority(db);
	const counts = await readRowCounts(db, SEED_TABLES);
	await writeRowCounts(hash, counts, storage);
	upsertNetwork(
		{ networkHash: hash, authorityName, domain: 'fixture.example', officerUserId: 'u1', bootstrappedAt: nowCanonicalDatetime() },
		storage,
	);
	await closeNetworkDb(db);
	return { storage, counts };
}

// ---------------------------------------------------------------------------
// freshness.js — snapshotAgeMillis
// ---------------------------------------------------------------------------

test('snapshotAgeMillis: exactly 86400000ms between two canonical instants a day apart', () => {
	assert.equal(snapshotAgeMillis('2026-08-24T12:00:00', '2026-08-25T12:00:00'), 86_400_000);
});

test('snapshotAgeMillis: rejects a non-19-character instant, paired with a canonical value that succeeds', () => {
	assert.throws(
		() => snapshotAgeMillis('2026-08-24T12:00:0', '2026-08-25T12:00:00'),
		(/** @type {any} */ err) => {
			assert.ok(err instanceof InvalidSnapshotInstantError);
			assert.equal(err.label, 'bootstrappedAt');
			return true;
		},
	);
	assert.equal(snapshotAgeMillis('2026-08-24T12:00:00', '2026-08-24T12:00:00'), 0);
});

test('snapshotAgeMillis: rejects a Z-suffixed instant, paired with a canonical value that succeeds', () => {
	assert.throws(
		() => snapshotAgeMillis('2026-08-24T12:00:00', '2026-08-25T12:00:00Z'),
		(/** @type {any} */ err) => {
			assert.ok(err instanceof InvalidSnapshotInstantError);
			assert.equal(err.label, 'atCanonical');
			return true;
		},
	);
	assert.equal(snapshotAgeMillis('2026-08-24T12:00:00', '2026-08-25T12:00:00'), 86_400_000);
});

test('snapshotAgeMillis: rejects a non-canonical shape (space instead of "T"), paired with a canonical value that succeeds', () => {
	assert.throws(
		() => snapshotAgeMillis('2026-08-24 12:00:00', '2026-08-25T12:00:00'),
		InvalidSnapshotInstantError,
	);
	assert.equal(snapshotAgeMillis('2026-08-24T12:00:00', '2026-08-25T12:00:00'), 86_400_000);
});

test('assertCanonicalInstant: never interpolates the offending value into the thrown message', () => {
	const CANARY = 'not-canonical-value-xyz';
	assert.throws(
		() => assertCanonicalInstant(CANARY, 'someLabel'),
		(/** @type {any} */ err) => {
			assert.ok(!err.message.includes(CANARY));
			assert.ok(err.message.includes('someLabel'));
			return true;
		},
	);
});

test('snapshotFreshness: clock skew (bootstrappedAt later than the comparison instant) yields ageMillis 0 and skewed true, never a negative age', () => {
	const freshness = snapshotFreshness('2026-08-25T12:00:05', '2026-08-25T12:00:00');
	assert.equal(freshness.ageMillis, 0);
	assert.equal(freshness.skewed, true);
	assert.ok(freshness.ageMillis >= 0);
});

test('snapshotFreshness: no skew when bootstrappedAt is not later than the comparison instant', () => {
	const freshness = snapshotFreshness('2026-08-24T12:00:00', '2026-08-25T12:00:00');
	assert.equal(freshness.skewed, false);
	assert.equal(freshness.ageMillis, 86_400_000);
});

// ---------------------------------------------------------------------------
// freshness.js — formatSnapshotAge
// ---------------------------------------------------------------------------

test('formatSnapshotAge: 0ms and 30s both produce a non-throwing phrase containing no unexpected digit', () => {
	assert.doesNotThrow(() => formatSnapshotAge(0));
	assert.doesNotThrow(() => formatSnapshotAge(30_000));
	assert.equal(typeof formatSnapshotAge(0), 'string');
	assert.ok(formatSnapshotAge(0).length > 0);
});

test('formatSnapshotAge: selects the largest whole unit, asserted by unit (derived from Intl itself), not by hand-typed wording', () => {
	const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

	// 90 minutes reads in hours (floor(90/60) = 1 hour).
	assert.equal(formatSnapshotAge(90 * 60 * 1000), rtf.format(-1, 'hour'));

	// 50 hours reads in days (floor(50/24) = 2 days).
	assert.equal(formatSnapshotAge(50 * 60 * 60 * 1000), rtf.format(-2, 'day'));

	// 45 seconds reads in minutes-or-smaller — under a minute, it is seconds.
	assert.equal(formatSnapshotAge(45 * 1000), rtf.format(-45, 'second'));
});

// ---------------------------------------------------------------------------
// freshness.js — isSnapshotStale / formatStaleThreshold
// ---------------------------------------------------------------------------

test('isSnapshotStale: false at exactly the threshold, true one millisecond past it', () => {
	const thresholdMs = STALE_THRESHOLD_HOURS * 60 * 60 * 1000;
	assert.equal(isSnapshotStale(thresholdMs), false);
	assert.equal(isSnapshotStale(thresholdMs + 1), true);
});

test('formatStaleThreshold: contains the digits of STALE_THRESHOLD_HOURS and a unit word, derived from the constant rather than hardcoded', () => {
	const expected = new Intl.NumberFormat(undefined, { style: 'unit', unit: 'hour', unitDisplay: 'long' }).format(
		STALE_THRESHOLD_HOURS,
	);
	assert.equal(formatStaleThreshold(), expected);
	assert.ok(formatStaleThreshold().includes(String(STALE_THRESHOLD_HOURS)));
});

// ---------------------------------------------------------------------------
// freshness.js — snapshotFreshness shape
// ---------------------------------------------------------------------------

test('snapshotFreshness: returns the full shape, absolute byte-identical to the bootstrappedAt it was given', () => {
	const bootstrappedAt = '2026-08-20T00:00:00';
	const freshness = snapshotFreshness(bootstrappedAt, '2026-08-24T00:00:00');
	assert.equal(freshness.absolute, bootstrappedAt);
	assert.equal(typeof freshness.ageMillis, 'number');
	assert.equal(typeof freshness.relativeTime, 'string');
	assert.equal(typeof freshness.stale, 'boolean');
	assert.equal(typeof freshness.skewed, 'boolean');
	// Four days > 24h threshold.
	assert.equal(freshness.stale, true);
});

// ---------------------------------------------------------------------------
// forget-network.js — the centrepiece negative + its positive control
// ---------------------------------------------------------------------------

test('forgetNetwork: an EMPTY authorityName confirms nothing -- an empty input is refused, not satisfied', async () => {
	// bootstrap.js derives authorityName as '' whenever the snapshot has no
	// Authority row or a non-string Name, and the registry validator accepts
	// ''. `'' !== ''` is false, so an empty input used to PASS the typed
	// confirmation -- the only thing between a stray click and irreversible
	// deletion of the officer's whole local copy.
	const hash = 'forget-empty-expected';
	const { storage, counts } = await setupNetwork(hash, '');

	for (const typed of ['', '   ', 'anything']) {
		// eslint-disable-next-line no-await-in-loop
		await assert.rejects(
			() => forgetNetwork({ networkHash: hash, typedConfirmation: typed, storage }),
			(/** @type {any} */ err) => err instanceof ForgetConfirmationMismatchError,
			`typedConfirmation ${JSON.stringify(typed)} was accepted against an empty expected name`,
		);
	}

	// Measured, not inferred from the throw: everything is still here.
	assert.ok(findNetwork(hash, storage));
	assert.deepEqual((await readRowCountsRecord(hash, storage))?.counts, counts);
	const reopened = await attachNetworkDb(hash, { storage });
	assert.deepEqual(await readRowCounts(reopened, Object.keys(counts)), counts);
	await closeNetworkDb(reopened);
	await deleteNetworkDb(hash, { storage });
});

test('positive control: a NON-empty authorityName still forgets when typed exactly', async () => {
	const hash = 'forget-empty-control';
	const { storage } = await setupNetwork(hash, 'Nonempty Authority');
	const result = await forgetNetwork({ networkHash: hash, typedConfirmation: 'Nonempty Authority', storage });
	assert.equal(result.networkHash, hash);
	assert.equal(findNetwork(hash, storage), undefined);
});

test('forgetNetwork: a typed confirmation that does not match authorityName throws, and the database still exists afterward -- measured, not just by the throw', async () => {
	const hash = 'forget-mismatch';
	const { storage, counts } = await setupNetwork(hash, 'Mismatch Authority');
	const db = await attachNetworkDb(hash, { storage });

	await assert.rejects(
		() => forgetNetwork({ networkHash: hash, typedConfirmation: 'Wrong Name Entirely', db, storage }),
		(/** @type {any} */ err) => {
			assert.ok(err instanceof ForgetConfirmationMismatchError);
			return true;
		},
	);
	await closeNetworkDb(db);

	// Measured: reopen and prove the database, the registry entry and the
	// row-count record are all still exactly as they were.
	const reopened = await attachNetworkDb(hash, { storage });
	const live = await readRowCounts(reopened, Object.keys(counts));
	assert.deepEqual(live, counts);
	await closeNetworkDb(reopened);
	assert.ok(findNetwork(hash, storage));
	assert.deepEqual((await readRowCountsRecord(hash, storage))?.counts, counts);

	await deleteNetworkDb(hash);
});

test('forgetNetwork: a matching typed confirmation deletes the database, clears the row-count record and removes the registry entry', async () => {
	const hash = 'forget-match';
	const { storage } = await setupNetwork(hash, 'Match Authority');
	const db = await attachNetworkDb(hash, { storage });

	const result = await forgetNetwork({ networkHash: hash, typedConfirmation: 'Match Authority', db, storage });

	assert.equal(result.networkHash, hash);
	assert.deepEqual(result.remaining, listNetworks(storage));
	assert.equal(findNetwork(hash, storage), undefined);
	assert.equal(await readRowCountsRecord(hash, storage), undefined);
	await assertNetworkForgotten(hash, storage);
});

test('forgetNetwork: leading/trailing whitespace in the typed confirmation is trimmed before comparison', async () => {
	const hash = 'forget-trim';
	const { storage } = await setupNetwork(hash, 'Trimmed Authority');
	const db = await attachNetworkDb(hash, { storage });

	const result = await forgetNetwork({ networkHash: hash, typedConfirmation: '  Trimmed Authority  ', db, storage });
	assert.equal(findNetwork(hash, storage), undefined);
	assert.deepEqual(result.remaining, []);
});

// ---------------------------------------------------------------------------
// forget-network.js — unknown network
// ---------------------------------------------------------------------------

test('forgetNetwork: an unknown network hash throws UnknownNetworkError naming the hash and deletes nothing', async () => {
	const storage = makeFakeStorage();
	await assert.rejects(
		() => forgetNetwork({ networkHash: 'no-such-network', typedConfirmation: 'whatever', storage }),
		(/** @type {any} */ err) => {
			assert.ok(err instanceof UnknownNetworkError);
			assert.ok(err.message.includes('no-such-network'));
			return true;
		},
	);
});

// ---------------------------------------------------------------------------
// forget-network.js — blocked delete leaves the network listed and retryable
// ---------------------------------------------------------------------------

test('forgetNetwork: a delete blocked by another open connection rejects DeleteBlockedError by name, and the registry entry and row-count record both survive', async () => {
	const hash = 'forget-blocked';
	const { storage, counts } = await setupNetwork(hash, 'Blocked Authority');
	const db = await attachNetworkDb(hash, { storage });

	// Hold a SECOND raw connection open across the call, per
	// test/node/db-delete.test.mjs's idiom, to force the blocked path.
	const blockingConn = await new Promise((resolve, reject) => {
		const req = indexedDB.open(dbNameFor(hash));
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});

	await assert.rejects(
		() => forgetNetwork({ networkHash: hash, typedConfirmation: 'Blocked Authority', db, storage, timeoutMs: 200 }),
		(/** @type {any} */ err) => {
			assert.equal(err.name, 'DeleteBlockedError');
			return true;
		},
	);

	/** @type {any} */ (blockingConn).close();
	await closeNetworkDb(db);

	assert.ok(findNetwork(hash, storage), 'the network stays listed after a blocked delete');
	assert.deepEqual((await readRowCountsRecord(hash, storage))?.counts, counts, 'the row-count record survives a blocked delete');

	await deleteNetworkDb(hash); // clean slate for later tests
});

// ---------------------------------------------------------------------------
// assertNetworkForgotten
// ---------------------------------------------------------------------------

test('assertNetworkForgotten: throws NetworkStillPresentError naming a surviving registry entry, paired with a fully-forgotten positive control', async () => {
	const hash = 'assert-forgotten-registry';
	const { storage } = await setupNetwork(hash, 'Registry Survivor Authority');
	const db = await attachNetworkDb(hash, { storage });
	await deleteNetworkDb(hash, { db });
	// registry entry NOT removed -- simulate a partial state.

	await assert.rejects(
		() => assertNetworkForgotten(hash, storage),
		(/** @type {any} */ err) => {
			assert.ok(err instanceof NetworkStillPresentError);
			assert.equal(err.survivor, 'registry entry');
			return true;
		},
	);

	// Positive control: a genuinely fully-forgotten network resolves.
	const cleanHash = 'assert-forgotten-clean';
	const clean = await setupNetwork(cleanHash, 'Clean Authority');
	const cleanDb = await attachNetworkDb(cleanHash, { storage: clean.storage });
	await forgetNetwork({ networkHash: cleanHash, typedConfirmation: 'Clean Authority', db: cleanDb, storage: clean.storage });
	await assert.doesNotReject(() => assertNetworkForgotten(cleanHash, clean.storage));
});

test('assertNetworkForgotten: throws NetworkStillPresentError naming a surviving row-count record, paired with a fully-forgotten positive control', async () => {
	const hash = 'assert-forgotten-rowcounts';
	const { storage } = await setupNetwork(hash, 'Row-Count Survivor Authority');
	const db = await attachNetworkDb(hash, { storage });
	await deleteNetworkDb(hash, { db });
	removeNetwork(hash, storage);
	// Re-write the row-count record AFTER deletion and after the registry
	// entry is removed, so only that ONE artefact survives.
	await writeRowCounts(hash, { Authority: 1 }, storage);

	await assert.rejects(
		() => assertNetworkForgotten(hash, storage),
		(/** @type {any} */ err) => {
			assert.ok(err instanceof NetworkStillPresentError);
			assert.equal(err.survivor, 'row-count record');
			return true;
		},
	);

	// Positive control: a genuinely fully-forgotten network resolves.
	const cleanHash = 'assert-forgotten-clean-2';
	const clean = await setupNetwork(cleanHash, 'Clean Authority Two');
	const cleanDb = await attachNetworkDb(cleanHash, { storage: clean.storage });
	await forgetNetwork({ networkHash: cleanHash, typedConfirmation: 'Clean Authority Two', db: cleanDb, storage: clean.storage });
	await assert.doesNotReject(() => assertNetworkForgotten(cleanHash, clean.storage));
});

// ---------------------------------------------------------------------------
// PII hygiene
// ---------------------------------------------------------------------------

test('PII-CANARY-9f3a: no thrown message from any error path in freshness.js or forget-network.js contains the marker', async () => {
	const CANARY = 'PII-CANARY-9f3a';
	/** @type {string[]} */
	const messages = [];

	try {
		// The LABEL is a code-controlled constant, never snapshot content, so
		// the module is expected to include it verbatim -- only the VALUE
		// (the canary here) must never leak. `atCanonical` names the label.
		assertCanonicalInstant(CANARY, 'atCanonical');
	} catch (/** @type {any} */ err) {
		messages.push(err.message);
	}
	try {
		snapshotAgeMillis(CANARY, '2026-01-01T00:00:00');
	} catch (/** @type {any} */ err) {
		messages.push(err.message);
	}
	try {
		snapshotFreshness(CANARY);
	} catch (/** @type {any} */ err) {
		messages.push(err.message);
	}

	const hash = 'forget-canary';
	const { storage } = await setupNetwork(hash, CANARY);
	const db = await attachNetworkDb(hash, { storage });
	try {
		await forgetNetwork({ networkHash: hash, typedConfirmation: `${CANARY}-wrong`, db, storage });
	} catch (/** @type {any} */ err) {
		messages.push(err.message);
	}
	await closeNetworkDb(db);

	try {
		await assertNetworkForgotten(hash, storage);
	} catch (/** @type {any} */ err) {
		messages.push(err.message);
	}

	assert.ok(messages.length >= 5, `expected every forced error path to be exercised, got ${messages.length}`);
	for (const message of messages) {
		assert.ok(!message.includes(CANARY), `error message leaked the PII canary: "${message}"`);
	}

	await deleteNetworkDb(hash);
});
