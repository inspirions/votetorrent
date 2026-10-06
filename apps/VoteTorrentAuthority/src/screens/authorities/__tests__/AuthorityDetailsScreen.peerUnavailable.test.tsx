/**
 * AuthorityDetailsScreen.peerUnavailable.test.tsx — gap 7 (D-23/D-39). On the Redmi, after both
 * apps relaunched and re-dialed, the peered Administration read failed `Block default/app/... is
 * unavailable (cohort-unreachable)` and the screen rendered the failure as ABSENCE: "Effective: N/A"
 * with the officers missing. A read the network could not answer must keep what this device last
 * read, or say plainly that the other devices cannot be reached. Non-peer errors keep today's
 * InlineError path. Mock scaffold mirrors AuthorityDetailsScreen.proposedLabels.test.tsx.
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

describe("AuthorityDetailsScreen — a read the network could not answer is not absence (gap 7)", () => {
	it("first load rejected cohort-unreachable: the unavailable notice renders, never N/A or the raw message", async () => {
		mockGetAdminDetails.mockRejectedValue(peerUnavailableError());
		const tr = await renderScreen();

		expect(noticeShown(tr)).toBe(true);
		const text = allText(tr);
		expect(text).toContain("peerReadUnavailableTitle");
		expect(text).toContain("peerReadUnavailableBody");
		expect(text).not.toContain("peerReadUnavailableStaleBody");
		expect(text).not.toContain("N/A");
		expect(text).not.toContain("effective: ");
		expect(text).not.toContain("is unavailable");
		expect(text).not.toContain("default/app/Admin");
		// No officer cards, and no "revise" action over an administration that was never read.
		expect(tr.root.findAll((n) => n.props?.title === "reviseAdministration")).toHaveLength(0);
		expect(mockGetUser).not.toHaveBeenCalled();
		// The log carries the reason token only.
		const peerLogs = warnSpy.mock.calls.filter((c) => String(c[0]).includes("peer read unavailable"));
		expect(peerLogs).toEqual([["[authority-details] peer read unavailable:", "cohort-unreachable"]]);
	});

	it("loaded then a reload rejected: Una Test and the Effective date stay, plus the stale notice", async () => {
		// First read: the administration loads, but Bea's summary cannot be reached -> stale notice
		// (the only way the Try Again button is on screen while data is shown).
		mockGetAdminDetails.mockResolvedValueOnce(makeAdminDetails([UNA, BEA]));
		mockGetUser.mockImplementation(async (userId: string) => {
			if (userId === "user-bea") throw peerUnavailableError();
			return { getSummary: async () => ({ id: userId, name: USER_NAMES[userId] }) };
		});
		const tr = await renderScreen();
		expect(allText(tr)).toContain("Una Test");
		expect(allText(tr)).toContain("peerReadUnavailableStaleBody");

		const effectiveBefore = leafTexts(tr)[leafTexts(tr).indexOf("effective: ") + 1];
		expect(effectiveBefore).toBeDefined();
		expect(effectiveBefore).not.toBe("N/A");

		// Try Again: the administration read itself now fails cohort-unreachable.
		mockGetAdminDetails.mockRejectedValueOnce(peerUnavailableError());
		await pressRetry(tr);

		expect(mockGetAdminDetails).toHaveBeenCalledTimes(2);
		const text = allText(tr);
		expect(text).toContain("Una Test");
		expect(text).toContain("user-bea"); // Bea's card is still listed (by id) — not dropped
		expect(leafTexts(tr)[leafTexts(tr).indexOf("effective: ") + 1]).toBe(effectiveBefore);
		expect(text).toContain("peerReadUnavailableStaleBody");
		expect(text).not.toContain("peerReadUnavailableTitle");
		expect(text).not.toContain("N/A");
		expect(text).not.toContain("is unavailable");
	});

	it("Try Again re-reads; when the read succeeds the notice goes and the data renders", async () => {
		mockGetAdminDetails.mockRejectedValueOnce(peerUnavailableError()).mockResolvedValueOnce(makeAdminDetails());
		const tr = await renderScreen();
		expect(noticeShown(tr)).toBe(true);

		await pressRetry(tr);

		expect(mockGetAdminDetails).toHaveBeenCalledTimes(2);
		expect(noticeShown(tr)).toBe(false);
		const text = allText(tr);
		expect(text).toContain("Una Test");
		expect(text).toContain("effective: ");
		expect(text).not.toContain("N/A");
	});

	it("a non-peer error keeps today's behaviour: InlineError with the message, no notice", async () => {
		mockGetAdminDetails.mockRejectedValue(new Error("boom"));
		const tr = await renderScreen();

		expect(noticeShown(tr)).toBe(false);
		const text = allText(tr);
		expect(text).toContain("boom");
		expect(text).not.toContain("peerReadUnavailable");
		// Today's absence rendering for a genuine failure is unchanged.
		expect(text).toContain("N/A");
	});
});
