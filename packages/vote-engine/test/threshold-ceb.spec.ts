import { expect } from 'chai'
import type { Database } from '@quereus/quereus'
import { SignatureTasksEngine } from '../src/tasks/signature-tasks-engine.js'
import { ElectionEngine } from '../src/election/election-engine.js'
import { fanOutSignatureTasks } from '../src/signing/fan-out.js'
import { allocateTid } from '../src/database/tid-allocator.js'
import {
  createThresholdAuthority,
  insertBallotHeaderSession,
  ballotExtensionInserter,
  type ThresholdAuthorityFixture,
} from './fixtures/threshold-authority.js'
import { seedProposedBallot } from './fixtures/test-context.js'

/**
 * threshold-ceb.spec.ts — 62-11 (D-08..D-12): ballot-confirmation (`ceb`) threshold-2
 * end-to-end wiring. The first describe pins the CONTEXT "Specific Ideas" defect
 * (RED on the unmodified engine): at ceb threshold 2, the first accept commits its
 * OfficerSignature, then `finalizeBallot` throws on `Ballot.MutationValid` (no
 * AdminSignature yet), and the Task is left open.
 */

function makeNetworkRef () {
  return {
    hash: 'test-threshold-ceb-hash',
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

async function headerNonceForBallot (db: Database, ballotId: string): Promise<string> {
  const row = await db
    .prepare(
      `select Task.SigningNonce from Task
         join BallotSignatureTaskExtension E on E.TaskId = Task.Id
         where E.BallotId = :ballotId
         limit 1`
    )
    .get({ ballotId })
  if (!row) throw new Error(`headerNonceForBallot: no Task for ballotId=${ballotId}`)
  return row.SigningNonce as string
}

async function electionIdForBallot (db: Database, ballotId: string): Promise<string> {
  const row = await db.prepare('select ElectionId from ProposedBallot where Id = :ballotId').get({ ballotId })
  if (!row) throw new Error(`electionIdForBallot: no ProposedBallot for ballotId=${ballotId}`)
  return row.ElectionId as string
}

/** Build an ElectionEngine over a specific holder's own ctx.user — mirrors how
 *  `addTestElection`'s own `elec.electionEngine` is constructed (ElectionsEngine.openElection),
 *  but for a NON-founder holder whose ctx.user must be their own. */
async function electionEngineFor (
  fx: ThresholdAuthorityFixture,
  holder: ThresholdAuthorityFixture['holders'][number],
  ballotId: string
): Promise<ElectionEngine> {
  const electionId = await electionIdForBallot(fx.elec.ctx.db, ballotId)
  return new ElectionEngine({ id: electionId, authorityId: fx.authorityId }, { db: fx.elec.ctx.db, user: holder.user })
}

describe('threshold-2 first accept (ceb, RED pin)', function () {
  this.timeout(60_000)

  it('C0: at ceb threshold 2, the first accept records the signature and leaves the Task open — does not throw, mints no Ballot', async () => {
    const fx = await createThresholdAuthority()
    const db = fx.elec.ctx.db
    const { ballotId } = await seedProposedBallot(fx.elec, 'tb-c0')

    const { nonce } = await insertBallotHeaderSession(fx, ballotId, fx.holders[0]!.user.id)
    await fanOutSignatureTasks(fx.elec.ctx, {
      authorityId: fx.authorityId,
      scope: 'ceb',
      nonce,
      initiatorUserId: null,
      signatureType: 'ballot',
      taskTid: await allocateTid(db, 'election'),
      insertExtension: ballotExtensionInserter(db, ballotId),
    })

    const engine = engineFor(fx, fx.holders[0]!)
    const tasks = await engine.getRequestedSignatures(true)
    const task = tasks.find(
      (t) => t.signatureType === 'ballot' && (t as any).ballot?.proposed?.id === ballotId
    )
    expect(task, 'holders[0] must have a pending ballot task').to.not.be.undefined

    const digest = await engine.getSignatureDigest(task!)
    const signature = await fx.holders[0]!.sign(digest)

    let caught: unknown
    try {
      await engine.completeSignature(task!, { isAccepted: true, signature, sign: fx.holders[0]!.sign })
    } catch (err) {
      caught = err
    }
    expect(caught, `the accept must not throw — got: ${caught instanceof Error ? caught.message : String(caught)}`).to.be.undefined

    const officerCount = await countRows(db, 'select count(*) as n from OfficerSignature where SigningNonce = :nonce', { nonce })
    expect(officerCount, 'exactly 1 OfficerSignature').to.equal(1)
    const adminCount = await countRows(db, 'select count(*) as n from AdminSignature where SigningNonce = :nonce', { nonce })
    expect(adminCount, '0 AdminSignature at threshold 2 after only 1 accept').to.equal(0)

    const ballotCount = await countRows(db, 'select count(*) as n from Ballot where Id = :id', { id: ballotId })
    expect(ballotCount, '0 Ballot rows — the session has not reached its threshold').to.equal(0)

    const holder0TaskRow = await db
      .prepare('select IsCompleted from Task where SigningNonce = :nonce and UserId = :userId')
      .get({ nonce, userId: fx.holders[0]!.user.id })
    expect(Number(holder0TaskRow?.IsCompleted), "holders[0]'s Task must be completed").to.equal(1)

    const openUsers = await openTaskUsers(db, nonce)
    const expectedOpen = [fx.holders[1]!.user.id, fx.holders[2]!.user.id, fx.holders[3]!.user.id].sort()
    expect(openUsers, 'holders[1..3] still have open Tasks').to.deep.equal(expectedOpen)
  })
})

export { makeNetworkRef, engineFor, countRows, openTaskUsers, headerNonceForBallot, electionEngineFor }
