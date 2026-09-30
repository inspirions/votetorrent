import type { Database, VTablePluginInfo, FunctionPluginInfo, CollationPluginInfo } from '@quereus/quereus';
import type { Libp2p } from '@libp2p/interface';
import type { IRawStorage, NodeOptions } from '@optimystic/db-p2p';
import type { StrandConnectionOptions, SereusPluginResult, StrandTransactor } from './types.js';
/** Registration shape shared by the crypto and optimystic plugin results. */
interface PluginRegistrations {
    vtables?: VTablePluginInfo[];
    functions?: FunctionPluginInfo[];
    collations?: CollationPluginInfo[];
}
/**
 * Inline equivalent of `@quereus/quereus`'s `registerPlugin` for plugins that
 * only return functions/vtables/collations. Used directly for the optimystic
 * result (so the composition can read `collectionFactory` off the same object),
 * and by the browser crypto strategy to keep the browser bundle from pulling a
 * duplicate `@quereus/quereus` next to the host's instance.
 */
export declare function applyRegistrations(db: Database, result: PluginRegistrations): void;
/** Context passed to the platform's node-creation strategy. */
export interface CreateNodeContext {
    networkName: string;
    bootstrapNodes: string[];
    fretProfile: 'edge' | 'core';
    /** libp2p listening port (Node TCP). Browser transports ignore it. */
    port: number;
    /**
     * Resolved replication cluster size. Already defaulted — pass it to
     * `createLibp2pNode` verbatim; omitting it falls back to Optimystic's own
     * default of 10, which gates writes on any smaller party.
     */
    clusterSize: number;
    /**
     * The strand cluster policy, resolved here so no platform has to remember it.
     * Pass it to `createLibp2pNode` verbatim.
     *
     * Omitting it does NOT fall back to something equivalent: Optimystic then computes
     * its read-repair corroboration floor against `clusterSize` instead of against
     * {@link STRAND_CLUSTER_POLICY}'s `assumedClusterSize`, which is a stricter demand
     * than a two-machine strand can meet — so repair of a damaged block gives up where
     * it would otherwise succeed. That is the same defect class that took the *control*
     * network's e2e suite down before `42cd12c`; see `cluster-size.ts` for the reasoning
     * written out in full.
     */
    clusterPolicy: NonNullable<NodeOptions['clusterPolicy']>;
    /** Resolved persistent storage to back the node, if any. */
    storage?: IRawStorage;
}
/** Context passed to the platform's storage-resolution strategy. */
export interface ResolveStorageContext {
    strandId: string;
    resolvedTransactor: StrandTransactor;
    /** The storage the caller passed in `options.storage`, if any. */
    requestedStorage?: IRawStorage;
}
/**
 * Platform-specific seams the shared composition delegates to. Everything else
 * (transactor resolution, plugin config, registration, default vtab, hydrate,
 * schema apply, cleanup/shutdown) is identical across Node and browser and lives
 * in {@link composeStrand}.
 */
export interface StrandPlatform {
    /**
     * Register the crypto plugin against `db`. Node uses `@quereus/quereus`'s
     * `registerPlugin`; the browser inlines `applyRegistrations` to avoid bundling
     * a second `@quereus/quereus`.
     */
    registerCrypto(db: Database): void | Promise<void>;
    /**
     * Resolve the persistent storage to use. Optional — when omitted the caller's
     * `options.storage` is used verbatim (Node). The browser supplies this to
     * default to IndexedDB so a reload survives.
     */
    resolveStorage?(ctx: ResolveStorageContext): Promise<IRawStorage | undefined> | IRawStorage | undefined;
    /**
     * Create a libp2p node. Called only when no node is injected and the
     * transactor needs one. Node creates a TCP node via `@optimystic/db-p2p`;
     * the browser creates a WebSockets + circuit-relay node via the `/rn` entry.
     * Returns the created node (its `coordinatedRepo` is read by the composition).
     */
    createNode(ctx: CreateNodeContext): Promise<Libp2p>;
}
/**
 * Connect a Quereus `Database` to a Sereus strand. This is the single shared
 * SQL-surface composition: `connectToStrand` (Node), `connectToStrandBrowser`
 * (browser), and `cadre-core`'s `StrandDatabase` all flow through here, so the
 * hydrate-before-apply fix and any future schema wiring land in one place.
 *
 * Steps: resolve transactor + storage, register crypto + optimystic plugins,
 * acquire (inject or create) the libp2p node, set optimystic as the default
 * vtab, hydrate the catalog, then apply the sApp schema.
 */
export declare function composeStrand(db: Database, options: StrandConnectionOptions, platform: StrandPlatform): Promise<SereusPluginResult>;
/**
 * Step 7 of {@link composeStrand}: declare the sApp's schema as `App` and apply it — a
 * declarative diff against the catalog, so re-applying a schema that is already in place
 * emits nothing. The one site that applies an `App` schema: `composeStrand` calls it at
 * bring-up, and cadre-core's `StrandDatabase.attachAppSchema` calls it on a live storage
 * replica when an app claims the strand. The database must already be composed (optimystic
 * set as the default vtab), or the tables land in memory instead of the strand.
 *
 * Refuses a schema holding an item the Quereus parser skipped: it keeps any item whose leading
 * keyword it does not model (`create unique index …`, a misspelled `tabel`, `domain`) as an
 * opaque placeholder that apply ignores, so the app would otherwise run without that item.
 */
export declare function applyAppSchema(db: Database, schema: string): Promise<void>;
export {};
