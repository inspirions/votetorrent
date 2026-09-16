/**
 * bootstrap-envelope.js -- the shared bootstrap-snapshot fixture Task 2's
 * (`snapshot-restore.test.mjs`) and Task 3's (`bootstrap-redemption.test.mjs`)
 * suites both import.
 *
 * TEST SCAFFOLDING, NOT A PRODUCTION WRITE PATH -- mirrors 50-05's
 * `seed-founding-authority.js` header. Phase 50's dashboard makes NO writes
 * of its own (D-01); this file exists only so the restore/redemption suites
 * have something real to verify, apply and corrupt.
 *
 * Builds a SMALL but STRUCTURALLY REAL envelope via 50-02's `buildSnapshot`,
 * over six of `votetorrent.qsql`'s real tables (`Network`, `Authority`,
 * `Admin`, `Officer`, `User`, `Registrant`), chosen to exercise the hard
 * cases:
 *
 *   - `Registrant` carries a PAST `Expiration` -- `ExpirationFuture`
 *     (`votetorrent.qsql:1629`) rejects this on a plain SQL insert; landing
 *     it through the restore seam is the proof the seam genuinely bypasses
 *     constraint evaluation.
 *   - `Authority.ImageRef` carries a blob cell wrapped as `{ $bytes }` --
 *     the round-trip case (the schema declares no dedicated blob-typed
 *     column; this nullable text column is a legitimate carrier because the
 *     external-write seam bypasses type/CHECK validation entirely, exactly
 *     as the past-Expiration case above already demonstrates).
 */

import { buildSnapshot, encodeBlobValue, sealPayload } from '@votetorrent/vote-engine/bootstrap';
import { secretToKeySplit } from '../../src/transport/bootstrap-transport-client.js';

/** @type {string} */
export const FIXTURE_NETWORK_HASH = 'bootstrap-fixture-network';

/** @type {Uint8Array} */
export const BLOB_ROUNDTRIP_BYTES = new Uint8Array([0x00, 0x01, 0x02, 0xfe, 0xff, 0x10, 0x42]);

/** @returns {import('@votetorrent/vote-engine/bootstrap').SnapshotTables} */
function baseTables() {
	return {
		Network: [
			{
				Id: 'n1',
				Hash: FIXTURE_NETWORK_HASH,
				PrimaryAuthorityId: 'a1',
				Name: 'Fixture Network',
				ImageRef: null,
				Relays: '[]',
				TimestampAuthorities: '[]',
				NumberRequiredTSAs: 0,
				ElectionType: 'o',
			},
		],
		Authority: [
			{
				Id: 'a1',
				Name: 'Fixture County Elections',
				DomainName: 'fixture.example',
				ImageRef: encodeBlobValue(BLOB_ROUNDTRIP_BYTES),
			},
		],
		Admin: [
			{
				AuthorityId: 'a1',
				EffectiveAt: '2026-01-01T00:00:00',
				ThresholdPolicies: '[]',
			},
		],
		Officer: [
			{
				AuthorityId: 'a1',
				AdminEffectiveAt: '2026-01-01T00:00:00',
				UserId: 'u1',
				Title: 'Clerk',
				Scopes: '["mel"]',
			},
		],
		User: [{ Id: 'u1', Name: 'Fixture Officer', ImageRef: null }],
		Registrant: [
			{
				Id: 'r1',
				AuthorityId: 'a1',
				PrivateCid: 'cid-private-1',
				PublicCid: null,
				SelectiveCid: null,
				Status: 'a',
				// Deliberately IN THE PAST -- ExpirationFuture rejects this on a
				// plain SQL insert; landing it is the seam's whole point. The `Z`
				// suffix is correct here (unlike a value THIS DASHBOARD produces):
				// `ExpirationValid` requires isISODatetime(...) and like('%Z', ...),
				// mirroring 50-05's seed-founding-authority.js note on the same point.
				Expiration: '2020-01-01T00:00:00Z',
				SignorKey: 'fixture-signor-key',
				Signature: 'fixture-signature',
			},
		],
	};
}

/**
 * The pristine envelope -- the positive control every corruption helper
 * below is compared against (each helper returns a NEW envelope, so this one
 * stays usable in the same test).
 *
 * @returns {import('@votetorrent/vote-engine/bootstrap').BootstrapSnapshot}
 */
export function buildFixtureEnvelope() {
	return buildSnapshot({ networkHash: FIXTURE_NETWORK_HASH, tables: baseTables() });
}

/**
 * The truncation case: `n` rows removed from `table`, the MANIFEST left
 * untouched. `verifySnapshot` must report this as `manifest-mismatch`, not
 * `digest-mismatch` (50-02's check order: manifest precedes digest).
 *
 * @param {import('@votetorrent/vote-engine/bootstrap').BootstrapSnapshot} env
 * @param {string} table
 * @param {number} n
 * @returns {import('@votetorrent/vote-engine/bootstrap').BootstrapSnapshot}
 */
export function withDroppedRows(env, table, n) {
	const rows = env.tables[table] ?? [];
	const dropped = rows.slice(0, Math.max(0, rows.length - n));
	return { ...env, tables: { ...env.tables, [table]: dropped } };
}

/**
 * The corruption case: one value changed, row COUNTS unchanged. The stored
 * `digest` field is left as-is (from the pristine envelope), so it no longer
 * matches the recomputed content digest -- `verifySnapshot` reports
 * `digest-mismatch`.
 *
 * @param {import('@votetorrent/vote-engine/bootstrap').BootstrapSnapshot} env
 * @param {string} table
 * @param {string} column
 * @returns {import('@votetorrent/vote-engine/bootstrap').BootstrapSnapshot}
 */
export function withMutatedCell(env, table, column) {
	const rows = env.tables[table] ?? [];
	if (rows.length === 0) {
		throw new Error(`withMutatedCell: table "${table}" has no rows to mutate`);
	}
	const mutated = rows.map((row, index) =>
		index === 0 ? /** @type {import('@votetorrent/vote-engine/bootstrap').SnapshotRow} */ ({ ...row, [column]: mutateValue(row[column]) }) : row,
	);
	return { ...env, tables: { ...env.tables, [table]: mutated } };
}

/**
 * @param {import('@votetorrent/vote-engine/bootstrap').SnapshotValue} value
 * @returns {import('@votetorrent/vote-engine/bootstrap').SnapshotValue}
 */
function mutateValue(value) {
	if (typeof value === 'string') return `${value}-mutated`;
	if (typeof value === 'number') return value + 1;
	if (typeof value === 'boolean') return !value;
	return value === null ? 'mutated' : value;
}

/**
 * A `schemaHash` computed over a foreign schema -- `verifySnapshot` reports
 * `schema-hash-mismatch`, checked BEFORE the manifest even when the payload
 * is also truncated (50-02's step 5 precedes step 6).
 *
 * @param {import('@votetorrent/vote-engine/bootstrap').BootstrapSnapshot} env
 * @returns {import('@votetorrent/vote-engine/bootstrap').BootstrapSnapshot}
 */
export function withForeignSchemaHash(env) {
	const flipped = env.schemaHash.startsWith('A') ? `B${env.schemaHash.slice(1)}` : `A${env.schemaHash.slice(1)}`;
	return { ...env, schemaHash: flipped };
}

/**
 * @param {import('@votetorrent/vote-engine/bootstrap').BootstrapSnapshot} env
 * @returns {import('@votetorrent/vote-engine/bootstrap').BootstrapSnapshot}
 */
export function withWrongFormatVersion(env) {
	return { ...env, formatVersion: env.formatVersion + 1 };
}

/** Case-insensitively flips every letter's case. */
/** @param {string} value */
function flipCase(value) {
	return [...value].map((ch) => (ch === ch.toUpperCase() ? ch.toLowerCase() : ch.toUpperCase())).join('');
}

/**
 * A SECOND, legitimately DIFFERENT `User` row -- rebuilt through
 * `buildSnapshot` so the manifest/digest/schemaHash stay internally
 * consistent (this envelope VERIFIES successfully; only Task 3's officer
 * derivation rejects it). Task 3's `officer-indeterminate` negative case.
 *
 * @param {import('@votetorrent/vote-engine/bootstrap').BootstrapSnapshot} env
 * @returns {import('@votetorrent/vote-engine/bootstrap').BootstrapSnapshot}
 */
export function withExtraUserRow(env) {
	const rows = env.tables.User ?? [];
	const first = /** @type {Record<string, string>} */ (/** @type {unknown} */ (rows[0]));
	const extra = /** @type {import('@votetorrent/vote-engine/bootstrap').SnapshotRow} */ ({ ...first, Id: `${first.Id}-extra` });
	/** @type {import('@votetorrent/vote-engine/bootstrap').SnapshotTables} */
	const tables = { ...env.tables, User: [...rows, extra] };
	return buildSnapshot({ networkHash: env.networkHash, tables, generatedAt: env.generatedAt });
}

/**
 * Two `Registrant` rows whose `Id`s differ ONLY by case. The store module's
 * default text-PK key collation is case-insensitive (NOCASE) for a PK column
 * that declares no explicit `collate` -- `Registrant.Id` does not -- so these
 * two DISTINCT envelope rows collapse onto ONE physical key when the restore
 * seam upserts them, landing fewer rows than the (self-consistent, correctly
 * VERIFIED) manifest promised. Rebuilt through `buildSnapshot`, so this is
 * the one legitimate way `restore-incomplete` can fire on an envelope that
 * verified successfully -- every other way a restore could come up short is
 * already caught earlier, by `verifySnapshot`'s manifest check.
 *
 * @param {import('@votetorrent/vote-engine/bootstrap').BootstrapSnapshot} env
 * @returns {import('@votetorrent/vote-engine/bootstrap').BootstrapSnapshot}
 */
export function withCaseCollidingRegistrant(env) {
	const rows = env.tables.Registrant ?? [];
	const first = /** @type {Record<string, string>} */ (/** @type {unknown} */ (rows[0]));
	const collided = /** @type {import('@votetorrent/vote-engine/bootstrap').SnapshotRow} */ ({
		...first,
		Id: flipCase(first.Id),
		PrivateCid: 'cid-private-2',
	});
	/** @type {import('@votetorrent/vote-engine/bootstrap').SnapshotTables} */
	const tables = { ...env.tables, Registrant: [first, collided] };
	return buildSnapshot({ networkHash: env.networkHash, tables, generatedAt: env.generatedAt });
}

/**
 * The PLAINTEXT-shaped result a caller hands `makeFakeTransport`. Deliberately
 * a fixture-local typedef rather than the seam's `BootstrapRedemptionResult`:
 * under D-06 the seam carries a SEALED wrapper, but this double's
 * `codeToResult` API stays plaintext-shaped so every existing call site keeps
 * writing `{ status: 'ok', snapshot: envelope }` unchanged. The sealing
 * happens on the way out of `redeem`, below.
 * @typedef {{ status: import('@votetorrent/vote-engine/bootstrap').BootstrapRedemptionStatus, snapshot?: import('@votetorrent/vote-engine/bootstrap').BootstrapSnapshot }} FakeRedemptionResult
 */

/**
 * An in-memory `IBootstrapTransport` double whose `redeem` resolves a
 * caller-supplied plaintext result (or throws when the mapped value is an
 * `Error`) and SEALS it on the way out, exactly as a real binding's source
 * would have staged it. This double exists because 50-03's own conformance
 * suite already proves both real bindings; the filesystem binding is
 * Node-only and barrel-excluded, so this workspace must not reach for it.
 *
 * IT SEALS WITH THE SAME DERIVATION THE CONSUMER UNSEALS WITH --
 * `secretToKeySplit`, imported from the production module rather than
 * re-implemented here. So a mismatch between the two sides can only be a
 * defect in `deriveBootstrapKeys` itself, which 52-01's known-answer vectors
 * already pin against an independent implementation. A locally re-derived key
 * would instead make this double capable of agreeing with a broken consumer.
 *
 * SINGLE-USE BY DEFAULT (50-20 / D-14): the real backend
 * (`dashboard-signin-code.ts:391`) redeems a bearer code exactly once -- a
 * second successful redemption of the same secret returns `{ status: 'used'
 * }`, never the original `ok` payload again. Before 50-20 this double
 * replayed the SAME `ok` result forever, so no test built on it could ever
 * observe the shipped defect where `Bootstrap.tsx`'s unmount cleanup reset
 * the single-flight cache it had just handed off, causing `DashboardShell`'s
 * replay to reach a would-be-cached `inner` a second time -- and a green
 * browser gate could report D-14 end to end while that class of double-spend
 * was invisible to it. `singleUse: true` closes that blind spot for every
 * future harness built on this fixture, not only the ones this round
 * happens to touch. A refusal (`expired` / `used` / `unknown`) or an `Error`
 * mapping is NEVER consumed -- it behaves identically on every call, exactly
 * as the real backend does for a code it never accepted; only an accepted
 * `ok` marks a secret spent.
 *
 * Pass `singleUse: false` to restore the old replay-forever behaviour ONLY
 * when a test genuinely drives two independent, intentional redemptions of
 * the SAME secret constant (e.g. two unrelated bootstraps that happen to
 * share a literal secret string) -- name the reason at the call site.
 *
 * @param {{ codeToResult: Record<string, FakeRedemptionResult | Error>, singleUse?: boolean }} options
 * @returns {import('@votetorrent/vote-engine/bootstrap').IBootstrapTransport & { calls: string[] }}
 */
export function makeFakeTransport({ codeToResult, singleUse = true }) {
	/** @type {string[]} */
	const calls = [];
	/** The set of secrets already served an `ok` result -- consulted only
	 * when `singleUse` is active. A refusal never enters this set. */
	/** @type {Set<string>} */
	const spent = new Set();
	return {
		calls,
		/** @param {string} code */
		async redeem(code) {
			// Pushed FIRST, unconditionally, so `calls` stays an honest record of
			// every call regardless of outcome.
			calls.push(code);
			if (singleUse && spent.has(code)) {
				return { status: 'used' };
			}
			const result = codeToResult[code];
			if (result instanceof Error) throw result;
			const resolved = result ?? { status: 'unknown' };
			if (resolved.status !== 'ok' || !resolved.snapshot) {
				return { status: resolved.status };
			}
			spent.add(code);
			// Sealed HERE, on the way out -- a courier hands back a wrapper it
			// never opened, and the consumer opens it. The `codeToResult` API
			// above stays plaintext so no call site had to move.
			return {
				status: 'ok',
				sealed: sealPayload(JSON.stringify(resolved.snapshot), secretToKeySplit(code)),
			};
		},
	};
}
