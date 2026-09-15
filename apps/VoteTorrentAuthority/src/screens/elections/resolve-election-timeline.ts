/**
 * Phase 59 plan 04 (D-16) — the single, shared construction site for a
 * ten-event `ElectionRevision.Timeline`, used by BOTH `CreateElectionScreen`
 * and `EditElectionScreen` so their signed write paths cannot drift apart
 * again the way R2 let them (see the R2 regression pin in this module's
 * co-located test).
 *
 * `now` is an explicit parameter and this module never reads the wall clock
 * itself (T-59-04-02 in the plan's threat model) — a signing-path digest-
 * parity control, not a style choice: two independently-timed calls would
 * sign a different blob than is stored.
 *
 * The seven pre-existing events keep defaulting RELATIVE TO `votingStarts`,
 * not to `now`, exactly as both screens did before this extraction — pushing
 * the voting date out keeps `votingStarts < accruingVotes < hashingVotes <
 * releasingKeys < tallyingStarts < validation < certificationStarts < closed`
 * satisfied (the ordering guard both screens preserve inline, per
 * `<wave_seam_note>`) regardless of how far out an officer sets it.
 */

import { ElectionEvent } from '@votetorrent/vote-core'

const DAY_MS = 24 * 60 * 60 * 1000

/** The ten `ElectionEvent` members, in D-09 chronological order — derived
 * from the enum itself (never a hand-typed literal) so this constant cannot
 * drift from `vote-core`. */
export const TIMELINE_FIELD_ORDER: readonly ElectionEvent[] = Object.values(ElectionEvent)

/**
 * The ten date-string fields a screen's revision form must supply. Not
 * imported from `ElectionRevisionFormValue` — this module stays independent
 * of the form component; the form value is structurally assignable to this
 * interface, which is all a caller needs.
 */
export interface TimelineFormDates {
  registrationEnds: string
  ballotsFinal: string
  votingStarts: string
  accruingVotes: string
  hashingVotes: string
  releasingKeys: string
  tallyingStarts: string
  validation: string
  certificationStarts: string
  closed: string
}

/** Front-half blank-form fallback offsets, in whole days from `now`. */
export interface TimelineFallbackDays {
  registrationEnds: number
  ballotsFinal: number
  votingStarts: number
}

/** Lifted verbatim from `CreateElectionScreen`'s pre-extraction literals. */
export const CREATE_FALLBACK_DAYS: TimelineFallbackDays = {
  registrationEnds: 2,
  ballotsFinal: 5,
  votingStarts: 10,
}

/** Lifted verbatim from `EditElectionScreen`'s pre-extraction literals. */
export const EDIT_FALLBACK_DAYS: TimelineFallbackDays = {
  registrationEnds: 3,
  ballotsFinal: 6,
  votingStarts: 11,
}

/**
 * Preserves today's `s.trim() ? new Date(s).getTime() || fallbackMs :
 * fallbackMs` semantics exactly — including that a parsed value of `0`
 * falls back, because `0` is falsy.
 */
function parseDateOrFallback(s: string, fallbackMs: number): number {
  return s.trim() ? new Date(s).getTime() || fallbackMs : fallbackMs
}

/**
 * Resolves a form's ten date strings into the full `ElectionEvent` ->
 * instant map both screens sign. `now` is an explicit parameter (see module
 * header); the module never reads the wall clock itself.
 */
export function resolveElectionTimeline(
  form: TimelineFormDates,
  now: number,
  fallbackDays: TimelineFallbackDays
): Record<ElectionEvent, number> {
  const votingStarts = parseDateOrFallback(form.votingStarts, now + fallbackDays.votingStarts * DAY_MS)

  return {
    [ElectionEvent.registrationEnds]: parseDateOrFallback(
      form.registrationEnds,
      now + fallbackDays.registrationEnds * DAY_MS
    ),
    [ElectionEvent.ballotsFinal]: parseDateOrFallback(form.ballotsFinal, now + fallbackDays.ballotsFinal * DAY_MS),
    [ElectionEvent.votingStarts]: votingStarts,
    [ElectionEvent.accruingVotes]: parseDateOrFallback(form.accruingVotes, votingStarts + 1 * DAY_MS),
    [ElectionEvent.hashingVotes]: parseDateOrFallback(form.hashingVotes, votingStarts + 2 * DAY_MS),
    [ElectionEvent.releasingKeys]: parseDateOrFallback(form.releasingKeys, votingStarts + 3 * DAY_MS),
    [ElectionEvent.tallyingStarts]: parseDateOrFallback(form.tallyingStarts, votingStarts + 4 * DAY_MS),
    [ElectionEvent.validation]: parseDateOrFallback(form.validation, votingStarts + 5 * DAY_MS),
    [ElectionEvent.certificationStarts]: parseDateOrFallback(
      form.certificationStarts,
      votingStarts + 6 * DAY_MS
    ),
    [ElectionEvent.closed]: parseDateOrFallback(form.closed, votingStarts + 7 * DAY_MS),
  } as Record<ElectionEvent, number>
}
