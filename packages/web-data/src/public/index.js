/**
 * public/index.js — the anonymous-reader barrel of `@votetorrent/web-data`.
 *
 * Serves `apps/VoteTorrentPublic`, an unauthenticated visitor with no officer
 * identity. This barrel must NEVER re-export anything under `src/officer/`
 * (D-04) — that boundary is what makes the `./public` / `./officer` subpath
 * split structural rather than decorative.
 *
 * Placeholder: the connection layer (`open-db.js`, `reattach.js`,
 * `networks-registry.js`) lands here in this same plan's Task 2. Public reads
 * land in a later plan.
 */
export {};
