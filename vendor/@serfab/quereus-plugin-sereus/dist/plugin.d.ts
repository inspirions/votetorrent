/**
 * Quereus plugin entry point for Sereus strand connections (Node).
 *
 * Loaded via Quoomb's `.plugin install` or config file, or via `registerPlugin()`.
 * Parses SqlValue config and delegates to `connectToStrand`.
 *
 * Browser/Worker consumers should load `./plugin-browser` instead, which uses
 * the TCP-free libp2p entry and IndexedDB-backed default storage.
 */
import type { Database, SqlValue } from '@quereus/quereus';
import { parseConfig } from './parse-config.js';
import type { SereusPluginResult } from './types.js';
export { parseConfig };
/**
 * Default export: Quereus plugin registration function.
 */
export default function register(db: Database, config?: Record<string, SqlValue>): Promise<SereusPluginResult>;
