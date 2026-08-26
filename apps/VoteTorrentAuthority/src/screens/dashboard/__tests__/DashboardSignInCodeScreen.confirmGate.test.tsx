/**
 * DashboardSignInCodeScreen.confirmGate.test.tsx — the blocking confirmation
 * in front of the whole-database export.
 *
 * WHAT THIS PINS, AND WHAT IT DOES NOT. It pins that ONE press of the generate
 * button cannot reach `exportDashboardSnapshot()`, and that a second, distinct
 * press does. It does NOT claim the export is authenticated: this app exposes
 * no standalone "prove the officer is present" primitive (its biometric gate is
 * bound to a signing operation), so a confirmation is the floor here, not the
 * equivalent of the ceremony every other authority action goes through.
 *
 * Scaffold mirrored from `SettingsScreen.dashboardSignInCodeEntry.test.tsx`:
 * the REAL screen, a mocked navigation/theme module, pressing the real onPress
 * handlers.
 */

import React from "react";
import renderer from "react-test-renderer";

jest.mock("react-native-vector-icons/FontAwesome6", () => "FontAwesome6");

// The real `Footer` reads `useSafeAreaInsets`, which throws outside a
// SafeAreaProvider. Zero insets keep the real Footer (and therefore the real
// button tree this suite presses) in the render.
jest.mock("react-native-safe-area-context", () => ({
	useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string) => key }),
}));

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
			dark: "sentinel-dark",
			light: "sentinel-light",
		},
	}),
}));

const mockExportDashboardSnapshot = jest.fn(async () => ({ digest: "d" }));

jest.mock("../../../providers/AppProvider", () => ({
	useApp: () => ({ exportDashboardSnapshot: mockExportDashboardSnapshot }),
}));

jest.mock("../../../engines/engine-factory", () => ({
	isNoNetworkEstablishedError: () => false,
}));

const mockMint = jest.fn(async () => ({
	code: "abc.def",
	secret: "a".repeat(40),
	digest: "def",
	expiresAt: "2099-01-01T00:00:00",
	mintedAt: "2099-01-01T00:00:00",
	snapshotName: "snapshot-aaaa",
	snapshotJson: "{}",
}));
const mockClear = jest.fn(async () => undefined);

jest.mock("../../../services/dashboard-signin-code", () => ({
	DASHBOARD_SIGNIN_CODE_SPAN_MINUTES: 10,
	mintDashboardSignInCode: (...args: unknown[]) => mockMint(...(args as [])),
	readStagedSignInCode: async () => undefined,
	clearStagedSignInCode: (...args: unknown[]) => mockClear(...(args as [])),
}));

/** Press the first pressable whose rendered title matches `title`. */
async function pressByTitle(tr: renderer.ReactTestRenderer, title: string): Promise<void> {
	const target = tr.root
		.findAll((node) => typeof node.props?.onPress === "function" && node.props?.title === title)
		.find(Boolean);
	if (!target) throw new Error(`no pressable titled "${title}" is rendered`);
	await renderer.act(async () => {
		target.props.onPress();
	});
	await renderer.act(async () => {
		await Promise.resolve();
	});
}

function hasPressableTitled(tr: renderer.ReactTestRenderer, title: string): boolean {
	return tr.root.findAll((node) => typeof node.props?.onPress === "function" && node.props?.title === title).length > 0;
}

/** Every tree this suite mounts, so `afterEach` can unmount it. The screen
 * runs a 1s countdown interval that keeps firing (and re-rendering) after the
 * Jest environment is torn down otherwise. */
const mounted: renderer.ReactTestRenderer[] = [];

async function renderScreen(): Promise<renderer.ReactTestRenderer> {
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const Screen = require("../DashboardSignInCodeScreen").default;
	let tr!: renderer.ReactTestRenderer;
	await renderer.act(async () => {
		tr = renderer.create(<Screen />);
	});
	await renderer.act(async () => {
		await Promise.resolve();
	});
	mounted.push(tr);
	return tr;
}

beforeEach(() => {
	jest.clearAllMocks();
});

afterEach(async () => {
	while (mounted.length > 0) {
		const tr = mounted.pop();
		// eslint-disable-next-line no-await-in-loop
		await renderer.act(async () => {
			tr?.unmount();
		});
	}
});

describe("DashboardSignInCodeScreen — the export is never one press away", () => {
	it("the first press raises the confirmation and calls neither the export nor the mint", async () => {
		const tr = await renderScreen();
		await pressByTitle(tr, "dashboardSignInCodeGenerateButton");

		expect(mockExportDashboardSnapshot).not.toHaveBeenCalled();
		expect(mockMint).not.toHaveBeenCalled();
		expect(() => tr.root.findByProps({ testID: "dashboard-signin-code-confirm" })).not.toThrow();
		const json = JSON.stringify(tr.toJSON());
		expect(json).toContain("dashboardSignInCodeConfirmHeading");
		expect(json).toContain("dashboardSignInCodeConfirmBody");
	});

	it("positive control: the second, confirming press DOES export and mint exactly once", async () => {
		const tr = await renderScreen();
		await pressByTitle(tr, "dashboardSignInCodeGenerateButton");
		await pressByTitle(tr, "dashboardSignInCodeGenerateButton");

		expect(mockExportDashboardSnapshot).toHaveBeenCalledTimes(1);
		expect(mockMint).toHaveBeenCalledTimes(1);
	});

	it("cancelling withdraws the confirmation without exporting anything", async () => {
		const tr = await renderScreen();
		await pressByTitle(tr, "dashboardSignInCodeGenerateButton");
		await pressByTitle(tr, "cancel");

		expect(mockExportDashboardSnapshot).not.toHaveBeenCalled();
		expect(() => tr.root.findByProps({ testID: "dashboard-signin-code-confirm" })).toThrow();
		expect(hasPressableTitled(tr, "dashboardSignInCodeGenerateButton")).toBe(true);
	});
});
