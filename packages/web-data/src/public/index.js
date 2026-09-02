/**
 * public/index.js — the anonymous-reader barrel of `@votetorrent/web-data`.
 *
 * Serves `apps/VoteTorrentPublic`, an unauthenticated visitor with no officer
 * identity. This barrel must NEVER re-export anything under `src/officer/`
 * (D-04) — that boundary is what makes the `./public` / `./officer` subpath
 * split structural rather than decorative.
 *
 * The connection layer (`open-db.js`, `reattach.js`, `networks-registry.js`)
 * landed here in this plan's Task 2 — explicit named re-exports only, never
 * `export *`, so the surface of this audience is readable at a glance and
 * 54-08's scan has a literal list to reason about. It is audience-neutral: it
 * opens a database and selects no application table. Public reads land in a
 * later plan.
 */
export {
	STORE_MODULE_NAME,
	DB_NAME_PREFIX,
	dbNameFor,
	openStoreHandle,
	createNetworkDb,
	closeNetworkDb,
	listObjectStores,
	deleteNetworkDb,
} from '../open-db.js';

export {
	NotBootstrappedError,
	MissingRowCountsError,
	RowCountMismatchError,
	InvalidRowCountRecordError,
	ROW_COUNTS_KEY_PREFIX,
	rowCountsKeyFor,
	writeRowCounts,
	readRowCountsRecord,
	clearRowCounts,
	readRowCounts,
	assertRowCounts,
	attachNetworkDb,
} from '../reattach.js';

export {
	NETWORKS_REGISTRY_KEY,
	InvalidNetworkRegistryError,
	listNetworks,
	findNetwork,
	upsertNetwork,
	removeNetwork,
} from '../networks-registry.js';

/**
 * @typedef {import('../open-db.js').DeleteNetworkDbOptions} DeleteNetworkDbOptions
 * @typedef {import('../reattach.js').StorageAdapter} StorageAdapter
 * @typedef {import('../reattach.js').RowCountsRecord} RowCountsRecord
 * @typedef {import('../networks-registry.js').NetworkRegistryEntry} NetworkRegistryEntry
 */
