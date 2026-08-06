import { setDisclose } from '@optimystic/quereus-plugin-crypto'
import { digestToBytes, nowCanonicalDatetime, parseJsonOr, asText, asNumberOr, SEQUENCE_ALLOCATION_ATTEMPTS } from '../utils.js'
import { seedSignedMutation } from '../signing/signed-mutation.js'
import { allocateTid } from '../database/tid-allocator.js'
import { toIsoZDatetime, toDeferredCheckDatetime, reZuluDatetime, resolveSign as resolveSignHelper, requireCtx as requireCtxHelper, rethrow as rethrowHelper } from '../signing/ceremony-helpers.js'
import { RegistrationRegisterBuilder } from './builders/registration-register-builder.js'
import { validateFieldPolicy } from './field-policy.js'
import {
  buildRegistrantListCountSql,
  buildRegistrantListPageSql,
  clampPageSize,
  REGISTRANT_PRIVATE_POINT_CURRENCY_JOIN,
  REGISTRANT_PUBLIC_POINT_CURRENCY_JOIN,
  REGISTRANT_SELECTIVE_POINT_CURRENCY_JOIN
} from './registrant-list-query.js'
import { collectPrivateFieldNames, sanitizeAccessTrailFields } from './access-trail-fields.js'
import type { SqlValue } from '@quereus/quereus'
import type { EngineContext } from '../types.js'
import type {
  DisclosedSelective,
  DisclosureAudience,
  ElectionAttestationPolicy,
  ElectionDisclosurePolicy,
  ElectionRegistrant,
  ElectionRegistrationField,
  IRegistrationEngine,
  IRegistrationRegisterBuilder,
  PriorRejection,
  PrivateDetail,
  RegisterInit,
  RegisterSelectivePayload,
  Registrant,
  RegistrantAccessEvent,
  RegistrantListFilter,
  RegistrantListPage,
  RegistrantListResult,
  RegistrantListRow,
  RegistrantPrivate,
  RegistrantPublic,
  RegistrantSelective,
  RegistrantStatus,
  RegistrationBridgeKey,
  RegistrationBridgeKeyInit,
  RegistrationRequestDecision,
  RegistrationRequestInit,
  RegistrationRequestListFilter,
  RegistrationRequestListPage,
  RegistrationRequestListResult,
  RegistrationRequestRead,
  RegistrationTransparencyStats,
  SelectiveLeaf,
  Signature,
  Timestamp
} from '@votetorrent/vote-core'

/**
 * D-01/D-19: every mutating method's signing parameter is a real `Signature`
 * OR a callback that receives the canonical digest bytes and returns one —
 * NEVER a raw private key. The engine never holds the key (D-01). Matches
 * `IRegistrationEngine`'s (unexported) `SignatureOrCallback` shape structurally.
 */
type SignatureOrCallback = Signature | ((digest: Uint8Array) => Promise<Signature>)

/**
 * L-3 skew guard bounds for `submitRegistrationRequest`'s submitter-supplied
 * `SubmittedAt` (48-02 `<digest_register>` / 48-07). Named module-level
 * constants, not inline magic numbers, because both bounds are pinned by a
 * test from each side (48-07 Task 3, tests 7/8) — a later change to either
 * has to move a test, not just a comment.
 *
 * +5 minutes forward: a submitter's device clock is not the authority's own.
 * This project has a recorded ~45s emulator/host clock-skew failure (project
 * memory: device proof clock skew) — the tolerance is deliberately an order
 * of magnitude wider than that observed drift, so an honest fast clock is
 * never rejected. Beyond 5 minutes the claim is to have signed AFTER the
 * authority received the document, which no clock error explains.
 */
const SUBMITTED_AT_MAX_FUTURE_SKEW_MS = 5 * 60 * 1000

/**
 * -30 days backward: the filesystem courier (48-09) is a BATCH/periodic sync
 * (doc/registration.md:12) — a staged document may legitimately sit in a
 * drop directory, and a bulk import prepared from a legacy roll may be
 * delivered well after it was signed. 30 days accommodates any realistic
 * courier delay while still bounding what lands in the audit record and in
 * D-09's median time-to-decision.
 */
const SUBMITTED_AT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

// 999.1 D-01/D-02: RegistrationEngine mutations allocate Tids through the
// shared durable, peer-safe allocator (`../database/tid-allocator.js`,
// namespace 'registration') instead of a process-local `Date.now()` counter
// — closes the restart/multi-peer Tid-collision replay window this module
// previously carried (superseded the retired `nextRegistrationTid`/
// `peekNextRegistrationTid()` pair; see `tid-allocator.ts`'s `peekTid` for
// the equivalent introspection hook).

// WR-01/WR-04 (42-REVIEW): the datetime + ceremony helpers were consolidated
// into ../signing/ceremony-helpers.js so the three Phase-42 engines share ONE
// canonical copy (the divergent registration copy of toIsoZDatetime that lost
// the bare-ISO read-back branch was WR-01). See that module for the doc comments.

/**
 * RegistrationEngine — Phase 42-03 (D-01/D-02/D-15/D-18/D-21) implementation.
 *
 * Unwired `(ctx?: EngineContext)` constructor per the `ElectionsEngine`
 * precedent (RESEARCH Open Question 1) — no `INetworkEngine` factory this
 * phase; `AuthorityId` is a per-row field, not a fixed engine-instance
 * identity.
 *
 * Scope boundaries (this plan): Registrant + RegistrantPublic + RegistrantPrivate
 * tier create/read + the multi-row Register ceremony. `RegistrantSelective`
 * (42-08), `ElectionRegistrant` roster + Status/Expiration lifecycle (42-06),
 * and `ElectionRegistrationField` policy (42-07) are stubbed below with clear
 * "not yet implemented" errors — they exist on `IRegistrationEngine` because
 * later Phase-42 plans extend this SAME class, not because they're silently
 * dropped.
 */
export class RegistrationEngine implements IRegistrationEngine {
  constructor (private readonly ctx?: EngineContext) {}

  // ---------- signing helpers ----------

  /** Normalizes the Signature|callback union into a single callback shape (WR-04: shared). */
  private resolveSign (signatureOrCallback: SignatureOrCallback): (digest: Uint8Array) => Promise<Signature> {
    return resolveSignHelper(signatureOrCallback)
  }

  // ---------- Cid compute helpers (pure, no insert — Pitfall 4: Cids-before-parent) ----------

  /** RegistrantPublic.CidValid: Cid = cid(Digest(RegistrantId, LastName, FirstName, District, ExtraFields)). */
  private async computeRegistrantPublicCid (
    registrantId: string,
    input: { lastName?: string; firstName?: string; district?: string; extraFields?: Record<string, unknown> }
  ): Promise<string> {
    const ctx = this.ctx!
    const extraFieldsJson = input.extraFields ? JSON.stringify(input.extraFields) : null
    const row = await ctx.db
      .prepare('select cid(Digest(:registrantId, :lastName, :firstName, :district, :extraFields)) as c')
      .get({
        registrantId,
        lastName: input.lastName ?? null,
        firstName: input.firstName ?? null,
        district: input.district ?? null,
        extraFields: extraFieldsJson
      })
    if (!row || row.c == null) {
      throw new Error('computeRegistrantPublicCid: cid(Digest(...)) returned null — crypto plugin not registered?')
    }
    return row.c as string
  }

  /** RegistrantPrivate.CidValid: Cid = cid(Digest(RegistrantId, Expiration, PrivateDetails)). */
  private async computeRegistrantPrivateCid (
    registrantId: string,
    input: { expiration: Timestamp | string; details: PrivateDetail[] }
  ): Promise<string> {
    const ctx = this.ctx!
    const expiration = toIsoZDatetime(input.expiration)
    const privateDetailsJson = JSON.stringify(input.details ?? [])
    const row = await ctx.db
      .prepare('select cid(Digest(:registrantId, :expiration, :privateDetails)) as c')
      .get({ registrantId, expiration, privateDetails: privateDetailsJson })
    if (!row || row.c == null) {
      throw new Error('computeRegistrantPrivateCid: cid(Digest(...)) returned null — crypto plugin not registered?')
    }
    return row.c as string
  }

  /**
   * RegistrantSelective.CidValid: Cid = cid(set_commit(SelectiveDetails)) — the
   * DB computes the root (never hand-rolled in JS) so it byte-matches the
   * schema's own re-derivation. Unlike RegistrantPublic/Private's CidValid,
   * this formula does NOT include RegistrantId (schema's own formula, verbatim).
   */
  private async computeRegistrantSelectiveCid (selectiveDetailsJson: string): Promise<string> {
    const ctx = this.ctx!
    const row = await ctx.db
      .prepare('select cid(set_commit(:details)) as c')
      .get({ details: selectiveDetailsJson })
    if (!row || row.c == null) {
      throw new Error('computeRegistrantSelectiveCid: cid(set_commit(...)) returned null — crypto plugin not registered?')
    }
    return row.c as string
  }

  /**
   * D-13: turn caller-supplied `{name, value}` field inputs into engine-
   * generated `SelectiveLeaf[]` — a fresh SQL `random_bytes` (>=128 bits)
   * salt per leaf, NEVER a JS ad-hoc RNG. Duplicate names and an empty/
   * missing salt are rejected BEFORE any DB ceremony runs: the duplicate
   * check runs first (pure, no DB call) so a caller never pays for salt
   * generation on a payload that's going to be rejected anyway.
   */
  private async buildSelectiveLeaves (fields: RegisterSelectivePayload): Promise<SelectiveLeaf[]> {
    const ctx = this.ctx!
    const seen = new Set<string>()
    for (const field of fields) {
      if (seen.has(field.name)) {
        throw new Error(`register: duplicate selective field name '${field.name}' (D-13)`)
      }
      seen.add(field.name)
    }
    const leaves: SelectiveLeaf[] = []
    for (const field of fields) {
      const saltRow = await ctx.db.prepare('select random_bytes(128) as s').get({})
      const salt = saltRow?.s == null ? '' : String(saltRow.s)
      if (!salt) {
        throw new Error(`register: engine could not obtain a non-empty salt for selective field '${field.name}' (D-13)`)
      }
      leaves.push({ name: field.name, value: field.value, salt })
    }
    return leaves
  }

  // ---------- tier create methods ----------

  /**
   * Insert the parent `Registrant` row. Two DISTINCT digests/signatures are
   * involved (Pitfall 4 / T-42-03-01/02):
   *   1. The row-level "signor" signature — a REAL secp256k1 signature over
   *      `Digest(Id, AuthorityId, PrivateCid, PublicCid, SelectiveCid, Status,
   *      Expiration)`, independently verified by the schema's `SignatureValid`
   *      CHECK (a portable, self-verifiable proof — D-19).
   *   2. The `vrg`-scoped `AdminSigning`/`AdminSignature` ceremony pair, whose
   *      Digest covers the row's ENTIRE field list INCLUDING the SignorKey/
   *      Signature values produced by (1) — `MutationValid`'s own formula.
   * `signatureOrCallback` is resolved (and invoked) independently for each —
   * a real callback receives two DIFFERENT digest byte sequences and must
   * sign both; a static `Signature` is reused for both (safe: only (1) is
   * ever independently crypto-verified by the schema).
   */
  async createRegistrant (
    input: {
      id: string
      authorityId: string
      privateCid: string
      publicCid?: string
      selectiveCid?: string
      status?: RegistrantStatus
      expiration: Timestamp | string
    },
    signatureOrCallback: SignatureOrCallback,
    options?: { ownsTransaction?: boolean }
  ): Promise<Registrant> {
    this.requireCtx('createRegistrant')
    const ctx = this.ctx!
    const tid = await allocateTid(ctx.db, 'registration')
    try {
      const status = input.status ?? 'a'
      const expiration = toIsoZDatetime(input.expiration)
      const publicCid = input.publicCid ?? null
      const selectiveCid = input.selectiveCid ?? null

      // 1. Row-level signor signature (D-19 portable proof).
      const rowDigestRow = await ctx.db
        .prepare('select Digest(:id, :authorityId, :privateCid, :publicCid, :selectiveCid, :status, :expiration) as d')
        .get({
          id: input.id,
          authorityId: input.authorityId,
          privateCid: input.privateCid,
          publicCid,
          selectiveCid,
          status,
          expiration
        })
      if (!rowDigestRow || rowDigestRow.d == null) {
        throw new Error('createRegistrant: Digest() returned null for row-level signature — crypto plugin not registered?')
      }
      const rowDigestBytes = digestToBytes(rowDigestRow.d)
      const rowSignature = await this.resolveSign(signatureOrCallback)(rowDigestBytes)

      // 2. AdminSigning ceremony ('vrg') — MutationValid's own field list, including
      //    the SignorKey/Signature produced in step 1. NOTE 1: bind names
      //    `rowSignorKey`/`rowSignature` (NOT `signerKey`/`signature`) —
      //    seedSignedMutation reserves `signerKey`/`signature`/`userId`/etc for ITS
      //    OWN ceremony bind params and would silently overwrite a same-named
      //    digestParams entry (T-42-03 bug found via TDD: a `signature` key here
      //    collided with the ceremony's own admin signature bind, corrupting the
      //    stored AdminSigning.Digest). NOTE 2: `MutationValid` contains a subquery
      //    (`exists(...)`) so it is a DEFERRED check — Quereus's deferred-check
      //    snapshot coerces `new.Expiration` through a Z-stripping round-trip
      //    (see `toDeferredCheckDatetime`'s doc comment); the ceremony digest MUST
      //    use that coerced form, NOT the Z-suffixed `expiration` bound on the row.
      const expirationForDeferredCheck = toDeferredCheckDatetime(input.expiration)
      const digestExpr = 'select Digest(:tid, :id, :authorityId, :privateCid, :publicCid, :selectiveCid, :status, :expirationDeferred, :rowSignorKey, :rowSignature) as d'
      const digestParams = {
        tid,
        id: input.id,
        authorityId: input.authorityId,
        privateCid: input.privateCid,
        publicCid,
        selectiveCid,
        status,
        expirationDeferred: expirationForDeferredCheck,
        rowSignorKey: rowSignature.signerKey,
        rowSignature: rowSignature.signature
      }
      const nonce = await seedSignedMutation(
        ctx,
        input.authorityId,
        'vrg',
        tid,
        digestExpr,
        digestParams,
        this.resolveSign(signatureOrCallback),
        options
      )

      await ctx.db.exec(
        `insert into Registrant (
          Id, AuthorityId, PrivateCid, PublicCid, SelectiveCid, Status, Expiration, SignorKey, Signature
        )
        with context SigningNonce = :signingNonce, Tid = ${tid}, now = :now
        values (:id, :authorityId, :privateCid, :publicCid, :selectiveCid, :status, :expiration, :signorKey, :signature)`,
        {
          id: input.id,
          authorityId: input.authorityId,
          privateCid: input.privateCid,
          publicCid,
          selectiveCid,
          status,
          expiration,
          signorKey: rowSignature.signerKey,
          signature: rowSignature.signature,
          signingNonce: nonce,
          now: nowCanonicalDatetime()
        }
      )

      return {
        id: input.id,
        authorityId: input.authorityId,
        privateCid: input.privateCid,
        publicCid: publicCid ?? undefined,
        selectiveCid: selectiveCid ?? undefined,
        status,
        expiration: input.expiration,
        signorKey: rowSignature.signerKey,
        signature: rowSignature.signature
      }
    } catch (err) {
      this.rethrow(err, 'createRegistrant')
    }
  }

  /**
   * Insert a `RegistrantPublic` tier row. Requires the parent `Registrant`
   * row to already exist (its `AuthorityId` is looked up to seed the `vrg`
   * ceremony; `RegistrantCidMatch` requires `Registrant.PublicCid = new.Cid`).
   */
  async createRegistrantPublic (
    input: {
      registrantId: string
      lastName?: string
      firstName?: string
      district?: string
      extraFields?: Record<string, unknown>
    },
    signatureOrCallback: SignatureOrCallback,
    options?: { ownsTransaction?: boolean }
  ): Promise<RegistrantPublic> {
    this.requireCtx('createRegistrantPublic')
    const ctx = this.ctx!
    const tid = await allocateTid(ctx.db, 'registration')
    try {
      const registrantRow = await ctx.db
        .prepare('select AuthorityId from Registrant where Id = :registrantId')
        .get({ registrantId: input.registrantId })
      if (!registrantRow) {
        throw new Error(`createRegistrantPublic: Registrant not found for registrantId=${input.registrantId}`)
      }
      const authorityId = asText(registrantRow.AuthorityId, 'Registrant.AuthorityId')

      const cid = await this.computeRegistrantPublicCid(input.registrantId, input)
      const extraFieldsJson = input.extraFields ? JSON.stringify(input.extraFields) : null
      const lastName = input.lastName ?? null
      const firstName = input.firstName ?? null
      const district = input.district ?? null

      const digestExpr = 'select Digest(:tid, :cid, :registrantId, :lastName, :firstName, :district, :extraFields) as d'
      const digestParams = {
        tid,
        cid,
        registrantId: input.registrantId,
        lastName,
        firstName,
        district,
        extraFields: extraFieldsJson
      }
      const nonce = await seedSignedMutation(ctx, authorityId, 'vrg', tid, digestExpr, digestParams, this.resolveSign(signatureOrCallback), options)

      await ctx.db.exec(
        `insert into RegistrantPublic (Cid, RegistrantId, LastName, FirstName, District, ExtraFields)
         with context SigningNonce = :signingNonce, Tid = ${tid}
         values (:cid, :registrantId, :lastName, :firstName, :district, :extraFields)`,
        {
          cid,
          registrantId: input.registrantId,
          lastName,
          firstName,
          district,
          extraFields: extraFieldsJson,
          signingNonce: nonce
        }
      )

      return {
        cid,
        registrantId: input.registrantId,
        lastName: lastName ?? undefined,
        firstName: firstName ?? undefined,
        district: district ?? undefined,
        extraFields: input.extraFields
      }
    } catch (err) {
      this.rethrow(err, 'createRegistrantPublic')
    }
  }

  /**
   * Insert a `RegistrantPrivate` tier row (authority-held, insert-only,
   * never disclosed). Requires the parent `Registrant` row to already exist.
   */
  async createRegistrantPrivate (
    input: { registrantId: string; expiration: Timestamp | string; details: PrivateDetail[] },
    signatureOrCallback: SignatureOrCallback,
    options?: { ownsTransaction?: boolean }
  ): Promise<RegistrantPrivate> {
    this.requireCtx('createRegistrantPrivate')
    const ctx = this.ctx!
    const tid = await allocateTid(ctx.db, 'registration')
    try {
      const registrantRow = await ctx.db
        .prepare('select AuthorityId from Registrant where Id = :registrantId')
        .get({ registrantId: input.registrantId })
      if (!registrantRow) {
        throw new Error(`createRegistrantPrivate: Registrant not found for registrantId=${input.registrantId}`)
      }
      const authorityId = asText(registrantRow.AuthorityId, 'Registrant.AuthorityId')

      const details = input.details ?? []
      const expiration = toIsoZDatetime(input.expiration)
      const privateDetailsJson = JSON.stringify(details)
      const cid = await this.computeRegistrantPrivateCid(input.registrantId, { expiration: input.expiration, details })

      // InsertValid contains a subquery (exists(...)) -> DEFERRED check -> its
      // new.Expiration snapshot is Z-stripped (see toDeferredCheckDatetime).
      // CidValid (above, immediate) correctly used the Z-suffixed form.
      const expirationForDeferredCheck = toDeferredCheckDatetime(input.expiration)
      const digestExpr = 'select Digest(:tid, :cid, :registrantId, :expirationDeferred, :privateDetails) as d'
      const digestParams = { tid, cid, registrantId: input.registrantId, expirationDeferred: expirationForDeferredCheck, privateDetails: privateDetailsJson }
      const nonce = await seedSignedMutation(ctx, authorityId, 'vrg', tid, digestExpr, digestParams, this.resolveSign(signatureOrCallback), options)

      await ctx.db.exec(
        `insert into RegistrantPrivate (Cid, RegistrantId, Expiration, PrivateDetails)
         with context SigningNonce = :signingNonce, Tid = ${tid}, now = :now
         values (:cid, :registrantId, :expiration, :privateDetails)`,
        {
          cid,
          registrantId: input.registrantId,
          expiration,
          privateDetails: privateDetailsJson,
          signingNonce: nonce,
          now: nowCanonicalDatetime()
        }
      )

      return { cid, registrantId: input.registrantId, expiration: input.expiration, privateDetails: details }
    } catch (err) {
      this.rethrow(err, 'createRegistrantPrivate')
    }
  }

  /**
   * Shared insert path for `RegistrantSelective` — accepts PRECOMPUTED leaves
   * (with their engine-generated salts already fixed) + the matching Cid.
   * `register()`'s Cids-before-parent step and this row-level insert MUST
   * share the IDENTICAL leaf set: salts are random, so recomputing them here
   * would silently produce a Cid that no longer matches the one already
   * embedded in `Registrant.SelectiveCid` (Pitfall 4 variant unique to the
   * salted-set construction — Digest()-based tiers don't have this hazard
   * since their Cid formula is pure/deterministic over the same inputs).
   */
  private async insertRegistrantSelectiveRow (
    registrantId: string,
    expiration: Timestamp | string,
    leaves: SelectiveLeaf[],
    cid: string,
    signatureOrCallback: SignatureOrCallback,
    options?: { ownsTransaction?: boolean }
  ): Promise<RegistrantSelective> {
    const ctx = this.ctx!
    const tid = await allocateTid(ctx.db, 'registration')
    const registrantRow = await ctx.db
      .prepare('select AuthorityId from Registrant where Id = :registrantId')
      .get({ registrantId })
    if (!registrantRow) {
      throw new Error(`createRegistrantSelective: Registrant not found for registrantId=${registrantId}`)
    }
    const authorityId = asText(registrantRow.AuthorityId, 'Registrant.AuthorityId')
    const expirationZ = toIsoZDatetime(expiration)
    const selectiveDetailsJson = JSON.stringify(leaves)

    // InsertValid contains a subquery (exists(...)) -> DEFERRED check -> its
    // new.Expiration snapshot is Z-stripped (see toDeferredCheckDatetime).
    const expirationForDeferredCheck = toDeferredCheckDatetime(expiration)
    const digestExpr = 'select Digest(:tid, :cid, :registrantId, :expirationDeferred, :selectiveDetails) as d'
    const digestParams = { tid, cid, registrantId, expirationDeferred: expirationForDeferredCheck, selectiveDetails: selectiveDetailsJson }
    const nonce = await seedSignedMutation(ctx, authorityId, 'vrg', tid, digestExpr, digestParams, this.resolveSign(signatureOrCallback), options)

    await ctx.db.exec(
      `insert into RegistrantSelective (Cid, RegistrantId, Expiration, SelectiveDetails)
       with context SigningNonce = :signingNonce, Tid = ${tid}, now = :now
       values (:cid, :registrantId, :expiration, :selectiveDetails)`,
      {
        cid,
        registrantId,
        expiration: expirationZ,
        selectiveDetails: selectiveDetailsJson,
        signingNonce: nonce,
        now: nowCanonicalDatetime()
      }
    )

    return { cid, registrantId, expiration, selectiveDetails: leaves }
  }

  /**
   * Insert a `RegistrantSelective` tier row (authority-held, insert-only,
   * flat salted-leaf set commitment, D-11/D-12/D-13). Standalone/additive
   * counterpart to `createRegistrantPublic`/`createRegistrantPrivate` — the
   * Register flow's own selective branch (in `register()` below) generates
   * its leaves + Cid via the SAME `buildSelectiveLeaves`/
   * `computeRegistrantSelectiveCid` helpers but does NOT call this method
   * directly (it needs the leaves/Cid BEFORE the parent Registrant insert —
   * see `insertRegistrantSelectiveRow`'s doc comment).
   */
  async createRegistrantSelective (
    input: { registrantId: string; expiration: Timestamp | string; fields: RegisterSelectivePayload },
    signatureOrCallback: SignatureOrCallback,
    options?: { ownsTransaction?: boolean }
  ): Promise<RegistrantSelective> {
    this.requireCtx('createRegistrantSelective')
    try {
      const leaves = await this.buildSelectiveLeaves(input.fields)
      const cid = await this.computeRegistrantSelectiveCid(JSON.stringify(leaves))
      return await this.insertRegistrantSelectiveRow(input.registrantId, input.expiration, leaves, cid, signatureOrCallback, options)
    } catch (err) {
      this.rethrow(err, 'createRegistrantSelective')
    }
  }

  // ---------- reads ----------

  async getRegistrant (registrantId: string): Promise<Registrant | undefined> {
    if (!this.ctx) return undefined
    try {
      const row = await this.ctx.db
        .prepare('select Id, AuthorityId, PrivateCid, PublicCid, SelectiveCid, Status, Expiration, SignorKey, Signature from Registrant where Id = :id')
        .get({ id: registrantId })
      if (!row) return undefined
      return {
        id: asText(row.Id, 'Registrant.Id'),
        authorityId: asText(row.AuthorityId, 'Registrant.AuthorityId'),
        privateCid: asText(row.PrivateCid, 'Registrant.PrivateCid'),
        publicCid: row.PublicCid == null ? undefined : asText(row.PublicCid, 'Registrant.PublicCid'),
        selectiveCid: row.SelectiveCid == null ? undefined : asText(row.SelectiveCid, 'Registrant.SelectiveCid'),
        status: asText(row.Status, 'Registrant.Status') as RegistrantStatus,
        expiration: reZuluDatetime(row.Expiration as string),
        signorKey: asText(row.SignorKey, 'Registrant.SignorKey'),
        signature: asText(row.Signature, 'Registrant.Signature')
      }
    } catch (err) {
      this.rethrow(err, 'getRegistrant')
    }
  }

  /**
   * D-18: fixed columns (LastName/FirstName/District) plus the ExtraFields
   * json object, parsed via `parseJsonOr` (single source of truth for
   * JSON-parse-with-fallback per utils.ts). See `getRegistrantPublicField`/
   * `getRegistrantPublicExtraFieldKeys` below for the D-21 json_extract/
   * json_each SQL-level resolution paths a field-policy caller uses.
   */
  async getRegistrantPublic (registrantId: string): Promise<RegistrantPublic | undefined> {
    if (!this.ctx) return undefined
    try {
      const row = await this.ctx.db
        .prepare(
          'select T.Cid, T.RegistrantId, T.LastName, T.FirstName, T.District, T.ExtraFields '
          + `from RegistrantPublic T ${REGISTRANT_PUBLIC_POINT_CURRENCY_JOIN} `
          + 'where T.RegistrantId = :registrantId'
        )
        .get({ registrantId })
      if (!row) return undefined
      return {
        cid: asText(row.Cid, 'RegistrantPublic.Cid'),
        registrantId: asText(row.RegistrantId, 'RegistrantPublic.RegistrantId'),
        lastName: row.LastName == null ? undefined : asText(row.LastName, 'RegistrantPublic.LastName'),
        firstName: row.FirstName == null ? undefined : asText(row.FirstName, 'RegistrantPublic.FirstName'),
        district: row.District == null ? undefined : asText(row.District, 'RegistrantPublic.District'),
        extraFields: parseJsonOr<Record<string, unknown>>(row.ExtraFields, {}, 'RegistrantPublic.ExtraFields')
      }
    } catch (err) {
      this.rethrow(err, 'getRegistrantPublic')
    }
  }

  /**
   * D-18/D-21: resolve a policy-declared field name to a `RegistrantPublic`
   * fixed column if one exists, else to an `ExtraFields` json key via
   * `json_extract` — cast to text, since json_extract's JSON-typed return is
   * not directly `=`-comparable (the 36-01 Probe 3b pitfall).
   */
  async getRegistrantPublicField (registrantId: string, fieldName: string): Promise<string | undefined> {
    this.requireCtx('getRegistrantPublicField')
    const ctx = this.ctx!
    const fixedColumns: Record<string, string> = { lastname: 'LastName', firstname: 'FirstName', district: 'District' }
    const column = fixedColumns[fieldName.toLowerCase()]
    try {
      if (column) {
        const row = await ctx.db
          .prepare(
            `select T.${column} as v `
            + `from RegistrantPublic T ${REGISTRANT_PUBLIC_POINT_CURRENCY_JOIN} `
            + 'where T.RegistrantId = :registrantId'
          )
          .get({ registrantId })
        return row?.v == null ? undefined : asText(row.v, `RegistrantPublic.${column}`)
      }
      const path = `$.${fieldName}`
      const row = await ctx.db
        .prepare(
          'select cast(json_extract(T.ExtraFields, :path) as text) as v '
          + `from RegistrantPublic T ${REGISTRANT_PUBLIC_POINT_CURRENCY_JOIN} `
          + 'where T.RegistrantId = :registrantId'
        )
        .get({ registrantId, path })
      return row?.v == null ? undefined : String(row.v)
    } catch (err) {
      this.rethrow(err, 'getRegistrantPublicField')
    }
  }

  /** D-18/D-21: enumerate all ExtraFields keys via `json_each`. */
  async getRegistrantPublicExtraFieldKeys (registrantId: string): Promise<string[]> {
    this.requireCtx('getRegistrantPublicExtraFieldKeys')
    const ctx = this.ctx!
    try {
      const row = await ctx.db
        .prepare(
          'select T.ExtraFields '
          + `from RegistrantPublic T ${REGISTRANT_PUBLIC_POINT_CURRENCY_JOIN} `
          + 'where T.RegistrantId = :registrantId'
        )
        .get({ registrantId })
      if (!row || row.ExtraFields == null) return []
      const keys: string[] = []
      for await (const r of ctx.db.eval('select key as k from json_each(:extraFields)', { extraFields: row.ExtraFields })) {
        keys.push(String(r.k))
      }
      return keys
    } catch (err) {
      this.rethrow(err, 'getRegistrantPublicExtraFieldKeys')
    }
  }

  async getRegistrantPrivate (registrantId: string): Promise<RegistrantPrivate | undefined> {
    if (!this.ctx) return undefined
    try {
      const row = await this.ctx.db
        .prepare(
          'select T.Cid, T.RegistrantId, T.Expiration, T.PrivateDetails '
          + `from RegistrantPrivate T ${REGISTRANT_PRIVATE_POINT_CURRENCY_JOIN} `
          + 'where T.RegistrantId = :registrantId'
        )
        .get({ registrantId })
      if (!row) return undefined
      return {
        cid: asText(row.Cid, 'RegistrantPrivate.Cid'),
        registrantId: asText(row.RegistrantId, 'RegistrantPrivate.RegistrantId'),
        expiration: reZuluDatetime(row.Expiration as string),
        privateDetails: parseJsonOr<PrivateDetail[]>(row.PrivateDetails, [], 'RegistrantPrivate.PrivateDetails')
      }
    } catch (err) {
      this.rethrow(err, 'getRegistrantPrivate')
    }
  }

  /** Authority-side, full (undisclosed) RegistrantSelective read (D-11/D-12/D-13). */
  async getRegistrantSelective (registrantId: string): Promise<RegistrantSelective | undefined> {
    if (!this.ctx) return undefined
    try {
      const row = await this.ctx.db
        .prepare(
          'select T.Cid, T.RegistrantId, T.Expiration, T.SelectiveDetails '
          + `from RegistrantSelective T ${REGISTRANT_SELECTIVE_POINT_CURRENCY_JOIN} `
          + 'where T.RegistrantId = :registrantId'
        )
        .get({ registrantId })
      if (!row) return undefined
      return {
        cid: asText(row.Cid, 'RegistrantSelective.Cid'),
        registrantId: asText(row.RegistrantId, 'RegistrantSelective.RegistrantId'),
        expiration: reZuluDatetime(row.Expiration as string),
        selectiveDetails: parseJsonOr<SelectiveLeaf[]>(row.SelectiveDetails, [], 'RegistrantSelective.SelectiveDetails')
      }
    } catch (err) {
      this.rethrow(err, 'getRegistrantSelective')
    }
  }

  /**
   * D-01: record one app-mediated read of a registrant's private tier.
   * Accountability/deterrence/regulatory posture only — NOT a security
   * control; direct local database access bypasses this entirely and writes
   * no row. D-02: deliberately UNSIGNED — no `seedSignedMutation`, no
   * `SigningNonce`, no signature parameter. `vrg`-signing every read would
   * grow `AdminSignature` with read traffic, which D-02 refused to pay.
   */
  async recordRegistrantAccessEvent (registrantId: string, viewerUserId: string, fields: string[]): Promise<void> {
    this.requireCtx('recordRegistrantAccessEvent')
    const ctx = this.ctx!
    try {
      // The allowlist derivation must read RegistrantPrivate.PrivateDetails —
      // which carries the registrant's actual SSN/DOB/phone VALUES — in order
      // to learn the NAMES. `privateDetails` is confined to this one `const`
      // and goes out of scope immediately below: it is never logged, never
      // interpolated into a message, never returned, and never rethrown; only
      // the NAME set `collectPrivateFieldNames` derives from it leaves this
      // statement (T-47-11).
      const privateRow = await ctx.db
        .prepare(
          'select T.PrivateDetails '
          + `from RegistrantPrivate T ${REGISTRANT_PRIVATE_POINT_CURRENCY_JOIN} `
          + 'where T.RegistrantId = :registrantId'
        )
        .get({ registrantId })
      const privateDetails = parseJsonOr<PrivateDetail[]>(privateRow?.PrivateDetails, [], 'RegistrantPrivate.PrivateDetails')
      const allowedNames = collectPrivateFieldNames(privateDetails)

      const safeFields = sanitizeAccessTrailFields(fields, allowedNames)
      if (safeFields.length === 0) {
        // The normal no-reveal case (an empty visit accumulator flushes
        // nothing) and also what a caller passing VALUES instead of NAMES
        // collapses to — resolve without allocating a Tid or touching the DB.
        return
      }

      // Sequence allocation is a read-then-insert with no enclosing
      // transaction, so two overlapping calls can read the same
      // `max(Sequence)` and the second insert then violates
      // `primary key (RegistrantId, Sequence)`. This is genuinely reachable:
      // `useAccessTrailVisit` fires BOTH its flushes as fire-and-forget
      // (`void visitRef.current?.flush()`), so a background flush and an
      // unmount flush can overlap, and `createAccessTrailVisit.flush()`
      // swallows the rejection in an empty catch — the losing audit row would
      // disappear with no trace at all.
      //
      // Retry rather than lock: on a failed insert, re-read the high-water
      // mark. If it ADVANCED past the sequence we tried, another writer won
      // the race and we retry with the new value. If it did not advance, the
      // failure was not a race (a CHECK violation, a storage error) and is
      // rethrown immediately — deliberately not sniffing the driver's error
      // TEXT for "primary key", which would silently stop working the moment
      // that wording changed. Known imprecision, accepted: a non-race failure
      // that COINCIDES with an unrelated writer advancing the counter is
      // still classified as a race and retried. It costs at most
      // SEQUENCE_ALLOCATION_ATTEMPTS attempts before the original error is
      // rethrown, and the own-row probe below keeps it from duplicating a row.
      const readNextSequence = async (): Promise<number> => {
        const seqRow = await ctx.db
          .prepare('select coalesce(max(Sequence), -1) + 1 as n from RegistrantAccessEvent where RegistrantId = :registrantId')
          .get({ registrantId })
        return asNumberOr(seqRow?.n, 0, 'RegistrantAccessEvent.Sequence')
      }

      const timestamp = toIsoZDatetime(Date.now())
      const fieldsJson = JSON.stringify(safeFields)

      // "Did the counter move?" is NOT the same question as "did another
      // writer win?" — our own row moves it too. If `db.exec` rejects AFTER
      // the row landed (project memory records intermittent
      // `stale revision: rev 1 vs rev 1` rejections from @optimystic/db-p2p
      // 0.18), a bare high-water test reads our own row as someone else's,
      // retries at sequence + 1, and appends a SECOND copy of the same
      // logical event. `RegistrantAccessEvent` is
      // `constraint InsertOnly check on update, delete (false)`, so that
      // duplicate can never be removed. The fresh-Tid-per-attempt note above
      // rules out Tid replay, not row duplication.
      //
      // So probe for OUR row specifically, comparing every non-key column:
      // a row another writer placed at this sequence differs in at least one
      // of ViewerUserId / Timestamp / Fields. (Two flushes that agree on all
      // three are byte-identical audit rows for one viewer at one instant;
      // treating those as already-landed is the safe reading, since the
      // alternative is a permanent unremovable duplicate.)
      //
      // TIMESTAMP COMPARISON MUST BE SEMANTIC, NOT TEXTUAL.
      //
      // `Timestamp` does not round-trip as the string that was bound. Quereus
      // coerces the `datetime` column through a `Temporal.PlainDateTime`-shaped
      // normalization which (a) drops the trailing `Z` that `TimestampValid`
      // requires on the way IN, and (b) STRIPS TRAILING ZEROS from the
      // fractional seconds. Observed: bound `2026-08-05T12:04:31.910Z` stored
      // as `2026-08-05T12:04:31.91`.
      //
      // (b) is why an earlier `stripZ`-only comparison was intermittently
      // wrong rather than always wrong: it only diverges when `Date.now()`
      // lands on a millisecond ending in zero, i.e. roughly one call in ten.
      // The consequence was the exact defect this probe exists to prevent —
      // the probe answered "not ours", the retry ran, and a SECOND copy of the
      // same logical event was appended to a table declared
      // `constraint InsertOnly check on update, delete (false)`, so the
      // duplicate could never be removed. It presented as a ~10% flaky test.
      //
      // Comparing instants sidesteps every formatting question: parse both
      // sides to epoch milliseconds, appending `Z` to the stored value because
      // Quereus stores UTC without a designator and `new Date()` would
      // otherwise read it as LOCAL time (see `fromCanonicalDatetime` in
      // utils.ts). Any future change to the stored spelling — more or fewer
      // fractional digits, a space separator — is absorbed automatically.
      const asInstant = (value: string): number => {
        const withZone = value.endsWith('Z') ? value : `${value}Z`
        return new Date(withZone).getTime()
      }
      const sameInstant = (stored: string, bound: string): boolean => {
        const a = asInstant(stored)
        const b = asInstant(bound)
        // An unparseable value must never compare equal — that would report a
        // foreign row as ours and DROP a legitimate audit write.
        return !Number.isNaN(a) && !Number.isNaN(b) && a === b
      }
      const ownRowLanded = async (seq: number): Promise<boolean> => {
        const row = await ctx.db
          .prepare('select ViewerUserId, Timestamp, Fields from RegistrantAccessEvent where RegistrantId = :registrantId and Sequence = :sequence')
          .get({ registrantId, sequence: seq })
        if (row === null || row === undefined) return false
        return String(row.ViewerUserId ?? '') === viewerUserId &&
          sameInstant(String(row.Timestamp ?? ''), timestamp) &&
          String(row.Fields ?? '') === fieldsJson
      }

      for (let attempt = 0; attempt < SEQUENCE_ALLOCATION_ATTEMPTS; attempt++) {
        const sequence = await readNextSequence()
        // A fresh Tid per attempt — a Tid is consumed by the attempt that
        // used it, never replayed into a second insert.
        const tid = await allocateTid(ctx.db, 'registration')

        try {
          // CORRECTNESS TRAP (T-47-15): `Timestamp`'s `TimestampValid` CHECK is
          // IMMEDIATE (no subquery), so it sees the raw bound value and requires
          // a trailing `Z`. `nowCanonicalDatetime()` returns a 19-char string
          // with NO `Z` — binding it into the `Timestamp` COLUMN fails the
          // CHECK. Bind a Z-suffixed value into the column and the Z-less
          // canonical form into the context `now`, matching `createRegistrant`'s
          // Z-suffixed `expiration` alongside a Z-less `now`. NOTE: this
          // deliberately diverges from `47-RESEARCH.md` Code Examples §1 and
          // `47-PATTERNS.md` §6, which both show `:now` bound into `Timestamp` —
          // that form fails this CHECK.
          await ctx.db.exec(
            `insert into RegistrantAccessEvent (RegistrantId, ViewerUserId, Sequence, Timestamp, Fields)
             with context Tid = ${tid}, now = :now
             values (:registrantId, :viewerUserId, :sequence, :timestamp, :fields)`,
            {
              registrantId,
              viewerUserId,
              sequence,
              timestamp,
              now: nowCanonicalDatetime(),
              fields: fieldsJson
            }
          )
          return
        } catch (err) {
          if (attempt + 1 >= SEQUENCE_ALLOCATION_ATTEMPTS) throw err
          // Both probes are fresh round trips issued immediately after a
          // storage failure — i.e. exactly when they are most likely to fail
          // too. Their own rejection must never REPLACE the insert error the
          // caller actually needs to see, so the whole diagnosis is wrapped
          // and collapses to `throw err`.
          let anotherWriterWon: boolean
          try {
            if (await ownRowLanded(sequence)) return
            anotherWriterWon = (await readNextSequence()) > sequence
          } catch {
            throw err
          }
          if (!anotherWriterWon) throw err
        }
      }
    } catch (err) {
      this.rethrow(err, 'recordRegistrantAccessEvent')
    }
  }

  /**
   * D-01: the reviewer read — a write-only trail was explicitly rejected.
   * The select list is fixed at RegistrantId/ViewerUserId/Sequence/
   * Timestamp/Fields and touches no `RegistrantPrivate`, `RegistrantSelective`,
   * or `RegistrantPublic` column, so this read cannot widen the private
   * tier's disclosure surface (T-47-12).
   */
  async getRegistrantAccessEvents (registrantId: string): Promise<RegistrantAccessEvent[]> {
    if (!this.ctx) return []
    const ctx = this.ctx
    const out: RegistrantAccessEvent[] = []
    try {
      for await (const row of ctx.db.eval(
        'select RegistrantId, ViewerUserId, Sequence, Timestamp, Fields from RegistrantAccessEvent where RegistrantId = :registrantId order by Sequence desc',
        { registrantId }
      )) {
        out.push({
          registrantId: asText(row.RegistrantId, 'RegistrantAccessEvent.RegistrantId'),
          viewerUserId: asText(row.ViewerUserId, 'RegistrantAccessEvent.ViewerUserId'),
          sequence: asNumberOr(row.Sequence, 0, 'RegistrantAccessEvent.Sequence'),
          timestamp: reZuluDatetime(row.Timestamp as string),
          fields: parseJsonOr<string[]>(row.Fields, [], 'RegistrantAccessEvent.Fields')
        })
      }
      return out
    } catch (err) {
      this.rethrow(err, 'getRegistrantAccessEvents')
    }
  }

  /**
   * D-14: off-schema read (JS only — no SQL set_verify) revealing only the
   * `ElectionDisclosurePolicy`-permitted subset of a registrant's selective
   * set for `audience` (or the 'everyone' audience). Withheld leaves are
   * reduced to opaque digests by the plugin's own `setDisclose` — their raw
   * `value`/`salt` NEVER cross this boundary, and `SelectiveDetails` is never
   * logged (Information Disclosure mitigation, T-42-08-05). Returns `null`
   * when the registrant has no `RegistrantSelective` row at all.
   */
  async getDisclosedSelective (electionId: string, registrantId: string, audience: string): Promise<DisclosedSelective | null> {
    this.requireCtx('getDisclosedSelective')
    const ctx = this.ctx!
    try {
      const row = await ctx.db
        .prepare(
          'select T.Cid, T.SelectiveDetails '
          + `from RegistrantSelective T ${REGISTRANT_SELECTIVE_POINT_CURRENCY_JOIN} `
          + 'where T.RegistrantId = :registrantId'
        )
        .get({ registrantId })
      if (!row) return null
      const cid = asText(row.Cid, 'RegistrantSelective.Cid')
      const leaves = parseJsonOr<SelectiveLeaf[]>(row.SelectiveDetails, [], 'RegistrantSelective.SelectiveDetails')

      const permitted = new Set<string>()
      for await (const policyRow of ctx.db.eval(
        'select FieldName from ElectionDisclosurePolicy where ElectionId = :electionId and (Audience = :audience or Audience = :everyone)',
        { electionId, audience, everyone: 'everyone' }
      )) {
        permitted.add(asText(policyRow.FieldName, 'ElectionDisclosurePolicy.FieldName'))
      }

      const { disclosed, hidden } = setDisclose(leaves, [...permitted])
      const disclosedOut: SelectiveLeaf[] = disclosed.map((leaf) => ({
        name: leaf.name,
        value: leaf.value as SelectiveLeaf['value'],
        salt: typeof leaf.salt === 'string' ? leaf.salt : asText(leaf.salt, 'salt')
      }))

      const selectiveDetailsText = asText(row.SelectiveDetails, 'RegistrantSelective.SelectiveDetails')
      const rootRow = await ctx.db.prepare('select set_commit(:details) as r').get({ details: selectiveDetailsText })
      if (!rootRow || rootRow.r == null) {
        throw new Error('getDisclosedSelective: set_commit(...) returned null — crypto plugin not registered?')
      }
      const root = asText(rootRow.r, 'set_commit root')

      return { cid, root, disclosed: disclosedOut, hidden: [...hidden] }
    } catch (err) {
      this.rethrow(err, 'getDisclosedSelective')
    }
  }

  /**
   * D-04/D-05/D-06: the registrant roster read. Filter dimensions are ANDed
   * (D-04); paging is keyset on `Registrant.Id` with `total` computed only on
   * a cursor-absent call (D-05); rows join the CURRENT `RegistrantPublic` row
   * only, via the shared `buildRegistrantListFragment`'s D-06 currency
   * predicate (see `registrant-list-query.ts`). Mirrors
   * `getElectionRegistrationFields`'s no-ctx convention — no context yet
   * means an empty page, not an error.
   */
  async listRegistrants (filter?: RegistrantListFilter, page?: RegistrantListPage): Promise<RegistrantListResult> {
    if (!this.ctx) return { rows: [] }
    const ctx = this.ctx
    try {
      const pageSize = clampPageSize(page?.pageSize)
      const cursor = page?.cursor
      const { sql, params } = buildRegistrantListPageSql(filter, cursor, pageSize)
      const rows: RegistrantListRow[] = []
      for await (const row of ctx.db.eval(sql, params as Record<string, SqlValue>)) {
        rows.push({
          registrantId: asText(row.Id, 'Registrant.Id'),
          authorityId: asText(row.AuthorityId, 'Registrant.AuthorityId'),
          status: asText(row.Status, 'Registrant.Status') as RegistrantStatus,
          expiration: reZuluDatetime(row.Expiration as string),
          privateCid: asText(row.PrivateCid, 'Registrant.PrivateCid'),
          publicCid: row.PublicCid == null ? undefined : asText(row.PublicCid, 'Registrant.PublicCid'),
          selectiveCid: row.SelectiveCid == null ? undefined : asText(row.SelectiveCid, 'Registrant.SelectiveCid'),
          lastName: row.LastName == null ? undefined : asText(row.LastName, 'RegistrantPublic.LastName'),
          firstName: row.FirstName == null ? undefined : asText(row.FirstName, 'RegistrantPublic.FirstName'),
          district: row.District == null ? undefined : asText(row.District, 'RegistrantPublic.District')
        })
      }

      const nextCursor = rows.length === pageSize ? rows[rows.length - 1]!.registrantId : undefined

      let total: number | undefined
      if (cursor === undefined) {
        // D-05: run once per filter-change (a cursor-absent call), never per
        // page. A failed count degrades to `total: undefined` — the roster
        // read must never fail because counting failed.
        try {
          const countSql = buildRegistrantListCountSql(filter)
          const countRow = await ctx.db.prepare(countSql.sql).get(countSql.params as Record<string, SqlValue>)
          total = asNumberOr(countRow?.n, 0, 'listRegistrants.total')
        } catch {
          // T-47-06: deliberately NOT logged and NOT interpolated into any
          // message — the count query's bound params can carry the
          // officer's typed `name` search term, which is registrant PII
          // under D-01's never-log rule. A future "let's log this" change
          // must be a deliberate decision, not an accident.
          total = undefined
        }
      }

      return { rows, nextCursor, total }
    } catch (err) {
      this.rethrow(err, 'listRegistrants')
    }
  }

  // ---------- Register builder ----------

  buildRegister (): IRegistrationRegisterBuilder {
    return new RegistrationRegisterBuilder(this)
  }

  /**
   * D-02/Pitfall 4: the multi-row Register ceremony. Computes ALL tier Cids
   * BEFORE the `Registrant` insert (its PrivateCid/PublicCid/SelectiveCid
   * columns are NOT NULL-or-precomputed and must already carry the tier's
   * derived Cid), inserts the parent `Registrant` row, THEN inserts the tier
   * rows (each independently re-deriving the SAME deterministic Cid — or,
   * for the selective tier, reusing the SAME engine-generated leaves — and
   * running its OWN `vrg` ceremony) — all inside one BEGIN/COMMIT/ROLLBACK
   * envelope so a partial failure never strands an orphaned `Registrant`.
   */
  async register (init: RegisterInit, signatureOrCallback: SignatureOrCallback): Promise<void> {
    this.requireCtx('register')
    const ctx = this.ctx!
    // D-09: engine-side field-policy enforcement runs BEFORE any DB ceremony —
    // there is NO schema CHECK backstop (deliberate gap, RESEARCH V5). Only
    // runs when the submission carries an electionId (D-10 election-scoped
    // policy) — a submission with no electionId has no policy to enforce
    // against and proceeds exactly as before this plan.
    if (init.electionId) {
      // WR-03 (42-REVIEW): the election whose field policy governs this
      // submission MUST belong to the same authority that is registering this
      // person. Without this check, a caller could pass an electionId owned by
      // an unrelated authority — enforcing that authority's policy, or (worse)
      // silently passing validation against a policy-less election while the
      // caller's own election carries a stricter one. Mirrors CR-01's
      // authority-ownership discipline at the engine layer (field policy has no
      // schema CHECK backstop per D-09, so this IS the only guard).
      const electionAuthorityId = await this.resolveElectionAuthorityId(init.electionId, 'register')
      if (electionAuthorityId !== init.registrant.authorityId) {
        throw new Error(
          `RegistrationEngine.register: electionId ${init.electionId} belongs to authority ${electionAuthorityId}, not the registrant's authority ${init.registrant.authorityId} — cross-authority registration is not permitted`
        )
      }
      await validateFieldPolicy(ctx, init.electionId, init)
    }

    // D-11/D-12/D-13: validate + generate the selective leaves BEFORE the DB
    // ceremony (BEGIN) — duplicate-name/empty-salt rejection must never open
    // a transaction. Pitfall 3: the "payload provided" and "insert a
    // RegistrantSelective row" gates are the SAME — only a non-empty
    // `selective.details` list enters this branch; an absent/empty payload
    // never touches `set_commit` and `Registrant.SelectiveCid` stays NULL.
    let selectiveLeaves: SelectiveLeaf[] | undefined
    let selectiveCid: string | undefined
    if (init.selective && init.selective.details.length > 0) {
      selectiveLeaves = await this.buildSelectiveLeaves(init.selective.details)
      selectiveCid = await this.computeRegistrantSelectiveCid(JSON.stringify(selectiveLeaves))
    }

    const registrantId = init.registrant.id
    try {
      await ctx.db.exec('BEGIN')
      try {
        // Cids-before-parent (Pitfall 4).
        let publicCid: string | undefined
        if (init.public) {
          publicCid = await this.computeRegistrantPublicCid(registrantId, init.public)
        }
        const privateCid = await this.computeRegistrantPrivateCid(registrantId, {
          expiration: init.private.expiration,
          details: init.private.details
        })

        // Parent row first, carrying the pre-computed Cids (own vrg ceremony).
        // `{ ownsTransaction: false }`: register() already owns the outer BEGIN
        // above — Quereus's transaction model is flat (no nested BEGIN), so the
        // inner ceremony's SigningEngine.sign() must NOT start its own nested
        // transaction (see SigningEngine.sign()'s doc comment / T-42-03).
        await this.createRegistrant(
          {
            id: registrantId,
            authorityId: init.registrant.authorityId,
            privateCid,
            publicCid,
            selectiveCid,
            expiration: init.registrant.expiration
          },
          signatureOrCallback,
          { ownsTransaction: false }
        )

        // Tier rows after — each recomputes the SAME deterministic Cid and runs
        // its OWN vrg ceremony (Pitfall 4); RegistrantCidMatch now finds the
        // just-committed parent Cid.
        if (init.public) {
          await this.createRegistrantPublic({ registrantId, ...init.public }, signatureOrCallback, { ownsTransaction: false })
        }
        await this.createRegistrantPrivate(
          { registrantId, expiration: init.private.expiration, details: init.private.details },
          signatureOrCallback,
          { ownsTransaction: false }
        )
        if (selectiveLeaves && selectiveCid) {
          await this.insertRegistrantSelectiveRow(
            registrantId,
            init.selective!.expiration,
            selectiveLeaves,
            selectiveCid,
            signatureOrCallback,
            { ownsTransaction: false }
          )
        }

        await ctx.db.exec('COMMIT')
      } catch (innerErr) {
        await ctx.db.exec('ROLLBACK')
        throw innerErr
      }
    } catch (err) {
      this.rethrow(err, 'register')
    }
  }

  // ---------- ElectionRegistrant roster (authority-only, D-17) ----------

  /**
   * D-17: authority-only roster enrollment. `ElectionRegistrant` is `NoUpdate`
   * (no update method exists, deliberately — see `IRegistrationEngine`'s doc
   * comment) — insert/delete are the only mutations. `InsertValid` requires a
   * `vrg`-scoped AdminSignature over `Digest(Tid, ElectionId, RegistrantId)`;
   * there is NO self-enroll code path — the officer's `sign` callback is the
   * sole authorization route (`RegistrantIdValid`/`RegistrantNotExpired`
   * independently gate eligibility at the schema layer).
   */
  async enrollElectionRegistrant (electionId: string, registrantId: string, signatureOrCallback: SignatureOrCallback): Promise<void> {
    this.requireCtx('enrollElectionRegistrant')
    const ctx = this.ctx!
    try {
      const authorityId = await this.resolveRegistrantAuthorityId(registrantId, 'enrollElectionRegistrant')
      const tid = await allocateTid(ctx.db, 'registration')
      const digestExpr = 'select Digest(:tid, :electionId, :registrantId) as d'
      const digestParams = { tid, electionId, registrantId }
      const nonce = await seedSignedMutation(ctx, authorityId, 'vrg', tid, digestExpr, digestParams, this.resolveSign(signatureOrCallback))

      await ctx.db.exec(
        `insert into ElectionRegistrant (ElectionId, RegistrantId)
         with context SigningNonce = :signingNonce, Tid = ${tid}, now = :now
         values (:electionId, :registrantId)`,
        { electionId, registrantId, signingNonce: nonce, now: nowCanonicalDatetime() }
      )
    } catch (err) {
      this.rethrow(err, 'enrollElectionRegistrant')
    }
  }

  /**
   * D-17: authority-only roster removal. `DeleteValid` requires a `vrg`-
   * scoped AdminSignature over `Digest(Tid, ElectionId, RegistrantId, 'delete')`
   * — the literal `'delete'` sentinel is a SQL literal inside the digest
   * expression, not a bound param (matches the schema's own formula verbatim).
   */
  async removeElectionRegistrant (electionId: string, registrantId: string, signatureOrCallback: SignatureOrCallback): Promise<void> {
    this.requireCtx('removeElectionRegistrant')
    const ctx = this.ctx!
    try {
      const authorityId = await this.resolveRegistrantAuthorityId(registrantId, 'removeElectionRegistrant')
      const tid = await allocateTid(ctx.db, 'registration')
      const digestExpr = "select Digest(:tid, :electionId, :registrantId, 'delete') as d"
      const digestParams = { tid, electionId, registrantId }
      const nonce = await seedSignedMutation(ctx, authorityId, 'vrg', tid, digestExpr, digestParams, this.resolveSign(signatureOrCallback))

      await ctx.db.exec(
        `delete from ElectionRegistrant
         with context SigningNonce = :signingNonce, Tid = ${tid}, now = :now
         where ElectionId = :electionId and RegistrantId = :registrantId`,
        { electionId, registrantId, signingNonce: nonce, now: nowCanonicalDatetime() }
      )
    } catch (err) {
      this.rethrow(err, 'removeElectionRegistrant')
    }
  }

  /**
   * D-07: thin, faithful direct read of `ElectionRegistrant` — NOT routed
   * through `listRegistrants`. The declared return type is
   * `ElectionRegistrant[]` (`{electionId, registrantId}` pairs), a much
   * narrower shape than `RegistrantListResult`; this method exists for
   * non-UI callers of the interface's declared signature. The roster
   * SCREEN uses `listRegistrants({ electionId })` instead.
   */
  async getElectionRegistrants (electionId: string): Promise<ElectionRegistrant[]> {
    if (!this.ctx) return []
    const ctx = this.ctx
    const out: ElectionRegistrant[] = []
    try {
      for await (const row of ctx.db.eval(
        'select ElectionId, RegistrantId from ElectionRegistrant where ElectionId = :electionId',
        { electionId }
      )) {
        out.push({
          electionId: asText(row.ElectionId, 'ElectionRegistrant.ElectionId'),
          registrantId: asText(row.RegistrantId, 'ElectionRegistrant.RegistrantId')
        })
      }
      return out
    } catch (err) {
      this.rethrow(err, 'getElectionRegistrants')
    }
  }

  // ---------- Permissive registrant lifecycle (D-16) ----------

  /**
   * D-16: change Status ('a'|'s'|'r'). Deliberately NO transition guard beyond
   * the schema's own `StatusValid` enum membership check — any direction is
   * allowed; the `vrg` AdminSignature is the sole control (`MutationValid`).
   */
  async changeStatus (registrantId: string, status: RegistrantStatus, signatureOrCallback: SignatureOrCallback): Promise<void> {
    try {
      await this.updateRegistrantRow(registrantId, { status }, signatureOrCallback, 'changeStatus')
    } catch (err) {
      this.rethrow(err, 'changeStatus')
    }
  }

  /**
   * D-16: renewal — change Expiration under a fresh `vrg`-signed mutation.
   * `ExpirationFuture` is `check on insert` ONLY — an update to ANY Expiration
   * value (including one `ExpirationFuture` would reject on insert) succeeds.
   */
  async changeExpiration (registrantId: string, expiration: string, signatureOrCallback: SignatureOrCallback): Promise<void> {
    try {
      await this.updateRegistrantRow(registrantId, { expiration }, signatureOrCallback, 'changeExpiration')
    } catch (err) {
      this.rethrow(err, 'changeExpiration')
    }
  }

  /**
   * D-08/D-10: election-keyed, `mel`-signed policy declaration — the
   * `ElectionDisclosurePolicy` twin. `AuthorityId` for the ceremony is
   * resolved from the OWNING election row (`Election.AuthorityId`), matching
   * the schema's own `join Election E on E.Id = new.ElectionId` +
   * `A.AuthorityId = E.AuthorityId` clause. Tier/Requirement are TEXT codes
   * validated against the `RegistrantTier`/`FieldRequirement` enum views by
   * the schema's own `TierValid`/`RequirementValid` CHECKs — this method
   * does not re-validate them app-side (D-08 single source of truth).
   */
  async addElectionRegistrationField (field: ElectionRegistrationField, signatureOrCallback: SignatureOrCallback): Promise<void> {
    this.requireCtx('addElectionRegistrationField')
    const ctx = this.ctx!
    try {
      const authorityId = await this.resolveElectionAuthorityId(field.electionId, 'addElectionRegistrationField')
      const tid = await allocateTid(ctx.db, 'registration')
      const digestExpr = 'select Digest(:tid, :electionId, :fieldName, :tier, :requirement) as d'
      const digestParams = { tid, electionId: field.electionId, fieldName: field.fieldName, tier: field.tier, requirement: field.requirement }
      const nonce = await seedSignedMutation(ctx, authorityId, 'mel', tid, digestExpr, digestParams, this.resolveSign(signatureOrCallback))

      await ctx.db.exec(
        `insert into ElectionRegistrationField (ElectionId, FieldName, Tier, Requirement)
         with context SigningNonce = :signingNonce, Tid = ${tid}
         values (:electionId, :fieldName, :tier, :requirement)`,
        {
          electionId: field.electionId,
          fieldName: field.fieldName,
          tier: field.tier,
          requirement: field.requirement,
          signingNonce: nonce
        }
      )
    } catch (err) {
      this.rethrow(err, 'addElectionRegistrationField')
    }
  }

  /**
   * D-08/D-10: policy removal. `DeleteValid` re-derives
   * `Digest(Tid, old.ElectionId, old.FieldName, old.Tier, old.Requirement, 'delete')`
   * — unlike `AuthorityPeer`/`PollingDevice` (whose whole row IS the PK), this
   * table carries Tier/Requirement DATA beyond its `(ElectionId, FieldName)`
   * PK, so the ceremony digest must read the row's CURRENT Tier/Requirement
   * back from the DB before computing the delete digest.
   */
  async removeElectionRegistrationField (electionId: string, fieldName: string, signatureOrCallback: SignatureOrCallback): Promise<void> {
    this.requireCtx('removeElectionRegistrationField')
    const ctx = this.ctx!
    try {
      const authorityId = await this.resolveElectionAuthorityId(electionId, 'removeElectionRegistrationField')
      const existing = await ctx.db
        .prepare('select Tier, Requirement from ElectionRegistrationField where ElectionId = :electionId and FieldName = :fieldName')
        .get({ electionId, fieldName })
      if (!existing) {
        throw new Error(`removeElectionRegistrationField: ElectionRegistrationField not found for electionId=${electionId}, fieldName=${fieldName}`)
      }
      const tier = asText(existing.Tier, 'ElectionRegistrationField.Tier')
      const requirement = asText(existing.Requirement, 'ElectionRegistrationField.Requirement')
      const tid = await allocateTid(ctx.db, 'registration')
      const digestExpr = "select Digest(:tid, :electionId, :fieldName, :tier, :requirement, 'delete') as d"
      const digestParams = { tid, electionId, fieldName, tier, requirement }
      const nonce = await seedSignedMutation(ctx, authorityId, 'mel', tid, digestExpr, digestParams, this.resolveSign(signatureOrCallback))

      await ctx.db.exec(
        `delete from ElectionRegistrationField
         with context SigningNonce = :signingNonce, Tid = ${tid}
         where ElectionId = :electionId and FieldName = :fieldName`,
        { electionId, fieldName, signingNonce: nonce }
      )
    } catch (err) {
      this.rethrow(err, 'removeElectionRegistrationField')
    }
  }

  async getElectionRegistrationFields (electionId: string): Promise<ElectionRegistrationField[]> {
    if (!this.ctx) return []
    const ctx = this.ctx
    const out: ElectionRegistrationField[] = []
    try {
      for await (const row of ctx.db.eval(
        'select ElectionId, FieldName, Tier, Requirement from ElectionRegistrationField where ElectionId = :electionId',
        { electionId }
      )) {
        out.push({
          electionId: asText(row.ElectionId, 'ElectionRegistrationField.ElectionId'),
          fieldName: asText(row.FieldName, 'ElectionRegistrationField.FieldName'),
          tier: asText(row.Tier, 'ElectionRegistrationField.Tier') as ElectionRegistrationField['tier'],
          requirement: asText(row.Requirement, 'ElectionRegistrationField.Requirement') as ElectionRegistrationField['requirement']
        })
      }
      return out
    } catch (err) {
      this.rethrow(err, 'getElectionRegistrationFields')
    }
  }

  // ---------- ElectionDisclosurePolicy (D-14, additive — declares which selective ----------
  // ---------- fields getDisclosedSelective may reveal, and to which audience) ----------

  /**
   * D-14: election policy declaring which `RegistrantSelective` field names
   * may be disclosed, and to which audience ('district' | 'everyone').
   * Companion to `ElectionRegistrationField` (42-07) — the SAME 'mel'-scoped,
   * election-keyed ceremony shape (`AuthorityId` resolved from the OWNING
   * `Election` row). Additive (not part of `IRegistrationEngine`, mirroring
   * `createRegistrant*`'s additive-CRUD precedent) — `getDisclosedSelective`
   * is the interface's disclosure-facing READ; this is the policy-declaring
   * WRITE those rows need to exist at all (the schema only declares the
   * table + its CHECKs, it does not seed policy rows).
   */
  async addElectionDisclosurePolicy (policy: ElectionDisclosurePolicy, signatureOrCallback: SignatureOrCallback): Promise<void> {
    this.requireCtx('addElectionDisclosurePolicy')
    const ctx = this.ctx!
    try {
      const authorityId = await this.resolveElectionAuthorityId(policy.electionId, 'addElectionDisclosurePolicy')
      const tid = await allocateTid(ctx.db, 'registration')
      const digestExpr = 'select Digest(:tid, :electionId, :fieldName, :audience) as d'
      const digestParams = { tid, electionId: policy.electionId, fieldName: policy.fieldName, audience: policy.audience }
      const nonce = await seedSignedMutation(ctx, authorityId, 'mel', tid, digestExpr, digestParams, this.resolveSign(signatureOrCallback))

      await ctx.db.exec(
        `insert into ElectionDisclosurePolicy (ElectionId, FieldName, Audience)
         with context SigningNonce = :signingNonce, Tid = ${tid}
         values (:electionId, :fieldName, :audience)`,
        { electionId: policy.electionId, fieldName: policy.fieldName, audience: policy.audience, signingNonce: nonce }
      )
    } catch (err) {
      this.rethrow(err, 'addElectionDisclosurePolicy')
    }
  }

  /**
   * D-14: policy removal. `DeleteValid` re-derives
   * `Digest(Tid, old.ElectionId, old.FieldName, old.Audience, 'delete')` — this
   * table carries `Audience` DATA beyond its `(ElectionId, FieldName)` PK, so
   * the ceremony digest must read the row's CURRENT Audience back from the DB
   * first (same shape as `removeElectionRegistrationField`'s Tier/Requirement
   * re-read).
   */
  async removeElectionDisclosurePolicy (electionId: string, fieldName: string, signatureOrCallback: SignatureOrCallback): Promise<void> {
    this.requireCtx('removeElectionDisclosurePolicy')
    const ctx = this.ctx!
    try {
      const authorityId = await this.resolveElectionAuthorityId(electionId, 'removeElectionDisclosurePolicy')
      const existing = await ctx.db
        .prepare('select Audience from ElectionDisclosurePolicy where ElectionId = :electionId and FieldName = :fieldName')
        .get({ electionId, fieldName })
      if (!existing) {
        throw new Error(`removeElectionDisclosurePolicy: ElectionDisclosurePolicy not found for electionId=${electionId}, fieldName=${fieldName}`)
      }
      const audience = asText(existing.Audience, 'ElectionDisclosurePolicy.Audience')
      const tid = await allocateTid(ctx.db, 'registration')
      const digestExpr = "select Digest(:tid, :electionId, :fieldName, :audience, 'delete') as d"
      const digestParams = { tid, electionId, fieldName, audience }
      const nonce = await seedSignedMutation(ctx, authorityId, 'mel', tid, digestExpr, digestParams, this.resolveSign(signatureOrCallback))

      await ctx.db.exec(
        `delete from ElectionDisclosurePolicy
         with context SigningNonce = :signingNonce, Tid = ${tid}
         where ElectionId = :electionId and FieldName = :fieldName`,
        { electionId, fieldName, signingNonce: nonce }
      )
    } catch (err) {
      this.rethrow(err, 'removeElectionDisclosurePolicy')
    }
  }

  async getElectionDisclosurePolicies (electionId: string): Promise<ElectionDisclosurePolicy[]> {
    if (!this.ctx) return []
    const ctx = this.ctx
    const out: ElectionDisclosurePolicy[] = []
    try {
      for await (const row of ctx.db.eval(
        'select ElectionId, FieldName, Audience from ElectionDisclosurePolicy where ElectionId = :electionId',
        { electionId }
      )) {
        out.push({
          electionId: asText(row.ElectionId, 'ElectionDisclosurePolicy.ElectionId'),
          fieldName: asText(row.FieldName, 'ElectionDisclosurePolicy.FieldName'),
          audience: asText(row.Audience, 'ElectionDisclosurePolicy.Audience') as DisclosureAudience
        })
      }
      return out
    } catch (err) {
      this.rethrow(err, 'getElectionDisclosurePolicies')
    }
  }

  // ---------- ElectionAttestationPolicy (D-14b, additive -- declares whether an ----------
  // ---------- election requires device attestation to Associate; consumed by 45-04's ----------
  // ---------- associate() ceremony) ----------

  /**
   * D-14b: election policy declaring whether device attestation is required to Associate.
   * Single row per election (PK = ElectionId alone, unlike ElectionRegistrationField's
   * append-only (ElectionId, FieldName) PK) -- an UPSERT via `insert or replace`
   * (Quereus-supported, precedented by `election-engine.ts`'s `proposeBallot`
   * `insert or replace into ProposedBallot`). Same 'mel'-scoped, election-keyed
   * ceremony shape as addElectionRegistrationField/addElectionDisclosurePolicy
   * (`AuthorityId` resolved from the OWNING `Election` row). The digest arg order
   * (`Tid, ElectionId, AttestationRequired`) MUST match the table's own `MutationValid`
   * CHECK exactly.
   */
  async setElectionAttestationPolicy (electionId: string, attestationRequired: boolean, signatureOrCallback: SignatureOrCallback): Promise<void> {
    this.requireCtx('setElectionAttestationPolicy')
    const ctx = this.ctx!
    try {
      const authorityId = await this.resolveElectionAuthorityId(electionId, 'setElectionAttestationPolicy')
      const tid = await allocateTid(ctx.db, 'registration')
      const requiredInt = attestationRequired ? 1 : 0
      const digestExpr = 'select Digest(:tid, :electionId, :attestationRequired) as d'
      const digestParams = { tid, electionId, attestationRequired: requiredInt }
      const nonce = await seedSignedMutation(ctx, authorityId, 'mel', tid, digestExpr, digestParams, this.resolveSign(signatureOrCallback))

      await ctx.db.exec(
        `insert or replace into ElectionAttestationPolicy (ElectionId, AttestationRequired)
         with context SigningNonce = :signingNonce, Tid = ${tid}
         values (:electionId, :attestationRequired)`,
        { electionId, attestationRequired: requiredInt, signingNonce: nonce }
      )
    } catch (err) {
      this.rethrow(err, 'setElectionAttestationPolicy')
    }
  }

  /** D-14b: read the stored attestation-required flag for an election; undefined when no policy row exists. */
  async getElectionAttestationPolicy (electionId: string): Promise<ElectionAttestationPolicy | undefined> {
    if (!this.ctx) return undefined
    const ctx = this.ctx
    try {
      const row = await ctx.db
        .prepare('select ElectionId, AttestationRequired from ElectionAttestationPolicy where ElectionId = :electionId')
        .get({ electionId })
      if (!row) return undefined
      return {
        electionId: asText(row.ElectionId, 'ElectionAttestationPolicy.ElectionId'),
        attestationRequired: Number(row.AttestationRequired) !== 0
      }
    } catch (err) {
      this.rethrow(err, 'getElectionAttestationPolicy')
    }
  }

  /**
   * D-07 (46): revert-to-default — a 'mel'-signed read-then-delete mirroring
   * `removeElectionDisclosurePolicy`'s structure. The re-read is mandatory:
   * `DeleteValid`'s digest binds the OLD `AttestationRequired` value
   * (`votetorrent.qsql:1775` — `Digest(context.Tid, old.ElectionId,
   * old.AttestationRequired, 'delete')`), and the PK (`ElectionId` alone) is
   * not sufficient to reconstruct it. After this succeeds,
   * `getElectionAttestationPolicy` returns `undefined` again, so the
   * fail-closed "absent = REQUIRED" default (enforced by 45-04's associate()
   * ceremony / 46-07's UI) applies once more.
   */
  async removeElectionAttestationPolicy (electionId: string, signatureOrCallback: SignatureOrCallback): Promise<void> {
    this.requireCtx('removeElectionAttestationPolicy')
    const ctx = this.ctx!
    try {
      const authorityId = await this.resolveElectionAuthorityId(electionId, 'removeElectionAttestationPolicy')
      const existing = await ctx.db
        .prepare('select AttestationRequired from ElectionAttestationPolicy where ElectionId = :electionId')
        .get({ electionId })
      if (!existing) {
        throw new Error(`removeElectionAttestationPolicy: ElectionAttestationPolicy not found for electionId=${electionId}`)
      }
      const attestationRequired = Number(existing.AttestationRequired)
      const tid = await allocateTid(ctx.db, 'registration')
      const digestExpr = "select Digest(:tid, :electionId, :attestationRequired, 'delete') as d"
      const digestParams = { tid, electionId, attestationRequired }
      const nonce = await seedSignedMutation(ctx, authorityId, 'mel', tid, digestExpr, digestParams, this.resolveSign(signatureOrCallback))

      await ctx.db.exec(
        `delete from ElectionAttestationPolicy
         with context SigningNonce = :signingNonce, Tid = ${tid}
         where ElectionId = :electionId`,
        { electionId, signingNonce: nonce }
      )
    } catch (err) {
      this.rethrow(err, 'removeElectionAttestationPolicy')
    }
  }

  /** Resolve an Election's owning AuthorityId (needed to seed the vrg/mel ceremony's CurrentAdmin lookup). */
  private async resolveElectionAuthorityId (electionId: string, method: string): Promise<string> {
    const ctx = this.ctx!
    const row = await ctx.db
      .prepare('select AuthorityId from Election where Id = :electionId')
      .get({ electionId })
    if (!row) {
      throw new Error(`${method}: Election not found for electionId=${electionId}`)
    }
    return asText(row.AuthorityId, 'Election.AuthorityId')
  }

  // ---------- 42-06 helpers ----------

  /** Resolve a Registrant's owning AuthorityId (needed to seed the vrg ceremony's CurrentAdmin lookup). */
  private async resolveRegistrantAuthorityId (registrantId: string, method: string): Promise<string> {
    const ctx = this.ctx!
    const row = await ctx.db
      .prepare('select AuthorityId from Registrant where Id = :registrantId')
      .get({ registrantId })
    if (!row) {
      throw new Error(`${method}: Registrant not found for registrantId=${registrantId}`)
    }
    return asText(row.AuthorityId, 'Registrant.AuthorityId')
  }

  /**
   * Shared UPDATE ceremony for `changeStatus`/`changeExpiration` — retargets
   * `createRegistrant`'s dual-signing pattern (row-level SignatureValid proof
   * + the vrg AdminSigning/AdminSignature MutationValid ceremony) to an
   * UPDATE. Only Status/Expiration/SignorKey/Signature are ever written —
   * Id/AuthorityId/*Cid stay untouched (IdImmutable/AuthorityIdImmutable).
   */
  private async updateRegistrantRow (
    registrantId: string,
    changes: { status?: RegistrantStatus; expiration?: Timestamp | string },
    signatureOrCallback: SignatureOrCallback,
    method: string
  ): Promise<void> {
    this.requireCtx(method)
    const ctx = this.ctx!
    const currentRow = await ctx.db
      .prepare('select AuthorityId, PrivateCid, PublicCid, SelectiveCid, Status, Expiration from Registrant where Id = :registrantId')
      .get({ registrantId })
    if (!currentRow) {
      throw new Error(`${method}: Registrant not found for registrantId=${registrantId}`)
    }
    const authorityId = asText(currentRow.AuthorityId, 'Registrant.AuthorityId')
    const privateCid = asText(currentRow.PrivateCid, 'Registrant.PrivateCid')
    const publicCid = currentRow.PublicCid == null ? null : asText(currentRow.PublicCid, 'Registrant.PublicCid')
    const selectiveCid = currentRow.SelectiveCid == null ? null : asText(currentRow.SelectiveCid, 'Registrant.SelectiveCid')
    const status = changes.status ?? (asText(currentRow.Status, 'Registrant.Status') as RegistrantStatus)
    const expiration = changes.expiration !== undefined
      ? toIsoZDatetime(changes.expiration)
      : reZuluDatetime(currentRow.Expiration as string)

    const tid = await allocateTid(ctx.db, 'registration')

    // 1. Row-level signor signature (D-19) — SAME 7-field formula as createRegistrant's SignatureValid.
    const rowDigestRow = await ctx.db
      .prepare('select Digest(:id, :authorityId, :privateCid, :publicCid, :selectiveCid, :status, :expiration) as d')
      .get({ id: registrantId, authorityId, privateCid, publicCid, selectiveCid, status, expiration })
    if (!rowDigestRow || rowDigestRow.d == null) {
      throw new Error(`${method}: Digest() returned null for row-level signature — crypto plugin not registered?`)
    }
    const rowDigestBytes = digestToBytes(rowDigestRow.d)
    const rowSignature = await this.resolveSign(signatureOrCallback)(rowDigestBytes)

    // 2. AdminSigning ceremony ('vrg') — MutationValid's 10-field formula (Tid,
    //    Id, AuthorityId, PrivateCid, PublicCid, SelectiveCid, Status,
    //    Expiration, SignorKey, Signature) — deferred-check-coerced Expiration
    //    (see toDeferredCheckDatetime's doc comment / T-42-03).
    const expirationForDeferredCheck = toDeferredCheckDatetime(expiration)
    const digestExpr = 'select Digest(:tid, :id, :authorityId, :privateCid, :publicCid, :selectiveCid, :status, :expirationDeferred, :rowSignorKey, :rowSignature) as d'
    const digestParams = {
      tid,
      id: registrantId,
      authorityId,
      privateCid,
      publicCid,
      selectiveCid,
      status,
      expirationDeferred: expirationForDeferredCheck,
      rowSignorKey: rowSignature.signerKey,
      rowSignature: rowSignature.signature
    }
    const nonce = await seedSignedMutation(ctx, authorityId, 'vrg', tid, digestExpr, digestParams, this.resolveSign(signatureOrCallback))

    await ctx.db.exec(
      `update Registrant
       with context SigningNonce = :signingNonce, Tid = ${tid}, now = :now
       set Status = :status, Expiration = :expiration, SignorKey = :signorKey, Signature = :signature
       where Id = :id`,
      {
        id: registrantId,
        status,
        expiration,
        signorKey: rowSignature.signerKey,
        signature: rowSignature.signature,
        signingNonce: nonce,
        now: nowCanonicalDatetime()
      }
    )
  }

  // ---------- Registration Request protocol + approval inbox (Phase 48) ----------
  // Throwing stub bodies only — 48-05 declares the contract; 48-07 (intake +
  // bridge registry), 48-08 (read surface + stats), and 48-12 (rejection)
  // replace these with real implementations against the schema. A stub MUST
  // throw and MUST NOT return a plausible empty value.

  /**
   * D-02/D-03/D-04: the phase's ceremony-free intake. A prospective
   * registrant carries no `User` row and no officer scope to seed a signing
   * session against — so this INSERT runs NO `seedSignedMutation`, holds NO
   * `SigningNonce`-bearing `AdminSigning` ceremony, and consults no
   * `IsUserValid`/`userKey`. The row's own requester-key self-signature over
   * DG-1 (`SignatureValid`) is the ENTIRE authorization gate. Pattern-
   * matching this method against the five sibling `vrg` ceremonies in this
   * file (e.g. `createRegistrant` above) would reintroduce the `ProposedX`
   * context envelope `48-CONTEXT.md`'s D-02 rejects — the exact regression
   * this phase's design correction exists to prevent.
   *
   * L-3 timestamp contract: `SubmittedAt` is `init.submittedAt`, bound
   * VERBATIM — the submitter's own staging-time value, never engine-
   * generated — because the offline courier (48-09) signs at staging time
   * and hands this method an ALREADY-RESOLVED `Signature`, not a callback;
   * `resolveSign` returns that signature verbatim, so the engine gets no
   * chance to re-sign anything a regenerated timestamp would invalidate.
   * `ReceivedAt` is this engine's own `toIsoZDatetime` observation, written
   * outside every digest, and is bounded against `SubmittedAt` by the named
   * skew constants above rather than trusted.
   */
  async submitRegistrationRequest (
    init: RegistrationRequestInit,
    requesterKey: string,
    signatureOrCallback: SignatureOrCallback
  ): Promise<string> {
    this.requireCtx('submitRegistrationRequest')
    const ctx = this.ctx!
    try {
      // A NEW allocator namespace, distinct from 'registration' above — shared
      // with registerBridgeKey below so a Tid is never reused across the
      // intake path and the registry path.
      const tid = await allocateTid(ctx.db, 'registration-request')

      // D-03 issuer normalization. bridgeId binds null (never undefined — a
      // bound undefined and a bound null are not interchangeable in the
      // digest).
      const issuerType = init.issuerType ?? 'registrant'
      const bridgeId = init.bridgeId ?? null

      // Pre-flight guard: produces an ATTRIBUTABLE error only. BridgeIdValid
      // remains the actual enforcement boundary — this guard must never be
      // described as the boundary itself.
      if (issuerType === 'registrant' && bridgeId !== null) {
        throw new Error('submitRegistrationRequest: issuerType is registrant but bridgeId is set — a registrant-issued row cannot carry a BridgeId')
      }
      if (issuerType === 'bridge' && bridgeId === null) {
        throw new Error('submitRegistrationRequest: issuerType is bridge but bridgeId is null — a bridge-issued row must carry a BridgeId')
      }

      // The identical serialized string flows into Digest(:payload) AND the
      // Payload column, so PayloadCidValid's own Digest(Payload)
      // recomputation matches (any re-serialization between the two would
      // produce a different cid).
      const payload = JSON.stringify(init.payload)
      const payloadCidRow = await ctx.db.prepare('select Digest(:payload) as d').get({ payload })
      if (!payloadCidRow || payloadCidRow.d == null) {
        throw new Error('submitRegistrationRequest: Digest() returned null for Payload — crypto plugin not registered?')
      }
      const payloadCid = payloadCidRow.d as string

      // L-3: SubmittedAt is the SUBMITTER's own value, bound VERBATIM.
      // NEVER toIsoZDatetime(new Date()) / nowCanonicalDatetime() here — see
      // the doc comment above.
      const submittedAt = init.submittedAt
      if (Number.isNaN(Date.parse(submittedAt))) {
        // Attributable-error guard only; SubmittedAtValid/SubmittedAtSaneValid remain the enforcement.
        throw new Error(`submitRegistrationRequest: init.submittedAt does not parse as a date: ${submittedAt}`)
      }

      // ReceivedAt: the AUTHORITY's OWN observation of intake time, inside NO digest.
      const receivedAt = toIsoZDatetime(Date.now())

      // Skew guard: BOUNDS the submitter-supplied SubmittedAt, does not
      // authenticate it — inside the window it remains a submitter-chosen
      // value covered only by the submitter's own signature (T-48-07-12).
      const submittedAtMs = Date.parse(submittedAt)
      const receivedAtMs = Date.parse(receivedAt)
      if (submittedAtMs - receivedAtMs > SUBMITTED_AT_MAX_FUTURE_SKEW_MS) {
        throw new Error(
          `submitRegistrationRequest: submittedAt (${submittedAt}) is more than ${SUBMITTED_AT_MAX_FUTURE_SKEW_MS}ms ahead of receivedAt (${receivedAt})`
        )
      }
      if (receivedAtMs - submittedAtMs > SUBMITTED_AT_MAX_AGE_MS) {
        throw new Error(
          `submitRegistrationRequest: submittedAt (${submittedAt}) is more than ${SUBMITTED_AT_MAX_AGE_MS}ms before receivedAt (${receivedAt})`
        )
      }

      // D-02's ONLY authorization gate: DG-1, field for field —
      // Digest(Id, AuthorityId, RequesterKey, IssuerType, BridgeId, PayloadCid, SubmittedAt).
      // NO context.Tid, NO ReceivedAt (the requester never observed ReceivedAt at signing time).
      const digestRow = await ctx.db
        .prepare('select Digest(:id, :rowAuthorityId, :requesterKey, :issuerType, :bridgeId, :payloadCid, :submittedAt) as d')
        .get({
          id: init.id,
          rowAuthorityId: init.authorityId,
          requesterKey,
          issuerType,
          bridgeId,
          payloadCid,
          submittedAt
        })
      if (!digestRow || digestRow.d == null) {
        throw new Error('submitRegistrationRequest: Digest() returned null — crypto plugin not registered?')
      }
      const digestBytes = digestToBytes(digestRow.d)
      const signature = await this.resolveSign(signatureOrCallback)(digestBytes)
      // D-02/D-04: `signature.signerUserId` is NEVER read here — a
      // prospective registrant has no user id, the field is a type artifact
      // on this path, and touching it is how a User dependency would creep
      // back in.

      // No signing session exists at INSERT — signingNonce binds null.
      await ctx.db.exec(
        `insert into RegistrationRequest (
          Id, AuthorityId, RequesterKey, IssuerType, BridgeId, Payload, PayloadCid, Status, SubmittedAt, ReceivedAt, RequesterSignature
        )
        with context SigningNonce = :signingNonce, Tid = ${tid}
        values (:id, :rowAuthorityId, :requesterKey, :issuerType, :bridgeId, :payload, :payloadCid, :status, :submittedAt, :receivedAt, :requesterSignature)`,
        {
          id: init.id,
          rowAuthorityId: init.authorityId,
          // The requesterKey PARAMETER — not signature.signerKey — because DG-1
          // digested the parameter and the CHECK verifies against the column.
          requesterKey,
          issuerType,
          bridgeId,
          payload,
          payloadCid,
          status: 'p',
          submittedAt,
          receivedAt,
          requesterSignature: signature.signature,
          signingNonce: null
        }
      )

      return init.id
    } catch (err) {
      this.rethrow(err, 'submitRegistrationRequest')
    }
  }

  /**
   * D-03 registry write. Unlike `submitRegistrationRequest` above, this IS
   * an authority act and DOES run the full ceremony: registering a bridge
   * key is a decision the authority makes about whom to trust, whereas
   * submitting a request is an act an untrusted party performs. Follows
   * `Registrant.MutationValid`'s `AdminSignature`-join shape through
   * `seedSignedMutation` at scope `'vrg'` (48-02 L-1 — NOT the `'cap'`
   * RESEARCH speculated).
   *
   * No revoke ceremony ships this phase (48-02): `RevokedAt` exists so
   * `listBridgeKeys`/`BridgeIdValid` can stay honest about revocation, but
   * nothing writes it here — do not add one.
   */
  async registerBridgeKey (init: RegistrationBridgeKeyInit, signatureOrCallback: SignatureOrCallback): Promise<void> {
    this.requireCtx('registerBridgeKey')
    const ctx = this.ctx!
    try {
      // The SAME durable allocator namespace submitRegistrationRequest uses
      // above — a Tid is never reused across the intake path and the
      // registry path.
      const tid = await allocateTid(ctx.db, 'registration-request')

      // DG-3, field for field: Digest(context.Tid, new.Id, new.AuthorityId,
      // new.Label, new.BridgeKey, new.RevokedAt). `rowAuthorityId`/`bridgeKey`
      // are DEFENSIVE RENAMES — `authorityId` and a `signerKey`-adjacent name
      // are among seedSignedMutation's eight reserved bind names and would be
      // silently overwritten by the helper's own ceremony binds (the real
      // Phase 42-03 bug documented at createRegistrant's NOTE 1 above).
      const digestExpr = 'select Digest(:tid, :id, :rowAuthorityId, :label, :bridgeKey, :revokedAt) as d'
      const digestParams = {
        tid,
        id: init.id,
        rowAuthorityId: init.authorityId,
        label: init.label,
        bridgeKey: init.key,
        revokedAt: null
      }
      const nonce = await seedSignedMutation(
        ctx,
        init.authorityId,
        'vrg',
        tid,
        digestExpr,
        digestParams,
        this.resolveSign(signatureOrCallback)
      )

      await ctx.db.exec(
        `insert into RegistrationBridgeKey (Id, AuthorityId, Label, BridgeKey, RevokedAt)
        with context SigningNonce = :signingNonce, Tid = ${tid}
        values (:id, :rowAuthorityId, :label, :bridgeKey, :revokedAt)`,
        {
          id: init.id,
          rowAuthorityId: init.authorityId,
          label: init.label,
          bridgeKey: init.key,
          revokedAt: null,
          signingNonce: nonce
        }
      )
    } catch (err) {
      this.rethrow(err, 'registerBridgeKey')
    }
  }

  /**
   * D-03 registry read. The `RevokedAt is null` filter mirrors
   * `BridgeIdValid`'s own predicate exactly, so the set a reviewing officer
   * reads here can never disagree with the set the CHECK accepts. Returns
   * `[]` for an authority with no registered keys — never throws on empty.
   */
  async listBridgeKeys (authorityId: string): Promise<RegistrationBridgeKey[]> {
    if (!this.ctx) return []
    const ctx = this.ctx
    const out: RegistrationBridgeKey[] = []
    for await (const row of ctx.db.eval(
      'select Id, AuthorityId, Label, BridgeKey from RegistrationBridgeKey where AuthorityId = :authorityId and RevokedAt is null order by Label',
      { authorityId }
    )) {
      out.push({
        id: asText(row.Id, 'RegistrationBridgeKey.Id'),
        authorityId: asText(row.AuthorityId, 'RegistrationBridgeKey.AuthorityId'),
        label: asText(row.Label, 'RegistrationBridgeKey.Label'),
        key: asText(row.BridgeKey, 'RegistrationBridgeKey.BridgeKey')
      })
    }
    return out
  }

  async listRegistrationRequests (_filter?: RegistrationRequestListFilter, _page?: RegistrationRequestListPage): Promise<RegistrationRequestListResult> {
    // CONTRACT STUB — replaced by 48-08 (read surface + stats)
    throw new Error('listRegistrationRequests is not implemented')
  }

  async getRegistrationRequest (_requestId: string): Promise<RegistrationRequestRead | undefined> {
    // CONTRACT STUB — replaced by 48-08 (read surface + stats)
    throw new Error('getRegistrationRequest is not implemented')
  }

  async getPriorRejections (_requesterKey: string): Promise<PriorRejection[]> {
    // CONTRACT STUB — replaced by 48-08 (read surface + stats)
    throw new Error('getPriorRejections is not implemented')
  }

  async getRegistrationTransparencyStats (_authorityId: string): Promise<RegistrationTransparencyStats> {
    // CONTRACT STUB — replaced by 48-08 (read surface + stats)
    throw new Error('getRegistrationTransparencyStats is not implemented')
  }

  async rejectRegistrationRequest (_requestId: string, _decision: RegistrationRequestDecision, _signatureOrCallback: SignatureOrCallback): Promise<void> {
    // CONTRACT STUB — replaced by 48-12 (rejection)
    throw new Error('rejectRegistrationRequest is not implemented')
  }

  // ---------- helpers ----------

  private requireCtx (method: string): void {
    requireCtxHelper(this.ctx, 'RegistrationEngine', method)
  }

  private rethrow (err: unknown, method: string): never {
    return rethrowHelper(err, 'RegistrationEngine', method)
  }
}
