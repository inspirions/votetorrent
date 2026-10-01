/**
 * registration-dedup.spec.ts — Phase 62 Plan 19 (D-43/D-44)
 *
 * End-to-end proof of the D-43 restart pair and the D-44 duplicate-detection/closure engine API,
 * against the REAL votetorrent schema through 62-15's `P2pRegistrationTransport`
 * (`createP2pStagingFixture()`). Every test gets a FRESH fixture (a fresh network/authority) —
 * `RegistrationDecision` rows are insert-only and the matcher scans every pending request of the
 * authority, so tests must not share one.
 */

import 'reflect-metadata'
import { expect } from 'chai'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js'
import type { SqlValue } from '@quereus/quereus'
import { createP2pStagingFixture } from './fixtures/p2p-staging-fixture.js'
import type { P2pStagingFixture } from './fixtures/p2p-staging-fixture.js'
import { addSiblingAuthority, makeTestSignCallback } from './fixtures/test-context.js'
import { createThresholdAuthority } from './fixtures/threshold-authority.js'
import type { ThresholdAuthorityFixture } from './fixtures/threshold-authority.js'
import { randomTestKeyPair } from './fixtures/keys.js'
import type { TestKeyPair } from './fixtures/keys.js'
import { RegistrationEngine } from '../src/registration/registration-engine.js'
import { MockRegistrationEngine } from '../src/registration/mock-registration-engine.js'
import { P2pRegistrationTransport, REGISTRATION_DUPLICATE_CLOSED_REASON } from '../src/registration/transport/p2p-registration-transport.js'
import { readAuthorityThreshold } from '../src/signing/threshold.js'
import { toIsoZDatetime } from '../src/signing/ceremony-helpers.js'
import { RegistrationDuplicateError } from '@votetorrent/vote-core'
import type {
  RegisterInit,
  RegistrationDecisionPublishPort,
  RegistrationRequestInit,
  Signature
} from '@votetorrent/vote-core'

type RegistrationDuplicateErrorInstance = InstanceType<typeof RegistrationDuplicateError>

let strandSeq = 0

function wait (ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** WR-10 prehash contract — mirrors `registrant-approval.spec.ts`'s own helper verbatim. */
function makeCallbackSigner (keyPair: TestKeyPair): (digest: Uint8Array) => Promise<Signature> {
  const privBytes = hexToBytes(keyPair.privateHex)
  return async (digest: Uint8Array): Promise<Signature> => {
    const sig = secp256k1.sign(digest, privBytes)
    return { signature: bytesToHex(sig), signerKey: keyPair.publicHex, signerUserId: '' }
  }
}

interface SubmitIdentity {
  firstName?: string
  lastName?: string
  dob?: string
  email?: string
  phone?: string
}

/** Submits one PENDING `RegistrationRequest` through the REAL engine (D-02 intake). */
async function submitPending (
  fixture: P2pStagingFixture,
  identity: SubmitIdentity,
  opts?: { requesterKey?: TestKeyPair; authorityId?: string }
): Promise<{ requestId: string; requester: TestKeyPair }> {
  const requester = opts?.requesterKey ?? randomTestKeyPair()
  const authorityId = opts?.authorityId ?? fixture.auth.authority.id
  const engine = new RegistrationEngine(fixture.auth.ctx)
  const details = [
    ...(identity.dob !== undefined ? [{ name: 'dob', value: identity.dob }] : []),
    ...(identity.email !== undefined ? [{ name: 'email', value: identity.email }] : []),
    ...(identity.phone !== undefined ? [{ name: 'phone', value: identity.phone }] : [])
  ]
  const payload: RegisterInit = {
    registrant: { id: crypto.randomUUID(), authorityId, expiration: toIsoZDatetime(Date.now() + 365 * 86_400_000) },
    public: { firstName: identity.firstName, lastName: identity.lastName },
    private: { expiration: toIsoZDatetime(Date.now() + 365 * 86_400_000), details }
  }
  const init: RegistrationRequestInit = {
    id: crypto.randomUUID(),
    authorityId,
    payload,
    submittedAt: toIsoZDatetime(Date.now())
  }
  const requestId = await engine.submitRegistrationRequest(init, requester.publicHex, makeCallbackSigner(requester))
  return { requestId, requester }
}

/** Submits one PENDING request directly against a `ThresholdAuthorityFixture` (D7). */
async function submitPendingAtThresholdAuthority (fx: ThresholdAuthorityFixture, identity: SubmitIdentity): Promise<{ requestId: string }> {
  const requester = randomTestKeyPair()
  const engine = new RegistrationEngine(fx.elec.ctx)
  const payload: RegisterInit = {
    registrant: { id: crypto.randomUUID(), authorityId: fx.authorityId, expiration: toIsoZDatetime(Date.now() + 365 * 86_400_000) },
    public: { firstName: identity.firstName, lastName: identity.lastName },
    private: { expiration: toIsoZDatetime(Date.now() + 365 * 86_400_000), details: [] }
  }
  const init: RegistrationRequestInit = {
    id: crypto.randomUUID(),
    authorityId: fx.authorityId,
    payload,
    submittedAt: toIsoZDatetime(Date.now())
  }
  const requestId = await engine.submitRegistrationRequest(init, requester.publicHex, makeCallbackSigner(requester))
  return { requestId }
}

/** Rejects one pending request as the fixture's founding 'vrg' officer. */
async function rejectAs (fixture: P2pStagingFixture, requestId: string, reason: string): Promise<void> {
  const engine = new RegistrationEngine(fixture.auth.ctx)
  await engine.rejectRegistrationRequest(requestId, { checklist: ['id'], rejectionReason: reason }, makeTestSignCallback(fixture.net.user))
}

async function countRows (fixture: P2pStagingFixture, sql: string, params: Record<string, SqlValue> = {}): Promise<number> {
  const row = await fixture.db.prepare(sql).get(params)
  return Number(row?.n ?? 0)
}

async function rawDecision (fixture: P2pStagingFixture, requestId: string): Promise<Record<string, unknown> | undefined> {
  return await fixture.db.prepare('select * from RegistrationDecision where RequestId = :requestId').get({ requestId }) as Record<string, unknown> | undefined
}

function makeTransport (fixture: P2pStagingFixture): P2pRegistrationTransport {
  strandSeq += 1
  return new P2pRegistrationTransport({
    openStrand: async () => fixture.makePort(),
    computeDigest: fixture.fixtureRequestDigest,
    strandId: `dedup-${strandSeq}`,
    decisionSigner: fixture.decisionSigner
  })
}

function makePublisher (fixture: P2pStagingFixture, transport: P2pRegistrationTransport): RegistrationDecisionPublishPort {
  return {
    authorityId: fixture.decisionSigner.authorityId,
    publishDecision: (d) => transport.publishDecision(d)
  }
}

describe('D-43/D-44 registration duplicate detection and closure', function () {
  this.timeout(30_000)

  let fixture: P2pStagingFixture
  let engine: RegistrationEngine
  let transport: P2pRegistrationTransport
  let publisher: RegistrationDecisionPublishPort

  beforeEach(async () => {
    fixture = await createP2pStagingFixture()
    expect(fixture.auth.ctx.db).to.equal(fixture.db)
    expect(await readAuthorityThreshold(fixture.db, fixture.auth.authority.id, 'vrg')).to.equal(1)
    engine = new RegistrationEngine(fixture.auth.ctx)
    transport = makeTransport(fixture)
    publisher = makePublisher(fixture, transport)
  })

  // ---- D1: the D-43 restart pair ----

  it('D1: the restart pair is flagged both ways, with no dob/email/phone value on the result', async () => {
    const { requestId: a } = await submitPending(fixture, { firstName: 'Ana', lastName: 'Pérez-Gómez', dob: '1990-02-03', email: 'ana@example.com' })
    await wait(5)
    const { requestId: b } = await submitPending(fixture, { firstName: 'ANA', lastName: 'perez gomez', dob: '1990/02/03' })

    const candidatesForB = await engine.getLikelyDuplicateRequests(b)
    expect(candidatesForB.map((c) => c.requestId)).to.deep.equal([a])
    expect(candidatesForB[0]!.matchedOn).to.deep.equal(['name', 'dob'])
    expect(candidatesForB[0]!.firstName).to.equal('Ana')
    expect(candidatesForB[0]!.lastName).to.equal('Pérez-Gómez')

    const candidatesForA = await engine.getLikelyDuplicateRequests(a)
    expect(candidatesForA.map((c) => c.requestId)).to.deep.equal([b])

    for (const c of [...candidatesForA, ...candidatesForB]) {
      expect(c).to.not.have.property('dob')
      expect(c).to.not.have.property('email')
      expect(c).to.not.have.property('phone')
      expect(c).to.not.have.property('payload')
    }
  })

  // ---- D2: negatives ----

  it('D2: a different dob is not flagged', async () => {
    const { requestId: a } = await submitPending(fixture, { firstName: 'Bea', lastName: 'Lopez', dob: '1990-01-01' })
    const { requestId: b } = await submitPending(fixture, { firstName: 'Bea', lastName: 'Lopez', dob: '1991-01-01' })
    expect(await engine.getLikelyDuplicateRequests(a)).to.deep.equal([])
    expect(await engine.getLikelyDuplicateRequests(b)).to.deep.equal([])
  })

  it('D2: the same identity under a sibling authority is not flagged', async () => {
    const siblingAuthorityId = await addSiblingAuthority(fixture.auth, { scopes: ['vrg'] })
    const { requestId: d } = await submitPending(fixture, { firstName: 'Carl', lastName: 'Diaz' })
    await submitPending(fixture, { firstName: 'Carl', lastName: 'Diaz' }, { authorityId: siblingAuthorityId })
    expect(await engine.getLikelyDuplicateRequests(d)).to.deep.equal([])
  })

  it('D2: the same requester key with a different name is not flagged', async () => {
    const sharedKey = randomTestKeyPair()
    const { requestId: f } = await submitPending(fixture, { firstName: 'Fay', lastName: 'Nolan' }, { requesterKey: sharedKey })
    const { requestId: g } = await submitPending(fixture, { firstName: 'Gus', lastName: 'Innes' }, { requesterKey: sharedKey })
    expect(await engine.getLikelyDuplicateRequests(f)).to.deep.equal([])
    expect(await engine.getLikelyDuplicateRequests(g)).to.deep.equal([])
  })

  it('D2: an unknown id and a decided target both resolve [] and never throw; a decided request is never a candidate', async () => {
    expect(await engine.getLikelyDuplicateRequests('unknown-request-id')).to.deep.equal([])

    const { requestId: h } = await submitPending(fixture, { firstName: 'Hana', lastName: 'Osei' })
    await rejectAs(fixture, h, 'reason')
    expect(await engine.getLikelyDuplicateRequests(h)).to.deep.equal([])

    const { requestId: i } = await submitPending(fixture, { firstName: 'Ivy', lastName: 'Soto' })
    await rejectAs(fixture, i, 'reason')
    const { requestId: j } = await submitPending(fixture, { firstName: 'Ivy', lastName: 'Soto' })
    expect(await engine.getLikelyDuplicateRequests(j)).to.deep.equal([])
  })

  // ---- D3: D-44 close through reject ----

  it('D3: rejecting B and publishing with closesRequestId A closes A in a separate transaction, voter-visible as a duplicate rejection', async () => {
    const { requestId: a } = await submitPending(fixture, { firstName: 'Nia', lastName: 'Krause', dob: '1990-02-03' })
    await wait(5)
    const { requestId: b } = await submitPending(fixture, { firstName: 'NIA', lastName: 'krause', dob: '1990/02/03' })

    await rejectAs(fixture, b, 'Could not verify')
    expect(await engine.listUnpublishedRegistrationDecisions(fixture.auth.authority.id)).to.deep.equal([b])

    const calls: Array<{ requestId: string; status: string; autocommitAtCall: boolean }> = []
    const spyPublisher: RegistrationDecisionPublishPort = {
      authorityId: fixture.decisionSigner.authorityId,
      publishDecision: async (d) => {
        calls.push({ requestId: d.requestId, status: d.status, autocommitAtCall: fixture.db.getAutocommit() })
        return transport.publishDecision(d)
      }
    }

    const result = await engine.publishRegistrationDecision(spyPublisher, b, { closesRequestId: a })
    expect(result.outcome).to.equal('published')
    expect(result.publishedStatus).to.equal('r')
    expect(result.closesRequestId).to.equal(a)
    expect(result.closure).to.equal('closed')
    expect(result.cursor).to.be.a('string')
    expect(result.closureCursor).to.be.a('string')

    const bRow = await rawDecision(fixture, b)
    expect(bRow?.Status).to.equal('r')
    expect(bRow?.ClosesRequestId).to.equal(a)
    expect(bRow?.Reason).to.equal('Could not verify')
    const aRow = await rawDecision(fixture, a)
    expect(aRow?.Status).to.equal('d')
    expect(aRow?.ClosesRequestId).to.equal(null)
    expect(aRow?.Reason).to.equal(null)
    expect(aRow?.DeciderKey).to.equal(bRow?.DeciderKey)

    expect(calls.map((c) => ({ requestId: c.requestId, status: c.status }))).to.deep.equal([
      { requestId: b, status: 'r' },
      { requestId: a, status: 'd' }
    ])
    expect(calls[1]!.autocommitAtCall).to.equal(true)

    const decisions = await transport.pollDecisions()
    const aDecision = decisions.find((d) => d.requestId === a)
    const bDecision = decisions.find((d) => d.requestId === b)
    expect(aDecision?.status).to.equal('r')
    expect(aDecision?.reason).to.equal(REGISTRATION_DUPLICATE_CLOSED_REASON)
    expect(bDecision?.status).to.equal('r')
    expect(bDecision?.reason).to.equal('Could not verify')

    const closureA = await engine.getDuplicateClosure(a)
    expect(closureA?.state).to.equal('closed')
    expect(closureA?.closedByRequestId).to.equal(b)
    expect(await engine.getLikelyDuplicateRequests(a)).to.deep.equal([])
    expect(await engine.listUnpublishedRegistrationDecisions(fixture.auth.authority.id)).to.deep.equal([])

    const before = {
      adminSigning: await countRows(fixture, 'select count(*) as n from AdminSigning'),
      officerSignature: await countRows(fixture, 'select count(*) as n from OfficerSignature'),
      decisions: await countRows(fixture, 'select count(*) as n from RegistrationDecision')
    }
    let caught: unknown
    try {
      await engine.rejectRegistrationRequest(a, { checklist: ['id'], rejectionReason: 'x' }, makeTestSignCallback(fixture.net.user))
    } catch (err) {
      caught = err
    }
    expect(caught).to.be.instanceOf(RegistrationDuplicateError)
    expect((caught as RegistrationDuplicateErrorInstance).code).to.equal('closed-as-duplicate')
    expect(await countRows(fixture, 'select count(*) as n from AdminSigning')).to.equal(before.adminSigning)
    expect(await countRows(fixture, 'select count(*) as n from OfficerSignature')).to.equal(before.officerSignature)
    expect(await countRows(fixture, 'select count(*) as n from RegistrationDecision')).to.equal(before.decisions)
    const aStatusRow = await fixture.db.prepare('select Status from RegistrationRequest where Id = :id').get({ id: a })
    expect(aStatusRow?.Status).to.equal('p')
  })

  // ---- D4: automatic choice ----

  it('D4: automatic choice closes the OLDEST flagged pending candidate received no later than the decision', async () => {
    const { requestId: deciding } = await submitPending(fixture, { firstName: 'Xan', lastName: 'Voss' })
    await wait(5)
    const { requestId: x } = await submitPending(fixture, { firstName: 'Xan', lastName: 'Voss' })
    await wait(5)
    const { requestId: y } = await submitPending(fixture, { firstName: 'Xan', lastName: 'Voss' })

    await rejectAs(fixture, deciding, 'reason')
    await wait(5)
    const { requestId: z } = await submitPending(fixture, { firstName: 'Xan', lastName: 'Voss' })

    const result = await engine.publishRegistrationDecision(publisher, deciding)
    expect(result.closesRequestId).to.equal(x)
    expect(result.closure).to.equal('closed')

    expect(await engine.getDuplicateClosure(z)).to.be.undefined
    expect(await engine.getDuplicateClosure(y)).to.be.undefined
  })

  // ---- D5: resume ----

  it('D5: an interrupted close resumes exactly once, and republishing is idempotent', async () => {
    const { requestId: target } = await submitPending(fixture, { firstName: 'Rin', lastName: 'Okafor' })
    await wait(5)
    const { requestId: surviving } = await submitPending(fixture, { firstName: 'Rin', lastName: 'Okafor' })
    await rejectAs(fixture, surviving, 'reason')

    let callCount = 0
    const flakyPublisher: RegistrationDecisionPublishPort = {
      authorityId: fixture.decisionSigner.authorityId,
      publishDecision: async (d) => {
        callCount += 1
        if (callCount === 2) {
          const err = new Error('simulated cursor exhaustion') as Error & { code?: string }
          err.code = 'cursor-exhausted'
          throw err
        }
        return transport.publishDecision(d)
      }
    }

    const result = await engine.publishRegistrationDecision(flakyPublisher, surviving, { closesRequestId: target })
    expect(result.outcome).to.equal('published')
    expect(result.closure).to.equal('pending-retry')
    expect(result.closureErrorCode).to.equal('cursor-exhausted')

    expect((await engine.getDuplicateClosure(target))?.state).to.equal('closing')

    const report = await engine.completeDuplicateClosures(publisher)
    expect(report.completed).to.deep.equal([target])
    expect(report.failed).to.deep.equal([])
    expect((await engine.getDuplicateClosure(target))?.state).to.equal('closed')

    const secondReport = await engine.completeDuplicateClosures(publisher)
    expect(secondReport.completed).to.deep.equal([])
    expect(secondReport.failed).to.deep.equal([])

    let republishCalled = false
    const spyPublisher: RegistrationDecisionPublishPort = {
      authorityId: fixture.decisionSigner.authorityId,
      publishDecision: async (d) => {
        republishCalled = true
        return transport.publishDecision(d)
      }
    }
    const republish = await engine.publishRegistrationDecision(spyPublisher, surviving)
    expect(republish.outcome).to.equal('already-published')
    expect(republish.closure).to.equal('already-closed')
    expect(republishCalled).to.equal(false)
  })

  // ---- D6: guards ----

  it('D6: every guard refuses with zero rows written, and the two success-without-close shapes report the right closure', async () => {
    async function expectRefused (fn: () => Promise<unknown>, code: string): Promise<void> {
      const before = await countRows(fixture, 'select count(*) as n from RegistrationDecision')
      let caught: unknown
      try {
        await fn()
      } catch (err) {
        caught = err
      }
      expect(caught, `expected a refusal with code ${code}`).to.be.instanceOf(RegistrationDuplicateError)
      expect((caught as RegistrationDuplicateErrorInstance).code).to.equal(code)
      expect(await countRows(fixture, 'select count(*) as n from RegistrationDecision')).to.equal(before)
    }

    const { requestId: pendingReq } = await submitPending(fixture, { firstName: 'Noa', lastName: 'Vance' })
    await expectRefused(() => engine.publishRegistrationDecision(publisher, pendingReq), 'request-not-decided')

    const { requestId: selfReq } = await submitPending(fixture, { firstName: 'Omar', lastName: 'Webb' })
    await rejectAs(fixture, selfReq, 'reason')
    await expectRefused(() => engine.publishRegistrationDecision(publisher, selfReq, { closesRequestId: selfReq }), 'self-closure')

    const { requestId: declined } = await submitPending(fixture, { firstName: 'Pia', lastName: 'Reyes' })
    await rejectAs(fixture, declined, 'reason')
    const { requestId: nonMatch } = await submitPending(fixture, { firstName: 'Zed', lastName: 'Kirk' })
    await expectRefused(() => engine.publishRegistrationDecision(publisher, declined, { closesRequestId: nonMatch }), 'not-a-likely-duplicate')

    const siblingAuthorityId = await addSiblingAuthority(fixture.auth, { scopes: ['vrg'] })
    const siblingPublisher: RegistrationDecisionPublishPort = { authorityId: siblingAuthorityId, publishDecision: (d) => transport.publishDecision(d) }
    const { requestId: mismatched } = await submitPending(fixture, { firstName: 'Quin', lastName: 'Tate' })
    await rejectAs(fixture, mismatched, 'reason')
    await expectRefused(() => engine.publishRegistrationDecision(siblingPublisher, mismatched), 'authority-mismatch')

    const { requestId: openTxnReq } = await submitPending(fixture, { firstName: 'Remy', lastName: 'Sato' })
    await rejectAs(fixture, openTxnReq, 'reason')
    await fixture.db.exec('BEGIN')
    try {
      await expectRefused(() => engine.publishRegistrationDecision(publisher, openTxnReq), 'transaction-open')
    } finally {
      await fixture.db.exec('ROLLBACK')
    }

    const { requestId: dbMismatchReq } = await submitPending(fixture, { firstName: 'Sana', lastName: 'Ueda' })
    await rejectAs(fixture, dbMismatchReq, 'reason')
    const dbMismatchPublisher: RegistrationDecisionPublishPort = {
      authorityId: fixture.decisionSigner.authorityId,
      publishDecision: async () => '0000000000000001'
    }
    await expectRefused(() => engine.publishRegistrationDecision(dbMismatchPublisher, dbMismatchReq), 'publisher-db-mismatch')

    const { requestId: noneReq } = await submitPending(fixture, { firstName: 'Toby', lastName: 'Vick' })
    await rejectAs(fixture, noneReq, 'reason')
    const noneResult = await engine.publishRegistrationDecision(publisher, noneReq, { closesRequestId: null })
    expect(noneResult.closure).to.equal('none')
    expect(noneResult.closesRequestId).to.be.undefined

    const { requestId: targetDecided } = await submitPending(fixture, { firstName: 'Uma', lastName: 'Wren' })
    await rejectAs(fixture, targetDecided, 'reason')
    const { requestId: deciderReq } = await submitPending(fixture, { firstName: 'Vik', lastName: 'Xu' })
    await rejectAs(fixture, deciderReq, 'reason')
    const skippedResult = await engine.publishRegistrationDecision(publisher, deciderReq, { closesRequestId: targetDecided })
    expect(skippedResult.closure).to.equal('skipped-target-decided')
    expect(skippedResult.closesRequestId).to.be.undefined
  })

  // ---- D7: the corrected 62-11 text ----

  it('D7: at vrg threshold 2, rejectRegistrationRequest refuses with the corrected D-11 text', async () => {
    const fx = await createThresholdAuthority()
    const thresholdEngine = new RegistrationEngine({ db: fx.elec.ctx.db, user: fx.holders[0]!.user })
    const { requestId } = await submitPendingAtThresholdAuthority(fx, { firstName: 'Wren', lastName: 'Zahn' })

    let caught: unknown
    try {
      await thresholdEngine.rejectRegistrationRequest(requestId, { checklist: ['id'], rejectionReason: 'x' }, fx.holders[0]!.sign)
    } catch (err) {
      caught = err
    }
    const message = (caught as Error).message
    expect(message).to.include('One officer cannot reject')
    expect(message).to.include('nothing was recorded')
    // Split across two literal fragments on purpose: a whole-file grep for the OLD sentence (this
    // plan's own acceptance gate) must find no occurrence anywhere under src/ or test/, including
    // inside this very assertion.
    expect(message).to.not.include('record your decision on the signature task' + ' instead')
  })

  // ---- D8: mock parity ----

  describe('D8: mock parity', () => {
    it('MockRegistrationEngine.getLikelyDuplicateRequests flags its seeded look-alike pending pair', async () => {
      const mock = new MockRegistrationEngine()
      const forA = await mock.getLikelyDuplicateRequests('fixture-request-pending-duplicate-a')
      expect(forA.map((c) => c.requestId)).to.deep.equal(['fixture-request-pending-duplicate-b'])
      const forB = await mock.getLikelyDuplicateRequests('fixture-request-pending-duplicate-b')
      expect(forB.map((c) => c.requestId)).to.deep.equal(['fixture-request-pending-duplicate-a'])
    })

    it('MockRegistrationEngine closure/unpublished reads resolve empty; publish/complete are CONTRACT STUBS', async () => {
      const mock = new MockRegistrationEngine()
      expect(await mock.getDuplicateClosure('any-id')).to.be.undefined
      expect(await mock.listUnpublishedRegistrationDecisions('any-authority')).to.deep.equal([])

      const stubPublisher: RegistrationDecisionPublishPort = { authorityId: 'x', publishDecision: async () => 'cursor' }
      let publishCaught: unknown
      try {
        await mock.publishRegistrationDecision(stubPublisher, 'any-id')
      } catch (err) {
        publishCaught = err
      }
      expect(publishCaught).to.be.instanceOf(Error)

      let completeCaught: unknown
      try {
        await mock.completeDuplicateClosures(stubPublisher)
      } catch (err) {
        completeCaught = err
      }
      expect(completeCaught).to.be.instanceOf(Error)
    })
  })

  // ---- Privacy (T-62-01-10) ----

  it('privacy: no RegistrationDuplicateError message or result object ever carries a dob/email/phone value', async () => {
    const secretDob = '1990-02-03'
    const secretEmail = 'privacy-marker@example.com'
    const secretPhone = '5550192834'

    const { requestId: a } = await submitPending(fixture, { firstName: 'Priv', lastName: 'Acy', dob: secretDob, email: secretEmail, phone: secretPhone })
    await wait(5)
    const { requestId: b } = await submitPending(fixture, { firstName: 'Priv', lastName: 'Acy', dob: secretDob, email: secretEmail, phone: secretPhone })

    const haystacks: string[] = []
    haystacks.push(JSON.stringify(await engine.getLikelyDuplicateRequests(a)))
    haystacks.push(JSON.stringify(await engine.getLikelyDuplicateRequests(b)))

    await rejectAs(fixture, b, 'reason')
    const publishResult = await engine.publishRegistrationDecision(publisher, b, { closesRequestId: a })
    haystacks.push(JSON.stringify(publishResult))

    let caught: unknown
    try {
      await engine.rejectRegistrationRequest(a, { checklist: ['id'], rejectionReason: 'x' }, makeTestSignCallback(fixture.net.user))
    } catch (err) {
      caught = err
    }
    expect(caught).to.be.instanceOf(RegistrationDuplicateError)
    haystacks.push((caught as Error).message)
    haystacks.push(JSON.stringify(await engine.getDuplicateClosure(a)))

    const combined = haystacks.join('\n')
    expect(combined).to.not.include(secretDob)
    expect(combined).to.not.include(secretEmail)
    expect(combined).to.not.include(secretPhone)
  })
})
