/**
 * peer-reactivity-bridge.test.mjs — behaviour contract for
 * `src/peer/reactivity-bridge.js` (`56-09` Task 2).
 *
 * The fakes below are fakes of the SEAMS this module reads, never of the
 * module itself:
 *   - a fake `node` exposing only `cohortTopicHost.service` and
 *     `reactivitySubscribers` (the latter is the REAL
 *     `ReactivitySubscriberRegistry` from `@optimystic/db-p2p` — a plain
 *     in-memory routing table with no I/O, so using the real class is
 *     simpler than reimplementing its contract and does not compromise the
 *     "fake the seam" discipline);
 *   - a fake `CohortTopicService` whose `verifier().verifyMessage(...)`
 *     resolves a caller-controlled `VerifyResult` — this is what lets a
 *     synthetic `NotificationV1` (no real threshold signature) drive the
 *     REAL `ReactivitySubscriptionManager` / db-core delivery path end to
 *     end, at Node tier, without a live cohort;
 *   - a fake `Database` exposing `schemaManager` and
 *     `ingestExternalRowChanges`, plus a store module whose
 *     `applyExternalRowChanges` returns a caller-controlled
 *     `BackingRowChange[]`;
 *   - a REAL `subscribeToPublicChanges` subscription on that same fake
 *     handle, so every notice-content assertion below runs through the
 *     real `subscribe.js` code this module calls into, not a stand-in.
 *
 * Every notification fixture is delivered through
 * `node.reactivitySubscribers.deliver(topicId, n)` — the real socket-delivery
 * seam the forwarder host uses — never by calling anything on the bridge's
 * private `onVerifiedNotification` directly (it is not exported).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { bytesToB64url } from '@optimystic/db-core';
import { ReactivitySubscriberRegistry, reactivityTailBytes } from '@optimystic/db-p2p';
import { reactivityTopicId } from '@optimystic/db-core';
import { PUBLIC_SUBSCRIBED_TABLES } from '@votetorrent/web-data/public';
import { publicSrc, moduleUrl } from '../../../../scripts/lib/source-paths.mjs';
import {
	PeerReplicationError,
	resolveCohortTopicService,
	resolveSubscriberRegistry,
	resolvePublicStoreModule,
	applyPeerRowBatch,
	startPeerReplication,
} from '../../src/peer/reactivity-bridge.js';

/**
 * `ReactivitySubscriberRegistry.deliver` is FIRE-AND-FORGET by upstream's own
 * design: it calls the handler synchronously and chains an isolating
 * `.catch` on the returned promise, but never awaits it, and the db-core
 * `CollectionSubscriber.onNotification` this module's manager drives ALSO
 * calls `deps.deliver(n)` (this module's `onVerifiedNotification`) without
 * awaiting it. So the actual `readRows` -> `applyPeerRowBatch` ->
 * `notifyPeerWrite` chain keeps running as a detached microtask chain after
 * `registry.deliver(...)` returns. A single `setImmediate` tick is enough to
 * observe it: Node drains the ENTIRE microtask queue (including a chain with
 * several `await` hops) before running any macrotask/immediate callback, and
 * this module's body schedules no timer of its own.
 * @returns {Promise<void>}
 */
function flush() {
	return new Promise((resolve) => setImmediate(resolve));
}

/**
 * A call-recording spy. `calls` is the ARGUMENT LISTS.
 * @param {(...args: any[]) => any} [impl]
 */
function spy(impl = () => undefined) {
	/** @type {any[][]} */
	const calls = [];
	/** @type {any} */
	const fn = (/** @type {any[]} */ ...args) => {
		calls.push(args);
		return impl(...args);
	};
	fn.calls = calls;
	return fn;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A real, subscribed table -- production-length by the repo's own fixture
 * mandate, and it must be a genuine member of the derived allowlist so the
 * "allowed" tests are not vacuous. @type {string} */
const VALID_TABLE = PUBLIC_SUBSCRIBED_TABLES[0];

/** A table this repo's classification never allows an anonymous reader to
 * see, used only to prove the allowlist refuses whole. @type {string} */
const FORBIDDEN_TABLE = 'RegistrationBridgeKey';

const NETWORK_HASH = 'aBcDeF0123456789aBcDeF0123456789fixture';

const COLLECTION_ID = new TextEncoder().encode('vt-fixture-collection-id-0123456789abcdef');
const COLLECTION_ID_B64 = bytesToB64url(COLLECTION_ID);
const TAIL_ID = 'vt-fixture-tail-block-id-0123456789abcdef';
const TAIL_BYTES = reactivityTailBytes(TAIL_ID);
const TAIL_ID_B64 = bytesToB64url(TAIL_BYTES);
const TOPIC_ID = reactivityTopicId(TAIL_BYTES);

/** A sentinel that must never reach a `notifyPeerWrite` argument or a
 * delivered notice -- planted inside an applied row's image. @type {string} */
const SECRET = 'PLANTED-ROW-SECRET-MUST-NOT-ESCAPE-0123456789';

/**
 * A syntactically-valid `NotificationV1` fixture. The signature/digest/signer
 * fields are dummy base64url text -- valid enough for `b64urlToBytes` to
 * decode without throwing, never actually verified because the fake
 * service's `verifyMessage` below returns a caller-controlled verdict
 * unconditionally.
 * @param {{ revision: number, invalidation?: boolean }} opts
 * @returns {any}
 */
function makeNotification({ revision, invalidation }) {
	return {
		v: 1,
		collectionId: COLLECTION_ID_B64,
		tailId: TAIL_ID_B64,
		revision,
		digest: bytesToB64url(new TextEncoder().encode(`digest-${revision}`)),
		timestamp: Date.now(),
		sig: bytesToB64url(new TextEncoder().encode(`sig-${revision}`)),
		signers: [bytesToB64url(new TextEncoder().encode('signer-1'))],
		...(invalidation !== undefined ? { invalidation } : {}),
	};
}

/**
 * A fake `CohortTopicService`. `verifyResult` controls every
 * `verifier().verifyMessage(...)` call -- default `'verified'`, the "trust
 * the origin" precondition this module's header names.
 * @param {{ verifyResult?: 'verified' | 'untrusted' }} [opts]
 */
function makeFakeService(opts = {}) {
	const verifyResult = opts.verifyResult ?? 'verified';
	const withdraw = spy(async () => undefined);
	const register = spy(async (/** @type {any} */ req) => ({
		topicId: req.topicId,
		tier: req.tier,
		primary: new Uint8Array([1]),
		backups: [],
		cohortEpoch: new Uint8Array([2]),
		cohortMembers: [],
		renewal: {},
	}));
	return {
		register,
		renew: spy(async () => undefined),
		withdraw,
		lookup: spy(async () => {
			throw new Error('lookup: not exercised by this fixture');
		}),
		cohortGossip: () => ({}),
		verifier: () => ({ verifyMessage: async () => verifyResult }),
	};
}

/**
 * A fake `OptimysticNode`, exposing only the two untyped attachments this
 * module reads.
 * @param {{ service?: any, registry?: any, omitCohortTopicHost?: boolean, omitSubscribers?: boolean }} [opts]
 */
function makeFakeNode(opts = {}) {
	const service = opts.service ?? makeFakeService();
	const registry = opts.registry ?? new ReactivitySubscriberRegistry();
	/** @type {any} */
	const node = {};
	if (!opts.omitCohortTopicHost) node.cohortTopicHost = { service };
	if (!opts.omitSubscribers) node.reactivitySubscribers = registry;
	return { node, service, registry };
}

/**
 * A fake externally-writable store table.
 * @param {(ops: readonly any[]) => Promise<any[]> | any[]} applyImpl
 */
function makeFakeStoreTable(applyImpl) {
	const applyExternalRowChanges = spy(async (/** @type {readonly any[]} */ ops) => applyImpl(ops));
	return { applyExternalRowChanges };
}

/**
 * A fake `Database`. `storeTable` is what `getTableForExternalWrite` returns
 * for `VALID_TABLE`; `undefined` for any other table name, mirroring
 * `snapshot-restore.js`'s own store-module contract.
 * @param {{ storeTable?: any, isolationWrap?: boolean, noModule?: boolean }} [opts]
 */
function makeFakeDb(opts = {}) {
	const ingestExternalRowChanges = spy(async () => undefined);
	const moduleCore = {
		getTableForExternalWrite: spy((/** @type {any} */ _db, /** @type {string} */ _schema, /** @type {string} */ tableName) =>
			tableName === VALID_TABLE ? opts.storeTable : undefined,
		),
	};
	const registeredModule = opts.noModule
		? undefined
		: opts.isolationWrap
			? { module: { underlying: moduleCore } }
			: { module: moduleCore };
	/** @type {any} */
	const db = {
		schemaManager: {
			getModule: spy((/** @type {string} */ _name) => registeredModule),
			getCurrentSchemaName: () => 'main',
			getTable: () => ({ name: VALID_TABLE, columns: [] }),
		},
		ingestExternalRowChanges,
		// A no-op release is enough: `subscribeToPublicChanges` only needs
		// `onDataChange` to be a function to report `live: true` and register
		// into `subscribe.js`'s own `REMOTE_SINKS`, which is the channel
		// `notifyPeerWrite`'s local dispatch actually feeds.
		onDataChange: () => () => undefined,
	};
	return { db, ingestExternalRowChanges, moduleCore };
}

// ---------------------------------------------------------------------------
// 1. resolveCohortTopicService / resolveSubscriberRegistry
// ---------------------------------------------------------------------------

test('resolveCohortTopicService returns node.cohortTopicHost.service when present', () => {
	const { node, service } = makeFakeNode();
	assert.equal(resolveCohortTopicService(node), service);
});

test('resolveCohortTopicService throws PeerReplicationError naming the missing attachment, never returns undefined', () => {
	const { node } = makeFakeNode({ omitCohortTopicHost: true });
	assert.throws(
		() => resolveCohortTopicService(node),
		(/** @type {any} */ err) => err instanceof PeerReplicationError && err.subject === 'cohortTopicHost',
	);
});

test('resolveSubscriberRegistry returns node.reactivitySubscribers when present', () => {
	const { node, registry } = makeFakeNode();
	assert.equal(resolveSubscriberRegistry(node), registry);
});

test('resolveSubscriberRegistry throws PeerReplicationError naming the missing attachment, never returns undefined', () => {
	const { node } = makeFakeNode({ omitSubscribers: true });
	assert.throws(
		() => resolveSubscriberRegistry(node),
		(/** @type {any} */ err) => err instanceof PeerReplicationError && err.subject === 'reactivitySubscribers',
	);
});

// ---------------------------------------------------------------------------
// 2. resolvePublicStoreModule
// ---------------------------------------------------------------------------

test('resolvePublicStoreModule returns the module directly when it exposes getTableForExternalWrite', () => {
	const { db, moduleCore } = makeFakeDb({ storeTable: makeFakeStoreTable(() => []) });
	assert.equal(resolvePublicStoreModule(db), moduleCore);
});

test('resolvePublicStoreModule unwraps an isolation wrapper\'s underlying module', () => {
	const { db, moduleCore } = makeFakeDb({ storeTable: makeFakeStoreTable(() => []), isolationWrap: true });
	assert.equal(resolvePublicStoreModule(db), moduleCore);
});

test('resolvePublicStoreModule throws PeerReplicationError naming STORE_MODULE_NAME when no module is registered', () => {
	const { db } = makeFakeDb({ noModule: true });
	assert.throws(
		() => resolvePublicStoreModule(db),
		(/** @type {any} */ err) => err instanceof PeerReplicationError && err.subject === 'store',
	);
});

// ---------------------------------------------------------------------------
// 3. applyPeerRowBatch
// ---------------------------------------------------------------------------

test('applyPeerRowBatch refuses a table outside PUBLIC_SUBSCRIBED_TABLES and applies nothing', async () => {
	assert.ok(!PUBLIC_SUBSCRIBED_TABLES.includes(FORBIDDEN_TABLE), 'fixture sanity: FORBIDDEN_TABLE must not be a real member of the allowlist');
	const { db } = makeFakeDb({ storeTable: makeFakeStoreTable(() => []) });
	await assert.rejects(
		applyPeerRowBatch(db, FORBIDDEN_TABLE, [{ op: 'upsert', row: ['x'] }]),
		(/** @type {any} */ err) => err instanceof PeerReplicationError && err.subject === FORBIDDEN_TABLE,
	);
});

test('applyPeerRowBatch returns the effective BackingRowChange[] the store table reports and applies through ingestExternalRowChanges once', async () => {
	const changes = [{ op: 'insert', newRow: ['a'] }];
	const storeTable = makeFakeStoreTable(() => changes);
	const { db, ingestExternalRowChanges } = makeFakeDb({ storeTable });
	const result = await applyPeerRowBatch(db, VALID_TABLE, [{ op: 'upsert', row: ['a'] }]);
	assert.deepEqual(result, changes);
	assert.equal(storeTable.applyExternalRowChanges.calls.length, 1);
	assert.equal(ingestExternalRowChanges.calls.length, 1);
	const [batches, options] = ingestExternalRowChanges.calls[0];
	assert.equal(batches.length, 1);
	assert.equal(batches[0].tableName, VALID_TABLE);
	assert.deepEqual(options, { captureChanges: false, applyForeignKeyActions: false });
});

test('applyPeerRowBatch returns an empty array for a value-identical batch, and does not call ingestExternalRowChanges', async () => {
	const storeTable = makeFakeStoreTable(() => []);
	const { db, ingestExternalRowChanges } = makeFakeDb({ storeTable });
	const result = await applyPeerRowBatch(db, VALID_TABLE, [{ op: 'upsert', row: ['a'] }]);
	assert.deepEqual(result, []);
	assert.equal(ingestExternalRowChanges.calls.length, 0, 'an empty effective-change batch must not reach ingestExternalRowChanges');
});

test('applyPeerRowBatch throws PeerReplicationError naming the table when the store module has no externally-writable handle for it', async () => {
	const { db } = makeFakeDb({ storeTable: undefined });
	await assert.rejects(
		applyPeerRowBatch(db, VALID_TABLE, [{ op: 'upsert', row: ['a'] }]),
		(/** @type {any} */ err) => err instanceof PeerReplicationError && err.subject === VALID_TABLE,
	);
});

// ---------------------------------------------------------------------------
// 4. startPeerReplication -- required options
// ---------------------------------------------------------------------------

/** @returns {any} a syntactically complete, otherwise-valid options object. */
function validOptions() {
	const { db } = makeFakeDb({ storeTable: makeFakeStoreTable(() => []) });
	const { node } = makeFakeNode();
	return {
		db,
		networkHash: NETWORK_HASH,
		node,
		collectionId: COLLECTION_ID,
		tailId: TAIL_ID,
		readRows: async () => [],
	};
}

test('startPeerReplication throws PeerReplicationError naming each of the six required options when omitted', async () => {
	for (const key of ['db', 'networkHash', 'node', 'collectionId', 'tailId', 'readRows']) {
		const options = validOptions();
		delete options[key];
		await assert.rejects(
			startPeerReplication(options),
			(/** @type {any} */ err) => err instanceof PeerReplicationError && err.subject === key,
			`omitting "${key}" did not throw PeerReplicationError naming it`,
		);
	}
});

test('readRows has no default: a non-function readRows throws naming "readRows" rather than silently starting', async () => {
	const options = validOptions();
	options.readRows = undefined;
	await assert.rejects(
		startPeerReplication(options),
		(/** @type {any} */ err) => err instanceof PeerReplicationError && err.subject === 'readRows',
	);
});

test('a complete options object starts successfully and returns a handle with an idempotent stop()', async () => {
	const options = validOptions();
	const handle = await startPeerReplication(options);
	assert.equal(typeof handle.stop, 'function');
	await handle.stop();
	await handle.stop(); // idempotent -- must not throw a second time
});

// ---------------------------------------------------------------------------
// 5. startPeerReplication -- the notify loop, driven through a REAL delivered
//    notification (node.reactivitySubscribers.deliver), never by calling a
//    private module function.
// ---------------------------------------------------------------------------

/**
 * Starts the bridge with a fresh service/node/registry and a real
 * `subscribeToPublicChanges` subscription wired onto the same `db`.
 *
 * `startPeerReplicationImpl` defaults to the real, imported
 * `startPeerReplication` — Task 3's isolation control (below) passes the
 * MUTATED copy's export instead, so the exact same harness drives both the
 * happy-path behaviour tests above and the source-transform control, and the
 * two can never silently diverge in what they exercise.
 * @param {any} storeTable
 * @param {(projected: any) => Promise<any[]>} readRows
 * @param {(options: any) => Promise<any>} [startPeerReplicationImpl]
 */
async function startHarness(storeTable, readRows, startPeerReplicationImpl = startPeerReplication) {
	const { subscribeToPublicChanges } = await import('@votetorrent/web-data/public');
	const { db } = makeFakeDb({ storeTable });
	const { node, service, registry } = makeFakeNode();
	/** @type {any[]} */
	const notices = [];
	const subscription = subscribeToPublicChanges(db, (/** @type {any} */ notice) => notices.push(notice));
	assert.equal(subscription.live, true, 'harness sanity: the fake db must expose a live change channel');
	const handle = await startPeerReplicationImpl({
		db,
		networkHash: NETWORK_HASH,
		node,
		collectionId: COLLECTION_ID,
		tailId: TAIL_ID,
		readRows,
	});
	return { db, node, service, registry, notices, handle, subscription };
}

test('on a delivered notification, readRows is called exactly once and its argument is a NEW frozen object with exactly {collectionId, revision, invalidation}', async () => {
	const readRowsSpy = spy(async () => []);
	const { registry } = await startHarness(makeFakeStoreTable(() => []), readRowsSpy);
	const notification = makeNotification({ revision: 1, invalidation: false });

	registry.deliver(TOPIC_ID, notification);
	await flush();

	assert.equal(readRowsSpy.calls.length, 1);
	const [projected] = readRowsSpy.calls[0];
	assert.notEqual(projected, notification, 'readRows must receive a NEW object, never the notification itself');
	assert.deepEqual(Object.keys(projected).sort(), ['collectionId', 'invalidation', 'revision']);
	assert.equal(projected.collectionId, COLLECTION_ID_B64);
	assert.equal(projected.revision, 1);
	assert.equal(projected.invalidation, false);
	assert.ok(Object.isFrozen(projected));
});

test('the bridge applies each returned batch and calls notifyPeerWrite once per distinct (table, op) pair present in the effective changes', async () => {
	const storeTable = makeFakeStoreTable(() => [
		{ op: 'insert', newRow: ['a'] },
		{ op: 'insert', newRow: ['b'] }, // same op -- must not double-notify
		{ op: 'update', oldRow: ['c'], newRow: ['d'] },
	]);
	const { registry, notices } = await startHarness(storeTable, async () => [{ table: VALID_TABLE, ops: [{ op: 'upsert', row: ['a'] }] }]);

	registry.deliver(TOPIC_ID, makeNotification({ revision: 1 }));
	await flush();

	// Two distinct (table, op) pairs -> exactly two notices, never three.
	assert.equal(notices.length, 2, `expected exactly 2 notices for 2 distinct (table, op) pairs, got ${notices.length}`);
	assert.deepEqual(
		notices.map((/** @type {any} */ n) => `${n.table}:${n.type}`).sort(),
		[`${VALID_TABLE}:insert`, `${VALID_TABLE}:update`].sort(),
	);
	for (const n of notices) {
		assert.equal(n.remote, true);
		assert.deepEqual(Object.keys(n).sort(), ['remote', 'table', 'type']);
	}
});

test('a notification whose readRows yields batches producing no effective change results in ZERO notifyPeerWrite calls', async () => {
	const storeTable = makeFakeStoreTable(() => []); // value-identical: reports nothing
	const { registry, notices } = await startHarness(storeTable, async () => [{ table: VALID_TABLE, ops: [{ op: 'upsert', row: ['a'] }] }]);

	registry.deliver(TOPIC_ID, makeNotification({ revision: 1 }));
	await flush();

	assert.equal(notices.length, 0);
});

test('a batch naming a table outside PUBLIC_SUBSCRIBED_TABLES is refused whole and produces no notice, without throwing out of the delivery path', async () => {
	const storeTable = makeFakeStoreTable(() => [{ op: 'insert', newRow: ['a'] }]);
	const { registry, notices } = await startHarness(storeTable, async () => [
		{ table: FORBIDDEN_TABLE, ops: [{ op: 'upsert', row: ['a'] }] },
	]);

	// Must not reject the registry's fan-out (it isolates handler throws
	// itself, but this module's own body must ALSO never let one escape).
	registry.deliver(TOPIC_ID, makeNotification({ revision: 1 }));
	await flush();

	assert.equal(notices.length, 0);
});

test('a rejecting readRows is caught, logs the error NAME only, fires no notice, and the subscription stays registered for the next notification', async () => {
	let call = 0;
	const storeTable = makeFakeStoreTable(() => [{ op: 'insert', newRow: ['a'] }]);
	const { registry, notices } = await startHarness(storeTable, async () => {
		call += 1;
		if (call === 1) {
			const err = new Error('synthetic readRows failure');
			err.name = 'SyntheticReadRowsError';
			throw err;
		}
		return [{ table: VALID_TABLE, ops: [{ op: 'upsert', row: ['a'] }] }];
	});

	const original = console.error;
	/** @type {any[][]} */
	const logged = [];
	console.error = (/** @type {any[]} */ ...args) => logged.push(args);
	try {
		registry.deliver(TOPIC_ID, makeNotification({ revision: 1 }));
		await flush();
	} finally {
		console.error = original;
	}
	assert.equal(notices.length, 0, 'the failed notification must fire no notice');
	assert.ok(
		logged.some((args) => args.includes('SyntheticReadRowsError')),
		'the error NAME must have been logged',
	);
	assert.ok(
		!logged.some((args) => args.some((a) => typeof a === 'string' && a.includes('synthetic readRows failure'))),
		'the error MESSAGE must never be logged',
	);

	// The subscriber's fresh-subscribe baseline adopts revision 1 regardless
	// of this module's internal (caught) failure -- deliver a contiguous
	// revision 2 and confirm the handler is still live and functions.
	registry.deliver(TOPIC_ID, makeNotification({ revision: 2 }));
	await flush();
	assert.equal(notices.length, 1, 'the subscription did not survive the earlier failure to receive a later notification');
	assert.equal(notices[0].table, VALID_TABLE);
});

test('an applyPeerRowBatch throw (a refused batch) is caught the same way: no notice fires, and a later notification still delivers', async () => {
	const storeTable = makeFakeStoreTable(() => [{ op: 'insert', newRow: ['a'] }]);
	let call = 0;
	const { registry, notices } = await startHarness(storeTable, async () => {
		call += 1;
		return call === 1
			? [{ table: FORBIDDEN_TABLE, ops: [{ op: 'upsert', row: ['a'] }] }]
			: [{ table: VALID_TABLE, ops: [{ op: 'upsert', row: ['a'] }] }];
	});

	const original = console.error;
	console.error = () => undefined;
	try {
		registry.deliver(TOPIC_ID, makeNotification({ revision: 1 }));
		await flush();
	} finally {
		console.error = original;
	}
	assert.equal(notices.length, 0);

	registry.deliver(TOPIC_ID, makeNotification({ revision: 2 }));
	await flush();
	assert.equal(notices.length, 1);
});

test('a sentinel value planted in an applied row never reaches a delivered notice', async () => {
	const storeTable = makeFakeStoreTable(() => [{ op: 'insert', newRow: [SECRET, 'other-field'] }]);
	const { registry, notices } = await startHarness(storeTable, async () => [
		{ table: VALID_TABLE, ops: [{ op: 'upsert', row: [SECRET, 'other-field'] }] },
	]);

	registry.deliver(TOPIC_ID, makeNotification({ revision: 1 }));
	await flush();

	assert.equal(notices.length, 1);
	assert.ok(!JSON.stringify(notices).includes(SECRET), 'the planted row sentinel escaped into a delivered notice');
});

// ---------------------------------------------------------------------------
// 6. stop()
// ---------------------------------------------------------------------------

test('stop() unregisters from the subscriber registry and withdraws the subscription manager, and is idempotent', async () => {
	const options = validOptions();
	const registry = options.node.reactivitySubscribers;
	const service = options.node.cohortTopicHost.service;
	const handle = await startPeerReplication(options);

	assert.equal(registry.has(TOPIC_ID), true, 'harness sanity: the manager must be registered under the derived topicId before stop()');

	await handle.stop();
	assert.equal(registry.has(TOPIC_ID), false, 'stop() did not unregister from the subscriber registry');
	assert.equal(service.withdraw.calls.length, 1);

	await handle.stop();
	assert.equal(service.withdraw.calls.length, 1, 'a second stop() call must be a no-op, not a second withdraw');
});

// ---------------------------------------------------------------------------
// 7. `56-09` Task 3 -- the source-transform isolation control.
//
// Proves the single `notifyPeerWrite(...)` call site is mechanically
// removable, and that removing it kills EXACTLY the notify while rows still
// land. A control that only asserted "no notices" would also pass on a
// mutated copy that failed to import at all, so this asserts the triple:
// the transform matched exactly one line, the store still received the
// applied batch, and the subscription received zero notices.
//
// DOES NOT PROVE the browser page re-renders (`56-11`'s liveness proof) and
// is NOT `56-13`'s D-16 production-variant inversion, which must rebuild a
// genuinely mutated BUNDLE rather than transform a source copy -- recorded
// here so a later reader does not double-count this proof.
// ---------------------------------------------------------------------------

test('the single notifyPeerWrite(...) call site is mechanically removable by a one-line source transform -- exactly one line matched, rows still land, zero notices fire', async () => {
	const sourcePath = publicSrc('peer', 'reactivity-bridge.js');
	const source = readFileSync(sourcePath, 'utf8');

	// The exact one-line statement Task 2's own call-site comment pins. A
	// match count other than one fails LOUDLY here rather than silently
	// proving nothing.
	const CALL_LINE_RE = /^\t+notifyPeerWrite\(db, networkHash, table, op\);\n/gm;
	const matches = source.match(CALL_LINE_RE);
	assert.equal(
		matches ? matches.length : 0,
		1,
		`the pinned notifyPeerWrite call-site pattern matched ${matches ? matches.length : 0} line(s), not exactly 1`,
	);

	const mutated = source.replace(CALL_LINE_RE, '');
	assert.notEqual(mutated, source, 'the transform did not change the source');

	// Written BESIDE the original, under this app's own src/peer/ tree --
	// never a system temp directory -- so the mutated copy's bare-specifier
	// imports (@optimystic/db-core, @optimystic/db-p2p,
	// @votetorrent/web-data/public) still resolve through this app's own
	// node_modules by the ordinary upward walk. Cleaned up in a `finally`;
	// never committed.
	const tmpDir = mkdtempSync(publicSrc('peer', '.tmp-mutant-'));
	try {
		const mutantPath = path.join(tmpDir, 'reactivity-bridge.mutant.mjs');
		writeFileSync(mutantPath, mutated);
		/** @type {any} */
		const mutantModule = await import(moduleUrl(mutantPath));
		assert.equal(typeof mutantModule.startPeerReplication, 'function', 'the mutated copy failed to import cleanly -- this control would prove nothing');

		const storeTable = makeFakeStoreTable(() => [{ op: 'insert', newRow: ['a'] }]);
		const { registry, notices } = await startHarness(
			storeTable,
			async () => [{ table: VALID_TABLE, ops: [{ op: 'upsert', row: ['a'] }] }],
			mutantModule.startPeerReplication,
		);

		registry.deliver(TOPIC_ID, makeNotification({ revision: 1 }));
		await flush();

		assert.equal(
			storeTable.applyExternalRowChanges.calls.length,
			1,
			'the mutated copy never applied the batch at all -- a broken copy would also show zero notices, proving nothing',
		);
		assert.equal(notices.length, 0, 'the mutated copy still delivered a notice -- the transform did not isolate the notify call');
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});
