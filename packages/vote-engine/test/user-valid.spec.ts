// user-valid.spec.ts — D-21 Class A (IsUserValid) rejection specs.
//
// `ProposedAdmin.UserValid` (packages/vote-core/schema/votetorrent.qsql:419)
// is `check (context.IsUserValid = true)`. `AuthorityEngine.proposeAdmin`
// (`authority-engine.ts:409-`) binds a REAL, computed `IsUserValid` (49-08):
// the conjunction of `verifyUserKeyMembership` (registered, unexpired
// UserKey row) and a curve-dispatched signature verification over the
// canonical digest. These cases assert that behavior: an unregistered
// signer key is rejected, an expired signer key is rejected, and a
// registered/unexpired signer with a real verifying signature still
// succeeds.

import { expect } from 'chai'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js'
import { digestToBytes, toCanonicalDatetime } from '../src/utils.js'
import { createTestNetwork, addTestAuthority, signTestDigest } from './fixtures/test-context.js'
import { randomTestKeyPair } from './fixtures/keys.js'
import type { EngineContext } from '../src/types.js'
import type { AdminInit, Proposal, Scope, Signature } from '@votetorrent/vote-core'

describe('IsUserValid — ProposedAdmin Class A signer/key gate (D-21)', () => {
  it('case 1: proposeAdmin with a signer key that has NO matching UserKey row is REJECTED', async () => {
    const net = await createTestNetwork()
    const auth = await addTestAuthority(net)
    const ctx = (auth.authorityEngine as unknown as { ctx: EngineContext }).ctx

    // A real signature, but over an UNREGISTERED keypair — no UserKey row
    // anywhere references this public key.
    const unregistered = randomTestKeyPair()
    const effectiveAt = Date.now() + 60_000
    const effectiveAtCanon = toCanonicalDatetime(effectiveAt)
    const thresholdPolicies = [{ policy: 'rad' as Scope, threshold: 1 }]
    const thresholdPoliciesJson = JSON.stringify(thresholdPolicies)

    const digestRow = await ctx.db
      .prepare('select Digest(:authorityId, :effectiveAt, :thresholdPolicies) as d')
      .get({
        authorityId: auth.authority.id,
        effectiveAt: effectiveAtCanon,
        thresholdPolicies: thresholdPoliciesJson
      })
    if (!digestRow || digestRow.d == null) throw new Error('case 1: Digest() returned null')
    const digestBytes = digestToBytes(digestRow.d as string)
    const sigHex = bytesToHex(secp256k1.sign(digestBytes, hexToBytes(unregistered.privateHex)))

    const proposal: Proposal<AdminInit> = {
      proposed: {
        officers: [{ existing: { userId: auth.user.id, authorityId: auth.authority.id, title: 'Chair', scopes: ['rad'] as Scope[] } }],
        effectiveAt,
        thresholdPolicies
      },
      signers: [auth.user.id]
    }
    const sig: Signature = { signerUserId: auth.user.id, signerKey: unregistered.publicHex, signature: sigHex }

    let threw = false
    try {
      await auth.authorityEngine.proposeAdmin(proposal, sig)
    } catch {
      threw = true
    }
    expect(threw, 'proposeAdmin with an unregistered signer key must reject').to.be.true
  })

  it('case 2: proposeAdmin with a registered signer key whose Expiration is in the PAST is REJECTED', async () => {
    const net = await createTestNetwork()
    const auth = await addTestAuthority(net)
    const ctx = (auth.authorityEngine as unknown as { ctx: EngineContext }).ctx

    // Seed a second, EXPIRED UserKey row for the seeded user. Insert-time
    // ExpirationFuture (`Expiration > context.now`) is satisfied by binding
    // an artificially EARLY `now` alongside the past Expiration — the row is
    // genuinely expired relative to real wall-clock time thereafter.
    const expiredKey = randomTestKeyPair()
    const insertNow = new Date(Date.now() - 2 * 86_400_000)
    const pastExpiration = new Date(Date.now() - 86_400_000)
    const digestRow = await ctx.db
      .prepare('select Digest(:userId, :pubKey, :type, :expiration) as d')
      .get({
        userId: auth.user.id,
        pubKey: expiredKey.publicHex,
        type: 'M',
        expiration: toCanonicalDatetime(pastExpiration)
      })
    if (!digestRow || digestRow.d == null) throw new Error('case 2: Digest() returned null')
    const existingKeySig = signTestDigest(auth.user, digestRow.d as string)

    await ctx.db.exec(
      `insert into UserKey (UserId, Type, PubKey, Expiration)
       with context UserKey = :userKey, Signature = :signature, Tid = 1, now = :now, IsSignatureValid = false
       values (:userId, 'M', :pubKey, :expiration)`,
      {
        userId: auth.user.id,
        pubKey: expiredKey.publicHex,
        expiration: toCanonicalDatetime(pastExpiration),
        userKey: existingKeySig.signerKey,
        signature: existingKeySig.signature,
        now: toCanonicalDatetime(insertNow)
      }
    )

    // Now propose admin, signed by the EXPIRED key.
    const effectiveAt = Date.now() + 60_000
    const effectiveAtCanon = toCanonicalDatetime(effectiveAt)
    const thresholdPolicies = [{ policy: 'rad' as Scope, threshold: 1 }]
    const thresholdPoliciesJson = JSON.stringify(thresholdPolicies)
    const adminDigestRow = await ctx.db
      .prepare('select Digest(:authorityId, :effectiveAt, :thresholdPolicies) as d')
      .get({ authorityId: auth.authority.id, effectiveAt: effectiveAtCanon, thresholdPolicies: thresholdPoliciesJson })
    if (!adminDigestRow || adminDigestRow.d == null) throw new Error('case 2: admin Digest() returned null')
    const adminDigestBytes = digestToBytes(adminDigestRow.d as string)
    const sigHex = bytesToHex(secp256k1.sign(adminDigestBytes, hexToBytes(expiredKey.privateHex)))

    const proposal: Proposal<AdminInit> = {
      proposed: {
        officers: [{ existing: { userId: auth.user.id, authorityId: auth.authority.id, title: 'Chair', scopes: ['rad'] as Scope[] } }],
        effectiveAt,
        thresholdPolicies
      },
      signers: [auth.user.id]
    }
    const sig: Signature = { signerUserId: auth.user.id, signerKey: expiredKey.publicHex, signature: sigHex }

    let threw = false
    try {
      await auth.authorityEngine.proposeAdmin(proposal, sig)
    } catch {
      threw = true
    }
    expect(threw, 'proposeAdmin signed by an expired UserKey must reject').to.be.true
  })

  it('case 3 (positive control): proposeAdmin with a registered, unexpired signer key and a real verifying signature SUCCEEDS', async () => {
    // This case must ALSO pass under today's vacuous CHECK — a regression in
    // the positive path is attributable independent of the D-21 fix.
    const net = await createTestNetwork()
    const auth = await addTestAuthority(net)
    const ctx = (auth.authorityEngine as unknown as { ctx: EngineContext }).ctx

    const effectiveAt = Date.now() + 60_000
    const effectiveAtCanon = toCanonicalDatetime(effectiveAt)
    const thresholdPolicies = [{ policy: 'rad' as Scope, threshold: 1 }]
    const thresholdPoliciesJson = JSON.stringify(thresholdPolicies)
    const digestRow = await ctx.db
      .prepare('select Digest(:authorityId, :effectiveAt, :thresholdPolicies) as d')
      .get({ authorityId: auth.authority.id, effectiveAt: effectiveAtCanon, thresholdPolicies: thresholdPoliciesJson })
    if (!digestRow || digestRow.d == null) throw new Error('case 3: Digest() returned null')
    const sig = signTestDigest(auth.user, digestRow.d as string)

    const proposal: Proposal<AdminInit> = {
      proposed: {
        officers: [{ existing: { userId: auth.user.id, authorityId: auth.authority.id, title: 'Chair', scopes: ['rad'] as Scope[] } }],
        effectiveAt,
        thresholdPolicies
      },
      signers: [auth.user.id]
    }

    await auth.authorityEngine.proposeAdmin(proposal, sig)

    const row = await ctx.db
      .prepare('select count(*) as n from ProposedAdmin where AuthorityId = :id and EffectiveAt = :e')
      .get({ id: auth.authority.id, e: effectiveAtCanon })
    expect(Number(row?.n)).to.equal(1)
  })
})
