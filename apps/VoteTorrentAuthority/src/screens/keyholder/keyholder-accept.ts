/**
 * keyholder-accept.ts — Phase 62 Plan 26 (D-21, D-26). Orchestrates a keyholder invite accept:
 * provision a fresh identity, pass it to 62-02's `respondToInvite`, and reconcile before ever
 * discarding the provisioned keys.
 *
 * Four points:
 *  1. The provisioning contract (62-02): `respondToInvite`'s sixth argument
 *     (`KeyholderAcceptProvisioning`) carries the fresh identity's public signing key, its DKG
 *     public key and a `sign` callback. The engine signs the binding digest through that callback
 *     BEFORE opening its accept transaction, and writes `InviteResult`, `User`, `UserKey`,
 *     `Keyholder` and `KeyholderDkgBinding` together, in one commit.
 *  2. `invokedId` (the engine's fifth argument) is the APP-MINTED userId from
 *     `provisionKeyholderIdentity` — never the officer's own id. Passing the officer's id collides
 *     on the `User` primary key and the whole accept rejects (D-21: the officer's device key is
 *     never used for a keyholder accept).
 *  3. The reconcile rule: on an error from `respondToInvite`, re-read the invite. If it shows this
 *     accept actually committed (an orphaned-keys-committed-keyholder race), the keys are KEPT and
 *     this call reports success — never orphan a committed keyholder without its keys. If the
 *     re-read shows no commit, the freshly-minted keys are inert (never bound to a Keyholder row)
 *     and are discarded. If the re-read itself fails, the outcome is UNKNOWN — discard nothing,
 *     and rethrow the original error (the keys might belong to a keyholder that did commit).
 *  4. D-21: every accept provisions a brand-new identity; this module never touches the officer's
 *     device signing key.
 *  5. The slot Cid is resolved from the pasted share (by InviteKey + Type) BEFORE provisioning, so an
 *     unknown, malformed or wrong-type invite costs zero auth wraps (zero biometric prompts) and
 *     leaves zero identities (UAT 62 test 10).
 */

import type { IInvitationEngine } from '@votetorrent/vote-core';
import type { IKeyVault } from '@votetorrent/vote-engine/rn';
import { discardKeyholderIdentity, provisionKeyholderIdentity } from '../../engines/keyholder-identity';
import type { KeyVaultStorage } from '../../engines/key-vault';
import { resolveInviteFromShare } from '../invitations/invite-share';

export interface KeyholderAcceptDeps {
	invitationEngine: IInvitationEngine;
	vault: IKeyVault;
	storage?: KeyVaultStorage;
}

export async function acceptKeyholderInvitation(
	deps: KeyholderAcceptDeps,
	shareText: string
): Promise<{ userId: string; slotCid: string }> {
	// Step 0: resolve and validate the slot BEFORE any identity is provisioned (zero prompts on failure).
	const { slotCid, invitePrivate } = await resolveInviteFromShare(deps.invitationEngine, shareText, 'k');
	const identity = await provisionKeyholderIdentity({ vault: deps.vault, storage: deps.storage }, slotCid);

	try {
		try {
			await deps.invitationEngine.respondToInvite(slotCid, true, invitePrivate, undefined, identity.userId, identity.provisioning);
			return { userId: identity.userId, slotCid };
		} catch (originalError) {
			let reread: Awaited<ReturnType<IInvitationEngine['getKeyholderInvite']>>;
			try {
				reread = await deps.invitationEngine.getKeyholderInvite(slotCid);
			} catch {
				// The outcome is UNKNOWN — the keys might belong to a keyholder that DID commit.
				// Discard nothing; surface the original error.
				throw originalError;
			}
			if (reread?.result?.isAccepted === true && reread.result.invokedId === identity.userId) {
				// The accept actually committed despite the thrown error — never orphan a
				// committed keyholder's keys.
				return { userId: identity.userId, slotCid };
			}
			await discardKeyholderIdentity({ vault: deps.vault, storage: deps.storage }, identity.userId).catch(() => undefined);
			throw originalError;
		}
	} finally {
		identity.release();
	}
}
