import { expect } from 'chai'
import { digestFields, resolveHasher, resolveOutputEncoder } from '@optimystic/quereus-plugin-crypto'
import { bytesToHex } from '@noble/hashes/utils.js'
import {
  ballotTemplateDigest, buildVoteEntry, makeVoteNonce, voterEntryDigest,
  type TemplateBallot, type VoterEntryUnsigned
} from '../src/voting/vote-entries.js'
import { canonicalJson, sortByCanonicalBytes } from '../src/voting/canonical.js'

const rand32 = (): Uint8Array => crypto.getRandomValues(new Uint8Array(32))
const sha = resolveHasher('sha256')
const b64 = resolveOutputEncoder('base64url')

// Known-answer digests, produced by the spike-096 module (.planning/spikes/096-.../vote-entries.ts)
// for the fixtures below. They prove the product lift is verbatim.
const KAT_TEMPLATE_DIGEST = '_8ABWDiPsL3QjCELg2mB3CAttwo6l7CcRy0yTrQbNdY'
const KAT_VOTER_ENTRY_DIGEST = 'jCOYTEKMxhW4MfSydSvjolzBGvIh_qDC1zfPpc1Ub9Y'

const KAT_BALLOT: TemplateBallot = {
  id: 'kat-ballot-1',
  electionId: 'kat-election-1',
  authorityId: 'kat-authority-1',
  description: 'KAT ballot',
  districts: ['d-2', 'd-1'],
  questions: [
    {
      code: 'us-senate', title: 'U.S. Senate', type: 'select', optionRange: { min: 1, max: 1 },
      options: [
        { code: 'marcus', title: 'Marcus Whitfield' },
        { code: 'diana', title: 'Diana Foster' },
        { code: 'elena', title: 'Elena Vasquez' }
      ]
    },
    {
      code: 'school-board', title: 'School Board', type: 'select', optionRange: { min: 1, max: 2 },
      options: [
        { code: 'cynthia', title: 'Cynthia Park' },
        { code: 'angela', title: 'Angela Torres' },
        { code: 'brian', title: 'Brian Michaels' }
      ]
    }
  ]
}

const KAT_VOTER: VoterEntryUnsigned = {
  v: 1,
  electionId: 'kat-election-1',
  electionRevision: 3,
  registrantId: 'kat-registrant-1',
  privateCid: 'kat-private-cid',
  publicCid: null,
  deviceKey: '02' + '1'.repeat(64),
  attestationCid: null,
  ballots: [
    { ballotId: 'kat-ballot-2', templateDigest: 'td-2' },
    { ballotId: 'kat-ballot-1', templateDigest: 'td-1' }
  ]
}

describe('voting/vote-entries (63-01: D-16, D-23, D-24, D-25, D-27, D-28)', function () {
  this.timeout(60000)

  describe('pure builders', function () {
    it('KAT-1 ballotTemplateDigest reproduces the spike-096 value', function () {
      expect(ballotTemplateDigest(KAT_BALLOT, 3)).to.equal(KAT_TEMPLATE_DIGEST)
    })

    it('KAT-2 voterEntryDigest reproduces the spike-096 value', function () {
      expect(voterEntryDigest(KAT_VOTER)).to.equal(KAT_VOTER_ENTRY_DIGEST)
    })

    it('D24-contract template digest field order is pinned by an inline recomputation', function () {
      // D-24 order: 'BallotTemplate', electionId, revision, id, authorityId, description,
      // sorted districts, questions (by code; options by code).
      const questionsTuple = [
        ['school-board', 'School Board', 'select', [1, 2], null,
          [['angela', 'Angela Torres', null], ['brian', 'Brian Michaels', null], ['cynthia', 'Cynthia Park', null]]],
        ['us-senate', 'U.S. Senate', 'select', [1, 1], null,
          [['diana', 'Diana Foster', null], ['elena', 'Elena Vasquez', null], ['marcus', 'Marcus Whitfield', null]]]
      ]
      const expected = digestFields(
        ['BallotTemplate', 'kat-election-1', 3, 'kat-ballot-1', 'kat-authority-1', 'KAT ballot',
          JSON.stringify(['d-1', 'd-2']), JSON.stringify(questionsTuple)],
        sha, b64
      )
      expect(ballotTemplateDigest(KAT_BALLOT, 3)).to.equal(expected)
    })

    it('D25-contract voter entry digest has no answer or nonce input', function () {
      const pairs = [['kat-ballot-1', 'td-1'], ['kat-ballot-2', 'td-2']]
      const expected = digestFields(
        ['VoterEntry', 1, 'kat-election-1', 3, 'kat-registrant-1', 'kat-private-cid', null, '02' + '1'.repeat(64),
          null, JSON.stringify(pairs)],
        sha, b64
      )
      expect(voterEntryDigest(KAT_VOTER)).to.equal(expected)
    })

    it('U3c the digest reads only its named fields (extra answers/nonce are ignored)', function () {
      const withVote = { ...KAT_VOTER, answers: [{ questionCode: 'us-senate', optionCodes: ['elena'] }], nonce: 'ab'.repeat(32) }
      expect(voterEntryDigest(withVote as unknown as VoterEntryUnsigned)).to.equal(KAT_VOTER_ENTRY_DIGEST)
    })

    it('H0 digestFields matches the shipped probe vector', function () {
      expect(digestFields(['probe-nonce-v1', 'probe-devicekey-v1'], sha, b64)).to.equal('epUx8O72zVpRIQl1WGnqZSQpvFJjJPPZtmgqJBcUfzI')
    })

    it('N1 a bare nonce is exactly bytesToHex(random), 64 lowercase hex', function () {
      const r = rand32()
      const n = makeVoteNonce(r)
      expect(n).to.equal(bytesToHex(r))
      expect(n).to.have.length(64)
      expect(n).to.match(/^[0-9a-f]{64}$/)
    })

    it('N2 voter entropy changes the nonce', function () {
      const r = rand32()
      const n0 = makeVoteNonce(r)
      expect(makeVoteNonce(r, 'my words')).to.not.equal(n0)
      expect(makeVoteNonce(r, 'my words')).to.not.equal(makeVoteNonce(r, 'other'))
    })

    it('N3 weak voter entropy cannot collapse two CSPRNG draws into one nonce', function () {
      expect(makeVoteNonce(rand32(), 'aaaa')).to.not.equal(makeVoteNonce(rand32(), 'aaaa'))
    })

    it('N4 2000 nonces, 0 collisions', function () {
      const nonces = new Set(Array.from({ length: 2000 }, () => makeVoteNonce(rand32())))
      expect(nonces.size).to.equal(2000)
    })

    it('N5 makeVoteNonce refuses anything but 32 bytes', function () {
      expect(() => makeVoteNonce(new Uint8Array(31))).to.throw(/32 CSPRNG bytes/)
      expect(() => makeVoteNonce(new Uint8Array(33))).to.throw(/32 CSPRNG bytes/)
    })

    it('V2 refuses more distinct options than the question cap', function () {
      const ballot: TemplateBallot = {
        ...KAT_BALLOT,
        questions: [
          { code: 'capped', title: 'Capped', optionRange: { min: 1, max: 2 }, options: ['a', 'b', 'c'].map(c => ({ code: c, title: c })) },
          { code: 'bare', title: 'Bare', options: ['x', 'y'].map(c => ({ code: c, title: c })) }
        ]
      }
      const nonce = makeVoteNonce(rand32())
      const build = (selections: Record<string, string[]>): ReturnType<typeof buildVoteEntry> =>
        buildVoteEntry({ ballot, electionRevision: 1, selections, nonce })
      expect(() => build({ capped: ['a', 'b', 'c'] })).to.throw(/too many options/)
      expect(build({ capped: ['a', 'a', 'a'] }).answers).to.deep.equal([{ questionCode: 'capped', optionCodes: ['a'] }])
      expect(build({ capped: ['b', 'a'] }).answers[0]!.optionCodes).to.deep.equal(['a', 'b'])
      // No optionRange: cap is 1.
      expect(() => build({ bare: ['x', 'y'] })).to.throw(/too many options/)
      expect(build({ bare: ['x'] }).answers).to.deep.equal([{ questionCode: 'bare', optionCodes: ['x'] }])
    })

    it('V3 refuses a nonce that is not 64 lowercase hex', function () {
      const sel = { 'us-senate': ['elena'] }
      for (const nonce of ['AB'.repeat(32), 'a'.repeat(63), 'a'.repeat(65)]) {
        expect(() => buildVoteEntry({ ballot: KAT_BALLOT, electionRevision: 3, selections: sel, nonce }))
          .to.throw(/nonce must be 64 lowercase hex/)
      }
    })

    it('V4 a blank question has one representation (absent); all-blank yields answers: []', function () {
      const nonce = makeVoteNonce(rand32())
      const a = buildVoteEntry({ ballot: KAT_BALLOT, electionRevision: 3, selections: { 'us-senate': ['elena'], 'school-board': [] }, nonce })
      const b = buildVoteEntry({ ballot: KAT_BALLOT, electionRevision: 3, selections: { 'us-senate': ['elena'] }, nonce })
      expect(canonicalJson(a)).to.equal(canonicalJson(b))
      expect(buildVoteEntry({ ballot: KAT_BALLOT, electionRevision: 3, selections: {}, nonce }).answers).to.deep.equal([])
      expect(buildVoteEntry({ ballot: KAT_BALLOT, electionRevision: 3, selections: { 'us-senate': [] }, nonce }).answers).to.deep.equal([])
    })

    it('C1 canonicalJson is key-order independent, drops undefined, keeps array order, recurses', function () {
      expect(canonicalJson({ b: 1, a: { d: 1, c: 2 } })).to.equal(canonicalJson({ a: { c: 2, d: 1 }, b: 1 }))
      expect(canonicalJson({ a: 1, b: undefined })).to.equal('{"a":1}')
      expect(canonicalJson([3, 1, 2])).to.equal('[3,1,2]')
      expect(canonicalJson({ x: [{ z: 1, y: 2 }] })).to.equal('{"x":[{"y":2,"z":1}]}')
    })

    it('C2 sortByCanonicalBytes is permutation invariant', function () {
      const items = Array.from({ length: 25 }, (_, i) => ({
        v: 1, ballotId: 'b', nonce: bytesToHex(rand32()), answers: [{ questionCode: 'q', optionCodes: [`o${i}`] }]
      }))
      const reference = canonicalJson(sortByCanonicalBytes(items))
      for (let p = 0; p < 50; p++) {
        const shuffled = [...items]
        for (let i = shuffled.length - 1; i > 0; i--) {
          const j = crypto.getRandomValues(new Uint32Array(1))[0]! % (i + 1)
          ;[shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!]
        }
        expect(canonicalJson(sortByCanonicalBytes(shuffled))).to.equal(reference)
      }
    })

    it('C3 orders by UTF-8 bytes, not UTF-16 code units', function () {
      const sorted = sortByCanonicalBytes([{ t: '\u{1F600}' }, { t: '！' }])
      expect(sorted.map(x => x.t)).to.deep.equal(['！', '\u{1F600}'])
      // The JS string order is the opposite, which is the trap this rule avoids.
      expect(JSON.stringify({ t: '\u{1F600}' }) < JSON.stringify({ t: '！' })).to.equal(true)
    })

    it('C4 sortByCanonicalBytes does not mutate its input', function () {
      const input = [{ t: 'c' }, { t: 'a' }, { t: 'b' }]
      const snapshot = [...input]
      const out = sortByCanonicalBytes(input)
      expect(out).to.not.equal(input)
      expect(input).to.have.length(3)
      input.forEach((x, i) => expect(x).to.equal(snapshot[i]))
      expect(out.map(x => x.t)).to.deep.equal(['a', 'b', 'c'])
    })
  })
})
