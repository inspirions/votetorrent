/**
 * AuthorityDetailsScreen.subjectKeyed.test.tsx -- REVIEW/IN-05. The last read kept through a peer
 * failure (gap 7) belongs to the authority it was read for: it is never shown under another
 * authority. Same-authority stale behaviour is unchanged. Scaffold copied from
 * AuthorityDetailsScreen.peerUnavailable.test.tsx.
 */

import React from "react";
import renderer from "react-test-renderer";
import { Text } from "react-native";

jest.mock("react-native-vector-icons/FontAwesome6", () => "FontAwesome6");

const mockT = (key: string) => key;
jest.mock("react-i18next", () => ({
	useTranslation: () => ({ t: mockT }),
}));

const mockNavigate = jest.fn();
const mockGoBack = jest.fn();
const mockSetOptions = jest.fn();
let mockRouteParams: { authority: any } = { authority: null };

jest.mock("@react-navigation/native", () => ({
	useTheme: () => ({
		colors: {
			primary: "sentinel-primary",
			background: "sentinel-background",
			card: "sentinel-card",
			text: "sentinel-text",
			border: "sentinel-border",
			notification: "sentinel-notification",
			error: "sentinel-error",
			textSecondary: "sentinel-textSecondary",
			important: "sentinel-important",
			success: "sentinel-success",
			accent: "sentinel-accent",
			warning: "sentinel-warning",
		},
	}),
	useNavigation: () => ({
		navigate: mockNavigate,
		goBack: mockGoBack,
		setOptions: mockSetOptions,
	}),
	useRoute: () => ({ params: mockRouteParams }),
}));

const ADMIN_ID = "authority-1:2026-10-01T00:00:00";
const EFFECTIVE_AT = Date.UTC(2026, 9, 1);
const AUTHORITY_FIXTURE = { id: "authority-1", name: "Test Authority", domainName: "test.example.org", imageRef: undefined };
const UNA = { userId: "user-una", authorityId: "authority-1", title: "Chair", scopes: ["rad"] };
const BEA = { userId: "user-bea", authorityId: "authority-1", title: "Clerk", scopes: ["vrg"] };

function makeAdminDetails(officers = [UNA]) {
	return {
		admin: { id: ADMIN_ID, authorityId: "authority-1", officers, effectiveAt: EFFECTIVE_AT, thresholdPolicies: [] },
		proposed: undefined,
	};
}

function peerUnavailableError(): Error {
	return Object.assign(
		new Error("Block default/app/Admin is unavailable (cohort-unreachable): the repo could not determine whether it exists"),
		{ name: "BlockUnavailableError", reason: "cohort-unreachable" }
	);
}

const USER_NAMES: Record<string, string> = { "user-una": "Una Test", "user-bea": "Bea Two" };

const mockGetAdminDetails = jest.fn();
const mockGetUser = jest.fn();
const mockAuthorityEngine = { getAdminDetails: mockGetAdminDetails };
const mockNetworkEngine = {
	openAuthority: jest.fn(async () => mockAuthorityEngine),
	getPinnedAuthorities: jest.fn(async () => []),
	pinAuthority: jest.fn(async () => {}),
	unpinAuthority: jest.fn(async () => {}),
	getUser: mockGetUser,
};
const mockGetEngine = jest.fn(async (name: string) => (name === "network" ? mockNetworkEngine : undefined));

jest.mock("../../../providers/AppProvider", () => ({
	useApp: () => ({ getEngine: mockGetEngine }),
}));

async function flush() {
	for (let i = 0; i < 6; i++) {
		// eslint-disable-next-line no-await-in-loop
		await renderer.act(async () => {
			await Promise.resolve();
		});
	}
}

async function renderScreen(): Promise<renderer.ReactTestRenderer> {
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const AuthorityDetailsScreen = require("../AuthorityDetailsScreen").default;
	let tr!: renderer.ReactTestRenderer;
	await renderer.act(async () => {
		tr = renderer.create(<AuthorityDetailsScreen />);
	});
	await flush();
	return tr;
}

function textContent(node: renderer.ReactTestInstance): string {
	return node.children.map((c) => (typeof c === "string" ? c : textContent(c))).join("");
}

function leafTexts(tr: renderer.ReactTestRenderer): string[] {
	return tr.root
		.findAllByType(Text)
		.filter((n) => !n.findAllByType(Text).some((child) => child !== n))
		.map(textContent);
}

function allText(tr: renderer.ReactTestRenderer): string {
	return leafTexts(tr).join(" | ");
}

function noticeShown(tr: renderer.ReactTestRenderer): boolean {
	return tr.root.findAll((n) => n.props?.testID === "peer-read-unavailable-notice").length > 0;
}

async function pressRetry(tr: renderer.ReactTestRenderer) {
	const retry = tr.root.findAll(
		(n) => n.props?.testID === "peer-read-unavailable-retry" && typeof n.props?.onPress === "function"
	);
	expect(retry.length).toBeGreaterThan(0);
	await renderer.act(async () => {
		retry[0].props.onPress();
	});
	await flush();
}


const AUTHORITY_B = { id: "authority-2", name: "Other Authority", domainName: "other.example.org", imageRef: undefined };

let warnSpy: jest.SpyInstance;

beforeEach(() => {
	jest.clearAllMocks();
	mockRouteParams = { authority: AUTHORITY_FIXTURE };
	mockGetUser.mockImplementation(async (userId: string) => ({
		getSummary: async () => ({ id: userId, name: USER_NAMES[userId] }),
	}));
	warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
	warnSpy.mockRestore();
});

describe("AuthorityDetailsScreen -- the last read belongs to its authority (REVIEW/IN-05)", () => {
	it("A-1: re-pointed at authority B whose read fails peer-unavailable, none of A's read is shown", async () => {
		mockGetAdminDetails.mockResolvedValue(makeAdminDetails([UNA]));
		const tr = await renderScreen();
		expect(allText(tr)).toContain("Una Test");

		// Authority B: its engine's administration read cannot reach the other devices.
		const engineB = { getAdminDetails: jest.fn().mockRejectedValue(peerUnavailableError()) };
		mockNetworkEngine.openAuthority.mockImplementation(async (id: string) =>
			id === "authority-2" ? (engineB as any) : (mockAuthorityEngine as any),
		);
		mockRouteParams = { authority: AUTHORITY_B };
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const Screen = require("../AuthorityDetailsScreen").default;
		await renderer.act(async () => {
			tr.update(<Screen />);
		});
		await flush();

		expect(engineB.getAdminDetails).toHaveBeenCalled();
		const text = allText(tr);
		expect(noticeShown(tr)).toBe(true);
		expect(text).toContain("peerReadUnavailableTitle");
		expect(text).not.toContain("peerReadUnavailableStaleBody");
		expect(text).not.toContain("Una Test");
		expect(text).not.toContain("user-una");
		expect(text).not.toContain("Test Authority");
		expect(text).toContain("Other Authority");
	});

	it("A-2: the same authority keeps its stale read with the stale notice after a peer failure", async () => {
		mockGetAdminDetails.mockResolvedValueOnce(makeAdminDetails([UNA, BEA]));
		mockGetUser.mockImplementation(async (userId: string) => {
			if (userId === "user-bea") throw peerUnavailableError();
			return { getSummary: async () => ({ id: userId, name: USER_NAMES[userId] }) };
		});
		const tr = await renderScreen();
		expect(allText(tr)).toContain("Una Test");

		mockGetAdminDetails.mockRejectedValueOnce(peerUnavailableError());
		const retry = tr.root.findAll(
			(n) => n.props?.testID === "peer-read-unavailable-retry" && typeof n.props?.onPress === "function",
		);
		await renderer.act(async () => {
			retry[0].props.onPress();
		});
		await flush();

		const text = allText(tr);
		expect(text).toContain("Una Test");
		expect(text).toContain("peerReadUnavailableStaleBody");
	});
});
