import type { StrandPeerBookOptions, StrandPeerBookStore } from './strand-peer-book.js';
/**
 * File-backed {@link StrandPeerBookStore}. Open via {@link open}, which loads the
 * existing file and returns the cross-platform store over it; an absent, corrupt,
 * or wrong-party file is a cold start (empty book) and structurally junk or
 * aged-out entries are dropped, while a present-but-unreadable file throws. Those
 * rules and their reasoning live on `NodeLocalSnapshot.open`.
 */
export declare const FileStrandPeerBookStore: {
    /** Load (or cold-start) the party's strand peer book from a file in `dir`. */
    open(dir: string, partyId: string, options?: StrandPeerBookOptions): Promise<StrandPeerBookStore>;
};
