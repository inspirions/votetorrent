/**
 * pool.spec.ts — vote pools (spike 102, applied): sealed envelopes, the rendezvous, the v2 block a
 * pool forms, the checks a member runs before it signs, and the agent's negotiation over an
 * in-process rendezvous. The same agent runs on real CadreNodes in
 * .planning/spikes/102-pool-negotiation/product-pool.ts.
 */

import { expect } from 'chai'
import { Database } from '@quereus/quereus'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex } from '@noble/curves/utils.js'
import { ed25519 } from '@noble/curves/ed25519.js'
import { registerDbPlugins } from '../src/database/initialize.js'
import { encryptVoteEntry, openElectionBlock, openVoteEntries } from '../src/key-release/index.js'
import {
  PoolAgent,
  PoolRendezvous,
  checkFormedPoolBlock,
  consentDigest,
  createInMemoryRendezvousClient,
  ed25519PublicKeyFromPeerId,
  formPoolBlock,
  openPoolEnvelope,
  peerIdFromEd25519PublicKey,
  poolBlockCid,
  poolBlockId,
  poolIdentityFromRawKey,
  poolRequests,
  sealPoolEnvelope,
  createPoolIdentity,
  type ConsentSignature,
  type FormedPoolBlock,
  type PoolBallot,
  type PoolContribution,
  type PoolIdentity,
  type PoolOutcome
} from '../src/pool/index.js'
import { fromBase64url, toBase64url } from '../src/pool/pool-codec.js'
import type { VoterEntry } from '../src/voting/index.js'
import { makeP256TestKey, signDigestP256 } from './fixtures/p256-signer.js'

const electionSecret = secp256k1.utils.randomSecretKey()
const ballot: PoolBallot = {
  electionKey: { electionId: 'election-pool-1', revision: 1, jointPublicKey: bytesToHex(secp256k1.getPublicKey(electionSecret, true)) },
  ballotId: 'ballot-pool-1',
  templateDigest: 'template-digest-1'
}

interface TestVoter { identity: PoolIdentity, contribution: PoolContribution, voteJson: string, priv: Uint8Array }

function makeVoter (i: number): TestVoter {
  const identity = poolIdentityFromRawKey(ed25519.utils.randomSecretKey())
  const { privBytes, pubHex } = makeP256TestKey()
  const voteJson = JSON.stringify({ v: 1, ballotId: ballot.ballotId, answers: [{ questionCode: 'q1', optionCodes: [i % 2 === 0 ? 'a' : 'b'] }], nonce: bytesToHex(crypto.getRandomValues(new Uint8Array(32))) })
  const voterEntry: VoterEntry = {
    v: 1, electionId: ballot.electionKey.electionId, electionRevision: ballot.electionKey.revision, registrantId: `registrant-${i}-${Math.random().toString(36).slice(2, 8)}`,
    privateCid: `private-${i}`, publicCid: null, deviceKey: pubHex, attestationCid: null,
    ballots: [{ ballotId: ballot.ballotId, templateDigest: ballot.templateDigest }], signature: 'ab'.repeat(32)
  }
  return {
    identity,
    voteJson,
    priv: privBytes,
    contribution: { member: identity.peerId, voteCiphertext: encryptVoteEntry(ballot.electionKey, ballot.ballotId, voteJson), voterEntry }
  }
}

describe('pool (spike 102): codec and peer ids', () => {
  it('base64url round-trips every length and refuses padding, foreign characters and non-canonical tails', () => {
    for (let n = 0; n < 40; n++) {
      const bytes = crypto.getRandomValues(new Uint8Array(n))
      expect(Array.from(fromBase64url(toBase64url(bytes))!)).to.deep.equal(Array.from(bytes))
    }
    expect(fromBase64url('AA==')).to.equal(null)
    expect(fromBase64url('A+B/')).to.equal(null)
    expect(fromBase64url('AB')).to.equal(null) // 'B' leaves non-zero spare bits: not the canonical encoding of 0x00
    expect(fromBase64url('A')).to.equal(null)
  })

  it('a peer id is the Ed25519 public key, both ways, and matches libp2p', async () => {
    const { generateKeyPair } = await import('@libp2p/crypto/keys') as { generateKeyPair: (t: string) => Promise<{ raw: Uint8Array }> }
    const { peerIdFromPrivateKey } = await import('@libp2p/peer-id') as { peerIdFromPrivateKey: (k: unknown) => { toString: () => string } }
    const key = await generateKeyPair('Ed25519')
    const libp2pPeerId = peerIdFromPrivateKey(key).toString()
    const identity = poolIdentityFromRawKey(key.raw)
    expect(identity.peerId).to.equal(libp2pPeerId)
    expect(peerIdFromEd25519PublicKey(ed25519PublicKeyFromPeerId(libp2pPeerId))).to.equal(libp2pPeerId)
    expect(() => ed25519PublicKeyFromPeerId('QmYyQSo1c1Ym7orWxLYvCrM2EmxFTANf8wXmmE7DWjhx5N')).to.throw().with.property('code', 'bad-peer-id')
  })
})

describe('pool (spike 102): sealed envelopes', () => {
  const a = makeVoter(0).identity
  const b = makeVoter(1).identity
  const c = makeVoter(2).identity

  it('only the recipient opens it, and it names the real sender', () => {
    const env = sealPoolEnvelope(a, b.peerId, { t: 'hello', n: 1 })
    const opened = openPoolEnvelope<{ t: string, n: number }>(b, env)
    expect(opened.from).to.equal(a.peerId)
    expect(opened.body).to.deep.equal({ t: 'hello', n: 1 })
    expect(() => openPoolEnvelope(c, env)).to.throw().with.property('code', 'not-for-me')
    expect(() => openPoolEnvelope(c, { ...env, to: c.peerId })).to.throw().with.property('code', 'auth-failed')
  })

  it('a flipped ciphertext byte is refused', () => {
    const env = sealPoolEnvelope(a, b.peerId, { t: 'x' })
    const ct = fromBase64url(env.ct)!
    ct[0] = ct[0]! ^ 1
    expect(() => openPoolEnvelope(b, { ...env, ct: toBase64url(ct) })).to.throw().with.property('code', 'auth-failed')
  })

  it('a sender claiming another peer id fails the signature check', () => {
    const forger: PoolIdentity = { peerId: c.peerId, secretKey: a.secretKey }
    const env = sealPoolEnvelope(forger, b.peerId, { t: 'x' })
    expect(() => openPoolEnvelope(b, env)).to.throw().with.property('code', 'bad-signature')
  })

  it('a stale envelope is refused', () => {
    const env = sealPoolEnvelope(a, b.peerId, { t: 'x' }, Date.now() - 11 * 60_000)
    expect(() => openPoolEnvelope(b, env)).to.throw().with.property('code', 'stale')
  })

  it('the rendezvous-visible envelope carries no body text', () => {
    const env = sealPoolEnvelope(a, b.peerId, { t: 'merge', registrantId: 'registrant-secret-xyz' })
    expect(JSON.stringify(env)).to.not.contain('registrant-secret-xyz')
    expect(JSON.stringify(env)).to.not.contain('merge')
  })
})

describe('pool (spike 102): per-vote ciphertexts and the v2 block', () => {
  const voters = [0, 1, 2, 3].map(makeVoter)
  const contributions = voters.map(v => v.contribution)

  it('a formed block passes every member\'s check and reopens to the same votes after release', () => {
    const block = formPoolBlock(contributions, ballot)
    for (const v of voters) expect(checkFormedPoolBlock(block, v.contribution, ballot)).to.deep.equal({ ok: true })
    const opened = openElectionBlock(electionSecret, ballot.electionKey, { blockId: block.blockId, ciphertext: block.ciphertext })
    expect(opened.ok).to.equal(true)
    if (!opened.ok) return
    expect(opened.payload.v).to.equal(2)
    const votes = openVoteEntries(electionSecret, ballot.electionKey, ballot.ballotId, opened.payload)
    expect(votes.every(v => v.ok)).to.equal(true)
    expect(votes.map(v => (v as { voteEntryJson: string }).voteEntryJson).sort()).to.deep.equal(voters.map(v => v.voteJson).sort())
  })

  it('the block lists votes in canonical order, not pool order', () => {
    const a = formPoolBlock(contributions, ballot)
    const b = formPoolBlock([...contributions].reverse(), ballot)
    expect(a.payload.votes).to.deep.equal(b.payload.votes)
    expect(a.payload.voterRecords).to.deep.equal(b.payload.voterRecords)
    expect(a.blockId).to.equal(b.blockId)
  })

  it('a vote cannot be opened under another ballot\'s binding', () => {
    const block = formPoolBlock(contributions, ballot)
    const opened = openElectionBlock(electionSecret, ballot.electionKey, { blockId: block.blockId, ciphertext: block.ciphertext })
    if (!opened.ok) throw new Error('block did not open')
    expect(openVoteEntries(electionSecret, ballot.electionKey, 'other-ballot', opened.payload).every(v => !v.ok)).to.equal(true)
  })

  const refusal = (block: FormedPoolBlock, who = voters[0]!.contribution) => checkFormedPoolBlock(block, who, ballot)

  it('a member refuses a block missing, altering or duplicating its vote', () => {
    const block = formPoolBlock(contributions, ballot)
    const withoutMine = formPoolBlock(contributions.slice(1), ballot)
    expect(refusal(withoutMine)).to.deep.equal({ ok: false, reason: 'my vote is missing or altered' })
    // The former swaps member 0's vote for another ciphertext and re-forms honestly around it.
    const swapped = formPoolBlock([{ ...contributions[0]!, voteCiphertext: encryptVoteEntry(ballot.electionKey, ballot.ballotId, '{"forged":true}') }, ...contributions.slice(1)], ballot)
    expect(refusal(swapped)).to.deep.equal({ ok: false, reason: 'my vote is missing or altered' })
    expect(refusal({ ...block, registrantIds: block.registrantIds.slice(1) }).ok).to.equal(false)
  })

  it('a member refuses a block whose ciphertext, id, cid, order or template does not match', () => {
    const block = formPoolBlock(contributions, ballot)
    const other = formPoolBlock(contributions, ballot)
    expect(refusal({ ...block, ciphertext: other.ciphertext })).to.deep.equal({ ok: false, reason: 'the ciphertext does not encrypt the shown payload' })
    expect(refusal({ ...block, blockId: 'x' + block.blockId.slice(1) }).ok).to.equal(false)
    expect(refusal({ ...block, cid: other.cid })).to.deep.equal({ ok: false, reason: 'the cid does not match the ciphertext' })
    expect(refusal({ ...block, payload: { ...block.payload, votes: [...block.payload.votes].reverse() } })).to.deep.equal({ ok: false, reason: 'the entries are not in canonical order' })
    expect(refusal({ ...block, templateDigest: 'other' })).to.deep.equal({ ok: false, reason: 'the block names another ballot template' })
  })

  it('the TS block id, cid and consent digest equal the SQL the schema checks', async () => {
    const db = new Database()
    await registerDbPlugins(db)
    const block = formPoolBlock(contributions, ballot)
    const json = JSON.stringify({ v: block.payload.v, votes: block.payload.votes, voterRecords: block.payload.voterRecords })
    const sqlId = (await db.prepare("select Digest('VoteBlockRecords', :p) as v").get({ p: json }))?.v
    const sqlCid = (await db.prepare('select cid(Digest(:ct)) as v').get({ ct: block.ciphertext }))?.v
    const reg = contributions[0]!.voterEntry
    const sqlConsent = (await db.prepare("select Digest('VoteBlockVoter', :e, :r, :b, :c, :i, :reg, :dk) as v").get({
      e: ballot.electionKey.electionId, r: ballot.electionKey.revision, b: ballot.ballotId, c: block.cid, i: block.blockId, reg: reg.registrantId, dk: reg.deviceKey
    }))?.v
    expect(poolBlockId(block.payload)).to.equal(sqlId)
    expect(poolBlockCid(block.ciphertext)).to.equal(sqlCid)
    expect(consentDigest(block, ballot, reg.registrantId, reg.deviceKey)).to.equal(sqlConsent)
  })
})

describe('pool (spike 102): rendezvous', () => {
  it('lists other coordinators, holds a poll until mail arrives, and drains only the caller\'s own mailbox', async () => {
    const rv = new PoolRendezvous()
    const [a, b, c] = [createPoolIdentity(), createPoolIdentity(), createPoolIdentity()]
    const now = () => Date.now()
    expect(await rv.handle('t', poolRequests.present(a, 'topic', 2, now()))).to.deep.equal({ t: 'coordinators', list: [] })
    expect(await rv.handle('t', poolRequests.present(b, 'topic', 1, now()))).to.deep.equal({ t: 'coordinators', list: [{ peerId: a.peerId, size: 2 }] })
    const held = rv.handle('t', poolRequests.poll(b, 2000, now()))
    const env = sealPoolEnvelope(a, b.peerId, { hi: 1 })
    expect(await rv.handle('t', poolRequests.send(env))).to.deep.equal({ t: 'ok' })
    expect(await held).to.deep.equal({ t: 'envelopes', list: [env] })
    await rv.handle('t', poolRequests.send(env))
    expect(await rv.handle('t', poolRequests.poll(c, 0, now()))).to.deep.equal({ t: 'envelopes', list: [] })
    expect(await rv.handle('t', poolRequests.poll(b, 0, now()))).to.deep.equal({ t: 'envelopes', list: [env] })
    await rv.handle('t', poolRequests.withdraw(a, 'topic', now()))
    expect(await rv.handle('t', poolRequests.present(c, 'topic', 1, now()))).to.deep.equal({ t: 'coordinators', list: [{ peerId: b.peerId, size: 1 }] })
    rv.close()
  })

  it('only the holder of a pool identity can present as it or drain its mailbox', async () => {
    const rv = new PoolRendezvous()
    const [a, b] = [createPoolIdentity(), createPoolIdentity()]
    await rv.handle('t', poolRequests.send(sealPoolEnvelope(a, b.peerId, { secret: true })))
    // b's request re-labelled as a: the signature no longer matches
    const forgedPoll = { ...poolRequests.poll(b, 0, Date.now()), as: a.peerId }
    expect(await rv.handle('t', forgedPoll)).to.deep.equal({ t: 'error', reason: 'bad signature' })
    const forgedPresent = { ...poolRequests.present(a, 'topic', 1, Date.now()), size: 9 }
    expect(await rv.handle('t', forgedPresent)).to.deep.equal({ t: 'error', reason: 'bad signature' })
    // a stale but correctly signed request
    expect(await rv.handle('t', poolRequests.poll(b, 0, Date.now() - 5 * 60_000))).to.deep.equal({ t: 'error', reason: 'bad signature' })
    expect(rv.stats.badSignature).to.equal(3)
    expect((await rv.handle('t', poolRequests.poll(b, 0, Date.now()))) as { list: unknown[] }).to.have.property('list').with.length(1)
  })

  it('refuses a transport peer the admission check refuses, a malformed envelope and an oversized one', async () => {
    const rv = new PoolRendezvous({ isAllowed: (p) => p !== 'stranger', maxEnvelopeChars: 200 })
    const a = createPoolIdentity()
    expect(await rv.handle('stranger', poolRequests.present(a, 'topic', 1, Date.now()))).to.deep.equal({ t: 'error', reason: 'not allowed' })
    expect(await rv.handle('member', { t: 'send', envelope: { v: 1, to: '', eph: '', nonce: '', ct: '' } })).to.deep.equal({ t: 'error', reason: 'bad envelope' })
    expect(await rv.handle('member', { t: 'send', envelope: { v: 1, to: 'b', eph: '', nonce: '', ct: 'x'.repeat(300) } })).to.deep.equal({ t: 'error', reason: 'envelope too large' })
  })
})

describe('pool (spike 102): agents negotiate through the rendezvous', function () {
  this.timeout(30_000)

  interface Run { outcomes: PoolOutcome[], commits: Array<{ block: FormedPoolBlock, signatures: ConsentSignature[] }>, rendezvous: PoolRendezvous }

  async function runAgents (voters: TestVoter[], opts: {
    deadlineMs?: number
    abortWhenMember?: number
    badSigner?: number
    quietMs?: number
  } = {}): Promise<Run> {
    const rendezvous = new PoolRendezvous()
    const commits: Run['commits'] = []
    const committedRegistrants = new Set<string>()
    const deadlineAt = Date.now() + (opts.deadlineMs ?? 20_000)
    const outcomes = await Promise.all(voters.map(async (v, i) => {
      const controller = new AbortController()
      const agent = new PoolAgent({
        identity: v.identity,
        rendezvous: createInMemoryRendezvousClient(rendezvous, `transport-${i}`),
        ballot,
        contribution: v.contribution,
        signConsent: async (digest) => (opts.badSigner === i ? 'aa'.repeat(64) : signDigestP256(digest, v.priv)),
        commit: async (block, signatures) => {
          if (signatures.some(s => committedRegistrants.has(s.registrantId))) return { ok: false, reason: 'a voter already voted' }
          for (const s of signatures) committedRegistrants.add(s.registrantId)
          commits.push({ block, signatures })
          return { ok: true }
        },
        findRecordedVote: async () => commits.find(c => c.signatures.some(s => s.registrantId === v.contribution.voterEntry.registrantId))?.block.cid ?? null,
        quietMs: opts.quietMs ?? 400,
        presentIntervalMs: 60,
        replyTimeoutMs: 400,
        informAttempts: 2,
        signTimeoutMs: 1_500,
        memberTimeoutMs: 3_000,
        pollWaitMs: 200,
        formLeadMs: 0,
        deadlineAt,
        onStatus: (s) => { if (opts.abortWhenMember === i && s.phase === 'member') controller.abort() }
      })
      return await agent.run(controller.signal)
    }))
    rendezvous.close()
    return { outcomes, commits, rendezvous }
  }

  it('five voters converge on ONE block of five; every signature verifies; each learns the cid', async () => {
    const voters = [0, 1, 2, 3, 4].map(makeVoter)
    const run = await runAgents(voters)
    expect(run.commits.map(c => c.block.registrantIds.length)).to.deep.equal([5])
    const cid = run.commits[0]!.block.cid
    expect(run.outcomes.map(o => o.status)).to.deep.equal(Array(5).fill('committed'))
    expect(run.outcomes.every(o => o.status === 'committed' && o.cid === cid)).to.equal(true)
    expect(run.outcomes.filter(o => o.status === 'committed' && o.formedByMe)).to.have.length(1)
  })

  it('two voters alone never form a block (minimum 3): both stop at the deadline with nothing committed', async () => {
    const run = await runAgents([0, 1].map(makeVoter), { deadlineMs: 2_000 })
    expect(run.commits).to.deep.equal([])
    expect(run.outcomes).to.deep.equal([{ status: 'stopped', reason: 'deadline' }, { status: 'stopped', reason: 'deadline' }])
  })

  it('a member that goes silent after merging is dropped after retries; the other four still commit', async () => {
    const voters = [0, 1, 2, 3, 4].map(makeVoter)
    // the agent with the highest peer id always merges away (it loses every tie), so it is a member
    const silent = voters.reduce((m, v, i) => (v.identity.peerId > voters[m]!.identity.peerId ? i : m), 0)
    const run = await runAgents(voters, { abortWhenMember: silent })
    const silentId = voters[silent]!.contribution.voterEntry.registrantId
    expect(run.commits).to.have.length(1)
    expect(run.commits[0]!.block.registrantIds).to.have.length(4)
    expect(run.commits[0]!.block.registrantIds).to.not.include(silentId)
    expect(run.outcomes[silent]).to.deep.equal({ status: 'stopped', reason: 'aborted' })
  })

  it('a member whose signature does not verify is dropped at formation; the rest commit', async () => {
    const voters = [0, 1, 2, 3, 4].map(makeVoter)
    const bad = voters.reduce((m, v, i) => (v.identity.peerId > voters[m]!.identity.peerId ? i : m), 0)
    const run = await runAgents(voters, { badSigner: bad, deadlineMs: 8_000 })
    const committed = run.commits.flatMap(c => c.block.registrantIds)
    expect(committed).to.not.include(voters[bad]!.contribution.voterEntry.registrantId)
    expect(committed).to.have.length(4)
  })

  it('one transport peer can run several pools at once (one per ballot) with separate pool identities', async () => {
    // three phones, two ballots each: six agents, three transport peers
    const rendezvous = new PoolRendezvous()
    const phones = [0, 1, 2]
    const ballots: PoolBallot[] = ['b-x', 'b-y'].map(id => ({ ...ballot, ballotId: id }))
    const commits: string[] = []
    const outcomes = await Promise.all(phones.flatMap(p => ballots.map(async (bal) => {
      const v = makeVoter(p)
      const identity = createPoolIdentity()
      const agent = new PoolAgent({
        identity, rendezvous: createInMemoryRendezvousClient(rendezvous, `phone-${p}`), ballot: bal,
        contribution: { member: identity.peerId, voteCiphertext: encryptVoteEntry(bal.electionKey, bal.ballotId, v.voteJson), voterEntry: v.contribution.voterEntry },
        signConsent: async (digest) => signDigestP256(digest, v.priv),
        commit: async (block) => { commits.push(`${bal.ballotId}:${block.registrantIds.length}`); return { ok: true } },
        quietMs: 300, presentIntervalMs: 50, replyTimeoutMs: 400, informAttempts: 2, signTimeoutMs: 1_500, pollWaitMs: 200, formLeadMs: 0, deadlineAt: Date.now() + 15_000
      })
      return await agent.run()
    })))
    rendezvous.close()
    expect(commits.sort()).to.deep.equal(['b-x:3', 'b-y:3'])
    expect(outcomes.every(o => o.status === 'committed')).to.equal(true)
  })

  it('the rendezvous only ever handled sealed envelopes', async () => {
    const voters = [0, 1, 2].map(makeVoter)
    const run = await runAgents(voters)
    expect(run.commits).to.have.length(1)
    expect(run.rendezvous.stats.send).to.be.greaterThan(0)
  })
})
