import { expect } from 'chai'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js'
import type { Database } from '@quereus/quereus'
import type { RegisterInit, RegistrationRequestInit, Signature } from '@votetorrent/vote-core'
import { SignatureTasksEngine } from '../src/tasks/signature-tasks-engine.js'
import { RegistrationEngine } from '../src/registration/registration-engine.js'
import { toIsoZDatetime } from '../src/signing/ceremony-helpers.js'
import { randomTestKeyPair, type TestKeyPair } from './fixtures/keys.js'
import {
  createThresholdAuthority,
  type ThresholdAuthorityFixture,
} from './fixtures/threshold-authority.js'

/**
 * threshold-vrg.spec.ts — 62-11 (D-08..D-12): registrant-approval (`vrg`) threshold-2
 * end-to-end wiring. The first describe pins the CONTEXT "Specific Ideas" defect (RED on
 * the unmodified engine): at vrg threshold 2, the inbox seed pass still seeds only ONE
 * Task (the legacy threshold-1 shape), so the first accept's finalize runs below
 * threshold and the derived `vrg` sessions (DG-2, Registrant, RegistrantPrivate) can
 * never reach AdminSignature.
 */

function makeNetworkRef () {
  return {
    hash: 'test-threshold-vrg-hash',
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

async function headerNonceForRequest (db: Database, requestId: string): Promise<string> {
  const row = await db
    .prepare(
      `select Task.SigningNonce from Task
         join RegistrantSignatureTaskExtension E on E.TaskId = Task.Id
         where E.RequestId = :requestId
         limit 1`
    )
    .get({ requestId })
  if (!row) throw new Error(`headerNonceForRequest: no Task for requestId=${requestId}`)
  return row.SigningNonce as string
}

/** WR-10 prehash contract — mirrors registrant-approval.spec.ts's makeCallbackSigner
 *  verbatim, adapted for this file's local scope (no vote-core signerUserId). */
function makeCallbackSigner (keyPair: TestKeyPair): (digest: Uint8Array) => Promise<Signature> {
  const privBytes = hexToBytes(keyPair.privateHex)
  return async (digest: Uint8Array): Promise<Signature> => {
    const sig = secp256k1.sign(digest, privBytes)
    return { signature: bytesToHex(sig), signerKey: keyPair.publicHex, signerUserId: '' }
  }
}

function makeTestPayload (authorityId: string, registrantId?: string): RegisterInit {
  return {
    registrant: {
      id: registrantId ?? crypto.randomUUID(),
      authorityId,
      expiration: toIsoZDatetime(Date.now() + 365 * 86_400_000),
    },
    private: {
      expiration: toIsoZDatetime(Date.now() + 365 * 86_400_000),
      details: [],
    },
  }
}

/** Submits one pending RegistrationRequest addressed to `fx.authorityId` through the REAL
 *  engine method (adapted from registrant-approval.spec.ts's submitPendingRequest, no
 *  electionId in the payload). */
async function submitPendingRequest (
  fx: ThresholdAuthorityFixture,
  registrantId?: string
): Promise<{ requestId: string; init: RegistrationRequestInit }> {
  const requester = randomTestKeyPair()
  const engine = new RegistrationEngine(fx.elec.ctx)
  const init: RegistrationRequestInit = {
    id: crypto.randomUUID(),
    authorityId: fx.authorityId,
    payload: makeTestPayload(fx.authorityId, registrantId),
    submittedAt: toIsoZDatetime(Date.now()),
  }
  const requestId = await engine.submitRegistrationRequest(init, requester.publicHex, makeCallbackSigner(requester))
  return { requestId, init }
}

describe('threshold-2 first accept (vrg, RED pin)', function () {
  this.timeout(60_000)

  it('V0: at vrg threshold 2, the first accept does not throw, mints no Registrant, and leaves the request pending', async () => {
    const fx = await createThresholdAuthority()
    const db = fx.elec.ctx.db
    const { requestId, init } = await submitPendingRequest(fx)

    const engine = engineFor(fx, fx.holders[0]!)
    const tasks = await engine.getRequestedSignatures(true)
    const task = tasks.find((t) => t.signatureType === 'registrant' && (t as any).requestId === requestId)
    expect(task, 'holders[0] must have a pending registrant task').to.not.be.undefined

    let caught: unknown
    try {
      await engine.completeSignature(task!, {
        isAccepted: true,
        signature: await fx.holders[0]!.sign(await engine.getSignatureDigest(task!)),
        sign: fx.holders[0]!.sign,
        decision: { checklist: ['id'] },
      })
    } catch (err) {
      caught = err
    }
    expect(caught, `the accept must not throw — got: ${caught instanceof Error ? caught.message : String(caught)}`).to.be.undefined

    const statusRow = await db.prepare('select Status from RegistrationRequest where Id = :id').get({ id: requestId })
    expect(statusRow!.Status, 'RegistrationRequest.Status must still be p').to.equal('p')

    const registrantRow = await db.prepare('select 1 from Registrant where Id = :id').get({ id: init.payload.registrant.id })
    expect(registrantRow, 'no Registrant row must exist').to.be.undefined

    const headerNonce = await headerNonceForRequest(db, requestId)
    const officerCount = await countRows(db, 'select count(*) as n from OfficerSignature where SigningNonce = :nonce', { nonce: headerNonce })
    expect(officerCount, 'exactly 1 OfficerSignature on the header nonce').to.equal(1)
    const adminCount = await countRows(db, 'select count(*) as n from AdminSignature where SigningNonce = :nonce', { nonce: headerNonce })
    expect(adminCount, '0 AdminSignature at threshold 2 after only 1 accept').to.equal(0)

    const holder0TaskRow = await db
      .prepare('select IsCompleted from Task where SigningNonce = :nonce and UserId = :userId')
      .get({ nonce: headerNonce, userId: fx.holders[0]!.user.id })
    expect(Number(holder0TaskRow?.IsCompleted), "holders[0]'s Task must be completed").to.equal(1)
  })
})

export { makeNetworkRef, engineFor, countRows, openTaskUsers, headerNonceForRequest, submitPendingRequest, makeTestPayload, makeCallbackSigner }
