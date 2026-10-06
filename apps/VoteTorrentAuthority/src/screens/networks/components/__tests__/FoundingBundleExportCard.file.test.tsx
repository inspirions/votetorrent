/**
 * FoundingBundleExportCard.file.test.tsx — the file handoff after the single biometric export
 * (D-35, D-36, D-37). Real LifecycleConfirmCard and real i18n resources; the native file seam,
 * the document picker, Share, device-signer/device-user and useApp are mocked.
 */

import React from "react";
import renderer, { act } from "react-test-renderer";
import { Platform } from "react-native";
import { resources } from "../../../../i18n";

jest.mock("react-native-vector-icons/FontAwesome6", () => "FontAwesome6");

jest.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string) => {
			// eslint-disable-next-line @typescript-eslint/no-var-requires
			const { resources: res } = require("../../../../i18n");
			const value = (res.en.translation as Record<string, string>)[key];
			return typeof value === "string" ? value : key;
		},
	}),
	initReactI18next: { type: "3rdParty", init: jest.fn() },
}));

jest.mock("@react-navigation/native", () => ({
	useNavigation: () => ({ navigate: jest.fn(), setOptions: jest.fn() }),
	useTheme: () => {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const { lightTheme: theme } = require("../../../../theme/themes");
		return theme;
	},
}));

const mockExport = jest.fn();
const mockNetworksEngine = { open: jest.fn(async () => ({})), exportFoundingBundle: (...a: unknown[]) => mockExport(...a) };
jest.mock("../../../../providers/AppProvider", () => ({
	useApp: () => ({ networksEngine: mockNetworksEngine }),
}));

const mockCreateSigner = jest.fn();
jest.mock("../../../../engines/device-signer", () => ({ createDeviceSigner: () => mockCreateSigner() }));
jest.mock("../../../../engines/device-user", () => ({
	getDeviceUser: async () => ({ id: "user-1", name: "O", activeKeys: [{ key: "key-1", type: "ed25519" }] }),
}));

const mockWrite = jest.fn();
const mockShareAndroid = jest.fn();
jest.mock("@votetorrent/attestation-native", () => {
	const actual = jest.requireActual("@votetorrent/attestation-native");
	return {
		...actual,
		writeShareFile: (...a: unknown[]) => mockWrite(...a),
		shareFileAndroid: (...a: unknown[]) => mockShareAndroid(...a),
	};
});

const mockSave = jest.fn();
jest.mock("@react-native-documents/picker", () => ({
	saveDocuments: (...a: unknown[]) => mockSave(...a),
	errorCodes: { OPERATION_CANCELED: "OPERATION_CANCELED" },
	isErrorWithCode: (e: any) => typeof e?.code === "string",
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { FoundingBundleExportCard } = require("../FoundingBundleExportCard");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Share } = require("react-native");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { FileShareError } = require("@votetorrent/attestation-native");

const T = resources.en.translation;
const REF = { hash: "hashA", name: "Network A", primaryAuthorityDomainName: "a.example" };
const URI = "file:///cache/founding-bundle.json";
const FILE = "founding-bundle.json";
const TEXT = "BUNDLE-TEXT-SECRET";

function setOS(os: "android" | "ios") {
	Object.defineProperty(Platform, "OS", { configurable: true, get: () => os });
}

const flush = async () => {
	for (let i = 0; i < 6; i++) {
		await act(async () => {
			await Promise.resolve();
		});
	}
};

function byTestID(tr: renderer.ReactTestRenderer, id: string) {
	return tr.root.findAll((n) => n.props.testID === id && n.props.title !== undefined && typeof n.props.onPress === "function");
}
function exists(tr: renderer.ReactTestRenderer, id: string) {
	return tr.root.findAll((n) => n.props.testID === id).length > 0;
}
async function press(tr: renderer.ReactTestRenderer, id: string) {
	await act(async () => {
		(byTestID(tr, id)[0].props as any).onPress();
	});
	await flush();
}

async function renderReady(onClose = jest.fn()) {
	let tr!: renderer.ReactTestRenderer;
	await act(async () => {
		tr = renderer.create(<FoundingBundleExportCard networkRef={REF} onClose={onClose} />);
	});
	const confirm = tr.root.findAll(
		(n) => n.props.title === T.networkFoundingExportShareButton && typeof n.props.onPress === "function",
	);
	await act(async () => {
		(confirm[0].props as any).onPress();
	});
	await flush();
	return { tr, onClose };
}

let shareSpy: jest.SpyInstance;

beforeEach(() => {
	jest.clearAllMocks();
	setOS("android");
	shareSpy = jest.spyOn(Share, "share").mockResolvedValue({ action: "sharedAction" });
	mockCreateSigner.mockImplementation(async () => jest.fn());
	mockExport.mockImplementation(async () => ({ bundle: {}, text: TEXT, fileName: FILE }));
	mockWrite.mockImplementation(async () => URI);
	mockShareAndroid.mockImplementation(async () => undefined);
	mockSave.mockImplementation(async () => [{ uri: "content://x", name: FILE, error: null }]);
});

afterEach(() => {
	shareSpy.mockRestore();
});

describe("FoundingBundleExportCard file handoff", () => {
	it("1: android ready state after a single export and file write", async () => {
		const { tr } = await renderReady();
		expect(mockCreateSigner).toHaveBeenCalledTimes(1);
		expect(mockExport).toHaveBeenCalledTimes(1);
		expect(mockWrite).toHaveBeenCalledTimes(1);
		expect(mockWrite).toHaveBeenCalledWith(FILE, TEXT);
		expect(byTestID(tr, "founding-export-share-file")).toHaveLength(1);
		expect(byTestID(tr, "founding-export-save-file")).toHaveLength(1);
		expect(byTestID(tr, "founding-export-done")).toHaveLength(1);
	});

	it("2: Share file uses the Android file share, never the text share", async () => {
		const { tr } = await renderReady();
		await press(tr, "founding-export-share-file");
		expect(mockShareAndroid).toHaveBeenCalledTimes(1);
		expect(mockShareAndroid).toHaveBeenCalledWith(URI, {
			mimeType: "application/json",
			subject: FILE,
			dialogTitle: T.networkFoundingExportShareButton,
		});
		expect(shareSpy).not.toHaveBeenCalled();
		expect(exists(tr, "founding-export-body-ready")).toBe(true);
	});

	it("3: Save to this phone saves the file; a cancel stays ready with no error", async () => {
		const { tr } = await renderReady();
		await press(tr, "founding-export-save-file");
		expect(mockSave).toHaveBeenCalledWith({ sourceUris: [URI], fileName: FILE, mimeType: "application/json" });
		expect(JSON.stringify(tr.toJSON())).toContain(T.networkFoundingExportSaved);

		mockSave.mockImplementation(async () => {
			throw Object.assign(new Error("cancel"), { code: "OPERATION_CANCELED" });
		});
		await press(tr, "founding-export-save-file");
		expect(exists(tr, "founding-export-body-ready")).toBe(true);
		expect(exists(tr, "founding-export-body-error")).toBe(false);
	});

	it("4: share then save reuse the single export and signer", async () => {
		const { tr } = await renderReady();
		await press(tr, "founding-export-share-file");
		await press(tr, "founding-export-save-file");
		expect(mockExport).toHaveBeenCalledTimes(1);
		expect(mockCreateSigner).toHaveBeenCalledTimes(1);
		expect(mockWrite).toHaveBeenCalledTimes(1);
	});

	it("5: ios shows Share file and Done only; Share file uses the url share", async () => {
		setOS("ios");
		const { tr } = await renderReady();
		expect(byTestID(tr, "founding-export-save-file")).toHaveLength(0);
		expect(byTestID(tr, "founding-export-done")).toHaveLength(1);
		await press(tr, "founding-export-share-file");
		expect(shareSpy).toHaveBeenCalledWith({ url: URI, title: FILE });
		expect(mockShareAndroid).not.toHaveBeenCalled();
	});

	it("6a: unavailable seam falls back to the text share with a visible notice", async () => {
		mockWrite.mockImplementation(async () => {
			throw new FileShareError("unavailable", "no native");
		});
		const { tr } = await renderReady();
		expect(shareSpy).toHaveBeenCalledTimes(1);
		expect(shareSpy.mock.calls[0][0]).toEqual({ message: TEXT, title: FILE });
		expect(JSON.stringify(tr.toJSON())).toContain(T.networkFoundingExportTextFallback);
	});

	it("6b: any other file error goes to the error state with no text share", async () => {
		const info = jest.spyOn(console, "info").mockImplementation(() => {});
		mockWrite.mockImplementation(async () => {
			throw new FileShareError("write-failed", "disk");
		});
		const { tr } = await renderReady();
		expect(exists(tr, "founding-export-body-error")).toBe(true);
		expect(shareSpy).not.toHaveBeenCalled();
		info.mockRestore();
	});

	it("7: no rendered text contains the bundle text, hash or file uri; the file name may appear", async () => {
		const { tr } = await renderReady();
		const json = JSON.stringify(tr.toJSON());
		expect(json).not.toContain(TEXT);
		expect(json).not.toContain(URI);
		expect(json).not.toContain(REF.hash);
		expect(json).toContain(FILE);
	});

	it("Done closes the card", async () => {
		const { tr, onClose } = await renderReady();
		await press(tr, "founding-export-done");
		expect(onClose).toHaveBeenCalledTimes(1);
	});
});
