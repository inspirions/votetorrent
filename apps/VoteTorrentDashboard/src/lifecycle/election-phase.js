/**
 * election-phase.js -- the COMPUTED (never selected) election lifecycle
 * phase, and the small set of pure datetime helpers `ElectionsPanel` needs
 * to render it.
 *
 * Four things a later reader cannot infer:
 *
 * 1. The phase is computed from the election's own `ElectionRevision.Timeline`,
 *    never chosen by an officer. Spike 078 shipped three `organizing` /
 *    `running` / `released` buttons as a SIMULATION AID so a reviewer could
 *    watch a since-removed write-window gate move -- that gate is gone
 *    (D-17), so a picker built here would reintroduce exactly the simulation
 *    this phase replaced with real data. There is no `setPhase` anywhere in
 *    this app.
 * 2. A foreign, absent, incomplete, non-monotonic or otherwise untrustworthy
 *    timeline yields a machine reason and NO pill -- `computeElectionPhase`
 *    never throws and never guesses. A guessed phase would tell an officer
 *    an election is in a state the data does not actually support.
 * 3. `ElectionRevision.Timeline` carries two live shapes: `vote-core` types
 *    it `Record<ElectionEvent, number>` (epoch milliseconds), but this
 *    project's own dashboard prototype (spike 078) persisted canonical
 *    19-character datetime strings into the same column, and the schema
 *    itself still carries a standing `-- TODO: constrain Timeline`
 *    (votetorrent.qsql:840,:891). Every timeline value is normalised through
 *    `toCanonicalDatetime` before it is compared, so both shapes are
 *    accepted identically. Do not "fix" either side and do not pick one.
 * 4. The phase boundaries are HALF-OPEN: `[start, next)`. An instant exactly
 *    on a boundary belongs to the LATER phase -- `organizing` while
 *    `at < votingStarts`, `running` while `votingStarts <= at < tallyingStarts`,
 *    `released` from `tallyingStarts` onward. Comparison is a plain
 *    lexicographic string comparison, which is exact for a fixed-width
 *    canonical form -- and only exact because validation runs BEFORE it.
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
 * Consequently `computeElectionPhase` does NOT reach `'invalid-datetime'`
 * for a `Z`-suffixed but otherwise `Date`-parseable timeline value -- it
 * normalises and compares like any other instant, which is arguably the
 * more useful behaviour for a value this module only ever reads. The
 * `'invalid-datetime'` branch is still real and is still exercised: it
 * fires for any string `toCanonicalDatetime` cannot parse into a `Date` at
 * all (e.g. `'not-a-date'`), which is returned UNCHANGED by
 * `toCanonicalDatetime` and then fails the post-normalisation regex here.
 * The unrelated claim this module also relies on -- that
 * `assertCanonicalDatetime` (which never normalises, unlike
 * `toCanonicalDatetime`) throws on that exact `Z`-suffixed string -- is
 * unaffected by this finding and is pinned by its own positive control.
 *
 * `Date.parse` and a bare `new Date(...)` are BANNED in this file.
 * `toCanonicalDatetime` is the only sanctioned conversion; there is no
 * arithmetic here, so `fromCanonicalDatetime` is not needed.
 */

import { toCanonicalDatetime, nowCanonicalDatetime } from '@votetorrent/vote-engine/browser';

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

/** @typedef {'organizing' | 'running' | 'released'} PhaseId */

/** @type {ReadonlyArray<PhaseId>} */
export const PHASE_IDS = Object.freeze(['organizing', 'running', 'released']);

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
 * Resolve the instant `computeElectionPhase` compares a timeline against.
 * Returns `provided` unchanged when it is already canonical; falls back to
 * `nowCanonicalDatetime()` when `provided` is `null` or `undefined` (a panel
 * can mount before any snapshot instant exists); throws via
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
 * @typedef {object} ElectionPhaseResult
 * @property {PhaseId | null} phase
 * @property {'no-timeline' | 'incomplete-timeline' | 'non-monotonic-timeline' | 'invalid-datetime' | null} reason
 */

/**
 * Compute the election's lifecycle phase from its raw `ElectionRevision.Timeline`
 * column value (a JSON string, an already-parsed object, or nullish) and a
 * canonical comparison instant. NEVER throws -- a foreign, possibly tampered
 * timeline yields a machine reason and no phase, never a guess.
 *
 * @param {unknown} timelineValue
 * @param {string} atCanonical
 * @returns {ElectionPhaseResult}
 */
export function computeElectionPhase(timelineValue, atCanonical) {
	if (timelineValue === null || timelineValue === undefined || timelineValue === '') {
		return { phase: null, reason: 'no-timeline' };
	}

	/** @type {unknown} */
	let timeline;
	if (typeof timelineValue === 'string') {
		try {
			timeline = JSON.parse(timelineValue);
		} catch {
			return { phase: null, reason: 'no-timeline' };
		}
	} else {
		timeline = timelineValue;
	}

	if (timeline === null || typeof timeline !== 'object') {
		return { phase: null, reason: 'no-timeline' };
	}

	const record = /** @type {Record<string, unknown>} */ (timeline);
	const rawVotingStarts = record.votingStarts;
	const rawTallyingStarts = record.tallyingStarts;
	if (rawVotingStarts === null || rawVotingStarts === undefined || rawTallyingStarts === null || rawTallyingStarts === undefined) {
		return { phase: null, reason: 'incomplete-timeline' };
	}
	if (typeof rawVotingStarts !== 'string' && typeof rawVotingStarts !== 'number') {
		return { phase: null, reason: 'invalid-datetime' };
	}
	if (typeof rawTallyingStarts !== 'string' && typeof rawTallyingStarts !== 'number') {
		return { phase: null, reason: 'invalid-datetime' };
	}

	const votingStarts = toCanonicalDatetime(rawVotingStarts);
	const tallyingStarts = toCanonicalDatetime(rawTallyingStarts);

	if (!CANONICAL_RE.test(votingStarts) || !CANONICAL_RE.test(tallyingStarts)) {
		return { phase: null, reason: 'invalid-datetime' };
	}

	if (tallyingStarts < votingStarts) {
		return { phase: null, reason: 'non-monotonic-timeline' };
	}

	if (atCanonical < votingStarts) {
		return { phase: 'organizing', reason: null };
	}
	if (atCanonical < tallyingStarts) {
		return { phase: 'running', reason: null };
	}
	return { phase: 'released', reason: null };
}

/**
 * @param {PhaseId | null} phase
 * @returns {string | null}
 */
export function phaseCopyKey(phase) {
	if (phase === 'organizing' || phase === 'running' || phase === 'released') {
		return `lifecycle.${phase}`;
	}
	return null;
}
