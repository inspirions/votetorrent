import type { Database } from '@quereus/quereus';
import type { StrandConnectionOptions, SereusPluginResult } from './types.js';
/**
 * Connect a Quereus Database to a Sereus strand (Node).
 *
 * Thin adapter over the shared {@link composeStrand} composition, supplying the
 * Node platform seams: crypto via `@quereus/quereus`'s `registerPlugin`, and a
 * TCP libp2p node created (only when not injected) via `@optimystic/db-p2p`.
 */
export declare function connectToStrand(db: Database, options: StrandConnectionOptions): Promise<SereusPluginResult>;
