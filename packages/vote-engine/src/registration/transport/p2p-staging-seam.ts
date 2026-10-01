import type { EnvelopeBinding } from '../../crypto/index.js'
import type { Signature } from '@votetorrent/vote-core'

/**
 * p2p-staging-seam.ts — the shared D-03/D-05/D-06 sealing, opening, decision-signing and
 * cursor-retry seam BOTH P2P transports (`p2p-registration-transport.ts`,
 * `p2p-association-transport.ts`) build on.
 *
 * ============================================================================
 * D-03: NO PLAINTEXT FALLBACK, EVER.
 * ============================================================================
 * Every staged payload this seam's callers write onto a strand goes on as a 62-04 sealed
 * envelope, never as plaintext. A transport given no sealer refuses to stage at all
 * (`P2pStagingError 'no-sealer'`) before any I/O; a sealer that throws (e.g. a zero-recipient
 * seal) propagates that error unchanged and the caller writes zero rows. There is no code path
 * in this module, or in either transport that imports it, that writes an un-sealed payload
 * column.
 *
 * Every `P2pStagingError` message carries only a code and a call-site label — never a payload
 * value, a plaintext fragment, a registration code or an identity-field value. The opener's own
 * `detail` string (62-04/62-14's structural-only detail) is deliberately DROPPED wherever this
 * seam surfaces an opener failure — only the `reason` code crosses into a `StagingUnreadableRow`.
 *
 * ============================================================================
 * WHAT THIS MODULE DOES NOT IMPORT
 * ============================================================================
 * No P2P package (cadre-core, db-p2p, libp2p) and no filesystem module —
 * only `import type` reaches `../../crypto/index.js` (62-04's envelope types) and
 * `@votetorrent/vote-core` (`Signature`). The two transports supply their own `StagingSqlPort`
 * implementation (a `RegistrationStrandPort`/`AssociationStrandPort`, which is structurally wider
 * but satisfies this narrower shape); this module never opens a strand itself.
 */

/** Zero-padded cursor width, matching the filesystem/REST bindings' own `SEQ_WIDTH` convention
 * and the schema's `CursorWidth` CHECK (`length(new.Cursor) = 16`). */
export const STAGING_CURSOR_WIDTH = 16

/** Bounded retry limit for the D-05 client-side max+1 cursor race (`insertWithCursorRetry`). */
export const STAGING_CURSOR_MAX_ATTEMPTS = 5

/**
 * Requester side (D-03/D-04). `plaintext` is the JSON string this transport builds (the encoded
 * `RegistrationStagingPlaintext` / `AssociationStagingPlaintext` / `AssociationAttestationAnswer`
 * body — see each transport's own module header for the exact shape). `seal()` returns the
 * `serializeEnvelope(...)` string stored VERBATIM in `InitJson` / `AnswerJson`. It THROWS
 * (62-14's production factory: `IntakeError 'no-recipients'`; this plan's own tests: 62-04's
 * `EnvelopeSealError 'no-recipients'`) rather than ever returning plaintext.
 *
 * `authorityId`, when present, must equal the request's `init.authorityId` — a transport checks
 * this BEFORE sealing (the `'sealer-authority-mismatch'` guard) so a sealer wired to the wrong
 * authority's recipient list can never silently mis-seal a row onto another authority's strand.
 * 62-14's `IntakeSealer` always sets it; a test sealer may leave it `undefined` to opt out of the
 * guard.
 */
export interface StagingSealer {
  readonly authorityId?: string
  seal(plaintext: string, binding: EnvelopeBinding): Promise<string>
}

/** Authority side. Shape fixed by the orchestrator's 62-14 note — 62-14's `IntakeOpenResult` is
 * structurally assignable to this type. */
export type StagingOpenResult =
  | { readonly ok: true, readonly plaintext: string }
  | { readonly ok: false, readonly reason: string, readonly detail: string }

/**
 * Authority side. `open()` is expected never to reject (62-14's opener reports every vault
 * problem as `reason: 'vault-error'`); if a host opener rejects anyway, the whole read rejects
 * with that error unchanged — this seam does not swallow a rejected promise into a fabricated
 * unreadable row.
 */
export interface StagingOpener {
  open(sealed: string, binding: EnvelopeBinding): Promise<StagingOpenResult>
}

/** Authority side (D-06). A transport binds `DeciderKey := signature.signerKey` and
 * `DeciderSignature := signature.signature` from the returned `Signature`. */
export interface StagingDecisionSigner {
  readonly authorityId: string
  sign(digest: Uint8Array): Promise<Signature>
}

export type P2pStagingErrorCode =
  | 'no-sealer' | 'no-opener' | 'no-decision-signer' | 'sealer-authority-mismatch'
  | 'duplicate-request-id' | 'duplicate-decision' | 'cursor-exhausted' | 'rejected' | 'digest-unavailable'

/**
 * Every message is built from a code and a call-site label only — never a payload, plaintext,
 * registration code or identity value. The underlying strand rejection (if any) is kept ONLY as
 * `cause`, never interpolated into `message`, so a caller that logs `error.message` cannot leak
 * driver-level detail that might itself echo bound parameters.
 */
export class P2pStagingError extends Error {
  readonly code: P2pStagingErrorCode

  constructor (code: P2pStagingErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'P2pStagingError'
    this.code = code
  }
}

/**
 * The opener's own reason string, passed through verbatim: 62-04's `EnvelopeOpenFailureReason`
 * (`'invalid-argument' | 'malformed-envelope' | 'unsupported-version' | 'not-a-recipient' |
 * 'authentication-failed'`), 62-14 additionally reports `'no-local-key' | 'vault-error'`, or one
 * of this seam's own two read-path reasons: `'invalid-plaintext'` (the opened plaintext failed
 * this transport's own shape/version/id checks) and `'malformed-row'` (the row's `SignatureJson`
 * itself did not parse — the opener was never even called).
 */
export type StagingUnreadableReason = string

export interface StagingUnreadableRow {
  readonly requestId: string
  readonly cursor: string
  readonly requesterKey: string
  readonly stagedAt: string
  readonly reason: StagingUnreadableReason
}

export interface StagingReadReport<T> {
  /** Opened rows, in cursor order. */
  readonly delivered: T[]
  readonly unreadable: StagingUnreadableRow[]
  /** The greatest cursor among EVERY row read this call, delivered or unreadable — so a caller
   * can advance its own `sinceCursor` past an unreadable row instead of re-reading it forever. */
  readonly highWaterCursor?: string
}

/** Structural SQL port both transports' `StrandPort` types satisfy (each additionally declares
 * `close()`, which this narrower shape does not require). */
export interface StagingSqlPort {
  query<T>(sql: string, params: Record<string, unknown>): Promise<T[]>
  mutate(sql: string, params: Record<string, unknown>): Promise<void>
}

/** The five staging/decision tables `insertWithCursorRetry` may target. Deliberately a closed
 * union: a table name is NEVER interpolated from external input, only from this fixed list. */
export type StagingCursorTable =
  | 'RegistrationRequestStaging' | 'RegistrationDecision'
  | 'AssociationRequestStaging' | 'AssociationAttestationStaging' | 'AssociationDecision'

/**
 * Bounded cursor retry — closes the D-05 client-side max+1 race
 * (`p2p-registration-transport.ts:287-297`, pre-this-plan). Internal to the two transports — NOT
 * re-exported to either barrel (`p2p-registration-transport.ts` exports every other seam name
 * explicitly; this one is left out on purpose).
 *
 * For attempt 1..`STAGING_CURSOR_MAX_ATTEMPTS`:
 *   1. Allocate the cursor via `select max(Cursor) from <table> where StrandId = :strandId`, +1,
 *      padded to `STAGING_CURSOR_WIDTH` (a null max gives `'0000000000000001'`).
 *   2. `port.mutate(insertSql, { ...params, cursor })`. On success, return
 *      `{ cursor, idempotent: false }`.
 *   3. On any rejection, first run the identity read (`args.identity`). If it returns rows, call
 *      `onIdentityConflict`: an `'idempotent'` result returns the EXISTING row's own cursor with
 *      `idempotent: true`; otherwise the returned `P2pStagingError` is thrown.
 *   4. Otherwise probe whether the allocated cursor is now taken
 *      (`select Cursor from <table> where StrandId = :strandId and Cursor = :cursor`). If taken,
 *      continue to the next attempt (re-allocate from the now-current max).
 *   5. Otherwise the rejection is some OTHER schema refusal (a forged signature, a CHECK the row
 *      fails on its own merits) — throw `P2pStagingError('rejected', ...)` immediately, with the
 *      underlying error as `cause`.
 * After the loop (every attempt hit a genuine cursor race), throw
 * `P2pStagingError('cursor-exhausted', ...)`.
 *
 * No sleep and no randomness — the retry is deterministic, driven only by what the port reports.
 */
export async function insertWithCursorRetry (port: StagingSqlPort, args: {
  table: StagingCursorTable
  strandId: string
  /** Binds `:cursor` plus every member of `params`. */
  insertSql: string
  /** Everything the insert needs except `cursor`. */
  params: Record<string, unknown>
  /** Reads back the row this insert would duplicate. */
  identity: { sql: string, params: Record<string, unknown> }
  onIdentityConflict: (existing: Array<Record<string, unknown>>) => 'idempotent' | P2pStagingError
  /** e.g. `'P2pRegistrationTransport.submitRequest'` — named in every thrown error. */
  where: string
}): Promise<{ cursor: string, idempotent: boolean }> {
  const { table, strandId, insertSql, params, identity, onIdentityConflict, where } = args
  const maxCursorSql = `select max(Cursor) as MaxCursor from ${table} where StrandId = :strandId`
  const cursorProbeSql = `select Cursor from ${table} where StrandId = :strandId and Cursor = :cursor`

  let lastError: unknown

  for (let attempt = 1; attempt <= STAGING_CURSOR_MAX_ATTEMPTS; attempt++) {
    const maxRows = await port.query<{ MaxCursor: string | null }>(maxCursorSql, { strandId })
    const maxCursor = maxRows[0]?.MaxCursor ?? null
    const next = maxCursor === null || maxCursor === '' ? 1 : Number(maxCursor) + 1
    const cursor = String(next).padStart(STAGING_CURSOR_WIDTH, '0')

    try {
      await port.mutate(insertSql, { ...params, cursor })
      return { cursor, idempotent: false }
    } catch (err) {
      lastError = err

      const existing = await port.query<Record<string, unknown>>(identity.sql, identity.params)
      if (existing.length > 0) {
        const outcome = onIdentityConflict(existing)
        if (outcome === 'idempotent') {
          const existingCursor = existing[0]?.Cursor
          if (typeof existingCursor !== 'string') {
            throw new P2pStagingError(
              'rejected',
              `${where}: an identity conflict resolved as idempotent, but the existing row carried no readable Cursor`,
              { cause: err }
            )
          }
          return { cursor: existingCursor, idempotent: true }
        }
        throw outcome
      }

      const cursorProbe = await port.query<{ Cursor: string }>(cursorProbeSql, { strandId, cursor })
      if (cursorProbe.length > 0) {
        // Genuine cursor race: someone else landed this exact cursor between our SELECT and our
        // INSERT. Retry from the top — the next attempt's max-cursor read sees the new row.
        continue
      }

      // Neither an identity conflict nor a cursor race: the strand refused the row on its own
      // merits (a forged signature, some other CHECK) — surface immediately, never retried.
      throw new P2pStagingError('rejected', `${where}: the strand refused the row`, { cause: err })
    }
  }

  throw new P2pStagingError(
    'cursor-exhausted',
    `${where}: exhausted ${STAGING_CURSOR_MAX_ATTEMPTS} cursor allocation attempts`,
    { cause: lastError }
  )
}

/** The seal/open seam is string-based (orchestrator note: 62-14 works on strings only), so
 * neither transport ever encodes or decodes bytes directly — only JSON text. */
export function encodeStagingPlaintext (value: unknown): string {
  return JSON.stringify(value)
}

/** `undefined` on any parse failure — never throws. The caller treats `undefined` as
 * `'invalid-plaintext'`. */
export function decodeStagingPlaintext (text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}
