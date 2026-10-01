/**
 * evidence.ts — 62-18 Task 3 (D-45).
 *
 * Pure reads plus opener calls — no writes, no logging. A re-association's registration code or
 * identity fields are matched OFFICER-SIDE, after decrypt (the opened registration payload is a
 * pre-existing plaintext, T-62-01-10, referenced here and never widened), never by a SQL query
 * over ciphertext (research's own "don't hand-roll a SQL-visible match" ruling). Performance is
 * one envelope open per approved registration per call — a documented residual, not a cache
 * across calls: `cache` is created fresh by every PUBLIC entry point in `driver.ts` and dropped
 * at the end of that call, so an opened plaintext never outlives the request that needed it.
 */

import type { Database } from '@quereus/quereus'
import { REASSOCIATION_MAX_CANDIDATES, registrationCodesEqual } from '@votetorrent/vote-core'
import type { AssociationIdentityField, PrivateDetail, ReassociationCandidate, ReassociationOpener, RegisterInit } from '@votetorrent/vote-core'
import { decodeStagingPlaintext } from '../../registration/transport/p2p-staging-seam.js'
import { asText, parseJsonOr } from '../../utils.js'

/** One approved registration, resolved to its ALREADY-active registrant. */
export interface ApprovedRegistration {
  readonly requestId: string
  readonly registrantId: string
  readonly payload: RegisterInit
}

/** `openRegistrationCode`'s own tiny result union — never re-exports the code itself beyond this
 * module's own return value; callers compare via `registrationCodesEqual`, never read it raw. */
export type OpenedCode = { readonly status: 'code'; readonly code: string } | { readonly status: 'unverifiable' }

/**
 * Every `RegistrationRequest` of `authorityId` that is approved (`Status = 'a'`) AND whose
 * `Payload.registrant.id` still names a currently-active `Registrant` row. Two passes: the first
 * collects candidate (requestId, payload) pairs from one `db.eval` cursor; the second probes each
 * registrant's current status via its own `db.prepare(...).get(...)` call — never nested inside
 * the still-open eval cursor (this codebase's own established discipline for that reason).
 */
export async function listApprovedRegistrations (db: Database, authorityId: string): Promise<ApprovedRegistration[]> {
  const candidates: Array<{ requestId: string; registrantId: string; payload: RegisterInit }> = []
  for await (const row of db.eval(
    "select Id, Payload from RegistrationRequest where AuthorityId = :rowAuthorityId and Status = 'a'",
    { rowAuthorityId: authorityId }
  )) {
    const requestId = asText(row.Id, 'RegistrationRequest.Id')
    const payload = parseJsonOr<RegisterInit | undefined>(row.Payload, undefined, 'RegistrationRequest.Payload')
    const registrantId = payload?.registrant?.id
    if (typeof registrantId !== 'string' || registrantId.length === 0 || payload === undefined) continue
    candidates.push({ requestId, registrantId, payload })
  }

  const out: ApprovedRegistration[] = []
  for (const candidate of candidates) {
    const activeRow = await db
      .prepare("select 1 as x from Registrant where Id = :registrantId and Status = 'a'")
      .get({ registrantId: candidate.registrantId })
    if (!activeRow) continue
    out.push(candidate)
  }
  return out
}

/**
 * Opens `requestId`'s own `RegistrationRequestStaging` row and extracts its sealed registration
 * code. `'unverifiable'` covers every failure mode uniformly (no staging row — REST bridge or
 * filesystem import, 62-01's documented limit; the opener refuses; the decoded plaintext fails
 * version/id/shape checks) — none of them distinguish "wrong code" from "cannot check the code
 * at all", which is exactly why they route to manual review (D-46) rather than a silent denial.
 */
export async function openRegistrationCode (db: Database, opener: ReassociationOpener, requestId: string): Promise<OpenedCode> {
  const row = await db
    .prepare('select Digest, InitJson from RegistrationRequestStaging where RequestId = :requestId')
    .get({ requestId })
  if (!row) return { status: 'unverifiable' }

  const digest = asText(row.Digest, 'RegistrationRequestStaging.Digest')
  const initJson = asText(row.InitJson, 'RegistrationRequestStaging.InitJson')
  const opened = await opener.open(initJson, { requestId, digest })
  if (!opened.ok) return { status: 'unverifiable' }

  const decoded = decodeStagingPlaintext(opened.plaintext) as
    { readonly version?: unknown; readonly init?: { readonly id?: unknown }; readonly registrationCode?: unknown } | undefined
  if (
    decoded === undefined || decoded === null || typeof decoded !== 'object' ||
    decoded.version !== 1 ||
    decoded.init === null || typeof decoded.init !== 'object' ||
    (decoded.init as { id?: unknown }).id !== requestId ||
    typeof decoded.registrationCode !== 'string'
  ) {
    return { status: 'unverifiable' }
  }
  return { status: 'code', code: decoded.registrationCode }
}

async function openCached (db: Database, opener: ReassociationOpener, requestId: string, cache: Map<string, OpenedCode>): Promise<OpenedCode> {
  const cached = cache.get(requestId)
  if (cached !== undefined) return cached
  const opened = await openRegistrationCode(db, opener, requestId)
  cache.set(requestId, opened)
  return opened
}

/** Verifies `presented` against ONE registrant's own approved-registration code — 'unverifiable'
 * when that registrant has no resolvable registration in `approved`, or its staging row cannot be
 * opened/decoded. */
export async function verifyRegistrationCode (
  db: Database,
  opener: ReassociationOpener,
  presented: string,
  registrantId: string,
  approved: readonly ApprovedRegistration[],
  cache: Map<string, OpenedCode>
): Promise<'matched' | 'unmatched' | 'unverifiable'> {
  const reg = approved.find((a) => a.registrantId === registrantId)
  if (reg === undefined) return 'unverifiable'
  const opened = await openCached(db, opener, reg.requestId, cache)
  if (opened.status === 'unverifiable') return 'unverifiable'
  return registrationCodesEqual(presented, opened.code) ? 'matched' : 'unmatched'
}

/**
 * Scans every approved registration for one whose own code equals `presented`. Exactly one match
 * is `{outcome:'matched', registrantId}`. Zero matches while at least one row could not be
 * verified, or MORE than one match (an officer-visible ambiguity, D-45's guessing-oracle note),
 * is `{outcome:'unverifiable'}` — never auto-approved. Otherwise `{outcome:'unmatched'}`.
 */
export async function resolveRegistrantByCode (
  db: Database,
  opener: ReassociationOpener,
  presented: string,
  approved: readonly ApprovedRegistration[],
  cache: Map<string, OpenedCode>
): Promise<{ readonly outcome: 'matched'; readonly registrantId: string } | { readonly outcome: 'unmatched' | 'unverifiable' }> {
  let matchedRegistrantId: string | undefined
  let matchCount = 0
  let sawUnverifiable = false

  for (const reg of approved) {
    const opened = await openCached(db, opener, reg.requestId, cache)
    if (opened.status === 'unverifiable') {
      sawUnverifiable = true
      continue
    }
    if (registrationCodesEqual(presented, opened.code)) {
      matchedRegistrantId = reg.registrantId
      matchCount++
    }
  }

  if (matchCount === 1 && matchedRegistrantId !== undefined) return { outcome: 'matched', registrantId: matchedRegistrantId }
  if (matchCount > 1) return { outcome: 'unverifiable' }
  if (sawUnverifiable) return { outcome: 'unverifiable' }
  return { outcome: 'unmatched' }
}

function flattenPrivateDetails (details: readonly PrivateDetail[] | undefined, out: AssociationIdentityField[]): void {
  if (details === undefined) return
  for (const detail of details) {
    if (Array.isArray(detail.value)) {
      flattenPrivateDetails(detail.value, out)
    } else {
      out.push({ name: detail.name, value: String(detail.value) })
    }
  }
}

/** Flattens `public.firstName/lastName/district`, string-valued `public.extraFields`, and the
 * recursive `private.details` tree into one flat `{ name, value }[]` — an officer's side-by-side
 * comparison record, and the candidate-ranking input. Never includes a `selective`-tier value
 * (that tier commits salted leaves, not plain name/value pairs). */
export function identityRecordOf (payload: RegisterInit): AssociationIdentityField[] {
  const fields: AssociationIdentityField[] = []
  if (payload.public?.firstName !== undefined) fields.push({ name: 'firstName', value: payload.public.firstName })
  if (payload.public?.lastName !== undefined) fields.push({ name: 'lastName', value: payload.public.lastName })
  if (payload.public?.district !== undefined) fields.push({ name: 'district', value: payload.public.district })

  const extraFields = payload.public?.extraFields
  if (extraFields !== undefined && extraFields !== null && typeof extraFields === 'object') {
    for (const [name, value] of Object.entries(extraFields)) {
      if (typeof value === 'string') fields.push({ name, value })
    }
  }

  flattenPrivateDetails(payload.private?.details, fields)
  return fields
}

function normalizeFieldName (name: string): string {
  return name.trim().toLowerCase()
}

/** NFKC-normalizes, trims, collapses internal whitespace, and case-folds — so "José " and "jose"
 * (differently-composed accents, trailing space, case) compare equal. */
function normalizeFieldValue (value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase()
}

/**
 * Ranks every approved registrant by how many (name, value) pairs its own `identityRecordOf`
 * record shares with `fields` (the submitted identity evidence), keeps only registrants with at
 * least one match, sorts by match count descending then `registrantId` ascending (deterministic,
 * never an iteration-order artifact), and caps the result at `REASSOCIATION_MAX_CANDIDATES`.
 * Returns field NAMES only (never values) plus a best-effort `displayName` — an officer still has
 * to open `registrantRecord` (the full record) to actually compare values.
 */
export function rankIdentityCandidates (
  fields: readonly AssociationIdentityField[],
  approved: readonly ApprovedRegistration[]
): ReassociationCandidate[] {
  const submitted = new Map<string, string>()
  for (const field of fields) {
    submitted.set(normalizeFieldName(field.name), normalizeFieldValue(field.value))
  }

  const scored: Array<{ registrantId: string; count: number; matchedFieldNames: string[]; displayName?: string }> = []
  for (const reg of approved) {
    const record = identityRecordOf(reg.payload)
    const matchedFieldNames: string[] = []
    for (const field of record) {
      const submittedValue = submitted.get(normalizeFieldName(field.name))
      if (submittedValue !== undefined && submittedValue === normalizeFieldValue(field.value)) {
        matchedFieldNames.push(field.name)
      }
    }
    if (matchedFieldNames.length === 0) continue
    const nameParts = [reg.payload.public?.firstName, reg.payload.public?.lastName].filter((x): x is string => typeof x === 'string')
    scored.push({
      registrantId: reg.registrantId,
      count: matchedFieldNames.length,
      matchedFieldNames,
      displayName: nameParts.length > 0 ? nameParts.join(' ') : undefined
    })
  }

  scored.sort((a, b) => (b.count !== a.count ? b.count - a.count : (a.registrantId < b.registrantId ? -1 : a.registrantId > b.registrantId ? 1 : 0)))

  return scored.slice(0, REASSOCIATION_MAX_CANDIDATES).map((s) => ({
    registrantId: s.registrantId,
    matchedFieldNames: s.matchedFieldNames,
    displayName: s.displayName
  }))
}
