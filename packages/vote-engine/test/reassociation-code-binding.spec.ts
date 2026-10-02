/**
 * reassociation-code-binding.spec.ts — Phase 62 Plan 35 (V-3, D-41, D-45, D-46, D-54, D-55).
 *
 * V-3: any strand writer could stage a row for a victim's cleartext RequestId carrying its own
 * registration code, and the officer side matched whatever it found first. The requester's own
 * signature over (RequestId, code) now rides inside the sealed staging plaintext, and the officer
 * side accepts a code only when that signature verifies against the APPROVED request's key.
 *
 * Task 2 (producer): B1-B5. Task 3 (officer side): F1a-F4, appended below.
 */

import { expect } from 'chai'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js'
import type { RegistrationRequestInit, RegisterInit, Signature } from '@votetorrent/vote-core'
import { ReassociationError } from '@votetorrent/vote-core'
import { P2pRegistrationTransport } from '../src/registration/transport/p2p-registration-transport.js'
import type { RegistrationStrandPort } from '../src/registration/transport/p2p-registration-transport.js'
import { P2pStagingError } from '../src/registration/transport/p2p-staging-seam.js'
import {
  deriveRegistrationCodeWith,
  registrationCodeBindingDigest,
  verifyRegistrationCodeBinding
} from '../src/association/reassociation/registration-code.js'
import { createP2pStagingFixture } from './fixtures/p2p-staging-fixture.js'
import type { P2pStagingFixture } from './fixtures/p2p-staging-fixture.js'
import { randomTestKeyPair } from './fixtures/keys.js'
import type { TestKeyPair } from './fixtures/keys.js'
import { toIsoZDatetime } from '../src/signing/ceremony-helpers.js'

function makeCallbackSigner (keyPair: TestKeyPair): (digest: Uint8Array) => Promise<Signature> {
  const privBytes = hexToBytes(keyPair.privateHex)
  return async (digest: Uint8Array): Promise<Signature> => {
    const sig = secp256k1.sign(digest, privBytes)
    return { signature: bytesToHex(sig), signerKey: keyPair.publicHex, signerUserId: '' }
  }
}

describe('registration code binding — producer (62-35 Task 2, V-3)', function () {
  this.timeout(30_000)

  let fixture: P2pStagingFixture
  let strandSeq = 0

  before(async () => {
    fixture = await createP2pStagingFixture()
  })

  function buildTransport (strandId: string): P2pRegistrationTransport {
    const port = fixture.makePort()
    return new P2pRegistrationTransport({
      openStrand: async () => port as unknown as RegistrationStrandPort,
      computeDigest: async (init, requesterKey) => await fixture.fixtureRequestDigest(init, requesterKey),
      strandId,
      sealer: fixture.sealer,
      opener: fixture.opener,
      decisionSigner: fixture.decisionSigner
    })
  }

  function nextStrand (): string {
    strandSeq += 1
    return `code-binding-strand-${strandSeq}`
  }

  function makeInit (registrantId = crypto.randomUUID()): RegistrationRequestInit {
    const payload: RegisterInit = {
      registrant: { id: registrantId, authorityId: fixture.auth.authority.id, expiration: toIsoZDatetime(Date.now() + 365 * 86_400_000) },
      public: { firstName: 'Bind', lastName: 'Tester' },
      private: { expiration: toIsoZDatetime(Date.now() + 365 * 86_400_000), details: [] }
    }
    return { id: registrantId, authorityId: fixture.auth.authority.id, payload, submittedAt: toIsoZDatetime(Date.now()) }
  }

  async function openPlaintext (strandId: string): Promise<{ plaintext: Record<string, unknown>; requestId: string }> {
    const rows = await fixture.rawRows('RegistrationRequestStaging', strandId)
    expect(rows).to.have.lengthOf(1)
    const row = rows[0]!
    const requestId = row.RequestId as string
    const opened = await fixture.opener.open(row.InitJson as string, { requestId, digest: row.Digest as string })
    if (!opened.ok) throw new Error('fixture opener refused its own row')
    return { plaintext: JSON.parse(opened.plaintext) as Record<string, unknown>, requestId }
  }

  it('B1: a staged code carries the requester binding signature, which verifies only for (requestId, code, key)', async () => {
    const strandId = nextStrand()
    const transport = buildTransport(strandId)
    const requester = randomTestKeyPair()
    const sign = makeCallbackSigner(requester)
    const init = makeInit()
    const code = await deriveRegistrationCodeWith(init.id, sign)

    await transport.submitRequest(init, requester.publicHex, sign, { registrationCode: code })

    const { plaintext } = await openPlaintext(strandId)
    const bound = plaintext.registrationCodeSignature as Signature | undefined
    expect(bound, 'registrationCodeSignature present').to.not.equal(undefined)
    expect(bound!.signerKey).to.equal(requester.publicHex)

    const ok = await verifyRegistrationCodeBinding(fixture.db, { requestId: init.id, code, signature: bound!.signature, requesterKey: requester.publicHex })
    expect(ok).to.equal(true)
    expect(await verifyRegistrationCodeBinding(fixture.db, { requestId: init.id, code: code + 'X', signature: bound!.signature, requesterKey: requester.publicHex }), 'other code').to.equal(false)
    expect(await verifyRegistrationCodeBinding(fixture.db, { requestId: crypto.randomUUID(), code, signature: bound!.signature, requesterKey: requester.publicHex }), 'other request id').to.equal(false)
    expect(await verifyRegistrationCodeBinding(fixture.db, { requestId: init.id, code, signature: bound!.signature, requesterKey: randomTestKeyPair().publicHex }), 'other key').to.equal(false)
  })

  it("B2: a finished Signature with a code is refused 'code-binding-requires-signer' and writes no row", async () => {
    const strandId = nextStrand()
    const transport = buildTransport(strandId)
    const requester = randomTestKeyPair()
    const init = makeInit()
    const finished = await makeCallbackSigner(requester)(await fixture.fixtureRequestDigest(init, requester.publicHex))

    let caught: unknown
    try {
      await transport.submitRequest(init, requester.publicHex, finished, { registrationCode: 'ABCDE-FGHJK' })
    } catch (err) {
      caught = err
    }
    expect(caught).to.be.instanceOf(P2pStagingError)
    expect((caught as P2pStagingError).code).to.equal('code-binding-requires-signer')
    expect(await fixture.rawRows('RegistrationRequestStaging', strandId)).to.have.lengthOf(0)
  })

  it('B3: without a code the callback runs once and no binding exists; with a code it runs exactly twice', async () => {
    const requester = randomTestKeyPair()
    const inner = makeCallbackSigner(requester)

    let calls = 0
    const counting = async (digest: Uint8Array): Promise<Signature> => { calls += 1; return await inner(digest) }

    const plainStrand = nextStrand()
    await buildTransport(plainStrand).submitRequest(makeInit(), requester.publicHex, counting)
    expect(calls).to.equal(1)
    const plain = await openPlaintext(plainStrand)
    expect(plain.plaintext).to.not.have.property('registrationCodeSignature')

    calls = 0
    const codeStrand = nextStrand()
    await buildTransport(codeStrand).submitRequest(makeInit(), requester.publicHex, counting, { registrationCode: 'ABCDE-FGHJK' })
    expect(calls).to.equal(2)
    const withCode = await openPlaintext(codeStrand)
    expect(withCode.plaintext).to.have.property('registrationCodeSignature')
  })

  it('B3b: a callback that signs as a different key is rejected before any row is written', async () => {
    const strandId = nextStrand()
    const requester = randomTestKeyPair()
    const other = randomTestKeyPair()
    const inner = makeCallbackSigner(requester)
    const otherSign = makeCallbackSigner(other)
    let calls = 0
    const mixed = async (digest: Uint8Array): Promise<Signature> => {
      calls += 1
      return calls === 1 ? await inner(digest) : await otherSign(digest)
    }
    let caught: unknown
    try {
      await buildTransport(strandId).submitRequest(makeInit(), requester.publicHex, mixed, { registrationCode: 'ABCDE-FGHJK' })
    } catch (err) {
      caught = err
    }
    expect(caught).to.be.instanceOf(P2pStagingError)
    expect(await fixture.rawRows('RegistrationRequestStaging', strandId)).to.have.lengthOf(0)
  })

  it('B4: registrationCodeBindingDigest is a deterministic 32-byte digest that changes with every input, and refuses empties', () => {
    const a = registrationCodeBindingDigest('req-1', 'CODE-1')
    expect(a).to.have.lengthOf(32)
    expect(bytesToHex(registrationCodeBindingDigest('req-1', 'CODE-1'))).to.equal(bytesToHex(a))
    expect(bytesToHex(registrationCodeBindingDigest('req-2', 'CODE-1'))).to.not.equal(bytesToHex(a))
    expect(bytesToHex(registrationCodeBindingDigest('req-1', 'CODE-2'))).to.not.equal(bytesToHex(a))
    for (const [id, code] of [['', 'CODE-1'], ['req-1', '']] as const) {
      let caught: unknown
      try { registrationCodeBindingDigest(id, code) } catch (err) { caught = err }
      expect(caught).to.be.instanceOf(ReassociationError)
      expect((caught as ReassociationError).code).to.equal('invalid-argument')
    }
  })

  it('B5: verifyRegistrationCodeBinding never throws; garbage gives false', async () => {
    const key = randomTestKeyPair().publicHex
    const args = { requestId: 'req-1', code: 'CODE-1' }
    expect(await verifyRegistrationCodeBinding(fixture.db, { ...args, signature: 42 as unknown as string, requesterKey: key })).to.equal(false)
    expect(await verifyRegistrationCodeBinding(fixture.db, { ...args, signature: 'ab'.repeat(32), requesterKey: '' })).to.equal(false)
    expect(await verifyRegistrationCodeBinding(fixture.db, { ...args, signature: 'not-a-signature', requesterKey: key })).to.equal(false)
    expect(await verifyRegistrationCodeBinding(fixture.db, { ...args, signature: '', requesterKey: key })).to.equal(false)
  })
})
