/**
 * block-tree.spec.ts — 65-05: the R5 block Merkle tree (D-50, D-51).
 *
 * Synthetic rows only: buildBlockTree does not check a Cid against its Ciphertext (that is R7's
 * job), so the rows need no crypto. The spec carries its own independent reference (refLeaf,
 * refNode, refRoot) so expected values never come from the module's own hash helpers.
 */

import { expect } from 'chai'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js'
import {
  BLOCK_TREE_DOMAIN,
  BLOCK_TREE_EMPTY_ROOT,
  blockLeafData,
  blockLeafHash,
  blockNodeHash,
  blockTreeStatus,
  buildBlockTree,
  finalBlockTree,
  verifyInclusion,
  type BlockInclusionProof,
  type BlockTree,
  type BlockTreeRow
} from '../src/blocks/index.js'
import { canonicalJson } from '../src/voting/canonical.js'
import { verifySigP256 } from '../src/database/initialize.js'
import { consentDigest, poolBlockCid, poolBlockId } from '../src/pool/index.js'
import { openElectionBlock, openVoteEntries } from '../src/key-release/index.js'
import { ballotTemplateDigest, voterEntryDigest, type VoterEntryUnsigned } from '../src/voting/index.js'
import {
  FIXTURE_ELECTION_ID,
  FIXTURE_REVISION,
  makeCommittedElection,
  makeFixtureElection,
  makeFixtureVoter,
  seededShuffle
} from './fixtures/pool-blocks.js'

const EID = 'election-bt-1'
const SCOPE = { electionId: EID, electionRevision: 1 }

function row (cid: string, overrides: Partial<Record<keyof BlockTreeRow, unknown>> = {}): BlockTreeRow {
  return {
    Cid: cid,
    Id: `id-${cid}`,
    ElectionId: EID,
    ElectionRevision: 1,
    BallotId: 'ballot-a',
    EntryCount: 3,
    ...overrides
  } as BlockTreeRow
}

function rows (n: number): BlockTreeRow[] {
  return Array.from({ length: n }, (_, i) => row(`cid-${String(i).padStart(3, '0')}`, { EntryCount: 3 + i }))
}

// ---- independent reference ----
function cmpUtf8 (a: string, b: string): number {
  const x = utf8ToBytes(a); const y = utf8ToBytes(b)
  const n = Math.min(x.length, y.length)
  for (let i = 0; i < n; i++) if (x[i] !== y[i]) return x[i]! - y[i]!
  return x.length - y.length
}
const refLeaf = (r: BlockTreeRow): Uint8Array => sha256(concatBytes(Uint8Array.of(0), utf8ToBytes(
  canonicalJson([r.ElectionId, Number(r.ElectionRevision), r.BallotId, r.Id, r.Cid, Number(r.EntryCount)]))))
const refNode = (l: Uint8Array, r: Uint8Array): Uint8Array => sha256(concatBytes(Uint8Array.of(1), l, r))
function refMth (leaves: Uint8Array[]): Uint8Array {
  if (leaves.length === 1) return leaves[0]!
  let k = 1
  while (k * 2 < leaves.length) k *= 2
  return refNode(refMth(leaves.slice(0, k)), refMth(leaves.slice(k)))
}
function refRoot (rs: readonly BlockTreeRow[]): string {
  if (rs.length === 0) return bytesToHex(sha256(utf8ToBytes('vt-block-tree/1/empty')))
  const sorted = [...rs].sort((a, b) => cmpUtf8(a.Cid, b.Cid))
  return bytesToHex(refMth(sorted.map(refLeaf)))
}

function build (rs: readonly BlockTreeRow[]): BlockTree {
  const r = buildBlockTree(rs, SCOPE)
  if (!r.ok) throw new Error(`build refused: ${r.reason} ${r.detail}`)
  return r.tree
}

describe('block-tree (65-05: R5, D-50, D-51)', () => {
  it('BT-1 empty set: defined root, no nodes, unknown block', () => {
    const t = build([])
    expect(t.size).to.equal(0)
    expect(t.nodes).to.have.length(0)
    expect(t.root).to.equal(bytesToHex(sha256(utf8ToBytes('vt-block-tree/1/empty'))))
    expect(t.root).to.equal(BLOCK_TREE_EMPTY_ROOT)
    expect(BLOCK_TREE_DOMAIN).to.equal('vt-block-tree/1')
    expect(t.proofFor('x')).to.deep.equal({ ok: false, reason: 'unknown-block' })
  })

  it('BT-2 single leaf: root is the leaf hash and the proof is empty', () => {
    const r = row('only')
    const t = build([r])
    expect(t.root).to.equal(bytesToHex(refLeaf(r)))
    const p = t.proofFor('only')
    expect(p.ok).to.equal(true)
    if (p.ok) {
      expect(p.proof.path).to.have.length(0)
      expect(verifyInclusion(t.leaves[0]!.hash, p.proof, t.root)).to.deep.equal({ ok: true })
    }
  })

  for (const n of [2, 3, 4, 5, 7, 8, 9]) {
    it(`BT-3 size ${n}: root matches the reference, proofs verify, node table is consistent`, () => {
      const rs = rows(n)
      const t = build(rs)
      expect(t.root).to.equal(refRoot(rs))
      expect(t.size).to.equal(n)
      for (const leaf of t.leaves) {
        const p = t.proofFor(leaf.cid)
        expect(p.ok).to.equal(true)
        if (p.ok) expect(verifyInclusion(leaf.hash, p.proof, t.root)).to.deep.equal({ ok: true })
      }
      expect(t.nodes).to.have.length(2 * n - 1)
      expect(t.nodes[t.nodes.length - 1]!.hash).to.equal(t.root)
      let leafNo = 0
      t.nodes.forEach((node, i) => {
        expect(node.index).to.equal(i)
        if (node.left === undefined) {
          expect(node.range[1] - node.range[0]).to.equal(1)
          expect(node.range[0]).to.equal(leafNo++)
          expect(node.hash).to.equal(t.leaves[node.range[0]]!.hash)
        } else {
          expect(node.left).to.be.lessThan(i)
          expect(node.right!).to.be.lessThan(i)
          expect(node.hash).to.equal(blockNodeHash(t.nodes[node.left]!.hash, t.nodes[node.right!]!.hash))
        }
      })
      expect(leafNo).to.equal(n)
    })
  }

  it('BT-4 known-answer vector (literal derived from refRoot, not from buildBlockTree)', () => {
    const rs = [row('cid-a', { EntryCount: 3 }), row('cid-b', { EntryCount: 4, BallotId: 'ballot-b' }), row('cid-c', { EntryCount: 5 })]
    // Derived once from refRoot over these three rows.
    const KAT = '2548e71a5de11d7275dac46f6fbade8bb2241af96383e5f6f6fbdd7b24a705f7'
    expect(refRoot(rs)).to.equal(KAT)
    expect(build(rs).root).to.equal(KAT)
  })

  it('BT-5 an odd node is carried up, never duplicated', () => {
    const rs = rows(3)
    const t = build(rs)
    const [l0, l1, l2] = t.leaves.map(l => l.hash)
    expect(t.root).to.equal(blockNodeHash(blockNodeHash(l0!, l1!), l2!))
    expect(t.root).to.not.equal(blockNodeHash(blockNodeHash(l0!, l1!), blockNodeHash(l2!, l2!)))
  })

  it('BT-6 domain separation and position binding', () => {
    const t = build(rows(4))
    const leaf = t.leaves[0]!
    expect(leaf.hash).to.not.equal(bytesToHex(sha256(utf8ToBytes(leaf.leafData))))
    expect(blockLeafHash(leaf.leafData)).to.equal(leaf.hash)
    expect(blockLeafData(rows(4)[0]!)).to.equal(leaf.leafData)
    // an internal node posing as a leaf with a shortened path
    const inner = t.nodes[t.nodes.length - 2]! // right child of the root for size 4
    const p = t.proofFor(t.leaves[2]!.cid)
    expect(p.ok).to.equal(true)
    if (p.ok) {
      const forged: BlockInclusionProof = { leafIndex: p.proof.leafIndex, treeSize: p.proof.treeSize, path: p.proof.path.slice(1) }
      expect(verifyInclusion(inner.hash, forged, t.root)).to.deep.equal({ ok: false, reason: 'malformed-proof' })
    }
  })

  it('BT-7 any arrival order gives the same root, leaf order and node hashes', () => {
    const rs = rows(7)
    const base = build(rs)
    for (const seed of [1, 2, 3]) {
      const t = build(seededShuffle(rs, seed))
      expect(t.root).to.equal(base.root)
      expect(t.leaves.map(l => l.cid)).to.deep.equal(base.leaves.map(l => l.cid))
      expect(t.nodes.map(n => n.hash)).to.deep.equal(base.nodes.map(n => n.hash))
    }
  })

  it('BT-8 leaves order by UTF-8 bytes, not UTF-16 code units', () => {
    const t = build([row('a\u{1F600}'), row('a！')])
    expect(t.leaves.map(l => l.cid)).to.deep.equal(['a！', 'a\u{1F600}'])
    expect(t.root).to.equal(refRoot([row('a\u{1F600}'), row('a！')]))
  })

  it('BT-9 tamper: changed leaf fields change the root; bad proofs return typed results and never throw', () => {
    const rs = rows(5)
    const base = build(rs)
    const mutate = (field: string, value: unknown): string => {
      const copy = rs.map((r, i) => i === 2 ? { ...r, [field]: value } as BlockTreeRow : r)
      return build(copy).root
    }
    expect(mutate('EntryCount', 99)).to.not.equal(base.root)
    expect(mutate('BallotId', 'ballot-z')).to.not.equal(base.root)
    expect(mutate('Id', 'id-changed')).to.not.equal(base.root)
    expect(mutate('Cid', 'cid-changed')).to.not.equal(base.root)
    const revCopy = rs.map((r, i) => i === 2 ? { ...r, ElectionRevision: 2 } : r)
    const revTree = buildBlockTree(revCopy, { electionId: EID, electionRevision: 2 })
    // other rows are revision 1 so the scope refuses; the leaf data itself carries the revision
    expect(revTree.ok).to.equal(false)
    expect(blockLeafData(row('c'))).to.not.equal(blockLeafData(row('c', { ElectionRevision: 2 })))

    const leaf = base.leaves[3]!
    const pr = base.proofFor(leaf.cid)
    if (!pr.ok) throw new Error('proof expected')
    const proof = pr.proof
    expect(verifyInclusion(leaf.hash, proof, base.root)).to.deep.equal({ ok: true })

    const flip = (h: string): string => (h[0] === 'a' ? 'b' : 'a') + h.slice(1)
    const flipped: BlockInclusionProof = { ...proof, path: proof.path.map((s, i) => i === 0 ? { ...s, hash: flip(s.hash) } : s) }
    expect(verifyInclusion(leaf.hash, flipped, base.root)).to.deep.equal({ ok: false, reason: 'root-mismatch' })
    const other = build(rows(6))
    expect(verifyInclusion(leaf.hash, proof, other.root)).to.deep.equal({ ok: false, reason: 'root-mismatch' })

    const malformed = (p: unknown, leafHash = leaf.hash, root = base.root): unknown => verifyInclusion(leafHash, p as BlockInclusionProof, root)
    const bad = { ok: false, reason: 'malformed-proof' }
    expect(malformed({ ...proof, path: proof.path.map((s, i) => i === 0 ? { ...s, side: s.side === 'left' ? 'right' : 'left' } : s) })).to.deep.equal(bad)
    expect(malformed({ ...proof, leafIndex: proof.leafIndex === 0 ? 1 : proof.leafIndex - 1 })).to.deep.equal(bad)
    expect(malformed({ ...proof, treeSize: proof.treeSize - 1 })).to.deep.equal(bad)
    expect(malformed({ ...proof, treeSize: 0 })).to.deep.equal(bad)
    expect(malformed({ ...proof, path: proof.path.slice(1) })).to.deep.equal(bad)
    expect(malformed({ ...proof, path: [...proof.path, proof.path[0]] })).to.deep.equal(bad)
    expect(malformed({ ...proof, path: proof.path.map((s, i) => i === 0 ? { ...s, hash: 'zz' + s.hash.slice(2) } : s) })).to.deep.equal(bad)
    expect(malformed({ ...proof, path: proof.path.map((s, i) => i === 0 ? { ...s, hash: s.hash.toUpperCase() } : s) })).to.deep.equal(bad)
    expect(malformed(proof, leaf.hash.toUpperCase())).to.deep.equal(bad)
    expect(malformed(proof, leaf.hash, 'nothex')).to.deep.equal(bad)
    expect(malformed(null)).to.deep.equal(bad)
    expect(malformed({ leafIndex: 1.5, treeSize: 5, path: [] })).to.deep.equal(bad)
    expect(malformed({ leafIndex: 0, treeSize: 5, path: 'x' })).to.deep.equal(bad)
  })

  it('BT-10 typed refusals, bigint acceptance, never a throw', () => {
    const refusal = (input: unknown): { reason: string, detail: string } => {
      const r = buildBlockTree(input as BlockTreeRow[], SCOPE)
      if (r.ok) throw new Error('expected refusal')
      return r
    }
    expect(refusal([row('a'), row('a', { Id: 'other' })]).reason).to.equal('duplicate-block')
    expect(refusal([row('a', { Id: 'same' }), row('b', { Id: 'same' })]).reason).to.equal('duplicate-block')
    expect(refusal([row('a'), row('b', { ElectionId: 'elsewhere' })]).reason).to.equal('mixed-election')
    expect(refusal([row('a'), row('b', { ElectionRevision: 2 })]).reason).to.equal('mixed-revision')
    for (const field of ['Cid', 'Id', 'ElectionId', 'BallotId']) {
      const missing = refusal([row('a', { [field]: undefined })])
      expect(missing.reason).to.equal('malformed-row')
      expect(missing.detail).to.contain(field)
      expect(refusal([row('a', { [field]: '' })]).reason).to.equal('malformed-row')
    }
    expect(refusal([row('a', { EntryCount: 0 })]).detail).to.contain('EntryCount')
    expect(refusal([row('a', { ElectionRevision: 1.5 })]).detail).to.contain('ElectionRevision')
    expect(refusal([row('a', { ElectionRevision: -1 })]).reason).to.equal('malformed-row')
    expect(refusal([row('a', { EntryCount: Number.MAX_SAFE_INTEGER + 1 })]).reason).to.equal('malformed-row')
    expect(refusal([row('a', { EntryCount: BigInt(Number.MAX_SAFE_INTEGER) + 1n })]).reason).to.equal('malformed-row')
    expect(refusal([null]).reason).to.equal('malformed-row')
    expect(refusal('nope').reason).to.equal('malformed-row')

    const withBig = [row('a', { ElectionRevision: 1n, EntryCount: 3n }), row('b')]
    const withNum = [row('a'), row('b')]
    expect(build(withBig).root).to.equal(build(withNum).root)
  })

  it('BT-11 the accruing gate (D-51): nowMs is a parameter; provisional before hashingVotes', () => {
    const tl = { accruingVotes: 1000, hashingVotes: 2000 }
    expect(blockTreeStatus(tl, 1999)).to.deep.equal({ ok: false, reason: 'accruing-not-ended', finalAtMs: 2000 })
    expect(blockTreeStatus(tl, 2000)).to.deep.equal({ ok: true, final: true })
    expect(blockTreeStatus(tl, 5000)).to.deep.equal({ ok: true, final: true })
    expect(blockTreeStatus(tl, NaN)).to.deep.equal({ ok: false, reason: 'clock-invalid' })
    expect(blockTreeStatus(tl, Infinity)).to.deep.equal({ ok: false, reason: 'clock-invalid' })
    expect(blockTreeStatus({ accruingVotes: 2000, hashingVotes: 1000 }, 3000)).to.deep.equal({ ok: false, reason: 'timeline-invalid' })
    expect(blockTreeStatus({ accruingVotes: NaN, hashingVotes: 1000 }, 3000)).to.deep.equal({ ok: false, reason: 'timeline-invalid' })
    expect(blockTreeStatus({ accruingVotes: 1000 } as never, 3000)).to.deep.equal({ ok: false, reason: 'timeline-invalid' })

    const rs = rows(4)
    const early = finalBlockTree(rs, SCOPE, tl, 1500)
    expect(early.ok).to.equal(false)
    if (!early.ok && early.reason === 'accruing-not-ended') {
      expect(early.finalAtMs).to.equal(2000)
      expect(early.provisional.root).to.equal(build(rs).root)
    } else throw new Error('expected accruing-not-ended')
    const late = finalBlockTree(rs, SCOPE, tl, 2000)
    expect(late.ok).to.equal(true)
    if (late.ok) { expect(late.final).to.equal(true); expect(late.tree.root).to.equal(build(rs).root) }
    const refused = finalBlockTree([row('a'), row('a')], SCOPE, tl, 1500)
    expect(refused).to.include({ ok: false, reason: 'duplicate-block' })
  })
})

describe('pool-blocks fixture (65-05: shared R5-R8 rows)', () => {
  const set = makeCommittedElection({
    ballotIds: ['ballot-a', 'ballot-b'],
    blocks: [{ size: 3 }, { size: 4 }, { ballotIndex: 1, size: 3 }, { size: 3, payloadVersion: 1 }]
  })

  it('FX-1 rows are schema-shaped and self-consistent', () => {
    expect(set.blocks).to.have.length(4)
    for (const b of set.blocks) {
      const r = b.row
      expect(poolBlockCid(r.Ciphertext)).to.equal(r.Cid)
      expect(r.Id).to.equal(poolBlockId(b.payload))
      expect(r.EntryCount).to.equal(b.voters.length)
      expect(set.voterRows.filter(v => v.BlockCid === r.Cid)).to.have.length(r.EntryCount)
      expect(r.VoterRegistrantIds).to.equal(JSON.stringify(b.voters.map(v => v.voterEntry.registrantId).sort()))
      expect(r.TemplateDigest).to.equal(ballotTemplateDigest(b.ballot.template, FIXTURE_REVISION))
      expect(r.ElectionId).to.equal(FIXTURE_ELECTION_ID)
      expect(r.ElectionRevision).to.equal(FIXTURE_REVISION)
    }
    expect(set.blocks.map(b => b.payloadVersion)).to.deep.equal([2, 2, 2, 1])
    expect(set.rows).to.have.length(4)
    expect(set.voterRows).to.have.length(13)
    expect(set.receipts).to.have.length(13)
  })

  it('FX-2 consent and voter-entry signatures are real', () => {
    for (const b of set.blocks) {
      for (const vr of b.voterRows) {
        const digest = consentDigest({ cid: b.row.Cid, blockId: b.row.Id }, b.ballot.poolBallot, vr.RegistrantId, vr.DeviceKey)
        expect(verifySigP256(digest, vr.Signature, vr.DeviceKey)).to.equal(true)
      }
      for (const v of b.voters) {
        const { signature, ...unsigned } = v.voterEntry
        expect(verifySigP256(voterEntryDigest(unsigned as VoterEntryUnsigned), signature, v.voterEntry.deviceKey)).to.equal(true)
      }
    }
  })

  it('FX-3 blocks reopen after release; receipts carry the entries found in the block', () => {
    const key = set.election.electionKey
    for (const b of set.blocks) {
      const opened = openElectionBlock(set.election.electionSecret, key, { blockId: b.row.Id, ciphertext: b.row.Ciphertext })
      expect(opened.ok).to.equal(true)
      if (!opened.ok) continue
      const mine = set.receipts.filter(rc => b.voters.some(v => v.voterEntry === rc.voter))
      expect(mine).to.have.length(b.voters.length)
      expect(opened.payload.voterRecords.map(v => canonicalJson(v)).sort()).to.deep.equal(mine.map(rc => canonicalJson(rc.voter)).sort())
      const receiptVotes = mine.flatMap(rc => rc.votes.map(v => canonicalJson(v))).sort()
      if (b.payloadVersion === 2) {
        const plain = openVoteEntries(set.election.electionSecret, key, b.ballot.poolBallot.ballotId, opened.payload)
          .map(p => (p.ok ? canonicalJson(JSON.parse(p.voteEntryJson)) : 'FAILED')).sort()
        expect(plain).to.deep.equal(receiptVotes)
      } else {
        expect(opened.payload.votes.map(v => canonicalJson(v)).sort()).to.deep.equal(receiptVotes)
      }
    }
  })

  it('FX-4 a raw voteEntry is used as is; voterBallots are signed sorted by ballotId', () => {
    const election = makeFixtureElection({ ballotIds: ['ballot-a', 'ballot-b'] })
    const raw = { v: 1 as const, ballotId: 'ballot-a', answers: [{ questionCode: 'q1', optionCodes: ['nope'] }], nonce: 'ab'.repeat(32) }
    const v = makeFixtureVoter(election, election.ballots[0]!, 0, { voteEntry: raw as never, voterBallots: [election.ballots[1]!, election.ballots[0]!] })
    expect(v.voteEntry).to.equal(raw)
    expect(v.voteJson).to.equal(canonicalJson(raw))
    expect(v.voterEntry.ballots.map(b => b.ballotId)).to.deep.equal(['ballot-a', 'ballot-b'])
  })

  it('FX-5 seededShuffle is a deterministic permutation; shuffled rows give the same root', () => {
    const xs = [1, 2, 3, 4, 5, 6, 7]
    expect(seededShuffle(xs, 3)).to.deep.equal(seededShuffle(xs, 3))
    expect([...seededShuffle(xs, 3)].sort()).to.deep.equal(xs)
    expect([1, 2, 3, 4, 5].some(s => JSON.stringify(seededShuffle(xs, s)) !== JSON.stringify(xs))).to.equal(true)
    const scope = { electionId: FIXTURE_ELECTION_ID, electionRevision: FIXTURE_REVISION }
    const ra = buildBlockTree(set.rows, scope)
    const rb = buildBlockTree(seededShuffle(set.rows, 4), scope)
    if (!ra.ok || !rb.ok) throw new Error('fixture rows refused')
    const a = ra.tree
    expect(rb.tree.root).to.equal(a.root)
    const cids = new Set(set.rows.map(r => r.Cid))
    expect(a.leaves.every(l => cids.has(l.cid))).to.equal(true)
  })
})
