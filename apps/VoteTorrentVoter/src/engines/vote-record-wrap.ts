/**
 * vote-record-wrap.ts - Voter `VoteRecordWrapProvider` seam (D-13, D-29, Phase 63 plan 07).
 *
 * This alias protects the vote record's data key. It is the opposite policy of the D-42 identity
 * alias (device-key-wrap.ts): `requireAuth: true` on every wrap and unwrap, so viewing saved
 * choices needs a fingerprint.
 *
 * Android uses a time-bound key (D-14): `VOTE_RECORD_AUTH_WINDOW_SECONDS` is passed only through
 * `voteRecordWrapOptions`, on wrap and on unwrap. If the vote-signing prompt opens the window,
 * Submit costs one prompt; otherwise two, which is an accepted D-14 outcome. Opening a saved receipt
 * after the window lapses prompts once (D-13). iOS ignores the window and stays per-use. The R-5
 * fallback to per-use is the constant set to 0, with no native change.
 *
 * One alias means one policy forever, fixed at key creation. V1 has never shipped, so it adopted
 * the windowed policy.
 *
 * Never reuse the identity alias or its provider.
 */

import {
	createNativeSecretWrapper,
	SecretWrapError,
	type SecretWrapOptions,
	type SecretWrapPrompt,
	type SecretWrapper,
	type WrappedSecret,
} from '@votetorrent/attestation-native'

export const VOTETORRENT_VOTE_RECORD_WRAP_KEY_V1 = 'VOTETORRENT_VOTE_RECORD_WRAP_KEY_V1'

export interface VoteRecordWrapProvider {
	wrap(plaintext: Uint8Array, aad: Uint8Array, prompt: SecretWrapPrompt): Promise<WrappedSecret>
	unwrap(wrapped: WrappedSecret, aad: Uint8Array, prompt: SecretWrapPrompt): Promise<Uint8Array>
}

/**
 * D-14 / R-5: the auth window, in seconds, of the vote-record wrap key. D-14's aim is one prompt at
 * Submit and its accepted worst case is two. A 10 s window lets the vote-signing prompt authorise
 * the seal that follows it within a fraction of a second. It is no longer, to keep the "view the
 * saved choices without a prompt right after Submit" gap (R-4) narrow.
 *
 * R-5 decision rule, applied by the device proof (63-18) after it counts the prompts at Submit:
 * - 1 prompt: keep this at 10 and record "one prompt".
 * - 2 prompts, or the windowed path is unstable on device: flip this to 0 and record "two prompts".
 *   0 restores per-use with ZERO native change, because the per-use native path is untouched. A
 *   window that saves no prompt buys nothing and still carries the 10 s residual, so per-use is then
 *   strictly better. Both outcomes satisfy D-14.
 *
 * V1 alias hazard: this value is part of `VOTETORRENT_VOTE_RECORD_WRAP_KEY_V1`'s fixed policy. An
 * install that created V1 under another value gets `WRAP_KEY_POLICY_MISMATCH`, which the vault maps
 * to `policy-mismatch`. The proof therefore runs `pm clear` first, and again after any flip, then
 * re-grants ACCESS_LOCAL_NETWORK. Once a build carrying V1 ships, a change needs a new
 * `VOTETORRENT_VOTE_RECORD_WRAP_KEY_V2` alias; it never deletes V1.
 *
 * iOS ignores the value and stays per-use.
 */
export const VOTE_RECORD_AUTH_WINDOW_SECONDS = 10

/**
 * The ONLY place the vote alias's wrap options are built. Every vote-record wrap and unwrap is
 * auth-required, with the D-14 window.
 */
export function voteRecordWrapOptions(aad: Uint8Array, prompt: SecretWrapPrompt): SecretWrapOptions {
	return { requireAuth: true, aad, prompt, authWindowSeconds: VOTE_RECORD_AUTH_WINDOW_SECONDS }
}

export function createVoteRecordWrapProvider(wrapper: SecretWrapper): VoteRecordWrapProvider {
	return {
		async wrap(plaintext, aad, prompt) {
			return wrapper.wrapSecret(VOTETORRENT_VOTE_RECORD_WRAP_KEY_V1, plaintext, voteRecordWrapOptions(aad, prompt))
		},
		async unwrap(wrapped, aad, prompt) {
			// Downgrade guard: a tampered envelope must never steer the unwrap to another alias
			// (for example the no-auth identity alias).
			if (wrapped.keyAlias !== VOTETORRENT_VOTE_RECORD_WRAP_KEY_V1) {
				throw new SecretWrapError('INVALID_ARGUMENT', 'vote record wrapped key names an unexpected alias')
			}
			return wrapper.unwrapSecret(wrapped, voteRecordWrapOptions(aad, prompt))
		},
	}
}

export function createNativeVoteRecordWrapProvider(): VoteRecordWrapProvider {
	return createVoteRecordWrapProvider(createNativeSecretWrapper())
}

let testOverride: VoteRecordWrapProvider | undefined
let nativeProvider: VoteRecordWrapProvider | undefined

/** The jest override if installed, otherwise a lazily constructed, memoised native provider. */
export function resolveVoteRecordWrapProvider(): VoteRecordWrapProvider {
	if (testOverride !== undefined) return testOverride
	if (!nativeProvider) nativeProvider = createNativeVoteRecordWrapProvider()
	return nativeProvider
}

/**
 * TEST ONLY. Sets or clears the override `resolveVoteRecordWrapProvider` returns. Production code
 * must never call this: the setter-reference gate in vote-record-wrap.test.ts enforces that only
 * this file references it outside test files.
 */
export function setVoteRecordWrapProviderForTests(provider: VoteRecordWrapProvider | undefined): void {
	testOverride = provider
}
