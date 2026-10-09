/**
 * fake-secret-wrapper.ts — Phase 62 Plan 26 (D-16/D-21). JEST-ONLY test fixture, never imported by
 * non-test code (enforced by an acceptance grep). Copies 62-21's `key-vault.test.ts` test-local fake
 * `SecretWrapper` semantics into a shared fixture so Task 1's `keyholder-vault.ts` and
 * `keyholder-identity.ts` tests, Task 2's `keyholder-accept.ts` tests and Task 3's
 * `keyholder-dkg-driver.ts` tests all exercise the SAME fake wrap/unwrap behavior.
 */

import type { SecretWrapOptions, SecretWrapper, SecretWrapPrompt, WrappedSecret } from '@votetorrent/attestation-native';

export interface FakeWrapCall {
	op: 'wrap' | 'unwrap';
	keyAlias: string;
	requireAuth: boolean;
	aadHex: string;
	prompt?: SecretWrapPrompt;
}

export interface FakeSecretWrapper extends SecretWrapper {
	readonly wrapCalls: number;
	readonly unwrapCalls: number;
	/** Wrap/unwrap calls whose `options.requireAuth` was `true`. */
	readonly authWraps: number;
	readonly authUnwraps: number;
	readonly calls: FakeWrapCall[];
}

export interface FakeSecretWrapperOptions {
	/** 1-based: the n-th `wrapSecret` call throws code 'WRAP_FAILED'. */
	failWrapAt?: number;
	/** Every `unwrapSecret` call throws this code. */
	failUnwrapCode?: string;
}

function toHex(bytes: Uint8Array): string {
	let hex = '';
	for (const b of bytes) hex += b.toString(16).padStart(2, '0');
	return hex;
}

/**
 * A fake `SecretWrapper`: an opaque handle is returned as `ciphertextBase64` (a counter-based
 * string, never real base64), keyed in an in-memory `Map`. `unwrapSecret` throws
 * `UNWRAP_TAG_MISMATCH` when the wrapped record's `keyAlias` or AAD does not match the unwrap
 * call's own `keyAlias`/`aad` — mirroring a real AES-GCM tag failure on a mismatched key or AAD.
 */
export function createFakeSecretWrapper(options?: FakeSecretWrapperOptions): FakeSecretWrapper {
	const store = new Map<string, { bytes: Uint8Array; keyAlias: string; aad: Uint8Array }>();
	let counter = 0;
	let wrapCalls = 0;
	let unwrapCalls = 0;
	let authWraps = 0;
	let authUnwraps = 0;
	const calls: FakeWrapCall[] = [];

	const fake: FakeSecretWrapper = {
		get wrapCalls() {
			return wrapCalls;
		},
		get unwrapCalls() {
			return unwrapCalls;
		},
		get authWraps() {
			return authWraps;
		},
		get authUnwraps() {
			return authUnwraps;
		},
		calls,

		async wrapSecret(keyAlias: string, plaintext: Uint8Array, opts: SecretWrapOptions): Promise<WrappedSecret> {
			wrapCalls++;
			if (opts.requireAuth) authWraps++;
			calls.push({ op: 'wrap', keyAlias, requireAuth: opts.requireAuth, aadHex: toHex(opts.aad), prompt: opts.prompt });
			if (options?.failWrapAt !== undefined && wrapCalls === options.failWrapAt) {
				throw Object.assign(new Error('fake wrap failed'), { code: 'WRAP_FAILED' });
			}
			const handle = `fake-h${counter++}`;
			store.set(handle, { bytes: Uint8Array.from(plaintext), keyAlias, aad: Uint8Array.from(opts.aad) });
			return {
				v: 1,
				alg: 'AES-256-GCM',
				keyAlias,
				ivBase64: 'AAAAAAAAAAAAAAAA',
				ciphertextBase64: handle,
				securityLevel: 'test-stub',
			};
		},

		async unwrapSecret(wrapped: WrappedSecret, opts: SecretWrapOptions): Promise<Uint8Array> {
			unwrapCalls++;
			if (opts.requireAuth) authUnwraps++;
			calls.push({ op: 'unwrap', keyAlias: wrapped.keyAlias, requireAuth: opts.requireAuth, aadHex: toHex(opts.aad), prompt: opts.prompt });
			if (options?.failUnwrapCode !== undefined) {
				throw Object.assign(new Error('fake unwrap failed'), { code: options.failUnwrapCode });
			}
			const entry = store.get(wrapped.ciphertextBase64);
			if (!entry) {
				throw Object.assign(new Error('fake: unknown handle'), { code: 'UNWRAP_FAILED' });
			}
			const aadMatches = entry.aad.length === opts.aad.length && entry.aad.every((b, i) => b === opts.aad[i]);
			const aliasMatches = entry.keyAlias === wrapped.keyAlias;
			if (!aadMatches || !aliasMatches) {
				throw Object.assign(new Error('fake: tag mismatch'), { code: 'UNWRAP_TAG_MISMATCH' });
			}
			return Uint8Array.from(entry.bytes);
		},
	};
	return fake;
}

export interface MapStorage {
	getItem(key: string): Promise<string | null>;
	setItem(key: string, value: string): Promise<void>;
	removeItem(key: string): Promise<void>;
	/** Test-only accessor — a live read, not a copy, of the underlying Map's values. */
	values(): string[];
}

/** A `KeyVaultStorage`-shaped fake over a `Map`, with a `values()` accessor for I3's no-plaintext
 * scan. Never imported by non-test code. */
export function createMapStorage(): MapStorage {
	const map = new Map<string, string>();
	return {
		async getItem(key: string): Promise<string | null> {
			return map.has(key) ? map.get(key)! : null;
		},
		async setItem(key: string, value: string): Promise<void> {
			map.set(key, value);
		},
		async removeItem(key: string): Promise<void> {
			map.delete(key);
		},
		values(): string[] {
			return [...map.values()];
		},
	};
}
