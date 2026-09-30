import type { DurableSlot } from './node-local-snapshot.js';
export declare class FileDurableSlot implements DurableSlot {
    private readonly dir;
    private readonly name;
    /** Filename-safe form of the party id, shared by the record and temp paths. */
    private readonly encodedParty;
    constructor(dir: string, name: string, partyId: string);
    /**
     * The record's bytes as text. An absent file (ENOENT — including an absent
     * directory) is `undefined`, a cold start. Every other read failure
     * (EACCES, EISDIR, EIO, …) THROWS, per {@link DurableSlot.load}: the caller
     * must not mistake an unreadable file for an empty one and snapshot-write
     * over it.
     */
    load(): Promise<string | undefined>;
    save(text: string): Promise<void>;
    private filePath;
    /** Sibling temp path for the atomic replace (random component: collide-free). */
    private tempPath;
}
