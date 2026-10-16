/**
 * A transient first relay-reservation miss must not cost the Voter its node for the whole process.
 *
 * The Authority hit this on 64-53 (debug authority-reattach-after-settle-timeout): a relaunched
 * keyholder on a loaded emulator logged `[CadreNodeProvider] Boot error: RelayReservationFailedError
 * ... (status: retrying)` while the relay refused nothing and admitted a reservation within the same
 * minute. cadre-core's fail-fast posture (network.requireRelay unset) threw that out of start(); the
 * provider then stopped the node, and nothing re-created it until the app was killed. The Voter's
 * provider runs the same posture in separate code, so a phone Voter relaunched on slow Wi-Fi with a
 * relay named in its bootstrap config never gets a node, and VoterAppProvider never re-opens the
 * joined network (it waits for a node that never comes).
 *
 * CadreNode and the native/ESM deps are virtual-mocked, as in the Authority's provider suite. The
 * fake start() mirrors cadre-core 1.15 `driveControlRelayReservation`: with `network.relayAddrs`
 * named and `network.requireRelay` not `false`, a first attempt that misses its budget throws; with
 * `requireRelay: false` the same drive only logs and start() carries on.
 */

import React from 'react';
import renderer from 'react-test-renderer';

const RELAY_ADDR = '/ip4/203.0.113.9/tcp/4801/ws/p2p/12D3KooWExample';
const BOOT_FLUSH_TURNS = 20;

let mockRelayFirstAttemptMisses = false;
const mockConstructedNodes: Array<{ receivedOptions: unknown; stop: jest.Mock }> = [];

jest.mock(
	'@serfab/cadre-core',
	() => {
		class FakeCadreNode {
			public receivedOptions: unknown;
			public stop = jest.fn(async () => {});
			public start = jest.fn(async () => {
				const network = (this.receivedOptions as {network?: {relayAddrs?: string[]; requireRelay?: boolean}}).network;
				if (mockRelayFirstAttemptMisses && (network?.relayAddrs?.length ?? 0) > 0 && network?.requireRelay !== false) {
					const e = new Error(
						'network.relayAddrs reservation failed (status: retrying): relay reservation request did not complete before the deadline',
					);
					e.name = 'RelayReservationFailedError';
					throw e;
				}
			});
			public getStrand = jest.fn(() => undefined);
			public getMultiaddrs = jest.fn(() => []);
			constructor(opts: unknown) {
				this.receivedOptions = opts;
				mockConstructedNodes.push(this);
			}
			on() {}
			off() {}
		}
		const controlStorageScope = (partyId: string) => 'control-' + Buffer.from(partyId).toString('hex');
		return {CadreNode: FakeCadreNode, controlStorageScope};
	},
	{virtual: true},
);

jest.mock(
	'@optimystic/db-p2p-storage-rn',
	() => ({
		openOptimysticRNDb: jest.fn(() => ({})),
		LevelDBRawStorage: class {},
		loadOrCreateRNPeerKey: jest.fn(async () => ({type: 'Ed25519'})),
	}),
	{virtual: true},
);
jest.mock('@libp2p/websockets', () => ({webSockets: () => ({})}), {virtual: true});
jest.mock('@libp2p/circuit-relay-v2', () => ({circuitRelayTransport: () => ({})}), {virtual: true});
jest.mock('../../engines/storage-guard', () => ({
	createScopedRnStorageProvider: () => Object.assign(() => ({}), {destroyScope: jest.fn(async () => undefined)}),
}));
jest.mock('../../engines/rn-durable-slot', () => ({
	openTrustedOwnerStore: jest.fn(async () => undefined),
	openBootstrapPeerStore: jest.fn(async () => undefined),
}));
jest.mock('../../engines/join-bootstrap', () => ({readJoinBootstrap: jest.fn(async () => [])}));
jest.mock('../../../bootstrap.config.json', () => ({bootstrapNodes: [RELAY_ADDR]}));

const {CadreNodeProvider, useCadreNode} = require('../CadreNodeProvider');

async function bootProvider() {
	const captured: {value: ReturnType<typeof useCadreNode> | null} = {value: null};
	function Probe() {
		captured.value = useCadreNode();
		return null;
	}
	await renderer.act(async () => {
		renderer.create(
			<CadreNodeProvider>
				<Probe />
			</CadreNodeProvider>,
		);
		for (let i = 0; i < BOOT_FLUSH_TURNS; i++) {
			// eslint-disable-next-line no-await-in-loop
			await Promise.resolve();
		}
	});
	return captured;
}

beforeEach(() => {
	mockConstructedNodes.length = 0;
	mockRelayFirstAttemptMisses = false;
});

describe('CadreNodeProvider (Voter) — a first relay reservation that misses its budget', () => {
	it('still boots with a live node, built with network.requireRelay false', async () => {
		mockRelayFirstAttemptMisses = true;
		const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
		try {
			const captured = await bootProvider();

			expect(errorSpy.mock.calls.some(c => c[0] === '[CadreNodeProvider] Boot error:')).toBe(false);
			expect(captured.value!.node).not.toBeNull();
			const node = mockConstructedNodes[mockConstructedNodes.length - 1];
			expect(node.stop).not.toHaveBeenCalled();
			const network = (node.receivedOptions as {network: {relayAddrs: string[]; requireRelay?: boolean}}).network;
			expect(network.relayAddrs).toEqual([RELAY_ADDR]);
			expect(network.requireRelay).toBe(false);
		} finally {
			errorSpy.mockRestore();
		}
	});

	it('boots normally when the first reservation lands (guard)', async () => {
		const captured = await bootProvider();
		expect(captured.value!.node).not.toBeNull();
		expect(mockConstructedNodes).toHaveLength(1);
	});
});
