/**
 * timeline-fixtures.ts -- Phase 59 plan 59-07, Task 1.
 *
 * Production-length strings + the ten-row view-model builder shared by `TimelineRow.test.tsx`
 * and `TimelineRail.test.tsx`. Deliberately under `__fixtures__/`, NOT `__tests__/` -- jest's
 * default `testMatch` treats every file under a `__tests__` directory as a suite, and a helper
 * module there fails with "must contain at least one test".
 *
 * `buildTenRowFixture` calls the REAL `deriveTimeline` adapter (59-06) rather than hand-rolling a
 * join -- this plan consumes 59-06's derivation, it never reimplements it. `buildRowFixture` is a
 * lighter single-row builder for `TimelineRow.test.tsx`'s per-stage/per-status behavior
 * assertions, which do not need a full, mutually-consistent ten-row rail.
 *
 * Trap (D-23(f)): this file is a plain `.ts` under `src/`, so
 * `src/__tests__/no-vrg-ceremony.gate.test.ts`'s source walk scans it -- it must never contain a
 * real `register(`, `associate(`, `seedSignedMutation` or `issueAttestationChallenge` call. It
 * does not.
 */
import {deriveTimeline, STAGE_TITLE_KEY} from '../../timeline';
import type {TimelineRow, TimelineRowStatus, TimelineStageId} from '../../timeline';

/** Production-length election title fixture (53 chars) -- the phase's DEFAULT header fixture, not
 * an edge-case addenda. Proves the `h2` title wraps rather than clipping. */
export const PRODUCTION_ELECTION_TITLE = 'Salt Lake County School Board Special Election 2025';

/** Production-length network name fixture (49 chars) -- the phase's DEFAULT registration-panel
 * fixture. Proves the panel wraps its bold run without clipping. */
export const PRODUCTION_NETWORK_NAME = 'Salt Lake County Unified School District Network';

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/** A fixed anchor instant so the same-day cluster and MM/DD labels are deterministic across test
 * runs and CI hosts (no `Date.now()` dependency anywhere in this module). */
export const FIXTURE_NOW_MS = Date.UTC(2026, 2, 23, 12, 0, 0);

/**
 * Builds a full ten-instant Timeline object anchored to `nowMs`: `registrationEnds`/
 * `ballotsFinal` sit in the past, `votingStarts` has JUST been crossed (making it the `current`
 * row), and `accruingVotes`/`hashingVotes`/`releasingKeys`/`tallyingStarts`/`validation`/
 * `certificationStarts`/`closed` sit in the future -- with `accruingVotes`/`hashingVotes`/
 * `releasingKeys` landing on the SAME calendar day, exercising the mockup's same-day cluster
 * (D-09).
 */
function buildAnchoredTimeline(nowMs: number): Record<TimelineStageId, number> {
	return {
		registrationEnds: nowMs - 3 * DAY_MS,
		ballotsFinal: nowMs - 2 * DAY_MS,
		votingStarts: nowMs - HOUR_MS,
		accruingVotes: nowMs + 2 * HOUR_MS,
		hashingVotes: nowMs + 4 * HOUR_MS,
		releasingKeys: nowMs + 6 * HOUR_MS,
		tallyingStarts: nowMs + 8 * HOUR_MS,
		validation: nowMs + DAY_MS + 2 * HOUR_MS,
		certificationStarts: nowMs + 2 * DAY_MS,
		closed: nowMs + 3 * DAY_MS,
	};
}

/**
 * The ten `TimelineRow` view-models in D-09 order, anchored to `nowMs` (default
 * `FIXTURE_NOW_MS`) -- `votingStarts` is `current`; `registrationEnds`/`ballotsFinal` are `past`;
 * everything else is `future`, including the same-day `accruingVotes`/`hashingVotes`/
 * `releasingKeys` cluster. Built by calling the real `deriveTimeline()` adapter, never a
 * hand-rolled join.
 */
export function buildTenRowFixture(nowMs: number = FIXTURE_NOW_MS, timeZone = 'UTC', language = 'en'): TimelineRow[] {
	const result = deriveTimeline({
		timeline: buildAnchoredTimeline(nowMs),
		now: nowMs,
		timeZone,
		language,
	});
	if (result.indeterminate) {
		throw new Error(`buildTenRowFixture: fixture timeline unexpectedly indeterminate -- ${result.reason}`);
	}
	return result.rows;
}

/**
 * The pre-D-08 seven-key slice of `buildTenRowFixture`'s output (drops `accruingVotes`/
 * `hashingVotes`/`releasingKeys`) -- `TimelineRail`'s partial-rail-refusal test input.
 */
export function buildSevenRowFixture(nowMs: number = FIXTURE_NOW_MS): TimelineRow[] {
	const excluded: ReadonlySet<TimelineStageId> = new Set(['accruingVotes', 'hashingVotes', 'releasingKeys']);
	return buildTenRowFixture(nowMs).filter(row => !excluded.has(row.stageId));
}

/**
 * A single `TimelineRow` view-model for ONE stage in ONE status, for `TimelineRow.test.tsx`'s
 * per-stage/per-status action-surface assertions, which exercise one row in isolation rather
 * than a full mutually-consistent ten-row rail. `instantMs`/`railLabel`/`subtitle` default to
 * plausible, self-consistent values a caller can override piece by piece.
 */
export function buildRowFixture(overrides: {stageId: TimelineStageId} & Partial<Omit<TimelineRow, 'stageId'>>): TimelineRow {
	const {stageId} = overrides;
	const status: TimelineRowStatus = overrides.status ?? 'past';
	const instantMs = 'instantMs' in overrides ? (overrides.instantMs ?? null) : FIXTURE_NOW_MS - DAY_MS;

	return {
		stageId,
		titleKey: STAGE_TITLE_KEY[stageId],
		status,
		instantMs,
		railLabel:
			overrides.railLabel ??
			(status === 'current' ? {kind: 'now'} : instantMs !== null ? {kind: 'date', text: '03/20'} : {kind: 'unknown'}),
		subtitle:
			overrides.subtitle !== undefined
				? overrides.subtitle
				: instantMs !== null
					? {key: 'subtitle.pastDate', params: {date: '03/20'}}
					: null,
	};
}
