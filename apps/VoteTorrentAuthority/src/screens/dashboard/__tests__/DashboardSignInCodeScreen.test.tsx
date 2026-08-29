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
 *
 * The upload cases added for the sealed-push sequence inherit that blind spot
 * and widen it. `bootstrap-upload` is mocked here too, so these cases prove
 * the SCREEN'S STATE MACHINE and its copy selection — which phase renders
 * when, which key is chosen for which classification, that nothing is
 * rendered before the mint resolves — and prove NOTHING about a real HTTP
 * round trip, a real rendezvous service, a real seal, or a real biometric.
 * Emulator results are not evidence for the last of those either: real
 * devices return `ERROR_NEGATIVE_BUTTON 13` / `ERROR_USER_CANCELED 10` where
 * an emulator returns a generic `ERROR_CANCELED 5`. The hardware leg is what
 * closes all of it; nothing in this file substitutes for it.
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

/** The code the officer would read out. Deliberately a DIFFERENT canary from
 * the secret below, so "no code is rendered" and "no secret is rendered" fail
 * independently rather than one standing in for the other. */
const CODE_CANARY = "abc.def";
const SECRET_CANARY = "5ecre7canary5ecre7canary5ecre7canary0000";

/** The push-path return shape. `snapshotJson` is ABSENT: after the producer
 * core landed, a mint given an uploader strips the payload from what it
 * returns, so a double still carrying it would model a shape production can
 * no longer produce. */
const MINTED_RECORD = {
	code: CODE_CANARY,
	secret: SECRET_CANARY,
	digest: "def",
	lookupId: "lookupIdlookupIdlookupIdlookupIdlookupIdAAA",
	expiresAt: "2099-01-01T00:00:00",
	mintedAt: "2099-01-01T00:00:00",
	snapshotName: "snapshot-aaaa",
};

/** Every options bag the mint was handed, in call order. */
const mintOptions: Array<Record<string, unknown>> = [];
/** When set, the mint returns THIS promise instead of resolving, so a test
 * can hold the upload in flight and observe the tree mid-sequence. */
let pendingMint: { promise: Promise<unknown>; resolve: (value: unknown) => void } | undefined;

const mockMint = jest.fn(async (_snapshot: unknown, options?: Record<string, unknown>) => {
	callOrder.push("mint");
	mintOptions.push(options ?? {});
	if (pendingMint !== undefined) return pendingMint.promise;
	return MINTED_RECORD;
});
const mockClear = jest.fn(async () => undefined);
const mockRead = jest.fn(async (): Promise<unknown> => undefined);

jest.mock("../../../services/dashboard-signin-code", () => ({
	DASHBOARD_SIGNIN_CODE_SPAN_MINUTES: 10,
	mintDashboardSignInCode: (...args: unknown[]) => mockMint(...(args as [unknown])),
	readStagedSignInCode: (...args: unknown[]) => mockRead(...(args as [])),
	clearStagedSignInCode: (...args: unknown[]) => mockClear(...(args as [])),
}));

// ---------------------------------------------------------------------------
// The uploader seam. Only the two functions that would touch the network (or
// read a dev-time constant) are replaced; `uploadFailureCopyKey` is the REAL
// one, via `requireActual`. Reproducing its mapping here would let the screen
// and the service drift apart silently and still pass — the assertion that
// matters is that the screen picks the key the shipped map actually returns.
// ---------------------------------------------------------------------------
let uploadConfigured = true;
let lastFailureReason: string | undefined;

const mockUpload = jest.fn(async () => undefined);
const uploadHandle = {
	upload: mockUpload,
	lastFailureReason: () => lastFailureReason,
};
const mockCreateUploadHandle = jest.fn(() => uploadHandle);
const mockIsUploadConfigured = jest.fn(() => uploadConfigured);

jest.mock("../../../services/bootstrap-upload", () => {
	const actual = jest.requireActual("../../../services/bootstrap-upload");
	return {
		...actual,
		isBootstrapUploadConfigured: (...args: unknown[]) => mockIsUploadConfigured(...(args as [])),
		createBootstrapUploadHandle: (...args: unknown[]) => mockCreateUploadHandle(...(args as [])),
	};
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { uploadFailureCopyKey } = require("../../../services/bootstrap-upload");

/** Every upload copy key the screen can select, so a case can assert that
 * exactly one of them is rendered and the other three are not. */
const UPLOAD_KEYS: readonly string[] = [
	"dashboardSignInCodeUploadFailed",
	"dashboardSignInCodeUploadRefused",
	"dashboardSignInCodeUploadTooLarge",
	"dashboardSignInCodeUploadNotConfigured",
];

const UPLOAD_ERROR_MESSAGE_CANARY = "the sealed payload upload was refused talking to some-internal-host:9099";

/** The error the mint throws when its uploader rejects: a fixed message, the
 * shipped name, and deliberately no `cause`. */
function uploadFailure(): Error {
	const failure = new Error(UPLOAD_ERROR_MESSAGE_CANARY);
	failure.name = "BootstrapUploadFailedError";
	return failure;
}

/** The NEXT mint records its options and its call order exactly as a real one
 * would, then throws the upload failure — so the failure path is still proven
 * to have been handed an uploader. */
function failNextMint(reason: string): void {
	lastFailureReason = reason;
	mockMint.mockImplementationOnce(async (_snapshot: unknown, options?: Record<string, unknown>) => {
		callOrder.push("mint");
		mintOptions.push(options ?? {});
		throw uploadFailure();
	});
}

function deferMint(): { resolve: (value: unknown) => void } {
	let resolve!: (value: unknown) => void;
	const promise = new Promise<unknown>((res) => {
		resolve = res;
	});
	pendingMint = { promise, resolve };
	return { resolve };
}

function isUploadingVisible(tr: renderer.ReactTestRenderer): boolean {
	return tr.root.findAll((node) => node.props?.testID === "dashboard-signin-code-uploading").length > 0;
}

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

/**
 * The helper for GATE assertions. Unlike `pressByTitle`, which invokes
 * `onPress` unconditionally so flow tests can drive the screen forward, this
 * helper honours the rendered `disabled` prop: if the matched pressable is
 * disabled, it returns a sentinel WITHOUT ever calling `onPress`, so a test
 * using this helper proves the gate actually blocks the action rather than
 * merely proving the screen state didn't change for some other reason.
 * `pressByTitle` deliberately bypasses `disabled` for the flow tests above
 * that need to reach the post-confirmation code paths; this helper is the
 * one that must be used whenever the assertion's whole point IS the gate.
 */
async function pressByTitleHonoringDisabled(
	tr: renderer.ReactTestRenderer,
	title: string,
): Promise<"pressed" | "refused-disabled"> {
	const target = tr.root
		.findAll((node) => typeof node.props?.onPress === "function" && node.props?.title === title)
		.find(Boolean);
	if (!target) throw new Error(`no pressable titled "${title}" is rendered`);
	if (target.props?.disabled === true) {
		return "refused-disabled";
	}
	await renderer.act(async () => {
		target.props.onPress();
	});
	await renderer.act(async () => {
		await Promise.resolve();
	});
	return "pressed";
}

/**
 * Returns the confirm-step's own generate pressable node (without pressing
 * it), so a test can read `props.disabled` directly off it. Asserts exactly
 * one such node is rendered -- the structural control confirming the three
 * gate assertions below cannot silently be reading the wrong button (during
 * the confirm step, the non-confirming generate button is not rendered at
 * all, so exactly one node should carry this title).
 */
function findConfirmPressable(tr: renderer.ReactTestRenderer) {
	const matches = tr.root.findAll(
		(node) => typeof node.props?.onPress === "function" && node.props?.title === "dashboardSignInCodeGenerateButton",
	);
	if (matches.length !== 1) {
		throw new Error(
			`expected exactly one pressable titled "dashboardSignInCodeGenerateButton" during the confirm step, found ${matches.length}`,
		);
	}
	return matches[0];
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
 * phrase in between (mirrors the real officer flow). This helper uses
 * `pressByTitle`, which deliberately BYPASSES the `disabled` prop, so it can
 * reach the post-confirmation flow tests below even if a future edit left
 * the gate open by mistake. The gate itself -- that the confirm control
 * really is disabled until the phrase is typed correctly -- is asserted
 * separately by the three named tests using `pressByTitleHonoringDisabled`
 * and `findConfirmPressable`, not by this helper. */
async function confirmAndGenerate(tr: renderer.ReactTestRenderer): Promise<void> {
	await pressByTitle(tr, "dashboardSignInCodeGenerateButton");
	await typeConfirmText(tr, "iConfirm");
	await pressByTitle(tr, "dashboardSignInCodeGenerateButton");
}

beforeEach(() => {
	jest.clearAllMocks();
	callOrder.length = 0;
	mintOptions.length = 0;
	pendingMint = undefined;
	uploadConfigured = true;
	lastFailureReason = undefined;
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

	it("structural control: exactly one pressable carries the generate title during the confirm step", async () => {
		const tr = await renderScreen();
		await pressByTitle(tr, "dashboardSignInCodeGenerateButton");

		// findConfirmPressable throws unless exactly one match exists -- not
		// throwing here IS the assertion.
		expect(() => findConfirmPressable(tr)).not.toThrow();
	});

	it("the confirm control is disabled until the confirmation phrase is typed", async () => {
		const tr = await renderScreen();
		await pressByTitle(tr, "dashboardSignInCodeGenerateButton");

		expect(findConfirmPressable(tr).props.disabled).toBe(true);

		await typeConfirmText(tr, "iConfirm");

		expect(findConfirmPressable(tr).props.disabled).toBe(false);
	});

	it("a wrong phrase does not open the gate", async () => {
		const tr = await renderScreen();
		await pressByTitle(tr, "dashboardSignInCodeGenerateButton");

		await typeConfirmText(tr, "iconfirm");

		expect(findConfirmPressable(tr).props.disabled).toBe(true);
	});

	it("pressing without confirming exports nothing, honouring `disabled`", async () => {
		const tr = await renderScreen();
		await pressByTitle(tr, "dashboardSignInCodeGenerateButton");

		const outcome = await pressByTitleHonoringDisabled(tr, "dashboardSignInCodeGenerateButton");

		expect(outcome).toBe("refused-disabled");
		expect(mockCreateDeviceSigner).not.toHaveBeenCalled();
		expect(mockExportDashboardSnapshot).not.toHaveBeenCalled();
		expect(callOrder).toEqual([]);
	});

	it("the full happy path: confirm -> signer resolves -> export and mint each exactly once, signer strictly BEFORE export", async () => {
		const tr = await renderScreen();
		await confirmAndGenerate(tr);

		expect(mockCreateDeviceSigner).toHaveBeenCalledTimes(1);
		expect(mockSignerFn).toHaveBeenCalledTimes(1);
		expect(mockExportDashboardSnapshot).toHaveBeenCalledTimes(1);
		expect(mockMint).toHaveBeenCalledTimes(1);
		// The mint now pushes its own label, so the sequence is four long. The
		// property this case has always existed to pin is unchanged and still
		// asserted by the SAME array equality: the biometric strictly precedes
		// the export.
		expect(callOrder).toEqual(["createDeviceSigner", "signer-invoked", "exportDashboardSnapshot", "mint"]);

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

describe("the code is shown only after the service acknowledges the upload", () => {
	it("the in-flight phase is visible while the mint is pending, and NO code is rendered yet", async () => {
		const gate = deferMint();
		const tr = await renderScreen();
		await confirmAndGenerate(tr);

		// Mid-sequence: the officer can see something is happening, and there
		// is nothing on screen to read out.
		expect(isUploadingVisible(tr)).toBe(true);
		const midFlight = JSON.stringify(tr.toJSON());
		expect(midFlight).toContain("dashboardSignInCodeUploading");
		expect(midFlight).not.toContain(CODE_CANARY);
		expect(midFlight).not.toContain(SECRET_CANARY);
		expect(hasPressableTitled(tr, "dashboardSignInCodeCopyButton")).toBe(false);

		await renderer.act(async () => {
			gate.resolve(MINTED_RECORD);
			await Promise.resolve();
		});

		expect(isUploadingVisible(tr)).toBe(false);
		const settled = JSON.stringify(tr.toJSON());
		expect(settled).toContain(CODE_CANARY);
		expect(hasPressableTitled(tr, "dashboardSignInCodeCopyButton")).toBe(true);
		expect(callOrder).toEqual(["createDeviceSigner", "signer-invoked", "exportDashboardSnapshot", "mint"]);
	});

	it("the in-flight phase clears on the REJECT exit too — a stuck indicator is a shipped defect", async () => {
		failNextMint("unreachable");
		const tr = await renderScreen();
		await confirmAndGenerate(tr);

		expect(isUploadingVisible(tr)).toBe(false);
	});

	it("the mint is always handed an uploader, and it is the handle's own upload member", async () => {
		const tr = await renderScreen();
		await confirmAndGenerate(tr);

		expect(mockCreateUploadHandle).toHaveBeenCalledTimes(1);
		expect(mintOptions).toHaveLength(1);
		expect(typeof mintOptions[0].uploader).toBe("function");
		// Not merely "a function": the exact member of the handle this attempt
		// created. A different function would be an uploader the screen cannot
		// read a failure reason from.
		expect(mintOptions[0].uploader).toBe(mockUpload);
	});

	it("even a FAILING attempt was handed an uploader — the filesystem path is never reached as a silent fallback", async () => {
		failNextMint("refused");
		const tr = await renderScreen();
		await confirmAndGenerate(tr);

		expect(mintOptions).toHaveLength(1);
		expect(mintOptions[0].uploader).toBe(mockUpload);
	});

	it("fails closed on a first-ever mint: no code, no secret, no copy control, no discard control", async () => {
		failNextMint("unreachable");
		const tr = await renderScreen();
		await confirmAndGenerate(tr);

		expect(mockMint).toHaveBeenCalledTimes(1);
		const json = JSON.stringify(tr.toJSON());
		// Four independent negatives. A single "does not contain" can pass for
		// the wrong reason — an empty tree, a crashed render, a renamed
		// testID — so each affordance is asserted absent on its own terms.
		expect(json).not.toContain(CODE_CANARY);
		expect(json).not.toContain(SECRET_CANARY);
		expect(hasPressableTitled(tr, "dashboardSignInCodeCopyButton")).toBe(false);
		expect(hasPressableTitled(tr, "dashboardSignInCodeDiscardButton")).toBe(false);
		// The paired positive control: the tree really did render, and it
		// really is back at the idle state — so the four negatives above are
		// facts about a live screen, not about an empty one.
		expect(hasPressableTitled(tr, "dashboardSignInCodeGenerateButton")).toBe(true);
		expect(json).toContain("dashboardSignInCodeIdle");
	});

	it("a failed re-mint leaves the PRIOR record intact and governing the screen, beside an upload banner", async () => {
		// REACHABILITY NOTE, and it is load-bearing. The shipped footer renders
		// no generate control while a live code is on screen
		// (`screenState !== "generated"`), so "a re-mint attempted while a live
		// code is displayed" is not reachable through this UI at all and no
		// test can stage it without changing the render tree. What IS reachable
		// — and what actually carries the property — is a re-mint over a prior
		// record that is no longer live. The invariant proven here is the one
		// that matters either way: a refused upload does not clear, replace or
		// disturb the prior record, and the officer is told plainly that no new
		// code was created.
		mockRead.mockResolvedValueOnce({
			code: "prior.code",
			secret: "p".repeat(40),
			digest: "code",
			lookupId: "priorLookupIdpriorLookupIdpriorLookupIdAAA",
			expiresAt: "2000-01-01T00:00:00",
			mintedAt: "2000-01-01T00:00:00",
			snapshotName: "snapshot-prior",
		});

		const tr = await renderScreen();
		// Pre-flight: the prior record really is present and governing.
		expect(JSON.stringify(tr.toJSON())).toContain("dashboardSignInCodeExpired");
		expect(hasPressableTitled(tr, "dashboardSignInCodeDiscardButton")).toBe(true);

		failNextMint("unreachable");
		await confirmAndGenerate(tr);

		const json = JSON.stringify(tr.toJSON());
		// The prior record survived untouched — it is still what the screen is
		// rendering, and its discard control is still offered.
		expect(json).toContain("dashboardSignInCodeExpired");
		expect(hasPressableTitled(tr, "dashboardSignInCodeDiscardButton")).toBe(true);
		// No new code was created, and the banner is an UPLOAD one, not the
		// generic generate failure.
		expect(json).not.toContain(CODE_CANARY);
		expect(json).not.toContain(SECRET_CANARY);
		expect(json).toContain("dashboardSignInCodeUploadFailed");
		expect(json).not.toContain("dashboardSignInCodeGenerateFailed");
	});
});

describe("the upload copy family is disjoint from the generic generate failure", () => {
	const REASON_CASES: ReadonlyArray<[string, string]> = [
		["unauthorized", "dashboardSignInCodeUploadRefused"],
		["too-large", "dashboardSignInCodeUploadTooLarge"],
		["not-configured", "dashboardSignInCodeUploadNotConfigured"],
		["unreachable", "dashboardSignInCodeUploadFailed"],
	];

	it("control: the four expected keys are exactly what the shipped map returns for those four reasons", () => {
		for (const [reason, key] of REASON_CASES) {
			expect(uploadFailureCopyKey(reason)).toBe(key);
		}
	});

	it.each(REASON_CASES)("a %s failure renders %s and no other upload key, and never the generic key", async (reason, expectedKey) => {
		failNextMint(reason);
		const tr = await renderScreen();
		await confirmAndGenerate(tr);

		const json = JSON.stringify(tr.toJSON());
		expect(json).toContain(expectedKey);
		expect(json).not.toContain("dashboardSignInCodeGenerateFailed");
		for (const other of UPLOAD_KEYS.filter((key) => key !== expectedKey)) {
			expect(json).not.toContain(other);
		}
	});

	it("the control in the opposite direction: a failing EXPORT still renders the generic key and NO upload key", async () => {
		const raw = new Error("dashboard-bootstrap-producer: unsupported value type in Registrant.LegalName");
		raw.name = "SnapshotExportError";
		mockExportDashboardSnapshot.mockRejectedValueOnce(raw);

		const tr = await renderScreen();
		await confirmAndGenerate(tr);

		const json = JSON.stringify(tr.toJSON());
		expect(json).toContain("dashboardSignInCodeGenerateFailed");
		for (const key of UPLOAD_KEYS) {
			expect(json).not.toContain(key);
		}
	});

	it("an unclassified upload failure still lands on a copy key, never on an empty banner", async () => {
		// The handle reports nothing (the mint attaches no `cause`, so there is
		// no other source of detail). The screen must still choose a key.
		failNextMint("unreachable");
		lastFailureReason = undefined;

		const tr = await renderScreen();
		await confirmAndGenerate(tr);

		expect(JSON.stringify(tr.toJSON())).toContain("dashboardSignInCodeUploadFailed");
	});
});

describe("one mint per confirmation, and no ceremony that cannot succeed", () => {
	it("two presses dispatched in ONE act, with no await between them, mint exactly once", async () => {
		deferMint();
		const tr = await renderScreen();
		await pressByTitle(tr, "dashboardSignInCodeGenerateButton");
		await typeConfirmText(tr, "iConfirm");

		// Both dispatches inside a single act callback with no intervening
		// await: React has not re-rendered between them, so the rendered
		// `disabled` prop CANNOT be what stopped the second press. Only a ref
		// checked and set before the first await can.
		const target = findConfirmPressable(tr);
		await renderer.act(async () => {
			target.props.onPress();
			target.props.onPress();
		});
		await renderer.act(async () => {
			await Promise.resolve();
		});

		expect(mockCreateDeviceSigner).toHaveBeenCalledTimes(1);
		expect(mockMint).toHaveBeenCalledTimes(1);
		expect(mockCreateUploadHandle).toHaveBeenCalledTimes(1);
	});

	it("an unconfigured upload target refuses BEFORE the ceremony — no biometric, no export, no mint", async () => {
		uploadConfigured = false;

		const tr = await renderScreen();
		await confirmAndGenerate(tr);

		expect(mockCreateDeviceSigner).not.toHaveBeenCalled();
		expect(mockExportDashboardSnapshot).not.toHaveBeenCalled();
		expect(mockMint).not.toHaveBeenCalled();
		expect(callOrder).toEqual([]);
		expect(JSON.stringify(tr.toJSON())).toContain("dashboardSignInCodeUploadNotConfigured");
	});

	it("the refusal leaves the screen usable: the generate control is back and not stuck disabled", async () => {
		uploadConfigured = false;

		const tr = await renderScreen();
		await confirmAndGenerate(tr);

		expect(isUploadingVisible(tr)).toBe(false);
		const outcome = await pressByTitleHonoringDisabled(tr, "dashboardSignInCodeGenerateButton");
		expect(outcome).toBe("pressed");
	});
});

describe("the error CLASS discipline holds on the upload path", () => {
	it("exactly one console.error is emitted, carrying the class and never the message", async () => {
		const errorSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
		try {
			failNextMint("unauthorized");
			const tr = await renderScreen();
			await confirmAndGenerate(tr);

			expect(errorSpy).toHaveBeenCalledTimes(1);
			const args = errorSpy.mock.calls.flat();
			// The paired positive control: one whole argument IS the shipped
			// error name, so the spy is reading the right call.
			expect(args).toContain("BootstrapUploadFailedError");
			const haystack = args.map((arg) => String(arg)).join(" | ");
			expect(haystack).not.toContain(UPLOAD_ERROR_MESSAGE_CANARY);
			expect(haystack).not.toContain("some-internal-host");
			// And nothing from the error reaches the officer's face either.
			expect(JSON.stringify(tr.toJSON())).not.toContain("some-internal-host");
		} finally {
			errorSpy.mockRestore();
		}
	});
});
