import type { KeyStore } from './key-store.js';
import type { StrandRow } from './types.js';
/** One strand this node joined from ANOTHER party and has not yet published party-wide. */
export interface JoinedStrandRecord {
    /** The strand id (a valid scope key, see storage-scope.ts). */
    Id: string;
    Type: 'o' | 'c';
    /** The closed strand's shared read secret the formation delivered; null for an open strand. */
    MemberPrivateKey: string | null;
    /** Wall-clock ms this node first recorded the join. Diagnostics only. */
    joinedAt: number;
}
export interface JoinedStrandStore {
    /** Party this store is scoped to. */
    readonly partyId: string;
    /** Every remembered join. A call reflects every {@link record}/{@link forget} that resolved before it was made. */
    list(): Promise<JoinedStrandRecord[]>;
    /** Remember a join, REPLACING any record with the same `Id`. */
    record(record: JoinedStrandRecord): Promise<void>;
    /** Forget a join. A no-op when there is no record for `strandId`. */
    forget(strandId: string): Promise<void>;
}
/**
 * The {@link StrandRow} a record stands for — the shape `addStrand` and `strand:discovered`
 * carry. `FounderOwnerKey` is null because a joiner never founds; `CadreNode.launchStrand`
 * reads null as "not mine" and joins.
 */
export declare function joinedStrandRow(record: JoinedStrandRecord): StrandRow;
/**
 * Ephemeral store for a node without a `keyStore`. Warns once, at the first join it is
 * asked to remember, because a join held only here is not re-offered after a restart —
 * exactly the gotchoices/sereus#18 shape, and it should show in a log rather than pass
 * silently.
 */
export declare class MemoryJoinedStrandStore implements JoinedStrandStore {
    readonly partyId: string;
    private readonly records;
    private warned;
    constructor(partyId: string);
    list(): Promise<JoinedStrandRecord[]>;
    record(record: JoinedStrandRecord): Promise<void>;
    forget(strandId: string): Promise<void>;
    private warnOnce;
}
/**
 * Durable store over a {@link KeyStore}: one slot per join, id
 * `cadre/joined-strand/<base64url party id>/<strand id>`, holding the record's UTF-8 JSON.
 * The party segment is base64url for the reason `controlStorageScope` gives: a party id is
 * arbitrary text, and base64url never contains the `/` that ends the segment.
 *
 * Loads every slot once, at the first {@link list}, then answers from memory and writes
 * through, so the strand watcher's five-second poll does not read the enclave on every
 * pass. A load that fails — `KeyStoreAccessError` from a refused unlock prompt, say —
 * is rethrown rather than read as "no joins" and retried at the next call, exactly as
 * `loadOrCreateIdentityKey` treats the identity slot. A slot that does not parse as a
 * record for its own id is dropped with a log and its siblings kept: refusing to start
 * repairs nothing, and the other joins are still good.
 */
export declare class KeyStoreJoinedStrandStore implements JoinedStrandStore {
    private readonly keyStore;
    readonly partyId: string;
    private readonly slotPrefix;
    /** The loaded records; null until a load succeeds. */
    private records;
    /** Runs every KeyStore access in call order, so a load never interleaves with a write. */
    private queue;
    constructor(keyStore: KeyStore, partyId: string);
    list(): Promise<JoinedStrandRecord[]>;
    /** Throws `InvalidStrandIdError` for an id that could never load back, before anything is written. */
    record(record: JoinedStrandRecord): Promise<void>;
    forget(strandId: string): Promise<void>;
    private slotId;
    private inOrder;
    private loaded;
}
/**
 * The party-wide joined-strand table (`CadreControl.JoinedStrand`), as the node's control
 * database exposes it. `CadreNode` builds it over `ControlDatabase` and the owner signing
 * key; this module sees only the seam, so it stays free of the runtime.
 */
export interface PartyJoinedStrandLedger {
    /** Every party-wide join, as offerable rows (`FounderOwnerKey: null`). */
    list(): Promise<StrandRow[]>;
    /** Whether this party's control database names `strandId`, as its own strand or as a party-wide join. */
    names(strandId: string): Promise<boolean>;
    /** Whether this machine can sign {@link publish} and {@link remove}: it holds an owner key the party enrolls. */
    canSign(): Promise<boolean>;
    /** Owner-signed insert. Resolves when the row landed or a sibling's join already holds the id. */
    publish(record: JoinedStrandRecord): Promise<void>;
    /** Owner-signed delete + tombstone; false when there is no row. Throws when a row exists and this machine cannot sign. */
    remove(strandId: string): Promise<boolean>;
}
/**
 * One node session's joined strands: what the strand watcher sees of the two records, and
 * the moves between them. Rebuilt at every start, which is what ends the per-session state
 * below.
 *
 * The watcher reads a row missing from a poll as a removal and detaches the strand, so this
 * holds the state a plain union would get wrong:
 *  - the last list each record answered, reused when a later read fails, so a failed read
 *    is not "every join was forgotten";
 *  - joins this party was removed from ({@link forgetAfterThisSession}): offered until this
 *    session ends, because `strand:revoked` promises that nothing is torn down for the app,
 *    and queued for party-wide removal so the next start does not re-attach them.
 */
export declare class JoinedStrandSession {
    private readonly store;
    private readonly ledger;
    private lastUnpublished;
    private lastPartyWide;
    private readonly keptForSession;
    /** Strands whose party-wide row {@link syncWithParty} removes, queued by a self-revocation. */
    private readonly pendingRemovals;
    /**
     * Tail of the moves that must not interleave ({@link serialized}): a publish that found no
     * party-wide row, then a {@link leave} that removed nothing, then the publish's insert
     * would leave the party holding a strand the app just left.
     */
    private exclusive;
    constructor(store: JoinedStrandStore, ledger: PartyJoinedStrandLedger);
    /**
     * `control` plus every join, one row per id, in this precedence: the control rows (the
     * party's own strands), then the party-wide joins, then this machine's unpublished joins
     * and the joins kept for this session. A local record named by either of the first two in
     * a read that succeeded this poll is stale — published, or the strand is the party's own
     * now — so it is forgotten here; this also cleans up after a crash between a publish and
     * its local forget. One named only by the last-good party-wide list is kept: that list may
     * predate a leave the record re-joined after.
     */
    withControlRows(control: readonly StrandRow[]): Promise<StrandRow[]>;
    /** Record a join `formStrand` just made. A re-join also cancels a removal a revocation queued. */
    remember(record: JoinedStrandRecord): Promise<void>;
    /**
     * Record `row`, joined by `addStrand`, unless this party's control database already names
     * it (its own strand, or a join already published) or an identical record is already here
     * (an app re-claiming a remembered join on every start). Keeps the first `joinedAt`. Like
     * {@link remember}, cancels a queued removal.
     */
    rememberForeign(row: StrandRow): Promise<void>;
    /**
     * Leave a join for the whole party: remove the party-wide row, then this machine's record.
     * Throws, keeping both, when a party-wide row exists and this machine cannot sign.
     */
    leave(strandId: string): Promise<void>;
    /**
     * For a strand this party was removed from: keep offering it until this session ends, and
     * queue its party-wide row for removal by {@link syncWithParty}, so it does not re-attach
     * on every start of every machine. A no-op for a strand with neither record (one of the
     * party's own). The queue is in memory: if the process dies first, the next start
     * relaunches the strand, the revoked-peer gate raises `strand:revoked` again, and this
     * runs again.
     */
    forgetAfterThisSession(strandId: string): Promise<void>;
    /**
     * The owner machine's half, run by the node's connected reconcile pass: publish every
     * unpublished join party-wide, then remove the party-wide rows queued by
     * {@link forgetAfterThisSession}. Does nothing on a machine that cannot sign, whose joins
     * stay machine-local. Per strand, a failure is logged and kept for the next pass; a
     * failure to list the store or to check the signer throws.
     */
    syncWithParty(): Promise<void>;
    private publish;
    private removeQueued;
    /** The party-wide joins; `fresh` is false when this read failed and the last list it answered stands in. */
    private partyWide;
    /**
     * {@link PartyJoinedStrandLedger.names}, answering false when the control database cannot
     * be read (a machine cut off from its party before it received the `JoinedStrand` block).
     * Recording is the safe side: a local record the party turns out to name is forgotten by
     * the next poll that reads it, while a join with no record is not offered after a restart.
     */
    private namedByParty;
    /** Run `work` after every earlier serialized move settles; see {@link exclusive}. */
    private serialized;
    private unpublished;
    private forgetSuperseded;
}
