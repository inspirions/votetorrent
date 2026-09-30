import type { KeyId, KeyStore } from './key-store.js';
/**
 * File-backed {@link KeyStore}. Each slot is `<dir>/<encoded keyId>.key`
 * containing the raw material bytes. The directory is created lazily on first
 * {@link set}. Suitable for headless Node cadre nodes and tests; for mobile use
 * a platform secure-enclave backend instead.
 */
export declare class FileKeyStore implements KeyStore {
    private readonly dir;
    constructor(dir: string);
    private slotPath;
    /**
     * Sibling path for the temp file written before the atomic rename. The random
     * component makes concurrent {@link set}s to the same slot (and crash-orphaned
     * leftovers) collide-free; it lives in the same directory as the slot so the
     * final {@link rename} stays within one filesystem and is therefore atomic.
     */
    private tempPath;
    get(keyId: KeyId): Promise<Uint8Array | undefined>;
    /**
     * Crash-atomic write: a concurrent reader sees either the complete previous
     * bytes or the complete new bytes, never a torn slot. The new material is
     * written to a sibling temp file, fsync'd, then atomically renamed over the
     * slot (see {@link writeFileAtomically}). A failure at any point removes the
     * temp file and leaves the previous slot untouched.
     */
    set(keyId: KeyId, keyMaterial: Uint8Array): Promise<void>;
    delete(keyId: KeyId): Promise<void>;
    list(): Promise<KeyId[]>;
}
