import type { Database } from '@quereus/quereus';
import type { StrandConnectionOptions, SereusPluginResult } from './types.js';
/**
 * Connect a Quereus Database to a Sereus strand from a browser/worker.
 *
 * Thin adapter over the shared {@link composeStrand} composition, supplying the
 * browser platform seams:
 *  - crypto registered inline (no runtime `@quereus/quereus` import, so the
 *    bundle does not duplicate the host's instance),
 *  - storage defaulting to `IndexedDBRawStorage` keyed by `sereus-strand-<id>`,
 *  - a node created via the TCP-free `@optimystic/db-p2p/rn` entry with explicit
 *    `webSockets()` + `circuitRelayTransport()` transports.
 */
export declare function connectToStrandBrowser(db: Database, options: StrandConnectionOptions): Promise<SereusPluginResult>;
