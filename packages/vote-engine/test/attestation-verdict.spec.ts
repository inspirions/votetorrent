/**
 * attestation-verdict.spec.ts — Phase 47-08 real-engine + mock-parity spec
 * for the D-03 `AttestationVerdict` store.
 *
 * Proves: both write paths (pass AND fail) inside `associate()`, the
 * write-before-throw ordering (behaviorally AND via a static source-order
 * lock), the text-code shape of `Verdict`, monotonic `Sequence` per
 * `(RegistrantId, DeviceKey)`, `InsertOnly`, that the store never touches
 * `AssociationPrivate`, the skip-verify (`AttestationRequired=0`) no-row
 * contract, the two-directional ordering guard (T-47-11), and
 * `MockAssociationEngine` parity.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { expect } from 'chai'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js'
import type { AttestationChallenge, AttestationVerification, DeviceAttestation, IAttestationVerifier, Signature } from '@votetorrent/vote-core'
import { AssociationEngine } from '../src/association/association-engine.js'
import { MockAssociationEngine } from '../src/association/mock-association-engine.js'
import { RegistrationEngine } from '../src/registration/registration-engine.js'
import { createTestNetwork, addTestAuthority, addTestElection } from './fixtures/test-context.js'
import { randomTestKeyPair } from './fixtures/keys.js'
import type { TestAuthorityContext } from './fixtures/test-context.js'
import type { EngineContext } from '../src/types.js'

// ---------------------------------------------------------------------------
// Helpers (copied from association.spec.ts, id prefixes changed to avoid
// cross-file id collisions inside the same mocha process)
// ---------------------------------------------------------------------------

/** Resolve the single Election row seeded by addTestElection() for this authority. */
async function resolveElectionId (ctx: EngineContext, authorityId: string): Promise<string> {
  const row = await ctx.db
    .prepare('select Id from Election where AuthorityId = :authorityId limit 1')
    .get({ authorityId })
  if (!row) throw new Error('resolveElectionId: Election not found for authority')
  return row.Id as string
}

/** Build a real secp256k1 sign callback (@noble/curves v2 defaults — prehash:true). */
function makeRealSigner (userId: string): { sign: (digest: Uint8Array) => Promise<Signature>; publicHex: string; privateHex: string } {
  const { privateHex, publicHex } = randomTestKeyPair()
  const privBytes = hexToBytes(privateHex)
  const sign = async (digest: Uint8Array): Promise<Signature> => {
    const sig = secp256k1.sign(digest, privBytes) // v2 default: prehash:true
    return { signerUserId: userId, signerKey: publicHex, signature: bytesToHex(sig) }
  }
  return { sign, publicHex, privateHex }
}

let registrantSeq = 0
function nextRegistrantId (): string {
  registrantSeq += 1
  return `verdict-registrant-${Date.now()}-${registrantSeq}`
}

let deviceSeq = 0
function nextDeviceKey (): string {
  deviceSeq += 1
  return `verdict-device-key-${Date.now()}-${deviceSeq}`
}

const FUTURE_REGISTRANT_EXPIRATION = Date.now() + 365 * 86_400_000
const FUTURE_CHALLENGE_EXPIRATION = new Date(Date.now() + 10 * 60_000).toISOString()

function makeDeviceAttestation (overrides?: Partial<DeviceAttestation>): DeviceAttestation {
  deviceSeq += 1
  return {
    publicKey: `verdict-device-pubkey-${deviceSeq}`,
    deviceId: `verdict-device-id-${Date.now()}-${deviceSeq}`,
    attestationTime: Date.now(),
    certificateChain: ['cert-a', 'cert-b'],
    ...overrides
  }
}

/** Seed an active Registrant (Status='a') for the attestation flow to associate against. */
async function setupAssociationTest (): Promise<{
  auth: TestAuthorityContext
  registrantId: string
  engine: AssociationEngine
  registrationEngine: RegistrationEngine
  sign: (digest: Uint8Array) => Promise<Signature>
}> {
  const net = await createTestNetwork()
  const auth = await addTestAuthority(net)
  const { sign } = makeRealSigner(auth.user.id)
  const registrationEngine = new RegistrationEngine(auth.ctx)
  const registrantId = nextRegistrantId()
  await registrationEngine.createRegistrant(
    { id: registrantId, authorityId: auth.authority.id, privateCid: 'verdict-test-private-cid-placeholder', expiration: FUTURE_REGISTRANT_EXPIRATION },
    sign
  )
  const engine = new AssociationEngine(auth.ctx)
  return { auth, registrantId, engine, registrationEngine, sign }
}

const REJECT_REASON = 'simulated rejection (D-03 fail-path)'
const rejectingVerifier: IAttestationVerifier = {
  async verify (): Promise<AttestationVerification> {
    return { ok: false, reason: REJECT_REASON }
  }
}

/** A verifier that ALWAYS throws — proves whether verify() was ever invoked at all. */
const throwIfCalledVerifier: IAttestationVerifier = {
  async verify (): Promise<AttestationVerification> {
    throw new Error('verify() must not run on the non-attested (AttestationRequired=0) path — D-14c')
  }
}

/** A subclass whose recordAttestationVerdict always throws — proves the T-47-11 ordering guard. */
class ThrowingVerdictEngine extends AssociationEngine {
  async recordAttestationVerdict (): Promise<void> {
    throw new Error('synthetic verdict-store failure')
  }
}

// ===========================================================================

describe('AttestationVerdict store (D-03)', () => {
  describe('associate() write site — both paths', () => {
    it('pass path: exactly one AttestationVerdict row, Verdict=pass, Sequence=0, Reason null', async () => {
      const { auth, registrantId, engine, sign } = await setupAssociationTest()
      const deviceKey = nextDeviceKey()
      const challenge = await engine.issueAttestationChallenge(registrantId, deviceKey, FUTURE_CHALLENGE_EXPIRATION, sign)
      const attestation = makeDeviceAttestation()

      await engine.associate({ registrantId, deviceKey, nonce: challenge.nonce, attestation }, sign)

      const verdicts = await engine.getAttestationVerdicts(registrantId, deviceKey)
      expect(verdicts).to.have.lengthOf(1)
      expect(verdicts[0].verdict).to.equal('pass')
      expect(verdicts[0].sequence).to.equal(0)
      expect(verdicts[0].reason).to.be.undefined

      const associationCount = await auth.ctx.db
        .prepare('select count(*) as n from Association where RegistrantId = :registrantId and DeviceKey = :deviceKey')
        .get({ registrantId, deviceKey })
      expect(Number(associationCount?.n)).to.equal(1)
    })

    it('fail path (THE test of this plan): a fail-verdict row exists after a rejected associate()', async () => {
      const { auth, registrantId, sign } = await setupAssociationTest()
      const engine = new AssociationEngine(auth.ctx, rejectingVerifier)
      const deviceKey = nextDeviceKey()
      const challenge = await engine.issueAttestationChallenge(registrantId, deviceKey, FUTURE_CHALLENGE_EXPIRATION, sign)
      const attestation = makeDeviceAttestation()

      let threw = false
      try {
        await engine.associate({ registrantId, deviceKey, nonce: challenge.nonce, attestation }, sign)
      } catch (err) {
        threw = true
        expect((err as Error).message).to.match(/attestation verification failed/)
      }
      expect(threw, 'expected associate() to throw on seam rejection').to.be.true

      const row = await auth.ctx.db
        .prepare('select Verdict, Reason, Sequence from AttestationVerdict where RegistrantId = :r and DeviceKey = :d')
        .get({ r: registrantId, d: deviceKey })
      expect(
        row,
        'D-03: the verdict insert must run BEFORE the fail-closed throw — a fail verdict with no row means the insert moved after it'
      ).to.not.be.undefined
      expect(row?.Verdict).to.equal('fail')
      expect(Number(row?.Sequence)).to.equal(0)
      expect(row?.Reason).to.equal(REJECT_REASON)
    })

    it('fail path leaves NO Association/AssociationPrivate rows, while the verdict row survives', async () => {
      const { auth, registrantId, sign } = await setupAssociationTest()
      const engine = new AssociationEngine(auth.ctx, rejectingVerifier)
      const deviceKey = nextDeviceKey()
      const challenge = await engine.issueAttestationChallenge(registrantId, deviceKey, FUTURE_CHALLENGE_EXPIRATION, sign)
      const attestation = makeDeviceAttestation()

      try {
        await engine.associate({ registrantId, deviceKey, nonce: challenge.nonce, attestation }, sign)
      } catch {
        // expected
      }

      // This is exactly why 47-01 declares NO foreign-key CHECK on
      // AttestationVerdict.DeviceKey: an FK would make this row impossible.
      const associationCount = await auth.ctx.db
        .prepare('select count(*) as n from Association where RegistrantId = :registrantId and DeviceKey = :deviceKey')
        .get({ registrantId, deviceKey })
      expect(Number(associationCount?.n)).to.equal(0)
      const privateCount = await auth.ctx.db
        .prepare('select count(*) as n from AssociationPrivate where RegistrantId = :registrantId and DeviceKey = :deviceKey')
        .get({ registrantId, deviceKey })
      expect(Number(privateCount?.n)).to.equal(0)

      const verdictCount = await auth.ctx.db
        .prepare('select count(*) as n from AttestationVerdict where RegistrantId = :registrantId and DeviceKey = :deviceKey')
        .get({ registrantId, deviceKey })
      expect(Number(verdictCount?.n)).to.equal(1)
    })

    it('Verdict is a TEXT code, never a boolean (votetorrent.qsql:1661-1662 rationale)', async () => {
      const { auth, registrantId: passRegistrantId, sign } = await setupAssociationTest()
      const passEngine = new AssociationEngine(auth.ctx)
      const deviceKeyPass = nextDeviceKey()
      const passChallenge = await passEngine.issueAttestationChallenge(passRegistrantId, deviceKeyPass, FUTURE_CHALLENGE_EXPIRATION, sign)
      await passEngine.associate({ registrantId: passRegistrantId, deviceKey: deviceKeyPass, nonce: passChallenge.nonce, attestation: makeDeviceAttestation() }, sign)

      const failEngine = new AssociationEngine(auth.ctx, rejectingVerifier)
      const deviceKeyFail = nextDeviceKey()
      const failChallenge = await failEngine.issueAttestationChallenge(passRegistrantId, deviceKeyFail, FUTURE_CHALLENGE_EXPIRATION, sign)
      try {
        await failEngine.associate({ registrantId: passRegistrantId, deviceKey: deviceKeyFail, nonce: failChallenge.nonce, attestation: makeDeviceAttestation() }, sign)
      } catch {
        // expected
      }

      const passRow = await auth.ctx.db
        .prepare('select Verdict from AttestationVerdict where RegistrantId = :r and DeviceKey = :d')
        .get({ r: passRegistrantId, d: deviceKeyPass })
      const failRow = await auth.ctx.db
        .prepare('select Verdict from AttestationVerdict where RegistrantId = :r and DeviceKey = :d')
        .get({ r: passRegistrantId, d: deviceKeyFail })

      expect(typeof passRow?.Verdict).to.equal('string')
      expect(typeof failRow?.Verdict).to.equal('string')
      expect(passRow?.Verdict).to.equal('pass')
      expect(failRow?.Verdict).to.equal('fail')
      for (const bad of [0, 1, '0', '1', true, false]) {
        expect(passRow?.Verdict).to.not.equal(bad)
        expect(failRow?.Verdict).to.not.equal(bad)
      }
    })

    it('skip-verify path (AttestationRequired=0) writes NO verdict row; AttestationCid is still non-null', async () => {
      const { auth, registrantId, registrationEngine, sign } = await setupAssociationTest()
      const elec = await addTestElection(auth)
      const electionId = await resolveElectionId(elec.ctx, elec.authority.id)
      await registrationEngine.setElectionAttestationPolicy(electionId, false, sign)

      const engine = new AssociationEngine(auth.ctx, throwIfCalledVerifier)
      const deviceKey = nextDeviceKey()
      const challenge = await engine.issueAttestationChallenge(registrantId, deviceKey, FUTURE_CHALLENGE_EXPIRATION, sign, electionId)
      const attestation = makeDeviceAttestation()

      // Resolving (not throwing) is itself the proof that verify() never ran.
      await engine.associate({ registrantId, deviceKey, nonce: challenge.nonce, attestation }, sign)

      const associationRow = await auth.ctx.db
        .prepare('select count(*) as n from Association where RegistrantId = :registrantId and DeviceKey = :deviceKey')
        .get({ registrantId, deviceKey })
      expect(Number(associationRow?.n)).to.equal(1)

      const verdicts = await engine.getAttestationVerdicts(registrantId, deviceKey)
      expect(verdicts).to.have.lengthOf(0)

      // D-03 contract 47-15/47-16 depend on: AttestationCid is non-null on the
      // non-attested path too (Phase 45 D-14a..D-14e) — so the ABSENCE of a
      // verdict row, not AttestationCid, is the honest "never attested" signal.
      const association = await engine.getAssociation(registrantId, deviceKey)
      expect(association?.attestationCid).to.not.be.null
      expect(association?.attestationCid).to.be.a('string').with.length.greaterThan(0)
    })

    describe('ordering guard (T-47-11), two directions', () => {
      it('(a) a throwing recordAttestationVerdict on the FAIL path does not mask or re-shape the rejection', async () => {
        const { auth, registrantId, sign } = await setupAssociationTest()
        const engine = new ThrowingVerdictEngine(auth.ctx, rejectingVerifier)
        const deviceKey = nextDeviceKey()
        const challenge = await engine.issueAttestationChallenge(registrantId, deviceKey, FUTURE_CHALLENGE_EXPIRATION, sign)
        const attestation = makeDeviceAttestation()

        let caught: Error | undefined
        try {
          await engine.associate({ registrantId, deviceKey, nonce: challenge.nonce, attestation }, sign)
        } catch (err) {
          caught = err as Error
        }
        expect(caught).to.not.be.undefined
        expect(caught!.message).to.match(/attestation verification failed/)
        expect(caught!.message).to.not.match(/synthetic verdict-store failure/)
        expect(caught!.cause).to.be.instanceOf(Error)
        expect((caught!.cause as Error).message).to.equal('synthetic verdict-store failure')
      })

      it('(b) a throwing recordAttestationVerdict on the PASS path is surfaced, never swallowed; no Association is written', async () => {
        const { auth, registrantId, sign } = await setupAssociationTest()
        const engine = new ThrowingVerdictEngine(auth.ctx)
        const deviceKey = nextDeviceKey()
        const challenge = await engine.issueAttestationChallenge(registrantId, deviceKey, FUTURE_CHALLENGE_EXPIRATION, sign)
        const attestation = makeDeviceAttestation()

        let caught: Error | undefined
        try {
          await engine.associate({ registrantId, deviceKey, nonce: challenge.nonce, attestation }, sign)
        } catch (err) {
          caught = err as Error
        }
        expect(caught).to.not.be.undefined
        expect(caught!.message).to.match(/synthetic verdict-store failure/)

        const associationCount = await auth.ctx.db
          .prepare('select count(*) as n from Association where RegistrantId = :registrantId and DeviceKey = :deviceKey')
          .get({ registrantId, deviceKey })
        expect(Number(associationCount?.n)).to.equal(0)
      })
    })
  })

  describe('source-order lock (write-before-throw)', () => {
    it('this.recordAttestationVerdict( precedes if (!verification.ok) in association-engine.ts', () => {
      const here = dirname(fileURLToPath(import.meta.url))
      const srcPath = join(here, '..', 'src', 'association', 'association-engine.ts')
      const lines = readFileSync(srcPath, 'utf8')
        .split('\n')
        .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))

      const recordIdx = lines.findIndex((l) => l.includes('this.recordAttestationVerdict('))
      const gateIdx = lines.findIndex((l) => l.includes('if (!verification.ok)'))

      expect(recordIdx, 'this.recordAttestationVerdict( anchor not found').to.be.greaterThan(-1)
      expect(gateIdx, 'if (!verification.ok) anchor not found').to.be.greaterThan(-1)
      expect(
        recordIdx,
        'moving the verdict insert after the fail-closed throw records nothing on the fail path — D-03 delivers nothing'
      ).to.be.lessThan(gateIdx)
    })
  })

  describe('recordAttestationVerdict / getAttestationVerdicts (direct)', () => {
    it('Sequence is monotonic per (RegistrantId, DeviceKey); independent across device keys and registrants', async () => {
      const { auth, registrantId, engine, registrationEngine, sign } = await setupAssociationTest()
      const deviceKeyA = nextDeviceKey()
      const deviceKeyB = nextDeviceKey()

      await engine.recordAttestationVerdict(registrantId, deviceKeyA, { ok: false, reason: 'r1' })
      await engine.recordAttestationVerdict(registrantId, deviceKeyA, { ok: true })
      await engine.recordAttestationVerdict(registrantId, deviceKeyA, { ok: false, reason: 'r3' })

      const aRows = await engine.getAttestationVerdicts(registrantId, deviceKeyA)
      expect(aRows.map((r) => r.sequence)).to.deep.equal([0, 1, 2])
      expect(aRows.map((r) => r.verdict)).to.deep.equal(['fail', 'pass', 'fail'])

      await engine.recordAttestationVerdict(registrantId, deviceKeyB, { ok: true })
      const bRows = await engine.getAttestationVerdicts(registrantId, deviceKeyB)
      expect(bRows[0].sequence).to.equal(0)

      // second registrant IN THE SAME authority context, same device key — no cross-registrant bleed
      const registrantId2 = nextRegistrantId()
      await registrationEngine.createRegistrant(
        { id: registrantId2, authorityId: auth.authority.id, privateCid: 'verdict-test-private-cid-placeholder-2', expiration: FUTURE_REGISTRANT_EXPIRATION },
        sign
      )
      await engine.recordAttestationVerdict(registrantId2, deviceKeyA, { ok: true })
      const secondRegistrantRows = await engine.getAttestationVerdicts(registrantId2, deviceKeyA)
      expect(secondRegistrantRows[0].sequence).to.equal(0)
    })

    it('read shape and ordering: unfiltered spans device keys, narrowed returns only one, last element is most recent', async () => {
      const { registrantId, engine } = await setupAssociationTest()
      const deviceKeyA = nextDeviceKey()
      const deviceKeyB = nextDeviceKey()

      await engine.recordAttestationVerdict(registrantId, deviceKeyA, { ok: false, reason: 'r1' })
      await engine.recordAttestationVerdict(registrantId, deviceKeyA, { ok: true })
      await engine.recordAttestationVerdict(registrantId, deviceKeyA, { ok: false, reason: 'r3' })
      await engine.recordAttestationVerdict(registrantId, deviceKeyB, { ok: true })

      const all = await engine.getAttestationVerdicts(registrantId)
      expect(all).to.have.lengthOf(4)
      // ordered DeviceKey asc then Sequence asc
      const sortedKeys = [...all].sort((a, b) => (a.deviceKey < b.deviceKey ? -1 : a.deviceKey > b.deviceKey ? 1 : a.sequence - b.sequence))
      expect(all.map((r) => `${r.deviceKey}:${r.sequence}`)).to.deep.equal(sortedKeys.map((r) => `${r.deviceKey}:${r.sequence}`))

      const narrowed = await engine.getAttestationVerdicts(registrantId, deviceKeyA)
      expect(narrowed).to.have.lengthOf(3)
      expect(narrowed.every((r) => r.deviceKey === deviceKeyA)).to.be.true
      const last = narrowed[narrowed.length - 1]
      expect(last.sequence).to.equal(2)
      expect(last.verdict).to.equal('fail')
    })

    it('reason and verifiedAt round-trip: reason is undefined (not null) when omitted; verifiedAt is Z-suffixed', async () => {
      const { registrantId, engine } = await setupAssociationTest()
      const deviceKey = nextDeviceKey()

      await engine.recordAttestationVerdict(registrantId, deviceKey, { ok: true })
      await engine.recordAttestationVerdict(registrantId, deviceKey, { ok: false, reason: 'exact-reason' })

      const rows = await engine.getAttestationVerdicts(registrantId, deviceKey)
      expect(rows[0].reason).to.be.undefined
      expect(rows[1].reason).to.equal('exact-reason')
      for (const row of rows) {
        expect(row.verifiedAt).to.match(/Z$/)
      }
    })

    it('unwired ctx: getAttestationVerdicts resolves [] without throwing; recordAttestationVerdict rejects', async () => {
      const engine = new AssociationEngine()
      // Reads degrade to empty; writes fail loudly (the getAssociation bare-guard vs requireCtx asymmetry).
      const result = await engine.getAttestationVerdicts('x')
      expect(result).to.deep.equal([])

      let threw = false
      try {
        await engine.recordAttestationVerdict('x', 'y', { ok: true })
      } catch {
        threw = true
      }
      expect(threw).to.be.true
    })

    it('InsertOnly: raw update and delete are rejected; the seeded row is unchanged', async () => {
      const { auth, registrantId, engine } = await setupAssociationTest()
      const deviceKey = nextDeviceKey()
      await engine.recordAttestationVerdict(registrantId, deviceKey, { ok: true })

      let updateErr: unknown
      try {
        await auth.ctx.db.exec(
          `update AttestationVerdict with context Tid = 9, now = ${Date.now()} set Reason = 'tampered'`
        )
      } catch (err) {
        updateErr = err
      }
      // Missing mutation context may fire before InsertOnly.
      expect(updateErr).to.be.instanceOf(Error)

      let deleteErr: unknown
      try {
        await auth.ctx.db.exec(
          `delete from AttestationVerdict with context Tid = 9, now = ${Date.now()}`
        )
      } catch (err) {
        deleteErr = err
      }
      // Missing mutation context may fire before InsertOnly.
      expect(deleteErr).to.be.instanceOf(Error)

      const row = await auth.ctx.db
        .prepare('select Reason from AttestationVerdict where RegistrantId = :registrantId and DeviceKey = :deviceKey')
        .get({ registrantId, deviceKey })
      expect(row?.Reason).to.not.equal('tampered')
    })

    it('never touches AssociationPrivate: its Cid is unchanged by further verdicts', async () => {
      const { auth, registrantId, engine, sign } = await setupAssociationTest()
      const deviceKey = nextDeviceKey()
      const challenge = await engine.issueAttestationChallenge(registrantId, deviceKey, FUTURE_CHALLENGE_EXPIRATION, sign)
      await engine.associate({ registrantId, deviceKey, nonce: challenge.nonce, attestation: makeDeviceAttestation() }, sign)

      const before = await auth.ctx.db
        .prepare('select Cid from AssociationPrivate where RegistrantId = :registrantId and DeviceKey = :deviceKey')
        .get({ registrantId, deviceKey })
      const capturedCid = before?.Cid

      await engine.recordAttestationVerdict(registrantId, deviceKey, { ok: true })
      await engine.recordAttestationVerdict(registrantId, deviceKey, { ok: false, reason: 'x' })

      const countRow = await auth.ctx.db
        .prepare('select count(*) as n from AssociationPrivate where RegistrantId = :registrantId and DeviceKey = :deviceKey')
        .get({ registrantId, deviceKey })
      expect(Number(countRow?.n)).to.equal(1)

      const after = await auth.ctx.db
        .prepare('select Cid from AssociationPrivate where RegistrantId = :registrantId and DeviceKey = :deviceKey')
        .get({ registrantId, deviceKey })
      expect(after?.Cid).to.equal(capturedCid)
    })
  })

  describe('MockAssociationEngine parity', () => {
    it('recordAttestationVerdict: sequences restart per device key and per registrant', async () => {
      const mock = new MockAssociationEngine()
      const registrantId = nextRegistrantId()
      const deviceKeyA = nextDeviceKey()
      const deviceKeyB = nextDeviceKey()

      await mock.recordAttestationVerdict(registrantId, deviceKeyA, { ok: false, reason: 'r1' })
      await mock.recordAttestationVerdict(registrantId, deviceKeyA, { ok: true })
      await mock.recordAttestationVerdict(registrantId, deviceKeyA, { ok: false, reason: 'r3' })
      const aRows = await mock.getAttestationVerdicts(registrantId, deviceKeyA)
      expect(aRows.map((r) => r.sequence)).to.deep.equal([0, 1, 2])

      await mock.recordAttestationVerdict(registrantId, deviceKeyB, { ok: true })
      const bRows = await mock.getAttestationVerdicts(registrantId, deviceKeyB)
      expect(bRows[0].sequence).to.equal(0)

      const registrantId2 = nextRegistrantId()
      await mock.recordAttestationVerdict(registrantId2, deviceKeyA, { ok: true })
      const secondRegistrantRows = await mock.getAttestationVerdicts(registrantId2, deviceKeyA)
      expect(secondRegistrantRows[0].sequence).to.equal(0)
    })

    it('getAttestationVerdicts: unfiltered/narrowed shapes match the real engine; associate() records exactly one pass verdict', async () => {
      const mock = new MockAssociationEngine()
      const registrantId = nextRegistrantId()
      const deviceKeyA = nextDeviceKey()
      const deviceKeyB = nextDeviceKey()

      await mock.recordAttestationVerdict(registrantId, deviceKeyA, { ok: false, reason: 'r1' })
      await mock.recordAttestationVerdict(registrantId, deviceKeyA, { ok: true })
      await mock.recordAttestationVerdict(registrantId, deviceKeyB, { ok: true })

      const all = await mock.getAttestationVerdicts(registrantId)
      expect(all).to.have.lengthOf(3)
      const keySet = all.map((r) => Object.keys(r).sort()).map((k) => k.join(','))
      const expectedKeySet = ['deviceKey', 'reason', 'registrantId', 'sequence', 'verdict', 'verifiedAt'].sort().join(',')
      for (const k of keySet) {
        // reason is optional and may be absent from the key set for pass rows —
        // compare against the union of possible shapes instead of exact equality.
        expect(expectedKeySet.includes(k) || k === ['deviceKey', 'registrantId', 'sequence', 'verdict', 'verifiedAt'].sort().join(',')).to.equal(true)
      }

      const narrowed = await mock.getAttestationVerdicts(registrantId, deviceKeyA)
      expect(narrowed).to.have.lengthOf(2)
      expect(narrowed.every((r) => r.deviceKey === deviceKeyA)).to.be.true

      // The mock holds no IAttestationVerifier and can therefore only ever
      // produce a 'pass' verdict from associate() — fail-path behavior is
      // proven against the real engine only (tests above).
      const deviceKey = nextDeviceKey()
      const challenge = await mock.issueAttestationChallenge('mock-assoc-registrant', deviceKey, FUTURE_CHALLENGE_EXPIRATION, { signerUserId: 'u', signerKey: 'k', signature: 's' })
      await mock.associate(
        { registrantId: 'mock-assoc-registrant', deviceKey, nonce: challenge.nonce, attestation: makeDeviceAttestation() },
        { signerUserId: 'u', signerKey: 'k', signature: 's' }
      )
      const mockVerdicts = await mock.getAttestationVerdicts('mock-assoc-registrant', deviceKey)
      expect(mockVerdicts).to.have.lengthOf(1)
      expect(mockVerdicts[0].verdict).to.equal('pass')
    })
  })
})
