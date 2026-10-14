/**
 * VoterInviteCard.test.tsx — "Invite voters" (spike 100). Real i18n resources and the real
 * engines/voter-invite logic; the node, the networks engine, device-user, clipboard and Share are
 * mocked.
 */
import React from "react";
import renderer, { act } from "react-test-renderer";
import { decodeNetworkJoinCode } from "@votetorrent/vote-engine/rn";
import { resources } from "../../../../i18n";

jest.mock("react-native-vector-icons/FontAwesome6", () => "FontAwesome6");

jest.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, vars?: Record<string, string>) => {
			// eslint-disable-next-line @typescript-eslint/no-var-requires
			const { resources: res } = require("../../../../i18n");
			const value = (res.en.translation as Record<string, string>)[key];
			if (typeof value !== "string") return key;
			return value.replace(/\{\{(\w+)\}\}/g, (_: string, k: string) => vars?.[k] ?? "");
		},
	}),
	initReactI18next: { type: "3rdParty", init: jest.fn() },
}));

jest.mock("@react-navigation/native", () => ({
	useTheme: () => {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const { lightTheme: theme } = require("../../../../theme/themes");
		return theme;
	},
}));

const ANCHOR = {
	networkHash: "hashA",
	name: "Network A",
	genesis: { userId: "user-1", signerKey: "key-1", authorityId: "auth", adminEffectiveAt: "2026-10-12T10:00:00" },
	digest: "F7BlCC_VqrIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
	fingerprint: "17b0 6508 2fd5 aab2",
};
const mockOpen = jest.fn(async () => ({}));
const mockGetFoundingAnchor = jest.fn(async () => ANCHOR);
jest.mock("../../../../providers/AppProvider", () => ({
	useApp: () => ({ networksEngine: { open: mockOpen, getFoundingAnchor: mockGetFoundingAnchor } }),
}));

const mockNodeState: { owners: Set<string>; node: unknown; seeded: boolean } = { owners: new Set(), node: null, seeded: false };
function makeNode() {
	return {
		peerId: { toString: () => "self-peer" },
		getIdentityOwnerKey: () => ({ publicKeyB64: "self-pub", privateKeyB64: "self-priv" }),
		getSeedBootstrapService: () => ({ canAuthorize: () => mockNodeState.seeded }),
		getControlDatabase: () => ({
			queryCadrePeers: async () => [],
			getOwnerKeys: async () => new Set(mockNodeState.owners),
			ensureOwnerKey: jest.fn(async (key: string) => {
				mockNodeState.owners.add(key);
				return true;
			}),
		}),
		trustOwnerKeys: jest.fn(async () => undefined),
		initializeSeedBootstrap: jest.fn(async () => {
			mockNodeState.seeded = true;
		}),
		createCadreInvitation: jest.fn(async () => ({ encoded: "encoded-invitation", invitation: { invite: { expiresAt: "2026-11-11T11:26:21.316" } } })),
	};
}
jest.mock("../../../../providers/CadreNodeProvider", () => ({
	useCadreNode: () => ({ node: mockNodeState.node }),
}));
jest.mock("../../../../engines/device-user", () => ({
	getDeviceUser: async () => ({ id: "user-1", name: "O", activeKeys: [{ key: "key-1", type: "ed25519" }] }),
}));
const mockCopy = jest.fn(async () => true);
jest.mock("../../../../utils/copyToClipboard", () => ({ copyToClipboard: (...a: unknown[]) => mockCopy(...(a as [])) }));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { VoterInviteCard } = require("../VoterInviteCard");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Share } = require("react-native");

const T = resources.en.translation;
const REF = { hash: "hashA", name: "Network A", relays: [], primaryAuthorityDomainName: "a.example" };

async function flush() {
	for (let i = 0; i < 12; i++) {
		// eslint-disable-next-line no-await-in-loop
		await act(async () => {
			await Promise.resolve();
		});
	}
}
async function render(onClose = jest.fn()) {
	let tr!: renderer.ReactTestRenderer;
	await act(async () => {
		tr = renderer.create(<VoterInviteCard networkRef={REF} onClose={onClose} />);
	});
	await flush();
	return tr;
}
const byId = (tr: renderer.ReactTestRenderer, id: string) => tr.root.find((n) => n.props.testID === id);
const hasId = (tr: renderer.ReactTestRenderer, id: string) => tr.root.findAll((n) => n.props.testID === id).length > 0;
const textOf = (node: renderer.ReactTestInstance) =>
	node.findAll((n) => typeof n.props.children === "string").map((n) => n.props.children).join(" ");

beforeEach(() => {
	mockNodeState.owners = new Set();
	mockNodeState.seeded = false;
	mockNodeState.node = makeNode();
	mockOpen.mockClear();
	mockGetFoundingAnchor.mockClear();
	mockCopy.mockClear();
});

describe("VoterInviteCard", () => {
	it("on this phone's own cadre: generates at once and shows the fingerprint, the expiry and the code", async () => {
		mockNodeState.owners = new Set(["self-pub"]);
		const tr = await render();
		expect(hasId(tr, "voter-invite-body-ready")).toBe(true);
		expect(byId(tr, "voter-invite-fingerprint").props.children).toBe("17b0 6508 2fd5 aab2");
		expect(hasId(tr, "voter-invite-expiry")).toBe(true);
		const code = byId(tr, "voter-invite-code").props.children as string;
		const decoded = decodeNetworkJoinCode(code);
		expect(decoded.ok && decoded.code.invitation).toBe("encoded-invitation");
		expect(mockOpen).toHaveBeenCalledWith(REF, expect.objectContaining({ id: "user-1" }), false);
		expect(mockGetFoundingAnchor).toHaveBeenCalledWith("hashA", { userId: "user-1", signerKey: "key-1" });
	});

	it("an ownerless cadre asks first, and only a confirm makes this phone the owner", async () => {
		const node = mockNodeState.node as ReturnType<typeof makeNode>;
		const tr = await render();
		expect(hasId(tr, "voter-invite-body-confirm-owner")).toBe(true);
		expect(textOf(byId(tr, "voter-invite-body-confirm-owner"))).toContain(T.voterInviteOwnerTitle);
		expect(node.trustOwnerKeys).not.toHaveBeenCalled();
		expect(node.createCadreInvitation).not.toHaveBeenCalled();

		await act(async () => {
			await byId(tr, "voter-invite-owner-confirm").props.onPress();
		});
		await flush();
		expect(node.trustOwnerKeys).toHaveBeenCalledWith(["self-pub"], "operator");
		expect(node.initializeSeedBootstrap).toHaveBeenCalledWith("self-priv");
		expect(hasId(tr, "voter-invite-body-ready")).toBe(true);
	});

	it("Cancel on the owner question closes without any change", async () => {
		const onClose = jest.fn();
		const node = mockNodeState.node as ReturnType<typeof makeNode>;
		const tr = await render(onClose);
		act(() => {
			byId(tr, "voter-invite-cancel").props.onPress();
		});
		expect(onClose).toHaveBeenCalled();
		expect(node.trustOwnerKeys).not.toHaveBeenCalled();
	});

	it("a cadre someone else owns: explains that the owner device must invite", async () => {
		mockNodeState.owners = new Set(["drone-owner"]);
		const tr = await render();
		expect(textOf(byId(tr, "voter-invite-body-not-owner"))).toContain(T.voterInviteNotOwner);
	});

	it("a failure shows translated copy only, and Try again regenerates", async () => {
		mockNodeState.owners = new Set(["self-pub"]);
		mockGetFoundingAnchor.mockImplementationOnce(async () => {
			throw new Error("RAW ENGINE TEXT");
		});
		const tr = await render();
		const body = byId(tr, "voter-invite-body-error");
		expect(textOf(body)).toContain(T.voterInviteFailed);
		expect(textOf(body)).not.toContain("RAW ENGINE TEXT");
		await act(async () => {
			await byId(tr, "voter-invite-retry").props.onPress();
		});
		await flush();
		expect(hasId(tr, "voter-invite-body-ready")).toBe(true);
	});

	it("Copy puts the code on the clipboard and confirms; Share sends name, fingerprint and code", async () => {
		mockNodeState.owners = new Set(["self-pub"]);
		const shareSpy = jest.spyOn(Share, "share").mockResolvedValue({ action: "sharedAction" });
		const tr = await render();
		const code = byId(tr, "voter-invite-code").props.children as string;
		await act(async () => {
			byId(tr, "voter-invite-copy").props.onPress();
		});
		await flush();
		expect(mockCopy).toHaveBeenCalledWith(code);
		expect(byId(tr, "voter-invite-copy-notice").props.children).toBe(T.voterInviteCopied);
		await act(async () => {
			byId(tr, "voter-invite-share").props.onPress();
		});
		const message = (shareSpy.mock.calls[0]![0] as { message: string }).message;
		expect(message).toContain("Network A");
		expect(message).toContain("17b0 6508 2fd5 aab2");
		expect(message).toContain(code);
		shareSpy.mockRestore();
	});

	it("no node yet: an error, not a hang", async () => {
		mockNodeState.node = null;
		const tr = await render();
		expect(hasId(tr, "voter-invite-body-error")).toBe(true);
	});
});
