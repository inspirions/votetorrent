/**
 * snapshot-restore.js -- how a VERIFIED envelope's rows get into IndexedDB,
 * and why not through SQL.
 *
 * A WHOLE-DATABASE SNAPSHOT CANNOT BE REPLAYED AS SQL `insert` STATEMENTS.
 * This is provable from `packages/vote-core/schema/votetorrent.qsql` as it
 * stands today:
 *
 *   - `Registrant.ExpirationFuture check on insert (Expiration > context.now)`
 *     (`:1629`, and the same constraint on `RegistrantPrivate:1723`,
 *     `RegistrantSelective:1760`, `AttestationChallenge:1836`,
 *     `Association:1874`, `AssociationPrivate:1953`) rejects any restored row
 *     whose expiration has already passed -- i.e. exactly the historical rows
 *     a snapshot exists to carry.
 *   - `User.InsertValid` (`:672`) admits a user only through the unsigned
 *     shoe-in requiring `count(*) from User = 1`.
 *   - The signature-gated `InsertValid` / `MutationValid` families
 *     (`Officer:203`, `Election:842`, `Ballot:941`, `Question:1001`,
 *     `Option:1064`, `Registrant:1667`, `RegistrationBridgeKey:1453`, the
 *     seven `*SignatureTaskExtension` tables) require a `context.SigningNonce`
 *     matching a live `AdminSigning` row and a `Digest(context.Tid, ...)`
 *     recomputation. No snapshot carries a per-row signing context, and
 *     Quereus 4.14.0 exposes NO option to suspend constraint evaluation.
 *
 * THE SEAM THAT EXISTS FOR EXACTLY THIS. `@quereus/store@4.14.0` ships
 * `StoreTable.applyExternalRowChanges`, documented verbatim as "built for
 * trusted replication-style writes" and as running "NO constraint validation
 * (PK/UNIQUE/CHECK/FK) -- the origin is trusted". Its return value feeds
 * `Database.ingestExternalRowChanges`, which replays the post-write facets
 * (change capture, covering-structure maintenance, parent-side FK actions)
 * over the batch.
 *
 * WHY THE TRUST POSTURE IS SATISFIED HERE AND NOWHERE ELSE IN THIS PHASE.
 * That seam's precondition is a trusted origin. In this flow the origin is
 * trusted BECAUSE THE PAYLOAD ALREADY PASSED `verifySnapshot` AGAINST THE
 * OFFICER'S OUT-OF-BAND DIGEST -- not because of who served it. That is the
 * only place in Phase 50 where the precondition holds.
 *
 * THE STANDING RULE AND ITS BOUNDARY. "Write through `vote-engine`, never
 * the raw Quereus `Database` handle" exists because 26 of the 41
 * authorization sites are engine-delegated `context.Is*Valid` constraints and
 * `iad`/`ik` have ZERO schema sites -- a client on the raw handle silently
 * loses tier 2. That rule governs AUTHORITY ACTIONS: a write that represents
 * someone doing something. A snapshot restore represents NOBODY DOING
 * ANYTHING; it re-materialises rows the origin already validated. There is no
 * engine API for it and, per the paragraph above, there cannot be a SQL one.
 *
 * CONFINEMENT IS MECHANICAL, NOT ASPIRATIONAL. The external-write seam may
 * appear in EXACTLY ONE FILE, this one, pinned by a repo-wide grep in this
 * plan's own verification.
 *
 * RE-ENTRY CONDITION: the panel-actions phase (ROADMAP scope step 3) MUST
 * NOT use this seam for user-initiated writes -- those go through
 * `vote-engine` with a signing ceremony, because for them the origin is the
 * officer and the constraint layer IS the authorization.
 */

import { decodeBlobValue } from '@votetorrent/vote-engine/bootstrap';
import { readRowCounts, STORE_MODULE_NAME } from '@votetorrent/web-data/officer';

/** Chunk size for `applyExternalRowChanges` batches -- bounds peak memory for a
 * large table rather than holding one call's worth of ops for the whole table.
 * @type {500} */
export const RESTORE_BATCH_ROWS = 500;

/** A restore-time failure naming a table, column or module -- never a row value
 * (a snapshot row is registrant PII). */
export class SnapshotRestoreError extends Error {
	/**
	 * @param {string} subject - the table, column or module name this error concerns
	 * @param {string} reason
	 */
	constructor(subject, reason) {
		super(`snapshot-restore: ${reason} (subject: "${subject}")`);
		this.name = 'SnapshotRestoreError';
		this.subject = subject;
	}
}

/** A live per-table row count, re-checked after applying a restore, diverges from
 * the envelope's own manifest. NOT a floor comparison -- exact equality, so a
 * half-landed restore fails loudly instead of rendering a database that looks
 * like it silently lost most of its registrants. */
export class RestoreCountMismatchError extends Error {
	/**
	 * @param {string} table
	 * @param {number} expected
	 * @param {number} actual
	 */
	constructor(table, expected, actual) {
		super(`snapshot-restore: row-count mismatch on table "${table}" after restore -- expected ${expected}, got ${actual}`);
		this.name = 'RestoreCountMismatchError';
		this.table = table;
		this.expected = expected;
		this.actual = actual;
	}
}

/**
 * @typedef {{ getTableForExternalWrite(db: import('@quereus/quereus').Database, schemaName: string, tableName: string): StoreTableLike | undefined }} StoreModuleLike
 * @typedef {{ applyExternalRowChanges(ops: readonly ExternalRowOpLike[]): Promise<import('@quereus/quereus').BackingRowChange[]> }} StoreTableLike
 * @typedef {{ op: 'upsert', row: import('@quereus/quereus').SqlValue[] } | { op: 'delete', pk: import('@quereus/quereus').SqlValue[] }} ExternalRowOpLike
 */

/**
 * Resolve the module registered under `open-db.js`'s `STORE_MODULE_NAME` as
 * something that exposes `getTableForExternalWrite` -- either directly (no
 * isolation wrapper), or through an `IsolationModule`'s public `underlying`
 * property (`open-db.js` registers with `isolation: true`, so the registered
 * module is normally the wrapper, not the store module itself; `@quereus/store`'s
 * own `StoreModule` doc comments name `underlying` as exactly this exposure
 * point). Throws `SnapshotRestoreError` naming the module rather than
 * returning `undefined` for a caller to trip over -- a missing/incompatible
 * module here means the handle was built without the mandatory
 * `setDefaultVtabName` path, which is 50-05's same-session-invisible trap.
 *
 * @param {import('@quereus/quereus').Database} db
 * @returns {StoreModuleLike}
 */
export function resolveStoreModule(db) {
	const registered = db.schemaManager.getModule(STORE_MODULE_NAME);
	const candidate = /** @type {any} */ (registered?.module);

	if (candidate && typeof candidate.getTableForExternalWrite === 'function') {
		return /** @type {StoreModuleLike} */ (candidate);
	}
	const underlying = candidate?.underlying;
	if (underlying && typeof underlying.getTableForExternalWrite === 'function') {
		return /** @type {StoreModuleLike} */ (underlying);
	}

	throw new SnapshotRestoreError(
		STORE_MODULE_NAME,
		'no externally-writable store module is registered under this name (directly, or via an isolation wrapper) -- the handle was built without the mandatory setDefaultVtabName path',
	);
}

/**
 * @param {unknown} value
 * @returns {value is import('@votetorrent/vote-engine/bootstrap').SnapshotBlobValue}
 */
function isBlobValue(value) {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
	const keys = Object.keys(value);
	return keys.length === 1 && keys[0] === '$bytes' && typeof (/** @type {any} */ (value).$bytes) === 'string';
}

/**
 * Project a snapshot row object onto `tableSchema.columns`' declared order --
 * `ExternalRowOp`'s `upsert` carries "the full table row in schema column
 * order". Missing column -> `null`. Unknown key in the row -> throws naming
 * the table and the COLUMN NAME ONLY -- a snapshot row's values are
 * registrant PII and must never reach an error string. Decodes `{ $bytes }`
 * through 50-02's `decodeBlobValue`; every other JSON scalar passes through
 * untouched.
 *
 * @param {import('@quereus/quereus').TableSchema} tableSchema
 * @param {import('@votetorrent/vote-engine/bootstrap').SnapshotRow} rowObject
 * @returns {import('@quereus/quereus').SqlValue[]}
 */
export function toSchemaOrderedRow(tableSchema, rowObject) {
	const knownColumns = new Set(tableSchema.columns.map((column) => column.name));
	for (const key of Object.keys(rowObject)) {
		if (!knownColumns.has(key)) {
			throw new SnapshotRestoreError(
				key,
				`snapshot row for table "${tableSchema.name}" carries a column the local schema does not declare`,
			);
		}
	}
	return tableSchema.columns.map((column) => {
		if (!(column.name in rowObject)) return null;
		const value = rowObject[column.name];
		if (isBlobValue(value)) return decodeBlobValue(value);
		return /** @type {import('@quereus/quereus').SqlValue} */ (/** @type {unknown} */ (value));
	});
}

/**
 * Land every table of a VERIFIED envelope into `db` through the
 * trusted-replication seam, in chunks of `RESTORE_BATCH_ROWS`. For each
 * table: resolve its local schema (a snapshot table the local schema does
 * not know is a version divergence, not something to ignore -- throws
 * naming the table), resolve its externally-writable handle, upsert every
 * row, then hand the accumulated changes to `db.ingestExternalRowChanges`
 * ONCE PER TABLE with the facets set explicitly:
 *
 *   - `captureChanges: false` -- Phase 50 registers no watcher (D-22 defers
 *     reactivity entirely), and capture is what makes commit-time global
 *     assertions fire over the inbound batch -- re-introducing exactly the
 *     validation this seam deliberately bypasses.
 *   - `applyForeignKeyActions: false` -- the origin's cascade effects are
 *     already IN the snapshot, so re-running them would double-apply; this
 *     is also the library's own default for a replication stream.
 *   - Covering-structure maintenance is left at its default (`true`) so any
 *     maintained structure this schema declares stays consistent -- a no-op
 *     when it declares none.
 *
 * Returns a `{ [tableName]: appliedCount }` map — the count
 * `applyExternalRowChanges` REPORTED BACK, never the number of rows
 * submitted. Those two agree today (this seam reports one change per
 * submitted row) and the difference has therefore never bitten, but the map
 * said `appliedCount` while carrying `rows.length`, which would claim a full
 * apply the first time the seam applied fewer than it was given — a
 * de-duplicated upsert onto an existing primary key being the obvious case.
 * A returned value must be the thing its name says it is, before someone
 * trusts it.
 *
 * No equality assertion is added here: `assertRestoreMatchesManifest` performs
 * the real check independently, with an exact `count(*)` per table, and a
 * second assertion over the same fact in a different place would just be two
 * things to keep in step. Never logs.
 *
 * @param {import('@quereus/quereus').Database} db
 * @param {import('@votetorrent/vote-engine/bootstrap').BootstrapSnapshot} envelope
 * @returns {Promise<Record<string, number>>}
 */
export async function applySnapshotTables(db, envelope) {
	const module = resolveStoreModule(db);
	const schemaName = db.schemaManager.getCurrentSchemaName();

	/** @type {Record<string, number>} */
	const applied = {};

	for (const tableName of Object.keys(envelope.tables)) {
		const tableSchema = db.schemaManager.getTable(schemaName, tableName);
		if (!tableSchema) {
			throw new SnapshotRestoreError(
				tableName,
				'snapshot carries a table the local schema does not declare -- version divergence',
			);
		}

		const storeTable = module.getTableForExternalWrite(db, schemaName, tableName);
		if (!storeTable) {
			throw new SnapshotRestoreError(tableName, 'the store module has no externally-writable table under this name');
		}

		const rows = envelope.tables[tableName] ?? [];
		/** @type {import('@quereus/quereus').BackingRowChange[]} */
		const allChanges = [];

		for (let start = 0; start < rows.length; start += RESTORE_BATCH_ROWS) {
			const chunk = rows.slice(start, start + RESTORE_BATCH_ROWS);
			/** @type {ExternalRowOpLike[]} */
			const ops = chunk.map((row) => ({ op: /** @type {'upsert'} */ ('upsert'), row: toSchemaOrderedRow(tableSchema, row) }));
			const changes = await storeTable.applyExternalRowChanges(ops);
			allChanges.push(...changes);
		}

		if (allChanges.length > 0) {
			await db.ingestExternalRowChanges(
				allChanges.map((change) => ({ schemaName, tableName, change })),
				{ captureChanges: false, applyForeignKeyActions: false },
			);
		}

		applied[tableName] = allChanges.length;
	}

	return applied;
}

/**
 * Re-check the applied restore against the envelope's own manifest with
 * 50-05's `readRowCounts` -- EXACT equality, throwing `RestoreCountMismatchError`
 * naming table/expected/actual on the first divergence. This is the check
 * that turns a half-landed restore into a loud failure instead of a
 * dashboard rendering a network that looks like it lost most of its
 * registrants -- the reason a partially applied restore never reaches the
 * row-count record.
 *
 * @param {import('@quereus/quereus').Database} db
 * @param {import('@votetorrent/vote-engine/bootstrap').BootstrapSnapshot} envelope
 * @returns {Promise<Record<string, number>>}
 */
export async function assertRestoreMatchesManifest(db, envelope) {
	const tableNames = Object.keys(envelope.manifest);
	const live = await readRowCounts(db, tableNames);
	for (const table of tableNames) {
		const expected = envelope.manifest[table];
		if (live[table] !== expected) {
			throw new RestoreCountMismatchError(table, /** @type {number} */ (expected), live[table]);
		}
	}
	return live;
}
