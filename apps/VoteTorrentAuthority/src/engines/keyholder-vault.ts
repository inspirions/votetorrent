/**
 * keyholder-vault.ts — Phase 62 Plan 26 (D-16). The auth-required `IKeyVault` every keyholder
 * secret in this app lives in.
 *
 * Four points:
 *  1. The wrap alias below follows 62-08's `VOTETORRENT_<APP>_<PURPOSE>_WRAP_KEY_V<n>` naming rule
 *     and is `requireAuth: true`, forever — one alias is one fixed auth policy (62-08's
 *     `WRAP_KEY_POLICY_MISMATCH` enforces this natively and in `key-vault.ts`'s own construction
 *     check). It is never reused for a `requireUserAuth: false` secret.
 *  2. Every keyholder secret this app ever holds is wrapped under this ONE alias: the fresh
 *     signing key and DKG receiving key minted at accept (`keyholder-identity.ts`), 62-17's
 *     in-progress round secrets, and the final share (`keyholderDkgShareAlias`). D-16: a device
 *     holds only ITS OWN share — nothing in this app ever reconstructs the joint election key or
 *     a group secret.
 *  3. This file never edits `./key-vault.ts` — 62-21's `createAuthorityKeyVault` exposes the
 *     `authRequiredWrap` injection seam exactly so a consumer like this one can add a new
 *     auth-required alias without touching that file.
 *  4. 62-08's native wrap on iOS is a Keychain AES key, NOT Secure Enclave-backed. Hardware
 *     behaviour (both platforms), the BiometricPrompt/LAContext prompt itself, and biometric
 *     re-enrolment invalidation are code-complete and unverified on real hardware (D-23) — carried
 *     to 62-30.
 */

import type { IKeyVault } from '@votetorrent/vote-engine/rn';
import type { SecretWrapPrompt } from '@votetorrent/attestation-native';
import i18n from '../i18n';
import { createAuthorityKeyVault } from './key-vault';

/** requireAuth true, forever — point 1 above. */
export const VOTETORRENT_AUTHORITY_KEYHOLDER_SHARE_WRAP_KEY_V1 = 'VOTETORRENT_AUTHORITY_KEYHOLDER_SHARE_WRAP_KEY_V1';

/** Resolved fresh on every wrap/unwrap call (never cached), so a locale change between calls is
 * honored. Reuses the existing `deviceSigningPrompt*` catalog keys (same biometric-confirmation
 * copy every other auth-required prompt in this app uses). */
export function keyholderVaultPrompt(): SecretWrapPrompt {
	return {
		title: i18n.t('deviceSigningPromptTitle'),
		subtitle: i18n.t('deviceSigningPromptSubtitle'),
		negativeButton: i18n.t('deviceSigningPromptNegativeButton'),
	};
}

let defaultVault: IKeyVault | undefined;
let testOverride: IKeyVault | undefined;

/** Test override: `undefined` restores the lazy default (built once, on first use after the
 * override is cleared). */
export function setKeyholderKeyVaultForTests(vault: IKeyVault | undefined): void {
	testOverride = vault;
}

/** The test override if set, else a lazily-built singleton over 62-21's `createAuthorityKeyVault`
 * with this file's auth-required alias injected through the `authRequiredWrap` seam (point 3
 * above). The SAME vault instance also serves 62-21's `requireUserAuth: false` officer-encryption
 * secrets — one vault, two policies, each bound to its own alias. */
export function resolveKeyholderKeyVault(): IKeyVault {
	if (testOverride !== undefined) return testOverride;
	if (defaultVault === undefined) {
		defaultVault = createAuthorityKeyVault({
			authRequiredWrap: { keyAlias: VOTETORRENT_AUTHORITY_KEYHOLDER_SHARE_WRAP_KEY_V1, prompt: keyholderVaultPrompt },
		});
	}
	return defaultVault;
}
