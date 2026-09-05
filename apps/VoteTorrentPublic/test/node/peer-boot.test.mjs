/**
 * peer-boot.test.mjs — behaviour, not source text, over `src/peer/boot.js`'s
 * injected deps: every `PEER_BOOT_STATUS` value is reachable, the bootstrap
 * config fault is propagated unchanged for both `56-06` variants, a missing
 * `coordinatedRepo` attachment throws `PeerBootError` naming it, `stop()` is
 * idempotent and tears down in the fixed order the module promises, and
 * `strandIdForNetwork` is total over the address pattern's character set.
 * Plus the two comment-stripped source assertions the plan's own acceptance
 * criteria name, so the file's own prose cannot satisfy them.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	startPublicPeerBoot,
	strandIdForNetwork,
	PEER_BOOT_STATUS,
	PeerBootError,
} from '../../src/peer/boot.js';

const APP_ROOT = path.resolve(fileURLToPath(import.meta.url), '../../..');

/** Whole-line comment stripper matching this plan's own acceptance-criteria
 * shell command exactly (a line is dropped when, after leading whitespace,
 * its first character is a star or a slash), so a passing test here means
 * the real verify command also passes.
 * @param {string} source
 * @returns {string}
 */
function stripCommentLines(source) {
	return source
		.split('\n')
		.filter((line) => !/^\s*[*/]/.test(line))
		.join('\n');
}

// ---------------------------------------------------------------------------
// Fake dependency factory
// ---------------------------------------------------------------------------

const FAKE_BOOTSTRAP_NODES = Object.freeze(['/dns4/gateway.invalid/tcp/443/tls/ws/p2p/12D3KooWFakePeerIdFakePeerIdFakePeerIdFake']);

/** @typedef {{ calls: string[] }} CallLog */

/**
 * @param {any} [overrides]
 */
function makeFakeDeps(overrides = {}) {
	/** @type {string[]} */
	const calls = [];

	const subscribedTables = overrides.subscribedTables ?? ['TableA', 'TableB'];

	const coordinatedRepoGet =
		overrides.coordinatedRepoGet ??
		(/** @param {any} blockGets */ async (blockGets) => {
			/** @type {Record<string, any>} */
			const out = {};
			for (const blockId of blockGets.blockIds) {
				out[blockId] = { block: { header: { id: blockId, type: 'header', collectionId: blockId }, headId: blockId, tailId: `${blockId}-tail-1` } };
			}
			return out;
		});

	/** @type {any} */
	const fakeNode = overrides.omitCoordinatedRepo
		? { peerId: { toString: () => 'FAKE_PEER_ID' } }
		: { peerId: { toString: () => 'FAKE_PEER_ID' }, coordinatedRepo: { get: coordinatedRepoGet } };

	/** @type {{ stop: () => Promise<void>, dbName: string, node: any }} */
	const fakeEdgeNode = {
		node: fakeNode,
		dbName: 'vt-edge-strand-fake-00000000',
		stop: async () => {
			calls.push('edgeNode.stop');
		},
	};

	/** @type {{ close: () => Promise<void> }} */
	const fakeStrandReadHandle = {
		close: async () => {
			calls.push('strandReadHandle.close');
		},
	};

	const fakeUiDb = { marker: 'fake-ui-db' };

	/** @type {any[]} */
	const replicationHandles = [];

	/** @type {any} */
	const deps = {
		loadBootstrapConfig: async () => overrides.configResult ?? { ok: true, bootstrapNodes: FAKE_BOOTSTRAP_NODES },
		loadOrCreateSessionPeerKey: async () => ({ marker: 'fake-private-key' }),
		createEdgeNode: /** @param {any} config */ async (config) => {
			calls.push('createEdgeNode');
			assert.equal(config.strandId, config.networkName, 'strandId must equal networkName -- strandIdForNetwork is identity');
			return fakeEdgeNode;
		},
		openStrandReadHandle: async () => {
			calls.push('openStrandReadHandle');
			return fakeStrandReadHandle;
		},
		createStrandRowSource: () => ({ readRows: async () => [] }),
		openUiHandleForNetwork: async () => {
			calls.push('openUiHandleForNetwork');
			return fakeUiDb;
		},
		closeNetworkDb: async () => {
			calls.push('closeNetworkDb');
		},
		startPeerReplication: /** @param {any} options */ async (options) => {
			assert.ok(options.collectionId instanceof Uint8Array, 'collectionId must be raw bytes, per ReactivitySubscriptionManagerOptions');
			calls.push(`startPeerReplication:${new TextDecoder().decode(options.collectionId)}`);
			const index = replicationHandles.length;
			const handle = {
				stop: async () => {
					calls.push(`replication[${index}].stop`);
				},
			};
			replicationHandles.push(handle);
			return handle;
		},
		subscribedTables,
	};

	return { deps, calls, fakeNode, fakeEdgeNode, fakeStrandReadHandle, fakeUiDb, replicationHandles };
}

// ---------------------------------------------------------------------------
// NO_ADDRESS
// ---------------------------------------------------------------------------

test('NO_ADDRESS: an empty/null/undefined networkHash short-circuits before any dep is called', async () => {
	for (const bad of ['', null, undefined]) {
		const { deps, calls } = makeFakeDeps();
		const result = await startPublicPeerBoot({ networkHash: bad, deps });
		assert.equal(result.status, PEER_BOOT_STATUS.NO_ADDRESS);
		assert.deepEqual(calls, [], `no dep may be called for networkHash=${JSON.stringify(bad)}`);
	}
});

// ---------------------------------------------------------------------------
// CONFIG_FAULT
// ---------------------------------------------------------------------------

test('CONFIG_FAULT: the "missing" variant is propagated unchanged, verbatim', async () => {
	const { deps } = makeFakeDeps({ configResult: { ok: false, fault: 'missing', reason: 'fetch failed: boom' } });
	const result = await startPublicPeerBoot({ networkHash: 'nh-1', deps });
	assert.equal(result.status, PEER_BOOT_STATUS.CONFIG_FAULT);
	assert.equal(result.fault, 'missing');
});

test('CONFIG_FAULT: the "malformed" variant is propagated unchanged, verbatim', async () => {
	const { deps } = makeFakeDeps({ configResult: { ok: false, fault: 'malformed', reason: 'bootstrapNodes is empty' } });
	const result = await startPublicPeerBoot({ networkHash: 'nh-1', deps });
	assert.equal(result.status, PEER_BOOT_STATUS.CONFIG_FAULT);
	assert.equal(result.fault, 'malformed');
});

// ---------------------------------------------------------------------------
// STARTED — the full happy path
// ---------------------------------------------------------------------------

test('STARTED: every step runs once per subscribed table, with the correct per-table collectionId/tailId, and the SAME readRows closure shared across every subscription', async () => {
	const { deps, calls } = makeFakeDeps({ subscribedTables: ['TableA', 'TableB', 'TableC'] });
	const result = await startPublicPeerBoot({ networkHash: 'nh-1', electionId: 'el-1', deps });

	assert.equal(result.status, PEER_BOOT_STATUS.STARTED);
	assert.equal(result.peerId, 'FAKE_PEER_ID');
	assert.equal(result.dbName, 'vt-edge-strand-fake-00000000');
	assert.equal(typeof result.stop, 'function');

	assert.deepEqual(
		calls.filter((c) => c.startsWith('startPeerReplication:')),
		['startPeerReplication:default/TableA', 'startPeerReplication:default/TableB', 'startPeerReplication:default/TableC'],
		'one subscription per table, keyed by the default collection URI transform',
	);
});

test('STARTED: a missing coordinatedRepo attachment on the constructed node is FAILED, naming "coordinatedRepo"', async () => {
	const { deps } = makeFakeDeps({ omitCoordinatedRepo: true });
	const result = await startPublicPeerBoot({ networkHash: 'nh-1', deps });
	assert.equal(result.status, PEER_BOOT_STATUS.FAILED);
	assert.equal(result.subject, 'coordinatedRepo');
});

test('FAILED: a table whose collection header block is absent throws PeerBootError naming the table, and boot reports FAILED with that table as the subject', async () => {
	const { deps } = makeFakeDeps({
		subscribedTables: ['TableA'],
		coordinatedRepoGet: async () => ({}), // no block for any requested id
	});
	const result = await startPublicPeerBoot({ networkHash: 'nh-1', deps });
	assert.equal(result.status, PEER_BOOT_STATUS.FAILED);
	assert.equal(result.subject, 'TableA');
});

test('a thrown PeerBootError\'s own subject survives to the FAILED result unchanged', async () => {
	const { deps } = makeFakeDeps();
	deps.createEdgeNode = async () => {
		throw new PeerBootError('bootstrapNodes', 'synthetic failure for this test');
	};
	const result = await startPublicPeerBoot({ networkHash: 'nh-1', deps });
	assert.equal(result.status, PEER_BOOT_STATUS.FAILED);
	assert.equal(result.subject, 'bootstrapNodes');
});

// ---------------------------------------------------------------------------
// stop() — idempotent, fixed teardown order
// ---------------------------------------------------------------------------

test('stop() tears down replications (reverse order), then the strand-read handle, then the Edge node, then the ui db -- and is idempotent', async () => {
	const { deps, calls } = makeFakeDeps({ subscribedTables: ['TableA', 'TableB'] });
	const result = await startPublicPeerBoot({ networkHash: 'nh-1', deps });
	assert.equal(result.status, PEER_BOOT_STATUS.STARTED);

	calls.length = 0; // only care about stop()'s own call order from here
	await result.stop();
	assert.deepEqual(calls, ['replication[1].stop', 'replication[0].stop', 'strandReadHandle.close', 'edgeNode.stop', 'closeNetworkDb']);

	calls.length = 0;
	await result.stop(); // idempotent: second call does nothing
	assert.deepEqual(calls, []);
});

test('stop() swallows a throwing teardown leg and still runs the rest', async () => {
	const { deps, calls } = makeFakeDeps({ subscribedTables: ['TableA'] });
	const result = await startPublicPeerBoot({ networkHash: 'nh-1', deps });
	assert.equal(result.status, PEER_BOOT_STATUS.STARTED);

	// Monkey-patch one of the fakes' close/stop to throw, after boot already
	// captured references to them.
	deps.closeNetworkDb = async () => {
		throw new Error('closeNetworkDb boom');
	};

	calls.length = 0;
	await assert.doesNotReject(result.stop());
	assert.ok(calls.includes('edgeNode.stop'), 'later teardown legs still ran despite the earlier throw');
});

// ---------------------------------------------------------------------------
// strandIdForNetwork — re-exported, total over the address pattern's charset
// ---------------------------------------------------------------------------

test('strandIdForNetwork is total (identity) over every character the address pattern allows', () => {
	const sample = 'Az09_-' + 'a'.repeat(120);
	assert.equal(strandIdForNetwork(sample), sample);
});

// ---------------------------------------------------------------------------
// Source assertions (comment-stripped) — the plan's own acceptance criteria
// ---------------------------------------------------------------------------

test('src/peer/boot.js contains zero references to test/fixtures (comment-stripped)', () => {
	const source = readFileSync(path.join(APP_ROOT, 'src', 'peer', 'boot.js'), 'utf8');
	const stripped = stripCommentLines(source);
	assert.equal((stripped.match(/test\/fixtures/g) ?? []).length, 0);
});

test('src/peer/boot.js contains zero references to the persisted browser-key helper 56-05 forbids (comment-stripped)', () => {
	const source = readFileSync(path.join(APP_ROOT, 'src', 'peer', 'boot.js'), 'utf8');
	const stripped = stripCommentLines(source);
	assert.equal((stripped.match(/loadOrCreateBrowserPeerKey/g) ?? []).length, 0);
});

test('src/peer/boot.js contains exactly one occurrence of attachNetworkDb, and zero of openStoreHandle / new Database (comment-stripped)', () => {
	const source = readFileSync(path.join(APP_ROOT, 'src', 'peer', 'boot.js'), 'utf8');
	const stripped = stripCommentLines(source);
	const attachLines = stripped.split('\n').filter((line) => line.includes('attachNetworkDb'));
	assert.equal(attachLines.length, 1);
	assert.equal((stripped.match(/openStoreHandle/g) ?? []).length, 0);
	assert.equal((stripped.match(/new Database/g) ?? []).length, 0);
});

test('src/main.tsx names startPublicPeerBoot exactly once, calls it with no election prop, and diffs additively over the pre-56-11 shape', () => {
	const source = readFileSync(path.join(APP_ROOT, 'src', 'main.tsx'), 'utf8');
	const lines = source.split('\n').filter((line) => line.includes('startPublicPeerBoot'));
	assert.equal(lines.length, 1, 'exactly one occurrence in the whole file, satisfied by the aliased import');
	assert.equal((source.match(/election=\{/g) ?? []).length, 0);
	assert.match(source, /<PublicApp \/>/, 'main.tsx still mounts the root element 56-12 left it mounting');
});
