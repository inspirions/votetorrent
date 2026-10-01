import { expect } from 'chai'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AdminDigestArgs, Signature } from '@votetorrent/vote-core'
import { SigningEngine } from '../src/signing/signing-engine.js'
import { DerivedSigningError } from '../src/signing/threshold.js'
import { fanOutSignatureTasks, FanOutError, SIGNATURE_TYPE_SCOPE } from '../src/signing/fan-out.js'
import { seedSignedMutation } from '../src/signing/signed-mutation.js'
import { BALLOT_HEADER_TID } from '../src/election/election-engine.js'
import { allocateTid } from '../src/database/tid-allocator.js'
import {
  createThresholdAuthority,
  signSessionDigest,
  insertBallotHeaderSession,
  ballotExtensionInserter,
  type ThresholdOfficer,
} from './fixtures/threshold-authority.js'
import { seedProposedBallot } from './fixtures/test-context.js'
import { digestToBytes, nowCanonicalDatetime } from '../src/utils.js'
import type { Database } from '@quereus/quereus'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

function installedQuereusVersion (): string {
  const pkgPath = path.join(__dirname, '..', 'node_modules', '@quereus', 'quereus', 'package.json')
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string }
  return pkg.version
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Mirrors signing.spec.ts's `realSignAdminDigest` — PATH A `startSigningSession`'s own
 *  `Digest(:authorityId, :effectiveAt, :officers, :thresholdPolicies)` formula, signed for real
 *  by a `ThresholdOfficer`'s fixture key. */
async function realSignAdminDigest (
  db: Database,
  authorityId: string,
  digestArgs: AdminDigestArgs,
  officer: ThresholdOfficer
): Promise<Signature> {
  const row = await db
    .prepare('select Digest(:authorityId, :effectiveAt, :officers, :thresholdPolicies) as d')
    .get({
      authorityId,
      effectiveAt: digestArgs.effectiveAt,
      officers: digestArgs.officers,
      thresholdPolicies: digestArgs.thresholdPolicies,
    })
  const digestB64 = row!.d as string
  return officer.sign(digestToBytes(digestB64))
}

function placeholderSignature (signerUserId: string): Signature {
  return { signerUserId, signerKey: '0'.repeat(66), signature: '0'.repeat(128) }
}

// ===========================================================================
// threshold core (62-07) — Task 1: contracts, holder-only counting, signDerived,
// getSigningStatus, and the multi-holder fixture.
// ===========================================================================

describe('threshold core (62-07)', function () {
  this.timeout(60_000)

  it('T1: crossedNow is true exactly once per nonce (D-10)', async () => {
    const fx = await createThresholdAuthority()
    const { ballotId } = await seedProposedBallot(fx.elec, 'ballot-t1')
    const { nonce } = await insertBallotHeaderSession(fx, ballotId, fx.holders[0]!.user.id)
    const engine = new SigningEngine(fx.elec.ctx)

    const sig0 = await signSessionDigest(fx.elec.ctx.db, nonce, fx.holders[0]!.user)
    const r0 = await engine.signWithOutcome(nonce, sig0)
    expect(r0.thresholdReached, 'r0.thresholdReached').to.equal(false)
    expect(r0.crossedNow, 'r0.crossedNow').to.equal(false)

    const sig1 = await signSessionDigest(fx.elec.ctx.db, nonce, fx.holders[1]!.user)
    const r1 = await engine.signWithOutcome(nonce, sig1)
    expect(r1.thresholdReached, 'r1.thresholdReached').to.equal(true)
    expect(r1.crossedNow, 'r1.crossedNow').to.equal(true)

    const sig2 = await signSessionDigest(fx.elec.ctx.db, nonce, fx.holders[2]!.user)
    const r2 = await engine.signWithOutcome(nonce, sig2)
    expect(r2.thresholdReached, 'r2.thresholdReached').to.equal(true)
    expect(r2.crossedNow, 'r2.crossedNow (late signature)').to.equal(false)

    const adminSigCount = await fx.elec.ctx.db
      .prepare('select count(*) as n from AdminSignature where SigningNonce = :nonce')
      .get({ nonce })
    expect(Number(adminSigCount?.n), 'exactly 1 AdminSignature row').to.equal(1)

    const officerSigCount = await fx.elec.ctx.db
      .prepare('select count(*) as n from OfficerSignature where SigningNonce = :nonce')
      .get({ nonce })
    expect(Number(officerSigCount?.n), 'exactly 3 OfficerSignature rows').to.equal(3)
  })

  it('T2: holder-only counting at threshold>1 (D-08/D-12, Pitfall 5)', async () => {
    const fx = await createThresholdAuthority()
    const { ballotId } = await seedProposedBallot(fx.elec, 'ballot-t2')
    const { nonce } = await insertBallotHeaderSession(fx, ballotId, fx.holders[0]!.user.id)
    const engine = new SigningEngine(fx.elec.ctx)

    await engine.signWithOutcome(nonce, await signSessionDigest(fx.elec.ctx.db, nonce, fx.holders[0]!.user))

    const rNonHolder = await engine.signWithOutcome(nonce, await signSessionDigest(fx.elec.ctx.db, nonce, fx.nonHolder.user))
    expect(rNonHolder.thresholdReached, 'non-holder signature must not complete').to.equal(false)

    const rOutsider = await engine.signWithOutcome(nonce, await signSessionDigest(fx.elec.ctx.db, nonce, fx.outsider))
    expect(rOutsider.thresholdReached, 'non-officer signature must not complete').to.equal(false)

    const officerCount = await fx.elec.ctx.db
      .prepare('select count(*) as n from OfficerSignature where SigningNonce = :nonce')
      .get({ nonce })
    expect(Number(officerCount?.n), '3 OfficerSignature rows recorded').to.equal(3)

    const adminCount = await fx.elec.ctx.db
      .prepare('select count(*) as n from AdminSignature where SigningNonce = :nonce')
      .get({ nonce })
    expect(Number(adminCount?.n), '0 AdminSignature rows — neither non-holder nor outsider qualified').to.equal(0)

    const status = await engine.getSigningStatus(nonce)
    expect(status?.signatures, 'only the 1 real holder signature qualifies').to.equal(1)

    const r1 = await engine.signWithOutcome(nonce, await signSessionDigest(fx.elec.ctx.db, nonce, fx.holders[1]!.user))
    expect(r1.crossedNow, 'a second REAL holder crosses the threshold').to.equal(true)
  })

  it('T3: the same holder signing twice stays at signatures=1 (idempotent)', async () => {
    const fx = await createThresholdAuthority()
    const { ballotId } = await seedProposedBallot(fx.elec, 'ballot-t3')
    const { nonce } = await insertBallotHeaderSession(fx, ballotId, fx.holders[0]!.user.id)
    const engine = new SigningEngine(fx.elec.ctx)

    const r0 = await engine.signWithOutcome(nonce, await signSessionDigest(fx.elec.ctx.db, nonce, fx.holders[0]!.user))
    expect(r0.thresholdReached).to.equal(false)

    const r0b = await engine.signWithOutcome(nonce, await signSessionDigest(fx.elec.ctx.db, nonce, fx.holders[0]!.user))
    expect(r0b.thresholdReached, 'repeat signature must not complete').to.equal(false)
    expect(r0b.crossedNow).to.equal(false)

    const status = await engine.getSigningStatus(nonce)
    expect(status?.signatures, 'repeat signature does not double-count').to.equal(1)
  })

  it('T4: the threshold-1 path is unchanged (rad)', async () => {
    const fx = await createThresholdAuthority()
    const engine = new SigningEngine(fx.elec.ctx)
    const digestArgs: AdminDigestArgs = {
      authorityId: fx.authorityId,
      effectiveAt: 'test-effective-at-t4',
      officers: '[]',
      thresholdPolicies: '[]',
    }
    const sig0 = await realSignAdminDigest(fx.elec.ctx.db, fx.authorityId, digestArgs, fx.holders[0]!)
    const result = await engine.startSigningSession(fx.authorityId, digestArgs, 'rad', sig0)
    expect(result.thresholdReached, 'threshold=1 reached on the first signature').to.equal(true)
    expect(result.crossedNow, 'startSigningSession crossed it').to.equal(true)

    const r1 = await engine.signWithOutcome(result.nonce, await signSessionDigest(fx.elec.ctx.db, result.nonce, fx.holders[1]!.user))
    expect(r1.thresholdReached).to.equal(true)
    expect(r1.crossedNow, 'a second signature on an already-reached rad session').to.equal(false)

    const r2 = await engine.sign(result.nonce, await signSessionDigest(fx.elec.ctx.db, result.nonce, fx.holders[2]!.user))
    expect(r2, 'sign() keeps returning the boolean').to.equal(true)
  })

  it('T5: signDerived inherits header satisfaction (Finding 4.1)', async () => {
    const fx = await createThresholdAuthority()
    const { ballotId } = await seedProposedBallot(fx.elec, 'ballot-t5')
    const { nonce: header } = await insertBallotHeaderSession(fx, ballotId, fx.holders[0]!.user.id)
    const engine = new SigningEngine(fx.elec.ctx)
    const db = fx.elec.ctx.db

    const derivedNonce = crypto.randomUUID()
    await db.exec(
      `insert into AdminSigning (Nonce, AuthorityId, AdminEffectiveAt, Scope, Digest, UserId, SignerKey, Signature)
       with context now = :now, IsSignerKeyValid = true, IsPlaceholderSignature = true
       values (:nonce, :authorityId, :adminEffectiveAt, 'ceb', Digest('derived-62-07', :n), :userId, :signerKey, :signature)`,
      {
        nonce: derivedNonce,
        authorityId: fx.authorityId,
        adminEffectiveAt: fx.adminEffectiveAt,
        n: derivedNonce,
        userId: fx.holders[0]!.user.id,
        signerKey: '0'.repeat(66),
        signature: '0'.repeat(128),
        now: nowCanonicalDatetime(),
      }
    )
    const placeholderSig = placeholderSignature(fx.holders[0]!.user.id)

    let caught: unknown
    try {
      await engine.signDerived(derivedNonce, placeholderSig, header, { isPlaceholderSignature: true })
    } catch (err) {
      caught = err
    }
    expect(caught, 'throws before the header is reached').to.be.instanceOf(DerivedSigningError)
    expect((caught as DerivedSigningError).reason).to.equal('header-not-reached')

    const adminCount0 = await db.prepare('select count(*) as n from AdminSignature where SigningNonce = :n').get({ n: derivedNonce })
    expect(Number(adminCount0?.n), 'no AdminSignature written on refusal').to.equal(0)
    const officerCount0 = await db.prepare('select count(*) as n from OfficerSignature where SigningNonce = :n').get({ n: derivedNonce })
    expect(Number(officerCount0?.n), 'no OfficerSignature written on refusal').to.equal(0)

    await engine.signWithOutcome(header, await signSessionDigest(db, header, fx.holders[0]!.user))
    await engine.signWithOutcome(header, await signSessionDigest(db, header, fx.holders[1]!.user))

    const r1 = await engine.signDerived(derivedNonce, placeholderSig, header, { isPlaceholderSignature: true })
    expect(r1.thresholdReached).to.equal(true)
    expect(r1.crossedNow).to.equal(true)

    const adminCount1 = await db.prepare('select count(*) as n from AdminSignature where SigningNonce = :n').get({ n: derivedNonce })
    expect(Number(adminCount1?.n), 'exactly 1 AdminSignature after the header is reached').to.equal(1)

    const r2 = await engine.signDerived(derivedNonce, placeholderSig, header, { isPlaceholderSignature: true })
    expect(r2.thresholdReached).to.equal(true)
    expect(r2.crossedNow, 'repeat call does not re-cross').to.equal(false)

    // scope-mismatch: a 'rad' header (T4's shape) against a 'ceb' derived row.
    const digestArgs: AdminDigestArgs = {
      authorityId: fx.authorityId,
      effectiveAt: 'test-effective-at-t5',
      officers: '[]',
      thresholdPolicies: '[]',
    }
    const radSig = await realSignAdminDigest(db, fx.authorityId, digestArgs, fx.holders[2]!)
    const radResult = await engine.startSigningSession(fx.authorityId, digestArgs, 'rad', radSig)

    const derivedNonce2 = crypto.randomUUID()
    await db.exec(
      `insert into AdminSigning (Nonce, AuthorityId, AdminEffectiveAt, Scope, Digest, UserId, SignerKey, Signature)
       with context now = :now, IsSignerKeyValid = true, IsPlaceholderSignature = true
       values (:nonce, :authorityId, :adminEffectiveAt, 'ceb', Digest('derived-62-07-b', :n), :userId, :signerKey, :signature)`,
      {
        nonce: derivedNonce2,
        authorityId: fx.authorityId,
        adminEffectiveAt: fx.adminEffectiveAt,
        n: derivedNonce2,
        userId: fx.holders[0]!.user.id,
        signerKey: '0'.repeat(66),
        signature: '0'.repeat(128),
        now: nowCanonicalDatetime(),
      }
    )
    let caught2: unknown
    try {
      await engine.signDerived(derivedNonce2, placeholderSignature(fx.holders[0]!.user.id), radResult.nonce, { isPlaceholderSignature: true })
    } catch (err) {
      caught2 = err
    }
    expect(caught2, 'throws on a scope mismatch').to.be.instanceOf(DerivedSigningError)
    expect((caught2 as DerivedSigningError).reason).to.equal('scope-mismatch')
  })

  it('T6: getSigningStatus (D-11)', async () => {
    const fx = await createThresholdAuthority()
    const engine = new SigningEngine(fx.elec.ctx)

    const statusUnknown = await engine.getSigningStatus('unknown-nonce-62-07')
    expect(statusUnknown, 'unknown nonce returns null').to.equal(null)

    const { ballotId } = await seedProposedBallot(fx.elec, 'ballot-t6')
    const { nonce } = await insertBallotHeaderSession(fx, ballotId, fx.holders[0]!.user.id)
    await engine.signWithOutcome(nonce, await signSessionDigest(fx.elec.ctx.db, nonce, fx.holders[0]!.user))

    const status = await engine.getSigningStatus(nonce)
    expect(status?.threshold).to.equal(2)
    expect(status?.signatures).to.equal(1)
    expect(status?.reached).to.equal(false)
    expect(status?.scope).to.equal('ceb')
  })
})
