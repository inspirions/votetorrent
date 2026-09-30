import type { Libp2p, PeerId } from '@libp2p/interface';
import type { Multiaddr } from '@multiformats/multiaddr';
import type { CadreNodeConfig, StrandInstance, StrandRow, StrandConfig, FoundStrandConfig, FoundStrandResult, SAppConfig, CadreNodeEvents, ControlNetworkSeed, ApplySeedResult, AddDroneOptions, AddPhoneOptions, DroneInitResult, InviteResult, CadreInvite, OpenInvitation, FormStrandResult, StrandFormationDisclosure, StrandMembershipInvite, ResolveOpts, SelfRegistrationOutcome, ServiceWakeResult, PushPlatform, DeviceTokenRecord, ResolveDeviceTokenOpts } from './types.js';
import { type Ed25519KeyPair } from './ed25519-key.js';
import { type TrustedOwnerStore, type TrustSource } from './trusted-owner-store.js';
import { type BootstrapPeerStore } from './bootstrap-peer-store.js';
import { type StrandPeerBookStore } from './strand-peer-book.js';
import { type EnrolledMachineStore } from './enrolled-machine-store.js';
import { type SAppIdLookup } from './strand-watcher.js';
import { type ControlCohortReconcileResult } from './control-cohort.js';
import { EnrollmentService } from './enrollment.js';
import { ControlDatabase } from './control-database.js';
import { SeedBootstrapService } from './seed-bootstrap.js';
import type { SeedTrustPolicy } from './seed-trust-policy.js';
import { StrandSolicitationService, type StrandSolicitationServiceOptions } from './strand-solicitation.js';
import { type RelayReservationState, type RelayReservationSupervisorOptions } from './relay-reservation.js';
import type { WakeAck } from './types.js';
import { type ConnectionPathSummary } from './diagnostics/connection-path.js';
/**
 * How often a running strand re-asks each connected sibling that last ANSWERED
 * (even with nothing) for its strand-network addresses, and re-merges them into
 * its own libp2p address book ({@link CadreNode.refreshStrandPeerAddrs}).
 * Overridable per node via `network.controlCohort.strandAddrRefreshMs`.
 *
 * Ten minutes sits comfortably inside the peerStore's one-hour address expiry
 * (`MAX_ADDRESS_AGE`, see `peer-addr-book.ts`) with headroom for several missed
 * passes, and far above the 15 s reconcile cadence the refresh rides on, so the
 * strand-addr RPC fan-out stays cheap.
 */
export declare const STRAND_PEER_ADDR_REFRESH_MS: number;
/**
 * How soon {@link CadreNode.refreshStrandPeerAddrs} re-asks a sibling that did NOT
 * answer — unreachable, `unavailable`, or `refused`. A refusal matters most: a
 * phone asking before its `CadrePeer` row has replicated to the sibling is refused
 * and its delegate grant goes unrecorded, and waiting the full
 * {@link STRAND_PEER_ADDR_REFRESH_MS} for the next try is the delay this bounds.
 * Four reconcile ticks, so a sibling that keeps failing costs one timed-out RPC a
 * minute rather than one a tick.
 */
export declare const STRAND_PEER_ADDR_RETRY_MS: number;
type EventHandler<T> = (data: T) => void;
/**
 * CadreNode is the main entry point for a cadre member.
 * It manages:
 * - Connection to the control network
 * - Watching for strand changes
 * - Starting/stopping strand instances
 * - Strand hibernation lifecycle
 * - Peer enrollment
 */
export declare class CadreNode implements SAppIdLookup {
    private readonly config;
    /**
     * The resolved node identity key, set once by {@link resolveIdentityKey}
     * during {@link start} (from `config.keyStore`, else `config.privateKey`).
     * Left undefined when neither is configured — libp2p then generates an
     * ephemeral key internally and there is no exposed owner key. Every
     * identity-dependent path (control node creation, self-record signing, strand
     * launch) reads this resolved field, never `config.privateKey` directly.
     */
    private identityKey;
    /**
     * Node-local, NON-replicated trusted-owner anchor (see
     * `trusted-owner-store.ts`). Constructed (or adopted from
     * `config.trustedOwners.store`) by {@link initializeTrustedOwnerStore} during
     * {@link start}; deliberately NOT cleared by {@link cleanup}, so an in-memory
     * anchor survives a stop()→start() cycle of the same node instance. Never
     * sourced from replicated control state.
     */
    private trustedOwnerStore;
    private controlNode;
    private controlDatabase;
    /**
     * The CONTROL network's peer-join block catch-up — same module as the
     * per-strand ones, but membership-gated (see {@link startControlBackfill}).
     * Created in {@link start} after the control node and database are up, stopped
     * and dropped in {@link cleanup} before either is torn down, so a stop()→
     * start() cycle rebuilds it with a fresh caught-up-peer memo.
     */
    private controlBackfill;
    private strandWatcher;
    private strandManager;
    private hibernationManager;
    private enrollmentService;
    private seedBootstrapService;
    private strandSolicitationService;
    private strandWakeService;
    /**
     * Control-network strand-address responder. Answers a co-cadre sibling's
     * on-demand request for this node's live strand-network multiaddrs so the
     * sibling can seed a strand mesh from us — the read side of the seed path that
     * stops conflating control addresses with strand seeding.
     */
    private strandAddrService;
    /**
     * Server-side push-wake fan-out. Constructed by {@link start} only when
     * `config.push` (an injected `PushNotifier` + policy) is present — without it
     * the node behaves exactly as before (no notifier, no fan-out). Owns who/when
     * to wake hibernating mobile peers on strand activity.
     */
    private pushFanoutService;
    /** Backing field for the {@link running} / {@link isRunning} getters. */
    private _running;
    /**
     * The control database's own raw storage (cache-wrapped), resolved once per
     * `start()` and released in {@link cleanup}. Owning it is what keeps the
     * provider call for the control scope — `controlStorageScope(partyId)`, see
     * `storage-scope.ts` — a once-per-runtime call: a `stop()` then `start()` cycle
     * on this object re-resolves against a live cache, and never orphans the
     * previous wrapper's registration in the shared cache pool.
     */
    private controlStorage;
    /**
     * In-flight {@link serviceWake} operations keyed by strandId. Coalesces
     * concurrent on-demand wakes for the same strand into one runtime build + one
     * window + one re-hibernate decision (a second caller joins the first's
     * promise), complementing {@link HibernationManager}'s wake coalescing.
     */
    private serviceWakePromises;
    /**
     * Live wake-window waiters (see {@link holdWakeWindow}). Tracked so
     * {@link cleanup} can clear the timer AND resolve the promise on teardown — a
     * window must never fire (or hang an in-flight serviceWake) after stop().
     */
    private windowWaiters;
    private eventHandlers;
    /**
     * Relay multiaddrs the caller asked {@link reserveRelays} to reserve through —
     * or, on a node that names `network.relayAddrs`, the ones
     * {@link driveControlRelayReservation} asked for at the end of {@link start}.
     * Empty (the default) means neither happened, so {@link getRelayReservationState}
     * reports `none`.
     */
    private relayReserveAddrs;
    /**
     * The running retry loop for {@link relayReserveAddrs}, or `null` when nobody
     * asked for a reservation / there was no control node to supervise. It owns the
     * in-flight flag, the last failure and the next-attempt time; this class only
     * starts it, stops it and reads it.
     */
    private relayReserveSupervisor;
    /**
     * Reason {@link reserveRelays} produced no reservation when there is no
     * supervisor to hold one — i.e. the pre-start `control node unavailable` case.
     */
    private relayReserveError;
    /**
     * True from just before the control libp2p node is created until
     * {@link ControlDatabase.initialize} has settled — the connection gate's
     * BRING-UP QUIET PERIOD (`membership-connection-gater.ts`), during which this
     * node refuses every control connection in both directions.
     *
     * The invariant: the control database is built while this node holds zero
     * control connections. Every same-party sibling connected in that window joins
     * the Optimystic cohort the bring-up's block probes consult, and a sibling that
     * has not yet replicated this node's `CadrePeer` row refuses them all — which
     * fails `start()` outright and cannot be retried into convergence (writing the
     * row that would clear the refusal needs the database being built).
     *
     * Cleared on FAILURE as well as success ({@link cleanup} clears it), so
     * teardown is never gated.
     */
    private controlBringUpInFlight;
    /** Map of strandId -> sAppConfig for sAppId filtering and management */
    private sAppConfigs;
    /**
     * Strands the control network advertises that no local sAppConfig claims — the
     * backlog behind `strand:discovered`. Maintained in {@link handleStrandAdded}
     * (added), {@link addStrand} (claimed), {@link detachStrand} (stopped or its
     * control row vanished) and {@link cleanup}. Read through
     * {@link getDiscoveredStrands}.
     */
    private discoveredStrands;
    /**
     * Whether an unclaimed strand the filter admits is launched as a storage replica
     * ({@link CadreNodeConfig.hostUnclaimedStrands}), resolved once from the config.
     *
     * NOTE: a replica host stores every admitted strand of its party with no quota (Arachnode
     * quotas are unimplemented). Fine at a party's handful of strands; if always-on nodes come
     * to host strands by the hundred, per-strand quotas or a narrower default filter is the lever.
     */
    private readonly hostUnclaimedStrands;
    /**
     * The sApp id each storage replica read from its own `Strand.Header` — {@link getSAppId}'s
     * answer for a strand no local config claims, so an `sAppId` strand filter can reject a
     * replica of some other app instead of admitting it provisionally forever.
     *
     * Cleared by {@link cleanup} only, deliberately NOT by {@link detachStrand}: the watcher's
     * filter rejection stops a replica through that very method, and forgetting the id there
     * would have the next poll find it unknown again, re-admit the strand provisionally and
     * relaunch the replica — once every other poll, forever. A strand id's sApp never changes,
     * and the map is bounded by the strands this party has published, like
     * {@link discoveredStrands}.
     */
    private replicaSAppIds;
    /**
     * Most-recently pushed invite addresses (see {@link setInviteAddresses}).
     * When non-null these take priority over `libp2pNode.getMultiaddrs()` when
     * minting invites — the host pushes NAT-resolved addresses here so the
     * control-network node never needs to dial back to the manager.
     */
    private latestInviteAddresses;
    /**
     * Epoch ms until which the control-network inbound gate admits
     * not-yet-authorized peers (see {@link admitInboundControlConnection} /
     * {@link openEnrollmentWindow}). 0 = no window open. Opened automatically by
     * {@link createInvite}; deliberately NOT reset on stop() — a stop/start cycle
     * inside an outstanding invite's validity must not strand the invitee.
     *
     * NOTE: in-memory only, so a PROCESS restart mid-invite closes the door until
     * the owner re-mints or the invitee is authorized. Fine while invites are
     * short-lived and redeemed promptly; if long-lived invites or restart-prone
     * hosts become normal, persist the window (or derive it from the issued-invite
     * records `SeedBootstrapService` already keeps).
     */
    private enrollmentWindowUntil;
    /**
     * Lazily-parsed PeerIds of `controlNetwork.bootstrapNodes` (see
     * {@link getBootstrapPeerIds}) — infrastructure the inbound gate always admits.
     */
    private bootstrapPeerIds;
    /**
     * Materialized in-memory snapshot of the AUTHORIZED member peer ids (the
     * {@link listAuthorizedMembers} result), consulted by the per-stream
     * control-DB gate ({@link authorizeInboundControlStream}). That predicate
     * runs on EVERY inbound Optimystic control-DB stream and must never await a
     * control-DB read: those reads pull blocks over the very protocols the
     * predicate gates, which closes a circular wait that ends in mutual denial
     * (the upstream gate is fail-closed on timeout, unlike the fail-open
     * connection gater). So the set is refreshed OUT OF BAND instead — after
     * start, on every {@link reconcileControlCohort} pass (15s cadence), and
     * immediately after every LOCAL membership mutation so a just-vouched peer
     * is admitted without waiting for the timer. That last refresh is AUTOMATIC:
     * the control database notifies {@link refreshMembershipGate} after every
     * committed `CadrePeer` write (see `ControlDatabase.mutateCadrePeer`), so no
     * writer has to remember. A change that arrives by REPLICATION is picked up
     * on the next timed refresh — bounded staleness, acceptable because this gate
     * is defense in depth: rows an unadmitted peer manages to write are still
     * disbelieved at read time by the voucher-anchored predicate.
     */
    private authorizedControlPeers;
    /**
     * Coalescing state for {@link refreshMembershipGate}: a pending "the snapshot
     * is stale" flag, the single in-flight drain that consumes it, and the depth
     * of open {@link deferMembershipGateRefresh} scopes (a burst of writes inside
     * one scope collapses to a single refresh at scope exit).
     */
    private membershipGateDirty;
    private membershipGateDrain;
    private membershipGateDeferDepth;
    /**
     * In-memory delegate admission grants (see `delegate-admission.ts`): the
     * strand-node transport peerIds this party's members have announced over the
     * strand-addr RPC, admitted at the CONNECTION and RESERVATION levels so a
     * member's NAT'd strand node can hold a circuit-relay reservation on this
     * node (without spending the unauthorized-reservation budget). Consulted
     * ONLY by {@link admitInboundControlConnection} and
     * {@link admitControlRelayReservation}; the fail-closed per-stream gate
     * ({@link authorizeInboundControlStream}) never honors it.
     */
    private readonly delegateAdmission;
    /**
     * Bounded budget of concurrent circuit-relay reservations granted to peers
     * this node cannot (yet) place as members — the boot-ordering window where a
     * genuine sibling reserves before its `CadrePeer` row has replicated here.
     * Consulted only by {@link admitControlRelayReservation} (the gater's
     * `denyInboundRelayReservation` policy); authorized members and announced
     * delegates are admitted before it and never counted. Cap from
     * `network.unauthorizedRelayReservationCap` (default
     * `MAX_UNAUTHORIZED_RELAY_RESERVATIONS`); entries expire on the relay
     * server's own resolved `reservationTtl` ({@link relayServer}).
     */
    private readonly unauthorizedRelayReservations;
    /**
     * Does this node's CONTROL libp2p run the circuit-relay server, and with which
     * init? Resolved once from `network` and `profile` by the same function every
     * strand node's build uses (`relay-server.ts`). Read by
     * {@link buildControlNodeOptions} (which configures the server from it),
     * {@link admitInboundControlConnection} (whose deny/admit-for-relay branch must
     * agree with whether a reservation is even servable here), and the
     * unauthorized budget above (whose TTL is the server's).
     */
    private readonly relayServer;
    /**
     * When this node last ANNOUNCED a delegate, keyed `<targetPeerId>\n<strandId>`
     * (the peer announced TO, not the delegate). Throttles
     * {@link refreshDelegateGrants} to once per `DELEGATE_GRANT_TTL_MS / 2` per
     * (relay, strand) so the 15 s reconcile tick never becomes per-tick RPC
     * chatter; the launch/resume announce passes record here too. Keys whose
     * strand is no longer running are pruned on each reconcile pass.
     */
    private readonly delegateAnnounceAt;
    /**
     * When each connected sibling is next due a strand-addr RPC for each running
     * strand, keyed `peerStrandKey(siblingControlPeerId, strandId)` → epoch ms; a
     * missing key is due. Bounds {@link refreshStrandPeerAddrs}'s fan-out per
     * (sibling, strand) rather than per strand, so a sibling that connects after a
     * pass is asked on the next 15 s tick instead of waiting out a stamp another
     * sibling's answer set. An answer (even an empty one) makes the sibling due again
     * in {@link STRAND_PEER_ADDR_REFRESH_MS}; no answer, in
     * {@link STRAND_PEER_ADDR_RETRY_MS}. Keys whose strand stopped running or whose
     * sibling is no longer connected are pruned every pass, so a resumed strand and a
     * reconnected sibling are both asked at once.
     */
    private readonly strandAddrAskDueAt;
    /**
     * Node-local strand peer book (see `strand-peer-book.ts`): per strand, the strand
     * peers this node has met and their last-known strand-network addresses. Three
     * writers: {@link recordFormationStrandPeers} files the responder's live strand
     * addrs a formation result carried back (`FormationResultMessage.strandAddrs`),
     * {@link observeStrandPeer} files every strand peer a running strand node
     * identifies, and the per-strand book swap (`strand-peer-book-swap.ts`, handed the
     * store as `StartStrandConfig.strandPeerBook`) files the node's own signed entry
     * plus every signed entry a strand peer sends it — the only writer whose entries
     * carry a signature, and the only one that can refresh a peer's addresses without
     * meeting that peer. Read by {@link resolveCohortSeed} (launch + hibernation resume) and
     * re-merged by every {@link refreshStrandPeerAddrs} pass, which is what keeps the
     * entries alive past the peerStore's one-hour address expiry.
     *
     * This is the ONLY cross-party discovery input there is. The strand-addr RPC that
     * resolves a strand's addresses is membership-gated and answers own-party siblings
     * only, so without the book a joiner's cohort seed for a two-party strand is empty
     * and the mesh never forms — and, with an in-memory book, never RE-forms after a
     * restart (gotchoices/sereus#18). A STORE rather than a map so an embedder can make
     * it outlive the process; constructed (or adopted from `config.strandPeers.store`)
     * by {@link initializeStrandPeerBookStore} during {@link start}, deliberately NOT
     * cleared by {@link cleanup}, so it survives a stop()→start() cycle of the same node
     * instance — same lifecycle as {@link bootstrapPeerStore}.
     *
     * Entries survive a {@link stopStrand} (a stopped strand may be claimed again with
     * {@link addStrand}, and is rediscovered on restart) and are forgotten by
     * {@link unpublishStrand}, {@link forgetJoinedStrand} and self-revocation; the store
     * ages the rest out after 14 days and caps each strand at 16 peers, so the book is
     * bounded by time and by the strands this node runs rather than by its history.
     */
    private strandPeerBookStore;
    /**
     * PENDING strand membership invitations learned at formation, keyed by strandId — the
     * single-use `Strand.Invite` credential a closed-strand formation result carried back
     * ({@link FormStrandResult.membershipInvite}), waiting for this node's strand bring-up
     * to redeem (`consumeInvite` seats the `Strand.Member` row under this party's own key
     * — the `strand-node-binds-member-peer` half of the party-identity chain).
     *
     * IN-MEMORY, deliberately: an invitation is single-use and short-lived, a restarted
     * joiner that never redeemed it re-forms from scratch, and re-forming issues a fresh
     * one. A re-formation against the same strand REPLACES the entry — the
     * fresh invitation supersedes one that may have expired. The party key the invitation
     * admits, by contrast, IS persisted (`StrandPartyKey`, seated by
     * {@link adoptFormationMembershipInvite} before the entry lands here), so a lost
     * invitation never orphans an identity.
     *
     * INVALIDATION is owned by the strand's bring-up membership reconciler
     * (`strand-membership-reconciler.ts`, wired via `StartStrandConfig.pendingMembershipInvite`
     * in {@link launchStrand}): it deletes the entry once the invitation is redeemed, burned
     * against an already-seated member, or found dead (expired / cancelled / consumed
     * elsewhere / the strand sealed) — naming the invitation it settled, so a re-formation
     * that replaced the entry meanwhile keeps its fresh one
     * ({@link unstageMembershipInvite}). Until the strand is actually launched here the entry
     * just waits; once launched, staging notifies the manager, which re-arms a finished loop.
     *
     * NOTE: entries live for the node's lifetime (one small pair per formed closed
     * strand); the number of keys is bounded only by the strands this node has ever
     * formed, not by time — if a node ever forms strands at scale, evict on
     * `unpublishStrand` / `forgetJoinedStrand` as the strand peer book does.
     */
    private readonly pendingMembershipInvites;
    /**
     * Founder launches refused because the strand was founded before the per-party
     * identity split (`PreSplitStrandIdentityError`), keyed by strandId. Read by
     * {@link issueStrandMembershipInvite}, which rethrows the recorded error so a bound
     * redemption against the strand is rejected as "must be recreated" — not told to retry
     * because the runtime is not live (a refused fresh launch leaves none) or failed by the
     * `Strand.Invite` gate (a refused in-place founding leaves a joiner instance up whose
     * party key is no manager).
     *
     * Written and cleared by {@link launchStrand}; also cleared by {@link detachStrand},
     * {@link unpublishStrand} and {@link cleanup}, so a recreated id starts clean.
     * In-memory: after a restart the next founder launch of the strand records it again;
     * until then issuance still reads the fingerprint off the live rows whenever a runtime
     * is up — only a strand with no runtime at all answers retryably meanwhile.
     */
    private readonly strandLaunchRefusals;
    /**
     * Dial targets learned out of band, keyed by peer id, valued by the multiaddr
     * strings this node was handed (parsed lazily, at dial time). Two writers:
     * {@link recordSeedBootstrapPeers} retains the owner-flagged peers of every seed
     * this node applies, and {@link addDrone} retains the addresses of every node
     * this node adds. Two readers: {@link dialColdStartBootstrap} dials every entry
     * while the control database still has no siblings, and
     * {@link resolveControlDialAddrs} falls back to a sibling's entry when neither
     * its signed record nor the address book yields an address.
     *
     * A STORE rather than a plain map (see `bootstrap-peer-store.ts`), because the
     * targets must outlive the process: a node seeded into a party it could not
     * reach has nothing else on disk naming that party's addresses (`applySeed`
     * writes no control row, and `CadrePeer` fills in only after a connection
     * succeeds), so an in-memory-only set left it stranded permanently across a
     * restart. An owner that added a node it cannot be dialed by is in the same
     * position: the added node's row stays unsigned, so unresolvable, until that
     * node self-publishes over a connection only the owner can open. Constructed (or
     * adopted from `config.bootstrapPeers.store`) by
     * {@link initializeBootstrapPeerStore} during {@link start}; deliberately NOT
     * cleared by {@link cleanup}, so it survives a stop()→start() cycle of the same
     * node instance — same lifecycle as {@link trustedOwnerStore}. Durability
     * depends on the injected backend; the default is in-memory.
     *
     * Deliberately NOT the libp2p peer store, which {@link peerStoreAddrs} already
     * reads for the steady-state path. The peer store is shared with everything
     * libp2p discovers, so "dial every entry" would grow into dialing arbitrary
     * discovered peers as the node lives longer; this store holds exactly the peers
     * an owner-signed, trust-anchored seed nominated as owners, and the nodes this
     * node chose to add. `applySeed` also merges a seed's addresses into the peer
     * store, where they age out; an added node's addresses are never merged there,
     * because only verified addresses go into the address book (see
     * {@link warmSiblingAddrBook}).
     *
     * A later record OVERWRITES an entry rather than merging, so a re-seed after an
     * owner's address changes replaces the stale address instead of accumulating
     * dead ones, and {@link warmSiblingAddrBook} replaces an entry with the addresses
     * the sibling's signed record resolves to when they differ. Only this node's own
     * {@link removePeer} evicts an entry: otherwise they are the node's only way back
     * to those peers if it is ever stranded again.
     */
    private bootstrapPeerStore;
    /**
     * Node-local record of the party's enrolled-machine count (see
     * `enrolled-machine-store.ts`), kept so the CONTROL node can declare a
     * block-repair yardstick at bring-up. Constructed (or adopted from
     * `config.enrolledMachines.store`) by {@link initializeEnrolledMachineStore};
     * written by {@link refreshAuthorizedControlPeers}. Like
     * {@link bootstrapPeerStore} it is deliberately NOT cleared by {@link cleanup},
     * so it survives a stop()→start() cycle of the same node instance.
     */
    private enrolledMachineStore;
    /**
     * Node-local record of the strands this node joined from ANOTHER party and has not yet
     * published party-wide (see `joined-strand-store.ts`). Written by {@link formStrand}
     * and by an {@link addStrand} of a foreign row; drained once the party-wide
     * `JoinedStrand` row is visible. Adopted from `config.joinedStrands.store`, else built over
     * `config.keyStore`, else in-memory, by {@link initializeJoinedStrandStore}. Like
     * {@link bootstrapPeerStore} it is deliberately NOT cleared by {@link cleanup}.
     */
    private joinedStrandStore;
    /**
     * This session's joined strands: {@link joinedStrandStore} and the party-wide
     * `JoinedStrand` table, unioned with the control rows each watcher poll, published and
     * removed by the reconcile pass. Per SESSION, unlike the store — rebuilt at every
     * {@link start}, which is what ends a revoked join's "keep offering until this session
     * ends" (see `JoinedStrandSession.forgetAfterThisSession`).
     */
    private joinedStrands;
    /**
     * The enrolled-machine count this node's CONTROL libp2p node was (or will be)
     * built with — read out of {@link enrolledMachineStore} during {@link start},
     * before {@link createControlNode}, and consumed by
     * {@link buildControlNodeOptions}.
     *
     * A captured FIELD rather than a live `store.count()` read, deliberately: the
     * store moves as membership changes, but Optimystic froze the policy when the
     * node was built, so this field is the honest answer to "what did this node
     * actually declare?" and does not drift away from the running node. It is
     * re-read on each {@link start}, which is what makes a stop()→start() cycle pick
     * up a count recorded during the previous run.
     *
     * `undefined` — a brand-new node, an unreadable slot, or the ephemeral default
     * store — means "this node does not know", which `controlClusterPolicy` answers
     * with the frozen base policy itself.
     */
    private declaredEnrolledMachines;
    /** Initial self-registration timer (see {@link scheduleSelfRegistration}). */
    private selfRegistrationTimer;
    /** TTL heartbeat that re-publishes the self record before it goes stale. */
    private recordRefreshTimer;
    /** Listener that re-publishes the self record when reachable addresses change. */
    private selfPeerUpdateHandler;
    /**
     * Recurring proactive control-cohort dial cadence (see
     * {@link reconcileControlCohort}). Wired alongside {@link recordRefreshTimer}
     * in {@link startRecordRefresh} and torn down symmetrically in
     * {@link stopRecordRefresh}; `.unref()`'d so it never keeps the loop alive.
     */
    private controlCohortReconcileTimer;
    /**
     * Single-flight guard for {@link reconcileControlCohort}. The eager start pass,
     * the recurring interval, and the `self:peer:update` trigger can fire close
     * together; collapsing concurrent passes into one in-flight run prevents two
     * passes from double-dialing the same siblings (mirrors {@link registerSelfInFlight}).
     */
    private reconcileControlCohortInFlight;
    /**
     * Single-flight guard for {@link registerSelf}. Concurrent callers (the explicit
     * CLI `--owner` publish, the 1s startup timer, the TTL heartbeat, and the
     * address-change listener) share one in-flight publish so two of them can never
     * both read "no row yet" and race a duplicate INSERT (a `CadrePeer` PK conflict).
     */
    private registerSelfInFlight;
    /**
     * When this node last PUBLISHED its own `CadrePeer` address record (inserted or
     * refreshed), or null if it never has in this session. Stamped by
     * {@link noteSelfRecordPublished} on every successful publish, wherever it was driven
     * from — the boot pass, the heartbeat, an address change, a drain or an explicit call.
     *
     * Read by {@link escalateIfSelfRecordStale} for the one consequence worth an operator's
     * attention: once this gap exceeds {@link DEFAULT_PEER_RECORD_MAX_AGE_MS}, every other
     * machine in the party is already discarding this node's address as stale.
     */
    private lastSelfRecordPublishAt;
    /** Say-once latch for {@link escalateIfSelfRecordStale}; re-armed by the next publish. */
    private selfRecordStaleWarned;
    /**
     * Re-replication queue for owner `authorizePeer` writes that committed while
     * this node was alone — `controlNode.getConnections().length === 0` at write
     * time means the Optimystic commit was local-only (the block's cluster was ≤1)
     * and never broadcast. Maps the affected subject peerId → 'authorize', to
     * re-issue once the cohort grows. Removals are NOT tracked here — a delete
     * leaves a `Revocation` tombstone, tracked by {@link pendingRevocations}; a
     * removePeer also clears any queued authorize for the same subject (the row is
     * gone, so re-issuing the insert would be wrong). Drained on the 0→≥1
     * control-connection transition by {@link drainPendingControlReplication}.
     */
    private pendingPeerWrites;
    /**
     * Re-replication queue for `Revocation` tombstones that committed while this
     * node was alone, keyed on the retired `StampId`. Fed by the control DB's
     * committed-delete seam ({@link noteGuardedDelete}), so one queue covers all
     * four guarded tables (`CadrePeer` / `DeviceToken` / `Strand` /
     * `ValidationKey`). Drained (owner-signed `ReissuedAt` bump, which re-broadcasts
     * the tombstone) by {@link drainPendingRevocations}. Cleared on stop alongside
     * {@link pendingPeerWrites} — the tombstone rows are durable, so the next
     * lifetime's first-growth sweep re-covers anything dropped here.
     */
    private pendingRevocations;
    /**
     * Guards the once-per-lifetime first-growth revocation sweep (re-issue EVERY
     * locally-held tombstone, covering removals from before this node started).
     * Deliberately separate from {@link reconstructedLocalOnlyWrites} and set only
     * after a sweep pass SUCCEEDS (including the nothing-held case) — a throwing
     * sweep retries on the next growth edge instead of being lost for the lifetime.
     * Reset on stop, so a stop()→start() cycle sweeps again (that second start is
     * exactly a "removals from before this lifetime" case).
     */
    private reissuedHeldRevocations;
    /**
     * Whether this process has seen the singleton `Revocation` ledger marker filed — its own
     * `'opened'` or an `'already-open'` answer, in {@link openRevocationLedgerIfDue}. A
     * record of work done, not a cached authorization answer: the marker can never be
     * deleted (`NoDelete`), so this can only go stale if the database itself is replaced,
     * which is why stop() clears it with the other per-process replication state.
     */
    private revocationLedgerOpened;
    /** This node's own `CadrePeer` self-write committed local-only (re-touched on growth). */
    private pendingSelfPeerWrite;
    /** This node's own `DeviceToken` self-write committed local-only (re-touched on growth). */
    private pendingSelfDeviceWrite;
    /**
     * Guards the one-shot, first-cohort-growth reconstruction: an owner re-touches
     * every membership row it may have authored that could be unreplicated (covering
     * writes made before this process started, which the in-memory queue cannot know).
     * Set true after the first drain so later passes only drain the in-memory queue.
     */
    private reconstructedLocalOnlyWrites;
    /** Single-flight guard for the re-replication drain (mirrors {@link registerSelfInFlight}). */
    private drainControlReplicationInFlight;
    /**
     * Tracks the control-connection presence edge so the drain fires only on the
     * 0→≥1 transition (the earliest point a re-issue can broadcast), not on every
     * subsequent `connection:open`. Re-armed to false once connections return to 0.
     */
    private hasControlConnection;
    /** `connection:open` listener driving the growth-triggered drain (teardown in {@link stopRecordRefresh}). */
    private controlConnectionOpenHandler;
    /** `connection:close` listener re-arming the growth edge (teardown in {@link stopRecordRefresh}). */
    private controlConnectionCloseHandler;
    /**
     * Hooks `globalThis.RTCPeerConnection` to observe whether ICE selected a TURN
     * relay candidate for each WebRTC session. Installed in {@link start}, disposed
     * in {@link cleanup}; inert on Node.js (no `RTCPeerConnection`).
     */
    private readonly turnTracker;
    /**
     * Peer IDs whose current WebRTC connection was observed to be TURN-relayed.
     * Populated by {@link handleTurnConnectionOpen} (drains the tracker queue on a
     * `/webrtc` `connection:open`), cleared per-peer on `connection:close`. Read by
     * {@link getConnectionPaths} to promote `webrtc` → `webrtc-turn` (relayed).
     */
    private turnRelayedPeers;
    /** `connection:open` listener feeding TURN detection (teardown in {@link stopRecordRefresh}). */
    private turnConnectionOpenHandler;
    /** `connection:close` listener clearing a peer's TURN flag (teardown in {@link stopRecordRefresh}). */
    private turnConnectionCloseHandler;
    constructor(config: CadreNodeConfig);
    /**
     * SAppIdLookup implementation - get sAppId for a strand: the claiming config's, else
     * the one a storage replica read from the strand's own `Strand.Header`.
     */
    getSAppId(strandId: string): string | undefined;
    /**
     * Get the peer ID of this node (available after start)
     */
    get peerId(): PeerId | undefined;
    /**
     * The party ID this node serves (control-network identity).
     */
    get partyId(): string;
    /**
     * Get the multiaddrs of this node (available after start)
     */
    getMultiaddrs(): string[];
    /**
     * Check if the node is running
     */
    get isRunning(): boolean;
    /**
     * Synchronous lifecycle snapshot for headless callers (a mobile
     * `BackgroundRunner` that boots in a background task and must *query* state
     * rather than subscribe to `control:connected`/`control:disconnected`).
     * Equivalent to {@link isRunning}.
     */
    get running(): boolean;
    /**
     * Synchronous readiness snapshot: whether the control network is currently
     * connected (the node is running and its control-network libp2p node is up).
     * Tracks the same edge the `control:connected`/`control:disconnected` events
     * announce, but pollable.
     */
    get controlConnected(): boolean;
    /**
     * Classify every open control-network connection as relayed
     * (`/p2p-circuit`) vs direct, tag its transport, and summarise counts plus a
     * stuck-on-relay condition. Pure, read-only snapshot over
     * `controlNode.getConnections()`. Returns an empty (all-zero) summary when
     * the node has not been started.
     *
     * @param settleWindowMs - grace period before a relayed connection with no
     *   direct sibling is considered stuck (default 10_000ms)
     */
    getConnectionPaths(settleWindowMs?: number): ConnectionPathSummary;
    /**
     * Get all strand instances
     */
    getStrands(): Map<string, StrandInstance>;
    /**
     * Strands the control network advertises that no local sAppConfig claims —
     * the backlog behind `strand:discovered`.
     *
     * The event fires once per strand, and it can fire before the app has
     * subscribed (the watcher's first poll runs inside `start()`). So an app that
     * auto-joins discovered strands must subscribe FIRST and then drain this map,
     * not rely on the event alone. Entries leave the map when the strand is
     * claimed ({@link addStrand}) or its control row disappears.
     *
     * Bounded by the number of strands this party has that this node does not run
     * — the control database holds only this party's rows — so there is no cap and
     * no eviction policy to reason about.
     *
     * Returns a snapshot; mutating it does not affect the node.
     */
    getDiscoveredStrands(): Map<string, StrandRow>;
    /**
     * Get a specific strand instance
     */
    getStrand(strandId: string): StrandInstance | undefined;
    /**
     * Get the enrollment service for adding new peers
     */
    getEnrollmentService(): EnrollmentService;
    /**
     * Start the cadre node
     */
    start(): Promise<void>;
    /**
     * Build the server-side push-wake fan-out over an injected {@link PushNotifier}.
     *
     * The notifier reaches for `node:http2`/`node:crypto`, so the cross-platform
     * core never constructs it — the Node host builds it from
     * `@serfab/cadre-core/push-node` and passes the instance in
     * `CadreNodeConfig.push`. This node owns that instance's lifecycle from here:
     * {@link cleanup} closes the fan-out, which closes the notifier (freeing the
     * APNs HTTP/2 session). Every other primitive the fan-out needs (member
     * enumeration, participation, direct dial, token resolve/expire) is an
     * import-clean closure over this node.
     */
    private buildPushFanout;
    /**
     * Stop the cadre node
     */
    stop(): Promise<void>;
    /**
     * Subscribe to events
     */
    on<K extends keyof CadreNodeEvents>(event: K, handler: EventHandler<CadreNodeEvents[K]>): void;
    /**
     * Unsubscribe from events
     */
    off<K extends keyof CadreNodeEvents>(event: K, handler: EventHandler<CadreNodeEvents[K]>): void;
    private emit;
    /**
     * Resolve the node identity into {@link identityKey} exactly once, fail-closed,
     * before any network bring-up. Resolution order:
     *
     * 1. Both `keyStore` and `privateKey` set ⇒ configuration error (throws).
     * 2. `keyStore` set ⇒ {@link loadOrCreateIdentityKey} against `identityKeyId`
     *    (default {@link DEFAULT_IDENTITY_KEY_ID}): load when the slot is present,
     *    generate + persist when it is empty. A rejected `get` (access denied /
     *    backend failure) PROPAGATES — we never generate a new key on a read error,
     *    which would silently orphan the real identity.
     * 3. `privateKey` set ⇒ use it directly.
     * 4. Neither ⇒ leave undefined; libp2p generates an ephemeral key.
     *
     * Idempotent: a second call (or a stop()→start() cycle) reuses the already
     * resolved key rather than regenerating or re-persisting.
     */
    private resolveIdentityKey;
    /**
     * Construct (or adopt) the node-local trusted-owner anchor and seed the
     * out-of-band pinned keys from `config.trustedOwners`. The store is NEVER
     * sourced from the replicated control DB — its entries come only from
     * genesis self-trust ({@link initializeSeedBootstrap}), config pins (here),
     * or runtime enrollment pins ({@link trustOwnerKeys}).
     *
     * Idempotent across stop()→start(): the store instance is kept, and
     * re-seeding config pins is a no-op ({@link TrustedOwnerStore.trust} is
     * idempotent). An injected store scoped to a different party is a
     * configuration error (fail closed before any network bring-up).
     */
    private initializeTrustedOwnerStore;
    /**
     * Construct (or adopt) the node-local cold-start bootstrap-peer store (see
     * {@link bootstrapPeerStore}). Synchronous: an injected store has already
     * loaded its persisted targets by the time it is handed in (its `open` is the
     * async part), and the in-memory fallback has nothing to load.
     *
     * Idempotent across stop()→start(): the store instance is kept, so retained
     * targets survive a restart of the same node instance even with the ephemeral
     * default. An injected store scoped to a different party is a configuration
     * error (fail closed before any network bring-up) — a foreign party's addresses
     * must never enter this node's dial loop.
     */
    private initializeBootstrapPeerStore;
    /**
     * Construct (or adopt) the node-local enrolled-machine store and capture the
     * count this run will declare into {@link declaredEnrolledMachines}.
     *
     * Synchronous for the same reason {@link initializeBootstrapPeerStore} is: an
     * injected store has already loaded its persisted count by the time it is handed
     * in (its `open` is the async part), and the in-memory default has nothing to
     * load. Must run BEFORE {@link createControlNode} — that is the whole point of
     * the record; see `enrolled-machine-store.ts`.
     *
     * The store instance is kept across stop()→start() (so a count recorded during
     * the previous run is not lost with the ephemeral default), but the DECLARED
     * count is re-read every time — which is how a restart applies a number the
     * previous run learned.
     *
     * A store scoped to a different party is a configuration error, fail closed. It
     * is only a repair hint, but a hint sized by a foreign party's membership is a
     * number nobody chose, and the mismatch always means a miswired embedder.
     */
    private initializeEnrolledMachineStore;
    /**
     * Construct (or adopt) the node-local joined-strand store (see
     * {@link joinedStrandStore}) and this session's {@link joinedStrands} over it.
     *
     * The store instance is kept across stop()→start(); the view is rebuilt. A store
     * scoped to a different party is a configuration error, fail closed: its joins
     * would be offered to this party's app as if this party had made them.
     */
    private initializeJoinedStrandStore;
    /**
     * Construct (or adopt) the node-local strand peer book (see
     * {@link strandPeerBookStore}). Synchronous for the reason
     * {@link initializeBootstrapPeerStore} is: an injected store has already loaded its
     * persisted entries by the time it is handed in, and the in-memory fallback has
     * nothing to load. The instance is kept across stop()→start(). A store scoped to a
     * different party is a configuration error, fail closed: another party's strand
     * peers must never enter this node's dial loop.
     */
    private initializeStrandPeerBookStore;
    /**
     * The node-local enrolled-machine store (null before {@link start}) — what this
     * node last knew about its party's size. Exposed for diagnostics and for a host
     * that wants to show which repair yardstick the next launch will declare.
     */
    getEnrolledMachineStore(): EnrolledMachineStore | null;
    /**
     * The node-local bootstrap-peer store (null before {@link start}) — the dial
     * targets learned out of band that {@link reconcileControlCohort} falls back to.
     * Exposed for diagnostics and for a host that wants to show "what would this
     * node dial if it is stranded?".
     */
    getBootstrapPeerStore(): BootstrapPeerStore | null;
    /**
     * The node-local strand peer book (null before {@link start}) — per strand, the
     * strand peers this node dials first on launch, resume and refresh. Exposed for
     * diagnostics and for a host that wants to show "whom would this strand re-find
     * after a restart?".
     */
    getStrandPeerBookStore(): StrandPeerBookStore | null;
    /**
     * The node-local trusted-owner anchor (null before {@link start}). This is
     * the set the authorized-membership predicate and seed-trust anchor consult —
     * never the replicated `OwnerKey` table, which any stranger can pollute.
     */
    getTrustedOwnerStore(): TrustedOwnerStore | null;
    /**
     * Persist out-of-band-established owner keys into the node-local anchor —
     * the runtime enrollment seam: call with `CadreInvite.ownerKeys` when
     * redeeming an invite (BEFORE the first `applySeed`, so the anchor already
     * holds the pins when seed trust consults it), or with an operator-supplied
     * pin. Idempotent. ('genesis' provenance is reserved for the node's own
     * founding key, seeded internally by {@link initializeSeedBootstrap}.)
     *
     * Validates every key's shape before trusting any of them (all-or-nothing):
     * a malformed entry anywhere in `keys` rejects the whole call before a
     * single key is anchored. For the invite route this means a `CadreInvite`
     * carrying one malformed `ownerKeys` entry fails the redemption outright —
     * consistent with the anchor's existing whole-record-or-nothing policy for
     * a corrupt persisted entry (see `trusted-owner-store.ts`'s
     * `unusableEntry: 'discard-all'`) — rather than silently anchoring a subset
     * and leaving the caller to notice a key went missing.
     */
    trustOwnerKeys(keys: Iterable<string>, source: Exclude<TrustSource, 'genesis'>): Promise<void>;
    private createControlNode;
    /**
     * The control libp2p node's Optimystic network name — ONE binding for every
     * derivation from it (`db-p2p` namespaces all of the node's protocol ids as
     * `/optimystic/<networkName>/...`), so the node options and the block-transfer
     * protocol prefix the control backfill dials can never drift apart.
     *
     * NOTE: the party id goes in UNENCODED here, unlike in `controlStorageScope`. Safe
     * today because a party id is locally configured rather than replicated in, and both
     * ends of a connection derive this string identically — an odd party id yields an odd
     * but consistent protocol id, not a mismatch or an escaped name. If a party id ever
     * arrives from the network, encode it here as the storage scope key already does.
     */
    private controlNetworkName;
    /**
     * Arm the CONTROL network's peer-join block catch-up: push every block in the
     * control database's own raw store to each newly connected AUTHORIZED member
     * this runtime has not yet caught up. This is what physically replicates
     * control blocks committed while the writer was alone — the named
     * collection-header blocks written once at genesis above all, whose revision
     * never moves again, so no later commit ever carries them to a member that
     * joined after them. Without it, such a member that restarts offline reads
     * the affected control tables as EMPTY, silently (`isMember()` answers false
     * for peers it knew about before the restart).
     *
     * Unlike the per-strand instances (see `strand-instance-manager.ts`), pushes
     * are gated on {@link isAuthorizedMember}, judged at push time: the control
     * network's inbound connection gate deliberately admits non-members in
     * several states (seed delivery to an un-enrolled node, an open enrollment
     * window, an outstanding invitation, configured bootstrap/relay peers), and
     * pushing the whole control store to such a peer would hand a stranger the
     * party's entire membership, addresses and strand list. The receiving side
     * needs no work of its own: `createLibp2pNode` registers the block-transfer
     * handler on every node it builds, control node included, and this node's
     * per-stream gate (`authorizeInboundControlStream`) covers the inbound
     * direction. A denied peer is retried on its next `peer:identify` (a
     * reconnect re-runs identify), and — because the production join order is
     * connect-then-authorize — on every committed membership change via
     * {@link refreshAuthorizedControlPeers}'s `scheduleConnectedPeers()` call.
     *
     * No-ops (logged) when the embedder configured no control storage or the
     * node exposes no key network — the backfill would have nothing to read or
     * no way to dial.
     */
    private startControlBackfill;
    /**
     * The control database's cache-wrapped raw storage, resolved from
     * `config.storage.provider` on first use and then held in {@link controlStorage}
     * for the rest of this runtime.
     *
     * Resolving once is the contract `RawStorageProvider` (types.ts) states: a provider is
     * called once per scope per runtime lifetime. Re-entering it per call would mint a
     * second store over one backend — a fresh, cold cache, with the previous wrapper's
     * registration orphaned in the process-wide pool.
     *
     * Lazy rather than eager in `start()` so the pure-unit call path
     * (`cadre-node-control-node-options.spec.ts` calls `buildControlNodeOptions` on a
     * bare `new CadreNode`) still resolves — and, on that path too, only once.
     *
     * Wrapped in the write-through raw-storage cache (quereus-plugin-sereus's
     * `cached-storage.ts`) because a control start's cost is its raw-storage
     * operation count.
     */
    private resolveControlStorage;
    /**
     * Warn the operator when `network.announceAddrs` will silently cost this node the
     * relay reachability it also configured.
     *
     * A non-empty announce set REPLACES everything libp2p advertises, so the
     * `/p2p-circuit` address earned by a relay reservation is dropped from the node's
     * advertised addresses even though the reservation itself is still held — peers
     * behind NAT stop being able to reach it through that relay. Not an error: an
     * operator whose relay slot is decorative may genuinely want only the announced
     * address, so this reports and proceeds.
     *
     * Keyed off `relayAddrs` AND `listenAddrs`, so a hand-written `/p2p-circuit` entry
     * in `listenAddrs` — a reservation by the longer route — is caught too.
     *
     * NOTE: the only direct `console.*` in this library — a boot-time operator warning, not a
     * diagnostic trace (those use `debug`, which an operator never sees without `DEBUG=`). If a
     * second such warning ever appears here, route both through a `CadreNodeEvents` entry the
     * embedder surfaces instead of growing a console surface inside a library.
     */
    private warnIfAnnounceAddrsDiscardRelay;
    /**
     * Map this node's config onto the control network's libp2p node options.
     *
     * Split out of {@link createControlNode} purely so the mapping is assertable without
     * standing up a real libp2p node — `packages/cadre-core/test/cadre-node-control-node-options.spec.ts`
     * calls it on a bare `new CadreNode(config)`. Read nothing else into the split; the
     * only caller in production is `createControlNode`.
     */
    private buildControlNodeOptions;
    /**
     * One debug line naming what this machine's relay server forwards and holds —
     * the same fields the dedicated relay container prints at boot
     * (`ops/docker/libp2p-infra/src/main.ts`). Once per start, not per strand:
     * strand nodes resolve the same settings from the same config.
     */
    private logRelayServerSettings;
    /**
     * Decide whether an inbound CONTROL-network connection from `remotePeerId`
     * should be admitted — the policy behind the connection gater wired in
     * {@link createControlNode}. Deny only on a positive "unauthorized outsider
     * while no stranger path is open" determination; everything ambiguous admits
     * and defers to the fail-closed per-stream gates (see
     * `membership-connection-gater.ts` for the layer's rationale and the
     * stranger-open protocol allowlist).
     *
     * Returns `'admit'` when ANY of:
     *  1. a shared-baseline check admits ({@link admitControlPeerUnconditionally}
     *     — not running / DB torn down, absent-or-empty trusted-owner anchor, or
     *     configured bootstrap/relay infrastructure);
     *  2. an enrollment window is open ({@link openEnrollmentWindow}, opened by
     *     {@link createInvite}) — the invitee dials in before it is authorized;
     *  3. the peer holds a live DELEGATE ADMISSION GRANT — an authorized member
     *     announced it (over the strand-addr RPC) as the transport peerId of its
     *     own strand node, so a NAT'd member's strand node can hold a
     *     circuit-relay reservation here (see `delegate-admission.ts`).
     *     Connection only: the per-stream gate below never honors a grant;
     *  4. the authorized-member set is empty — cold start: the rows that would
     *     authorize anyone arrive by replication over these very connections;
     *  5. the peer IS an authorized member; or
     *  6. an open invitation is OUTSTANDING — at least one unexpired,
     *     not-fully-consumed invitation this node minted or persisted (see
     *     `StrandSolicitationService.hasOutstandingInvitation`). A formation
     *     initiator is another party's peer by design and its token is only
     *     checkable inside the protocol, so the gate asks the coarser question
     *     "does this node expect a stranger at all?". Merely REGISTERING the
     *     responder ({@link initializeStrandSolicitation}) no longer suspends
     *     stranger denial — eager registration (as `reference-app-rn` does at
     *     bring-up) and `formStrand`'s lazy initialization both leave the gate
     *     armed, because neither mints an invitation.
     *
     * Ordering is semantically free (the checks are OR'd) but decides who pays:
     * checks 1-3 are in-memory, 4/5 share one control-DB read, and only a peer
     * already on the deny path reaches check 6's invitation lookup.
     *
     * Caveats of check 6, both self-healing:
     *  - the in-memory mint registry dies with the process, so after a restart
     *    only invitations persisted as `FormationInvite` rows still hold the
     *    exemption open (re-mint otherwise — same story as the enrollment window);
     *  - a peer holding a token whose `FormationInvite` row has not replicated to
     *    this node yet is denied even though the formation handler would have
     *    accepted it, exactly like the unreplicated-membership-row case below.
     *
     * When every check falls through, the verdict depends on whether this node
     * runs the circuit-relay server ({@link relayServer}): without one,
     * `'deny'`; with one, `'admit-for-relay'` — a circuit-relay reservation is
     * established by the reserving peer DIALING the relay, so a connection deny
     * here kills the reservation, and that deny is NOT self-healing: an outbound
     * reconcile re-dial re-establishes a data link, but no outbound dial can
     * grant the remote peer a reservation, and a relay-only peer has no address
     * of its own to dial back — the reservation IS its address. The gater admits
     * such a connection, decides the reservation via
     * {@link admitControlRelayReservation}, and drops the connection if no
     * reservation is admitted in time (see `membership-connection-gater.ts` →
     * "The relay-reservation seam").
     *
     * NOTE: check 4/5 runs a control-DB read per inbound connection
     * (`listAuthorizedMembers`); connections are rare and cadres small, and this
     * layer is fail-open behind `ADMISSION_DECISION_TIMEOUT_MS`, so the live
     * read is safe here — unlike the per-stream gate, which must consult the
     * materialized {@link authorizedControlPeers} snapshot instead.
     * NOTE: on a relay-DISABLED node, a sibling whose membership row has not yet
     * replicated here is denied until the row converges (typically via the
     * owner); either side's next outbound reconcile dial (outbound is never
     * gated) re-establishes the DATA link — self-healing for data, visible as a
     * transient deny. That self-healing story never covered a reservation, which
     * is exactly why the relay-enabled path above exists.
     */
    private admitInboundControlConnection;
    /**
     * Should `remotePeerId` be granted a circuit-relay reservation slot on this
     * node's relay server? The policy behind the gater's
     * `denyInboundRelayReservation` hook (see `membership-connection-gater.ts` →
     * "The relay-reservation seam"); the circuit-relay server consults it per
     * RESERVE request, so it is never called on a node whose relay server is off.
     *
     * Admits when ANY of:
     *  1. a shared-baseline check admits ({@link admitControlPeerUnconditionally}
     *     — not running / DB torn down, absent-or-empty trusted-owner anchor, or
     *     configured bootstrap/relay infrastructure);
     *  2. the peer holds a live delegate admission grant — a member's strand
     *     node reserving here (see `delegate-admission.ts`); never counted
     *     against the unauthorized budget;
     *  3. the authorized-member set is empty (cold start) or the peer IS an
     *     authorized member — members are never counted against the budget; or
     *  4. the peer takes (or already holds) a slot in the bounded
     *     unauthorized-reservation budget — the boot-ordering window where a
     *     genuine member reserves before its `CadrePeer` row replicates here.
     *     Cap via `network.unauthorizedRelayReservationCap` (0 = refuse every
     *     unauthorized reservation).
     *
     * Every uncounted admission also RELEASES the budget slot the peer may hold
     * from an earlier reservation taken while it was still unplaceable — a member
     * that boots, reserves, and only then has its row replicate here would
     * otherwise keep that slot spent for the rest of the entry's TTL.
     *
     * The connection gate's stranger carve-outs (an open enrollment window, an
     * outstanding formation invitation) deliberately do NOT extend here: they
     * exist so a stranger's SEED or FORMATION stream can ride a connection, and
     * neither needs relay capacity. A genuine invitee that does need a relay slot
     * takes one from the budget like any other unplaced peer, so an open window
     * never becomes an unbounded grant of this node's forwarding capacity.
     */
    private admitControlRelayReservation;
    /** Admit a reservation on the peer's own merits, giving back any budget slot it still holds. */
    private admitReservationUncounted;
    /**
     * Hold the control-network inbound gate open for not-yet-authorized peers
     * until `untilEpochMs` (extends, never shrinks, an already-open window).
     * {@link createInvite} calls this automatically; a host running an
     * out-of-band enrollment flow (e.g. accepting a phone whose invite this node
     * never minted) can open it explicitly before the stranger dials in.
     */
    openEnrollmentWindow(untilEpochMs: number): void;
    /**
     * Record (or refresh) a delegate admission grant: `delegatePeerId` is the
     * transport peerId of `announcerPeerId`'s strand-`strandId` node, admitted
     * at the CONNECTION and RESERVATION levels (all a circuit-relay reservation
     * needs, without spending the unauthorized-reservation budget) for
     * `DELEGATE_GRANT_TTL_MS`. Called by the strand-addr responder after its
     * authorized-membership gate has passed; public so tests can drive the
     * admission policy without a full strand launch. A re-announce for the same
     * (announcer, strand) REPLACES the previous delegate rather than
     * accumulating. Never honored by {@link authorizeInboundControlStream}.
     */
    grantDelegateAdmission(announcerPeerId: string, strandId: string, delegatePeerId: string): void;
    /** Is `remotePeerId` covered by a live delegate admission grant? */
    hasDelegateAdmission(remotePeerId: string): boolean;
    /**
     * The admission checks SHARED by the connection gate
     * ({@link admitInboundControlConnection}) and the per-stream control-DB gate
     * ({@link authorizeInboundControlStream}) — factored so the two layers cannot
     * drift. All in-memory and cheap (the stream gate runs this per inbound
     * stream). Returns true when the peer must be admitted BEFORE any membership
     * source is consulted:
     *  - the node is not fully up (`start()` in progress / DB torn down) — both
     *    gates exist from libp2p bring-up, before the control DB does;
     *  - the trusted-owner anchor is absent or empty — an un-enrolled node has
     *    no basis to judge anyone and MUST accept its enrollment seed;
     *  - the peer is one of the configured control bootstrap/relay nodes —
     *    operator-configured infrastructure, not cadre members.
     * False only means "no unconditional admit": the caller then judges the peer
     * against its own membership source (a live DB read for the fail-open
     * connection gate; the materialized snapshot for the fail-closed stream gate).
     */
    private admitControlPeerUnconditionally;
    /**
     * Per-stream authorization for the four Optimystic control-DB protocols
     * (`/optimystic/control-<party>/{repo,cluster,sync,block-transfer}/…`),
     * wired as `authorizeInboundStream` in {@link createControlNode} — the
     * fail-closed layer behind the fail-open connection gater. Control node
     * ONLY: strand cohort nodes legitimately serve cross-party peers.
     *
     * The STRICT SUBSET of {@link admitInboundControlConnection}: the same
     * "no basis to judge" admissions (shared via
     * {@link admitControlPeerUnconditionally}), minus the stranger carve-outs
     * (enrollment window, outstanding open invitation, delegate admission
     * grant). The first two exist so a stranger can reach `/sereus/seed/1.0.0`
     * and `/sereus/formation/1.0.0` — neither is gated here, and admitting a
     * stranger to `repo` during an enrollment window is exactly the hole this
     * gate closes. A DELEGATE-admitted connection (a member's strand node
     * holding a circuit-relay reservation, see `delegate-admission.ts`) is
     * likewise exactly a case this gate must still refuse: the delegate gets
     * the connection and never the control DB.
     *
     * Admits when ANY of:
     *  1. a shared-baseline check admits (not running / no DB, empty anchor,
     *     configured bootstrap infra);
     *  2. the materialized authorized set is empty — cold start, before the
     *     rows that would authorize anyone have replicated in;
     *  3. the peer IS in the materialized authorized set.
     *
     * Deliberately SYNCHRONOUS and pure in-memory — see
     * {@link authorizedControlPeers} for why a control-DB read here would
     * deadlock into mutual denial. With a sync predicate the upstream deadline
     * (`authorizeInboundStreamTimeoutMs`) never trips, so it stays at its
     * default.
     *
     * NOTE: the snapshot keys on PEER ID, so a node with no persistent identity
     * key never lands a `CadrePeer` row ({@link registerSelf} skips) and its
     * siblings deny its control-DB streams once their own snapshot is non-empty —
     * owner status is a KEY, not a peer id, so being the owner does not exempt it.
     * Harmless today (a real deployment persists its identity; the ephemeral-owner
     * case appears only in tests, which configure the owner as bootstrap infra —
     * `push-wake-e2e.integration.ts` design note 3). If an ephemeral-identity node
     * ever becomes a supported deployment, this gate needs a key-based admission.
     */
    private authorizeInboundControlStream;
    /**
     * Refresh {@link authorizedControlPeers} from the control DB, best-effort: a
     * failed read keeps the previous snapshot (never clears it), so a transient
     * DB error can neither flip the stream gate's cold-start carve-out back open
     * nor drop a legitimate member mid-flight. Never rejects.
     *
     * The SOLE caller is {@link drainMembershipGate}, which serializes refreshes —
     * so two reads can no longer settle out of order.
     *
     * Reads WITHOUT the transient-failure retry, deliberately: `ControlDatabase` drives
     * this listener with its write lock HELD (`notifyMembershipChanged`), so a retrying
     * read here would sleep its backoff holding the lock and stall every other local
     * writer. Nothing is lost — this refresh already keeps the previous snapshot on
     * failure and is re-driven by the next membership write and by the timed reconcile.
     */
    private refreshAuthorizedControlPeers;
    /**
     * PeerIds of the configured control bootstrap nodes (relay/bootstrap
     * infrastructure — always admitted inbound). Parsed once, lazily; an
     * address without a `/p2p/<id>` component contributes nothing.
     */
    private getBootstrapPeerIds;
    /**
     * What the strand watcher polls: this party's control rows plus a row per cross-party
     * join (see {@link joinedStrands}), so a joined strand is offered and relaunched on
     * the same path as the party's own.
     */
    private createStrandQueryable;
    /**
     * The party-wide `JoinedStrand` table as {@link joinedStrands} reads and writes it.
     * Reads {@link controlDatabase} at call time, so start-up order does not matter.
     */
    private createPartyJoinedStrandLedger;
    /**
     * This machine's owner signing key when it can make owner-gated control writes: its seed
     * bootstrap holds an owner key (`SeedBootstrapService.canAuthorize`) and the party's
     * `OwnerKey` table enrolls it. A phone that ran self-genesis after another machine
     * founded the party passes the first test and not the second (`runOwnerGenesis` in the
     * reference apps), and a write it signed would only be refused.
     */
    private enrolledOwnerSigningKey;
    /**
     * Schedule the node's initial self-record publish + ongoing refresh shortly
     * after start (non-blocking). {@link registerSelf} is idempotent and safely
     * no-ops when it cannot yet sign/insert (e.g. owner key not installed),
     * so the timer is harmless even when registration only becomes possible later.
     */
    private scheduleSelfRegistration;
    /**
     * Publish (or refresh) this node's own signed `CadrePeer` address record so
     * other members can resolve its current signaling/relay multiaddrs from its
     * PeerId alone. Public, awaitable, and idempotent.
     *
     * - Builds a `PeerAddressRecord` from the node's current dialable addrs
     *   (signaling/`p2p-circuit` first), signed with the ed25519 key behind its
     *   PeerId (the resolved node identity from `keyStore`/`config.privateKey`).
     * - If the row already exists: a self-signed UPDATE bumping `UpdatedAt`.
     * - If not, and the node is its own owner: an owner-signed INSERT that
     *   also carries the self-signature. That INSERT is idempotent, so if an owner
     *   {@link authorizePeer} of this node's own id seated the row inside the
     *   read-then-insert window it no-ops — the publish then falls through to the
     *   UPDATE path (re-reading and re-signing against the row that landed) rather
     *   than leaving the authorize's null `Sig` in place, and reports `refreshed`.
     * - Otherwise: logs and returns (a non-owner node with no row yet must
     *   wait for an owner to insert it; it can then self-refresh).
     *
     * Safe to call repeatedly (heartbeat / address-change driven); each successful
     * publish strictly increases `UpdatedAt`. Concurrent calls are collapsed into a
     * single in-flight publish (see {@link registerSelfInFlight}) so the explicit
     * startup publish and the background timers can never race a duplicate INSERT.
     *
     * @returns what the publish did — `inserted`, `refreshed`, or `skipped`.
     */
    registerSelf(): Promise<SelfRegistrationOutcome>;
    /** The body of {@link registerSelf}; serialised by its single-flight guard. */
    private publishSelfRecord;
    /**
     * Record that this node's own address record just landed, and re-arm the stale-record
     * warning. Called from BOTH publishing paths of {@link publishSelfRecord} and nowhere
     * else — a `skipped` publish wrote nothing, so it must not refresh the stamp.
     */
    private noteSelfRecordPublished;
    /**
     * Report an abandoned control write to the embedding app.
     *
     * Every control write funnels through `ControlDatabase.lockedWithRetry`, which now tells
     * this node when it gives one up. Foreground writes ALSO reject to their caller; the
     * background ones ({@link startRecordRefresh}'s republish and the two replication
     * drains) are fired unawaited with a `debug`-only catch, so this event is the only thing
     * that reaches an app at all.
     *
     * Reporting only — the one operator-visible escalation lives on the republish path
     * ({@link escalateIfSelfRecordStale}), where the consequence is measurable.
     */
    private noteControlWriteAbandoned;
    /**
     * Escalate ONE failed self-address republish to the operator — once — when the node has
     * not published its own record for longer than a record stays fresh.
     *
     * The bar is the CONSEQUENCE, not a failure count: a resolver discards a `CadrePeer`
     * record older than {@link DEFAULT_PEER_RECORD_MAX_AGE_MS} (15 minutes) and the heartbeat
     * re-stamps at half that, so by the time this gap opens every other machine in the party
     * has already stopped accepting this node's address. A count would fire far too early —
     * one failed heartbeat is already half the budget, and a single miss costs nothing.
     *
     * Say-once, re-armed by the next successful publish ({@link noteSelfRecordPublished}), so
     * a node that stays broken warns once rather than every 7.5 minutes.
     *
     * A node that has never published in this session is skipped: it has no record out there
     * to go stale, and the reason it has none (not a member yet, no signing key, revoked) is
     * already logged by `registerSelf` itself.
     *
     * Only a FAILED republish is checked. A heartbeat whose publish reports `skipped` neither
     * stamps nor warns, so a node that stops being able to publish without erroring — revoked,
     * or its row removed — goes quiet here. That is the intended reading: a revoked node has
     * nothing to publish and its unreachability is the point, not a fault to report.
     *
     * NOTE: the second `console.*` in this library, and the reason
     * {@link warnIfAnnounceAddrsDiscardRelay}'s note says a third should not simply be added:
     * both are operator warnings about a configuration/health condition an embedder cannot
     * see otherwise, and both have an event beside them (`control:write-abandoned` carries
     * the underlying write failure). A third such condition should surface through
     * {@link CadreNodeEvents} alone unless it likewise degrades the whole party in silence.
     */
    private escalateIfSelfRecordStale;
    /**
     * Sign this node's address record for publication, stamped strictly later than
     * `existing` (the row it is about to replace, or null for a first insert) so a
     * same-millisecond re-publish still satisfies the monotonic `UpdatedAt` rule the
     * `CadrePeer.AuthorizedUpdate` self-branch enforces.
     */
    private signSelfRecord;
    /**
     * The ed25519 keypair (base64url) the node signs its own record with — the key
     * behind its libp2p PeerId. Sourced from the resolved {@link identityKey}
     * (which a `keyStore` or `config.privateKey` supplies); returns null when
     * absent (ephemeral identity) or (defensively) when it does not match the
     * control node's PeerId, in which case self-publish is skipped rather than
     * producing an unresolvable row.
     */
    private getSelfSigningKey;
    /**
     * Does the `Strand` row name THIS machine as its founder — i.e. is its
     * `FounderOwnerKey` this node's own owner key (the key behind its PeerId)?
     * A null/absent column (a consent-seated strand, or a hand-built row) and a
     * node with no owner key both derive `false`: without a positive match this
     * machine must attach, never bootstrap. Pure key derivation, no I/O — cheap
     * enough for {@link launchStrand}'s tracked-instance early return.
     *
     * NOTE: reads "one owner key per machine" — the reference model, where the owner
     * key IS the key behind the PeerId. Two machines running the SAME identity key
     * would both derive `true` and each bootstrap on its own replica, which is the
     * double-`Header` hazard this derivation exists to avoid. Unreachable today: that
     * configuration also gives both machines one PeerId, which already breaks control
     * networking well before any strand launches. Revisit if machines ever share an
     * owner key while holding distinct transport identities — the derivation would
     * then need a per-machine discriminator (the `CadrePeer` PeerId) on the row.
     */
    private isSelfFoundedRow;
    /**
     * The owner keypair (base64url Ed25519) derived from this node's resolved
     * identity key. In the single-key reference model the owner signing key is
     * *derived from* the node identity (see {@link ed25519KeyPairFromLibp2p}), so the
     * same key material protected in a secure enclave backs both.
     *
     * Exposed so the hosting app retains control of owner genesis: cadre-core
     * resolves + protects the identity, then the app sources this pair to drive
     * `ensureOwnerKey(pub)` + `initializeSeedBootstrap(priv)` itself — cadre-core
     * never silently runs genesis. A future separate-owner slot would return a
     * distinct key here instead of the identity-derived one.
     *
     * @returns The base64url seed/public-key owner pair.
     * @throws If called before {@link start} has resolved the identity, or when the
     *   node runs on an ephemeral libp2p key (no `keyStore`/`privateKey` configured),
     *   since that key is internal to libp2p and not exposed.
     */
    getIdentityOwnerKey(): Ed25519KeyPair;
    /**
     * Collect this node's current dialable addresses for publication, signaling
     * (`/p2p-circuit`) first. Prefers the best invite/NAT-resolved set and folds
     * in the relay/signaling address (the WebRTC dial input) when not already
     * present.
     */
    private collectSelfAddrs;
    /**
     * Wire the ongoing self-record refresh: re-publish whenever libp2p reports an
     * address change (relay reservation rotation, NAT change) and on a TTL
     * heartbeat at half the freshness ceiling. Idempotent — repeated calls do not
     * stack listeners/timers.
     */
    private startRecordRefresh;
    /** Tear down the self-record refresh timers + listener (see {@link cleanup}). */
    private stopRecordRefresh;
    /**
     * Resolve a peer's current, signed, trust-checkable multiaddrs from only its
     * PeerId — the transport-agnostic input a NAT-to-NAT WebRTC (or any) dial path
     * consumes, with no copy/paste of a relayed dial string.
     *
     * Reads the peer's `CadrePeer` record and gates it through, in order:
     *   1. record present (else `[]`),
     *   2. `publicKey <-> peerId` binding (the stored key's libp2p identity must be
     *      the requested peerId),
     *   3. self-signature verifies against `publicKey`,
     *   4. freshness — rejected once older than `maxAgeMs` (never a dead relay
     *      reservation),
     *   5. the pluggable trust gate (`opts.trustPolicy`).
     * Survivors are returned signaling (`/p2p-circuit`) first, filtered to
     * signaling-only when requested, as parsed `Multiaddr`s (unparsable addrs
     * dropped). Any gate failure yields an empty array rather than throwing.
     *
     * Every returned address is normalized to terminate in `/p2p/<peerId>` — see
     * {@link normalizeDialAddrs} for why that invariant, not each dial site's own
     * handling, is what keeps a mixed list from taking a whole peer offline.
     */
    resolvePeerAddrs(peerId: string, opts?: ResolveOpts): Promise<Multiaddr[]>;
    /**
     * Guarantee every address handed to a control-network dial terminates in
     * `/p2p/<peerId>`, with no duplicates — the invariant every dial path
     * downstream relies on.
     *
     * `libp2p.dial(addrs)` requires that the addresses in ONE dial either all name
     * a peer id or none do; a list mixing a circuit address (which ends in
     * `/p2p/<target>`) with a bare direct one (which ends in `/tcp/…`) makes that
     * call throw, and the whole peer is then silently skipped rather than one bad
     * address.
     *
     * Applied by ALL THREE sources of control-dial candidates, so no call site
     * invents its own rule and none can produce a mixed list: the signed record
     * ({@link resolvePeerAddrs}), the libp2p address book
     * ({@link peerStoreAddrs}), and a retained out-of-band dial target
     * ({@link bootstrapDialAddrs}).
     *
     * An address naming a DIFFERENT trailing peer id is dropped: it does not reach
     * `peerId`, so it does not belong in this peer's candidate list (libp2p's own
     * dial queue filters the same shape out one layer lower).
     */
    private normalizeDialAddrs;
    /**
     * One address bound to `peerId`, or `null` when it cannot be — logged either
     * way, never thrown, so every caller's list-shaping stays total.
     *
     * Used both to normalize addresses this node DIALS (a `CadrePeer` row, a
     * retained bootstrap addr) and to normalize the ones it ANNOUNCES
     * ({@link getStrandMultiaddrs}); the rule is the same either way — an address
     * that does not reach `peerId` is not an address for `peerId`.
     *
     * `withTrailingPeerId` encapsulates `/p2p/<peerId>`, which throws on a peer id
     * that does not parse. Unreachable for a `CadrePeer` row (the binding gate
     * above parsed it already) and for our own node's id, reachable for a
     * retained one ({@link bootstrapDialAddrs}).
     */
    private bindAddrToPeer;
    /** Parse multiaddr strings, dropping (and logging) any that fail to parse. */
    private parseMultiaddrs;
    /**
     * Run one proactive control-cohort dial pass to keep this node connected to its
     * cadre siblings (so the `CadreControl` collections form a replicating cohort).
     * Public so the cohort-growth-driven re-replication path
     * (`control-write-ensure-replicated`) and tests can trigger a pass on demand;
     * normally driven by the eager start pass, the recurring interval, and
     * `self:peer:update` (all wired in {@link startRecordRefresh}).
     *
     * Concurrent triggers collapse into a single in-flight pass
     * (see {@link reconcileControlCohortInFlight}) so two passes never double-dial;
     * a call that joins an in-flight pass resolves to THAT pass's result.
     * Best-effort throughout: a failure to resolve/dial any one sibling is logged
     * and the pass continues; the whole pass is a no-op when the node is alone.
     *
     * Resolves to the peers the pass dialled ({@link ControlCohortReconcileResult}),
     * so a caller can tell a link this pass opened from one something else opened —
     * the pass skips a peer that is already connected. The timer and event triggers
     * discard it.
     */
    reconcileControlCohort(): Promise<ControlCohortReconcileResult>;
    /** Body of {@link reconcileControlCohort}; serialised by its single-flight guard. */
    private runReconcileControlCohort;
    /**
     * The owner-only half of the reconcile pass's ledger-marker step: file the singleton
     * `Revocation` marker ({@link SeedBootstrapService.openRevocationLedger}) unless this
     * process has already seen it filed. The connectivity gate is the caller's
     * ({@link runReconcileControlCohort}); why the marker exists is on
     * {@link ControlDatabase.openRevocationLedger}.
     *
     * Sets {@link revocationLedgerOpened} on `'opened'` or `'already-open'`. A node that
     * cannot sign as an owner does nothing: it picks the owner's marker up the first time it
     * reads the table, like any other replicated row. Best-effort like every step of the
     * pass — a failure is logged and leaves the flag clear, so the next connected pass retries.
     */
    private openRevocationLedgerIfDue;
    /**
     * Resolve every sibling's signed address record once and merge what resolves
     * into the control node's libp2p **address book** (peerStore). Returns the
     * resolved addresses per sibling so the dial loop reuses them rather than
     * re-resolving — one `queryPeerRecord` per sibling per pass, not two.
     *
     * Deliberately every sibling, not the {@link selectControlCohortDials} subset,
     * and deliberately including already-connected ones: everything below
     * cadre-core dials by bare peer id (Optimystic's cluster/repo clients, FRET
     * ping/announce), so the address book has to be warm BEFORE a live connection
     * drops, and a sibling the out-degree cap declines to dial is still one those
     * layers may need to reach.
     *
     * Only `resolvePeerAddrs` output is merged — never the cold-start
     * `peerStoreAddrs` fallback, which came out of the address book to begin with
     * and would restamp unverified seed addresses indefinitely. A sibling that
     * resolves to nothing (revoked, stale, untrusted) is not written at all, so its
     * existing entry ages out on its own.
     *
     * The same resolution also keeps a sibling's retained out-of-band dial target
     * current ({@link refreshDialHint}).
     *
     * NOTE: this resolves EVERY sibling serially before the dial loop below runs,
     * so it costs one record query per sibling per reconcile pass (~15s) and each
     * one delays the pass's first dial. A cadre is a handful of devices, so today
     * that is a few extra local reads; if cadres ever grow large, batch the records
     * into one query, merge only on change, or move the warm pass after the dials.
     */
    private warmSiblingAddrBook;
    /**
     * Replace a sibling's retained out-of-band dial target (see
     * {@link bootstrapPeerStore}) with the addresses its signed record just resolved
     * to, when the two differ — so an address change this node saw while the record
     * was fresh (a new port, a new LAN address) is what it dials after a relaunch
     * that outlives the record's freshness window.
     *
     * Only a sibling that already HAS an entry (`retained`) is refreshed: the store
     * holds peers learned out of band and must not grow into a copy of every
     * sibling's addresses. An empty resolution leaves the entry alone — a stale or
     * not-yet-signed record is exactly when the entry is needed. The comparison is
     * order-insensitive and runs on the retained addresses after binding them to the
     * peer id, so an entry recorded without `/p2p/` suffixes is not rewritten merely
     * for lacking them.
     *
     * NOTE: replaces rather than merges, so the entry becomes exactly what the
     * sibling announces. If a node's signed record ever lists fewer addresses this
     * node can reach than it was added with (say an announce override naming only a
     * public address, for a node added by its LAN address), a relaunch dials the
     * worse set; merge the two lists here if that shows up.
     */
    private refreshDialHint;
    /**
     * {@link resolvePeerAddrs} for one sibling, best-effort: a control-DB read
     * failure yields `[]` (and the cold-start fallback then gets its turn) rather
     * than aborting the whole pass, like every other step here.
     */
    private resolveSiblingAddrs;
    /**
     * Time limits for dialing ONE control-network peer from its candidate
     * addresses ({@link dialPeerAddrs}): the reconcile pass's steady-state sibling
     * ({@link dialControlSibling}) and cold-start bootstrap peer
     * ({@link dialBootstrapPeer}) dials, and — handed to every
     * {@link SeedBootstrapService} this node builds — `applySeed`'s owner dials and
     * `dialInvite`.
     *
     * See `peer-dial.ts`'s `DEFAULT_CONTROL_COHORT_DIAL_TIMEOUT_MS` for why a peer's dial is
     * bounded as a whole, and `DEFAULT_CONTROL_COHORT_PER_ADDRESS_DIAL_TIMEOUT_MS` for why each
     * address is bounded as well.
     *
     * Both are DERIVED from `network.linkRoundTripMs` rather than fixed, because the slowest
     * address either has to cover is a relayed dial and that costs a fixed number of exchanges —
     * `link-budget.ts` has the counts. A host's explicit `controlCohort` values still win, so a
     * test that drives dead addresses on purpose keeps the duration it chose.
     */
    private controlDialBudget;
    /**
     * The link-derived limits shared by every {@link SeedBootstrapService} this node builds: its
     * owner and invite dials ({@link controlDialBudget}) and its seed delivery deadline, derived
     * from `network.linkRoundTripMs`. One helper so the four construction sites cannot drift.
     */
    private seedServiceBudgets;
    /**
     * {@link collectStrandAddrs} at this node's declared `network.linkRoundTripMs`, so each ask's
     * deadline derives from it. One helper so the four call sites cannot drift.
     */
    private collectSiblingStrandAddrs;
    /**
     * Dial one sibling from its already-resolved addresses, best-effort. Returns
     * whether the dial resolved (false when no address resolves or the dial fails).
     *
     * A per-peer failure (NAT, offline, relay down, connection-gater denial, or
     * the {@link controlDialBudget} expiring) is logged and swallowed so one
     * unreachable sibling never aborts the pass — exactly like
     * {@link SeedBootstrapService.applySeed}'s owner-dial loop. A failed dial is
     * simply retried on the next pass. A sibling whose every address relays
     * through this node ({@link SelfRelayOnlyError}) is not dialed at all and gets
     * a one-line log instead: only the sibling can reconnect.
     */
    private dialControlSibling;
    /**
     * A sibling's control-network dial addresses for the reconcile pass, from the
     * first of three sources that yields any:
     *
     *  1. the signed, fresh, trust-gated control addresses `resolved` for it by
     *     {@link warmSiblingAddrBook} — passed in rather than re-resolved, so the
     *     pass makes one record query per sibling;
     *  2. the libp2p address book ({@link peerStoreAddrs}) — the entries `applySeed`
     *     and identify put there, until they age out;
     *  3. the sibling's retained out-of-band dial target ({@link retainedDialAddrs}).
     *     For a node that cannot listen, this is the only source for a sibling it
     *     added but has not yet connected to: the added node's row stays unsigned
     *     until it self-publishes, which needs the connection this dial opens. It is
     *     also what a relaunch that outlived the record's freshness window uses.
     *
     * Returns `[]` (never throws) when none yields an address — that sibling is
     * skipped this pass.
     *
     * The list may name transports this node cannot dial (a lent node reports TCP
     * and `/ws` addresses to a phone that dials WebSockets only). That needs no
     * filtering here: libp2p's dial queue (`calculateMultiaddrs`, libp2p 3.1.3)
     * rejects an address no transport can dial before touching the network, so
     * such an address costs a log line.
     *
     * The list is NOT handed to one `dial()`. libp2p tries a multi-address dial's
     * addresses one after another under a single deadline, with no limit per
     * address, and sorts loopback addresses last — so one or two addresses that
     * never answer used up the whole deadline before the address that worked was
     * tried. {@link dialPeerAddrs} dials each address on its own time limit instead.
     */
    private resolveControlDialAddrs;
    /**
     * A sibling's retained out-of-band dial target (see {@link bootstrapPeerStore}),
     * bound to its peer id through {@link bootstrapDialAddrs}; `[]` when it has none.
     *
     * These addresses are never merged into the libp2p address book: they are
     * unverified, and the address book takes only verified ones (see
     * `mergePeerAddrs`). Layers that dial by bare peer id use the connection this
     * dial opens, and after it drops the next reconcile pass dials again.
     *
     * NOTE: an entry is consulted here only for a current sibling, so a peer revoked
     * by another owner is not dialed from it, even though the entry stays (only this
     * node's own {@link removePeer} forgets one). The cold-start branch
     * ({@link dialColdStartBootstrap}) still dials every entry while there are no
     * siblings at all; if entries for revoked peers ever cause dial churn there,
     * prune entries whose peer has a retired `CadrePeer` row during the membership
     * refresh.
     */
    private retainedDialAddrs;
    /**
     * Cold-start fallback: the libp2p peerStore multiaddrs for `peerId` (seeded by
     * {@link SeedBootstrapService.applySeed}). Returns `[]` on a missing entry or any
     * parse/lookup failure — never throws.
     *
     * Normalized through {@link normalizeDialAddrs} for the same reason
     * {@link resolvePeerAddrs} is, and with more cause: the address book hands back
     * a list that is inherently MIXED. `@libp2p/peer-store`'s
     * `dedupeFilterAndSortAddresses` strips a trailing `/p2p/<peerId>` only when
     * that id is the address's FIRST `/p2p/` component, so a direct address
     * round-trips bare while a relayed one — whose first `/p2p/` names the relay —
     * keeps its suffix (the same asymmetry `peer-addr-book.ts`'s `addrKey` exists
     * to absorb). Feeding both to one `dial()` is exactly the
     * `InvalidParametersError` that skipped the whole peer.
     */
    private peerStoreAddrs;
    /**
     * Retain a just-applied seed's owner-flagged peers as cold-start bootstrap
     * dial targets (see {@link bootstrapPeerStore}).
     *
     * Called for every seed this node accepts, on BOTH intake paths — the
     * {@link applySeed} wrapper (which may run on a throwaway service, so the
     * service itself is the wrong place to keep this) and the inbound
     * `/sereus/seed/1.0.0` handler via `onSeedApplied`. Peers with no address are
     * skipped: there is nothing to dial.
     *
     * `isOwner` is the seed's own claim about its peers, exactly as
     * `SeedBootstrapService.applySeed` uses it to choose its dial targets. That is
     * sound here for the same reason it is sound there — the whole seed is
     * signature-checked against a trust-anchored signer before this runs, and the
     * flag only *selects a dial target*; a dial grants no authority.
     *
     * Addressless peers and self are skipped by {@link retainDialTarget}.
     */
    private recordSeedBootstrapPeers;
    /**
     * Retain (or replace) one peer's out-of-band dial target in
     * {@link bootstrapPeerStore}. Shared by every writer: seed intake, {@link addDrone}
     * and {@link refreshDialHint}.
     *
     * Fire-and-log: the entry is visible synchronously by the store's contract, and
     * the promise tracks durability only. A persist failure costs restart survival,
     * never this session's dial set — the same trade
     * `SeedBootstrapService.anchorAcceptedSigner` makes — so it is logged rather than
     * failing a seed or an add that has already been accepted.
     *
     * Two peers are never retained. One with no address: there is nothing to dial.
     * And self: `createSeed` projects EVERY `CadrePeer` row, so an owner that applies
     * a seed minted after it joined finds itself in the owner list, and `addDrone`
     * could be handed this node's own id. Retaining self would make the cold-start
     * pass dial this node forever (the steady-state pass filters self out of its
     * sibling list for the same reason).
     */
    private retainDialTarget;
    /**
     * Cold-start branch of the reconcile pass: re-dial every retained out-of-band
     * dial target (see {@link bootstrapPeerStore}) — in practice the owner peers of
     * the seeds this node applied — while the control database still has no
     * siblings to dial.
     *
     * `SeedBootstrapService.applySeed` dials those owners exactly ONCE, best-effort.
     * When that single dial fails — owner momentarily down, relay reservation not
     * up yet, NAT traversal lost the race — the joining node has an empty
     * `CadrePeer` table and no connection, and the steady-state pass above cannot
     * help: it dials only siblings enumerated from that very table. Retrying here
     * is the only way back in.
     *
     * Unbounded, at the reconcile cadence, with no backoff: the branch is already
     * gated by "the control database has no siblings", so it stops the moment the
     * node is actually in the party, and a node that is stranded MUST keep trying —
     * a give-up rule would turn a transient outage into a permanent one. The steady
     * cost is one dial per bootstrap peer per pass (seeds nominate one or a few
     * owners), each failing fast against an unreachable address.
     * NOTE: if seeds ever carry many owner peers, or the reconcile cadence tightens
     * well below its 15 s default, add per-peer backoff here.
     *
     * Best-effort per peer, exactly like {@link dialControlSibling}: one dead
     * address never aborts the pass.
     */
    private dialColdStartBootstrap;
    /**
     * Bind a retained dial target's addresses (see {@link bootstrapPeerStore}) to
     * its peer id, so the dial authenticates the peer it is aiming at rather than
     * trusting whoever answers.
     *
     * The same {@link normalizeDialAddrs} rule the resolved and address-book paths
     * use, on the third and last source of control-dial candidates: an address that
     * already terminates in `/p2p/<id>` must carry THIS peer's id or it is dropped
     * (an entry that disagrees with itself is not a dial target); one that does not —
     * a bare listen addr, or a relay hop with the destination missing — gets the id
     * encapsulated; an unencapsulatable one is dropped rather than dialed bare.
     */
    private bootstrapDialAddrs;
    /** Dial one cold-start bootstrap peer, best-effort. Returns whether it connected. */
    private dialBootstrapPeer;
    /**
     * Whether a control write happening now would commit local-only. A sound lower
     * bound is "no connected control peers": 0 connections ⇒ the block's cluster is
     * ≤1 ⇒ Optimystic commits without broadcasting. This is the pragmatic proxy for
     * the precise signal (the block's `getClusterSize`); it over-approximates safely
     * — a connected-but-not-in-this-block's-cluster write may still be local-only and
     * is caught by the cohort's periodic pull-on-read instead. Re-issuing an already-
     * replicated row is harmless (an idempotent monotonic bump), so the coarse proxy
     * is acceptable as the agreed first cut.
     *
     * Reads {@link getControlConnectionCount} — the public, embedder-facing form of
     * the same sample — so the two cannot drift.
     */
    private committedAlone;
    /**
     * Record (or clear) a just-committed owner membership write in the
     * write-while-alone re-replication queue. If the control node had no connections
     * at commit, the Optimystic write was local-only and must be re-issued once the
     * cohort grows; otherwise the write replicated and any stale queue entry for this
     * subject is dropped.
     *
     * A `remove` never queues here — a delete's re-replicable half is its
     * `Revocation` tombstone, which the committed-delete seam routes into
     * {@link pendingRevocations} ({@link noteGuardedDelete}). The `remove` arm only
     * drops any queued authorize for the subject (the row is gone; re-issuing the
     * insert would resurrect it) and, when the commit was alone, logs the
     * security-relevant window loudly.
     */
    private noteControlWrite;
    /**
     * Committed-delete seam handler ({@link GuardedDeleteListener}, wired in
     * {@link start}): a guarded-table delete and its `Revocation` tombstone
     * committed. If the node was alone the tombstone is local-only — queue it for
     * an owner-signed re-issue on cohort growth; otherwise it broadcast, so drop
     * any stale queue entry for the stamp. Synchronous by contract — bookkeeping
     * only, never throws into the delete path.
     */
    private noteGuardedDelete;
    /**
     * Drain the write-while-alone re-replication queue: re-issue the writes that
     * committed local-only now that the cohort can broadcast them. Public so the
     * 0→≥1 growth trigger ({@link handleControlConnectionChange}) and tests can drive
     * it; concurrent calls collapse into one in-flight drain
     * ({@link drainControlReplicationInFlight}) so two growth signals never
     * double-issue. Best-effort throughout — a per-row failure leaves that entry
     * queued for the next growth rather than aborting the drain.
     */
    drainPendingControlReplication(reason: string): Promise<void>;
    /** Body of {@link drainPendingControlReplication}; serialised by its single-flight guard. */
    private runDrainControlReplication;
    /**
     * Re-touch this node's own `DeviceToken` row (re-sign + bump `UpdatedAt` via
     * {@link registerDeviceToken}) so a self device-token that committed local-only
     * re-broadcasts on cohort growth. No-op when no row exists (nothing to
     * re-replicate) or the stored platform is unknown. Best-effort — never throws to
     * the drain.
     */
    private retouchSelfDeviceToken;
    /**
     * Re-issue `Revocation` tombstones so a removal that committed while alone
     * still reaches the cohort. Two regimes, one method:
     *
     * - **First successful pass per process** ({@link reissuedHeldRevocations}
     *   false): sweep EVERY locally-held tombstone from `queryRevocations()` — the
     *   only cover for a removal made before this process started, since the
     *   in-memory queue does not survive a restart. Queued stamps are part of that
     *   same batch (exactly once — one transaction, no double bump).
     * - **Later passes**: only the tombstones queued in-session by
     *   {@link noteGuardedDelete}.
     *
     * Owner-gated: a node with no owner key cannot sign a re-issue, so stray queue
     * entries are dropped (mirrors {@link drainPendingPeerWrites}). Best-effort — a
     * failure is logged and leaves the queue (and the sweep flag) untouched for the
     * next growth edge. A successful `reissueRevocations` exec is NOT proof of
     * broadcast (the connection that fired the growth edge may not be in the
     * affected block's cluster — see
     * tickets/backlog/control-rereplication-broadcast-confirmation); the drain
     * inherits that known gap, and a full disconnect→reconnect (or the next
     * process's sweep) re-covers it.
     *
     * NOTE: the sweep is O(all tombstones ever) row-updates — plus one owner
     * signature each — in one transaction, once per lifetime. `Revocation` is
     * append-only and unbounded growth is declared acceptable for a cadre-sized
     * party. If the tombstone table ever gets large, bound the sweep (e.g. persist
     * a node-local high-water mark of what has been re-issued while connected)
     * instead of re-touching everything; note the `Math.max(...)` spread below also
     * caps out around 10^5 rows (V8 argument limit) before the size becomes merely
     * a latency problem.
     */
    private drainPendingRevocations;
    /**
     * One-shot, first-cohort-growth reconstruction of the write-while-alone queue for
     * an OWNER node: re-touch every membership row that may be an unreplicated
     * owner insert. A row is a candidate iff it is not self (handled by
     * {@link registerSelf}), is not already tracked in the in-memory queue (handled by
     * {@link drainPendingPeerWrites}), and carries no self-`Sig` yet (an
     * owner-authored row the peer has not self-published — the only kind safe to
     * bump without invalidating a self-signature). O(rows) on the small control
     * tables; safe to over-apply (a monotonic owner bump on an already-replicated
     * row is a no-op-equivalent).
     *
     * A node with no owner private key skips this entirely — it cannot re-sign
     * rows for other peers, and rows it merely holds are not its to re-issue.
     * DELETEs are not reconstructed here — the `Revocation` tombstone sweep in
     * {@link drainPendingRevocations} covers them (a removed row leaves no
     * `CadrePeer` trace, but its tombstone is re-issuable).
     */
    private reconstructAuthoredMembership;
    /**
     * Body of {@link reconstructAuthoredMembership}'s sweep: re-issue each candidate
     * owner-authored row, returning how many were re-touched. A per-row failure is
     * logged and skipped; a teardown mid-sweep stops it.
     */
    private reissueAuthoredMembershipRows;
    /**
     * Drain the in-session write-while-alone queue: re-issue each pending owner
     * authorize as an idempotent monotonic owner UPDATE
     * ({@link reissuePeerAuthorize}) now that the cohort can broadcast it.
     * Sequential (no fan-out) to avoid a thundering re-touch; an entry is cleared
     * only on success, so a failure (or a still-alone re-commit) leaves it queued
     * for the next growth. An entry is skipped (and cleared) if the row vanished
     * (raced a delete) or now carries a self-`Sig` (the peer self-published and owns
     * its republish). Removals are drained by {@link drainPendingRevocations}, not
     * here.
     */
    private drainPendingPeerWrites;
    /**
     * Body of {@link drainPendingPeerWrites}' loop. An entry is cleared only on
     * success (or when there is nothing left to re-issue); a failure is logged and
     * the entry stays queued for the next cohort growth.
     */
    private reissuePendingPeerWrites;
    /**
     * Re-issue an owner membership row as a monotonic owner UPDATE: bump
     * `UpdatedAt` strictly above the stored value (and the wall clock) and re-sign via
     * the owner branch of `CadrePeer.AuthorizedUpdate`. The row already exists
     * locally (it committed there, just local-only), so this is an UPDATE, not the
     * original INSERT.
     */
    private reissuePeerAuthorize;
    /**
     * On a control connection opening, detect the 0→≥1 transition and drain the
     * write-while-alone re-replication queue (single-flight; fires only on the edge,
     * not on every subsequent `connection:open`). Best-effort — a drain failure is
     * logged, not thrown.
     */
    private handleControlConnectionChange;
    /** Re-arm the growth edge once all control connections drop, so a later reconnect re-drains. */
    private handleControlConnectionClose;
    /**
     * Wire the control-connection growth listeners that drive write-while-alone
     * re-replication. Wired in {@link start} (not the delayed refresh path) so no
     * early `connection:open` is missed; torn down in {@link stopRecordRefresh}.
     * Idempotent.
     */
    private wireControlConnectionListeners;
    /**
     * On a control connection opening: if it is a WebRTC connection, drain the TURN
     * tracker for the just-settled ICE verdict and, when it relayed, mark the peer
     * so {@link getConnectionPaths} classifies it `webrtc-turn` (relayed). The
     * settlement↔open correlation is timing-based and best-effort; an unknown
     * verdict degrades to not-relayed. Never throws to the event loop.
     */
    private handleTurnConnectionOpen;
    /** On a control connection closing, drop any TURN-relayed flag for its peer. */
    private handleTurnConnectionClose;
    /**
     * Publish (or refresh) this node's own self-signed `DeviceToken` row so a server
     * peer can resolve its FCM/APNs push token from its PeerId alone. Mirrors
     * {@link registerSelf}:
     *
     * - If the row already exists: a self-signed UPDATE bumping `UpdatedAt` (works
     *   for any member — the `AuthorizedUpdate` self-branch verifies the new `Sig`
     *   against the bound `CadrePeer.PublicKey`). Platform/Token may change here
     *   (rotation / platform switch / reinstall are all normal self-updates).
     * - If not, and the node holds an owner service: an owner-signed INSERT
     *   that also carries the self-signature.
     * - Otherwise: throws. Like `CadrePeer`, the first `DeviceToken` row requires an
     *   owner signature; a non-owner peer (e.g. a phone) must have its row
     *   seeded by an owner — typically the server it enrolled with — before it
     *   can self-refresh. (Establishing that phone→server registration handshake is
     *   the downstream "RN registration" ticket; this node only owns the cadre-core
     *   write path.)
     *
     * `UpdatedAt` strictly increases on every publish (even a same-millisecond
     * re-publish), so a replayed older record is rejected by the schema.
     *
     * @param platform - `'fcm'` (Android/Firebase) or `'apns'` (Apple).
     * @param token - the opaque platform device/registration token.
     * @throws if the node is not started, exposes no self-signing key, or has no
     *   existing row and no owner service to self-insert.
     */
    registerDeviceToken(platform: PushPlatform, token: string): Promise<void>;
    /**
     * Resolve a cadre peer's FCM/APNs push token from only its PeerId — the input a
     * server's push-wake fan-out consumes to deliver a platform push to a suspended
     * app. Applies the same gating shape as {@link resolvePeerAddrs}, returning
     * `null` (never throwing) on any failure:
     *
     *   1. membership — the peer has a `CadrePeer` row with a `PublicKey`,
     *   2. `publicKey <-> peerId` binding — the stored key's libp2p identity is the
     *      requested peerId,
     *   3. a `DeviceToken` row exists with a known {@link PushPlatform},
     *   4. the row's `StampId` is NOT retired in `CadreControl.Revocation` — the
     *      read-side half of the clear (see below),
     *   5. self-signature verifies against the bound `CadrePeer.PublicKey`,
     *   6. freshness — `updatedAt` is positive and within `opts.maxAgeMs` (default:
     *      no ceiling, since a push token is valid until it rotates).
     *
     * A peer that is not a current member, or whose token has no backing `CadrePeer`
     * record, resolves to `null` — a server must not attempt to push to a non-cadre
     * peer.
     */
    resolveDeviceToken(peerId: string, opts?: ResolveDeviceTokenOpts): Promise<DeviceTokenRecord | null>;
    /**
     * Delete this node's own `DeviceToken` row (logout / token invalidation). No-op
     * when no row exists. Like {@link registerDeviceToken}'s first insert, the delete
     * is gated on an owner signature (`DeviceToken.AuthorizedInsert` covers insert
     * AND delete), so it requires this node's owner service; a non-owner peer
     * must route the clear through its owner (downstream RN registration path).
     *
     * @throws if the node is not started, or a row exists but no owner service is
     *   available to sign the delete.
     */
    clearDeviceToken(): Promise<void>;
    /**
     * Expire ANOTHER peer's stale `DeviceToken` after a platform reported it
     * unregistered during a push-wake fan-out. Unlike {@link clearDeviceToken}
     * (self-only — it hardcodes the local peerId), this takes an arbitrary peerId.
     *
     * - When this node holds an owner seed service, it deletes the row
     *   (`deleteDeviceToken` is owner-gated and accepts any peerId), so the peer
     *   is not retried until it re-registers.
     * - When this node is NOT an owner it cannot delete the row, so it only logs
     *   that a re-registration is needed. The fan-out's own in-memory dead-token set
     *   is what actually stops re-pushing to the dead token this process — see
     *   {@link PushFanoutService}. That set is acceptably lossy across restarts (a
     *   restart re-learns staleness on the next failed send).
     *
     * Best-effort: never throws to the (best-effort) fan-out caller.
     */
    expireDeviceToken(peerId: string): Promise<void>;
    private handleStrandAdded;
    /**
     * Offer a strand no local config claims to the hosting app as `strand:discovered`, so
     * it can decide whether to join (register a config + addStrand); the strand-agnostic
     * seam keeps this class free of any app's join policy.
     *
     * Once per strand: a storage-replica launch that fails is retried by the watcher
     * (`StrandWatcher.forgetStrand` + backoff), and each retry comes back through
     * {@link handleStrandAdded} with no config — the app must still see one announcement.
     * The other thing that un-retains a strand in the watcher (a failed `addStrand`) leaves
     * the sApp config registered, so that retry takes the claimed branch instead.
     *
     * Recorded BEFORE the emit so a handler that synchronously drains
     * `getDiscoveredStrands()` sees this strand too. So this map — not the event — is what
     * a late subscriber reads. See the `strand:discovered` doc in types.ts.
     *
     * NOTE: a replica launch that keeps failing leaves the watcher not tracking the strand,
     * so if its control row is removed during the backoff no `handleStrandRemoved` arrives
     * and this entry outlives the row. Needs a persistently failing launch AND a removal
     * inside the backoff; if it is ever seen, have the watcher report removal of rows it
     * forgot, since `detachStrand` is already a no-op for an untracked instance.
     */
    private announceDiscoveredStrand;
    /**
     * Record the sApp id a storage replica's `Strand.Header` names, for {@link getSAppId}.
     * Runs whenever a replica's database may have just been published (launch, the
     * first-sync gate opening, a wake); a no-op for a claimed strand, an unpublished
     * database, or an id already recorded. Never throws: a failed read logs and leaves the
     * id unknown, so an `sAppId` filter keeps the strand provisionally admitted — a
     * syncing replica, which is harmless.
     */
    private recordReplicaSAppId;
    private handleStrandRemoved;
    /**
     * Return this node to its pre-{@link start} state. The ONE teardown — `stop()` and
     * a failed `start()` both come here, so anything a stopped node must not still be
     * doing belongs in this method and not in `stop()`. `stop()` adds only the
     * `control:disconnected` emit, which a never-connected start has no edge for.
     */
    private cleanup;
    /**
     * A gated joiner's database was just published (`StartStrandConfig.onWritable`): the
     * instance is `'active'` now, so re-arm its idle timer as any activity would. Nothing
     * records activity on a gated joiner, so its idle timer may already have fired — the
     * instance read `'idle'` with a hibernate timer pending — and without this the flip
     * back to `'active'` would leave that timer to quiesce a strand the app just started
     * using. Emits `strand:writable` after the timers are settled.
     */
    private handleStrandWritable;
    private handleStrandIdle;
    /**
     * Hibernate a strand: release its strand-network resources via the strand
     * manager (stop the libp2p node, close the StrandDatabase) and mark it
     * `hibernating`. A quiesced strand holds no open strand-network connections,
     * transports, or DB handles. No-ops if the strand is missing; if already
     * quiesced (defensive), just marks status and emits.
     */
    private handleStrandHibernate;
    /**
     * Wake a strand. If it was hibernating (quiesced — no libp2p node), re-resolve
     * the cohort discovery seed exactly as `launchStrand` does and rebuild
     * its runtime via the strand manager. If it is still live (e.g. waking an idle
     * strand, which retains its resources), just flip the status. Overlapping wake
     * triggers are coalesced upstream by `HibernationManager`, so this runs once
     * per wake; a wake racing a check-in joins the check-in's rebuild in `resumeStrand`.
     *
     * A failed rebuild re-hibernates the strand (see {@link rehibernateAfterFailedResume});
     * every failure rethrows, so the waker still sees the error.
     *
     * Records no activity itself: whoever asked for the wake did ({@link wakeStrand},
     * `HibernationManager.recordActivity`), and {@link serviceWake}'s own probe must not.
     */
    private handleStrandWake;
    /**
     * Put a strand whose resume failed back to `'hibernating'`, after a best-effort quiesce
     * that releases any partially rebuilt runtime. `resumeStrand` leaves a failed strand
     * `'error'`, which nothing retries: `HibernationManager` wakes only `idle`/`hibernating`
     * strands, and reads any other status after a check-in as "woke", ending its chain.
     * Safe to run twice for one failure (a wake that joined a failed check-in's rebuild):
     * quiescing a quiesced strand is a no-op.
     */
    private rehibernateAfterFailedResume;
    /**
     * Rebuild a quiesced strand's runtime, re-resolving the volatile cohort input
     * first: the discovery seed may have grown since the strand last ran. Shared by
     * the wake (`handleStrandWake`) and check-in (`handleStrandCheckIn`) paths so both
     * apply the same fresh resolution. `resumeStrand` returns a live instance unchanged
     * and joins a rebuild already in flight, so the two paths never build twice.
     */
    private resumeStrandRuntime;
    /**
     * Real cohort check-in for a hibernating strand (the `onCheckIn` callback).
     *
     * Optimystic syncs pull-on-read, not on connect, and exposes no cheap
     * repo-level "pull pending" hook (`IRepo` is get/pend/commit/cancel only —
     * see the review handoff). So "query the cohort for pending activity" is
     * realized as a resume → bounded window → re-hibernate-if-idle cycle that
     * reuses the existing quiesce/resume primitives rather than a bespoke probe:
     *
     *   1. Resume the strand (rebuild node + db, re-resolve the cohort seed) so
     *      its strand network can reach cohort peers — exactly as a wake does.
     *   2. Hold it resumed for a bounded window, during which the app may drive
     *      reads (pull-on-read) and record activity.
     *   3. If activity was recorded during the window, leave the strand `active`
     *      (the idle/hibernate timers + backoff reset take over). Otherwise
     *      quiesce again and leave it `hibernating`, so `HibernationManager`
     *      schedules the next, longer-delayed check-in.
     *
     * No-ops unless the strand is currently `hibernating` — a concurrent wake may
     * have already resumed it.
     */
    private handleStrandCheckIn;
    /**
     * Window-then-decide for a just-resumed strand, shared by the check-in timer
     * path ({@link handleStrandCheckIn}) and the on-demand {@link serviceWake}:
     *
     *   1. Hold the strand live for `windowMs` so its strand network reaches the
     *      cohort and the app can drive pull-on-read activity.
     *   2. If activity landed since `activityMark`, leave the strand `active` (return
     *      `true`); otherwise quiesce and mark it `hibernating` again (return `false`).
     *
     * @param activityMark - `instance.lastActivity` as the caller read it BEFORE bringing the
     *   strand up. The bring-up records none, and every writer assigns a FRESH `Date`, so a
     *   changed reference means a wake or activity landed during the resume or the window —
     *   not millisecond-resolution noise.
     * @returns whether activity was observed (strand left active).
     */
    private runWakeWindow;
    /**
     * Hold a just-resumed strand live for `windowMs` (default
     * {@link DEFAULT_CHECKIN_WINDOW_MS} is applied by callers). A non-positive
     * window resolves immediately. The pending timer is tracked in
     * {@link windowWaiters} so {@link cleanup} can both clear it and resolve the
     * promise on teardown — a `stop()` during an in-flight window must neither fire
     * the timer afterward nor hang the awaiting check-in/serviceWake. Extracted as
     * its own method so tests can stub the wait (and inject activity during it).
     */
    private holdWakeWindow;
    /**
     * Clear every in-flight wake window: cancel its timer and resolve its promise
     * so any awaiting check-in/serviceWake completes promptly rather than hanging
     * past teardown. Called from {@link cleanup}.
     */
    private clearWindowWaiters;
    /**
     * Add a strand with its sApp configuration.
     * The hosting application must provide the sApp schema when creating a strand.
     *
     * This is the ATTACH half only — it starts the local instance and never publishes the
     * `Strand` row. A joiner (the row arrived over the control network) wants exactly this; a
     * FOUNDER wants {@link foundStrand}, which publishes and attaches in one resumable call.
     * With no explicit `founder` flag, founder-ness is derived from the row's
     * `FounderOwnerKey` (see {@link StrandConfig.founder}) — so attaching a row THIS machine
     * published (e.g. re-attaching its own orphan after a restart) founds it, and attaching
     * anyone else's row joins, without the caller needing to know which it is.
     *
     * A joined row (no `founder: true`) this party's control database does not name — a
     * strand joined from another party — is remembered in the node's joined-strand store, so it
     * is re-offered as `strand:discovered` after a restart, and published party-wide by an
     * owner machine's reconcile pass (see {@link forgetJoinedStrand}).
     *
     * A rejected call leaves nothing running but DOES leave the sApp config
     * registered, deliberately: both an explicit retry and the {@link StrandWatcher}'s
     * automatic relaunch need it. A failed launch here hands the strand back to that
     * relaunch — `StrandWatcher.forgetStrand` drops the id from the watcher's
     * `knownStrands` and records the backoff, so a later poll re-attempts it on the same
     * `pollInterval * 2^(failures-1)` ladder a watcher-driven failure gets. Because the
     * config stays registered, the retry takes `handleStrandAdded`'s auto-launch branch:
     * what the app sees is `strand:error` per failed retry and `strand:started` when one
     * succeeds, never a second `strand:discovered`. {@link detachStrand} (reached via
     * {@link stopStrand}) is what abandons a strand for good, and its stop suppresses the
     * strand in the watcher so this retry cannot resurrect it — a call to THIS method lifts
     * that suppression again, since an explicit claim is a deliberate reversal of the
     * deliberate stop.
     */
    addStrand(config: StrandConfig): Promise<StrandInstance>;
    /**
     * Resolve once a launched strand is writable — its database published to the app and
     * its status `'active'` — or reject with the retryable `StrandAwaitingFirstSyncError`
     * after `timeoutMs` (default `strandFirstSync.timeoutMs`, else
     * `DEFAULT_STRAND_FIRST_SYNC_TIMEOUT_MS`). The promise form of the `strand:writable`
     * event, for a caller that attached without waiting ({@link StrandConfig.awaitFirstSync}
     * `false`) or that holds a strand the watcher launched. Resolves immediately for a
     * strand that is already writable; rejects immediately for one this node does not run.
     * A hibernating strand is not woken — wake it first if that is what is wanted.
     */
    whenStrandWritable(strandId: string, options?: {
        timeoutMs?: number;
    }): Promise<StrandInstance>;
    /**
     * Publish a strand row to the shared control database under this node's own
     * owner identity, so other cadre members discover it via control-network
     * sync (their {@link StrandWatcher} fires `strand:discovered`).
     *
     * **Founding a strand is TWO steps** — this one (publish the row cadre-wide) and
     * {@link addStrand} (start the local instance, `founder: true` to write the strand's
     * `Header`/founding membership). `addStrand` deliberately omits the insert: it only
     * starts the LOCAL instance, whereas publishing makes the strand visible cadre-wide. A
     * discovering peer only does `addStrand` (the row already exists). Callers founding a
     * strand should use {@link foundStrand}, which performs both steps and is safe to
     * re-run — hand-rolling the pair is what left strands half-founded when an app was
     * killed between them.
     *
     * **Idempotent for identical content.** A live row whose `(Type, MemberPrivateKey)` match
     * the arguments is the state this call would have produced, so the call logs and returns
     * that row instead of writing — a publish interrupted after it committed can be repeated.
     * DIFFERENT content on the same id throws, naming the columns that differ, rather than
     * surfacing the raw `UNIQUE constraint failed: Strand.Id`: silently accepting it would
     * let a retry reopen a closed strand or swap the key gating its reads. The read and the
     * insert are not atomic, so a concurrent founder (two machines of one party, same id) is
     * caught on the insert's uniqueness rejection and resolved the same way — re-read, no-op
     * on a match, rethrow otherwise. Never an overwrite either way.
     *
     * A tombstoned strand is NOT resurrected here: {@link unpublishStrand} deletes the row, so
     * the idempotent branch is unreachable and the ordinary publish path re-seats it, exactly
     * as that method documents.
     *
     * **Already stuck on `UNIQUE constraint failed: Strand.Id`?** The row is already published
     * — attach, do NOT republish: `addStrand` (or {@link foundStrand}) with the id and, for a
     * closed strand, the `MemberPrivateKey` read back from the row. `unpublishStrand` + a
     * fresh publish also clears it for an OPEN strand, but is destructive for a closed one
     * (the key exists nowhere else). No app-data wipe is needed for either.
     *
     * The insert is signed with the ed25519 key behind this node's PeerId — which
     * {@link ed25519KeyPairFromLibp2p} also exposes as the node's owner keypair,
     * so peer identity and owner key are one and the same. That key is also persisted on the
     * row as `FounderOwnerKey` (the schema pins the column to the verified signer), which is
     * what later lets any launch derive "this machine is the founder" from the row alone.
     * The key must be enrolled in `OwnerKey` (e.g. via {@link ControlDatabase.ensureOwnerKey}
     * at genesis) or the schema's `Strand.AuthorizedInsert` constraint rejects the write.
     * Failing loudly here is intentional: a silently-unpublished strand would run
     * as a local-only island that no peer could ever discover or join.
     *
     * A CLOSED strand's publish also seats this party's own membership identity key —
     * the `StrandPartyKey` row {@link ensureStrandPartyKey} documents — which is what the
     * founder bootstrap derives `Member.Key`/`Manager.MemberKey` from. The
     * `memberPrivateKey` ARGUMENT stays the strand-wide read secret formation hands to
     * joiners; it derives nobody's identity.
     *
     * @param strandId - Unique strand identifier (typically the same id passed to
     *   {@link addStrand}).
     * @param type - `'o'` for open (default) or `'c'` for closed.
     * @param memberPrivateKey - Optional shared membership (read) key for a closed strand.
     * @returns The live `Strand` row — the one just inserted, or the matching one already
     *   there. A closed strand's caller should carry THIS row's `MemberPrivateKey` forward:
     *   on a repeat it is the stored key, not the argument.
     * @throws if the node is not started, exposes no owner signing key, the id is blank or
     *   unusable as a storage scope key (`InvalidStrandIdError` — see `storage-scope.ts`), a
     *   row with the same id holds different content, or the control DB rejects the
     *   (unauthorized) insert.
     */
    publishStrand(strandId: string, type?: 'o' | 'c', memberPrivateKey?: string): Promise<StrandRow>;
    /**
     * Found a strand — publish its row cadre-wide AND start the local instance as its
     * founder — in one resumable call. The single entry point for creating a strand; a
     * caller joining one someone else founded uses {@link addStrand} alone.
     *
     * Safe to re-run from any point of interruption, which hand-rolling
     * {@link publishStrand} + {@link addStrand} is not. Either half can already have
     * happened:
     *
     * - **row already published** → the stored row is adopted rather than re-published, so a
     *   run killed after the insert committed no longer dies on
     *   `UNIQUE constraint failed: Strand.Id`. For a closed strand the row's STORED
     *   `MemberPrivateKey` wins over `config.memberPrivateKey`: a caller that mints a key per
     *   attempt (as the reference apps do) would otherwise present a key that does not match
     *   the membership already seated in the strand.
     * - **instance already running** → the tracked instance is returned, and — because the
     *   `Strand` row records its publishing machine (`FounderOwnerKey`) — a founder request
     *   against an instance that was first launched as a joiner now runs the (idempotent,
     *   insert-if-absent) founder bootstrap on it rather than silently skipping it
     *   ({@link StrandInstanceManager.foundExistingStrand}). So a strand that something else
     *   attached first — the reference RN app's `strand:discovered` handler after a restart,
     *   or this node's own {@link StrandWatcher} poll winning `launchStrand`'s
     *   `resolveCohortSeed` window — still ends up with its `Strand.Header` written.
     *
     * Founder-ness is resolved FROM THE ROW, not assumed: this machine founds iff the
     * resolved row's `FounderOwnerKey` is its own owner key. A fresh publish records this
     * machine, so the common path founds; a machine that lost a concurrent founding race to
     * a sibling adopts the sibling's row and ATTACHES instead — deliberately, since two
     * machines bootstrapping the same strand on separate replicas is the double-`Header`
     * hazard. The returned {@link FoundStrandResult.founded} says which happened.
     *
     * `Type` is compared, not adopted: a stored row of the other type means the caller and
     * the control plane disagree about what this strand IS, so it throws.
     *
     * @returns The instance AND the row the strand actually runs under — read the membership
     *   key from the returned row, not from a freshly minted one ({@link FoundStrandResult}).
     * @throws if the node is not started, the id is blank, a published row of the same id has
     *   a different `Type`, or either half rejects.
     */
    foundStrand(config: FoundStrandConfig): Promise<FoundStrandResult>;
    /**
     * Resume onto an already-published `Strand` row: keep its stored content, reject a type
     * disagreement. The stored `MemberPrivateKey` is authoritative — see {@link foundStrand}
     * for why a caller-minted key must lose here (and why that is NOT the same rule as
     * {@link publishStrand}'s, which throws on a key mismatch because it is being asked to
     * WRITE that key, not to resume onto what already exists).
     */
    private adoptPublishedStrand;
    /**
     * Remove this party's `Strand` row from the shared control database — the owner-signed
     * inverse of {@link publishStrand}.
     *
     * Party-wide, unlike {@link stopStrand}, which only stops the strand on THIS node: every
     * cadre node watching the table sees the row vanish on its next poll (default 5 s) and
     * stops its own instance. This node converges immediately — the method forces a watcher
     * poll and stops any still-running local instance before resolving. Removing the row
     * removes OUR party's participation only: other parties in the strand keep their own
     * rows and the strand network carries on, so no cross-party sign-off is involved — this
     * is an owner-signed control-plane write like every other, not "destroy the network".
     *
     * Irreversible for a closed strand (`Type='c'`): the row carries `MemberPrivateKey`,
     * this party's read secret for that network, and the strand's `StrandPartyKey` row —
     * this party's own membership identity, removed (and tombstoned) in the SAME
     * transaction — is stored nowhere else either. With both gone the party can never
     * again sign as its seated member/manager there, and a re-published row mints a fresh
     * identity that does not match the membership already written into the strand's RBAC
     * layer. The strand id itself is NOT
     * blacklisted: a fresh owner-signed {@link publishStrand} re-seats it under a new
     * stamp — only the unsigned consent re-seat is permanently foreclosed (the removal's
     * `Revocation` tombstone names the id, which the consent branch of
     * `Strand.AuthorizedInsert` refuses ever after). Outstanding `FormationInvite` rows
     * bound to the removed strand are unredeemable while the row is absent (the formation
     * recorder resolves the strand as missing and rejects cleanly).
     *
     * Convergence caveats, same class as {@link enrollValidationKey}'s: a sibling that has
     * not yet synced keeps running the strand until its own watcher observes the missing
     * row; a sibling whose `strandFilter` never admitted this strand never observes the
     * removal AT ALL and keeps running its instance indefinitely — opting out of watching a
     * strand is also opting out of its party-wide removal, so such a node's only stop is its
     * own local {@link stopStrand}/`unpublishStrand` call; and a removal committed while
     * ALONE (0 control connections) deletes the row local-only. The accompanying
     * `Revocation` tombstone IS queued and re-issued on the next cohort-growth edge
     * ({@link noteGuardedDelete}/{@link drainPendingRevocations}), so the stamp retirement
     * — and with it the consent re-seat foreclosure — does propagate; but the physical row
     * deletion cannot be replayed, and `queryStrands` reads raw (no retired-stamp filter),
     * so siblings that already hold the row keep running the strand until the collection
     * itself converges (logged loudly; see the delete-while-alone durability note in
     * docs/architecture.md).
     *
     * A no-op (no throw, no tombstone) when the row is already absent — but a
     * locally-running instance of that id is still stopped.
     *
     * NOTE: control-plane only — the strand's local durable storage is retained. Stopping the
     * instance closes the `StrandDatabase` and its libp2p node but purges no blocks, so a
     * closed strand's content stays readable on disk to anyone with the data directory. If a
     * caller ever needs removal to mean "and erase the local copy", that is a separate purge
     * step, not a widening of this method.
     *
     * @param strandId - The `Strand` row id to remove (as passed to {@link publishStrand}).
     * @throws if the node is not started, exposes no owner signing key, the id is blank, or
     *   the signer is not an enrolled owner (the schema's `Strand.AuthorizedDelete` rejects
     *   the write and the row survives). A rejection does NOT imply the row survived: the
     *   local stop runs after the control-plane delete has already committed, so a failure
     *   there throws over a completed removal.
     */
    unpublishStrand(strandId: string): Promise<void>;
    /**
     * Seat this party's own strand membership identity key — the `StrandPartyKey` row —
     * for `strandId`, minting a fresh one when none is given, and adopting the stored one
     * when a row already exists. Insert-if-absent and stable thereafter: the founding
     * `Member.Key` must not change across restarts, or the bootstrap's insert-if-absent
     * guards stop matching.
     *
     * This is the identity half of the closed-strand key split: the row's `PrivateKey` —
     * NOT the strand row's shared `MemberPrivateKey`, which formation hands to every
     * joining party — is what the founder bootstrap derives `Member.Key`/`Manager.MemberKey`
     * from. It replicates to every machine this party owns (same plaintext-at-rest stance
     * as `MemberPrivateKey`; docs/strands.md → "Closed-Strand Member Key Handling") and is
     * never put on the formation wire.
     *
     * Called internally by {@link publishStrand} (closed strands mint at publish) and by a
     * founder launch that finds no row (a publish interrupted before its mint); public so a
     * test harness — or a joiner flow that persists a formation-issued identity — can seat
     * a specific key deliberately.
     *
     * @param strandId - The strand the key is this party's identity for.
     * @param partyMemberPrivateKey - Optional specific key (base64 protobuf, as
     *   `generateStrandMemberKey` mints). When a row already holds a DIFFERENT key this
     *   throws — a party has one identity per strand; rotation is a deliberate
     *   remove-then-insert, not a silent swap.
     * @returns The live party key: the one just seated, or the stored one.
     */
    ensureStrandPartyKey(strandId: string, partyMemberPrivateKey?: string): Promise<string>;
    /**
     * Resolve the party membership key a closed strand's launch threads into the founder
     * bootstrap: the explicit attach-time key when given, else the party's persisted
     * `StrandPartyKey` row, else — on the one machine whose owner key the row names as
     * founder — a freshly minted-and-persisted key, which seats the identity for a publish
     * that was interrupted before its mint. Everyone else resolves undefined: non-founding
     * machines never mint (no mint race between a party's machines), and only a founder
     * bootstrap needs the key at all.
     *
     * Minting does NOT repair a strand founded before the key split: its founding
     * membership was seated under the shared `MemberPrivateKey`, and nothing re-seats it —
     * the founder bootstrap refuses such a strand (`PreSplitStrandIdentityError`) instead.
     *
     * NOTE: "founding machine" here is the ROW's provenance, not the launch's resolved
     * `founder` flag — so an explicit `founder: false` over a row this machine published
     * still mints, an owner-signed write a caller that said "I am not founding" did not ask
     * for. Reached by a storage replica of a row this machine published (always a joiner,
     * see {@link launchStrand}) and kept on purpose: the party needs that identity for the
     * strand either way, the mint is insert-if-absent, and a closed-strand replica runs its
     * membership reconciler — which seats its own `MemberPeer` binding — only with a party key.
     */
    private resolveStrandPartyKey;
    /**
     * Publish an owner-signed `FormationInvite` (open-invitation token) to the
     * shared control database, so a later {@link formStrand} redemption can be
     * validated against it (the consent branch of `Strand.AuthorizedInsert`).
     *
     * Counterpart to {@link createOpenInvitation}, which only mints the
     * out-of-band {@link OpenInvitation} envelope: persisting the matching
     * `FormationInvite` row is what makes the token *redeemable* — the host's
     * {@link ControlFormationUsageRecorder} answers `isTokenValid`/`isTokenUsed`
     * from this row. A host minting a closed-strand invite does both (mint +
     * publish), exactly as the integration harness's `createInvitation` does.
     *
     * Signs with the same self-owner key as {@link publishStrand} (the ed25519
     * key behind this node's PeerId, which must be an enrolled `OwnerKey`).
     * Throws loudly if the node isn't started or exposes no signing key.
     *
     * @param token - Invitation token (the `FormationInvite` primary key); use the
     *   `token` of the {@link OpenInvitation} from {@link createOpenInvitation}.
     * @param sAppId - The sApp a redeemed strand will use.
     * @param options - Optional `expiresAtMs` (epoch ms), `totalUses`, `validationUrl`,
     *   `strandId` (bind a closed/pre-existing host strand for provision-then-record).
     */
    publishFormationInvite(token: string, sAppId: string, options?: {
        expiresAtMs?: number;
        totalUses?: number;
        validationUrl?: string;
        strandId?: string;
    }): Promise<void>;
    /**
     * Enroll an approver public key allowed to sign off on `ValidationUrl` redemptions.
     *
     * A `FormationInvite` carrying a `ValidationUrl` is only redeemable when the approval
     * that comes back from that URL is signed by a key present in `CadreControl.ValidationKey`
     * — this is how a party says which outside approver it trusts. Without an enrollment,
     * every such invitation is unredeemable.
     *
     * Signs with the same self-owner key as {@link publishStrand} (the ed25519 key behind
     * this node's PeerId, which must be an enrolled `OwnerKey`). Throws loudly if the node
     * isn't started, exposes no signing key, or the key is blank — a blank key would reach
     * the database and fail the signature CHECK as an opaque constraint error.
     *
     * Enrolling this node's OWN owner key is permitted and harmless: the domain/action tags
     * baked into each authorization digest mean an owner-key signature can never satisfy the
     * approval rule and an approval can never satisfy an owner rule. No guard is needed.
     *
     * NOTE: enrollment is replicated control state, so a key enrolled here is visible to a
     * sibling cadre node only once control replication converges. A redemption that arrives
     * at a node which has not caught up is refused as not-enrolled — the same convergence
     * gap the schema records on `Strand.StampId`. Enroll before circulating the invitations
     * that depend on the key.
     *
     * @param key - Approver public key to enroll (base64url ed25519 public key).
     */
    enrollValidationKey(key: string): Promise<void>;
    /**
     * Remove an approver public key.
     *
     * Narrows who may approve FUTURE redemptions ONLY. The schema's approval CHECKs run at
     * write time, so a join that was already approved by this key stays valid — removal is
     * not retroactive and does not re-examine committed rows.
     *
     * Rotation is therefore add-then-remove, in that order: removing the only enrolled key
     * while `ValidationUrl` invitations are outstanding makes every one of them unredeemable
     * until a new key is enrolled.
     *
     * Removing a key that is not enrolled is a silent no-op (no throw, no `Revocation`
     * tombstone) — see {@link ControlDatabase.deleteValidationKey}.
     *
     * @param key - Approver public key to remove (base64url ed25519 public key).
     */
    removeValidationKey(key: string): Promise<void>;
    /**
     * The approver keys currently enrolled, sorted. Read-only, so unlike
     * {@link enrollValidationKey} / {@link removeValidationKey} it needs no owner signing
     * key — only a started node.
     */
    listValidationKeys(): Promise<string[]>;
    /**
     * Resolve the owner keypair every owner-signed control write needs — {@link publishStrand},
     * {@link unpublishStrand}, {@link publishFormationInvite}, {@link enrollValidationKey},
     * {@link removeValidationKey}
     * — failing loudly in one two-part shape (not started / no signing key, naming owner
     * genesis as the fix). Narrows `controlDatabase` for the caller: a non-null return means
     * `this.controlDatabase` is non-null too.
     *
     * @param action - Infinitive phrase naming the attempted write, e.g. `'enroll a
     *   validation key'`; interpolated into both messages.
     */
    private requireOwnerSigningKey;
    /**
     * Shared strand launch path for both the explicit (`addStrand`) and the
     * control-discovered (`handleStrandAdded`) entry points. Resolves the cohort
     * seed, starts the strand, and registers it with the hibernation manager
     * before emitting `strand:started`.
     *
     * Founder-ness: an explicit `founder` argument wins (the formation/responder flows pass
     * one deliberately — their consent-seated rows carry a null `FounderOwnerKey`); when
     * unset it is DERIVED from the row, so the control-discovered path
     * (`handleStrandAdded`) and a restart's re-attach found this machine's own strands
     * without the caller having to know. The derivation is pure key comparison — no I/O.
     *
     * Idempotent when the strand manager already tracks `strand.Id` — the watcher
     * rediscovers a row this node already started and calls this again via
     * `handleStrandAdded`; without the guard that re-entry would resolve a fresh
     * (already-connected) cohort seed and re-emit `strand:started` for an
     * instance that never stopped. The guard runs before the cohort-seed RPC
     * fan-out, so a rediscovery costs nothing beyond the map lookup plus the (pure)
     * founder derivation. NOT a silent no-op any more when the launch resolves as a
     * FOUNDER: the tracked instance may have been launched first as a joiner (an app
     * attach, or this node's own watcher poll winning the `resolveCohortSeed` window
     * below), which used to drop the founder request and leave the strand headerless —
     * now the tracked instance is founded in place
     * ({@link StrandInstanceManager.foundExistingStrand}), waking it first if quiesced
     * so the bootstrap actually runs before this resolves.
     *
     * A founder launch refused as pre-split (`PreSplitStrandIdentityError`) is recorded in
     * {@link strandLaunchRefusals} for the formation arm, then rethrown; a founder launch
     * that succeeds clears the record (it ran the bootstrap's pre-split check and passed).
     *
     * An absent `sAppConfig` launches a storage replica ({@link CadreNodeConfig.hostUnclaimedStrands}),
     * which is ALWAYS a joiner whatever the row says: the founder bootstrap writes the sApp
     * into `Strand.Header`, and a replica has none. So a self-founded row whose watcher poll
     * wins the race against its app's `addStrand` after a restart comes up as a replica — and
     * so does a `foundStrand` whose publish a watcher poll saw before its attach. A claim
     * that finds a tracked replica upgrades it in place, over the same node and store
     * ({@link StrandInstanceManager.attachSApp}), BEFORE any founding: the founder bootstrap
     * needs the sApp the attach supplies.
     */
    private launchStrand;
    /**
     * The launch itself, for {@link launchStrand} (which documents the behaviour): found a
     * tracked instance in place, or start a fresh one.
     */
    private startOrFoundStrand;
    /**
     * {@link startOrFoundStrand} for a strand the manager already tracks: a claim of a
     * storage replica gives it the app's schema in place, then a founder request founds it,
     * waking a quiesced instance so the bootstrap has run before this resolves. Emits
     * nothing — `strand:started` fired when the instance launched.
     */
    private claimTrackedStrand;
    /**
     * Resolve a strand's discovery seed — the dialable strand-network multiaddr
     * strings for cohort siblings. Membership comes from the control network's
     * CadrePeer rows; the **strand-network** bootstrap addresses are resolved on
     * demand over the control mesh via the strand-addr RPC — deliberately NOT
     * from `CadrePeer.Multiaddr`, which carries *control* addresses that must not
     * seed the strand mesh.
     *
     * Only siblings we already hold an open control connection to are RPC'd: they
     * are the ones that can answer right now, and dialing them by peerId reuses the
     * live connection. When no connected sibling yet runs the strand the seed is
     * empty (`[]`) — the empty seed self-heals on the next resume / check-in pass.
     * Returns an empty seed when the control DB or node is absent (not yet
     * started / torn down).
     *
     * When `delegatePeerId` is given (a strand launch/resume is imminent), the
     * pass doubles as the delegate ANNOUNCEMENT: our circuit relays are merged
     * into the RPC targets and every request carries the delegate peerId, so each
     * receiver records an admission grant BEFORE `libp2p.start()` (re-)dials the
     * relay reservation — the gate denial there is fatal, not degraded. A
     * party-member relay answers the RPC (its control node admits us as a
     * member); a dedicated ops/ relay does not speak the protocol and the
     * per-peer failure comes back `unreachable` — harmless, it has no membership gate and
     * needs no grant. The relay's direct addr rides along as the dial fallback
     * for a relay we are not yet connected to.
     */
    private resolveCohortSeed;
    /**
     * The strand peer book's contribution to a strand's seed: every live entry's
     * addresses, freshest peer first, minus this node's own entry when `selfPeerId` is
     * known (the book swap files one under the strand transport id; a node must never
     * dial itself). Empty before {@link start} builds the store.
     */
    private strandPeerBookAddrs;
    /**
     * The own-party half of {@link resolveCohortSeed}: strand-network addresses resolved
     * from CONNECTED cohort siblings over the control-mesh strand-addr RPC, doubling as
     * the delegate announcement when `delegatePeerId` is given. Empty when the control DB
     * or node is absent (not yet started / torn down).
     */
    private resolveSiblingSeed;
    /**
     * The co-cadre siblings worth sending a strand-addr RPC to right now: cohort
     * members (self excluded) we already hold an open control connection to. They
     * are the ones that can answer immediately, and dialing them by peerId reuses
     * the live connection instead of opening a second one.
     *
     * Shared by {@link resolveCohortSeed} (launch/resume) and
     * {@link refreshStrandPeerAddrs} (the periodic pass) so both ask the same set.
     * Empty when the control DB or node is absent (not yet started / torn down).
     *
     * The read below is issued even when the node holds no control connection and
     * the answer is therefore empty by construction. That is deliberate on the
     * launch path: `control-database-solo-warm-start.spec.ts` exists to prove this
     * exact read does not stall as an embedder's FIRST awaited control operation,
     * on a warm cohort no one can reach. A caller that re-enters often enough for
     * the read to matter should skip the call itself, as
     * {@link refreshStrandPeerAddrs} does.
     *
     * NOTE: this read is UNBOUNDED and sits on the critical path an embedding app
     * awaits during startup — `addStrand` cannot resolve until it does, and it is
     * the first control operation an embedder's boot order issues (before genesis,
     * before seed bootstrap). Measured fine today: the warm-start-alone shape a
     * report pointed at — a `CadrePeer` list naming peers that are all gone, read
     * off real files after a restart — completes in milliseconds, and
     * `control-database-solo-warm-start.spec.ts` covers it under a deadline. If a
     * control read ever CAN stall (a transactor change that consults the network
     * for a local row, a storage backend with blocking I/O), give this one a
     * timeout — and decide then whether the breach fails `addStrand` or degrades
     * to an empty seed, because those promise callers different things.
     */
    private connectedSiblingTargets;
    /**
     * The circuit relays this node's strand nodes would reserve through: the
     * union of CONFIGURED relays — `network.relayAddrs`, plus any hand-written
     * `network.listenAddrs` circuit entry, both of which a strand node inherits
     * verbatim — and the control node's own live `/p2p-circuit` multiaddrs (a
     * reservation this node discovered rather than configured).
     *
     * The CONFIGURED half reads `network.relayAddrs` and `network.listenAddrs`
     * directly rather than going through {@link resolveListenAddrs}: the control
     * node's resolution takes the `'search'` route, whose bare `/p2p-circuit` entry
     * names no relay, so a configured relay would be unannounceable here until this
     * node's own reservation landed — and the announce must be in place BEFORE a
     * strand node dials its reservation, since the relay's membership gate does not
     * know the strand's derived peerId (see delegate-admission.ts). Configuration is
     * authoritative; the live multiaddrs only ADD relays nobody configured.
     *
     * The `listenAddrs` half is now unreachable on a control node — `relay-addrs.ts`
     * rejects a hand-written `<relay>/p2p-circuit` listen entry outright, because the
     * bring-up quiet period denies the dial that listener makes from inside
     * `libp2p.start()`. Kept because it costs one spread and this is the one place
     * that would silently stop announcing if that rejection is ever relaxed.
     *
     * NOTE: a relay the STRAND node discovers on its own (autorelay — in neither
     * source) gets no announcement, and a membership-gated one will deny it; fine
     * now, every realistic topology feeds one of the two sources.
     */
    private circuitRelayTargets;
    /**
     * Record the announce timestamps {@link refreshDelegateGrants} throttles on,
     * for every relay a delegate-carrying announce pass dialed.
     *
     * Recorded OPTIMISTICALLY at announce time, whatever `collectStrandAddrs`
     * reports per peer: a dedicated `ops/` relay never speaks the strand-addr
     * protocol, so recording only on success would re-announce to it on every
     * reconcile tick, one wasted protocol negotiation each. A failed INITIAL announce
     * costs the strand supervisor its first attempt only (the relay denies the
     * reservation; every re-drive re-announces first through
     * {@link announceDelegateToRelay}); a failed REFRESH retries within
     * `DELEGATE_GRANT_TTL_MS / 2` (15 min), still inside the 30 min TTL.
     */
    private recordDelegateAnnounces;
    /**
     * Re-announce every running strand's delegate peerId to this node's circuit
     * relays, throttled to once per `DELEGATE_GRANT_TTL_MS / 2` per
     * (relay, strand). A grant must outlive the reservation: a dropped relay
     * connection makes the strand's circuit-relay transport re-dial and face the
     * connection gate again, so the relay must still hold a live grant then.
     * RELAY targets only — siblings get their announce on every launch/resume
     * seed pass, and a grant only matters where a reservation can be re-dialed.
     *
     * Strands announce CONCURRENTLY: this runs ahead of the reconcile pass's
     * sibling enumeration, and one unreachable relay costs a dial timeout per
     * target, which must not stack up per strand.
     */
    private refreshDelegateGrants;
    /**
     * Announce ONE strand's delegate peerId to ONE relay, UNTHROTTLED — the
     * `beforeRedrive` hook of that strand node's per-relay reservation supervisor
     * (`strand-instance-manager.ts` → `buildStrandRuntime`), run before every
     * re-drive after the first attempt.
     *
     * Why a re-drive must re-announce first: a party control node running the relay
     * server admits the strand node's derived peerId on an in-memory delegate grant
     * (`delegate-admission.ts`), and a relay restart drops every grant it held
     * without telling the announcer. {@link refreshDelegateGrants} would re-announce
     * on its own at most every `DELEGATE_GRANT_TTL_MS / 2` (15 min) per (relay,
     * strand) — far slower than the supervisor's backoff — so without this the first
     * re-drives after a relay restart would be denied at the relay's connection gate.
     * The throttle map is updated afterwards, so the periodic pass does not announce
     * again right away.
     *
     * Against a dedicated ops relay (no strand-addr RPC) the request fails per-peer
     * and `collectStrandAddrs` reports it `unreachable`: one wasted protocol negotiation per
     * re-drive attempt, bounded by the supervisor's backoff. Never throws on that
     * path; a relay addr that names no peer id is logged and skipped (the hook's
     * caller runs the drive regardless).
     *
     * NOTE: against a relay that is DOWN this hook costs up to two strand-addr
     * timeouts (dial by peer id, then by addr; 23 s each at the default declared link round trip)
     * before the reservation drive even starts, so one failed re-drive holds the supervisor
     * `driving` for those 46 s plus the drive's own deadline — 64 s at the default, and longer on
     * a host that declared a slower one (`link-budget.ts`).
     * Bounded and harmless while the relay is unreachable anyway; if recovery
     * latency after a relay comes back ever matters, skip the announce when the
     * control node holds no connection to the relay (the drive's own dial fails
     * faster) rather than shortening the strand-addr timeout.
     */
    private announceDelegateToRelay;
    /** One strand's share of {@link refreshDelegateGrants}: announce to the relays whose grant is due. */
    private announceDelegateToDueRelays;
    /**
     * Keep each running strand's own libp2p address book warm: re-merge its strand
     * peer book on every pass, and re-ask each connected SIBLING for its strand
     * addresses over the control mesh when that (sibling, strand) is due
     * ({@link strandAddrAskDueAt}).
     *
     * Without this, a strand's address book is written exactly once — the
     * launch/resume seed — and everything below cadre-core that dials a strand peer
     * by bare peer id (Optimystic's cluster and repo clients, FRET ping/announce)
     * loses its address for any sibling it is not currently connected to: a sibling
     * that restarted its strand node or rotated its relay reservation is never
     * re-resolved, and even the original seed addresses fall off at the peerStore's
     * one-hour expiry (see `peer-addr-book.ts`).
     *
     * Due times are per (sibling, strand) and set from each sibling's own outcome, so
     * a sibling that connects late — a phone joining after the party's always-on
     * machines — is asked on the next tick, and one that could not answer or refused
     * (its view of the membership may not include us yet) is retried within
     * {@link STRAND_PEER_ADDR_RETRY_MS} rather than {@link STRAND_PEER_ADDR_REFRESH_MS}.
     *
     * Distinct from {@link refreshDelegateGrants}, deliberately: that pass covers
     * RELAYS on a `DELEGATE_GRANT_TTL_MS / 2` throttle to keep circuit-relay
     * admission grants alive, this one covers SIBLINGS on an address-expiry
     * throttle to keep the address book warm. They overlap only in that both carry
     * `delegatePeerId`, so a sibling that also runs a relay gets its grant
     * refreshed here as a side effect. Merging them would tie an admission-grant
     * TTL to an address-expiry window that has nothing to do with it.
     *
     * Strands refresh CONCURRENTLY, like `refreshDelegateGrants`, so one
     * unreachable sibling's dial timeout does not stack up per strand.
     */
    private refreshStrandPeerAddrs;
    /**
     * The siblings {@link refreshStrandPeerAddrs} may ask this pass: the connected
     * cohort, or none when enumeration fails (logged, never thrown).
     *
     * `connectedSiblingTargets`' membership read is unbounded, and with zero
     * connections its answer is empty whatever the table holds, so decide it from the
     * connection list instead of paying for the read once a tick.
     *
     * NOTE: otherwise the read runs on EVERY tick with a running strand, not only when
     * some (sibling, strand) is due: pruning a departed sibling needs the current
     * target set, and whether anyone is due cannot be told without it (a connected
     * non-member never gets a due time to compare). One more `CadrePeer` read per 15 s
     * tick, on top of the two `runReconcileControlCohort` already makes; if those reads
     * get costly, share one row-set across the pass (see the NOTE there) rather than
     * skipping ticks here.
     *
     * NOTE: one strand-addr RPC per (running strand × due sibling) — each a tiny
     * request/response on an already-open control connection. If a node ever runs
     * MANY strands at once, batch the RPC to carry several strand ids per request
     * rather than one fan-out per strand.
     */
    private strandAddrRefreshTargets;
    /**
     * One strand's share of {@link refreshStrandPeerAddrs}: RPC the siblings that are
     * due, union their answers with this strand's peer-book addresses, and merge the
     * lot into the strand's address book. Errors are logged and swallowed so one
     * strand's failure never costs the others their refresh.
     *
     * The peer book merges on EVERY pass, whether or not any sibling is due or
     * connected: nothing re-resolves another party's addresses, so this re-merge is the
     * ONLY thing standing between them and the peerStore's one-hour expiry — and it is
     * also how a re-formation's freshly carried addresses reach a running strand on the
     * next tick. A strand with nobody due and no book entry does nothing.
     */
    private refreshOneStrandPeerAddrs;
    /**
     * RPC `due` siblings for `strandId` and set each one's next due time from its own
     * outcome: an answer, even an empty one, waits the full refresh interval; anything
     * else retries in {@link STRAND_PEER_ADDR_RETRY_MS} (or the refresh interval, if
     * configured shorter). Stamped before the caller
     * re-checks that the strand is still running, so a strand torn down mid-pass still
     * records who was asked.
     */
    private askSiblingsForStrandAddrs;
    /**
     * Merge strand-network addresses into ONE strand node's libp2p address book,
     * attributed per peer. Best-effort throughout: an address-book write must never
     * fail a launch, a resume, or a reconcile pass.
     *
     * `addrs` is the peer-agnostic union the strand-addr RPC returns, so
     * {@link groupAddrsByPeerId} attributes each entry to the **strand transport**
     * peerId in its final `/p2p/` component — never the sibling's control peerId,
     * which names a different libp2p node entirely. Entries that name no peer are
     * dropped there and counted here, once per pass.
     *
     * NOTE: a member could answer with arbitrary multiaddrs bound to arbitrary peer
     * ids and poison this address book. That is the same exposure the launch-time
     * `bootstrapNodes` seeding already accepts, and the cost is bounded: an address
     * grants no authority, the dialed peer authenticates by peer id at the
     * handshake, and a bad entry costs one failed dial that ages out at the
     * peerStore's one-hour expiry. No new gating here — cross-party strand trust is
     * `backlog/strand-network-nat-relay-reachability`.
     *
     * NOTE: one input ages out on a slower clock — the strand peer book's entries
     * ({@link strandPeerBookStore}). Nothing can re-resolve another party's addresses,
     * so {@link refreshStrandPeerAddrs} re-merges the book every pass, which means a
     * junk entry from a responder or a peer's identify survives until the book drops it
     * (14 days unrefreshed, or the peer's next connection replacing the entry) rather
     * than an hour. Bounded to 16 peers × 16 addrs per strand, forgotten on
     * `unpublishStrand` / `forgetJoinedStrand`, and still authority-free — so the
     * exposure is a handful of failed dials, not a trust hole.
     */
    private mergeStrandPeerAddrs;
    /**
     * The local strand instance's dialable strand-network multiaddrs for the
     * strand-addr RPC, ordered signaling-first (reusing the control node's
     * {@link orderSignalingFirst}). Returns `[]` when the strand is not running
     * locally or has no live libp2p node (hibernating / quiescing / never
     * participated) — a node only answers for a strand it is actively meshing,
     * regardless of the strand's mode. A `bootstrap`-mode first node still has a
     * live node, so it answers and a later sibling can dial in.
     */
    private getStrandMultiaddrs;
    /**
     * Leave a strand joined from another party, for the whole party: remove its party-wide
     * `JoinedStrand` row (owner-signed, with a `Revocation` tombstone), then this machine's
     * unpublished record, its strand peer book entries and any session-kept entry, then
     * {@link stopStrand} it here. Every other machine's watcher then sees the row gone and
     * detaches the strand, a storage replica included; a machine offline at the time reaps the
     * row once the tombstone reaches it. The joiner's counterpart of {@link unpublishStrand},
     * which only works on a row the party's own `Strand` table holds. For one of those, or for
     * a join still local-only, there is no party-wide row and this is a local forget plus
     * {@link stopStrand}.
     *
     * The other members of the strand are not told, and this party's membership row in the
     * strand stays, so a later re-formation reuses the same identity.
     *
     * @throws when a party-wide row exists and this machine cannot sign its removal (not an
     *   enrolled owner) — {@link stopStrand} stops the strand on this machine only — or when
     *   the party-wide table cannot be read.
     */
    forgetJoinedStrand(strandId: string): Promise<void>;
    /**
     * Record `row` as a join from another party when this party's control database names it
     * neither as its own strand nor as a party-wide join — the one case nothing else would
     * re-offer after a restart (`JoinedStrandSession.rememberForeign`).
     *
     * Best-effort, for {@link addStrand}: a failure costs the strand its re-offer after the
     * next restart, not this attach, so it is reported and the attach goes on.
     * {@link formStrand}, whose join nothing else would name, fails loudly instead.
     *
     * NOTE: "no control row" also describes a row the party has just unpublished. A claim
     * of such a row the app kept from an earlier offer, made after the watcher already
     * withdrew it, is remembered as a join and survives the removal on this machine until
     * {@link forgetJoinedStrand}. Contrived today (a claim of a row the node itself is still
     * offering skips this method); if it shows up, check the strand's `Revocation`
     * tombstone here before recording.
     */
    private rememberForeignStrand;
    /**
     * Self-revocation arm of the joined-strand records: a party removed from a strand must
     * not re-attach it on every launch of every machine. The strand keeps running this
     * session here — the `strand:revoked` contract is that nothing is torn down for the app —
     * and its party-wide row is queued for removal by the next connected owner reconcile pass
     * (`JoinedStrandSession.forgetAfterThisSession`). A no-op for this party's own strands,
     * which have neither record; the strand peer book is forgotten either way, since a
     * removed party must not keep dialing the strand's peers.
     *
     * NOTE: accepted tradeoff — a sibling machine that has not raised `strand:revoked` itself
     * detaches the strand (`strand:stopped`) when the party-wide removal reaches it, instead
     * of keeping it for the session, which weakens "nothing is stopped on the removed
     * machine's behalf" for siblings. Weighed against a party-wide row that brings a revoked
     * strand back on every start of every machine. Revisit if apps need the "you were
     * removed" screen on every device: the sibling could re-check its own revocation state
     * (`refreshRevocationEnforcement`) before detaching a vanished joined row.
     *
     * NOTE: a manager can re-admit a removed party directly (`addMemberByManager`), and the
     * membership loop then finishes the join on its own — but the records are gone by then,
     * so the next start does not re-attach the strand. Re-forming records it again. If direct
     * re-admission becomes a routine flow, re-record the join when the revoked-peer gate
     * clears for this node.
     */
    private forgetRevokedJoin;
    /**
     * Forget a strand's entries in the peer book (see {@link strandPeerBookStore}):
     * fire-and-log, like every book write — the removal is visible synchronously by the
     * store's contract, and a failed persist costs restart survival only.
     */
    private forgetStrandPeers;
    /**
     * The strand peer book's observation writer (`StartStrandConfig.onStrandPeerIdentified`):
     * a strand node identified a strand peer at `observation.addrs`, so remember it as an
     * unsigned entry seen just now. The observer never reports self, and the store binds
     * every address to the peer id before filing it.
     */
    private observeStrandPeer;
    /**
     * Merge one entry into the peer book. Fire-and-log: the entry is visible
     * synchronously by the store's contract, and the promise tracks durability only. A
     * persist failure costs restart survival, never this session's seed — the same trade
     * {@link retainDialTarget} makes.
     */
    private rememberStrandPeer;
    /**
     * Stop a strand on THIS node only: untrack it from hibernation, drop its sApp config,
     * stop the local instance, and emit `strand:stopped`. The shared `Strand` row is left
     * intact, so on the next node RESTART the strand is rediscovered and surfaces as
     * `strand:discovered` again — but never again in THIS session: the stop suppresses the
     * id in the watcher (`StrandWatcher.suppressStrand`) and drops it from
     * {@link getDiscoveredStrands}, so neither a later poll nor a drain can undo a
     * deliberate stop. Only an explicit {@link addStrand} does, which is the caller
     * reversing its own decision. Party-wide removal is {@link unpublishStrand}. A strand
     * joined from another party comes back the same way, from its remembered join;
     * {@link forgetJoinedStrand} is how to leave one for good.
     */
    stopStrand(strandId: string): Promise<void>;
    /**
     * Local teardown for one strand, shared by the caller-driven {@link stopStrand} and the
     * watcher-driven `handleStrandRemoved`: untrack hibernation, drop the sApp config and any
     * recorded launch refusal, stop the instance, emit `strand:stopped`. Touches no
     * control-plane row — which side of the removal the node is on is the caller's concern,
     * not this method's.
     *
     * The stop + emit are skipped when the strand manager holds no instance for `strandId` —
     * e.g. a party owner that published a strand's row but never ran it locally, or an
     * explicit {@link stopStrand} for an id this node never started. `hibernationManager`
     * untrack and the `sAppConfigs` / {@link strandLaunchRefusals} / {@link discoveredStrands}
     * deletes stay unconditional (all no-ops when there is nothing to remove), so a launch
     * that failed before an instance was ever tracked still gets its stray entries cleared.
     *
     * Dropping the {@link discoveredStrands} entry here covers both callers, and both
     * readings are the intended one: `handleStrandRemoved` arrives because the control row
     * is gone, and an explicit {@link stopStrand} is a deliberate abandonment — neither
     * strand may be re-offered to a later `getDiscoveredStrands()` drain.
     *
     * The watcher-level suppression that makes a stop permanent is deliberately NOT here,
     * only in {@link stopStrand}: the two callers diverge on it. A vanished control row
     * that reappears is a fresh strand and must be offered again.
     */
    private detachStrand;
    /**
     * Record activity on a strand (resets hibernation timer).
     *
     * Also drives the server push-wake fan-out: whatever already drives activity on
     * this node's strand (its relay/app layer doing pull-on-read) additionally wakes
     * hibernating mobile peers — the same imperative seam local-wake uses, with no
     * new contract. No-op for the fan-out when push is not configured.
     */
    recordStrandActivity(strandId: string): void;
    /**
     * Explicit fan-out trigger: an always-on host/relay/sApp calls this when it
     * observes activity for a strand this node participates in, to wake hibernating
     * mobile members over a direct control-network dial (falling back to FCM/APNs
     * for suspended phones). This is the supported, honest v1 trigger — Optimystic
     * exposes no passive repo-level "new transaction" hook to drive it automatically
     * (see the deferred passive-detector follow-up). No-op when push is not
     * configured; best-effort (never throws — the check-in wake is the backstop).
     *
     * @param strandId - the strand that saw activity.
     * @param reason - free-form cause hint carried in the wake (default `activity`).
     */
    notifyStrandActivity(strandId: string, reason?: string): void;
    /**
     * Force wake a hibernating strand. A requested wake is activity, recorded before the
     * wake starts: a check-in holding the strand — or rebuilding it, a rebuild this wake then
     * joins — leaves it up instead of re-quiescing it at the end of its window.
     */
    wakeStrand(strandId: string): Promise<void>;
    /**
     * Force a single strand to hibernate immediately, bypassing the idle/hibernate
     * timers — the background-entry path. No-op if the strand is realtime
     * (never-hibernate latency hint), already hibernating, or unknown.
     *
     * Routes through {@link HibernationManager.forceHibernate}, which cancels the
     * strand's pending idle/hibernate (and check-in) timers — so a stale timer
     * can't re-fire on or resurrect the strand — then runs the same `onHibernate`
     * path as the timer (`quiesceStrand` + `status='hibernating'` +
     * `strand:hibernating`). Unlike the timer path it does NOT re-arm check-ins:
     * the strand stays down until the caller drives a wake (e.g. {@link serviceWake}).
     */
    hibernateStrand(strandId: string): Promise<void>;
    /**
     * Force-hibernate every tracked strand whose latency hint is not realtime,
     * tolerating per-strand failure (one strand failing to quiesce never aborts
     * the others). Realtime strands are left running — the caller keeps the control
     * connection and realtime strands alive for as long as the OS permits.
     *
     * @returns the strandIds actually hibernated (now in `hibernating` status);
     *   realtime strands are excluded.
     */
    hibernateAll(): Promise<string[]>;
    /**
     * On-demand equivalent of a check-in cycle, for a push-delivered wake on
     * mobile: resume the strand, hold it live for `windowMs` so its strand network
     * reaches the cohort and the app can pull pending activity, then re-hibernate
     * if no activity was recorded (else leave it active).
     *
     * Idempotent / coalesced two ways: concurrent `serviceWake`s for the same
     * strand share one in-flight operation ({@link serviceWakePromises}), and the
     * underlying resume coalesces with a racing push-wake via
     * {@link HibernationManager}'s wake coalescing — one runtime build, one window,
     * one re-hibernate decision. A wake or activity from elsewhere that lands during
     * the resume or the window leaves the strand up; this call's own wake does not.
     * Returns `{ serviced: false }` (never throws) when
     * the node is not running or the strand is unknown, and surfaces a resume
     * failure as `{ serviced: true, hadActivity: false }` after re-hibernating.
     *
     * @param strandId - the strand a push said has pending activity.
     * @param opts.windowMs - override the live-window duration (defaults to the
     *   configured `checkInWindowMs` / {@link DEFAULT_CHECKIN_WINDOW_MS}).
     */
    serviceWake(strandId: string, opts?: {
        windowMs?: number;
    }): Promise<ServiceWakeResult>;
    /** Body of {@link serviceWake}; serialised per-strand by its coalescing guard. */
    private runServiceWake;
    /**
     * Get the control network node (for advanced use)
     */
    getControlNode(): Libp2p | null;
    /**
     * The boot-path half of {@link reserveRelays}: reserve through every
     * `network.relayAddrs` entry, or fail `start()`.
     *
     * WHY IT RUNS HERE, AT THE END. `network.relayAddrs` used to resolve to a
     * CONFIGURED circuit listener, which libp2p dials from inside `libp2p.start()`
     * — so the relay was already a connected peer, and therefore already in this
     * node's Optimystic cohort, before `ControlDatabase.initialize()` ran. Building
     * that database is a long chain of cohort-consulting block probes (catalog
     * hydration, then one per table, then the indexes), and a sibling that has not
     * yet replicated this node's `CadrePeer` row correctly refuses every one of
     * them, so bring-up died on `BlockUnavailableError` — deterministically, on
     * every boot of a relay-only node. Retrying could not converge either: the
     * condition that clears the refusal is this node's own row reaching the
     * sibling, and writing that row needs the database the retry is building.
     *
     * So the invariant is ordering, not retrying: the control database is built
     * while this node holds ZERO control connections (a cohort of one, entirely
     * local), and only then does it reach out. Everything above in {@link start}
     * has completed by the time this runs.
     *
     * BUDGET: the supervisor's first attempt is what `start()` waits on — deliberately the drive's
     * ordinary deadline rather than a boot-specific one. That deadline is now COUNTED, four link
     * round trips at the declared `network.linkRoundTripMs` plus the relay's two admission
     * decisions (18 s at its default, where it was a fixed 10 s): a healthy dial-plus-reserve is sub-second even over a WAN, so this is slack for
     * a slow link, while going much longer would make a dead relay indistinguishable from a hung
     * start and much shorter would fail nodes on links that were merely slow. A host that declares
     * a slower link lengthens it without touching this path — `link-budget.ts`. The retries carry
     * on in the background after this resolves, exactly as they do for a {@link reserveRelays}
     * caller.
     *
     * `network.requireRelay === false` softens only the outcome below: a first
     * attempt that lands no `/p2p-circuit` address is logged instead of thrown, and
     * `start()` carries on with the retry supervisor already running in the
     * background (the same supervisor {@link reserveRelays} always starts).
     */
    private driveControlRelayReservation;
    /**
     * Start keeping a relay reservation: dial the given relay(s) from the control
     * node, ask the first one that answers for a reservation slot, wait until the
     * resulting `/p2p-circuit` address makes this node dialable — and keep a
     * supervisor running that re-drives whenever the reservation is later lost.
     *
     * The FAIL-SOFT entry point, for a caller that discovers its relay at runtime
     * (a browser tab, a host UI). A node that names `network.relayAddrs` gets the
     * same drive from {@link driveControlRelayReservation} at the end of
     * {@link start}, which is fail-fast instead. Both fill the pending reservation
     * the bare `/p2p-circuit` search listener registered; calling this afterwards
     * simply replaces the supervisor with one over the new list.
     *
     * Resolves once the FIRST attempt has settled, exactly as it did when it drove
     * once; the retries continue in the background until {@link stop} or the next
     * `reserveRelays` call. Fail-soft — never throws. An unreachable relay, a
     * missing control node, or a timeout all resolve to a non-`reserved` status, so
     * a caller can await this during startup without a dead relay aborting the node.
     *
     * Passing an empty list stops the supervisor and resets the posture to `none`
     * without dialing or waiting.
     */
    reserveRelays(addrs: string[], opts?: RelayReservationSupervisorOptions): Promise<RelayReservationState>;
    /**
     * The node's CURRENT relay-reservation posture, recomputed from the control
     * node's live multiaddrs on every call.
     *
     * Deliberately not memoised: a reservation can be lost after
     * {@link reserveRelays} succeeds (the relay restarts, the connection drops) and
     * a cached `reserved` would let a caller mint invitations carrying circuit
     * addresses that no longer route.
     *
     * A lost reservation now recovers on its own — the supervisor {@link reserveRelays}
     * starts re-drives on a backoff, reporting `retrying` meanwhile. `error` here
     * means nothing is going to try again: no supervisor, or no control node.
     */
    getRelayReservationState(): RelayReservationState;
    /**
     * Get the control database (for advanced queries)
     */
    getControlDatabase(): ControlDatabase | null;
    /**
     * Open control-network connections right now. A lower-bound proxy for replication
     * reach: 0 connections ⇒ a control write commits local-only. The private
     * `committedAlone` write-while-alone seam is defined in terms of this.
     *
     * It approximates the precise signal (the block's cluster size), and a caller that
     * samples it AFTER a write samples a slightly wider window than `committedAlone`
     * does inside the write itself. It exists so an embedder can warn an owner before a
     * control write that this machine currently sees none of its siblings, and report
     * after one that the write may not have travelled — a warning shown unconditionally
     * is a warning people learn to ignore.
     */
    getControlConnectionCount(): number;
    /**
     * Force a poll of the strand watcher (for testing)
     */
    forceStrandPoll(): Promise<void>;
    /**
     * Get the sApp configuration for a strand
     */
    getSAppConfig(strandId: string): SAppConfig | undefined;
    /**
     * Initialize the seed bootstrap service with an owner key.
     * Must be called before using seed-related methods that require signing.
     *
     * @param ownerPrivateKey - The owner's private key (base64url encoded)
     */
    initializeSeedBootstrap(ownerPrivateKey: string): Promise<void>;
    /**
     * Push the multiaddrs that future invites should advertise. Pass `null` to
     * revert to the libp2p-reported addresses (the default). The host calls this
     * at spawn and on every NAT change.
     *
     * Entries need NOT carry a `/p2p/<peerId>` suffix — {@link resolveInviteAddresses}
     * appends this node's own before anything publishes or dials them (see
     * {@link normalizeSelfAddrs}). Passing them suffixed is equally fine.
     */
    setInviteAddresses(addresses: string[] | null): void;
    /**
     * Resolve the addresses to embed in invites. Prefers pushed addresses, then
     * any config-supplied resolver, then the libp2p-observed multiaddrs. The two
     * app-supplied sources are normalized onto `/p2p/<self>` (see
     * {@link normalizeSelfAddrs}) so neither hook has to remember the suffix;
     * libp2p's own addresses already carry it.
     */
    private resolveInviteAddresses;
    /**
     * Normalize addresses an app handed us for THIS node onto `/p2p/<self>`, the
     * same invariant {@link normalizeDialAddrs} enforces on the way out.
     *
     * `setInviteAddresses` (the admin API `PUT /admin/invite-addresses`) and
     * `network.inviteAddressResolver` both take arbitrary strings, and whatever
     * they return ends up in this node's published `CadrePeer` record — so ONE
     * unsuffixed entry from either hook is enough to give every sibling in the
     * party a mixed candidate list for this peer. Establishing the suffix here,
     * where those strings enter the system, means neither hook has to know the
     * rule; `cadre-host`'s `buildInviteAddresses` already appends it, and
     * re-normalizing an already-suffixed address is a no-op.
     *
     * Unparsable and other-peer-addressed entries are passed through untouched
     * rather than dropped: publication is not the place to police an address's
     * validity, and {@link resolvePeerAddrs} already drops both on the read side.
     * Before `start()` resolves an identity there is no peer id to append, so the
     * list is returned as given.
     */
    private normalizeSelfAddrs;
    /**
     * Enumerate the cadre's `CadrePeer` membership — the ADDRESSABLE surface (see
     * {@link isMember}). Rows whose stamp is retired in `CadreControl.Revocation`
     * never reach here: {@link ControlDatabase.queryCadrePeers} excludes them, so a
     * revoked peer is not addressable either.
     */
    listMembers(): Promise<Array<{
        peerId: string;
        multiaddr: string | null;
    }>>;
    /**
     * Probe whether a given peer is a `CadrePeer` member.
     *
     * This is the ADDRESSABLE surface ("do I have a dialable address record for this
     * peer") — it includes this node's own self-published row. Address resolution and
     * push fan-out use this. A peer whose stamp is retired in `CadreControl.Revocation`
     * is excluded here too (the filter lives in
     * {@link ControlDatabase.queryCadrePeers}): revocation removes a peer from the
     * addressable surface, not only the trust-facing one, so a revoked peer is no
     * longer dialed, RPC'd, or handed out as an address. The trust-facing gate is
     * {@link isAuthorizedMember}.
     */
    isMember(peerId: string): Promise<boolean>;
    /**
     * Enumerate the party's AUTHORIZED members — the trust-facing set, distinct from
     * the addressable set ({@link listMembers}). A peer is authorized iff ALL hold:
     *
     *  1. it is not this node itself — a node publishes its own `CadrePeer` address
     *     row so its dialable address rides in seeds, but "self" is not a peer this
     *     node authorized;
     *  2. its `CadrePeer` row carries a complete voucher (`StampId`, `VouchOwner`,
     *     `VouchSig` all non-null);
     *  3. `VouchOwner` is in the NODE-LOCAL trusted-owner anchor
     *     ({@link getTrustedOwnerStore}) — never the replicated `OwnerKey` table,
     *     which any stranger can genesis-pollute; and
     *  4. `VouchSig` verifies as that owner's signature over the row's voucher
     *     digest ({@link verifyCadrePeerVoucher}), so the anchored owner really
     *     vouched THIS peer id under THIS row's nonce; and
     *  5. the row's `StampId` is NOT retired in `CadreControl.Revocation` — enforced
     *     upstream in {@link ControlDatabase.queryCadrePeers}, which drops retired rows
     *     before ANY reader (this predicate included) sees them, so a row resurrected
     *     by replaying the captured admission approval on a node that had not yet
     *     converged on the tombstone (the write-time `NotRevoked` CHECK only sees
     *     local rows) is still inert to every reader that has the tombstone.
     *
     * Fail-closed at every step: a missing anchor (pre-start), an empty anchor (a
     * not-yet-enrolled node authorizes no one), a null/partial voucher, an
     * unanchored `VouchOwner`, or a bad signature all yield "not authorized" —
     * having an address row is NOT membership. The control-network wake and
     * strand-address gates consult this set, NOT the addressable one.
     *
     * NOTE (rotation): if a party owner rotates keys and only the NEW key is pinned
     * in the anchor, rows the OLD key vouched fail check 3 until re-vouched — a
     * legit member goes un-authorized on readers that only pin the new key. Full
     * rotation handling (re-vouch on rotate) is the
     * `flip-strand-membership-rotation-known-gap` work, not this predicate's.
     *
     * @param retry - Whether the underlying membership read may retry a transient cluster
     *   failure. Only {@link refreshAuthorizedControlPeers} passes `false`, because it runs
     *   as the control database's membership listener with that database's write lock held;
     *   see its comment.
     */
    listAuthorizedMembers(retry?: boolean): Promise<Array<{
        peerId: string;
        multiaddr: string | null;
    }>>;
    /**
     * Checks 2–4 of the authorized-membership predicate (see
     * {@link listAuthorizedMembers}) for one `CadrePeer` row: complete voucher,
     * `VouchOwner` in the node-local anchor, signature valid over the row's
     * (PeerId, StampId) voucher digest.
     *
     * NOTE: verifies the ed25519 signature on every call (no memo of already-
     * verified (peerId, stampId, vouchSig) triples). Cadres are a handful of
     * devices and the gates run per inbound request, so this is cheap today; if
     * membership or gate traffic ever grows, cache verified triples keyed on the
     * row's `StampId` (which rotates with every re-vouch).
     */
    private hasAnchoredVoucher;
    /**
     * Probe whether a given peer is an AUTHORIZED party member (see
     * {@link listAuthorizedMembers}) — the gate the control-network wake and
     * strand-address responders consult, NOT {@link isMember} (the addressable
     * surface). Deliberately scans the full membership (one `CadrePeer` query)
     * rather than adding a single-row read path: cadres are small, and one code
     * path keeps the predicate impossible to drift from the list.
     */
    isAuthorizedMember(peerId: string): Promise<boolean>;
    /**
     * Push-wake a hibernating cadre peer over the control network.
     *
     * Resolves the target's signed control-network address from its `CadrePeer`
     * record (via {@link resolvePeerAddrs}, signaling/relay first — so a NAT'd peer
     * is reachable through its circuit-relay address), dials `WAKE_PROTOCOL`, sends
     * the {@link WakeRequest}, and returns the peer's {@link WakeAck}. The receiver
     * gates the request on cadre membership and only resumes a strand it already
     * participates in; it acks once it has decided, before the strand is up. The
     * dial deadlines derive from this node's `network.linkRoundTripMs`.
     *
     * @param targetPeerId - The hibernating cadre peer to wake.
     * @param strandId - The strand the caller knows has pending activity.
     * @param reason - Optional cause hint, e.g. `"activity"` or `"manual"`.
     * @throws if the node is not started or the target has no dialable address.
     */
    pushWake(targetPeerId: string, strandId: string, reason?: string): Promise<WakeAck>;
    /**
     * Enable the seed listener for receiving seeds via the /sereus/seed/1.0.0 protocol.
     * This is for drone nodes that need to receive seeds without being an owner.
     * Does not require an owner key.
     */
    enableSeedListener(): Promise<void>;
    /**
     * Get the seed bootstrap service (for advanced use)
     */
    getSeedBootstrapService(): SeedBootstrapService | null;
    /**
     * Make `service` this node's seed service and register its inbound seed handler.
     * The field is set before the registration is awaited, so a concurrent
     * {@link enableSeedListener} finds it and does not register a second handler; a
     * failed registration puts the previous service back and rethrows.
     *
     * NOTE: libp2p's registrar stores the handler before its peer-store merge, so a
     * failed merge leaves SEED_PROTOCOL registered with no service owning it and a retry
     * here rejects as a duplicate; if peer-store writes can fail in practice, unhandle on
     * a non-duplicate failure (never on a duplicate — that handler belongs to someone else).
     */
    private installSeedBootstrapService;
    /**
     * The event callbacks every {@link SeedBootstrapService} this node owns is
     * wired with — shared by the owner-capable service ({@link initializeSeedBootstrap})
     * and the listener-only one ({@link enableSeedListener}) so the two cannot drift.
     *
     * A seed applied by the INBOUND protocol handler writes no `CadrePeer` row of
     * its own (it merges the libp2p peer store and dials owners), so the automatic
     * write-driven refresh never fires for it — yet applying it can ANCHOR a new
     * owner key, which flips rows already present from unauthorized to authorized.
     * Hence the explicit refresh here; without it a peer the freshly anchored owner
     * vouched for stays denied until the next timed cohort reconcile.
     */
    private seedEventCallbacks;
    /**
     * Re-materialize the authorized-peer snapshot that the fail-closed per-stream
     * control-DB gate ({@link authorizeInboundControlStream}) judges against.
     *
     * NO `CadrePeer` writer needs to call this: the control database notifies it
     * after every committed member-row write (`ControlDatabase.mutateCadrePeer`,
     * wired in {@link start}), which is exactly what makes the refresh automatic
     * rather than a caller obligation. It stays public for the changes that write
     * NO row locally and so raise no notification:
     *
     * - a membership row that arrived by REPLICATION (otherwise picked up on the
     *   next timed cohort reconcile — bounded staleness by design), and
     * - a newly anchored trusted owner key ({@link applySeed}), which flips rows
     *   ALREADY present from unauthorized to authorized without touching them.
     *
     * Coalescing: marks the snapshot stale and resolves once a refresh that began
     * after this call has completed, so a caller that awaits it always observes
     * its own change. Concurrent callers share one read. Idempotent and
     * best-effort (a failed read keeps the previous snapshot); never rejects.
     */
    refreshMembershipGate(reason?: string): Promise<void>;
    /**
     * Re-materialize a CLOSED strand's revoked-peer deny set now, and hang up any
     * connected peer it newly covers — the strand-side counterpart to
     * {@link refreshMembershipGate}.
     *
     * Unlike that one, NOTHING calls this automatically: strand membership is
     * written through the strand's own `Database` handle
     * (`strand-membership-writer.ts`), which raises no notification this runtime
     * can hook, and a revocation that arrives by REPLICATION raises none either.
     * The gate therefore polls (default 30 s). An app that has just called
     * `revokeMember` or `leaveStrand` should follow the write with this call so
     * the cut is immediate rather than up to one poll interval late.
     *
     * Quiet no-op for a strand that is not running, is quiesced, is open, or has
     * the gate disabled. Never rejects; resolves once the sweep has finished.
     */
    refreshRevocationEnforcement(strandId: string): Promise<void>;
    /**
     * The single in-flight refresh loop behind {@link refreshMembershipGate}: read
     * until the stale flag stays clear, then release the slot.
     *
     * NOTE: correct only because {@link membershipGateDirty} is guaranteed TRUE at
     * entry — its sole caller sets it synchronously, with no await in between. Were
     * this ever invoked with the flag already clear, the body would never suspend,
     * so the `finally` would null the slot BEFORE the caller's `??=` filled it, and
     * the slot would be left holding an already-settled drain that every later
     * refresh reuses — an unbreakable await/re-check spin. If a second caller is
     * ever added, have it mark the flag first (or assert it here).
     */
    private drainMembershipGate;
    /**
     * Collapse a burst of `CadrePeer` writes into ONE gate refresh at scope exit.
     *
     * For loops that re-touch many rows (the write-while-alone drains), where a
     * per-row refresh would mean one full membership read per row for a snapshot
     * that only has to be correct once the loop settles.
     *
     * The depth counter is instance-level, so it also suppresses a genuinely
     * CONCURRENT external write's refresh for the life of the scope: that writer's
     * promise resolves before its peer is admitted, and admission lands at scope
     * exit instead. Acceptable — scope exit is milliseconds away (bounded by the
     * drain), versus the ~15 s reconcile interval that was the alternative before
     * any of this existed — but it is the reason these scopes stay short and rare.
     */
    private deferMembershipGateRefresh;
    /**
     * Authorize a new peer to join the cadre.
     * Signs the peer ID with the owner key and inserts into CadrePeer table.
     *
     * @param peerId - The peer ID to authorize
     * @param multiaddrs - Optional multiaddrs for the peer
     */
    authorizePeer(peerId: string, multiaddrs?: string[]): Promise<void>;
    /**
     * Remove a previously-authorized peer from the cadre.
     * Signs the peer ID with the owner key and deletes the CadrePeer row.
     *
     * @param peerId - The peer ID to remove
     */
    removePeer(peerId: string): Promise<void>;
    /**
     * Create a seed from the current control network state.
     * The seed contains peer information and is signed by an owner.
     */
    createSeed(): Promise<ControlNetworkSeed>;
    /**
     * Apply a seed to populate the peer cache and enable connections.
     *
     * Validates the seed signature, then evaluates a trust anchor for the signer
     * key (see `SeedTrustPolicy`). An enrollment caller can pass a per-seed
     * `trustPolicy` override — e.g. a `pinnedKeyTrustPolicy` built from a
     * `CadreInvite.ownerKeys` — so a cold-start node can accept its first
     * seed without reconfiguring the service.
     */
    applySeed(seed: ControlNetworkSeed, options?: {
        trustPolicy?: SeedTrustPolicy;
    }): Promise<ApplySeedResult>;
    /**
     * Post-process an {@link applySeed} outcome: retain the seed's owner peers as
     * cold-start bootstrap targets, and surface a seed that was accepted but whose
     * every owner dial failed — the node is now seeded yet unconnected, and the
     * cold-start reconcile branch is what gets it out of that state.
     */
    private noteAppliedSeed;
    /**
     * Deliver a seed directly to a peer via the /sereus/seed/1.0.0 protocol.
     */
    deliverSeed(targetMultiaddr: string, seed: ControlNetworkSeed): Promise<{
        accepted: boolean;
        reason?: string;
    }>;
    /**
     * Encode a seed for out-of-band delivery (e.g., QR code, copy/paste).
     */
    encodeSeed(seed: ControlNetworkSeed): string;
    /**
     * Decode a seed from base64url encoding.
     */
    decodeSeed(encoded: string): ControlNetworkSeed;
    /**
     * Get this node's circuit relay address for inclusion in seeds.
     * Returns null if no relay address is available.
     */
    getRelayAddress(): Promise<string | null>;
    /**
     * Add a drone to the cadre (for phone/server adding provider-hosted node).
     * Creates authorization and seed for drone initialization.
     *
     * Also retains the drone's handed-over addresses as a durable dial target (see
     * {@link bootstrapPeerStore}). The drone cannot dial an owner that does not
     * listen (a phone), and its `CadrePeer` row stays unsigned — so unresolvable —
     * until it self-publishes over a connection; this node therefore has to open
     * that connection from the addresses it was handed, on this launch or a later
     * one.
     *
     * Nothing is dialed here: the drone has not received the seed yet. After
     * delivering it, call {@link reconcileControlCohort} to dial straight away;
     * otherwise the next timed reconcile pass does. A pass already in flight is
     * joined rather than restarted, and one that listed siblings before this add
     * does not dial the drone, so a caller waiting for the connection should allow
     * for one more timed pass.
     */
    addDrone(options: AddDroneOptions): Promise<DroneInitResult>;
    /**
     * Create an invite for a phone to join the cadre.
     * Use when a server wants to invite a NAT'd phone.
     */
    createInvite(token?: string, expiresIn?: number): Promise<InviteResult>;
    /**
     * Accept a phone connection using an invite.
     * Call this when a phone dials in with an invite token.
     */
    acceptPhone(options: AddPhoneOptions, issuedInvite?: CadreInvite): Promise<void>;
    /**
     * Add a phone to the cadre with relay support.
     * Use when both nodes are NAT'd (phone-to-phone).
     */
    addPhoneWithRelay(phonePeerId: string): Promise<DroneInitResult>;
    /**
     * Encode an invite for out-of-band delivery (QR, link, etc.).
     */
    encodeInvite(invite: CadreInvite): string;
    /**
     * Decode an invite from base64url encoding.
     */
    decodeInvite(encoded: string): CadreInvite;
    /**
     * Dial an owner from an invite (for phone joining via invite).
     */
    dialInvite(invite: CadreInvite): Promise<void>;
    /**
     * Initialize the strand solicitation service.
     * This enables forming strands with other parties via open invitations.
     *
     * @param options - Configuration for the solicitation service
     */
    initializeStrandSolicitation(options?: StrandSolicitationServiceOptions): Promise<void>;
    /**
     * Get the strand solicitation service (for advanced use)
     */
    getStrandSolicitationService(): StrandSolicitationService | null;
    /**
     * Create an open invitation for others to form strands with this party.
     *
     * @param sAppId - The sApp to use for formed strands
     * @param expirationMs - How long the invitation is valid (ms from now)
     * @returns The open invitation to share out-of-band
     */
    createOpenInvitation(sAppId: string, expirationMs?: number): Promise<OpenInvitation>;
    /**
     * Form a strand with a responder via an open invitation.
     *
     * @param invitation - The open invitation received out-of-band
     * @param disclosure - Identity/context information to share with the responder
     * @returns The member key and strand info if successful
     */
    formStrand(invitation: OpenInvitation, disclosure?: StrandFormationDisclosure): Promise<FormStrandResult>;
    /**
     * Remember the strand a formation just joined (see {@link joinedStrandStore}), so it
     * is re-offered after a restart even when the app is killed before its `addStrand`, and
     * published party-wide by the next connected owner reconcile pass. A re-join also
     * cancels a party-wide removal a self-revocation queued for the strand.
     * Last in {@link formStrand}, after the membership adoption, so a failure here leaves
     * the party key and staged invitation in place for the re-formation it asks for.
     *
     * Throws on failure, like {@link adoptFormationMembershipInvite}: the formation's
     * token is spent, and a join no store names would vanish at the next restart.
     */
    private rememberFormedStrand;
    /**
     * Adopt an approved closed-strand formation's membership half on the JOINER:
     *
     * 1. Mint-or-reuse this party's own strand identity — {@link ensureStrandPartyKey}
     *    with no explicit key returns the stored `StrandPartyKey` row when one exists (a
     *    re-formation by an existing member party: lost addresses, an app reinstall with
     *    an intact control DB) and mints + persists a fresh one otherwise. The invitation
     *    will admit THIS key's public half as the `Strand.Member`.
     * 2. Stage the invitation in {@link pendingMembershipInvites} for the strand
     *    bring-up flow (`strand-node-binds-member-peer`) to redeem via `consumeInvite`,
     *    and tell the instance manager, which re-arms an already-finished membership
     *    reconciler so a RE-formation against a launched strand is attempted at once — the
     *    removed-party case, where the loop finished long before the removal. A strand not
     *    launched here yet has no loop to re-arm, and its bring-up finds the entry.
     *
     * Throws — failing the whole {@link formStrand} — when the identity cannot be
     * persisted: a joiner "joined" without a persistable identity could never become a
     * member, and failing loudly beats a silent half-member. The formation itself has
     * already succeeded by then and its one-time token is SPENT, so the error says so:
     * recovery is fixing the underlying cause (no owner signing key / control DB write
     * rejected) and redeeming a FRESH invitation.
     */
    private adoptFormationMembershipInvite;
    /**
     * The reconciler's half of the {@link pendingMembershipInvites} seam: drop `settled`
     * (spent, burned, or dead) only while it is still the staged entry. A re-formation
     * replaces the entry between a pass's read and its settle, and the fresh invitation it
     * staged is the one the re-armed loop is about to redeem — deleting it here would lose
     * it silently, the very outcome the re-arm exists to prevent.
     */
    private unstageMembershipInvite;
    /**
     * The pending single-use membership invitation a closed-strand formation carried back
     * for `strandId`, or `undefined` when none is staged — the seam the strand bring-up
     * membership reconciler (`strand-membership-reconciler.ts`) reads to redeem the
     * joiner's `Strand.Member` seat. `undefined` therefore also means "already redeemed,
     * burned, or found dead": the reconciler clears the entry as soon as it settles the
     * invitation, so a caller polling this sees it disappear on its own. In-memory only;
     * see {@link pendingMembershipInvites} for lifetime and re-formation semantics.
     */
    getPendingMembershipInvite(strandId: string): StrandMembershipInvite | undefined;
    /**
     * Responder-side issuer behind the formation manager's `issueMembershipInvite` seam
     * (see `StrandFormationManagerOptions.issueMembershipInvite` for the contract this
     * implements): mint a single-use `Strand.Invite` against the LIVE host strand so a
     * validated joiner can seat its own `Strand.Member` row.
     *
     * - Open host strand → `null` (no members, nothing to invite into).
     * - Closed host strand whose founder launch was refused as pre-split
     *   ({@link strandLaunchRefusals}) → rethrow the recorded `PreSplitStrandIdentityError`;
     *   the manager maps it to the NON-retryable `HOST_STRAND_MUST_BE_RECREATED_REASON`.
     * - Closed host strand with no `StrandPartyKey` row → throw: this party's identity is
     *   the invite's issuing manager, and without it nothing can sign the issuance. (The
     *   founder's publish/launch paths mint it, so this is a not-yet-converged sibling.)
     *   The manager maps the throw to a clean retryable rejection BEFORE the formation
     *   token is spent.
     * - Closed host strand whose runtime is HIBERNATING → woken first
     *   ({@link wakeHostStrandForFormation}, bounded by `signal`), then issued as below. In
     *   every state the redemption counts as activity, so the host stays up for the
     *   joiner's first sync.
     * - Closed host strand with no running local instance/database (never launched, still
     *   starting, quiescing, or a hibernating one whose wake failed or outran `signal`) →
     *   throw, same mapping: a joiner admitted without an invitation would look joined and
     *   never become a member, and a responder not running the strand cannot serve its sync
     *   anyway.
     * - Closed host strand whose LIVE rows carry the pre-split fingerprint
     *   (`assertNotPreSplitStrand`) → throw `PreSplitStrandIdentityError`, same mapping as
     *   the recorded refusal. Covers the responders that never ran a refused founder launch:
     *   a sibling machine of the founding party, or a node restarted since the refusal.
     *
     * The recorded refusal is checked first: it is an in-memory read and the only
     * permanent diagnosis. Identity is checked BEFORE the runtime: it is the cheaper read
     * and the more actionable diagnosis when both are missing (a missing runtime is
     * transient, a missing identity is not), and it keeps the branch reachable without
     * standing a strand runtime up. For the same reason every control-database check runs
     * before a wake: a strand that cannot issue anyway is not woken.
     *
     * `signal` is the formation's provisioning budget. Once it has aborted nothing is
     * issued — the joiner has already been told to retry, and an invitation written now
     * would only sit in the strand until it expires.
     *
     * The invitation expires `MEMBERSHIP_INVITE_TTL_MS` from now — see that constant for
     * the slow-joiner / lost-result tradeoff.
     *
     * NOTE: the issuing identity must be a `Strand.Manager` (the schema's `InviteValid`
     * gate), and only the FOUNDING party's key is seated as one. Today only the founder
     * party can host a bound formation at all — a joining party never gets the host
     * strand's control `Strand` row, so `resolveStrand` reports `missing` on it — so this
     * never bites. If a joined party is ever able to host formations into a strand it
     * joined (re-invite / multi-hop join), issuance here fails the manager gate and every
     * such redemption rejects with the retryable-sounding
     * `MEMBERSHIP_INVITE_UNAVAILABLE_REASON` forever; that flow needs manager delegation,
     * not a retry.
     */
    private issueStrandMembershipInvite;
    /**
     * Count a bound closed-strand redemption as activity on the host strand, and wake the
     * strand when it is HIBERNATING so the membership invitation can be issued. Only reached
     * after the formation manager has authorized the redemption (token, disclosure, outside
     * approval, seat pre-check), so only a caller already entitled to the strand's member key
     * can cause a wake. No other state is woken — never launched, still starting, or a
     * quiesce in flight is not something this node recovers from on demand; the caller's
     * live-database check refuses those.
     *
     * The activity is recorded in every state, through the hibernation manager rather than
     * {@link recordStrandActivity}, whose push fan-out would wake this party's phones for
     * nothing. It keeps the host up for the joiner's first sync: a live strand's idle timer
     * restarts, a check-in window that happens to have the strand live sees activity and
     * leaves it up instead of re-quiescing it, and a hibernating strand has its idle →
     * hibernate timers re-armed once the wake leaves it `active`. The explicit
     * {@link wakeStrand} coalesces onto the wake `recordActivity` began, and still wakes when
     * `recordActivity` is a no-op (hibernation disabled but the strand force-hibernated, or
     * the manager stopped).
     *
     * Bounded by `signal` (the formation's provisioning budget): when it aborts first this
     * throws — a retryable rejection, token unspent — and leaves the wake running, so the
     * joiner's retry finds the strand live.
     */
    private wakeHostStrandForFormation;
    /**
     * Remember the responder's strand-network addresses for a strand this node just
     * formed in the strand peer book (see {@link strandPeerBookStore}), so the strand's
     * discovery seed has something to work with when the app launches it — and again
     * after every restart.
     *
     * The carried list is peer-agnostic (`sanitizeStrandAddrs` bounds and parses it,
     * nothing more), so it is attributed per peer here (`groupAddrsByPeerId`, the same
     * rule the address-book merge applies) and each peer becomes one unsigned entry seen
     * just now: the responder disclosed the addresses live a moment ago. An entry naming
     * no destination peer is dropped there. Scoped strictly to `strandId`: these
     * addresses reach ONE strand node of ONE other party and must never seed another
     * strand's mesh or the control peerStore. An empty list records nothing, so a later
     * formation against the same strand that DOES disclose addresses is not shadowed.
     */
    private recordFormationStrandPeers;
    /**
     * Encode an open invitation for out-of-band delivery (QR, link, etc.).
     */
    encodeInvitation(invitation: OpenInvitation): string;
    /**
     * Decode an open invitation from base64url encoding.
     */
    decodeInvitation(encoded: string): OpenInvitation;
}
export {};
