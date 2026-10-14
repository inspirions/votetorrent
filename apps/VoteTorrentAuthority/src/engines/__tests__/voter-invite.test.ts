/**
 * voter-invite (spike 100): who may mint a voter join code, the owner setup a founder needs, and
 * the code itself. The real CadreNode path (owner setup AFTER the network and strand exist, then a
 * voter joining with the code) is proven on the host by
 * `.planning/spikes/100-voter-joins-authority-network/product-join.ts` OWNER_LATE=1.
 */
import { decodeNetworkJoinCode } from "@votetorrent/vote-engine/rn";
import {
	createVoterJoinCode,
	ensureVoterInviteOwner,
	inviteExpiryMs,
	VOTER_INVITE_LIFETIME_MS,
	VOTER_INVITE_USES,
	voterInviteCapability,
	type VoterInviteNode,
} from "../voter-invite";

const SELF = { publicKeyB64: "self-pub", privateKeyB64: "self-priv" };
const ANCHOR = {
	networkHash: "a1b2c3d4e5f60718",
	name: "Utah County Elections",
	genesis: { userId: "u", signerKey: "k", authorityId: "a", adminEffectiveAt: "2026-10-12T10:00:00" },
	digest: "F7BlCC_VqrIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
	fingerprint: "17b0 6508 2fd5 aab2",
};

type SelfRow = { peerId: string; vouchSig: string | null; vouchUsage: string | null };

function fakeNode(
	owners: string[],
	opts: { identityThrows?: boolean; noDb?: boolean; selfRow?: SelfRow; peersThrow?: boolean; noPeerId?: boolean; alreadyWired?: boolean } = {},
) {
	const state = { owners: new Set(owners), wired: opts.alreadyWired === true };
	const node = {
		...(opts.noPeerId ? {} : { peerId: { toString: () => "self-peer" } }),
		getIdentityOwnerKey: jest.fn(() => {
			if (opts.identityThrows) throw new Error("ephemeral identity");
			return SELF;
		}),
		getControlDatabase: jest.fn(() =>
			opts.noDb
				? null
				: {
						getOwnerKeys: async () => new Set(state.owners),
						ensureOwnerKey: jest.fn(async (key: string) => {
							if (state.owners.size > 0) return false;
							state.owners.add(key);
							return true;
						}),
						queryCadrePeers: jest.fn(async () => {
							if (opts.peersThrow) throw new Error("peers unreadable");
							return opts.selfRow ? [opts.selfRow] : [];
						}),
					},
		),
		trustOwnerKeys: jest.fn(async () => undefined),
		getSeedBootstrapService: jest.fn(() => ({ canAuthorize: () => state.wired })),
		// What cadre-core does on a second wire: libp2p refuses to register /sereus/seed/1.0.0 twice.
		initializeSeedBootstrap: jest.fn(async () => {
			if (state.wired) throw Object.assign(new Error("handler already registered"), { name: "DuplicateProtocolHandlerError" });
			state.wired = true;
		}),
		createCadreInvitation: jest.fn(async () => ({ encoded: "encoded-invitation", invitation: { invite: { expiresAt: "2026-11-11T11:26:21.316" } } })),
	};
	return { node: node as unknown as VoterInviteNode & typeof node, state };
}

const JOINED_ROW: SelfRow = { peerId: "self-peer", vouchSig: null, vouchUsage: "usage-1" };

describe("voterInviteCapability", () => {
	it("a cadre with no owner key needs owner setup", async () => {
		expect(await voterInviteCapability(fakeNode([]).node)).toBe("needs-owner-setup");
	});
	it("this phone's own owner key is ready", async () => {
		expect(await voterInviteCapability(fakeNode([SELF.publicKeyB64]).node)).toBe("ready");
	});
	it("a cadre someone else owns cannot be invited into from this phone", async () => {
		expect(await voterInviteCapability(fakeNode(["drone-owner"]).node)).toBe("not-owner");
	});
	it("a phone admitted to the cadre by invitation, with no owner rows, is never offered owner setup", async () => {
		expect(await voterInviteCapability(fakeNode([], { selfRow: JOINED_ROW }).node)).toBe("not-owner");
	});
	it("an ownerless cadre whose rows lack this phone, or hold it vouched, still needs owner setup", async () => {
		expect(await voterInviteCapability(fakeNode([], { selfRow: { peerId: "someone-else", vouchSig: null, vouchUsage: "u" } }).node)).toBe("needs-owner-setup");
		expect(await voterInviteCapability(fakeNode([], { selfRow: { peerId: "self-peer", vouchSig: "sig", vouchUsage: null } }).node)).toBe("needs-owner-setup");
	});
	it("an unreadable self row or a missing peer id fails closed to unavailable", async () => {
		expect(await voterInviteCapability(fakeNode([], { peersThrow: true }).node)).toBe("unavailable");
		expect(await voterInviteCapability(fakeNode([], { noPeerId: true }).node)).toBe("unavailable");
	});
	it("no node, no control database or an ephemeral identity is unavailable", async () => {
		expect(await voterInviteCapability(null)).toBe("unavailable");
		expect(await voterInviteCapability(fakeNode([], { noDb: true }).node)).toBe("unavailable");
		expect(await voterInviteCapability(fakeNode([], { identityThrows: true }).node)).toBe("unavailable");
	});
});

describe("ensureVoterInviteOwner", () => {
	it("an ownerless cadre: anchors this phone's key, writes the genesis owner row, wires the seed bootstrap", async () => {
		const { node, state } = fakeNode([]);
		await ensureVoterInviteOwner(node);
		expect(node.trustOwnerKeys).toHaveBeenCalledWith([SELF.publicKeyB64], "operator");
		expect([...state.owners]).toEqual([SELF.publicKeyB64]);
		expect(node.initializeSeedBootstrap).toHaveBeenCalledWith(SELF.privateKeyB64);
	});

	it("already the owner: no new owner row, and the seed bootstrap is wired once (canAuthorize guard)", async () => {
		const { node } = fakeNode([SELF.publicKeyB64]);
		await ensureVoterInviteOwner(node);
		await ensureVoterInviteOwner(node);
		expect(node.trustOwnerKeys).not.toHaveBeenCalled();
		expect(node.initializeSeedBootstrap).toHaveBeenCalledTimes(1);
	});

	it("a boot that already wired the seed bootstrap is never wired again", async () => {
		const { node } = fakeNode([SELF.publicKeyB64], { alreadyWired: true });
		await ensureVoterInviteOwner(node);
		expect(node.initializeSeedBootstrap).not.toHaveBeenCalled();
	});

	it("survives the boot wire that cadre-core would punish with DuplicateProtocolHandlerError", async () => {
		const { node } = fakeNode([SELF.publicKeyB64]);
		await node.initializeSeedBootstrap(SELF.privateKeyB64); // the boot wireOwnKeyIfOwner
		await expect(node.initializeSeedBootstrap(SELF.privateKeyB64)).rejects.toMatchObject({ name: "DuplicateProtocolHandlerError" });
		node.initializeSeedBootstrap.mockClear();
		await expect(ensureVoterInviteOwner(node)).resolves.toBeUndefined();
		expect(node.initializeSeedBootstrap).not.toHaveBeenCalled();
	});

	it("refuses owner setup on a phone admitted by invitation, before any write", async () => {
		const { node, state } = fakeNode([], { selfRow: JOINED_ROW });
		await expect(ensureVoterInviteOwner(node)).rejects.toThrow(/joined its cadre by invitation/);
		expect(node.trustOwnerKeys).not.toHaveBeenCalled();
		expect(node.initializeSeedBootstrap).not.toHaveBeenCalled();
		expect(state.owners.size).toBe(0);
	});

	it("an unreadable self row refuses before any write", async () => {
		const { node, state } = fakeNode([], { peersThrow: true });
		await expect(ensureVoterInviteOwner(node)).rejects.toThrow();
		expect(node.trustOwnerKeys).not.toHaveBeenCalled();
		expect(node.initializeSeedBootstrap).not.toHaveBeenCalled();
		expect(state.owners.size).toBe(0);
	});

	it("refuses on a cadre someone else owns", async () => {
		const { node } = fakeNode(["drone-owner"]);
		await expect(ensureVoterInviteOwner(node)).rejects.toThrow("not an owner");
		expect(node.initializeSeedBootstrap).not.toHaveBeenCalled();
	});
});

describe("createVoterJoinCode", () => {
	it("mints an untargeted, multi-use, 30-day invitation and encodes it with the founding anchor", async () => {
		const { node } = fakeNode([SELF.publicKeyB64]);
		const getFoundingAnchor = jest.fn(async () => ANCHOR);
		const result = await createVoterJoinCode({
			node,
			networksEngine: { getFoundingAnchor },
			networkHash: ANCHOR.networkHash,
			founder: { userId: "officer", signerKey: "officer-key" },
		});
		expect(getFoundingAnchor).toHaveBeenCalledWith(ANCHOR.networkHash, { userId: "officer", signerKey: "officer-key" });
		expect(node.createCadreInvitation).toHaveBeenCalledWith({ grantsOwner: false, uses: VOTER_INVITE_USES, expiresInMs: VOTER_INVITE_LIFETIME_MS });
		expect(result).toMatchObject({ fingerprint: ANCHOR.fingerprint, expiresAt: "2026-11-11T11:26:21.316", networkName: ANCHOR.name });
		const decoded = decodeNetworkJoinCode(result.code);
		expect(decoded).toEqual({
			ok: true,
			fingerprint: ANCHOR.fingerprint,
			code: { v: 1, invitation: "encoded-invitation", networkHash: ANCHOR.networkHash, name: ANCHOR.name, genesis: ANCHOR.genesis, digest: ANCHOR.digest },
		});
	});

	it("a network this phone cannot anchor (not its founding officer) fails before any owner change", async () => {
		const { node, state } = fakeNode([]);
		const getFoundingAnchor = jest.fn(async () => {
			throw Object.assign(new Error("not-founding-officer"), { code: "not-founding-officer" });
		});
		await expect(
			createVoterJoinCode({ node, networksEngine: { getFoundingAnchor }, networkHash: "h", founder: { userId: "x", signerKey: "y" } }),
		).rejects.toThrow();
		expect(state.owners.size).toBe(0);
		expect(node.createCadreInvitation).not.toHaveBeenCalled();
	});
});

describe("inviteExpiryMs", () => {
	it("reads cadre-core's zone-less datetime as UTC", () => {
		expect(inviteExpiryMs("2026-11-11T11:26:21.316")).toBe(Date.parse("2026-11-11T11:26:21.316Z"));
		expect(inviteExpiryMs(null)).toBeNull();
		expect(inviteExpiryMs("later")).toBeNull();
	});
});
