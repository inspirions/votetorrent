// src/keyholder/types.ts — the DKG engine contract (62-17: D-13, D-15, D-19).
//
// `IKeyholderDkgEngine` is the API 62-20, 62-24 and 62-26 consume verbatim.
// Implemented by `KeyholderDkgEngine` in vote-engine's `src/keyholder/keyholder-dkg-engine.ts`.

import type {
  DkgAdvanceResult,
  DkgTranscriptVerdict,
  ElectionKeyRecord,
  KeyholderDkgSigner,
  KeyholderDkgStatus
} from './models.js'

export interface IKeyholderDkgEngine {
  /** Read-only status for `electionId`'s CURRENT revision. Never writes. */
  getDkgStatus(electionId: string, selfUserId?: string): Promise<KeyholderDkgStatus>
  /**
   * Drive the DKG forward by at most a few rounds of signed strand rows for
   * `signer`'s own participation. Never throws for a self who is not a live
   * keyholder — returns `{ actions: [] }` instead.
   */
  advanceDkg(electionId: string, signer: KeyholderDkgSigner): Promise<DkgAdvanceResult>
  /** The published `ElectionKey` for `electionId`'s `revision` (default: current), or null. */
  getElectionKey(electionId: string, revision?: number): Promise<ElectionKeyRecord | null>
  /** Re-verify every replicated row's signature and payload and re-run the evaluator. */
  verifyDkgTranscript(electionId: string, revision?: number): Promise<DkgTranscriptVerdict>
}
