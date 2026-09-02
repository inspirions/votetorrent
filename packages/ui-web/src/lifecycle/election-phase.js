/**
 * election-phase.js -- the COMPUTED (never selected) election lifecycle
 * phase, and the small set of pure datetime helpers `ElectionsPanel` needs
 * to render it.
 *
 * Six things a later reader cannot infer:
 *
 * 1. The phase is computed from the election's own `ElectionRevision.Timeline`,
 *    never chosen by an officer. Spike 078 shipped three `organizing` /
 *    `running` / `released` buttons as a SIMULATION AID so a reviewer could
 *    watch a since-removed write-window gate move -- that gate is gone
 *    (D-17), so a picker built here would reintroduce exactly the simulation
 *    this phase replaced with real data. There is no `setPhase` anywhere in
 *    this app.
 * 2. A foreign, absent, incomplete, non-monotonic or otherwise untrustworthy
 *    timeline yields `indeterminate` (D-10) -- `derivePhase` never throws and
 *    never guesses. A guessed phase would tell a viewer an election is in a
 *    state the data does not actually support. Unlike the retired three-phase
 *    model, `indeterminate` is rendered as a visible pill, not silence: the
 *    `Timeline` column carries zero CHECK constraints, so a broken timeline is
 *    an expected input, not an exception.
 * 3. `ElectionRevision.Timeline` carries two live shapes: `vote-core` types
 *    it `Record<ElectionEvent, number>` (epoch milliseconds), but this
 *    project's own dashboard prototype (spike 078) persisted canonical
 *    19-character datetime strings into the same column, and the schema
 *    itself still carries a standing `-- TODO: constrain Timeline`
 *    (votetorrent.qsql:840,:891). Every timeline value is normalised through
 *    `normalizeInstant` before it is compared, so both shapes are accepted
 *    identically. A THIRD shape is also live: `ElectionRevision.Timeline`'s
 *    column itself carries a JSON **string** in practice (confirmed:
 *    `seed-election-surface.js:188` writes `JSON.stringify(...)`), so
 *    `parseTimeline` also accepts the whole blob as a JSON string -- see
 *    deviation (e) below. Do not "fix" any of these shapes and do not pick
 *    one.
 * 4. The phase boundaries are HALF-OPEN and derived by a NEWEST-FIRST walk
 *    (spike 086): `pre` while `at < votingStarts`, `voting` while
 *    `votingStarts <= at < tallyingStarts`, `settling` while
 *    `tallyingStarts <= at < closed`, `closed` from the `closed` event
 *    onward. `derivePhase` walks the three boundaries newest-first (closed,
 *    then settling, then voting): the first boundary already crossed decides
 *    the phase, and a MISSING boundary only degrades the answer to
 *    `indeterminate` when nothing later already settles it -- so a broken
 *    `votingStarts` still yields a confident `settling` once `tallyingStarts`
 *    has passed, because voting is provably over either way (rung 5's
 *    property). Comparison is a plain numeric (epoch-ms) comparison, exact
 *    because every instant is normalised through `normalizeInstant` first.
 * 5. `derivePhase`'s `reason` string and every `conflicts[].detail` are
 *    MACHINE DIAGNOSTICS, never user-facing copy -- they embed raw timeline
 *    values and English sentences authored outside `copy.js`. They cross into
 *    54-12/54-13's render path, which is a copy-table boundary: every
 *    rendered sentence must be routed through `t()` (contract C2).
 * 6. `computeElectionPhase` survives this wave ONLY as a thin delegating
 *    alias over `derivePhase` -- see its own doc comment below for the full
 *    bridge rationale and expiry.
 *
 * FINDING (measured at execution time, 2026-08-26): `toCanonicalDatetime`
 * (packages/vote-engine/src/utils.ts) is not merely a validator -- for any
 * string that fails its fast-path 19-character regex, it falls through to
 * `new Date(input)` and, if that parses, returns the result re-sliced back
 * to 19 characters. A trailing `Z` (or any other `Date`-parseable suffix) is
 * therefore silently stripped, and the result is the SAME canonical string a
 * plain 19-character input of the same instant would produce -- it does
 * NOT surface as a distinct non-canonical value after normalisation.
 * Empirically: `toCanonicalDatetime('2026-11-03T08:00:00Z') === '2026-11-03T08:00:00'`.
 * This finding is about `toCanonicalDatetime`, which remains the only
 * conversion used by `assertCanonicalDatetime` and `resolveComparisonInstant`
 * -- it does not describe `normalizeInstant`, which is a distinct function
 * (below) with its own explicit-UTC handling of the canonical form.
 *
 * `Date.parse` and a bare `new Date(...)` BAN, AMENDED (Phase 54): the prior
 * blanket ban is narrowed to its real intent -- NO IMPLICIT-ZONE PARSE. The
 * lifted `normalizeInstant`, `startOfUtcDay` and `iso` all use `Date`, and
 * every `Date.parse`/`new Date(...)` call in this file either (a) receives an
 * explicit `Z` suffix, (b) goes through `Date.UTC`, or (c) receives a value
 * that already carries its own zone information (an arbitrary non-canonical
 * string, e.g. already-`Z`-suffixed ISO-8601 -- the one fallback branch in
 * `normalizeInstant` that is not itself pinned to UTC; a bare, zoneless
 * non-canonical string is expected to fail there more often than it
 * succeeds, which is acceptable because it is not the canonical 19-character
 * form D-26 is pinning). The 19-character canonical form specifically -- the
 * value D-26 requires be parsed as UTC explicitly, so the derived phase never
 * shifts with the reader's timezone -- is always parsed via an explicit `Z`
 * suffix in `normalizeInstant`, matching the same T-only, no-`Z` canonical
 * regex `assertCanonicalDatetime` pins. `toCanonicalDatetime` remains the
 * only conversion used by `assertCanonicalDatetime` and
 * `resolveComparisonInstant` -- unchanged by this amendment.
 *
 * Lifted from `.claude/skills/spike-findings-votetorrent/sources/
 * 086-election-phase-derivation/phase.js` (Phase 54, D-06/D-07/D-10),
 * replacing the three-phase (`organizing`/`running`/`released`) interval walk
 * that 53-05 had moved verbatim from
 * `apps/VoteTorrentDashboard/src/lifecycle/election-phase.js`. This lift is
 * no longer byte-for-byte verbatim -- the sha-verified-verbatim claim the
 * prior header carried does not carry over. Six deliberate deviations from
 * the 086 source, all D-07's restatement obligation:
 *
 *   (a) `threeBucket()` is omitted entirely (D-07: zero occurrences anywhere
 *       in `apps/` or `packages/`). Its `pre-election` / `during-election` /
 *       `completed-election` buckets are a vocabulary this repo never
 *       adopted -- the word `threeBucket` survives nowhere in this package's
 *       `src/` outside this sentence.
 *   (b) 086's `PHASES` map is NOT lifted -- `PHASE_IDS` from `./phase-ids.js`
 *       is the single vocabulary declaration; a second map naming the same
 *       four strings would be pure drift bait.
 *   (c) 086's `ELECTION_EVENTS` is NOT lifted -- the identical seven-member
 *       frozen `ELECTION_EVENT_ORDER` already in this file is used instead.
 *   (d) `PHASE_OPENED_BY` is EXPORTED here (086 keeps it private), so the
 *       drift assertion in `test/election-phase.test.mjs` can prove the
 *       walk's boundary map and `PHASE_IDS` cannot diverge.
 *   (e) `parseTimeline` additionally accepts the timeline as a JSON STRING,
 *       defensively parsed inside a `try` that degrades to an empty blob --
 *       086 only ever received an already-parsed object, but the real
 *       `ElectionRevision.Timeline` column carries both shapes (point 3
 *       above) and the retired `computeElectionPhase` had its own
 *       `JSON.parse` branch for exactly that reason. Dropping it would
 *       silently turn every string-valued timeline into `indeterminate` for
 *       both apps.
 *   (f) `computeElectionPhase` is RETAINED as a thin delegating alias for one
 *       wave -- see its own doc comment below.
 */

import { toCanonicalDatetime, nowCanonicalDatetime } from '@votetorrent/vote-engine/browser';
import { PHASE_IDS, phaseCopyKey, INDETERMINATE_PHASE } from './phase-ids.js';

// Re-exported unchanged (WR-11, Phase 53 review): `PHASE_IDS`/`phaseCopyKey`
// moved to the dependency-free `./phase-ids.js` sibling so `LifecyclePill.tsx`
// (a `./components` barrel member) can depend on them without transitively
// loading `@votetorrent/vote-engine/browser` -- see `phase-ids.js`'s own
// header. This module's public surface (and every existing
// `@votetorrent/ui-web/lifecycle` consumer) is unchanged.
export { PHASE_IDS, phaseCopyKey };

/** T-only, no-`Z`, 19-character canonical form -- pins `assertCanonicalDatetime` and `normalizeInstant` to the SAME regex. */
const CANONICAL_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;

/** The seven `ElectionEvent` values, in schema/vote-core order. Frozen; never derived at runtime. @type {ReadonlyArray<string>} */
export const ELECTION_EVENT_ORDER = Object.freeze([
	'registrationEnds',
	'ballotsFinal',
	'votingStarts',
	'tallyingStarts',
	'validation',
	'certificationStarts',
	'closed',
]);

/** @typedef {'pre' | 'voting' | 'settling' | 'closed'} PhaseId */

/**
 * Which `ElectionEvent` opens each non-`pre` phase. `pre` is the implicit
 * start and has no opener. EXPORTED (086 keeps it private, deviation (d))
 * so `test/election-phase.test.mjs` can assert `Object.keys(PHASE_OPENED_BY)`
 * deep-equals `PHASE_IDS.slice(1)` -- the walk's boundary map and the
 * vocabulary cannot silently diverge.
 * @type {Readonly<Record<'voting' | 'settling' | 'closed', string>>}
 */
export const PHASE_OPENED_BY = Object.freeze({
	voting: 'votingStarts',
	settling: 'tallyingStarts',
	closed: 'closed',
});

/**
 * Conflict codes `parseTimeline` can report. @type {Readonly<Record<string, string>>}
 */
export const CONFLICT = Object.freeze({
	MISSING_EVENT: 'MISSING_EVENT',
	UNPARSEABLE: 'UNPARSEABLE',
	OUT_OF_ORDER: 'OUT_OF_ORDER',
	BALLOTS_FINAL_AFTER_DEADLINE: 'BALLOTS_FINAL_AFTER_DEADLINE',
	EVENT_AFTER_ELECTION_DATE: 'EVENT_AFTER_ELECTION_DATE',
	CLOSED_BEFORE_ELECTION_DATE: 'CLOSED_BEFORE_ELECTION_DATE',
});

/**
 * @typedef {object} TimelineConflict
 * @property {string} code
 * @property {string} event
 * @property {string} detail
 */

/**
 * @typedef {object} ParsedTimeline
 * @property {Record<string, number | null>} at
 * @property {Array<TimelineConflict>} conflicts
 */

/**
 * The three schema-enforced fields `parseTimeline` cross-checks the
 * unenforced JSON Timeline against. Both optional: a two-argument caller
 * (the `computeElectionPhase` bridge alias) cannot supply either.
 * @typedef {object} ElectionCrossCheckFields
 * @property {unknown} [ballotDeadline]
 * @property {unknown} [date]
 */

/**
 * @typedef {object} DerivePhaseResult
 * @property {PhaseId | typeof INDETERMINATE_PHASE} phase
 * @property {string | null} stage
 * @property {string | null} firedRule
 * @property {string} reason
 * @property {Record<string, number | null>} at
 * @property {Array<TimelineConflict>} conflicts
 * @property {boolean} indeterminate
 */

/**
 * Throws when `value` is not a canonical 19-character, no-`Z` datetime,
 * naming both `label` and the offending value -- this guards a value the
 * dashboard PRODUCES (the comparison instant), not one it merely reads, so
 * naming the value is appropriate here (contrast the read-side PII-hygiene
 * rule, which applies to row values, not to this app's own derived instant).
 *
 * @param {unknown} value
 * @param {string} label
 * @returns {string}
 */
export function assertCanonicalDatetime(value, label) {
	if (typeof value !== 'string' || !CANONICAL_RE.test(value)) {
		throw new Error(
			`assertCanonicalDatetime: "${label}" must be a canonical 19-character datetime with no "Z" suffix, got ${JSON.stringify(value)}`,
		);
	}
	return value;
}

/**
 * Resolve the instant `derivePhase`/`computeElectionPhase` compare a timeline
 * against. Returns `provided` unchanged when it is already canonical; falls
 * back to `nowCanonicalDatetime()` when `provided` is `null` or `undefined`
 * (a panel can mount before any snapshot instant exists); throws via
 * `assertCanonicalDatetime` for any other, non-canonical value.
 *
 * @param {string | null | undefined} [provided]
 * @returns {string}
 */
export function resolveComparisonInstant(provided) {
	if (provided === null || provided === undefined) {
		return nowCanonicalDatetime();
	}
	return assertCanonicalDatetime(provided, 'resolveComparisonInstant(provided)');
}

/**
 * Normalise one raw Timeline value to epoch-ms, or `null`.
 *
 * `Record<ElectionEvent, number>` is the declared TS type, but this project's
 * own prior `computeElectionPhase` accepted `string | number` via
 * `toCanonicalDatetime` -- so the declared type is already known not to hold
 * at runtime. Both are accepted here too.
 *
 * The 19-character canonical VT form (no trailing `Z`) is parsed as UTC
 * EXPLICITLY (D-26): letting the JS engine guess would make the derived
 * phase depend on the reader's timezone, which for a public election
 * dashboard is a correctness bug, not a formatting one.
 *
 * @param {unknown} raw
 * @returns {number | null}
 */
export function normalizeInstant(raw) {
	if (raw === undefined || raw === null) return null;
	if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
	if (typeof raw !== 'string') return null;

	const trimmed = raw.trim();
	if (trimmed === '') return null;

	// Canonical VT form (19 chars, T separator, no zone): pin to UTC
	// explicitly rather than local, via an explicit `Z` suffix (D-26).
	if (CANONICAL_RE.test(trimmed)) {
		const ms = Date.parse(trimmed + 'Z');
		return Number.isFinite(ms) ? ms : null;
	}

	// Fallback: an arbitrary non-canonical string, expected to already carry
	// its own zone (e.g. `Z`-suffixed ISO-8601) more often than it succeeds
	// zoneless -- not the canonical form D-26 pins.
	const ms = Date.parse(trimmed);
	return Number.isFinite(ms) ? ms : null;
}

/**
 * Parse the whole timeline blob into `{ event -> ms|null }` plus the
 * conflicts found while doing it. Never throws: a public page must render
 * something honest for arbitrarily broken authority data.
 *
 * Accepts `timeline` as an already-parsed object OR as a JSON string
 * (deviation (e) from 086 -- see this module's header point 3): a string
 * that fails to parse, or that parses to something other than an object,
 * degrades to an empty blob, which in turn makes every event `MISSING_EVENT`
 * -- never a confident phase.
 *
 * @param {unknown} timeline
 * @param {ElectionCrossCheckFields} [election]
 * @returns {ParsedTimeline}
 */
export function parseTimeline(timeline, election = {}) {
	/** @type {Array<TimelineConflict>} */
	const conflicts = [];
	/** @type {Record<string, number | null>} */
	const at = {};

	/** @type {Record<string, unknown>} */
	let blob;
	if (typeof timeline === 'string') {
		try {
			const parsed = JSON.parse(timeline);
			blob = parsed !== null && typeof parsed === 'object' ? /** @type {Record<string, unknown>} */ (parsed) : {};
		} catch {
			blob = {};
		}
	} else {
		blob = timeline !== null && typeof timeline === 'object' ? /** @type {Record<string, unknown>} */ (timeline) : {};
	}

	for (const event of ELECTION_EVENT_ORDER) {
		const raw = blob[event];
		const ms = normalizeInstant(raw);
		at[event] = ms;
		if (ms === null) {
			conflicts.push({
				code: raw === undefined || raw === null ? CONFLICT.MISSING_EVENT : CONFLICT.UNPARSEABLE,
				event,
				detail:
					raw === undefined || raw === null
						? `${event} is absent from Timeline`
						: `${event} = ${JSON.stringify(raw)} is not a usable instant`,
			});
		}
	}

	// ORDERING, narrowed after spike 088 ran this against the only real 7-event
	// fixture in the repo (078's seeded Timeline) and this rule fired on it.
	//
	// The first version asserted that DECLARATION order is chronological order, and
	// so flagged `ballotsFinal` (2026-10-01) preceding `registrationEnds`
	// (2026-10-05). That is not a defect: finalising ballot content and closing
	// voter registration are INDEPENDENT preparation tracks, and either may finish
	// first. Only the post-voting chain is genuinely causal -- you cannot tally
	// before voting ends, validate before tallying, or certify before validating.
	//
	// So: the five post-voting events are pairwise ordered; the two preparation
	// events must each precede `votingStarts` but NOT each other.
	const STRICT_CHAIN = ['votingStarts', 'tallyingStarts', 'validation', 'certificationStarts', 'closed'];
	const PREPARATION = ['registrationEnds', 'ballotsFinal'];

	/** @type {string | null} */
	let prevEvent = null;
	for (const event of STRICT_CHAIN) {
		if (at[event] === null) continue;
		if (prevEvent !== null && /** @type {number} */ (at[event]) < /** @type {number} */ (at[prevEvent])) {
			conflicts.push({
				code: CONFLICT.OUT_OF_ORDER,
				event,
				detail: `${event} (${iso(at[event])}) precedes ${prevEvent} (${iso(at[prevEvent])})`,
			});
		}
		prevEvent = event;
	}
	for (const event of PREPARATION) {
		if (at[event] === null || at.votingStarts === null) continue;
		if (/** @type {number} */ (at[event]) > /** @type {number} */ (at.votingStarts)) {
			conflicts.push({
				code: CONFLICT.OUT_OF_ORDER,
				event,
				detail: `${event} (${iso(at[event])}) falls after votingStarts (${iso(at.votingStarts)})`,
			});
		}
	}

	// Cross-check the unenforced JSON against the three schema-enforced dates.
	// These are the conflicts that matter most: the DB will act on its columns
	// and ignore the JSON, so a disagreement means the dashboard and the
	// database would tell a viewer different things.
	const ballotDeadline = normalizeInstant(election.ballotDeadline);
	const electionDate = normalizeInstant(election.date);

	if (ballotDeadline !== null && at.ballotsFinal !== null && at.ballotsFinal > ballotDeadline) {
		conflicts.push({
			code: CONFLICT.BALLOTS_FINAL_AFTER_DEADLINE,
			event: 'ballotsFinal',
			detail:
				`Timeline says ballots are final at ${iso(at.ballotsFinal)}, after the ` +
				`schema-enforced Election.BallotDeadline ${iso(ballotDeadline)}. ` +
				`Ballot.MutationValid (E.BallotDeadline > context.now) would already reject writes.`,
		});
	}

	if (electionDate !== null) {
		// AMBIGUITY, resolved deliberately (spike 086 rung 2 caught this as a
		// false positive on an ordinary election). `Election.Date` is commented
		// "date of the election" -- a DAY -- but is typed `datetime` and compared
		// as an INSTANT by the schema's own constraints (`DateValid: Date >=
		// context.now`, `RevisionDeadlineValid: RevisionDeadline <= Date`).
		// Authorities set it to midnight, so voting at noon on election day is
		// after it as an instant while being squarely ON it as a day. Comparing
		// as an instant flags every normal election. We therefore treat Date as
		// a DAY and conflict only past the end of that day.
		const dayEnd = startOfUtcDay(electionDate) + 86_400_000;
		for (const event of ['registrationEnds', 'ballotsFinal', 'votingStarts']) {
			const eventMs = at[event];
			if (eventMs !== null && eventMs >= dayEnd) {
				conflicts.push({
					code: CONFLICT.EVENT_AFTER_ELECTION_DATE,
					event,
					detail:
						`${event} (${iso(eventMs)}) falls after the end of election day ` +
						`(Election.Date ${iso(electionDate)}, day ends ${iso(dayEnd)})`,
				});
			}
		}
		if (at.closed !== null && at.closed < electionDate) {
			conflicts.push({
				code: CONFLICT.CLOSED_BEFORE_ELECTION_DATE,
				event: 'closed',
				detail: `closed (${iso(at.closed)}) precedes Election.Date (${iso(electionDate)})`,
			});
		}
	}

	return { at, conflicts };
}

/**
 * Derive the public phase at `now`.
 *
 * THE LOAD-BEARING RULE: if the event that decides a boundary is missing or
 * unparseable, the phase is `indeterminate` -- never a silent default. A
 * public dashboard that renders "voting is open" because `votingStarts` was
 * absent from an unconstrained JSON blob is worse than one that renders
 * "unknown".
 *
 * @param {ElectionCrossCheckFields} election
 * @param {unknown} timeline
 * @param {unknown} now
 * @returns {DerivePhaseResult}
 */
export function derivePhase(election, timeline, now) {
	const nowMs = normalizeInstant(now);
	const { at, conflicts } = parseTimeline(timeline, election);

	if (nowMs === null) {
		return {
			phase: INDETERMINATE_PHASE,
			stage: null,
			firedRule: null,
			reason: '`now` is not a usable instant',
			at,
			conflicts,
			indeterminate: true,
		};
	}

	// Walk the boundaries newest-first. The first boundary already passed
	// decides the phase; a missing boundary we would have had to cross to get
	// here makes the answer indeterminate rather than wrong.
	/** @type {ReadonlyArray<readonly [PhaseId, string]>} */
	const ordered = [
		['closed', PHASE_OPENED_BY.closed],
		['settling', PHASE_OPENED_BY.settling],
		['voting', PHASE_OPENED_BY.voting],
	];

	for (const [phase, opener] of ordered) {
		const boundary = at[opener];
		if (boundary === null) {
			// We cannot rule this phase in or out. Note the ordering: because we
			// walk newest-first, a LATER boundary that has already been crossed
			// returns above and never reaches here. So a broken `votingStarts`
			// still yields a confident `settling` once `tallyingStarts` has
			// passed -- voting is provably over either way. A missing boundary
			// degrades the answer only when nothing later already settles it.
			// (Proved by rung 5's two halves.)
			return {
				phase: INDETERMINATE_PHASE,
				stage: null,
				firedRule: opener,
				reason: `cannot decide: '${opener}' is missing or unparseable, so the ${phase} boundary is unknown`,
				at,
				conflicts,
				indeterminate: true,
			};
		}
		if (nowMs >= boundary) {
			return {
				phase,
				stage: finestStage(at, nowMs),
				firedRule: `now >= ${opener}`,
				reason: `${iso(nowMs)} is at or after ${opener} (${iso(boundary)})`,
				at,
				conflicts,
				indeterminate: false,
			};
		}
	}

	return {
		phase: 'pre',
		stage: finestStage(at, nowMs),
		firedRule: 'now < votingStarts',
		reason: `${iso(nowMs)} precedes votingStarts (${iso(at.votingStarts)})`,
		at,
		conflicts,
		indeterminate: false,
	};
}

/**
 * The finest-grained stage: the last declared event whose instant has passed.
 * @param {Record<string, number | null>} at
 * @param {number} nowMs
 * @returns {string | null}
 */
function finestStage(at, nowMs) {
	/** @type {string | null} */
	let stage = null;
	for (const event of ELECTION_EVENT_ORDER) {
		const eventMs = at[event];
		if (eventMs !== null && nowMs >= eventMs) stage = event;
	}
	return stage;
}

/** @param {number} ms @returns {number} */
function startOfUtcDay(ms) {
	const d = new Date(ms);
	return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** @param {number | null | undefined} ms @returns {string} */
function iso(ms) {
	return ms === null || ms === undefined ? '(none)' : new Date(ms).toISOString().slice(0, 19) + 'Z';
}

export { iso as formatInstant };

/**
 * @deprecated Bridge alias, retained for exactly ONE wave (Phase 54, wave 1).
 *
 * It exists solely to keep `apps/VoteTorrentPublic/src/screens/ElectionShell.tsx`
 * compiling across this wave: `apps/VoteTorrentPublic/test/node/election-shell.test.mjs`'s
 * `PHASE_54_FORBIDDEN_RE` still forbids the literal `derivePhase` anywhere
 * under the public app's `src/` until **54-05** (wave 2) narrows that fence
 * and repoints that one call site. 54-05 does NOT delete this alias --
 * `apps/VoteTorrentDashboard/src/screens/panels/ElectionsPanel.tsx` and
 * `apps/VoteTorrentDashboard/test/browser/gate-matrix.tsx` also call it, and
 * their owner is **54-07** (wave 4), which repoints both dashboard call sites
 * and THEN deletes this function -- the alias dies with its LAST consumer,
 * not its first.
 *
 * Its entire body FORWARDS to `derivePhase`. It holds NO derivation logic of
 * its own -- no boundary comparison, no timeline field access, no branch
 * that could disagree with `derivePhase`; if a future reader finds one, this
 * alias has become a second implementation and D-06 ("the ONE shared
 * implementation") is broken. It passes an empty election object for the
 * schema-enforced cross-checks a two-argument caller cannot supply.
 *
 * It now returns `indeterminate` where it once returned `phase: null` --
 * that changed value flows straight into `LifecyclePill`, so both apps begin
 * rendering four phases and D-10's unknown pill during this bridge wave
 * without an app-side edit.
 *
 * @param {unknown} timelineValue
 * @param {string} atCanonical
 * @returns {{ phase: PhaseId | typeof INDETERMINATE_PHASE, reason: string }}
 */
export function computeElectionPhase(timelineValue, atCanonical) {
	const result = derivePhase({}, timelineValue, atCanonical);
	return { phase: result.phase, reason: result.reason };
}
