/**
 * ProvisionSigningKeyScreen.test.tsx — 49-10 (D-14/D-16/D-18) screen-layer coverage, rewritten by
 * 49-17 (Gap A provisioning closure + the attested-key defect).
 *
 * HEADER NOTE (49-17): the first-run happy-path assertions below intentionally changed from the
 * original 49-10 suite. The old suite asserted `addKey` received `provisionDeviceKey`'s
 * PRE-attestation `publicKeyCompressedHex` and that the whole ceremony ran unconditionally with no
 * network guard — both encode the two faults 49-17 closes (the circular network dependency and the
 * discarded-key defect, see `49-17-PLAN.md`'s objective). Do NOT "restore" those old assertions; a
 * future reader who does so is reintroducing a silent signature-verification failure
 * (`UserKey.SignatureValid` rejects closed, and `verify()` swallows exceptions, so the failure is
 * invisible without this suite's fixtures deliberately using DIFFERENT pre/post-attestation hex
 * values).
 *
 * DEVICE-PROOF HONESTY: jest cannot exercise the real Android Keystore, the real
 * `BiometricPrompt`, or `KeyguardManager` — this suite proves the JS-side wiring and rendering
 * against a faked native module ONLY. That the ceremony works on real hardware is D-24 leg 1
 * (49-13/49-18) and leg 3 (49-14), not this file.
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
const mockDefaultUserGet = jest.fn(async () => ({ name: "Config Default Name" }));
const mockDefaultUserEngine = { get: mockDefaultUserGet };
let networkEngineRejects = false;
const mockGetEngine = jest.fn(async (name: string) => {
	if (name === "defaultUser") return mockDefaultUserEngine;
	if (name === "network") {
		if (networkEngineRejects) throw new Error("no network context");
		return mockNetworkEngine;
	}
	throw new Error(`unexpected getEngine name in test: ${name}`);
});

jest.mock("../../../providers/AppProvider", () => ({
	useApp: () => ({ getEngine: mockGetEngine }),
}));

const mockPersistProvisionedDeviceUser = jest.fn(async (_displayName: string, publicKeyCompressedHex: string) => ({
	id: "user-1",
	name: "Officer One",
	activeKeys: [{ key: publicKeyCompressedHex, type: "P", expiration: Date.now() }],
}));
const mockPersistDeviceProvisioningRecord = jest.fn(async (_record: unknown) => {});
let mockDeviceUserFixture: { id: string; name: string; activeKeys: Array<{ key: string }> } | undefined;
let mockProvisioningRecordFixture: { recoveryPublicKeyCompressedHex: string } | undefined;
const mockGetDeviceUser = jest.fn(async () => mockDeviceUserFixture);
const mockGetDeviceProvisioningRecord = jest.fn(async () => mockProvisioningRecordFixture);

jest.mock("../../../engines/device-user", () => ({
	persistProvisionedDeviceUser: (displayName: string, publicKeyCompressedHex: string) =>
		mockPersistProvisionedDeviceUser(displayName, publicKeyCompressedHex),
	persistDeviceProvisioningRecord: (record: unknown) => mockPersistDeviceProvisioningRecord(record),
	getDeviceUser: () => mockGetDeviceUser(),
	getDeviceProvisioningRecord: () => mockGetDeviceProvisioningRecord(),
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
	mockDefaultUserGet.mockResolvedValue({ name: "Config Default Name" });
	networkEngineRejects = false;
	mockDeviceUserFixture = undefined;
	mockProvisioningRecordFixture = undefined;
});

// Deliberately DIFFERENT pre/post-attestation hex values throughout this suite — the whole point
// of T-49-KEY's fixture design (49-17-PLAN.md): a test using the SAME value on both sides could
// never distinguish "registered the right key" from "registered the wrong key that happens to be
// identical".
const PRE_ATTESTATION_SIGNING_HEX = "aa" + "11".repeat(32);
const POST_ATTESTATION_SIGNING_HEX = "cc" + "33".repeat(32);
const RECOVERY_HEX = "bb" + "22".repeat(32);

function mockHappyPathNative(): void {
	nativeFake.provisionDeviceKey.mockResolvedValue({
		publicKeyBase64: "SIGNING-SPKI-DER-BASE64",
		publicKeyCompressedHex: PRE_ATTESTATION_SIGNING_HEX,
	});
	nativeFake.provisionRecoveryKey.mockResolvedValue({
		publicKeyBase64: "RECOVERY-SPKI-DER-BASE64",
		publicKeyCompressedHex: RECOVERY_HEX,
	});
	nativeFake.produceAttestation.mockResolvedValue({
		certificateChainBase64: ["leaf-cert", "intermediate-cert"],
		publicKeyCompressedHex: POST_ATTESTATION_SIGNING_HEX,
	});
	nativeFake.signWithDeviceKey.mockResolvedValue({ signatureHex: "deadbeef" });
}

describe("ProvisionSigningKeyScreen — 49-17 first-run stage 1 (network-independent, attested-key correctness)", () => {
	it("(a) runs the native ceremony in order and persists BEFORE any network engine call", async () => {
		mockHappyPathNative();

		const tr = await renderScreen();
		await press(tr, primaryButton(tr));

		expect(nativeFake.provisionDeviceKey).toHaveBeenCalledWith("VOTETORRENT_AUTHORITY_SIGNING_KEY_V1");
		expect(nativeFake.provisionRecoveryKey).toHaveBeenCalledWith("VOTETORRENT_AUTHORITY_RECOVERY_KEY_V1");
		expect(nativeFake.produceAttestation).toHaveBeenCalledTimes(1);
		expect(mockPersistDeviceProvisioningRecord).toHaveBeenCalledTimes(1);
		expect(mockPersistProvisionedDeviceUser).toHaveBeenCalledTimes(1);

		const order = [
			nativeFake.provisionDeviceKey.mock.invocationCallOrder[0]!,
			nativeFake.provisionRecoveryKey.mock.invocationCallOrder[0]!,
			nativeFake.produceAttestation.mock.invocationCallOrder[0]!,
			mockPersistDeviceProvisioningRecord.mock.invocationCallOrder[0]!,
			mockPersistProvisionedDeviceUser.mock.invocationCallOrder[0]!,
		];
		const sorted = [...order].sort((a, b) => a - b);
		expect(order).toEqual(sorted);

		// No engine call (network resolution) happens until AFTER stage 1 fully persists.
		const firstNetworkCallOrder = mockGetCurrentUser.mock.invocationCallOrder[0];
		expect(firstNetworkCallOrder).toBeDefined();
		expect(firstNetworkCallOrder!).toBeGreaterThan(mockPersistProvisionedDeviceUser.mock.invocationCallOrder[0]!);

		// `defaultUser` IS resolved during stage 1 (LocalStorage-only, never network-scoped) —
		// assert it was used for the display name, not a network User summary.
		expect(mockDefaultUserGet).toHaveBeenCalled();
		expect(mockPersistProvisionedDeviceUser).toHaveBeenCalledWith("Config Default Name", expect.any(String));
	});

	it("(b) registers the POST-attestation key, never the pre-attestation key — fails if the discarded value is used", async () => {
		mockHappyPathNative();

		const tr = await renderScreen();
		await press(tr, primaryButton(tr));

		expect(mockPersistProvisionedDeviceUser).toHaveBeenCalledWith("Config Default Name", POST_ATTESTATION_SIGNING_HEX);
		expect(mockPersistProvisionedDeviceUser).not.toHaveBeenCalledWith(
			expect.any(String),
			PRE_ATTESTATION_SIGNING_HEX,
		);
	});

	it("(c) persists the provisioning record with the recovery key, the ATTESTED signing key, the alias, and the cert chain", async () => {
		mockHappyPathNative();

		const tr = await renderScreen();
		await press(tr, primaryButton(tr));

		expect(mockPersistDeviceProvisioningRecord).toHaveBeenCalledWith(
			expect.objectContaining({
				recoveryPublicKeyCompressedHex: RECOVERY_HEX,
				attestedPublicKeyCompressedHex: POST_ATTESTATION_SIGNING_HEX,
				signingKeyAlias: "VOTETORRENT_AUTHORITY_SIGNING_KEY_V1",
				certificateChainBase64: ["leaf-cert", "intermediate-cert"],
			}),
		);
	});

	it("(d) lands on the awaiting-network state (no InlineError) when no network User resolves", async () => {
		mockHappyPathNative();
		networkEngineRejects = true;

		const tr = await renderScreen();
		await press(tr, primaryButton(tr));

		const json = JSON.stringify(tr.toJSON());
		expect(json).toContain("signingKeyProvisioningAwaitingNetworkHeading");
		expect(json).not.toContain("deviceSigningError");

		const continueButton = tr.root.findByProps({ testID: "signing-key-provisioning-continue-button" });
		const pressable = continueButton.findAll((node) => typeof node.props.onPress === "function")[0]!;
		await renderer.act(async () => pressable.props.onPress());
		expect(mockGoBack).toHaveBeenCalled();
	});

	it("(e) re-entry on an already-locally-provisioned device never re-runs the native ceremony", async () => {
		mockDeviceUserFixture = {
			id: "user-1",
			name: "Officer One",
			activeKeys: [{ key: POST_ATTESTATION_SIGNING_HEX }],
		};
		mockProvisioningRecordFixture = { recoveryPublicKeyCompressedHex: RECOVERY_HEX };
		// Both keys already registered network-side too, so stage 2 is a full no-op — isolates
		// this test to ONLY the stage-1 idempotency claim (stage 2's own reconciliation coverage
		// lives in the "stage 2 reconciliation" describe block below).
		mockGetSummary.mockResolvedValue({
			id: "user-1",
			name: "Officer One",
			activeKeys: [
				{ key: POST_ATTESTATION_SIGNING_HEX, type: "P", expiration: Date.now() },
				{ key: RECOVERY_HEX, type: "P", expiration: Date.now() },
			],
		});

		const tr = await renderScreen();
		await press(tr, primaryButton(tr));

		expect(nativeFake.provisionDeviceKey).not.toHaveBeenCalled();
		expect(nativeFake.provisionRecoveryKey).not.toHaveBeenCalled();
		expect(nativeFake.produceAttestation).not.toHaveBeenCalled();
		expect(mockPersistProvisionedDeviceUser).not.toHaveBeenCalled();
		expect(mockPersistDeviceProvisioningRecord).not.toHaveBeenCalled();
		expect(mockAddKey).not.toHaveBeenCalled();
	});

	it("(f) a CANCELED rejection during stage 1 renders no InlineError and re-enables the button", async () => {
		nativeFake.provisionDeviceKey.mockRejectedValue(Object.assign(new Error("canceled"), { code: "CANCELED" }));

		const tr = await renderScreen();
		const button = primaryButton(tr);
		await press(tr, button);

		const json = JSON.stringify(tr.toJSON());
		expect(json).not.toContain("deviceSigningError");
		const buttonAfter = primaryButton(tr);
		expect(buttonAfter.props.disabled).toBeFalsy();
	});

	it("(g) a LOCKOUT_PERMANENT rejection renders the deviceSigningErrorLockoutPermanent copy", async () => {
		nativeFake.provisionDeviceKey.mockRejectedValue(
			Object.assign(new Error("locked"), { code: "LOCKOUT_PERMANENT" }),
		);

		const tr = await renderScreen();
		await press(tr, primaryButton(tr));

		const json = JSON.stringify(tr.toJSON());
		expect(json).toContain("deviceSigningErrorLockoutPermanent");
	});
});

describe("ProvisionSigningKeyScreen — 49-17 first-run stage 2 (reconcile against the network User)", () => {
	// Every case here starts from an already-locally-provisioned device (stage 1 already ran on a
	// prior visit) so only stage 2's reconciliation is under test.
	beforeEach(() => {
		mockDeviceUserFixture = {
			id: "user-1",
			name: "Officer One",
			activeKeys: [{ key: POST_ATTESTATION_SIGNING_HEX }],
		};
		mockProvisioningRecordFixture = { recoveryPublicKeyCompressedHex: RECOVERY_HEX };
	});

	it("(a) signing key present, recovery missing: exactly one signed addKey call for the recovery key", async () => {
		mockGetSummary.mockResolvedValue({
			id: "user-1",
			name: "Officer One",
			activeKeys: [{ key: POST_ATTESTATION_SIGNING_HEX, type: "P", expiration: Date.now() }],
		});
		nativeFake.signWithDeviceKey.mockResolvedValue({ signatureHex: "deadbeef" });

		const tr = await renderScreen();
		await press(tr, primaryButton(tr));

		expect(nativeFake.provisionRecoveryKey).not.toHaveBeenCalled();
		expect(mockAddKey).toHaveBeenCalledTimes(1);
		const [key, sign] = mockAddKey.mock.calls[0]!;
		expect((key as { key: string }).key).toBe(RECOVERY_HEX);
		expect(typeof sign).toBe("function");

		const json = JSON.stringify(tr.toJSON());
		expect(json).toContain("signingKeyProvisioningSuccessHeading");
	});

	it("(b) empty activeKeys: two addKey calls in order — bootstrap (no sign) then signed", async () => {
		mockGetSummary.mockResolvedValue({ id: "user-1", name: "Officer One", activeKeys: [] });
		nativeFake.signWithDeviceKey.mockResolvedValue({ signatureHex: "deadbeef" });

		const tr = await renderScreen();
		await press(tr, primaryButton(tr));

		expect(mockAddKey).toHaveBeenCalledTimes(2);
		const [firstKey, firstSign] = mockAddKey.mock.calls[0]!;
		expect((firstKey as { key: string }).key).toBe(POST_ATTESTATION_SIGNING_HEX);
		expect(firstSign).toBeUndefined();
		const [secondKey, secondSign] = mockAddKey.mock.calls[1]!;
		expect((secondKey as { key: string }).key).toBe(RECOVERY_HEX);
		expect(typeof secondSign).toBe("function");

		const json = JSON.stringify(tr.toJSON());
		expect(json).toContain("signingKeyProvisioningSuccessHeading");
	});

	it("(c) both keys present: no addKey call, success renders", async () => {
		mockGetSummary.mockResolvedValue({
			id: "user-1",
			name: "Officer One",
			activeKeys: [
				{ key: POST_ATTESTATION_SIGNING_HEX, type: "P", expiration: Date.now() },
				{ key: RECOVERY_HEX, type: "P", expiration: Date.now() },
			],
		});

		const tr = await renderScreen();
		await press(tr, primaryButton(tr));

		expect(mockAddKey).not.toHaveBeenCalled();
		const json = JSON.stringify(tr.toJSON());
		expect(json).toContain("signingKeyProvisioningSuccessHeading");
	});

	it("(d) the signed insert's signerKey is the ATTESTED signing key, never a pre-attestation value", async () => {
		mockGetSummary.mockResolvedValue({
			id: "user-1",
			name: "Officer One",
			activeKeys: [{ key: POST_ATTESTATION_SIGNING_HEX, type: "P", expiration: Date.now() }],
		});
		nativeFake.signWithDeviceKey.mockResolvedValue({ signatureHex: "deadbeef" });

		let capturedSignature: { signerKey: string } | undefined;
		mockAddKey.mockImplementationOnce(async (_key: unknown, sign?: (d: Uint8Array) => Promise<unknown>) => {
			if (sign) capturedSignature = (await sign(new Uint8Array([1, 2, 3]))) as { signerKey: string };
		});

		const tr = await renderScreen();
		await press(tr, primaryButton(tr));

		expect(capturedSignature?.signerKey).toBe(POST_ATTESTATION_SIGNING_HEX);
		expect(capturedSignature?.signerKey).not.toBe(PRE_ATTESTATION_SIGNING_HEX);
	});

	it("(e) a fresh user engine is resolved between the two writes — getCurrentUser called at least twice", async () => {
		mockGetSummary.mockResolvedValue({ id: "user-1", name: "Officer One", activeKeys: [] });
		nativeFake.signWithDeviceKey.mockResolvedValue({ signatureHex: "deadbeef" });

		const tr = await renderScreen();
		await press(tr, primaryButton(tr));

		expect(mockGetCurrentUser.mock.calls.length).toBeGreaterThanOrEqual(2);
	});

	it("(f) never re-calls provisionRecoveryKey on a return visit", async () => {
		mockGetSummary.mockResolvedValue({ id: "user-1", name: "Officer One", activeKeys: [] });
		nativeFake.signWithDeviceKey.mockResolvedValue({ signatureHex: "deadbeef" });

		const tr = await renderScreen();
		await press(tr, primaryButton(tr));

		expect(nativeFake.provisionRecoveryKey).not.toHaveBeenCalled();
	});

	it("(g) a cancellation raised by signWithDeviceKey returns silently to idle, no InlineError, local record intact", async () => {
		mockGetSummary.mockResolvedValue({
			id: "user-1",
			name: "Officer One",
			activeKeys: [{ key: POST_ATTESTATION_SIGNING_HEX, type: "P", expiration: Date.now() }],
		});
		nativeFake.signWithDeviceKey.mockRejectedValue(Object.assign(new Error("canceled"), { code: "CANCELED" }));

		const tr = await renderScreen();
		await press(tr, primaryButton(tr));

		const json = JSON.stringify(tr.toJSON());
		expect(json).not.toContain("deviceSigningError");
		expect(mockPersistProvisionedDeviceUser).not.toHaveBeenCalled();
		expect(mockPersistDeviceProvisioningRecord).not.toHaveBeenCalled();
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

	it("(c) refreshes the provisioning record with the new attested key and an EMPTY certificateChainBase64 — no produceAttestation on this path", async () => {
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

		expect(nativeFake.produceAttestation).not.toHaveBeenCalled();
		expect(mockPersistDeviceProvisioningRecord).toHaveBeenCalledWith(
			expect.objectContaining({
				recoveryPublicKeyCompressedHex: RECOVERY_KEY_HEX,
				attestedPublicKeyCompressedHex: NEW_SIGNING_KEY_HEX,
				signingKeyAlias: "VOTETORRENT_AUTHORITY_SIGNING_KEY_V1",
				certificateChainBase64: [],
			}),
		);
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
