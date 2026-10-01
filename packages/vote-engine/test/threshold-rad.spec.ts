/**
 * threshold-rad.spec.ts — 62-13 (D-08, D-10, D-12, D-33): `rad` (administration) threshold-2
 * co-signing, end to end through production code.
 *
 * First describe pins the CONTEXT-named defects (RED on the unmodified engine): above rad
 * threshold 1, `proposeAdmin` creates no co-signer Task at all (R0a), and a late co-signature
 * re-enters `applyAdminProposal` a second time (R0b) once a Task exists by hand-fan-out.
 */

import { expect } from 'chai'
import type { Database } from '@quereus/quereus'
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
import { toCanonicalDatetime } from '../src/utils.js'

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

async function countRows (db: Database, sql: string, params: Record<string, unknown> = {}): Promise<number> {
  const row = await db.prepare(sql).get(params as Record<string, unknown>)
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
