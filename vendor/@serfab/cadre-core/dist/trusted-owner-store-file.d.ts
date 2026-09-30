import type { TrustedOwnerStore } from './trusted-owner-store.js';
/**
 * File-backed {@link TrustedOwnerStore}. Open via {@link open}, which loads the
 * existing file and returns the cross-platform store over it; an absent, corrupt, or wrong-party file is a cold
 * start (empty anchor), while a present-but-unreadable file throws. Those rules
 * and their reasoning live on `NodeLocalSnapshot.open` — they are properties of
 * every persistent backend, not of this one.
 */
export declare const FileTrustedOwnerStore: {
    /** Load (or cold-start) the party's anchor from a file in `dir`. */
    open(dir: string, partyId: string): Promise<TrustedOwnerStore>;
};
