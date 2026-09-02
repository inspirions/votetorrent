/**
 * officer/index.js — the authenticated-officer barrel of `@votetorrent/web-data`.
 *
 * Serves `apps/VoteTorrentDashboard`, the dashboard app used by a signed-in
 * officer. This barrel re-exports the audience-neutral connection layer plus
 * everything scoped to `src/officer/` (per-capability read helpers,
 * `CAPABILITY_TABLES`).
 *
 * Task 1 (this task) re-exports `CAPABILITY_TABLES` only — needed here,
 * ahead of Task 2, so `capabilities.test.mjs`'s cross-check can import it
 * "through the package's real export surface, not a file read" per this
 * plan's own `<interfaces>` contract. The connection layer lands in this
 * same plan's Task 2. The officer read helpers (`elections.js`, `ballots.js`,
 * `registrations.js`) land in a later plan.
 */
export { CAPABILITY_TABLES } from './capability-tables.js';
