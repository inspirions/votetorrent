import type { RegistrationRequestListFilter, RegistrationRequestStatus } from '@votetorrent/vote-core'

/**
 * D-06/D-08/D-09 (Phase 48 plan 08): the SINGLE shared predicate builder
 * feeding `buildRegistrationRequestListPageSql` and
 * `buildRegistrationRequestListCountSql`, mirroring
 * `registrant-list-query.ts`'s module shape and its own "one shared
 * fragment, never two independently-assembled clauses" argument verbatim —
 * a drifted count predicate would report a total for a different filter
 * than the page it accompanies, and (here specifically) a drifted keyset
 * predicate would silently page wrong. This module is pure, DB-free, and
 * ctx-free — a plain SQL-construction utility.
 *
 * ORDER KEY (T-48-08-11): the triage queue orders by `ReceivedAt` — the
 * AUTHORITY's own intake observation, written by 48-07 with
 * `toIsoZDatetime` and inside NO digest (not DG-1, not DG-2, not DG-4) —
 * and NEVER by `SubmittedAt`, which is submitter-supplied (48-02 L-3) and
 * rides inside DG-1. Ordering a triage queue on a value the submitter
 * chooses is a self-serve priority channel into an officer's attention:
 * backdate the field, jump the queue, with the backdated claim sitting
 * INSIDE a validly-signed row so nothing downstream looks wrong. This
 * supersedes this plan's own original oldest-`submittedAt`-first wording —
 * 48-05 recorded that supersession explicitly. Do not "restore" the
 * `SubmittedAt` ordering.
 *
 * The status/issuer literals used below are sourced from the vote-core
 * `RegistrationRequestStatus` union (imported), not re-declared as bare
 * strings in more than one place in this module.
 */

/** The one status code this module hard-codes a literal for — type-checked against the vote-core union so a typo is a compile error, not a silent no-op filter. */
const STATUS_PENDING: RegistrationRequestStatus = 'p'
const STATUS_APPROVED: RegistrationRequestStatus = 'a'
const STATUS_REJECTED: RegistrationRequestStatus = 'r'

export { STATUS_PENDING, STATUS_APPROVED, STATUS_REJECTED }

export const REGISTRATION_REQUEST_LIST_DEFAULT_PAGE_SIZE = 50
export const REGISTRATION_REQUEST_LIST_MAX_PAGE_SIZE = 200

/**
 * Clamp a caller-supplied page size to a bounded integer. Its return value
 * is interpolated directly into the `limit` clause, so this is a security
 * boundary, not a convenience: it must always yield a bounded integer.
 * Deliberately a SEPARATE constant/function pair from
 * `registrant-list-query.ts`'s `clampPageSize` (the engine reuses THAT one
 * for `listRegistrationRequests`'s page-size argument per the plan's "reuse
 * clampPageSize, second paging scheme risk" instruction) — this local copy
 * exists only so the `limit` clause below is self-contained and independently
 * bounded even if a caller bypasses the engine's own clamp.
 */
function clampRegistrationRequestPageSize (requested: number): number {
  if (!Number.isFinite(requested)) return REGISTRATION_REQUEST_LIST_DEFAULT_PAGE_SIZE
  return Math.min(REGISTRATION_REQUEST_LIST_MAX_PAGE_SIZE, Math.max(1, Math.trunc(requested)))
}

interface RegistrationRequestListSqlFragment {
  from: string
  where: string
  params: Record<string, unknown>
}

/**
 * The private shared where-fragment. Emits NO cursor predicate, NO
 * `order by`, NO `limit`, and NO select list — those are assembled by
 * `buildRegistrationRequestListPageSql`/`buildRegistrationRequestListCountSql`
 * around this fragment's `from`/`where` text. Deliberately NOT exported —
 * the page and count builders below are this module's only public surface
 * over filter semantics, so a filter dimension can never be added to one
 * without the other.
 */
function buildRegistrationRequestListFragment (filter?: RegistrationRequestListFilter): RegistrationRequestListSqlFragment {
  const params: Record<string, unknown> = {}
  const from = 'from RegistrationRequest R'
  let where = 'where 1 = 1'

  if (filter?.authorityId !== undefined) {
    where += ' and R.AuthorityId = :authorityId'
    params.authorityId = filter.authorityId
  }
  if (filter?.status !== undefined) {
    where += ' and R.Status = :status'
    params.status = filter.status
  }
  if (filter?.issuerType !== undefined) {
    where += ' and R.IssuerType = :issuerType'
    params.issuerType = filter.issuerType
  }
  if (filter?.name !== undefined) {
    // WR-12. The previous predicate was `R.Payload like '%<name>%'` — a raw substring match over
    // the WHOLE serialized RegisterInit, private tier included. That made the inbox search box an
    // ORACLE over the private tier: typing a candidate SSN, date of birth or phone number
    // confirmed or denied its presence in a pending request, defeating the never-log/never-
    // disclose discipline the rest of this phase maintains around `private.details`. It also
    // matched ids, keys, cids and timestamps — any of which could make an unrelated request
    // surface under a name search.
    //
    // The predicate is now restricted to the PUBLIC tier's two name fields, read structurally via
    // `json_extract` (the same `cast(json_extract(...) as text)` idiom votetorrent.qsql already
    // uses for `SlotCidValid`; the cast is required because json_extract's JSON-typed return is
    // not directly comparable). A missing path, a malformed Payload or a non-string value all
    // yield `null` rather than throwing, so such a row is simply excluded — a request whose
    // payload will not parse must not crash the officer's inbox.
    //
    // `instr(lower(...), lower(:nameQuery)) > 0` replaces `like` deliberately, and it closes the
    // second half of WR-12 at the same time: `like`'s `%`/`_` are wildcards, and Quereus does NOT
    // support the `escape` clause (re-confirmed by probe against the installed engine — the same
    // finding this module's previous comment recorded as D-04/RESEARCH-Open-Question-2), so an
    // unescaped bound term containing `%` silently broadened the query and no escape mechanism
    // existed to fix it in place. `instr` has no metacharacters at all, so the search term matches
    // literally and there is nothing to escape. `lower(...)` on both sides makes the match
    // case-insensitive, which also brings this read into parity with
    // `MockRegistrationEngine.listRegistrationRequests` — that mock already filtered
    // case-insensitively on exactly these two public fields, so the mock was right and the real
    // engine was the surface that disagreed.
    //
    // One documented limitation is unchanged: RegistrationRequest carries no denormalized
    // LastName/FirstName column (unlike RegistrantPublic on the roster read), so this remains an
    // unindexed per-row JSON read. A generated column populated at INSERT is still the obvious
    // future improvement.
    where +=
      " and (instr(lower(cast(json_extract(R.Payload, '$.public.lastName') as text)), lower(:nameQuery)) > 0" +
      " or instr(lower(cast(json_extract(R.Payload, '$.public.firstName') as text)), lower(:nameQuery)) > 0)"
    params.nameQuery = filter.name
  }

  return { from, where, params }
}

/**
 * The triage page query. Selected columns include BOTH `SubmittedAt` (the
 * requester's claim) and `ReceivedAt` (the authority's observation, and the
 * order key) — the row is sorted by one and displays the other beside it,
 * so a divergence between what a requester claimed and what the authority
 * observed is visible rather than silently collapsed (48-05's
 * `RegistrationRequestListRow` contract). Never render one as the other.
 *
 * `left join` on `RegistrationBridgeKey` (not `inner`) — a registrant-issued
 * row has a null `BridgeId` and must still appear in the queue, with
 * `BridgeLabel` undefined.
 *
 * ORDER KEY — `order by R.ReceivedAt asc, R.Id asc`:
 *   - vs `Id`: the cursor is still a plain row id (Phase 47's contract,
 *     unchanged), but two rows CAN share a `ReceivedAt`, so the `Id`
 *     tiebreak is load-bearing — without it a page boundary landing inside
 *     a same-timestamp group silently drops or repeats rows.
 *   - vs `SubmittedAt`: see this module's header comment (T-48-08-11). Do
 *     NOT "restore" the `SubmittedAt` ordering; it was superseded
 *     deliberately.
 *
 * KEYSET PREDICATE — the expanded two-branch form, BOTH branches keyed on
 * the observed intake column: "received-after OR (received-equal AND
 * id-after)" (see the exact bind names in the implementation below). A
 * predicate that still compares `SubmittedAt` while the `order by` compares
 * `ReceivedAt` typechecks
 * perfectly and pages WRONG — it silently drops and repeats rows at every
 * page boundary, and nothing in the type system will ever catch it. This is
 * the single easiest place in this module to leave a half-migration.
 *
 * Deliberately NO row-value tuple comparison and NO correlated scalar
 * subquery for the cursor's own `ReceivedAt` — the caller (the engine)
 * resolves `cursorReceivedAt` with its own point read and binds it here,
 * which keeps this builder free of any Quereus expression-support gamble.
 */
export function buildRegistrationRequestListPageSql (
  filter: RegistrationRequestListFilter | undefined,
  cursor: string | undefined,
  cursorReceivedAt: string | undefined,
  pageSize: number
): { sql: string; params: Record<string, unknown> } {
  const fragment = buildRegistrationRequestListFragment(filter)
  const selectList =
    'select R.Id, R.AuthorityId, R.Status, R.IssuerType, R.BridgeId, R.SubmittedAt, R.ReceivedAt, R.RequesterKey, R.Payload, B.Label as BridgeLabel '
  let sql = selectList + fragment.from + ' left join RegistrationBridgeKey B on B.Id = R.BridgeId ' + fragment.where
  const params: Record<string, unknown> = { ...fragment.params }

  if (cursor !== undefined) {
    sql += ' and (R.ReceivedAt > :cursorReceivedAt or (R.ReceivedAt = :cursorReceivedAt and R.Id > :cursor))'
    params.cursor = cursor
    params.cursorReceivedAt = cursorReceivedAt
  }

  sql += ` order by R.ReceivedAt asc, R.Id asc limit ${clampRegistrationRequestPageSize(pageSize)}`
  return { sql, params }
}

/**
 * The count query. No cursor, no `order by`, no `limit`, no join — the
 * SAME where fragment as the page query, so the count can never drift from
 * the page it accompanies onto a different filter.
 */
export function buildRegistrationRequestListCountSql (filter?: RegistrationRequestListFilter): { sql: string; params: Record<string, unknown> } {
  const fragment = buildRegistrationRequestListFragment(filter)
  const sql = `select count(*) as n ${fragment.from} ${fragment.where}`
  return { sql, params: fragment.params }
}

/**
 * D-06: a single grouped query over rejected rows only, backing every page
 * row's `hasPriorRejections` without a per-row subquery (T-48-08-06). Scoped
 * to `filter.authorityId` when supplied so it can never count a rejection
 * that belongs to a different authority into this page's flags.
 */
export function buildPriorRejectionCountSql (filter?: RegistrationRequestListFilter): { sql: string; params: Record<string, unknown> } {
  const params: Record<string, unknown> = { status: STATUS_REJECTED }
  let sql = 'select R.RequesterKey as k, count(*) as n from RegistrationRequest R where R.Status = :status'
  if (filter?.authorityId !== undefined) {
    sql += ' and R.AuthorityId = :authorityId'
    params.authorityId = filter.authorityId
  }
  sql += ' group by R.RequesterKey'
  return { sql, params }
}
