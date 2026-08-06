/**
 * registrant-rejection.spec.ts — Phase 48 Plan 12 (D-06, D-07)
 *
 * Proves the D-06 rejection ceremony end-to-end against the REAL Quereus schema with REAL
 * secp256k1 signatures, and the no-sign discipline that makes it safe.
 *
 * A rejection is permanent because that permanence is what lets an applicant be told why, lets
 * a re-application carry its own history (`getPriorRejections`), and makes D-09's transparency
 * counts mean anything (D-06) — a rejection that left no trace would be indistinguishable from a
 * request that was never reviewed.
 *
 * These assertions prove the RECORD and its REACHABILITY, not scope enforcement — the `'vrg'`
 * gate on `DecisionValid` is a data-model label, not an enforced boundary (Phase 999.1).
 * `AdminSigning.SignerKeyValid`/`OfficerSignature.OfficerValid` are hardcoded stub CHECKs, and
 * `AdminSigning.UserIdValid` only requires the signer be SOME officer at that authority.
 */

import 'reflect-metadata'
import { expect } from 'chai'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js'
import { createTestNetwork, addTestAuthority, makeTestSignCallback } from './fixtures/test-context.js'
import { randomTestKeyPair } from './fixtures/keys.js'
import type { TestKeyPair } from './fixtures/keys.js'
import { toIsoZDatetime } from '../src/signing/ceremony-helpers.js'
import { RegistrationEngine } from '../src/registration/registration-engine.js'
import { SignatureTasksEngine } from '../src/tasks/signature-tasks-engine.js'
import { SigningEngine } from '../src/signing/signing-engine.js'
import { verificationCid } from '@votetorrent/vote-core'
import type { EngineContext } from '../src/types.js'
import type {
  ISigningEngine,
  RegisterInit,
  RegistrationRequestInit,
  RegistrationVerificationChecklistItem,
  RegistrantSignatureTask,
  Signature,
} from '@votetorrent/vote-core'

type TestAuthority = Awaited<ReturnType<typeof addTestAuthority>>

// ---------------------------------------------------------------------------
// Module-level helpers (mirrors registrant-approval.spec.ts's shape)
// ---------------------------------------------------------------------------

function makeNetworkRef () {
  return {
    hash: 'test-registrant-rejection-hash',
    name: 'Test Network',
    relays: [] as string[],
    primaryAuthorityDomainName: 'test.example',
  }
}

async function setup (): Promise<TestAuthority> {
  const net = await createTestNetwork()
  return addTestAuthority(net)
}

/** WR-10 prehash contract: mirrors authority-transport.spec.ts / registrant-approval.spec.ts. */
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

/** Submits one pending RegistrationRequest through the REAL engine method (D-02 intake, 48-07). */
async function submitPendingRequest (
  auth: TestAuthority,
  opts?: { requesterKey?: TestKeyPair; registrantId?: string }
): Promise<{ requestId: string; requester: TestKeyPair; init: RegistrationRequestInit }> {
  const requester = opts?.requesterKey ?? randomTestKeyPair()
  const engine = new RegistrationEngine(auth.ctx)
  const init: RegistrationRequestInit = {
    id: crypto.randomUUID(),
    authorityId: auth.authority.id,
    payload: makeTestPayload(auth.authority.id, opts?.registrantId),
    submittedAt: toIsoZDatetime(Date.now()),
  }
  const requestId = await engine.submitRegistrationRequest(init, requester.publicHex, makeCallbackSigner(requester))
  return { requestId, requester, init }
}

async function countRows (ctx: EngineContext, sql: string, params: Record<string, unknown> = {}): Promise<number> {
  const row = await ctx.db.prepare(sql).get(params as Record<string, unknown>)
  return Number(row?.n ?? 0)
}

/** The digest primitive the read surface/rejection ceremony both use — the SAME cid(Digest(...)) call shape. */
async function computeChecklistCidFor (ctx: EngineContext, canonical: string): Promise<string> {
  const row = await ctx.db.prepare('select cid(Digest(:canonical)) as c').get({ canonical })
  if (!row || row.c == null) {
    throw new Error('computeChecklistCidFor: cid(Digest(...)) returned null — crypto plugin not registered?')
  }
  return row.c as string
}

/** Runs the real rejectRegistrationRequest ceremony under the fixture officer's REAL secp256k1 key. */
async function rejectRequest (
  auth: TestAuthority,
  requestId: string,
  opts?: { rejectionReason?: string; checklist?: RegistrationVerificationChecklistItem[] }
): Promise<void> {
  const engine = new RegistrationEngine(auth.ctx)
  await engine.rejectRegistrationRequest(
    requestId,
    { checklist: opts?.checklist ?? ['id'], rejectionReason: opts?.rejectionReason ?? 'Photo ID did not match the roll entry' },
    makeTestSignCallback(auth.user)
  )
}

// ---------------------------------------------------------------------------

describe('rejectRegistrationRequest', () => {
  it('rejects a pending request by a real signer, landing Status=r with all four decision columns non-null', async () => {
    const auth = await setup()
    const { requestId } = await submitPendingRequest(auth)

    await rejectRequest(auth, requestId, { rejectionReason: 'Photo ID did not match the roll entry' })

    const row = await auth.ctx.db
      .prepare('select Status, RejectionReason, DecidingOfficerUserId, DecidedAt, VerificationCid from RegistrationRequest where Id = :id')
      .get({ id: requestId })
    expect(row!.Status).to.equal('r')
    expect(row!.RejectionReason, 'RejectionReason must be non-null').to.equal('Photo ID did not match the roll entry')
    expect(row!.DecidingOfficerUserId, 'DecidingOfficerUserId must be non-null').to.equal(auth.user.id)
    expect(row!.DecidedAt, 'DecidedAt must be non-null').to.be.a('string').and.not.equal('')
    expect(row!.VerificationCid, 'VerificationCid must be non-null').to.be.a('string').and.not.equal('')
  })

  it('persists a VerificationCid equal to verificationCid(decision.checklist, <db digest>) recomputed independently', async () => {
    const auth = await setup()
    const { requestId } = await submitPendingRequest(auth)
    const checklist: RegistrationVerificationChecklistItem[] = ['id', 'roll']

    await rejectRequest(auth, requestId, { checklist })

    const row = await auth.ctx.db.prepare('select VerificationCid from RegistrationRequest where Id = :id').get({ id: requestId })
    const expectedCid = await verificationCid(checklist, async (canonical) => computeChecklistCidFor(auth.ctx, canonical))
    expect(row!.VerificationCid).to.equal(expectedCid)
  })

  it('throws on an empty/whitespace-only rejectionReason, leaving Status still p', async () => {
    const auth = await setup()
    const { requestId } = await submitPendingRequest(auth)

    let threw = false
    try {
      await rejectRequest(auth, requestId, { rejectionReason: '   ' })
    } catch {
      threw = true
    }
    expect(threw, 'a whitespace-only rejectionReason must throw').to.be.true

    const row = await auth.ctx.db.prepare('select Status from RegistrationRequest where Id = :id').get({ id: requestId })
    expect(row!.Status, 'the request must remain pending after a rejected-reason rejection').to.equal('p')
  })

  it('throws on an unknown requestId', async () => {
    const auth = await setup()
    let threw = false
    try {
      await rejectRequest(auth, 'no-such-request-id')
    } catch {
      threw = true
    }
    expect(threw, 'rejecting an unknown requestId must throw').to.be.true
  })

  it('throws on rejecting an already-decided request, leaving the stored RejectionReason unchanged', async () => {
    const auth = await setup()
    const { requestId } = await submitPendingRequest(auth)
    await rejectRequest(auth, requestId, { rejectionReason: 'Original reason' })

    let threw = false
    try {
      await rejectRequest(auth, requestId, { rejectionReason: 'Second attempt reason' })
    } catch {
      threw = true
    }
    expect(threw, 'rejecting an already-decided request must throw').to.be.true

    const row = await auth.ctx.db.prepare('select RejectionReason from RegistrationRequest where Id = :id').get({ id: requestId })
    expect(row!.RejectionReason, 'the ORIGINAL reason must survive a rejected second decision attempt').to.equal('Original reason')
  })
})

// ---------------------------------------------------------------------------
// Task 2 — the no-sign discipline: both negatives, asserted explicitly
// ---------------------------------------------------------------------------

/** Finds the seeded RegistrantSignatureTask for a given requestId out of a pending pull. */
async function getRegistrantTask (engine: SignatureTasksEngine, requestId: string): Promise<RegistrantSignatureTask> {
  const tasks = await engine.getRequestedSignatures(true)
  const found = tasks.find(
    (t) => t.signatureType === 'registrant' && (t as RegistrantSignatureTask).requestId === requestId
  ) as RegistrantSignatureTask | undefined
  expect(found, `registrant task for requestId=${requestId} must be present`).to.not.be.undefined
  return found!
}

/**
 * Wraps a real SigningEngine's `sign` method in a counting proxy — every OTHER ISigningEngine
 * method delegates untouched via Reflect. This is the literal "wrap the engine's signingEngine.sign
 * in a counting proxy" the plan specifies, constructed through SignatureTasksEngine's own
 * constructor-injected `signingEngine` field (48-11's documented injection seam).
 */
function makeCountingSigningEngine (ctx: EngineContext): { engine: ISigningEngine; counter: { calls: number } } {
  const real = new SigningEngine(ctx)
  const counter = { calls: 0 }
  const engine = new Proxy(real, {
    get (target, prop, receiver) {
      if (prop === 'sign') {
        return async (...args: Parameters<ISigningEngine['sign']>) => {
          counter.calls += 1
          return target.sign(...args)
        }
      }
      return Reflect.get(target, prop, receiver)
    }
  }) as unknown as ISigningEngine
  return { engine, counter }
}

describe('completeSignature — registrant reject path', () => {
  it('sign() is never called on reject — and DOES record 1 call on an accept control run, so the spy cannot pass vacuously', async () => {
    const auth = await setup()
    const { requestId } = await submitPendingRequest(auth)
    const { engine: countingSigningEngine, counter } = makeCountingSigningEngine(auth.ctx)
    const tasksEngine = new SignatureTasksEngine(makeNetworkRef(), auth.ctx, countingSigningEngine)
    await tasksEngine.getRequestedSignatures(true)

    const officerSign = makeTestSignCallback(auth.user)
    const task = await getRegistrantTask(tasksEngine, requestId)
    const digestBytes = await tasksEngine.getSignatureDigest(task)
    const headerSignature = await officerSign(digestBytes)

    // asserting only `status === 'r'` here would pass against code that signed anyway — this
    // spec asserts the ABSENCE of the sign() side-effect, not the presence of a status value.
    await tasksEngine.completeSignature(task, { isAccepted: false, signature: headerSignature })

    const signCalls = counter.calls
    expect(signCalls, 'sign() must be called exactly 0 times on reject').to.equal(0)

    // Control run: a fresh pending request, ACCEPTED, on the SAME counting proxy — proves the
    // spy itself is a live signal, not a permanently-broken counter that would pass vacuously
    // either way.
    const { requestId: controlRequestId } = await submitPendingRequest(auth)
    await tasksEngine.getRequestedSignatures(true)
    const controlTask = await getRegistrantTask(tasksEngine, controlRequestId)
    const controlDigest = await tasksEngine.getSignatureDigest(controlTask)
    const controlHeaderSig = await officerSign(controlDigest)
    await tasksEngine.completeSignature(controlTask, {
      isAccepted: true,
      signature: controlHeaderSig,
      sign: officerSign,
      decision: { checklist: ['id'] },
    })
    expect(counter.calls, 'the SAME wrapper DOES record 1 call on an isAccepted:true control run').to.equal(1)
  })

  it('no AdminSignature advance on reject — the count delta is exactly 0', async () => {
    const auth = await setup()
    const { requestId } = await submitPendingRequest(auth)
    const tasksEngine = new SignatureTasksEngine(makeNetworkRef(), auth.ctx)
    await tasksEngine.getRequestedSignatures(true)

    const officerSign = makeTestSignCallback(auth.user)
    const task = await getRegistrantTask(tasksEngine, requestId)
    const digestBytes = await tasksEngine.getSignatureDigest(task)
    const headerSignature = await officerSign(digestBytes)
    const nonceRow = await auth.ctx.db
      .prepare(
        `select Task.SigningNonce from Task join RegistrantSignatureTaskExtension E on E.TaskId = Task.Id where E.RequestId = :requestId`
      )
      .get({ requestId })
    const nonce = nonceRow!.SigningNonce as string

    const before = await countRows(auth.ctx, 'select count(*) as n from AdminSignature where SigningNonce = :nonce', { nonce })
    await tasksEngine.completeSignature(task, { isAccepted: false, signature: headerSignature })
    const after = await countRows(auth.ctx, 'select count(*) as n from AdminSignature where SigningNonce = :nonce', { nonce })

    const adminSignatureDelta = after - before
    expect(adminSignatureDelta, 'the vrg AdminSigning session must not advance on a rejection').to.equal(0)
  })

  it('register() is never reached — a prototype spy on RegistrationEngine.register AND zero new Registrant rows', async () => {
    const auth = await setup()
    const { requestId, init } = await submitPendingRequest(auth)
    const tasksEngine = new SignatureTasksEngine(makeNetworkRef(), auth.ctx)
    await tasksEngine.getRequestedSignatures(true)

    const officerSign = makeTestSignCallback(auth.user)
    const task = await getRegistrantTask(tasksEngine, requestId)
    const digestBytes = await tasksEngine.getSignatureDigest(task)
    const headerSignature = await officerSign(digestBytes)

    // Prototype spy: finalizeRegistrantApproval constructs `new RegistrationEngine(ctx)` and calls
    // `.register(...)` directly (no DI seam) — a prototype patch is the only way to observe the
    // CALL without altering the code path itself. Always restored, even on assertion failure.
    let registerCalls = 0
    const originalRegister = RegistrationEngine.prototype.register
    RegistrationEngine.prototype.register = async function (this: RegistrationEngine, ...args: Parameters<typeof originalRegister>) {
      registerCalls += 1
      return originalRegister.apply(this, args)
    } as typeof originalRegister

    try {
      await tasksEngine.completeSignature(task, { isAccepted: false, signature: headerSignature })
    } finally {
      RegistrationEngine.prototype.register = originalRegister
    }

    // The spy proves the CODE PATH; the row count proves the OUTCOME and survives any future
    // refactor of how the register() reference is injected.
    expect(registerCalls, 'register() must be reached exactly 0 times on reject').to.equal(0)

    const anyRegistrant = await auth.ctx.db.prepare('select 1 as x from Registrant where Id = :id').get({ id: init.payload.registrant.id })
    expect(anyRegistrant, 'no Registrant row may exist for a rejected request').to.be.undefined
  })

  it('the task still closes — the discipline forbids advancing the signature, not closing the task', async () => {
    const auth = await setup()
    const { requestId } = await submitPendingRequest(auth)
    const tasksEngine = new SignatureTasksEngine(makeNetworkRef(), auth.ctx)
    await tasksEngine.getRequestedSignatures(true)

    const officerSign = makeTestSignCallback(auth.user)
    const task = await getRegistrantTask(tasksEngine, requestId)
    const digestBytes = await tasksEngine.getSignatureDigest(task)
    const headerSignature = await officerSign(digestBytes)

    await tasksEngine.completeSignature(task, { isAccepted: false, signature: headerSignature })

    const taskRow = await auth.ctx.db
      .prepare(`select Task.IsCompleted from Task join RegistrantSignatureTaskExtension E on E.TaskId = Task.Id where E.RequestId = :requestId`)
      .get({ requestId })
    expect(Number(taskRow!.IsCompleted), 'a rejected task must still close').to.equal(1)
  })
})
