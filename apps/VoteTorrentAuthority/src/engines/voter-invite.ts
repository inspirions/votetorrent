/**
 * voter-invite.ts — the Authority side of "a voter joins this network" (spike 100).
 *
 * A voter joins with a JOIN CODE: an untargeted, multi-use cadre invitation (cadre-core
 * `createCadreInvitation`) plus the network's founding anchor (`NetworksEngine.getFoundingAnchor`),
 * encoded by vote-engine's `encodeNetworkJoinCode`. The voter's phone redeems the invitation,
 * opens the network's strand and accepts it only when its founding rows hash to the anchor's
 * digest; the fingerprint the officer publishes is derived from that digest.
 *
 * Only a cadre OWNER can mint an invitation. This phone is one when:
 *  - it founded its cadre and set up an owner key (`ready`);
 *  - it founded its cadre WITHOUT one — every Authority phone before this card — (`needs-owner-setup`):
 *    the owner key is set up after an explicit confirm, exactly as the drone and the spike harness
 *    do it (identity owner key → anchor it → genesis `OwnerKey` row → seed bootstrap). Proven AFTER
 *    the network and its strand already exist (spike 100 `product-join.ts` OWNER_LATE=1, 2/2);
 *  - otherwise the cadre has an owner that is not this phone (`not-owner`, e.g. a phone that joined
 *    a drone's cadre): the owner device must invite voters.
 *
 * A phone that joined a cadre BY INVITATION (its own CadrePeer row has no vouch signature but a vouch
 * usage) is never offered owner setup: it must not genesis-insert itself as an owner of someone else's
 * cadre (D-09: pins come only from an invitation or the operator; cadre-core makes the same point at
 * `cadre-node.js` ~l.7155). That predicate mirrors `self-voucher.ts` `isInvitationAdmitted`.
 *
 * Nothing here logs the invitation or the code: the invitation carries its private key, a bearer
 * credential for cadre membership.
 */
import type { CadrePeerRow } from '@serfab/cadre-core';
import type { FoundingAnchor, INetworksEngine } from '@votetorrent/vote-core';

/** How many voters one code admits. A leaked code admits at most this many strangers as cadre members. */
export const VOTER_INVITE_USES = 1000;

/**
 * How long a code stays valid. cadre-core's default for a non-owner invitation is 24 h, far shorter
 * than a registration window; 30 days covers one, and the officer can mint a new code at any time.
 */
export const VOTER_INVITE_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;

/** The slice of a cadre-core `CadreNode` minting needs (the real class satisfies it). */
export interface VoterInviteNode {
	readonly peerId?: { toString(): string };
	getIdentityOwnerKey(): { publicKeyB64: string; privateKeyB64: string };
	getControlDatabase(): {
		getOwnerKeys(): Promise<ReadonlySet<string>>;
		ensureOwnerKey(key: string): Promise<boolean>;
		queryCadrePeers(retry?: boolean): Promise<ReadonlyArray<Pick<CadrePeerRow, 'peerId' | 'vouchSig' | 'vouchUsage'>>>;
	} | null;
	getSeedBootstrapService(): { canAuthorize(): boolean } | null;
	trustOwnerKeys(keys: Iterable<string>, source: 'operator'): Promise<void>;
	initializeSeedBootstrap(ownerPrivateKey: string): Promise<void>;
	createCadreInvitation(options: {
		grantsOwner: boolean;
		uses?: number;
		expiresInMs?: number;
	}): Promise<{ encoded: string; invitation: { invite: { expiresAt: string | null } } }>;
}

export type VoterInviteCapability = 'ready' | 'needs-owner-setup' | 'not-owner' | 'unavailable';

/**
 * Was this phone admitted to the cadre by an invitation? Its own row then has no vouch signature but a
 * vouch usage (the `self-voucher.ts` `isInvitationAdmitted` predicate). Throws when the peer id or the
 * rows cannot be read, so callers fail closed.
 */
async function selfAdmittedByInvitation(
	node: VoterInviteNode,
	db: NonNullable<ReturnType<VoterInviteNode['getControlDatabase']>>,
): Promise<boolean> {
	const self = node.peerId?.toString();
	if (!self) throw new Error('voter-invite: this device has no peer id yet');
	const rows = await db.queryCadrePeers();
	return rows.some((row) => row.peerId === self && row.vouchSig === null && row.vouchUsage != null);
}

/** Can this phone mint voter invitations, and if not, why. Never throws. */
export async function voterInviteCapability(node: VoterInviteNode | null | undefined): Promise<VoterInviteCapability> {
	if (!node) return 'unavailable';
	try {
		const self = node.getIdentityOwnerKey().publicKeyB64;
		const db = node.getControlDatabase();
		if (!db) return 'unavailable';
		const owners = await db.getOwnerKeys();
		if (owners.size === 0) return (await selfAdmittedByInvitation(node, db)) ? 'not-owner' : 'needs-owner-setup';
		return owners.has(self) ? 'ready' : 'not-owner';
	} catch {
		return 'unavailable';
	}
}

/**
 * Make this phone the cadre's owner (only when the cadre has NO owner yet), then wire the seed
 * bootstrap that signs invitations. Idempotent: an existing genesis row is kept (`ensureOwnerKey`
 * returns false).
 *
 * The seed bootstrap is wired only while it cannot authorize. The boot re-anchor
 * (`wireOwnKeyIfOwner`, CadreNodeProvider) already wires it on an owner phone, and a second
 * `initializeSeedBootstrap` re-registers `/sereus/seed/1.0.0`, which libp2p refuses with
 * `DuplicateProtocolHandlerError`. So the guard asks cadre-core instead of keeping per-launch state.
 * A phone admitted by invitation is refused before any write.
 */
export async function ensureVoterInviteOwner(node: VoterInviteNode): Promise<void> {
	const owner = node.getIdentityOwnerKey();
	const db = node.getControlDatabase();
	if (!db) throw new Error('voter-invite: control database unavailable');
	const owners = await db.getOwnerKeys();
	if (owners.size > 0 && !owners.has(owner.publicKeyB64)) {
		throw new Error('voter-invite: this device is not an owner of its cadre');
	}
	if (owners.size === 0) {
		if (await selfAdmittedByInvitation(node, db)) {
			throw new Error('voter-invite: this device joined its cadre by invitation and cannot become its owner');
		}
		await node.trustOwnerKeys([owner.publicKeyB64], 'operator');
		await db.ensureOwnerKey(owner.publicKeyB64);
	}
	if (!node.getSeedBootstrapService()?.canAuthorize()) {
		await node.initializeSeedBootstrap(owner.privateKeyB64);
	}
}

export interface VoterJoinCodeResult {
	readonly code: string;
	readonly fingerprint: string;
	/** cadre-core's T-form UTC datetime (no zone suffix), or null if it never expires. */
	readonly expiresAt: string | null;
	readonly networkName: string;
}

/**
 * Mint an untargeted voter invitation and build the join code for `networkHash`. The network
 * must already be open in `networksEngine`; `founder` is this device's officer (its founding
 * rows select the anchor, exactly as the founding-bundle export does).
 */
export async function createVoterJoinCode(args: {
	node: VoterInviteNode;
	networksEngine: Pick<INetworksEngine, 'getFoundingAnchor'>;
	networkHash: string;
	founder: { userId: string; signerKey: string };
}): Promise<VoterJoinCodeResult> {
	const anchor: FoundingAnchor = await args.networksEngine.getFoundingAnchor(args.networkHash, args.founder);
	await ensureVoterInviteOwner(args.node);
	const minted = await args.node.createCadreInvitation({
		grantsOwner: false,
		uses: VOTER_INVITE_USES,
		expiresInMs: VOTER_INVITE_LIFETIME_MS,
	});
	// Required lazily, like the other engine-only paths in this app: screens import this module, and
	// several screen suites stub vote-core to an empty module that vote-engine's barrel cannot load.
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const { encodeNetworkJoinCode } = require('@votetorrent/vote-engine/rn') as typeof import('@votetorrent/vote-engine/rn');
	const code = encodeNetworkJoinCode({
		v: 2,
		invitation: minted.encoded,
		networkHash: anchor.networkHash,
		name: anchor.name,
		genesis: anchor.genesis,
		digest: anchor.digest,
	});
	return { code, fingerprint: anchor.fingerprint, expiresAt: minted.invitation.invite.expiresAt, networkName: anchor.name };
}

/** cadre-core's zone-less T-form datetime, read as UTC; null when absent or unreadable. */
export function inviteExpiryMs(expiresAt: string | null): number | null {
	if (!expiresAt) return null;
	const ms = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(expiresAt) ? expiresAt : `${expiresAt}Z`);
	return Number.isFinite(ms) ? ms : null;
}
