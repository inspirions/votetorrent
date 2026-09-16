/**
 * dashboard-bootstrap-producer.test.ts — Task 1 of 50-07.
 *
 * DECLARED BLIND SPOT: the integration case (below) runs `exportDatabaseSnapshot`
 * against a REAL in-memory Quereus `Database` with `VOTETORRENT_SCHEMA_SQL` applied,
 * but the database is left EMPTY — it proves the enumerated table names really
 * resolve against the live schema, not that row COUNTS survive on a populated
 * database. Row-count parity on a populated database is proven separately here by
 * the planted fake row source, and end-to-end on a populated on-device database by
 * the manual hand-over recorded in `50-VALIDATION.md` § Manual-Only Verifications.
 * Nothing in this file exercises LevelDB, IndexedDB, or a deferred schema CHECK.
 */

import * as fs from 'fs';
import * as path from 'path';
import { buildSnapshot, verifySnapshot } from '@votetorrent/vote-engine/bootstrap';
import { VOTETORRENT_SCHEMA_SQL } from '@votetorrent/vote-engine/rn';
import {
	exportDatabaseSnapshot,
	listSnapshotTableNames,
} from '../dashboard-bootstrap-producer';
import type { SnapshotRowSource } from '../dashboard-bootstrap-producer';

const SCHEMA_PATH = path.join(
	__dirname,
	'../../../../../packages/vote-core/schema/votetorrent.qsql',
);

/** Independently parses `table <Name> (` declarations straight out of the .qsql
 * source, mirroring `foundingOfficerScopes.test.ts`'s own-schema-parity pattern —
 * a SEPARATE parser from the module under test, so a bug shared by both parsers
 * would not silently agree with itself. */
function parseSchemaTableNames(): Set<string> {
	const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');
	const names = new Set<string>();
	const re = /^[ \t]*table[ \t]+([A-Za-z_][A-Za-z0-9_]*)[ \t]*\(/gim;
	let match: RegExpExecArray | null;
	while ((match = re.exec(schema)) !== null) {
		names.add(match[1]!);
	}
	return names;
}

function parseSchemaViewNames(): Set<string> {
	const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');
	const names = new Set<string>();
	const re = /^[ \t]*view[ \t]+([A-Za-z_][A-Za-z0-9_]*)[ \t]+as/gim;
	let match: RegExpExecArray | null;
	while ((match = re.exec(schema)) !== null) {
		names.add(match[1]!);
	}
	return names;
}

/** A fake `SnapshotRowSource` over a plain object of table name -> row array (or a
 * thrown Error for a table configured to fail). Parses the table name straight out
 * of the `select * from <Name>` string `exportDatabaseSnapshot` always emits — this
 * source never receives any other query shape. Any table not present in `tables`
 * yields zero rows, mirroring the real-schema fact that most tables get no fixture
 * data in these planted-row cases. */
function makeFakeRowSource(
	tables: Record<string, ReadonlyArray<Record<string, unknown>> | Error>,
): SnapshotRowSource {
	return {
		async *eval(sql: string): AsyncIterable<Record<string, unknown>> {
			const match = /^select \* from (\w+)$/.exec(sql);
			if (!match) throw new Error(`fake row source: unexpected query shape: ${sql}`);
			const tableName = match[1]!;
			const entry = tables[tableName];
			if (entry === undefined) return;
			if (entry instanceof Error) throw entry;
			for (const row of entry) yield row;
		},
	};
}

describe('listSnapshotTableNames', () => {
	test('set-equals the table names parsed independently out of votetorrent.qsql, in both directions', () => {
		const schemaNames = parseSchemaTableNames();
		const producerNames = new Set(listSnapshotTableNames());
		expect(schemaNames.size).toBeGreaterThan(50);
		expect(producerNames).toEqual(schemaNames);
	});

	test('contains no view name', () => {
		const viewNames = parseSchemaViewNames();
		const producerNames = new Set(listSnapshotTableNames());
		expect(viewNames.size).toBeGreaterThan(0);
		for (const viewName of viewNames) {
			expect(producerNames.has(viewName)).toBe(false);
		}
	});

	test('contains no duplicates and is sorted in ascending UTF-16 code-unit order', () => {
		const names = listSnapshotTableNames();
		expect(new Set(names).size).toBe(names.length);
		const expectedOrder = [...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
		expect(names).toEqual(expectedOrder);
	});

	test('throws when the parse yields fewer than 50 tables, naming the count only', () => {
		const tinySchema = 'declare schema main\n{\n\ttable Foo (\n\t\tId text\n\t);\n}\napply schema main;';
		expect(() => listSnapshotTableNames(tinySchema)).toThrow(/yielded only 1 table/);
	});
});

describe('exportDatabaseSnapshot — planted fake row source', () => {
	test('produces a manifest whose counts equal the planted row counts, including a zero-row table at count 0', async () => {
		const bytes = new Uint8Array([1, 2, 3, 4]);
		const source = makeFakeRowSource({
			Network: [
				{ Id: 'net-1', Hash: 'h1', Name: 'Network One', NumberRequiredTSAs: 0 },
				{ Id: 'net-2', Hash: 'h2', Name: 'Network Two', NumberRequiredTSAs: 1 },
			],
			AttestationChallenge: [{ Nonce: 'n1', Payload: bytes }],
			TidHighWater: [],
		});

		const envelope = await exportDatabaseSnapshot(source, 'network-hash-fixture');

		expect(envelope.manifest.Network).toBe(2);
		expect(envelope.manifest.AttestationChallenge).toBe(1);
		// The empty table is asserted PRESENT at count 0, directly — not inferred
		// from the absence of a thrown error.
		expect('TidHighWater' in envelope.manifest).toBe(true);
		expect(envelope.manifest.TidHighWater).toBe(0);
		expect(envelope.tables.TidHighWater).toEqual([]);

		const result = verifySnapshot(envelope);
		expect(result.ok).toBe(true);
	});

	test('wraps a Uint8Array cell as $bytes (encodeBlobValue) and the envelope verifies', async () => {
		const bytes = new Uint8Array([9, 8, 7]);
		const source = makeFakeRowSource({
			AttestationChallenge: [{ Nonce: 'n1', Payload: bytes }],
		});

		const envelope = await exportDatabaseSnapshot(source, 'network-hash-fixture');

		const { encodeBlobValue } = require('@votetorrent/vote-engine/bootstrap');
		expect(envelope.tables.AttestationChallenge![0]!.Payload).toEqual(encodeBlobValue(bytes));
		expect(verifySnapshot(envelope).ok).toBe(true);
	});

	test('a raw (unwrapped) Uint8Array passed straight into buildSnapshot throws — proving the wrapping above is load-bearing, not decorative', () => {
		const bytes = new Uint8Array([9, 8, 7]);
		expect(() =>
			buildSnapshot({
				networkHash: 'network-hash-fixture',
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				tables: { AttestationChallenge: [{ Nonce: 'n1', Payload: bytes }] } as any,
			}),
		).toThrow(/snapshot: unsupported value type in/);
	});

	test('a row-source failure is rethrown naming the table and containing no row value from an adjacent table', async () => {
		const source = makeFakeRowSource({
			Network: [{ Id: 'net-1', Marker: 'ADJACENT-ROW-MARKER-should-not-leak' }],
			Officer: new Error('underlying transport exploded: ADJACENT-ROW-MARKER-should-not-leak'),
		});

		await expect(exportDatabaseSnapshot(source, 'network-hash-fixture')).rejects.toThrow(
			/failed to read table Officer/,
		);
		try {
			await exportDatabaseSnapshot(source, 'network-hash-fixture');
			throw new Error('expected exportDatabaseSnapshot to reject');
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			expect(message).toContain('Officer');
			expect(message).not.toContain('ADJACENT-ROW-MARKER-should-not-leak');
		}
	});

	test('a row whose value is undefined is exported as null, not omitted', async () => {
		const source = makeFakeRowSource({
			Network: [{ Id: 'net-1', ImageRef: undefined }],
		});

		const envelope = await exportDatabaseSnapshot(source, 'network-hash-fixture');

		const row = envelope.tables.Network![0]!;
		expect('ImageRef' in row).toBe(true);
		expect(row.ImageRef).toBeNull();
		expect(envelope.manifest.Network).toBe(1);
	});
});

describe('exportDatabaseSnapshot — integration against a REAL in-memory Quereus Database', () => {
	test('an empty schema-applied database enumerates every real table at manifest count 0 and verifies', async () => {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const { Database } = require('@quereus/quereus');
		// The schema's CHECK constraints call `digest(...)`, `SignatureValid(...)`,
		// `SignatureValidP256(...)` and `isISODatetime(...)` — none of which a bare
		// `new Database()` registers. `registerDbPlugins` is vote-engine's OWN
		// per-Database-instance plugin bootstrap (see `database/initialize.ts`'s doc
		// comment); it is not on the controlled RN-safe `./rn` barrel (correctly —
		// screens never construct a raw Database), so this TEST ONLY reaches it via
		// the package's built dist file directly, bypassing the package "exports"
		// map the way `@votetorrent/vote-engine/test/fixtures/test-context` is
		// already deep-imported by sibling app-Jest suites (see jest.config.js).
		const initializePath = path.join(
			__dirname,
			'../../../../../packages/vote-engine/dist/database/initialize.js',
		);
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const { registerDbPlugins } = require(initializePath);
		const db = new Database();
		await registerDbPlugins(db);
		await db.exec(VOTETORRENT_SCHEMA_SQL);

		const envelope = await exportDatabaseSnapshot(db, 'network-hash-integration');

		const names = listSnapshotTableNames();
		for (const name of names) {
			expect(envelope.manifest[name]).toBe(0);
		}
		expect(envelope.generatedAt.length).toBe(19);
		expect(envelope.generatedAt.endsWith('Z')).toBe(false);
		expect(verifySnapshot(envelope).ok).toBe(true);
	}, 30_000);
});
