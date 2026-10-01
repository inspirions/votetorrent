// src/keyholder/models.ts — the DKG key-loop contract types (62-17: D-13, D-14,
// D-16, D-19, D-25, D-26). Types only, no runtime imports beyond `Signature`.
//
// These names are LOCKED and consumed verbatim by 62-20 (key release and public
// reconstruction), 62-24 (two-node DKG legs) and 62-26 (Authority keyholder app
// and round driver) — see 62-17-PLAN.md `<interfaces>`.
//
// Private keys, shares and round secrets NEVER enter vote-core or vote-engine
// except as opaque vault bytes (D-16) — nothing in this file, or anywhere
// `src/keyholder/*` imports, assembles or stores a full private key.

import type { Signature } from '../common/index.js'

/** Mirrors the schema's `KeyholderDkgMessage.AttemptValid` bound (`Attempt` is 1..3). */
export const DKG_MAX_ATTEMPTS = 3

/** `KeyholderDkgMessage.DkgRound` (R0 commit .. R4 result). */
export type DkgRound = 0 | 1 | 2 | 3 | 4

/**
 * The lifecycle phase of a revision's DKG. `'failed'` is TERMINAL for the
 * revision — no further attempt is ever started once a revision reaches it
 * (either the 3-attempt cap was spent, or the live roster can never reach
 * `threshold` again).
 */
export type DkgPhase = 'not-started' | 'blocked' | 'in-progress' | 'restarting' | 'complete' | 'failed'

export type DkgBlockedReason = 'no-current-revision' | 'no-keyholders' | 'threshold-out-of-range' | 'pending-invites'
export type DkgWaitingReason = 'awaiting-participants' | 'roster-mismatch'
export type DkgFailedReason = 'attempts-exhausted' | 'threshold-unreachable' | 'election-key-mismatch'
export type DkgAbortReason = 'faults' | 'unresolved-complaint' | 'roster-changed'
export type DkgFaultReason =
  | 'malformed-round0' | 'commit-mismatch' | 'invalid-round1' | 'malformed-round2'
  | 'malformed-round3' | 'invalid-share' | 'undecryptable-share' | 'false-complaint' | 'malformed-complaint'
  | 'round4-mismatch'

export interface DkgDisqualification {
  attempt: number
  userId: string
  reason: DkgFaultReason
  complainantUserId?: string
}

export interface DkgAttemptSummary {
  attempt: number
  roster: string[]
  outcome: 'collecting' | 'aborted' | 'agreed'
  round: DkgRound
  abortReason?: DkgAbortReason
  disqualified: DkgDisqualification[]
  unresolvedComplaints: number
}

export interface ElectionKeyRecord {
  electionId: string
  revision: number
  attempt: number
  jointPublicKey: string
  groupCommitments: string[]
  threshold: number
  participants: number
  publishedAt: string
  publisherUserId: string
}

export interface KeyholderDkgSelfStatus {
  userId: string
  isParticipant: boolean
  isDisqualified: boolean
  hasShare: boolean
}

export interface KeyholderDkgStatus {
  electionId: string
  revision: number | null
  threshold: number | null
  phase: DkgPhase
  blockedReason?: DkgBlockedReason
  waitingReason?: DkgWaitingReason
  failedReason?: DkgFailedReason
  currentAttempt: number | null
  currentRound: DkgRound | null
  roster: string[]
  awaitingUserIds: string[]
  attempts: DkgAttemptSummary[]
  disqualified: DkgDisqualification[]
  electionKey: ElectionKeyRecord | null
  self?: KeyholderDkgSelfStatus
}

export interface KeyholderDkgSigner {
  userId: string
  signingPublicKey: string
  sign: (digest: Uint8Array) => Promise<Signature>
}

export type DkgActionTaken =
  | 'removed-disqualified' | 'posted-round-0' | 'posted-round-1' | 'posted-round-2'
  | 'posted-round-3-ack' | 'posted-round-3-complaint' | 'posted-round-4' | 'published-election-key' | 'cleaned-vault'

export interface DkgAdvanceResult {
  actions: DkgActionTaken[]
  status: KeyholderDkgStatus
}

export interface DkgTranscriptVerdict {
  electionId: string
  revision: number
  rowCount: number
  invalidRows: Array<{ attempt: number, round: number, senderUserId: string }>
  electionKeyConsistent: boolean | null
  status: KeyholderDkgStatus
}
