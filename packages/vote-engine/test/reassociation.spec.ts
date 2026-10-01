/**
 * reassociation.spec.ts — 62-18 (D-40, D-41, D-45, D-46).
 *
 * Task 1: the pure vote-core registration-code format helpers, the vote-engine PRF derivation,
 * and the `ReassociationError` shape. Tasks 2/3 (association-removal.spec.ts and this file's
 * later describe blocks) extend this file with the compound write, the driver and the full
 * code/identity/automatic/manual flows.
 */

import { expect } from 'chai'
import {
  encodeRegistrationCodeBits,
  formatRegistrationCode,
  normalizeRegistrationCode,
  registrationCodesEqual,
  REASSOCIATION_UNRESOLVED_REGISTRANT_ID,
  REGISTRATION_CODE_ALPHABET,
  REGISTRATION_CODE_FORMATTED_LENGTH,
  REGISTRATION_CODE_LENGTH,
  ReassociationError
} from '@votetorrent/vote-core'
import { deterministicTestKeyPair } from './fixtures/keys.js'
import { deriveRegistrationCodeWith } from '../src/association/reassociation/registration-code.js'
import type { Signature } from '@votetorrent/vote-core'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js'

/** Deterministic callback signer — @noble/curves v2 defaults (prehash:true, no extraEntropy), so
 * two signs over the identical digest produce byte-identical signatures. */
function makeDeterministicSigner (privateHex: string, publicHex: string): (digest: Uint8Array) => Promise<Signature> {
  const privBytes = hexToBytes(privateHex)
  return async (digest: Uint8Array): Promise<Signature> => {
    const sig = secp256k1.sign(digest, privBytes)
    return { signature: bytesToHex(sig), signerKey: publicHex, signerUserId: '' }
  }
}

/** A hedged signer: `extraEntropy: true` makes @noble/curves randomize `k`, so two signs over the
 * SAME digest produce DIFFERENT signature bytes — the non-determinism `deriveRegistrationCodeWith`
 * must reject. */
function makeHedgedSigner (privateHex: string, publicHex: string): (digest: Uint8Array) => Promise<Signature> {
  const privBytes = hexToBytes(privateHex)
  return async (digest: Uint8Array): Promise<Signature> => {
    const sig = secp256k1.sign(digest, privBytes, { extraEntropy: true })
    return { signature: bytesToHex(sig), signerKey: publicHex, signerUserId: '' }
  }
}

describe('registration code (D-45)', () => {
  describe('encodeRegistrationCodeBits', () => {
    it('all-zero 7 bytes encodes to all-zero-character code', () => {
      expect(encodeRegistrationCodeBits(new Uint8Array(7))).to.equal('0000000000')
    })

    it('all-0xff 7 bytes encodes to all-Z code', () => {
      expect(encodeRegistrationCodeBits(new Uint8Array(7).fill(0xff))).to.equal('ZZZZZZZZZZ')
    })

    it('throws TypeError on fewer than 7 bytes', () => {
      expect(() => encodeRegistrationCodeBits(new Uint8Array(6))).to.throw(TypeError)
    })

    it('output is always 10 characters, every one in the alphabet', () => {
      const out = encodeRegistrationCodeBits(new Uint8Array([0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0xde, 0xf0]))
      expect(out).to.have.lengthOf(REGISTRATION_CODE_LENGTH)
      for (const ch of out) expect(REGISTRATION_CODE_ALPHABET.includes(ch), `char ${ch} in alphabet`).to.equal(true)
    })
  })

  describe('normalizeRegistrationCode', () => {
    it('strips spaces/hyphens and uppercases', () => {
      expect(normalizeRegistrationCode(' abcde-fghjk ')).to.equal('ABCDEFGHJK')
    })

    it('maps O->0 and I/L->1', () => {
      expect(normalizeRegistrationCode('O0IL1ABCDE')).to.equal('00111ABCDE')
    })

    it('returns undefined for a 9-char input', () => {
      expect(normalizeRegistrationCode('ABCDEFGHJ')).to.equal(undefined)
    })

    it('returns undefined for an 11-char input', () => {
      expect(normalizeRegistrationCode('ABCDEFGHJKM')).to.equal(undefined)
    })

    it('returns undefined for an input containing U', () => {
      expect(normalizeRegistrationCode('ABCDEFGHJU')).to.equal(undefined)
    })
  })

  describe('formatRegistrationCode', () => {
    it('formats a normalized 10-char code as XXXXX-XXXXX', () => {
      const formatted = formatRegistrationCode('ABCDEFGHJK')
      expect(formatted).to.equal('ABCDE-FGHJK')
      expect(formatted).to.have.lengthOf(REGISTRATION_CODE_FORMATTED_LENGTH)
    })

    it('throws TypeError for an invalid code', () => {
      expect(() => formatRegistrationCode('too-short')).to.throw(TypeError)
    })
  })

  describe('registrationCodesEqual', () => {
    it('is true for the same code in different casing/separator form', () => {
      expect(registrationCodesEqual('abcde-fghjk', 'ABCDEFGHJK')).to.equal(true)
    })

    it('is false for codes differing in one character', () => {
      expect(registrationCodesEqual('ABCDEFGHJK', 'ABCDEFGHJM')).to.equal(false)
    })

    it('is false, never throws, when either side is invalid', () => {
      expect(registrationCodesEqual('ABCDEFGHJK', 'too-short')).to.equal(false)
      expect(registrationCodesEqual('nope', 'ABCDEFGHJK')).to.equal(false)
    })
  })

  describe('ReassociationError', () => {
    it('is instanceof Error, carries name and code', () => {
      const err = new ReassociationError('invalid-argument', 'test message')
      expect(err).to.be.instanceOf(Error)
      expect(err.name).to.equal('ReassociationError')
      expect(err.code).to.equal('invalid-argument')
      expect(err.message).to.equal('test message')
    })
  })

  describe('deriveRegistrationCodeWith (vote-engine)', () => {
    it('is deterministic: same registrantId + same signer -> same code on two calls', async () => {
      const key = deterministicTestKeyPair('1'.repeat(64))
      const sign = makeDeterministicSigner(key.privateHex, key.publicHex)
      const codeA = await deriveRegistrationCodeWith('registrant-det-1', sign)
      const codeB = await deriveRegistrationCodeWith('registrant-det-1', sign)
      expect(codeA).to.equal(codeB)
    })

    it('different registrantIds give different codes under the same signer', async () => {
      const key = deterministicTestKeyPair('2'.repeat(64))
      const sign = makeDeterministicSigner(key.privateHex, key.publicHex)
      const codeA = await deriveRegistrationCodeWith('registrant-diff-a', sign)
      const codeB = await deriveRegistrationCodeWith('registrant-diff-b', sign)
      expect(codeA).to.not.equal(codeB)
    })

    // Pinned regression vector (KAT): a fixed test private key + a fixed registrantId must
    // always reproduce this exact code. If this ever fails, either the digest/domain/derivation
    // changed (a breaking change to every already-issued code) or something upstream (the signer,
    // the hash) silently changed behavior.
    it('pinned regression vector: fixed key + registrantId reassoc-kat-registrant', async () => {
      const KAT_PRIVATE_HEX = 'a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1'
      const key = deterministicTestKeyPair(KAT_PRIVATE_HEX)
      const sign = makeDeterministicSigner(key.privateHex, key.publicHex)
      const code = await deriveRegistrationCodeWith('reassoc-kat-registrant', sign)
      expect(code).to.equal('AQ6CH4P12J')
    })

    it('rejects a non-deterministic (hedged) signer with non-deterministic-signer', async () => {
      const key = deterministicTestKeyPair('3'.repeat(64))
      const sign = makeHedgedSigner(key.privateHex, key.publicHex)
      try {
        await deriveRegistrationCodeWith('registrant-hedged', sign)
        expect.fail('expected deriveRegistrationCodeWith to throw')
      } catch (err) {
        expect(err).to.be.instanceOf(ReassociationError)
        expect((err as ReassociationError).code).to.equal('non-deterministic-signer')
      }
    })

    it('rejects an empty registrantId with invalid-argument', async () => {
      const key = deterministicTestKeyPair('4'.repeat(64))
      const sign = makeDeterministicSigner(key.privateHex, key.publicHex)
      try {
        await deriveRegistrationCodeWith('', sign)
        expect.fail('expected deriveRegistrationCodeWith to throw')
      } catch (err) {
        expect(err).to.be.instanceOf(ReassociationError)
        expect((err as ReassociationError).code).to.equal('invalid-argument')
      }
    })

    it('rejects REASSOCIATION_UNRESOLVED_REGISTRANT_ID with invalid-argument', async () => {
      const key = deterministicTestKeyPair('5'.repeat(64))
      const sign = makeDeterministicSigner(key.privateHex, key.publicHex)
      try {
        await deriveRegistrationCodeWith(REASSOCIATION_UNRESOLVED_REGISTRANT_ID, sign)
        expect.fail('expected deriveRegistrationCodeWith to throw')
      } catch (err) {
        expect(err).to.be.instanceOf(ReassociationError)
        expect((err as ReassociationError).code).to.equal('invalid-argument')
      }
    })

    it('accepts no key material — the only key input is the signing callback', () => {
      // Structural proof, not a runtime one: the function's own declared arity is 2
      // (registrantId, sign) — no third "key" parameter exists on the signature at all.
      expect(deriveRegistrationCodeWith.length).to.equal(2)
    })
  })
})
