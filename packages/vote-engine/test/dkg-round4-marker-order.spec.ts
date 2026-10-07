/**
 * Round 4 must delete the stale share-attempt marker BEFORE it stores a fresh share, on every
 * branch (review finding gap1/IN-01). With the old order (put share, then delete marker) a crash
 * between the two left a fresh share labelled with an aborted attempt's marker, which the V-1
 * sweep (`cleanupVault`) would then delete.
 */

import { expect } from 'chai'
import type { Database } from '@quereus/quereus'
import {
  InMemoryTestKeyVault,
  KEYHOLDER_SHARE_ATTEMPT_POLICY,
  keyholderDkgShareAlias,
  keyholderDkgShareAttemptAlias,
  type IKeyVault
} from '../src/crypto/vault.js'
import { KeyholderDkgEngine } from '../src/keyholder/keyholder-dkg-engine.js'
import { runDkgToQuiescence, seedDkgElection, type DkgTestParticipant } from './fixtures/dkg-keyholders.js'

async function countRows (db: Database, electionId: string, revision: number, attempt: number, round: number): Promise<number> {
  const row = await db
    .prepare('select count(*) as c from KeyholderDkgMessage where ElectionId = :electionId and ElectionRevision = :revision and Attempt = :attempt and DkgRound = :dkgRound')
    .get({ electionId, revision, attempt, dkgRound: round })
  return (row?.c as number | undefined) ?? 0
}

async function awaitingRound4 (db: Database, electionId: string, revision: number, participants: DkgTestParticipant[]): Promise<DkgTestParticipant> {
  for (const p of participants) {
    const row = await db
      .prepare('select 1 as x from KeyholderDkgMessage where ElectionId = :electionId and ElectionRevision = :revision and Attempt = 1 and DkgRound = 4 and SenderUserId = :senderUserId')
      .get({ electionId, revision, senderUserId: p.userId })
    if (!row) return p
  }
  throw new Error('every participant already posted round 4')
}

/** Delegating vault whose delete of `failAlias` throws until `armed` is cleared. */
function flakyVault (base: InMemoryTestKeyVault, failAlias: string): { vault: IKeyVault, disarm: () => void } {
  let armed = true
  const vault: IKeyVault = {
    putSecret: (alias, secret, policy) => base.putSecret(alias, secret, policy),
    getSecret: async (alias) => base.getSecret(alias),
    hasSecret: async (alias) => base.hasSecret(alias),
    deleteSecret: async (alias) => {
      if (armed && alias === failAlias) throw new Error('simulated crash at marker delete')
      return base.deleteSecret(alias)
    }
  } as IKeyVault
  return { vault, disarm: () => { armed = false } }
}

describe('dkg-round4-marker-order.spec: stale marker deleted before the fresh share is stored', function () {
  this.timeout(180000)

  it('M-1/M-2: a failure at the marker delete leaves NO fresh share; the retry stores it with the producing attempt, and it survives the sweep', async () => {
    const { auth, electionId, revision, participants } = await seedDkgElection({ keyholders: ['Alice', 'Bob', 'Carol'], threshold: 2 })
    const db = auth.ctx.db
    await runDkgToQuiescence(participants, electionId, {
      stopWhen: async () => (await countRows(db, electionId, revision, 1, 3)) === participants.length
    })
    const p = await awaitingRound4(db, electionId, revision, participants)

    const shareAlias = keyholderDkgShareAlias(electionId, revision, p.userId)
    const markerAlias = keyholderDkgShareAttemptAlias(electionId, revision, p.userId)
    // A stale marker from an earlier (aborted) attempt is already present.
    await p.vault.putSecret(markerAlias, new TextEncoder().encode('9'), KEYHOLDER_SHARE_ATTEMPT_POLICY)

    const flaky = flakyVault(p.vault, markerAlias)
    const flakyEngine = new KeyholderDkgEngine(auth.ctx, { vault: flaky.vault })
    let caught: unknown
    try {
      await flakyEngine.advanceDkg(electionId, p.signer)
    } catch (err) {
      caught = err
    }
    expect(caught, 'the simulated marker-delete failure surfaces').to.not.equal(undefined)
    expect(await p.vault.hasSecret(shareAlias), 'no fresh share exists next to the stale marker').to.equal(false)

    flaky.disarm()
    await runDkgToQuiescence(participants, electionId)
    expect(await p.vault.hasSecret(shareAlias), 'retried round 4 stored the share').to.equal(true)
    const marker = await p.vault.getSecret(markerAlias)
    expect(new TextDecoder().decode(marker!)).to.equal('1')
    for (const q of participants) {
      expect(await q.vault.hasSecret(keyholderDkgShareAlias(electionId, revision, q.userId)), `${q.name} share survives the sweep`).to.equal(true)
    }
    const status = await p.engine.getDkgStatus(electionId, p.userId)
    expect(status.phase).to.equal('complete')
  })

  it('M-3: the happy path (no stale marker) still stores share + marker', async () => {
    const { electionId, revision, participants } = await seedDkgElection({ keyholders: ['Alice', 'Bob', 'Carol'], threshold: 2 })
    await runDkgToQuiescence(participants, electionId)
    for (const q of participants) {
      expect(await q.vault.hasSecret(keyholderDkgShareAlias(electionId, revision, q.userId))).to.equal(true)
      const m = await q.vault.getSecret(keyholderDkgShareAttemptAlias(electionId, revision, q.userId))
      expect(new TextDecoder().decode(m!)).to.equal('1')
    }
  })
})
