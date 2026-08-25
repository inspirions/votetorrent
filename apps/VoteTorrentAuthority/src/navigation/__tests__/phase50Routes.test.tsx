/**
 * phase50Routes.test.tsx — the real-navigator registration proof for 50-07's
 * single `DashboardSignInCode` route (D-03/D-05/D-09).
 *
 * Mirrored wholesale from `phase48Routes.test.tsx` (itself mirrored from
 * `phase47Routes.test.tsx`): "a rename or removal of a route name, a
 * registration, or an entry card severs the only user path into an entire
 * phase's UI with nothing going red." Renders the REAL `RootNavigator`
 * (src/navigation/index.tsx) inside a REAL `NavigationContainer` +
 * `SafeAreaProvider`. Only the DESTINATION screen module is replaced with a
 * marker component — the `Stack.Screen` registration, its route-name string
 * and its title binding are all the untouched production code from
 * `navigation/index.tsx`. `navigation/index.tsx` is never mocked.
 */

import React from "react";
import renderer from "react-test-renderer";
import fs from "fs";
import path from "path";

// Rendering the REAL RootNavigator eagerly loads every screen module in the
// app, so the FIRST test in this file pays the whole module-graph cost — see
// phase48Routes.test.tsx's identical comment; the render breadth *is* the
// proof, so raise the timeout rather than shortening the render.
jest.setTimeout(30_000);

jest.mock("react-native-vector-icons/FontAwesome6", () => "FontAwesome6");

jest.mock("react-native-splash-view", () => ({ hideSplash: jest.fn() }));

jest.mock("../../providers/AppProvider", () => ({
	useApp: () => ({}),
	AppProvider: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock("../../providers/CadreNodeProvider", () => ({
	useCadreNode: () => ({ node: null, syncState: "offline", connectedPeers: () => 0 }),
	CadreNodeProvider: ({ children }: { children: React.ReactNode }) => children,
}));

let mockDashboardSignInCodeParams: unknown = "unset";

jest.mock("../../screens/dashboard/DashboardSignInCodeScreen", () => ({
	__esModule: true,
	default: function MockDashboardSignInCodeScreen() {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const ReactLib = require("react");
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const { Text } = require("react-native");
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const { useRoute } = require("@react-navigation/native");
		mockDashboardSignInCodeParams = (useRoute() as any).params;
		return ReactLib.createElement(
			Text,
			{ testID: "mock-dashboard-signin-code-screen" },
			"mock-dashboard-signin-code-screen",
		);
	},
}));

async function renderRootNavigatorAt(
	initialState: { index: number; routes: Array<{ name: string; params?: unknown }> },
): Promise<renderer.ReactTestRenderer> {
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const { NavigationContainer } = require("@react-navigation/native");
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const { SafeAreaProvider } = require("react-native-safe-area-context");
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const { RootNavigator } = require("../index");
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const { lightTheme } = require("../../theme/themes");

	let tr!: renderer.ReactTestRenderer;
	await renderer.act(async () => {
		tr = renderer.create(
			<SafeAreaProvider
				initialMetrics={{
					frame: { x: 0, y: 0, width: 320, height: 640 },
					insets: { top: 0, left: 0, right: 0, bottom: 0 },
				}}
			>
				<NavigationContainer theme={lightTheme} initialState={initialState}>
					<RootNavigator />
				</NavigationContainer>
			</SafeAreaProvider>,
		);
	});
	for (let i = 0; i < 6; i++) {
		// eslint-disable-next-line no-await-in-loop
		await renderer.act(async () => {
			await Promise.resolve();
		});
	}
	return tr;
}

beforeEach(() => {
	mockDashboardSignInCodeParams = "unset";
});

describe("RootNavigator — the DashboardSignInCode route is really registered and really resolves (50-07, D-09)", () => {
	it("resolves DashboardSignInCode to its destination marker with no params", async () => {
		const tr = await renderRootNavigatorAt({
			index: 0,
			routes: [{ name: "DashboardSignInCode" }],
		});
		expect(() => tr.root.findByProps({ testID: "mock-dashboard-signin-code-screen" })).not.toThrow();
		expect(mockDashboardSignInCodeParams).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Source-level gates. native-stack renders its header outside the asserted
// subtree under react-test-renderer, so the honest available proof that the
// Stack.Screen registration binds the right title key is a source assertion,
// not a render assertion.
// ---------------------------------------------------------------------------

const NAV_INDEX_PATH = path.join(__dirname, "..", "index.tsx");

/** Extracts the substring from `name="<Route>"` to the next `/>` in navigation/index.tsx. */
function extractRegistration(source: string, routeName: string): string {
	const marker = `name="${routeName}"`;
	const start = source.indexOf(marker);
	expect(start).toBeGreaterThanOrEqual(0);
	const end = source.indexOf("/>", start);
	expect(end).toBeGreaterThan(start);
	return source.slice(start, end + 2);
}

describe("navigation/index.tsx — DashboardSignInCode title-binding source gate (50-07)", () => {
	const source = fs.readFileSync(NAV_INDEX_PATH, "utf8");

	it("binds component DashboardSignInCodeScreen and title key dashboardSignInCodeTitle", () => {
		const registration = extractRegistration(source, "DashboardSignInCode");
		expect(registration).toContain("DashboardSignInCodeScreen");
		expect(registration).toContain('t("dashboardSignInCodeTitle")');
	});

	it("carries none of presentation/CloseButton/headerLeft/headerRight", () => {
		const registration = extractRegistration(source, "DashboardSignInCode");
		expect(registration).not.toContain("presentation");
		expect(registration).not.toContain("CloseButton");
		expect(registration).not.toContain("headerLeft");
		expect(registration).not.toContain("headerRight");
	});
});

describe("i18n/index.ts — dashboardSignInCodeTitle binding gate (50-07)", () => {
	it("the title key appears at least twice (EN and ES) — a missing key does not throw at runtime", () => {
		const i18n = fs.readFileSync(path.join(__dirname, "..", "..", "i18n", "index.ts"), "utf8");
		const count = (i18n.match(/\bdashboardSignInCodeTitle:/g) || []).length;
		expect(count).toBeGreaterThanOrEqual(2);
	});
});

describe("navigation/types.ts — param-hygiene source gate (50-07)", () => {
	it("DashboardSignInCode is typed undefined — no params", () => {
		const source = fs.readFileSync(path.join(__dirname, "..", "types.ts"), "utf8");
		expect(source).toContain("DashboardSignInCode: undefined;");
	});
});

describe("SettingsScreen.tsx — entry-point source gate (50-07)", () => {
	it("contains the dashboard sign-in code entry row, its testID, and its DashboardSignInCode navigate target", () => {
		const source = fs.readFileSync(
			path.join(__dirname, "..", "..", "screens", "settings", "SettingsScreen.tsx"),
			"utf8",
		);
		expect(source).toContain("settings-dashboard-signin-code-entry");
		expect(source).toContain('"DashboardSignInCode"');
		expect(source).toContain('t("dashboardSignInCodeTitle")');
	});
});
