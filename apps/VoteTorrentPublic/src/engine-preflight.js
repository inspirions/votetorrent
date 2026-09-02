/**
 * Engine preflight — D-13's positive half. Proves the browser build actually
 * reaches `@votetorrent/vote-engine/browser` (the same browser-safe subpath
 * the dashboard uses) without opening any database.
 *
 * Deliberately a NAMED import of ONLY `VOTETORRENT_SCHEMA_SQL` — NO namespace
 * import. This diverges from `apps/VoteTorrentDashboard/src/engine-preflight.js`,
 * which uses a namespace-style wildcard import of the whole subpath, and that
 * divergence is intentional: a wildcard-style import drags every export of
 * the subpath into this app's bundle — including `initDB`, `prepareDb`,
 * `registerDbPlugins` and `UserEngine` — which would put database-opening
 * code inside a public build that D-13 says must have none. Do NOT "fix"
 * this back to the dashboard's wildcard-import shape.
 *
 * The two runtime fields below are BOTH computed by a method call
 * (`.length`, `.split('\n').length`) on the imported `VOTETORRENT_SCHEMA_SQL`
 * binding, never by slicing a fixed prefix out of it. This is a measured
 * vacuity trap: a fixed short prefix (such as the schema's first line,
 * "declare schema main") could be constant-folded into a small literal by
 * the minifier, and a bundle check that greps for that literal would then
 * pass while the real ~132 KB schema string was tree-shaken away. A `split`
 * call on the imported binding cannot be folded away, so the whole string
 * must survive into the bundle for these fields to be computed correctly.
 * `apps/VoteTorrentPublic/scripts/assert-engine-reach.mjs` depends on this.
 *
 * Does NOT open, prepare, register or initialise anything. No `initDB`, no
 * `prepareDb`, no `registerDbPlugins`, no `indexedDB` reference of any kind.
 *
 * Plain ESM `.js` with JSDoc types, matching the dashboard's file-type
 * convention for this surface.
 */
import { VOTETORRENT_SCHEMA_SQL } from '@votetorrent/vote-engine/browser';

/**
 * @returns {{ schemaByteLength: number, schemaLineCount: number }}
 */
export function enginePreflight() {
	return {
		schemaByteLength: VOTETORRENT_SCHEMA_SQL.length,
		schemaLineCount: VOTETORRENT_SCHEMA_SQL.split('\n').length,
	};
}
