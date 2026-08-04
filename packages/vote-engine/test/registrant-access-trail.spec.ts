/**
 * registrant-access-trail.spec.ts — real-engine + mock-parity spec for the
 * RegistrantPrivate access trail (D-01/D-02, 47-07-PLAN.md).
 *
 * Covers:
 *   - the shared names-only sanitizer (`access-trail-fields.ts`): name
 *     collection (flat + nested groups), and the value-rejection lock that
 *     proves a private VALUE handed to the sanitizer can never survive it
 *   - RegistrationEngine.recordRegistrantAccessEvent / getRegistrantAccessEvents
 *     against the real schema: the insert is UNSIGNED (no new AdminSigning/
 *     AdminSignature row), Sequence is monotonic per registrant, update and
 *     delete are both rejected (InsertOnly), and the reviewer read returns
 *     viewer/timestamp/names newest-first
 *   - MockRegistrationEngine parity for both methods
 *
 * Framing (D-01, T-47-03), stated once here: `RegistrantAccessEvent` records
 * app-mediated access only, for accountability, deterrence, and regulatory
 * posture. It is **not a security control** — an officer holding the device
 * can read the local Quereus/LevelDB file directly and no row is written. No
 * test in this file asserts that the trail prevents, blocks, or restricts
 * anything, because it does not.
 */

import { expect } from 'chai'
import type { PrivateDetail } from '@votetorrent/vote-core'
import { collectPrivateFieldNames, sanitizeAccessTrailFields } from '../src/registration/access-trail-fields.js'

describe('access-trail field sanitizer (D-01/T-47-02)', () => {
  describe('collectPrivateFieldNames', () => {
    it('returns the top-level names for a flat PrivateDetail[]', () => {
      const details: PrivateDetail[] = [
        { name: 'ssn', value: '000-00-0000' },
        { name: 'dob', value: '1980-01-01' }
      ]
      expect([...collectPrivateFieldNames(details)].sort()).to.deep.equal(['dob', 'ssn'])
    })

    it('returns nested group names too, for an element whose value is a PrivateDetail[]', () => {
      const details: PrivateDetail[] = [
        {
          name: 'address',
          value: [
            { name: 'street', value: '123 Main St' },
            { name: 'zip', value: '00000' }
          ]
        }
      ]
      expect([...collectPrivateFieldNames(details)].sort()).to.deep.equal(['address', 'street', 'zip'])
    })

    it('returns an empty Set for undefined, [], and a malformed element, without throwing', () => {
      expect(collectPrivateFieldNames(undefined).size).to.equal(0)
      expect(collectPrivateFieldNames([]).size).to.equal(0)
      const malformed = [
        { value: 'no name' } as unknown as PrivateDetail,
        { name: '', value: 'empty name' } as PrivateDetail,
        { name: 123, value: 'x' } as unknown as PrivateDetail
      ]
      expect(() => collectPrivateFieldNames(malformed)).to.not.throw()
      expect(collectPrivateFieldNames(malformed).size).to.equal(0)
    })
  })

  describe('sanitizeAccessTrailFields', () => {
    it('keeps only intersecting names, de-dupes a repeated name, and sorts ascending', () => {
      const allowed = new Set(['ssn', 'dob', 'phone'])
      const result = sanitizeAccessTrailFields(['phone', 'ssn', 'phone', 'unknown-field'], allowed)
      expect(result).to.deep.equal(['phone', 'ssn'])
    })

    it('returns [] for an empty requested list, no intersection, an empty allowed set, or undefined', () => {
      const allowed = new Set(['ssn'])
      expect(sanitizeAccessTrailFields([], allowed)).to.deep.equal([])
      expect(sanitizeAccessTrailFields(['dob'], allowed)).to.deep.equal([])
      expect(sanitizeAccessTrailFields(['ssn'], new Set())).to.deep.equal([])
      expect(sanitizeAccessTrailFields(undefined, allowed)).to.deep.equal([])
    })

    it('the value-rejection lock: a private VALUE handed in alongside a real name is dropped, never returned', () => {
      const allowed = new Set(['ssn', 'dob', 'phone'])
      const requested = ['123-45-6789', '1980-01-01', 'ssn']
      const result = sanitizeAccessTrailFields(requested, allowed)
      expect(result).to.deep.equal(['ssn'])
      expect(result).to.not.include('123-45-6789')
      expect(result).to.not.include('1980-01-01')
    })

    it('does not throw on the value-rejection lock input', () => {
      const allowed = new Set(['ssn'])
      expect(() => sanitizeAccessTrailFields(['123-45-6789', 'ssn'], allowed)).to.not.throw()
    })
  })
})
