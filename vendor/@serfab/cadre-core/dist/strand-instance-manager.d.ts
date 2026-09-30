import type { PrivateKey } from '@libp2p/interface';
import { type PeerJoinBackfillConfig } from './peer-join-backfill.js';
import { type StrandPeerObservation } from './strand-peer-observer.js';
import type { StrandPeerBookStore } from './strand-peer-book.js';
import { type StrandRevocationEnforcementConfig } from './strand-revocation-enforcer.js';
import { type PendingMembershipInviteSource, type StrandMembershipReconciliationConfig } from './strand-membership-reconciler.js';
import { type StrandFirstSyncConfig } from './strand-first-sync-gate.js';
import type { StrandInstance, StrandRow, StorageConfig, NetworkConfig, LatencyHint, NodeProfile, SAppConfig } from './types.js';
/**
 * Whether a tracked instance is launched but waiting for its first sync: the runtime is
 * up (`libp2pNode` set) while the database is still withheld (`database` unset). That
 * is the first-sync gate's state regardless of what `status` says — the hibernation
 * manager's idle timer can flip a long-gated joiner to `'idle'` without changing it.
 *
 * NOTE: `status` is therefore not the source of truth for "gated": a joiner that reaches
 * nobody for `idleTimeout` (5 min at the interactive hint) reads `'idle'`, then
 * `'hibernating'`, while still holding no database. Harmless today — every decision the
 * runtime makes goes through this predicate, {@link StrandInstanceManager.publishDatabase}
 * announces on the idle-flipped instance exactly as on a `'syncing'` one, and an app that
 * shows "waiting for the other member" on `'syncing'` merely sees "idle" instead after
 * five minutes. If an app ever needs the gated LABEL to survive the idle flip, make the
 * hibernation manager's idle transition preserve `'syncing'` rather than adding a flag.
 */
export declare function isAwaitingFirstSync(instance: StrandInstance): boolean;
/**
 * The status a LIVE instance (runtime rebuilt or woken) should report: `'active'` once its
 * database is published, `'syncing'` while the first-sync gate still withholds it. Every
 * site that would otherwise write `'active'` after a build or a wake goes through this,
 * so a gated joiner never reads as writable.
 */
export declare function liveStrandStatus(instance: StrandInstance): 'active' | 'syncing';
/**
 * Configuration for starting a strand instance
 */
export interface StartStrandConfig {
    strandRow: StrandRow;
    /**
     * sApp configuration provided by the hosting application. Absent for a **storage
     * replica** — a strand this node stores and serves without the app installed
     * (`CadreNodeConfig.hostUnclaimedStrands`): no schema signature check, no `App`
     * schema, no `sAppInfo` on the instance, and the default latency hint. A replica is
     * always a joiner; `StrandDatabase` refuses to found one. An app that later claims the
     * strand upgrades the running replica in place ({@link StrandInstanceManager.attachSApp}).
     */
    sAppConfig?: SAppConfig;
    storage?: StorageConfig;
    network?: NetworkConfig;
    profile: NodeProfile;
    defaultLatencyHint: LatencyHint;
    privateKey?: PrivateKey;
    /** Cohort-derived discovery seed (multiaddr strings). Defaults to [] when omitted. */
    bootstrapNodes?: string[];
    /**
     * Require a valid author signature on the sApp schema before bring-up.
     * Defaults to true (fail closed) when omitted; set false only for dev/test
     * with unsigned demo schemas. Mirrors {@link CadreNodeConfig.requireSignedSchemas}.
     */
    requireSignedSchemas?: boolean;
    /**
     * Whether this node founds the strand (vs. joins it). Forwarded to the
     * StrandDatabase so the founder bootstrap (Header, founding Member/Manager)
     * runs once at bring-up. Joiners leave this unset and write nothing. Callers
     * resolve it BEFORE calling `startStrand` (`CadreNode.launchStrand` derives it
     * from the row's `FounderOwnerKey` when no explicit flag is given — see
     * {@link StrandConfig.founder}); a founder request that arrives while the
     * instance is already tracked goes through {@link StrandInstanceManager.foundExistingStrand},
     * never through a repeat `startStrand`.
     */
    founder?: boolean;
    /**
     * THIS party's own strand membership private key (base64 protobuf) for a closed
     * strand — the identity the founder bootstrap derives `Member.Key` /
     * `Manager.MemberKey` from. Resolved by the caller (`CadreNode.launchStrand`: an
     * explicit attach-time key, else the control-layer `StrandPartyKey` row, healed by
     * mint-on-launch for the founding machine) and retained with the launch config, so a
     * hibernation wake rebuilds under the same identity. Deliberately NOT the strand
     * row's shared `MemberPrivateKey` (see `StrandDatabaseConfig.partyMemberPrivateKey`).
     * Absent for open strands, and for joiners with no persisted party key.
     */
    partyMemberPrivateKey?: string;
    /**
     * Number of nodes Optimystic is told this strand's replication cluster should
     * have. Same rule as {@link CadreNodeConfig.strandClusterSize}, which CadreNode
     * forwards here: every node on the strand should use the same value, and it is
     * frozen when the strand's libp2p node is created. Defaults to
     * `DEFAULT_STRAND_CLUSTER_SIZE` (4); values below `MIN_CLUSTER_SIZE` (2) are
     * rejected by `resolveStrandClusterSize`. Strand-only — the
     * control network's breadth is the fixed `CONTROL_REPLICATION_BREADTH`.
     */
    clusterSize?: number;
    /**
     * Machines that SERVE THIS STRAND (this node included), for the strand node's
     * block-repair corroboration yardstick — see `resolveRepairYardstick`. It must be
     * an authenticated per-strand count: the machines that actually run a node for this
     * strand, not the machines that exist.
     *
     * **The party's enrolled-machine count is NOT this number and must never be passed
     * here.** A strand launches only on machines whose embedding app registered its sApp
     * config (`CadreNode.addStrand`), so a closed strand shared by two machines of a
     * three-machine party is served by two. Passing three over-declares, and
     * over-declaring is the unsafe direction: at a declaration of 3 or more Optimystic
     * pins the repair corroboration floor at two corroborating peers, which a cohort
     * that can only ever field one peer can never reach — so the strand can never repair
     * a block (`cluster-fetch:no-quorum`, surfacing as reads failing with `Missing
     * block`). That regression is why this field was renamed off "enrolledMachines":
     * `bug-strand-yardstick-counts-party-machines`.
     *
     * **Nothing feeds it in production today.** No authenticated per-strand serving count
     * exists yet, so `CadreNode` passes nothing and the strand node runs the frozen
     * `STRAND_CLUSTER_POLICY` — declaring no yardstick, which leaves the known,
     * upstream-tracked single-voter exposure
     * (`backlog/debt-read-repair-single-voter-corroboration`). Building the count is
     * `backlog/feat-strand-yardstick-from-serving-machines`; this field and its
     * threading are the seam it plugs into.
     *
     * Volatile when a source does exist: re-resolve it on every resume beside the cohort
     * seed, since machines join and leave a strand while it hibernates. Omitting it means
     * "this node does not know", which declares nothing.
     */
    servingMachines?: number;
    /**
     * Tuning for the strand peer-join block catch-up ({@link PeerJoinBackfill}),
     * forwarded from {@link CadreNodeConfig.strandBackfill}. When the strand's
     * libp2p node connects to a peer this runtime has not yet caught up, every
     * block in the strand's own raw store is pushed to it. Runs only on strands
     * with per-strand storage; `{ enabled: false }` restores the pre-existing
     * no-backfill behaviour.
     */
    backfill?: PeerJoinBackfillConfig;
    /**
     * Tuning for the CLOSED-strand revoked-peer gate
     * ({@link StrandRevocationEnforcer}), forwarded from
     * {@link CadreNodeConfig.strandRevocationEnforcement}. Armed only for
     * `strandRow.Type === 'c'` (an open strand has no membership rows to derive a
     * deny set from); `{ enabled: false }` restores the pre-existing behaviour
     * (a removed party's peers keep being served).
     */
    revocationEnforcement?: StrandRevocationEnforcementConfig;
    /**
     * The staged formation membership invitation for THIS strand — the seam the
     * bring-up membership reconciler (`strand-membership-reconciler.ts`) reads to
     * redeem the party's `Strand.Member` seat, and clears once the invitation is
     * spent, burned, or dead. `CadreNode.launchStrand` wires it over its in-memory
     * `pendingMembershipInvites` map; read lazily per pass, so a re-formation that
     * replaces the entry between passes is picked up. Only consulted for closed
     * strands launched with a {@link partyMemberPrivateKey}; harmless otherwise.
     */
    pendingMembershipInvite?: PendingMembershipInviteSource;
    /**
     * Tuning for the CLOSED-strand membership reconciler, forwarded from
     * {@link CadreNodeConfig.strandMembershipReconciliation}. Armed only for
     * closed strands launched with a {@link partyMemberPrivateKey};
     * `{ enabled: false }` disarms the loop (test fixtures that hand-drive the
     * membership writers). When it names no `pollIntervalMs` the reconciler
     * mirrors {@link revocationEnforcement}'s cadence — as its IDLE cadence and
     * the cap of its unfinished-join retry ladder, not as a flat retry interval.
     */
    membershipReconciliation?: StrandMembershipReconciliationConfig;
    /**
     * Called when THIS node's own peer id turns up in the strand's revoked set —
     * this node's party was removed from the closed strand, or left it. Fires once
     * per removal (re-armed if the party is re-admitted; a resume also rebuilds the
     * enforcer and may legitimately re-fire), and only for closed strands with the
     * gate armed. `CadreNode`
     * wires it to its `strand:revoked` event; nothing is stopped or torn down on
     * this node's behalf — what to do about it is the app's call.
     */
    onSelfRevoked?: (strandId: string) => void;
    /**
     * Called when the membership reconciler reports a blocked re-join — this node holds a
     * staged membership invitation for the strand that its writes cannot redeem, which is
     * what a REMOVED party handed a fresh invitation hits (see "Reporting a blocked
     * re-join" in `strand-membership-reconciler.ts` for the two triggers, one of them a
     * suspicion rather than a verdict). At most once per re-arm of the loop — a further
     * invitation staged while the loop is still running does not reset the report — and
     * only for closed strands with a party key. `CadreNode` wires it to its `strand:rejoin-blocked`
     * event; nothing is stopped or torn down — a remaining manager admitting this party's
     * key directly is the remedy, and the loop finishes the join by itself once that lands.
     */
    onRejoinBlocked?: (strandId: string) => void;
    /**
     * Tuning for the JOINING machine's first-sync write gate (`strand-first-sync-gate.ts`),
     * forwarded from {@link CadreNodeConfig.strandFirstSync}: the Header probe cadence while
     * a non-founder launch is `'syncing'`, and the default budget {@link whenWritable} waits
     * before rejecting. Founders and machines that already hold the Header are never gated.
     */
    firstSync?: StrandFirstSyncConfig;
    /**
     * Called when a launch that came up `'syncing'` (see {@link firstSync}) becomes
     * writable: the strand's `Strand.Header` arrived from a peer — or a founder request
     * ran the bootstrap against the gated database — and `instance.database` is now set.
     * Never called for a launch that was writable when `startStrand`/`resumeStrand`
     * resolved. `CadreNode` wires it to its `strand:writable` event. Retained with the
     * launch config, so a hibernation resume that comes up gated announces too.
     */
    onWritable?: (strandId: string) => void;
    /**
     * Re-announce this strand's delegate peer id (`delegatePeerId` — the strand
     * node's own transport peer id) to ONE relay (`relayAddr`, a direct dial addr
     * with a trailing `/p2p/<relayPeerId>`), unthrottled. Awaited before every
     * relay-reservation RE-drive of that relay — never before the first attempt,
     * which the launch/resume seed pass has already announced for.
     *
     * Why: a party control node running the relay server admits the strand node on
     * an in-memory delegate grant that a relay restart drops, so a re-drive that did
     * not re-announce first would be denied at the relay's gate. `CadreNode` wires
     * its own control-mesh announce here; a throw or rejection is logged by the
     * supervisor and the re-drive still runs. Retained with the launch config, so a
     * hibernation wake's rebuilt supervisors carry it too.
     */
    announceDelegateToRelay?: (strandId: string, relayAddr: string, delegatePeerId: string) => Promise<void>;
    /**
     * Called when the strand's libp2p node identifies a STRAND peer — one whose
     * identify result names this strand's block-transfer protocol, so never the
     * circuit relay or a bootstrap node — with the addresses it is dialable at
     * (`strand-peer-observer.ts`). Throttled per peer; must not throw. `CadreNode`
     * wires it to the node-local strand peer book, which is what lets a restarted
     * machine dial the peers it was talking to. Absent ⇒ nothing is observed.
     * Retained with the launch config, so a hibernation wake re-arms it on the
     * rebuilt node.
     */
    onStrandPeerIdentified?: (strandId: string, observation: StrandPeerObservation) => void;
    /**
     * The node-local strand peer book the book SWAP reads and writes
     * (`strand-peer-book-swap.ts`): the strand node signs its own addresses with
     * {@link privateKey}, exchanges signed entries with every strand peer it identifies,
     * and files what verifies. Absent ⇒ no swap runs — a peer that dials this node's
     * swap handler gets no answer. `CadreNode` passes its book store. Retained with the
     * launch config, so a hibernation wake re-arms the swap on the rebuilt node.
     */
    strandPeerBook?: StrandPeerBookStore;
}
/**
 * Volatile inputs re-resolved when resuming a quiesced strand — the ones that can
 * have moved since it last ran, and that the rebuilt libp2p node freezes again. Each
 * one omitted keeps the value the retained launch config already holds, so a resume
 * that passes nothing rebuilds the strand exactly as it last ran.
 */
export interface ResumeStrandOverrides {
    /**
     * Freshly-resolved cohort discovery seed (multiaddr strings). Grows as peers are
     * learned since the strand first launched.
     */
    bootstrapNodes?: string[];
    /**
     * Freshly-read count of the machines serving this strand, for the repair yardstick
     * (see {@link StartStrandConfig.servingMachines} — including why the party's
     * enrolled-machine count is not it). Moves whenever a machine starts or stops
     * serving the strand, which a hibernating strand does not otherwise notice. Nothing
     * passes it today. Omitting it here does NOT mean "unknown" the way omitting it from
     * {@link StartStrandConfig} does — it retains the last value; see `resumeStrand`.
     */
    servingMachines?: number;
}
/**
 * Get the isolated storage path for a specific strand.
 *
 * @deprecated This helper is Node-only and throws in React Native (it assumes a
 * filesystem layout). Use a storage provider factory function instead, which
 * receives the strandId and can create strand-specific storage paths using
 * platform-appropriate methods.
 *
 * @example
 * // Instead of using getStrandStoragePath, use a storage provider factory:
 * const storage = {
 *   provider: (strandId: string) => new FileRawStorage(`./data/strands/${strandId}`)
 * };
 */
export declare function getStrandStoragePath(basePath: string, strandId: string): string;
/**
 * Manages individual strand instances - creates and destroys isolated libp2p nodes
 * for each strand the cadre participates in.
 */
export declare class StrandInstanceManager {
    private instances;
    /**
     * Retained launch config per strand, captured in `startStrand` and cleared in
     * `stopStrand`. `resumeStrand` reuses it to rebuild a quiesced strand's runtime
     * without the caller re-threading storage/network/profile/key/sApp config.
     */
    private launchConfigs;
    /**
     * The per-strand peer-join block catch-up, keyed by strand id. Private (not on
     * the public {@link StrandInstance}) because it is runtime plumbing with the
     * same lifetime as the strand's libp2p node: created in `buildStrandRuntime`,
     * stopped and dropped in `releaseRuntime` — so quiesce → resume rebuilds it
     * with a fresh caught-up-peer memo, which is intended (a resumed node may have
     * missed writes).
     */
    private backfills;
    /**
     * The per-strand peer-book observation writer (`strand-peer-observer.ts`), keyed
     * by strand id. Same lifecycle rationale as {@link backfills}: started in
     * `buildStrandRuntime` right after the libp2p node exists, stopped and dropped in
     * `releaseRuntime`, so quiesce → resume re-arms it on the rebuilt node. Only
     * present when the launch config supplied `onStrandPeerIdentified`.
     */
    private peerObservers;
    /**
     * Per-strand strand peer book SWAP driver ({@link StrandPeerBookSwap}) — the signed
     * exchange of book entries between strand peers. Same lifetime as the peer-book
     * observer above: armed in `buildStrandRuntime` right after the libp2p node exists
     * (its protocol handler must be registered before an early peer dials it), stopped
     * and dropped in `releaseRuntime`. Only present when the launch config supplied
     * `strandPeerBook`.
     */
    private peerBookSwaps;
    /**
     * The per-strand revoked-peer enforcer (closed strands only), keyed by strand
     * id. Same lifecycle rationale as {@link backfills}: created in
     * `buildStrandRuntime`, stopped and dropped in `releaseRuntime`, so quiesce →
     * resume rebuilds it with a fresh (initially empty, fail-open) snapshot.
     */
    private revocationEnforcers;
    /**
     * The per-strand membership reconciler (closed strands launched with a party
     * key only), keyed by strand id. Same lifecycle rationale as {@link backfills}:
     * created in `buildStrandRuntime`, stopped and dropped in `releaseRuntime`, so
     * quiesce → resume rebuilds it and re-runs the idempotent join ladder (redeem a
     * staged invitation, write this machine's own `MemberPeer` binding) from scratch.
     */
    private membershipReconcilers;
    /**
     * The per-strand first-sync gate (`strand-first-sync-gate.ts`), keyed by strand id:
     * holds a launch's `StrandDatabase` while it is NOT yet published on the instance.
     * Present from the moment the database object exists in `buildStrandRuntime` until
     * {@link publishDatabase} hands it to the app — so it doubles as the rollback handle
     * for a failed `initialize()` — and, for a joiner that holds no `Strand.Header` yet,
     * for as long as the launch stays `'syncing'`. Same lifecycle as {@link backfills}:
     * stopped (its database closed) and dropped in `releaseRuntime`, so a quiesce →
     * resume rebuild re-probes over the same store. An entry and `instance.database`
     * are mutually exclusive.
     */
    private firstSyncGates;
    /**
     * Callers blocked in {@link whenWritable}, keyed by strand id. Resolved by
     * {@link publishDatabase}, rejected by {@link stopStrand}; each waiter also carries
     * its own timeout. Deliberately NOT cleared by `releaseRuntime`: a waiter outlives a
     * quiesce → resume cycle, since the rebuild is what may finally publish the database.
     */
    private writableWaiters;
    /**
     * The per-strand relay-reservation supervisors — ONE PER CONFIGURED RELAY, each
     * over the node's own bare `/p2p-circuit` listener for that relay
     * (`strand-network-config.ts`) — keyed by strand id. Same lifecycle rationale as
     * {@link backfills}: started in `buildStrandRuntime` right after the libp2p node
     * exists, stopped FIRST and dropped in `releaseRuntime` (before the database
     * closes and the node stops, so no re-drive dials a node being torn down), so
     * quiesce → resume rebuilds them over the new node. What makes a strand node's
     * lost relay slot come back on its own — the control node has the same loop in
     * `CadreNode.reserveRelays`.
     */
    private relaySupervisors;
    /**
     * The resolved (cache-wrapped) raw storage per strand id — the instance's OWN
     * store, resolved once in `startStrand` and held until `stopStrand` disposes it.
     * Private for the same reason `backfills` is: runtime plumbing, not part of the
     * public {@link StrandInstance}.
     *
     * Deliberately NOT touched by `releaseRuntime`: that is what lets a quiesce →
     * resume cycle rebuild the libp2p node over the SAME store, keeping its
     * write-through cache warm (and, on an in-memory backend, keeping the strand's
     * blocks at all). An entry exists iff `instances` does AND the launch config
     * supplied a storage provider.
     *
     * NOTE: a hibernating strand therefore keeps its store — and its share of the
     * process-wide cache pool — resident for as long as the instance is tracked. That
     * is the point (a warm wake), and the pool evicts under pressure, so the cost is
     * one map entry per hibernating strand today. If a device ever hibernates strands
     * by the hundred, revisit: dropping the store at quiesce and paying for a cold
     * wake becomes the better trade.
     */
    private strandStorages;
    /**
     * The runtime build in flight per strand id (`buildStrandRuntime`, from `startStrand` or
     * `resumeStrand`), present until it settles. The instance is tracked for the whole build,
     * with its database not yet constructed or not yet initialized, so a caller that must act
     * on the FINISHED runtime ({@link attachSApp}) waits on this instead. A failed build's
     * rejection belongs to the call that started it.
     */
    private runtimeBuilds;
    /**
     * The resume in flight per strand id ({@link runResume}), present until it settles. The
     * WHOLE operation, not its entry in {@link runtimeBuilds}: that settles before the resume's
     * own catch records `'error'`, so a joiner awaiting it could read a stale status.
     */
    private resumesInFlight;
    private stopping;
    constructor();
    /**
     * Get all current strand instances
     */
    getInstances(): Map<string, StrandInstance>;
    /**
     * Get a specific strand instance
     */
    getInstance(strandId: string): StrandInstance | undefined;
    /**
     * Check if a strand is currently running
     */
    hasStrand(strandId: string): boolean;
    /**
     * Start a new strand instance.
     *
     * A failed launch leaves NOTHING tracked: the instance and its retained launch
     * config are both dropped before the error is rethrown, so the strand id is
     * free for a genuine retry. This matches the pre-registration failure path
     * (a rejected schema signature, which throws before anything is recorded) —
     * both failure modes of this call leave the same residue: none. Callers learn
     * of the failure from the rejected promise (and, on the control-discovered
     * path, from CadreNode's `strand:error` event), not from an error record left
     * behind in `instances`.
     *
     * The strand's raw storage is resolved HERE, once, and held for the instance's
     * lifetime (see `strandStorages`) — `buildStrandRuntime` only reads it, so a
     * hibernation wake never re-enters the embedder's provider.
     */
    startStrand(config: StartStrandConfig): Promise<StrandInstance>;
    /** Hold `build` in {@link runtimeBuilds} until it settles, and settle as it does. */
    private trackRuntimeBuild;
    /**
     * Wait until no runtime build of `strandId` is in flight. Never rejects: a failed build
     * is reported by the call that started it, and the caller re-reads the instance after.
     *
     * NOTE: after a failed launch the re-read sees the instance gone only because
     * `startStrand`'s catch deletes it synchronously, and its continuation is queued before
     * this waiter's. If that cleanup ever awaits before `instances.delete`, a waiter can act
     * on the dying record; move the cleanup inside the tracked promise then.
     */
    private settleRuntimeBuilds;
    /**
     * Build (or rebuild) the libp2p node + StrandDatabase for an instance and
     * attach them, transitioning it to `active`. Shared by `startStrand` (fresh
     * launch) and `resumeStrand` (rehydrating a quiesced instance). Reads all
     * volatile inputs (bootstrapNodes, servingMachines, network, profile,
     * privateKey, sApp config) from `config`, so the caller controls the
     * cohort-derived values. Storage is the
     * one input it does NOT re-read from `config`: that belongs to the instance and
     * comes from `strandStorages`.
     */
    private buildStrandRuntime;
    /**
     * Release an instance's strand-network runtime: stop the relay supervisors and
     * the other background loops, close the StrandDatabase, then stop the libp2p
     * node (construction order in reverse), clearing both fields and zeroing
     * connectedPeers. Tolerant of partially-built state — either handle may be
     * absent — so it doubles as rollback for a failed `buildStrandRuntime`. Shared
     * by `quiesceStrand`, `stopStrand`, and that rollback path.
     *
     * Leaves `strandStorages` untouched by design — the store outlives the runtime it
     * was built into, which is what makes a resume warm. Only `stopStrand` disposes it.
     */
    private releaseRuntime;
    /**
     * One {@link superviseRelayReservation} per relay dial addr, each over exactly
     * that relay so "held" is judged per relay (`circuitMultiaddrsVia`) and losing
     * one relay re-drives only that one. Default retry timings — the control node's (2 s
     * doubling to 60 s between failed attempts, a 5 s liveness check while held). Each DRIVE's
     * own deadline is counted in link round trips at this host's declared
     * `network.linkRoundTripMs` (`link-budget.ts`), so the same declaration that lengthens the
     * control node's drive lengthens these.
     *
     * Each supervisor's `beforeRedrive` is the caller's
     * {@link StartStrandConfig.announceDelegateToRelay} for THIS relay and THIS
     * node's peer id, so a re-drive after a relay restart is preceded by a fresh
     * delegate grant on the relay about to be dialed. Returns `[]` when no relay is
     * configured — the strand then simply has no circuit listener to fill.
     */
    private startRelaySupervisors;
    /**
     * Wait for every relay supervisor's first attempt to settle, concurrently, and log
     * the ones that landed nothing. Never throws — a strand whose relay is unreachable
     * at launch still comes up, with its supervisors retrying in the background.
     */
    private awaitFirstRelayAttempts;
    /**
     * Drop the strand's owned store and release this strand's claim on its cache. The
     * wrapper counts holders, so the cache is emptied and unregistered from the shared
     * pool only if no other scope still holds it. Called only where the strand's whole
     * lifetime ends (`stopStrand`, and the failed-launch rollback) — never on a quiesce.
     *
     * A dispose failure is logged, not thrown: the store is already unreferenced here,
     * and failing the stop over a cache-bookkeeping error would leave the caller unable
     * to tear the strand down. `disposeStorageCache` no-ops for an unwrapped store
     * (e.g. `MemoryRawStorage`), so no instanceof test is needed.
     */
    private disposeStrandStorage;
    /**
     * Refresh a strand's revoked-peer deny set NOW — and, with it, run the
     * teardown sweep that hangs up every connected revoked peer.
     *
     * The gate is otherwise poll-driven (default
     * `DEFAULT_REVOCATION_POLL_INTERVAL_MS`), because neither a replicated
     * revocation nor a local `revokeMember`/`leaveStrand` raises anything this
     * runtime can hook. A caller that just wrote a revocation against the
     * strand's database should follow it with this call, which makes the cut
     * immediate instead of waiting out the interval.
     *
     * Quiet no-op — matching `quiesceStrand`'s posture — when the strand is not
     * tracked, is quiesced, is open, or has the gate disabled: in every one of
     * those cases there is no enforcer to refresh. Never rejects (the enforcer's
     * refresh contains its own failures), and resolves only once the sweep has
     * finished.
     */
    refreshRevocationEnforcement(strandId: string): Promise<void>;
    /**
     * A fresh membership invitation was staged for `strandId` (`CadreNode`'s
     * `adoptFormationMembershipInvite`): re-arm the strand's membership reconciler so the
     * invitation is attempted now rather than never — the loop finished during the first
     * join and would otherwise stay stopped until a relaunch. Quiet no-op when no reconciler
     * is armed: a first formation stages before the strand is added, and bring-up then arms
     * a loop that finds the invitation by itself. Returns at once; the pass runs on the
     * loop's own serialized chain and never rejects.
     */
    notifyMembershipInviteStaged(strandId: string): void;
    /**
     * Best-effort removal of THIS machine's own `Strand.MemberPeer` binding — the
     * self arm of `removeMemberPeer`, signed with the retained launch config's party
     * key. Called by `CadreNode.unpublishStrand` BEFORE the local stop, while the
     * strand database and transport are still live: after the unpublish commits, the
     * party's `StrandPartyKey` control row is gone, so no restart could ever sign
     * this removal again — the in-memory retained key is the last chance.
     *
     * Never throws. Quiet no-op for a strand that is untracked, open, or launched
     * without a party key; a quiesced (hibernating) strand, or a strand whose write
     * quorum is already unreachable, leaves the stale binding behind with a log —
     * it grants nothing today (admission is not allowlist-gated) and only
     * mis-credits diversity. The strand's own membership reconciler is stopped —
     * and its in-flight pass awaited — FIRST, so a pass that was already past its
     * own stopped check cannot re-register the binding this is about to clear.
     *
     * NOTE: deliberately NOT handled here (or anywhere yet): clearing the bindings
     * of a machine removed from the CADRE at the control layer, or of a party's
     * OTHER machines when the party unpublishes — the party still holds the key on
     * every surviving machine and can clear from any of them, and the stale rows
     * grant nothing while admission is deny-list only. Revisit when
     * `feat-strand-member-allowlist-admission` lands and a stale binding starts
     * granting admission rather than merely mis-crediting diversity.
     */
    clearOwnMemberPeerBinding(strandId: string): Promise<void>;
    /**
     * Quiesce a strand: release its strand-network resources (stop the libp2p node,
     * close the StrandDatabase) while RETAINING the instance record — identity,
     * sAppInfo, keys, latency hint, metadata — and its launch config so it can be
     * resumed later. Mechanically this is `stopStrand` minus the instance/config
     * deletion. The caller sets the post-quiesce status (e.g. `hibernating`).
     * No-ops when the strand is missing or already quiesced.
     */
    quiesceStrand(strandId: string): Promise<void>;
    /**
     * Resume a previously-quiesced strand: rebuild its libp2p node + StrandDatabase
     * from the retained launch config and re-attach them, transitioning it back to
     * `active`. `overrides` re-applies volatile inputs that may have changed since
     * launch (the cohort `bootstrapNodes` seed and the strand's `servingMachines`
     * count) and updates the retained config so a later resume reuses the latest
     * values. Returns the live instance unchanged if it is already running.
     *
     * Overlapping calls share one rebuild: a call made while a resume of the same strand is
     * in flight — a wake landing during a check-in — joins it and settles exactly as it does,
     * `'error'` status included. The joiner's own `overrides` are ignored; the first resume's
     * seed wins, and both callers resolved the cohort seed moments apart. A call made while
     * `startStrand` is still building waits for that build rather than starting a second.
     */
    resumeStrand(strandId: string, overrides?: ResumeStrandOverrides): Promise<StrandInstance>;
    /** Body of {@link resumeStrand}; at most one runs per strand at a time. */
    private runResume;
    /**
     * Honor a founder request against an ALREADY-TRACKED strand — the seam that
     * closes the "whoever launches first decides whether the bootstrap runs" gap:
     * an instance first launched as a joiner (an app's own attach, or a watcher
     * poll winning the launch race) used to swallow a later founder request
     * silently, leaving the strand active with no `Strand.Header`.
     *
     * Flips the RETAINED launch config's `founder` to true, so every later
     * quiesce → resume rebuild founds as well (the bootstrap is insert-if-absent —
     * {@link StrandDatabase.ensureFounderBootstrap} — so re-running it per rebuild
     * writes nothing twice), and runs the bootstrap against the live database now.
     *
     * @returns how the request resolved:
     * - `'already-founder'` — the retained config already founds; nothing to do.
     * - `'bootstrapped'` — config flipped and the live database ran the bootstrap.
     * - `'needs-resume'` — config flipped, but the instance is quiesced (no live
     *   database), so the bootstrap could not run here: the CALLER must wake the
     *   strand (`CadreNode.wakeStrand`, which owns the hibernation bookkeeping this
     *   manager does not) so the rebuild — which now founds — runs it.
     * @param resolvePartyKey - Asked for the party's own membership key when (and only
     *   when) a CLOSED strand's retained config carries none — the instance was launched
     *   as a joiner before its `StrandPartyKey` row existed or replicated. The resolved
     *   key is retained alongside the founder flip so the bootstrap (now, or on the
     *   caller's wake for `'needs-resume'`) can seat the founding Member/Manager.
     * @throws when the strand is not tracked — this seam exists only for the
     *   tracked-instance launch path; an untracked id is a caller bug.
     * @throws whatever the live bootstrap throws (e.g. `PreSplitStrandIdentityError`),
     *   after {@link withdrawFounderRequest} — so a retry re-attempts the founding rather
     *   than resolving `'already-founder'` over an instance that never founded. A caller
     *   whose `'needs-resume'` wake fails owes the same withdrawal.
     */
    foundExistingStrand(strandId: string, resolvePartyKey?: () => Promise<string | undefined>): Promise<'already-founder' | 'bootstrapped' | 'needs-resume'>;
    /**
     * Give a tracked storage replica ({@link StartStrandConfig.sAppConfig} absent) the app's
     * schema in place — the seam for an app on this machine claiming a strand this node was
     * already hosting. No runtime rebuild: the libp2p node, its peer id and connections, the
     * store and its warm cache all stay, and the new `App` tables read the blocks the replica
     * already holds. Callers attach BEFORE {@link foundExistingStrand}: the founder bootstrap
     * writes the sApp into `Strand.Header` and refuses a database that has none.
     *
     * A runtime build in flight (the replica's launch, or a hibernation wake) is waited out
     * first, so the attach acts on the database that build produced. Then, in order: the
     * schema signature is checked before anything changes; the retained launch config takes
     * the sApp, so every later rebuild applies it through `composeStrand`; the live database —
     * published, or still held by the first-sync gate — gets the schema; and only then does
     * the instance record `sAppInfo` and the sApp's latency hint. A quiesced instance gets the
     * config alone, and its next resume applies the schema.
     *
     * @returns `'already-attached'` when the instance already runs an sApp — a DIFFERENT one
     *   is logged and left as it is, as a second claim of a claimed strand always has been —
     *   else `'attached'`.
     * @throws when the strand is not tracked (a caller bug, or a launch that failed while
     *   this waited on it); when the schema signature is refused, having changed nothing; and
     *   whatever the live apply throws (e.g. a quiesce closed the database mid-apply) — the
     *   retained config then still carries the sApp and `sAppInfo` stays unset, so the next
     *   claim retries the apply.
     *
     * NOTE: two claims of one replica racing each other both pass the `sAppInfo` check and
     * apply concurrently; the loser of the declarative diff can reject, and its `addStrand`
     * retry then resolves `'already-attached'`. Needs an app calling `addStrand` twice at once
     * (or beside a watcher retry); if it is ever seen, chain attaches per strand id.
     */
    attachSApp(strandId: string, sAppConfig: SAppConfig, options?: {
        requireSignedSchemas?: boolean;
    }): Promise<'attached' | 'already-attached'>;
    /**
     * Whether `strandId` is launched but still waiting for its first sync — a joiner whose
     * runtime is up while its database is withheld (status `'syncing'`, or `'idle'` after
     * the hibernation manager's idle timer fired on it). `false` for a writable, quiesced,
     * or untracked strand. The predicate {@link whenWritable}'s callers gate on.
     */
    isAwaitingFirstSync(strandId: string): boolean;
    /**
     * Resolve once the strand's database is published to the app — immediately for a
     * writable strand — or reject with {@link StrandAwaitingFirstSyncError} after
     * `timeoutMs` (default: the retained launch config's `firstSync.timeoutMs`, else
     * {@link DEFAULT_STRAND_FIRST_SYNC_TIMEOUT_MS}). The rejection is RETRYABLE: nothing is
     * torn down, the gate keeps probing, and a later call waits afresh. A quiesced
     * (hibernating) strand is not woken here — the wait spans a resume, so a caller that
     * wants one wakes it (`CadreNode.wakeStrand`) and waits. Rejects immediately for an
     * untracked strand, and whenever the strand is stopped while a wait is pending.
     */
    whenWritable(strandId: string, options?: {
        timeoutMs?: number;
    }): Promise<StrandInstance>;
    /**
     * Hand a launch's database to the app: set `instance.database`, retire the gate that
     * held it, release every {@link whenWritable} waiter, and — when the launch had already
     * been reported gated — flip it `'active'` and announce it through the retained config's
     * `onWritable`. "Reported gated" is any status but `'starting'`: `'syncing'`, or the
     * `'idle'` the hibernation manager's idle timer flips a long-gated joiner to (see
     * {@link isAwaitingFirstSync}) — the Header arriving after that flip must announce too,
     * or an app hanging on `strand:writable` never learns the strand opened. A publish that
     * lands while the instance is still `'starting'` (the Header arrived during the rest of
     * bring-up) announces nothing: `startStrand` / `resumeStrand` are about to report the
     * strand `'active'`, and `strand:writable` is defined as the follow-up to a gated
     * launch, never a duplicate of `strand:started`.
     *
     * It is also the one seam where a WITHHELD database becomes available, so it kicks the
     * membership reconciler: on a gated launch that loop's own immediate pass ran while
     * `instance.database` was still unset, found no database, and would otherwise not try
     * again until its retry timer fired. A launch that was never gated publishes here BEFORE
     * the reconciler is constructed, so there is nothing registered to kick and the loop's own
     * immediate pass already sees the database — which is why the kick needs no `wasGated`
     * test of its own.
     */
    private publishDatabase;
    /** Reject every {@link whenWritable} waiter for a strand that is going away. */
    private rejectWritableWaiters;
    /**
     * Undo {@link foundExistingStrand}'s founder flip after the founding it promised
     * failed, so the retained config again says what this instance actually runs as (a
     * joiner) and the next founder request re-attempts the bootstrap. The resolved party
     * key stays retained — it is this party's identity for the strand either way. No-op
     * when the strand is untracked or its config does not found.
     */
    withdrawFounderRequest(strandId: string): void;
    /**
     * Run the (idempotent) founder bootstrap against a tracked strand's LIVE
     * database, independently of what the retained launch config says.
     *
     * Separate from {@link foundExistingStrand} because a caller that resolved
     * `'needs-resume'` and woke the strand must not assume the wake's own rebuild
     * founded it: `HibernationManager` COALESCES wakes, so a wake already in flight
     * when the config flipped had already read the PRE-flip config and rebuilt as a
     * joiner. Re-running the bootstrap costs one insert-if-absent probe per table
     * and is the only thing that makes "founding resolves once the Header is
     * written" true on that path.
     *
     * A strand still `'syncing'` (its database withheld behind the first-sync gate) is
     * founded through the gate: the bootstrap writes the Header this machine was waiting
     * to receive, so a successful run publishes the database and the strand goes
     * `'active'` — the one legitimate way a joiner launch becomes writable without a peer.
     *
     * @throws when the strand is not tracked, or is still quiesced (no live
     *   database) — both mean the bootstrap did NOT run, which a founder request
     *   must never swallow.
     */
    ensureFounderBootstrap(strandId: string): Promise<void>;
    /**
     * Stop a strand instance
     */
    stopStrand(strandId: string): Promise<void>;
    /**
     * Stop all strand instances
     */
    stopAll(): Promise<void>;
}
