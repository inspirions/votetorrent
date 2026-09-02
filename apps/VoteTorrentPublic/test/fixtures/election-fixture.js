/**
 * election-fixture.js — TEST-ONLY. Nothing under `apps/VoteTorrentPublic/src`
 * may import this file (D-17): a production bundle containing these facts
 * would let a public page assert election facts that are not true, on a
 * page whose entire purpose is that its claims can be checked.
 * `test/node/election-harness.test.mjs` asserts the absence of any import
 * specifier reaching this file (or `fixtures/`, or `test/`) from `src/`.
 *
 * Plain JS, frozen exports, zero imports from `src/` — this file has no
 * dependency on anything this app builds, so it cannot accidentally pull a
 * production module (and its side effects) into a test-only artefact.
 */

/**
 * Matches `ELECTION_ID_PATTERN` and CONTAINS the literal substring
 * `vtx-fixture`, so a `dist/` scan has a token to name.
 * @type {string}
 */
export const FIXTURE_ELECTION_ID = 'vtx-fixture-0001';

/**
 * A frozen `{ title, timeline }` fact set. `title` also contains
 * `vtx-fixture`. `timeline`'s two instants are canonical 19-character
 * datetimes with NO trailing `Z` — `toCanonicalDatetime` silently strips a
 * trailing `Z`, so keeping one here would test nothing it appears to test
 * (see `election-phase.js`'s own header FINDING).
 * @type {Readonly<{ title: string, timeline: Readonly<{ votingStarts: string, tallyingStarts: string }> }>}
 */
export const FIXTURE_ELECTION = Object.freeze({
	title: 'vtx-fixture Test Election',
	timeline: Object.freeze({
		votingStarts: '2026-11-03T08:00:00',
		tallyingStarts: '2026-11-03T20:00:00',
	}),
});

/**
 * Three canonical instants, one per `PHASE_IDS` member, each chosen to land
 * STRICTLY inside its phase under `computeElectionPhase`'s half-open
 * `[start, next)` boundary rule — never on a boundary.
 * @type {Readonly<{ organizing: string, running: string, released: string }>}
 */
export const FIXTURE_INSTANTS = Object.freeze({
	organizing: '2026-11-03T07:00:00',
	running: '2026-11-03T12:00:00',
	released: '2026-11-04T00:00:00',
});
