/**
 * officer/index.js — the authenticated-officer barrel of `@votetorrent/web-data`.
 *
 * Serves `apps/VoteTorrentDashboard`, the dashboard app used by a signed-in
 * officer. This barrel re-exports the audience-neutral connection layer plus
 * everything scoped to `src/officer/` (per-capability read helpers,
 * `CAPABILITY_TABLES`).
 *
 * `CAPABILITY_TABLES` landed in Task 1 — needed ahead of Task 2 so
 * `capabilities.test.mjs`'s cross-check can import it "through the package's
 * real export surface, not a file read" per this plan's own `<interfaces>`
 * contract. The connection layer (`open-db.js`, `reattach.js`,
 * `networks-registry.js`) lands here in Task 2 (this task) — explicit named
 * re-exports only, never `export *`, so the surface of this audience is
 * readable at a glance. The officer read helpers (`elections.js`,
 * `ballots.js`, `registrations.js`) land in a later plan.
 */
export { CAPABILITY_TABLES } from './capability-tables.js';

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
