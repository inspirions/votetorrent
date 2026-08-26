/**
 * DashboardSignInCodeScreen.test.tsx — 50-15 Task 3 (CR-04 gap closure).
 *
 * Supersedes the prior `DashboardSignInCodeScreen.confirmGate.test.tsx`
 * (deleted in the same commit): that suite proved only the two-tap
 * confirmation and explicitly disclaimed authentication ("this app exposes
 * no standalone 'prove the officer is present' primitive"). This suite
 * proves the primitive now exists and is load-bearing: `createDeviceSigner`
 * must resolve and its signer must produce a signature BEFORE
 * `exportDashboardSnapshot()` runs, for every reachable path through this
 * screen. The clipboard-clear-on-copy/unmount and
 * raw-engine-message-never-rendered regressions the old suite also pinned
 * are carried forward here rather than lost.
 *
 * ============================================================================
 * DECLARED BLIND SPOT — read before trusting a single green test in this file.
 * ============================================================================
 * `createDeviceSigner` and its returned signer are both `jest.fn()` mocks.
 * This suite proves the SCREEN gates correctly — that it calls the right
 * functions, in the right order, under the right conditions — and proves
 * NOTHING about whether a real biometric prompt appears on real hardware, or
 * about `device-signer.ts`'s own native-bridge behavior (that module has its
 * own suite). Device-proof honesty for the real prompt belongs to this
 * project's on-device ceremony practice (see `50-15-PLAN.md`'s
 * `<human-check>`), not to this file.
 * ============================================================================
 *
 * Mocking pattern mirrored from `RegistrationRequestApprovalScreen.test.tsx`
 * (the established `createDeviceSigner` mock shape) and
 * `ProvisionSigningKeyScreen.test.tsx` (the `code`-carrying rejection shapes:
 * `{ code: 'CANCELED' }`, `{ code: 'NO_KEY_PROVISIONED' }`). This suite does
 * NOT mock `useDeviceSigningErrorHandler` — the real hook is exercised
 * (it depends only on the mocked `useNavigation`/`t` below), so its own
 * routing decisions are proven for real, not re-implemented as a stub.
 */

import React from "react";
import renderer from "react-test-renderer";
import { TextInput } from "react-native";

jest.mock("react-native-vector-icons/FontAwesome6", () => "FontAwesome6");

const mockSetString = jest.fn();
jest.mock("@react-native-clipboard/clipboard", () => ({
	__esModule: true,
	default: {
		setString: (...args: unknown[]) => mockSetString(...(args as [])),
		getString: async () => "",
		hasString: async () => false,
	},
}));

// The real `Footer` reads `useSafeAreaInsets`, which throws outside a
// SafeAreaProvider. Zero insets keep the real Footer (and therefore the real
// button tree this suite presses) in the render.
jest.mock("react-native-safe-area-context", () => ({
	useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

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
			dark: "sentinel-dark",
			light: "sentinel-light",
		},
	}),
	useNavigation: () => ({
		navigate: mockNavigate,
		goBack: mockGoBack,
		setOptions: mockSetOptions,
	}),
}));

jest.mock("../../../providers/SettingsProvider", () => ({
	useSettings: () => ({ showHelpIcons: false }),
}));

// ---------------------------------------------------------------------------
// The shared call-order array. Both the signer mock and the export mock below
// push a label into THIS SAME array — an ordering regression (export before
// sign) is exactly CR-04 with extra steps, and a pair of independent
// `toHaveBeenCalled` assertions would pass on that regression. `jest.mock`
// calls are hoisted above this by babel-plugin-jest-hoist, but their FACTORY
// bodies only run lazily, the first time the mocked module is `require`d
// (inside `renderScreen()`, well after this file's top-level code has
// finished) — by then `callOrder` is a fully initialized module-scope
// binding, so the closures below resolve it correctly despite the visual
// ordering.
// ---------------------------------------------------------------------------
const callOrder: string[] = [];

const mockExportDashboardSnapshot = jest.fn(async () => {
	callOrder.push("exportDashboardSnapshot");
	return { digest: "d" };
});

jest.mock("../../../providers/AppProvider", () => ({
	useApp: () => ({ exportDashboardSnapshot: mockExportDashboardSnapshot }),
}));

jest.mock("../../../engines/engine-factory", () => ({
	isNoNetworkEstablishedError: () => false,
}));

const mockSignerFn = jest.fn(async (_digest: Uint8Array) => {
	callOrder.push("signer-invoked");
	return { signature: "device-signature", signerKey: "device-key", signerUserId: "device-user-1" };
});
const mockCreateDeviceSigner = jest.fn(async (_displayName: string) => {
	callOrder.push("createDeviceSigner");
	return mockSignerFn;
});

jest.mock("../../../engines/device-signer", () => ({
	createDeviceSigner: (...args: unknown[]) => mockCreateDeviceSigner(...(args as [string])),
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

/** Types `text` into the confirm step's typed-confirmation input. */
async function typeConfirmText(tr: renderer.ReactTestRenderer, text: string): Promise<void> {
	const input = tr.root.findByType(TextInput);
	await renderer.act(async () => {
		input.props.onChangeText(text);
	});
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

/** Drives the screen through both confirmation taps, typing the confirm
 * phrase in between (mirrors the real officer flow; the harness's direct
 * `onPress` invocation does not itself honor the button's `disabled` prop,
 * so typing here documents intent even though it is not load-bearing for
 * these particular assertions). */
async function confirmAndGenerate(tr: renderer.ReactTestRenderer): Promise<void> {
	await pressByTitle(tr, "dashboardSignInCodeGenerateButton");
	await typeConfirmText(tr, "iConfirm");
	await pressByTitle(tr, "dashboardSignInCodeGenerateButton");
}

beforeEach(() => {
	jest.clearAllMocks();
	callOrder.length = 0;
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

describe("DashboardSignInCodeScreen — the export cannot be reached without a present officer", () => {
	it("the gate holds: one press (no confirmation) calls neither createDeviceSigner nor exportDashboardSnapshot", async () => {
		const tr = await renderScreen();
		await pressByTitle(tr, "dashboardSignInCodeGenerateButton");

		expect(mockCreateDeviceSigner).not.toHaveBeenCalled();
		expect(mockExportDashboardSnapshot).not.toHaveBeenCalled();
		expect(() => tr.root.findByProps({ testID: "dashboard-signin-code-confirm" })).not.toThrow();
	});

	it("the full happy path: confirm -> signer resolves -> export and mint each exactly once, signer strictly BEFORE export", async () => {
		const tr = await renderScreen();
		await confirmAndGenerate(tr);

		expect(mockCreateDeviceSigner).toHaveBeenCalledTimes(1);
		expect(mockSignerFn).toHaveBeenCalledTimes(1);
		expect(mockExportDashboardSnapshot).toHaveBeenCalledTimes(1);
		expect(mockMint).toHaveBeenCalledTimes(1);
		expect(callOrder).toEqual(["createDeviceSigner", "signer-invoked", "exportDashboardSnapshot"]);

		const json = JSON.stringify(tr.toJSON());
		expect(json).toContain("abc.def");
	});

	it("cancellation exports nothing: the signer rejects CANCELED -> no export, no error banner, screen back at idle", async () => {
		mockSignerFn.mockRejectedValueOnce(Object.assign(new Error("canceled"), { code: "CANCELED" }));

		const tr = await renderScreen();
		await confirmAndGenerate(tr);

		expect(mockExportDashboardSnapshot).not.toHaveBeenCalled();
		expect(mockMint).not.toHaveBeenCalled();
		const json = JSON.stringify(tr.toJSON());
		expect(json).not.toContain("dashboardSignInCodeGenerateFailed");
		// Back at idle: the confirm section is gone and the idle-state button is rendered again.
		expect(() => tr.root.findByProps({ testID: "dashboard-signin-code-confirm" })).toThrow();
		expect(hasPressableTitled(tr, "dashboardSignInCodeGenerateButton")).toBe(true);
	});

	it("unprovisioned device: createDeviceSigner rejects NO_KEY_PROVISIONED -> no export, delegates to the provisioning screen via the existing hook", async () => {
		mockCreateDeviceSigner.mockRejectedValueOnce(
			Object.assign(new Error("no key provisioned"), { code: "NO_KEY_PROVISIONED" }),
		);

		const tr = await renderScreen();
		await confirmAndGenerate(tr);

		expect(mockExportDashboardSnapshot).not.toHaveBeenCalled();
		expect(mockMint).not.toHaveBeenCalled();
		expect(mockNavigate).toHaveBeenCalledWith("ProvisionSigningKey", { reason: "first-run" });
		const json = JSON.stringify(tr.toJSON());
		expect(json).not.toContain("dashboardSignInCodeGenerateFailed");
	});

	it("a genuine signer failure (an error the hook does not claim) -> no export, an InlineError is shown", async () => {
		mockSignerFn.mockRejectedValueOnce(Object.assign(new Error("unexpected"), { code: "SOME_UNRECOGNIZED_CODE" }));

		const tr = await renderScreen();
		await confirmAndGenerate(tr);

		expect(mockExportDashboardSnapshot).not.toHaveBeenCalled();
		expect(mockMint).not.toHaveBeenCalled();
		const json = JSON.stringify(tr.toJSON());
		expect(json).toContain("dashboardSignInCodeGenerateFailed");
	});

	it("a failing export renders a copy-table key, never the raw engine message", async () => {
		const raw = new Error("dashboard-bootstrap-producer: unsupported value type in Registrant.LegalName");
		raw.name = "SnapshotExportError";
		mockExportDashboardSnapshot.mockRejectedValueOnce(raw);

		const tr = await renderScreen();
		await confirmAndGenerate(tr);

		const json = JSON.stringify(tr.toJSON());
		expect(json).toContain("dashboardSignInCodeGenerateFailed");
		expect(json).not.toContain("unsupported value type");
		expect(json).not.toContain("Registrant.LegalName");
	});

	it("the discard control: in the generated state, pressing discard calls clearStagedSignInCode once and returns the screen to idle", async () => {
		const tr = await renderScreen();
		await confirmAndGenerate(tr);
		expect(hasPressableTitled(tr, "dashboardSignInCodeDiscardButton")).toBe(true);

		await pressByTitle(tr, "dashboardSignInCodeDiscardButton");

		expect(mockClear).toHaveBeenCalledTimes(1);
		expect(hasPressableTitled(tr, "dashboardSignInCodeDiscardButton")).toBe(false);
		expect(hasPressableTitled(tr, "dashboardSignInCodeGenerateButton")).toBe(true);
	});

	it("copying the code and then leaving the screen clears the clipboard", async () => {
		const tr = await renderScreen();
		await confirmAndGenerate(tr);
		await pressByTitle(tr, "dashboardSignInCodeCopyButton");
		expect(mockSetString).toHaveBeenCalledWith("abc.def");

		mockSetString.mockClear();
		await renderer.act(async () => {
			tr.unmount();
		});
		mounted.length = 0;
		expect(mockSetString).toHaveBeenCalledWith("");
	});

	it("inertness control: leaving WITHOUT copying does not touch the clipboard at all", async () => {
		const tr = await renderScreen();
		await confirmAndGenerate(tr);

		mockSetString.mockClear();
		await renderer.act(async () => {
			tr.unmount();
		});
		mounted.length = 0;
		expect(mockSetString).not.toHaveBeenCalled();
	});

	it("cancelling the confirmation step withdraws it without exporting anything", async () => {
		const tr = await renderScreen();
		await pressByTitle(tr, "dashboardSignInCodeGenerateButton");
		await pressByTitle(tr, "cancel");

		expect(mockCreateDeviceSigner).not.toHaveBeenCalled();
		expect(mockExportDashboardSnapshot).not.toHaveBeenCalled();
		expect(() => tr.root.findByProps({ testID: "dashboard-signin-code-confirm" })).toThrow();
		expect(hasPressableTitled(tr, "dashboardSignInCodeGenerateButton")).toBe(true);
	});
});
