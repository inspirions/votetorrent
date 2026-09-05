/**
 * AddNetworkScreen.provisioning.test.tsx — 49-16 Gap A closure coverage (AddNetworkScreen half).
 *
 * Proves `handleCreate`'s catch block routes a `NO_KEY_PROVISIONED`-coded rejection from
 * `getOrCreateDeviceUser` through the REAL `useDeviceSigningErrorHandler` hook (not mocked —
 * only `@react-navigation/native`'s `useNavigation` is faked, so the hook's own classification
 * logic is exercised for real) to `navigate('ProvisionSigningKey', { reason: 'first-run' })`,
 * and that every other failure shape still reaches `setErrorMessage` with its own text unchanged
 * — the negative case that keeps a genuine engine/network failure from being relabeled as a
 * biometric failure (T-49-USER-7).
 *
 * `getOrCreateDeviceUser` itself is mocked (its real behavior is Task 1's own coverage,
 * `device-user.provisioning.test.ts`) — this suite is about the SCREEN's routing, not the
 * engine's rejection shape.
 */

jest.mock("react-native-vector-icons/FontAwesome6", () => "FontAwesome6");

jest.mock("react-native-safe-area-context", () => ({
	useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock("../../../providers/SettingsProvider", () => ({
	useSettings: () => ({ showHelpIcons: false }),
}));

jest.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string) => key }),
}));

const mockNavigate = jest.fn();
const mockGoBack = jest.fn();
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
	useNavigation: () => ({ navigate: mockNavigate, goBack: mockGoBack }),
}));

const mockGetOrCreateDeviceUser = jest.fn();
// `getDeviceProvisioningRecord` is what the recovery-key gate reads to learn this device's
// recovery key. It must be on the mock: without it the real module's export is simply absent,
// `deviceNeedsRecoveryKeyRegistration` swallows the resulting TypeError, and the gate resolves
// false -- which would silently make the goBack-suppression specs below pass for the wrong
// reason (nothing to route to, rather than routing correctly suppressed).
const mockGetDeviceProvisioningRecord = jest.fn(async () => undefined as unknown);
jest.mock("../../../engines/device-user", () => ({
	getOrCreateDeviceUser: (...args: unknown[]) => mockGetOrCreateDeviceUser(...args),
	getDeviceProvisioningRecord: () => mockGetDeviceProvisioningRecord(),
}));

const mockGetDefaultUser = jest.fn(async () => ({ name: "Device User" }));
const mockDefaultUserEngine = { get: mockGetDefaultUser };
// The recovery-key gate resolves getEngine("network") -> getCurrentUser() -> getSummary(); the
// screen itself resolves getEngine("defaultUser"). A single catch-all engine cannot serve both,
// so dispatch on the name the caller actually asked for.
const mockGetSummary = jest.fn(async () => ({ id: "u1", activeKeys: [] as Array<{ key: string }> }));
const mockGetCurrentUser = jest.fn(async () => ({ getSummary: mockGetSummary }) as unknown);
const mockNetworkEngine = { getCurrentUser: () => mockGetCurrentUser() };
const mockGetEngine = jest.fn(async (name?: string) =>
	name === "network" ? mockNetworkEngine : mockDefaultUserEngine,
);
const mockNetworksEngine = { buildCreate: jest.fn() };
const mockSelectNetwork = jest.fn();
jest.mock("../../../providers/AppProvider", () => ({
	useApp: () => ({
		getEngine: mockGetEngine,
		networksEngine: mockNetworksEngine,
		selectNetwork: mockSelectNetwork,
	}),
}));

import React from "react";
import renderer from "react-test-renderer";
import AddNetworkScreen from "../AddNetworkScreen";

function findByProps(
	tr: renderer.ReactTestRenderer,
	predicate: (props: Record<string, unknown>) => boolean,
) {
	return tr.root.findAll((n) => {
		try {
			return predicate(n.props as Record<string, unknown>);
		} catch {
			return false;
		}
	});
}

async function renderScreen() {
	let tr!: renderer.ReactTestRenderer;
	await renderer.act(async () => {
		tr = renderer.create(<AddNetworkScreen />);
	});
	return tr;
}

function getSignButton(tr: renderer.ReactTestRenderer) {
	return findByProps(tr, (p) => p.title === "sign" && typeof p.onPress === "function")[0];
}

function getCreateButton(tr: renderer.ReactTestRenderer) {
	return findByProps(
		tr,
		(p) => (p.title === "create" || p.title === "creating") && typeof p.onPress === "function",
	)[0];
}

function inlineErrorMessage(tr: renderer.ReactTestRenderer): string {
	const matches = findByProps(tr, (p) => "message" in p);
	return (matches[0]?.props as { message?: string } | undefined)?.message ?? "";
}

/** Drives the screen to a signed, CREATE-pressed state so handleCreate's try body runs. */
async function pressSignThenCreate(tr: renderer.ReactTestRenderer) {
	await renderer.act(async () => {
		getSignButton(tr).props.onPress();
	});
	await renderer.act(async () => {
		await getCreateButton(tr).props.onPress();
	});
}

describe("AddNetworkScreen — 49-16 Gap A closure: routes NO_KEY_PROVISIONED through the shared hook", () => {
	beforeEach(() => {
		jest.clearAllMocks();
		mockGetDefaultUser.mockResolvedValue({ name: "Device User" });
	});

	it("navigates to ProvisionSigningKey with { reason: 'first-run' } and sets no inline error on a NO_KEY_PROVISIONED rejection", async () => {
		const rejection = Object.assign(new Error("no device signing key provisioned"), {
			code: "NO_KEY_PROVISIONED",
		});
		mockGetOrCreateDeviceUser.mockRejectedValue(rejection);

		const tr = await renderScreen();
		await pressSignThenCreate(tr);

		expect(mockNavigate).toHaveBeenCalledTimes(1);
		expect(mockNavigate).toHaveBeenCalledWith("ProvisionSigningKey", { reason: "first-run" });
		expect(inlineErrorMessage(tr)).toBe("");
	});

	it("leaves creating false (the CREATE button re-enabled) after routing the NO_KEY_PROVISIONED path", async () => {
		const rejection = Object.assign(new Error("no device signing key provisioned"), {
			code: "NO_KEY_PROVISIONED",
		});
		mockGetOrCreateDeviceUser.mockRejectedValue(rejection);

		const tr = await renderScreen();
		await pressSignThenCreate(tr);

		const createButton = getCreateButton(tr);
		expect(createButton.props.title).toBe("create");
		expect(createButton.props.disabled).toBe(false);
	});

	it("a plain Error (no code) still reaches setErrorMessage with its own text, not a deviceSigningError copy key", async () => {
		mockGetOrCreateDeviceUser.mockRejectedValue(new Error("boom"));

		const tr = await renderScreen();
		await pressSignThenCreate(tr);

		expect(mockNavigate).not.toHaveBeenCalled();
		expect(inlineErrorMessage(tr)).toBe("boom");
	});

	it("mustSignBeforeCreating gate is unchanged: pressing CREATE without signing sets that error and never calls getOrCreateDeviceUser", async () => {
		const tr = await renderScreen();
		await renderer.act(async () => {
			await getCreateButton(tr).props.onPress();
		});

		expect(mockGetOrCreateDeviceUser).not.toHaveBeenCalled();
		expect(inlineErrorMessage(tr)).toBe("mustSignBeforeCreating");
	});
});

/**
 * 49-19 follow-up, MEASURED ON REAL HARDWARE (Pixel 7 Pro, 2026-08-24).
 *
 * `handleCreate` ends in an UNCONDITIONAL `navigation.goBack()`. The recovery-key gate pushes
 * the ceremony screen; that `goBack()` then popped it straight back off, landing the officer on
 * Add Network again -- so the gate correctly logged `needed: true`, correctly navigated, and the
 * officer still ended up with an unregistered recovery key. The fix mirrors NetworkDetailsScreen's
 * join path (`if (await promptRecoveryKeyRegistrationIfNeeded()) return;`).
 *
 * WHY THE ORIGINAL SUITE COULD NOT SEE IT: `goBack` was an inline `jest.fn()` created fresh on
 * every `useNavigation()` call, so nothing could assert against it, and no spec exercised a
 * SUCCESSFUL create at all -- every existing spec drives a `getOrCreateDeviceUser` rejection and
 * never reaches the gate. Asserting `navigate` alone is exactly the blind spot: it was called,
 * on device, and undone one statement later.
 */
describe("AddNetworkScreen — 49-19: the recovery-key ceremony survives handleCreate's goBack", () => {
	const SIGNING_KEY = "03f450ccccbaefd2efe218d8eb8c2f84677aaed1fa7bc19b9dbcac96e6ef7d86ab";
	const RECOVERY_KEY = "036d541206f2fb5d6c67e0a39b615eebf8ada784a8b12dcab550c901305b6fcf3a";

	function armSuccessfulCreate() {
		mockGetOrCreateDeviceUser.mockResolvedValue({
			id: "u1",
			name: "Device User",
			activeKeys: [{ key: SIGNING_KEY, type: "P", expiration: Date.now() + 1000 }],
		});
		mockNetworksEngine.buildCreate.mockReturnValue({
			update: () => ({
				isValid: () => true,
				errors: () => [],
				commit: async () => ({ init: { hash: "net-hash" } }),
			}),
		});
	}

	beforeEach(() => {
		jest.clearAllMocks();
		mockGetDefaultUser.mockResolvedValue({ name: "Device User" });
		armSuccessfulCreate();
	});

	it("does NOT goBack when the gate routes into the ceremony — the device-measured defect", async () => {
		// The exact state measured on hardware: the provisioning record holds the recovery key,
		// while the network User that create() just bootstrapped holds the signing key alone.
		mockGetDeviceProvisioningRecord.mockResolvedValue({
			recoveryPublicKeyCompressedHex: RECOVERY_KEY,
		});
		mockGetSummary.mockResolvedValue({ id: "u1", activeKeys: [{ key: SIGNING_KEY }] });

		const tr = await renderScreen();
		await pressSignThenCreate(tr);

		expect(mockNavigate).toHaveBeenCalledWith("ProvisionSigningKey", { reason: "first-run" });
		// The assertion the original suite lacked. Before the fix this was 1, and the ceremony
		// screen the line above pushed was popped straight back off.
		expect(mockGoBack).not.toHaveBeenCalled();
	});

	it("still goes back when the recovery key is already registered — the gate must not strand the officer on this screen", async () => {
		mockGetDeviceProvisioningRecord.mockResolvedValue({
			recoveryPublicKeyCompressedHex: RECOVERY_KEY,
		});
		mockGetSummary.mockResolvedValue({
			id: "u1",
			activeKeys: [{ key: SIGNING_KEY }, { key: RECOVERY_KEY }],
		});

		const tr = await renderScreen();
		await pressSignThenCreate(tr);

		expect(mockNavigate).not.toHaveBeenCalled();
		expect(mockGoBack).toHaveBeenCalledTimes(1);
	});

	it("still goes back when the device has no provisioning record at all — an unprovisioned device is not a registration gap", async () => {
		mockGetDeviceProvisioningRecord.mockResolvedValue(undefined);
		mockGetSummary.mockResolvedValue({ id: "u1", activeKeys: [{ key: SIGNING_KEY }] });

		const tr = await renderScreen();
		await pressSignThenCreate(tr);

		expect(mockNavigate).not.toHaveBeenCalled();
		expect(mockGoBack).toHaveBeenCalledTimes(1);
	});
});
