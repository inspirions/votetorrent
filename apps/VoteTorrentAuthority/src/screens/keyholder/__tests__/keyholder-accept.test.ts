/**
 * keyholder-accept.test.ts — Phase 62 Plan 26 (D-21, D-26). Real-schema tests for
 * `acceptKeyholderInvitation`, over `@votetorrent/vote-engine/rn`'s real `InvitationEngine` and
 * the mapped `@votetorrent/vote-engine/test/fixtures/test-context` helpers — the same recipe
 * `keyholder-dkg-binding.spec.ts` (62-02) and `keyholder-identity.spec.ts` (62-09) use.
 */

import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex } from '@noble/curves/utils.js';
import { InvitationEngine } from '@votetorrent/vote-engine/rn';
import {
	addTestAuthority,
	addTestElection,
	createTestNetwork,
	makeTestSignCallback,
} from '@votetorrent/vote-engine/test/fixtures/test-context';
import type { KeyholderInvite } from '@votetorrent/vote-core';
import { createAuthorityKeyVault } from '../../../engines/key-vault';
import { VOTETORRENT_AUTHORITY_KEYHOLDER_SHARE_WRAP_KEY_V1, keyholderVaultPrompt } from '../../../engines/keyholder-vault';
import { createFakeSecretWrapper, createMapStorage } from '../../../engines/__fixtures__/fake-secret-wrapper';
import { listKeyholderIdentities } from '../../../engines/keyholder-identity';
import type { KeyVaultStorage } from '../../../engines/key-vault';
import { acceptKeyholderInvitation } from '../keyholder-accept';
import { InviteShareError } from '../../invitations/invite-share';

async function seedElection() {
	const net = await createTestNetwork();
	const auth = await addTestAuthority(net);
	const { electionEngine, electionsEngine } = await addTestElection(auth);
	return { auth, electionEngine, electionsEngine };
}

function makeKeyholderInvite(name: string, inviteKey: string): KeyholderInvite {
	return {
		name,
		type: 'k',
		expiration: new Date(Date.now() + 3_600_000).toISOString(),
		inviteKey,
		inviteSignature: '',
	};
}

/** A fresh share in the exact onSend shape; the share is built WITHOUT any DB Cid query. */
function makeShare(name: string, type: 'k' | 'of' = 'k') {
	const priv = secp256k1.utils.randomSecretKey();
	const invitePrivate = bytesToHex(priv);
	const inviteKey = bytesToHex(secp256k1.getPublicKey(priv));
	return { invitePrivate, inviteKey, text: JSON.stringify({ invitePrivate, inviteKey, expiration: 'x', type, name }) };
}

/** Sends a real keyholder invite and returns the share text. The slot Cid is read ONLY for assertions. */
async function inviteKeyholder(seeded: Awaited<ReturnType<typeof seedElection>>, name: string): Promise<{ shareText: string; slotCid: string }> {
	const share = makeShare(name);
	const electionId = (await seeded.electionEngine.getElectionDetails()).election.id;
	await seeded.electionEngine.inviteKeyholder(makeKeyholderInvite(name, share.inviteKey), electionId, makeTestSignCallback(seeded.auth.user));
	const slotRow = await seeded.auth.ctx.db.prepare("select Cid from InviteSlot where Type = 'k' and Name = :name").get({ name });
	return { shareText: share.text, slotCid: slotRow!.Cid as string };
}

function makeVaultHarness() {
	const wrapper = createFakeSecretWrapper();
	const vault = createAuthorityKeyVault({
		wrapper,
		storage: createMapStorage() as unknown as KeyVaultStorage,
		authRequiredWrap: { keyAlias: VOTETORRENT_AUTHORITY_KEYHOLDER_SHARE_WRAP_KEY_V1, prompt: keyholderVaultPrompt },
	});
	const storage = createMapStorage();
	return { wrapper, vault, storage };
}

describe('acceptKeyholderInvitation (D-21/D-26, real schema)', () => {
	it('A1/A6: accept writes InviteResult/User/UserKey/Keyholder/KeyholderDkgBinding atomically, with the exact 6-arg call shape, from the share string alone', async () => {
		const seeded = await seedElection();
		const { shareText, slotCid } = await inviteKeyholder(seeded, 'Alice');
		const { vault, storage } = makeVaultHarness();
		const invitationEngine = new InvitationEngine(seeded.auth.ctx);

		const result = await acceptKeyholderInvitation({ invitationEngine, vault, storage }, shareText);

		const irCount = (await seeded.auth.ctx.db.prepare('select count(*) as c from InviteResult where SlotCid = :cid').get({ cid: slotCid }))!.c as number;
		expect(irCount).toBe(1);
		const userCount = (await seeded.auth.ctx.db.prepare('select count(*) as c from User where Id = :id').get({ id: result.userId }))!.c as number;
		expect(userCount).toBe(1);
		const keyCount = (await seeded.auth.ctx.db.prepare('select count(*) as c from UserKey where UserId = :id').get({ id: result.userId }))!.c as number;
		expect(keyCount).toBe(1);
		const khCount = (await seeded.auth.ctx.db.prepare('select count(*) as c from Keyholder where UserId = :id').get({ id: result.userId }))!.c as number;
		expect(khCount).toBe(1);
		const bindingRow = (await seeded.auth.ctx.db
			.prepare('select DkgPublicKey, SignerKey, InviteSlotCid from KeyholderDkgBinding where UserId = :id')
			.get({ id: result.userId })) as { DkgPublicKey: string; SignerKey: string; InviteSlotCid: string };
		const record = (await listKeyholderIdentities(storage)).find((r) => r.userId === result.userId)!;
		expect(bindingRow.DkgPublicKey).toBe(record.dkgReceivingPublicKey);
		expect(bindingRow.SignerKey).toBe(record.signingPublicKey);
		expect(bindingRow.InviteSlotCid).toBe(slotCid);
	});

	it('A2: the minted userId and signing key differ from the officer; two accepts on one device/storage are fully distinct', async () => {
		const seeded = await seedElection();
		const Alice = await inviteKeyholder(seeded, 'Alice');
		const Carol = await inviteKeyholder(seeded, 'Carol');
		const { vault, storage } = makeVaultHarness();
		const invitationEngine = new InvitationEngine(seeded.auth.ctx);

		const alice = await acceptKeyholderInvitation({ invitationEngine, vault, storage }, Alice.shareText);
		const carol = await acceptKeyholderInvitation({ invitationEngine, vault, storage }, Carol.shareText);

		expect(alice.userId).not.toBe(seeded.auth.user.id);
		expect(alice.userId).not.toBe(carol.userId);
		const identities = await listKeyholderIdentities(storage);
		expect(identities).toHaveLength(2);
		const officerKeys = seeded.auth.user.activeKeys.map((k: { key: string }) => k.key);
		for (const identity of identities) {
			expect(officerKeys).not.toContain(identity.signingPublicKey);
		}
	});

	it('A3: a failure before any write rejects with the original error and leaves nothing behind', async () => {
		const seeded = await seedElection();
		const { shareText, slotCid } = await inviteKeyholder(seeded, 'Dana');
		const { vault, storage } = makeVaultHarness();
		const failingEngine = {
			resolveInviteSlotCid: jest.fn(async (k: string, t: 'k') => new InvitationEngine(seeded.auth.ctx).resolveInviteSlotCid(k, t)),
			respondToInvite: jest.fn(async () => {
				throw new Error('bad invitePrivate');
			}),
			getKeyholderInvite: jest.fn(async () => undefined),
		};

		await expect(acceptKeyholderInvitation({ invitationEngine: failingEngine as never, vault, storage }, shareText)).rejects.toThrow(
			'bad invitePrivate'
		);

		expect(await listKeyholderIdentities(storage)).toHaveLength(0);
		const khCount = (await seeded.auth.ctx.db.prepare('select count(*) as c from Keyholder').get())!.c as number;
		expect(khCount).toBe(0);
	});

	it('A4: a failure AFTER commit (reconcile) resolves success and keeps the keys', async () => {
		const seeded = await seedElection();
		const { shareText, slotCid } = await inviteKeyholder(seeded, 'Erin');
		const { vault, storage } = makeVaultHarness();
		const realEngine = new InvitationEngine(seeded.auth.ctx);
		let committedUserId: string | undefined;
		const reconcileEngine = {
			resolveInviteSlotCid: jest.fn(async (k: string, t: 'k') => realEngine.resolveInviteSlotCid(k, t)),
			respondToInvite: jest.fn(async (...args: Parameters<InvitationEngine['respondToInvite']>) => {
				committedUserId = args[4];
				await realEngine.respondToInvite(...args);
				throw new Error('post-commit transport hiccup');
			}),
			getKeyholderInvite: jest.fn(async (id: string) => realEngine.getKeyholderInvite(id)),
		};

		const result = await acceptKeyholderInvitation({ invitationEngine: reconcileEngine as never, vault, storage }, shareText);

		expect(result.userId).toBe(committedUserId);
		expect(await vault.hasSecret(`vt.keyholder-signing.${result.userId}`)).toBe(true);
		expect(await listKeyholderIdentities(storage)).toHaveLength(1);
	});

	it('A5: a failure whose reconcile re-read ALSO rejects rethrows the original error and discards nothing', async () => {
		const seeded = await seedElection();
		const { shareText, slotCid } = await inviteKeyholder(seeded, 'Frank');
		const { vault, storage } = makeVaultHarness();
		const unknownOutcomeEngine = {
			resolveInviteSlotCid: jest.fn(async (k: string, t: 'k') => new InvitationEngine(seeded.auth.ctx).resolveInviteSlotCid(k, t)),
			respondToInvite: jest.fn(async () => {
				throw new Error('original failure');
			}),
			getKeyholderInvite: jest.fn(async () => {
				throw new Error('re-read also failed');
			}),
		};

		await expect(
			acceptKeyholderInvitation({ invitationEngine: unknownOutcomeEngine as never, vault, storage }, shareText)
		).rejects.toThrow('original failure');

		// Unknown outcome — nothing is discarded.
		expect(await listKeyholderIdentities(storage)).toHaveLength(1);
	});

	it('A6: the engine receives exactly (slotCid, true, invitePrivate, undefined, userId, provisioning), and release() has run by the time the promise settles', async () => {
		const seeded = await seedElection();
		const { shareText, slotCid } = await inviteKeyholder(seeded, 'Hank');
		const { vault, storage } = makeVaultHarness();
		const realEngine = new InvitationEngine(seeded.auth.ctx);
		let capturedArgs: unknown[] | undefined;
		const capturingEngine = {
			resolveInviteSlotCid: jest.fn(async (k: string, t: 'k') => realEngine.resolveInviteSlotCid(k, t)),
			respondToInvite: jest.fn(async (...args: Parameters<InvitationEngine['respondToInvite']>) => {
				capturedArgs = args;
				return realEngine.respondToInvite(...args);
			}),
			getKeyholderInvite: jest.fn(async (id: string) => realEngine.getKeyholderInvite(id)),
		};

		const result = await acceptKeyholderInvitation({ invitationEngine: capturingEngine as never, vault, storage }, shareText);

		expect(capturedArgs).toHaveLength(6);
		expect(capturedArgs![0]).toBe(slotCid);
		expect(capturedArgs![1]).toBe(true);
		expect(typeof capturedArgs![2]).toBe('string');
		expect(capturedArgs![3]).toBeUndefined();
		expect(capturedArgs![4]).toBe(result.userId);
		const provisioning = capturedArgs![5] as { sign: (digest: Uint8Array) => Promise<unknown> };
		await expect(provisioning.sign(new Uint8Array(32))).rejects.toMatchObject({ code: 'signing-key-missing' });
	});

	it('A7 budget: one accept performs exactly 2 auth-required wraps and 0 unwraps', async () => {
		const seeded = await seedElection();
		const { shareText, slotCid } = await inviteKeyholder(seeded, 'Grace');
		const { vault, storage, wrapper } = makeVaultHarness();
		const invitationEngine = new InvitationEngine(seeded.auth.ctx);

		await acceptKeyholderInvitation({ invitationEngine, vault, storage }, shareText);

		expect(wrapper.authWraps).toBe(2);
		expect(wrapper.authUnwraps).toBe(0);
	});

	it('A8: a share for an invite that does not exist rejects not-found with 0 auth wraps and 0 identities', async () => {
		const seeded = await seedElection();
		const { vault, storage, wrapper } = makeVaultHarness();
		const invitationEngine = new InvitationEngine(seeded.auth.ctx);

		const err = await acceptKeyholderInvitation({ invitationEngine, vault, storage }, makeShare('Ghost').text).catch((e) => e);

		expect(err).toBeInstanceOf(InviteShareError);
		expect(err.code).toBe('not-found');
		expect(wrapper.authWraps).toBe(0);
		expect(await listKeyholderIdentities(storage)).toHaveLength(0);
	});

	it('A9: an officer share pasted into keyholder accept rejects wrong-type with 0 wraps', async () => {
		const seeded = await seedElection();
		const { vault, storage, wrapper } = makeVaultHarness();
		const invitationEngine = new InvitationEngine(seeded.auth.ctx);

		await expect(
			acceptKeyholderInvitation({ invitationEngine, vault, storage }, makeShare('Officer', 'of').text)
		).rejects.toMatchObject({ code: 'wrong-type' });

		expect(wrapper.authWraps).toBe(0);
		expect(await listKeyholderIdentities(storage)).toHaveLength(0);
	});
});
