/**
 * SettingsScreen.dashboardSignInCodeEntry.test.tsx — the D-09 dashboard
 * sign-in code producer entry (50-07).
 *
 * Scaffold mirrored from `SettingsScreen.provisioningEntry.test.tsx` (itself
 * copied from Suite A's `ElectionDetailsScreen.navigation.test.tsx`): a real
 * component + a mocked `@react-navigation/native` module, pressing the REAL
 * screen's own onPress handler. The real navigator really resolving
 * `DashboardSignInCode` is proven separately by
 * `src/navigation/__tests__/phase50Routes.test.tsx`; this suite complements
 * that, it does not duplicate it.
 */

import React from "react";
import renderer from "react-test-renderer";
import fs from "fs";
import path from "path";

jest.mock("react-native-vector-icons/FontAwesome6", () => "FontAwesome6");

jest.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string) => key }),
}));

const mockNavigate = jest.fn();
const mockGoBack = jest.fn();
const mockSetOptions = jest.fn();

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
	useFocusEffect: (cb: () => void | (() => void)) => {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const ReactLib = require("react");
		ReactLib.useEffect(() => {
			cb();
			// eslint-disable-next-line react-hooks/exhaustive-deps
		}, []);
	},
}));

jest.mock("../../../providers/SettingsProvider", () => ({
	useSettings: () => ({ showHelpIcons: false, setShowHelpIcons: jest.fn() }),
}));

jest.mock("../../../providers/AppProvider", () => ({
	useApp: () => ({ getEngine: async () => null }),
}));

jest.mock("../../../engines/engine-factory", () => ({
	// Keeps the no-network path silent per that file's own comment — this
	// screen must be reachable before any network exists.
	isNoNetworkEstablishedError: () => true,
}));

jest.mock("../../../i18n", () => ({
	__esModule: true,
	default: {
		language: "en",
		changeLanguage: jest.fn(async () => {}),
		on: jest.fn(),
		off: jest.fn(),
	},
}));

/** Same helper as Suite A — see ElectionDetailsScreen.navigation.test.tsx for the "why" comment. */
async function press(tr: renderer.ReactTestRenderer, testID: string): Promise<void> {
	const wrapper = tr.root.findByProps({ testID });
	const candidates = wrapper.findAll(
		(node) => typeof node.props.onPressIn === "function" || typeof node.props.onPress === "function",
	);
	expect(candidates.length).toBeGreaterThan(0);
	const target = candidates[0]!;
	await renderer.act(async () => {
		if (typeof target.props.onPressIn === "function") {
			target.props.onPressIn();
		} else {
			target.props.onPress();
		}
	});
	await renderer.act(async () => {
		await Promise.resolve();
	});
}

async function renderScreen(): Promise<renderer.ReactTestRenderer> {
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const SettingsScreenModule = require("../SettingsScreen");
	const SettingsScreen = SettingsScreenModule.default;

	let tr!: renderer.ReactTestRenderer;
	await renderer.act(async () => {
		tr = renderer.create(<SettingsScreen />);
	});
	for (let i = 0; i < 6; i++) {
		// eslint-disable-next-line no-await-in-loop
		await renderer.act(async () => {
			await Promise.resolve();
		});
	}
	return tr;
}

const ENTRY_TESTID = "settings-dashboard-signin-code-entry";

beforeEach(() => {
	jest.clearAllMocks();
});

describe("SettingsScreen — D-09 dashboard sign-in code entry (50-07)", () => {
	it("renders exactly once with the dashboardSignInCodeTitle key as its title", async () => {
		const tr = await renderScreen();
		expect(() => tr.root.findByProps({ testID: ENTRY_TESTID })).not.toThrow();
		const json = JSON.stringify(tr.toJSON());
		expect(json).toContain("dashboardSignInCodeTitle");
	});

	it("pressing it calls navigate exactly once with DashboardSignInCode and no second argument", async () => {
		const tr = await renderScreen();
		await press(tr, ENTRY_TESTID);
		expect(mockNavigate).toHaveBeenCalledTimes(1);
		expect(mockNavigate.mock.calls[0]![0]).toBe("DashboardSignInCode");
		// The route is typed `undefined` — passing params would be a contract drift.
		expect(mockNavigate.mock.calls[0]!.length).toBe(1);
	});

	// No scope gate, asserted as a decision: this entry exports only data the
	// officer's own device already holds, so gating it would hide the feature
	// from exactly the officer who needs it (mirrors 47-22's identical decision
	// for the attestation-provisioning row).
	it("the screen source contains no officer-scope hook", () => {
		const source = fs.readFileSync(path.join(__dirname, "..", "SettingsScreen.tsx"), "utf8");
		const scopeHookName = ["useCurrent", "OfficerScopes"].join("");
		expect(source).not.toContain(scopeHookName);
	});

	it("is placed adjacent to the other device-level provisioning rows (source order)", () => {
		const source = fs.readFileSync(path.join(__dirname, "..", "SettingsScreen.tsx"), "utf8");
		const signingKeyIndex = source.indexOf("settings-signing-key-provisioning-entry");
		const entryIndex = source.indexOf(ENTRY_TESTID);
		const networkBoundaryIndex = source.indexOf("styles.networkTitle");
		expect(signingKeyIndex).toBeGreaterThanOrEqual(0);
		expect(entryIndex).toBeGreaterThan(signingKeyIndex);
		expect(networkBoundaryIndex).toBeGreaterThan(entryIndex);
	});
});
