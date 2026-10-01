// src/keyholder/keyholder-dkg-engine.ts — KeyholderDkgEngine (62-17: D-13,
// D-14, D-16, D-19, D-26). Drives 62-05's split-round FROST DKG through
// 62-02's signed, append-only `KeyholderDkgMessage` strand rows.
//
// ---------------------------------------------------------------------------
// The round table (D-19)
// ---------------------------------------------------------------------------
//
//   R0 (commit)   -- a sha256 hash binding electionId/revision/attempt to the
//                    sender's own round-1 package, so a rushing peer cannot
//                    tailor its R1 after seeing others' (commit-reveal).
//   R1 (reveal)   -- the Feldman commitment vector and Schnorr proof of
//                    knowledge (DkgRound1Wire), checked against its own R0.
//   R2 (shares)   -- EncryptedShare[], one per OTHER roster member, each
//                    encrypted ONLY to that recipient's keyholder-signed
//                    KeyholderDkgBinding.DkgPublicKey (D-26).
//   R3 (ack/complaint) -- every received share is decrypted and verified
//                    before an ack; a bad share is complained with public,
//                    reader-checkable evidence (verifyComplaintEvidence).
//   R4 (result)   -- the agreed joint public key Y and group commitments.
//                    Once every live keyholder's R4 agrees (and none
//                    dissents -- the schema's AllKeyholdersAgree/NoDissent),
//                    `publish` writes the write-once ElectionKey row.
//
// Numbered rules 1-9 (gates, boundary evaluation, roster rule, cap) are
// documented in `dkg-evaluator.ts`'s header; this engine is the DRIVER that
// turns `planDkgAction`'s verdict into one signed row.
//
// ---------------------------------------------------------------------------
// The round-secret alias lifecycle (D-16)
// ---------------------------------------------------------------------------
//
// Step 1 (`keyholderDkgRoundSecretAlias(e, r, a, 1, self)`) holds the
// dealer's own polynomial coefficients plus its UNREVEALED R1 package from
// the moment round 0 is posted until round 2 is posted. Step 2 is written
// BEFORE step 1 is deleted (crash safety -- see `dkg-vault.ts`'s header) and
// itself deleted right after round 4 is posted. `cleanupVault` additionally
// sweeps every attempt's round-secret aliases once that attempt is known
// ABORTED, and the own share alias whenever an attempt aborts with no
// ElectionKey yet published -- so a disqualified or superseded attempt never
// leaves a stale secret behind.
//
// No device ever holds the full election private key: `src/keyholder/*`
// never calls `combineSecret`/`reconstructGroupSecret` (D-16 grep gate).
// Each keyholder ends with exactly one 32-byte signing share, raw, under
// `keyholderDkgShareAlias(electionId, revision, userId)`.
//
// ---------------------------------------------------------------------------
// Biometric-prompt budget
// ---------------------------------------------------------------------------
//
// Each round-step action reads the vault AT MOST once (`getSecret` on the
// round-secret or receiving-key alias) and signs AT MOST once
// (`signer.sign`) -- `KEYHOLDER_DKG_ROUND_SECRET_POLICY`/
// `KEYHOLDER_DKG_RECEIVING_KEY_POLICY`/`KEYHOLDER_SHARE_POLICY` all require
// user auth, so a single `advanceDkg` pass never prompts a keyholder more
// than once per round it actually advances.
//
// ---------------------------------------------------------------------------
// Two-tier residual (T-62-02-13)
// ---------------------------------------------------------------------------
//
// `remove-disqualified` deletes a Keyholder row through a TIER-2 path --
// `Keyholder` carries no `check on delete` (62-02's deliberate deferral).
// Any evidence used is a transcript-proven fault from permanent, insert-only
// rows, the delete is idempotent, and any live participant may run it. A
// raw-handle re-add is re-removed on the next pass (the planner's
// `remove-disqualified` priority runs before any post or publish).
//
// ---------------------------------------------------------------------------
// Specifications cited
// ---------------------------------------------------------------------------
//
// Komlo & Goldberg, "FROST: Flexible Round-Optimized Schnorr Threshold
// Signatures" (SAC 2020) section 5.1 KeyGen; Pedersen, "A Threshold
// Cryptosystem without a Trusted Party" (EUROCRYPT 1991); Gennaro, Jarecki,
// Krawczyk & Rabin, "Secure Distributed Key Generation for Discrete-Log
// Based Cryptosystems" (J. Cryptology 2007) for the Joint-Feldman complaint
// phase this engine implements; 62-05's `src/crypto/dkg.ts` for the RFC 9591
// citations its own primitives rest on.
//
// ---------------------------------------------------------------------------
// Consumer notes (copied from `<interfaces>`)
// ---------------------------------------------------------------------------
//
// 62-26 stores `generateDkgReceivingKey().privateKey` at accept under
// `keyholderDkgReceivingKeyAlias(userId)` with `KEYHOLDER_DKG_RECEIVING_KEY_POLICY`.
// It calls `advanceDkg(electionId, signer)` on keyholder-screen focus and
// maps `DkgPhase` to the four UI states (not-started/blocked -> pending,
// in-progress -> inProgress, restarting -> complaint, complete -> complete).
// `failed` has no UI-SPEC copy (open question, surfaced in the SUMMARY).
// 62-20 reads `getElectionKey()` for Y and the group commitments, and
// unlocks the share from `keyholderDkgShareAlias(electionId, revision, userId)`.
// 62-24 constructs a `KeyholderDkgEngine` on node B and calls
// `verifyDkgTranscript`, re-verifying every replicated row in SQL; its vault
// is never read except through `hasSecret`.

import { MisuseError, QuereusError } from '@quereus/quereus'
import { bytesToHex } from '@noble/hashes/utils.js'
import {
  DKG_MAX_ATTEMPTS,
  type DkgActionTaken,
  type DkgAdvanceResult,
  type DkgRound,
  type DkgTranscriptVerdict,
  type ElectionKeyRecord,
  type IKeyholderDkgEngine,
  type KeyholderDkgSigner,
  type KeyholderDkgStatus
} from '@votetorrent/vote-core'
import type { EngineContext } from '../types.js'
import { allocateTid } from '../database/tid-allocator.js'
import { digestToBytes } from '../utils.js'
import { KEYHOLDER_SHARE_POLICY, KeyVaultError, keyholderDkgReceivingKeyAlias, keyholderDkgShareAlias, type IKeyVault } from '../crypto/vault.js'
import {
  buildComplaintEvidence,
  commitRound1,
  decryptShare,
  deriveGroupCommitments,
  dkgIdentifierForUser,
  dkgRound1,
  dkgRound2,
  dkgRound3,
  encryptShare,
  parseDkgSecret,
  serializeDkgSecret,
  validateReleasedShare,
  verifyDealerShare,
  type ComplaintEvidence,
  type DkgContext,
  type DkgReceivedShare,
  type DkgRound1Wire,
  type EncryptedShare
} from '../crypto/dkg.js'
import {
  parseRound0Payload,
  parseRound1Payload,
  parseRound2Payload,
  serializeRound0Payload,
  serializeRound1Payload,
  serializeRound2Payload,
  serializeRound3Payload,
  serializeRound4Payload
} from './dkg-payloads.js'
import {
  evaluateDkgRevision,
  planDkgAction,
  type DkgMessageRow,
  type DkgPlannedAction,
  type DkgRevisionEvaluation,
  type DkgRevisionSnapshot
} from './dkg-evaluator.js'
import {
  KEYHOLDER_DKG_ROUND_SECRET_POLICY,
  KeyholderDkgError,
  decodeDkgRoundVaultRecord,
  encodeDkgRoundVaultRecord,
  keyholderDkgRoundSecretAlias,
  type DkgRoundVaultRecord,
  type KeyholderDkgErrorCode
} from './dkg-vault.js'

// KeyholderDkgError was defined in dkg-vault.ts (Task 1 needed it before this
// file existed) and is re-exported here so the `<interfaces>`-declared
// import path (`from './keyholder-dkg-engine.js'`) still resolves.
export { KeyholderDkgError, type KeyholderDkgErrorCode }


// ---------------------------------------------------------------------------
// Per-(electionId,userId) advance mutex -- mirrors the per-namespace
// promise-chain idiom in `database/tid-allocator.ts`.
// ---------------------------------------------------------------------------

const advanceLocks = new Map<string, Promise<unknown>>()

async function withAdvanceLock<T> (key: string, fn: () => Promise<T>): Promise<T> {
  const prior = advanceLocks.get(key) ?? Promise.resolve()
  const settled = prior.then(
    () => {},
    () => {}
  )
  const next = settled.then(fn)
  advanceLocks.set(
    key,
    next.then(
      () => {},
      () => {}
    )
  )
  return next
}

function normalizeBool (value: unknown): boolean {
  return value === true || value === 1
}

function collectRoundPayloads<T> (
  snapshot: DkgRevisionSnapshot, attempt: number, round: number, parser: (text: string) => T | null
): Record<string, T> {
  const out: Record<string, T> = {}
  for (const row of snapshot.messages) {
    if (row.attempt === attempt && row.round === round && row.signatureValid) {
      const parsed = parser(row.payload)
      if (parsed !== null) out[row.senderUserId] = parsed
    }
  }
  return out
}

export class KeyholderDkgEngine implements IKeyholderDkgEngine {
  constructor (private readonly ctx: EngineContext, private readonly deps: { vault: IKeyVault }) {}

  // -------------------------------------------------------------------------
  // Snapshot loader -- read-side signature verification (T-62-17-01)
  // -------------------------------------------------------------------------

  private async loadSnapshot (electionId: string, revisionOverride?: number): Promise<DkgRevisionSnapshot> {
    let revision: number | null = null
    let threshold: number | null = null
    if (revisionOverride !== undefined) {
      const row = await this.ctx.db
        .prepare('select KeyholderThreshold from ElectionRevision where ElectionId = :electionId and Revision = :revision')
        .get({ electionId, revision: revisionOverride })
      if (row) {
        revision = revisionOverride
        threshold = row.KeyholderThreshold as number
      }
    } else {
      const row = await this.ctx.db
        .prepare('select Revision, KeyholderThreshold from ElectionRevision where ElectionId = :electionId')
        .get({ electionId })
      if (row) {
        revision = row.Revision as number
        threshold = row.KeyholderThreshold as number
      }
    }

    if (revision === null) {
      return { electionId, revision: null, threshold: null, liveRoster: [], bindings: {}, pendingInviteCount: 0, messages: [], electionKey: null }
    }

    const liveRoster: string[] = []
    for await (const row of this.ctx.db.eval(
      'select UserId from Keyholder where ElectionId = :electionId and ElectionRevision = :revision order by UserId',
      { electionId, revision }
    )) {
      liveRoster.push(row.UserId as string)
    }

    const bindings: Record<string, { dkgPublicKey: string }> = {}
    for await (const row of this.ctx.db.eval(
      'select UserId, DkgPublicKey from KeyholderDkgBinding where ElectionId = :electionId and ElectionRevision = :revision',
      { electionId, revision }
    )) {
      bindings[row.UserId as string] = { dkgPublicKey: row.DkgPublicKey as string }
    }

    const pendingRow = await this.ctx.db
      .prepare(
        `select count(*) as c from InviteSlot S
          where S.Type = 'k' and S.ElectionId = :electionId and S.Expiration > :now
            and not exists (select 1 from InviteResult IR where IR.SlotCid = S.Cid)`
      )
      .get({ electionId, now: new Date().toISOString() })
    const pendingInviteCount = (pendingRow?.c as number | undefined) ?? 0

    const messages: DkgMessageRow[] = []
    for await (const row of this.ctx.db.eval(
      `select Attempt, DkgRound, SenderUserId, Payload, ResultKey,
          (
            (
              SignatureValid(Digest('KeyholderDkgMessage', ElectionId, ElectionRevision, Attempt, DkgRound, SenderUserId, Payload, ResultKey, SentAt), Signature, SenderKey)
                or SignatureValidP256(Digest('KeyholderDkgMessage', ElectionId, ElectionRevision, Attempt, DkgRound, SenderUserId, Payload, ResultKey, SentAt), Signature, SenderKey)
            )
            and exists (select 1 from UserKey K where K.UserId = SenderUserId and K.PubKey = SenderKey)
          ) as SigValid
        from KeyholderDkgMessage
        where ElectionId = :electionId and ElectionRevision = :revision`,
      { electionId, revision }
    )) {
      messages.push({
        attempt: row.Attempt as number,
        round: row.DkgRound as DkgRound,
        senderUserId: row.SenderUserId as string,
        payload: row.Payload as string,
        resultKey: (row.ResultKey as string | null) ?? null,
        signatureValid: normalizeBool(row.SigValid)
      })
    }

    let electionKey: (ElectionKeyRecord & { signatureValid: boolean }) | null = null
    const ekRow = await this.ctx.db
      .prepare(
        `select Attempt, JointPublicKey, GroupCommitments, Threshold, Participants, PublishedAt, PublisherUserId,
            (
              (
                SignatureValid(Digest('ElectionKey', ElectionId, ElectionRevision, Attempt, JointPublicKey, GroupCommitments, Threshold, Participants, PublishedAt, PublisherUserId), Signature, PublisherKey)
                  or SignatureValidP256(Digest('ElectionKey', ElectionId, ElectionRevision, Attempt, JointPublicKey, GroupCommitments, Threshold, Participants, PublishedAt, PublisherUserId), Signature, PublisherKey)
              )
              and exists (select 1 from UserKey K where K.UserId = PublisherUserId and K.PubKey = PublisherKey)
            ) as SigValid
          from ElectionKey where ElectionId = :electionId and ElectionRevision = :revision`
      )
      .get({ electionId, revision })
    if (ekRow) {
      electionKey = {
        electionId,
        revision,
        attempt: ekRow.Attempt as number,
        jointPublicKey: ekRow.JointPublicKey as string,
        groupCommitments: JSON.parse(ekRow.GroupCommitments as string) as string[],
        threshold: ekRow.Threshold as number,
        participants: ekRow.Participants as number,
        publishedAt: ekRow.PublishedAt as string,
        publisherUserId: ekRow.PublisherUserId as string,
        signatureValid: normalizeBool(ekRow.SigValid)
      }
    }

    return { electionId, revision, threshold, liveRoster, bindings, pendingInviteCount, messages, electionKey }
  }

  // -------------------------------------------------------------------------
  // IKeyholderDkgEngine
  // -------------------------------------------------------------------------

  async getDkgStatus (electionId: string, selfUserId?: string): Promise<KeyholderDkgStatus> {
    try {
      const snapshot = await this.loadSnapshot(electionId)
      const evaluation = evaluateDkgRevision(snapshot)
      return await this.buildStatus(electionId, evaluation, selfUserId)
    } catch (err) {
      this.rethrow(err, 'getDkgStatus')
    }
  }

  async getElectionKey (electionId: string, revision?: number): Promise<ElectionKeyRecord | null> {
    try {
      let rev = revision
      if (rev === undefined) {
        const row = await this.ctx.db.prepare('select Revision from ElectionRevision where ElectionId = :electionId').get({ electionId })
        if (!row) return null
        rev = row.Revision as number
      }
      const row = await this.ctx.db
        .prepare(
          `select Attempt, JointPublicKey, GroupCommitments, Threshold, Participants, PublishedAt, PublisherUserId
             from ElectionKey where ElectionId = :electionId and ElectionRevision = :revision`
        )
        .get({ electionId, revision: rev })
      if (!row) return null
      return {
        electionId,
        revision: rev,
        attempt: row.Attempt as number,
        jointPublicKey: row.JointPublicKey as string,
        groupCommitments: JSON.parse(row.GroupCommitments as string) as string[],
        threshold: row.Threshold as number,
        participants: row.Participants as number,
        publishedAt: row.PublishedAt as string,
        publisherUserId: row.PublisherUserId as string
      }
    } catch (err) {
      this.rethrow(err, 'getElectionKey')
    }
  }

  async verifyDkgTranscript (electionId: string, revision?: number): Promise<DkgTranscriptVerdict> {
    try {
      let rev = revision
      if (rev === undefined) {
        const row = await this.ctx.db.prepare('select Revision from ElectionRevision where ElectionId = :electionId').get({ electionId })
        if (!row) throw new KeyholderDkgError('no-current-revision', 'verifyDkgTranscript: no ElectionRevision for electionId')
        rev = row.Revision as number
      }
      const snapshot = await this.loadSnapshot(electionId, rev)
      const evaluation = evaluateDkgRevision(snapshot)
      const status = await this.buildStatus(electionId, evaluation, undefined)
      const rowCountRow = await this.ctx.db
        .prepare('select count(*) as c from KeyholderDkgMessage where ElectionId = :electionId and ElectionRevision = :revision')
        .get({ electionId, revision: rev })
      const electionKeyConsistent = snapshot.electionKey === null ? null : evaluation.phase === 'complete'
      return {
        electionId,
        revision: rev,
        rowCount: (rowCountRow?.c as number | undefined) ?? 0,
        invalidRows: evaluation.invalidRows,
        electionKeyConsistent,
        status
      }
    } catch (err) {
      this.rethrow(err, 'verifyDkgTranscript')
    }
  }

  async advanceDkg (electionId: string, signer: KeyholderDkgSigner): Promise<DkgAdvanceResult> {
    return withAdvanceLock(`${electionId}:${signer.userId}`, async () => {
      try {
        const signerRow = await this.ctx.db
          .prepare('select 1 as x from UserKey where UserId = :userId and PubKey = :pubKey')
          .get({ userId: signer.userId, pubKey: signer.signingPublicKey })
        if (!signerRow) {
          throw new KeyholderDkgError('signer-key-mismatch', 'advanceDkg: signer.signingPublicKey is not a UserKey of signer.userId')
        }

        const quickEvaluation = evaluateDkgRevision(await this.loadSnapshot(electionId))
        if (quickEvaluation.cumulativeDisqualified.includes(signer.userId)) {
          return { actions: [], status: await this.buildStatus(electionId, quickEvaluation, signer.userId) }
        }

        const actions: DkgActionTaken[] = []
        for (let i = 0; i < 8; i++) {
          const snapshot = await this.loadSnapshot(electionId)
          const evaluation = evaluateDkgRevision(snapshot)
          const planned = planDkgAction(evaluation, signer.userId)
          if (planned.kind === 'none') {
            if (await this.cleanupVault(electionId, evaluation, signer)) actions.push('cleaned-vault')
            break
          }
          const taken = await this.executeAction(snapshot, evaluation, planned, signer)
          if (taken !== null) actions.push(taken)
          if (await this.cleanupVault(electionId, evaluation, signer)) actions.push('cleaned-vault')
        }
        const finalStatus = await this.getDkgStatus(electionId, signer.userId)
        return { actions, status: finalStatus }
      } catch (err) {
        this.rethrow(err, 'advanceDkg')
      }
    })
  }

  // -------------------------------------------------------------------------
  // Status assembly
  // -------------------------------------------------------------------------

  private async buildStatus (electionId: string, evaluation: DkgRevisionEvaluation, selfUserId?: string): Promise<KeyholderDkgStatus> {
    const status: KeyholderDkgStatus = {
      electionId: evaluation.electionId,
      revision: evaluation.revision,
      threshold: evaluation.threshold,
      phase: evaluation.phase,
      currentAttempt: evaluation.currentAttempt,
      currentRound: evaluation.currentRound,
      roster: evaluation.roster,
      awaitingUserIds: evaluation.awaitingUserIds,
      attempts: evaluation.attempts,
      disqualified: evaluation.disqualified,
      electionKey: evaluation.electionKey
    }
    if (evaluation.blockedReason !== undefined) status.blockedReason = evaluation.blockedReason
    if (evaluation.waitingReason !== undefined) status.waitingReason = evaluation.waitingReason
    if (evaluation.failedReason !== undefined) status.failedReason = evaluation.failedReason
    if (selfUserId !== undefined) {
      const isDisqualified = evaluation.cumulativeDisqualified.includes(selfUserId)
      const isParticipant = evaluation.roster.includes(selfUserId) && !isDisqualified
      const hasShare = evaluation.revision !== null
        ? await this.deps.vault.hasSecret(keyholderDkgShareAlias(electionId, evaluation.revision, selfUserId))
        : false
      status.self = { userId: selfUserId, isParticipant, isDisqualified, hasShare }
    }
    return status
  }

  // -------------------------------------------------------------------------
  // Action execution
  // -------------------------------------------------------------------------

  private async executeAction (
    snapshot: DkgRevisionSnapshot, evaluation: DkgRevisionEvaluation, planned: DkgPlannedAction, signer: KeyholderDkgSigner
  ): Promise<DkgActionTaken | null> {
    if (planned.kind === 'remove-disqualified') {
      return this.executeRemoveDisqualified(evaluation, planned.userIds)
    }
    if (planned.kind === 'publish') {
      return this.executePublish(evaluation, signer)
    }
    if (planned.kind === 'post-round') {
      switch (planned.round) {
        case 0: return this.executePostRound0(evaluation, signer)
        case 1: return this.executePostRound1(evaluation, signer)
        case 2: return this.executePostRound2(snapshot, evaluation, signer)
        case 3: return this.executePostRound3(snapshot, evaluation, signer)
        case 4: return this.executePostRound4(snapshot, evaluation, signer)
        default: return null
      }
    }
    return null
  }

  private async postMessage (
    electionId: string, revision: number, attempt: number, dkgRound: number,
    resultKey: string | null, payload: string, signer: KeyholderDkgSigner
  ): Promise<void> {
    const sentAt = new Date().toISOString()
    const digestRow = await this.ctx.db
      .prepare(
        "select Digest('KeyholderDkgMessage', :electionId, :revision, :attempt, :dkgRound, :senderUserId, :payload, :resultKey, :sentAt) as d"
      )
      .get({ electionId, revision, attempt, dkgRound, senderUserId: signer.userId, payload, resultKey, sentAt })
    if (!digestRow || digestRow.d == null) {
      throw new Error('KeyholderDkgEngine: Digest() returned null for KeyholderDkgMessage — crypto plugin not registered?')
    }
    const signature = await signer.sign(digestToBytes(digestRow.d as string))
    if (signature.signerKey !== signer.signingPublicKey) {
      throw new KeyholderDkgError('signature-mismatch', 'advanceDkg: sign() returned a signerKey that does not match signer.signingPublicKey')
    }
    await this.ctx.db.exec(
      `insert into KeyholderDkgMessage (ElectionId, ElectionRevision, Attempt, DkgRound, SenderUserId, Payload, ResultKey, SentAt, SenderKey, Signature)
       values (:electionId, :revision, :attempt, :dkgRound, :senderUserId, :payload, :resultKey, :sentAt, :senderKey, :signature)`,
      { electionId, revision, attempt, dkgRound, senderUserId: signer.userId, payload, resultKey, sentAt, senderKey: signature.signerKey, signature: signature.signature }
    )
  }

  private async executeRemoveDisqualified (evaluation: DkgRevisionEvaluation, userIds: string[]): Promise<DkgActionTaken> {
    const electionId = evaluation.electionId
    const revision = evaluation.revision!
    for (const userId of userIds) {
      const tid = await allocateTid(this.ctx.db, 'election')
      await this.ctx.db.exec(
        `delete from Keyholder
           with context SigningNonce = null, InviteSlotCid = null, InviteSignature = null, Tid = ${tid}
           where ElectionId = :electionId and ElectionRevision = :revision and UserId = :userId`,
        { electionId, revision, userId }
      )
    }
    return 'removed-disqualified'
  }

  private async executePostRound0 (evaluation: DkgRevisionEvaluation, signer: KeyholderDkgSigner): Promise<DkgActionTaken> {
    const electionId = evaluation.electionId
    const revision = evaluation.revision!
    const attempt = evaluation.currentAttempt!
    const k = evaluation.threshold!
    const n = evaluation.roster.length
    const dkgCtx: DkgContext = { electionId, revision, attempt }
    const stepAlias1 = keyholderDkgRoundSecretAlias(electionId, revision, attempt, 1, signer.userId)

    let record: DkgRoundVaultRecord
    const existingBytes = await this.deps.vault.getSecret(stepAlias1)
    if (existingBytes !== null) {
      record = decodeDkgRoundVaultRecord(existingBytes)
    } else {
      const { public: pkg, secret } = dkgRound1(dkgIdentifierForUser(signer.userId), k, n)
      const commit = commitRound1(dkgCtx, pkg)
      record = { v: 1, dkgSecret: serializeDkgSecret(secret), round1: pkg, commit }
      await this.deps.vault.putSecret(stepAlias1, encodeDkgRoundVaultRecord(record), KEYHOLDER_DKG_ROUND_SECRET_POLICY)
    }

    const payload = serializeRound0Payload({ v: 1, commit: record.commit, roster: evaluation.roster, threshold: k })
    await this.postMessage(electionId, revision, attempt, 0, null, payload, signer)
    return 'posted-round-0'
  }

  private async executePostRound1 (evaluation: DkgRevisionEvaluation, signer: KeyholderDkgSigner): Promise<DkgActionTaken> {
    const electionId = evaluation.electionId
    const revision = evaluation.revision!
    const attempt = evaluation.currentAttempt!
    const stepAlias1 = keyholderDkgRoundSecretAlias(electionId, revision, attempt, 1, signer.userId)
    const bytes = await this.deps.vault.getSecret(stepAlias1)
    if (bytes === null) {
      throw new KeyholderDkgError('round-secret-missing', 'advanceDkg: round-1 secret record missing for post-round-1')
    }
    const record = decodeDkgRoundVaultRecord(bytes)
    const payload = serializeRound1Payload(record.round1)
    await this.postMessage(electionId, revision, attempt, 1, null, payload, signer)
    return 'posted-round-1'
  }

  private async executePostRound2 (snapshot: DkgRevisionSnapshot, evaluation: DkgRevisionEvaluation, signer: KeyholderDkgSigner): Promise<DkgActionTaken> {
    const electionId = evaluation.electionId
    const revision = evaluation.revision!
    const attempt = evaluation.currentAttempt!
    const dkgCtx: DkgContext = { electionId, revision, attempt }
    const r1ByUser = collectRoundPayloads<DkgRound1Wire>(snapshot, attempt, 1, parseRound1Payload)
    const others = evaluation.roster.filter((u) => u !== signer.userId).map((u) => r1ByUser[u]!)

    const stepAlias1 = keyholderDkgRoundSecretAlias(electionId, revision, attempt, 1, signer.userId)
    const bytes1 = await this.deps.vault.getSecret(stepAlias1)
    if (bytes1 === null) {
      throw new KeyholderDkgError('round-secret-missing', 'advanceDkg: round-1 secret record missing for post-round-2')
    }
    const record1 = decodeDkgRoundVaultRecord(bytes1)
    const secret = parseDkgSecret(record1.dkgSecret)
    const shares = dkgRound2(secret, others)

    const entries: EncryptedShare[] = []
    for (const theirUserId of evaluation.roster) {
      if (theirUserId === signer.userId) continue
      const theirIdentifier = dkgIdentifierForUser(theirUserId)
      const share = shares[theirIdentifier]
      const theirBinding = snapshot.bindings[theirUserId]
      if (share === undefined || theirBinding === undefined) {
        throw new Error(`KeyholderDkgEngine: missing share or binding for recipient ${theirUserId}`)
      }
      entries.push(encryptShare(dkgCtx, dkgIdentifierForUser(signer.userId), theirIdentifier, theirBinding.dkgPublicKey, share))
    }

    const stepAlias2 = keyholderDkgRoundSecretAlias(electionId, revision, attempt, 2, signer.userId)
    if (!(await this.deps.vault.hasSecret(stepAlias2))) {
      const record2: DkgRoundVaultRecord = { v: 1, dkgSecret: serializeDkgSecret(secret), round1: record1.round1, commit: record1.commit }
      await this.deps.vault.putSecret(stepAlias2, encodeDkgRoundVaultRecord(record2), KEYHOLDER_DKG_ROUND_SECRET_POLICY)
    }

    const payload = serializeRound2Payload(entries)
    await this.postMessage(electionId, revision, attempt, 2, null, payload, signer)
    await this.deps.vault.deleteSecret(stepAlias1)
    return 'posted-round-2'
  }

  private async executePostRound3 (snapshot: DkgRevisionSnapshot, evaluation: DkgRevisionEvaluation, signer: KeyholderDkgSigner): Promise<DkgActionTaken> {
    const electionId = evaluation.electionId
    const revision = evaluation.revision!
    const attempt = evaluation.currentAttempt!
    const k = evaluation.threshold!
    const n = evaluation.roster.length
    const dkgCtx: DkgContext = { electionId, revision, attempt }

    const recvAlias = keyholderDkgReceivingKeyAlias(signer.userId)
    const recvBytes = await this.deps.vault.getSecret(recvAlias)
    if (recvBytes === null) {
      throw new KeyholderDkgError('receiving-key-missing', 'advanceDkg: DKG receiving key missing for round-3')
    }

    const r1ByUser = collectRoundPayloads<DkgRound1Wire>(snapshot, attempt, 1, parseRound1Payload)
    const r2ByUser = collectRoundPayloads<EncryptedShare[]>(snapshot, attempt, 2, parseRound2Payload)
    const myIdentifier = dkgIdentifierForUser(signer.userId)
    const complaints: ComplaintEvidence[] = []

    for (const dealerUserId of evaluation.roster) {
      if (dealerUserId === signer.userId) continue
      const dealerR1 = r1ByUser[dealerUserId]
      const enc = r2ByUser[dealerUserId]?.find((e) => e.recipient === myIdentifier)
      if (dealerR1 === undefined || enc === undefined) {
        throw new Error(`KeyholderDkgEngine: missing round-1/round-2 data for dealer ${dealerUserId}`)
      }
      let share: Uint8Array | null = null
      try {
        share = decryptShare(dkgCtx, enc, recvBytes)
      } catch {
        complaints.push(buildComplaintEvidence(enc, recvBytes))
        continue
      }
      if (!verifyDealerShare(k, n, dealerR1, myIdentifier, share)) {
        complaints.push(buildComplaintEvidence(enc, recvBytes))
      }
    }

    const payload = complaints.length > 0
      ? serializeRound3Payload({ v: 1, kind: 'complaint', evidence: complaints })
      : serializeRound3Payload({ v: 1, kind: 'ack' })
    await this.postMessage(electionId, revision, attempt, 3, null, payload, signer)
    return complaints.length > 0 ? 'posted-round-3-complaint' : 'posted-round-3-ack'
  }

  private async executePostRound4 (snapshot: DkgRevisionSnapshot, evaluation: DkgRevisionEvaluation, signer: KeyholderDkgSigner): Promise<DkgActionTaken> {
    const electionId = evaluation.electionId
    const revision = evaluation.revision!
    const attempt = evaluation.currentAttempt!
    const dkgCtx: DkgContext = { electionId, revision, attempt }

    const recvAlias = keyholderDkgReceivingKeyAlias(signer.userId)
    const recvBytes = await this.deps.vault.getSecret(recvAlias)
    if (recvBytes === null) {
      throw new KeyholderDkgError('receiving-key-missing', 'advanceDkg: DKG receiving key missing for round-4')
    }

    const r1ByUser = collectRoundPayloads<DkgRound1Wire>(snapshot, attempt, 1, parseRound1Payload)
    const r2ByUser = collectRoundPayloads<EncryptedShare[]>(snapshot, attempt, 2, parseRound2Payload)
    const myIdentifier = dkgIdentifierForUser(signer.userId)
    const others = evaluation.roster.filter((u) => u !== signer.userId).map((u) => r1ByUser[u]!)
    const received: DkgReceivedShare[] = []
    for (const dealerUserId of evaluation.roster) {
      if (dealerUserId === signer.userId) continue
      const enc = r2ByUser[dealerUserId]?.find((e) => e.recipient === myIdentifier)
      if (enc === undefined) throw new Error(`KeyholderDkgEngine: missing round-2 share from dealer ${dealerUserId}`)
      received.push({ dealer: dkgIdentifierForUser(dealerUserId), share: decryptShare(dkgCtx, enc, recvBytes) })
    }
    const orderedReceived = others.map((pkg) => received.find((r) => r.dealer === pkg.identifier)!)

    const stepAlias2 = keyholderDkgRoundSecretAlias(electionId, revision, attempt, 2, signer.userId)
    const bytes2 = await this.deps.vault.getSecret(stepAlias2)
    if (bytes2 === null) {
      throw new KeyholderDkgError('round-secret-missing', 'advanceDkg: round-2 secret record missing for post-round-4')
    }
    const record2 = decodeDkgRoundVaultRecord(bytes2)
    const secret2 = parseDkgSecret(record2.dkgSecret)
    const material = dkgRound3(secret2, others, orderedReceived)

    const allR1 = evaluation.roster.map((u) => r1ByUser[u]!)
    const derived = deriveGroupCommitments(allR1)
    if (material.groupPublicKey !== derived[0]) {
      throw new Error('KeyholderDkgEngine: dkgRound3 result does not match deriveGroupCommitments over the roster\'s R1 packages')
    }

    const shareAlias = keyholderDkgShareAlias(electionId, revision, signer.userId)
    const existingShareBytes = await this.deps.vault.getSecret(shareAlias)
    if (existingShareBytes !== null) {
      const stillValid = validateReleasedShare(evaluation.threshold!, evaluation.roster.length, material.groupCommitments, {
        identifier: myIdentifier,
        signingShare: bytesToHex(existingShareBytes)
      })
      if (!stillValid) {
        await this.deps.vault.deleteSecret(shareAlias)
        await this.deps.vault.putSecret(shareAlias, material.signingShare, KEYHOLDER_SHARE_POLICY)
      }
    } else {
      await this.deps.vault.putSecret(shareAlias, material.signingShare, KEYHOLDER_SHARE_POLICY)
    }

    const payload = serializeRound4Payload({ groupPublicKey: material.groupPublicKey, groupCommitments: material.groupCommitments })
    await this.postMessage(electionId, revision, attempt, 4, material.groupPublicKey, payload, signer)
    await this.deps.vault.deleteSecret(stepAlias2)
    return 'posted-round-4'
  }

  private async executePublish (evaluation: DkgRevisionEvaluation, signer: KeyholderDkgSigner): Promise<DkgActionTaken | null> {
    const electionId = evaluation.electionId
    const revision = evaluation.revision!
    const pub = evaluation.readyToPublish!

    const existing = await this.ctx.db
      .prepare('select Attempt, JointPublicKey from ElectionKey where ElectionId = :electionId and ElectionRevision = :revision')
      .get({ electionId, revision })
    if (existing) return null

    const publishedAt = new Date().toISOString()
    const groupCommitmentsJson = JSON.stringify(pub.groupCommitments)
    const threshold = evaluation.threshold!
    const participants = pub.roster.length

    const digestRow = await this.ctx.db
      .prepare(
        "select Digest('ElectionKey', :electionId, :revision, :attempt, :jointPublicKey, :groupCommitments, :threshold, :participants, :publishedAt, :publisherUserId) as d"
      )
      .get({
        electionId, revision, attempt: pub.attempt, jointPublicKey: pub.jointPublicKey,
        groupCommitments: groupCommitmentsJson, threshold, participants, publishedAt, publisherUserId: signer.userId
      })
    if (!digestRow || digestRow.d == null) {
      throw new Error('KeyholderDkgEngine: Digest() returned null for ElectionKey — crypto plugin not registered?')
    }
    const signature = await signer.sign(digestToBytes(digestRow.d as string))
    if (signature.signerKey !== signer.signingPublicKey) {
      throw new KeyholderDkgError('signature-mismatch', 'advanceDkg: sign() returned a signerKey that does not match signer.signingPublicKey while publishing ElectionKey')
    }

    try {
      await this.ctx.db.exec(
        `insert into ElectionKey (ElectionId, ElectionRevision, Attempt, JointPublicKey, GroupCommitments, Threshold, Participants, PublishedAt, PublisherUserId, PublisherKey, Signature)
         values (:electionId, :revision, :attempt, :jointPublicKey, :groupCommitments, :threshold, :participants, :publishedAt, :publisherUserId, :publisherKey, :signature)`,
        {
          electionId, revision, attempt: pub.attempt, jointPublicKey: pub.jointPublicKey, groupCommitments: groupCommitmentsJson,
          threshold, participants, publishedAt, publisherUserId: signer.userId, publisherKey: signature.signerKey, signature: signature.signature
        }
      )
    } catch (err) {
      const reread = await this.ctx.db
        .prepare('select Attempt, JointPublicKey from ElectionKey where ElectionId = :electionId and ElectionRevision = :revision')
        .get({ electionId, revision })
      if (reread && reread.Attempt === pub.attempt && reread.JointPublicKey === pub.jointPublicKey) {
        return 'published-election-key'
      }
      throw err
    }
    return 'published-election-key'
  }

  // -------------------------------------------------------------------------
  // Vault hygiene
  // -------------------------------------------------------------------------

  private async cleanupVault (electionId: string, evaluation: DkgRevisionEvaluation, signer: KeyholderDkgSigner): Promise<boolean> {
    if (evaluation.revision === null) return false
    const revision = evaluation.revision
    let didSomething = false

    const attemptsToClean = new Set<number>()
    for (const a of evaluation.attempts) {
      if (a.outcome === 'aborted') attemptsToClean.add(a.attempt)
    }
    if (evaluation.phase === 'complete') {
      for (let a = 1; a <= DKG_MAX_ATTEMPTS; a++) attemptsToClean.add(a)
    }
    for (const attempt of attemptsToClean) {
      for (const step of [1, 2] as const) {
        const alias = keyholderDkgRoundSecretAlias(electionId, revision, attempt, step, signer.userId)
        if (await this.deps.vault.deleteSecret(alias)) didSomething = true
      }
    }

    const hadAbortedAttempt = evaluation.attempts.some((a) => a.outcome === 'aborted')
    if (hadAbortedAttempt && evaluation.electionKey === null) {
      const shareAlias = keyholderDkgShareAlias(electionId, revision, signer.userId)
      if (await this.deps.vault.deleteSecret(shareAlias)) didSomething = true
    }

    return didSomething
  }

  // -------------------------------------------------------------------------
  // Error wrapping
  // -------------------------------------------------------------------------

  private rethrow (err: unknown, method: string): never {
    if (err instanceof KeyholderDkgError) throw err
    if (err instanceof KeyVaultError) throw err
    if (err instanceof QuereusError) throw new Error(`Quereus error (code ${err.code}): ${err.message}`)
    if (err instanceof MisuseError) throw new Error(`API misuse: ${err.message}`)
    if (err instanceof Error) throw new Error(`KeyholderDkgEngine.${method}: ${err.message}`)
    throw new Error(`KeyholderDkgEngine.${method}: unknown error: ${String(err)}`)
  }
}
