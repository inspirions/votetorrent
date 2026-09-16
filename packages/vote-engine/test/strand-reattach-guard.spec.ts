import { Database } from '@quereus/quereus';
import { expect } from 'chai';
import { VOTETORRENT_SCHEMA_SQL } from '../src/database/schema-sql.js';
import {
	registerDbPlugins,
	ensureTidSequence,
	markSchemaInitialized,
} from '../src/database/initialize.js';
import { NetworksEngine } from '../src/networks/networks-engine.js';
import { AsyncStorage } from './shims/react-native.js';
import type { NetworkReference } from '@votetorrent/vote-core';

/**
 * Strand re-attach guard (D-05 regression).
 *
 * The cadre-core strand backend applies the VoteTorrent schema under the `App`
 * schema, not `main`. open()'s re-attach guard used to test only
 * `hasDeclaredSchema('main')`, which is ALWAYS false on a strand handle — so
 * initDB ran on every strand re-attach, declared a second `main` over the same
 * tree://default/{table} collections, and the Quereus differ re-emitted every
 * named constraint. The first one to fail was Network's:
 *
 *   Failed to execute DDL: ALTER TABLE Network ADD constraint CantDelete check on delete (false)
 *   Cannot add constraint 'CantDelete' to table 'Network': a constraint with that name already exists
 *
 * On device that surfaced as "Failed to load network" on EVERY app restart, with
 * "Try Again" re-running the identical failing DDL — only "Start Fresh" escaped,
 * discarding the operator's session each launch.
 *
 * These tests stand in for the strand backend by applying the real schema under
 * `App` on a plain Database, which is exactly the precondition open() misread.
 *
 * SCOPE OF PROOF — read before trusting these as closure of the device defect.
 * An in-memory Database has no persisted catalog for the Quereus differ to diff
 * against, so this suite does NOT reproduce the `ALTER TABLE ... ADD constraint
 * CantDelete` DDL error verbatim; without the fix the second test fails one step
 * later, with the outer `use create() first` symptom (initDB declares `main`, and
 * the SchemaInit marker lookup then misses). What these tests DO pin is the root
 * cause common to both symptoms: open() ran initDB on a strand handle at all.
 * Eliminating the CantDelete DDL specifically is a device-observable claim and
 * must be confirmed on hardware, not inferred from a green run here.
 */
describe('strand re-attach guard', () => {
	/** Apply the real VoteTorrent schema under `App`, as StrandDatabase does. */
	async function makeStrandDb(): Promise<Database> {
		const db = new Database();
		await registerDbPlugins(db);
		const appSchemaSql = VOTETORRENT_SCHEMA_SQL.replace(
			/^declare schema main/,
			'declare schema App',
		).replace(/apply schema main;$/, 'apply schema App;');
		await db.exec(appSchemaSql);
		// Mirror the real strand session: cadre-core leaves `main` as the current
		// schema and puts `App` on the search path, which is why unqualified TABLE
		// reads resolve there while unqualified VIEW reads do not (the asymmetry
		// declareViewsInMain exists to close). Without this the test would resolve
		// tables only in `App` and would not exercise the same resolution paths.
		db.setSchemaPath(['App', 'main']);
		return db;
	}

	const ref: NetworkReference = {
		hash: 'strand-guard-hash',
		name: 'Strand Guard Net',
		primaryAuthorityDomainName: 'strand.example',
		relays: [],
	} as unknown as NetworkReference;

	it('applies the schema under App, not main (precondition)', async () => {
		const db = await makeStrandDb();
		expect(db.declaredSchemaManager.hasDeclaredSchema('App')).to.equal(true);
		expect(db.declaredSchemaManager.hasDeclaredSchema('main')).to.equal(false);
		await db.close();
	});

	it('re-attaches an initialized strand store without re-running schema DDL', async () => {
		const db = await makeStrandDb();
		// Stand in for a store the CREATE path already established.
		await ensureTidSequence(db);
		await markSchemaInitialized(db);

		const engine = new NetworksEngine(AsyncStorage, async () => db);

		// Before the fix this threw the CantDelete QuereusError.
		const networkEngine = await engine.open(ref, undefined, false);
		expect(networkEngine).to.not.equal(undefined);

		// The guard must not have declared a second `main` over the strand tables.
		expect(db.declaredSchemaManager.hasDeclaredSchema('main')).to.equal(false);

		// STRAND-VIEWS must still run on this path: unqualified view reads are
		// resolved against the current schema only, so skipping initDB must not
		// also skip re-declaring the views in `main`.
		const adminView = await db
			.prepare("select count(*) as c from CurrentAdmin")
			.get();
		expect(adminView).to.not.equal(undefined);
		await db.close();
	});

	it('still refuses an uninitialized strand store (D-05 gate intact)', async () => {
		const db = await makeStrandDb();
		// No markSchemaInitialized — this store was never created through create().
		const engine = new NetworksEngine(AsyncStorage, async () => db);

		let caught: unknown;
		try {
			await engine.open(ref, undefined, false);
		} catch (error) {
			caught = error;
		}
		expect((caught as Error)?.message).to.include('use create() first');
		await db.close();
	});
});
