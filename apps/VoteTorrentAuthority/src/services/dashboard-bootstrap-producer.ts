/**
 * dashboard-bootstrap-producer.ts — the producer half of the authority web
 * dashboard (D-09: the phase deliberately spans both apps — `apps/VoteTorrentAuthority`
 * and the new dashboard web app — so a real end-to-end path exists instead of the
 * dashboard being fed by fixtures).
 *
 * The payload this module builds is the whole local database verbatim (D-07). It is
 * naturally scoped to one network because one on-device store IS one network's data by
 * construction — there is nothing to filter by network here, the whole handle already
 * belongs to exactly one.
 *
 * The envelope, its per-table manifest, its content digest and its schema hash are ALL
 * owned by `@votetorrent/vote-engine/bootstrap` (D-13) and are never reconstructed here.
 * This module's only job is to enumerate the schema's tables, read every row through an
 * injectable seam, shape each cell into the frozen `SnapshotValue` union, and hand the
 * result to `buildSnapshot` — never to compute a manifest entry, a digest, a schema hash
 * or a `generatedAt` value itself.
 *
 * Every error path this module throws names tables and columns only — never a row value
 * or a column value — because the payload this module exports carries registrant PII.
 */

import {
	buildSnapshot,
	encodeBlobValue,
} from '@votetorrent/vote-engine/bootstrap';
import type {
	BootstrapSnapshot,
	SnapshotRow,
	SnapshotTables,
	SnapshotValue,
} from '@votetorrent/vote-engine/bootstrap';
import { VOTETORRENT_SCHEMA_SQL } from '@votetorrent/vote-engine/rn';

/**
 * A one-method structural seam a real Quereus `Database` satisfies without any
 * adaptation (its `eval(sql, params?, options?)` accepts a call with only `sql`
 * supplied, and TypeScript's structural typing accepts the extra optional
 * parameters). The seam exists so the row-shaping logic in
 * {@link exportDatabaseSnapshot} can be unit-tested with planted rows without
 * standing up LevelDB — the integration case in this module's own test suite binds
 * it to a REAL `Database` so the enumerated table names from
 * {@link listSnapshotTableNames} are proven to actually resolve. It is NOT a
 * mocking seam for that integration case; it exists only to make the planted-row
 * unit cases possible.
 */
export interface SnapshotRowSource {
	eval(sql: string): AsyncIterable<Record<string, unknown>>;
}

/** Match only `table <Name> (` declarations — never `view <Name> as`. The schema
 * declares nine views whose names must never appear in the exported manifest; a
 * view has no rows of its own to snapshot. Multiline + global + case-insensitive,
 * anchored at line start with optional leading whitespace so indentation inside
 * `declare schema main { ... }` does not defeat the match. */
const TABLE_DECLARATION_PATTERN = /^[ \t]*table[ \t]+([A-Za-z_][A-Za-z0-9_]*)[ \t]*\(/gim;

/** Below this count, treat the parse as having silently matched (nearly) nothing
 * rather than the real ~60-table schema. A regex that stopped matching — a syntax
 * change in the schema this parser was never updated for — would otherwise ship an
 * empty or near-empty database as a valid snapshot with a perfectly self-consistent
 * manifest and digest, and every downstream verification would pass. There is
 * nothing else standing between that failure and a silent partial export. */
const MINIMUM_EXPECTED_TABLE_COUNT = 50;

/** Ascending UTF-16 code-unit order — the SAME comparator 50-02's own
 * `snapshot-codec.ts` uses for its canonical key ordering. Deliberately NEVER
 * `Array.prototype.sort()` with no comparator (whose default is a UTF-16
 * string-coerced sort, and *happens* to agree here for plain identifiers, but the
 * explicit comparator states the intent) and NEVER `localeCompare` (ICU-dependent
 * — two machines with different locale data could order the manifest differently,
 * so the byte-identical digest preimage 50-02 hashes over would drift even though
 * the row content is identical). */
const compareTableNames = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The set of table names this app exports, parsed directly out of
 * `VOTETORRENT_SCHEMA_SQL` rather than hand-listed anywhere. This is deliberate:
 * the exported table set is EXACTLY the set 50-02's `schemaHash` already covers
 * (both are derived from the same schema DDL string), so the manifest and the
 * schema hash describe the same universe by construction. Hand-listing the tables
 * here instead would let a schema change silently drift out of sync with what
 * actually gets exported (see T-50-07-07).
 *
 * `schemaSql` is exposed purely so the test suite can pass a synthetic string
 * without needing a second copy of `schema-sql.ts`; every production caller
 * supplies nothing and gets the real `VOTETORRENT_SCHEMA_SQL`.
 */
export function listSnapshotTableNames(schemaSql: string = VOTETORRENT_SCHEMA_SQL): string[] {
	const names = new Set<string>();
	TABLE_DECLARATION_PATTERN.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = TABLE_DECLARATION_PATTERN.exec(schemaSql)) !== null) {
		names.add(match[1]!);
	}
	if (names.size < MINIMUM_EXPECTED_TABLE_COUNT) {
		throw new Error(
			`dashboard-bootstrap-producer: schema parse yielded only ${names.size} table(s), expected at least ${MINIMUM_EXPECTED_TABLE_COUNT} — the table-declaration parser likely stopped matching`,
		);
	}
	return [...names].sort(compareTableNames);
}

/**
 * Distinguishes a value-shaping refusal (a defect in the DATA, whose
 * table+column-naming message must survive verbatim) from a row-source
 * transport failure (whose original message must be discarded — see
 * {@link exportDatabaseSnapshot}'s catch block below). Without this
 * distinction, the outer catch's generic wrapping would swallow this
 * function's more specific, already-PII-safe message.
 */
class SnapshotValueShapeError extends Error {}

/**
 * Shape a single cell read off `SnapshotRowSource.eval(...)` into the frozen
 * `SnapshotValue` union. `undefined` maps to `null` — deliberately NOT omitted —
 * because a missing key and a `null` column are different facts, and the
 * manifest's row COUNT must never depend on which one occurred (dropping the key
 * would still leave the row present, just with fewer columns; that is a silent
 * schema-shape change this module must not introduce).
 *
 * Never interpolates the offending value into the thrown message: table names and
 * column names only, because the payload carries registrant PII (T-50-07-06).
 */
function shapeCellValue(value: unknown, tableName: string, columnName: string): SnapshotValue {
	if (value === undefined || value === null) return null;
	if (typeof value === 'string' || typeof value === 'boolean') return value;
	if (typeof value === 'number') {
		if (!Number.isFinite(value)) {
			throw new SnapshotValueShapeError(
				`dashboard-bootstrap-producer: unsupported non-finite number value in ${tableName}.${columnName}`,
			);
		}
		return value;
	}
	if (value instanceof Uint8Array) return encodeBlobValue(value);
	throw new SnapshotValueShapeError(`dashboard-bootstrap-producer: unsupported value type in ${tableName}.${columnName}`);
}

/**
 * Export the whole local database verbatim (D-07) as a 50-02 envelope.
 *
 * For each name returned by {@link listSnapshotTableNames}, reads every row via
 * `source.eval('select * from ' + name)` — table names come ONLY from the schema
 * parse and are NEVER interpolated from caller input, so no user-controlled text
 * ever reaches this SQL string — and shapes each row's cells with
 * {@link shapeCellValue}. The collected `SnapshotTables` object is handed to
 * `buildSnapshot`, which alone computes the manifest, the content digest, the
 * schema hash and `generatedAt`; none of those four is duplicated here, because
 * duplicating any of them is exactly how the producer and 50-02's consumers would
 * drift apart.
 *
 * A row-source failure for a given table is rethrown as an `Error` naming that
 * table only — never any row content the failed read may have partially produced.
 */
export async function exportDatabaseSnapshot(
	source: SnapshotRowSource,
	networkHash: string,
): Promise<BootstrapSnapshot> {
	const tables: Record<string, SnapshotRow[]> = {};
	for (const tableName of listSnapshotTableNames()) {
		const rows: SnapshotRow[] = [];
		try {
			for await (const rawRow of source.eval(`select * from ${tableName}`)) {
				const row: Record<string, SnapshotValue> = {};
				for (const [columnName, rawValue] of Object.entries(rawRow)) {
					row[columnName] = shapeCellValue(rawValue, tableName, columnName);
				}
				rows.push(row);
			}
		} catch (err) {
			// A shaping refusal already carries a table+column-naming, PII-safe
			// message (T-50-07-06) — pass it through unchanged. Anything else is a
			// row-source transport failure whose original message is DISCARDED,
			// because it may embed row content the failed read partially produced.
			if (err instanceof SnapshotValueShapeError) throw err;
			throw new Error(`dashboard-bootstrap-producer: failed to read table ${tableName}`);
		}
		tables[tableName] = rows;
	}
	return buildSnapshot({ networkHash, tables: tables as SnapshotTables });
}
