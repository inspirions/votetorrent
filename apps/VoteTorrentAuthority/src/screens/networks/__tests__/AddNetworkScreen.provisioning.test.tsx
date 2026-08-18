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
	useNavigation: () => ({ navigate: mockNavigate, goBack: jest.fn() }),
}));

const mockGetOrCreateDeviceUser = jest.fn();
jest.mock("../../../engines/device-user", () => ({
	getOrCreateDeviceUser: (...args: unknown[]) => mockGetOrCreateDeviceUser(...args),
}));

const mockGetDefaultUser = jest.fn(async () => ({ name: "Device User" }));
const mockDefaultUserEngine = { get: mockGetDefaultUser };
const mockGetEngine = jest.fn(async () => mockDefaultUserEngine);
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
