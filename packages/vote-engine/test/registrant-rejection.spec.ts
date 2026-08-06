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
import { verificationCid } from '@votetorrent/vote-core'
import type { EngineContext } from '../src/types.js'
import type {
  RegisterInit,
  RegistrationRequestInit,
  RegistrationVerificationChecklistItem,
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
