/**
 * ImportFoundingBundleScreen.test.tsx — M-1, S-1..S-9 (D-35, D-36, D-37).
 *
 * Mounts the REAL screen. `t()` resolves against the REAL `resources` from `src/i18n/index.ts`
 * for both `en` and `es` (mirrors `ThresholdProgressNote.test.tsx`'s `mockCurrentLocale`
 * convention); `useTheme()` returns the REAL `lightTheme.colors`. Geometry assertions walk the
 * RENDERED JSON tree (`StyleSheet.flatten`), mirroring `ThresholdProgressNote.test.tsx`'s
 * `findJsonByTestID`/ancestor-walk and `button-radius-padding.test.tsx`'s flatten convention.
 * Button PRESSES go through `tr.root.findAll` against the `CustomButton` REACT element (its
 * `onPress` prop is the real handler) — `CustomButton`'s rendered `TouchableOpacity` host node
 * does not expose a callable `onPress` prop in the JSON tree (Pressability consumes it
 * internally), only `accessibilityLabel`/`accessibilityRole`/style, which the JSON assertions use.
 */

import React from "react";
import { StyleSheet } from "react-native";
import renderer, { act } from "react-test-renderer";
import { lightTheme } from "../../../theme/themes";
import { resources } from "../../../i18n";
import { mapFoundingImportResult } from "../foundingBundleState";
import type { FoundingBundleImportResult } from "@votetorrent/vote-core";

jest.mock("react-native-vector-icons/FontAwesome6", () => "FontAwesome6");

jest.mock("react-native-safe-area-context", () => ({
	useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

let mockCurrentLocale: "en" | "es" = "en";

jest.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string) => {
			// eslint-disable-next-line @typescript-eslint/no-var-requires
			const { resources: res } = require("../../../i18n");
			const value = (res[mockCurrentLocale].translation as Record<string, string>)[key];
			return typeof value === "string" ? value : key;
		},
	}),
	initReactI18next: { type: "3rdParty", init: jest.fn() },
}));

const mockNavigate = jest.fn();
jest.mock("@react-navigation/native", () => ({
	useTheme: () => {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const { lightTheme: theme } = require("../../../theme/themes");
		return theme;
	},
	useNavigation: () => ({ navigate: mockNavigate }),
}));

let mockNetworksEngine: { importFoundingBundle: jest.Mock } | undefined;
const mockSelectNetwork = jest.fn(async () => undefined);
jest.mock("../../../providers/AppProvider", () => ({
	useApp: () => ({ networksEngine: mockNetworksEngine, selectNetwork: mockSelectNetwork }),
}));

const mockGetDeviceUser = jest.fn(async () => ({ id: "user-1" }));
jest.mock("../../../engines/device-user", () => ({
	getDeviceUser: () => mockGetDeviceUser(),
}));

const mockPickFoundingBundleFile = jest.fn();
jest.mock("../../../engines/pick-founding-bundle-file", () => ({
	pickFoundingBundleFile: (...args: unknown[]) => mockPickFoundingBundleFile(...args),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const ImportFoundingBundleScreen = require("../ImportFoundingBundleScreen").default;

const NETWORK_REF = { hash: "netHash1", name: "Test Network", primaryAuthorityDomainName: "authority.example" };

function okResult(outcome: "replayed" | "already-present"): FoundingBundleImportResult {
	return { ok: true, outcome, networkRef: NETWORK_REF as any, network: {} as any };
}
function alreadyJoinedResult(): FoundingBundleImportResult {
	return { ok: false, reason: "already-joined", category: "already-joined", networkRef: NETWORK_REF as any };
}
function invalidBundleResult(): FoundingBundleImportResult {
	return { ok: false, reason: "signature-invalid", category: "invalid-bundle", detail: "d" };
}
function errorResult(): FoundingBundleImportResult {
	return { ok: false, reason: "target-open-failed", category: "error", detail: "d" };
}

async function mount() {
	let tr!: renderer.ReactTestRenderer;
	await act(async () => {
		tr = renderer.create(<ImportFoundingBundleScreen />);
	});
	return tr;
}

/** Finds the CustomButton REACT element (not its rendered host node) by its resolved title. */
function findButton(tr: renderer.ReactTestRenderer, title: string) {
	const matches = tr.root.findAll(
		(n) => typeof (n.props as any)?.title === "string" && (n.props as any).title === title && typeof (n.props as any).onPress === "function",
	);
	expect(matches.length).toBeGreaterThan(0);
	return matches[0];
}

async function pressButton(tr: renderer.ReactTestRenderer, title: string) {
	const button = findButton(tr, title);
	await act(async () => {
		(button.props as any).onPress();
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
	});
}

function findJsonByTestID(
	node: unknown,
	testID: string,
	path: unknown[] = [],
): { node: any; path: any[] } | null {
	if (node == null || typeof node === "string") return null;
	if (Array.isArray(node)) {
		for (const child of node) {
			const found = findJsonByTestID(child, testID, path);
			if (found) return found;
		}
		return null;
	}
	const n = node as { props?: Record<string, unknown>; children?: unknown[] };
	if (n.props && n.props.testID === testID) return { node, path };
	if (n.children) {
		for (const child of n.children) {
			const found = findJsonByTestID(child, testID, [...path, node]);
			if (found) return found;
		}
	}
	return null;
}

/** True if any descendant (inclusive) carries accessibilityRole === 'button'. */
function hasButtonDescendant(node: unknown): boolean {
	if (node == null || typeof node === "string") return false;
	if (Array.isArray(node)) return node.some(hasButtonDescendant);
	const n = node as { props?: Record<string, unknown>; children?: unknown[] };
	if (n.props?.accessibilityRole === "button") return true;
	return (n.children ?? []).some(hasButtonDescendant);
}

const STATES = ["idle", "picking", "validating", "invalidSignature", "alreadyJoined", "success", "genericError"];

beforeEach(() => {
	jest.clearAllMocks();
	mockCurrentLocale = "en";
	mockNetworksEngine = { importFoundingBundle: jest.fn(async () => okResult("replayed")) };
	mockGetDeviceUser.mockImplementation(async () => ({ id: "user-1" } as any));
});

describe("M-1: mapFoundingImportResult — exhaustive 62-16 category map", () => {
	it("ok replayed -> success (carries networkRef)", () => {
		expect(mapFoundingImportResult(okResult("replayed"))).toEqual({ state: "success", networkRef: NETWORK_REF });
	});
	it("ok already-present -> success (carries networkRef)", () => {
		expect(mapFoundingImportResult(okResult("already-present"))).toEqual({
			state: "success",
			networkRef: NETWORK_REF,
		});
	});
	it("category already-joined -> alreadyJoined (carries networkRef)", () => {
		expect(mapFoundingImportResult(alreadyJoinedResult())).toEqual({
			state: "alreadyJoined",
			networkRef: NETWORK_REF,
		});
	});
	it("category invalid-bundle -> invalidSignature", () => {
		expect(mapFoundingImportResult(invalidBundleResult())).toEqual({ state: "invalidSignature" });
	});
	it("category error -> genericError", () => {
		expect(mapFoundingImportResult(errorResult())).toEqual({ state: "genericError" });
	});
});

describe("S-1: each of the seven states renders exactly one body and none of the other six", () => {
	it("idle renders only founding-import-body-idle", async () => {
		const tr = await mount();
		const json = tr.toJSON();
		for (const state of STATES) {
			const found = findJsonByTestID(json, `founding-import-body-${state}`);
			if (state === "idle") expect(found).toBeTruthy();
			else expect(found).toBeNull();
		}
	});

	it("every one of the seven states renders a DISTINCT testID (no two states share a body) — this is the rung m4 proves", async () => {
		const observedTestIDs: Record<string, string> = {};

		async function reach(state: string, engineResult: FoundingBundleImportResult | "hold-validating"): Promise<void> {
			mockPickFoundingBundleFile.mockResolvedValue({ kind: "picked", text: "bundle" });
			mockNetworksEngine =
				engineResult === "hold-validating"
					? { importFoundingBundle: jest.fn(() => new Promise(() => {})) }
					: { importFoundingBundle: jest.fn(async () => engineResult) };
			const tr = await pickAndResolve({ kind: "picked", text: "bundle" });
			const json = tr.toJSON();
			// Find whichever of the seven testIDs actually rendered.
			for (const candidate of STATES) {
				const found = findJsonByTestID(json, `founding-import-body-${candidate}`);
				if (found) {
					observedTestIDs[state] = `founding-import-body-${candidate}`;
					return;
				}
			}
			throw new Error(`reach(${state}): no founding-import-body-* testID rendered`);
		}

		// idle and picking need their own direct paths (no engine result applies).
		{
			const tr = await mount();
			observedTestIDs.idle = findJsonByTestID(tr.toJSON(), "founding-import-body-idle") ? "founding-import-body-idle" : "MISSING";
		}
		{
			let resolvePick!: (v: unknown) => void;
			mockPickFoundingBundleFile.mockReturnValue(new Promise((resolve) => (resolvePick = resolve)));
			const tr = await mount();
			await pressButton(tr, resources.en.translation.networkFoundingImportChooseFileButton);
			observedTestIDs.picking = findJsonByTestID(tr.toJSON(), "founding-import-body-picking")
				? "founding-import-body-picking"
				: "MISSING";
			await act(async () => {
				resolvePick({ kind: "cancelled" });
				await Promise.resolve();
			});
		}

		await reach("validating", "hold-validating");
		await reach("invalidSignature", invalidBundleResult());
		await reach("alreadyJoined", alreadyJoinedResult());
		await reach("success", okResult("replayed"));
		await reach("genericError", errorResult());

		const values = Object.values(observedTestIDs);
		expect(new Set(values).size).toBe(values.length);
		for (const state of STATES) {
			expect(observedTestIDs[state]).toBe(`founding-import-body-${state}`);
		}
	});
});

describe("S-2: idle -> picking flow, guarded against a double tap", () => {
	it("idle shows the Choose File button (accent); pressing it moves to picking (empty body); a concurrent second call does not invoke the picker twice", async () => {
		let resolvePick!: (v: unknown) => void;
		mockPickFoundingBundleFile.mockReturnValue(
			new Promise((resolve) => {
				resolvePick = resolve;
			}),
		);

		const tr = await mount();
		const idleBody = findJsonByTestID(tr.toJSON(), "founding-import-body-idle")!.node;
		const buttonHost = idleBody.children.find((c: any) => c?.props?.accessibilityRole === "button");
		expect(buttonHost.props.accessibilityLabel).toBe(resources.en.translation.networkFoundingImportChooseFileButton);
		const flat = StyleSheet.flatten(buttonHost.props.style) as Record<string, unknown>;
		expect(flat.backgroundColor).toBe(lightTheme.colors.accent);

		const button = findButton(tr, resources.en.translation.networkFoundingImportChooseFileButton);
		await act(async () => {
			(button.props as any).onPress();
			(button.props as any).onPress();
			await Promise.resolve();
		});

		expect(mockPickFoundingBundleFile).toHaveBeenCalledTimes(1);
		expect(findJsonByTestID(tr.toJSON(), "founding-import-body-picking")).toBeTruthy();

		await act(async () => {
			resolvePick({ kind: "cancelled" });
			await Promise.resolve();
		});
	});
});

describe("S-3: validating shows the validating copy and contains no pressable element", () => {
	it("renders networkFoundingImportValidating with no button", async () => {
		let resolvePick!: (v: unknown) => void;
		mockPickFoundingBundleFile.mockReturnValue(
			new Promise((resolve) => {
				resolvePick = resolve;
			}),
		);
		mockNetworksEngine = {
			importFoundingBundle: jest.fn(
				() =>
					new Promise(() => {
						/* never resolves — hold at validating */
					}),
			),
		};

		const tr = await mount();
		await pressButton(tr, resources.en.translation.networkFoundingImportChooseFileButton);
		await act(async () => {
			resolvePick({ kind: "picked", text: "bundle-text" });
			await Promise.resolve();
			await Promise.resolve();
		});

		const validatingBody = findJsonByTestID(tr.toJSON(), "founding-import-body-validating")!.node;
		expect(validatingBody).toBeTruthy();
		const text = validatingBody.children[0];
		expect(text.children).toEqual([resources.en.translation.networkFoundingImportValidating]);
		expect(hasButtonDescendant(validatingBody)).toBe(false);
	});
});

describe("S-4: picked text passed unchanged, device user as second arg, no options; result maps through mapFoundingImportResult", () => {
	it("calls importFoundingBundle(text, deviceUser) and lands on success", async () => {
		mockPickFoundingBundleFile.mockResolvedValue({ kind: "picked", text: "SENTINEL-BUNDLE-TEXT" });
		mockGetDeviceUser.mockResolvedValue({ id: "user-xyz" } as any);
		mockNetworksEngine = { importFoundingBundle: jest.fn(async () => okResult("replayed")) };

		const tr = await mount();
		await pressButton(tr, resources.en.translation.networkFoundingImportChooseFileButton);

		expect(mockNetworksEngine!.importFoundingBundle).toHaveBeenCalledWith("SENTINEL-BUNDLE-TEXT", { id: "user-xyz" });
		expect(mockNetworksEngine!.importFoundingBundle.mock.calls[0]).toHaveLength(2);
	});
});

async function pickAndResolve(pickResult: unknown) {
	mockPickFoundingBundleFile.mockResolvedValue(pickResult);
	const tr = await mount();
	await pressButton(tr, resources.en.translation.networkFoundingImportChooseFileButton);
	return tr;
}

describe("S-5: invalidSignature and genericError bodies — geometry + EN/ES full text", () => {
	for (const locale of ["en", "es"] as const) {
		it(`invalidSignature (${locale}): first child, full text, colors.error, no clipping, Choose Another File follows`, async () => {
			mockCurrentLocale = locale;
			mockNetworksEngine = { importFoundingBundle: jest.fn(async () => invalidBundleResult()) };
			mockPickFoundingBundleFile.mockResolvedValue({ kind: "picked", text: "bundle" });
			const tr = await mount();
			await pressButton(tr, resources[locale].translation.networkFoundingImportChooseFileButton);

			const json = tr.toJSON();
			const found = findJsonByTestID(json, "founding-import-body-invalidSignature")!;
			// Body is the first child of its immediate parent (the ScrollView's content wrapper).
			const parent = found.path[found.path.length - 1] as any;
			expect(parent.children[0]).toBe(found.node);

			const [textNode, buttonNode] = found.node.children;
			expect(textNode.props.numberOfLines).toBeUndefined();
			expect(textNode.props.ellipsizeMode).toBeUndefined();
			const flat = StyleSheet.flatten(textNode.props.style) as Record<string, unknown>;
			expect(flat.position).not.toBe("absolute");
			expect(flat.color).toBe(lightTheme.colors.error);
			expect(textNode.children).toEqual([resources[locale].translation.networkFoundingImportInvalidSignature]);

			expect(buttonNode.props.accessibilityLabel).toBe(
				resources[locale].translation.networkFoundingImportChooseAnotherFileButton,
			);

			const ancestors = [...found.path, found.node];
			for (const ancestor of ancestors) {
				const aFlat = (StyleSheet.flatten([
					(ancestor as any).props?.style,
					(ancestor as any).props?.contentContainerStyle,
				]) ?? {}) as Record<string, unknown>;
				expect(aFlat.height).toBeUndefined();
				expect(aFlat.maxHeight).toBeUndefined();
				expect(aFlat.overflow).not.toBe("hidden");
			}
		});

		it(`genericError (${locale}): first child, full text, colors.error, no clipping, Choose Another File follows`, async () => {
			mockCurrentLocale = locale;
			mockNetworksEngine = { importFoundingBundle: jest.fn(async () => errorResult()) };
			mockPickFoundingBundleFile.mockResolvedValue({ kind: "picked", text: "bundle" });
			const tr = await mount();
			await pressButton(tr, resources[locale].translation.networkFoundingImportChooseFileButton);

			const json = tr.toJSON();
			const found = findJsonByTestID(json, "founding-import-body-genericError")!;
			const parent = found.path[found.path.length - 1] as any;
			expect(parent.children[0]).toBe(found.node);

			const [textNode, buttonNode] = found.node.children;
			expect(textNode.props.numberOfLines).toBeUndefined();
			expect(textNode.props.ellipsizeMode).toBeUndefined();
			const flat = StyleSheet.flatten(textNode.props.style) as Record<string, unknown>;
			expect(flat.position).not.toBe("absolute");
			expect(flat.color).toBe(lightTheme.colors.error);
			expect(textNode.children).toEqual([resources[locale].translation.networkFoundingImportGenericError]);
			expect(buttonNode.props.accessibilityLabel).toBe(
				resources[locale].translation.networkFoundingImportChooseAnotherFileButton,
			);

			const ancestors = [...found.path, found.node];
			for (const ancestor of ancestors) {
				const aFlat = (StyleSheet.flatten([
					(ancestor as any).props?.style,
					(ancestor as any).props?.contentContainerStyle,
				]) ?? {}) as Record<string, unknown>;
				expect(aFlat.height).toBeUndefined();
				expect(aFlat.maxHeight).toBeUndefined();
				expect(aFlat.overflow).not.toBe("hidden");
			}
		});
	}
});

describe("S-6: alreadyJoined — textSecondary, only control is View Network -> NetworkDetails", () => {
	it("renders the alreadyJoined body with no Choose File / import-again control", async () => {
		mockNetworksEngine = { importFoundingBundle: jest.fn(async () => alreadyJoinedResult()) };
		const tr = await pickAndResolve({ kind: "picked", text: "bundle" });

		const found = findJsonByTestID(tr.toJSON(), "founding-import-body-alreadyJoined")!;
		const [textNode, buttonNode] = found.node.children;
		const flat = StyleSheet.flatten(textNode.props.style) as Record<string, unknown>;
		expect(flat.color).toBe(lightTheme.colors.textSecondary);
		expect(textNode.children).toEqual([resources.en.translation.networkFoundingImportAlreadyJoined]);

		expect(buttonNode.props.accessibilityLabel).toBe(resources.en.translation.networkFoundingImportViewNetworkButton);
		expect(found.node.children).toHaveLength(2);

		await pressButton(tr, resources.en.translation.networkFoundingImportViewNetworkButton);
		expect(mockNavigate).toHaveBeenCalledWith("NetworkDetails", { networkRef: NETWORK_REF });
	});
});

describe("S-7: success — colors.success, selectNetwork awaited then navigate Home; rejection leaves success body, no navigation", () => {
	it("navigates Home after a successful selectNetwork", async () => {
		mockSelectNetwork.mockResolvedValueOnce(undefined);
		mockNetworksEngine = { importFoundingBundle: jest.fn(async () => okResult("replayed")) };
		const tr = await pickAndResolve({ kind: "picked", text: "bundle" });
		await act(async () => {
			await Promise.resolve();
			await Promise.resolve();
		});

		const found = findJsonByTestID(tr.toJSON(), "founding-import-body-success")!;
		const flat = StyleSheet.flatten(found.node.children[0].props.style) as Record<string, unknown>;
		expect(flat.color).toBe(lightTheme.colors.success);
		expect(found.node.children[0].children).toEqual([resources.en.translation.networkFoundingImportSuccess]);
		expect(mockSelectNetwork).toHaveBeenCalledWith(NETWORK_REF);
		expect(mockNavigate).toHaveBeenCalledWith("Home");
	});

	it("a selectNetwork rejection leaves the success body and does not navigate", async () => {
		mockSelectNetwork.mockRejectedValueOnce(new Error("boom"));
		mockNetworksEngine = { importFoundingBundle: jest.fn(async () => okResult("replayed")) };
		const tr = await pickAndResolve({ kind: "picked", text: "bundle" });
		await act(async () => {
			await Promise.resolve();
			await Promise.resolve();
		});

		expect(findJsonByTestID(tr.toJSON(), "founding-import-body-success")).toBeTruthy();
		expect(mockNavigate).not.toHaveBeenCalledWith("Home");
	});
});

describe("S-8: terminal state mapping", () => {
	it("cancelled returns to idle", async () => {
		const tr = await pickAndResolve({ kind: "cancelled" });
		expect(findJsonByTestID(tr.toJSON(), "founding-import-body-idle")).toBeTruthy();
	});
	it("too-large maps to invalidSignature", async () => {
		const tr = await pickAndResolve({ kind: "too-large" });
		expect(findJsonByTestID(tr.toJSON(), "founding-import-body-invalidSignature")).toBeTruthy();
	});
	it("unreadable maps to genericError", async () => {
		const tr = await pickAndResolve({ kind: "unreadable", reason: "picker-error" });
		expect(findJsonByTestID(tr.toJSON(), "founding-import-body-genericError")).toBeTruthy();
	});
	it("an importFoundingBundle throw maps to genericError", async () => {
		mockNetworksEngine = {
			importFoundingBundle: jest.fn(async () => {
				throw new Error("boom");
			}),
		};
		const tr = await pickAndResolve({ kind: "picked", text: "bundle" });
		expect(findJsonByTestID(tr.toJSON(), "founding-import-body-genericError")).toBeTruthy();
	});
	it("an absent networksEngine maps to genericError", async () => {
		mockNetworksEngine = undefined;
		const tr = await pickAndResolve({ kind: "picked", text: "bundle" });
		expect(findJsonByTestID(tr.toJSON(), "founding-import-body-genericError")).toBeTruthy();
	});
});

describe("S-9: no console call leaks a sentinel planted in the bundle text or the network hash", () => {
	it("console.info never contains the sentinel bundle text or hash", async () => {
		const spy = jest.spyOn(console, "info").mockImplementation(() => {});
		const sentinel = "SENTINEL-DO-NOT-LOG-ME-12345";
		mockNetworksEngine = {
			importFoundingBundle: jest.fn(async () => ({
				ok: false,
				reason: "signature-invalid",
				category: "invalid-bundle",
				detail: sentinel,
			})),
		};
		await pickAndResolve({ kind: "picked", text: sentinel });

		for (const call of spy.mock.calls) {
			const joined = call.map((a) => String(a)).join(" ");
			expect(joined).not.toContain(sentinel);
			expect(joined).not.toContain(NETWORK_REF.hash);
		}
		spy.mockRestore();
	});
});
