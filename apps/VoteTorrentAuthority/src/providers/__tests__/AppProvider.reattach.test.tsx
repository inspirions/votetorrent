/**
 * AppProvider.reattach.test.tsx — R2 unit coverage (58-05, D-08/D-09/D-10).
 *
 * Proves the cold-start re-attach race is REMOVED (not survived): the init
 * effect awaits CadreNodeProvider's `nodeSettled` (Task 1) before its first
 * `factory.setNode(...)` / `NetworksEngine.open()` call, bounded by
 * `NODE_SETTLE_TIMEOUT_MS` and resolving (never rejecting) to a solo
 * default. Five behaviours, each run against the UNCHANGED AppProvider.tsx
 * first and recorded RED in the SUMMARY (see the plan's acceptance
 * criteria) before being trusted green.
 *
 * `EngineFactory` is faked so the whole instrument is "which node did the
 * factory hold at the moment NetworksEngine.open() was actually called" —
 * the ONLY way to observe which DbFactory backend a real dispatch would
 * have chosen (mirrors the lazy-dispatch shape in engine-factory.ts).
 *
 * House mocking style: named `mock*` module-scope jest.fns behind
 * `jest.mock` factories (AddNetworkScreen.provisioning.test.tsx), with the
 * module under test `require()`'d after all mock setup (rn-db-factory.test.ts
 * / CadreNodeProvider.test.tsx) so mock-prefixed config variables are
 * guaranteed initialized before the mocked modules are first required.
 */

import React from "react";

// ---------------------------------------------------------------------------
// react-native-splash-view — native TurboModule, mocked inert (App.test.tsx
// convention).
// ---------------------------------------------------------------------------
const mockHideSplash = jest.fn();
jest.mock("react-native-splash-view", () => ({
	hideSplash: (...args: unknown[]) => mockHideSplash(...args),
}));

// ---------------------------------------------------------------------------
// @votetorrent/vote-engine/rn — only LocalStorageReact is touched by
// AppProvider's construction path; a bare class stub is enough.
// ---------------------------------------------------------------------------
jest.mock("@votetorrent/vote-engine/rn", () => ({
	LocalStorageReact: class {},
}));

// ---------------------------------------------------------------------------
// rn-db-factory — never actually invoked (EngineFactory is faked below and
// ignores the ctor arg), but the real module pulls in rn-leveldb / native
// LevelDB bindings at import time, so it must be mocked to load at all.
// ---------------------------------------------------------------------------
jest.mock("../../engines/rn-db-factory", () => ({
	rnDbFactory: jest.fn(),
}));

// ---------------------------------------------------------------------------
// ../CadreNodeProvider — the seam under test. `mockCadreHook.current` is
// mutated per-test (and once per re-render in the node-changes case) so the
// SAME test can drive different useCadreNode() return values across renders
// while keeping referential identity where the plan requires it.
// ---------------------------------------------------------------------------
interface FakeNode {
	tag: string;
}

interface CadreHookMockValue {
	node: FakeNode | null;
	syncState: "connected" | "syncing" | "offline";
	configFault: null;
	connectedPeers: (strandId: string) => number;
	nodeSettled: Promise<{ status: "ready" | "failed"; node: FakeNode | null }> | undefined;
}

function defaultCadreHookValue(): CadreHookMockValue {
	return {
		node: null,
		syncState: "offline",
		configFault: null,
		connectedPeers: () => 0,
		nodeSettled: Promise.resolve({ status: "failed", node: null }),
	};
}

const mockCadreHook: { current: CadreHookMockValue } = { current: defaultCadreHookValue() };

jest.mock("../CadreNodeProvider", () => ({
	useCadreNode: () => mockCadreHook.current,
}));

// ---------------------------------------------------------------------------
// ../engines/engine-factory — the whole instrument. FakeEngineFactory records
// every setNode() argument (in order) and, for every NetworksEngine.open()
// call, the node the factory held AT CALL TIME — that recording is the only
// way to observe which backend a real lazy DbFactory dispatch would have
// chosen (see engine-factory.ts:203-206's real dispatch this mirrors).
// ---------------------------------------------------------------------------
interface FakeEngineFactoryInstance {
	currentNode: FakeNode | null;
	setNodeCalls: Array<FakeNode | null>;
	openCalls: Array<{ node: FakeNode | null }>;
}

const mockEngineFactoryInstances: FakeEngineFactoryInstance[] = [];
let mockNetworksToReturn: unknown[] = [{ id: "net1" }];
let mockOpenShouldReject = false;

jest.mock("../../engines/engine-factory", () => {
	class FakeEngineFactory {
		currentNode: FakeNode | null = null;
		setNodeCalls: Array<FakeNode | null> = [];
		openCalls: Array<{ node: FakeNode | null }> = [];
		clearEngineCache = jest.fn();
		setCurrentUser = jest.fn();
		setGetPeerCount = jest.fn();
		hasEngine = jest.fn(() => false);
		isAttestationVerifierProvisioned = jest.fn(() => false);
		exportDashboardSnapshot = jest.fn(async () => ({}));

		private fakeNetworksEngine = {
			getRecentNetworks: jest.fn(async () => mockNetworksToReturn),
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			open: jest.fn(async (_network: any, _user: any) => {
				// Record the node the factory holds RIGHT NOW — the whole point of
				// this fake: proves which backend a real lazy DbFactory dispatch
				// would have chosen at THIS call.
				this.openCalls.push({ node: this.currentNode });
				if (mockOpenShouldReject) {
					throw new Error("open failed");
				}
			}),
		};

		constructor(_localStorage: unknown, _dbFactory: unknown) {
			mockEngineFactoryInstances.push(this as unknown as FakeEngineFactoryInstance);
		}

		setNode(node: FakeNode | null) {
			this.currentNode = node;
			this.setNodeCalls.push(node);
		}

		getNetworksEngine() {
			return this.fakeNetworksEngine;
		}

		getEngine = jest.fn(async (name?: string) => {
			// Dispatch by name (mirrors AddNetworkScreen.provisioning.test.tsx's
			// mockGetEngine — a single catch-all cannot serve both callers).
			if (name === "defaultUser") {
				return { get: jest.fn(async () => ({ name: "Device User" })), set: jest.fn() };
			}
			return {};
		});
	}

	return { EngineFactory: FakeEngineFactory };
});

// ---------------------------------------------------------------------------
// The remaining native/heavy modules AppProvider imports — every one is
// __DEV__-gated or fire-and-forget in the init path, mocked inert so import
// resolves and nothing throws mid-effect.
// ---------------------------------------------------------------------------
const mockGetOrCreateDeviceUser = jest.fn(async (name: string) => ({ id: "u1", name, activeKeys: [] }));
jest.mock("../../engines/device-user", () => ({
	getOrCreateDeviceUser: (name: string) => mockGetOrCreateDeviceUser(name),
}));

jest.mock("../../engines/device-signer", () => ({
	createDeviceSigner: jest.fn(),
}));

const mockMaybeSeedRegistrantFixtures = jest.fn(async () => undefined);
jest.mock("../../engines/registrant-dev-seed", () => ({
	maybeSeedRegistrantFixtures: () => mockMaybeSeedRegistrantFixtures(),
}));

jest.mock("../../screens/registration/attach-sync-bindings", () => ({
	attachSyncBindings: jest.fn(),
}));
jest.mock("../../screens/registration/attach-association-sync-bindings", () => ({
	attachAssociationSyncBindings: jest.fn(),
}));

const mockPurgeLegacyStagedPayload = jest.fn(async () => "clean" as const);
const mockRegisterDashboardSnapshotProvider = jest.fn();
jest.mock("../../services/dashboard-signin-code", () => ({
	purgeLegacyStagedPayload: () => mockPurgeLegacyStagedPayload(),
	registerDashboardSnapshotProvider: (...args: unknown[]) => mockRegisterDashboardSnapshotProvider(...args),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const renderer = require("react-test-renderer");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Text, TouchableOpacity } = require("react-native");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { AppProvider } = require("../AppProvider");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderApp() {
	let tr: import("react-test-renderer").ReactTestRenderer;
	renderer.act(() => {
		tr = renderer.create(
			<AppProvider>
				<Text>child-rendered</Text>
			</AppProvider>,
		);
	});
	// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
	return tr!;
}

/** Flush queued microtasks (settle races, awaited engine calls) without advancing any timer. */
async function flushMicrotasks(turns = 10) {
	await renderer.act(async () => {
		for (let i = 0; i < turns; i++) {
			// eslint-disable-next-line no-await-in-loop
			await Promise.resolve();
		}
	});
}

function findTryAgainButton(tr: import("react-test-renderer").ReactTestRenderer) {
	const touchables = tr.root.findAllByType(TouchableOpacity);
	return touchables.find(
		(t: import("react-test-renderer").ReactTestInstance) =>
			t.findAll((n: import("react-test-renderer").ReactTestInstance) => n.type === Text && n.props.children === "Try Again")
				.length > 0,
	);
}

beforeEach(() => {
	jest.clearAllMocks();
	mockEngineFactoryInstances.length = 0;
	mockNetworksToReturn = [{ id: "net1" }];
	mockOpenShouldReject = false;
	mockCadreHook.current = defaultCadreHookValue();
});

afterEach(() => {
	jest.useRealTimers();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AppProvider cold-start re-attach — D-08/D-09/D-10 (58-05)", () => {
	it(
		'boot settles "ready": the first (and only) open() observes the live node already ' +
			"dispatched into the factory — never null ahead of it (RED today: opens with null)",
		async () => {
			const fakeNode: FakeNode = { tag: "live-node" };
			mockCadreHook.current = {
				...defaultCadreHookValue(),
				nodeSettled: Promise.resolve({ status: "ready", node: fakeNode }),
			};

			renderApp();
			await flushMicrotasks();

			const factory = mockEngineFactoryInstances[0];
			expect(factory.openCalls.length).toBe(1);
			expect(factory.openCalls[0].node).toBe(fakeNode);
			expect(mockHideSplash).toHaveBeenCalledTimes(1);
		},
	);

	it('boot settles "failed": setNode(null), open() still runs on the solo backend, init completes (no hang)', async () => {
		mockCadreHook.current = {
			...defaultCadreHookValue(),
			nodeSettled: Promise.resolve({ status: "failed", node: null }),
		};

		renderApp();
		await flushMicrotasks();

		const factory = mockEngineFactoryInstances[0];
		expect(factory.openCalls.length).toBe(1);
		expect(factory.openCalls[0].node).toBeNull();
		expect(mockHideSplash).toHaveBeenCalledTimes(1);
	});

	it(
		"nodeSettled never settles: no open() before the bound elapses (RED today: opens immediately); " +
			"after NODE_SETTLE_TIMEOUT_MS, init completes on the solo default",
		async () => {
			jest.useFakeTimers();
			mockCadreHook.current = {
				...defaultCadreHookValue(),
				// eslint-disable-next-line @typescript-eslint/no-empty-function
				nodeSettled: new Promise<{ status: "ready" | "failed"; node: FakeNode | null }>(() => {}),
			};

			renderApp();
			await renderer.act(async () => {
				await Promise.resolve();
				await Promise.resolve();
			});

			const factory = mockEngineFactoryInstances[0];
			expect(factory.openCalls.length).toBe(0);
			expect(mockHideSplash).not.toHaveBeenCalled();

			// NODE_SETTLE_TIMEOUT_MS = 15000 (AppProvider.tsx, module-scope, not exported).
			await renderer.act(async () => {
				await jest.advanceTimersByTimeAsync(15000);
			});

			expect(factory.openCalls.length).toBe(1);
			expect(factory.openCalls[0].node).toBeNull();
			expect(mockHideSplash).toHaveBeenCalledTimes(1);
		},
	);

	it(
		"a re-render in which node changes from null to a live node produces no second open() " +
			"(RED today: the [initNonce, node] dep array fires a second init)",
		async () => {
			const fakeNode: FakeNode = { tag: "live-node" };
			mockCadreHook.current = {
				...defaultCadreHookValue(),
				nodeSettled: Promise.resolve({ status: "ready", node: fakeNode }),
			};

			function Harness({ generation }: { generation: number }) {
				// `generation` exists only to force React to re-render this subtree —
				// AppProvider reads the mocked hook fresh on every render.
				void generation;
				return (
					<AppProvider>
						<Text>child-rendered</Text>
					</AppProvider>
				);
			}

			let tr: import("react-test-renderer").ReactTestRenderer;
			renderer.act(() => {
				tr = renderer.create(<Harness generation={0} />);
			});
			await flushMicrotasks();

			const factory = mockEngineFactoryInstances[0];
			expect(factory.openCalls.length).toBe(1);

			// Simulate CadreNode boot completing AFTER the settle already ran: the
			// hook's `node` transitions null -> live, forcing AppProvider to
			// re-render (mirrors the real peer-count effect committing `node`).
			mockCadreHook.current = { ...mockCadreHook.current, node: fakeNode };
			renderer.act(() => {
				// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
				tr!.update(<Harness generation={1} />);
			});
			await flushMicrotasks();

			expect(factory.openCalls.length).toBe(1);
		},
	);

	it('CR-02 "Try Again" survives: when open() rejects, the error view renders, and pressing it runs a second init (second open())', async () => {
		mockOpenShouldReject = true;
		mockCadreHook.current = {
			...defaultCadreHookValue(),
			nodeSettled: Promise.resolve({ status: "failed", node: null }),
		};

		const tr = renderApp();
		await flushMicrotasks();

		const factory = mockEngineFactoryInstances[0];
		expect(factory.openCalls.length).toBe(1);

		const tryAgain = findTryAgainButton(tr);
		expect(tryAgain).toBeDefined();

		renderer.act(() => {
			// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
			tryAgain!.props.onPress();
		});
		await flushMicrotasks();

		expect(factory.openCalls.length).toBe(2);
	});
});
