/**
 * election-key-hardening.spec.ts (62-34, V-2)
 *
 * A live keyholder can publish the write-once ElectionKey row with the right
 * joint key Y but junk (or non-JSON) GroupCommitments. These real-engine
 * regressions pin that:
 *   - the DKG status reports such a row as failed/'election-key-mismatch'
 *     (E1-E3) and no DKG reader throws on a malformed column, and
 *   - key release validates every share against commitments DERIVED FROM THE
 *     TRANSCRIPT, so the election key stays recoverable (R1-R3).
 */

import { expect } from 'chai'
import type { Database } from '@quereus/quereus'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { parseRound4Payload, serializeRound4Payload } from '../src/keyholder/dkg-payloads.js'
import { digestToBytes } from '../src/utils.js'
import { postSignedDkgMessage, runDkgToQuiescence, seedDkgElection, type DkgTestParticipant } from './fixtures/dkg-keyholders.js'

async function countRound4 (db: Database, electionId: string, revision: number, attempt: number): Promise<number> {
  const row = await db
    .prepare('select count(*) as c from KeyholderDkgMessage where ElectionId = :electionId and ElectionRevision = :revision and Attempt = :attempt and DkgRound = 4')
    .get({ electionId, revision, attempt })
  return (row?.c as number | undefined) ?? 0
}

interface ForgedSetup {
  auth: Awaited<ReturnType<typeof seedDkgElection>>['auth']
  electionId: string
  revision: number
  participants: DkgTestParticipant[]
  /** Participants whose own engine posted round 4 (their vault holds the share). */
  holders: DkgTestParticipant[]
  /** The one participant whose round-4 row was injected so the schema's all-keyholders-agree check lets a forged key in before any honest publish. */
  late: DkgTestParticipant
  /** The honest round-4 result the forged row is built from. */
  y: string
  commitments: string[]
}

/**
 * Drives a 3-of-5 DKG until four of the five round-4 rows exist, then posts the fifth participant's round-4 row
 * directly (the ElectionKey table's AllKeyholdersAgree CHECK needs all five). No honest engine has run since, so no
 * honest publish can have happened: the caller's forged row is the write-once key.
 */
async function driveToRound4Minus1 (): Promise<ForgedSetup> {
  const { auth, electionId, revision, participants } = await seedDkgElection({
    keyholders: ['Alice', 'Bob', 'Carol', 'Dave', 'Eve'], threshold: 3
  })
  const db = auth.ctx.db
  await runDkgToQuiescence(participants, electionId, {
    stopWhen: async () => (await countRound4(db, electionId, revision, 1)) === 4
  })
  const r4 = await db
    .prepare('select Payload from KeyholderDkgMessage where ElectionId = :electionId and ElectionRevision = :revision and Attempt = 1 and DkgRound = 4')
    .get({ electionId, revision })
  const parsed = parseRound4Payload(r4!.Payload as string)!
  let late: DkgTestParticipant | undefined
  for (const p of participants) {
    const row = await db
      .prepare('select 1 as x from KeyholderDkgMessage where ElectionId = :electionId and ElectionRevision = :revision and Attempt = 1 and DkgRound = 4 and SenderUserId = :u')
      .get({ electionId, revision, u: p.userId })
    if (!row) late = p
  }
  if (late === undefined) throw new Error('driveToRound4Minus1: every participant already posted round 4')
  await postSignedDkgMessage(db, late, {
    electionId, revision, attempt: 1, dkgRound: 4,
    payload: serializeRound4Payload({ groupPublicKey: parsed.groupPublicKey, groupCommitments: parsed.groupCommitments }), resultKey: parsed.groupPublicKey
  })
  const holders = participants.filter((p) => p.userId !== late!.userId)
  return { auth, electionId, revision, participants, holders, late, y: parsed.groupPublicKey, commitments: parsed.groupCommitments }
}

/** Raw-handle publish of a correctly SIGNED ElectionKey (copies the engine's Digest/sign/insert shape). */
async function publishForgedElectionKey (
  setup: ForgedSetup, publisher: DkgTestParticipant, over: { groupCommitments: string, participants?: number }
): Promise<void> {
  const { auth, electionId, revision } = setup
  const db = auth.ctx.db
  const publishedAt = new Date().toISOString()
  const participantsCount = over.participants ?? 5
  const digestRow = await db
    .prepare("select Digest('ElectionKey', :electionId, :revision, :attempt, :jointPublicKey, :groupCommitments, :threshold, :participants, :publishedAt, :publisherUserId) as d")
    .get({
      electionId, revision, attempt: 1, jointPublicKey: setup.y, groupCommitments: over.groupCommitments,
      threshold: 3, participants: participantsCount, publishedAt, publisherUserId: publisher.userId
    })
  const signature = await publisher.signer.sign(digestToBytes(digestRow!.d as string))
  await db.exec(
    `insert into ElectionKey (ElectionId, ElectionRevision, Attempt, JointPublicKey, GroupCommitments, Threshold, Participants, PublishedAt, PublisherUserId, PublisherKey, Signature)
     values (:electionId, :revision, :attempt, :jointPublicKey, :groupCommitments, :threshold, :participants, :publishedAt, :publisherUserId, :publisherKey, :signature)`,
    {
      electionId, revision, attempt: 1, jointPublicKey: setup.y, groupCommitments: over.groupCommitments, threshold: 3,
      participants: participantsCount, publishedAt, publisherUserId: publisher.userId, publisherKey: signature.signerKey, signature: signature.signature
    }
  )
}

function junkCommitments (commitments: string[]): string {
  const other = bytesToHex(secp256k1.getPublicKey(secp256k1.utils.randomSecretKey(), true))
  const forged = [...commitments]
  forged[1] = other
  return JSON.stringify(forged)
}

describe('election-key-hardening: V-2 (62-34)', function () {
  this.timeout(240000)

  describe('E: DKG status binds the ElectionKey to the round-4 result', function () {
    it('E1: an ElectionKey with right Y but junk GroupCommitments reads failed/election-key-mismatch, never complete', async () => {
      const setup = await driveToRound4Minus1()
      await publishForgedElectionKey(setup, setup.holders[0]!, { groupCommitments: junkCommitments(setup.commitments) })
      await runDkgToQuiescence(setup.holders, setup.electionId)

      const status = await setup.holders[1]!.engine.getDkgStatus(setup.electionId)
      expect(status.phase).to.equal('failed')
      expect(status.failedReason).to.equal('election-key-mismatch')
      const verdict = await setup.holders[1]!.engine.verifyDkgTranscript(setup.electionId)
      expect(verdict.electionKeyConsistent).to.equal(false)
    })

    it('E2: a non-JSON GroupCommitments makes no DKG reader throw; status is failed/election-key-mismatch and getElectionKey reports []', async () => {
      const setup = await driveToRound4Minus1()
      let refused: unknown = null
      try {
        await publishForgedElectionKey(setup, setup.holders[0]!, { groupCommitments: 'not-json' })
      } catch (err) {
        refused = err
      }
      if (refused !== null) {
        // The schema refused the text: the refusal itself is the proof; fall back to a JSON array of non-points.
        await publishForgedElectionKey(setup, setup.holders[0]!, { groupCommitments: JSON.stringify(['not-a-point', 'neither']) })
      }
      await runDkgToQuiescence(setup.holders, setup.electionId)

      const honest = setup.holders[1]!
      const status = await honest.engine.getDkgStatus(setup.electionId)
      expect(status.phase).to.equal('failed')
      expect(status.failedReason).to.equal('election-key-mismatch')
      const advance = await honest.engine.advanceDkg(setup.electionId, honest.signer)
      expect(advance.actions).to.be.an('array')
      const ek = await honest.engine.getElectionKey(setup.electionId)
      expect(ek).to.not.equal(null)
      expect(ek!.groupCommitments).to.deep.equal([])
      const verdict = await honest.engine.verifyDkgTranscript(setup.electionId)
      expect(verdict.electionKeyConsistent).to.equal(false)
    })

    it('E3: an ElectionKey whose Participants differs from the agreed roster reads failed/election-key-mismatch (measured: the schema refuses it, ParticipantsAreKeyholders)', async () => {
      const setup = await driveToRound4Minus1()
      let refused: unknown = null
      try {
        await publishForgedElectionKey(setup, setup.holders[0]!, { groupCommitments: JSON.stringify(setup.commitments), participants: 4 })
      } catch (err) {
        refused = err
      }
      await runDkgToQuiescence(setup.holders, setup.electionId)
      const status = await setup.holders[1]!.engine.getDkgStatus(setup.electionId)
      if (refused !== null) {
        // Schema refusal is the proof: the honest publish then completes the DKG.
        expect((refused as Error).message).to.match(/ParticipantsAreKeyholders/)
        expect(status.phase).to.equal('complete')
      } else {
        expect(status.phase).to.equal('failed')
        expect(status.failedReason).to.equal('election-key-mismatch')
      }
    })
  })
})
