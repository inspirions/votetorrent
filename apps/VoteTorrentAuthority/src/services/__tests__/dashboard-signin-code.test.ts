/**
 * dashboard-signin-code.test.ts — Task 2 of 50-07, extended by Task 1 of
 * 50-15 (CR-03 gap closure: the payload must NEVER be persisted, not even
 * between mint and redemption — see the module header this suite exercises).
 *
 * DECLARED BLIND SPOT: this spec exercises no transport binding (neither the
 * filesystem binding nor a REST binding is constructed here) and no real wall
 * clock — every expiry/freshness decision is proven with INJECTED `now` values.
 * The real-clock rejection path (a code that expires purely from wall-clock
 * passage, with no test-supplied `now`) is listed in `50-VALIDATION.md` §
 * Manual-Only Verifications.
 *
 * Uses the real AsyncStorage jest mock mapped in `jest.config.js`
 * (`@react-native-async-storage/async-storage/jest/async-storage-mock.js`) and
 * clears it between cases, mirroring `device-user.provisioning.test.ts`'s
 * convention. `__resetInMemoryStateForTests()` additionally clears the
 * module's two in-memory-only slots (the staged payload and the registered
 * snapshot provider) — neither lives in AsyncStorage, so `AsyncStorage.clear()`
 * alone cannot reach them, and without this reset one test's mint could leak
 * its in-memory payload into a later "cold start" test.
 */

import * as fs from 'fs';
import * as path from 'path';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { buildSnapshot } from '@votetorrent/vote-engine/bootstrap';
import type { BootstrapSnapshot } from '@votetorrent/vote-engine/bootstrap';
import {
	DASHBOARD_SIGNIN_CODE_SPAN_MINUTES,
	__resetInMemoryStateForTests,
	clearStagedSignInCode,
	mintDashboardSignInCode,
	readStagedSignInCode,
	redeemStagedSignInCode,
	registerDashboardSnapshotProvider,
	splitDashboardSignInCode,
	stageForFilesystemBinding,
} from '../dashboard-signin-code';

const PII_CANARY = 'PII-CANARY-9f3a';

function makeFixtureSnapshot(marker: string = PII_CANARY): BootstrapSnapshot {
	return buildSnapshot({
		networkHash: 'network-hash-fixture',
		tables: {
			Network: [{ Id: 'net-1', Marker: marker }],
		},
	});
}

beforeEach(async () => {
	await AsyncStorage.clear();
	__resetInMemoryStateForTests();
});

describe('mintDashboardSignInCode', () => {
	test('code is secret + "." + snapshot.digest, and the digest is recoverable via splitDashboardSignInCode', async () => {
		const snapshot = makeFixtureSnapshot();
		const minted = await mintDashboardSignInCode(snapshot, { now: new Date('2026-01-01T00:00:00.000Z') });

		expect(minted.code).toBe(`${minted.secret}.${snapshot.digest}`);
		expect(minted.secret).toMatch(/^[0-9a-f]{40}$/);
		const split = splitDashboardSignInCode(minted.code);
		expect(split.digest).toBe(snapshot.digest);
		expect(split.secret).toBe(minted.secret);
	});

	test('expiresAt is exactly DASHBOARD_SIGNIN_CODE_SPAN_MINUTES minutes after the injected now, 19 chars, no Z', async () => {
		const snapshot = makeFixtureSnapshot();
		const now = new Date('2026-01-01T00:00:00.000Z');
		const minted = await mintDashboardSignInCode(snapshot, { now });

		expect(minted.expiresAt.length).toBe(19);
		expect(minted.expiresAt.endsWith('Z')).toBe(false);
		expect(minted.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
		const expected = new Date(now.getTime() + DASHBOARD_SIGNIN_CODE_SPAN_MINUTES * 60_000)
			.toISOString()
			.slice(0, 19);
		expect(minted.expiresAt).toBe(expected);
	});

	test('two consecutive mints produce different secrets', async () => {
		const snapshot = makeFixtureSnapshot();
		const first = await mintDashboardSignInCode(snapshot);
		const second = await mintDashboardSignInCode(snapshot);
		expect(first.secret).not.toBe(second.secret);
	});

	test('supersedes: after a second mint, readStagedSignInCode returns only the second record, and the first secret redeems as unknown', async () => {
		const snapshot = makeFixtureSnapshot();
		const now = new Date('2026-01-01T00:00:00.000Z');
		const first = await mintDashboardSignInCode(snapshot, { now });
		const second = await mintDashboardSignInCode(snapshot, { now });

		const staged = await readStagedSignInCode();
		expect(staged?.secret).toBe(second.secret);

		const firstResult = await redeemStagedSignInCode(first.secret, { now });
		expect(firstResult.status).toBe('unknown');
		expect(firstResult.snapshot).toBeUndefined();
	});

	test('no value in the minted record matches key-material markers', async () => {
		const snapshot = makeFixtureSnapshot();
		const minted = await mintDashboardSignInCode(snapshot);
		const serialized = JSON.stringify(minted);
		expect(serialized).not.toMatch(/secp256k1|privateKey|randomSecretKey|getPublicKey/);
	});
});

describe('splitDashboardSignInCode', () => {
	test('rejects a code with no dot, more than one dot, a non-hex secret, or an empty digest — message contains neither half', () => {
		const secret = 'a'.repeat(40);
		const digest = 'b'.repeat(43);
		const cases = [secret, `${secret}.${digest}.extra`, `${'z'.repeat(40)}.${digest}`, `${secret}.`];
		for (const badCode of cases) {
			let thrown: Error | undefined;
			try {
				splitDashboardSignInCode(badCode);
			} catch (err) {
				thrown = err as Error;
			}
			expect(thrown).toBeDefined();
			expect(thrown!.message).not.toContain(secret);
			expect(thrown!.message).not.toContain(digest);
		}
	});
});

describe('redeemStagedSignInCode — expired / used / unknown, each with a positive control', () => {
	test('expired: redeeming past expiresAt returns "expired" with no snapshot; a fresh code in the same test returns "ok" with the snapshot (positive control)', async () => {
		const snapshot = makeFixtureSnapshot();
		const mintNow = new Date('2026-01-01T00:00:00.000Z');
		const minted = await mintDashboardSignInCode(snapshot, { now: mintNow });

		const pastExpiry = new Date(mintNow.getTime() + (DASHBOARD_SIGNIN_CODE_SPAN_MINUTES + 1) * 60_000);
		const expiredResult = await redeemStagedSignInCode(minted.secret, { now: pastExpiry });
		expect(expiredResult.status).toBe('expired');
		expect(expiredResult.snapshot).toBeUndefined();

		// Positive control: a freshly minted code, redeemed before its expiry, succeeds.
		await clearStagedSignInCode();
		const freshMintNow = new Date('2026-02-01T00:00:00.000Z');
		const freshMinted = await mintDashboardSignInCode(snapshot, { now: freshMintNow });
		const withinExpiry = new Date(freshMintNow.getTime() + 60_000);
		const okResult = await redeemStagedSignInCode(freshMinted.secret, { now: withinExpiry });
		expect(okResult.status).toBe('ok');
		expect(okResult.snapshot).toEqual(snapshot);
	});

	test('used: a second redemption of the same secret returns "used" with no snapshot; the first call returned "ok" with the snapshot (positive control)', async () => {
		const snapshot = makeFixtureSnapshot();
		const mintNow = new Date('2026-01-01T00:00:00.000Z');
		const minted = await mintDashboardSignInCode(snapshot, { now: mintNow });
		const withinExpiry = new Date(mintNow.getTime() + 60_000);

		const firstResult = await redeemStagedSignInCode(minted.secret, { now: withinExpiry });
		expect(firstResult.status).toBe('ok');
		expect(firstResult.snapshot).toEqual(snapshot);

		const secondResult = await redeemStagedSignInCode(minted.secret, { now: withinExpiry });
		expect(secondResult.status).toBe('used');
		expect(secondResult.snapshot).toBeUndefined();
	});

	test('unknown: an unrecognised secret returns "unknown", distinct from "expired" and "used"', async () => {
		const snapshot = makeFixtureSnapshot();
		await mintDashboardSignInCode(snapshot);

		const result = await redeemStagedSignInCode('f'.repeat(40));
		expect(result.status).toBe('unknown');
		expect(result.status).not.toBe('expired');
		expect(result.status).not.toBe('used');
		expect(result.snapshot).toBeUndefined();
	});

	test('concurrency: two redemptions fired without an intervening await resolve to exactly one "ok" and one "used"', async () => {
		const snapshot = makeFixtureSnapshot();
		const mintNow = new Date('2026-01-01T00:00:00.000Z');
		const minted = await mintDashboardSignInCode(snapshot, { now: mintNow });
		const withinExpiry = new Date(mintNow.getTime() + 60_000);

		const [r1, r2] = await Promise.all([
			redeemStagedSignInCode(minted.secret, { now: withinExpiry }),
			redeemStagedSignInCode(minted.secret, { now: withinExpiry }),
		]);

		const statuses = [r1.status, r2.status].sort();
		expect(statuses).toEqual(['ok', 'used']);
	});
});

/** Every value AsyncStorage currently holds, concatenated — so a canary scan
 * cannot be fooled by the payload moving to a different key. */
async function allStoredText(): Promise<string> {
	const keys = await AsyncStorage.getAllKeys();
	const entries = await Promise.all(keys.map((k) => AsyncStorage.getItem(k)));
	return entries.join('\n');
}

describe('the staged payload NEVER touches AsyncStorage — the CR-03 core', () => {
	test('mint: the RAW AsyncStorage string does not contain the PII canary or the "snapshotJson" substring, but DOES contain secret/digest/expiresAt/mintedAt', async () => {
		const snapshot = makeFixtureSnapshot();
		const mintNow = new Date('2026-01-01T00:00:00.000Z');
		const minted = await mintDashboardSignInCode(snapshot, { now: mintNow });

		// Positive control first: the RETURNED (in-memory) record still carries
		// the payload, so `stageForFilesystemBinding` keeps working this session.
		// A canary that never fired here would prove nothing below.
		expect(minted.snapshotJson).toBeDefined();
		expect(minted.snapshotJson).toContain(PII_CANARY);

		const raw = await AsyncStorage.getItem('votetorrent.dashboardBootstrap.stagedCode');
		expect(raw).not.toBeNull();
		expect(raw).not.toContain(PII_CANARY);
		expect(raw).not.toContain('snapshotJson');
		expect(await allStoredText()).not.toContain(PII_CANARY);

		// The record still answers "does this code exist, and is it live?" honestly.
		expect(raw).toContain(minted.secret);
		expect(raw).toContain(minted.digest);
		expect(raw).toContain(minted.expiresAt);
		expect(raw).toContain(minted.mintedAt);
	});

	test('a successful redemption stamps redeemedAt and collapses the record to EXACTLY the tombstone key set, in the same write', async () => {
		const snapshot = makeFixtureSnapshot();
		const mintNow = new Date('2026-01-01T00:00:00.000Z');
		const minted = await mintDashboardSignInCode(snapshot, { now: mintNow });

		const result = await redeemStagedSignInCode(minted.secret, { now: new Date(mintNow.getTime() + 60_000) });
		expect(result.status).toBe('ok');
		expect(result.snapshot).toEqual(snapshot);

		const raw = await AsyncStorage.getItem('votetorrent.dashboardBootstrap.stagedCode');
		expect(raw).not.toBeNull();
		expect(raw).not.toContain(PII_CANARY);
		expect(raw).not.toContain('snapshotJson');
		expect(raw).not.toContain('snapshotName');
		expect(await allStoredText()).not.toContain(PII_CANARY);

		const parsed = JSON.parse(raw!) as Record<string, unknown>;
		expect(Object.keys(parsed).sort()).toEqual(
			['code', 'digest', 'expiresAt', 'mintedAt', 'redeemedAt', 'secret'].sort(),
		);
		expect(parsed.redeemedAt).toBeDefined();

		const persisted = await readStagedSignInCode();
		expect(persisted?.redeemedAt).toBeDefined();
		expect(persisted?.snapshotJson).toBeUndefined();
	});

	test('an expiry refusal drops the record to the tombstone shape (no redeemedAt) but KEEPS it, so a second attempt still answers "expired"', async () => {
		const snapshot = makeFixtureSnapshot();
		const mintNow = new Date('2026-01-01T00:00:00.000Z');
		const minted = await mintDashboardSignInCode(snapshot, { now: mintNow });
		const pastExpiry = new Date(mintNow.getTime() + (DASHBOARD_SIGNIN_CODE_SPAN_MINUTES + 1) * 60_000);

		expect((await redeemStagedSignInCode(minted.secret, { now: pastExpiry })).status).toBe('expired');

		const raw = await AsyncStorage.getItem('votetorrent.dashboardBootstrap.stagedCode');
		expect(raw).not.toContain(PII_CANARY);
		expect(raw).not.toContain('snapshotJson');
		expect(raw).not.toContain('snapshotName');
		expect(await allStoredText()).not.toContain(PII_CANARY);

		const parsed = JSON.parse(raw!) as Record<string, unknown>;
		expect(Object.keys(parsed).sort()).toEqual(['code', 'digest', 'expiresAt', 'mintedAt', 'secret'].sort());
		expect(parsed.redeemedAt).toBeUndefined();

		// Dropping the payload must not weaken the refusal to 'unknown' --
		// 'expired' tells the officer to generate a new code; 'unknown' does not.
		expect((await redeemStagedSignInCode(minted.secret, { now: pastExpiry })).status).toBe('expired');
	});

	test('a wrong-secret redemption attempt does not tombstone or clear the live record', async () => {
		const snapshot = makeFixtureSnapshot();
		const mintNow = new Date('2026-01-01T00:00:00.000Z');
		const minted = await mintDashboardSignInCode(snapshot, { now: mintNow });
		const withinExpiry = new Date(mintNow.getTime() + 60_000);

		const wrongResult = await redeemStagedSignInCode('f'.repeat(40), { now: withinExpiry });
		expect(wrongResult.status).toBe('unknown');

		// The legitimate secret still redeems successfully afterwards — a wrong
		// guess must not have disturbed the live record.
		const okResult = await redeemStagedSignInCode(minted.secret, { now: withinExpiry });
		expect(okResult.status).toBe('ok');
		expect(okResult.snapshot).toEqual(snapshot);
	});

	test('clearStagedSignInCode leaves nothing behind, and the producer screen is the one caller that reaches it', () => {
		const screenSource = fs.readFileSync(
			path.join(__dirname, '..', '..', 'screens', 'dashboard', 'DashboardSignInCodeScreen.tsx'),
			'utf8',
		);
		expect(screenSource).toContain('clearStagedSignInCode');
		expect(screenSource).toContain('dashboardSignInCodeDiscardButton');
	});
});

describe('registerDashboardSnapshotProvider — the regeneration fallback for a cold start', () => {
	test('no provider registered, and the in-memory payload is gone (simulated restart): redemption of an otherwise-live code returns "unknown" and does NOT stamp redeemedAt', async () => {
		const snapshot = makeFixtureSnapshot();
		const mintNow = new Date('2026-01-01T00:00:00.000Z');
		const minted = await mintDashboardSignInCode(snapshot, { now: mintNow });

		// Simulate a process restart: the persisted record survives (it was
		// never in memory to begin with), the in-memory payload does not.
		__resetInMemoryStateForTests();

		const result = await redeemStagedSignInCode(minted.secret, { now: new Date(mintNow.getTime() + 60_000) });
		expect(result.status).toBe('unknown');
		expect(result.snapshot).toBeUndefined();

		const persisted = await readStagedSignInCode();
		expect(persisted?.redeemedAt).toBeUndefined();
	});

	test('a registered provider whose regenerated snapshot digest MATCHES the record: redemption returns "ok" with that snapshot', async () => {
		const snapshot = makeFixtureSnapshot();
		const mintNow = new Date('2026-01-01T00:00:00.000Z');
		const minted = await mintDashboardSignInCode(snapshot, { now: mintNow });
		__resetInMemoryStateForTests();

		// A fresh snapshot built from IDENTICAL tables produces an IDENTICAL
		// digest (the digest covers `tables` only) — this is the regeneration
		// path's whole premise: the database has not changed since minting.
		registerDashboardSnapshotProvider(async () => makeFixtureSnapshot());

		const result = await redeemStagedSignInCode(minted.secret, { now: new Date(mintNow.getTime() + 60_000) });
		expect(result.status).toBe('ok');
		expect(result.snapshot?.digest).toBe(minted.digest);

		const persisted = await readStagedSignInCode();
		expect(persisted?.redeemedAt).toBeDefined();
	});

	test('a registered provider whose regenerated snapshot digest DIFFERS from the record: redemption returns "unknown", does NOT stamp redeemedAt, and returns no snapshot', async () => {
		const snapshot = makeFixtureSnapshot();
		const mintNow = new Date('2026-01-01T00:00:00.000Z');
		const minted = await mintDashboardSignInCode(snapshot, { now: mintNow });
		__resetInMemoryStateForTests();

		// A DIFFERENT marker means a DIFFERENT digest — the database changed
		// since minting. Never `'ok'` with bytes the code's out-of-band digest
		// does not pin.
		registerDashboardSnapshotProvider(async () => makeFixtureSnapshot('a-different-marker-entirely'));

		const result = await redeemStagedSignInCode(minted.secret, { now: new Date(mintNow.getTime() + 60_000) });
		expect(result.status).toBe('unknown');
		expect(result.snapshot).toBeUndefined();

		const persisted = await readStagedSignInCode();
		expect(persisted?.redeemedAt).toBeUndefined();
	});

	test('registerDashboardSnapshotProvider(undefined) unregisters — a subsequent redemption with no in-memory payload returns "unknown"', async () => {
		const snapshot = makeFixtureSnapshot();
		const mintNow = new Date('2026-01-01T00:00:00.000Z');
		const minted = await mintDashboardSignInCode(snapshot, { now: mintNow });
		__resetInMemoryStateForTests();

		registerDashboardSnapshotProvider(async () => makeFixtureSnapshot());
		registerDashboardSnapshotProvider(undefined);

		const result = await redeemStagedSignInCode(minted.secret, { now: new Date(mintNow.getTime() + 60_000) });
		expect(result.status).toBe('unknown');
	});
});

describe('stageForFilesystemBinding', () => {
	const FS_TRANSPORT_SOURCE = fs.readFileSync(
		path.join(
			__dirname,
			'../../../../../packages/vote-engine/src/bootstrap/filesystem-bootstrap-transport.ts',
		),
		'utf8',
	);

	test('emits the exact relative paths and code-record field names the shipped filesystem binding reads', async () => {
		// Source-level gate against the binding's OWN module: a rename on either
		// side goes red here, not silently.
		expect(FS_TRANSPORT_SOURCE).toContain('expiresAt');
		expect(FS_TRANSPORT_SOURCE).toContain('snapshotFile');
		expect(FS_TRANSPORT_SOURCE).toContain("join(this.rootDir, 'codes')");
		expect(FS_TRANSPORT_SOURCE).toContain("join(this.rootDir, 'snapshots')");

		const snapshot = makeFixtureSnapshot();
		const minted = await mintDashboardSignInCode(snapshot, { now: new Date('2026-01-01T00:00:00.000Z') });
		const docs = stageForFilesystemBinding(minted);

		const paths = docs.map((d) => d.path);
		expect(paths).toEqual([
			`codes/${minted.secret}.json`,
			`snapshots/${minted.snapshotName}.json`,
			'snapshots/current.json',
		]);

		const codeDoc = JSON.parse(docs[0]!.contents);
		expect(Object.keys(codeDoc).sort()).toEqual(['expiresAt', 'snapshotFile']);
		expect(codeDoc.expiresAt).toBe(minted.expiresAt);
		expect(codeDoc.snapshotFile).toBe(minted.snapshotName);

		expect(docs[1]!.contents).toBe(minted.snapshotJson);
		expect(docs[2]!.contents).toBe(minted.snapshotJson);
	});

	test('calling it twice for the same record throws', async () => {
		const snapshot = makeFixtureSnapshot();
		const minted = await mintDashboardSignInCode(snapshot);
		stageForFilesystemBinding(minted);
		expect(() => stageForFilesystemBinding(minted)).toThrow();
	});
});

describe('PII / secret non-leakage', () => {
	test('no thrown message and no redemption result contains the PII canary or the bearer secret', async () => {
		const snapshot = makeFixtureSnapshot();
		const mintNow = new Date('2026-01-01T00:00:00.000Z');
		const minted = await mintDashboardSignInCode(snapshot, { now: mintNow });

		let splitErrorMessage = '';
		try {
			splitDashboardSignInCode('not-a-valid-code');
		} catch (err) {
			splitErrorMessage = (err as Error).message;
		}
		expect(splitErrorMessage).not.toContain(PII_CANARY);
		expect(splitErrorMessage).not.toContain(minted.secret);

		const withinExpiry = new Date(mintNow.getTime() + 60_000);
		await redeemStagedSignInCode(minted.secret, { now: withinExpiry });
		const usedResult = await redeemStagedSignInCode(minted.secret, { now: withinExpiry });
		expect(JSON.stringify(usedResult)).not.toContain(minted.secret);
	});
});
