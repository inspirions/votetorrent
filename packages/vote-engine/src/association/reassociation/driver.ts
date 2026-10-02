/**
 * driver.ts — 62-18 Task 3 (D-40, D-41, D-45, D-46).
 *
 * Free functions over a `ReassociationHost` — the bound-private-method seam `AssociationEngine`
 * builds (`reassociationHost()`), so this module never duplicates `prepareAssociation`,
 * `commitPreparedAssociation`, the transition helpers, or the synthetic-rejection machinery Task
 * 2 already proved. `AssociationEngine` is the ONLY production implementor; `driver.ts` itself
 * never imports `association-engine.ts`.
 *
 * No write (no db-exec call of any kind), and no console output anywhere in this module — every
 * mutation runs through a host method (whose own file already carries the write-time ceremony and
 * ANY logging it needs); a row this driver cannot safely resolve is simply left where it is, for a
 * later sync.
 */

import type { Database } from '@quereus/quereus'
import {
  REASSOCIATION_NOT_APPROVED_REASON,
  REASSOCIATION_REJECTION_NONCE_PREFIX,
  REASSOCIATION_UNRESOLVED_REGISTRANT_ID,
  ReassociationError
} from '@votetorrent/vote-core'
import type {
  Association,
  AssociationAttestationAnswer,
  AssociationIdentityField,
  AssociationMatchMethod,
  AssociationRequestStatus,
  AttestationChallenge,
  DeviceAttestation,
  DeviceRetirement,
  ReassociationApprovalInput,
  ReassociationApprovalResult,
  ReassociationDecisionSource,
  ReassociationEvidence,
  ReassociationIntake,
  ReassociationOpener,
  ReassociationProcessingSummary,
  ReassociationRejectionResult,
  ReassociationReview,
  ReassociationRouteKind,
  ReassociationSignatureOrCallback
} from '@votetorrent/vote-core'
import { intakeQueryPortFromDb, readIntakePolicyFrom, reassociationRouteFor } from '../../intake/index.js'
import { readAuthorityThreshold } from '../../signing/threshold.js'
import type { EngineContext } from '../../types.js'
import { asText } from '../../utils.js'
import {
  identityRecordOf,
  listApprovedRegistrations,
  rankIdentityCandidates,
  resolveRegistrantByCode,
  verifyRegistrationCode
} from './evidence.js'
import type { ApprovedRegistrationsRead, OpenedCode } from './evidence.js'

/** The staged-answer shape `validateStagedAttestationAnswer` returns — duplicated structurally
 * (not imported) because `association-engine.ts`'s own copy is intentionally engine-internal. */
interface ValidatedAnswer {
  readonly id: string
  readonly authorityId: string
  readonly registrantId: string
  readonly deviceKey: string
  readonly electionId?: string
  readonly status: AssociationRequestStatus
  readonly challengeNonce?: string
}

/**
 * The bound-private-method seam `AssociationEngine.reassociationHost()` builds. `prepared` is
 * deliberately `unknown` here — this module never inspects it, only threads it from
 * `prepareAssociation` to `commitPreparedAssociation`, both of which are the SAME engine-internal
 * `PreparedAssociation` shape on the real implementor.
 */
export interface ReassociationHost {
  readonly ctx: EngineContext
  prepareAssociation (
    init: { registrantId: string; deviceKey: string; deviceHash?: string; nonce: string; attestation: DeviceAttestation },
    options?: { registrantIdForChallenge?: string }
  ): Promise<unknown>
  commitPreparedAssociation (
    prepared: unknown,
    signatureOrCallback: ReassociationSignatureOrCallback,
    revoke?: { registrantId: string; deviceKeys: readonly string[] }
  ): Promise<void>
  issueAttestationChallenge (
    registrantId: string,
    deviceKey: string,
    signatureOrCallback: ReassociationSignatureOrCallback,
    electionId?: string
  ): Promise<AttestationChallenge>
  validateStagedAttestationAnswer (
    answer: AssociationAttestationAnswer,
    requesterKey: string,
    signatureOrCallback: ReassociationSignatureOrCallback
  ): Promise<ValidatedAnswer>
  writeChallengeTransition (
    requestId: string,
    authorityId: string,
    challengeNonce: string,
    signatureOrCallback: ReassociationSignatureOrCallback
  ): Promise<void>
  writeTerminalTransition (
    requestId: string,
    authorityId: string,
    status: 'a' | 'r',
    rejectionReason: string | null,
    signatureOrCallback: ReassociationSignatureOrCallback
  ): Promise<string>
  rejectPendingRequest (
    row: { id: string; authorityId: string; registrantId: string; deviceKey: string },
    reasonCode: string,
    signatureOrCallback: ReassociationSignatureOrCallback,
    intake: { publishDecision (decision: { requestId: string; status: AssociationRequestStatus; reason?: string; decidedAt: string }): Promise<string> }
  ): Promise<void>
  completeInterruptedRejections (
    authorityId: string,
    signatureOrCallback: ReassociationSignatureOrCallback,
    intake: { publishDecision (decision: { requestId: string; status: AssociationRequestStatus; reason?: string; decidedAt: string }): Promise<string> }
  ): Promise<number>
  getAssociation (registrantId: string, deviceKey: string): Promise<Association | undefined>
  getAssociations (registrantId: string): Promise<Association[]>
  getAssociationsByDeviceKey (deviceKey: string): Promise<Association[]>
}

interface SentinelRequestRow {
  readonly id: string
  readonly authorityId: string
  readonly registrantId: string
  readonly deviceKey: string
  readonly electionId?: string
  readonly submittedAt: string
  readonly receivedAt: string
  readonly status: AssociationRequestStatus
}

async function loadRequestRow (db: Database, requestId: string): Promise<SentinelRequestRow | undefined> {
  const row = await db
    .prepare('select Id, AuthorityId, RegistrantId, DeviceKey, ElectionId, SubmittedAt, ReceivedAt, Status from AssociationRequest where Id = :requestId')
    .get({ requestId })
  if (!row) return undefined
  return {
    id: asText(row.Id, 'AssociationRequest.Id'),
    authorityId: asText(row.AuthorityId, 'AssociationRequest.AuthorityId'),
    registrantId: asText(row.RegistrantId, 'AssociationRequest.RegistrantId'),
    deviceKey: asText(row.DeviceKey, 'AssociationRequest.DeviceKey'),
    electionId: row.ElectionId == null ? undefined : asText(row.ElectionId, 'AssociationRequest.ElectionId'),
    submittedAt: reZulu(asText(row.SubmittedAt, 'AssociationRequest.SubmittedAt')),
    receivedAt: reZulu(asText(row.ReceivedAt, 'AssociationRequest.ReceivedAt')),
    status: asText(row.Status, 'AssociationRequest.Status') as AssociationRequestStatus
  }
}

/** Local copy of the project's Z-stripped-read-back re-stamp (mirrors `ceremony-helpers.ts`'s
 * `reZuluDatetime` — not imported, to keep this module's import graph free of the full
 * ceremony-helpers surface for a one-line transform). */
function reZulu (stored: string): string {
  return stored.endsWith('Z') ? stored : `${stored}Z`
}

type RawEvidence =
  | { readonly kind: 'code'; readonly code: string }
  | { readonly kind: 'identity'; readonly fields: readonly AssociationIdentityField[] }
  | { readonly kind: 'none' }

/** Reads `requestId`'s own staged request (via `intake.readStagedRequests()`) and classifies it:
 * a non-empty `registrationCode` is code evidence, else a non-empty `identityFields` is identity
 * evidence, else (including "not found") no evidence. */
async function rawEvidenceFor (requestId: string, intake: ReassociationIntake): Promise<RawEvidence> {
  const staged = await intake.readStagedRequests()
  const row = staged.find((r) => r.requestId === requestId)
  if (row === undefined) return { kind: 'none' }
  if (typeof row.registrationCode === 'string' && row.registrationCode.length > 0) {
    return { kind: 'code', code: row.registrationCode }
  }
  if (row.identityFields !== undefined && row.identityFields.length > 0) {
    return { kind: 'identity', fields: row.identityFields }
  }
  return { kind: 'none' }
}

/**
 * Builds the officer review for one sentinel `AssociationRequest` row. `approved`/`codeCache` are
 * supplied by the caller (one scan + one opened-code cache per PUBLIC call — never cached across
 * calls, T-62-01-10).
 */
async function buildReview (
  host: ReassociationHost,
  authorityId: string,
  row: { id: string; deviceKey: string; electionId?: string; submittedAt: string; receivedAt: string; status: AssociationRequestStatus },
  intake: ReassociationIntake,
  opener: ReassociationOpener,
  approved: ApprovedRegistrationsRead,
  codeCache: Map<string, OpenedCode>,
  options?: { readonly registrantId?: string }
): Promise<ReassociationReview> {
  const raw = await rawEvidenceFor(row.id, intake)

  let evidence: ReassociationEvidence
  let resolvedRegistrantId: string | undefined
  let candidates: ReassociationCandidateList = []
  let matchMethod: AssociationMatchMethod = 'identity'

  if (raw.kind === 'code') {
    const resolved = await resolveRegistrantByCode(host.ctx.db, opener, raw.code, approved, codeCache)
    evidence = { kind: 'code', outcome: resolved.outcome }
    if (resolved.outcome === 'matched') {
      resolvedRegistrantId = resolved.registrantId
      matchMethod = 'code'
    }
  } else if (raw.kind === 'identity') {
    evidence = { kind: 'identity', fields: raw.fields }
    candidates = rankIdentityCandidates(raw.fields, approved)
    resolvedRegistrantId = options?.registrantId
  } else {
    evidence = { kind: 'none' }
  }

  const policy = await readIntakePolicyFrom(intakeQueryPortFromDb(host.ctx.db), authorityId)
  const route: ReassociationRouteKind = reassociationRouteFor(policy, matchMethod)

  let existingDevices: Association[] = []
  let registrantRecord: AssociationIdentityField[] | undefined
  let registrantName: string | undefined
  if (resolvedRegistrantId !== undefined) {
    existingDevices = await host.getAssociations(resolvedRegistrantId)
    const reg = approved.registrations.find((a) => a.registrantId === resolvedRegistrantId)
    if (reg !== undefined) {
      registrantRecord = identityRecordOf(reg.payload)
      const nameParts = [reg.payload.public?.firstName, reg.payload.public?.lastName].filter((x): x is string => typeof x === 'string')
      registrantName = nameParts.length > 0 ? nameParts.join(' ') : undefined
    }
  }

  return {
    requestId: row.id,
    authorityId,
    status: row.status,
    newDeviceKey: row.deviceKey,
    electionId: row.electionId,
    submittedAt: row.submittedAt,
    receivedAt: row.receivedAt,
    evidence,
    resolvedRegistrantId,
    registrantName,
    registrantRecord,
    candidates,
    existingDevices,
    matchMethod,
    route
  }
}

// Avoids importing ReassociationCandidate purely for a local alias cycle concern; re-declared via
// the review type's own field instead.
type ReassociationCandidateList = ReassociationReview['candidates']

/** Every `'p'` sentinel-registrant row of `authorityId`, newest `submittedAt` first. */
export async function listPendingReassociations (
  host: ReassociationHost,
  authorityId: string,
  intake: ReassociationIntake,
  opener: ReassociationOpener
): Promise<ReassociationReview[]> {
  const rows: SentinelRequestRow[] = []
  for await (const row of host.ctx.db.eval(
    "select Id, AuthorityId, RegistrantId, DeviceKey, ElectionId, SubmittedAt, ReceivedAt, Status from AssociationRequest where AuthorityId = :rowAuthorityId and RegistrantId = :sentinel and Status = 'p' order by SubmittedAt desc",
    { rowAuthorityId: authorityId, sentinel: REASSOCIATION_UNRESOLVED_REGISTRANT_ID }
  )) {
    rows.push({
      id: asText(row.Id, 'AssociationRequest.Id'),
      authorityId: asText(row.AuthorityId, 'AssociationRequest.AuthorityId'),
      registrantId: asText(row.RegistrantId, 'AssociationRequest.RegistrantId'),
      deviceKey: asText(row.DeviceKey, 'AssociationRequest.DeviceKey'),
      electionId: row.ElectionId == null ? undefined : asText(row.ElectionId, 'AssociationRequest.ElectionId'),
      submittedAt: reZulu(asText(row.SubmittedAt, 'AssociationRequest.SubmittedAt')),
      receivedAt: reZulu(asText(row.ReceivedAt, 'AssociationRequest.ReceivedAt')),
      status: asText(row.Status, 'AssociationRequest.Status') as AssociationRequestStatus
    })
  }

  const approved = await listApprovedRegistrations(host.ctx.db, authorityId, opener)
  const codeCache = new Map<string, OpenedCode>()
  const out: ReassociationReview[] = []
  for (const row of rows) {
    out.push(await buildReview(host, authorityId, row, intake, opener, approved, codeCache))
  }
  return out
}

export async function getReassociationReview (
  host: ReassociationHost,
  requestId: string,
  intake: ReassociationIntake,
  opener: ReassociationOpener,
  options?: { readonly registrantId?: string }
): Promise<ReassociationReview | undefined> {
  const row = await loadRequestRow(host.ctx.db, requestId)
  if (row === undefined || row.registrantId !== REASSOCIATION_UNRESOLVED_REGISTRANT_ID) return undefined

  const approved = await listApprovedRegistrations(host.ctx.db, row.authorityId, opener)
  const codeCache = new Map<string, OpenedCode>()
  return buildReview(host, row.authorityId, row, intake, opener, approved, codeCache, options)
}

/** R0/R1/R2 — the automatic authority-side re-association sync driver (D-41, D-46). */
export async function processPendingReassociations (
  host: ReassociationHost,
  authorityId: string,
  signatureOrCallback: ReassociationSignatureOrCallback,
  intake: ReassociationIntake,
  opener: ReassociationOpener
): Promise<ReassociationProcessingSummary> {
  // R0 — finish any interrupted synthetic rejection first (idempotent).
  const interruptedCompleted = await host.completeInterruptedRejections(authorityId, signatureOrCallback, intake)

  let challengesIssued = 0
  let associated = 0
  let rejected = interruptedCompleted
  let awaitingReview = 0

  // R1 — resolution + D-46 routing for every sentinel 'p' row.
  const pendingRows: SentinelRequestRow[] = []
  for await (const row of host.ctx.db.eval(
    "select Id, AuthorityId, RegistrantId, DeviceKey, ElectionId, SubmittedAt, ReceivedAt, Status from AssociationRequest where AuthorityId = :rowAuthorityId and RegistrantId = :sentinel and Status = 'p'",
    { rowAuthorityId: authorityId, sentinel: REASSOCIATION_UNRESOLVED_REGISTRANT_ID }
  )) {
    pendingRows.push({
      id: asText(row.Id, 'AssociationRequest.Id'),
      authorityId: asText(row.AuthorityId, 'AssociationRequest.AuthorityId'),
      registrantId: asText(row.RegistrantId, 'AssociationRequest.RegistrantId'),
      deviceKey: asText(row.DeviceKey, 'AssociationRequest.DeviceKey'),
      electionId: row.ElectionId == null ? undefined : asText(row.ElectionId, 'AssociationRequest.ElectionId'),
      submittedAt: reZulu(asText(row.SubmittedAt, 'AssociationRequest.SubmittedAt')),
      receivedAt: reZulu(asText(row.ReceivedAt, 'AssociationRequest.ReceivedAt')),
      status: asText(row.Status, 'AssociationRequest.Status') as AssociationRequestStatus
    })
  }

  const r1Approved = await listApprovedRegistrations(host.ctx.db, authorityId, opener)
  const r1CodeCache = new Map<string, OpenedCode>()

  for (const row of pendingRows) {
    try {
      const review = await buildReview(host, authorityId, row, intake, opener, r1Approved, r1CodeCache)
      if (review.route === 'automatic' && review.matchMethod === 'code' && review.resolvedRegistrantId !== undefined) {
        const challenge = await host.issueAttestationChallenge(review.resolvedRegistrantId, row.deviceKey, signatureOrCallback, row.electionId)
        await host.writeChallengeTransition(row.id, authorityId, challenge.nonce, signatureOrCallback)
        await intake.publishDecision({ requestId: row.id, status: 'c', challengeNonce: challenge.nonce, decidedAt: new Date().toISOString() })
        challengesIssued++
      } else {
        awaitingReview++
      }
    } catch {
      // Per-row isolation — one bad row never stalls the batch. Left 'p' for a later sync.
      continue
    }
  }

  // R2 — compound completion for every staged attestation whose sentinel 'c' row is ours.
  const stagedAnswers = await intake.readStagedAttestations()
  for (const doc of stagedAnswers) {
    const rowC = await host.ctx.db
      .prepare(
        "select Id, RegistrantId, ChallengeNonce from AssociationRequest where Id = :id and AuthorityId = :rowAuthorityId and Status = 'c'"
      )
      .get({ id: doc.requestId, rowAuthorityId: authorityId })
    if (!rowC) continue

    const rowCRegistrantId = asText(rowC.RegistrantId, 'AssociationRequest.RegistrantId')
    if (rowCRegistrantId !== REASSOCIATION_UNRESOLVED_REGISTRANT_ID) continue
    const challengeNonce = rowC.ChallengeNonce == null ? undefined : asText(rowC.ChallengeNonce, 'AssociationRequest.ChallengeNonce')
    if (challengeNonce === undefined || challengeNonce.startsWith(REASSOCIATION_REJECTION_NONCE_PREFIX)) continue

    try {
      let validated: { registrantId: string; deviceKey: string }
      try {
        const loaded = await host.validateStagedAttestationAnswer(doc.answer, doc.requesterKey, doc.signature)
        validated = { registrantId: loaded.registrantId, deviceKey: loaded.deviceKey }
      } catch {
        // CR-05 envelope skip — not a decision.
        continue
      }

      const challengeRow = await host.ctx.db
        .prepare('select RegistrantId from AttestationChallenge where Nonce = :nonce')
        .get({ nonce: challengeNonce })

      let registrantId: string
      if (!challengeRow) {
        const alreadyAssociated = await host.getAssociationsByDeviceKey(validated.deviceKey)
        if (alreadyAssociated.length === 0) continue
        registrantId = alreadyAssociated[0]!.registrantId
      } else {
        registrantId = asText(challengeRow.RegistrantId, 'AttestationChallenge.RegistrantId')
      }

      const existingForRegistrant = await host.getAssociations(registrantId)
      const devicesToRetire = existingForRegistrant
        .map((a) => a.deviceKey)
        .filter((k) => k !== validated.deviceKey)
        .sort()

      const raw = await rawEvidenceFor(doc.requestId, intake)
      let matchMethod: AssociationMatchMethod = 'identity'
      if (raw.kind === 'code') {
        const r2Approved = await listApprovedRegistrations(host.ctx.db, authorityId, opener)
        const r2CodeCache = new Map<string, OpenedCode>()
        const verdict = await verifyRegistrationCode(host.ctx.db, opener, raw.code, registrantId, r2Approved, r2CodeCache)
        matchMethod = verdict === 'matched' ? 'code' : 'identity'
      }

      let prepared: unknown
      try {
        prepared = await host.prepareAssociation({
          registrantId,
          deviceKey: validated.deviceKey,
          deviceHash: doc.answer.deviceHash,
          nonce: challengeNonce,
          attestation: doc.answer.attestation
        })
      } catch {
        const decidedAt = await host.writeTerminalTransition(doc.requestId, authorityId, 'r', 'attestation-verification-failed', signatureOrCallback)
        await intake.publishDecision({ requestId: doc.requestId, status: 'r', reason: 'attestation-verification-failed', decidedAt })
        rejected++
        continue
      }

      try {
        await host.commitPreparedAssociation(prepared, signatureOrCallback, { registrantId, deviceKeys: devicesToRetire })
      } catch {
        const stillAssociated = await host.getAssociation(registrantId, validated.deviceKey)
        if (stillAssociated === undefined) continue
        // The write landed; the post-commit challenge consumption failed (WR-05 analog) — decide
        // 'a' below, same as the existing driver's own documented recovery.
      }

      const decidedAt = await host.writeTerminalTransition(doc.requestId, authorityId, 'a', null, signatureOrCallback)
      await intake.publishDecision({
        requestId: doc.requestId,
        status: 'a',
        decidedAt,
        revokesDeviceKey: devicesToRetire[0],
        matchMethod
      })
      associated++
    } catch {
      continue
    }
  }

  return { challengesIssued, associated, rejected, awaitingReview }
}

/** Officer approval — every check runs before the first write. */
export async function approveReassociation (
  host: ReassociationHost,
  requestId: string,
  input: ReassociationApprovalInput,
  signatureOrCallback: ReassociationSignatureOrCallback,
  intake: ReassociationIntake,
  opener: ReassociationOpener
): Promise<ReassociationApprovalResult> {
  if (typeof input.registrantId !== 'string' || input.registrantId.length === 0) {
    throw new ReassociationError('invalid-argument', 'approveReassociation: input.registrantId must be a non-empty string')
  }

  const row = await loadRequestRow(host.ctx.db, requestId)
  if (row === undefined) throw new ReassociationError('not-found', `approveReassociation: no AssociationRequest for requestId=${requestId}`)
  if (row.registrantId !== REASSOCIATION_UNRESOLVED_REGISTRANT_ID) {
    throw new ReassociationError('not-a-reassociation', `approveReassociation: requestId=${requestId} is not a re-association request`)
  }
  if (row.status !== 'p') {
    throw new ReassociationError('not-pending', `approveReassociation: requestId=${requestId} is not pending`)
  }

  const registrantRow = await host.ctx.db
    .prepare('select AuthorityId, Status from Registrant where Id = :registrantId')
    .get({ registrantId: input.registrantId })
  if (!registrantRow || asText(registrantRow.Status, 'Registrant.Status') !== 'a') {
    throw new ReassociationError('registrant-not-active', `approveReassociation: registrantId=${input.registrantId} is not an active registrant`)
  }
  if (asText(registrantRow.AuthorityId, 'Registrant.AuthorityId') !== row.authorityId) {
    throw new ReassociationError('registrant-authority-mismatch', `approveReassociation: registrantId=${input.registrantId} belongs to a different authority than requestId=${requestId}`)
  }

  const threshold = await readAuthorityThreshold(host.ctx.db, row.authorityId, 'vrg')
  if (threshold > 1) {
    throw new ReassociationError('threshold-requires-co-sign', `approveReassociation: 'vrg' threshold at authority ${row.authorityId} is above 1`)
  }

  const raw = await rawEvidenceFor(requestId, intake)
  let matchMethod: AssociationMatchMethod = 'identity'
  if (raw.kind === 'code') {
    const approved = await listApprovedRegistrations(host.ctx.db, row.authorityId, opener)
    const codeCache = new Map<string, OpenedCode>()
    const resolved = await resolveRegistrantByCode(host.ctx.db, opener, raw.code, approved, codeCache)
    if (resolved.outcome === 'matched') {
      if (resolved.registrantId !== input.registrantId) {
        throw new ReassociationError('code-registrant-mismatch', `approveReassociation: the staged code matched a different registrant than ${input.registrantId}`)
      }
      matchMethod = 'code'
    }
  }

  const existingDevices = await host.getAssociations(input.registrantId)
  const devicesToRetire = existingDevices.map((a) => a.deviceKey).sort()

  const challenge = await host.issueAttestationChallenge(input.registrantId, row.deviceKey, signatureOrCallback, row.electionId)
  await host.writeChallengeTransition(requestId, row.authorityId, challenge.nonce, signatureOrCallback)
  await intake.publishDecision({ requestId, status: 'c', challengeNonce: challenge.nonce, decidedAt: new Date().toISOString() })

  return {
    requestId,
    registrantId: input.registrantId,
    matchMethod,
    devicesToRetire,
    challengeNonce: challenge.nonce,
    outcome: 'awaiting-device-attestation'
  }
}

/** Officer rejection — the same row checks as approval, then the synthetic `'p'->'c'->'r'`. */
export async function rejectReassociation (
  host: ReassociationHost,
  requestId: string,
  signatureOrCallback: ReassociationSignatureOrCallback,
  intake: ReassociationIntake
): Promise<ReassociationRejectionResult> {
  const row = await loadRequestRow(host.ctx.db, requestId)
  if (row === undefined) throw new ReassociationError('not-found', `rejectReassociation: no AssociationRequest for requestId=${requestId}`)
  if (row.registrantId !== REASSOCIATION_UNRESOLVED_REGISTRANT_ID) {
    throw new ReassociationError('not-a-reassociation', `rejectReassociation: requestId=${requestId} is not a re-association request`)
  }
  if (row.status !== 'p') {
    throw new ReassociationError('not-pending', `rejectReassociation: requestId=${requestId} is not pending`)
  }

  const threshold = await readAuthorityThreshold(host.ctx.db, row.authorityId, 'vrg')
  if (threshold > 1) {
    throw new ReassociationError('threshold-requires-co-sign', `rejectReassociation: 'vrg' threshold at authority ${row.authorityId} is above 1`)
  }

  await host.rejectPendingRequest(
    { id: row.id, authorityId: row.authorityId, registrantId: row.registrantId, deviceKey: row.deviceKey },
    REASSOCIATION_NOT_APPROVED_REASON,
    signatureOrCallback,
    intake
  )
  return { requestId, reason: REASSOCIATION_NOT_APPROVED_REASON }
}

/** The old device's own read: retired iff an `'a'` decision names `deviceKey` in
 * `RevokesDeviceKey` AND no `Association` row still carries that key. */
export async function getDeviceRetirement (
  host: ReassociationHost,
  deviceKey: string,
  source?: ReassociationDecisionSource
): Promise<DeviceRetirement | undefined> {
  const stillAssociated = await host.ctx.db
    .prepare('select 1 as x from Association where DeviceKey = :deviceKey limit 1')
    .get({ deviceKey })
  if (stillAssociated) return undefined

  if (source !== undefined) {
    const records = await source.readDecisionRecords()
    const matches = records.filter((r) => r.status === 'a' && r.revokesDeviceKey === deviceKey)
    if (matches.length === 0) return undefined
    const earliest = matches.reduce((a, b) => (Date.parse(a.decidedAt) <= Date.parse(b.decidedAt) ? a : b))
    return { deviceKey, requestId: earliest.requestId, decidedAt: earliest.decidedAt }
  }

  const row = await host.ctx.db
    .prepare("select RequestId, DecidedAt from AssociationDecision where RevokesDeviceKey = :deviceKey and Status = 'a' order by DecidedAt asc limit 1")
    .get({ deviceKey })
  if (!row) return undefined
  return {
    deviceKey,
    requestId: asText(row.RequestId, 'AssociationDecision.RequestId'),
    decidedAt: reZulu(asText(row.DecidedAt, 'AssociationDecision.DecidedAt'))
  }
}

/**
 * The `RequesterKey` of the approved registration for `registrantId` — the only key whose
 * derived code would match — or `undefined` when none is resolvable.
 *
 * Used by the Voter's code-availability read (`continuity.ts`, through `IReassociationEngine`,
 * which declares NO opener parameter here). It reads only cleartext columns, so it works for
 * D-49-sealed rows: the Voter's own registration shape has a request id equal to the registrant
 * id, and `RegistrationRequest.RequesterKey` is cleartext (V-5). A request whose id differs from
 * the registrant id AND whose payload is sealed cannot be resolved without an opener and returns
 * `undefined`; a legacy unsealed row is still resolved through the fallback scan below.
 */
export async function getRegistrationCodeHolderKey (host: ReassociationHost, registrantId: string): Promise<string | undefined> {
  const registrantRow = await host.ctx.db
    .prepare("select AuthorityId from Registrant where Id = :registrantId and Status = 'a'")
    .get({ registrantId })
  if (!registrantRow) return undefined
  const authorityId = asText(registrantRow.AuthorityId, 'Registrant.AuthorityId')

  const direct = await host.ctx.db
    .prepare("select RequesterKey from RegistrationRequest where Id = :registrantId and AuthorityId = :authorityId and Status = 'a'")
    .get({ registrantId, authorityId })
  if (direct) return asText(direct.RequesterKey, 'RegistrationRequest.RequesterKey')

  // Legacy fallback: an unsealed approved row whose request id differs from the registrant id.
  const approved = await listApprovedRegistrations(host.ctx.db, authorityId)
  const reg = approved.registrations.find((a) => a.registrantId === registrantId)
  if (reg === undefined) return undefined

  const row = await host.ctx.db
    .prepare('select RequesterKey from RegistrationRequest where Id = :requestId')
    .get({ requestId: reg.requestId })
  if (!row) return undefined
  return asText(row.RequesterKey, 'RegistrationRequest.RequesterKey')
}
