/**
 * rawErrorCopy.authoritiesNetworksTasks.test.tsx — raw-message residue sweep (OI-8.10).
 *
 * One non-peer failure per screen. Each rejection carries engine text (a block path and an
 * authority id); the rendered tree must show the translated generic key and none of that text.
 *   READ sites  -> errorLoadFailedGeneric
 *   WRITE sites -> errorActionFailedGeneric
 * Regression guard (A-3): a device-signing outcome message from the hook still wins.
 */

import React from "react";
import renderer from "react-test-renderer";

const RAW = "Engine X authorityId=a1 block=default/app/Authority";
const HASH_A = "a1b2c3d4".repeat(8);

let mockRejection: unknown;
let mockRouteParams: any = {};
let mockEngines: Record<string, any> = {};
let mockHandlerOutcome: { handled: boolean; message?: string } = { handled: false };
const mockNavigation = {
	navigate: jest.fn(),
	setOptions: jest.fn(),
	goBack: jest.fn(),
	popTo: jest.fn(),
	setParams: jest.fn(),
};
const mockGetEngine = jest.fn(async (name: string): Promise<any> => mockEngines[name]);

jest.mock("react-native-vector-icons/FontAwesome6", () => "FontAwesome6");
jest.mock("react-native-safe-area-context", () => ({
	useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock("@votetorrent/vote-engine/rn", () => ({}), { virtual: true });
jest.mock("../../providers/SettingsProvider", () => ({ useSettings: () => ({ showHelpIcons: false }) }));
jest.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string) => key }),
}));
jest.mock("@react-navigation/native", () => ({
	useTheme: () => ({ colors: new Proxy({}, { get: (_t, p) => `c-${String(p)}` }) }),
	useNavigation: () => mockNavigation,
	useRoute: () => ({ params: mockRouteParams }),
	useFocusEffect: (cb: () => void | (() => void)) => {
		const R = require("react");
		R.useEffect(() => {
			const cleanup = cb();
			return typeof cleanup === "function" ? cleanup : undefined;
			// eslint-disable-next-line react-hooks/exhaustive-deps
		}, []);
	},
}));
jest.mock("../../providers/AppProvider", () => ({
	useApp: () => ({ getEngine: mockGetEngine, isAttestationVerifierProvisioned: () => true }),
}));
jest.mock("../../hooks/useCurrentOfficerScopes", () => ({
	useCurrentOfficerScopes: () => ({ scopes: ["vrg", "cap", "mel", "rad"], loading: false }),
}));
jest.mock("../../hooks/useDeviceSigningErrorHandler", () => ({
	useDeviceSigningErrorHandler: () => () => mockHandlerOutcome,
}));
jest.mock("../../hooks/useMediaPin", () => ({
	useMediaPin: () => ({ reset: jest.fn(), cidFor: () => undefined, statusFor: () => undefined, pin: jest.fn(), isPinning: false }),
}));
jest.mock("../../engines/device-user", () => ({
	getOrCreateDeviceUser: jest.fn(async () => ({ id: "device-user-1", name: "Device User" })),
}));
jest.mock("../../engines/device-signer", () => ({
	createDeviceSigner: jest.fn(async () => async () => ({
		signature: "mock-sig",
		signerKey: "mock-key",
		signerUserId: "device-user-1",
	})),
}));
jest.mock("../elections/components/ElectionRevisionForm", () => ({ ElectionRevisionForm: () => null }));
jest.mock("../tasks/components/AdminSignatureTaskDetails", () => ({ AdminSignatureTaskDetails: () => null }));
jest.mock("../tasks/components/AuthoritySignatureTaskDetails", () => ({ AuthoritySignatureTaskDetails: () => null }));
jest.mock("../tasks/components/NetworkSignatureTaskDetails", () => ({ NetworkSignatureTaskDetails: () => null }));
jest.mock("../tasks/components/ElectionSignatureTaskDetails", () => ({ ElectionSignatureTaskDetails: () => null }));
jest.mock("../tasks/components/ElectionRevisionSignatureTaskDetails", () => ({
	ElectionRevisionSignatureTaskDetails: () => null,
}));
jest.mock("../tasks/components/BallotSignatureTaskDetails", () => ({ BallotSignatureTaskDetails: () => null }));

type Tr = renderer.ReactTestRenderer;

async function flush(n = 15): Promise<void> {
	await renderer.act(async () => {
		for (let i = 0; i < n; i++) await Promise.resolve();
	});
}

async function mount(el: React.ReactElement): Promise<Tr> {
	let tr!: Tr;
	await renderer.act(async () => {
		tr = renderer.create(el);
	});
	await flush();
	return tr;
}

function allText(tr: Tr): string {
	return JSON.stringify(tr.toJSON());
}

function expectCopy(tr: Tr, key: string): void {
	const s = allText(tr);
	expect(s).toContain(key);
	expect(s).not.toContain("Engine X");
	expect(s).not.toContain("authorityId");
	expect(s).not.toContain("default/app");
}

/** Press a control by testID wrapper (ChipButton binds onPressIn, CustomButton onPress). */
async function pressId(tr: Tr, testID: string): Promise<void> {
	const wrapper = tr.root.findByProps({ testID });
	const candidates = wrapper.findAll(
		(n) => typeof n.props.onPressIn === "function" || typeof n.props.onPress === "function",
	);
	expect(candidates.length).toBeGreaterThan(0);
	const target = candidates[0]!;
	await renderer.act(async () => {
		try {
			if (typeof target.props.onPressIn === "function") target.props.onPressIn();
			else await target.props.onPress();
		} catch {
			// a re-thrown write failure is expected on the remove paths
		}
	});
	await flush();
}

/** Press a control by its title. */
async function pressTitle(tr: Tr, title: string): Promise<void> {
	const node = tr.root.findAll(
		(n) => typeof n.props.title === "string" && n.props.title === title && typeof n.props.onPress === "function",
	)[0];
	if (!node) throw new Error(`no control titled ${title}`);
	await renderer.act(async () => {
		try {
			await node.props.onPress();
		} catch {
			// swallowed: the screen renders the failure
		}
	});
	await flush();
}

const reject = async (): Promise<never> => {
	throw mockRejection;
};

const errSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);
afterAll(() => errSpy.mockRestore());

beforeEach(() => {
	jest.clearAllMocks();
	mockRejection = new Error(RAW);
	mockRouteParams = {};
	mockEngines = {};
	mockHandlerOutcome = { handled: false };
});

describe("READ failures show errorLoadFailedGeneric", () => {
	it("PollingDevicesScreen load", async () => {
		mockRouteParams = { authorityId: "auth-1" };
		mockEngines = { authorityConfig: { getPollingDevices: reject } };
		const Screen = require("../authorities/PollingDevicesScreen").default;
		expectCopy(await mount(<Screen />), "errorLoadFailedGeneric");
	});

	it("ProposedAdministrationScreen load", async () => {
		mockRouteParams = { authorityId: "auth-1" };
		mockEngines = { network: { openAuthority: reject } };
		const Screen = require("../authorities/ProposedAdministrationScreen").default;
		expectCopy(await mount(<Screen />), "errorLoadFailedGeneric");
	});

	it("AuthorityPeersScreen load", async () => {
		mockRouteParams = { authorityId: "auth-1" };
		mockEngines = { authorityConfig: { getAuthorityPeers: reject } };
		const Screen = require("../authorities/AuthorityPeersScreen").default;
		expectCopy(await mount(<Screen />), "errorLoadFailedGeneric");
	});

	it("NetworkRevisionScreen load", async () => {
		mockRouteParams = { networkId: "n1" };
		mockEngines = { network: { getDetails: reject } };
		const Screen = require("../networks/NetworkRevisionScreen").default;
		expectCopy(await mount(<Screen />), "errorLoadFailedGeneric");
	});

	it("NetworkStatisticsScreen load", async () => {
		mockRouteParams = { networkId: "n1" };
		mockEngines = { network: { getStatistics: reject } };
		const Screen = require("../networks/NetworkStatisticsScreen").default;
		expectCopy(await mount(<Screen />), "errorLoadFailedGeneric");
	});

	it("RegistrationPolicyScreen load", async () => {
		mockRouteParams = { electionEngine: {}, electionId: "e1", authorityId: "auth-1" };
		mockEngines = { registration: { getElectionRegistrationFields: reject } };
		const Screen = require("../elections/RegistrationPolicyScreen").default;
		expectCopy(await mount(<Screen />), "errorLoadFailedGeneric");
	});

	it("EditElectionScreen load", async () => {
		mockRouteParams = { electionEngine: { getElectionDetails: reject } };
		const Screen = require("../elections/EditElectionScreen").default;
		expectCopy(await mount(<Screen />), "errorLoadFailedGeneric");
	});
});

describe("WRITE failures show errorActionFailedGeneric", () => {
	it("PollingDevicesScreen add", async () => {
		mockRouteParams = { authorityId: "auth-1" };
		mockEngines = { authorityConfig: { getPollingDevices: async () => [], addPollingDevice: reject } };
		const Screen = require("../authorities/PollingDevicesScreen").default;
		const tr = await mount(<Screen />);
		const headerRight = mockNavigation.setOptions.mock.calls.at(-1)![0].headerRight;
		let headerTr!: Tr;
		await renderer.act(async () => {
			headerTr = renderer.create(headerRight());
		});
		await pressId(headerTr, "polling-devices-add-toggle");
		const hashInput = tr.root.findByProps({ testID: "polling-devices-add-hash-input" });
		await renderer.act(async () => {
			hashInput.props.onChangeText(HASH_A);
		});
		await pressId(tr, "polling-devices-add-submit");
		expectCopy(tr, "errorActionFailedGeneric");
	});

	it("PollingDevicesScreen remove", async () => {
		mockRouteParams = { authorityId: "auth-1" };
		mockEngines = {
			authorityConfig: {
				getPollingDevices: async () => [{ authorityId: "auth-1", deviceHash: HASH_A, label: "Precinct 4" }],
				removePollingDevice: reject,
			},
		};
		const Screen = require("../authorities/PollingDevicesScreen").default;
		const tr = await mount(<Screen />);
		await pressId(tr, "polling-devices-remove-" + HASH_A);
		await pressId(tr, "polling-device-remove-" + HASH_A + "-confirm");
		expectCopy(tr, "errorActionFailedGeneric");
	});

	it("ProposedAdministrationScreen propose", async () => {
		mockRouteParams = { authorityId: "auth-1" };
		const authorityEngine = {
			getAdminDetails: async () => ({ admin: { officers: [] } }),
			getDetails: async () => ({ authority: { id: "auth-1", name: "A", domainName: "a.example.org" } }),
			proposeAdmin: reject,
		};
		mockEngines = { network: { openAuthority: async () => authorityEngine, getUser: async () => undefined } };
		const Screen = require("../authorities/ProposedAdministrationScreen").default;
		const tr = await mount(<Screen />);
		await pressTitle(tr, "propose");
		expectCopy(tr, "errorActionFailedGeneric");
	});

	it("AuthorityPeersScreen add", async () => {
		mockRouteParams = { authorityId: "auth-1" };
		mockEngines = { authorityConfig: { getAuthorityPeers: async () => [], addAuthorityPeer: reject } };
		const Screen = require("../authorities/AuthorityPeersScreen").default;
		const tr = await mount(<Screen />);
		await pressId(tr, "authority-peers-add-toggle");
		const input = tr.root.findByProps({ testID: "authority-peers-add-input" });
		await renderer.act(async () => {
			input.props.onChangeText("peer-alpha");
		});
		await pressId(tr, "authority-peers-add-submit");
		expectCopy(tr, "errorActionFailedGeneric");
	});

	it("AuthorityPeersScreen remove", async () => {
		mockRouteParams = { authorityId: "auth-1" };
		mockEngines = {
			authorityConfig: {
				getAuthorityPeers: async () => [{ authorityId: "auth-1", peerId: "peer-alpha" }],
				removeAuthorityPeer: reject,
			},
		};
		const Screen = require("../authorities/AuthorityPeersScreen").default;
		const tr = await mount(<Screen />);
		await pressId(tr, "authority-peers-remove-peer-alpha");
		await pressId(tr, "authority-peers-confirm-peer-alpha-confirm");
		expectCopy(tr, "errorActionFailedGeneric");
	});

	it("NetworkRevisionScreen propose", async () => {
		mockRouteParams = { networkId: "n1" };
		mockEngines = {
			network: {
				getDetails: async () => ({
					network: {
						name: "N",
						imageRef: undefined,
						relays: [],
						policies: { electionType: "adhoc", numberRequiredTSAs: 1, timestampAuthorities: [] },
					},
				}),
				proposeRevision: reject,
			},
		};
		const Screen = require("../networks/NetworkRevisionScreen").default;
		const tr = await mount(<Screen />);
		await pressTitle(tr, "propose");
		expectCopy(tr, "errorActionFailedGeneric");
	});

	const task = {
		type: "signature",
		userId: "user-1",
		signatureType: "ballot",
		network: { name: "Test Network" },
		ballot: { proposed: { id: "ballot-1", description: "Ballot One", timestamp: 1 } },
	};
	const signatureEngine = () => ({
		getTaskSigningStatus: async () => null,
		getSignatureDigest: async () => new Uint8Array([1, 2, 3]),
		completeSignature: reject,
	});

	it("SignatureTaskScreen sign", async () => {
		mockRouteParams = { task };
		mockEngines = { signatureTasksEngine: signatureEngine() };
		const Screen = require("../tasks/SignatureTaskScreen").default;
		const tr = await mount(<Screen />);
		await pressTitle(tr, "sign");
		expectCopy(tr, "errorActionFailedGeneric");
	});

	it("SignatureTaskScreen reject", async () => {
		mockRouteParams = { task };
		mockEngines = { signatureTasksEngine: signatureEngine() };
		const Screen = require("../tasks/SignatureTaskScreen").default;
		const tr = await mount(<Screen />);
		await pressTitle(tr, "reject");
		expectCopy(tr, "errorActionFailedGeneric");
	});

	it("ProposedRevisionScreen resend", async () => {
		mockRouteParams = { name: "N", revision: {} };
		mockEngines = { network: { resendRevision: reject, cancelRevision: reject } };
		const Screen = require("../tasks/ProposedRevisionScreen").default;
		const tr = await mount(<Screen />);
		await pressTitle(tr, "proposedRevisionResendRequest");
		expectCopy(tr, "errorActionFailedGeneric");
	});

	it("ProposedRevisionScreen cancel", async () => {
		mockRouteParams = { name: "N", revision: {} };
		mockEngines = { network: { resendRevision: reject, cancelRevision: reject } };
		const Screen = require("../tasks/ProposedRevisionScreen").default;
		const tr = await mount(<Screen />);
		await pressTitle(tr, "proposedRevisionCancelRequest");
		expectCopy(tr, "errorActionFailedGeneric");
	});
});

describe("A-3 regression guards", () => {
	it("a device-signing outcome message on SignatureTaskScreen still wins", async () => {
		mockHandlerOutcome = { handled: false, message: "deviceSigningErrorLockout" };
		mockRejection = Object.assign(new Error(RAW), { code: "LOCKOUT" });
		mockRouteParams = {
			task: {
				type: "signature",
				userId: "user-1",
				signatureType: "ballot",
				network: { name: "Test Network" },
				ballot: { proposed: { id: "ballot-1", description: "Ballot One", timestamp: 1 } },
			},
		};
		mockEngines = {
			signatureTasksEngine: {
				getTaskSigningStatus: async () => null,
				getSignatureDigest: async () => new Uint8Array([1]),
				completeSignature: reject,
			},
		};
		const Screen = require("../tasks/SignatureTaskScreen").default;
		const tr = await mount(<Screen />);
		await pressTitle(tr, "sign");
		const s = allText(tr);
		expect(s).toContain("deviceSigningErrorLockout");
		expect(s).not.toContain("errorActionFailedGeneric");
		expect(s).not.toContain("Engine X");
	});
	// EditElectionScreen's save path (mapElectionError -> errBallotDeadlineAfterDate) is pinned by
	// peerUnavailable.hookFileScreens.test.tsx H-3 and is not touched by this sweep.
});
