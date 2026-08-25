/**
 * Tier-1 coverage of `src/db/open-db.js`: open/create/close/delete plus the
 * single-call source assertion on `setDefaultVtabName`.
 *
 * Honesty note (50-VALIDATION.md): this tier proves the ENGINE's use of the
 * IndexedDB API round-trips within one process via `fake-indexeddb` — an
 * in-process reimplementation of the IDB API. It proves NOTHING about quota,
 * eviction, cross-tab locking or structured-clone edges, and it cannot catch
 * a missing `setDefaultVtabName('store')`, whose absence is
 * same-session-invisible (schema applies, seed succeeds, every read returns
 * correct data, and nothing was ever written). Only
 * `test/browser/run-headless.mjs`'s two-page headless-Chrome gate can catch
 * that class of bug — see its `--prove-trap` mode.
 *
 * Deliberately sequential and stateful (spike 076's node-suite idiom):
 * `import 'fake-indexeddb/auto'` first, then `node:test` + `node:assert/strict`.
 * No `--test-concurrency > 1`, no reordering.
 */
import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isSchemaInitialized } from '@votetorrent/vote-engine/browser';
import {
	dbNameFor,
	openStoreHandle,
	createNetworkDb,
	closeNetworkDb,
	listObjectStores,
	deleteNetworkDb,
} from '../../src/db/open-db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OPEN_DB_SOURCE = path.resolve(__dirname, '..', '..', 'src', 'db', 'open-db.js');

test('dbNameFor: exact template, no q2 prefix', () => {
	assert.equal(dbNameFor('abc123'), 'votetorrent-abc123');
});

test('dbNameFor: rejects an empty/non-string networkHash', () => {
	assert.throws(() => dbNameFor(''), TypeError);
	assert.throws(() => dbNameFor(/** @type {any} */ (undefined)), TypeError);
});

test('createNetworkDb: Authority resolves and the schema-init marker is present', async () => {
	const hash = 'db-delete-create';
	await deleteNetworkDb(hash).catch(() => {});
	const db = await createNetworkDb(hash);
	const row = await db.prepare('select count(*) as c from Authority').get({});
	assert.equal(row?.c, 0, 'Authority table resolves on a fresh store (0 rows, but resolves)');
	assert.equal(await isSchemaInitialized(db), true, 'schema-init marker must be present after createNetworkDb');
	await closeNetworkDb(db);
	await deleteNetworkDb(hash);
});

test('createNetworkDb: the IndexedDB database reports >50 object stores routed to the store module', async () => {
	const hash = 'db-delete-stores';
	await deleteNetworkDb(hash).catch(() => {});
	const db = await createNetworkDb(hash);
	const names = await listObjectStores(hash);
	assert.ok(names.length > 50, `expected >50 object stores, got ${names.length}`);
	assert.ok(names.includes('__catalog__'), 'catalog store missing — tables did not route to the store module');
	assert.ok(names.includes('main.authority'), 'main.authority store missing — tables did not route to the store module');
	await closeNetworkDb(db);
	await deleteNetworkDb(hash);
});

test('closeNetworkDb: resolves, and a subsequent query on that handle rejects', async () => {
	const hash = 'db-delete-close';
	await deleteNetworkDb(hash).catch(() => {});
	const db = await createNetworkDb(hash);
	await closeNetworkDb(db);
	// db.prepare() throws SYNCHRONOUSLY on a closed handle (MisuseError), so the
	// probe is wrapped in an async function — an async function boundary turns a
	// synchronous throw into a rejected promise, which is what assert.rejects needs.
	await assert.rejects(async () => {
		await db.prepare('select count(*) as c from Authority').get({});
	});
	await deleteNetworkDb(hash);
});

test('deleteNetworkDb: closes the handle, deletes the database, and indexedDB.databases() no longer lists it', async () => {
	const hash = 'db-delete-full';
	await deleteNetworkDb(hash).catch(() => {});
	const db = await createNetworkDb(hash);

	await deleteNetworkDb(hash, { db });

	if (typeof indexedDB.databases === 'function') {
		const remaining = await indexedDB.databases();
		assert.ok(
			!remaining.some((entry) => entry.name === dbNameFor(hash)),
			'indexedDB.databases() must not list the deleted database',
		);
	}
});

test('deleteNetworkDb: on a name never created, resolves without error (idempotent)', async () => {
	await assert.doesNotReject(() => deleteNetworkDb('db-delete-never-existed'));
});

test('deleteNetworkDb: on a name still held open by another connection, rejects DeleteBlockedError naming the database', async () => {
	const hash = 'db-delete-blocked';
	await deleteNetworkDb(hash).catch(() => {});
	// Establish a raw connection that stays open across the delete call.
	const blockingConn = await new Promise((resolve, reject) => {
		const req = indexedDB.open(dbNameFor(hash));
		req.onupgradeneeded = () => req.result.createObjectStore('probe');
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});

	await assert.rejects(
		() => deleteNetworkDb(hash, { timeoutMs: 200 }),
		/** @param {any} err */
		(err) => {
			assert.equal(err.name, 'DeleteBlockedError');
			assert.ok(String(err.message).includes(dbNameFor(hash)), 'message must contain the database name');
			return true;
		},
	);

	blockingConn.close();
	await deleteNetworkDb(hash); // clean slate for the following positive control
});

test('positive control: ordinary create -> delete -> recreate cycle succeeds (the rejections above are discriminating)', async () => {
	const hash = 'db-delete-cycle';
	await deleteNetworkDb(hash).catch(() => {});

	const db1 = await createNetworkDb(hash);
	await deleteNetworkDb(hash, { db: db1 });

	const db2 = await createNetworkDb(hash);
	const row = await db2.prepare('select count(*) as c from Authority').get({});
	assert.equal(row?.c, 0);
	await deleteNetworkDb(hash, { db: db2 });
});

test('openStoreHandle: applies setDefaultVtabName in the mandatory registration order', async () => {
	const hash = 'db-delete-order';
	await deleteNetworkDb(hash).catch(() => {});
	const db = await openStoreHandle(hash);
	// No DDL applied yet by openStoreHandle itself — declaring a table now must
	// route to the store module (proven indirectly by createNetworkDb's tests
	// above); this test only proves the handle opens without throwing.
	assert.ok(db);
	await closeNetworkDb(db);
	await deleteNetworkDb(hash);
});

test('source assertion: open-db.js contains exactly one setDefaultVtabName(\'store\') call outside comments', () => {
	const source = readFileSync(OPEN_DB_SOURCE, 'utf8');
	const codeOnly = source
		.split('\n')
		.filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
		.join('\n');
	const matches = codeOnly.match(/setDefaultVtabName\(\s*['"]store['"]\s*\)/g) ?? [];
	assert.equal(matches.length, 1, `expected exactly one setDefaultVtabName('store') call, found ${matches.length}`);
});
