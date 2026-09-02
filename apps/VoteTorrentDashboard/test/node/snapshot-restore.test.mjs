/**
 * Tier-1 coverage of the trusted-replication restore seam
 * (`src/lifecycle/snapshot-restore.js`): exact row counts, blob round-trip,
 * schema-order projection, and the count-mismatch rejection.
 *
 * HONESTY NOTE (mirrors `test/node/db.test.mjs`): `fake-indexeddb` proves the
 * ENGINE's use of the IndexedDB API round-trips within one process. It says
 * NOTHING about quota, eviction, cross-tab locking or structured-clone edges
 * -- it cannot prove the restored rows survive a real page load, and no
 * assertion or test name in this file may suggest otherwise. That proof
 * belongs to `test/browser/run-headless.mjs`'s two-page gate (50-09's
 * extension point, per the plan's handoff notes).
 *
 * Sequential and stateful against one shared fake IDB in one process (spike
 * 076's idiom) -- do not reorder or parallelise. A per-test network hash
 * keeps tests from contaminating each other; `deleteNetworkDb` at the top of
 * each.
 */
import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dashboardSrc } from '../../../../scripts/lib/source-paths.mjs';
import { createNetworkDb, closeNetworkDb, deleteNetworkDb, readRowCounts } from '@votetorrent/web-data/officer';
import {
	RESTORE_BATCH_ROWS,
	SnapshotRestoreError,
	RestoreCountMismatchError,
	resolveStoreModule,
	toSchemaOrderedRow,
	applySnapshotTables,
	assertRestoreMatchesManifest,
} from '../../src/lifecycle/snapshot-restore.js';
import {
	buildFixtureEnvelope,
	withDroppedRows,
	BLOB_ROUNDTRIP_BYTES,
} from '../fixtures/bootstrap-envelope.js';


test('module exports RESTORE_BATCH_ROWS as a positive integer', () => {
	assert.equal(typeof RESTORE_BATCH_ROWS, 'number');
	assert.ok(RESTORE_BATCH_ROWS > 0);
});

test('applySnapshotTables: lands every table exactly matching the manifest, including a Registrant row plain SQL would reject', async () => {
	const hash = 'restore-happy-path';
	await deleteNetworkDb(hash).catch(() => {});
	const db = await createNetworkDb(hash);
	const envelope = buildFixtureEnvelope();

	const applied = await applySnapshotTables(db, envelope);
	for (const table of Object.keys(envelope.manifest)) {
		assert.equal(applied[table], envelope.manifest[table], `applied count for ${table}`);
	}

	const live = await readRowCounts(db, Object.keys(envelope.manifest));
	assert.deepEqual(live, envelope.manifest);

	// The seam genuinely bypasses constraint evaluation: the past-Expiration
	// Registrant row landed via applySnapshotTables (asserted above via the
	// exact row count). Positive control that this is NOT a permissive
	// fixture: a plain SQL insert of the identical row is rejected by
	// ExpirationFuture on this same store.
	await assert.rejects(
		() =>
			db.exec(
				`insert into Registrant (Id, AuthorityId, PrivateCid, PublicCid, SelectiveCid, Status, Expiration, SignorKey, Signature)
				 with context SigningNonce = null, Tid = 1, now = '2026-01-01T00:00:00'
				 values ('r-plain-sql-reject','a1','cid-x',null,null,'a','2020-01-01T00:00:00Z','k','s')`,
			),
		/ExpirationFuture/,
	);

	await closeNetworkDb(db);
	await deleteNetworkDb(hash);
});

test('applySnapshotTables: the returned map is the APPLIED count reported by the seam, not the submitted row count', async () => {
	// The JSDoc said `appliedCount` while the implementation returned
	// `rows.length` -- the number SUBMITTED. The two agree in this environment
	// (the seam reports one change per submitted row), which is exactly why
	// this never bit; the point is that the value now comes from the seam's
	// own answer, so it stays true if that ever stops holding.
	const hash = 'restore-applied-count';
	await deleteNetworkDb(hash).catch(() => {});
	const db = await createNetworkDb(hash);
	const envelope = buildFixtureEnvelope();

	const applied = await applySnapshotTables(db, envelope);
	const live = await readRowCounts(db, Object.keys(envelope.manifest));

	// The returned map must agree with what is ACTUALLY in the database, which
	// is the only claim a caller could reasonably read it as making.
	for (const table of Object.keys(envelope.manifest)) {
		assert.equal(applied[table], live[table], `applied vs live for ${table}`);
	}

	// Source assertion, because the equality above cannot distinguish the two
	// values while they coincide: the implementation must not be reading
	// `rows.length` for this map.
	const source = readFileSync(dashboardSrc('lifecycle', 'snapshot-restore.js'), 'utf8');
	assert.doesNotMatch(source, /applied\[tableName\] = rows\.length/);
	assert.match(source, /applied\[tableName\] = allChanges\.length/);

	await deleteNetworkDb(hash, { db });
});

test('applySnapshotTables: a blob column round-trips byte-identical', async () => {
	const hash = 'restore-blob-roundtrip';
	await deleteNetworkDb(hash).catch(() => {});
	const db = await createNetworkDb(hash);
	const envelope = buildFixtureEnvelope();

	await applySnapshotTables(db, envelope);
	const row = await db.prepare('select ImageRef from Authority').get({});
	assert.ok(row?.ImageRef instanceof Uint8Array);
	assert.deepEqual(new Uint8Array(/** @type {Uint8Array} */ (row.ImageRef)), BLOB_ROUNDTRIP_BYTES);

	await closeNetworkDb(db);
	await deleteNetworkDb(hash);
});

test('assertRestoreMatchesManifest: passes on a complete restore, paired with a short table throwing RestoreCountMismatchError naming table/expected/actual', async () => {
	const hash = 'restore-count-mismatch';
	await deleteNetworkDb(hash).catch(() => {});
	const db = await createNetworkDb(hash);
	const envelope = buildFixtureEnvelope();

	// Apply a SHORT version (one Registrant row dropped) but re-check against
	// the ORIGINAL (unmodified) manifest -- this is a module-level probe of
	// assertRestoreMatchesManifest's own throw, independent of whether
	// verifySnapshot would ever let such an envelope through in the full
	// redemption flow (Task 3 covers that path).
	const shortEnvelope = withDroppedRows(envelope, 'Registrant', 1);
	await applySnapshotTables(db, shortEnvelope);

	await assert.rejects(
		() => assertRestoreMatchesManifest(db, envelope),
		/** @param {any} err */
		(err) => {
			assert.ok(err instanceof RestoreCountMismatchError);
			assert.equal(err.name, 'RestoreCountMismatchError');
			assert.equal(err.table, 'Registrant');
			assert.equal(err.expected, 1);
			assert.equal(err.actual, 0);
			assert.match(err.message, /Registrant/);
			return true;
		},
	);

	await closeNetworkDb(db);
	await deleteNetworkDb(hash);

	// Positive control: a fresh store, fully applied, passes against its own manifest.
	const hash2 = 'restore-count-match-control';
	await deleteNetworkDb(hash2).catch(() => {});
	const db2 = await createNetworkDb(hash2);
	const envelope2 = buildFixtureEnvelope();
	await applySnapshotTables(db2, envelope2);
	const live = await assertRestoreMatchesManifest(db2, envelope2);
	assert.deepEqual(live, envelope2.manifest);
	await closeNetworkDb(db2);
	await deleteNetworkDb(hash2);
});

test('toSchemaOrderedRow: throws naming an unknown COLUMN (never a row value) for a stray key, paired with a well-formed row', async () => {
	const hash = 'restore-schema-order';
	await deleteNetworkDb(hash).catch(() => {});
	const db = await createNetworkDb(hash);
	const tableSchema = db.schemaManager.getTable('main', 'Authority');
	assert.ok(tableSchema);

	assert.throws(
		() =>
			toSchemaOrderedRow(/** @type {import('@quereus/quereus').TableSchema} */ (tableSchema), {
				Id: 'a-stray',
				Name: 'PII-CANARY-9f3a',
				NotARealColumn: 'PII-CANARY-9f3a',
			}),
		/** @param {any} err */
		(err) => {
			assert.ok(err instanceof SnapshotRestoreError);
			assert.equal(err.name, 'SnapshotRestoreError');
			assert.equal(err.subject, 'NotARealColumn');
			assert.ok(!err.message.includes('PII-CANARY-9f3a'));
			return true;
		},
	);

	// Positive control: a row with only declared columns projects cleanly,
	// missing columns become null in schema-column order.
	const projected = toSchemaOrderedRow(/** @type {import('@quereus/quereus').TableSchema} */ (tableSchema), {
		Id: 'a-ok',
		Name: 'OK Authority',
	});
	assert.equal(Array.isArray(projected), true);
	assert.equal(projected.length, tableSchema.columns.length);

	await closeNetworkDb(db);
	await deleteNetworkDb(hash);
});

test('resolveStoreModule: resolves the externally-writable module for a properly-opened handle (positive control)', async () => {
	const hash = 'restore-resolve-module-ok';
	await deleteNetworkDb(hash).catch(() => {});
	const db = await createNetworkDb(hash);
	const module = resolveStoreModule(db);
	assert.equal(typeof module.getTableForExternalWrite, 'function');
	await closeNetworkDb(db);
	await deleteNetworkDb(hash);
});

test('resolveStoreModule: throws SnapshotRestoreError by name on a handle with no store module registered', async () => {
	const { Database } = await import('@quereus/quereus');
	const bareDb = new Database();
	assert.throws(
		() => resolveStoreModule(bareDb),
		/** @param {any} err */
		(err) => {
			assert.ok(err instanceof SnapshotRestoreError);
			assert.equal(err.name, 'SnapshotRestoreError');
			return true;
		},
	);
	await bareDb.close();
});
