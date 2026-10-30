/**
 * tally-tree.spec.ts — R8 (D-80, D-81): the tally tree that mirrors the R5 block Merkle tree with a histogram at
 * every node. Part 1 uses synthetic inputs only (no crypto).
 */

import { expect } from 'chai'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js'
import { BLOCK_TREE_EMPTY_ROOT, buildBlockTree } from '../src/blocks/block-tree.js'
import { TALLY_TREE_DOMAIN, addHistograms, tallyNodeHash, tallyTreeFrom } from '../src/blocks/tally-tree.js'
import { canonicalJson } from '../src/voting/canonical.js'
import { FIXTURE_ELECTION_ID, FIXTURE_REVISION, makeFixtureTemplate } from './fixtures/pool-blocks.js'

// ---- independent reference (never uses the module's helpers) ----

const refTallyHash = (merkleHex: string, hist: unknown, prefix = 0x03): string =>
  bytesToHex(sha256(concatBytes(Uint8Array.of(prefix), hexToBytes(merkleHex), utf8ToBytes(canonicalJson(hist)))))

const hasOwn = (o: any, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k)

function refSumRec (a: any, b: any): any {
  const keys = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])
  const out: any = {}
  for (const k of [...keys].sort()) {
    Object.defineProperty(out, k, {
      value: (a && hasOwn(a, k) ? a[k] : 0) + (b && hasOwn(b, k) ? b[k] : 0), enumerable: true, writable: true, configurable: true
    })
  }
  return out
}

function refAddBallot (x: any, y: any): any {
  const qs = new Set([...Object.keys(x?.questions ?? {}), ...Object.keys(y?.questions ?? {})])
  const questions: any = {}
  for (const q of [...qs].sort()) {
    const qx = x && hasOwn(x.questions, q) ? x.questions[q] : undefined
    const qy = y && hasOwn(y.questions, q) ? y.questions[q] : undefined
    Object.defineProperty(questions, q, {
      value: { answered: (qx?.answered ?? 0) + (qy?.answered ?? 0), options: refSumRec(qx?.options, qy?.options) },
      enumerable: true, writable: true, configurable: true
    })
  }
  return {
    votes: (x?.votes ?? 0) + (y?.votes ?? 0),
    invalid: (x?.invalid ?? 0) + (y?.invalid ?? 0),
    excluded: (x?.excluded ?? 0) + (y?.excluded ?? 0),
    questions,
    unsupported: refSumRec(x?.unsupported, y?.unsupported)
  }
}

function refAdd (a: any, b: any): any {
  const ids = new Set([...Object.keys(a.ballots), ...Object.keys(b.ballots)])
  const ballots: any = {}
  for (const id of [...ids].sort()) {
    Object.defineProperty(ballots, id, {
      value: refAddBallot(hasOwn(a.ballots, id) ? a.ballots[id] : undefined, hasOwn(b.ballots, id) ? b.ballots[id] : undefined),
      enumerable: true, writable: true, configurable: true
    })
  }
  return { ballots }
}

/** A tallied leaf's counts straight from the template and the verdicts. */
function refLeafCounts (template: any, verdicts: any[]): any {
  const questions: any = {}
  const unsupported: any = {}
  for (const q of template.questions) {
    if (q.type === undefined || q.type === 'select') {
      const options: any = {}
      for (const o of q.options) options[o.code] = 0
      questions[q.code] = { answered: 0, options }
    } else unsupported[q.code] = 0
  }
  let invalid = 0
  for (const v of verdicts) {
    if (v.status === 'invalid') { invalid++; continue }
    for (const a of v.entry.answers) {
      if (hasOwn(questions, a.questionCode)) {
        questions[a.questionCode].answered++
        for (const o of a.optionCodes) questions[a.questionCode].options[o]++
      } else unsupported[a.questionCode]++
    }
  }
  return { votes: verdicts.length, invalid, excluded: 0, questions, unsupported }
}

// ---- synthetic builders ----

const scope = { electionId: FIXTURE_ELECTION_ID, electionRevision: FIXTURE_REVISION }

const row = (cid: string, ballotId: string, entryCount: number): any => ({
  Cid: cid, Id: `id-${cid}`, ElectionId: FIXTURE_ELECTION_ID, ElectionRevision: FIXTURE_REVISION, BallotId: ballotId,
  TemplateDigest: 'td', EntryCount: entryCount, VoterRegistrantIds: '[]', Ciphertext: 'x'
})

const entryOf = (ballotId: string, answers: Array<[string, string[]]>): any => ({
  v: 1, electionId: FIXTURE_ELECTION_ID, electionRevision: FIXTURE_REVISION, ballotId, templateDigest: 'td',
  answers: answers.map(([questionCode, optionCodes]) => ({ questionCode, optionCodes })), nonce: '0'.repeat(64)
})

function verdictsFor (ballotId: string, blockNo: number, n: number): any[] {
  const out: any[] = []
  for (let j = 0; j < n; j++) {
    if (j === n - 1 && blockNo % 2 === 0) { out.push({ index: j, status: 'invalid', codes: ['unknown-option'] }); continue }
    const answers: Array<[string, string[]]> = [
      ['q1', [['a', 'b', 'c'][(blockNo + j) % 3]!]],
      ['q2', (blockNo + j) % 2 === 0 ? ['x'] : ['x', 'y']]
    ]
    if (j % 2 === 0) answers.push(['q3', ['r1']])
    out.push({ index: j, status: 'valid', entry: entryOf(ballotId, answers) })
  }
  return out
}

const blockFinding = (r: any, over: any = {}): any => ({
  blockCid: r.Cid, blockId: r.Id, ballotId: r.BallotId, payloadVersion: 2, status: 'valid', declaredEntries: r.EntryCount,
  votes: [], findings: [], ...over
})

const report = (blocks: any[], over: any = {}): any => ({
  ok: true, electionId: FIXTURE_ELECTION_ID, electionRevision: FIXTURE_REVISION, released: true, blocks, findings: [],
  totals: { blocks: blocks.length, entries: 0, valid: 0, invalid: 0, undecryptable: 0 }, ...over
})

const templates = (): any[] => [makeFixtureTemplate('ballot-a'), makeFixtureTemplate('ballot-b')]

/** 5 rows over 2 ballots (entry counts 3,4,3,3,5) with a released finding per Cid. */
function syntheticSet (over: { invalidBlock?: number } = {}): any {
  const spec: Array<[string, string, number]> = [['c1', 'ballot-a', 3], ['c2', 'ballot-a', 4], ['c3', 'ballot-b', 3], ['c4', 'ballot-a', 3], ['c5', 'ballot-b', 5]]
  const rows = spec.map(([cid, b, n]) => row(cid, b, n))
  const blocks = rows.map((r, i) => {
    if (i === over.invalidBlock) {
      return blockFinding(r, {
        status: 'invalid',
        votes: verdictsFor(r.BallotId, i, r.EntryCount),
        findings: [
          { blockCid: r.Cid, code: 'consent-signature-invalid', severity: 'error', detail: 'x' },
          { blockCid: r.Cid, code: 'cid-mismatch', severity: 'error', detail: 'x' },
          { blockCid: r.Cid, code: 'cid-mismatch', severity: 'error', detail: 'again' },
          { blockCid: r.Cid, code: 'blank-required', severity: 'info', detail: 'x', voteIndex: 0 },
          { blockCid: r.Cid, code: 'below-minimum', severity: 'error', detail: 'x', voteIndex: 1 }
        ]
      })
    }
    return blockFinding(r, { votes: verdictsFor(r.BallotId, i, r.EntryCount) })
  })
  const built = buildBlockTree(rows, scope)
  if (!built.ok) throw new Error('fixture tree failed')
  return { rows, tree: built.tree, validation: report(blocks), blocks }
}

const freeze = <T>(v: T): T => {
  if (v !== null && typeof v === 'object') { Object.freeze(v); for (const k of Object.keys(v)) freeze((v as any)[k]) }
  return v
}

describe('tally histograms (65-08: R8, D-80, D-81)', function () {
  this.timeout(60_000)

  const H = { ballots: { 'ballot-a': { excluded: 0, invalid: 1, questions: { q1: { answered: 2, options: { a: 1, b: 1, c: 0 } } }, unsupported: { q3: 1 }, votes: 3 } } }
  // Derived once from refTallyHash('ab'.repeat(32), H) (independent noble computation).
  const PINNED = '35399850ce4f9225355b3a3bcc38381953726c462d12f4f14b804a0355f61499'

  it('TH-1 hash: prefix 0x03 over the raw merkle bytes and the canonical histogram', () => {
    const m = 'ab'.repeat(32)
    expect(TALLY_TREE_DOMAIN).to.equal('vt-tally-tree/1')
    expect(tallyNodeHash(m, H as any)).to.equal(PINNED)
    expect(refTallyHash(m, H)).to.equal(PINNED)
    expect(refTallyHash(m, H, 0x01)).to.not.equal(PINNED)
    const noMerkle = bytesToHex(sha256(concatBytes(Uint8Array.of(0x03), utf8ToBytes(canonicalJson(H)))))
    expect(noMerkle).to.not.equal(PINNED)
    // the same histogram printed with non-canonical key order hashes differently if JSON.stringify were used
    const shuffled = { ballots: { 'ballot-a': { votes: 3, unsupported: { q3: 1 }, questions: { q1: { options: { c: 0, b: 1, a: 1 }, answered: 2 } }, invalid: 1, excluded: 0 } } }
    const viaStringify = bytesToHex(sha256(concatBytes(Uint8Array.of(0x03), hexToBytes(m), utf8ToBytes(JSON.stringify(shuffled)))))
    expect(viaStringify).to.not.equal(PINNED)
    expect(tallyNodeHash(m, shuffled as any)).to.equal(PINNED)
  })

  it('TH-2 addHistograms: identity, commutative, associative, union, fresh, canonical key order', () => {
    const e = { ballots: {} }
    const ha: any = { ballots: { A: { votes: 3, invalid: 1, excluded: 0, questions: { q1: { answered: 2, options: { a: 1, b: 1 } } }, unsupported: { q3: 1 } } } }
    const hb: any = { ballots: { A: { votes: 2, invalid: 0, excluded: 2, questions: { q1: { answered: 0, options: { b: 0, c: 0 } }, q2: { answered: 0, options: { x: 0 } } }, unsupported: { q4: 0 } }, B: { votes: 4, invalid: 0, excluded: 0, questions: {}, unsupported: {} } } }
    const hc: any = { ballots: { B: { votes: 1, invalid: 1, excluded: 0, questions: { q1: { answered: 0, options: { a: 0 } } }, unsupported: { q3: 0 } } } }
    expect(canonicalJson(addHistograms(e as any, ha))).to.equal(canonicalJson(ha))
    expect(canonicalJson(addHistograms(ha, e as any))).to.equal(canonicalJson(ha))
    expect(canonicalJson(addHistograms(ha, hb))).to.equal(canonicalJson(addHistograms(hb, ha)))
    expect(canonicalJson(addHistograms(addHistograms(ha, hb), hc))).to.equal(canonicalJson(addHistograms(ha, addHistograms(hb, hc))))
    const sum: any = addHistograms(ha, hb)
    expect(canonicalJson(sum)).to.equal(canonicalJson(refAdd(ha, hb)))
    expect(sum.ballots.A.votes).to.equal(5)
    expect(sum.ballots.A.excluded).to.equal(2)
    expect(sum.ballots.A.questions.q1.options).to.deep.equal({ a: 1, b: 1, c: 0 })
    expect(Object.keys(sum.ballots.A.questions)).to.deep.equal(['q1', 'q2'])
    expect(sum.ballots.A.unsupported).to.deep.equal({ q3: 1, q4: 0 })
    expect(Object.keys(sum.ballots)).to.deep.equal(['A', 'B'])
    // frozen inputs stay unchanged; mutating the result does not reach either input
    const fa = freeze(structuredClone(ha))
    const fb = freeze(structuredClone(hb))
    const r1: any = addHistograms(fa, fb)
    r1.ballots.B.votes = 99
    r1.ballots.A.questions.q1.options.a = 99
    expect(canonicalJson(fa)).to.equal(canonicalJson(ha))
    expect(canonicalJson(fb)).to.equal(canonicalJson(hb))
    const solo: any = addHistograms(fa, e as any)
    expect(solo.ballots.A).to.not.equal(fa.ballots.A)
    // Object.keys order equals the sorted order at every level (integer-like keys are listed first by the
    // engine whatever the insertion order; that exception is documented and not asserted)
    const isInt = (k: string): boolean => /^(0|[1-9]\d*)$/.test(k)
    const checkOrder = (o: any): void => {
      if (o === null || typeof o !== 'object') return
      const ks = Object.keys(o).filter(k => !isInt(k))
      expect(ks).to.deep.equal([...ks].sort())
      for (const k of Object.keys(o)) checkOrder(o[k])
    }
    checkOrder(sum)
  })

  it('TH-3 tallyTreeFrom: every leaf and every parent', () => {
    const { tree, validation, blocks } = syntheticSet()
    const ballots = templates()
    const r = tallyTreeFrom(tree, validation, ballots)
    expect(r.ok).to.equal(true)
    if (!r.ok) return
    const t: any = r.tally
    expect(t.format).to.equal('vt-tally-tree/1')
    expect(t.electionId).to.equal(FIXTURE_ELECTION_ID)
    expect(t.size).to.equal(5)
    expect(t.nodes.length).to.equal(9)
    expect(t.blockRoot).to.equal(tree.root)
    const tmpl = (id: string): any => ballots.find(b => b.id === id)
    t.nodes.forEach((n: any, i: number) => {
      const rn: any = tree.nodes[i]
      expect(n.index).to.equal(rn.index)
      expect(n.range).to.deep.equal(rn.range)
      expect(n.left).to.equal(rn.left)
      expect(n.right).to.equal(rn.right)
      expect(n.merkleHash).to.equal(rn.hash)
      expect(n.hash).to.equal(refTallyHash(rn.hash, n.histogram))
      if (rn.range[1] - rn.range[0] === 1) {
        const leaf: any = tree.leaves[rn.range[0]]
        const f = blocks[tree.leaves.findIndex((l: any) => l.cid === leaf.cid)]
        expect(Object.keys(n.histogram.ballots)).to.deep.equal([leaf.ballotId])
        const mine = n.histogram.ballots[leaf.ballotId]
        expect(mine.votes).to.equal(leaf.entryCount)
        expect(mine.excluded).to.equal(0)
        expect(mine.invalid).to.equal(f.votes.filter((v: any) => v.status === 'invalid').length)
        expect(canonicalJson(mine)).to.equal(canonicalJson(refLeafCounts(tmpl(leaf.ballotId), f.votes)))
        expect(Object.keys(mine.questions)).to.deep.equal(['q1', 'q2'])
        expect(mine.questions.q1.options).to.have.all.keys('a', 'b', 'c')
        expect(mine.unsupported).to.have.all.keys('q3')
      } else {
        expect(canonicalJson(n.histogram)).to.equal(canonicalJson(refAdd(t.nodes[rn.left].histogram, t.nodes[rn.right].histogram)))
      }
    })
    t.leaves.forEach((l: any, i: number) => {
      expect(l.index).to.equal(i)
      expect(l.disposition).to.equal('tallied')
      expect(l.excludedFor).to.deep.equal([])
      expect(l.leafData).to.equal(tree.leaves[i]!.leafData)
    })
    expect(canonicalJson(t.histogram)).to.equal(canonicalJson(t.nodes[8].histogram))
    expect(t.root).to.equal(t.nodes[8].hash)
    // q3 (rank) is only ever under unsupported
    for (const n of t.nodes) for (const b of Object.values<any>(n.histogram.ballots)) expect(b.questions).to.not.have.property('q3')
    // the totals line up: valid votes that answered q3 = ceil(valid/2) per block
    const root = t.histogram.ballots
    expect(root['ballot-a'].votes + root['ballot-b'].votes).to.equal(18)
  })

  it('TH-4 an R7-invalid block is excluded, not tallied', () => {
    const { tree, validation } = syntheticSet({ invalidBlock: 2 })
    const r = tallyTreeFrom(tree, validation, templates())
    expect(r.ok).to.equal(true)
    if (!r.ok) return
    const t: any = r.tally
    expect(t.leaves[2].disposition).to.equal('excluded')
    expect(t.leaves[2].excludedFor).to.deep.equal(['cid-mismatch', 'consent-signature-invalid'])
    for (const i of [0, 1, 3, 4]) {
      expect(t.leaves[i].disposition).to.equal('tallied')
      expect(t.leaves[i].excludedFor).to.deep.equal([])
    }
    const leafNode = t.nodes.find((n: any) => n.range[0] === 2 && n.range[1] === 3)
    const mine = leafNode.histogram.ballots['ballot-b']
    expect(mine.votes).to.equal(3)
    expect(mine.excluded).to.equal(3)
    expect(mine.invalid).to.equal(0)
    for (const q of Object.values<any>(mine.questions)) {
      expect(q.answered).to.equal(0)
      for (const c of Object.values<any>(q.options)) expect(c).to.equal(0)
    }
    for (const c of Object.values<any>(mine.unsupported)) expect(c).to.equal(0)
    // ballot-b's other block is unaffected
    const other = t.nodes.find((n: any) => n.range[0] === 4 && n.range[1] === 5).histogram.ballots['ballot-b']
    expect(other.excluded).to.equal(0)
    // votes = valid + invalid + excluded at the root, valid counted by the spec itself
    const rb = t.histogram.ballots['ballot-b']
    expect(rb.votes).to.equal(8)
    expect(rb.excluded).to.equal(3)
    const validB = 5 - rb.invalid
    expect(rb.votes).to.equal(validB + rb.invalid + rb.excluded)
  })

  it('TH-5 refusals, none throwing', () => {
    const base = (): any => syntheticSet()
    const go = (tree: any, validation: any, ballots: any = templates()): any => tallyTreeFrom(tree, validation, ballots)
    const reason = (r: any): string => (r.ok ? 'ok' : r.reason)
    let s = base()
    expect(reason(go(s.tree, { ...s.validation, ok: false, reason: 'secret-mismatch', detail: 'x' }))).to.equal('malformed-input')
    expect(reason(go(s.tree, { ...s.validation, released: false }))).to.equal('not-released')
    expect(reason(go(s.tree, { ...s.validation, electionId: 'other' }))).to.equal('inconsistent-inputs')
    expect(reason(go(s.tree, { ...s.validation, electionRevision: 9 }))).to.equal('inconsistent-inputs')
    expect(reason(go(s.tree, { ...s.validation, blocks: s.validation.blocks.slice(1) }))).to.equal('inconsistent-inputs')
    expect(reason(go(s.tree, { ...s.validation, blocks: [...s.validation.blocks, s.validation.blocks[0]] }))).to.equal('inconsistent-inputs')
    expect(reason(go(s.tree, { ...s.validation, blocks: s.validation.blocks.map((b: any, i: number) => (i === 1 ? { ...b, status: 'not-decryptable-yet', votes: [] } : b)) }))).to.equal('inconsistent-inputs')
    expect(reason(go(s.tree, { ...s.validation, blocks: s.validation.blocks.map((b: any, i: number) => (i === 1 ? { ...b, votes: b.votes.slice(1) } : b)) }))).to.equal('inconsistent-inputs')
    const withEntry = (mut: (e: any) => void): any => ({
      ...s.validation,
      blocks: s.validation.blocks.map((b: any, i: number) => {
        if (i !== 0) return b
        const votes = structuredClone(b.votes)
        const v = votes.find((x: any) => x.status === 'valid')
        mut(v.entry)
        return { ...b, votes }
      })
    })
    expect(reason(go(s.tree, withEntry(e => { e.answers[0].questionCode = 'q9' })))).to.equal('inconsistent-inputs')
    expect(reason(go(s.tree, withEntry(e => { e.answers[0].optionCodes = ['zz'] })))).to.equal('inconsistent-inputs')
    expect(reason(go(s.tree, withEntry(e => { e.answers = 'x' })))).to.equal('inconsistent-inputs')
    expect(reason(go(s.tree, s.validation, [makeFixtureTemplate('ballot-a')]))).to.equal('inconsistent-inputs')
    expect(reason(go(s.tree, s.validation, 'x'))).to.equal('malformed-input')
    expect(reason(go(s.tree, s.validation, [{ ...templates()[0], questions: 'x' }, templates()[1]]))).to.equal('malformed-input')
    expect(reason(go(s.tree, s.validation, [{ ...templates()[0], questions: [{ title: 't', options: [] }] }, templates()[1]]))).to.equal('malformed-input')
    expect(reason(go(s.tree, s.validation, [{ ...templates()[0], questions: [{ code: 'q', title: 't', options: [{ title: 'x' }] }] }, templates()[1]]))).to.equal('malformed-input')
    expect(reason(go(s.tree, s.validation, [templates()[0], templates()[0]]))).to.equal('malformed-input')
    expect(reason(go(null, s.validation))).to.equal('malformed-input')
    expect(reason(go({ leaves: [] }, s.validation))).to.equal('malformed-input')
    expect(reason(go(s.tree, null))).to.equal('malformed-input')
    expect(reason(go(s.tree, 5))).to.equal('malformed-input')
    s = base()
    expect(reason(go(s.tree, s.validation))).to.equal('ok')
  })

  it('TH-6 hostile codes and the empty tree', () => {
    const before = Object.getOwnPropertyNames(Object.prototype).sort()
    const template: any = makeFixtureTemplate('ballot-a', {
      questions: [{
        code: 'hasOwnProperty', title: 't', type: 'select', optionRange: { min: 1, max: 4 },
        options: ['__proto__', 'constructor', 'toString', '1'].map(code => ({ code, title: code }))
      }, { code: '__proto__', title: 'u', type: 'rank', options: [{ code: 'r', title: 'r' }] }]
    })
    const rows = [row('c1', 'ballot-a', 3)]
    const built = buildBlockTree(rows, scope)
    if (!built.ok) throw new Error('tree')
    const votes = [
      { index: 0, status: 'valid', entry: entryOf('ballot-a', [['__proto__', ['r']], ['hasOwnProperty', ['1', '__proto__', 'constructor', 'toString']]]) },
      { index: 1, status: 'valid', entry: entryOf('ballot-a', [['hasOwnProperty', ['toString']]]) },
      { index: 2, status: 'valid', entry: entryOf('ballot-a', [['hasOwnProperty', ['__proto__']]]) }
    ]
    const r: any = tallyTreeFrom(built.tree, report([blockFinding(rows[0], { votes })]), [template])
    expect(r.ok).to.equal(true)
    const leaf = r.tally.nodes[0].histogram.ballots['ballot-a']
    const qd = Object.getOwnPropertyDescriptor(leaf.questions, 'hasOwnProperty')!.value
    expect(qd.answered).to.equal(3)
    const opt = (k: string): number => Object.getOwnPropertyDescriptor(qd.options, k)!.value
    expect(opt('1')).to.equal(1)
    expect(opt('__proto__')).to.equal(2)
    expect(opt('constructor')).to.equal(1)
    expect(opt('toString')).to.equal(2)
    expect(Object.getOwnPropertyDescriptor(leaf.unsupported, '__proto__')!.value).to.equal(1)
    expect(Object.getPrototypeOf(qd.options)).to.equal(Object.prototype)
    expect(Object.getOwnPropertyNames(Object.prototype).sort()).to.deep.equal(before)
    expect(({} as any).polluted).to.equal(undefined)
    expect(canonicalJson(JSON.parse(JSON.stringify(r.tally)))).to.equal(canonicalJson(r.tally))

    const empty = buildBlockTree([], scope)
    if (!empty.ok) throw new Error('empty')
    const er: any = tallyTreeFrom(empty.tree, report([]), templates())
    expect(er.ok).to.equal(true)
    expect(er.tally.size).to.equal(0)
    expect(er.tally.nodes).to.deep.equal([])
    expect(er.tally.leaves).to.deep.equal([])
    expect(er.tally.histogram).to.deep.equal({ ballots: {} })
    expect(er.tally.blockRoot).to.equal(BLOCK_TREE_EMPTY_ROOT)
    expect(er.tally.root).to.equal(refTallyHash(BLOCK_TREE_EMPTY_ROOT, { ballots: {} }))
  })
})
