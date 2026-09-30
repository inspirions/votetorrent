import type { Libp2p } from '@libp2p/interface';
import { type PeerDialBudget } from './peer-dial.js';
import type { ControlNetworkSeed, SeedAckMessage, AuthorizePeerOptions, ApplySeedResult, AddDroneOptions, AddPhoneOptions, DroneInitResult, InviteResult, CadreInvite, PeerAddressRecord, DeviceTokenRecord, RevocationRow, RevocationLedgerOpenResult } from './types.js';
import type { ControlDatabase } from './control-database.js';
import { type SeedTrustPolicy } from './seed-trust-policy.js';
import type { TrustedOwnerStore } from './trusted-owner-store.js';
/** Protocol ID for seed delivery */
export declare const SEED_PROTOCOL = "/sereus/seed/1.0.0";
/**
 * Decode a 4-byte big-endian length-prefixed frame; returns the body bytes.
 *
 * Guards every parse site against malformed input: a buffer too short to hold
 * the prefix, a declared length exceeding `maxLength`, and a declared length
 * exceeding the bytes actually present. Returns a view (`subarray`, no copy) —
 * the body is handed straight to `TextDecoder`.
 */
export declare function decodeLengthPrefixedFrame(data: Uint8Array, maxLength?: number): Uint8Array;
/**
 * Derive the base64url ed25519 public key embedded in an Ed25519 libp2p PeerId.
 *
 * An Ed25519 PeerId is an identity multihash of the public key, so
 * `peerIdFromString(id).publicKey.raw` is the 32-byte ed25519 key whose
 * base64url form matches the `OwnerKey.Key` representation (and
 * `ed25519KeyPairFromLibp2p().publicKeyB64`). Returns null for a non-Ed25519
 * id, a missing embedded key, or any parse failure — callers treat null as
 * "not an owner" rather than throwing.
 */
export declare function ed25519PublicKeyB64FromPeerId(peerId: string): string | null;
/**
 * Canonical byte representation of the authenticated seed fields.
 *
 * Routes both the creator (`createSeed`) and the verifier
 * (`validateSeedSignature`) through one builder so the signed bytes are
 * identical regardless of key insertion order. `canonicalJson` sorts keys and
 * drops `undefined`, so the signed payload is exactly `{ partyId, peers }` —
 * the fields the producer actually emits.
 */
export declare function canonicalSeedPayload(seed: Pick<ControlNetworkSeed, 'partyId' | 'peers'>): string;
/**
 * Configuration for the SeedBootstrapService
 */
export interface SeedBootstrapConfig {
    /** Party ID for this cadre */
    partyId: string;
    /** Owner private key for signing seeds and peer authorizations (base64url) */
    ownerPrivateKey?: string;
    /** Owner public key (base64url) - derived from private key if not provided */
    ownerPublicKey?: string;
    /**
     * Optional async resolver returning the multiaddrs to embed in invites.
     * When unset, `libp2pNode.getMultiaddrs()` is used. Hosts behind NAT supply
     * this (via `@serfab/cadre-host`'s NatService) to substitute the host's
     * DDNS hostname and externally-mapped port.
     */
    inviteAddressResolver?: () => Promise<string[]>;
    /**
     * Trust anchor for incoming seeds. Decides whether a signature-verified
     * `signerKey` should be trusted, against the receiver's anchored owner
     * keys (NOT the seed body). Defaults to `anchoredTrustPolicy()`, which
     * rejects any signer not already in {@link trustedOwners}. An enrollment
     * caller can pass a per-seed override to `applySeed` instead.
     *
     * A `CadreNode` forwards its node-wide `CadreNodeConfig.seedTrustPolicy` here
     * — that is the only seam the inbound libp2p seed-protocol handler can use,
     * since a network-delivered seed has no per-call override.
     */
    trustPolicy?: SeedTrustPolicy;
    /**
     * The node-local, NON-replicated trusted-owner anchor. Supplies
     * `SeedTrustContext.knownOwnerKeys` for every {@link applySeed}, and receives
     * a key accepted via a pin/TOFU (see `SeedTrustDecision.anchorAs`).
     *
     * Deliberately NOT `ControlDatabase.getOwnerKeys()`: the replicated
     * `OwnerKey` table is pollutable — any connecting node can genesis-insert its
     * own key and let it replicate — so a seed signed by a stranger's self-issued
     * owner key would pass a table-anchored check. A `CadreNode` passes its
     * `getTrustedOwnerStore()` here. Unset (e.g. a directly-constructed service in
     * a test) means an EMPTY anchor: only a pinned/TOFU policy can accept a seed.
     */
    trustedOwners?: TrustedOwnerStore;
    /**
     * Time the inbound seed handler waits for the seed frame before aborting the
     * read (ms). Defaults to {@link DEFAULT_SEED_READ_TIMEOUT_MS}. Bounds a
     * buggy/compromised own-cadre node that opens a stream and never half-closes.
     */
    seedReadTimeoutMs?: number;
    /**
     * Cap on concurrent inbound seed streams (defaults to
     * {@link DEFAULT_MAX_CONCURRENT_SEEDS}). Over the cap, a non-accepting ack is
     * returned without applying any seed.
     */
    maxConcurrentSeeds?: number;
    /**
     * The host's declared link round trip (`NetworkConfig.linkRoundTripMs`), from which
     * {@link seedDeliverTimeoutMs}'s default is derived. Unset means the declared default.
     */
    linkRoundTripMs?: number;
    /**
     * Time {@link SeedBootstrapService.deliverSeed} waits for the whole exchange —
     * dial, write, ack read — before aborting (ms). Bounds the SENDER against a seed
     * target that accepts the stream and then never replies; the target is a
     * not-yet-trusted node during onboarding, so this is the more exposed
     * direction than the receiver knobs above.
     *
     * Defaults to `relayedRequestBudgetMs(linkRoundTripMs)` (`link-budget.ts`; 23 s at the
     * default declaration): one dial that may need a relay, then one request and its answer.
     * Delivery does not set `runOnLimitedConnection`, so it does not use a limited relayed
     * connection today; the relayed-dial count is the upper bound on the dial it can use, the
     * same choice `CadreNode.controlDialBudget` makes for every address. It holds only link work
     * because the receiver acks before its owner dials.
     *
     * NOTE: no transfer allowance — a seed is a peer list of a few KB, and `MAX_SEED_SIZE` (1 MiB)
     * is a defensive cap. If seeds ever grow toward that cap, add an allowance the way
     * `PUSH_TRANSFER_ALLOWANCE_MS` does.
     */
    seedDeliverTimeoutMs?: number;
    /**
     * Time limits for each peer this service dials from a list of addresses —
     * {@link SeedBootstrapService.applySeed}'s owner dials and
     * {@link SeedBootstrapService.dialInvite} — per address and per peer (see
     * `peer-dial.ts`). Defaults to {@link DEFAULT_PEER_DIAL_BUDGET}; a `CadreNode`
     * passes its `network.controlCohort` limits.
     */
    dialBudget?: PeerDialBudget;
}
/**
 * Event callbacks for seed-related events
 */
export interface SeedEventCallbacks {
    /** Called when a seed is received via the protocol */
    onSeedReceived?: (partyId: string, peerId: string) => void;
    /**
     * Called when a seed is successfully applied.
     *
     * `seed` is the applied seed itself: the inbound protocol handler applies it
     * INSIDE the service, so this callback is the only seam through which a
     * `CadreNode` sees a wire-delivered seed's contents — which it needs to
     * retain the owner-flagged peers as cold-start bootstrap dial targets.
     */
    onSeedApplied?: (partyId: string, peersAdded: number, seed: ControlNetworkSeed) => void;
    /** Called when seed application fails */
    onSeedError?: (partyId: string, error: string) => void;
}
/**
 * SeedBootstrapService handles control network seed generation and delivery.
 *
 * Seeds solve the cold-start problem: new nodes need control data to validate
 * connections, but can't get data without connecting first. Seeds pre-populate
 * the new node's cache with peer information.
 */
export declare class SeedBootstrapService {
    private readonly config;
    private libp2pNode;
    private controlDatabase;
    private readonly ownerPublicKey;
    private readonly trustPolicy;
    private readonly seedReadTimeoutMs;
    private readonly maxConcurrentSeeds;
    private readonly seedDeliverTimeoutMs;
    private readonly dialBudget;
    /** In-flight inbound seed streams, used to enforce {@link maxConcurrentSeeds}. */
    private activeStreams;
    private eventCallbacks;
    constructor(config: SeedBootstrapConfig);
    /**
     * Set event callbacks for seed-related events.
     * Used by CadreNode to emit events.
     */
    setEventCallbacks(callbacks: SeedEventCallbacks): void;
    /**
     * Whether this service holds an owner private key, i.e. can produce the
     * owner signatures that gate `CadrePeer` / `DeviceToken` inserts, deletes,
     * and re-authorizations. A seed-listener-only service (`enableSeedListener`,
     * no owner key) returns false: it can receive/apply seeds but cannot author
     * or re-issue owner writes. Used by the write-while-alone re-replication
     * drain to skip owner work on a non-owner node.
     */
    canAuthorize(): boolean;
    /**
     * Initialize the service with libp2p node and control database.
     *
     * `registerHandler` (default true) gates registration of the shared inbound
     * `/sereus/seed/1.0.0` handler on `libp2pNode`. Persistent services
     * (`initializeSeedBootstrap`, `enableSeedListener`) own that handler and leave
     * it on. The throwaway temp services CadreNode builds in `applySeed` /
     * `dialInvite` pass `false`: they only need the stored `libp2pNode` /
     * `controlDatabase` for dialing and known-key lookup, and must NOT bind a
     * discarded closure to the shared node (a handler leak, and a second
     * `handle()` of the same protocol throws `DuplicateProtocolHandlerError`).
     *
     * Rejects when libp2p refuses the registration; the node and database are
     * kept only once the handler is in place, so a failed service holds nothing
     * for {@link shutdown} to unhandle.
     */
    initialize(libp2pNode: Libp2p, controlDatabase: ControlDatabase, options?: {
        registerHandler?: boolean;
    }): Promise<void>;
    /**
     * Authorize a new peer to join the cadre.
     * Signs a membership voucher with the owner key and inserts into CadrePeer table.
     *
     * The owner vouches the `PublicKey <-> PeerId` binding: rather than trust a
     * caller-supplied key, the binding is enforced by construction — `PublicKey` is
     * DERIVED from the (Ed25519) `peerId`. A non-Ed25519 peer id yields a null
     * `PublicKey`, and such a row can never be self-updated (it has no key to
     * verify against), which is correct. The row is inserted with a fresh
     * `UpdatedAt` but no self-signature (`Sig` null) — the owner cannot produce
     * the peer's self-signature, so the peer must self-publish (see
     * {@link CadreNode.registerSelf}) before the row resolves.
     */
    authorizePeer(options: AuthorizePeerOptions): Promise<void>;
    /**
     * Owner-signed INSERT of this node's OWN self-signed address record.
     *
     * Used by {@link CadreNode.registerSelf} when the node is not yet a member and
     * is its own owner (it holds the owner key): the row is owner-signed
     * (satisfying `AuthorizedInsert`) AND carries a valid self-`Sig`, so it resolves
     * immediately without a follow-up self-update.
     *
     * @returns `true` when this call seated the row, `false` when a concurrent writer
     *   (e.g. an {@link authorizePeer} of this node's own id) had already seated it —
     *   in which case the row in the database is NOT this record and carries whatever
     *   `Sig` that writer had, so the caller must self-update to publish its signature.
     */
    insertSelfPeerRecord(record: PeerAddressRecord): Promise<boolean>;
    /**
     * Shared owner-signed `CadrePeer` INSERT — the row fields and the owner-key
     * precondition; the stamp mint, voucher signature, write lock, existence check and
     * membership notify are all {@link ControlDatabase.insertCadrePeer}'s (see there for
     * the anti-replay and insert-race rationale). No `CadrePeer` write may bypass that
     * method: the write is what admits the peer's traffic.
     *
     * The DB check precedes the owner-key check here, matching the order this method has
     * always surfaced them (the owner-key error used to come out of the signer, after the
     * DB check).
     *
     * @returns `true` when this call performed the INSERT, `false` when the row was
     *   already seated by a concurrent writer. The loser needs to know: an authorize seats
     *   a row with a null `Sig`, so a self-publish that lost the race must fall through to
     *   a self-update or its record never lands.
     */
    private insertCadrePeerRow;
    /**
     * Owner-signed INSERT of a peer's OWN self-signed `DeviceToken` row.
     *
     * Counterpart to {@link insertSelfPeerRecord} for the device-token registry: the
     * row is owner-signed (satisfying `DeviceToken.AuthorizedInsert` via the
     * 'add'-tagged digest, {@link deviceTokenAddDigest}) AND carries the peer's
     * own self-`Sig` over the token payload. The owner signature covers the WHOLE row
     * (every column, ending in a freshly minted single-use `StampId`) — but covering the
     * token contents is not the same as vouching them: the peer's `Sig` (verified at
     * resolve time against the bound `CadrePeer.PublicKey`) is what makes the row
     * resolvable. Used by {@link CadreNode.registerDeviceToken} for the first publish
     * when the node is its own owner.
     *
     * The stamp is per-INSERT, so a re-register after a clear mints a fresh one and a
     * fresh signature — unaffected by the cleared row's retired stamp
     * (`DeviceToken.NotRevoked`).
     */
    insertSelfDeviceToken(record: DeviceTokenRecord): Promise<void>;
    /**
     * Owner-signed DELETE of a peer's `DeviceToken` row (logout / token
     * invalidation). The `DeviceToken.AuthorizedDelete` constraint validates an owner
     * signature over the 'remove'-tagged digest bound to the STORED row's
     * (PeerId, StampId) — deliberately distinct from the insert digest, so a captured
     * insert approval can never be replayed to clear a token. Like {@link removePeer}
     * for `CadrePeer`, clearing a token requires the owner key.
     *
     * The delete and the `Revocation` tombstone retiring the row's `StampId` commit in
     * ONE transaction — `DeviceToken.RevocationRecorded` refuses a bare delete, and
     * without the tombstone the stamp would free up and the never-expiring insert
     * approval (which the cleared device holds a copy of) would re-seat the token. The
     * tombstone carries its OWN owner signature: retiring a stamp permanently forecloses
     * that row, so it is an owner action in its own right.
     *
     * Both digests, the stamp read, and the transaction come from
     * {@link ControlDatabase.deleteDeviceToken} — one shared implementation across
     * `CadrePeer` / `DeviceToken` / `Strand` / `ValidationKey`. What stays here is the
     * owner-key precondition; a no-op on an already-absent row is the shared body's
     * behavior, and unlike {@link removePeer} nothing here rides on it.
     */
    deleteDeviceToken(peerId: string): Promise<void>;
    /**
     * Return the configured owner private key, or throw if none is set. The single
     * precondition gate for every owner-signed write. {@link removePeer} /
     * {@link reauthorizePeer} read the row's `StampId` from the DB BEFORE they sign, so
     * they call this up front — otherwise a keyless service would either surface the
     * wrong "Control database not initialized" error or, worse, silently no-op when the
     * target row is absent (the early `stampId === null` return) instead of rejecting.
     */
    private requireOwnerPrivateKey;
    /**
     * The owner PUBLIC key that rides in every owner-signed write's context, non-null.
     *
     * The field is nullable because a read-only service carries no owner key at all, but the
     * constructor derives the public key whenever `ownerPrivateKey` is set — so gating on
     * {@link requireOwnerPrivateKey} first makes the pair inseparable and the second throw
     * unreachable. Callers that must reject a keyless service BEFORE any DB read use this as
     * their first line and get the owner-key precondition for free.
     */
    private requireOwnerPublicKey;
    /**
     * Sign a base64url digest with the owner key (ed25519). The single place the
     * owner private key is applied; callers pass the canonical domain-tagged digest for
     * the specific action ({@link deviceTokenAddDigest}), or the raw-bytes form via
     * {@link signMessageBytes}. Throws if no owner key is set.
     */
    private signDigest;
    /**
     * Adapt the control database's raw-bytes `signMessage` callback (every guarded delete
     * takes one) to {@link signDigest}'s base64url-string form. Both encodings hash to the
     * same signed bytes (`sign` decodes its base64url input), so a signature minted here
     * satisfies the same schema CHECK as one from the callers that sign the bytes directly — see
     * `control-revocation-replay.spec.ts`'s "raw-bytes and digest-string signers agree".
     */
    private signMessageBytes;
    /**
     * Remove a peer from the cadre by owner signature.
     *
     * The `CadrePeer.AuthorizedDelete` (`check on delete`) constraint validates a
     * signature over the DISTINCT 'remove'-tagged digest
     * `digest('CadreControl.CadrePeer', 'remove', old.PeerId, old.StampId)` by an owner
     * key — deliberately NOT the insert voucher digest, so the row's stored `VouchSig` can
     * never be replayed to delete.
     *
     * The delete and the `Revocation` tombstone retiring the row's `StampId` commit in ONE
     * transaction — `CadrePeer.RevocationRecorded` refuses a bare delete, and without the
     * tombstone the stamp would free up and the original admission approval (which never
     * expires, and which the removed peer holds a copy of) would re-seat the row.
     *
     * The tombstone is separately owner-signed (satisfying `Revocation.Authorized`):
     * retiring a stamp evicts that peer party-wide and permanently forecloses re-admitting
     * the row, so it is an owner action in its own right, not a side effect the delete's
     * signature covers.
     *
     * Both digests, the stamp read, the transaction, and the post-commit membership notify
     * come from {@link ControlDatabase.deleteCadrePeer} — one shared implementation across
     * `CadrePeer` / `DeviceToken` / `Strand` / `ValidationKey`. What stays here is the
     * owner-key precondition and the absent-row gate the notify depends on (below).
     */
    removePeer(peerId: string): Promise<void>;
    /**
     * Owner "re-touch" of an existing `CadrePeer` membership row: bump `UpdatedAt` and
     * re-vouch the row so it is re-emitted as a fresh, broadcasting transaction. This is
     * the write-while-alone re-replication primitive (`control-write-ensure-replicated`):
     * a membership row that committed local-only (its block's cluster ≤1 at insert) is
     * pushed to the cohort once it grows.
     *
     * The stamp read, the voucher signature, the write lock and the membership notify are
     * {@link ControlDatabase.reauthorizeCadrePeer}'s — including the caveat that it rebinds
     * `VouchOwner` to this node's owner key. What stays here is the owner-key precondition.
     *
     * A no-op (no throw, no notify) when the row does not exist.
     *
     * @param peerId - the membership row to re-touch.
     * @param updatedAt - the strictly-increasing freshness stamp to write.
     * @throws if no owner private key is configured (a non-owner cannot
     *   re-sign another peer's row) or the control database is not initialized.
     */
    reauthorizePeer(peerId: string, updatedAt: number): Promise<void>;
    /**
     * Owner re-issue of a batch of `Revocation` tombstones: bump each row's
     * `ReissuedAt` so the storage layer re-broadcasts a tombstone that committed
     * while the node was alone. The delete-while-alone counterpart of
     * {@link reauthorizePeer} — a removed row cannot be re-touched (it is gone),
     * but its tombstone can, and every membership read treats a retired stamp as
     * absent.
     *
     * The signatures, the single transaction, and the strictly-monotonic
     * `reissuedAt` contract are {@link ControlDatabase.reissueRevocations}'s. What
     * stays here is the owner-key precondition.
     *
     * @returns how many tombstones were re-issued (`rows.length` on success).
     * @throws if no owner private key is configured or the control database is not
     *   initialized.
     */
    reissueRevocations(rows: readonly RevocationRow[], reissuedAt: number): Promise<number>;
    /**
     * Owner filing of the singleton `Revocation` ledger marker, so the table is never a
     * never-written block that the storage layer re-consults on every read.
     *
     * The signature, the insert-if-absent guard and the `'already-open'` mapping are
     * {@link ControlDatabase.openRevocationLedger}'s. What stays here is the owner-key
     * precondition.
     *
     * @throws if no owner private key is configured or the control database is not
     *   initialized.
     */
    openRevocationLedger(): Promise<RevocationLedgerOpenResult>;
    /**
     * Create a seed from the current control network state.
     * The seed contains peer information and is signed by an owner.
     */
    createSeed(): Promise<ControlNetworkSeed>;
    /**
     * Apply a seed to populate the peer cache and enable connections.
     *
     * Validates the seed signature, then evaluates a trust anchor for the
     * `signerKey` that does NOT come from the seed body: the receiver's
     * node-local {@link SeedBootstrapConfig.trustedOwners} anchor, optionally
     * augmented by pinned keys or TOFU via the configured/overriding
     * `SeedTrustPolicy`. A forged self-asserting seed — one that merely lists its
     * own signer as an owner peer — no longer passes, and neither does one signed
     * by a key a stranger genesis-inserted into the replicated `OwnerKey` table.
     *
     * A key accepted via a pin/TOFU is persisted into the anchor (the policy says
     * so via `SeedTrustDecision.anchorAs`), so the next seed from that owner is
     * anchored without re-supplying the invite.
     *
     * @param seed - The seed to apply (already transport-decoded).
     * @param options.trustPolicy - Per-call policy override (e.g. a
     *   `pinnedKeyTrustPolicy` derived from a `CadreInvite`) used instead of the
     *   service-configured default for this seed only.
     */
    applySeed(seed: ControlNetworkSeed, options?: {
        trustPolicy?: SeedTrustPolicy;
    }): Promise<ApplySeedResult>;
    /**
     * The first half of {@link applySeed}: check the signature and the signer's trust, then merge
     * the seed's peer addresses into the peer store. Every rejection happens here, so this result is
     * what the inbound handler acks with; the owner dials that follow cannot change it.
     */
    private verifyAndMergeSeed;
    /**
     * The second half of {@link applySeed}: dial the seed's owner peers to establish connections.
     *
     * Best-effort and COUNTED: an owner that is momentarily down leaves this node seeded but
     * unconnected, which the caller can only see if the outcome is reported (see
     * `ApplySeedResult.ownerDialsFailed`). Recovery is not this loop's job —
     * `CadreNode.dialColdStartBootstrap` retries these same addresses on every control-cohort
     * reconcile pass until the control database has siblings.
     *
     * The inbound handler runs this AFTER it has acked and closed the stream
     * ({@link handleSeedStream}), because an unreachable owner can take `dialBudget.totalMs`.
     */
    private dialSeedOwners;
    /**
     * Persist a signer that a pin/TOFU accepted into the node-local anchor, so a
     * later seed from the same owner is anchored without re-supplying the invite
     * or re-prompting. Only the policy decides this happens (`anchorAs` is unset
     * when the key was already anchored, so a plain re-apply writes nothing) and
     * `trust()` is idempotent, keeping the original provenance for a known key.
     *
     * Failure to PERSIST does not fail the seed: `trust()` reflects the key in the
     * in-memory anchor synchronously, so this seed and the rest of the session are
     * unaffected — only durability across a restart is lost, and that is logged.
     *
     * NOTE: anchoring a key can flip `CadrePeer` rows ALREADY present from
     * unauthorized to authorized, which the write-driven membership-gate refresh
     * (`ControlDatabase.mutateCadrePeer`) cannot see — no row was written. Every
     * anchor mutation today rides seed application, and both seed paths refresh the
     * gate explicitly afterwards (`CadreNode.applySeed`, `onSeedApplied`). If some
     * future path anchors an owner OUTSIDE seed application, it owes the same
     * `CadreNode.refreshMembershipGate()` — or the anchor needs its own hub.
     */
    private anchorAcceptedSigner;
    /**
     * Encode a seed for out-of-band delivery (e.g., QR code, copy/paste).
     */
    encodeSeed(seed: ControlNetworkSeed): string;
    /**
     * Decode a seed from base64url encoding.
     */
    decodeSeed(encoded: string): ControlNetworkSeed;
    /**
     * Deliver a seed directly to a peer via the /sereus/seed/1.0.0 protocol.
     *
     * Sender hardening: the whole exchange — dial, write, ack read — is bounded by
     * {@link seedDeliverTimeoutMs}, and the ack is capped at {@link MAX_SEED_SIZE}.
     * The target is a NOT-YET-TRUSTED node the instigator chose to dial during
     * onboarding, so an unbounded read here is strictly more exposed than the
     * membership-gated receiver paths: without the bound a target that accepts the
     * stream and never replies parks this call forever, and one that streams
     * arbitrary bytes as a fake ack exhausts memory.
     */
    deliverSeed(targetMultiaddr: string, seed: ControlNetworkSeed): Promise<SeedAckMessage>;
    /**
     * Open one stream to the target, send the seed frame, half-close, and read the ack.
     *
     * `signal` is the deadline from {@link deliverSeed}: it goes to `dialProtocol` so
     * a timeout during connect aborts the dial, and into {@link exchangeFrame} so a
     * timeout after the stream is open resets it — releasing the otherwise unbounded
     * ack-read.
     *
     * Deliberately NOT `runOnLimitedConnection`: a wake sets it because a wake is a
     * tiny frame over a relay, whereas a seed is up to 1MB and this delivery path
     * does not dial relay addresses today. Changing that is a separate decision.
     */
    private sendSeed;
    /**
     * Read the ack frame a delivery target writes back, bounded by
     * {@link seedDeliverTimeoutMs} and capped at {@link MAX_SEED_SIZE} — an
     * untrusted target must not be able to stream unlimited bytes as a fake ack.
     * Decoding runs inside {@link exchangeFrame}'s `try`, so a malformed or
     * non-JSON ack resets the stream rather than leaking it.
     */
    private readSeedAck;
    /**
     * Get this node's circuit relay address for inclusion in seeds.
     * Returns null if no relay address is available.
     */
    getRelayAddress(): Promise<string | null>;
    /**
     * Validate a seed's signature.
     */
    validateSeedSignature(seed: ControlNetworkSeed): boolean;
    /**
     * Query peers from the control database.
     *
     * Owner identity is sourced from the `OwnerKey` table, not from the
     * transport peer ID. An Ed25519 libp2p PeerId embeds its public key (identity
     * multihash), so each peer's ed25519 key is derivable from its `PeerId`; a
     * peer is an owner iff that derived key is in the `OwnerKey` set.
     * This makes any owner node markable — not just the local one — and ties
     * `isOwner` to the control table rather than to `peerId === self`.
     *
     * Read through {@link ControlDatabase.queryCadrePeers}, not a raw `CadrePeer`
     * select: that reader drops any row whose `StampId` is retired in
     * `CadreControl.Revocation`, so a removed member's addresses are never packed
     * into a seed and pushed into a joiner's peerstore (`applySeed` adds every
     * seed peer's addrs and dials the owner-flagged ones). A revoked peer is off
     * the addressable surface everywhere, and this is one of its exits.
     *
     * NOTE: this is the one owner lookup deliberately left on the REPLICATED
     * table rather than the node-local anchor. `SeedPeer.isOwner` is a dial hint
     * — the receiver dials owner-flagged peers first — not a trust decision, and
     * the receiver re-derives real trust from its own anchor. So a polluted table
     * costs at most a wasted dial, while anchoring here would silently drop
     * legitimate co-owners this node never pinned. If `isOwner` ever gates
     * anything the receiver TRUSTS, move it to the anchor.
     */
    private queryPeers;
    /**
     * Register the seed protocol handler. The inbound closure just delegates to
     * {@link handleSeedStream} — extracted as a method so it has a unit-test seam
     * (mirroring wake's `handleStream`) the inline closure never had.
     */
    private registerProtocolHandler;
    /**
     * Read one inbound seed frame, verify and merge it, write the ack and close the
     * stream, then dial the seed's owners.
     *
     * The ack and the close come BEFORE the owner dials: an unreachable owner can hold
     * a dial for `dialBudget.totalMs` (64 s at the default declared link), which is not
     * link time and does not belong inside the sender's delivery deadline. The close is
     * what releases the sender, which reads the ack to end-of-stream. The stream stays
     * counted in {@link activeStreams} through the dials, so {@link maxConcurrentSeeds}
     * still bounds concurrent owner-dial phases.
     *
     * Hardened against a buggy/compromised own-cadre node: a concurrency cap (over
     * {@link maxConcurrentSeeds}, reply without applying), a read timeout (a peer
     * that never half-closes is aborted inside `readStreamToEnd`), and the existing
     * malformed/oversized-frame guard — all reported as a non-accepting
     * {@link SeedAckMessage} rather than a dropped/hung stream.
     *
     * NOTE: a receiver configured with an interactive trust-on-first-use policy asks a
     * human before acking, and that wait sits inside the sender's delivery deadline. If
     * TOFU is ever used on this wire path, ack "pending" or move the confirmation out of
     * the exchange.
     */
    private handleSeedStream;
    /** Read the inbound seed frame to EOF (bounded and size-capped) and decode it. */
    private readSeedFrame;
    /**
     * Shutdown the service.
     */
    shutdown(): Promise<void>;
    /**
     * Add a drone to the cadre (phone/server adds provider-hosted node).
     *
     * Use this when you've spawned a drone via provider API and received its
     * peer ID and multiaddrs. This method:
     * 1. Authorizes the drone peer
     * 2. Creates a seed including all current peers
     * 3. Returns the seed for sending to provider API
     *
     * Nothing here dials the drone or remembers its addresses beyond the unsigned
     * `CadrePeer` row, which no resolver accepts. `CadreNode.addDrone` is the entry
     * point that also retains them as a durable dial target, so the adder's
     * reconcile pass can open the connection — the drone cannot dial an owner that
     * does not listen. Call `CadreNode.reconcileControlCohort()` after delivering
     * the seed to dial at once.
     *
     * @param options - Drone peer info from provider API
     * @returns Seed and encoded seed for drone initialization
     */
    addDrone(options: AddDroneOptions): Promise<DroneInitResult>;
    /**
     * Create an invite for a phone to join the cadre.
     *
     * Use this when a server (public IP) wants to invite a phone (NAT'd).
     * The invite is shared out-of-band (QR code, link, etc.) and contains
     * the server's address so the phone can dial in.
     *
     * @param token - Optional invite token for validation
     * @param expiresIn - Optional expiration time in milliseconds
     * @returns Invite and encoded invite for sharing
     */
    createInvite(token?: string, expiresIn?: number): Promise<InviteResult>;
    /**
     * Accept a phone connection using an invite.
     *
     * Use this when a phone dials in with an invite token. This method:
     * 1. Validates the token if provided
     * 2. Authorizes the phone peer
     *
     * After this, the phone can sync the control database normally.
     *
     * @param options - Phone peer info and invite token
     * @param issuedInvite - The original invite for validation
     */
    acceptPhone(options: AddPhoneOptions, issuedInvite?: CadreInvite): Promise<void>;
    /**
     * Add a phone to the cadre with relay support.
     *
     * Use this when both nodes are NAT'd (phone-to-phone). This method:
     * 1. Authorizes the new phone peer
     * 2. Creates a seed with relay addresses for dialing
     *
     * @param phonePeerId - Peer ID of the new phone
     * @returns Seed with relay addresses for out-of-band delivery
     */
    addPhoneWithRelay(phonePeerId: string): Promise<DroneInitResult>;
    /**
     * Encode an invite for out-of-band delivery.
     */
    encodeInvite(invite: CadreInvite): string;
    /**
     * Decode an invite from base64url encoding.
     */
    decodeInvite(encoded: string): CadreInvite;
    /**
     * Dial an owner from an invite.
     * Use this on a phone after receiving an invite to connect to the owner.
     *
     * @param invite - The invite received out-of-band
     * @returns Connection to the owner
     */
    dialInvite(invite: CadreInvite): Promise<void>;
}
