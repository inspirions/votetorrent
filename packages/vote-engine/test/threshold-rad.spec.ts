/**
 * threshold-rad.spec.ts — 62-13 (D-08, D-10, D-12, D-33): `rad` (administration) threshold-2
 * co-signing, end to end through production code.
 *
 * First describe pins the CONTEXT-named defects (RED on the unmodified engine): above rad
 * threshold 1, `proposeAdmin` creates no co-signer Task at all (R0a), and a late co-signature
 * re-enters `applyAdminProposal` a second time (R0b) once a Task exists by hand-fan-out.
 */

import { expect } from 'chai'
import type { Database, SqlValue } from '@quereus/quereus'
import type { AdminInit, AdminSignatureTask, Proposal, Scope, Signature, ThresholdPolicy } from '@votetorrent/vote-core'
import { SignatureTasksEngine } from '../src/tasks/signature-tasks-engine.js'
import { AuthorityEngine } from '../src/authority/authority-engine.js'
import {
  createThresholdAuthority,
  type ThresholdAuthorityFixture,
} from './fixtures/threshold-authority.js'
import {
  computeRadProposalDigest,
  readProposedRosterJson,
  adminSignatureTaskExtensionInserter,
} from '../src/authority/rad-roster-digest.js'
import { fanOutSignatureTasks } from '../src/signing/fan-out.js'
import { allocateTid } from '../src/database/tid-allocator.js'
import { digestToBytes, toCanonicalDatetime } from '../src/utils.js'
import { SigningEngine } from '../src/signing/signing-engine.js'
import { sortRosterEntries } from '../src/authority/authority-engine.js'
import { UserEngine } from '../src/user/user-engine.js'

function makeNetworkRef () {
  return {
    hash: 'test-threshold-rad-hash',
    name: 'Test Network',
    relays: [] as string[],
    primaryAuthorityDomainName: 'test.example',
  }
}

function engineFor (fx: ThresholdAuthorityFixture, holder: ThresholdAuthorityFixture['holders'][number]): SignatureTasksEngine {
  return new SignatureTasksEngine(makeNetworkRef(), { db: fx.elec.ctx.db, user: holder.user })
}

async function countRows (db: Database, sql: string, params: Record<string, SqlValue> = {}): Promise<number> {
  const row = await db.prepare(sql).get(params)
  return Number(row?.n ?? 0)
}

async function openTaskUsers (db: Database, nonce: string): Promise<string[]> {
  const rows: string[] = []
  for await (const row of db.eval(
    'select distinct UserId from Task where SigningNonce = :nonce and IsCompleted = 0 order by UserId',
    { nonce }
  )) {
    rows.push(row.UserId as string)
  }
  return rows.sort()
}

/** Locate a 'rad' proposal's AdminSigning.Nonce by recomputing its digest — the canonical way
 *  to find a session this file never captured a return value for (proposeAdmin returns void). */
async function proposalNonce (
  db: Database,
  authorityId: string,
  effectiveAtCanon: string,
  thresholdPolicies: ThresholdPolicy[]
): Promise<string> {
  const officers = await readProposedRosterJson(db, authorityId, effectiveAtCanon)
  const digest = await computeRadProposalDigest(db, {
    authorityId,
    effectiveAt: effectiveAtCanon,
    officers,
    thresholdPolicies: JSON.stringify(thresholdPolicies),
  })
  const row = await db.prepare(`select Nonce from AdminSigning where Scope = 'rad' and Digest = :digest`).get({ digest })
  if (!row) throw new Error('proposalNonce: no AdminSigning row found for the computed proposal digest')
  return row.Nonce as string
}

/** The pending admin task for `holder` whose proposed EffectiveAt equals `effectiveAtCanon` —
 *  disambiguates when a holder has more than one open admin task (R11). */
async function adminTaskFor (
  fx: ThresholdAuthorityFixture,
  holder: ThresholdAuthorityFixture['holders'][number],
  effectiveAtCanon: string
): Promise<{ engine: SignatureTasksEngine; task: AdminSignatureTask }> {
  const engine = engineFor(fx, holder)
  const tasks = await engine.getRequestedSignatures(true)
  const task = tasks.find((t): t is AdminSignatureTask =>
    t.signatureType === 'admin' &&
    (t as AdminSignatureTask).administration?.proposed?.effectiveAt === effectiveAtCanon
  )
  if (!task) {
    throw new Error(
      `adminTaskFor: holder ${holder.user.id} has no pending admin task at proposed effectiveAt=${effectiveAtCanon}`
    )
  }
  return { engine, task }
}

interface ProposeArgs {
  effectiveAt: number
  rosterHolders: ThresholdAuthorityFixture['holders']
  thresholdPolicies: ThresholdPolicy[]
  initiatorUserId: string
  signerCallback: ((digest: Uint8Array) => Promise<Signature>) | Signature
}

/** Build and propose a 'rad' roster through the real `proposeAdmin` call — every R-test in this
 *  file drives the production entry point, never a hand-built row. Returns the canonical
 *  EffectiveAt; callers resolve the nonce separately via `proposalNonce` when they need it. */
async function proposeAdminRoster (fx: ThresholdAuthorityFixture, args: ProposeArgs): Promise<{ effectiveAtCanon: string }> {
  const proposal: Proposal<AdminInit> = {
    proposed: {
      officers: args.rosterHolders.map((h, i) => ({
        existing: {
          userId: h.user.id,
          authorityId: fx.authorityId,
          title: `Officer ${i}`,
          scopes: Array.from(new Set([...h.scopes, 'rad'])) as Scope[],
        },
      })),
      effectiveAt: args.effectiveAt,
      thresholdPolicies: args.thresholdPolicies,
    },
    signers: [args.initiatorUserId],
  }
  await fx.elec.authorityEngine.proposeAdmin(proposal, args.signerCallback)
  return { effectiveAtCanon: toCanonicalDatetime(args.effectiveAt) }
}

const RAD_THRESHOLD_2: ThresholdPolicy[] = [{ policy: 'rad' as Scope, threshold: 2 }]

describe('threshold-2 rad (RED pin)', function () {
  this.timeout(60_000)

  it('R0a (D-08 pin): proposeAdmin above threshold 1 fans out a co-signer Task to every other current rad holder', async () => {
    const fx = await createThresholdAuthority({ thresholdPolicies: RAD_THRESHOLD_2 })
    const db = fx.elec.ctx.db
    const effectiveAt = Date.now() + 3_600_000

    const { effectiveAtCanon } = await proposeAdminRoster(fx, {
      effectiveAt,
      rosterHolders: fx.holders.slice(0, 3),
      thresholdPolicies: RAD_THRESHOLD_2,
      initiatorUserId: fx.holders[0]!.user.id,
      signerCallback: fx.holders[0]!.sign,
    })
    const nonce = await proposalNonce(db, fx.authorityId, effectiveAtCanon, RAD_THRESHOLD_2)

    const expectedOpen = [fx.holders[1]!.user.id, fx.holders[2]!.user.id, fx.holders[3]!.user.id].sort()
    const openUsers = await openTaskUsers(db, nonce)
    expect(openUsers, 'R0a: openTaskUsers must equal holders[1..3]').to.deep.equal(expectedOpen)

    for (const userId of expectedOpen) {
      const extRow = await db
        .prepare(
          `select E.AdminEffectiveAt from Task T join AdminSignatureTaskExtension E on E.TaskId = T.Id
            where T.SigningNonce = :nonce and T.UserId = :userId`
        )
        .get({ nonce, userId })
      expect(extRow?.AdminEffectiveAt, `R0a: ${userId}'s task extension AdminEffectiveAt`).to.equal(effectiveAtCanon)
    }

    const officerSigCount = await countRows(db, 'select count(*) as n from OfficerSignature where SigningNonce = :nonce', { nonce })
    expect(officerSigCount, 'R0a: exactly 1 OfficerSignature (the proposer, holders[0])').to.equal(1)
    const adminSigCount = await countRows(db, 'select count(*) as n from AdminSignature where SigningNonce = :nonce', { nonce })
    expect(adminSigCount, 'R0a: 0 AdminSignature').to.equal(0)
  })

  it('R0b (D-10 pin): a late co-signature must not re-enter applyAdminProposal a second time', async () => {
    const fx = await createThresholdAuthority({ thresholdPolicies: RAD_THRESHOLD_2 })
    const db = fx.elec.ctx.db
    const effectiveAt = Date.now() + 3_600_000

    const { effectiveAtCanon } = await proposeAdminRoster(fx, {
      effectiveAt,
      rosterHolders: fx.holders.slice(0, 3),
      thresholdPolicies: RAD_THRESHOLD_2,
      initiatorUserId: fx.holders[0]!.user.id,
      signerCallback: fx.holders[0]!.sign,
    })
    const nonce = await proposalNonce(db, fx.authorityId, effectiveAtCanon, RAD_THRESHOLD_2)

    // Only hand-fan-out if proposeAdmin itself did not already (true before Task 2 lands; a
    // no-op once it does) — the same code is valid on both sides of this plan's own edit.
    const existingTaskCount = await countRows(db, 'select count(*) as n from Task where SigningNonce = :nonce', { nonce })
    if (existingTaskCount === 0) {
      const taskTid = await allocateTid(db, 'authority')
      await fanOutSignatureTasks(fx.elec.ctx, {
        authorityId: fx.authorityId,
        scope: 'rad' as Scope,
        nonce,
        initiatorUserId: fx.holders[0]!.user.id,
        signatureType: 'admin',
        taskTid,
        insertExtension: adminSignatureTaskExtensionInserter(db, fx.authorityId, effectiveAtCanon, taskTid),
      })
    }

    let promotionCalls = 0
    const originalApply = AuthorityEngine.prototype.applyAdminProposal
    AuthorityEngine.prototype.applyAdminProposal = async function (
      this: AuthorityEngine,
      ...args: Parameters<typeof originalApply>
    ) {
      promotionCalls++
      return originalApply.apply(this, args)
    } as typeof originalApply

    try {
      const { engine: engine1, task: task1 } = await adminTaskFor(fx, fx.holders[1]!, effectiveAtCanon)
      const digest1 = await engine1.getSignatureDigest(task1)
      await engine1.completeSignature(task1, {
        isAccepted: true,
        signature: await fx.holders[1]!.sign(digest1),
        sign: fx.holders[1]!.sign,
      })

      const { engine: engine2, task: task2 } = await adminTaskFor(fx, fx.holders[2]!, effectiveAtCanon)
      const digest2 = await engine2.getSignatureDigest(task2)
      await engine2.completeSignature(task2, {
        isAccepted: true,
        signature: await fx.holders[2]!.sign(digest2),
        sign: fx.holders[2]!.sign,
      })
    } finally {
      AuthorityEngine.prototype.applyAdminProposal = originalApply
    }

    const adminCount = await countRows(
      db,
      'select count(*) as n from Admin where AuthorityId = :id and EffectiveAt = :e',
      { id: fx.authorityId, e: effectiveAtCanon }
    )
    expect(adminCount, 'R0b: exactly 1 Admin row at the proposed EffectiveAt').to.equal(1)
    const officerSigCount = await countRows(db, 'select count(*) as n from OfficerSignature where SigningNonce = :nonce', { nonce })
    expect(officerSigCount, 'R0b: 3 OfficerSignature rows').to.equal(3)
    const adminSigCount = await countRows(db, 'select count(*) as n from AdminSignature where SigningNonce = :nonce', { nonce })
    expect(adminSigCount, 'R0b: exactly 1 AdminSignature on the nonce').to.equal(1)
    const task2Row = await db
      .prepare('select IsCompleted from Task where SigningNonce = :nonce and UserId = :userId')
      .get({ nonce, userId: fx.holders[2]!.user.id })
    expect(Number(task2Row?.IsCompleted), "R0b: holders[2]'s Task must be completed").to.equal(1)
    expect(promotionCalls, 'R0b: applyAdminProposal must be called exactly once').to.equal(1)
  })
})

/** R6/R7: a snapshot of every row class a refused proposeAdmin call must leave untouched,
 *  scoped to this authority so a refusal's "nothing written" claim is provable. */
async function snapshotCounts (db: Database, authorityId: string): Promise<Record<string, number>> {
  return {
    proposedAdmin: await countRows(db, 'select count(*) as n from ProposedAdmin where AuthorityId = :id', { id: authorityId }),
    proposedOfficer: await countRows(db, 'select count(*) as n from ProposedOfficer where AuthorityId = :id', { id: authorityId }),
    adminSigning: await countRows(db, `select count(*) as n from AdminSigning where AuthorityId = :id and Scope = 'rad'`, { id: authorityId }),
    officerSignature: await countRows(
      db,
      `select count(*) as n from OfficerSignature where SigningNonce in (select Nonce from AdminSigning where AuthorityId = :id and Scope = 'rad')`,
      { id: authorityId }
    ),
    task: await countRows(
      db,
      `select count(*) as n from Task where SigningNonce in (select Nonce from AdminSigning where AuthorityId = :id and Scope = 'rad')`,
      { id: authorityId }
    ),
    adminSignatureTaskExtension: await countRows(
      db,
      'select count(*) as n from AdminSignatureTaskExtension where AuthorityId = :id',
      { id: authorityId }
    ),
  }
}

describe('rad Trigger A: proposeAdmin fan-out (D-08, D-12)', function () {
  this.timeout(60_000)

  it('R1 (D-08): proposer signature recorded, co-signer tasks fanned out, lastPromotionOutcome and getSigningStatus report awaiting-co-signers', async () => {
    const fx = await createThresholdAuthority({ thresholdPolicies: RAD_THRESHOLD_2 })
    const db = fx.elec.ctx.db
    const effectiveAt = Date.now() + 3_600_000
    let callbackCalls = 0
    const countingCallback = async (digest: Uint8Array): Promise<Signature> => {
      callbackCalls++
      return fx.holders[0]!.sign(digest)
    }

    const { effectiveAtCanon } = await proposeAdminRoster(fx, {
      effectiveAt,
      rosterHolders: fx.holders.slice(0, 3),
      thresholdPolicies: RAD_THRESHOLD_2,
      initiatorUserId: fx.holders[0]!.user.id,
      signerCallback: countingCallback,
    })
    const nonce = await proposalNonce(db, fx.authorityId, effectiveAtCanon, RAD_THRESHOLD_2)

    const adminSigningCount = await countRows(db, 'select count(*) as n from AdminSigning where Nonce = :nonce', { nonce })
    expect(adminSigningCount, 'R1: exactly 1 rad AdminSigning session').to.equal(1)
    const officerSigCount = await countRows(db, 'select count(*) as n from OfficerSignature where SigningNonce = :nonce', { nonce })
    expect(officerSigCount, 'R1: exactly 1 OfficerSignature (holders[0])').to.equal(1)
    const adminSigCount = await countRows(db, 'select count(*) as n from AdminSignature where SigningNonce = :nonce', { nonce })
    expect(adminSigCount, 'R1: 0 AdminSignature').to.equal(0)

    const expectedOpen = [fx.holders[1]!.user.id, fx.holders[2]!.user.id, fx.holders[3]!.user.id].sort()
    const openUsers = await openTaskUsers(db, nonce)
    expect(openUsers, 'R1: openTaskUsers equals holders[1..3]').to.deep.equal(expectedOpen)

    for (const userId of [fx.holders[0]!.user.id, fx.nonHolder.user.id, fx.outsider.id]) {
      const n = await countRows(db, 'select count(*) as n from Task where SigningNonce = :nonce and UserId = :userId', { nonce, userId })
      expect(n, `R1: ${userId} must have 0 Tasks for the nonce`).to.equal(0)
    }

    for (const userId of expectedOpen) {
      const extRow = await db
        .prepare(
          `select E.AdminEffectiveAt from Task T join AdminSignatureTaskExtension E on E.TaskId = T.Id
            where T.SigningNonce = :nonce and T.UserId = :userId`
        )
        .get({ nonce, userId })
      expect(extRow?.AdminEffectiveAt, `R1: ${userId}'s extension AdminEffectiveAt`).to.equal(effectiveAtCanon)
    }

    const adminRowCount = await countRows(
      db,
      'select count(*) as n from Admin where AuthorityId = :id and EffectiveAt = :e',
      { id: fx.authorityId, e: effectiveAtCanon }
    )
    expect(adminRowCount, 'R1: 0 Admin rows at the proposed EffectiveAt').to.equal(0)
    expect(callbackCalls, 'R1: the callback was invoked exactly once').to.equal(1)

    const outcome = (
      fx.elec.authorityEngine as unknown as {
        lastPromotionOutcome?: { status: string; nonce: string; threshold: number; recipientUserIds: string[] }
      }
    ).lastPromotionOutcome
    expect(outcome, 'R1: lastPromotionOutcome').to.deep.equal({
      status: 'awaiting-co-signers',
      nonce,
      threshold: 2,
      recipientUserIds: expectedOpen,
    })

    const status = await new SigningEngine(fx.elec.ctx).getSigningStatus(nonce)
    expect(status?.signatures, 'R1: getSigningStatus signatures').to.equal(1)
    expect(status?.openTasks, 'R1: getSigningStatus openTasks').to.equal(3)
    expect(status?.reached, 'R1: getSigningStatus reached').to.equal(false)
    expect(status?.unreachable, 'R1: getSigningStatus unreachable').to.equal(false)
  })

  it('R6 (unreachable at birth): a threshold exceeding the holder count is refused before any write or callback', async () => {
    const fx = await createThresholdAuthority({ holderCount: 4, thresholdPolicies: [{ policy: 'rad' as Scope, threshold: 5 }] })
    const db = fx.elec.ctx.db
    const effectiveAt = Date.now() + 3_600_000
    let callbackCalls = 0
    const countingCallback = async (digest: Uint8Array): Promise<Signature> => {
      callbackCalls++
      return fx.holders[0]!.sign(digest)
    }

    const before = await snapshotCounts(db, fx.authorityId)

    let caught: unknown
    try {
      await proposeAdminRoster(fx, {
        effectiveAt,
        rosterHolders: fx.holders.slice(0, 3),
        thresholdPolicies: [{ policy: 'rad' as Scope, threshold: 5 }],
        initiatorUserId: fx.holders[0]!.user.id,
        signerCallback: countingCallback,
      })
    } catch (err) {
      caught = err
    }
    expect(caught, 'R6: proposeAdmin must reject').to.be.instanceOf(Error)
    expect((caught as Error).message, 'R6: error text names the threshold and the actual holder count').to.include('only 4 officers')
    expect(callbackCalls, 'R6: the callback must be invoked 0 times').to.equal(0)

    const after = await snapshotCounts(db, fx.authorityId)
    expect(after, 'R6: row counts unchanged from before the call').to.deep.equal(before)
  })

  it('R7 (spoof): a signature whose signer differs from admin.signers[0] is refused before any write', async () => {
    const fx = await createThresholdAuthority({ thresholdPolicies: RAD_THRESHOLD_2 })
    const db = fx.elec.ctx.db
    const effectiveAt = Date.now() + 3_600_000
    const before = await snapshotCounts(db, fx.authorityId)

    let caught: unknown
    try {
      await proposeAdminRoster(fx, {
        effectiveAt,
        rosterHolders: fx.holders.slice(0, 3),
        thresholdPolicies: RAD_THRESHOLD_2,
        initiatorUserId: fx.holders[0]!.user.id,
        signerCallback: async (digest: Uint8Array): Promise<Signature> => fx.holders[1]!.sign(digest),
      })
    } catch (err) {
      caught = err
    }
    expect(caught, 'R7: proposeAdmin must reject').to.be.instanceOf(Error)
    expect((caught as Error).message, 'R7: error text').to.include('does not belong to the officer proposing')

    const after = await snapshotCounts(db, fx.authorityId)
    expect(after, 'R7: row counts unchanged from before the call').to.deep.equal(before)
  })

  it('R8 (atomic envelope): a fault inside the extension insert leaves no signed session and no Task behind', async () => {
    const fx = await createThresholdAuthority({ thresholdPolicies: RAD_THRESHOLD_2 })
    const db = fx.elec.ctx.db
    const effectiveAt1 = Date.now() + 3_600_000
    const effectiveAtCanon1 = toCanonicalDatetime(effectiveAt1)

    const originalExec = db.exec.bind(db)
    let hitCount = 0
    let faultArmed = true
    db.exec = (async (sql: string, params?: unknown) => {
      if (faultArmed && typeof sql === 'string' && sql.includes('insert into AdminSignatureTaskExtension')) {
        hitCount++
        throw new Error('forced fan-out fault')
      }
      return originalExec(sql as never, params as never)
    }) as typeof db.exec

    let caught: unknown
    try {
      await proposeAdminRoster(fx, {
        effectiveAt: effectiveAt1,
        rosterHolders: fx.holders.slice(0, 3),
        thresholdPolicies: RAD_THRESHOLD_2,
        initiatorUserId: fx.holders[0]!.user.id,
        signerCallback: fx.holders[0]!.sign,
      })
    } catch (err) {
      caught = err
    } finally {
      faultArmed = false
      db.exec = originalExec
    }
    expect(caught, 'R8: proposeAdmin must reject').to.be.instanceOf(Error)
    expect((caught as Error).message, 'R8: the forced fan-out fault must propagate').to.include('forced fan-out fault')
    expect(hitCount, 'R8: the fault must have fired at least once').to.be.at.least(1)

    const digest1 = await computeRadProposalDigest(db, {
      authorityId: fx.authorityId,
      effectiveAt: effectiveAtCanon1,
      officers: await readProposedRosterJson(db, fx.authorityId, effectiveAtCanon1),
      thresholdPolicies: JSON.stringify(RAD_THRESHOLD_2),
    })
    const adminSigningCount = await countRows(db, `select count(*) as n from AdminSigning where Scope = 'rad' and Digest = :digest`, { digest: digest1 })
    expect(adminSigningCount, 'R8: 0 AdminSigning rows with the proposal digest').to.equal(0)
    const officerSigCount1 = await countRows(
      db,
      `select count(*) as n from OfficerSignature OS join AdminSigning A on A.Nonce = OS.SigningNonce where A.AuthorityId = :id and A.Scope = 'rad' and A.Digest = :digest`,
      { id: fx.authorityId, digest: digest1 }
    )
    expect(officerSigCount1, 'R8: 0 OfficerSignature rows for holders[0] on any new rad session').to.equal(0)
    const taskViaExtCount = await countRows(
      db,
      'select count(*) as n from AdminSignatureTaskExtension where AuthorityId = :id and AdminEffectiveAt = :e',
      { id: fx.authorityId, e: effectiveAtCanon1 }
    )
    expect(taskViaExtCount, 'R8: 0 Task rows created for this proposal').to.equal(0)

    // The ProposedAdmin row IS present — the proposal rows committed in their own
    // transaction, pre-existing behaviour, asserted and documented, not hidden.
    const proposedAdminCount = await countRows(
      db,
      'select count(*) as n from ProposedAdmin where AuthorityId = :id and EffectiveAt = :e',
      { id: fx.authorityId, e: effectiveAtCanon1 }
    )
    expect(proposedAdminCount, 'R8: ProposedAdmin IS present (pre-existing behaviour)').to.equal(1)

    const effectiveAt2 = effectiveAt1 + 60_000
    await proposeAdminRoster(fx, {
      effectiveAt: effectiveAt2,
      rosterHolders: fx.holders.slice(0, 3),
      thresholdPolicies: RAD_THRESHOLD_2,
      initiatorUserId: fx.holders[0]!.user.id,
      signerCallback: fx.holders[0]!.sign,
    })
    const effectiveAtCanon2 = toCanonicalDatetime(effectiveAt2)
    const nonce2 = await proposalNonce(db, fx.authorityId, effectiveAtCanon2, RAD_THRESHOLD_2)
    const openUsers2 = await openTaskUsers(db, nonce2)
    expect(openUsers2.length, 'R8: a second proposeAdmin with a NEW EffectiveAt fans out to 3').to.equal(3)
  })

  it('R12 (threshold 1 unchanged): proposeAdmin promotes immediately, invoking the callback exactly twice, with no Task created', async () => {
    const fx = await createThresholdAuthority()
    const db = fx.elec.ctx.db
    const effectiveAt = Date.now() + 3_600_000
    let callbackCalls = 0
    const countingCallback = async (digest: Uint8Array): Promise<Signature> => {
      callbackCalls++
      return fx.holders[0]!.sign(digest)
    }
    const thresholdPolicies: ThresholdPolicy[] = [{ policy: 'rad' as Scope, threshold: 1 }]

    const { effectiveAtCanon } = await proposeAdminRoster(fx, {
      effectiveAt,
      rosterHolders: fx.holders.slice(0, 3),
      thresholdPolicies,
      initiatorUserId: fx.holders[0]!.user.id,
      signerCallback: countingCallback,
    })

    const adminCount = await countRows(
      db,
      'select count(*) as n from Admin where AuthorityId = :id and EffectiveAt = :e',
      { id: fx.authorityId, e: effectiveAtCanon }
    )
    expect(adminCount, 'R12: the Admin row must exist').to.equal(1)
    expect(callbackCalls, 'R12: the callback must be invoked exactly twice').to.equal(2)

    const outcome = (fx.elec.authorityEngine as unknown as { lastPromotionOutcome?: { status: string } }).lastPromotionOutcome
    expect(outcome?.status, 'R12: lastPromotionOutcome.status').to.equal('promoted')

    const nonce = await proposalNonce(db, fx.authorityId, effectiveAtCanon, thresholdPolicies)
    const taskCount = await countRows(db, 'select count(*) as n from Task where SigningNonce = :nonce', { nonce })
    expect(taskCount, 'R12: 0 Task rows exist for the nonce').to.equal(0)
  })

  it('R13 (bare Signature at threshold 2): fan-out never depends on the callback form', async () => {
    const fx = await createThresholdAuthority({ thresholdPolicies: RAD_THRESHOLD_2 })
    const db = fx.elec.ctx.db
    const effectiveAt = Date.now() + 3_600_000
    const effectiveAtCanon = toCanonicalDatetime(effectiveAt)
    const roster = fx.holders.slice(0, 3)
    const rosterScopes = roster.map((h) => Array.from(new Set([...h.scopes, 'rad'])) as Scope[])

    const entries = roster.map((h, i) => ({
      proposedName: h.user.name,
      userId: h.user.id,
      title: `Officer ${i}`,
      scopes: rosterScopes[i]!,
    }))
    const officers = JSON.stringify(sortRosterEntries(entries))
    const digest = await computeRadProposalDigest(db, {
      authorityId: fx.authorityId,
      effectiveAt: effectiveAtCanon,
      officers,
      thresholdPolicies: JSON.stringify(RAD_THRESHOLD_2),
    })
    const signature = await fx.holders[0]!.sign(digestToBytes(digest))

    const proposal: Proposal<AdminInit> = {
      proposed: {
        officers: roster.map((h, i) => ({
          existing: { userId: h.user.id, authorityId: fx.authorityId, title: `Officer ${i}`, scopes: rosterScopes[i]! },
        })),
        effectiveAt,
        thresholdPolicies: RAD_THRESHOLD_2,
      },
      signers: [fx.holders[0]!.user.id],
    }
    await fx.elec.authorityEngine.proposeAdmin(proposal, signature)

    const nonce = await proposalNonce(db, fx.authorityId, effectiveAtCanon, RAD_THRESHOLD_2)
    const expectedOpen = [fx.holders[1]!.user.id, fx.holders[2]!.user.id, fx.holders[3]!.user.id].sort()
    const openUsers = await openTaskUsers(db, nonce)
    expect(openUsers, 'R13: fans out to holders[1..3]').to.deep.equal(expectedOpen)

    const outcome = (fx.elec.authorityEngine as unknown as { lastPromotionOutcome?: { status: string } }).lastPromotionOutcome
    expect(outcome?.status, 'R13: lastPromotionOutcome.status').to.equal('awaiting-co-signers')
  })

  it('R14 (non-holder initiator): a non-holder officer fans out to all current holders; its own signature is not counted', async () => {
    const fx = await createThresholdAuthority({ thresholdPolicies: RAD_THRESHOLD_2 })
    const db = fx.elec.ctx.db
    const effectiveAt = Date.now() + 3_600_000

    // proposeAdmin's ProposedAdmin insert is a Class A IsUserValid site (verify-user-key.ts):
    // it requires a REAL UserKey row for whoever signs, not only the founder. The fixture never
    // seeds one for nonHolder/outsider (only the founder's key exists from genesis) — prime it
    // through the real UserEngine.addKey bootstrap path, exactly as authority.spec.ts's
    // primeUserForRename does for its own non-founder signer.
    await new UserEngine({ ...fx.nonHolder.user, activeKeys: [] }, fx.elec.ctx).addKey(fx.nonHolder.user.activeKeys[0]!)

    const { effectiveAtCanon } = await proposeAdminRoster(fx, {
      effectiveAt,
      rosterHolders: fx.holders.slice(0, 3),
      thresholdPolicies: RAD_THRESHOLD_2,
      initiatorUserId: fx.nonHolder.user.id,
      signerCallback: fx.nonHolder.sign,
    })
    const nonce = await proposalNonce(db, fx.authorityId, effectiveAtCanon, RAD_THRESHOLD_2)

    const expectedOpen = fx.holders.map((h) => h.user.id).sort()
    const openUsers = await openTaskUsers(db, nonce)
    expect(openUsers, 'R14: all 4 current holders get a Task').to.deep.equal(expectedOpen)

    const status = await new SigningEngine(fx.elec.ctx).getSigningStatus(nonce)
    expect(status?.signatures, "R14: the non-holder initiator's own signature is not counted").to.equal(0)
  })
})

export {
  makeNetworkRef,
  engineFor,
  countRows,
  openTaskUsers,
  proposalNonce,
  adminTaskFor,
  proposeAdminRoster,
  RAD_THRESHOLD_2,
}
export type { ProposeArgs }
