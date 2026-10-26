/**
 * voter-invite (spike 100): who may mint a voter join code, the owner setup a founder needs, and
 * the code itself. The real CadreNode path (owner setup AFTER the network and strand exist, then a
 * voter joining with the code) is proven on the host by
 * `.planning/spikes/100-voter-joins-authority-network/product-join.ts` OWNER_LATE=1.
 */
import { decodeNetworkJoinCode } from "@votetorrent/vote-engine/rn";
import { JOIN_CODE_FIXTURES, type JoinCodeFixtureName } from "@votetorrent/vote-engine/test/fixtures/join-code-fixtures";
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

/** The real cadre-core mint inside a real-encoder fixture (a `sereus-invite:1.` string). */
function fixtureMint(name: JoinCodeFixtureName): string {
	const d = decodeNetworkJoinCode(JOIN_CODE_FIXTURES[name].text);
	if (!d.ok) throw new Error("fixture did not decode");
	return d.code.invitation;
}
function fixtureAnchor(name: JoinCodeFixtureName) {
	const d = decodeNetworkJoinCode(JOIN_CODE_FIXTURES[name].text);
	if (!d.ok) throw new Error("fixture did not decode");
	const { networkHash, name: networkName, genesis, digest } = d.code;
	return { networkHash, name: networkName, genesis, digest, fingerprint: d.fingerprint };
}
const MINT = fixtureMint("v2-1-member");

/** Count the 16-char windows of `secret` that occur in `haystack`. */
function windowHits(haystack: string, secret: string): number {
	let hits = 0;
	for (let i = 0; i + 16 <= secret.length; i++) if (haystack.includes(secret.slice(i, i + 16))) hits++;
	return hits;
}

type SelfRow = { peerId: string; vouchSig: string | null; vouchUsage: string | null };

function fakeNode(
	owners: string[],
	opts: { invitation?: string; identityThrows?: boolean; noDb?: boolean; selfRow?: SelfRow; peersThrow?: boolean; noPeerId?: boolean; alreadyWired?: boolean } = {},
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
		createCadreInvitation: jest.fn(async () => ({ encoded: opts.invitation ?? MINT, invitation: { invite: { expiresAt: "2026-11-11T11:26:21.316" } } })),
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
		expect(node.createCadreInvitation).toHaveBeenCalledWith({ uses: VOTER_INVITE_USES, expiresInMs: VOTER_INVITE_LIFETIME_MS });
		expect(result).toMatchObject({ fingerprint: ANCHOR.fingerprint, expiresAt: "2026-11-11T11:26:21.316", networkName: ANCHOR.name });
		const decoded = decodeNetworkJoinCode(result.code);
		expect(decoded.ok).toBe(true);
		expect(decoded.ok && decoded.code.v === 2).toBe(true);
		expect(decoded.ok && decoded.fingerprint === ANCHOR.fingerprint).toBe(true);
		expect(decoded.ok && decoded.code.invitation === MINT).toBe(true);
		expect(decoded.ok && decoded.code.networkHash === ANCHOR.networkHash && decoded.code.name === ANCHOR.name && decoded.code.digest === ANCHOR.digest).toBe(true);
		expect(decoded.ok && JSON.stringify(decoded.code.genesis) === JSON.stringify(ANCHOR.genesis)).toBe(true);
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

describe("createVoterJoinCode emits vtjoin2. (D-01)", () => {
	const mint = (name: JoinCodeFixtureName, anchorName?: string) => {
		const anchor = fixtureAnchor(name);
		const { node } = fakeNode([SELF.publicKeyB64], { invitation: fixtureMint(name) });
		return createVoterJoinCode({
			node,
			networksEngine: { getFoundingAnchor: jest.fn(async () => (anchorName === undefined ? anchor : { ...anchor, name: anchorName })) },
			networkHash: anchor.networkHash,
			founder: { userId: "officer", signerKey: "officer-key" },
		});
	};

	it.each(["v2-1-member", "v2-6-members", "v2-non-ascii-name"] as const)("%s: the minted code is byte-identical to the real-encoder fixture", async (name) => {
		const result = await mint(name);
		expect(result.code.startsWith("vtjoin2.")).toBe(true);
		const decoded = decodeNetworkJoinCode(result.code);
		expect(decoded.ok && decoded.code.v === 2).toBe(true);
		expect(result.code === JOIN_CODE_FIXTURES[name].text).toBe(true);
	});

	it("a mint that is not a sereus invitation rejects without echoing the anchor or the mint", async () => {
		const { node } = fakeNode([SELF.publicKeyB64], { invitation: "encoded-invitation" });
		let thrown = "";
		try {
			await createVoterJoinCode({
				node,
				networksEngine: { getFoundingAnchor: jest.fn(async () => ANCHOR) },
				networkHash: ANCHOR.networkHash,
				founder: { userId: "officer", signerKey: "officer-key" },
			});
		} catch (err) {
			thrown = String(err);
		}
		expect(thrown).not.toBe("");
		expect(windowHits(thrown, "encoded-invitation")).toBe(0);
		expect(windowHits(thrown, ANCHOR.digest)).toBe(0);
		// Non-vacuous: the same anchor with a real mint resolves.
		const ok = await createVoterJoinCode({
			node: fakeNode([SELF.publicKeyB64]).node,
			networksEngine: { getFoundingAnchor: jest.fn(async () => ANCHOR) },
			networkHash: ANCHOR.networkHash,
			founder: { userId: "officer", signerKey: "officer-key" },
		});
		expect(ok.code.startsWith("vtjoin2.")).toBe(true);
	});

	it("a name that pushes the code past 4096 chars rejects with no window of the code, mint or name in the error", async () => {
		const name = "v2-6-members";
		const long = "\u00e9".repeat(256);
		await expect(mint(name)).resolves.toMatchObject({ fingerprint: JOIN_CODE_FIXTURES[name].fingerprint });
		let text = "";
		try {
			await mint(name, long);
		} catch (err) {
			text = String(err);
		}
		expect(text).not.toBe("");
		expect(windowHits(text, JOIN_CODE_FIXTURES[name].text)).toBe(0);
		expect(windowHits(text, fixtureMint(name))).toBe(0);
		expect(windowHits(text, long)).toBe(0);
	});
});

describe("inviteExpiryMs", () => {
	it("reads cadre-core's zone-less datetime as UTC", () => {
		expect(inviteExpiryMs("2026-11-11T11:26:21.316")).toBe(Date.parse("2026-11-11T11:26:21.316Z"));
		expect(inviteExpiryMs(null)).toBeNull();
		expect(inviteExpiryMs("later")).toBeNull();
	});
});
