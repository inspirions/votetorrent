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
import { createTestNetwork, addTestAuthority, seedSignedMutation, signTestDigest, makeTestSignature } from './fixtures/test-context.js'
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
