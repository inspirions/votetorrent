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
import { verificationCid } from '@votetorrent/vote-core'
import type { RegisterInit, RegistrationVerificationChecklistItem, Signature } from '@votetorrent/vote-core'

type TestAuthority = Awaited<ReturnType<typeof addTestAuthority>>

const FUTURE_EXPIRATION = new Date(Date.now() + 365 * 86_400_000).toISOString()

/**
 * T-42-06 (carried from `registration-request.spec.ts`): a plain SELECT
 * read-back of a Quereus `datetime` column drops the trailing `Z` AND
 * serializes fractional seconds at MINIMAL precision (trailing zero digits
 * stripped) — not just for deferred-CHECK snapshots. A literal
 * byte-identical comparison against the originally-seeded string is
 * therefore flaky whenever the millisecond component happens to end in a
 * `0`. Normalize the EXPECTED value through this before comparing against
 * the engine's own `reZuluDatetime`-normalized read-back.
 */
function stripTrailingZeroMs (isoZ: string): string {
  let s = isoZ.replace(/Z$/, '')
  if (s.includes('.')) {
    s = s.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '')
  }
  return `${s}Z`
}

/** Computes a checklist's VerificationCid the SAME way the D-07 module + engine do — the D-06 module's own canonical serializer, digested through the real `cid(Digest(...))` UDF, never a JS hash. */
async function computeTestVerificationCid (auth: TestAuthority, items: readonly RegistrationVerificationChecklistItem[]): Promise<string> {
  return await verificationCid(items, async (canonical) => {
    const row = await auth.ctx.db.prepare('select cid(Digest(:canonical)) as c').get({ canonical })
    if (!row || row.c == null) throw new Error('computeTestVerificationCid: cid(Digest(...)) returned null')
    return row.c as string
  })
}

/**
 * A real 'vrg'-ceremony-shaped signer for `RegistrationEngine.register()` —
 * mirrors `field-policy.spec.ts`'s own `makeRegistrantSigner`. `AdminSigning
 * .SignerKeyValid` is a hardcoded stub CHECK (T-48-08-09) — any genuine
 * secp256k1 signature over the row's own digest satisfies the ceremony
 * regardless of which key produced it.
 */
function makeOfficerSigner (userId: string): (digest: Uint8Array) => Promise<Signature> {
  const { privateHex, publicHex } = randomTestKeyPair()
  const privBytes = hexToBytes(privateHex)
  return async (digest: Uint8Array): Promise<Signature> => {
    const sig = secp256k1.sign(digest, privBytes)
    return { signerUserId: userId, signerKey: publicHex, signature: bytesToHex(sig) }
  }
}

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

// ---------------------------------------------------------------------------
// getRegistrationRequest — the point read backing all three approval-screen modes
// ---------------------------------------------------------------------------

describe('getRegistrationRequest', () => {
  it('a pending registrant-issued request round-trips, and a seeded submittedAt/receivedAt divergence survives the read', async () => {
    const auth = await addTestAuthority(await createTestNetwork())
    const engine = new RegistrationEngine(auth.ctx)
    const submittedAt = toIsoZDatetime(Date.now() - 45 * 60_000)
    const receivedAt = toIsoZDatetime(Date.now())
    const seeded = await seedRequest(auth, { submittedAt, receivedAt })

    const read = await engine.getRegistrationRequest(seeded.id)
    expect(read, 'a seeded request must round-trip').to.not.equal(undefined)
    expect(read!.payload).to.deep.equal(seeded.payload)
    expect(read!.issuerType).to.equal('registrant')
    expect(read!.bridgeId).to.equal(undefined)
    expect(read!.bridgeLabel).to.equal(undefined)
    expect(read!.decidedAt).to.equal(undefined)
    expect(read!.registrantId).to.equal(undefined)

    // The point read surfaces the divergence rather than collapsing it —
    // the only way an officer can ever notice a requester whose claim
    // disagrees with the authority's own observation.
    expect(read!.submittedAt).to.equal(stripTrailingZeroMs(submittedAt))
    expect(read!.receivedAt).to.equal(stripTrailingZeroMs(receivedAt))
    expect(read!.submittedAt).to.not.equal(read!.receivedAt)
  })

  it('a bridge-issued request returns issuerType=bridge, its bridgeId, and the registered Label as bridgeLabel', async () => {
    const auth = await addTestAuthority(await createTestNetwork())
    const engine = new RegistrationEngine(auth.ctx)
    const bridgeSigner = makeRequesterSigner()
    const { id: bridgeId } = await seedBridgeKey(auth, { label: 'State Voter Roll Import', key: bridgeSigner.publicHex })
    const seeded = await seedRequest(auth, { issuerType: 'bridge', signer: bridgeSigner, bridgeId })

    const read = await engine.getRegistrationRequest(seeded.id)
    expect(read!.issuerType).to.equal('bridge')
    expect(read!.bridgeId).to.equal(bridgeId)
    expect(read!.bridgeLabel).to.equal('State Voter Roll Import')
  })

  it('an approved request with an existing Registrant returns registrantId; one whose Registrant is absent returns registrantId=undefined and does not throw', async () => {
    const auth = await addTestAuthority(await createTestNetwork())
    const engine = new RegistrationEngine(auth.ctx)

    // T-48-08-05: seed a REAL Registrant row through the real register()
    // ceremony (Registrant.MutationValid requires a genuine 'vrg' AdminSigning
    // row and a genuine SignatureValid — a raw INSERT cannot fabricate this)
    // so the existence probe below has something real to find.
    const registrantId = crypto.randomUUID()
    const officerSign = makeOfficerSigner(auth.user.id)
    const producedPayload: RegisterInit = {
      registrant: { id: registrantId, authorityId: auth.authority.id, expiration: FUTURE_EXPIRATION },
      private: { expiration: FUTURE_EXPIRATION, details: [] }
    }
    await engine.register(producedPayload, officerSign)

    const produced = await seedRequest(auth, {
      payload: producedPayload,
      status: 'a',
      decidedAt: toIsoZDatetime(Date.now()),
      decidingOfficerUserId: auth.user.id
    })

    const missingPayload: RegisterInit = {
      registrant: { id: crypto.randomUUID(), authorityId: auth.authority.id, expiration: FUTURE_EXPIRATION },
      private: { expiration: FUTURE_EXPIRATION, details: [] }
    }
    const missing = await seedRequest(auth, {
      payload: missingPayload,
      status: 'a',
      decidedAt: toIsoZDatetime(Date.now()),
      decidingOfficerUserId: auth.user.id
    })

    const producedRead = await engine.getRegistrationRequest(produced.id)
    expect(producedRead!.registrantId).to.equal(registrantId)

    const missingRead = await engine.getRegistrationRequest(missing.id)
    expect(missingRead!.registrantId).to.equal(undefined)
  })

  it('a request decided with checklist [id, roll] returns verificationChecklist deep-equal to the canonical ordering, and verificationCid equal to the stored digest; an unknown id returns undefined', async () => {
    const auth = await addTestAuthority(await createTestNetwork())
    const engine = new RegistrationEngine(auth.ctx)
    const checklist: RegistrationVerificationChecklistItem[] = ['id', 'roll']
    const cid = await computeTestVerificationCid(auth, checklist)
    const seeded = await seedRequest(auth, {
      status: 'a',
      decidedAt: toIsoZDatetime(Date.now()),
      decidingOfficerUserId: auth.user.id,
      verificationCid: cid
    })

    const read = await engine.getRegistrationRequest(seeded.id)
    expect(read!.verificationCid).to.equal(cid)
    // VERIFICATION_CHECKLIST_ITEM_ORDER is ['id','roll','eligibility','none'] — canonical order
    // regardless of the input order above.
    expect(read!.verificationChecklist).to.deep.equal(['id', 'roll'])

    const unknown = await engine.getRegistrationRequest(crypto.randomUUID())
    expect(unknown).to.equal(undefined)
  })
})

// ---------------------------------------------------------------------------
// getPriorRejections (D-06 reachability)
// ---------------------------------------------------------------------------

describe('getPriorRejections', () => {
  it('three rejections for one requesterKey come back newest-rejectedAt-first, each carrying its own rejectionReason and decidingOfficerUserId', async () => {
    const auth = await addTestAuthority(await createTestNetwork())
    const engine = new RegistrationEngine(auth.ctx)
    const signer = makeRequesterSigner()
    const base = Date.now()

    const r1 = await seedRequest(auth, {
      signer,
      status: 'r',
      decidedAt: toIsoZDatetime(base),
      decidingOfficerUserId: auth.user.id,
      rejectionReason: 'Illegible identification'
    })
    const r2 = await seedRequest(auth, {
      signer,
      status: 'r',
      decidedAt: toIsoZDatetime(base + 60_000),
      decidingOfficerUserId: auth.user.id,
      rejectionReason: 'Address mismatch'
    })
    const r3 = await seedRequest(auth, {
      signer,
      status: 'r',
      decidedAt: toIsoZDatetime(base + 120_000),
      decidingOfficerUserId: auth.user.id,
      rejectionReason: 'Duplicate submission'
    })

    const rejections = await engine.getPriorRejections(signer.publicHex)
    expect(rejections.map((r) => r.requestId)).to.deep.equal([r3.id, r2.id, r1.id])
    expect(rejections.map((r) => r.rejectionReason)).to.deep.equal(['Duplicate submission', 'Address mismatch', 'Illegible identification'])
    expect(rejections.every((r) => r.decidingOfficerUserId === auth.user.id)).to.equal(true)
  })

  it('a key with no rejections returns []; an entirely unknown key returns [] without throwing', async () => {
    const auth = await addTestAuthority(await createTestNetwork())
    const engine = new RegistrationEngine(auth.ctx)
    const seeded = await seedRequest(auth)

    const noRejections = await engine.getPriorRejections(seeded.requesterKey)
    expect(noRejections).to.deep.equal([])

    const unknownKey = await engine.getPriorRejections(randomTestKeyPair().publicHex)
    expect(unknownKey).to.deep.equal([])
  })

  it('rejections belonging to a DIFFERENT RequesterKey are not returned (the read is key-scoped, not authority-scoped)', async () => {
    const auth = await addTestAuthority(await createTestNetwork())
    const engine = new RegistrationEngine(auth.ctx)
    const signerA = makeRequesterSigner()
    const signerB = makeRequesterSigner()

    await seedRequest(auth, {
      signer: signerA,
      status: 'r',
      decidedAt: toIsoZDatetime(Date.now()),
      decidingOfficerUserId: auth.user.id,
      rejectionReason: 'signer A reason'
    })
    const bRejection = await seedRequest(auth, {
      signer: signerB,
      status: 'r',
      decidedAt: toIsoZDatetime(Date.now()),
      decidingOfficerUserId: auth.user.id,
      rejectionReason: 'signer B reason'
    })

    const forB = await engine.getPriorRejections(signerB.publicHex)
    expect(forB.map((r) => r.requestId)).to.deep.equal([bRejection.id])
  })
})
