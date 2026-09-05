/**
 * fret-routing-probe.test.mjs — behaviour contract for
 * `src/peer/fret-routing-probe.js` (`56-20` Task 1).
 *
 * The fakes below fake only the SEAM this module reads (`node.services.fret`,
 * `node.cohortTopicHost`, `node.getConnections`, `node.peerId`) — never
 * `createTierAddressing`/`RingHash`/`hashKey`, which are the REAL, pure,
 * no-I/O functions the probe imports directly from `@optimystic/db-core` and
 * `p2p-fret`. Using the real ring-coordinate math is simpler than
 * reimplementing it and is exactly what lets this suite pin the strict `<`
 * comparison and the window-floor arithmetic against the substrate's own
 * behaviour, not a stand-in for it — the same "fake the seam, not the
 * substrate" discipline `peer-reactivity-bridge.test.mjs` documents for
 * itself.
 *
 * Every `fret.neighborDistance`/`fret.assembleCohort` fake below deliberately
 * IGNORES the coordinate arguments it is called with and returns a
 * caller-configured fixed value — the point of this suite is to pin how the
 * probe INTERPRETS those return values (the strict-`<` branch, the window
 * floor, the `.length` reads), not to re-derive the ring math a real
 * `FretService` would produce for arbitrary fixture bytes.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { probeFretRouting, FRET_ROUTING_PROBE_PREFIX } from '../../src/peer/fret-routing-probe.js';

const TOPIC_ID = new TextEncoder().encode('vt-fixture-topic-id-0123456789abcdef');
const PARTICIPANT_ID = new TextEncoder().encode('12D3KooWFixtureParticipantId0123456789');

/**
 * A fake `node.services.fret`. `neighborDistanceImpl`/`assembleCohortImpl` default to values that
 * would make every behaviour assertion below vacuous if a test forgot to override them, so a
 * missing override fails loudly rather than passing by accident.
 * @param {{ neighborDistanceImpl?: (...args: any[]) => any, assembleCohortImpl?: (...args: any[]) => any, listPeersImpl?: () => any, networkSizeEstimateImpl?: () => any }} [opts]
 */
function makeFakeFret(opts = {}) {
	return {
		neighborDistance: opts.neighborDistanceImpl ?? (() => Number.POSITIVE_INFINITY),
		assembleCohort: opts.assembleCohortImpl ?? (() => []),
		listPeers: opts.listPeersImpl ?? (() => []),
		getNetworkSizeEstimate: opts.networkSizeEstimateImpl ?? (() => ({ size_estimate: 1, confidence: 0, sources: 1 })),
	};
}

/**
 * A fake `OptimysticNode`, exposing only the attachments this module reads.
 * @param {{ fret?: any, omitCohortTopicHost?: boolean, registryAll?: () => any[], connections?: any[], peerIdStr?: string }} [opts]
 */
function makeFakeNode(opts = {}) {
	const fret = opts.fret ?? makeFakeFret();
	/** @type {any} */
	const node = {
		peerId: { toString: () => opts.peerIdStr ?? 'self-peer-id' },
		services: { fret },
		getConnections: () => opts.connections ?? [],
	};
	if (!opts.omitCohortTopicHost) {
		node.cohortTopicHost = { registry: { all: opts.registryAll ?? (() => []) } };
	}
	return node;
}

// ---------------------------------------------------------------------------
// Availability gates
// ---------------------------------------------------------------------------

test('probeFretRouting returns available:false reason:fret-service-absent when node.services.fret is undefined, and never throws', async () => {
	const node = { services: {}, cohortTopicHost: {} };
	const result = await probeFretRouting(node, { topicId: TOPIC_ID, participantId: PARTICIPANT_ID, wantK: 16 });
	assert.deepEqual(result, { available: false, reason: 'fret-service-absent' });
});

test('probeFretRouting returns available:false reason:fret-service-absent when node.services is entirely absent, and never throws', async () => {
	const node = { cohortTopicHost: {} };
	const result = await probeFretRouting(node, { topicId: TOPIC_ID, participantId: PARTICIPANT_ID, wantK: 16 });
	assert.deepEqual(result, { available: false, reason: 'fret-service-absent' });
});

test('probeFretRouting returns available:false reason:cohort-host-absent when node.cohortTopicHost is undefined, and never throws', async () => {
	const node = { services: { fret: makeFakeFret() } };
	const result = await probeFretRouting(node, { topicId: TOPIC_ID, participantId: PARTICIPANT_ID, wantK: 16 });
	assert.deepEqual(result, { available: false, reason: 'cohort-host-absent' });
});

// ---------------------------------------------------------------------------
// inCluster branch — both outcomes, plus the strict-< boundary
// ---------------------------------------------------------------------------

test('probeFretRouting: neighborDistance returning 0 carries selfIndex:0 and inCluster:true', async () => {
	const node = makeFakeNode({ fret: makeFakeFret({ neighborDistanceImpl: () => 0 }) });
	const result = await probeFretRouting(node, { topicId: TOPIC_ID, participantId: PARTICIPANT_ID, wantK: 16 });
	assert.equal(result.selfIndex, 0);
	assert.equal(result.inCluster, true);
});

test('probeFretRouting: neighborDistance returning Number.POSITIVE_INFINITY carries inCluster:false (not permanently true)', async () => {
	const node = makeFakeNode({ fret: makeFakeFret({ neighborDistanceImpl: () => Number.POSITIVE_INFINITY }) });
	const result = await probeFretRouting(node, { topicId: TOPIC_ID, participantId: PARTICIPANT_ID, wantK: 16 });
	assert.equal(result.selfIndex, 'Infinity');
	assert.equal(result.inCluster, false);
});

test('probeFretRouting: wantK:4 with neighborDistance returning 4 carries clusterWindow:4 and inCluster:false (strict <, not <=)', async () => {
	const node = makeFakeNode({ fret: makeFakeFret({ neighborDistanceImpl: () => 4 }) });
	const result = await probeFretRouting(node, { topicId: TOPIC_ID, participantId: PARTICIPANT_ID, wantK: 4 });
	assert.equal(result.clusterWindow, 4);
	assert.equal(result.selfIndex, 4);
	assert.equal(result.inCluster, false);
});

test('probeFretRouting: wantK:4 with neighborDistance returning 3 carries inCluster:true (one below the window is still in-cluster)', async () => {
	const node = makeFakeNode({ fret: makeFakeFret({ neighborDistanceImpl: () => 3 }) });
	const result = await probeFretRouting(node, { topicId: TOPIC_ID, participantId: PARTICIPANT_ID, wantK: 4 });
	assert.equal(result.clusterWindow, 4);
	assert.equal(result.inCluster, true);
});

test('probeFretRouting: wantK:1 carries clusterWindow:2 (the floor of 2 is reproduced)', async () => {
	const node = makeFakeNode({ fret: makeFakeFret({ neighborDistanceImpl: () => 0 }) });
	const result = await probeFretRouting(node, { topicId: TOPIC_ID, participantId: PARTICIPANT_ID, wantK: 1 });
	assert.equal(result.clusterWindow, 2);
});

// ---------------------------------------------------------------------------
// Length reads — never .size
// ---------------------------------------------------------------------------

test('probeFretRouting: cohortSize equals the .length of the array the fake assembleCohort returns', async () => {
	const cohort = ['peer-a', 'peer-b', 'peer-c'];
	const node = makeFakeNode({ fret: makeFakeFret({ assembleCohortImpl: () => cohort }) });
	const result = await probeFretRouting(node, { topicId: TOPIC_ID, participantId: PARTICIPANT_ID, wantK: 16 });
	assert.equal(result.cohortSize, 3);
	assert.deepEqual(result.cohortIds, cohort);
});

test('probeFretRouting: registrySize equals the .length of the array the fake registry.all() returns', async () => {
	const node = makeFakeNode({ registryAll: () => ['coord-engine-a'] });
	const result = await probeFretRouting(node, { topicId: TOPIC_ID, participantId: PARTICIPANT_ID, wantK: 16 });
	assert.equal(result.registrySize, 1);
});

test('probeFretRouting: registrySize is 0 when the fake registry.all() returns an empty array', async () => {
	const node = makeFakeNode({ registryAll: () => [] });
	const result = await probeFretRouting(node, { topicId: TOPIC_ID, participantId: PARTICIPANT_ID, wantK: 16 });
	assert.equal(result.registrySize, 0);
});

// ---------------------------------------------------------------------------
// Structural-facts-only shape
// ---------------------------------------------------------------------------

test('probeFretRouting: every value in the result is a string, a number, a boolean, or an array of strings', async () => {
	const node = makeFakeNode({
		fret: makeFakeFret({
			neighborDistanceImpl: () => 2,
			assembleCohortImpl: () => ['peer-x', 'peer-y'],
			listPeersImpl: () => ['peer-x', 'peer-y', 'peer-z'],
		}),
		registryAll: () => ['coord-engine-a'],
		connections: [{ remotePeer: { toString: () => 'peer-x' } }],
	});
	const result = await probeFretRouting(node, { topicId: TOPIC_ID, participantId: PARTICIPANT_ID, wantK: 4 });
	for (const [key, value] of Object.entries(result)) {
		const isPrimitive = typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
		const isStringArray = Array.isArray(value) && value.every((v) => typeof v === 'string');
		assert.ok(isPrimitive || isStringArray, `key "${key}" carries a non-primitive, non-string-array value: ${JSON.stringify(value)}`);
	}
	// Round-trips through JSON with no loss for a downstream `JSON.stringify` consumer (the wiring
	// site emits `FRET_ROUTING_PROBE_PREFIX + JSON.stringify(result)`).
	const roundTripped = JSON.parse(JSON.stringify(result));
	assert.deepEqual(roundTripped, result);
});

test('probeFretRouting: connectionCount and connectedPeerIds are read from node.getConnections(), de-duplicated', async () => {
	const node = makeFakeNode({
		connections: [
			{ remotePeer: { toString: () => 'peer-a' } },
			{ remotePeer: { toString: () => 'peer-a' } },
			{ remotePeer: { toString: () => 'peer-b' } },
		],
	});
	const result = await probeFretRouting(node, { topicId: TOPIC_ID, participantId: PARTICIPANT_ID, wantK: 16 });
	assert.equal(result.connectionCount, 2);
	assert.deepEqual(result.connectedPeerIds.slice().sort(), ['peer-a', 'peer-b']);
});

// ---------------------------------------------------------------------------
// Module constant
// ---------------------------------------------------------------------------

test('FRET_ROUTING_PROBE_PREFIX is the exact literal the driver greps for', () => {
	assert.equal(FRET_ROUTING_PROBE_PREFIX, 'FRET_ROUTING_PROBE=');
});
