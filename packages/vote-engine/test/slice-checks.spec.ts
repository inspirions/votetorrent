/**
 * slice-checks.spec.ts — 65-06: the shared committed-block opener (OCB) and the R6 voter slice checks (SC).
 *
 * Built over the 65-05 committed-row fixture. The fixture is never edited; tampered variants are
 * shallow copies made inside each test.
 */

import { expect } from 'chai'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { checkElectionSecret, openCommittedBlock, type CommittedBlockRow } from '../src/blocks/open-committed-block.js'
import { formPoolBlock } from '../src/pool/pool-block.js'
import { encryptVoteEntry } from '../src/key-release/election-block.js'
import { canonicalJson } from '../src/voting/canonical.js'
import {
  FIXTURE_ELECTION_ID,
  FIXTURE_REVISION,
  makeCommittedElection,
  makeFixtureVoter,
  type CommittedFixtureSet
} from './fixtures/pool-blocks.js'

function containsBytes (value: unknown, seen = new Set<unknown>()): boolean {
  if (value instanceof Uint8Array) return true
  if (value === null || typeof value !== 'object') return false
  if (seen.has(value)) return false
  seen.add(value)
  return Object.values(value as Record<string, unknown>).some(v => containsBytes(v, seen))
}

describe('open-committed-block (65-06: shared R6-R8 opener)', function () {
  this.timeout(30_000)
  let set: CommittedFixtureSet
  before(() => {
    set = makeCommittedElection({ ballotIds: ['ballot-a'], blocks: [{ size: 3 }, { size: 3, payloadVersion: 1 }] })
  })

  it('OCB-1 opens a v:2 block and every per-vote layer', () => {
    const b = set.blocks[0]!
    const r = openCommittedBlock(b.row, set.election.electionSecret, set.election.electionKey)
    expect(r.ok).to.equal(true)
    if (!r.ok) return
    expect(r.payloadVersion).to.equal(2)
    expect(r.blockCid).to.equal(b.row.Cid)
    expect(r.blockId).to.equal(b.row.Id)
    expect(r.ballotId).to.equal(b.row.BallotId)
    expect(canonicalJson(r.payload)).to.equal(canonicalJson(b.payload))
    expect(r.votes).to.have.length(3)
    r.votes.forEach((v, i) => {
      expect(v.ok).to.equal(true)
      expect(v.index).to.equal(i)
    })
    const got = r.votes.map(v => (v.ok ? v.entryJson : '')).sort()
    const want = b.voters.map(v => canonicalJson(v.voteEntry)).sort()
    expect(got).to.deep.equal(want)
  })

  it('OCB-2 opens a v:1 block of clear votes', () => {
    const b = set.blocks[1]!
    const r = openCommittedBlock(b.row, set.election.electionSecret, set.election.electionKey)
    expect(r.ok).to.equal(true)
    if (!r.ok) return
    expect(r.payloadVersion).to.equal(1)
    expect(r.votes).to.have.length(3)
    for (const v of r.votes) {
      expect(v.ok).to.equal(true)
      if (v.ok) expect(v.entryJson).to.equal(canonicalJson(v.entry))
    }
    const got = r.votes.map(v => (v.ok ? v.entryJson : '')).sort()
    expect(got).to.deep.equal(b.voters.map(v => canonicalJson(v.voteEntry)).sort())
  })

  it('OCB-3 checks the secret against the joint key and never throws', () => {
    const { electionSecret, electionKey } = set.election
    const row = set.blocks[0]!.row
    expect(checkElectionSecret(electionSecret, electionKey)).to.deep.equal({ ok: true })
    const wrong = secp256k1.utils.randomSecretKey()
    const mismatch = checkElectionSecret(wrong, electionKey)
    expect(mismatch.ok).to.equal(false)
    if (!mismatch.ok) expect(mismatch.reason).to.equal('secret-mismatch')
    for (const bad of [new Uint8Array(32), new Uint8Array(31)]) {
      const c = checkElectionSecret(bad, electionKey)
      expect(c.ok).to.equal(false)
      if (!c.ok) expect(c.reason).to.equal('invalid-secret')
      const o = openCommittedBlock(row, bad, electionKey)
      expect(o.ok).to.equal(false)
      if (!o.ok) {
        expect(o.reason).to.equal('invalid-secret')
        expect(o.blockCid).to.equal(row.Cid)
      }
    }
    const o2 = openCommittedBlock(row, wrong, electionKey)
    expect(o2.ok).to.equal(false)
    if (!o2.ok) expect(o2.reason).to.equal('secret-mismatch')
  })

  it('OCB-4 refuses malformed and out-of-scope rows with typed reasons', () => {
    const { electionSecret, electionKey } = set.election
    const row = set.blocks[0]!.row
    const reason = (r: unknown): string => {
      const o = openCommittedBlock(r as CommittedBlockRow, electionSecret, electionKey)
      return o.ok ? 'ok' : o.reason
    }
    expect(reason({ ...row, ElectionId: 'other' })).to.equal('scope-mismatch')
    expect(reason({ ...row, ElectionRevision: FIXTURE_REVISION + 1 })).to.equal('scope-mismatch')
    expect(reason({ ...row, ElectionRevision: BigInt(FIXTURE_REVISION + 5) })).to.equal('scope-mismatch')
    expect(reason({ ...row, ElectionRevision: BigInt(FIXTURE_REVISION) })).to.equal('ok')
    expect(reason(null)).to.equal('malformed-row')
    expect(reason({ ...row, Cid: '' })).to.equal('malformed-row')
    expect(reason({ ...row, Id: '' })).to.equal('malformed-row')
    expect(reason({ ...row, BallotId: '' })).to.equal('malformed-row')
    expect(reason({ ...row, Ciphertext: 5 })).to.equal('malformed-row')
    expect(reason({ ...row, Ciphertext: '{}' })).to.equal('malformed-ciphertext')
    expect(reason({ ...row, Ciphertext: set.blocks[1]!.row.Ciphertext })).to.equal('authentication-failed')
  })

  it('OCB-5 reports per-vote failures individually', () => {
    const { electionKey, electionSecret, ballots } = set.election
    const ballot = ballots[0]!
    const ballotId = ballot.poolBallot.ballotId
    const good = makeFixtureVoter(set.election, ballot, 0)
    const w = makeFixtureVoter(set.election, ballot, 1)
    const n = makeFixtureVoter(set.election, ballot, 2)
    w.contribution = { ...w.contribution, voteCiphertext: encryptVoteEntry(electionKey, 'another-ballot', w.voteJson) }
    n.contribution = { ...n.contribution, voteCiphertext: encryptVoteEntry(electionKey, ballotId, 'not json {') }
    const formed = formPoolBlock([good.contribution, w.contribution, n.contribution], ballot.poolBallot)
    const row: CommittedBlockRow = {
      Cid: formed.cid, Id: formed.blockId, ElectionId: electionKey.electionId, ElectionRevision: electionKey.revision,
      BallotId: ballotId, Ciphertext: formed.ciphertext
    }
    const r = openCommittedBlock(row, electionSecret, electionKey)
    expect(r.ok).to.equal(true)
    if (!r.ok) return
    const kinds = r.votes.map(v => (v.ok ? 'ok' : v.reason)).sort()
    expect(kinds).to.deep.equal(['ok', 'vote-does-not-open', 'vote-not-json'])
    for (const v of r.votes) if (!v.ok) expect(v.detail).to.be.a('string').with.length.greaterThan(0)
  })

  it('OCB-6 neither retains nor zeroes the caller secret, and returns no bytes', () => {
    const secret = set.election.electionSecret
    const copy = new Uint8Array(secret)
    const r = openCommittedBlock(set.blocks[0]!.row, secret, set.election.electionKey)
    expect(Array.from(secret)).to.deep.equal(Array.from(copy))
    expect(containsBytes(r)).to.equal(false)
  })

  it('OCB-7 is deterministic', () => {
    const a = openCommittedBlock(set.blocks[0]!.row, set.election.electionSecret, set.election.electionKey)
    const b = openCommittedBlock(set.blocks[0]!.row, set.election.electionSecret, set.election.electionKey)
    expect(a).to.deep.equal(b)
  })
})

// keep FIXTURE_ELECTION_ID referenced for the SC describe appended in the next commit
void FIXTURE_ELECTION_ID
