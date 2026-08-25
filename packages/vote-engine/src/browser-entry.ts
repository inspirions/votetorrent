// src/browser-entry.ts — browser-safe subpath entry (D-01/D-02/D-19)
//
// Neither `src/index.ts` (the default '.' subpath) nor `src/rn-entry.ts` (the
// './rn' subpath) is importable from a browser bundle: both re-export
// `LocalStorageReact`, which imports `@react-native-async-storage/async-storage`
// at module scope (`src/local-storage-react.ts:1`), unconditionally. Phase 50
// (the Authority Web Dashboard) is the first consumer that needs the compiled
// engine WITHOUT React Native in the module graph at all, so this is a third,
// narrow subpath rather than a conditional inside an existing one.
//
// The exclusion list below (see the DELIBERATELY NOT EXPORTED block) is
// enforced by `test/browser-entry-purity.spec.ts` — a source-level
// transitive-import-graph walker with a working positive control. Do NOT
// "helpfully" widen this file's exports without updating that spec's
// allowlist; a widening that pulls in a forbidden specifier fails the purity
// gate, not a downstream Vite build.
//
// Per D-01 (Phase 50 steps 1+2 only — read-only dashboard, no panel actions
// yet), this seam deliberately exports NO write-capable domain engine: no
// AuthorityEngine, ElectionsEngine, ElectionEngine, SigningEngine,
// RegistrationEngine, InvitationEngine, AuthorityConfigEngine, NetworksEngine,
// or NetworkEngine.
//
// Do NOT add `export * from './index.js'` or `export * from './rn-entry.js'`
// here — that is exactly the barrel-widening this seam exists to prevent.
// Named exports only, each with an inline comment naming the consuming plan.

// The privilege primitive. `isPrivileged`'s SQL runs unmodified in a browser
// (spikes 075/078). Plan 50-06 wraps it; it must never be re-derived as a
// hand-rolled SQL string, which is what all four spikes did only because this
// barrel-import problem was unsolved.
export { UserEngine } from './user/user-engine.js'

// The per-Database lifecycle. `registerDbPlugins` registers the crypto plugin
// and the `SignatureValid`/`SignatureValidP256` UDFs the schema's CHECK
// constraints call; without it on this seam, plan 50-05's `open-db.ts` would
// have to hand-roll UDF registration. `isSchemaInitialized` is the D-11
// re-attach gate.
export {
	registerDbPlugins,
	initDB,
	prepareDb,
	isSchemaInitialized,
	markSchemaInitialized,
} from './database/initialize.js'

// The single source of truth for the DDL, bundled as a string so no `node:fs`
// or `import.meta` is needed in a browser bundle.
export { VOTETORRENT_SCHEMA_SQL } from './database/schema-sql.js'

// `H16` produces the `networkHash` the browser database name is keyed on; the
// three datetime helpers are the only correct producers/parsers of the
// 19-character, no-`Z` canonical datetime format.
export { H16, toCanonicalDatetime, nowCanonicalDatetime, fromCanonicalDatetime } from './utils.js'

export type { DbFactory, EngineContext } from './types.js'

// -----------------------------------------------------------------------
// DELIBERATELY NOT EXPORTED (enforced by test/browser-entry-purity.spec.ts)
// -----------------------------------------------------------------------
//
// - LocalStorageReact — imports `@react-native-async-storage/async-storage`
//   at module scope (src/local-storage-react.ts:1).
// - AssociationEngine, PlayIntegrityVerifier, LocalConfigKeyProvider — import
//   `Buffer` from the `buffer` package.
// - verifySigP256 — rn-entry.ts exports it for on-device proof code; the
//   browser holds no key and can never sign (D-04), so it has no consumer
//   here.
// - Every write-capable domain engine — AuthorityEngine, ElectionsEngine,
//   ElectionEngine, SigningEngine, RegistrationEngine, InvitationEngine,
//   AuthorityConfigEngine, NetworksEngine, NetworkEngine — because Phase 50
//   is read-only (D-01: panel actions are step 3, explicitly OUT) and
//   because the outline's binding cross-plan contract 2 fixes the
//   dashboard's only engine-class import as UserEngine.
