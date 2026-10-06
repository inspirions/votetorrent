/**
 * vote-record-wrap.ts - Voter `VoteRecordWrapProvider` seam (D-13, D-29, Phase 63 plan 07).
 *
 * This alias protects the vote record's data key. It is the opposite policy of the D-42 identity
 * alias (device-key-wrap.ts): `requireAuth: true` on every wrap and unwrap, so viewing saved
 * choices needs a fingerprint.
 *
 * Today it is per-use. Submit costs two prompts (sign, then seal) and every receipt view costs
 * one. That is already an accepted D-14 outcome.
 *
 * 63-17 adds the named constant `VOTE_RECORD_AUTH_WINDOW_SECONDS` to this file and passes it only
 * through `voteRecordWrapOptions`.
 *
 * One alias means one policy forever, fixed at key creation. V1 has never shipped, so it may
 * adopt the windowed policy.
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
 * The ONLY place the vote alias's wrap options are built. 63-17 turns the key time-bound (D-14)
 * by editing this one return value.
 */
export function voteRecordWrapOptions(aad: Uint8Array, prompt: SecretWrapPrompt): SecretWrapOptions {
	return { requireAuth: true, aad, prompt }
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
