import type { BootstrapPeerStore } from './bootstrap-peer-store.js';
/**
 * File-backed {@link BootstrapPeerStore}. Open via {@link open}, which loads the
 * existing file and returns the cross-platform store over it; an absent, corrupt, or wrong-party file is a cold
 * start (empty store) and structurally junk entries are dropped, while a
 * present-but-unreadable file throws. Those rules and their reasoning live on
 * `NodeLocalSnapshot.open` — including the in-process-only write serialisation,
 * which two nodes sharing one directory for one party would defeat.
 */
export declare const FileBootstrapPeerStore: {
    /** Load (or cold-start) the party's retained dial targets from a file in `dir`. */
    open(dir: string, partyId: string): Promise<BootstrapPeerStore>;
};
