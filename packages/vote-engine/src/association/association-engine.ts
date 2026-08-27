import { bytesToHex } from '@noble/curves/utils.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { utf8ToBytes } from '@noble/hashes/utils.js'
import { asText, digestToBytes, nowCanonicalDatetime, SEQUENCE_ALLOCATION_ATTEMPTS } from '../utils.js'
import { seedSignedMutation } from '../signing/signed-mutation.js'
import { allocateTid } from '../database/tid-allocator.js'
import { toIsoZDatetime, toDeferredCheckDatetime, resolveSign as resolveSignHelper, requireCtx as requireCtxHelper, rethrow as rethrowHelper } from '../signing/ceremony-helpers.js'
import { StubAttestationVerifier } from './stub-attestation-verifier.js'
import { AssociationAssociateBuilder } from './builders/association-associate-builder.js'
import type { EngineContext } from '../types.js'
import type {
  AssociateInit,
  Association,
  AssociationAttestationAnswer,
  AssociationRequestInit,
  AssociationRequestRead,
  AssociationRequestStatus,
  AttestationChallenge,
  AttestationVerdict,
  AttestationVerdictCode,
  AttestationVerification,
  IAssociationAssociateBuilder,
  IAssociationEngine,
  IAttestationVerifier,
  Signature
} from '@votetorrent/vote-core'

/**
 * D-01/D-19: every mutating method's signing parameter is a real `Signature`
 * OR a callback that receives the canonical digest bytes and returns one —
 * NEVER a raw private key. The engine never holds the key (D-01). Matches
 * `IAssociationEngine`'s (unexported) `SignatureOrCallback` shape structurally.
 */
type SignatureOrCallback = Signature | ((digest: Uint8Array) => Promise<Signature>)

// 999.1 D-01/D-02: AssociationEngine mutations allocate Tids through the
// shared durable, peer-safe allocator (`../database/tid-allocator.js`,
// namespace 'association') instead of a process-local `Date.now()` counter
// — closes the restart/multi-peer Tid-collision replay window this module
// previously carried (superseded the retired `nextAssociationTid`/
// `peekNextAssociationTid()` pair; see `tid-allocator.ts`'s `peekTid` for
// the equivalent introspection hook).

// WR-01/WR-04 (42-REVIEW): datetime + ceremony helpers consolidated into
// ../signing/ceremony-helpers.js (shared by all three Phase-42 engines).

/** sha256(deviceId) hex-encoded — matches `PollingDevice.DeviceHash`/`Association.DeviceHash`'s documented "sha256 hash of the device ID" convention. */
function sha256Hex (input: string): string {
  return bytesToHex(sha256(utf8ToBytes(input)))
}

/**
 * AssociationEngine — Phase 42-04 (D-03..D-07, D-01/D-02) implementation.
 *
 * Unwired `(ctx?: EngineContext)` constructor per the `ElectionsEngine`/
 * `RegistrationEngine` precedent, PLUS an injectable `verifier` (D-07): the
 * device-attestation platform-verification seam defaults to
 * `StubAttestationVerifier` (nonce-freshness only, seam-only this phase) so
 * the engine is Node-testable without a real iOS/Android device. A real
 * verifier can be swapped in later without any change to this class's shape.
 *
 * Attestation flow (D-03..D-05): `issueAttestationChallenge` seeds a one-time
 * nonce bound to (RegistrantId, DeviceKey); `associate` verifies the device's
 * answering attestation through the seam BEFORE opening any transaction,
 * then writes the authority-held `AssociationPrivate` row and the public
 * `Association` row (committing to it via `AttestationCid`) inside one
 * BEGIN/COMMIT/ROLLBACK envelope (Pitfall 4 — Cids-before-parent order,
 * Association-before-AssociationPrivate here because `AssociationCidMatch`
 * needs the public row to already exist).
 *
 * Device uniqueness (D-06) is authority-side (needs the private DeviceId)
 * and engine-enforced — no cross-row schema CHECK. Waived only for a
 * `PollingDevice` whitelist entry (shared-tablet scenario), keyed by
 * `sha256(DeviceId)` — the same hash convention `Association.DeviceHash`/
 * `PollingDevice.DeviceHash` document.
 */
export class AssociationEngine implements IAssociationEngine {
  constructor (
    private readonly ctx?: EngineContext,
    private readonly verifier: IAttestationVerifier = new StubAttestationVerifier()
  ) {}

  /** Normalizes the Signature|callback union into a single callback shape (WR-04: shared). */
  private resolveSign (signatureOrCallback: SignatureOrCallback): (digest: Uint8Array) => Promise<Signature> {
    return resolveSignHelper(signatureOrCallback)
  }

  // ---------- Cid compute helper (pure, no insert — Pitfall 4) ----------

  /** AssociationPrivate.CidValid: Cid = cid(Digest(RegistrantId, DeviceKey, DeviceId, AttestationTime, Nonce, AttestationDetails, Expiration)). */
  private async computeAssociationPrivateCid (input: {
    registrantId: string
    deviceKey: string
    deviceId: string
    attestationTime: string
    nonce: string
    attestationDetails: string
    expiration: string
  }): Promise<string> {
    const ctx = this.ctx!
    const row = await ctx.db
      .prepare('select cid(Digest(:registrantId, :deviceKey, :deviceId, :attestationTime, :nonce, :attestationDetails, :expiration)) as c')
      .get(input)
    if (!row || row.c == null) {
      throw new Error('computeAssociationPrivateCid: cid(Digest(...)) returned null — crypto plugin not registered?')
    }
    return row.c as string
  }

  // ---------- D-03: attestation-challenge issuance / removal ----------

  /**
   * D-03: issue a one-time `AttestationChallenge` nonce bound to
   * (RegistrantId, DeviceKey). `AuthorityId` is resolved from the
   * `Registrant` row (the interface takes no explicit authorityId param);
   * the schema's own `RegistrantIdValid` CHECK rejects a non-`Status='a'`
   * registrant at insert time.
   */
  async issueAttestationChallenge (
    registrantId: string,
    deviceKey: string,
    expiration: string,
    signatureOrCallback: SignatureOrCallback,
    electionId?: string
  ): Promise<AttestationChallenge> {
    this.requireCtx('issueAttestationChallenge')
    const ctx = this.ctx!
    const tid = await allocateTid(ctx.db, 'association')
    try {
      const registrantRow = await ctx.db
        .prepare('select AuthorityId from Registrant where Id = :registrantId')
        .get({ registrantId })
      if (!registrantRow) {
        throw new Error(`issueAttestationChallenge: Registrant not found for registrantId=${registrantId}`)
      }
      const authorityId = asText(registrantRow.AuthorityId, 'Registrant.AuthorityId')

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const nonce: string = (globalThis as any).crypto.randomUUID()
      const expirationZ = toIsoZDatetime(expiration)
      const expirationDeferred = toDeferredCheckDatetime(expirationZ)
      const electionIdValue = electionId ?? null

      // NOTE: bind names `challengeNonce`/`challengeAuthorityId` (NOT `nonce`/`authorityId`) —
      // seedSignedMutation reserves `nonce`/`authorityId`/etc for ITS OWN ceremony bind params
      // and would silently overwrite a same-named digestParams entry (T-42-03 bug class found
      // via TDD on 42-03's RegistrationEngine: a `signature` key collided there; here the
      // colliding keys would have been the challenge's own Nonce/AuthorityId). `electionId`
      // does NOT collide with seedSignedMutation's reserved set (nonce/authorityId/signature).
      //
      // D-14a: `:electionId` sits in the IDENTICAL slot (between deviceKey and expiration) as
      // the schema's welded `AttestationChallenge.InsertValid` `Digest(...)` — both sides MUST
      // move together (45-04 atomicity requirement); a slot mismatch fails every insert.
      const digestExpr = 'select Digest(:tid, :challengeNonce, :challengeAuthorityId, :registrantId, :deviceKey, :electionId, :expirationDeferred) as d'
      const digestParams = { tid, challengeNonce: nonce, challengeAuthorityId: authorityId, registrantId, deviceKey, electionId: electionIdValue, expirationDeferred }
      const signingNonce = await seedSignedMutation(ctx, authorityId, 'vrg', tid, digestExpr, digestParams, this.resolveSign(signatureOrCallback))

      await ctx.db.exec(
        `insert into AttestationChallenge (Nonce, AuthorityId, RegistrantId, DeviceKey, ElectionId, Expiration)
         with context SigningNonce = :signingNonce, Tid = ${tid}, now = :now
         values (:nonce, :authorityId, :registrantId, :deviceKey, :electionId, :expiration)`,
        {
          nonce,
          authorityId,
          registrantId,
          deviceKey,
          electionId: electionIdValue,
          expiration: expirationZ,
          signingNonce,
          now: nowCanonicalDatetime()
        }
      )

      return { nonce, authorityId, registrantId, deviceKey, electionId: electionIdValue ?? undefined, expiration: expirationZ }
    } catch (err) {
      this.rethrow(err, 'issueAttestationChallenge')
    }
  }

  /** D-03: authority deletes a consumed/expired challenge ('vrg'-signed delete). */
  async removeAttestationChallenge (nonce: string, signatureOrCallback: SignatureOrCallback): Promise<void> {
    this.requireCtx('removeAttestationChallenge')
    const ctx = this.ctx!
    const tid = await allocateTid(ctx.db, 'association')
    try {
      const row = await ctx.db
        .prepare('select AuthorityId from AttestationChallenge where Nonce = :nonce')
        .get({ nonce })
      if (!row) {
        throw new Error(`removeAttestationChallenge: AttestationChallenge not found for nonce=${nonce}`)
      }
      const authorityId = asText(row.AuthorityId, 'AttestationChallenge.AuthorityId')

      // NOTE: `challengeNonce` (not `nonce`) — avoids the seedSignedMutation reserved-bind collision (see issueAttestationChallenge).
      const digestExpr = "select Digest(:tid, :challengeNonce, 'delete') as d"
      const digestParams = { tid, challengeNonce: nonce }
      const signingNonce = await seedSignedMutation(ctx, authorityId, 'vrg', tid, digestExpr, digestParams, this.resolveSign(signatureOrCallback))

      await ctx.db.exec(
        `delete from AttestationChallenge
         with context SigningNonce = :signingNonce, Tid = ${tid}, now = :now
         where Nonce = :nonce`,
        { nonce, signingNonce, now: nowCanonicalDatetime() }
      )
    } catch (err) {
      this.rethrow(err, 'removeAttestationChallenge')
    }
  }

  // ---------- D-03..D-06: the associate ceremony ----------

  buildAssociate (): IAssociationAssociateBuilder {
    return new AssociationAssociateBuilder(this)
  }

  /**
   * D-03/D-04/D-05/D-06/D-07: the multi-row associate ceremony.
   *
   * 1. Load the `AttestationChallenge` bound to (nonce, registrantId, deviceKey) —
   *    a mismatch on ANY of the three (wrong nonce, wrong registrant, wrong
   *    device) fails the lookup, which is the structural nonce-replay
   *    mitigation (T-42-02): the nonce cannot be redirected to a different
   *    registrant+device pair.
   * 2. Call `IAttestationVerifier.verify(challenge, attestation)` BEFORE
   *    opening any transaction (D-07) — reject on `!ok`, no row written.
   * 3. D-06 device-uniqueness: reject if `AssociationPrivate` already has a
   *    row for this `DeviceId` under a DIFFERENT `RegistrantId`, UNLESS a
   *    `PollingDevice` row whitelists `sha256(DeviceId)` for this authority
   *    (the shared-tablet waiver). Engine-side only — no cross-row CHECK.
   * 4. BEGIN. Compute `AssociationPrivate.Cid` (pure select). Insert the
   *    public `Association` FIRST (its own row-level `SignatureValid`
   *    signature PLUS a 'vrg' AdminSigning ceremony, mirroring
   *    `RegistrationEngine.createRegistrant`'s two-digest pattern) — THEN
   *    `AssociationPrivate` (`AssociationCidMatch` needs the public row to
   *    already exist). COMMIT, ROLLBACK on any failure.
   *
   * `Association`/`AssociationPrivate.Expiration` reuse the matched
   * `AttestationChallenge.Expiration` — `AssociateInit` carries no
   * independent expiration field, and the challenge's expiration is the
   * only expiration value in scope at associate time.
   */
  async associate (init: AssociateInit, signatureOrCallback: SignatureOrCallback): Promise<void> {
    this.requireCtx('associate')
    const ctx = this.ctx!
    const { registrantId, deviceKey, deviceHash, nonce, attestation } = init

    const challengeRow = await ctx.db
      .prepare(
        'select Nonce, AuthorityId, RegistrantId, DeviceKey, ElectionId, Expiration from AttestationChallenge where Nonce = :nonce and RegistrantId = :registrantId and DeviceKey = :deviceKey'
      )
      .get({ nonce, registrantId, deviceKey })
    if (!challengeRow) {
      throw new Error(
        `AssociationEngine.associate: no AttestationChallenge found for nonce=${nonce} registrantId=${registrantId} deviceKey=${deviceKey} — either it was never issued, has already been consumed, or does not bind this exact (registrant, device) pair`
      )
    }
    const challenge: AttestationChallenge = {
      nonce: asText(challengeRow.Nonce, 'AttestationChallenge.Nonce'),
      authorityId: asText(challengeRow.AuthorityId, 'AttestationChallenge.AuthorityId'),
      registrantId: asText(challengeRow.RegistrantId, 'AttestationChallenge.RegistrantId'),
      deviceKey: asText(challengeRow.DeviceKey, 'AttestationChallenge.DeviceKey'),
      // D-14a: null (unset) ElectionId reads back as undefined — associate()'s policy gate
      // (below) treats a missing electionId as fail-closed attestation-required (Assumption A5).
      electionId: challengeRow.ElectionId == null ? undefined : asText(challengeRow.ElectionId, 'AttestationChallenge.ElectionId'),
      // Read back from a plain SELECT — Quereus's stored canonical form lacks the
      // trailing `Z` (see `toIsoZDatetime`'s doc comment); re-Z-suffix it here so the
      // verifier (and every downstream expiration/digest computation) sees the
      // correct absolute instant, not a `new Date(...)`-local-time misinterpretation.
      expiration: toIsoZDatetime(challengeRow.Expiration as string)
    }

    // D-14c/A5/CR-03 (LOCKED, fail-closed): read the election's attestation policy and skip
    // verifier.verify() ONLY when a policy row exists AND AttestationRequired is exactly 0.
    // No row (unconfigured election), a null challenge.electionId, or any non-zero/unexpected
    // value ⇒ attestation is REQUIRED. A failure in this SELECT itself propagates (rejects
    // associate()) rather than silently skipping — fail-closed by rejection, never by omission.
    const policyRow = await ctx.db
      .prepare('select AttestationRequired from ElectionAttestationPolicy where ElectionId = :electionId')
      .get({ electionId: challenge.electionId ?? null })
    const attestationRequired = policyRow == null || Number(policyRow.AttestationRequired) !== 0

    // D-07 seam — verify BEFORE opening any transaction; no row written on rejection.
    if (attestationRequired) {
      const verification: AttestationVerification = await this.verifier.verify(challenge, attestation)

      // D-03/T-47-11/T-47-12 (LOCKED ORDER — do not reorder): the verdict is
      // recorded HERE, unconditionally on both the pass and the fail path,
      // BEFORE the fail-closed gate below AND before `await ctx.db.exec('BEGIN')`
      // further down — recording failures is the entire point of D-03, and an
      // insert placed after the throw or inside the transaction would record
      // nothing on the fail path (the transaction is never opened there, and a
      // ROLLBACK would erase it anyway). The record's own outcome is CAPTURED,
      // never let to influence the gate directly: a storage failure must never
      // be able to mask or re-shape the "attestation verification failed"
      // rejection (a caller distinguishing "attestation rejected" from
      // "storage error" would mis-classify a rejected device), and on the pass
      // path a record failure must never be silently swallowed.
      let recordError: unknown
      try {
        await this.recordAttestationVerdict(registrantId, deviceKey, verification)
      } catch (err) {
        recordError = err
      }

      if (!verification.ok) {
        const message = `AssociationEngine.associate: attestation verification failed${verification.reason ? `: ${verification.reason}` : ''}`
        throw recordError !== undefined ? new Error(message, { cause: recordError }) : new Error(message)
      }

      if (recordError !== undefined) throw recordError
    }

    // D-06 device-uniqueness (authority-side — needs the private DeviceId).
    const deviceIdHash = sha256Hex(attestation.deviceId)
    const conflictingRow = await ctx.db
      .prepare('select RegistrantId from AssociationPrivate where DeviceId = :deviceId and RegistrantId <> :registrantId limit 1')
      .get({ deviceId: attestation.deviceId, registrantId })
    if (conflictingRow) {
      const waiverRow = await ctx.db
        .prepare('select AuthorityId from PollingDevice where AuthorityId = :authorityId and DeviceHash = :deviceHash')
        .get({ authorityId: challenge.authorityId, deviceHash: deviceIdHash })
      if (!waiverRow) {
        throw new Error(
          `AssociationEngine.associate: device already associated with a different registrant (no PollingDevice waiver present for this device — D-06)`
        )
      }
    }

    const expiration = toIsoZDatetime(challenge.expiration)
    const expirationDeferred = toDeferredCheckDatetime(expiration)
    const attestationTime = toIsoZDatetime(attestation.attestationTime)
    const attestationTimeDeferred = toDeferredCheckDatetime(attestationTime)
    const attestationDetailsJson = JSON.stringify({
      location: attestation.location,
      attestationStatement: attestation.attestationStatement,
      certificateChain: attestation.certificateChain,
      platformDetails: attestation.platformDetails
    })

    try {
      await ctx.db.exec('BEGIN')
      try {
        const cid = await this.computeAssociationPrivateCid({
          registrantId,
          deviceKey,
          deviceId: attestation.deviceId,
          attestationTime,
          nonce,
          attestationDetails: attestationDetailsJson,
          expiration
        })

        // ---- Association (public row) FIRST — AssociationCidMatch (below) needs it. ----
        const associationTid = await allocateTid(ctx.db, 'association')
        const rowDigestRow = await ctx.db
          .prepare('select Digest(:registrantId, :deviceKey, :deviceHash, :attestationCid, :expiration) as d')
          .get({ registrantId, deviceKey, deviceHash: deviceHash ?? null, attestationCid: cid, expiration })
        if (!rowDigestRow || rowDigestRow.d == null) {
          throw new Error('AssociationEngine.associate: Digest() returned null for Association row-level signature — crypto plugin not registered?')
        }
        const rowSignature = await this.resolveSign(signatureOrCallback)(digestToBytes(rowDigestRow.d))

        const associationDigestExpr = 'select Digest(:tid, :registrantId, :deviceKey, :deviceHash, :attestationCid, :expirationDeferred, :rowSignorKey, :rowSignature) as d'
        const associationDigestParams = {
          tid: associationTid,
          registrantId,
          deviceKey,
          deviceHash: deviceHash ?? null,
          attestationCid: cid,
          expirationDeferred,
          rowSignorKey: rowSignature.signerKey,
          rowSignature: rowSignature.signature
        }
        const associationNonce = await seedSignedMutation(
          ctx,
          challenge.authorityId,
          'vrg',
          associationTid,
          associationDigestExpr,
          associationDigestParams,
          this.resolveSign(signatureOrCallback),
          { ownsTransaction: false }
        )

        await ctx.db.exec(
          `insert into Association (RegistrantId, DeviceKey, DeviceHash, AttestationCid, Expiration, SignorKey, Signature)
           with context SigningNonce = :signingNonce, Tid = ${associationTid}, now = :now
           values (:registrantId, :deviceKey, :deviceHash, :attestationCid, :expiration, :signorKey, :signature)`,
          {
            registrantId,
            deviceKey,
            deviceHash: deviceHash ?? null,
            attestationCid: cid,
            expiration,
            signorKey: rowSignature.signerKey,
            signature: rowSignature.signature,
            signingNonce: associationNonce,
            now: nowCanonicalDatetime()
          }
        )

        // ---- AssociationPrivate (authority-held) SECOND — re-derives the SAME Cid. ----
        // NOTE: `challengeNonce` (not `nonce`) — avoids the seedSignedMutation reserved-bind
        // collision (see issueAttestationChallenge's doc comment); this is the AttestationChallenge
        // nonce this attestation answered, stored in AssociationPrivate.Nonce.
        const privateTid = await allocateTid(ctx.db, 'association')
        const privateDigestExpr = 'select Digest(:tid, :cid, :registrantId, :deviceKey, :deviceId, :attestationTimeDeferred, :challengeNonce, :attestationDetails, :expirationDeferred) as d'
        const privateDigestParams = {
          tid: privateTid,
          cid,
          registrantId,
          deviceKey,
          deviceId: attestation.deviceId,
          attestationTimeDeferred,
          challengeNonce: nonce,
          attestationDetails: attestationDetailsJson,
          expirationDeferred
        }
        const privateNonce = await seedSignedMutation(
          ctx,
          challenge.authorityId,
          'vrg',
          privateTid,
          privateDigestExpr,
          privateDigestParams,
          this.resolveSign(signatureOrCallback),
          { ownsTransaction: false }
        )

        await ctx.db.exec(
          `insert into AssociationPrivate (Cid, RegistrantId, DeviceKey, DeviceId, AttestationTime, Nonce, AttestationDetails, Expiration)
           with context SigningNonce = :signingNonce, Tid = ${privateTid}, now = :now
           values (:cid, :registrantId, :deviceKey, :deviceId, :attestationTime, :nonce, :attestationDetails, :expiration)`,
          {
            cid,
            registrantId,
            deviceKey,
            deviceId: attestation.deviceId,
            attestationTime,
            nonce,
            attestationDetails: attestationDetailsJson,
            expiration,
            signingNonce: privateNonce,
            now: nowCanonicalDatetime()
          }
        )

        await ctx.db.exec('COMMIT')
      } catch (innerErr) {
        await ctx.db.exec('ROLLBACK')
        throw innerErr
      }
    } catch (err) {
      this.rethrow(err, 'associate')
    }
  }

  // ---------- reads / removal ----------

  /** D-04 information-disclosure boundary: exposes at most `DeviceHash` — never `AssociationPrivate.DeviceId`. */
  async getAssociation (registrantId: string, deviceKey: string): Promise<Association | undefined> {
    if (!this.ctx) return undefined
    try {
      const row = await this.ctx.db
        .prepare('select RegistrantId, DeviceKey, DeviceHash, AttestationCid, Expiration, SignorKey, Signature from Association where RegistrantId = :registrantId and DeviceKey = :deviceKey')
        .get({ registrantId, deviceKey })
      if (!row) return undefined
      return {
        registrantId: asText(row.RegistrantId, 'Association.RegistrantId'),
        deviceKey: asText(row.DeviceKey, 'Association.DeviceKey'),
        deviceHash: row.DeviceHash == null ? undefined : asText(row.DeviceHash, 'Association.DeviceHash'),
        attestationCid: row.AttestationCid == null ? undefined : asText(row.AttestationCid, 'Association.AttestationCid'),
        // CR-02: a datetime-column read-back is Z-stripped (Quereus canonical form); re-stamp
        // it to UTC via toIsoZDatetime (which appends `Z` to the bare form) rather than
        // returning the ambiguous string a caller's `new Date(...)` would misread as local time.
        expiration: toIsoZDatetime(row.Expiration as string),
        signorKey: asText(row.SignorKey, 'Association.SignorKey'),
        signature: asText(row.Signature, 'Association.Signature')
      }
    } catch (err) {
      this.rethrow(err, 'getAssociation')
    }
  }

  /**
   * Array variant of `getAssociation` — every public `Association` row bound
   * to `registrantId`. Same column list as the point read, hence the same
   * D-04 information-disclosure boundary by construction.
   */
  async getAssociations (registrantId: string): Promise<Association[]> {
    if (!this.ctx) return []
    const ctx = this.ctx
    const out: Association[] = []
    try {
      for await (const row of ctx.db.eval(
        'select RegistrantId, DeviceKey, DeviceHash, AttestationCid, Expiration, SignorKey, Signature from Association where RegistrantId = :registrantId',
        { registrantId }
      )) {
        out.push({
          registrantId: asText(row.RegistrantId, 'Association.RegistrantId'),
          deviceKey: asText(row.DeviceKey, 'Association.DeviceKey'),
          deviceHash: row.DeviceHash == null ? undefined : asText(row.DeviceHash, 'Association.DeviceHash'),
          attestationCid: row.AttestationCid == null ? undefined : asText(row.AttestationCid, 'Association.AttestationCid'),
          expiration: toIsoZDatetime(row.Expiration as string),
          signorKey: asText(row.SignorKey, 'Association.SignorKey'),
          signature: asText(row.Signature, 'Association.Signature')
        })
      }
      return out
    } catch (err) {
      this.rethrow(err, 'getAssociations')
    }
  }

  /**
   * D-11 inspect half: every outstanding `AttestationChallenge`, optionally
   * narrowed to one registrant. Pairs with `removeAttestationChallenge` (the
   * expire half) — a removed challenge disappears from this read for free.
   */
  async getAttestationChallenges (registrantId?: string): Promise<AttestationChallenge[]> {
    if (!this.ctx) return []
    const ctx = this.ctx
    const out: AttestationChallenge[] = []
    try {
      const sql = registrantId === undefined
        ? 'select Nonce, AuthorityId, RegistrantId, DeviceKey, ElectionId, Expiration from AttestationChallenge'
        : 'select Nonce, AuthorityId, RegistrantId, DeviceKey, ElectionId, Expiration from AttestationChallenge where RegistrantId = :registrantId'
      const params: Record<string, string> = registrantId === undefined ? {} : { registrantId }
      for await (const row of ctx.db.eval(sql, params)) {
        out.push({
          nonce: asText(row.Nonce, 'AttestationChallenge.Nonce'),
          authorityId: asText(row.AuthorityId, 'AttestationChallenge.AuthorityId'),
          registrantId: asText(row.RegistrantId, 'AttestationChallenge.RegistrantId'),
          deviceKey: asText(row.DeviceKey, 'AttestationChallenge.DeviceKey'),
          electionId: row.ElectionId == null ? undefined : asText(row.ElectionId, 'AttestationChallenge.ElectionId'),
          expiration: toIsoZDatetime(row.Expiration as string)
        })
      }
      return out
    } catch (err) {
      this.rethrow(err, 'getAttestationChallenges')
    }
  }

  /** 'vrg'-signed delete. */
  async removeAssociation (registrantId: string, deviceKey: string, signatureOrCallback: SignatureOrCallback): Promise<void> {
    this.requireCtx('removeAssociation')
    const ctx = this.ctx!
    const tid = await allocateTid(ctx.db, 'association')
    try {
      const existing = await ctx.db
        .prepare('select 1 as found from Association where RegistrantId = :registrantId and DeviceKey = :deviceKey')
        .get({ registrantId, deviceKey })
      if (!existing) {
        throw new Error(`removeAssociation: Association not found for registrantId=${registrantId} deviceKey=${deviceKey}`)
      }
      // Association carries no AuthorityId column of its own — resolve via Registrant.
      const registrantRow = await ctx.db
        .prepare('select AuthorityId from Registrant where Id = :registrantId')
        .get({ registrantId })
      if (!registrantRow) {
        throw new Error(`removeAssociation: Registrant not found for registrantId=${registrantId}`)
      }
      const authorityId = asText(registrantRow.AuthorityId, 'Registrant.AuthorityId')

      const digestExpr = "select Digest(:tid, :registrantId, :deviceKey, 'delete') as d"
      const digestParams = { tid, registrantId, deviceKey }
      const signingNonce = await seedSignedMutation(ctx, authorityId, 'vrg', tid, digestExpr, digestParams, this.resolveSign(signatureOrCallback))

      await ctx.db.exec(
        `delete from Association
         with context SigningNonce = :signingNonce, Tid = ${tid}, now = :now
         where RegistrantId = :registrantId and DeviceKey = :deviceKey`,
        { registrantId, deviceKey, signingNonce, now: nowCanonicalDatetime() }
      )
    } catch (err) {
      this.rethrow(err, 'removeAssociation')
    }
  }

  // ---------- D-03: attestation verdict store ----------

  /**
   * D-03: append-only, UNSIGNED insert — no `seedSignedMutation`,
   * `SigningNonce`, `AdminSigning`, or `Digest(...)` ceremony (D-02),
   * following the `InviteCancellation` precedent, not `UserEvent`.
   * `Sequence` is monotonic per `(RegistrantId, DeviceKey)` so
   * re-verifications accumulate rather than overwrite. Called
   * unconditionally from `associate()` on both the pass and the fail path.
   * Persisting a verdict neither authorizes nor blocks anything — the
   * fail-closed control is `associate()`'s own `if (!verification.ok) throw`.
   */
  async recordAttestationVerdict (registrantId: string, deviceKey: string, verification: AttestationVerification): Promise<void> {
    this.requireCtx('recordAttestationVerdict')
    const ctx = this.ctx!
    try {
      // Text code, never a boolean — a boolean-shaped bind fails VerdictValid.
      const verdict = verification.ok ? 'pass' : 'fail'
      // Z-suffixed, required by VerifiedAtValid's like('%Z', VerifiedAt); the
      // context `now` param stays Z-less (nowCanonicalDatetime()) — the same
      // split every other like('%Z', X)-checked datetime column in this
      // codebase uses (Association.Expiration, AttestationChallenge.Expiration,
      // the private device-association row's own attestation-time column,
      // 47-07's RegistrantAccessEvent.Timestamp). Do NOT bind
      // nowCanonicalDatetime() into this column.
      const verifiedAt = toIsoZDatetime(Date.now())

      // Sequence allocation is a read-then-insert with no enclosing
      // transaction, so two overlapping calls read the same `max(Sequence)`
      // and the loser violates `primary key (RegistrantId, DeviceKey,
      // Sequence)`. Here a lost row is a lost VERDICT — potentially a lost
      // FAIL verdict — so it retries rather than letting the row vanish.
      // Broadly the same discipline as `recordRegistrantAccessEvent`: on
      // failure, probe for our own row (below) before retrying. Deliberately
      // does not sniff the driver's error text for "primary key". UNLIKE the
      // sibling, this method retries UNCONDITIONALLY on any failure where our
      // own row did not land (not only when the high-water mark advanced) —
      // see the retry loop's own comment for why that gate does not transfer
      // here. Bounded by SEQUENCE_ALLOCATION_ATTEMPTS attempts before the
      // original error is rethrown.
      const readNextSequence = async (): Promise<number> => {
        const seqRow = await ctx.db
          .prepare('select coalesce(max(Sequence), -1) + 1 as n from AttestationVerdict where RegistrantId = :registrantId and DeviceKey = :deviceKey')
          .get({ registrantId, deviceKey })
        return Number(seqRow?.n ?? 0)
      }

      // "Did the counter move?" is NOT "did another writer win?" — our own
      // row moves it too. If `db.exec` rejects AFTER the row landed (project
      // memory records intermittent `stale revision: rev 1 vs rev 1`
      // rejections from @optimystic/db-p2p 0.18), a bare high-water test
      // reads our own row as someone else's and appends a SECOND copy at
      // sequence + 1. `AttestationVerdict` is
      // `constraint InsertOnly check on update, delete (false)`, so a
      // duplicated pass/fail judgement can never be removed from the table
      // that exists to keep those judgements honest. The
      // fresh-Tid-per-attempt note above rules out Tid replay, not row
      // duplication. Same fix as `recordRegistrantAccessEvent`.
      //
      // WR-01 FIX (folded 2026-08-25 defect, 51-02): `VerifiedAt` round-trips
      // through Quereus's `datetime` normalization, which BOTH drops the
      // trailing `Z` that `VerifiedAtValid`'s like('%Z', VerifiedAt) requires
      // on the way in, AND strips trailing zeros from the fractional seconds
      // — a bound `...:31.910Z` comes back as `...:31.91`. The prior `stripZ`
      // helper only undid the first transform, so comparing the two as TEXT
      // still failed whenever `Date.now()` landed on a millisecond ending in
      // zero (~1 in 10 calls): the probe answered "not ours", the retry ran,
      // and a SECOND copy of the same verdict was appended to a table
      // declared `constraint InsertOnly check on update, delete (false)`,
      // where it could never be removed. This is the EXACT bug
      // `recordRegistrantAccessEvent` already found and fixed for
      // `RegistrantAccessEvent.Timestamp` (see that method's `sameInstant`
      // comment) — `recordAttestationVerdict` had only received the
      // Z-stripping half of that fix, not the semantic-instant half.
      //
      // Comparing instants sidesteps every formatting question: parse both
      // sides to epoch milliseconds, appending `Z` to the stored value
      // because Quereus stores UTC without a designator and `new Date()`
      // would otherwise read it as LOCAL time.
      const asInstant = (value: string): number => {
        const withZone = value.endsWith('Z') ? value : `${value}Z`
        return new Date(withZone).getTime()
      }
      const sameInstant = (stored: string, bound: string): boolean => {
        const a = asInstant(stored)
        const b = asInstant(bound)
        // An unparseable value must never compare equal — that would report a
        // foreign row as ours and DROP a legitimate verdict write.
        return !Number.isNaN(a) && !Number.isNaN(b) && a === b
      }
      const ownRowLanded = async (seq: number): Promise<boolean> => {
        const row = await ctx.db
          .prepare('select Verdict, Reason, VerifiedAt from AttestationVerdict where RegistrantId = :registrantId and DeviceKey = :deviceKey and Sequence = :sequence')
          .get({ registrantId, deviceKey, sequence: seq })
        if (row === null || row === undefined) return false
        const reason = verification.reason ?? null
        const rowReason = row.Reason === null || row.Reason === undefined ? null : String(row.Reason)
        return String(row.Verdict ?? '') === verdict &&
          rowReason === reason &&
          sameInstant(String(row.VerifiedAt ?? ''), verifiedAt)
      }

      for (let attempt = 0; attempt < SEQUENCE_ALLOCATION_ATTEMPTS; attempt++) {
        const sequence = await readNextSequence()
        // A fresh Tid per attempt — never replayed into a second insert.
        const tid = await allocateTid(ctx.db, 'association')

        try {
          await ctx.db.exec(
            `insert into AttestationVerdict (RegistrantId, DeviceKey, Sequence, Verdict, Reason, VerifiedAt)
             with context Tid = ${tid}, now = :now
             values (:registrantId, :deviceKey, :sequence, :verdict, :reason, :verifiedAt)`,
            {
              registrantId,
              deviceKey,
              sequence,
              verdict,
              reason: verification.reason ?? null,
              verifiedAt,
              now: nowCanonicalDatetime()
            }
          )
          return
        } catch (err) {
          if (attempt + 1 >= SEQUENCE_ALLOCATION_ATTEMPTS) throw err
          // The probe is a fresh round trip issued immediately after a
          // storage failure — exactly when it is most likely to fail too.
          // Its rejection must never REPLACE the insert error the caller
          // needs, so the whole diagnosis collapses to `throw err`.
          try {
            if (await ownRowLanded(sequence)) return
          } catch {
            throw err
          }
          // Our own row did NOT land at `sequence`. Unlike
          // `recordRegistrantAccessEvent`'s stricter "only retry if the
          // high-water mark advanced" gate, `recordAttestationVerdict`
          // retries UNCONDITIONALLY here (still bounded by
          // SEQUENCE_ALLOCATION_ATTEMPTS above): the sibling's gate exists to
          // avoid wasting attempts on a deterministic, non-transient failure,
          // but this table is a permanent audit trail
          // (`constraint InsertOnly`) and a rejected pass/fail judgement that
          // never landed is worth one more attempt with a freshly re-derived
          // sequence rather than surfacing a possibly-transient storage error
          // to `associate()`. The next loop iteration re-reads
          // `readNextSequence()` before retrying, so this never reuses the
          // sequence that just failed.
        }
      }
    } catch (err) {
      this.rethrow(err, 'recordAttestationVerdict')
    }
  }

  /**
   * `deviceKey` is an OPTIONAL narrowing predicate. Results are ordered
   * `DeviceKey` asc then `Sequence` asc — the LAST element of a narrowed
   * read is the most recent verdict (the ordering contract 47-15/47-16
   * render "the latest verdict" from). T-47-05: projects only
   * `AttestationVerdict`'s own six columns — no column from the private,
   * authority-held device-association row, and no join; `DeviceKey` is
   * already public via `Association`.
   */
  async getAttestationVerdicts (registrantId: string, deviceKey?: string): Promise<AttestationVerdict[]> {
    if (!this.ctx) return []
    const ctx = this.ctx
    const out: AttestationVerdict[] = []
    try {
      const sql = deviceKey === undefined
        ? 'select RegistrantId, DeviceKey, Sequence, Verdict, Reason, VerifiedAt from AttestationVerdict where RegistrantId = :registrantId order by DeviceKey asc, Sequence asc'
        : 'select RegistrantId, DeviceKey, Sequence, Verdict, Reason, VerifiedAt from AttestationVerdict where RegistrantId = :registrantId and DeviceKey = :deviceKey order by DeviceKey asc, Sequence asc'
      const params: Record<string, string> = deviceKey === undefined ? { registrantId } : { registrantId, deviceKey }
      for await (const row of ctx.db.eval(sql, params)) {
        out.push({
          registrantId: asText(row.RegistrantId, 'AttestationVerdict.RegistrantId'),
          deviceKey: asText(row.DeviceKey, 'AttestationVerdict.DeviceKey'),
          sequence: Number(row.Sequence),
          verdict: asText(row.Verdict, 'AttestationVerdict.Verdict') as AttestationVerdictCode,
          // undefined, never null — the model declares `reason?: string`.
          reason: row.Reason == null ? undefined : asText(row.Reason, 'AttestationVerdict.Reason'),
          // CR-02: a datetime read-back is Z-stripped; re-stamp it.
          verifiedAt: toIsoZDatetime(row.VerifiedAt as string)
        })
      }
      return out
    } catch (err) {
      this.rethrow(err, 'getAttestationVerdicts')
    }
  }

  // ---------- helpers ----------

  private requireCtx (method: string): void {
    requireCtxHelper(this.ctx, 'AssociationEngine', method)
  }

  private rethrow (err: unknown, method: string): never {
    return rethrowHelper(err, 'AssociationEngine', method)
  }

  // ---------- 51-04: stub bodies for the widened IAssociationEngine ----------
  // Land here so packages/vote-engine compiles at the end of wave 2 (51-04). Real
  // bodies land in 51-08 (both submit legs) and 51-09 (the driver + both reads).

  async submitAssociationRequest (_init: AssociationRequestInit, _requesterKey: string, _signatureOrCallback: SignatureOrCallback): Promise<string> {
    // CONTRACT STUB — replaced by 51-08 (ceremony-free self-signed intake)
    throw new Error('submitAssociationRequest is not implemented')
  }

  async submitAssociationAttestation (_answer: AssociationAttestationAnswer, _requesterKey: string, _signatureOrCallback: SignatureOrCallback): Promise<void> {
    // CONTRACT STUB — replaced by 51-08 (D-18 second leg)
    throw new Error('submitAssociationAttestation is not implemented')
  }

  async processPendingAssociationRequests (_authorityId: string, _signatureOrCallback: SignatureOrCallback): Promise<{ challengesIssued: number; associated: number; rejected: number }> {
    // CONTRACT STUB — replaced by 51-09 (D-05/D-19 automatic driver)
    throw new Error('processPendingAssociationRequests is not implemented')
  }

  async listAssociationRequests (_authorityId: string, _status?: AssociationRequestStatus): Promise<AssociationRequestRead[]> {
    // CONTRACT STUB — replaced by 51-09 (D-06 read-only list)
    throw new Error('listAssociationRequests is not implemented')
  }

  async getAssociationRequest (_requestId: string): Promise<AssociationRequestRead | undefined> {
    // CONTRACT STUB — replaced by 51-09 (D-06 read-only point read)
    throw new Error('getAssociationRequest is not implemented')
  }
}
