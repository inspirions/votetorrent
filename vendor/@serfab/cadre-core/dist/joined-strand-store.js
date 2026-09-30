/**
 * The strands this party joined from ANOTHER party, held in two records.
 *
 * A party's own strands come back after a restart through its control database: the
 * `Strand` table holds their rows, the strand watcher polls it, and each row no sApp
 * config claims is offered as `strand:discovered`. A strand joined through formation with
 * another party (`CadreNode.formStrand`) has its `Strand` row in the OTHER party's control
 * database, so it needs a record of its own (gotchoices/sereus#18):
 *
 *  - the PARTY-WIDE record, a `CadreControl.JoinedStrand` row ({@link PartyJoinedStrandLedger}).
 *    Once it exists it is the authority: every machine of the party offers it, a storage
 *    replica host launches it, and removing it is how the party leaves the strand;
 *  - the MACHINE-LOCAL record ({@link JoinedStrandStore}, below), a queue of joins this
 *    machine made that the party does not know about yet. A join is recorded here first,
 *    published by an owner machine's connected reconcile pass, and forgotten as soon as the
 *    party-wide row is visible, so a local record always means "joined here, not yet
 *    published". A machine that is not an owner never publishes; its joins stay here.
 *
 * {@link JoinedStrandSession} moves joins between the two and is what the strand watcher
 * polls beside the control rows.
 *
 * Two store implementations:
 *  - {@link MemoryJoinedStrandStore} — joins die with the process. The default only for a
 *    node configured with no `keyStore`.
 *  - {@link KeyStoreJoinedStrandStore} — one {@link KeyStore} slot per join. A record holds
 *    the closed strand's shared read secret, and the KeyStore is the one seam every
 *    platform already routes secrets through (the platform enclave on React Native, the
 *    state directory for `FileKeyStore`), so the record goes there rather than into a
 *    `DurableSlot` like the bootstrap-peer store.
 *
 * Party-scoped like every other node-local store, because one KeyStore can serve several
 * parties: the React Native app keeps one per device and lets the user switch party. A
 * join made for one party must never be offered to a node started for another.
 *
 * Dependency-free beyond the KeyStore seam, so safe in every entry graph.
 */
import debug from 'debug';
import { toString as uint8ArrayToString, fromString as uint8ArrayFromString } from 'uint8arrays';
import { assertStrandScopeKey, isValidStrandScopeKey } from './storage-scope.js';
const log = debug('sereus:cadre:joined-strand-store');
/**
 * The {@link StrandRow} a record stands for — the shape `addStrand` and `strand:discovered`
 * carry. `FounderOwnerKey` is null because a joiner never founds; `CadreNode.launchStrand`
 * reads null as "not mine" and joins.
 */
export function joinedStrandRow(record) {
    return { Id: record.Id, Type: record.Type, MemberPrivateKey: record.MemberPrivateKey, FounderOwnerKey: null };
}
/**
 * Ephemeral store for a node without a `keyStore`. Warns once, at the first join it is
 * asked to remember, because a join held only here is not re-offered after a restart —
 * exactly the gotchoices/sereus#18 shape, and it should show in a log rather than pass
 * silently.
 */
export class MemoryJoinedStrandStore {
    constructor(partyId) {
        this.partyId = partyId;
        this.records = new Map();
        this.warned = false;
    }
    async list() {
        return [...this.records.values()];
    }
    async record(record) {
        this.warnOnce();
        this.records.set(record.Id, { ...record });
    }
    async forget(strandId) {
        this.records.delete(strandId);
    }
    warnOnce() {
        if (this.warned) {
            return;
        }
        this.warned = true;
        console.warn('CadreNode has no keyStore and no joinedStrands.store, so strands joined from another party ' +
            'are remembered in memory only and will NOT be re-offered after a restart. Configure a keyStore, ' +
            'or inject joinedStrands: { store: new KeyStoreJoinedStrandStore(<a durable KeyStore>, partyId) }.');
    }
}
/** Slot id prefix for every joined-strand record; the party segment and the strand id follow. */
const SLOT_PREFIX = 'cadre/joined-strand/';
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
export class KeyStoreJoinedStrandStore {
    constructor(keyStore, partyId) {
        this.keyStore = keyStore;
        this.partyId = partyId;
        /** The loaded records; null until a load succeeds. */
        this.records = null;
        /** Runs every KeyStore access in call order, so a load never interleaves with a write. */
        this.queue = Promise.resolve();
        this.slotPrefix = SLOT_PREFIX + uint8ArrayToString(uint8ArrayFromString(partyId, 'utf8'), 'base64url') + '/';
    }
    list() {
        return this.inOrder(async () => [...(await this.loaded()).values()]);
    }
    /** Throws `InvalidStrandIdError` for an id that could never load back, before anything is written. */
    record(record) {
        assertStrandScopeKey(record.Id);
        const stored = { ...record };
        return this.inOrder(async () => {
            await this.keyStore.set(this.slotId(record.Id), uint8ArrayFromString(JSON.stringify(stored), 'utf8'));
            this.records?.set(record.Id, stored);
            log('joined strand remembered (party=%s, strand=%s, type=%s)', this.partyId, record.Id, record.Type);
        });
    }
    forget(strandId) {
        return this.inOrder(async () => {
            await this.keyStore.delete(this.slotId(strandId));
            this.records?.delete(strandId);
            log('joined strand forgotten (party=%s, strand=%s)', this.partyId, strandId);
        });
    }
    slotId(strandId) {
        return this.slotPrefix + strandId;
    }
    inOrder(op) {
        const result = this.queue.then(op);
        // The caller receives `result`, rejection included; the queue only needs to know it settled.
        this.queue = result.catch(() => undefined);
        return result;
    }
    // NOTE: a failed load is retried at the next list(), which is every strand-watcher poll;
    // over a backend that gates reads behind an unlock prompt the user keeps declining, that
    // is a prompt every five seconds. Every KeyStore shipped today is ungated for this reason
    // (see `SecureStoreKeyStoreOptions.requireAuthentication`); if one is ever gated, back
    // off the retry here.
    async loaded() {
        if (this.records) {
            return this.records;
        }
        const records = new Map();
        for (const slot of await this.keyStore.list()) {
            if (!slot.startsWith(this.slotPrefix)) {
                continue;
            }
            const strandId = slot.slice(this.slotPrefix.length);
            const bytes = await this.keyStore.get(slot);
            if (!bytes) {
                continue;
            }
            const record = parseRecord(strandId, bytes);
            if (record) {
                records.set(strandId, record);
            }
        }
        this.records = records;
        log('joined strands loaded (party=%s, count=%d)', this.partyId, records.size);
        return records;
    }
}
/** The record a slot holds, or undefined (logged) when it is not one for `strandId`. */
function parseRecord(strandId, bytes) {
    let parsed;
    try {
        parsed = JSON.parse(uint8ArrayToString(bytes, 'utf8'));
    }
    catch (error) {
        log('dropping joined-strand slot for %s: not JSON (%o)', strandId, error);
        return undefined;
    }
    const { Id, Type, MemberPrivateKey, joinedAt } = (typeof parsed === 'object' && parsed !== null ? parsed : {});
    const valid = Id === strandId
        && isValidStrandScopeKey(strandId)
        && (Type === 'o' || Type === 'c')
        && (MemberPrivateKey === null || typeof MemberPrivateKey === 'string')
        && typeof joinedAt === 'number';
    if (!valid) {
        log('dropping joined-strand slot for %s: not a joined-strand record for that id', strandId);
        return undefined;
    }
    return { Id: strandId, Type: Type, MemberPrivateKey: MemberPrivateKey, joinedAt: joinedAt };
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
export class JoinedStrandSession {
    constructor(store, ledger) {
        this.store = store;
        this.ledger = ledger;
        this.lastUnpublished = [];
        this.lastPartyWide = [];
        this.keptForSession = new Map();
        /** Strands whose party-wide row {@link syncWithParty} removes, queued by a self-revocation. */
        this.pendingRemovals = new Set();
        /**
         * Tail of the moves that must not interleave ({@link serialized}): a publish that found no
         * party-wide row, then a {@link leave} that removed nothing, then the publish's insert
         * would leave the party holding a strand the app just left.
         */
        this.exclusive = Promise.resolve();
    }
    /**
     * `control` plus every join, one row per id, in this precedence: the control rows (the
     * party's own strands), then the party-wide joins, then this machine's unpublished joins
     * and the joins kept for this session. A local record named by either of the first two in
     * a read that succeeded this poll is stale — published, or the strand is the party's own
     * now — so it is forgotten here; this also cleans up after a crash between a publish and
     * its local forget. One named only by the last-good party-wide list is kept: that list may
     * predate a leave the record re-joined after.
     */
    async withControlRows(control) {
        const controlIds = new Set(control.map((row) => row.Id));
        const named = new Set(controlIds);
        const offered = new Map(control.map((row) => [row.Id, row]));
        const partyWide = await this.partyWide();
        // NOTE: a party-wide join whose id the party's own `Strand` table also holds (the party
        // founded AND joined it — contrived) is shadowed here, not deleted: a watcher poll must
        // not make owner-signed writes. If the party later unpublishes its own row the join row
        // resurfaces; if that is ever seen, remove the join row inside `unpublishStrand`.
        for (const row of partyWide.rows) {
            if (!offered.has(row.Id)) {
                offered.set(row.Id, row);
            }
            if (partyWide.fresh) {
                named.add(row.Id);
            }
        }
        for (const record of await this.unpublished()) {
            if (named.has(record.Id)) {
                await this.forgetSuperseded(record.Id);
            }
            else if (!offered.has(record.Id)) {
                offered.set(record.Id, joinedStrandRow(record));
            }
        }
        for (const [strandId, row] of this.keptForSession) {
            if (controlIds.has(strandId)) {
                this.keptForSession.delete(strandId);
            }
            else if (!offered.has(strandId)) {
                offered.set(strandId, row);
            }
        }
        return [...offered.values()];
    }
    /** Record a join `formStrand` just made. A re-join also cancels a removal a revocation queued. */
    async remember(record) {
        this.pendingRemovals.delete(record.Id);
        await this.store.record(record);
    }
    /**
     * Record `row`, joined by `addStrand`, unless this party's control database already names
     * it (its own strand, or a join already published) or an identical record is already here
     * (an app re-claiming a remembered join on every start). Keeps the first `joinedAt`. Like
     * {@link remember}, cancels a queued removal.
     */
    async rememberForeign(row) {
        this.pendingRemovals.delete(row.Id);
        if (await this.namedByParty(row.Id)) {
            return;
        }
        const existing = (await this.store.list()).find((record) => record.Id === row.Id);
        if (existing?.Type === row.Type && existing.MemberPrivateKey === row.MemberPrivateKey) {
            return;
        }
        await this.store.record({
            Id: row.Id,
            Type: row.Type,
            MemberPrivateKey: row.MemberPrivateKey,
            joinedAt: existing?.joinedAt ?? Date.now()
        });
    }
    /**
     * Leave a join for the whole party: remove the party-wide row, then this machine's record.
     * Throws, keeping both, when a party-wide row exists and this machine cannot sign.
     */
    leave(strandId) {
        return this.serialized(async () => {
            await this.ledger.remove(strandId);
            this.pendingRemovals.delete(strandId);
            this.keptForSession.delete(strandId);
            this.lastPartyWide = this.lastPartyWide.filter((row) => row.Id !== strandId);
            await this.store.forget(strandId);
        });
    }
    /**
     * For a strand this party was removed from: keep offering it until this session ends, and
     * queue its party-wide row for removal by {@link syncWithParty}, so it does not re-attach
     * on every start of every machine. A no-op for a strand with neither record (one of the
     * party's own). The queue is in memory: if the process dies first, the next start
     * relaunches the strand, the revoked-peer gate raises `strand:revoked` again, and this
     * runs again.
     */
    forgetAfterThisSession(strandId) {
        return this.serialized(async () => {
            const local = (await this.unpublished()).find((record) => record.Id === strandId);
            const row = local ? joinedStrandRow(local) : this.lastPartyWide.find((listed) => listed.Id === strandId);
            if (!row) {
                return;
            }
            // Kept BEFORE the store forgets, so no poll can union without it. Queued even for a
            // local-only join, which a sibling may have published already.
            this.keptForSession.set(strandId, row);
            this.pendingRemovals.add(strandId);
            if (local) {
                await this.store.forget(strandId);
            }
        });
    }
    /**
     * The owner machine's half, run by the node's connected reconcile pass: publish every
     * unpublished join party-wide, then remove the party-wide rows queued by
     * {@link forgetAfterThisSession}. Does nothing on a machine that cannot sign, whose joins
     * stay machine-local. Per strand, a failure is logged and kept for the next pass; a
     * failure to list the store or to check the signer throws.
     */
    syncWithParty() {
        return this.serialized(async () => {
            // Straight from the store, never the last-good list: a stale list could republish a
            // join that was left since.
            const unpublished = await this.store.list();
            if (unpublished.length === 0 && this.pendingRemovals.size === 0) {
                return;
            }
            if (!(await this.ledger.canSign())) {
                return;
            }
            for (const record of unpublished) {
                await this.publish(record);
            }
            for (const strandId of [...this.pendingRemovals]) {
                await this.removeQueued(strandId);
            }
        });
    }
    // NOTE: a sibling that joined the same strand and has not yet published publishes it after
    // a leave, bringing the strand back party-wide. Needs two devices joining one strand within
    // a reconcile interval of the leave; if it is ever seen, check the strand's `Revocation`
    // tombstone before publishing.
    async publish(record) {
        try {
            if (!(await this.ledger.names(record.Id))) {
                await this.ledger.publish(record);
                // Into the last-good list too: its local record goes next, so a party-wide read that
                // fails before one succeeds would otherwise drop the strand from the poll and hide it
                // from a self-revocation.
                this.lastPartyWide = [...this.lastPartyWide.filter((row) => row.Id !== record.Id), joinedStrandRow(record)];
                log('joined strand %s published party-wide (party=%s)', record.Id, this.store.partyId);
            }
            await this.store.forget(record.Id);
        }
        catch (error) {
            log('joined strand %s: publishing party-wide failed; kept for the next pass: %o', record.Id, error);
        }
    }
    async removeQueued(strandId) {
        try {
            const removed = await this.ledger.remove(strandId);
            this.pendingRemovals.delete(strandId);
            log('joined strand %s: party-wide row %s after this party was removed from it', strandId, removed ? 'removed' : 'already absent');
        }
        catch (error) {
            log('joined strand %s: removing the party-wide row failed; queued for the next pass: %o', strandId, error);
        }
    }
    /** The party-wide joins; `fresh` is false when this read failed and the last list it answered stands in. */
    async partyWide() {
        try {
            this.lastPartyWide = await this.ledger.list();
            return { rows: this.lastPartyWide, fresh: true };
        }
        catch (error) {
            log('party-wide joined-strand read failed; offering the last list it answered (%d join(s)): %o', this.lastPartyWide.length, error);
            return { rows: this.lastPartyWide, fresh: false };
        }
    }
    /**
     * {@link PartyJoinedStrandLedger.names}, answering false when the control database cannot
     * be read (a machine cut off from its party before it received the `JoinedStrand` block).
     * Recording is the safe side: a local record the party turns out to name is forgotten by
     * the next poll that reads it, while a join with no record is not offered after a restart.
     */
    async namedByParty(strandId) {
        try {
            return await this.ledger.names(strandId);
        }
        catch (error) {
            log('joined strand %s: could not read whether the control database names it; recording it locally: %o', strandId, error);
            return false;
        }
    }
    /** Run `work` after every earlier serialized move settles; see {@link exclusive}. */
    serialized(work) {
        const result = this.exclusive.then(work);
        this.exclusive = result.catch(() => undefined);
        return result;
    }
    async unpublished() {
        try {
            this.lastUnpublished = await this.store.list();
        }
        catch (error) {
            log('joined-strand store list failed; offering the last list it answered (%d join(s)): %o', this.lastUnpublished.length, error);
        }
        return this.lastUnpublished;
    }
    async forgetSuperseded(strandId) {
        try {
            await this.store.forget(strandId);
            log('joined strand %s is named by this party\'s control database — local record forgotten', strandId);
        }
        catch (error) {
            log('forgetting superseded joined strand %s failed; the next poll retries: %o', strandId, error);
        }
    }
}
//# sourceMappingURL=joined-strand-store.js.map