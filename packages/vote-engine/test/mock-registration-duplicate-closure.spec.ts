// mock-registration-duplicate-closure.spec.ts — UAT 62 test 12 (62-56)
//
// The mock must model D-44 duplicate closure so screens can be tested against the
// real list-row path: a closed request keeps Status 'p', carries duplicateClosure on
// the unfiltered list, and is excluded from the pending filter.

import { expect } from 'chai'
import { MockRegistrationEngine } from '../src/registration/mock-registration-engine.js'

const A = 'fixture-request-pending-duplicate-a'
const B = 'fixture-request-pending-duplicate-b'

describe('MockRegistrationEngine duplicate closure (62-56)', () => {
  for (const state of ['closed', 'closing'] as const) {
    it(`marks a ${state} row, excludes it from pending, and omits the key elsewhere`, async () => {
      const engine = new MockRegistrationEngine()
      const pendingBefore = await engine.listRegistrationRequests({ status: 'p' })
      engine.markDuplicateClosure(A, state)

      const all = await engine.listRegistrationRequests()
      const row = all.rows.find((r) => r.requestId === A)!
      expect(row.status).to.equal('p')
      expect(row.duplicateClosure).to.equal(state)
      for (const other of all.rows.filter((r) => r.requestId !== A)) {
        expect('duplicateClosure' in other, other.requestId).to.equal(false)
      }

      const pending = await engine.listRegistrationRequests({ status: 'p' })
      expect(pending.rows.some((r) => r.requestId === A)).to.equal(false)
      expect(pending.rows.some((r) => r.requestId === B)).to.equal(true)
      expect(pending.total).to.equal(pendingBefore.total! - 1)
    })
  }

  it('getDuplicateClosure returns the marked state and undefined otherwise', async () => {
    const engine = new MockRegistrationEngine()
    engine.markDuplicateClosure(A, 'closed')
    const c = await engine.getDuplicateClosure(A)
    expect(c?.state).to.equal('closed')
    expect(c?.requestId).to.equal(A)
    expect(await engine.getDuplicateClosure(B)).to.equal(undefined)
  })
})
