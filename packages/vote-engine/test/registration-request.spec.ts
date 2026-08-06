/**
 * registration-request.spec.ts — Phase 48 Plan 04 (D-02, D-03, D-05)
 *
 * Drives the REAL Quereus schema landed by 48-02 through raw SQL — no engine method exists yet
 * at wave 3 (`RegistrationEngine.submitRegistrationRequest` / `registerBridgeKey` and the
 * `'registrant'` `SignatureTasksEngine` branch land in 48-07/48-11, both AFTER this plan). This
 * file is deliberately scheduled EARLY to resolve RESEARCH Pitfall 2 / assumption A4 — whether a
 * `SignatureType='registrant'` Task can even be inserted — before any ceremony, transport, or
 * screen work is built on top of it.
 *
 * Covers:
 *   (a) D-05 / A4 — a 'registrant' Task + RegistrantSignatureTaskExtension pairing COMMITS.
 *   (b) D-05 regression — the amended Task.ExtensionExists still rejects all six pre-existing
 *       pairings, plus a crossed pairing.
 *   (c) D-02 — RegistrationRequest.SignatureValid accepts a genuine requester signature from a
 *       key with no User row, and rejects tampering.
 *   (d) D-03 — BridgeIdValid accepts a registered bridge key only, and machine-distinguishes a
 *       bridge assertion from a registrant's own act.
 *
 * ESCALATION RULE (carried verbatim from the plan): if the FIRST test below
 * ("commits a Task with SignatureType='registrant' ...") fails, RESEARCH assumption A4 is
 * REFUTED — this is a BLOCKING FINDING for the phase, not a test bug. Do NOT weaken the
 * assertion, do NOT add `.skip`, and do NOT edit `votetorrent.qsql`, `schema-sql.ts`, or any
 * engine source to make it pass. Record the exact Quereus error, the failing SQL, and the
 * `view SignatureType` row ordering in the plan SUMMARY under a `## BLOCKING FINDING` heading and
 * stop the plan there.
 */

import 'reflect-metadata'
import { expect } from 'chai'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js'
import { createTestNetwork, addTestAuthority, seedSignedMutation, makeTestSignature } from './fixtures/test-context.js'
import { randomTestKeyPair } from './fixtures/keys.js'
import { digestToBytes, nowCanonicalDatetime } from '../src/utils.js'
import { toIsoZDatetime } from '../src/signing/ceremony-helpers.js'

type TestAuthority = Awaited<ReturnType<typeof addTestAuthority>>

// ---------------------------------------------------------------------------
// Module-level helpers
// ---------------------------------------------------------------------------

/**
 * WR-10 prehash contract: `secp256k1.sign(bytes, priv)` with NO explicit `prehash` option relies
 * on @noble/curves v2's default (`prehash:true`) — identical to `authority-transport.spec.ts:31-40`.
 * Any divergence from this exact call shape diverges from every other verifier in the codebase.
 *
 * Deliberately returns a bare hex signature string, not a `Signature` object — a prospective
 * registrant has no `signerUserId`, which is the D-02 point this whole spec exists to prove.
 */
function makeRequesterSigner (): { publicHex: string; signDigest: (digestBase64url: string) => string } {
  const { privateHex, publicHex } = randomTestKeyPair()
  const privBytes = hexToBytes(privateHex)
  const signDigest = (digestBase64url: string): string => {
    const digestBytes = digestToBytes(digestBase64url)
    return bytesToHex(secp256k1.sign(digestBytes, privBytes))
  }
  return { publicHex, signDigest }
}

interface SeedRegistrationRequestOverrides {
  /** External signer to use instead of a freshly-generated one — e.g. a registered bridge key. */
  signer?: { publicHex: string; signDigest: (digestBase64url: string) => string }
  issuerType?: string
  bridgeId?: string | null
  /** Deliberately bind a RequesterKey different from whoever actually signed — wrong-key negative tests. */
  requesterKey?: string
  /** Deliberately bind a RequesterSignature that was not produced over the row's own digest — tamper negative tests. */
  signature?: string
  payload?: string
  payloadCid?: string
}

interface SeedRegistrationRequestResult {
  id: string
  requesterKey: string
  signer: { publicHex: string; signDigest: (digestBase64url: string) => string }
}

/**
 * Insert one `RegistrationRequest` row by raw SQL (D-02: no `User` FK, no `IsUserValid`, no
 * officer ceremony required to submit). `overrides` lets Task 3's negative cases substitute a
 * single field without duplicating this helper.
 */
async function seedRegistrationRequest (
  auth: TestAuthority,
  overrides?: SeedRegistrationRequestOverrides
): Promise<SeedRegistrationRequestResult> {
  const authorityId = auth.authority.id
  const id = crypto.randomUUID()
  const signer = overrides?.signer ?? makeRequesterSigner()
  const requesterKey = overrides?.requesterKey ?? signer.publicHex
  const issuerType = overrides?.issuerType ?? 'registrant'
  const bridgeId = overrides?.bridgeId === undefined ? null : overrides.bridgeId
  // A minimal RegisterInit-shaped payload is sufficient — this plan asserts CHECK behaviour, not
  // payload semantics.
  const payload = overrides?.payload ?? JSON.stringify({ registrant: { authorityId, note: 'test-payload' } })
  // SubmittedAt is submitter-supplied and inside the SignatureValid digest (L-3) — must be written
  // with the Z-emitting helper the schema's `like('%Z', SubmittedAt)` CHECK requires.
  const submittedAt = toIsoZDatetime(Date.now())

  let payloadCid = overrides?.payloadCid
  if (payloadCid === undefined) {
    const cidRow = await auth.ctx.db.prepare('select Digest(:payload) as d').get({ payload })
    if (!cidRow || cidRow.d == null) throw new Error('seedRegistrationRequest: PayloadCid Digest() returned null')
    payloadCid = cidRow.d as string
  }

  let requesterSignature = overrides?.signature
  if (requesterSignature === undefined) {
    // RegistrationRequest.SignatureValid's Digest(...) argument order, field for field:
    //   Digest(Id, AuthorityId, RequesterKey, IssuerType, BridgeId, PayloadCid, SubmittedAt)
    const digestRow = await auth.ctx.db
      .prepare('select Digest(:id, :authorityId, :requesterKey, :issuerType, :bridgeId, :payloadCid, :submittedAt) as d')
      .get({ id, authorityId, requesterKey, issuerType, bridgeId, payloadCid, submittedAt })
    if (!digestRow || digestRow.d == null) throw new Error('seedRegistrationRequest: SignatureValid Digest() returned null')
    requesterSignature = signer.signDigest(digestRow.d as string)
  }

  // ReceivedAt is the authority's OWN observation of intake time — engine-written, inside NO
  // digest at all (distinct from SubmittedAt).
  const receivedAt = toIsoZDatetime(Date.now())

  await auth.ctx.db.exec(
    `insert into RegistrationRequest (
      Id, AuthorityId, RequesterKey, IssuerType, BridgeId, Payload, PayloadCid, SubmittedAt, ReceivedAt, RequesterSignature
    )
    with context SigningNonce = null, Tid = :tid
    values (:id, :authorityId, :requesterKey, :issuerType, :bridgeId, :payload, :payloadCid, :submittedAt, :receivedAt, :requesterSignature)`,
    { id, authorityId, requesterKey, issuerType, bridgeId, payload, payloadCid, submittedAt, receivedAt, requesterSignature, tid: Date.now() }
  )

  return { id, requesterKey, signer }
}

/**
 * BEGIN -> Task insert (SignatureType='registrant') -> RegistrantSignatureTaskExtension insert ->
 * COMMIT, copied structurally from `signing.spec.ts:806-828`'s `seedSignatureTask`. The extension
 * row's MutationValid requires a matching UNSIGNED AdminSigning row (scope 'vrg') whose Digest
 * reproduces `RegistrantSignatureTaskExtension.MutationValid`'s own
 * `Digest(context.Tid, R.Id, R.AuthorityId, R.RequesterKey, R.IssuerType, R.BridgeId, R.PayloadCid, R.SubmittedAt)`
 * formula over the seeded `RegistrationRequest`'s own columns — seeded with
 * `IsPlaceholderSignature = true` and WITHOUT calling `SigningEngine.sign()`, because the
 * extension's `not exists (... AdminSignature ...)` clause requires no `AdminSignature` to exist
 * yet at extension-insert time.
 */
async function seedRegistrantTask (auth: TestAuthority, requestId: string): Promise<{ taskId: string; nonce: string }> {
  const reqRow = await auth.ctx.db
    .prepare('select Id, AuthorityId, RequesterKey, IssuerType, BridgeId, PayloadCid, SubmittedAt from RegistrationRequest where Id = :id')
    .get({ id: requestId })
  if (!reqRow) throw new Error('seedRegistrantTask: RegistrationRequest not found')

  const sig = makeTestSignature(auth.user)
  const nonce = crypto.randomUUID()
  const taskId = crypto.randomUUID()
  // Same tid value used in the AdminSigning digest AND both `with context Tid` bindings below.
  const tid = Date.now()

  const adminRow = await auth.ctx.db
    .prepare('select EffectiveAt from CurrentAdmin where AuthorityId = :authorityId')
    .get({ authorityId: auth.authority.id })
  if (!adminRow) throw new Error('seedRegistrantTask: CurrentAdmin not found')
  const adminEffectiveAt = adminRow.EffectiveAt as string

  await auth.ctx.db.exec(
    `insert into AdminSigning (Nonce, AuthorityId, AdminEffectiveAt, Scope, Digest, UserId, SignerKey, Signature)
     with context now = :now, IsSignerKeyValid = true, IsPlaceholderSignature = true
     values (:nonce, :authorityId, :adminEffectiveAt, 'vrg',
             Digest(:tid, :reqId, :reqAuthorityId, :reqRequesterKey, :reqIssuerType, :reqBridgeId, :reqPayloadCid, :reqSubmittedAt),
             :userId, :signerKey, :signature)`,
    {
      nonce,
      authorityId: auth.authority.id,
      adminEffectiveAt,
      tid,
      reqId: reqRow.Id as string,
      reqAuthorityId: reqRow.AuthorityId as string,
      reqRequesterKey: reqRow.RequesterKey as string,
      reqIssuerType: reqRow.IssuerType as string,
      reqBridgeId: reqRow.BridgeId as string | null,
      reqPayloadCid: reqRow.PayloadCid as string,
      reqSubmittedAt: reqRow.SubmittedAt as string,
      userId: sig.signerUserId,
      signerKey: sig.signerKey,
      signature: sig.signature,
      now: nowCanonicalDatetime(),
    }
  )

  // Step: Task + RegistrantSignatureTaskExtension in one explicit transaction so the deferred
  // ExtensionExists (on Task) and TaskIdValid (on the extension) see each other at COMMIT.
  await auth.ctx.db.exec('BEGIN')
  try {
    await auth.ctx.db.exec(
      `insert into Task (Id, UserId, Type, SignatureType, SigningNonce, IsCompleted)
       with context IsMutationValid = true, Tid = :tid
       values (:id, :userId, 'signature', 'registrant', :nonce, 0)`,
      { id: taskId, userId: auth.user.id, nonce, tid }
    )
    await auth.ctx.db.exec(
      `insert into RegistrantSignatureTaskExtension (TaskId, RequestId)
       with context Tid = :tid
       values (:taskId, :requestId)`,
      { taskId, requestId, tid }
    )
    await auth.ctx.db.exec('COMMIT')
  } catch (err) {
    await auth.ctx.db.exec('ROLLBACK')
    throw err
  }

  return { taskId, nonce }
}

// ---------------------------------------------------------------------------
// (a) D-05 / A4 — the ambiguity-killer
// ---------------------------------------------------------------------------

describe("registration-request schema: ExtensionExists 'registrant' pairing (D-05)", () => {
  // ESCALATION RULE: see the file header. A failure here is a BLOCKING FINDING for the phase, not
  // a test bug — do not weaken this assertion, skip it, or edit schema/engine source to pass it.
  it("commits a Task with SignatureType='registrant' alongside a matching RegistrantSignatureTaskExtension row — quereus#21's 'only the first view row matches' comment does not block a 7th SignatureType", async () => {
    const auth = await addTestAuthority(await createTestNetwork())
    const { id: requestId } = await seedRegistrationRequest(auth)
    const { taskId } = await seedRegistrantTask(auth, requestId)

    // A4 is proven by row-count SELECTs, not by absence of a thrown error — a "silent rejection"
    // (quereus#21's failure mode) would still let COMMIT succeed while inserting zero rows.
    const taskRow = await auth.ctx.db
      .prepare(`select count(*) as n from Task where Id = :id and SignatureType = 'registrant'`)
      .get({ id: taskId })
    expect(Number(taskRow?.n), "A4: Task row with SignatureType='registrant' must exist post-COMMIT").to.equal(1)

    const extRow = await auth.ctx.db
      .prepare('select count(*) as n from RegistrantSignatureTaskExtension where TaskId = :taskId and RequestId = :requestId')
      .get({ taskId, requestId })
    expect(Number(extRow?.n), 'A4: RegistrantSignatureTaskExtension row must exist post-COMMIT').to.equal(1)
  })

  it("rejects a Task with SignatureType='registrant' and no extension row", async () => {
    const auth = await addTestAuthority(await createTestNetwork())
    const taskId = crypto.randomUUID()
    const nonce = crypto.randomUUID()
    const tid = Date.now()

    let caught: unknown
    await auth.ctx.db.exec('BEGIN')
    try {
      await auth.ctx.db.exec(
        `insert into Task (Id, UserId, Type, SignatureType, SigningNonce, IsCompleted)
         with context IsMutationValid = true, Tid = :tid
         values (:id, :userId, 'signature', 'registrant', :nonce, 0)`,
        { id: taskId, userId: auth.user.id, nonce, tid }
      )
      await auth.ctx.db.exec('COMMIT')
    } catch (err) {
      caught = err
      await auth.ctx.db.exec('ROLLBACK')
    }

    expect(caught, 'COMMIT must throw: SignatureType=registrant Task with no extension row').to.be.instanceOf(Error)
    const taskRow = await auth.ctx.db.prepare('select count(*) as n from Task where Id = :id').get({ id: taskId })
    expect(Number(taskRow?.n)).to.equal(0)
    const extRow = await auth.ctx.db
      .prepare('select count(*) as n from RegistrantSignatureTaskExtension where TaskId = :id')
      .get({ id: taskId })
    expect(Number(extRow?.n)).to.equal(0)
  })
})

// ---------------------------------------------------------------------------
// (b) D-05 regression — the six pre-existing ExtensionExists pairings
// ---------------------------------------------------------------------------

/**
 * The six SignatureType<->extension-table pairings `Task.ExtensionExists` enumerated BEFORE 48-02's
 * amendment — cross-checked against the landed schema text (votetorrent.qsql:1012-1023) before
 * writing this list down. `'registrant'` is deliberately NOT included here — Task 1 owns that
 * pairing.
 */
const PRE_EXISTING_PAIRINGS: ReadonlyArray<{ signatureType: string; extensionTable: string }> = [
  { signatureType: 'network', extensionTable: 'NetworkSignatureTaskExtension' },
  { signatureType: 'authority', extensionTable: 'AuthoritySignatureTaskExtension' },
  { signatureType: 'admin', extensionTable: 'AdminSignatureTaskExtension' },
  { signatureType: 'election', extensionTable: 'ElectionSignatureTaskExtension' },
  { signatureType: 'election-revision', extensionTable: 'ElectionRevisionSignatureTaskExtension' },
  { signatureType: 'ballot', extensionTable: 'BallotSignatureTaskExtension' },
]

describe('registration-request schema: ExtensionExists pre-existing pairing regression (D-05)', () => {
  // 48-02 amended a CHECK on a LIVE table (Task.ExtensionExists). Proving the new 'registrant'
  // clause works (the describe block above) proves NOTHING about the six clauses that were
  // already there. Neither mocha nor jest exercises Quereus re-attach reconcile, so this suite is
  // the ONLY automated evidence that the amendment was additive rather than destructive. 48-02's
  // on-device proof covers reconcile, not semantics — these two legs are complementary, and
  // neither substitutes for the other.
  for (const { signatureType, extensionTable } of PRE_EXISTING_PAIRINGS) {
    it(`rejects a Task with SignatureType='${signatureType}' and no ${extensionTable} row`, async () => {
      const auth = await addTestAuthority(await createTestNetwork())
      const taskId = crypto.randomUUID()
      const nonce = crypto.randomUUID()
      const tid = Date.now()

      // No extension row and no AdminSigning row is needed here — the insert must fail on
      // ExtensionExists before anything downstream matters; keeping the setup minimal keeps the
      // failure attributable.
      let caught: unknown
      await auth.ctx.db.exec('BEGIN')
      try {
        await auth.ctx.db.exec(
          `insert into Task (Id, UserId, Type, SignatureType, SigningNonce, IsCompleted)
           with context IsMutationValid = true, Tid = :tid
           values (:id, :userId, 'signature', :signatureType, :nonce, 0)`,
          { id: taskId, userId: auth.user.id, signatureType, nonce, tid }
        )
        await auth.ctx.db.exec('COMMIT')
      } catch (err) {
        caught = err
        await auth.ctx.db.exec('ROLLBACK')
      }

      expect(caught, `COMMIT must throw: SignatureType='${signatureType}' has no matching ${extensionTable} row`).to.be.instanceOf(Error)
      const taskRow = await auth.ctx.db.prepare('select count(*) as n from Task where Id = :id').get({ id: taskId })
      expect(Number(taskRow?.n)).to.equal(0)
    })
  }

  it("rejects a mismatched pairing: a SignatureType='network' Task carrying an AdminSignatureTaskExtension row", async () => {
    const auth = await addTestAuthority(await createTestNetwork())
    const taskId = crypto.randomUUID()
    const nonce = crypto.randomUUID()
    const tid = Date.now()

    const adminRow = await auth.ctx.db
      .prepare('select EffectiveAt from CurrentAdmin where AuthorityId = :authorityId')
      .get({ authorityId: auth.authority.id })
    if (!adminRow) throw new Error('mismatched-pairing test: CurrentAdmin not found')
    const adminEffectiveAt = adminRow.EffectiveAt as string

    // Deliberately imprecise about WHICH constraint fires: AdminSignatureTaskExtension.TaskIdValid
    // (requires T.SignatureType = 'admin') AND Task.ExtensionExists (a 'network' Task requires a
    // NetworkSignatureTaskExtension row, not an Admin one) BOTH reject this insert. Asserting on
    // the specific constraint name would couple the test to Quereus error-message formatting — the
    // contract under test is "the pairing cannot be crossed", not "constraint X is the one that
    // objected".
    let caught: unknown
    await auth.ctx.db.exec('BEGIN')
    try {
      await auth.ctx.db.exec(
        `insert into Task (Id, UserId, Type, SignatureType, SigningNonce, IsCompleted)
         with context IsMutationValid = true, Tid = :tid
         values (:id, :userId, 'signature', 'network', :nonce, 0)`,
        { id: taskId, userId: auth.user.id, nonce, tid }
      )
      await auth.ctx.db.exec(
        `insert into AdminSignatureTaskExtension (TaskId, AuthorityId, AdminEffectiveAt)
         with context Tid = :tid
         values (:taskId, :authorityId, :adminEffectiveAt)`,
        { taskId, authorityId: auth.authority.id, adminEffectiveAt, tid }
      )
      await auth.ctx.db.exec('COMMIT')
    } catch (err) {
      caught = err
      await auth.ctx.db.exec('ROLLBACK')
    }

    expect(caught, 'COMMIT must throw: a network Task cannot carry an AdminSignatureTaskExtension row').to.be.instanceOf(Error)
    const taskRow = await auth.ctx.db.prepare('select count(*) as n from Task where Id = :id').get({ id: taskId })
    expect(Number(taskRow?.n)).to.equal(0)
    const extRow = await auth.ctx.db
      .prepare('select count(*) as n from AdminSignatureTaskExtension where TaskId = :id')
      .get({ id: taskId })
    expect(Number(extRow?.n)).to.equal(0)
  })
})

// ---------------------------------------------------------------------------
// (c) D-02 — RegistrationRequest self-signature
// ---------------------------------------------------------------------------

describe('registration-request schema: RegistrationRequest self-signature (D-02)', () => {
  it('accepts a genuine requester signature from a key that belongs to no User row', async () => {
    const auth = await addTestAuthority(await createTestNetwork())
    const { id, requesterKey } = await seedRegistrationRequest(auth)

    const row = await auth.ctx.db.prepare('select count(*) as n from RegistrationRequest where Id = :id').get({ id })
    expect(Number(row?.n), 'RegistrationRequest row must exist post-insert').to.equal(1)

    // D-02's decisive claim: this signature verifies under the supplied key, with NO requirement
    // that the key belong to a known User. UserKey is the table that would carry the FK from a
    // key to a User row (see fixtures/test-context.ts's makeTestUser) — its absence here is what
    // proves the requester key belongs to no User, not merely that a signature verified. This is
    // also the first table in the schema where the `SignatureValid(Digest(...), Signature, Key)`
    // shape validates an untrusted EXTERNAL party's key rather than the authority's own signor
    // (48-PATTERNS.md's Registrant analog caveat).
    // NOTE: `:key` collides with Quereus's contextual keyword `key` — bind as `:pubKey` instead.
    const userKeyRow = await auth.ctx.db.prepare('select count(*) as n from UserKey where PubKey = :pubKey').get({ pubKey: requesterKey })
    expect(Number(userKeyRow?.n), 'D-02: requester key must NOT belong to any User (no UserKey row)').to.equal(0)
  })

  it('rejects a row whose Payload was swapped after the digest was signed', async () => {
    const auth = await addTestAuthority(await createTestNetwork())
    const authorityId = auth.authority.id
    const id = crypto.randomUUID()
    const signer = makeRequesterSigner()
    const requesterKey = signer.publicHex
    const issuerType = 'registrant'
    const bridgeId = null
    const submittedAt = toIsoZDatetime(Date.now())

    const payloadA = JSON.stringify({ registrant: { authorityId, note: 'payload-a' } })
    const payloadB = JSON.stringify({ registrant: { authorityId, note: 'payload-b' } })

    const cidARow = await auth.ctx.db.prepare('select Digest(:payload) as d').get({ payload: payloadA })
    if (!cidARow || cidARow.d == null) throw new Error('payload-swap test: Digest(payloadA) returned null')
    const payloadCidA = cidARow.d as string

    const cidBRow = await auth.ctx.db.prepare('select Digest(:payload) as d').get({ payload: payloadB })
    if (!cidBRow || cidBRow.d == null) throw new Error('payload-swap test: Digest(payloadB) returned null')
    const payloadCidB = cidBRow.d as string

    // Sign the digest over payload A's PayloadCid.
    const digestRow = await auth.ctx.db
      .prepare('select Digest(:id, :authorityId, :requesterKey, :issuerType, :bridgeId, :payloadCid, :submittedAt) as d')
      .get({ id, authorityId, requesterKey, issuerType, bridgeId, payloadCid: payloadCidA, submittedAt })
    if (!digestRow || digestRow.d == null) throw new Error('payload-swap test: SignatureValid Digest() returned null')
    const requesterSignature = signer.signDigest(digestRow.d as string)

    // INSERT with payload B and PayloadCid = Digest(B) — keeps PayloadCidValid satisfied so the
    // rejection is attributable to SignatureValid, not the cid check.
    let caught: unknown
    try {
      await auth.ctx.db.exec(
        `insert into RegistrationRequest (
          Id, AuthorityId, RequesterKey, IssuerType, BridgeId, Payload, PayloadCid, SubmittedAt, ReceivedAt, RequesterSignature
        )
        with context SigningNonce = null, Tid = :tid
        values (:id, :authorityId, :requesterKey, :issuerType, :bridgeId, :payload, :payloadCid, :submittedAt, :receivedAt, :requesterSignature)`,
        {
          id, authorityId, requesterKey, issuerType, bridgeId,
          payload: payloadB, payloadCid: payloadCidB, submittedAt,
          receivedAt: toIsoZDatetime(Date.now()), requesterSignature, tid: Date.now(),
        }
      )
    } catch (err) {
      caught = err
    }

    expect(caught, 'INSERT must throw: signature was over payload A, row carries payload B').to.be.instanceOf(Error)
    const row = await auth.ctx.db.prepare('select count(*) as n from RegistrationRequest where Id = :id').get({ id })
    expect(Number(row?.n)).to.equal(0)
  })

  it('rejects a signature produced by a key other than the RequesterKey column', async () => {
    const auth = await addTestAuthority(await createTestNetwork())
    const authorityId = auth.authority.id
    const id = crypto.randomUUID()
    const signerX = makeRequesterSigner()
    const signerY = makeRequesterSigner()
    const issuerType = 'registrant'
    const bridgeId = null
    const payload = JSON.stringify({ registrant: { authorityId, note: 'wrong-key' } })
    const submittedAt = toIsoZDatetime(Date.now())

    const cidRow = await auth.ctx.db.prepare('select Digest(:payload) as d').get({ payload })
    if (!cidRow || cidRow.d == null) throw new Error('wrong-key test: Digest(payload) returned null')
    const payloadCid = cidRow.d as string

    // Sign the CORRECT digest with signer X's private key, while binding signer Y's publicHex
    // into RequesterKey.
    const digestRow = await auth.ctx.db
      .prepare('select Digest(:id, :authorityId, :requesterKey, :issuerType, :bridgeId, :payloadCid, :submittedAt) as d')
      .get({ id, authorityId, requesterKey: signerY.publicHex, issuerType, bridgeId, payloadCid, submittedAt })
    if (!digestRow || digestRow.d == null) throw new Error('wrong-key test: SignatureValid Digest() returned null')
    const requesterSignature = signerX.signDigest(digestRow.d as string)

    let caught: unknown
    try {
      await auth.ctx.db.exec(
        `insert into RegistrationRequest (
          Id, AuthorityId, RequesterKey, IssuerType, BridgeId, Payload, PayloadCid, SubmittedAt, ReceivedAt, RequesterSignature
        )
        with context SigningNonce = null, Tid = :tid
        values (:id, :authorityId, :requesterKey, :issuerType, :bridgeId, :payload, :payloadCid, :submittedAt, :receivedAt, :requesterSignature)`,
        {
          id, authorityId, requesterKey: signerY.publicHex, issuerType, bridgeId,
          payload, payloadCid, submittedAt,
          receivedAt: toIsoZDatetime(Date.now()), requesterSignature, tid: Date.now(),
        }
      )
    } catch (err) {
      caught = err
    }

    expect(caught, 'INSERT must throw: signature was produced by a key other than RequesterKey').to.be.instanceOf(Error)
    const row = await auth.ctx.db.prepare('select count(*) as n from RegistrationRequest where Id = :id').get({ id })
    expect(Number(row?.n)).to.equal(0)
  })
})

// ---------------------------------------------------------------------------
// (d) D-03 — bridge issuer binding
// ---------------------------------------------------------------------------

/**
 * Register a bridge key via the real `'vrg'`-scoped officer ceremony. This ceremony is an
 * OFFICER act (signed under scope 'vrg'), categorically different from the requester's own
 * self-signature above — `seedSignedMutation`/`signTestDigest` against the fixture `User` is
 * correct here. `digestParams` deliberately avoids `seedSignedMutation`'s reserved bind names
 * (`nonce`, `authorityId`, `adminEffectiveAt`, `scope`, `userId`, `signerKey`, `signature`, `now`)
 * by binding the row's own authority id as `authId`, not `authorityId`.
 */
async function seedBridgeKey (auth: TestAuthority, opts: { label: string; key: string }): Promise<{ id: string }> {
  const id = crypto.randomUUID()
  const authorityId = auth.authority.id
  const label = opts.label
  const bridgeKey = opts.key
  const revokedAt = null
  const tid = Date.now()

  // RegistrationBridgeKey.MutationValid's Digest(...) argument order, field for field:
  //   Digest(context.Tid, new.Id, new.AuthorityId, new.Label, new.BridgeKey, new.RevokedAt)
  const digestExpr = 'select Digest(:tid, :id, :authId, :label, :bridgeKey, :revokedAt) as d'
  const digestParams = { tid, id, authId: authorityId, label, bridgeKey, revokedAt }
  const { nonce } = await seedSignedMutation(auth.ctx, authorityId, 'vrg', tid, digestExpr, digestParams, auth.user)

  await auth.ctx.db.exec(
    `insert into RegistrationBridgeKey (Id, AuthorityId, Label, BridgeKey, RevokedAt)
     with context SigningNonce = :nonce, Tid = :tid
     values (:id, :authorityId, :label, :bridgeKey, :revokedAt)`,
    { id, authorityId, label, bridgeKey, revokedAt, nonce, tid }
  )

  return { id }
}

describe('registration-request schema: RegistrationRequest bridge issuer binding (D-03)', () => {
  it('accepts an IssuerType=bridge row whose BridgeId resolves to a registered RegistrationBridgeKey with a matching Key', async () => {
    const auth = await addTestAuthority(await createTestNetwork())
    const bridgeSigner = makeRequesterSigner()
    const { id: bridgeId } = await seedBridgeKey(auth, { label: 'Legacy Roll Importer', key: bridgeSigner.publicHex })

    const { id } = await seedRegistrationRequest(auth, { signer: bridgeSigner, issuerType: 'bridge', bridgeId })

    const row = await auth.ctx.db
      .prepare('select IssuerType, BridgeId from RegistrationRequest where Id = :id')
      .get({ id })
    expect(row, 'RegistrationRequest row must exist post-insert').to.not.be.undefined
    // D-03: the marker's persistence is the assertion, not just the insert's success — a bridge
    // assertion must be machine-distinguishable at the data layer, not merely in the UI.
    expect(row?.IssuerType).to.equal('bridge')
    expect(row?.BridgeId).to.equal(bridgeId)
  })

  it('rejects an IssuerType=bridge row whose BridgeId is not a registered RegistrationBridgeKey', async () => {
    const auth = await addTestAuthority(await createTestNetwork())
    const bridgeSigner = makeRequesterSigner()
    const unregisteredBridgeId = crypto.randomUUID()

    // Threat: an unregistered bridge key submitting bulk rows would be an unbounded trust anchor
    // (T-48-04-02) — bridge keys must be a bounded, authority-registered set.
    let caught: unknown
    try {
      await seedRegistrationRequest(auth, { signer: bridgeSigner, issuerType: 'bridge', bridgeId: unregisteredBridgeId })
    } catch (err) {
      caught = err
    }
    expect(caught, 'INSERT must throw: BridgeId does not resolve to a registered RegistrationBridgeKey').to.be.instanceOf(Error)
  })

  it('rejects an IssuerType=registrant row carrying a non-null BridgeId', async () => {
    const auth = await addTestAuthority(await createTestNetwork())
    const bogusBridgeId = crypto.randomUUID()

    // Threat: a bridge assertion masquerading as a voter's own cryptographically attributed act
    // (RESEARCH's Security Domain Spoofing threat; T-48-04-01) — a genuinely self-signed request
    // must not be able to also carry a BridgeId.
    let caught: unknown
    try {
      await seedRegistrationRequest(auth, { issuerType: 'registrant', bridgeId: bogusBridgeId })
    } catch (err) {
      caught = err
    }
    expect(caught, 'INSERT must throw: a registrant-issued row cannot carry a BridgeId').to.be.instanceOf(Error)
  })
})
