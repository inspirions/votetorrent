/**
 * AddNetworkScreen.reconciliation.test.tsx — R1 (58-04) closure coverage.
 *
 * Proves D-01/D-02/D-03: a missed `builder.commit()` deadline never reports failure until
 * `getRecentNetworks()` has been re-read under its own separate deadline; a reconciled landing
 * runs the identical success tail a timely commit would; an unconfirmed outcome says only that —
 * never a failure claim, never a connection claim; a non-timeout rejection keeps its existing
 * routing untouched and reconciliation never runs for it; the reconciliation performs no write and
 * calls no `open()`; `finally` clears `creating` on every exit.
 *
 * Block A (`networkCreateOutcome`, pure) is the module's own coverage and is green immediately.
 * Block B (`AddNetworkScreen` behaviour) is proven RED against the unfixed screen — that is the
 * point (58-VALIDATION Known Blind Spot 4: prove every gate RED before trusting it).
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
// `open` exists only so a spec can assert it is never called -- the screen must never call it
// (probing an unknown hash via `open()` would mint an empty on-disk store under it).
const mockNetworksEngine = {
	buildCreate: jest.fn(),
	getRecentNetworks: jest.fn(),
	open: jest.fn(),
};
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
import type { NetworkReference } from "@votetorrent/vote-core";
import {
	RECONCILE_TIMEOUT_MS,
	NETWORK_CREATE_STEP_TIMEOUT,
	createStepTimeoutError,
	timedOutStep,
	findLandedNetwork,
} from "../networkCreateOutcome";

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

/** Drives the screen to a signed, CREATE-pressed state so handleCreate's try body runs, and
 * awaits the returned promise fully. Use only for specs that do not need to drive a real timer. */
async function pressSignThenCreate(tr: renderer.ReactTestRenderer) {
	await renderer.act(async () => {
		getSignButton(tr).props.onPress();
	});
	await renderer.act(async () => {
		await getCreateButton(tr).props.onPress();
	});
}

/** Signs the screen and presses CREATE WITHOUT awaiting the result, returning the in-flight
 * promise so the caller can advance fake timers before it settles.
 *
 * Returns `{ promise }` rather than the promise itself: an `async function` that directly
 * `return`s a thenable has its OWN returned promise transparently chained to it (the engine
 * awaits the returned value before settling the outer promise) -- so `return createPromise;`
 * here would silently make every caller's `await signAndPressCreateWithoutAwaiting(tr)` block
 * until `handleCreate` itself resolves, which is exactly the still-pending promise this helper
 * exists to hand back UNresolved. Wrapping it in an object sidesteps the flattening. */
async function signAndPressCreateWithoutAwaiting(
	tr: renderer.ReactTestRenderer,
): Promise<{ promise: Promise<unknown> }> {
	await renderer.act(async () => {
		getSignButton(tr).props.onPress();
	});
	let createPromise!: Promise<unknown>;
	await renderer.act(async () => {
		createPromise = getCreateButton(tr).props.onPress() as Promise<unknown>;
	});
	return { promise: createPromise };
}

const SIGNING_KEY = "03f450ccccbaefd2efe218d8eb8c2f84677aaed1fa7bc19b9dbcac96e6ef7d86ab";
const RECOVERY_KEY = "036d541206f2fb5d6c67e0a39b615eebf8ada784a8b12dcab550c901305b6fcf3a";

/** The screen's default networkName/domainName state is "" -- no spec here fills those fields,
 * so every "landed" NetworkReference fixture used to drive `findLandedNetwork`'s match must carry
 * name: "" / primaryAuthorityDomainName: "" to be recognized as landed by the real code path. */
const BEFORE: NetworkReference[] = [
	{ hash: "existing-hash", name: "Old Net", primaryAuthorityDomainName: "old.example", relays: [] },
];
const LANDED_REF: NetworkReference = {
	hash: "landed-hash",
	name: "",
	primaryAuthorityDomainName: "",
	relays: [],
};

type CommitBehavior =
	| { kind: "resolve"; ref: NetworkReference }
	| { kind: "reject"; error: Error }
	| { kind: "pending" };

function armCreate(behavior: CommitBehavior) {
	mockGetOrCreateDeviceUser.mockResolvedValue({
		id: "u1",
		name: "Device User",
		activeKeys: [{ key: SIGNING_KEY, type: "P", expiration: Date.now() + 1000 }],
	});
	mockNetworksEngine.buildCreate.mockReturnValue({
		update: () => ({
			isValid: () => true,
			errors: () => [],
			commit: () => {
				if (behavior.kind === "resolve") return Promise.resolve({ init: behavior.ref });
				if (behavior.kind === "reject") return Promise.reject(behavior.error);
				return new Promise(() => {
					/* never settles */
				});
			},
		}),
	});
}

describe("networkCreateOutcome (pure, no timers, no render)", () => {
	describe("timedOutStep", () => {
		it("returns the step for an error from createStepTimeoutError", () => {
			const err = createStepTimeoutError("commit", "did not finish in time");
			expect(timedOutStep(err)).toBe("commit");
		});

		it("preserves the message verbatim", () => {
			const err = createStepTimeoutError("select", "the select step message");
			expect((err as Error).message).toBe("the select step message");
		});

		it("returns undefined for a plain Error", () => {
			expect(timedOutStep(new Error("boom"))).toBeUndefined();
		});

		it("returns undefined for null", () => {
			expect(timedOutStep(null)).toBeUndefined();
		});

		it("returns undefined for a bare string", () => {
			expect(timedOutStep("boom")).toBeUndefined();
		});

		it("returns undefined for an object whose marker property is not a string", () => {
			expect(timedOutStep({ [NETWORK_CREATE_STEP_TIMEOUT]: 42 })).toBeUndefined();
		});
	});

	describe("findLandedNetwork", () => {
		const expected = { name: "New Net", primaryAuthorityDomainName: "new.example" };
		const before: NetworkReference[] = [
			{ hash: "h1", name: "Other Net", primaryAuthorityDomainName: "other.example", relays: [] },
		];

		it("returns the new matching entry", () => {
			const landed: NetworkReference = {
				hash: "h2",
				name: "New Net",
				primaryAuthorityDomainName: "new.example",
				relays: [],
			};
			const after = [...before, landed];
			expect(findLandedNetwork(before, after, expected)).toEqual(landed);
		});

		it("returns undefined when after equals before", () => {
			expect(findLandedNetwork(before, before, expected)).toBeUndefined();
		});

		it("returns undefined when the only new entry differs in name", () => {
			const after = [
				...before,
				{ hash: "h2", name: "Wrong Name", primaryAuthorityDomainName: "new.example", relays: [] },
			];
			expect(findLandedNetwork(before, after, expected)).toBeUndefined();
		});

		it("returns undefined when the only new entry differs in primaryAuthorityDomainName", () => {
			const after = [
				...before,
				{ hash: "h2", name: "New Net", primaryAuthorityDomainName: "wrong.example", relays: [] },
			];
			expect(findLandedNetwork(before, after, expected)).toBeUndefined();
		});

		it("returns the LAST match when two new matching entries appear", () => {
			const first: NetworkReference = {
				hash: "h2",
				name: "New Net",
				primaryAuthorityDomainName: "new.example",
				relays: [],
			};
			const second: NetworkReference = {
				hash: "h3",
				name: "New Net",
				primaryAuthorityDomainName: "new.example",
				relays: [],
			};
			const after = [...before, first, second];
			expect(findLandedNetwork(before, after, expected)).toEqual(second);
		});

		it("returns undefined for non-array inputs", () => {
			expect(
				findLandedNetwork(undefined as unknown as NetworkReference[], before, expected),
			).toBeUndefined();
			expect(
				findLandedNetwork(before, undefined as unknown as NetworkReference[], expected),
			).toBeUndefined();
		});
	});
});

describe("AddNetworkScreen — R1: reconcile before reporting a missed commit deadline", () => {
	beforeEach(() => {
		jest.clearAllMocks();
		mockGetDefaultUser.mockResolvedValue({ name: "Device User" });
		mockGetDeviceProvisioningRecord.mockResolvedValue(undefined);
		mockGetSummary.mockResolvedValue({ id: "u1", activeKeys: [] });
	});

	afterEach(() => {
		jest.useRealTimers();
	});

	it("(1, D-02) commit never settles; the deadline fires; the recents re-read shows a new matching entry -> the normal success tail runs", async () => {
		jest.useFakeTimers();
		armCreate({ kind: "pending" });
		mockNetworksEngine.getRecentNetworks
			.mockResolvedValueOnce(BEFORE)
			.mockResolvedValueOnce([...BEFORE, LANDED_REF]);

		const tr = await renderScreen();
		const { promise: createPromise } = await signAndPressCreateWithoutAwaiting(tr);

		await renderer.act(async () => {
			await jest.advanceTimersByTimeAsync(60_000);
			await createPromise;
		});

		expect(mockSelectNetwork).toHaveBeenCalledTimes(1);
		expect(mockSelectNetwork).toHaveBeenCalledWith(LANDED_REF);
		expect(mockGoBack).toHaveBeenCalledTimes(1);
		expect(inlineErrorMessage(tr)).toBe("");
	});

	it("(2, D-02 load-bearing return) same landing, but the recovery-key gate fires -> navigates and does NOT goBack", async () => {
		jest.useFakeTimers();
		armCreate({ kind: "pending" });
		mockNetworksEngine.getRecentNetworks
			.mockResolvedValueOnce(BEFORE)
			.mockResolvedValueOnce([...BEFORE, LANDED_REF]);
		// The provisioning record holds the recovery key; getSummary shows only the signing key,
		// so the gate fires (measured on real hardware, see AddNetworkScreen.tsx 49-19).
		mockGetDeviceProvisioningRecord.mockResolvedValue({
			recoveryPublicKeyCompressedHex: RECOVERY_KEY,
		});
		mockGetSummary.mockResolvedValue({ id: "u1", activeKeys: [{ key: SIGNING_KEY }] });

		const tr = await renderScreen();
		const { promise: createPromise } = await signAndPressCreateWithoutAwaiting(tr);

		await renderer.act(async () => {
			await jest.advanceTimersByTimeAsync(60_000);
			await createPromise;
		});

		expect(mockNavigate).toHaveBeenCalledWith("ProvisionSigningKey", { reason: "first-run" });
		expect(mockGoBack).not.toHaveBeenCalled();
	});

	it("(3, D-01/D-03) deadline fires; the re-read returns the unchanged list -> reports networkCreateUnconfirmed, no select, no goBack", async () => {
		jest.useFakeTimers();
		armCreate({ kind: "pending" });
		mockNetworksEngine.getRecentNetworks.mockResolvedValueOnce(BEFORE).mockResolvedValueOnce(BEFORE);

		const tr = await renderScreen();
		const { promise: createPromise } = await signAndPressCreateWithoutAwaiting(tr);

		await renderer.act(async () => {
			await jest.advanceTimersByTimeAsync(60_000);
			await createPromise;
		});

		expect(inlineErrorMessage(tr)).toBe("networkCreateUnconfirmed");
		expect(mockSelectNetwork).not.toHaveBeenCalled();
		expect(mockGoBack).not.toHaveBeenCalled();
	});

	it("(4, D-01 own deadline) waits genuinely on the re-read, then reports unconfirmed only after its OWN RECONCILE_TIMEOUT_MS elapses", async () => {
		jest.useFakeTimers();
		armCreate({ kind: "pending" });
		mockNetworksEngine.getRecentNetworks.mockResolvedValueOnce(BEFORE).mockReturnValueOnce(
			new Promise(() => {
				/* the reconcile re-read never settles */
			}),
		);

		const tr = await renderScreen();
		const { promise: createPromise } = await signAndPressCreateWithoutAwaiting(tr);

		// Advance exactly past the commit deadline -- the screen must still be waiting on the
		// re-read, not already giving up. This is the paired control for the second half below.
		await renderer.act(async () => {
			await jest.advanceTimersByTimeAsync(45_001);
		});
		expect(inlineErrorMessage(tr)).toBe("");

		// The reconcile timer is scheduled in a microtask that runs after the first
		// advanceTimersByTimeAsync resolves, so it needs a second, separate advance.
		await renderer.act(async () => {
			await jest.advanceTimersByTimeAsync(RECONCILE_TIMEOUT_MS + 1);
			await createPromise;
		});

		expect(inlineErrorMessage(tr)).toBe("networkCreateUnconfirmed");
	});

	it("(5, finally on every path) after the unconfirmed outcome, the CREATE button re-enables", async () => {
		jest.useFakeTimers();
		armCreate({ kind: "pending" });
		mockNetworksEngine.getRecentNetworks.mockResolvedValueOnce(BEFORE).mockResolvedValueOnce(BEFORE);

		const tr = await renderScreen();
		const { promise: createPromise } = await signAndPressCreateWithoutAwaiting(tr);

		await renderer.act(async () => {
			await jest.advanceTimersByTimeAsync(60_000);
			await createPromise;
		});

		// The precondition this spec's re-enable check is conditioned on: without it, `finally`
		// clearing `creating` is pre-existing behaviour untouched by this plan and would pass
		// trivially against the unfixed screen too (58-VALIDATION Known Blind Spot 4).
		expect(inlineErrorMessage(tr)).toBe("networkCreateUnconfirmed");
		const createButton = getCreateButton(tr);
		expect(createButton.props.title).toBe("create");
		expect(createButton.props.disabled).toBe(false);
	});

	it("(6, non-timeout passthrough) a NO_KEY_PROVISIONED commit() rejection keeps its existing routing; reconciliation never runs", async () => {
		const rejection = Object.assign(new Error("no device signing key provisioned"), {
			code: "NO_KEY_PROVISIONED",
		});
		armCreate({ kind: "reject", error: rejection });
		mockNetworksEngine.getRecentNetworks.mockResolvedValueOnce(BEFORE);

		const tr = await renderScreen();
		await pressSignThenCreate(tr);

		expect(mockNavigate).toHaveBeenCalledWith("ProvisionSigningKey", { reason: "first-run" });
		expect(inlineErrorMessage(tr)).toBe("");
		expect(mockNetworksEngine.getRecentNetworks).toHaveBeenCalledTimes(1);
	});

	it("(7, non-timeout passthrough) a plain Error rejection reaches setErrorMessage with its own text; reconciliation never runs", async () => {
		armCreate({ kind: "reject", error: new Error("boom") });
		mockNetworksEngine.getRecentNetworks.mockResolvedValueOnce(BEFORE);

		const tr = await renderScreen();
		await pressSignThenCreate(tr);

		expect(inlineErrorMessage(tr)).toBe("boom");
		expect(mockNetworksEngine.getRecentNetworks).toHaveBeenCalledTimes(1);
	});

	it("(8, read-only guarantee) on the landed path, open() is never called and getRecentNetworks is called exactly twice", async () => {
		jest.useFakeTimers();
		armCreate({ kind: "pending" });
		mockNetworksEngine.getRecentNetworks
			.mockResolvedValueOnce(BEFORE)
			.mockResolvedValueOnce([...BEFORE, LANDED_REF]);

		const tr = await renderScreen();
		const { promise: createPromise } = await signAndPressCreateWithoutAwaiting(tr);

		await renderer.act(async () => {
			await jest.advanceTimersByTimeAsync(60_000);
			await createPromise;
		});

		expect(mockNetworksEngine.open).not.toHaveBeenCalled();
		expect(mockNetworksEngine.getRecentNetworks).toHaveBeenCalledTimes(2);
	});

	it("(9, happy path unchanged) commit() resolves promptly -> one snapshot read, select with the commit's own ref, goBack", async () => {
		const ref: NetworkReference = {
			hash: "net-hash",
			name: "",
			primaryAuthorityDomainName: "",
			relays: [],
		};
		armCreate({ kind: "resolve", ref });
		mockNetworksEngine.getRecentNetworks.mockResolvedValueOnce(BEFORE);

		const tr = await renderScreen();
		await pressSignThenCreate(tr);

		expect(mockNetworksEngine.getRecentNetworks).toHaveBeenCalledTimes(1);
		expect(mockSelectNetwork).toHaveBeenCalledWith(ref);
		expect(mockGoBack).toHaveBeenCalledTimes(1);
	});
});
