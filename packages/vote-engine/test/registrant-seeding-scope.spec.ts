/**
 * registrant-seeding-scope.spec.ts — Phase 48 Plan 30 (CR-01)
 *
 * `seedRegistrantSignatureTasks` (signature-tasks-engine.ts) pulls EVERY pending
 * `RegistrationRequest` in the local DB with no authority predicate, and isolates only the
 * missing-`CurrentAdmin` case. Because D-02 deliberately makes intake unauthenticated, a single
 * request naming any locally-known `Authority` the signed-in officer does not serve fails
 * `AdminSigning.UserIdValid`, propagates out of the loop and out of `getRequestedSignatures`'s
 * try, and is rethrown — permanently disabling `TasksScreen` for that officer, for ALL signature
 * types, re-firing on every mount because the offending row stays `'p'`.
 *
 * This suite proves three things against the REAL Quereus schema and the REAL engine:
 *   1. scope   — a request addressed to an authority the signed-in officer does not serve is
 *                never seeded, and never blocks a request at the officer's own authority.
 *   2. isolation — a per-row failure never aborts the batch; the failure is transient, not
 *                permanent.
 *   3. inbox availability — getRequestedSignatures(true) resolves and still returns every other
 *                signature type's tasks while an un-seedable request is pending.
 *
 * NOT proven here: that TasksScreen renders on a device, or that the new scoping predicate
 * matches a real device's Officer/CurrentAdmin history — both are 48-32's concern.
 */

import { expect } from 'chai'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js'
import {
  createTestNetwork,
  addTestAuthority,
  addTestElection,
  seedAuthorityInvite,
  seedUserInvite,
  seedProposedBallot,
  makeDistinctTestUser,
} from './fixtures/test-context.js'
import type { TestAuthorityContext } from './fixtures/test-context.js'
import { randomTestKeyPair } from './fixtures/keys.js'
import type { TestKeyPair } from './fixtures/keys.js'
import { toIsoZDatetime } from '../src/signing/ceremony-helpers.js'
import { RegistrationEngine } from '../src/registration/registration-engine.js'
import { SignatureTasksEngine } from '../src/tasks/signature-tasks-engine.js'
import type { EngineContext } from '../src/types.js'
import type {
  RegisterInit,
  RegistrationRequestInit,
  BallotSignatureTask,
  SignatureTask,
  Signature,
  Scope,
  User,
} from '@votetorrent/vote-core'

// ---------------------------------------------------------------------------
// Module-level helpers — mirrors registrant-approval.spec.ts's module-local set
// (that spec keeps its own copies module-local; not exported for reuse).
// ---------------------------------------------------------------------------

function makeNetworkRef () {
  return {
    hash: 'test-registrant-seeding-scope-hash',
    name: 'Test Network',
    relays: [] as string[],
    primaryAuthorityDomainName: 'test.example',
  }
}

async function setup (): Promise<TestAuthorityContext> {
  const net = await createTestNetwork()
  return addTestAuthority(net)
}

/**
 * WR-10 prehash contract: `secp256k1.sign(digest, priv)` with NO explicit `prehash` option,
 * relying on @noble/curves v2's default (`prehash:true`) — matches
 * `registrant-approval.spec.ts`'s own helper. Deliberately returns `signerUserId: ''` — a
 * prospective registrant has no user id.
 */
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

/**
 * Submits one pending RegistrationRequest through the REAL engine method (D-02 intake, 48-07).
 * Unlike registrant-approval.spec.ts's version, this accepts an explicit `authorityId` override
 * so a request can be addressed to an authority OTHER than `auth.authority.id` — the CR-01 case.
 * Forward-compat with 48-31 (payload.registrant.authorityId must equal the request's
 * AuthorityId): `makeTestPayload` is always called with the SAME `authorityId`.
 */
async function submitPendingRequest (
  auth: TestAuthorityContext,
  opts?: {
    authorityId?: string
    issuerType?: 'registrant' | 'bridge'
    bridgeId?: string
    requesterKey?: TestKeyPair
    registrantId?: string
  }
): Promise<{ requestId: string; requester: TestKeyPair; init: RegistrationRequestInit }> {
  const requester = opts?.requesterKey ?? randomTestKeyPair()
  const authorityId = opts?.authorityId ?? auth.authority.id
  const engine = new RegistrationEngine(auth.ctx)
  const init: RegistrationRequestInit = {
    id: crypto.randomUUID(),
    authorityId,
    payload: makeTestPayload(authorityId, opts?.registrantId),
    submittedAt: toIsoZDatetime(Date.now()),
    issuerType: opts?.issuerType,
    bridgeId: opts?.bridgeId,
  }
  const requestId = await engine.submitRegistrationRequest(init, requester.publicHex, makeCallbackSigner(requester))
  return { requestId, requester, init }
}

async function countRows (ctx: EngineContext, sql: string, params: Record<string, unknown> = {}): Promise<number> {
  const row = await ctx.db.prepare(sql).get(params as Record<string, unknown>)
  return Number(row?.n ?? 0)
}

async function extensionCount (ctx: EngineContext, requestId: string): Promise<number> {
  return countRows(
    ctx,
    `select count(*) as n from RegistrantSignatureTaskExtension E
       join RegistrationRequest R on R.Id = E.RequestId
       where R.Id = :requestId`,
    { requestId }
  )
}

/**
 * Materializes a SECOND, genuinely foreign authority: a real `User` row for a brand-new officer
 * (via the `seedUserInvite` recipe, test/user.spec.ts:142-160), a real authority-invite ceremony
 * (`seedAuthorityInvite`, mirroring test/registration.spec.ts:830-850's "Forger Authority"
 * recipe), and a `createAuthority` call issued through a NetworkEngine bound to the FOREIGN
 * user's own EngineContext — NOT `auth`'s.
 *
 * `NetworkEngine.createAuthority` binds every inserted Officer row's UserId to `ctx.user.id` of
 * WHOEVER CALLS IT (a real, documented v1.2 limitation — `OfficerInit` carries no per-officer
 * userId), so routing the call through `auth.networkEngine` (as the Forger-Authority recipe does
 * verbatim) would make `auth.user` an officer of the new authority too — the OPPOSITE of what
 * this suite needs. `networksEngine.open(ref, foreignUser, false)` returns a NetworkEngine bound
 * to a fresh EngineContext sharing the SAME underlying `db`, with `ctx.user = foreignUser` — that
 * is the context this helper uses for the `createAuthority` call, so the foreign authority's real
 * Officer row lands under `foreignUser.id`, and `auth.user` never becomes an officer there.
 */
async function createForeignAuthority (
  auth: TestAuthorityContext
): Promise<{ foreignAuthorityId: string; foreignUser: User }> {
  const foreignUser = makeDistinctTestUser()

  // Seed the foreign officer's real User row (test/user.spec.ts:142-160 recipe).
  const { inviteSlotCid, inviteSignature } = await seedUserInvite(auth, foreignUser)
  const userTid = Date.now() + Math.floor(Math.random() * 100_000)
  await auth.ctx.db.exec(
    `insert into User (Id, Name, ImageRef)
     with context SigningNonce = null, InviteSlotCid = :inviteSlotCid, InviteSignature = :inviteSignature, Tid = ${userTid}
     values (:userId, :userName, :userImageRef)`,
    {
      userId: foreignUser.id,
      userName: foreignUser.name,
      userImageRef: foreignUser.imageRef ? JSON.stringify(foreignUser.imageRef) : null,
      inviteSlotCid,
      inviteSignature,
    }
  )

  // Real authority-invite ceremony naming the foreign officer (test/registration.spec.ts:830-850).
  const inviteCtx = await seedAuthorityInvite(auth, {
    name: 'Foreign Authority',
    domainName: 'foreign.example.com',
    officers: [{ userId: foreignUser.id, title: 'Chair', scopes: JSON.stringify(['rad']) }],
  })

  // Route createAuthority through the FOREIGN user's own context (see doc comment above) so the
  // real Officer row this inserts is bound to foreignUser.id, not auth.user.id.
  const foreignNetworkEngine = await auth.networksEngine.open(auth.ref, foreignUser, false)
  await foreignNetworkEngine.createAuthority(
    { name: 'Foreign Authority', domainName: 'foreign.example.com' },
    {
      officers: [{ init: { name: 'Foreign Officer', title: 'Chair', scopes: ['rad'] as Scope[] } }],
      effectiveAt: inviteCtx.adminEffectiveAt,
      thresholdPolicies: [{ policy: 'rad', threshold: 1 }],
    },
    { inviteSlotCid: inviteCtx.inviteSlotCid, inviteSignature: 'a'.repeat(128) }
  )

  const forgerRow = await auth.ctx.db
    .prepare('select Id from Authority where Name = :n')
    .get({ n: 'Foreign Authority' })
  const foreignAuthorityId = forgerRow!.Id as string
  expect(foreignAuthorityId).to.be.a('string').and.not.equal(auth.authority.id)

  return { foreignAuthorityId, foreignUser }
}

// ---------------------------------------------------------------------------

describe('registrant task seeding — authority scope and per-row isolation (CR-01)', () => {
  it('does not seed a request addressed to an authority the signed-in officer does not serve', async () => {
    const auth = await setup()
    const selfUserId = auth.user.id

    const { foreignAuthorityId } = await createForeignAuthority(auth)

    // Fixture-integrity assertions — these must hold BEFORE any behavioural assertion is made.
    const officerCount = await countRows(
      auth.ctx,
      'select count(*) as n from Officer where AuthorityId = :authorityId and UserId = :userId',
      { authorityId: foreignAuthorityId, userId: selfUserId }
    )
    expect(officerCount, 'fixture integrity: the signed-in officer must NOT be an Officer at the foreign authority').to.equal(0)

    const currentAdminCount = await countRows(
      auth.ctx,
      'select count(*) as n from CurrentAdmin where AuthorityId = :authorityId',
      { authorityId: foreignAuthorityId }
    )
    expect(currentAdminCount, 'fixture integrity: the foreign authority must have exactly one CurrentAdmin row').to.equal(1)

    // One pending request at the foreign authority, one at the officer's own authority.
    const { requestId: foreignRequestId } = await submitPendingRequest(auth, { authorityId: foreignAuthorityId })
    const { requestId: ownRequestId } = await submitPendingRequest(auth, { authorityId: auth.authority.id })

    const engine = new SignatureTasksEngine(makeNetworkRef(), auth.ctx)
    let rejected = false
    let rejectionMessage = ''
    try {
      await engine.getRequestedSignatures(true)
    } catch (err) {
      rejected = true
      rejectionMessage = err instanceof Error ? err.message : String(err)
    }
    expect(
      rejected,
      `getRequestedSignatures(true) must resolve, not reject, while a foreign-authority request is pending (got: ${rejectionMessage})`
    ).to.be.false

    const ownCount = await extensionCount(auth.ctx, ownRequestId)
    expect(ownCount, 'the own-authority request must be seeded exactly once').to.equal(1)

    const foreignCount = await extensionCount(auth.ctx, foreignRequestId)
    expect(foreignCount, 'the foreign-authority request must never be seeded').to.equal(0)

    const foreignStatusRow = await auth.ctx.db
      .prepare('select Status from RegistrationRequest where Id = :id')
      .get({ id: foreignRequestId })
    expect(foreignStatusRow?.Status, 'the foreign-authority request must remain pending').to.equal('p')

    const foreignAdminSigningCount = await countRows(
      auth.ctx,
      "select count(*) as n from AdminSigning where AuthorityId = :authorityId and Scope = 'vrg'",
      { authorityId: foreignAuthorityId }
    )
    expect(foreignAdminSigningCount, 'no AdminSigning attempt may ever be made at the foreign authority').to.equal(0)
  })

  it('isolates a per-row failure so the remaining pending requests still seed', async () => {
    const auth = await setup()
    const { requestId: id1 } = await submitPendingRequest(auth)
    const { requestId: id2 } = await submitPendingRequest(auth)

    const dbHandle = auth.ctx.db as unknown as { exec: (sql: string, params?: Record<string, unknown>) => Promise<unknown> }
    const origExec = dbHandle.exec.bind(auth.ctx.db)
    let faulted = false
    dbHandle.exec = async (sql: string, params?: Record<string, unknown>): Promise<unknown> => {
      if (!faulted && sql.includes('insert into AdminSigning')) {
        faulted = true
        dbHandle.exec = origExec
        throw new Error('forced per-row seeding fault')
      }
      return origExec(sql, params)
    }

    try {
      const engine = new SignatureTasksEngine(makeNetworkRef(), auth.ctx)
      let rejected = false
      let rejectionMessage = ''
      try {
        await engine.getRequestedSignatures(true)
      } catch (err) {
        rejected = true
        rejectionMessage = err instanceof Error ? err.message : String(err)
      }
      expect(
        rejected,
        `getRequestedSignatures(true) must resolve even with a forced per-row fault (got: ${rejectionMessage})`
      ).to.be.false

      const firstPullCount = (await extensionCount(auth.ctx, id1)) + (await extensionCount(auth.ctx, id2))
      expect(firstPullCount, 'exactly one of the two pending requests must seed on the SAME call as the fault').to.equal(1)

      // Second pull, no fault installed — the failed row must seed now (transient, not permanent).
      await engine.getRequestedSignatures(true)
      const secondPullCount1 = await extensionCount(auth.ctx, id1)
      const secondPullCount2 = await extensionCount(auth.ctx, id2)
      expect(secondPullCount1, 'request 1 must be seeded by the second, unfaulted pull').to.equal(1)
      expect(secondPullCount2, 'request 2 must be seeded by the second, unfaulted pull').to.equal(1)
    } finally {
      dbHandle.exec = origExec
    }
  })

  it('keeps every other signature type visible while an unseedable request is pending', async () => {
    const auth = await setup()
    const elec = await addTestElection(auth)
    const { ballotId } = await seedProposedBallot(elec)
    await elec.electionEngine.submitBallotForConfirmation(ballotId)

    const { foreignAuthorityId } = await createForeignAuthority(elec)
    await submitPendingRequest(elec, { authorityId: foreignAuthorityId })

    const engine = new SignatureTasksEngine(makeNetworkRef(), elec.ctx)
    const tasks: SignatureTask[] = await engine.getRequestedSignatures(true)

    const ballotTask = tasks.find(
      (t) => t.signatureType === 'ballot' && (t as BallotSignatureTask).ballot.proposed.id === ballotId
    ) as BallotSignatureTask | undefined
    expect(
      ballotTask,
      'the ballot signature task must still be visible while a foreign-authority request sits unseedable'
    ).to.not.be.undefined
    expect(ballotTask?.ballot.proposed.id).to.equal(ballotId)
  })
})
