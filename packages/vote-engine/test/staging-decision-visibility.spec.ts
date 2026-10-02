/**
 * staging-decision-visibility.spec.ts — 62-43 (WR-01, V-4, D-05, D-06, D-07).
 *
 * Since 62-38 a decision is allocated by walking past every occupied slot, so an honest decision
 * can land above the in-sequence ceiling after an officer plants rows at the ceiling. The decision
 * readers must still deliver it on the publish that creates it, while the `cursor` each notice
 * carries stays a forward-safe resume cursor: a consumer that forwards the last notice's cursor
 * (Voter advanceReassociation, ConfirmationScreen pollForNotice) must never skip a later decision.
 */

import { expect } from 'chai'
import {
  insertWithCursorRetry,
  STAGING_CURSOR_MAX_STEP,
  STAGING_CURSOR_MAX_TEXT
} from '../src/registration/transport/p2p-staging-seam.js'
import type { StagingSqlPort, StagingCursorTable } from '../src/registration/transport/p2p-staging-seam.js'
import { P2pRegistrationTransport } from '../src/registration/transport/p2p-registration-transport.js'
import type { RegistrationStrandPort } from '../src/registration/transport/p2p-registration-transport.js'
import { P2pAssociationTransport } from '../src/association/transport/p2p-association-transport.js'
import type { AssociationStrandPort } from '../src/association/transport/p2p-association-transport.js'
import { digestToBytes, nowCanonicalDatetime } from '../src/utils.js'
import { toIsoZDatetime } from '../src/signing/ceremony-helpers.js'
import { createP2pStagingFixture } from './fixtures/p2p-staging-fixture.js'
import type { P2pStagingFixture } from './fixtures/p2p-staging-fixture.js'

const CAP = STAGING_CURSOR_MAX_TEXT
const pad = (n: number | bigint): string => String(n).padStart(16, '0')
const unreadableOpener = { open: async () => ({ ok: false as const, reason: 'not-a-recipient', detail: '' }) }

/** In-memory decision strand: models the (StrandId, Cursor) unique index and the decision SELECT. */
class DecisionPort implements StagingSqlPort, RegistrationStrandPort, AssociationStrandPort {
  constructor (readonly cursors: string[]) {}

  private rowFor (cursor: string): Record<string, unknown> {
    return {
      Cursor: cursor,
      RequestId: `req-${cursor}`,
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
    if (/count\(\*\)/.test(sql)) return [{ RowCount: this.cursors.length } as unknown as T]
    if (/order by Cursor asc limit 64/.test(sql)) {
      const after = params.afterCursor as string
      const cap = params.capCursor as string
      return this.cursors.filter((c) => c > after && c <= cap).sort().slice(0, 64).map((c) => ({ Cursor: c }) as unknown as T)
    }
    if (/order by Cursor desc limit 64/.test(sql)) {
      const ceiling = params.ceiling as string
      const before = params.beforeCursor as string | undefined
      return this.cursors
        .filter((c) => c <= ceiling && (before === undefined || c < before))
        .sort().reverse().slice(0, 64)
        .map((c) => ({ Cursor: c }) as unknown as T)
    }
    if (/Cursor = :cursor/.test(sql)) return this.cursors.filter((c) => c === params.cursor).map((c) => ({ Cursor: c }) as unknown as T)
    if (/:sinceCursor/.test(sql)) {
      const since = params.sinceCursor as string | null
      return this.cursors.filter((c) => since === null || c > since).sort().map((c) => this.rowFor(c) as unknown as T)
    }
    return []
  }

  async mutate (_sql: string, params: Record<string, unknown>): Promise<void> {
    const cursor = params.cursor as string
    if (this.cursors.includes(cursor)) throw new Error('UNIQUE constraint failed: (StrandId, Cursor)')
    this.cursors.push(cursor)
  }

  async close (): Promise<void> {}
  describe (): string { return 'DecisionPort' }
}

function reg (port: DecisionPort): P2pRegistrationTransport {
  return new P2pRegistrationTransport({
    openStrand: async () => port, computeDigest: async () => new Uint8Array(32), strandId: 's', opener: unreadableOpener
  })
}
function assoc (port: DecisionPort): P2pAssociationTransport {
  return new P2pAssociationTransport({
    openStrand: async () => port,
    computeDigest: async () => new Uint8Array(32),
    computeAttestationDigest: async () => new Uint8Array(32),
    strandId: 's',
    opener: unreadableOpener
  } as never)
}

async function allocate (port: DecisionPort, table: StagingCursorTable): Promise<string> {
  const out = await insertWithCursorRetry(port, {
    table,
    strandId: 's',
    insertSql: 'insert into x',
    params: {},
    identity: { sql: 'select 1 where StrandId = :strandId and RequestId = :requestId', params: { strandId: 's', requestId: 'r' } },
    onIdentityConflict: () => 'idempotent',
    where: 'test'
  })
  return out.cursor
}

/** Mirrors Voter advanceReassociation / ConfirmationScreen pollForNotice: forward the last notice's cursor. */
async function forwardPoll (
  poll: (cursor?: string) => Promise<Array<{ requestId: string, cursor: string }>>,
  start: string | undefined
): Promise<{ requestIds: string[], cursor: string | undefined }> {
  let cursor = start
  const requestIds: string[] = []
  for (const notice of await poll(cursor)) {
    requestIds.push(notice.requestId)
    cursor = notice.cursor
  }
  return { requestIds, cursor }
}

describe('decision readers deliver walked decisions without skipping (62-43, WR-01)', function () {
  this.timeout(240_000)

  async function hiddenCounts (
    table: 'RegistrationDecision' | 'AssociationDecision',
    k: number
  ): Promise<{ polled: number[], records: number[] }> {
    const port = new DecisionPort([])
    for (let i = 0; i < k; i++) port.cursors.push(pad(k + STAGING_CURSOR_MAX_STEP + i))
    const honest: string[] = []
    const polled: number[] = []
    const records: number[] = []
    for (let d = 0; d < 4; d++) {
      honest.push(`req-${await allocate(port, table)}`)
      const transport = table === 'RegistrationDecision' ? reg(port) : assoc(port)
      const seenPolled = (await transport.pollDecisions()).map((n) => n.requestId)
      const seenRecords = (await transport.readDecisionRecords()).map((n) => n.requestId)
      polled.push(honest.filter((id) => !seenPolled.includes(id)).length)
      records.push(honest.filter((id) => !seenRecords.includes(id)).length)
    }
    return { polled, records }
  }

  it('V1a CONTROL k = 0: every honest registration decision is visible on the publish that creates it', async () => {
    const out = await hiddenCounts('RegistrationDecision', 0)
    expect(out.polled).to.deep.equal([0, 0, 0, 0])
    expect(out.records).to.deep.equal([0, 0, 0, 0])
  })

  it('V1b k = 2 officer-forged registration decisions at the ceiling hide no honest decision', async () => {
    const out = await hiddenCounts('RegistrationDecision', 2)
    expect(out.polled, 'pollDecisions hidden counts').to.deep.equal([0, 0, 0, 0])
    expect(out.records, 'readDecisionRecords hidden counts').to.deep.equal([0, 0, 0, 0])
  })

  it('V1c k = 5 officer-forged registration decisions at the ceiling hide no honest decision', async () => {
    const out = await hiddenCounts('RegistrationDecision', 5)
    expect(out.polled, 'pollDecisions hidden counts').to.deep.equal([0, 0, 0, 0])
    expect(out.records, 'readDecisionRecords hidden counts').to.deep.equal([0, 0, 0, 0])
  })

  it('V2 k = 2 officer-forged association decisions at the ceiling hide no honest decision', async () => {
    const out = await hiddenCounts('AssociationDecision', 2)
    expect(out.polled, 'pollDecisions hidden counts').to.deep.equal([0, 0, 0, 0])
    expect(out.records, 'readDecisionRecords hidden counts').to.deep.equal([0, 0, 0, 0])
  })

  it('V3 forwarding the last notice cursor never skips a later decision past a far-high forged row', async () => {
    const port = new DecisionPort([pad(1), CAP])
    const transport = reg(port)
    const first = await forwardPoll(async (c) => await transport.pollDecisions(c), undefined)
    expect(first.cursor).to.equal(pad(1))
    const honest = await allocate(port, 'RegistrationDecision')
    expect(honest).to.equal(pad(2))
    const second = await forwardPoll(async (c) => await transport.pollDecisions(c), first.cursor)
    expect(second.requestIds).to.include(`req-${honest}`)
  })

  it('V4 forwarding with a walked honest decision: delivered at once, forwarded cursor stays in sequence', async () => {
    const port = new DecisionPort([pad(2 + STAGING_CURSOR_MAX_STEP), pad(3 + STAGING_CURSOR_MAX_STEP)])
    const transport = reg(port)
    const h1 = await allocate(port, 'RegistrationDecision')
    expect(h1).to.equal(pad(1004))
    const first = await forwardPoll(async (c) => await transport.pollDecisions(c), undefined)
    expect(first.requestIds).to.include(`req-${h1}`)
    expect(first.cursor !== undefined && first.cursor <= pad(1003)).to.equal(true)
    const h2 = await allocate(port, 'RegistrationDecision')
    expect(h2).to.equal(pad(1005))
    const second = await forwardPoll(async (c) => await transport.pollDecisions(c), first.cursor)
    expect(second.requestIds).to.include(`req-${h2}`)
  })

  it('V6 a lone above-ceiling decision is delivered with the re-read sentinel cursor', async () => {
    const port = new DecisionPort([CAP])
    const notices = await reg(port).pollDecisions()
    expect(notices.map((n) => n.requestId)).to.deep.equal([`req-${CAP}`])
    expect(notices[0]?.cursor).to.equal('0000000000000000')
    const again = await reg(port).pollDecisions('0000000000000000')
    expect(again.map((n) => n.requestId)).to.deep.equal([`req-${CAP}`])
  })

  describe('real strand', () => {
    let fixture: P2pStagingFixture
    before(async () => {
      fixture = await createP2pStagingFixture()
    })

    /** An officer-signed raw RegistrationDecision at an arbitrary cursor (what any `vrg` officer can write). */
    async function forgeDecision (strandId: string, cursor: string): Promise<void> {
      const requestId = `forged-${crypto.randomUUID()}`
      const authorityId = fixture.auth.authority.id
      const decidedAt = toIsoZDatetime(Date.now())
      const digestRow = await fixture.db
        .prepare("select Digest('RegistrationDecision', :strandId, :requestId, :authorityId, :status, :reason, :closesRequestId, :decidedAt) as d")
        .get({ strandId, requestId, authorityId, status: 'a', reason: null, closesRequestId: null, decidedAt })
      const sig = await fixture.decisionSigner.sign(digestToBytes(digestRow?.d as string))
      await fixture.db.exec(
        `insert into RegistrationDecision (StrandId, Cursor, RequestId, AuthorityId, Status, Reason, ClosesRequestId, DecidedAt, DeciderKey, DeciderSignature)
         with context now = :now
         values (:strandId, :cursor, :requestId, :authorityId, :status, :reason, :closesRequestId, :decidedAt, :deciderKey, :deciderSignature)`,
        { strandId, cursor, requestId, authorityId, status: 'a', reason: null, closesRequestId: null, decidedAt, deciderKey: sig.signerKey, deciderSignature: sig.signature, now: nowCanonicalDatetime() }
      )
    }

    it('V5 an honest publishDecision above two forged officer rows is delivered at once by both readers', async () => {
      const strandId = `decision-visibility-${crypto.randomUUID()}`
      await forgeDecision(strandId, pad(2 + STAGING_CURSOR_MAX_STEP))
      await forgeDecision(strandId, pad(3 + STAGING_CURSOR_MAX_STEP))
      const transport = new P2pRegistrationTransport({
        openStrand: async () => fixture.makePort() as unknown as RegistrationStrandPort,
        computeDigest: async (init, key) => await fixture.fixtureRequestDigest(init, key),
        strandId,
        sealer: fixture.sealer,
        opener: fixture.opener,
        decisionSigner: fixture.decisionSigner
      })
      const honestId = `honest-${crypto.randomUUID()}`
      const cursor = await transport.publishDecision({ requestId: honestId, status: 'a', decidedAt: new Date().toISOString() })
      expect(cursor).to.equal('0000000000001004')
      const notice = (await transport.pollDecisions()).find((n) => n.requestId === honestId)
      expect(notice, 'pollDecisions delivers the honest decision').to.not.equal(undefined)
      expect(notice?.cursor !== undefined && notice.cursor <= '0000000000001003').to.equal(true)
      const record = (await transport.readDecisionRecords()).find((r) => r.requestId === honestId)
      expect(record, 'readDecisionRecords delivers the honest decision').to.not.equal(undefined)
      expect(record?.cursor !== undefined && record.cursor <= '0000000000001003').to.equal(true)
    })
  })
})
