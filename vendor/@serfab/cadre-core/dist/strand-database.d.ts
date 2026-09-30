import { Database } from '@quereus/quereus';
import type { SereusPluginResult } from '@serfab/quereus-plugin-sereus';
import type { Libp2p } from '@libp2p/interface';
import type { IRepo } from '@optimystic/db-core';
import type { SAppConfig } from './types.js';
export interface StrandDatabaseConfig {
    /** The strand ID */
    strandId: string;
    /**
     * sApp configuration containing the schema. Absent for a storage replica — a strand
     * this node stores and serves without the app installed: only the `Strand` membership
     * schema is applied, and such a database can never found (see {@link founderSApp}).
     */
    sAppConfig?: SAppConfig;
    /** Libp2p node for the strand network */
    libp2pNode: Libp2p;
    /** Coordinated repo from the libp2p node */
    coordinatedRepo: IRepo;
    /**
     * Strand type (`'o'` open / `'c'` closed) from the control-network strand row.
     * Drives the founder bootstrap: open strands get a `Header` only; closed strands
     * also get the founding `Member`+`Manager`.
     */
    strandType: 'o' | 'c';
    /**
     * The closed-strand `MemberPrivateKey` (base64 protobuf) from the strand row —
     * the strand-wide read secret every joining party receives. Carried for the
     * strand's read-gating story only; it derives NOBODY's identity (that used to be
     * this key's second job, which let any joiner sign as the founding manager —
     * gotchoices/sereus#4). Absent for open strands.
     */
    memberPrivateKey?: string;
    /**
     * THIS party's own strand membership private key (base64 protobuf), from the
     * control-layer `StrandPartyKey` row (or supplied explicitly at attach). Required
     * when `founder` is true and `strandType` is `'c'` — it derives the founding
     * `Member.Key`/`Manager.MemberKey`. Never shared outside the party; absent for
     * open strands and for joiners that have not yet persisted one.
     */
    partyMemberPrivateKey?: string;
    /**
     * Whether this node founds the strand. When true, {@link initialize} runs the
     * one-time founder membership bootstrap after the schema is applied. Joiners
     * leave this false and write nothing (rows arrive via sync). Defaults to false.
     */
    founder?: boolean;
}
/**
 * StrandDatabase manages the sApp schema for a strand using Quereus with the
 * Optimystic backend. Each strand instance has its own isolated database with
 * the sApp's schema applied.
 *
 * This class owns the `Database` lifecycle (creation, `getDatabase()`, `close()`)
 * but delegates the actual SQL-surface composition — plugin registration, node
 * wiring, catalog hydration, schema apply — to `connectToStrand` from
 * `@serfab/quereus-plugin-sereus`, the single shared composition. The libp2p
 * node is injected here, so `connectToStrand` never *creates* the node;
 * `StrandInstanceManager` owns the node lifecycle. (The strand connection's
 * `shutdown` still stops the injected node via the collection factory, so the
 * manager's own `node.stop()` is an idempotent second stop — see `close()`.)
 */
export declare class StrandDatabase {
    private db;
    private shutdownStrand;
    private resolvedTransactor;
    private readonly config;
    private initialized;
    constructor(config: StrandDatabaseConfig);
    /**
     * Initialize the database — create the `Database` and delegate the strand
     * SQL-surface composition (plugins, node wiring, hydrate, schema apply) to
     * `connectToStrand` with the injected libp2p node.
     */
    initialize(): Promise<void>;
    /**
     * Run the founder membership bootstrap against the freshly-composed strand DB.
     *
     * Derives the founding keypair from this PARTY's own `partyMemberPrivateKey` (the
     * `Member.Key`/`Manager.MemberKey` are its public key) — deliberately NOT from the
     * strand row's shared `MemberPrivateKey`, which every joining party receives and could
     * therefore use to forge the founder's identity. A closed strand with no
     * `partyMemberPrivateKey` throws, because it could never seat a founding manager.
     * The shared key's public half IS passed, but only so the bootstrap can refuse a strand
     * founded under it before the split (`PreSplitStrandIdentityError`). Open strands derive
     * no keypair (Header only). Idempotent — see {@link bootstrapFounderMembership}.
     */
    private bootstrapFounder;
    /**
     * The sApp a founder bootstrap records in the `Strand.Header`. Throws for a storage
     * replica (no sApp config): its Header's sApp columns would have nothing to say.
     * `CadreNode` always launches a replica as a joiner, so this guards a future caller.
     */
    private founderSApp;
    /**
     * Derive the founding keypair for a closed strand from the party's own
     * `partyMemberPrivateKey`, failing loudly when the key is absent (a closed strand
     * with no founding Manager can never admit anyone).
     */
    private deriveFounderKeyPair;
    /**
     * Run the founder membership bootstrap against an ALREADY-LIVE database — the
     * seam {@link StrandInstanceManager.foundExistingStrand} uses when a founder
     * request arrives for an instance that was first launched as a joiner.
     * Idempotent: every bootstrap write is insert-if-absent
     * ({@link bootstrapFounderMembership}), so calling it on an instance that
     * already founded writes nothing. On success also flips the captured config's
     * `founder`, so this object's own record of how it was launched stays coherent
     * with what actually ran (a construction-time `founder: false` is a statement
     * about the launch, not a permanent identity); a refused bootstrap leaves it a joiner.
     *
     * @param partyMemberPrivateKey - The party's own membership key, for a closed strand
     *   whose original (joiner) launch resolved none — e.g. the `StrandPartyKey` row had
     *   not been written or replicated yet. The captured config's key wins when both
     *   exist: it is the identity this instance launched under.
     */
    ensureFounderBootstrap(partyMemberPrivateKey?: string): Promise<void>;
    /**
     * Give a live storage replica the app's schema: apply `App` to the already-composed
     * database — same libp2p node, same store, so the new tables read the blocks this node
     * already holds — and record the sApp, so a later {@link ensureFounderBootstrap} has it
     * for the `Header`. Idempotent: the apply is a declarative diff, so re-applying the same
     * schema emits nothing. A failed apply records nothing.
     */
    attachAppSchema(sAppConfig: SAppConfig): Promise<void>;
    /**
     * Get the underlying database for queries
     */
    getDatabase(): Database;
    /**
     * The Optimystic transactor this strand's connection resolved to — always
     * `'network'` here, since cadre-core passes no `transactor` option and takes
     * the plugin's default. Exposed so a spec measuring or asserting the network
     * path (`strand-solo-write-budget.spec.ts`) can pin the engine it ran on
     * rather than assume it.
     */
    getTransactor(): SereusPluginResult['transactor'];
    /**
     * Close the database and cleanup resources. Runs the strand-connection
     * shutdown (collection-factory teardown, which also stops the injected node),
     * then closes the `Database`. `StrandInstanceManager.releaseRuntime` issues a
     * further idempotent `node.stop()` after this returns.
     */
    close(): Promise<void>;
    private ensureInitialized;
}
