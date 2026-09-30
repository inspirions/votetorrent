/**
 * Backend-agnostic store for raw private key material.
 *
 * Mobile cadre nodes hold sensitive key material at rest: the libp2p
 * peer/node identity key and (in the single-key reference model) the owner
 * signing key derived from it. This module defines the seam those keys flow
 * through so a platform-secure backend (iOS Keychain / Android Keystore) can be
 * plugged in without `@serfab/cadre-core` taking any platform dependency.
 *
 * This file is dependency-free (no node:/RN imports) so it is safe in every
 * entry graph. The Node reference {@link FileKeyStore} lives in a separate
 * subpath module (`./key-store-file.js`) so its `node:fs` import never lands in
 * the cross-platform default entry.
 */
/**
 * Default slot id for the node identity key. `CadreNode` reads/persists its
 * libp2p identity here when a {@link KeyStore} is configured without an explicit
 * `identityKeyId`.
 */
export const DEFAULT_IDENTITY_KEY_ID = 'cadre/identity';
/**
 * Thrown by {@link KeyStore.get} when access was denied or could not be
 * satisfied (e.g. a biometric/device-unlock prompt was cancelled or failed).
 * Distinguishes "access refused" from "slot empty" (which is a plain `undefined`
 * return). Biometric gating itself is out of scope here, but `get` rejecting
 * with this error is the contract a gated backend uses, so callers must not
 * treat it as "no key" (which would trigger key regeneration and silent
 * identity loss).
 *
 * Carries only the {@link keyId} — never key material — so it is safe to log.
 */
export class KeyStoreAccessError extends Error {
    constructor(keyId, message, options) {
        super(message, options);
        this.name = 'KeyStoreAccessError';
        this.keyId = keyId;
    }
}
/**
 * In-memory {@link KeyStore} backed by a `Map`. For tests and ephemeral nodes;
 * nothing is persisted across process restarts. Dependency-free, so it is safe
 * in every entry graph.
 *
 * Material is defensively copied on both {@link set} and {@link get} so a caller
 * mutating its own buffer cannot alter stored state (and vice versa), matching
 * the fresh-buffer semantics a file/keyring backend produces.
 */
export class InMemoryKeyStore {
    constructor() {
        this.slots = new Map();
    }
    async get(keyId) {
        const stored = this.slots.get(keyId);
        return stored ? stored.slice() : undefined;
    }
    async set(keyId, keyMaterial) {
        this.slots.set(keyId, keyMaterial.slice());
    }
    async delete(keyId) {
        this.slots.delete(keyId);
    }
    async list() {
        return [...this.slots.keys()];
    }
}
//# sourceMappingURL=key-store.js.map