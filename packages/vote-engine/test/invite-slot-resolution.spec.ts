/**
 * invite-slot-resolution.spec.ts - InvitationEngine.resolveInviteSlotCid against the real schema.
 * The invitee holds only the share (invitePrivate/inviteKey/type); the slot Cid is resolved by
 * (InviteKey, Type), never recomputed.
 */
import { expect } from 'chai'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex } from '@noble/curves/utils.js'
import type { KeyholderInvite } from '@votetorrent/vote-core'
import { InvitationEngine } from '../src/invite/invitation-engine.js'
import { MockInvitationEngine } from '../src/invite/mock-invitation-engine.js'
import { makeKeyholderProvisioning } from './fixtures/keyholder-provisioning.js'
import { createTestNetwork, addTestAuthority, addTestElection, makeTestSignCallback } from './fixtures/test-context.js'

function makeKeypair () {
  const priv = secp256k1.utils.randomSecretKey()
  return { invitePrivate: bytesToHex(priv), inviteKey: bytesToHex(secp256k1.getPublicKey(priv)) }
}

async function seed (name: string) {
  const net = await createTestNetwork()
  const auth = await addTestAuthority(net)
  const { electionEngine } = await addTestElection(auth)
  const kp = makeKeypair()
  const invite: KeyholderInvite = {
    name, type: 'k', expiration: new Date(Date.now() + 3_600_000).toISOString(),
    inviteKey: kp.inviteKey, inviteSignature: '',
  }
  const electionId = (await electionEngine.getElectionDetails()).election.id
  await electionEngine.inviteKeyholder(invite, electionId, makeTestSignCallback(auth.user))
  const row = await auth.ctx.db.prepare("select Cid from InviteSlot where Type = 'k' and Name = :name").get({ name })
  return { auth, kp, cid: row!.Cid as string, engine: new InvitationEngine(auth.ctx) }
}

describe('resolveInviteSlotCid', () => {
  it('resolves the real slot Cid by (InviteKey, Type k)', async () => {
    const s = await seed('Resolve Keyholder')
    expect(await s.engine.resolveInviteSlotCid(s.kp.inviteKey, 'k')).to.equal(s.cid)
  })

  it('returns undefined for the wrong type', async () => {
    const s = await seed('Wrong Type Keyholder')
    expect(await s.engine.resolveInviteSlotCid(s.kp.inviteKey, 'of')).to.equal(undefined)
  })

  it('returns undefined for an unknown key', async () => {
    const s = await seed('Unknown Key Keyholder')
    expect(await s.engine.resolveInviteSlotCid(makeKeypair().inviteKey, 'k')).to.equal(undefined)
  })

  it('end to end: the resolved Cid accepts with the share private key', async () => {
    const s = await seed('E2E Keyholder')
    const cid = await s.engine.resolveInviteSlotCid(s.kp.inviteKey, 'k')
    expect(cid).to.equal(s.cid)
    const provisioning = makeKeyholderProvisioning()
    const userId = crypto.randomUUID()
    await s.engine.respondToInvite(cid!, true, s.kp.invitePrivate, undefined, userId, provisioning)
    const ir = await s.auth.ctx.db.prepare('select InvokedId from InviteResult where SlotCid = :cid').get({ cid })
    expect(ir?.InvokedId).to.equal(userId)
  })

  it('mock engine seeds no slots and resolves undefined', async () => {
    expect(await new MockInvitationEngine().resolveInviteSlotCid('a'.repeat(66), 'k')).to.equal(undefined)
  })
})
