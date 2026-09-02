/**
 * @votetorrent/ui-web — the `.` barrel.
 *
 * Binding rule (D-16, mirrors apps/VoteTorrentDashboard/src/i18n/copy.js's
 * contract-header idiom): this file, and everything it transitively imports,
 * MUST be plain JavaScript that plain Node can resolve with no bundler. The
 * tier-1 gate in every web workspace consuming this package (the dashboard
 * today, apps/VoteTorrentPublic once 53-06 lands) runs under
 * `node --test` with no bundler in front of it. Anything `.tsx`, or anything
 * that transitively imports a `.tsx` file, belongs behind the separate
 * `./components` subpath (see src/components.js), never here.
 *
 * `copy.js` (the shared copy table, D-05/D-09/D-10/D-11) landed in 53-04 and is
 * re-exported below. Still pending, later Phase 53 work, not this plan's:
 *   - `lifecycle/election-phase.js` lands in 53-05 (D-01/D-02/D-07).
 *
 * Do not merge this barrel with `./components` — the split under `./exports`
 * in package.json is what makes `ERR_MODULE_NOT_FOUND` the correct, gated
 * behaviour for a `.tsx` re-export reached from plain Node, rather than a
 * silent success that only breaks a consumer at build/typecheck time.
 */

export { COPY, t } from './copy.js';
