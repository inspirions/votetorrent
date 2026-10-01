// src/intake/policy.ts — Phase 62 Plan 14 (D-29, D-46)
//
// Reads the greatest `AuthorityIntakePolicy` revision for an authority (no
// row means manual re-association and no REST bridge — D-46's default) and
// implements the D-45/D-46 routing rule: the identity-fallback
// re-association path is ALWAYS officer-reviewed, whatever the policy says.

import { DEFAULT_REASSOCIATION_MODE, IntakeError, REASSOCIATION_MODES, REST_BRIDGE_URL_MAX_LENGTH } from './types.js'
import type { AuthorityIntakePolicyView, ReassociationMatchMethod, ReassociationMode, ReassociationRoute } from './types.js'
import type { IntakeQueryPort } from './query-port.js'

// https-only, no userinfo, no whitespace. A regex (not `new URL()`): React
// Native's URL implementation lacks several getters, and the row is PUBLIC
// (web-data classifies it CLASS.PUBLIC), so credentials embedded as
// userinfo must never be accepted.
const REST_BRIDGE_URL_PATTERN = /^https:\/\/[A-Za-z0-9.-]+(:[0-9]{1,5})?([/?#][^\s]*)?$/

export function isValidRestBridgeUrl (url: unknown): url is string {
  return typeof url === 'string' &&
    url.length >= 1 &&
    url.length <= REST_BRIDGE_URL_MAX_LENGTH &&
    REST_BRIDGE_URL_PATTERN.test(url)
}

interface RawPolicyRow {
  readonly Revision: unknown
  readonly RestBridgeUrl: unknown
  readonly ReassociationMode: unknown
  readonly SetAt: unknown
}

function defaultView (authorityId: string): AuthorityIntakePolicyView {
  return {
    authorityId,
    revision: 0,
    restBridgeUrl: null,
    reassociationMode: DEFAULT_REASSOCIATION_MODE,
    setAt: null,
    isDefault: true
  }
}

/** Defensive reader: a forged/corrupt row never produces an invalid view — it falls back field by field. */
export function normalizeIntakePolicyRow (
  authorityId: string,
  row: RawPolicyRow | undefined
): AuthorityIntakePolicyView {
  if (row === undefined) return defaultView(authorityId)

  const revisionNumber = Number(row.Revision)
  if (!Number.isSafeInteger(revisionNumber) || revisionNumber < 1) {
    return defaultView(authorityId)
  }
  const restBridgeUrl = isValidRestBridgeUrl(row.RestBridgeUrl) ? row.RestBridgeUrl : null
  const mode: ReassociationMode = (REASSOCIATION_MODES as readonly string[]).includes(row.ReassociationMode as string)
    ? (row.ReassociationMode as ReassociationMode)
    : DEFAULT_REASSOCIATION_MODE
  const setAt = typeof row.SetAt === 'string' ? row.SetAt : null

  return { authorityId, revision: revisionNumber, restBridgeUrl, reassociationMode: mode, setAt, isDefault: false }
}

export async function readIntakePolicyFrom (port: IntakeQueryPort, authorityId: string): Promise<AuthorityIntakePolicyView> {
  if (typeof authorityId !== 'string' || authorityId.length === 0) {
    throw new IntakeError('invalid-argument', 'readIntakePolicyFrom: authorityId must be a non-empty string')
  }
  const rows = await port.query<RawPolicyRow>(
    'select Revision, RestBridgeUrl, ReassociationMode, SetAt from AuthorityIntakePolicy where AuthorityId = :authorityId order by Revision desc limit 1',
    { authorityId }
  )
  return normalizeIntakePolicyRow(authorityId, rows[0])
}

/**
 * D-45/D-46: `'automatic'` applies ONLY when the policy says automatic AND
 * the match method is `'code'` — the identity fallback always routes to
 * manual review, whatever the policy's `reassociationMode` is. 62-18
 * applies this route.
 */
export function reassociationRouteFor (
  policy: Pick<AuthorityIntakePolicyView, 'reassociationMode'>,
  matchMethod: ReassociationMatchMethod
): ReassociationRoute {
  return policy.reassociationMode === 'automatic' && matchMethod === 'code' ? 'automatic' : 'manual'
}
