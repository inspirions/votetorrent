/**
 * ProvisionSigningKeyScreen.test.tsx — 49-10 (D-14/D-16/D-18) screen-layer coverage.
 *
 * DEVICE-PROOF HONESTY: jest cannot exercise the real Android Keystore, the real
 * `BiometricPrompt`, or `KeyguardManager` — this suite proves the JS-side wiring and rendering
 * against a faked native module ONLY. That the ceremony works on real hardware is D-24 leg 1
 * (49-13) and leg 3 (49-14), not this file.
 *
 * The native TurboModule bridge is faked the same way `device-signer.hardware.test.ts` and
 * `real-attestation-producer.test.ts` fake it: react-native's `TurboModuleRegistry.getEnforcing`
 * is overridden for the `'AttestationNative'` name only, via a Proxy, so the REAL screen module
 * (including its own lazy `getNative()`) is exercised, not a stand-in.
 */

jest.mock("react-native-vector-icons/FontAwesome6", () => "FontAwesome6");

jest.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string) => key }),
	// device-signer.ts (imported by this screen for its two alias constants) imports the app's
	// `i18n` singleton at module scope, which calls `i18n.use(initReactI18next).init(...)` at ITS
	// OWN module scope — this mock must supply a real-shaped plugin object or that call throws
	// before this file's own assertions ever run. Mirrors KeyholderInvitationScreen.test.tsx's
	// identical fix (49-07).
	initReactI18next: { type: "3rdParty", init: () => {} },
}));

jest.mock("react-native-safe-area-context", () => ({
	useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

let mockRouteParams: { reason: "first-run" | "invalidated" } = { reason: "first-run" };
const mockGoBack = jest.fn();
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
	useRoute: () => ({ params: mockRouteParams }),
	useNavigation: () => ({ goBack: mockGoBack, navigate: mockNavigate }),
}));

// Mirrors the REAL engine's own behavior (user-engine.ts addKey): when a `sign` callback is
// passed, it is invoked with a digest — so this fake must call it too, or the signWithDeviceKey/
// signWithRecoveryKey call inside this screen's own callback would never fire.
const mockAddKey = jest.fn(async (_key: unknown, sign?: (digest: Uint8Array) => Promise<unknown>) => {
	if (sign) await sign(new Uint8Array([1, 2, 3]));
});
const mockRevokeKey = jest.fn(
	async (_key: string, _signature: { signerKey: string; signature: string; signerUserId: string }) => {},
);
const mockGetRevokeKeyDigest = jest.fn(async (_key: string) => new Uint8Array([9, 9, 9]));
const mockGetSummary = jest.fn(async () => ({
	id: "user-1",
	name: "Officer One",
	activeKeys: [] as Array<{ key: string; type: string; expiration: number }>,
}));
const mockUserEngine = {
	addKey: mockAddKey,
	revokeKey: mockRevokeKey,
	getRevokeKeyDigest: mockGetRevokeKeyDigest,
	getSummary: mockGetSummary,
};
const mockGetCurrentUser = jest.fn(async () => mockUserEngine);
const mockNetworkEngine = { getCurrentUser: mockGetCurrentUser };
const mockGetEngine = jest.fn(async (_name: string) => mockNetworkEngine);

jest.mock("../../../providers/AppProvider", () => ({
	useApp: () => ({ getEngine: mockGetEngine }),
}));

const mockPersistProvisionedDeviceUser = jest.fn(async (_displayName: string, _publicKeyCompressedHex: string) => ({
	id: "user-1",
	name: "Officer One",
	activeKeys: [],
}));
jest.mock("../../../engines/device-user", () => ({
	persistProvisionedDeviceUser: (displayName: string, publicKeyCompressedHex: string) =>
		mockPersistProvisionedDeviceUser(displayName, publicKeyCompressedHex),
}));

// NOTE: do NOT `{ ...jest.requireActual('react-native') }` — see device-signer.hardware.test.ts's
// identical comment: react-native's index.js exports most modules as lazy getters, and spreading
// forces every one to evaluate eagerly. A Proxy defers property access to exactly what the code
// under test reads.
jest.mock("react-native", () => {
	const actual: Record<string, unknown> = jest.requireActual("react-native");
	const attestationNativeFake = {
		provisionDeviceKey: jest.fn(),
		provisionRecoveryKey: jest.fn(),
		produceAttestation: jest.fn(),
		signWithDeviceKey: jest.fn(),
		signWithRecoveryKey: jest.fn(),
	};
	const actualTurboModuleRegistry = actual.TurboModuleRegistry as { getEnforcing: (name: string) => unknown };
	const turboModuleRegistryProxy = new Proxy(actualTurboModuleRegistry, {
		get(target, prop, receiver) {
			if (prop === "getEnforcing") {
				return (name: string) => (name === "AttestationNative" ? attestationNativeFake : target.getEnforcing(name));
			}
			return Reflect.get(target, prop, receiver);
		},
	});
	return new Proxy(actual, {
		get(target, prop, receiver) {
			if (prop === "TurboModuleRegistry") return turboModuleRegistryProxy;
			if (prop === "__attestationNativeFake") return attestationNativeFake;
			return Reflect.get(target, prop, receiver);
		},
	});
});

import React from "react";
import renderer from "react-test-renderer";

// eslint-disable-next-line @typescript-eslint/no-var-requires -- reach the fake exposed by the react-native mock above.
const { __attestationNativeFake: nativeFake } = require("react-native") as {
	__attestationNativeFake: {
		provisionDeviceKey: jest.Mock;
		provisionRecoveryKey: jest.Mock;
		produceAttestation: jest.Mock;
		signWithDeviceKey: jest.Mock;
		signWithRecoveryKey: jest.Mock;
	};
};

// eslint-disable-next-line @typescript-eslint/no-var-requires
const ProvisionSigningKeyModule = require("../ProvisionSigningKeyScreen");
const ProvisionSigningKeyScreen = ProvisionSigningKeyModule.default;

async function renderScreen(): Promise<renderer.ReactTestRenderer> {
	let tr!: renderer.ReactTestRenderer;
	await renderer.act(async () => {
		tr = renderer.create(<ProvisionSigningKeyScreen />);
	});
	for (let i = 0; i < 6; i++) {
		// eslint-disable-next-line no-await-in-loop
		await renderer.act(async () => {
			await Promise.resolve();
		});
	}
	return tr;
}

function primaryButton(tr: renderer.ReactTestRenderer) {
	const wrapper = tr.root.findByProps({ testID: "signing-key-provisioning-primary-button" });
	const candidates = wrapper.findAll((node) => typeof node.props.onPress === "function");
	expect(candidates.length).toBeGreaterThan(0);
	return candidates[0]!;
}

async function press(tr: renderer.ReactTestRenderer, node: ReturnType<typeof primaryButton>): Promise<void> {
	await renderer.act(async () => {
		node.props.onPress();
	});
	for (let i = 0; i < 6; i++) {
		// eslint-disable-next-line no-await-in-loop
		await renderer.act(async () => {
			await Promise.resolve();
		});
	}
}

beforeEach(() => {
	jest.clearAllMocks();
	mockRouteParams = { reason: "first-run" };
	mockGetSummary.mockResolvedValue({ id: "user-1", name: "Officer One", activeKeys: [] });
	mockGetCurrentUser.mockResolvedValue(mockUserEngine);
});

describe("ProvisionSigningKeyScreen — 49-10 first-run provisioning", () => {
	it("(a) the happy path calls the native/engine steps in order and registers publicKeyCompressedHex, never publicKeyBase64", async () => {
		nativeFake.provisionDeviceKey.mockResolvedValue({
			publicKeyBase64: "SIGNING-SPKI-DER-BASE64",
			publicKeyCompressedHex: "aa" + "11".repeat(32),
		});
		nativeFake.provisionRecoveryKey.mockResolvedValue({
			publicKeyBase64: "RECOVERY-SPKI-DER-BASE64",
			publicKeyCompressedHex: "bb" + "22".repeat(32),
		});
		nativeFake.produceAttestation.mockResolvedValue({ certificateChainBase64: ["chain"] });
		nativeFake.signWithDeviceKey.mockResolvedValue({ signatureHex: "deadbeef" });

		const tr = await renderScreen();
		await press(tr, primaryButton(tr));

		expect(nativeFake.provisionDeviceKey).toHaveBeenCalledWith("VOTETORRENT_AUTHORITY_SIGNING_KEY_V1");
		expect(nativeFake.provisionRecoveryKey).toHaveBeenCalledWith("VOTETORRENT_AUTHORITY_RECOVERY_KEY_V1");
		expect(nativeFake.produceAttestation).toHaveBeenCalledTimes(1);
		expect(nativeFake.signWithDeviceKey).toHaveBeenCalledTimes(1);

		expect(mockAddKey).toHaveBeenCalledTimes(2);
		const firstCallKey = mockAddKey.mock.calls[0]![0] as { key: string };
		const secondCallKey = mockAddKey.mock.calls[1]![0] as { key: string };
		expect(firstCallKey.key).toBe("aa" + "11".repeat(32));
		expect(mockAddKey.mock.calls[0]![1]).toBeUndefined();
		expect(secondCallKey.key).toBe("bb" + "22".repeat(32));
		expect(typeof mockAddKey.mock.calls[1]![1]).toBe("function");

		expect(mockPersistProvisionedDeviceUser).toHaveBeenCalledWith("Officer One", "aa" + "11".repeat(32));

		// The exact value asserted, and publicKeyBase64 never surfaces as a registered key.
		const allRegisteredKeys = [firstCallKey.key, secondCallKey.key];
		expect(allRegisteredKeys).not.toContain("SIGNING-SPKI-DER-BASE64");
		expect(allRegisteredKeys).not.toContain("RECOVERY-SPKI-DER-BASE64");

		const json = JSON.stringify(tr.toJSON());
		expect(json).toContain("signingKeyProvisioningSuccessHeading");
	});

	it("(b) a CANCELED rejection renders no InlineError and re-enables the button", async () => {
		nativeFake.provisionDeviceKey.mockRejectedValue(Object.assign(new Error("canceled"), { code: "CANCELED" }));

		const tr = await renderScreen();
		const button = primaryButton(tr);
		await press(tr, button);

		const json = JSON.stringify(tr.toJSON());
		expect(json).not.toContain("deviceSigningError");
		const buttonAfter = primaryButton(tr);
		expect(buttonAfter.props.disabled).toBeFalsy();
	});

	it("(c) a LOCKOUT_PERMANENT rejection renders the deviceSigningErrorLockoutPermanent copy", async () => {
		nativeFake.provisionDeviceKey.mockRejectedValue(
			Object.assign(new Error("locked"), { code: "LOCKOUT_PERMANENT" }),
		);

		const tr = await renderScreen();
		await press(tr, primaryButton(tr));

		const json = JSON.stringify(tr.toJSON());
		expect(json).toContain("deviceSigningErrorLockoutPermanent");
	});
});

const OLD_SIGNING_KEY_HEX = "cc" + "33".repeat(32);
const NEW_SIGNING_KEY_HEX = "dd" + "44".repeat(32);
const RECOVERY_KEY_HEX = "ee" + "55".repeat(32);

describe("ProvisionSigningKeyScreen — 49-10 recovery variant (D-16) and D-18 terminal state", () => {
	beforeEach(() => {
		mockRouteParams = { reason: "invalidated" };
		mockGetSummary.mockResolvedValue({
			id: "user-1",
			name: "Officer One",
			activeKeys: [{ key: OLD_SIGNING_KEY_HEX, type: "P", expiration: Date.now() + 1000 }],
		});
	});

	it("(a) the recovery happy path signs with signWithRecoveryKey (never signWithDeviceKey), registers the replacement key, then revokes the old one", async () => {
		nativeFake.provisionDeviceKey.mockResolvedValue({
			publicKeyBase64: "NEW-SIGNING-SPKI-DER-BASE64",
			publicKeyCompressedHex: NEW_SIGNING_KEY_HEX,
		});
		nativeFake.provisionRecoveryKey.mockResolvedValue({
			publicKeyBase64: "RECOVERY-SPKI-DER-BASE64",
			publicKeyCompressedHex: RECOVERY_KEY_HEX,
		});
		nativeFake.signWithRecoveryKey.mockResolvedValue({ signatureHex: "cafebabe" });

		const tr = await renderScreen();
		await press(tr, primaryButton(tr));

		expect(nativeFake.signWithDeviceKey).not.toHaveBeenCalled();
		expect(nativeFake.signWithRecoveryKey).toHaveBeenCalled();
		for (const call of nativeFake.signWithRecoveryKey.mock.calls) {
			expect(call[0]).toBe("VOTETORRENT_AUTHORITY_RECOVERY_KEY_V1");
		}

		expect(mockRevokeKey).toHaveBeenCalledTimes(1);
		expect(mockRevokeKey.mock.calls[0]![0]).toBe(OLD_SIGNING_KEY_HEX);
		const revokeSignature = mockRevokeKey.mock.calls[0]![1] as { signerKey: string; signature: string };
		expect(revokeSignature.signerKey).toBe(RECOVERY_KEY_HEX);
		expect(revokeSignature.signature).toBe("cafebabe");

		expect(mockAddKey).toHaveBeenCalledTimes(1);
		const addedKey = mockAddKey.mock.calls[0]![0] as { key: string };
		expect(addedKey.key).toBe(NEW_SIGNING_KEY_HEX);
		expect(typeof mockAddKey.mock.calls[0]![1]).toBe("function");

		expect(mockPersistProvisionedDeviceUser).toHaveBeenCalledWith("Officer One", NEW_SIGNING_KEY_HEX);

		const json = JSON.stringify(tr.toJSON());
		expect(json).toContain("signingKeyProvisioningSuccessHeading");
	});

	it("(b) a NO_DEVICE_CREDENTIAL rejection renders the no-recovery heading/body and ZERO buttons", async () => {
		nativeFake.provisionDeviceKey.mockResolvedValue({
			publicKeyBase64: "NEW-SIGNING-SPKI-DER-BASE64",
			publicKeyCompressedHex: NEW_SIGNING_KEY_HEX,
		});
		nativeFake.provisionRecoveryKey.mockResolvedValue({
			publicKeyBase64: "RECOVERY-SPKI-DER-BASE64",
			publicKeyCompressedHex: RECOVERY_KEY_HEX,
		});
		nativeFake.signWithRecoveryKey.mockRejectedValue(
			Object.assign(new Error("no device credential"), { code: "NO_DEVICE_CREDENTIAL" }),
		);

		const tr = await renderScreen();
		await press(tr, primaryButton(tr));

		const json = JSON.stringify(tr.toJSON());
		expect(json).toContain("signingKeyProvisioningNoRecoveryHeading");
		expect(json).toContain("signingKeyProvisioningNoRecoveryBody");

		// D-18: no action affordance at all — assert the rendered button COUNT, not just the
		// absence of a specific testID (a stray pressable elsewhere would still be a lie).
		const pressables = tr.root.findAll((node) => typeof node.props.onPress === "function");
		expect(pressables.length).toBe(0);
	});
});

describe("ProvisionSigningKeyScreen — D-14 boot invariant", () => {
	it("AppProvider.tsx never references this route — no boot-time redirect exists", () => {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const fs = require("fs");
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const path = require("path");
		const appProviderSource = fs.readFileSync(
			path.join(__dirname, "..", "..", "..", "providers", "AppProvider.tsx"),
			"utf8",
		);
		expect(appProviderSource).not.toContain("ProvisionSigningKey");
	});
});
