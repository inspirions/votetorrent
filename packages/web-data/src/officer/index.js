/**
 * officer/index.js — the authenticated-officer barrel of `@votetorrent/web-data`.
 *
 * Serves `apps/VoteTorrentDashboard`, the dashboard app used by a signed-in
 * officer. This barrel re-exports the audience-neutral connection layer plus
 * everything scoped to `src/officer/` (per-capability read helpers,
 * `CAPABILITY_TABLES`).
 *
 * `CAPABILITY_TABLES` landed in 54-03a's Task 1 — needed ahead of Task 2 so
 * `capabilities.test.mjs`'s cross-check could import it "through the
 * package's real export surface, not a file read". The connection layer
 * (`open-db.js`, `reattach.js`, `networks-registry.js`) landed in 54-03a's
 * Task 2 — explicit named re-exports only, never `export *`, so the surface
 * of this audience is readable at a glance.
 *
 * 54-06 adds `read-keyholders.js`, the per-row `Keyholder` join `User` roster.
 * It is exported HERE and nowhere under `src/public/`: that placement is what
 * makes D-04's audience split structural — the public audience's counterpart to
 * it, `public/read-keyrelease.js`, answers the same subject with counts alone.
 *
 * The officer read helpers (`elections.js`, `ballots.js`, `registrations.js`)
 * land here in 54-03b. Same discipline, one addition: each module also
 * exports its own `TABLES_READ` constant, and three modules cannot all
 * re-export a binding named `TABLES_READ` from one barrel without a
 * collision — so each is re-exported under a module-qualified name
 * (`ELECTIONS_TABLES_READ` / `BALLOTS_TABLES_READ` / `REGISTRATIONS_TABLES_READ`)
 * rather than as a namespace object, keeping every read function itself a
 * flat, directly-importable name for the three dashboard panels.
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

export {
	selectActiveElection,
	readElectionOverview,
	readElectionPolicies,
	countElections,
	TABLES_READ as ELECTIONS_TABLES_READ,
} from './elections.js';

export { readBallots, readQuestions, countBallotSigningTasks, TABLES_READ as BALLOTS_TABLES_READ } from './ballots.js';

export {
	ROSTER_PAGE_SIZE,
	readRegistrantStatusBreakdown,
	readRegistrationRequestBreakdown,
	readRegistrantRoster,
	readRegistrationSurfaceCounts,
	hasAnyRegistrationData,
	TABLES_READ as REGISTRATIONS_TABLES_READ,
} from './registrations.js';

export { readKeyholders, TABLES_READ as KEYHOLDER_TABLES_READ } from './read-keyholders.js';

/**
 * @typedef {import('../open-db.js').DeleteNetworkDbOptions} DeleteNetworkDbOptions
 * @typedef {import('../reattach.js').StorageAdapter} StorageAdapter
 * @typedef {import('../reattach.js').RowCountsRecord} RowCountsRecord
 * @typedef {import('../networks-registry.js').NetworkRegistryEntry} NetworkRegistryEntry
 * @typedef {import('./elections.js').ActiveElection} ActiveElection
 * @typedef {import('./elections.js').ElectionOverview} ElectionOverview
 * @typedef {import('./elections.js').ElectionPolicies} ElectionPolicies
 * @typedef {import('./elections.js').RegistrationFieldBreakdownRow} RegistrationFieldBreakdownRow
 * @typedef {import('./ballots.js').BallotRow} BallotRow
 * @typedef {import('./ballots.js').QuestionRow} QuestionRow
 * @typedef {import('./registrations.js').StatusBreakdownRow} StatusBreakdownRow
 * @typedef {import('./registrations.js').RequestBreakdownRow} RequestBreakdownRow
 * @typedef {import('./registrations.js').RosterRow} RosterRow
 * @typedef {import('./registrations.js').RosterResult} RosterResult
 * @typedef {import('./registrations.js').SurfaceCountEntry} SurfaceCountEntry
 * @typedef {import('./read-keyholders.js').KeyholderRosterRow} KeyholderRosterRow
 */
