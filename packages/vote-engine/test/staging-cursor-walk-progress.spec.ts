/**
 * staging-cursor-walk-progress.spec.ts — 62-41 (CR-01, V-4, D-05, D-06, D-19, D-24, IN-05).
 *
 * The 62-38 upward walk in `insertWithCursorRetry` re-queried from the candidate, which never
 * moves when a full 64-row page holds only non-conforming cursors. These cases pin that the walk
 * pages by the last row seen, is bounded to the conforming range, and fails closed on a page that
 * does not advance. Every port here carries a query budget so a regression ends in a 'HANG' error
 * instead of hanging mocha.
 */

import { expect } from 'chai'
import {
  insertWithCursorRetry,
  P2pStagingError,
  STAGING_CURSOR_MAX_TEXT
} from '../src/registration/transport/p2p-staging-seam.js'
import type { StagingSqlPort, StagingCursorTable } from '../src/registration/transport/p2p-staging-seam.js'

const DEFAULT_BUDGET = 5000
const pad = (n: number): string => String(n).padStart(16, '0')

/** In-memory port with a query budget; models the (StrandId, Cursor) unique index. */
class BudgetPort implements StagingSqlPort {
  queries = 0
  mutates = 0
  constructor (
    readonly cursors: string[],
    private readonly budget: number = DEFAULT_BUDGET,
    private readonly rowCountOverride?: number
  ) {}

  protected ascending (params: Record<string, unknown>): string[] {
    const sorted = [...this.cursors].sort()
    if (typeof params.afterCursor === 'string') {
      const after = params.afterCursor
      const cap = typeof params.capCursor === 'string' ? params.capCursor : undefined
      return sorted.filter((c) => c > after && (cap === undefined || c <= cap)).slice(0, 64)
    }
    const from = params.fromCursor as string
    return sorted.filter((c) => c >= from).slice(0, 64)
  }

  async query<T> (sql: string, params: Record<string, unknown>): Promise<T[]> {
    this.queries += 1
    if (this.queries > this.budget) throw new Error(`HANG: query budget ${this.budget} exceeded`)
    if (/count\(\*\)/.test(sql)) return [{ RowCount: this.rowCountOverride ?? this.cursors.length } as unknown as T]
    if (/order by Cursor asc limit 64/.test(sql)) return this.ascending(params).map((c) => ({ Cursor: c }) as unknown as T)
    if (/order by Cursor desc limit 64/.test(sql)) {
      const ceiling = params.ceiling as string
      const before = params.beforeCursor as string | undefined
      return [...this.cursors]
        .filter((c) => c <= ceiling && (before === undefined || c < before))
        .sort()
        .reverse()
        .slice(0, 64)
        .map((c) => ({ Cursor: c }) as unknown as T)
    }
    if (/Cursor = :cursor/.test(sql)) return this.cursors.filter((c) => c === params.cursor).map((c) => ({ Cursor: c }) as unknown as T)
    throw new Error(`BudgetPort: unexpected query ${sql}`)
  }

  async mutate (_sql: string, params: Record<string, unknown>): Promise<void> {
    this.mutates += 1
    const cursor = params.cursor as string
    if (this.cursors.includes(cursor)) throw new Error('UNIQUE constraint failed: (StrandId, Cursor)')
    this.cursors.push(cursor)
  }

  async close (): Promise<void> {}
  describe (): string { return 'budget' }
}

/** Ignores every lower bound: always returns the first 64 rows, so it can never advance. */
class NonAdvancingPort extends BudgetPort {
  protected override ascending (_params: Record<string, unknown>): string[] {
    return [...this.cursors].filter((c) => !/^\d{16}$/.test(c)).sort().slice(0, 64)
  }
}

async function allocateOn (port: StagingSqlPort, table: StagingCursorTable): Promise<string> {
  const out = await insertWithCursorRetry(port, {
    table,
    strandId: 's',
    insertSql: 'insert',
    params: {},
    identity: { sql: 'select identity', params: {} },
    onIdentityConflict: () => 'idempotent',
    where: 'walk-progress'
  })
  return out.cursor
}

const HONEST = [pad(1), pad(2)]
const nines = (n: number): string[] =>
  Array.from({ length: n }, (_, i) => (BigInt('9999999999999999') - BigInt(i)).toString())
const nonDigit = (n: number): string[] => Array.from({ length: n }, (_, i) => `zzzzzzzzzzzz${String(i).padStart(4, '0')}`)
const legacyInRange = (n: number): string[] =>
  Array.from({ length: n }, (_, i) => `000000000000${String(i).padStart(3, '0')}x`)

describe('staging cursor walk always makes progress (62-41, CR-01)', () => {
  it('H0: the instrument rejects past its budget with HANG and models the unique index', async () => {
    const port = new BudgetPort([], 3)
    await port.query('select count(*)', {})
    await port.query('select count(*)', {})
    await port.query('select count(*)', {})
    let err = ''
    try { await port.query('select count(*)', {}) } catch (e) { err = (e as Error).message }
    expect(err).to.contain('HANG')
    const dup = new BudgetPort([pad(5)])
    let dupErr = ''
    try { await dup.mutate('insert', { cursor: pad(5) }) } catch (e) { dupErr = (e as Error).message }
    expect(dupErr).to.contain('UNIQUE')
  })

  it('H1: 64 above-cap 16-digit decision cursors do not stall allocation (the promoted review repro)', async () => {
    const port = new BudgetPort([...HONEST, ...nines(64)])
    expect(await allocateOn(port, 'RegistrationDecision')).to.equal(pad(3))
    expect(port.mutates).to.equal(1)
    expect(port.queries).to.be.at.most(4)
  })

  it('H2: 200 above-cap cursors cost the walk nothing (IN-05)', async () => {
    const port = new BudgetPort([...HONEST, ...nines(200)])
    expect(await allocateOn(port, 'RegistrationDecision')).to.equal(pad(3))
    expect(port.queries).to.be.at.most(4)
  })

  it('H3: 64 non-digit 16-character cursors on AssociationDecision do not stall allocation', async () => {
    const port = new BudgetPort([...HONEST, ...nonDigit(64)])
    expect(await allocateOn(port, 'AssociationDecision')).to.equal(pad(3))
    expect(port.mutates).to.equal(1)
  })

  it('H4: 70 in-range legacy non-conforming staging cursors do not stall allocation; cost is about k/64 pages (IN-05)', async () => {
    const port = new BudgetPort([...HONEST, ...legacyInRange(70)])
    expect(await allocateOn(port, 'RegistrationRequestStaging')).to.equal(pad(3))
    expect(port.mutates).to.equal(1)
    expect(port.queries).to.be.at.most(6)
  })

  it('H5: CONTROL, 63 above-cap cursors allocate 0000000000000003 (green before and after the fix)', async () => {
    const port = new BudgetPort([...HONEST, ...nines(63)])
    expect(await allocateOn(port, 'RegistrationDecision')).to.equal(pad(3))
  })

  it('H6: last-row paging still walks occupied conforming slots behind a full page of non-conforming rows', async () => {
    const wrongWidth = Array.from({ length: 70 }, (_, i) => pad(1000) + String(i).padStart(2, '0'))
    const port = new BudgetPort([pad(1000), ...wrongWidth, pad(1001), pad(1002)], DEFAULT_BUDGET, 0)
    expect(await allocateOn(port, 'RegistrationRequestStaging')).to.equal(pad(1003))
  })

  it('H7: a port that returns a non-advancing page makes the walk throw cursor-exhausted without mutating', async () => {
    const port = new NonAdvancingPort([...HONEST, ...legacyInRange(70)])
    let err: unknown
    try { await allocateOn(port, 'RegistrationRequestStaging') } catch (e) { err = e }
    expect(err, 'expected a throw').to.be.instanceOf(P2pStagingError)
    expect((err as P2pStagingError).message).to.not.contain('HANG')
    expect((err as P2pStagingError).code).to.equal('cursor-exhausted')
    expect(port.mutates).to.equal(0)
  })
})
