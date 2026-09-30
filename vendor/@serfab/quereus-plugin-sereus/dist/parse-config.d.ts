import type { SqlValue } from '@quereus/quereus';
import type { StrandConnectionOptions, StrandTransactor } from './types.js';
type FretProfile = NonNullable<StrandConnectionOptions['fretProfile']>;
export interface ParsedPluginConfig {
    options: StrandConnectionOptions;
    /**
     * Node-only: resolved to a `FileRawStorage` by `plugin.ts`, rejected by
     * `plugin-browser.ts`. It travels beside the options rather than in them
     * because `StrandConnectionOptions.storage` is an `IRawStorage`, which no
     * `SqlValue` can carry.
     */
    storagePath?: string;
}
/** What each setting reads to once it is supplied and accepted. */
interface SettingTypes {
    strand_id: string;
    bootstrap_nodes: string[];
    schema: string;
    sapp_id: string;
    sapp_version: string;
    port: number;
    enable_cache: boolean;
    fret_profile: FretProfile;
    transactor: StrandTransactor;
    storage_path: string;
}
type SettingKey = keyof SettingTypes;
/** Every key the plugin accepts; the package manifest's `quereus.settings` must list the same. */
export declare const PLUGIN_SETTING_KEYS: readonly SettingKey[];
/**
 * Parse the plugin-loader SqlValue config into typed StrandConnectionOptions.
 * Shared by the Node (`plugin.ts`) and browser (`plugin-browser.ts`) entries.
 *
 * Strict: an unknown key or a value of the wrong type throws one error listing
 * every problem, rather than falling back to a default the user never chose.
 */
export declare function parseConfig(config: Record<string, SqlValue>): ParsedPluginConfig;
export {};
