/**
 * O-06 failure paths of the boot / select identity repair (harness copied from
 * AppProvider.identityRepair.test.tsx):
 *  - B-1 (REVIEW WR-R4-03): a repair that persisted but whose re-bind fails is rolled back, so
 *    storage, factory, network ctx and engine cache all end on the old id together.
 */
import React from "react";

jest.mock("react-native-splash-view", () => ({ hideSplash: jest.fn() }));
// Read through a stable object (fresh-t mocks loop effects otherwise).
const mockT = { t: (key: string) => key };
jest.mock("react-i18next", () => ({ useTranslation: () => mockT }));
jest.mock("@votetorrent/vote-engine/rn", () => ({
	LocalStorageReact: class {},
	UserEngine: class {},
}));
jest.mock("../../engines/rn-db-factory", () => ({ rnDbFactory: jest.fn() }));
const mockCadre = {
	node: null,
	syncState: "offline",
	configFault: null,
	connectedPeers: () => 0,
	nodeSettled: Promise.resolve({ status: "failed", node: null }),
};
jest.mock("../CadreNodeProvider", () => ({ useCadreNode: () => mockCadre }));

const NETWORK = { hash: "h", name: "n", primaryAuthorityDomainName: "d", relays: [] };
let mockRecent: unknown[] = [];
const mockOpen = jest.fn(async (_n: unknown, _u: unknown) => undefined);
const mockSetCurrentUser = jest.fn();
const mockClearEngineCache = jest.fn();
const mockGetEngineCalls: string[] = [];

jest.mock("../../engines/engine-factory", () => {
	class FakeEngineFactory {
		clearEngineCache = (...a: unknown[]) => mockClearEngineCache(...a);
		cancelPendingStrandWaits = jest.fn();
		setCurrentUser = (...a: unknown[]) => mockSetCurrentUser(...a);
		setGetPeerCount = jest.fn();
		hasEngine = jest.fn(() => false);
		isAttestationVerifierProvisioned = jest.fn(() => false);
		exportDashboardSnapshot = jest.fn(async () => ({}));
		setFirstSyncListener = jest.fn();
		setNode = jest.fn();
		private networks = {
			getRecentNetworks: async () => mockRecent,
			open: (n: unknown, u: unknown) => mockOpen(n, u),
			getEstablishedContext: () => ({ db: {} }),
		};
		getNetworksEngine() {
			return this.networks;
		}
		getEngine = async (name?: string) => {
			mockGetEngineCalls.push(String(name));
			return name === "defaultUser" ? { get: async () => ({ name: "Device User" }), set: jest.fn() } : {};
		};
	}
	return { EngineFactory: FakeEngineFactory };
});

const mockStoredUser = { id: "forked-r", name: "Device User", activeKeys: [] };
const REPAIRED_USER = { id: "network-x", name: "Device User", activeKeys: [] };
jest.mock("../../engines/device-user", () => ({
	getOrCreateDeviceUser: async () => mockStoredUser,
}));
const mockRepair = jest.fn<Promise<{ outcome: string; user?: unknown }>, [unknown]>();
const mockRollback = jest.fn(async (_pair: unknown) => true);
jest.mock("../../engines/device-identity-repair", () => ({
	repairDeviceIdentityForkIfNeeded: (deps: unknown) => mockRepair(deps),
	rollbackDeviceIdentityRepair: (pair: unknown) => mockRollback(pair),
}));
jest.mock("../../engines/device-signer", () => ({ createDeviceSigner: jest.fn() }));
jest.mock("../../engines/registrant-dev-seed", () => ({ maybeSeedRegistrantFixtures: jest.fn(async () => undefined) }));
jest.mock("../../screens/registration/attach-sync-bindings", () => ({ attachSyncBindings: jest.fn() }));
jest.mock("../../services/dashboard-signin-code", () => ({
	purgeLegacyStagedPayload: jest.fn(async () => "clean"),
	registerDashboardSnapshotProvider: jest.fn(),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const renderer = require("react-test-renderer");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Text } = require("react-native");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { AppProvider, useApp } = require("../AppProvider");

let captured: { selectNetwork: (ref: unknown) => Promise<void> } | undefined;
function Probe() {
	captured = useApp();
	return <Text>probe</Text>;
}

async function mount() {
	await renderer.act(async () => {
		renderer.create(
			<AppProvider>
				<Probe />
			</AppProvider>,
		);
		for (let i = 0; i < 20; i++) await Promise.resolve();
	});
}

beforeEach(() => {
	jest.clearAllMocks();
	mockGetEngineCalls.length = 0;
	mockRecent = [];
	captured = undefined;
	jest.spyOn(console, "info").mockImplementation(() => {});
});

describe("AppProvider identity repair failure paths", () => {
	beforeEach(() => {
		mockOpen.mockImplementation(async () => undefined);
	});

	it("B-1 boot: a repaired id whose re-open fails is rolled back everywhere (WR-R4-03)", async () => {
		mockRecent = [NETWORK];
		mockRepair.mockResolvedValue({ outcome: "repaired", user: REPAIRED_USER });
		mockOpen.mockImplementation(async (_n: unknown, u: unknown) => {
			if (u === REPAIRED_USER) throw new Error("cohort-unreachable");
			return undefined;
		});
		jest.spyOn(console, "warn").mockImplementation(() => {});
		await mount();
		expect(mockRepair).toHaveBeenCalledTimes(1);
		expect(mockRollback).toHaveBeenCalledWith({ fromUserId: mockStoredUser.id, toUserId: REPAIRED_USER.id });
		expect(mockSetCurrentUser).toHaveBeenLastCalledWith(mockStoredUser);
		expect(mockOpen).toHaveBeenLastCalledWith(NETWORK, mockStoredUser);
		expect(mockClearEngineCache).toHaveBeenCalledTimes(1);
		// the network engine is rebuilt (against the old user) after the cache was dropped
		expect(mockGetEngineCalls.filter((n) => n === "network").length).toBe(2);
	});

	it("B-1 selectNetwork: the same rollback, and the select still completes", async () => {
		mockRepair.mockResolvedValue({ outcome: "repaired", user: REPAIRED_USER });
		mockOpen.mockImplementation(async (_n: unknown, u: unknown) => {
			if (u === REPAIRED_USER) throw new Error("cohort-unreachable");
			return undefined;
		});
		jest.spyOn(console, "warn").mockImplementation(() => {});
		await mount();
		await renderer.act(async () => {
			await captured!.selectNetwork(NETWORK);
		});
		expect(mockRollback).toHaveBeenCalledTimes(1);
		expect(mockSetCurrentUser).toHaveBeenLastCalledWith(mockStoredUser);
		expect(mockOpen).toHaveBeenLastCalledWith(NETWORK, mockStoredUser);
	});

	it("B-1 control: a successful re-bind never rolls back", async () => {
		mockRecent = [NETWORK];
		mockOpen.mockImplementation(async () => undefined);
		mockRepair.mockResolvedValue({ outcome: "repaired", user: REPAIRED_USER });
		await mount();
		expect(mockRollback).not.toHaveBeenCalled();
		expect(mockSetCurrentUser).toHaveBeenLastCalledWith(REPAIRED_USER);
	});
});
