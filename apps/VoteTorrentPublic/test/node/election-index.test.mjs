/**
 * election-index.test.mjs — tier-1 proof of D-34's registry-walking read seam,
 * driven entirely through INJECTED dependencies: no browser, no IndexedDB, no
 * localStorage. The subject is `src/election-index-source.js`, imported
 * directly by relative path (the D-25 idiom for a module this file EXECUTES
 * rather than merely scans).
 *
 * THE ONE THING TO READ BEFORE EDITING ANY GATE IN THIS FILE (I-15).
 * `attachNetworkDb` calls `openStoreHandle`, which calls `indexedDB.open`,
 * which CREATES an absent store rather than refusing one. On a page that takes
 * its network identifier from the URL (D-33), an unguarded attach therefore
 * lets a link author plant an empty database in a stranger's browser — a
 * WRITE, on a page whose entire premise is anonymous read-only viewing. The
 * mitigation is structural and is asserted below by a ZERO-CALL SPY over
 * `attachNetworkDb`, paired with a control proving that same spy does fire
 * when the registry legitimately holds something. A zero-call assertion with
 * no proof the spy can count is not evidence.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { publicSrc } from '../../../../scripts/lib/source-paths.mjs';
import { loadHeldElections, mergeHeldElections, DEFAULT_INDEX_DEPS } from '../../src/election-index-source.js';

/** Same line-based comment-stripping idiom the repo's other tier-1 assertions
 * use. A checker whose own comment quotes the pattern it greps for is
 * permanently green — this has recurred repeatedly in this repo.
 * @param {string} source @returns {string} */
function stripCommentLines(source) {
	return source
		.split('\n')
		.filter((line) => {
			const trimmed = line.trim();
			return !(trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*'));
		})
		.join('\n');
}

// ---------------------------------------------------------------------------
// The injected dependency double. Deliberately a hand-rolled recorder rather
// than a mocking library: the counts it keeps (attach calls, close calls, the
// exact hash arguments) ARE the evidence several assertions below rest on.
// ---------------------------------------------------------------------------

/**
 * @typedef {object} FakeSpec
 * @property {ReadonlyArray<string>} [networks]        registry entry hashes, in registry order
 * @property {boolean} [registryThrows]                the HARD registry failure (a corrupt stored entry)
 * @property {Record<string, ReadonlyArray<{ Id: string, Title?: string | null, Date: string }>>} [rows]
 * @property {ReadonlyArray<string>} [attachFails]     hashes whose attach throws
 * @property {ReadonlyArray<string>} [listFails]       hashes whose listPublicElections throws
 */

/**
 * @param {FakeSpec} spec
 */
function makeDeps(spec) {
	const networks = spec.networks ?? [];
	const rows = spec.rows ?? {};
	const attachFails = new Set(spec.attachFails ?? []);
	const listFails = new Set(spec.listFails ?? []);

	/** @type {{ attachArgs: string[], closeCount: number, listNetworksCalls: number }} */
	const record = { attachArgs: [], closeCount: 0, listNetworksCalls: 0 };

	const deps = {
		/** @param {unknown} _storage */
		listNetworks(_storage) {
			record.listNetworksCalls += 1;
			if (spec.registryThrows) {
				// The shape `networks-registry.js` really throws: a structurally
				// corrupt stored ENTRY, naming the offending FIELD only.
				const err = new Error('networks-registry: field "bootstrappedAt" is invalid -- must be a string');
				err.name = 'InvalidNetworkRegistryError';
				throw err;
			}
			return networks.map((networkHash) => ({
				networkHash,
				authorityName: 'A',
				domain: 'd',
				officerUserId: 'u',
				bootstrappedAt: '2026-01-01T00:00:00',
			}));
		},
		/** @param {string} networkHash @param {unknown} _options */
		async attachNetworkDb(networkHash, _options) {
			record.attachArgs.push(networkHash);
			if (attachFails.has(networkHash)) {
				// attachNetworkDb closes its own handle before throwing, so a
				// failed attach contributes NO open handle for the caller to
				// close — mirrored here so the attach/close balance assertion
				// measures the real contract rather than a friendlier one.
				throw new Error('attach failed');
			}
			return { __handleFor: networkHash };
		},
		/** @param {unknown} _db */
		async closeNetworkDb(_db) {
			record.closeCount += 1;
		},
		/** @param {{ __handleFor: string }} db */
		async listPublicElections(db) {
			const hash = db.__handleFor;
			if (listFails.has(hash)) throw new Error('list failed');
			return [...(rows[hash] ?? [])];
		},
	};

	return { deps, record };
}

/** @param {string} id @param {string} date @param {string | null} [title] */
function row(id, date, title = `Title of ${id}`) {
	return { Id: id, Title: title, Date: date };
}

// ---------------------------------------------------------------------------
// INERTNESS CONTROL, FIRST. A loader that always returned an empty,
// incomplete result cannot pass this suite.
// ---------------------------------------------------------------------------

test('inertness control: two registry entries, both attaching, each holding one election -> 2 elections, complete, nothing unreadable', async () => {
	const { deps } = makeDeps({
		networks: ['nw-one', 'nw-two'],
		rows: { 'nw-one': [row('e-one', '2026-05-01')], 'nw-two': [row('e-two', '2026-06-01')] },
	});
	const result = await loadHeldElections({}, deps);
	assert.equal(result.elections.length, 2, 'the loader returned nothing from a registry that holds two readable networks');
	assert.equal(result.networksAttempted, 2);
	assert.equal(result.networksUnreadable, 0);
	assert.equal(result.complete, true);
	assert.ok(Object.isFrozen(result), 'the result must be frozen');
});

// ---------------------------------------------------------------------------
// The empty-registry path — I-01's first-time visitor, and the ONE case that
// licenses an UNQUALIFIED "no elections" statement.
// ---------------------------------------------------------------------------

test('an empty registry is COMPLETE: nothing held is a settled finding, not an incomplete one', async () => {
	const { deps, record } = makeDeps({ networks: [] });
	const result = await loadHeldElections({}, deps);
	assert.deepEqual([...result.elections], []);
	assert.equal(result.networksAttempted, 0);
	assert.equal(result.networksUnreadable, 0);
	assert.equal(result.complete, true, 'an empty registry is the ordinary first-visit state and licenses the unqualified claim');
	assert.equal(record.attachArgs.length, 0);
});

// ---------------------------------------------------------------------------
// A FAULT IS NOT A FACT (D-28). A registry the browser cannot parse must map
// to "unreadable", NEVER to "holds nothing" — telling a reader "no elections"
// because the registry threw is a FALSE STATEMENT.
// ---------------------------------------------------------------------------

test('a corrupt registry maps to UNREADABLE, never to notHeld: the loader does not throw, and reports complete === false', async () => {
	const { deps, record } = makeDeps({ registryThrows: true });
	/** @type {unknown} */
	let thrown = null;
	let result;
	try {
		result = await loadHeldElections({}, deps);
	} catch (err) {
		thrown = err;
	}
	assert.equal(thrown, null, 'loadHeldElections must never throw — an anonymous page has no operator to surface a failure to');
	assert.ok(result);
	assert.deepEqual([...result.elections], []);
	assert.equal(result.complete, false, 'a registry that could not be parsed is NOT the same answer as "this browser holds nothing"');
	assert.equal(record.attachArgs.length, 0);
});

test('THE SHAPE THAT DECIDES THE RENDER GUARD: a corrupt registry leaves networksUnreadable at 0 while complete is false', async () => {
	const { deps } = makeDeps({ registryThrows: true });
	const result = await loadHeldElections({}, deps);
	assert.equal(result.networksAttempted, 0);
	assert.equal(result.networksUnreadable, 0, 'nothing was attempted, so nothing can be counted unreadable');
	assert.equal(result.complete, false);
	// Stated as an assertion rather than as a comment, because this is exactly
	// the reasoning a later "simplification" would discard: a render layer
	// gating its qualifier on the COUNTER would leave this case unqualified.
	assert.equal(
		result.networksUnreadable > 0,
		false,
		'a counter-based qualifier gate would let precisely the corrupt-registry case render an unqualified "no elections"',
	);
});

// ---------------------------------------------------------------------------
// A held network that could not be attached.
// ---------------------------------------------------------------------------

test('one of two networks fails to attach: the other network\'s elections still come back, unreadable === 1, complete === false', async () => {
	const { deps } = makeDeps({
		networks: ['nw-good', 'nw-bad'],
		rows: { 'nw-good': [row('e-good', '2026-05-01')] },
		attachFails: ['nw-bad'],
	});
	const result = await loadHeldElections({}, deps);
	assert.deepEqual(
		result.elections.map((e) => e.electionId),
		['e-good'],
	);
	assert.equal(result.networksAttempted, 2);
	assert.equal(result.networksUnreadable, 1);
	assert.equal(result.complete, false);
});

test('listPublicElections throwing for one network has the same shape as an attach failure', async () => {
	const { deps } = makeDeps({
		networks: ['nw-good', 'nw-bad'],
		rows: { 'nw-good': [row('e-good', '2026-05-01')] },
		listFails: ['nw-bad'],
	});
	const result = await loadHeldElections({}, deps);
	assert.deepEqual(
		result.elections.map((e) => e.electionId),
		['e-good'],
	);
	assert.equal(result.networksUnreadable, 1);
	assert.equal(result.complete, false);
});

// ---------------------------------------------------------------------------
// THE CO-OCCURRENCE CASE — the one the qualifier exists for. The list is
// empty AND the answer is incomplete, both at once.
// ---------------------------------------------------------------------------

test('co-occurrence: one network reads fine and holds NOTHING while a second cannot be attached -> empty list AND complete === false', async () => {
	const { deps } = makeDeps({
		networks: ['nw-empty', 'nw-bad'],
		rows: { 'nw-empty': [] },
		attachFails: ['nw-bad'],
	});
	const result = await loadHeldElections({}, deps);
	assert.deepEqual([...result.elections], [], 'the list is empty');
	assert.equal(result.networksAttempted, 2);
	assert.equal(result.networksUnreadable, 1);
	assert.equal(result.complete, false, 'and the answer is incomplete — emptiness and completeness are independent axes');
});

// ---------------------------------------------------------------------------
// Handle hygiene. A live handle is what resurrects a deleted IndexedDB as an
// empty shell, so a failing network must not strand one.
// ---------------------------------------------------------------------------

test('every handle the loader opened is closed, on the success path', async () => {
	const { deps, record } = makeDeps({
		networks: ['nw-one', 'nw-two'],
		rows: { 'nw-one': [row('e-one', '2026-05-01')], 'nw-two': [row('e-two', '2026-06-01')] },
	});
	await loadHeldElections({}, deps);
	assert.equal(record.attachArgs.length, 2);
	assert.equal(record.closeCount, 2, 'attachCount !== closeCount — a handle was left holding a database');
});

test('every handle the loader opened is closed, on the THROWING path too (a read that throws after the handle is open)', async () => {
	const { deps, record } = makeDeps({
		networks: ['nw-one', 'nw-two'],
		rows: { 'nw-one': [row('e-one', '2026-05-01')] },
		listFails: ['nw-two'],
	});
	await loadHeldElections({}, deps);
	assert.equal(record.attachArgs.length, 2);
	assert.equal(record.closeCount, 2, 'a network whose read threw left its handle open');
});

// ---------------------------------------------------------------------------
// ORDER IS A FUNCTION OF THE ELECTION DATA, NEVER OF THE REGISTRY'S ORDER —
// which is the exact ambiguity D-33 cites as its reason for naming both
// identifiers in the address.
// ---------------------------------------------------------------------------

test('reversing the registry order produces a deepEqual election list', async () => {
	const rows = {
		'nw-one': [row('e-alpha', '2026-05-01'), row('e-beta', '2026-09-01')],
		'nw-two': [row('e-gamma', '2026-07-01')],
	};
	const forward = await loadHeldElections({}, makeDeps({ networks: ['nw-one', 'nw-two'], rows }).deps);
	const reverse = await loadHeldElections({}, makeDeps({ networks: ['nw-two', 'nw-one'], rows }).deps);
	assert.deepEqual(
		forward.elections.map((e) => ({ ...e })),
		reverse.elections.map((e) => ({ ...e })),
		'the merged order depends on the registry order — the exact ambiguity D-33 exists to remove',
	);
	assert.deepEqual(
		forward.elections.map((e) => e.electionId),
		['e-beta', 'e-gamma', 'e-alpha'],
		'expected Date descending',
	);
});

test('mergeHeldElections sorts by Date descending then electionId ascending, and is pure', () => {
	const merged = mergeHeldElections([
		[
			{ networkHash: 'nw-a', electionId: 'z-late', title: 'Z', date: '2026-01-01' },
			{ networkHash: 'nw-a', electionId: 'a-late', title: 'A', date: '2026-01-01' },
		],
		[{ networkHash: 'nw-b', electionId: 'm-early', title: 'M', date: '2026-09-09' }],
	]);
	assert.deepEqual(
		merged.map((e) => e.electionId),
		['m-early', 'a-late', 'z-late'],
	);
	assert.ok(Object.isFrozen(merged));
	assert.ok(merged.every((e) => !('date' in e)), 'the Date column must not survive into the rendered shape (D-26 owns instant display)');
});

// ---------------------------------------------------------------------------
// T-54-11-02 / I-15 — THE ZERO-CALL SPY, AND THE CONTROL THAT PROVES IT
// DISCRIMINATES.
// ---------------------------------------------------------------------------

const ATTACKER_HASH = 'nw-attacker-controlled-0001';

test('I-15 ZERO-CALL SPY: a URL-supplied networkHash the registry does not hold reaches NO database call at all', async () => {
	const { deps, record } = makeDeps({ networks: [] });
	const result = await loadHeldElections({ networkHash: ATTACKER_HASH }, deps);
	assert.equal(
		record.attachArgs.length,
		0,
		'a URL-supplied hash reached attachNetworkDb. openStoreHandle CREATES an absent store, so this is a link author ' +
			'planting an empty database in a stranger\'s browser (I-15).',
	);
	assert.equal(result.complete, true, 'an empty registry is still a settled finding');
});

test('I-15 CONTROL: the SAME spy DOES fire when the registry legitimately holds a network — the zero above is a refusal, not a dead wire', async () => {
	const { deps, record } = makeDeps({ networks: ['nw-held'], rows: { 'nw-held': [row('e-held', '2026-05-01')] } });
	await loadHeldElections({ networkHash: ATTACKER_HASH }, deps);
	assert.equal(record.attachArgs.length, 1, 'the attach spy never fires at all — the zero-call assertion above proves nothing');
	assert.deepEqual(record.attachArgs, ['nw-held'], 'the spy fired with a REGISTRY hash, never with the URL-supplied one');
});

test('I-15 CONTROL: the spy is also silent when the registry itself threw, and that silence is likewise proven discriminating by the case above', async () => {
	const { deps, record } = makeDeps({ registryThrows: true });
	await loadHeldElections({ networkHash: ATTACKER_HASH }, deps);
	assert.equal(record.attachArgs.length, 0, 'a corrupt registry must not license an attach of a URL-supplied hash');
});

test('I-15 PROVENANCE: across every shape, every hash ever handed to attachNetworkDb came OUT of the registry — registry membership, not the URL, authorises a database name', async () => {
	/** @type {ReadonlyArray<{ label: string, networks: string[], networkHash: string | null }>} */
	const shapes = [
		{ label: 'empty registry + hostile hash', networks: [], networkHash: ATTACKER_HASH },
		{ label: 'held networks + hostile hash', networks: ['nw-one', 'nw-two'], networkHash: ATTACKER_HASH },
		{ label: 'held networks + a held hash', networks: ['nw-one', 'nw-two'], networkHash: 'nw-two' },
		{ label: 'held networks + no hash', networks: ['nw-one', 'nw-two'], networkHash: null },
		{ label: 'held networks + empty-string hash', networks: ['nw-one'], networkHash: '' },
	];
	let totalAttaches = 0;
	for (const shape of shapes) {
		const { deps, record } = makeDeps({ networks: shape.networks });
		await loadHeldElections({ networkHash: shape.networkHash }, deps);
		totalAttaches += record.attachArgs.length;
		for (const arg of record.attachArgs) {
			assert.ok(shape.networks.includes(arg), `[${shape.label}] attachNetworkDb was handed "${arg}", which is not a registry member`);
		}
		assert.ok(!record.attachArgs.includes(ATTACKER_HASH), `[${shape.label}] the URL-supplied hash reached attachNetworkDb`);
	}
	assert.ok(totalAttaches > 0, 'no shape attached anything — this whole scan would be vacuous');
});

// ---------------------------------------------------------------------------
// Scoping and fallback.
// ---------------------------------------------------------------------------

test('scoping: a networkHash the registry DOES hold attaches only that network', async () => {
	const { deps, record } = makeDeps({
		networks: ['nw-one', 'nw-two'],
		rows: { 'nw-one': [row('e-one', '2026-05-01')], 'nw-two': [row('e-two', '2026-06-01')] },
	});
	const result = await loadHeldElections({ networkHash: 'nw-two' }, deps);
	assert.deepEqual(record.attachArgs, ['nw-two']);
	assert.deepEqual(
		result.elections.map((e) => e.electionId),
		['e-two'],
	);
	assert.equal(result.networksAttempted, 1);
	assert.equal(result.complete, true);
});

test('fallback: a networkHash the registry does NOT hold still shows everything the browser does hold', async () => {
	const { deps, record } = makeDeps({
		networks: ['nw-one', 'nw-two'],
		rows: { 'nw-one': [row('e-one', '2026-05-01')], 'nw-two': [row('e-two', '2026-06-01')] },
	});
	const result = await loadHeldElections({ networkHash: ATTACKER_HASH }, deps);
	assert.deepEqual(record.attachArgs, ['nw-one', 'nw-two']);
	assert.equal(result.elections.length, 2);
});

// ---------------------------------------------------------------------------
// Row shape.
// ---------------------------------------------------------------------------

test('a row with a null or absent Title yields title: null and is STILL LISTED', async () => {
	const { deps } = makeDeps({
		networks: ['nw-one'],
		rows: { 'nw-one': [row('e-null', '2026-05-01', null), { Id: 'e-absent', Date: '2026-04-01' }] },
	});
	const result = await loadHeldElections({}, deps);
	assert.deepEqual(
		result.elections.map((e) => [e.electionId, e.title]),
		[
			['e-null', null],
			['e-absent', null],
		],
	);
});

test('each element carries the networkHash it was read from, so the index can address it with both parameters', async () => {
	const { deps } = makeDeps({ networks: ['nw-one'], rows: { 'nw-one': [row('e-one', '2026-05-01')] } });
	const result = await loadHeldElections({}, deps);
	assert.equal(result.elections[0].networkHash, 'nw-one');
	assert.equal(result.elections[0].title, 'Title of e-one');
});

test('loadHeldElections never throws across every option shape, including hostile ones', async () => {
	/** @type {unknown[]} */
	const optionShapes = [undefined, {}, { networkHash: null }, { networkHash: '' }, { networkHash: ATTACKER_HASH }, { networkHash: 'a'.repeat(10000) }];
	for (const options of optionShapes) {
		const { deps } = makeDeps({ networks: ['nw-one'], rows: { 'nw-one': [row('e-one', '2026-05-01')] } });
		const result = await loadHeldElections(/** @type {never} */ (options), deps);
		assert.ok(Object.isFrozen(result), `result not frozen for options ${JSON.stringify(options)}`);
	}
});

test('DEFAULT_INDEX_DEPS is frozen and holds the four real functions — the deps parameter is a test SEAM over the real modules, never a fixture that ships', () => {
	assert.ok(Object.isFrozen(DEFAULT_INDEX_DEPS));
	for (const name of ['listNetworks', 'attachNetworkDb', 'closeNetworkDb', 'listPublicElections']) {
		assert.equal(typeof (/** @type {Record<string, unknown>} */ (DEFAULT_INDEX_DEPS)[name]), 'function', `DEFAULT_INDEX_DEPS.${name} is not a function`);
	}
});

// ---------------------------------------------------------------------------
// Import discipline (T-54-11-03) — over COMMENT-STRIPPED source, with a
// positive control for each matcher first.
// ---------------------------------------------------------------------------

const SEAM_SOURCE = readFileSync(publicSrc('election-index-source.js'), 'utf8');
const SEAM_STRIPPED = stripCommentLines(SEAM_SOURCE);

/** Assembled rather than written whole, so this file's own source never
 * contains the literal it hunts — the self-tripping-checker failure this repo
 * has manufactured repeatedly. @type {RegExp} */
const OFFICER_SUBPATH_RE = new RegExp(['@votetorrent', 'web-data', 'officer'].join('\\/'));
/** @type {RegExp} */
const DEEP_WEB_DATA_PATH_RE = new RegExp(`from ['"][^'"]*${['packages', 'web-data'].join('\\/')}`);

test('positive control: both import-discipline matchers fire on planted violations (the planted literals are ASSEMBLED, never written whole)', () => {
	const officerPlant = `import { x } from '${['@votetorrent', 'web-data', 'officer'].join('/')}';`;
	const deepPlant = `import { y } from '../../../${['packages', 'web-data'].join('/')}/src/open-db.js';`;
	assert.ok(officerPlant.includes('officer'), 'fixture sanity: the planted line must really name the officer subpath');
	assert.match(officerPlant, OFFICER_SUBPATH_RE, 'the officer-subpath matcher is inert');
	assert.match(deepPlant, DEEP_WEB_DATA_PATH_RE, 'the deep-path matcher is inert');
});

test('benign control: neither matcher fires on the bare public subpath specifier the seam is allowed to use', () => {
	const benign = "import { listNetworks } from '@votetorrent/web-data/public';";
	assert.doesNotMatch(benign, OFFICER_SUBPATH_RE);
	assert.doesNotMatch(benign, DEEP_WEB_DATA_PATH_RE);
});

test('the seam reaches the shared package ONLY through its bare public subpath — never the officer half, never a deep path', () => {
	assert.doesNotMatch(SEAM_STRIPPED, OFFICER_SUBPATH_RE, 'the index seam reaches the officer subpath (D-04)');
	assert.doesNotMatch(SEAM_STRIPPED, DEEP_WEB_DATA_PATH_RE, 'the index seam reaches the shared data package by a deep source path rather than by its bare public subpath');
	assert.ok(SEAM_STRIPPED.includes("'@votetorrent/web-data/public'"), 'sanity: the seam must actually import the public subpath, or this scan is vacuous');
});

test('this test file\'s own RAW source contains zero occurrences of EITHER hunted literal — a checker whose own source quotes its pattern is permanently green (this has recurred repeatedly in this repo)', () => {
	const own = readFileSync(new URL(import.meta.url), 'utf8');
	for (const literal of [['@votetorrent', 'web-data', 'officer'].join('/'), ['packages', 'web-data'].join('/')]) {
		assert.equal(own.split(literal).length - 1, 0, `this file names the hunted literal "${literal}" in its own source`);
	}
});
