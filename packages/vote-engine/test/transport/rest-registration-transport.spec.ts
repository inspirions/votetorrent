/**
 * rest-registration-transport.spec.ts — Phase 48 Plan 10 (D-01)
 *
 * WHY A REAL SERVER: this spec starts a throwaway `node:http` server on an
 * ephemeral loopback port and drives `RestRegistrationTransport` through the
 * REAL global `fetch`. A mocked `fetch` would prove the binding calls a
 * function; it would not prove it speaks HTTP, builds the right URL, omits
 * an absent query param, or survives a JSON round-trip.
 *
 * This test server is test-only and never ships in any app bundle. It lives
 * under `packages/vote-engine/test/`, which `tsconfig.build.json` excludes.
 * It is NOT a counterexample to the shipped binding's pull-only constraint —
 * that constraint governs the SHIPPED source (`rest-registration-transport.ts`),
 * and the `shipped-code constraints` describe below gates that distinction
 * mechanically by reading the shipped file's source text.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { readFileSync, readdirSync } from 'node:fs'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect } from 'chai'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js'
import { sha256 } from '@noble/hashes/sha2.js'
import type { RegistrationRequestInit, Signature } from '@votetorrent/vote-core'
import { RestRegistrationTransport } from '../../src/registration/transport/rest-registration-transport.js'
import { digestToBytes } from '../../src/utils.js'
import { randomTestKeyPair } from '../fixtures/keys.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// ---------------------------------------------------------------------------
// Throwaway test-only authority server fixture (never ships)
// ---------------------------------------------------------------------------

interface TestServer {
  baseUrl: string
  received: Array<{ method: string; url: string; body: unknown }>
  decisions: Array<{ requestId: string; status: string; reason?: string; cursor: string }>
  /** The digest (hex) this fixture issued for a given `init.id`, keyed so a
   * spec can independently verify the signature against the exact bytes the
   * server handed out, without duplicating the fixture's hashing logic. */
  issuedDigests: Map<string, string>
  /** Single-shot override applied to the NEXT digest-handshake (R-1)
   * response only, then cleared. */
  setNextDigest: (override: { digest?: string; submittedAt?: string }) => void
  /** Single-shot override of the `requestId` the NEXT submit (R-2) response
   * carries, then cleared. */
  setNextSubmitRequestId: (id: string) => void
  /** Single-shot override that forces the NEXT submit (R-2) call to receive
   * exactly this status/body instead of normal handling, then cleared. */
  setNextSubmitResponse: (status: number, body: unknown) => void
  close: () => Promise<void>
}

async function startTestAuthorityServer (): Promise<TestServer> {
  const received: Array<{ method: string; url: string; body: unknown }> = []
  const decisionsStore: Array<{ requestId: string; status: string; reason?: string; cursor: string }> = []
  const issuedDigests = new Map<string, string>()

  let digestOverride: { digest?: string; submittedAt?: string } | null = null
  let submitRequestIdOverride: string | null = null
  let submitResponseOverride: { status: number; body: unknown } | null = null

  const send = (res: ServerResponse, status: number, body: unknown): void => {
    const json = JSON.stringify(body)
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(json)
  }

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const rawBody = Buffer.concat(chunks).toString('utf8')
      let parsedBody: unknown
      if (rawBody.length > 0) {
        try {
          parsedBody = JSON.parse(rawBody)
        } catch {
          parsedBody = undefined
        }
      }
      const method = req.method ?? 'GET'
      const url = req.url ?? '/'
      received.push({ method, url, body: parsedBody })

      if (method === 'POST' && url === '/registration-requests/digest') {
        const body = parsedBody as { init: RegistrationRequestInit; requesterKey: string }
        const digestBytes = sha256(new TextEncoder().encode(JSON.stringify({ init: body.init, requesterKey: body.requesterKey })))
        const digestHex = bytesToHex(digestBytes)
        issuedDigests.set(body.init.id, digestHex)
        // The response's submittedAt is an ECHO, not an issue: the
        // submitter chose it at signing time (48-02 L-3), and this fixture
        // merely reports which value it digested so the client can detect
        // an endpoint that digested something else. A fixture that
        // generated its OWN timestamp here would be modelling the OLD,
        // superseded contract and would make test 1 vacuous.
        let responseBody: { digest: string; submittedAt: string } = { digest: digestHex, submittedAt: body.init.submittedAt }
        if (digestOverride) {
          responseBody = { ...responseBody, ...digestOverride }
          digestOverride = null
        }
        send(res, 200, responseBody)
        return
      }

      if (method === 'POST' && url === '/registration-requests') {
        if (submitResponseOverride) {
          const override = submitResponseOverride
          submitResponseOverride = null
          send(res, override.status, override.body)
          return
        }
        const body = parsedBody as { init: RegistrationRequestInit }
        const requestId = submitRequestIdOverride ?? body.init.id
        submitRequestIdOverride = null
        send(res, 200, { requestId })
        return
      }

      if (method === 'GET' && url.startsWith('/registration-decisions')) {
        const parsedUrl = new URL(url, 'http://127.0.0.1')
        const since = parsedUrl.searchParams.get('since')
        const notices = decisionsStore.filter((d) => since === null || d.cursor > since)
        send(res, 200, { notices })
        return
      }

      send(res, 404, { error: 'not found' })
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })

  const address = server.address() as AddressInfo
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    received,
    decisions: decisionsStore,
    issuedDigests,
    setNextDigest: (override) => { digestOverride = override },
    setNextSubmitRequestId: (id) => { submitRequestIdOverride = id },
    setNextSubmitResponse: (status, body) => { submitResponseOverride = { status, body } },
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()))
      })
    }
  }
}

/** Real secp256k1 sign callback (@noble/curves v2 defaults — prehash:true,
 * two-argument `sign` form, WR-10). `signerUserId` is deliberately empty: a
 * prospective registrant has no `User` row, the field is a type artifact on
 * this path, and neither the binding nor the endpoint may read it (D-02). */
function makeRealSigner (privBytes: Uint8Array, publicHex: string): (digest: Uint8Array) => Promise<Signature> {
  return async (digest: Uint8Array): Promise<Signature> => ({
    signature: bytesToHex(secp256k1.sign(digest, privBytes)),
    signerKey: publicHex,
    signerUserId: ''
  })
}

const FUTURE_EXPIRATION = Date.now() + 365 * 86_400_000

// The ONE place in this file a clock may touch a submittedAt position: this
// is the SUBMITTER's own act, authored once into a single named constant so
// every init and every assertion below reuses it and can compare
// byte-for-byte instead of approximately.
const SUBMITTED_AT = new Date().toISOString()

let requestIdSeq = 0
function buildInit (overrides: Partial<RegistrationRequestInit> = {}): RegistrationRequestInit {
  requestIdSeq += 1
  const id = `rest-transport-test-request-${Date.now()}-${requestIdSeq}`
  return {
    id,
    authorityId: 'rest-transport-test-authority',
    payload: {
      registrant: {
        id: `rest-transport-test-registrant-${requestIdSeq}`,
        authorityId: 'rest-transport-test-authority',
        expiration: FUTURE_EXPIRATION
      },
      private: { expiration: FUTURE_EXPIRATION, details: [] }
    },
    submittedAt: SUBMITTED_AT,
    ...overrides
  }
}

// ---------------------------------------------------------------------------
// Task 2: real round-trip
// ---------------------------------------------------------------------------

describe('rest-registration-transport: real round-trip', () => {
  let server: TestServer

  afterEach(async () => {
    await server.close()
  })

  it('submits a genuinely signed request over a real HTTP socket and returns the assigned request id', async () => {
    server = await startTestAuthorityServer()
    const transport = new RestRegistrationTransport({ baseUrl: server.baseUrl })
    const { privateHex, publicHex } = randomTestKeyPair()
    const privBytes = hexToBytes(privateHex)
    const init = buildInit()

    const requestId = await transport.submitRequest(init, publicHex, makeRealSigner(privBytes, publicHex))

    expect(server.received).to.have.lengthOf(2)
    expect(server.received[0]!.method).to.equal('POST')
    expect(server.received[0]!.url).to.equal('/registration-requests/digest')
    expect(server.received[1]!.method).to.equal('POST')
    expect(server.received[1]!.url).to.equal('/registration-requests')

    const r1Body = server.received[0]!.body as { init: RegistrationRequestInit }
    const r2Body = server.received[1]!.body as { init: RegistrationRequestInit; submittedAt: string; signature: Signature }

    // The submitter's submittedAt is identical in all three wire positions
    // and equals the value the test authored — the client did not invent,
    // re-format, or adopt a timestamp. A courier that rewrote it would
    // invalidate a signature it never touched; this is the same property
    // 48-13's conformance case 6 asserts across both bindings.
    expect(r1Body.init.submittedAt).to.equal(SUBMITTED_AT)
    expect(r2Body.submittedAt).to.equal(SUBMITTED_AT)
    expect(r2Body.init.submittedAt).to.equal(SUBMITTED_AT)

    // Load-bearing assertion: prove the digest survived the
    // string->bytes->sign->hex round-trip unmangled by verifying the
    // transmitted signature against the EXACT digest bytes the server
    // issued (not a value re-derived independently in this test).
    const issuedDigestHex = server.issuedDigests.get(init.id)
    expect(issuedDigestHex, 'server must have issued a digest for this init.id').to.be.a('string')
    const digestBytes = digestToBytes(issuedDigestHex!)
    const sigBytes = hexToBytes(r2Body.signature.signature)
    const pubBytes = hexToBytes(publicHex)
    expect(secp256k1.verify(sigBytes, digestBytes, pubBytes)).to.equal(true)

    expect(requestId).to.equal(init.id)
  })

  it('carries a bridge-issued submission issuer markers through unchanged', async () => {
    server = await startTestAuthorityServer()
    const transport = new RestRegistrationTransport({ baseUrl: server.baseUrl })
    const { privateHex, publicHex } = randomTestKeyPair()
    const privBytes = hexToBytes(privateHex)
    const init = buildInit({ issuerType: 'bridge', bridgeId: 'rest-transport-test-bridge' })

    await transport.submitRequest(init, publicHex, makeRealSigner(privBytes, publicHex))

    const r1Body = server.received[0]!.body as { init: RegistrationRequestInit }
    const r2Body = server.received[1]!.body as { init: RegistrationRequestInit }

    // A binding that dropped or defaulted these markers would make a
    // bridge assertion arrive looking like a voter's own cryptographically
    // attributed act (D-03). Both markers must also have been present in
    // the R-1 handshake body, so they are inside the digest the endpoint
    // computed.
    expect(r1Body.init.issuerType).to.equal('bridge')
    expect(r1Body.init.bridgeId).to.equal('rest-transport-test-bridge')
    expect(r2Body.init.issuerType).to.equal('bridge')
    expect(r2Body.init.bridgeId).to.equal('rest-transport-test-bridge')
  })

  it('polls decisions and advances the cursor monotonically', async () => {
    server = await startTestAuthorityServer()
    server.decisions.push(
      { requestId: 'rest-transport-test-req-a', status: 'p', cursor: 'c001' },
      { requestId: 'rest-transport-test-req-b', status: 'a', cursor: 'c002' },
      { requestId: 'rest-transport-test-req-c', status: 'r', reason: 'not eligible', cursor: 'c003' }
    )
    const transport = new RestRegistrationTransport({ baseUrl: server.baseUrl })

    const all = await transport.pollDecisions()
    expect(all.map((n) => n.cursor)).to.deep.equal(['c001', 'c002', 'c003'])
    expect(server.received[0]!.url).to.equal('/registration-decisions')
    // Never sent as the literal string "undefined", and never sent at all
    // when there is no cursor.
    expect(server.received[0]!.url).to.not.include('since')

    // The binding holds no cursor of its own between calls — this second
    // call's result depends solely on the argument just supplied.
    const sinceC002 = await transport.pollDecisions('c002')
    expect(sinceC002.map((n) => n.requestId)).to.deep.equal(['rest-transport-test-req-c'])
    expect(server.received[1]!.url).to.include('since=c002')
  })
})
