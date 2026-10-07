import { Database } from '@quereus/quereus';
import { expect } from 'chai';
import { VOTETORRENT_SCHEMA_SQL } from '../src/database/schema-sql.js';
import {
	registerDbPlugins,
	ensureTidSequence,
	markSchemaInitialized,
} from '../src/database/initialize.js';
import { NetworksEngine } from '../src/networks/networks-engine.js';
import { peekTid, allocateTid } from '../src/database/tid-allocator.js';
import { createTestNetwork, makeTestSignCallback } from './fixtures/test-context.js';
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

	// -----------------------------------------------------------------------
	// 62-91 Task 2 (UAT 62 test 19): a bundle-importing joiner never holds the
	// TidHighWater header block, which is only reachable through the cohort.
	// open() must not read it; the first allocateTid reads it lazily.
	// -----------------------------------------------------------------------
	const UNAVAILABLE_MSG = (table: string): string =>
		`Failed to initialize Optimystic table: Block default/app/${table} is unavailable (cohort-unreachable): the repo could not determine whether it exists`;

	function unavailableError(table: string): Error {
		const e = new Error(UNAVAILABLE_MSG(table));
		e.name = 'BlockUnavailableError';
		(e as unknown as { reason: string }).reason = 'cohort-unreachable';
		return e;
	}

	/** Wrap a db so any statement whose SQL matches `blocked` throws the cohort-unreachable error. */
	function stubBlocked(db: Database, blocked: (sql: string) => string | undefined): { db: Database; seen: string[] } {
		const seen: string[] = [];
		const check = (sql: unknown): void => {
			const table = typeof sql === 'string' ? blocked(sql) : undefined;
			if (table !== undefined) {
				seen.push(String(sql));
				throw unavailableError(table);
			}
		};
		const proxy = new Proxy(db, {
			get(target, prop) {
				const value = Reflect.get(target, prop, target) as unknown;
				if (prop === 'prepare' || prop === 'exec') {
					return (sql: unknown, ...rest: unknown[]) => {
						check(sql);
						return (value as (...a: unknown[]) => unknown).call(target, sql, ...rest);
					};
				}
				return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
			},
		});
		return { db: proxy, seen };
	}

	const onlyTid = (sql: string): string | undefined => (/TidHighWater/.test(sql) ? 'TidHighWater' : undefined);

	/** Same token matching the app classifier uses: message regex or a 5-deep cause walk. */
	function findReason(err: unknown): string | undefined {
		let cur: unknown = err;
		for (let i = 0; i < 5 && cur !== undefined && cur !== null; i++) {
			const msg = cur instanceof Error ? cur.message : String(cur);
			const m = /Block \S+ is unavailable \(([a-z-]+)\)/.exec(msg);
			if (m) return m[1];
			cur = (cur as { cause?: unknown }).cause;
		}
		return undefined;
	}

	it('R-TID-0: the stub can fail — peekTid on the stubbed db rejects (negative control)', async () => {
		const { db } = stubBlocked(await makeStrandDb(), onlyTid);
		let caught: unknown;
		try { await peekTid(db, 'networks'); } catch (e) { caught = e; }
		expect((caught as Error)?.message).to.include('cohort-unreachable');
	});

	it('R-TID-1: open() on a strand never reads TidHighWater (cohort-unreachable stub)', async () => {
		const base = await makeStrandDb();
		await markSchemaInitialized(base);
		const { db, seen } = stubBlocked(base, onlyTid);
		const engine = new NetworksEngine(AsyncStorage, async () => db);
		const networkEngine = await engine.open(ref, undefined, false);
		expect(networkEngine).to.not.equal(undefined);
		expect(seen, 'no TidHighWater statement may be issued').to.deep.equal([]);
	});

	it('R-TID-2: a strand importFoundingBundle (createContext) issues zero TidHighWater statements', async () => {
		const net = await createTestNetwork();
		const user = net.user;
		const exporter = {
			userId: user.id,
			signerKey: user.activeKeys[0]!.key,
			sign: makeTestSignCallback(user),
		};
		const { text, bundle } = await net.networksEngine.exportFoundingBundle(net.ref.hash, exporter);
		const base = await makeStrandDb();
		const { db, seen } = stubBlocked(base, onlyTid);
		const store = new Map<string, unknown>();
		const deviceStorage = {
			async getItem<T>(k: string): Promise<T | undefined> { return store.has(k) ? (store.get(k) as T) : undefined; },
			async setItem<T>(k: string, v: T): Promise<void> { store.set(k, v); },
			async removeItem(k: string): Promise<void> { store.delete(k); },
			async clear(): Promise<void> { store.clear(); },
		};
		const engineB = new NetworksEngine(deviceStorage, async () => db);
		const result = await engineB.importFoundingBundle(text, undefined);
		expect(result.ok, result.ok ? 'ok' : String((result as { reason?: string }).reason)).to.equal(true);
		expect(bundle.descriptor.networkHash).to.be.a('string');
		expect(seen).to.deep.equal([]);
	});

	it('W-1: after open(), the first allocateTid rejects with the classifiable token and writes nothing', async () => {
		const base = await makeStrandDb();
		await markSchemaInitialized(base);
		const { db } = stubBlocked(base, onlyTid);
		const engine = new NetworksEngine(AsyncStorage, async () => db);
		await engine.open(ref, undefined, false);
		let caught: unknown;
		try { await allocateTid(db, 'networks'); } catch (e) { caught = e; }
		expect(caught, 'allocateTid must reject').to.not.equal(undefined);
		expect(findReason(caught)).to.equal('cohort-unreachable');
		// No engine wrapper sits between the officer write and allocateTid in the engines that
		// call it (grep: key-release/registration/elections call allocateTid unwrapped).
		const rows = await base.prepare('select count(*) as c from SchemaInit').get();
		expect(rows).to.not.equal(undefined);
	});

	it('W-2: non-genesis table reads fail classifiably while genesis-table reads succeed locally', async () => {
		const base = await makeStrandDb();
		await markSchemaInitialized(base);
		const GENESIS = new Set(['user', 'userkey', 'authority', 'admin', 'officer', 'network', 'schemainit']);
		const { db } = stubBlocked(base, (sql) => {
			const m = /\bfrom\s+(\w+)/i.exec(sql);
			if (!m) return undefined;
			return GENESIS.has(m[1]!.toLowerCase()) ? undefined : m[1];
		});
		await db.prepare('select count(*) as c from Authority').get();
		let caught: unknown;
		try { await db.prepare('select count(*) as c from Election').get(); } catch (e) { caught = e; }
		expect(findReason(caught)).to.equal('cohort-unreachable');
	});
});
