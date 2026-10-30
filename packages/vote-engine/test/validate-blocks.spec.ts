/**
 * validate-blocks.spec.ts — R7 (D-70, D-71): the shared pool payload shape check, the ballot answer
 * validator and the comprehensive block validation, over the 65-05 committed-row fixture.
 */

import { expect } from 'chai'
import { serializeBlockCiphertext } from '../src/crypto/index.js'
import { reencryptElectionBlock } from '../src/key-release/election-block.js'
import {
  checkFormedPoolBlock,
  checkPoolPayloadShape,
  formPoolBlock,
  poolBlockCid,
  poolBlockId,
  type FormedPoolBlock,
  type PoolBallot,
  type PoolBlockCheck,
  type PoolContribution
} from '../src/pool/pool-block.js'
import { canonicalJson, sortByCanonicalBytes } from '../src/voting/canonical.js'
import { ballotTemplateDigest, buildVoteEntry, makeVoteNonce, type VoteEntry } from '../src/voting/vote-entries.js'
import {
  ANSWER_FINDING_CODES,
  ANSWER_INFO_CODES,
  validateVoteEntryAgainstBallot,
  type VoteEntryValidity
} from '../src/blocks/answer-checks.js'
import { FIXTURE_ELECTION_ID, FIXTURE_REVISION, makeCommittedElection, makeFixtureTemplate } from './fixtures/pool-blocks.js'

// The oracle below is the b0cee4af body of checkFormedPoolBlock and sameOrder, copied verbatim from
// `git show b0cee4af:packages/vote-engine/src/pool/pool-block.ts` (only the two names changed).
// PS-4 proves the refactored function returns exactly what this one returns.

const legacySameOrder = (a: readonly unknown[], b: readonly unknown[]): boolean =>
  a.length === b.length && a.every((x, i) => canonicalJson(x) === canonicalJson(b[i]))

/**
 * What a member checks before it signs a formed block. Every refusal names its reason (the former
 * relays it to the pool); a member never signs a block that fails any of these.
 */
export function legacyCheckFormedPoolBlock (block: FormedPoolBlock, mine: PoolContribution, ballot: PoolBallot): PoolBlockCheck {
  const p = block.payload
  if (p?.v !== 2 || !Array.isArray(p.votes) || !Array.isArray(p.voterRecords)) return { ok: false, reason: 'the block is not a pool block' }
  if (block.templateDigest !== ballot.templateDigest) return { ok: false, reason: 'the block names another ballot template' }
  if (p.votes.length !== p.voterRecords.length) return { ok: false, reason: 'vote and voter counts differ' }
  if (p.votes.length !== block.registrantIds.length) return { ok: false, reason: 'the voter list does not match the entries' }
  if (!legacySameOrder(p.votes, sortByCanonicalBytes(p.votes)) || !legacySameOrder(p.voterRecords, sortByCanonicalBytes(p.voterRecords))) {
    return { ok: false, reason: 'the entries are not in canonical order' }
  }
  if (p.votes.filter(v => v === mine.voteCiphertext).length !== 1) return { ok: false, reason: 'my vote is missing or altered' }
  const myEntry = canonicalJson(mine.voterEntry)
  if (p.voterRecords.filter(r => canonicalJson(r) === myEntry).length !== 1) return { ok: false, reason: 'my voter entry is missing or altered' }
  if (new Set(p.votes as string[]).size !== p.votes.length) return { ok: false, reason: 'a vote appears twice' }
  const ids = (p.voterRecords as VoterEntry[]).map(r => r?.registrantId)
  if (new Set(ids).size !== ids.length) return { ok: false, reason: 'a voter appears twice' }
  if (canonicalJson([...ids].sort()) !== canonicalJson(block.registrantIds)) return { ok: false, reason: 'the voter list does not match the entries' }
  for (const r of p.voterRecords as VoterEntry[]) {
    if (r?.electionId !== ballot.electionKey.electionId || r?.electionRevision !== ballot.electionKey.revision) {
      return { ok: false, reason: 'a voter entry is for another election or revision' }
    }
  }
  if (poolBlockId(p) !== block.blockId) return { ok: false, reason: 'the block id is not the digest of the payload' }
  let rederived: string
  try {
    rederived = serializeBlockCiphertext(reencryptElectionBlock(ballot.electionKey, block.blockId, p, block.randomness))
  } catch {
    return { ok: false, reason: 'the disclosed randomness is unusable' }
  }
  if (rederived !== block.ciphertext) return { ok: false, reason: 'the ciphertext does not encrypt the shown payload' }
  if (poolBlockCid(block.ciphertext) !== block.cid) return { ok: false, reason: 'the cid does not match the ciphertext' }
  return { ok: true }
}

describe('pool payload shape (65-07: checkPoolPayloadShape)', function () {
  this.timeout(30_000)

  let set: ReturnType<typeof makeCommittedElection>
  let b2: ReturnType<typeof makeCommittedElection>['blocks'][number]
  let b1: ReturnType<typeof makeCommittedElection>['blocks'][number]
  const scope2 = { electionId: FIXTURE_ELECTION_ID, revision: FIXTURE_REVISION }

  before(() => {
    set = makeCommittedElection({ ballotIds: ['ballot-a'], blocks: [{ size: 4 }, { size: 3, payloadVersion: 1 }] })
    b2 = set.blocks[0]!
    b1 = set.blocks[1]!
  })

  const ids2 = (): string[] => [...b2.formed!.registrantIds]
  const votes2 = (): string[] => [...(b2.payload.votes as string[])]
  const recs2 = (): any[] => [...(b2.payload.voterRecords as any[])]
  const payloadOf = (votes: unknown[], voterRecords: unknown[], v: 1 | 2 = 2): any => ({ v, votes, voterRecords })

  it('PS-1 an honest v:2 and an honest v:1 payload are ok', () => {
    expect(checkPoolPayloadShape(b2.payload, b2.formed!.registrantIds, scope2)).to.deep.equal({ ok: true })
    const ids1 = JSON.parse(b1.row.VoterRegistrantIds) as string[]
    expect(checkPoolPayloadShape(b1.payload, ids1, scope2)).to.deep.equal({ ok: true })
  })

  it('PS-2 every code, its stage and its legacy reason', () => {
    const cases: Array<[string, any, string[], any, string, 'structure' | 'records', string]> = [
      ['null payload', null, ids2(), scope2, 'not-a-payload', 'structure', 'the block is not a pool block'],
      ['votes not an array', { v: 2, votes: 'x', voterRecords: recs2() }, ids2(), scope2, 'not-a-payload', 'structure', 'the block is not a pool block'],
      ['one record dropped', payloadOf(votes2(), recs2().slice(1)), ids2(), scope2, 'counts-differ', 'structure', 'vote and voter counts differ'],
      ['short voter list', b2.payload, ids2().slice(1), scope2, 'voter-count-mismatch', 'structure', 'the voter list does not match the entries'],
      ['votes reversed', payloadOf(votes2().reverse(), recs2()), ids2(), scope2, 'not-canonical-order', 'structure', 'the entries are not in canonical order'],
      ['duplicate vote', payloadOf(sortByCanonicalBytes([votes2()[0], ...votes2().slice(0, 1), ...votes2().slice(2)]), recs2()), ids2(), scope2, 'duplicate-vote', 'records', 'a vote appears twice'],
      ['duplicate voter', payloadOf(votes2(), sortByCanonicalBytes([recs2()[0], { ...recs2()[0], privateCid: 'zzz' }, recs2()[2], recs2()[3]])), ids2(), scope2, 'duplicate-voter', 'records', 'a voter appears twice'],
      ['stranger in list', b2.payload, [...ids2().slice(1), 'stranger'].sort(), scope2, 'voter-list-mismatch', 'records', 'the voter list does not match the entries'],
      ['other revision scope', b2.payload, ids2(), { electionId: FIXTURE_ELECTION_ID, revision: 2 }, 'voter-entry-scope-mismatch', 'records', 'a voter entry is for another election or revision']
    ]
    for (const [name, payload, ids, scope, code, stage, reason] of cases) {
      const r = checkPoolPayloadShape(payload, ids, scope)
      expect(r, name).to.deep.equal({ ok: false, code, stage, reason })
    }
    expect(checkPoolPayloadShape(b2.payload, ids2()), 'no scope').to.deep.equal({ ok: true })
  })

  it('PS-3 structure failures are reported before record failures', () => {
    const dup = sortByCanonicalBytes([votes2()[0], votes2()[0], votes2()[2], votes2()[3]])
    const r = checkPoolPayloadShape(payloadOf([...dup].reverse(), recs2()), ids2(), scope2)
    expect(r).to.deep.include({ ok: false, code: 'not-canonical-order', stage: 'structure' })
  })

  it('PS-4 checkFormedPoolBlock equals the b0cee4af body on every tampered block and every member', () => {
    const poolBallot: PoolBallot = b2.ballot.poolBallot
    const contribs: PoolContribution[] = b2.voters.map(v => v.contribution)
    const formed = b2.formed!
    const other = formPoolBlock(contribs.slice(0, 3), poolBallot)
    const withPayload = (payload: any): FormedPoolBlock => ({ ...formed, payload })
    const swapped = sortByCanonicalBytes(votes2().map((v, i) => (i === votes2().indexOf(contribs[1]!.voteCiphertext) ? contribs[0]!.voteCiphertext : v)))
    const dupVoter = sortByCanonicalBytes([recs2()[0], { ...recs2()[0], privateCid: 'zzz' }, recs2()[2], recs2()[3]])
    const rec0Rev2 = sortByCanonicalBytes(recs2().map((r, i) => (i === 0 ? { ...r, electionRevision: 2 } : r)))
    const blocks: Array<[string, FormedPoolBlock]> = [
      ['honest', formed],
      ['votes reversed', withPayload(payloadOf(votes2().reverse(), recs2()))],
      ['registrantIds.slice(1)', { ...formed, registrantIds: formed.registrantIds.slice(1) }],
      ['formed without member 0', formPoolBlock(contribs.slice(1), poolBallot)],
      ['member 0 vote twice', withPayload(payloadOf(swapped, recs2()))],
      ['voter twice', withPayload(payloadOf(votes2(), dupVoter))],
      ['templateDigest other', { ...formed, templateDigest: 'other' }],
      ['record revision 2', withPayload(payloadOf(votes2(), rec0Rev2))],
      ['ciphertext of another block', { ...formed, ciphertext: other.ciphertext }],
      ['cid of another block', { ...formed, cid: other.cid }],
      ['blockId first char changed', { ...formed, blockId: (formed.blockId[0] === 'A' ? 'B' : 'A') + formed.blockId.slice(1) }],
      ['payload v:1', withPayload(payloadOf(votes2(), recs2(), 1))],
      ['payload null', withPayload(null)]
    ]
    for (const [name, block] of blocks) {
      for (const mine of contribs) {
        const now: PoolBlockCheck = checkFormedPoolBlock(block, mine, poolBallot)
        const then = legacyCheckFormedPoolBlock(block, mine, poolBallot)
        expect(now, `${name} / ${mine.member}`).to.deep.equal(then)
      }
    }
    expect(legacyCheckFormedPoolBlock(blocks[0]![1], contribs[0]!, poolBallot)).to.deep.equal({ ok: true })
    expect(checkFormedPoolBlock(blocks[4]![1], contribs[0]!, poolBallot)).to.deep.equal({ ok: false, reason: 'my vote is missing or altered' })
  })

  it('PS-5 hostile JSON values give a typed failure, never a throw', () => {
    const r = checkPoolPayloadShape(payloadOf(['a', 'b', 'c'], [null, 1, 'x']), ['i', 'j', 'k'], scope2)
    expect(r.ok).to.equal(false)
    const r2 = checkPoolPayloadShape(payloadOf(['a', 'b', 'c'], ['x', 1, null]), ['i', 'j', 'k'], scope2)
    expect(r2.ok).to.equal(false)
    // keep the shared helpers referenced so the oracle imports stay honest
    expect(typeof poolBlockId).to.equal('function')
    expect(typeof poolBlockCid).to.equal('function')
    expect(typeof reencryptElectionBlock).to.equal('function')
    expect(typeof serializeBlockCiphertext).to.equal('function')
    expect(typeof canonicalJson).to.equal('function')
  })
})

describe('answer checks (65-07: validateVoteEntryAgainstBallot, D-71)', function () {
  this.timeout(30_000)

  const t = makeFixtureTemplate('ballot-a')
  const tOpt = { ...t, questions: t.questions.map(q => (q.code === 'q3' ? { ...q, required: false } : q)) }
  const scope = { electionId: FIXTURE_ELECTION_ID, electionRevision: FIXTURE_REVISION, ballotId: 'ballot-a' }
  const nonce = (): string => makeVoteNonce(globalThis.crypto.getRandomValues(new Uint8Array(32)))
  const build = (selections: Record<string, string[]>, ballot = t): VoteEntry =>
    buildVoteEntry({ ballot, electionRevision: FIXTURE_REVISION, selections, nonce: nonce() })
  const codes = (r: VoteEntryValidity): string[] => r.findings.map(f => f.code)
  const errors = (r: VoteEntryValidity): string[] => r.findings.filter(f => f.severity === 'error').map(f => f.code)
  const base = (): VoteEntry => build({ q1: ['a'], q2: ['x'] }, tOpt)
  const raw = (over: Record<string, unknown>): unknown => ({ ...base(), ...over })
  const withQ2 = (over: Record<string, unknown>): ReturnType<typeof makeFixtureTemplate> =>
    makeFixtureTemplate('ballot-a', { questions: t.questions.map(q => (q.code === 'q2' ? { ...q, ...over } : q)) })

  it('AC-1 producer output validates', () => {
    for (const sel of [{ q1: ['a'], q2: ['x'] }, { q1: ['c'], q2: ['y', 'x'] }]) {
      const e = build(sel, tOpt)
      const r = validateVoteEntryAgainstBallot(e, tOpt, scope)
      expect(r.valid).to.equal(true)
      if (r.valid) expect(r.entry).to.deep.equal(e)
      expect(r.findings).to.deep.equal([])
    }
    const blank = validateVoteEntryAgainstBallot(build({ q1: ['b'] }, tOpt), tOpt, scope)
    expect(blank.valid).to.equal(true)
    expect(blank.findings).to.have.length(1)
    expect(blank.findings[0]).to.deep.include({ code: 'blank-required', severity: 'info', questionCode: 'q2' })
    const plain = validateVoteEntryAgainstBallot(build({ q1: ['a'], q2: ['x'] }), t, scope)
    expect(plain.valid).to.equal(true)
    expect(plain.findings).to.have.length(1)
    expect(plain.findings[0]).to.deep.include({ code: 'blank-required', questionCode: 'q3' })
  })

  it('AC-2 D-71 minimum', () => {
    const tm = withQ2({ optionRange: { min: 2, max: 3 }, required: true })
    const below = validateVoteEntryAgainstBallot(build({ q1: ['a'], q2: ['x'] }, tm), tm, scope)
    expect(below.valid).to.equal(false)
    expect(errors(below)).to.deep.equal(['below-minimum'])
    expect(below.findings.find(f => f.code === 'below-minimum')?.questionCode).to.equal('q2')
    expect(validateVoteEntryAgainstBallot(build({ q1: ['a'], q2: ['x', 'y'] }, tm), tm, scope).valid).to.equal(true)
    const blank = validateVoteEntryAgainstBallot(build({ q1: ['a'] }, tm), tm, scope)
    expect(blank.valid).to.equal(true)
    expect(blank.findings.filter(f => f.code === 'blank-required' && f.questionCode === 'q2')).to.have.length(1)
    const opt = { ...tm, questions: tm.questions.map(q => (q.code === 'q2' || q.code === 'q3' ? { ...q, required: false } : q)) }
    expect(validateVoteEntryAgainstBallot(build({ q1: ['a'] }, opt), opt, scope).findings).to.deep.equal([])
  })

  it('AC-3 one error code per single-defect raw entry', () => {
    const q1 = (optionCodes: string[]): unknown => ({ questionCode: 'q1', optionCodes })
    const q2 = (optionCodes: string[]): unknown => ({ questionCode: 'q2', optionCodes })
    const cases: Array<[string, unknown]> = [
      ['unknown-question', raw({ answers: [q1(['a']), q2(['x']), { questionCode: 'q9', optionCodes: ['a'] }] })],
      ['unknown-option', raw({ answers: [q1(['zz']), q2(['x'])] })],
      ['too-many-options', raw({ answers: [q1(['a', 'b']), q2(['x'])] })],
      ['duplicate-option', raw({ answers: [q1(['a']), q2(['x', 'x'])] })],
      ['options-not-sorted', raw({ answers: [q1(['a']), q2(['y', 'x'])] })],
      ['empty-answer', raw({ answers: [q1(['a']), q2([])] })],
      ['answers-not-sorted', raw({ answers: [q2(['x']), q1(['a'])] })],
      ['duplicate-question', raw({ answers: [q1(['a']), q1(['a']), q2(['x'])] })],
      ['bad-nonce', raw({ nonce: 'A'.repeat(64) })],
      ['bad-nonce', raw({ nonce: 'a'.repeat(63) })],
      ['template-digest-mismatch', raw({ templateDigest: 'other' })],
      ['wrong-ballot', raw({ ballotId: 'ballot-b' })],
      ['wrong-election', raw({ electionId: 'other-election' })],
      ['wrong-revision', raw({ electionRevision: 2 })]
    ]
    for (const [code, entry] of cases) {
      const r = validateVoteEntryAgainstBallot(entry, tOpt, scope)
      expect(r.valid, code).to.equal(false)
      expect(errors(r), code).to.deep.equal([code])
    }
    const unk = validateVoteEntryAgainstBallot(raw({ answers: [q1(['zz']), q2(['x'])] }), tOpt, scope)
    expect(unk.findings[0]).to.deep.include({ optionCode: 'zz', questionCode: 'q1' })
  })

  it('AC-4 malformed entries give one malformed-entry finding', () => {
    const b = base() as any
    const { nonce: _n, ...noNonce } = b
    const bad: unknown[] = [
      null, [], 'x', noNonce, { ...b, extra: 1 }, { ...b, v: 2 }, { ...b, answers: 'x' },
      { ...b, answers: [{ questionCode: 'q1', optionCodes: ['a'], extra: 1 }] },
      { ...b, answers: [{ questionCode: 'q1', optionCodes: [1] }] },
      { ...b, electionRevision: '1' }, { ...b, electionRevision: 1n }
    ]
    for (const e of bad) {
      const r = validateVoteEntryAgainstBallot(e, tOpt, scope)
      expect(r.valid).to.equal(false)
      expect(codes(r)).to.deep.equal(['malformed-entry'])
    }
  })

  it('AC-5 non-select questions are info, structure still applies', () => {
    const e = build({ q1: ['a'], q2: ['x'], q3: ['r1'] }, tOpt)
    const r = validateVoteEntryAgainstBallot(e, tOpt, scope)
    expect(r.valid).to.equal(true)
    expect(r.findings).to.have.length(1)
    expect(r.findings[0]).to.deep.include({ code: 'unsupported-question-type', severity: 'info', questionCode: 'q3' })
    const bad = validateVoteEntryAgainstBallot(raw({ answers: [{ questionCode: 'q1', optionCodes: ['a'] }, { questionCode: 'q2', optionCodes: ['x'] }, { questionCode: 'q3', optionCodes: ['zz'] }] }), tOpt, scope)
    expect(bad.valid).to.equal(false)
    expect(errors(bad)).to.deep.equal(['unknown-option'])
  })

  it('AC-6 every defect is collected in a fixed order', () => {
    const e = raw({ nonce: 'BAD', answers: [{ questionCode: 'q1', optionCodes: ['zz'] }] })
    const r = validateVoteEntryAgainstBallot(e, tOpt, scope)
    expect(codes(r)).to.deep.equal(['bad-nonce', 'unknown-option', 'blank-required'])
  })

  it('AC-7 the scope digest is authoritative; required does not move the digest', () => {
    const e = raw({ templateDigest: 'custom' })
    expect(codes(validateVoteEntryAgainstBallot(e, tOpt, scope))).to.deep.equal(['template-digest-mismatch'])
    expect(codes(validateVoteEntryAgainstBallot(e, tOpt, { ...scope, templateDigest: 'custom' }))).to.deep.equal([])
    expect(ballotTemplateDigest(t, FIXTURE_REVISION)).to.equal(ballotTemplateDigest(tOpt, FIXTURE_REVISION))
  })

  it('AC-8 a hostile ballot gives malformed-ballot', () => {
    for (const ballot of [{ ...tOpt, questions: 'x' }, { ...tOpt, questions: [{ title: 'no code', options: [] }] }, null, { ...tOpt, questions: [{ code: 'q1', options: [null] }] }]) {
      const r = validateVoteEntryAgainstBallot(base(), ballot as any, scope)
      expect(r.valid).to.equal(false)
      expect(codes(r)).to.deep.equal(['malformed-ballot'])
    }
  })

  it('AC-9 pure, closed codes, severity rule', () => {
    const entry = raw({ nonce: 'BAD', answers: [{ questionCode: 'q3', optionCodes: ['r1'] }, { questionCode: 'q9', optionCodes: [] }] })
    const entryCopy = structuredClone(entry)
    const ballotCopy = structuredClone(tOpt)
    const r1 = validateVoteEntryAgainstBallot(entry, tOpt, scope)
    const r2 = validateVoteEntryAgainstBallot(entry, tOpt, scope)
    expect(r1).to.deep.equal(r2)
    expect(entry).to.deep.equal(entryCopy)
    expect(tOpt).to.deep.equal(ballotCopy)
    for (const f of r1.findings) {
      expect(f.detail).to.be.a('string').that.is.not.empty
      expect(ANSWER_FINDING_CODES).to.include(f.code)
      expect(f.severity).to.equal((ANSWER_INFO_CODES as readonly string[]).includes(f.code) ? 'info' : 'error')
    }
  })
})
