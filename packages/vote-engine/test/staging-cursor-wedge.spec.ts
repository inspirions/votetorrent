/**
 * staging-cursor-wedge.spec.ts — 62-33 Task 2 (V-4, D-19, D-24).
 *
 * The confirmed V-4 repro as a permanent regression: a forged or legacy malformed staging cursor
 * must not wedge allocation, burn the cursor space, or poison any reader's high-water mark, on
 * the shared seam and on both P2P transports. Mock-port cases model rows that predate the
 * CursorWellFormed CHECK; the real-strand case (W7) uses a conforming forged cap-valued row.
 */

import { expect } from 'chai'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js'
import {
  insertWithCursorRetry,
  isConformingStagingCursor,
  stagingCursorCeiling,
  P2pStagingError,
  STAGING_CURSOR_MAX_TEXT,
  STAGING_CURSOR_MAX_STEP
} from '../src/registration/transport/p2p-staging-seam.js'
import type { StagingSqlPort, StagingCursorTable } from '../src/registration/transport/p2p-staging-seam.js'
import { P2pRegistrationTransport } from '../src/registration/transport/p2p-registration-transport.js'
import type { RegistrationStrandPort } from '../src/registration/transport/p2p-registration-transport.js'
import { P2pAssociationTransport } from '../src/association/transport/p2p-association-transport.js'
import type { AssociationStrandPort } from '../src/association/transport/p2p-association-transport.js'
import { digestToBytes } from '../src/utils.js'
import { toIsoZDatetime } from '../src/signing/ceremony-helpers.js'
import { randomTestKeyPair } from './fixtures/keys.js'
import { createP2pStagingFixture } from './fixtures/p2p-staging-fixture.js'

const GOOD = '0000000000000001'
const FORGED_TEXT = 'zzzzzzzzzzzzzzzz'
const FORGED_NINES = '9999999999999999'
const CAP = STAGING_CURSOR_MAX_TEXT

/** In-memory port that interprets just the statements the seam and transports issue. */
class MockPort implements StagingSqlPort, RegistrationStrandPort, AssociationStrandPort {
  readonly inserted: string[] = []
  constructor (private readonly cursors: string[], private readonly table: string = 'T') {}

  private rowFor (cursor: string): Record<string, unknown> {
    return {
      Cursor: cursor,
      RequestId: `req-${cursor}`,
      Digest: 'd',
      InitJson: 'x',
      AnswerJson: 'x',
      RequesterKey: 'k',
      SignatureJson: 'not-json',
      StagedAt: '2026-01-01T00:00:00.000Z',
      AuthorityId: 'a',
      Status: 'a',
      Reason: null,
      ClosesRequestId: null,
      ChallengeNonce: null,
      RevokesDeviceKey: null,
      MatchMethod: null,
      DecidedAt: '2026-01-01T00:00:00.000Z',
      DeciderKey: 'k',
      DeciderSignature: 's'
    }
  }

  async query<T> (sql: string, params: Record<string, unknown>): Promise<T[]> {
    if (/max\(Cursor\)/.test(sql)) return [{ MaxCursor: [...this.cursors].sort().pop() ?? null } as unknown as T]
    if (/count\(\*\)/.test(sql)) return [{ RowCount: this.cursors.length } as unknown as T]
    if (/order by Cursor desc limit 64/.test(sql)) {
      const ceiling = params.ceiling as string
      const before = params.beforeCursor as string | undefined
      return this.cursors
        .filter((c) => c <= ceiling && (before === undefined || c < before))
        .sort()
        .reverse()
        .slice(0, 64)
        .map((c) => ({ Cursor: c }) as unknown as T)
    }
    if (/Cursor = :cursor/.test(sql)) return this.cursors.filter((c) => c === params.cursor).map((c) => ({ Cursor: c }) as unknown as T)
    if (/:sinceCursor/.test(sql)) {
      const since = params.sinceCursor as string | null
      return this.cursors
        .filter((c) => since === null || c > since)
        .sort()
        .map((c) => this.rowFor(c) as unknown as T)
    }
    if (/where StrandId = :strandId and RequestId/.test(sql)) return []
    throw new Error(`MockPort: unexpected query ${sql}`)
  }

  async mutate (_sql: string, params: Record<string, unknown>): Promise<void> {
    this.inserted.push(params.cursor as string)
    this.cursors.push(params.cursor as string)
  }

  async close (): Promise<void> {}
  describe (): string { return this.table }
}

async function allocate (cursors: string[], table: StagingCursorTable = 'RegistrationRequestStaging'): Promise<{ cursor: string, port: MockPort }> {
  const port = new MockPort(cursors)
  const out = await insertWithCursorRetry(port, {
    table,
    strandId: 's',
    insertSql: 'insert into x',
    params: {},
    identity: { sql: 'select 1 where StrandId = :strandId and RequestId = :requestId', params: { strandId: 's', requestId: 'r' } },
    onIdentityConflict: () => 'idempotent',
    where: 'test'
  })
  return { cursor: out.cursor, port }
}

const unreadableOpener = { open: async () => ({ ok: false as const, reason: 'not-a-recipient', detail: '' }) }

describe('staging cursor wedge (62-33, V-4)', function () {
  this.timeout(60_000)

  describe('allocator', () => {
    it('W1: a legacy non-digit cursor does not wedge allocation', async () => {
      expect((await allocate([GOOD, FORGED_TEXT])).cursor).to.equal('0000000000000002')
    })

    it('W2: a 16-nines cursor does not push allocation to 17 characters', async () => {
      const { cursor, port } = await allocate([GOOD, FORGED_NINES])
      expect(cursor).to.equal('0000000000000002')
      for (const c of port.inserted) expect(c.length).to.equal(16)
    })

    it('W3: a conforming cap-valued cursor above the in-sequence ceiling is ignored', async () => {
      expect((await allocate([GOOD, '0000000000000002', CAP])).cursor).to.equal('0000000000000003')
    })

    it('W4: at the cap the allocator throws cursor-exhausted and never mutates', async () => {
      // Only reachable in-sequence when the ceiling itself clamps to the cap: build the port so the
      // single conforming in-sequence row IS the cap by faking a huge row count.
      const port = new MockPort([CAP])
      const realQuery = port.query.bind(port)
      port.query = (async (sql: string, params: Record<string, unknown>) =>
        /count\(\*\)/.test(sql) ? [{ RowCount: CAP }] : realQuery(sql, params)) as typeof port.query
      let caught: unknown
      try {
        await insertWithCursorRetry(port, {
          table: 'RegistrationRequestStaging',
          strandId: 's',
          insertSql: 'insert into x',
          params: {},
          identity: { sql: 'select 1 where StrandId = :strandId and RequestId = :requestId', params: { strandId: 's', requestId: 'r' } },
          onIdentityConflict: () => 'idempotent',
          where: 'test'
        })
      } catch (err) {
        caught = err
      }
      expect(caught).to.be.instanceOf(P2pStagingError)
      expect((caught as P2pStagingError).code).to.equal('cursor-exhausted')
      expect(port.inserted).to.deep.equal([])
    })

    it('an empty strand allocates 0000000000000001', async () => {
      expect((await allocate([])).cursor).to.equal(GOOD)
    })
  })

  describe('helpers', () => {
    it('W5: isConformingStagingCursor', () => {
      for (const ok of [GOOD, CAP]) expect(isConformingStagingCursor(ok), ok).to.equal(true)
      const bad: unknown[] = [
        FORGED_TEXT, FORGED_NINES, '1e15000000000000', '0x00000000000001', '000000000000000a',
        ' 000000000000001', '0000000000000000', '9007199254740992', '123456789012345', '12345678901234567', 5, null, undefined
      ]
      for (const b of bad) expect(isConformingStagingCursor(b), String(b)).to.equal(false)
    })

    it('W5: stagingCursorCeiling is count + max step, padded, clamped to the cap', async () => {
      const port = new MockPort([GOOD, '0000000000000002', '0000000000000003'])
      expect(await stagingCursorCeiling(port, 'RegistrationRequestStaging', 's')).to.equal(String(3 + STAGING_CURSOR_MAX_STEP).padStart(16, '0'))
      const huge = new MockPort([])
      huge.query = (async () => [{ RowCount: CAP }]) as typeof huge.query
      expect(await stagingCursorCeiling(huge, 'RegistrationRequestStaging', 's')).to.equal(CAP)
    })
  })

  describe('readers', () => {
    const ROWS = [GOOD, FORGED_TEXT, CAP]

    function reg (cursors: string[]): P2pRegistrationTransport {
      const port = new MockPort(cursors)
      return new P2pRegistrationTransport({
        openStrand: async () => port, computeDigest: async () => new Uint8Array(32), strandId: 's', opener: unreadableOpener
      })
    }
    function assoc (cursors: string[]): P2pAssociationTransport {
      const port = new MockPort(cursors)
      return new P2pAssociationTransport({
        openStrand: async () => port, computeDigest: async () => new Uint8Array(32), computeAttestationDigest: async () => new Uint8Array(32), strandId: 's', opener: unreadableOpener
      } as never)
    }

    it('W6: registration readStagedRequestsReport ignores forged cursors', async () => {
      const report = await reg(ROWS).readStagedRequestsReport()
      expect(report.unreadable.map((u) => u.cursor).concat(report.delivered.map((d) => d.cursor))).to.deep.equal([GOOD])
      expect(report.highWaterCursor).to.equal(GOOD)
    })

    it('W6: a non-conforming sinceCursor is treated as absent (re-delivery, never loss)', async () => {
      const report = await reg(ROWS).readStagedRequestsReport(FORGED_TEXT)
      expect(report.highWaterCursor).to.equal(GOOD)
    })

    it('W6: registration pollDecisions and readDecisionRecords ignore forged cursors', async () => {
      expect((await reg(ROWS).pollDecisions()).map((n) => n.cursor)).to.deep.equal([GOOD])
      expect((await reg(ROWS).readDecisionRecords()).map((n) => n.cursor)).to.deep.equal([GOOD])
      expect((await reg(ROWS).pollDecisions(FORGED_TEXT)).map((n) => n.cursor)).to.deep.equal([GOOD])
    })

    it('W6b: association requests', async () => {
      const report = await assoc(ROWS).readStagedRequestsReport()
      expect(report.unreadable.map((u) => u.cursor).concat(report.delivered.map((d) => d.cursor))).to.deep.equal([GOOD])
      expect(report.highWaterCursor).to.equal(GOOD)
      expect((await assoc(ROWS).readStagedRequestsReport(FORGED_TEXT)).highWaterCursor).to.equal(GOOD)
    })

    it('W6b: association attestations', async () => {
      const report = await assoc(ROWS).readStagedAttestationsReport()
      expect(report.unreadable.map((u) => u.cursor).concat(report.delivered.map((d) => d.cursor))).to.deep.equal([GOOD])
      expect(report.highWaterCursor).to.equal(GOOD)
      expect((await assoc(ROWS).readStagedAttestationsReport(FORGED_TEXT)).highWaterCursor).to.equal(GOOD)
    })

    it('W6b: association decisions', async () => {
      expect((await assoc(ROWS).pollDecisions()).map((n) => n.cursor)).to.deep.equal([GOOD])
      expect((await assoc(ROWS).readDecisionRecords()).map((n) => n.cursor)).to.deep.equal([GOOD])
      expect((await assoc(ROWS).pollDecisions(FORGED_TEXT)).map((n) => n.cursor)).to.deep.equal([GOOD])
      expect((await assoc(ROWS).readDecisionRecords(FORGED_TEXT)).map((n) => n.cursor)).to.deep.equal([GOOD])
    })
  })

  describe('real strand database', () => {
    it('W7: a forged cap-valued row neither burns the cursor space nor poisons the high-water mark', async () => {
      const fixture = await createP2pStagingFixture()
      const strandId = `wedge-${crypto.randomUUID()}`
      const authorityId = fixture.auth.authority.id

      // Forger: a correctly signed row at the conforming cap cursor.
      const { privateHex, publicHex } = randomTestKeyPair()
      const digestRow = await fixture.db.prepare('select Digest(:s, :n) as d').get({ s: 'forged', n: crypto.randomUUID() })
      const digest = digestRow?.d as string
      const signature = bytesToHex(secp256k1.sign(digestToBytes(digest), hexToBytes(privateHex)))
      await fixture.db.exec(
        `insert into RegistrationRequestStaging (StrandId, Cursor, RequestId, Digest, InitJson, RequesterKey, SignatureJson, StagedAt)
         values (:strandId, :cursor, :requestId, :digest, :payload, :requesterKey, :signatureJson, :stagedAt)`,
        {
          strandId, cursor: CAP, requestId: 'forged-request', digest, payload: '{}', requesterKey: publicHex,
          signatureJson: JSON.stringify({ signature, signerKey: publicHex }), stagedAt: toIsoZDatetime(Date.now())
        }
      )

      const transport = new P2pRegistrationTransport({
        openStrand: async () => fixture.makePort() as unknown as RegistrationStrandPort,
        computeDigest: async (init, key) => await fixture.fixtureRequestDigest(init, key),
        strandId,
        sealer: fixture.sealer,
        opener: fixture.opener
      })
      const signer = fixture.makeRequesterSigner()
      const id = `honest-${crypto.randomUUID()}`
      const init = {
        id,
        authorityId,
        payload: {
          registrant: { id: `registrant-${id}`, authorityId, expiration: Date.now() + 365 * 86_400_000 },
          private: { expiration: Date.now() + 365 * 86_400_000, details: [{ name: 'note', value: 'wedge' }] }
        },
        submittedAt: new Date().toISOString()
      }
      await transport.submitRequest(init as never, signer.publicHex, signer.sign)

      const rows = await fixture.rawRows('RegistrationRequestStaging', strandId)
      const honest = rows.find((r) => r.RequestId === id)
      expect(honest?.Cursor).to.equal(GOOD)

      const report = await transport.readStagedRequestsReport()
      expect(report.delivered.map((d) => d.requestId)).to.deep.equal([id])
      expect(report.highWaterCursor).to.equal(GOOD)
    })
  })
})
