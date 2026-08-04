import type { RegistrantListFilter } from '@votetorrent/vote-core'

/**
 * D-05/D-06: the SINGLE shared predicate builder feeding BOTH
 * `buildRegistrantListPageSql` and `buildRegistrantListCountSql`. Both derive
 * their FROM and WHERE text from `buildRegistrantListFragment` and neither
 * may ever assemble either clause independently — a drifted count predicate
 * would report a total for a different filter than the page it accompanies
 * (D-05/T-47-09), and a drifted currency predicate would silently serve
 * stale registrant data (D-06/T-47-08). This module is pure, DB-free, and
 * ctx-free — a plain SQL-construction utility.
 */

/**
 * D-06 currency predicate. `RegistrantPublic` is `InsertOnly` with PK
 * `(RegistrantId, Cid)`, so a registrant accumulates one row per public-tier
 * revision and only the one whose Cid column equals the parent's PublicCid
 * column is current; the second join condition below carries that equality
 * and must never be reduced to just the RegistrantId equality alone — a join
 * missing that second condition still runs, still renders, and still passes
 * a single-row fixture while silently serving stale district/name data. This
 * constant is the ONLY place that predicate is written out in
 * `packages/vote-engine/src` (excluding the generated `schema-sql.ts`).
 *
 * It is a `left join` (not `inner`) so a registrant with no public tier —
 * `Registrant.PublicCid` is nullable — still appears in the roster with
 * `lastName`/`firstName`/`district` undefined, which 47-11 renders via its
 * truncated-`Registrant.Id` fallback.
 */
export const REGISTRANT_PUBLIC_CURRENCY_JOIN =
  'left join RegistrantPublic RP on RP.RegistrantId = R.Id and RP.Cid = R.PublicCid'

export const REGISTRANT_LIST_DEFAULT_PAGE_SIZE = 50
export const REGISTRANT_LIST_MAX_PAGE_SIZE = 200

/**
 * Clamp a caller-supplied page size to a bounded integer. Its return value is
 * interpolated directly into the `limit` clause, so this is a security
 * boundary, not a convenience: it must always yield a bounded integer.
 */
export function clampPageSize (requested?: number): number {
  if (requested === undefined || !Number.isFinite(requested)) {
    return REGISTRANT_LIST_DEFAULT_PAGE_SIZE
  }
  return Math.min(REGISTRANT_LIST_MAX_PAGE_SIZE, Math.max(1, Math.trunc(requested)))
}

export interface RegistrantListSqlFragment {
  from: string
  where: string
  params: Record<string, unknown>
}

/**
 * The single shared predicate builder. Emits NO cursor predicate, NO
 * `order by`, NO `limit`, and NO select list — those are assembled by
 * `buildRegistrantListPageSql`/`buildRegistrantListCountSql` around this
 * fragment's `from`/`where` text.
 */
export function buildRegistrantListFragment (filter?: RegistrantListFilter): RegistrantListSqlFragment {
  const params: Record<string, unknown> = {}

  let from = `from Registrant R ${REGISTRANT_PUBLIC_CURRENCY_JOIN}`
  if (filter?.electionId !== undefined) {
    // Inner (not left) because the join exists solely to narrow membership (D-07).
    from += ' inner join ElectionRegistrant ER on ER.RegistrantId = R.Id and ER.ElectionId = :electionId'
    params.electionId = filter.electionId
  }

  let where = 'where 1 = 1'
  if (filter?.authorityId !== undefined) {
    where += ' and R.AuthorityId = :authorityId'
    params.authorityId = filter.authorityId
  }
  if (filter?.status !== undefined) {
    where += ' and R.Status = :status'
    params.status = filter.status
  }
  if (filter?.expiringBefore !== undefined) {
    where += ' and R.Expiration < :expiringBefore'
    params.expiringBefore = filter.expiringBefore
  }
  if (filter?.expiringAfter !== undefined) {
    where += ' and R.Expiration > :expiringAfter'
    params.expiringAfter = filter.expiringAfter
  }
  if (filter?.district !== undefined) {
    where += ' and RP.District = :district'
    params.district = filter.district
  }
  if (filter?.name !== undefined) {
    // D-04/RESEARCH-Open-Question-2: no `escape` clause — a documented omission.
    where += ' and (RP.LastName like :nameQuery or RP.FirstName like :nameQuery)'
    params.nameQuery = `%${filter.name}%`
  }

  return { from, where, params }
}

/**
 * The page query. Keyset cursor rides `Registrant.Id`, the table's PK
 * (D-05), so the scan is an ordered PK range, not a full table scan.
 */
export function buildRegistrantListPageSql (
  filter: RegistrantListFilter | undefined,
  cursor: string | undefined,
  pageSize: number
): { sql: string; params: Record<string, unknown> } {
  const fragment = buildRegistrantListFragment(filter)
  const selectList =
    'select R.Id, R.AuthorityId, R.Status, R.Expiration, R.PrivateCid, R.PublicCid, R.SelectiveCid, RP.LastName, RP.FirstName, RP.District '
  let sql = selectList + fragment.from + ' ' + fragment.where
  const params: Record<string, unknown> = { ...fragment.params }
  if (cursor !== undefined) {
    sql += ' and R.Id > :cursor'
    params.cursor = cursor
  }
  sql += ` order by R.Id asc limit ${clampPageSize(pageSize)}`
  return { sql, params }
}

/**
 * The count query. No cursor, no `order by`, no `limit`. Uses a derived-table
 * form — `from (select R.Id …) as RegistrantMatch` — which is provably
 * equivalent to a flat `select count(*) … from Registrant R …` here because
 * both joins match at most one row per registrant (`RegistrantPublic` PK
 * `(RegistrantId, Cid)` against a single `R.PublicCid` value;
 * `ElectionRegistrant` PK `(ElectionId, RegistrantId)` against a single
 * `:electionId`), so no row multiplication is possible.
 */
export function buildRegistrantListCountSql (filter?: RegistrantListFilter): { sql: string; params: Record<string, unknown> } {
  const fragment = buildRegistrantListFragment(filter)
  const sql = `select count(*) as n from (select R.Id ${fragment.from} ${fragment.where}) as RegistrantMatch`
  return { sql, params: fragment.params }
}
