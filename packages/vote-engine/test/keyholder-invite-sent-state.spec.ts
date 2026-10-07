/**
 * keyholder-invite-sent-state.spec.ts - phase 62 plan 76 (D-14, D-16, D-27).
 *
 * The election engine's keyholder projection reports, per invitee, whether a keyholder invitation
 * slot was sent and whether it is still live, answered, or no longer valid, using the one shared
 * invite-chain rule (readInviteChain). Real-DB cases S1-S6, then mock parity M1-M3.
 *
 * 62-84 (CR-01, WR-04, gap 7): S7-S7c rank every chain of a name (answered > live > unknown >
 * no-longer-valid, ties on the latest expiration) and are seeded in BOTH InviteSlot Cid orders with
 * the order asserted; S8 carries an ambiguous chain as 'unknown'; S9 degrades an unreadable slot table
 * to 'unknown' without failing the election read; M4 is mock parity for repeated sends.
 *
 * 62 CR-01: S10 - a decline (InviteResult IsAccepted false, no Keyholder row) reads 'declined', never
 * 'answered' (which the label shows as Sent); a newer live resend outranks it in BOTH Cid orders; a
 * decline outranks a dead chain. M5 is the mock parity for a decline (sent 'declined', no result).
 *
 * Fixtures are built only through real engine paths: createElection with invitees, inviteKeyholder,
 * InvitationEngine.respondToInvite, AuthorityEngine.cancelInvite/resendInvite. The one raw write is
 * an already-expired 'k' slot (the engine refuses to send an expired one), inserted under a past
 * context now the way fixtures/invite-chain.ts insertExpiredSlot does for 'of'.
 */

import { expect } from 'chai'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex } from '@noble/curves/utils.js'
import type { KeyholderInvite, Signature } from '@votetorrent/vote-core'
import { InvitationEngine } from '../src/invite/invitation-engine.js'
import { ElectionsEngine, peekNextElectionTid } from '../src/elections/elections-engine.js'
import { allocateTid } from '../src/database/tid-allocator.js'
import { toCanonicalDatetime } from '../src/utils.js'
import type { AuthorityEngine } from '../src/authority/authority-engine.js'
import { MockElectionEngine } from '../src/election/mock-election-engine.js'
import {
  createTestNetwork,
  addTestAuthority,
  makeTestSignCallback,
  makeElectionInit,
} from './fixtures/test-context.js'
import { makeKeyholderProvisioning } from './fixtures/keyholder-provisioning.js'

function freshInviteKey (): string {
  return bytesToHex(secp256k1.getPublicKey(secp256k1.utils.randomSecretKey()))
}

function futureIso (ms = 3_600_000): string {
  return new Date(Date.now() + ms).toISOString()
}

function makeInvite (name: string, expiration = futureIso()): KeyholderInvite {
  // Empty inviteSignature hits the documented send-side carve-out (same as keyholder-identity.spec.ts).
  return { name, type: 'k', expiration, inviteKey: freshInviteKey(), inviteSignature: '' }
}

function makePendingInvitee (name: string): KeyholderInvite {
  return { name, type: 'k', expiration: '0', inviteKey: '', inviteSignature: '' }
}

type SeedRevisionSeam = {
  seedElectionRevisionSigning(
    electionId: string,
    authorityId: string,
    revision: {
      revision: number
      revisionTimestamp: number
      tags: string[]
      instructions: string
      timeline: Record<string, number>
      keyholderThreshold: number
    },
    tid: number,
    sign: (digest: Uint8Array) => Promise<Signature>,
  ): Promise<string>
}

async function createElectionWithInvitees (invitees: string[]) {
  const net = await createTestNetwork()
  const auth = await addTestAuthority(net)
  const electionsEngine = new ElectionsEngine(auth.ctx)

  const init = makeElectionInit({ authorityId: auth.authority.id })
  init.revision.keyholders = invitees.map(makePendingInvitee)
  const { election: e } = init
  const pastRevTimestamp = Date.now() - 1000

  const sign = makeTestSignCallback(auth.user)
  const signingNonce = await electionsEngine.seedElectionSigning({
    id: e.id,
    authorityId: e.authorityId,
    title: e.title,
    date: e.date,
    revisionDeadline: e.revisionDeadline,
    ballotDeadline: e.ballotDeadline,
    type: e.type,
  }, sign)

  const revTid = (await peekNextElectionTid(auth.ctx.db)) + 1
  const revisionSigningNonce = await (electionsEngine as unknown as SeedRevisionSeam).seedElectionRevisionSigning(
    e.id,
    e.authorityId,
    {
      revision: 0,
      revisionTimestamp: pastRevTimestamp,
      tags: init.revision.tags,
      instructions: init.revision.instructions,
      timeline: init.revision.timeline as Record<string, number>,
      keyholderThreshold: init.revision.keyholderThreshold,
    },
    revTid,
    sign
  )

  await electionsEngine.createElection(
    { ...init, revision: { ...init.revision, revisionTimestamp: pastRevTimestamp } },
    { signingNonce, revisionSigningNonce }
  )
  const electionEngine = await electionsEngine.openElection(e.id)
  return { auth, electionEngine, electionId: e.id }
}

type Fixture = Awaited<ReturnType<typeof createElectionWithInvitees>>

async function send (fx: Fixture, invite: KeyholderInvite): Promise<string> {
  await fx.electionEngine.inviteKeyholder(invite, fx.electionId, makeTestSignCallback(fx.auth.user))
  const row = await fx.auth.ctx.db
    .prepare('select Cid from InviteSlot where InviteKey = :inviteKey and Type = :slotType')
    .get({ inviteKey: invite.inviteKey, slotType: 'k' })
  return row!.Cid as string
}

async function projection (fx: Fixture) {
  return (await fx.electionEngine.getElectionDetails()).current.keyholders
}

describe('keyholder invite sent state (62-76)', () => {
  it('S1: a sent invitee is live, a never-invited invitee has no sent field, neither has a result', async () => {
    const fx = await createElectionWithInvitees(['Kay', 'Lee'])
    const kay = makeInvite('Kay')
    const cid = await send(fx, kay)
    // The schema canonicalises the stored Expiration (drops the trailing Z); the projection reports the stored value.
    const stored = await fx.auth.ctx.db.prepare('select Expiration from InviteSlot where Cid = :cid').get({ cid })
    const kh = await projection(fx)
    expect(kh).to.have.length(2)
    expect(kh[0]!.invite.name).to.equal('Kay')
    expect(kh[0]!.sent).to.deep.equal({ state: 'live', expiration: String(stored!.Expiration) })
    expect(kh[0]!.result).to.equal(undefined)
    expect(kh[1]!.invite.name).to.equal('Lee')
    expect(kh[1]!.sent).to.equal(undefined)
    expect(kh[1]!.result).to.equal(undefined)
  })

  it('S2: an accepted keyholder keeps result.isAccepted true and reports sent answered', async () => {
    const fx = await createElectionWithInvitees(['Kay', 'Lee'])
    const cid = await send(fx, makeInvite('Kay'))
    await new InvitationEngine(fx.auth.ctx).respondToInvite(cid, true, undefined, undefined, undefined, makeKeyholderProvisioning())
    const kh = await projection(fx)
    expect(kh[0]!.result?.isAccepted).to.equal(true)
    expect(kh[0]!.sent?.state).to.equal('answered')
    expect(kh[1]!.sent).to.equal(undefined)
  })

  it('S3: a cancelled invitation is no-longer-valid', async () => {
    const fx = await createElectionWithInvitees(['Kay', 'Lee'])
    const cid = await send(fx, makeInvite('Kay'))
    await (fx.auth.authorityEngine as unknown as AuthorityEngine).cancelInvite(cid)
    const kh = await projection(fx)
    expect(kh[0]!.sent?.state).to.equal('no-longer-valid')
    expect(kh[0]!.result).to.equal(undefined)
  })

  it('S4: an expired invitation is no-longer-valid', async () => {
    const fx = await createElectionWithInvitees(['Kay', 'Lee'])
    const db = fx.auth.ctx.db
    const invite = makeInvite('Kay', '2000-01-02T00:00:00')
    const nonce = bytesToHex(secp256k1.utils.randomSecretKey())
    const cidRow = await db
      .prepare('select cid(Digest(:electionId, :expiration, :inviteKey, :inviteSignature, :name, :nonce, :type)) as c')
      .get({ electionId: fx.electionId, expiration: invite.expiration, inviteKey: invite.inviteKey, inviteSignature: invite.inviteSignature, name: invite.name, nonce, type: 'k' })
    const tid = await allocateTid(db, 'election')
    await db.exec(
      `insert into InviteSlot (Cid, Type, Name, Expiration, InviteKey, InviteSignature, SigningNonce, ElectionId)
        with context Tid = ${tid}, now = '2000-01-01T00:00:00', IsSignatureValid = true, IsInsertValid = true
        values (:cid, 'k', :name, :expiration, :inviteKey, :inviteSignature, :nonce, :electionId)`,
      { cid: cidRow!.c as string, name: invite.name, expiration: invite.expiration, inviteKey: invite.inviteKey, inviteSignature: invite.inviteSignature, nonce, electionId: fx.electionId }
    )
    const kh = await projection(fx)
    expect(kh[0]!.sent?.state).to.equal('no-longer-valid')
    expect(kh[1]!.sent).to.equal(undefined)
  })

  it('S5: a resent invitation yields exactly one sent entry, live (the head decides)', async () => {
    const fx = await createElectionWithInvitees(['Kay', 'Lee'])
    const cid = await send(fx, makeInvite('Kay'))
    await (fx.auth.authorityEngine as unknown as AuthorityEngine).cancelInvite(cid)
    expect((await projection(fx))[0]!.sent?.state).to.equal('no-longer-valid')
    await (fx.auth.authorityEngine as unknown as AuthorityEngine).resendInvite(cid)
    const kh = await projection(fx)
    expect(kh).to.have.length(2)
    expect(kh[0]!.sent?.state).to.equal('live')
    expect(kh[1]!.sent).to.equal(undefined)
  })

  it('S6: two invitees with the same Name and one slot - the first absorbs it, no duplicate, no crash', async () => {
    const fx = await createElectionWithInvitees(['Twin', 'Twin'])
    await send(fx, makeInvite('Twin'))
    const kh = await projection(fx)
    expect(kh).to.have.length(2)
    expect(kh[0]!.sent?.state).to.equal('live')
    expect(kh[1]!.sent).to.equal(undefined)
  })
})

/** A canonical (no Z) future expiration, so a precomputed Cid uses exactly the stored value. */
function futureCanonical (ms = 3_600_000): string {
  return toCanonicalDatetime(new Date(Date.now() + ms))
}

async function storedExpiration (fx: Fixture, cid: string): Promise<string> {
  const row = await fx.auth.ctx.db.prepare('select Expiration from InviteSlot where Cid = :cid').get({ cid })
  return String(row!.Expiration)
}

/**
 * Raw 'k' slot insert (the S4 technique, generalised): an already-expired slot is written under a past
 * context now; any other row (e.g. a second original under an existing InviteKey) under the current now.
 */
async function insertRawKSlot (
  fx: Fixture,
  opts: { name: string, inviteKey?: string, expiration: string, contextNow?: string },
): Promise<string> {
  const db = fx.auth.ctx.db
  const inviteKey = opts.inviteKey ?? freshInviteKey()
  const nonce = bytesToHex(secp256k1.utils.randomSecretKey())
  const cidRow = await db
    .prepare('select cid(Digest(:electionId, :expiration, :inviteKey, :inviteSignature, :name, :nonce, :type)) as c')
    .get({ electionId: fx.electionId, expiration: opts.expiration, inviteKey, inviteSignature: '', name: opts.name, nonce, type: 'k' })
  const tid = await allocateTid(db, 'election')
  await db.exec(
    `insert into InviteSlot (Cid, Type, Name, Expiration, InviteKey, InviteSignature, SigningNonce, ElectionId)
      with context Tid = ${tid}, now = :now, IsSignatureValid = true, IsInsertValid = true
      values (:cid, 'k', :name, :expiration, :inviteKey, :inviteSignature, :nonce, :electionId)`,
    { cid: cidRow!.c as string, name: opts.name, expiration: opts.expiration, inviteKey, inviteSignature: '', nonce, electionId: fx.electionId, now: opts.contextNow ?? toCanonicalDatetime(new Date()) }
  )
  return cidRow!.c as string
}

async function insertExpiredKSlot (fx: Fixture, name: string, expiration = '2000-01-02T00:00:00'): Promise<string> {
  return insertRawKSlot(fx, { name, expiration, contextNow: '2000-01-01T00:00:00' })
}

type NonceSeam = { signingEngine: { generateSigningNonce(): string } }

/**
 * Send a live invite for `name` through the real inviteKeyholder whose InviteSlot Cid sorts on the wanted
 * side of `otherCid`. The engine mints a random signing nonce, so the nonce is pinned for this one send
 * (an own property on the engine's signing engine, removed afterwards) and the Cid is predicted with the
 * same Digest expression; the InviteKey is regenerated until the order holds (bounded at 64 tries). The
 * ACTUAL stored Cid is returned and the caller asserts the order on it.
 */
async function sendOrdered (fx: Fixture, name: string, otherCid: string, wantOtherFirst: boolean): Promise<{ cid: string, invite: KeyholderInvite }> {
  const expiration = futureCanonical()
  for (let attempt = 0; attempt < 64; attempt++) {
    const invite = makeInvite(name, expiration)
    const nonce = crypto.randomUUID()
    const predicted = await fx.auth.ctx.db
      .prepare('select cid(Digest(:electionId, :expiration, :inviteKey, :inviteSignature, :name, :nonce, :type)) as c')
      .get({ electionId: fx.electionId, expiration, inviteKey: invite.inviteKey, inviteSignature: '', name, nonce, type: 'k' })
    const cid = predicted!.c as string
    if ((otherCid < cid) !== wantOtherFirst) continue
    const signing = (fx.electionEngine as unknown as NonceSeam).signingEngine
    signing.generateSigningNonce = () => nonce
    try {
      const actual = await send(fx, invite)
      expect(actual).to.equal(cid)
      return { cid: actual, invite }
    } finally {
      delete (signing as Partial<NonceSeam['signingEngine']>).generateSigningNonce
    }
  }
  throw new Error('sendOrdered: no InviteKey produced the wanted Cid order in 64 tries')
}

const BOTH_ORDERS: Array<{ label: string, otherFirst: boolean }> = [
  { label: 'Cid(A) < Cid(B)', otherFirst: true },
  { label: 'Cid(A) > Cid(B)', otherFirst: false },
]

describe('keyholder invite sent state - every chain of a name is ranked (62-84)', () => {
  for (const order of BOTH_ORDERS) {
    it('S7: expired chain A then a live resend chain B reads live with B\'s expiration (' + order.label + ')', async () => {
      const fx = await createElectionWithInvitees(['Kay', 'Lee'])
      const cidA = await insertExpiredKSlot(fx, 'Kay')
      const b = await sendOrdered(fx, 'Kay', cidA, order.otherFirst)
      expect(cidA < b.cid).to.equal(order.otherFirst)
      const kh = await projection(fx)
      expect(kh).to.have.length(2)
      expect(kh[0]!.sent).to.deep.equal({ state: 'live', expiration: await storedExpiration(fx, b.cid) })
      expect(kh[1]!.sent).to.equal(undefined)
    })

    it('S7: cancelled chain A then a live resend chain B reads live with B\'s expiration (' + order.label + ')', async () => {
      const fx = await createElectionWithInvitees(['Kay', 'Lee'])
      const cidA = await send(fx, makeInvite('Kay'))
      await (fx.auth.authorityEngine as unknown as AuthorityEngine).cancelInvite(cidA)
      const b = await sendOrdered(fx, 'Kay', cidA, order.otherFirst)
      expect(cidA < b.cid).to.equal(order.otherFirst)
      const kh = await projection(fx)
      expect(kh[0]!.sent).to.deep.equal({ state: 'live', expiration: await storedExpiration(fx, b.cid) })
      expect(kh[1]!.sent).to.equal(undefined)
    })

    it('S7b: an answered chain A outranks a live chain B (' + order.label + ')', async () => {
      const fx = await createElectionWithInvitees(['Kay', 'Lee'])
      const cidA = await send(fx, makeInvite('Kay'))
      await new InvitationEngine(fx.auth.ctx).respondToInvite(cidA, true, undefined, undefined, undefined, makeKeyholderProvisioning())
      const b = await sendOrdered(fx, 'Kay', cidA, order.otherFirst)
      expect(cidA < b.cid).to.equal(order.otherFirst)
      const kh = await projection(fx)
      expect(kh[0]!.sent?.state).to.equal('answered')
      expect(kh[0]!.result?.isAccepted).to.equal(true)
    })
  }

  it('S7c: two same-name invitees and three chains (one live, two expired) - live first, then no-longer-valid, no duplicate', async () => {
    const fx = await createElectionWithInvitees(['Kay', 'Kay'])
    await insertExpiredKSlot(fx, 'Kay', '2000-01-02T00:00:00')
    const liveCid = await send(fx, makeInvite('Kay', futureCanonical()))
    await insertExpiredKSlot(fx, 'Kay', '2000-01-03T00:00:00')
    const kh = await projection(fx)
    expect(kh).to.have.length(2)
    expect(kh[0]!.sent).to.deep.equal({ state: 'live', expiration: await storedExpiration(fx, liveCid) })
    // Ties inside a rank break on the latest expiration: the later of the two dead chains is handed out.
    expect(kh[1]!.sent).to.deep.equal({ state: 'no-longer-valid', expiration: '2000-01-03T00:00:00' })
  })
})

describe('keyholder invite sent state - a decline reads declined, and a newer live resend wins (62 CR-01)', () => {
  /** Kay declines through the real path: respondToInvite(accept=false) writes InviteResult(IsAccepted=false) and no Keyholder row. */
  async function decline (fx: Fixture, cid: string): Promise<void> {
    await new InvitationEngine(fx.auth.ctx).respondToInvite(cid, false)
  }

  it('S10: a declined chain alone reads declined (never answered, so the label cannot read Sent)', async () => {
    const fx = await createElectionWithInvitees(['Kay', 'Lee'])
    const cidA = await send(fx, makeInvite('Kay'))
    await decline(fx, cidA)
    const kh = await projection(fx)
    expect(kh).to.have.length(2)
    expect(kh[0]!.sent).to.deep.equal({ state: 'declined', expiration: await storedExpiration(fx, cidA) })
    // A decline writes no Keyholder row, so the projection carries no result: `sent` is the only carrier.
    expect(kh[0]!.result).to.equal(undefined)
    expect(kh[1]!.sent).to.equal(undefined)
  })

  for (const order of BOTH_ORDERS) {
    it('S10: declined chain A then a live resend chain B reads live with B\'s expiration (' + order.label + ')', async () => {
      const fx = await createElectionWithInvitees(['Kay', 'Lee'])
      const cidA = await send(fx, makeInvite('Kay'))
      await decline(fx, cidA)
      expect((await projection(fx))[0]!.sent?.state).to.equal('declined')
      const b = await sendOrdered(fx, 'Kay', cidA, order.otherFirst)
      expect(cidA < b.cid).to.equal(order.otherFirst)
      const kh = await projection(fx)
      expect(kh[0]!.sent).to.deep.equal({ state: 'live', expiration: await storedExpiration(fx, b.cid) })
      expect(kh[0]!.result).to.equal(undefined)
      expect(kh[1]!.sent).to.equal(undefined)
    })
  }

  it('S10: a decline outranks a dead chain of the same name (the officer is told "declined", not "no longer valid")', async () => {
    const fx = await createElectionWithInvitees(['Kay', 'Lee'])
    const cidA = await send(fx, makeInvite('Kay'))
    await decline(fx, cidA)
    await insertExpiredKSlot(fx, 'Kay')
    const kh = await projection(fx)
    expect(kh[0]!.sent).to.deep.equal({ state: 'declined', expiration: await storedExpiration(fx, cidA) })
  })
})

describe('keyholder invite sent state - ambiguous chains are carried, not dropped (62-84)', () => {
  /** Two originals (two signing nonces) under one InviteKey: readInviteChain reports 'ambiguous'. */
  async function ambiguousChain (fx: Fixture): Promise<{ inviteKey: string, latest: string }> {
    const invite = makeInvite('Kay', futureCanonical(3_600_000))
    const cid = await send(fx, invite)
    const second = futureCanonical(7_200_000)
    await insertRawKSlot(fx, { name: 'Kay', inviteKey: invite.inviteKey, expiration: second })
    const first = await storedExpiration(fx, cid)
    return { inviteKey: invite.inviteKey, latest: first > second ? first : second }
  }

  it('S8: an ambiguous chain reports sent unknown (never omitted, so the label cannot read Not sent)', async () => {
    const fx = await createElectionWithInvitees(['Kay', 'Lee'])
    const { latest } = await ambiguousChain(fx)
    const kh = await projection(fx)
    expect(kh[0]!.sent).to.deep.equal({ state: 'unknown', expiration: latest })
    expect(kh[0]!.result).to.equal(undefined)
    expect(kh[1]!.sent).to.equal(undefined)
  })

  it('S8: a live chain outranks an ambiguous one for the same name', async () => {
    const fx = await createElectionWithInvitees(['Kay', 'Lee'])
    await ambiguousChain(fx)
    const liveCid = await send(fx, makeInvite('Kay', futureCanonical(1_800_000)))
    const kh = await projection(fx)
    expect(kh[0]!.sent).to.deep.equal({ state: 'live', expiration: await storedExpiration(fx, liveCid) })
  })

  it('S8: an ambiguous chain outranks a no-longer-valid one for the same name', async () => {
    const fx = await createElectionWithInvitees(['Kay', 'Lee'])
    const { latest } = await ambiguousChain(fx)
    await insertExpiredKSlot(fx, 'Kay')
    const kh = await projection(fx)
    expect(kh[0]!.sent).to.deep.equal({ state: 'unknown', expiration: latest })
  })
})

describe('keyholder invite sent state - an unreadable invitation table degrades (62-84)', () => {
  const SLOT_READ = /from InviteSlot where ElectionId = :electionId/

  type EvalFn = Fixture['auth']['ctx']['db']['eval']

  /** Replace ONLY the projection's InviteSlot select with one that throws `err`; restore afterwards. */
  async function withFailingSlotRead<T> (fx: Fixture, err: unknown, body: () => Promise<T>): Promise<T> {
    const db = fx.auth.ctx.db
    const original = db.eval
    const stub = function (this: typeof db, sql: string, ...rest: unknown[]) {
      if (SLOT_READ.test(sql)) {
        return (async function * () { throw err })()
      }
      return (original as (...a: unknown[]) => unknown).call(this, sql, ...rest)
    }
    db.eval = stub as unknown as EvalFn
    try {
      return await body()
    } finally {
      db.eval = original
    }
  }

  function peerUnavailable (): Error {
    const e = new Error('Block default/app/InviteSlot is unavailable (cohort-unreachable): the repo could not determine whether it exists')
    e.name = 'BlockUnavailableError'
    return e
  }

  it('S9: a BlockUnavailableError on the slot read still returns the election; every keyholder reads unknown', async () => {
    const fx = await createElectionWithInvitees(['Kay', 'Lee'])
    const cid = await send(fx, makeInvite('Kay'))
    await new InvitationEngine(fx.auth.ctx).respondToInvite(cid, true, undefined, undefined, undefined, makeKeyholderProvisioning())
    const details = await withFailingSlotRead(fx, peerUnavailable(), () => fx.electionEngine.getElectionDetails())
    const kh = details.current.keyholders
    expect(details.election.id).to.equal(fx.electionId)
    expect(kh).to.have.length(2)
    for (const k of kh) expect(k.sent).to.deep.equal({ state: 'unknown', expiration: '' })
    expect(kh[0]!.result?.isAccepted).to.equal(true)
    // The stub is gone: the next read sees the real tables again.
    expect((await projection(fx))[0]!.sent?.state).to.equal('answered')
  })

  it('S9: a peer-unavailable error wrapped as a cause, or a possibly-stale block, also degrades', async () => {
    const fx = await createElectionWithInvitees(['Kay', 'Lee'])
    await send(fx, makeInvite('Kay'))
    const wrapped = new Error('vtab read failed', { cause: new Error('outer', { cause: peerUnavailable() }) })
    const stale = Object.assign(new Error('Block default/app/InviteSlot may be stale: no peer confirmed the latest revision'), { name: 'BlockPossiblyStaleError' })
    for (const err of [wrapped, stale]) {
      const kh = (await withFailingSlotRead(fx, err, () => fx.electionEngine.getElectionDetails())).current.keyholders
      for (const k of kh) expect(k.sent?.state).to.equal('unknown')
    }
  })

  it('S9: any other error from the same read still rejects getElectionDetails (not masked)', async () => {
    const fx = await createElectionWithInvitees(['Kay', 'Lee'])
    let caught: unknown
    try {
      await withFailingSlotRead(fx, new Error('boom'), () => fx.electionEngine.getElectionDetails())
    } catch (err) {
      caught = err
    }
    expect(caught).to.be.instanceOf(Error)
    expect(String((caught as Error).message)).to.contain('boom')
  })
})

describe('keyholder invite sent state - mock parity (62-76)', () => {
  async function mockKeyholders (m: MockElectionEngine) {
    return (await m.getElectionDetails()).current.keyholders
  }

  it('M1: mock inviteKeyholder for a seeded invitee yields sent live with the invite expiration', async () => {
    const m = new MockElectionEngine()
    const exp = futureIso()
    await m.inviteKeyholder({ ...makeInvite('Dr. Sarah Chen', exp) }, 'election-2', async () => { throw new Error('unused') })
    const kh = await mockKeyholders(m)
    const sarah = kh.find(k => k.invite.name === 'Dr. Sarah Chen')!
    expect(sarah.sent).to.deep.equal({ state: 'live', expiration: exp })
    expect(sarah.result).to.equal(undefined)
  })

  it('M2: an accepted mock keyholder reports answered; a past-expiration invite reports no-longer-valid', async () => {
    const m = new MockElectionEngine()
    await m.inviteKeyholder(makeInvite('Prof. James Wilson'), 'election-2', async () => { throw new Error('unused') })
    await m.inviteKeyholder(makeInvite('Dr. Sarah Chen', '2000-01-02T00:00:00'), 'election-2', async () => { throw new Error('unused') })
    const kh = await mockKeyholders(m)
    expect(kh.find(k => k.invite.name === 'Prof. James Wilson')!.sent?.state).to.equal('answered')
    expect(kh.find(k => k.invite.name === 'Dr. Sarah Chen')!.sent?.state).to.equal('no-longer-valid')
  })

  it('M3: a never-invited mock invitee has no sent field', async () => {
    const m = new MockElectionEngine()
    await m.inviteKeyholder(makeInvite('Prof. James Wilson'), 'election-2', async () => { throw new Error('unused') })
    const kh = await mockKeyholders(m)
    expect(kh.find(k => k.invite.name === 'Dr. Sarah Chen')!.sent).to.equal(undefined)
  })

  it('M5 (CR-01): a declined mock keyholder has the real engine shape - sent declined, no result', async () => {
    const m = new MockElectionEngine()
    const judge = (await mockKeyholders(m)).find(k => k.invite.name === 'Judge Michael Rodriguez')!
    expect(judge.sent?.state).to.equal('declined')
    expect(judge.sent?.expiration).to.be.a('string').and.not.equal('')
    expect(judge.result).to.equal(undefined)
  })

  it('M5 (CR-01): a live resend to a declined mock keyholder reads live; an expired one leaves it declined', async () => {
    const m = new MockElectionEngine()
    await m.inviteKeyholder(makeInvite('Judge Michael Rodriguez', '2000-01-02T00:00:00'), 'election-2', async () => { throw new Error('unused') })
    const declined = (await mockKeyholders(m)).find(k => k.invite.name === 'Judge Michael Rodriguez')!
    expect(declined.sent?.state).to.equal('declined')
    expect(declined.result).to.equal(undefined)
    const future = futureIso()
    await m.inviteKeyholder(makeInvite('Judge Michael Rodriguez', future), 'election-2', async () => { throw new Error('unused') })
    const resent = (await mockKeyholders(m)).find(k => k.invite.name === 'Judge Michael Rodriguez')!
    expect(resent.sent).to.deep.equal({ state: 'live', expiration: future })
    expect(resent.result).to.equal(undefined)
  })

  it('M4: repeated sends to one name read live with the future expiration, in either send order', async () => {
    const past = '2000-01-02T00:00:00'
    for (const order of [[past, 'future'], ['future', past]]) {
      const m = new MockElectionEngine()
      const future = futureIso()
      for (const exp of order) {
        await m.inviteKeyholder(makeInvite('Dr. Sarah Chen', exp === 'future' ? future : exp), 'election-2', async () => { throw new Error('unused') })
      }
      const sarah = (await mockKeyholders(m)).find(k => k.invite.name === 'Dr. Sarah Chen')!
      expect(sarah.sent).to.deep.equal({ state: 'live', expiration: future })
    }
  })
})
