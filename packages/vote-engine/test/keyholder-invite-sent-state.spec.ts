/**
 * keyholder-invite-sent-state.spec.ts - phase 62 plan 76 (D-14, D-16, D-27).
 *
 * The election engine's keyholder projection reports, per invitee, whether a keyholder invitation
 * slot was sent and whether it is still live, answered, or no longer valid, using the one shared
 * invite-chain rule (readInviteChain). Real-DB cases S1-S6, then mock parity M1-M3.
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
    expect(kh.find(k => k.invite.name === 'Judge Michael Rodriguez')!.sent).to.equal(undefined)
  })
})
