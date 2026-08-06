/**
 * registration-request-read.spec.ts — Phase 48 Plan 08 (D-06/D-09)
 *
 * The registration-request READ surface: `listRegistrationRequests` (the
 * triage queue, keyset-paged, `ReceivedAt`-ordered — T-48-08-11),
 * `getRegistrationRequest` (the point read backing all three approval-screen
 * modes), `getPriorRejections` (D-06 reachability), and
 * `getRegistrationTransparencyStats` (D-09 counts + median).
 *
 * Drives the REAL `RegistrationEngine` against the REAL Quereus schema — no
 * mocks. Every seeded `RegistrationRequest` row carries a REAL requester
 * secp256k1 self-signature (D-02), reusing 48-04/48-07's own DG-1 digest
 * field order (`registration-request.spec.ts`) rather than re-deriving it.
 */

import 'reflect-metadata'
import { expect } from 'chai'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js'
import { createTestNetwork, addTestAuthority, seedSignedMutation } from './fixtures/test-context.js'
import { randomTestKeyPair } from './fixtures/keys.js'
import { digestToBytes } from '../src/utils.js'
import { toIsoZDatetime } from '../src/signing/ceremony-helpers.js'
import { RegistrationEngine } from '../src/registration/registration-engine.js'
import type { RegisterInit } from '@votetorrent/vote-core'

type TestAuthority = Awaited<ReturnType<typeof addTestAuthority>>

const FUTURE_EXPIRATION = new Date(Date.now() + 365 * 86_400_000).toISOString()

// ---------------------------------------------------------------------------
// Module-level helpers
// ---------------------------------------------------------------------------

/**
 * WR-10 prehash contract: `secp256k1.sign(bytes, priv)` with NO explicit
 * `prehash` option relies on @noble/curves v2's default (`prehash:true`) —
 * identical shape to `registration-request.spec.ts`'s own
 * `makeRequesterSigner`. Deliberately returns a bare hex signature string,
 * not a `Signature` object — a prospective registrant has no `signerUserId`.
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

interface SeedRequestOverrides {
  /** External signer to use instead of a freshly-generated one — e.g. two rows from the SAME requester (D-06 prior-rejection tests). */
  signer?: { publicHex: string; signDigest: (digestBase64url: string) => string }
  issuerType?: 'registrant' | 'bridge'
  bridgeId?: string | null
  requesterKey?: string
  payload?: RegisterInit
  submittedAt?: string
  receivedAt?: string
  status?: 'p' | 'a' | 'r'
  decidedAt?: string | null
  decidingOfficerUserId?: string | null
  rejectionReason?: string | null
  verificationCid?: string | null
}

interface SeedRequestResult {
  id: string
  requesterKey: string
  payload: RegisterInit
  submittedAt: string
  receivedAt: string
}

/**
 * Insert one `RegistrationRequest` row by raw SQL, reusing 48-04/48-07's own
 * `SignatureValid` digest field order verbatim
 * (`registration-request.spec.ts`'s `seedRegistrationRequest`):
 * `Digest(Id, AuthorityId, RequesterKey, IssuerType, BridgeId, PayloadCid,
 * SubmittedAt)` — no `context.Tid`, no `ReceivedAt`. `submittedAt` and
 * `receivedAt` can be set INDEPENDENTLY (DG-1 covers the former, never the
 * latter) — the anti-backdating proof below depends on this.
 *
 * DECLARED BLIND SPOT: `status`/`decidedAt`/`decidingOfficerUserId`/
 * `rejectionReason`/`verificationCid` can all be seeded pre-decided directly
 * on INSERT — `DecisionValid` is a `check on update` ONLY and none of DG-1's
 * seven digest arguments cover any decision column, so a correctly-signed
 * INSERT of an already-decided row is schema-legal. This seeds the READ
 * surface only and proves NOTHING about the decision ceremony's own
 * transition semantics, which the rejection plan (48-12) owns.
 */
async function seedRequest (auth: TestAuthority, overrides?: SeedRequestOverrides): Promise<SeedRequestResult> {
  const authorityId = auth.authority.id
  const id = crypto.randomUUID()
  const signer = overrides?.signer ?? makeRequesterSigner()
  const requesterKey = overrides?.requesterKey ?? signer.publicHex
  const issuerType = overrides?.issuerType ?? 'registrant'
  const bridgeId = overrides?.bridgeId === undefined ? null : overrides.bridgeId
  const payload: RegisterInit = overrides?.payload ?? {
    registrant: { id: crypto.randomUUID(), authorityId, expiration: FUTURE_EXPIRATION },
    private: { expiration: FUTURE_EXPIRATION, details: [] }
  }
  const payloadJson = JSON.stringify(payload)
  // Kept within a few hours of "now" by default so no row trips
  // SubmittedAtSaneValid's absolute bound; callers override explicitly.
  const submittedAt = overrides?.submittedAt ?? toIsoZDatetime(Date.now())
  const receivedAt = overrides?.receivedAt ?? toIsoZDatetime(Date.now())
  const status = overrides?.status ?? 'p'
  const decidedAt = overrides?.decidedAt === undefined ? null : overrides.decidedAt
  const decidingOfficerUserId = overrides?.decidingOfficerUserId === undefined ? null : overrides.decidingOfficerUserId
  const rejectionReason = overrides?.rejectionReason === undefined ? null : overrides.rejectionReason
  const verificationCidValue = overrides?.verificationCid === undefined ? null : overrides.verificationCid

  const cidRow = await auth.ctx.db.prepare('select Digest(:payload) as d').get({ payload: payloadJson })
  if (!cidRow || cidRow.d == null) throw new Error('seedRequest: PayloadCid Digest() returned null')
  const payloadCid = cidRow.d as string

  const digestRow = await auth.ctx.db
    .prepare('select Digest(:id, :authorityId, :requesterKey, :issuerType, :bridgeId, :payloadCid, :submittedAt) as d')
    .get({ id, authorityId, requesterKey, issuerType, bridgeId, payloadCid, submittedAt })
  if (!digestRow || digestRow.d == null) throw new Error('seedRequest: SignatureValid Digest() returned null')
  const requesterSignature = signer.signDigest(digestRow.d as string)

  await auth.ctx.db.exec(
    `insert into RegistrationRequest (
      Id, AuthorityId, RequesterKey, IssuerType, BridgeId, Payload, PayloadCid, Status, SubmittedAt, ReceivedAt,
      RequesterSignature, VerificationCid, DecidedAt, DecidingOfficerUserId, RejectionReason
    )
    with context SigningNonce = null, Tid = :tid
    values (:id, :authorityId, :requesterKey, :issuerType, :bridgeId, :payload, :payloadCid, :status, :submittedAt, :receivedAt,
      :requesterSignature, :verificationCid, :decidedAt, :decidingOfficerUserId, :rejectionReason)`,
    {
      id,
      authorityId,
      requesterKey,
      issuerType,
      bridgeId,
      payload: payloadJson,
      payloadCid,
      status,
      submittedAt,
      receivedAt,
      requesterSignature,
      verificationCid: verificationCidValue,
      decidedAt,
      decidingOfficerUserId,
      rejectionReason,
      tid: Date.now()
    }
  )

  return { id, requesterKey, payload, submittedAt, receivedAt }
}

/**
 * Register a bridge key via the real `'vrg'`-scoped officer ceremony —
 * mirrors `registration-request.spec.ts`'s own `seedBridgeKey`.
 */
async function seedBridgeKey (auth: TestAuthority, opts: { label: string; key: string }): Promise<{ id: string }> {
  const id = crypto.randomUUID()
  const authorityId = auth.authority.id
  const label = opts.label
  const bridgeKey = opts.key
  const revokedAt = null
  const tid = Date.now()
  // RegistrationBridgeKey.MutationValid's Digest(...) argument order, field
  // for field: Digest(context.Tid, new.Id, new.AuthorityId, new.Label,
  // new.BridgeKey, new.RevokedAt). `authId` avoids seedSignedMutation's
  // reserved `authorityId` bind name.
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

// ---------------------------------------------------------------------------
// listRegistrationRequests (D-06/D-09/T-48-08-11)
// ---------------------------------------------------------------------------

describe('listRegistrationRequests', () => {
  it('returns rows in strictly non-decreasing receivedAt order, oldest received first', async () => {
    const auth = await addTestAuthority(await createTestNetwork())
    const engine = new RegistrationEngine(auth.ctx)
    const base = Date.now()
    const r1 = await seedRequest(auth, { receivedAt: toIsoZDatetime(base) })
    const r2 = await seedRequest(auth, { receivedAt: toIsoZDatetime(base + 60_000) })
    const r3 = await seedRequest(auth, { receivedAt: toIsoZDatetime(base + 120_000) })

    const result = await engine.listRegistrationRequests({ authorityId: auth.authority.id })
    expect(result.rows.map((r) => r.requestId)).to.deep.equal([r1.id, r2.id, r3.id])
    for (let i = 1; i < result.rows.length; i++) {
      expect(result.rows[i]!.receivedAt >= result.rows[i - 1]!.receivedAt).to.equal(true)
    }
  })

  it('T-48-08-11: the anti-backdating proof — a submittedAt order reversed against receivedAt buys NO queue position', async () => {
    const auth = await addTestAuthority(await createTestNetwork())
    const engine = new RegistrationEngine(auth.ctx)
    const base = Date.now()
    // A claims the EARLIER submittedAt but is RECEIVED SECOND.
    const a = await seedRequest(auth, { submittedAt: toIsoZDatetime(base), receivedAt: toIsoZDatetime(base + 120_000) })
    // B claims the LATER submittedAt but is RECEIVED FIRST.
    const b = await seedRequest(auth, { submittedAt: toIsoZDatetime(base + 60_000), receivedAt: toIsoZDatetime(base + 60_000) })

    // Stake: submittedAt is submitter-CHOSEN. If this assertion ever inverts, any submitter can
    // jump an officer's triage queue by editing one string before signing — the backdated claim
    // would sit inside a validly-signed row with nothing downstream looking wrong. This test is
    // the ENTIRE reason the order key changed off SubmittedAt; it must not be softened into
    // "returns rows in some order".
    const result = await engine.listRegistrationRequests({ authorityId: auth.authority.id })
    const returnedOrder = result.rows.map((r) => r.requestId)
    const receivedAtOrder = [b.id, a.id]
    const submittedAtOrder = [a.id, b.id]
    expect(returnedOrder, 'must come back in receivedAt order').to.deep.equal(receivedAtOrder)
    expect(returnedOrder, 'must NOT come back in submittedAt order').to.not.deep.equal(submittedAtOrder)
  })

  it('two rows sharing an identical receivedAt come back in ascending requestId order (the tiebreak is real, not incidental)', async () => {
    const auth = await addTestAuthority(await createTestNetwork())
    const engine = new RegistrationEngine(auth.ctx)
    const sharedReceivedAt = toIsoZDatetime(Date.now())
    const r1 = await seedRequest(auth, { receivedAt: sharedReceivedAt })
    const r2 = await seedRequest(auth, { receivedAt: sharedReceivedAt })
    const [lo, hi] = [r1.id, r2.id].sort()

    const result = await engine.listRegistrationRequests({ authorityId: auth.authority.id })
    expect(result.rows.map((r) => r.requestId)).to.deep.equal([lo, hi])
  })

  it('filter.status and filter.issuerType each narrow the set, and together AND (exact intersection)', async () => {
    const auth = await addTestAuthority(await createTestNetwork())
    const engine = new RegistrationEngine(auth.ctx)
    const bridgeSigner = makeRequesterSigner()
    const { id: bridgeId } = await seedBridgeKey(auth, { label: 'Legacy Roll Importer', key: bridgeSigner.publicHex })

    await seedRequest(auth, { status: 'p', issuerType: 'registrant' })
    await seedRequest(auth, {
      status: 'a',
      issuerType: 'registrant',
      decidedAt: toIsoZDatetime(Date.now()),
      decidingOfficerUserId: auth.user.id
    })
    const pendingBridge = await seedRequest(auth, { status: 'p', issuerType: 'bridge', signer: bridgeSigner, bridgeId })

    const pendingOnly = await engine.listRegistrationRequests({ authorityId: auth.authority.id, status: 'p' })
    expect(pendingOnly.rows).to.have.lengthOf(2)
    expect(pendingOnly.rows.every((r) => r.status === 'p')).to.equal(true)

    const bridgeOnly = await engine.listRegistrationRequests({ authorityId: auth.authority.id, issuerType: 'bridge' })
    expect(bridgeOnly.rows).to.have.lengthOf(1)
    expect(bridgeOnly.rows[0]!.requestId).to.equal(pendingBridge.id)

    const both = await engine.listRegistrationRequests({ authorityId: auth.authority.id, status: 'p', issuerType: 'bridge' })
    expect(both.rows).to.have.lengthOf(1)
    expect(both.rows[0]!.requestId).to.equal(pendingBridge.id)
  })

  it("a bridge row's bridgeLabel equals the registered RegistrationBridgeKey.Label; a registrant row's bridgeLabel/bridgeId are undefined", async () => {
    const auth = await addTestAuthority(await createTestNetwork())
    const engine = new RegistrationEngine(auth.ctx)
    const bridgeSigner = makeRequesterSigner()
    const { id: bridgeId } = await seedBridgeKey(auth, { label: 'County Clerk Import', key: bridgeSigner.publicHex })
    const bridgeReq = await seedRequest(auth, { issuerType: 'bridge', signer: bridgeSigner, bridgeId })
    const registrantReq = await seedRequest(auth)

    const result = await engine.listRegistrationRequests({ authorityId: auth.authority.id })
    const bridgeRow = result.rows.find((r) => r.requestId === bridgeReq.id)!
    const registrantRow = result.rows.find((r) => r.requestId === registrantReq.id)!
    expect(bridgeRow.bridgeLabel).to.equal('County Clerk Import')
    expect(bridgeRow.bridgeId).to.equal(bridgeId)
    expect(registrantRow.bridgeLabel).to.equal(undefined)
    expect(registrantRow.bridgeId).to.equal(undefined)
  })

  it('pageSize=2 over 5 matching rows pages with no overlap and no gap; the union equals the full set by id', async () => {
    const auth = await addTestAuthority(await createTestNetwork())
    const engine = new RegistrationEngine(auth.ctx)
    const base = Date.now()
    const seeded: SeedRequestResult[] = []
    for (let i = 0; i < 5; i++) {
      // submittedAt deliberately OUT OF STEP with receivedAt — a cursor predicate that still keys
      // on SubmittedAt would produce a gap or a repeat here and fail, rather than passing by
      // coincidence.
      seeded.push(
        await seedRequest(auth, {
          receivedAt: toIsoZDatetime(base + i * 60_000),
          submittedAt: toIsoZDatetime(base + (4 - i) * 60_000)
        })
      )
    }

    const page1 = await engine.listRegistrationRequests({ authorityId: auth.authority.id }, { pageSize: 2 })
    expect(page1.rows).to.have.lengthOf(2)
    expect(page1.nextCursor).to.not.equal(undefined)

    const page2 = await engine.listRegistrationRequests({ authorityId: auth.authority.id }, { pageSize: 2, cursor: page1.nextCursor })
    expect(page2.rows).to.have.lengthOf(2)
    expect(page2.nextCursor).to.not.equal(undefined)

    const page3 = await engine.listRegistrationRequests({ authorityId: auth.authority.id }, { pageSize: 2, cursor: page2.nextCursor })
    expect(page3.rows).to.have.lengthOf(1)
    expect(page3.nextCursor).to.equal(undefined)

    const seenIds = [...page1.rows, ...page2.rows, ...page3.rows].map((r) => r.requestId)
    expect(new Set(seenIds).size, 'no overlap and no gap').to.equal(5)
    expect(new Set(seenIds)).to.deep.equal(new Set(seeded.map((s) => s.id)))
  })

  it('total is defined and equals the filtered row count on the cursor-absent call, and is undefined on every cursor-bearing call', async () => {
    const auth = await addTestAuthority(await createTestNetwork())
    const engine = new RegistrationEngine(auth.ctx)
    for (let i = 0; i < 3; i++) await seedRequest(auth)

    const first = await engine.listRegistrationRequests({ authorityId: auth.authority.id }, { pageSize: 2 })
    expect(first.total).to.equal(3)

    const second = await engine.listRegistrationRequests({ authorityId: auth.authority.id }, { pageSize: 2, cursor: first.nextCursor })
    expect(second.total).to.equal(undefined)
  })

  it('an unknown/stale cursor returns { rows: [] }, does not throw, and does not return page 1', async () => {
    const auth = await addTestAuthority(await createTestNetwork())
    const engine = new RegistrationEngine(auth.ctx)
    await seedRequest(auth)

    const result = await engine.listRegistrationRequests({ authorityId: auth.authority.id }, { cursor: crypto.randomUUID() })
    expect(result.rows).to.deep.equal([])
  })

  it('hasPriorRejections is true only for a request whose RequesterKey has an EARLIER rejected request, and a rejection never counts itself', async () => {
    const auth = await addTestAuthority(await createTestNetwork())
    const engine = new RegistrationEngine(auth.ctx)
    const repeatSigner = makeRequesterSigner()

    const rejected = await seedRequest(auth, {
      signer: repeatSigner,
      status: 'r',
      decidedAt: toIsoZDatetime(Date.now()),
      decidingOfficerUserId: auth.user.id,
      rejectionReason: 'Could not verify identity'
    })
    const resubmission = await seedRequest(auth, { signer: repeatSigner })
    const firstTime = await seedRequest(auth)

    const result = await engine.listRegistrationRequests({ authorityId: auth.authority.id })
    const rejectedRow = result.rows.find((r) => r.requestId === rejected.id)!
    const resubmissionRow = result.rows.find((r) => r.requestId === resubmission.id)!
    const firstTimeRow = result.rows.find((r) => r.requestId === firstTime.id)!

    expect(resubmissionRow.hasPriorRejections, 'a pending request from a key with an earlier rejection').to.equal(true)
    expect(firstTimeRow.hasPriorRejections, 'a first-time key').to.equal(false)
    expect(rejectedRow.hasPriorRejections, 'a rejected request does not count itself as its own prior rejection').to.equal(false)
  })
})
