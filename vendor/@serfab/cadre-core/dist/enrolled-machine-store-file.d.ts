import type { EnrolledMachineStore } from './enrolled-machine-store.js';
/**
 * File-backed {@link EnrolledMachineStore}. Open via {@link open}, which loads the
 * existing file and returns the cross-platform store over it. An absent, corrupt,
 * wrong-party, junk-valued **or unreadable** file is a cold start (`count()` is
 * `undefined`, the node declares no repair yardstick and runs at the base control
 * policy) — `open` never rejects, unlike the sibling stores' file backends. That
 * divergence and its reasoning live on `enrolled-machine-store.ts`.
 */
export declare const FileEnrolledMachineStore: {
    /** Load (or cold-start) the party's last recorded machine count from a file in `dir`. */
    open(dir: string, partyId: string): Promise<EnrolledMachineStore>;
};
