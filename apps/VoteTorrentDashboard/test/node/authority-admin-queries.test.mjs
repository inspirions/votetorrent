/**
 * authority-admin-queries.test.mjs — seeded real-schema proof of all six
 * `authority-admin-queries.js` fetchers, with instrument controls for the
 * empty results (an empty result that cannot be distinguished from a broken
 * query is not evidence).
 *
 * Uses an in-memory `new Database()` from `@quereus/quereus` -- no
 * IndexedDB is touched, so this file does NOT import the IndexedDB test
 * shim, mirroring `is-privileged.test.mjs`'s (50-06) own recipe.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Database } from '@quereus/quereus';
import { prepareDb } from '@votetorrent/vote-engine/browser';

import { dashboardSrc } from '../../../../scripts/lib/source-paths.mjs';

import { seedFoundingAuthority } from '../fixtures/seed-founding-authority.js';
import {
	seedNetwork,
	seedAuthorityPeers,
	seedAuthorityInvite,
	seedOtherScopeInvite,
	seedOfficerWithMalformedScopes,
} from '../fixtures/seed-authority-admin-extras.js';
import {
	resolveAuthorityId,
	fetchNetworkSettings,
	fetchAuthorityProfile,
	fetchAuthorityPeers,
	fetchAdministrationOfficers,
	fetchKeyholders,
	fetchAuthorityInvites,
} from '../../src/screens/panels/authority-admin-queries.js';

const AUTHORITY_ID = 'a1';

/** A schema-loaded, empty database -- no Authority, no User, nothing. */
async function emptyDb() {
	const db = new Database();
	await prepareDb(db);
	return db;
}

/** A database with just the founding shoe-in (Authority/User/Admin/Officer). */
async function foundingDb() {
	const db = new Database();
	await prepareDb(db);
	await seedFoundingAuthority(db);
	return db;
}

// --- resolveAuthorityId -------------------------------------------------

test('resolveAuthorityId: with a Network row present, resolves PrimaryAuthorityId', async () => {
	const db = await foundingDb();
	await seedNetwork(db, { authorityId: AUTHORITY_ID });
	assert.equal(await resolveAuthorityId(db), AUTHORITY_ID);
});

test('resolveAuthorityId: with no Network row but exactly one Authority, resolves that Authority.Id', async () => {
	const db = await foundingDb();
	assert.equal(await resolveAuthorityId(db), AUTHORITY_ID);
});

test('resolveAuthorityId: with neither a Network row nor any Authority, resolves null without throwing', async () => {
	const db = await emptyDb();
	assert.equal(await resolveAuthorityId(db), null);
});

test('resolveAuthorityId: with db === null, resolves null', async () => {
	assert.equal(await resolveAuthorityId(null), null);
});

// --- fetchNetworkSettings ------------------------------------------------

test('fetchNetworkSettings: resolves parsed Relays/TimestampAuthorities, NumberRequiredTSAs as a number, and ElectionTypeName', async () => {
	const db = await foundingDb();
	await seedNetwork(db, { authorityId: AUTHORITY_ID });
	const settings = await fetchNetworkSettings(db);
	assert.ok(settings);
	assert.equal(settings.Name, 'Gate County Network');
	assert.ok(Array.isArray(settings.Relays));
	assert.equal(settings.Relays.length, 2);
	assert.ok(Array.isArray(settings.TimestampAuthorities));
	assert.equal(typeof settings.NumberRequiredTSAs, 'number');
	assert.equal(settings.NumberRequiredTSAs, 2);
	assert.equal(settings.ElectionType, 'o');
	assert.equal(settings.ElectionTypeName, 'Official');
});

test('fetchNetworkSettings: with no Network row, resolves null', async () => {
	const db = await foundingDb();
	assert.equal(await fetchNetworkSettings(db), null);
});

test('fetchNetworkSettings: malformed Relays JSON resolves Relays: [] rather than throwing', async () => {
	const db = await foundingDb();
	await db.exec(
		`insert into Network (Id,Hash,PrimaryAuthorityId,Name,ImageRef,Relays,TimestampAuthorities,NumberRequiredTSAs,ElectionType)
		 with context SigningNonce = null, Tid = 1
		 values ('net1','h1',:aid,'Malformed Relays Network',null,:relays,'[]',1,'o')`,
		{ aid: AUTHORITY_ID, relays: 'not-valid-json[[[' },
	);
	const settings = await fetchNetworkSettings(db);
	assert.ok(settings);
	assert.deepEqual(settings.Relays, []);
});

test('fetchNetworkSettings: db === null resolves null', async () => {
	assert.equal(await fetchNetworkSettings(null), null);
});

// --- fetchAuthorityProfile ------------------------------------------------

test('fetchAuthorityProfile: resolves Id (the SID)/Name/DomainName/ImageRef for the resolved authority', async () => {
	const db = await foundingDb();
	const profile = await fetchAuthorityProfile(db);
	assert.ok(profile);
	assert.equal(profile.Id, AUTHORITY_ID);
	assert.equal(profile.Name, 'Gate County Elections');
	assert.equal(profile.DomainName, 'gate50.example');
});

test('fetchAuthorityProfile: resolves null when resolveAuthorityId resolves null', async () => {
	const db = await emptyDb();
	assert.equal(await fetchAuthorityProfile(db), null);
});

test('fetchAuthorityProfile: db === null resolves null', async () => {
	assert.equal(await fetchAuthorityProfile(null), null);
});

// --- fetchAuthorityPeers ---------------------------------------------------

test('fetchAuthorityPeers: before the peer rungs run, resolves []', async () => {
	const db = await foundingDb();
	assert.deepEqual(await fetchAuthorityPeers(db), []);
});

test('fetchAuthorityPeers: with two peers seeded, resolves both PeerId values sorted ascending', async () => {
	const db = await foundingDb();
	await seedAuthorityPeers(db, { authorityId: AUTHORITY_ID, peerIds: ['peer-zzz', 'peer-aaa'] });
	const peers = await fetchAuthorityPeers(db);
	assert.deepEqual(peers, ['peer-aaa', 'peer-zzz']);
});

test('fetchAuthorityPeers: db === null resolves []', async () => {
	assert.deepEqual(await fetchAuthorityPeers(null), []);
});

// --- fetchAdministrationOfficers -------------------------------------------

test('fetchAdministrationOfficers: resolves admin + officers, Scopes round-trips as an array of valid Scope codes', async () => {
	const db = await foundingDb();
	const result = await fetchAdministrationOfficers(db);
	assert.ok(result.admin);
	assert.equal(result.officers.length, 1);
	const [officer] = result.officers;
	assert.equal(officer.UserId, 'u1');
	assert.deepEqual(officer.Scopes, ['mel', 'ceb']);

	const scopeCodes = [];
	for await (const row of db.eval(`select Code from Scope`, {})) scopeCodes.push(row.Code);
	for (const code of officer.Scopes) {
		assert.ok(scopeCodes.includes(code), `${code} must be a member of view Scope`);
	}
});

test('fetchAdministrationOfficers: fail-closed -- a future-dated Admin resolves { admin: null, officers: [] }', async () => {
	// The ONLY difference from a positive-control fixture is AdminEffectiveAt,
	// compared side by side here: the founding fixture below uses
	// '2099-01-01T00:00:00.000Z' where seed-founding-authority.js uses
	// '2026-01-01T00:00:00.000Z' -- everything else is identical to that
	// file's own seedFoundingAuthority body.
	const db = await emptyDb();
	const noCtx = 'with context SigningNonce = null, InviteSlotCid = null, InviteSignature = null, Tid = 1';
	const futureEffectiveAt = '2099-01-01T00:00:00.000Z';
	await db.exec(`insert into Authority (Id, Name, DomainName, ImageRef) ${noCtx} values ('a1','Gate County Elections','gate50.example',null)`);
	await db.exec(`insert into User (Id, Name, ImageRef) ${noCtx} values ('u1','Ada Officer',null)`);
	await db.exec(`insert into Admin (AuthorityId, EffectiveAt, ThresholdPolicies) ${noCtx} values ('a1','${futureEffectiveAt}','[]')`);
	await db.exec(
		`insert into Officer (AuthorityId, AdminEffectiveAt, UserId, Title, Scopes) ${noCtx} values ('a1','${futureEffectiveAt}','u1','Clerk','["mel","ceb"]')`,
	);

	const result = await fetchAdministrationOfficers(db);
	assert.deepEqual(
		result,
		{ admin: null, officers: [] },
		'a future-dated Admin.EffectiveAt must make the CurrentAdmin join yield nothing, the same wall-clock behaviour isPrivileged imposes',
	);
});

test('fetchAdministrationOfficers: a malformed (non-array) Scopes value on one officer resolves Scopes: [] for that officer only, others unaffected', async () => {
	const db = await foundingDb();
	await seedOfficerWithMalformedScopes(db, { authorityId: AUTHORITY_ID, userId: 'u2', title: 'Deputy Clerk', scopes: '{}' });

	const result = await fetchAdministrationOfficers(db);
	assert.equal(result.officers.length, 2);
	const founding = result.officers.find((o) => o.UserId === 'u1');
	const malformed = result.officers.find((o) => o.UserId === 'u2');
	assert.ok(founding);
	assert.ok(malformed);
	assert.deepEqual(founding.Scopes, ['mel', 'ceb'], 'the unrelated officer must be unaffected by the malformed one');
	assert.deepEqual(malformed.Scopes, [], 'a well-formed-but-non-array Scopes value must resolve to []');
});

test('fetchAdministrationOfficers: db === null resolves { admin: null, officers: [] }', async () => {
	assert.deepEqual(await fetchAdministrationOfficers(null), { admin: null, officers: [] });
});

// --- fetchKeyholders --------------------------------------------------------

test('fetchKeyholders: resolves [] on the seeded database without throwing', async () => {
	const db = await foundingDb();
	assert.deepEqual(await fetchKeyholders(db), []);
});

test('fetchKeyholders: instrument control -- the same query shape with a non-existent column rejects, naming the column', async () => {
	const db = await foundingDb();
	await assert.rejects(async () => {
		// eslint-disable-next-line no-unused-vars
		for await (const _row of db.eval(`select K.NoSuchColumn from Keyholder K`, {})) {
			/* never reached */
		}
	}, /NoSuchColumn/);
});

test('fetchKeyholders: db === null resolves []', async () => {
	assert.deepEqual(await fetchKeyholders(null), []);
});

test('fetchKeyholders: source text names no key-material column -- a keyholder is an identity here, never key material', async () => {
	const source = readFileSync(dashboardSrc('screens', 'panels', 'authority-admin-queries.js'), 'utf8');
	assert.doesNotMatch(source, /UserKey|PubKey|PrivateKey|ReleaseKey|SignerKey|Signature/i);
});

// --- fetchAuthorityInvites ---------------------------------------------------

test('fetchAuthorityInvites: resolves [] before the invite rungs run, with the same non-existent-column instrument control', async () => {
	const db = await foundingDb();
	assert.deepEqual(await fetchAuthorityInvites(db), []);

	await assert.rejects(async () => {
		// eslint-disable-next-line no-unused-vars
		for await (const _row of db.eval(`select IS_.NoSuchColumn from InviteSlot IS_`, {})) {
			/* never reached */
		}
	}, /NoSuchColumn/);
});

test('fetchAuthorityInvites: an iad invite resolves one entry with Cid/Name/Type/TypeName/Expiration/IsAccepted normalized to a real false/CancelledAt null', async () => {
	const db = await foundingDb();
	await seedAuthorityInvite(db, { authorityId: AUTHORITY_ID, name: 'Neighboring County Authority', expiration: '2026-06-01T00:00:00' });

	const invites = await fetchAuthorityInvites(db);
	assert.equal(invites.length, 1);
	const [invite] = invites;
	assert.equal(invite.Name, 'Neighboring County Authority');
	assert.equal(invite.Type, 'au');
	assert.equal(invite.TypeName, 'Authority');
	assert.equal(invite.Expiration, '2026-06-01T00:00:00');
	assert.equal(invite.IsAccepted, false, 'IsAccepted must be a real boolean false, never the raw 0');
	assert.notEqual(invite.IsAccepted, 0);
	assert.equal(invite.CancelledAt, null);
	assert.ok(typeof invite.Cid === 'string' && invite.Cid.length > 0);
});

test('fetchAuthorityInvites: the iad filter is positive-and-negative -- an iad slot is returned, an other-scope (uai) slot on the same authority is not', async () => {
	const db = await foundingDb();
	await seedAuthorityInvite(db, { authorityId: AUTHORITY_ID, name: 'Neighboring County Authority', expiration: '2026-06-01T00:00:00' });
	await seedOtherScopeInvite(db, { authorityId: AUTHORITY_ID });

	const invites = await fetchAuthorityInvites(db);
	const names = invites.map((i) => i.Name);
	assert.ok(names.includes('Neighboring County Authority'), 'the iad-scoped invite must be present (positive control)');
	assert.ok(
		!names.includes('Wrong-Scope Invite (must not appear as an authority invite)'),
		'the uai-scoped invite must be excluded (negative control) -- an all-empty result could not pass this assertion',
	);
	assert.equal(invites.length, 1);
});

test('fetchAuthorityInvites: db === null resolves []', async () => {
	assert.deepEqual(await fetchAuthorityInvites(null), []);
});

// --- Every fetcher accepts db === null without throwing ---------------------

test('every fetcher resolves its empty shape for db === null, none throws', async () => {
	assert.equal(await resolveAuthorityId(null), null);
	assert.equal(await fetchNetworkSettings(null), null);
	assert.equal(await fetchAuthorityProfile(null), null);
	assert.deepEqual(await fetchAuthorityPeers(null), []);
	assert.deepEqual(await fetchAdministrationOfficers(null), { admin: null, officers: [] });
	assert.deepEqual(await fetchKeyholders(null), []);
	assert.deepEqual(await fetchAuthorityInvites(null), []);
});
