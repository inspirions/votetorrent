import { type DurableSlot } from './node-local-snapshot.js';
/** How an owner key entered the anchor (out-of-band provenance). */
export type TrustSource = 'genesis' | 'invite' | 'operator';
export interface TrustedOwnerStore {
    /** Party this anchor is scoped to. */
    readonly partyId: string;
    /** Is this ed25519 (base64url) key one of my party's out-of-band-trusted owners? */
    has(ownerKey: string): boolean;
    /**
     * All anchored owner keys (e.g. for seed-trust `knownOwnerKeys`).
     *
     * NOTE: every backend copies into a fresh Set per call (so the result is a
     * snapshot decoupled from later `trust()` calls). Anchors hold a handful of
     * keys and callers are per-seed, so the copy is free today; if a hot path
     * ever calls this per message, prefer `has()` or cache the snapshot.
     */
    all(): ReadonlySet<string>;
    /**
     * Add a key established out of band (genesis self-trust / invite pin /
     * operator pin). Idempotent: re-trusting a known key is a no-op that keeps
     * the original source. Implementations MUST reflect the key in {@link has} /
     * {@link all} synchronously; the returned promise tracks durability only
     * (a persistent backend's write), so a synchronous caller may safely consult
     * the store right after invoking this.
     */
    trust(ownerKey: string, source: TrustSource): Promise<void>;
}
/**
 * Ephemeral in-memory anchor for nodes without durable storage (tests, browser
 * demos, not-yet-persisted mobile). Same contract, no disk: trust established
 * here must be re-supplied (invite / operator pin) on the next process.
 */
export declare class MemoryTrustedOwnerStore implements TrustedOwnerStore {
    readonly partyId: string;
    private readonly keys;
    constructor(partyId: string);
    has(ownerKey: string): boolean;
    all(): ReadonlySet<string>;
    trust(ownerKey: string, source: TrustSource): Promise<void>;
}
/**
 * Durable {@link TrustedOwnerStore} over an app-supplied {@link DurableSlot} —
 * the cross-platform half of every persistent backend (the Node
 * `FileTrustedOwnerStore` is this class over a file slot).
 *
 * Construct via {@link open}. Load and persist policy — what an absent,
 * corrupt, foreign-party or unreadable slot does, and what a failed persist
 * does — is documented once on `NodeLocalSnapshot`; this class only supplies
 * the payload shape and the anchor's whole-record-on-bad-entry policy.
 */
export declare class PersistentTrustedOwnerStore implements TrustedOwnerStore {
    private readonly snapshot;
    private constructor();
    /** Load (or cold-start) the party's anchor from `slot`. */
    static open(slot: DurableSlot, partyId: string): Promise<PersistentTrustedOwnerStore>;
    get partyId(): string;
    has(ownerKey: string): boolean;
    all(): ReadonlySet<string>;
    /**
     * Anchor a key: visible via {@link has} / {@link all} synchronously, then the
     * full snapshot is persisted (see `NodeLocalSnapshot.put`).
     */
    trust(ownerKey: string, source: TrustSource): Promise<void>;
}
