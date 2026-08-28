import { bytesToHex } from '@noble/curves/utils.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { utf8ToBytes } from '@noble/hashes/utils.js'
import { asText, digestToBytes, nowCanonicalDatetime, SEQUENCE_ALLOCATION_ATTEMPTS } from '../utils.js'
import { seedSignedMutation } from '../signing/signed-mutation.js'
import { allocateTid } from '../database/tid-allocator.js'
import { toIsoZDatetime, toDeferredCheckDatetime, reZuluDatetime, restoreCanonicalDatetime, resolveSign as resolveSignHelper, requireCtx as requireCtxHelper, rethrow as rethrowHelper } from '../signing/ceremony-helpers.js'
import { verifySig, verifySigP256 } from '../database/initialize.js'
import { StubAttestationVerifier } from './stub-attestation-verifier.js'
import { AssociationAssociateBuilder } from './builders/association-associate-builder.js'
import { resolveRecordValidity as resolveRecordValidityFromPolicy } from './record-validity.js'
import type { EngineContext } from '../types.js'
// 51-09 Task 2: `IAssociationRequestIntake`/`StagedAttestation` are declared in the FILESYSTEM
// transport module (deliberately, per that file's own doc comment — "transport-agnostic despite
// living in the filesystem module for now"). This is a TYPE-ONLY import of that shared interface,
// never a value import and never a concrete transport binding — the driver below never
// constructs, imports as a value, or depends on `FilesystemAssociationTransport` itself, so it
// never drags `node:fs` toward the RN bundle.
import type { IAssociationRequestIntake, StagedAttestation } from './transport/filesystem-association-transport.js'
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

/**
 * The persisted `AssociationRequest` row shape `validateStagedAttestationAnswer` (51-08 Task 2)
 * loads and returns. Deliberately NOT exported from `@votetorrent/vote-core` — this is an
 * engine-internal load result, not a wire type; `AssociationRequestRead` (vote-core) remains the
 * public read shape. 51-09's driver (`processPendingAssociationRequests`, same class/file) calls
 * `validateStagedAttestationAnswer` again on every staged document and consumes this same shape.
 */
interface AssociationRequestRow {
  id: string
  authorityId: string
  registrantId: string
  deviceKey: string
  electionId?: string
  status: AssociationRequestStatus
  challengeNonce?: string
}

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
 * L-3 skew-guard bounds for `submitAssociationRequest`'s submitter-supplied `SubmittedAt`
 * (51-08 Task 1). SAME VALUES, SAME rationale, and the SAME named-constant discipline as
 * `RegistrationEngine`'s identically-named module constants (`registration-engine.ts:91/101`) —
 * declared as siblings here rather than imported because the registration copy is not exported
 * (WR-04 consolidated the datetime/ceremony HELPERS into `ceremony-helpers.js`, not these two
 * plan-specific bound constants). A later change to either bound has to move the test that pins
 * it, not just a comment.
 *
 * +5 minutes forward: a submitter's device clock is not the authority's own (this project has a
 * recorded ~45s emulator/host clock-skew failure — project memory: device proof clock skew — so
 * the tolerance is deliberately an order of magnitude wider than that observed drift).
 */
const SUBMITTED_AT_MAX_FUTURE_SKEW_MS = 5 * 60 * 1000

/**
 * -30 days backward: mirrors `RegistrationEngine`'s identical bound — an offline courier (51-06)
 * may legitimately deliver a staged, already-signed request well after it was signed.
 */
const SUBMITTED_AT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

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
  /**
   * D-18: same-process holding pen for a validated staged attestation answer, keyed by
   * `requestId`. NOT the durable home for an in-flight answer — that is the TRANSPORT's staging
   * area (`readStagedAttestations`, 51-06), which is where 51-09's driver actually reads answers
   * from in a real multi-process deployment. This map exists only because
   * `submitAssociationAttestation` needs somewhere to put a validated answer within a single
   * `AssociationEngine` instance's lifetime (e.g. same-process tests); a second table is
   * explicitly rejected by D-18, and `AssociationRequest.TransitionValid` admits only the two
   * 'vrg'-signed UPDATE transitions, neither of which this staging step is.
   */
  private readonly pendingAttestationAnswers = new Map<string, AssociationAttestationAnswer>()

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

  /**
   * D-12 — thin per-instance wrapper around the shared `resolveRecordValidity` helper
   * (`./record-validity.js`), which runs, field for field, the EXACT select-then-fallback shape
   * modeled on the EXISTING `ElectionAttestationPolicy` read above (`associate()`'s `policyRow`
   * lookup):
   *
   *   select RegistrantValidityDays, AssociationValidityDays
   *     from ElectionRecordValidityPolicy where ElectionId = :electionId
   *
   * A failure of that SELECT itself PROPAGATES (rejects `associate()`), never silently defaults —
   * the only silent-default case is "no row for this election, or `electionId` is `undefined`",
   * which falls back to the shared module's CONSERVATIVE named constants
   * (`DEFAULT_REGISTRANT_VALIDITY_DAYS`/`DEFAULT_ASSOCIATION_VALIDITY_DAYS`), never a permissive
   * window. Lifted into a shared free function — rather than kept inline here — so
   * `SignatureTasksEngine.finalizeRegistrantApproval` (the `Registrant`/`RegistrantPrivate`
   * expiration site) reads the SAME `ElectionRecordValidityPolicy` row without constructing an
   * `AssociationEngine` instance from `signature-tasks-engine.ts` (see 51-09-SUMMARY.md's "chosen
   * mechanism" note — the plan's other option).
   */
  private async resolveRecordValidity (electionId: string | undefined): Promise<{ registrantExpiration: string; associationExpiration: string }> {
    return resolveRecordValidityFromPolicy(this.ctx!, electionId)
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
      const electionIdValue = electionId ?? null

      // NOTE: bind names `challengeNonce`/`challengeAuthorityId` (NOT `nonce`/`authorityId`) —
      // seedSignedMutation reserves `nonce`/`authorityId`/etc for ITS OWN ceremony bind params
      // and would silently overwrite a same-named digestParams entry (T-42-03 bug class found
      // via TDD on 42-03's RegistrationEngine: a `signature` key collided there; here the
      // colliding keys would have been the challenge's own Nonce/AuthorityId). `electionId`
      // does NOT collide with seedSignedMutation's reserved set (nonce/authorityId/signature).
      //
      // D-10 (51-05): the trailing `expiration`/`expirationDeferred` argument is GONE — removed
      // in lockstep with the schema's `AttestationChallenge.InsertValid` `Digest(...)` (D-10).
      // `:electionId` is now the LAST slot in this 6-argument tuple; both sides moved together
      // in the same commit (45-04/51-05 atomicity requirement) — a slot/arity mismatch fails
      // every insert.
      const digestExpr = 'select Digest(:tid, :challengeNonce, :challengeAuthorityId, :registrantId, :deviceKey, :electionId) as d'
      const digestParams = { tid, challengeNonce: nonce, challengeAuthorityId: authorityId, registrantId, deviceKey, electionId: electionIdValue }
      const signingNonce = await seedSignedMutation(ctx, authorityId, 'vrg', tid, digestExpr, digestParams, this.resolveSign(signatureOrCallback))

      await ctx.db.exec(
        `insert into AttestationChallenge (Nonce, AuthorityId, RegistrantId, DeviceKey, ElectionId)
         with context SigningNonce = :signingNonce, Tid = ${tid}
         values (:nonce, :authorityId, :registrantId, :deviceKey, :electionId)`,
        {
          nonce,
          authorityId,
          registrantId,
          deviceKey,
          electionId: electionIdValue,
          signingNonce
        }
      )

      return { nonce, authorityId, registrantId, deviceKey, electionId: electionIdValue ?? undefined }
    } catch (err) {
      this.rethrow(err, 'issueAttestationChallenge')
    }
  }

  /** D-03: authority deletes a consumed/stale challenge ('vrg'-signed delete). */
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

      // D-10 (51-05): the `with context` clause's `now` param is GONE — `context.now` was used
      // by nothing in this table except the removed `ExpirationFuture` CHECK.
      await ctx.db.exec(
        `delete from AttestationChallenge
         with context SigningNonce = :signingNonce, Tid = ${tid}
         where Nonce = :nonce`,
        { nonce, signingNonce }
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
   * 5. D-11 (51-05): AFTER step 4's transaction COMMITs, DELETE the matched
   *    `AttestationChallenge` row under its own `'vrg'`-signed delete ceremony,
   *    in a SEPARATE transaction — a replay with the same nonce then fails at
   *    step 1's lookup. NOT folded into step 4's transaction: `AssociationPrivate
   *    .ChallengeValid` is a deferred (subquery) CHECK that Quereus evaluates
   *    against the transaction's FINAL row state at COMMIT, so deleting the
   *    challenge inside that same transaction made the already-satisfied CHECK
   *    fail (empirically confirmed via TDD). A failure in step 4 never reaches
   *    this step at all, so the challenge is trivially left intact for the
   *    device to retry — single-use is enforced by BOTH this consumption AND
   *    the pre-existing Association primary-key collision (D-06).
   *
   * D-10/D-12 (51-09): `AttestationChallenge` carries no `Expiration` — the challenge no longer
   * supplies an expiration value. `Association`/`AssociationPrivate.Expiration` are computed here
   * from the authority's OWN per-election `ElectionRecordValidityPolicy` row (via
   * `resolveRecordValidity`, above), with a CONSERVATIVE named-constant fallback when no such row
   * exists. The expiration is authority policy, per election — it does NOT derive from the
   * challenge, and `AssociateInit` deliberately still carries no expiration field: the voter does
   * not propose the validity window of a record the authority signs. This is deliberately NOT a
   * ten-year window — see `ConfirmationScreen.tsx:150`'s `TEN_YEARS_MS` "dev posture", the exact
   * anti-pattern D-12 exists to retire.
   */
  async associate (init: AssociateInit, signatureOrCallback: SignatureOrCallback): Promise<void> {
    this.requireCtx('associate')
    const ctx = this.ctx!
    const { registrantId, deviceKey, deviceHash, nonce, attestation } = init

    const challengeRow = await ctx.db
      .prepare(
        'select Nonce, AuthorityId, RegistrantId, DeviceKey, ElectionId from AttestationChallenge where Nonce = :nonce and RegistrantId = :registrantId and DeviceKey = :deviceKey'
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
      electionId: challengeRow.ElectionId == null ? undefined : asText(challengeRow.ElectionId, 'AttestationChallenge.ElectionId')
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

    // D-10/D-12 (51-09): the challenge no longer carries an expiration (D-10 removed
    // `AttestationChallenge.Expiration`) — read the authority-owned per-election
    // `ElectionRecordValidityPolicy` row instead (conservative named-constant fallback when no
    // such row exists). Do NOT change this to a ten-year window — see
    // `ConfirmationScreen.tsx:150`'s `TEN_YEARS_MS`, the exact "dev posture" anti-pattern D-12
    // exists to retire.
    const { associationExpiration: expiration } = await this.resolveRecordValidity(challenge.electionId)
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

      // ---- D-11 (51-05): consume the challenge — its OWN transaction, run ONLY after the
      // Association/AssociationPrivate write above has durably COMMITted. This is NOT folded
      // into that transaction (a deliberate deviation from the original plan text, which asked
      // for the delete inside the same BEGIN/COMMIT): AssociationPrivate.ChallengeValid is a
      // subquery ("deferred") CHECK, and empirically (via TDD — every associate() test failed
      // with "CHECK constraint failed: ChallengeValid" once the in-transaction delete was added)
      // Quereus evaluates deferred CHECKs against the transaction's FINAL row state at COMMIT,
      // not per-statement. Deleting AttestationChallenge inside the same transaction as the
      // AssociationPrivate insert made that already-satisfied CHECK fail at commit — the exact
      // "deferred-CHECK sibling-row visibility" class this project has hit before (quereus #25).
      //
      // Consequence: the write and the consumption are two honest, sequential transactions, not
      // one atomic unit. A crash in the narrow window between them would leave a used-but-not-
      // yet-deleted challenge — NOT a live replay vector, because a second associate() attempt
      // for the same (registrantId, deviceKey) is independently rejected by the Association
      // primary-key collision (D-06 structural — proven in association.spec.ts's "replay-reject"
      // suite). Single-use is therefore enforced by TWO independent layers (PK collision +
      // this consumption), not by this delete alone.
      //
      // Modeled on removeAttestationChallenge's existing 'vrg'-signed delete ceremony shape,
      // called with its OWN transaction (no `ownsTransaction: false` — the outer BEGIN/COMMIT
      // above has already closed).
      const consumeTid = await allocateTid(ctx.db, 'association')
      // NOTE: `challengeNonce` (not `nonce`) — avoids the seedSignedMutation reserved-bind
      // collision (see issueAttestationChallenge's doc comment).
      const consumeDigestExpr = "select Digest(:tid, :challengeNonce, 'delete') as d"
      const consumeDigestParams = { tid: consumeTid, challengeNonce: nonce }
      const consumeNonce = await seedSignedMutation(
        ctx,
        challenge.authorityId,
        'vrg',
        consumeTid,
        consumeDigestExpr,
        consumeDigestParams,
        this.resolveSign(signatureOrCallback)
      )
      // D-10 (51-05): the `with context` clause's `now` param is GONE from this table.
      await ctx.db.exec(
        `delete from AttestationChallenge
         with context SigningNonce = :signingNonce, Tid = ${consumeTid}
         where Nonce = :nonce`,
        { nonce, signingNonce: consumeNonce }
      )
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
        ? 'select Nonce, AuthorityId, RegistrantId, DeviceKey, ElectionId from AttestationChallenge'
        : 'select Nonce, AuthorityId, RegistrantId, DeviceKey, ElectionId from AttestationChallenge where RegistrantId = :registrantId'
      const params: Record<string, string> = registrantId === undefined ? {} : { registrantId }
      for await (const row of ctx.db.eval(sql, params)) {
        out.push({
          nonce: asText(row.Nonce, 'AttestationChallenge.Nonce'),
          authorityId: asText(row.AuthorityId, 'AttestationChallenge.AuthorityId'),
          registrantId: asText(row.RegistrantId, 'AttestationChallenge.RegistrantId'),
          deviceKey: asText(row.DeviceKey, 'AttestationChallenge.DeviceKey'),
          electionId: row.ElectionId == null ? undefined : asText(row.ElectionId, 'AttestationChallenge.ElectionId')
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
      // codebase uses (Association.Expiration, the private device-association
      // row's own attestation-time column,
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

  /**
   * D-02: the ceremony-free self-signed intake — the voter's ONLY write path into the
   * association flow after D-01. Deliberately runs NO `seedSignedMutation`, creates NO
   * `AdminSigning`/`AdminSignature`/`SigningNonce` row, touches no `User` row and references no
   * `IsUserValid` — the requester's own signature under `requesterKey` (the device key) is the
   * entire authorization gate. `requesterKey` is bound to `AssociationRequest.DeviceKey` (the
   * same column `init.deviceKey` describes) — see the pre-flight guard below for why both must
   * agree rather than silently preferring one.
   *
   * Allocates Tids through a NEW `'association-request'` allocator namespace, distinct from the
   * `'association'` namespace `issueAttestationChallenge`/`associate`/`removeAttestationChallenge`/
   * `removeAssociation` draw from (mirrors 48-07's `'registration-request'` beside
   * `'registration'`) — a Tid is never reused across a ceremony-bearing write and this
   * ceremony-free one. `AssociationRequest`'s own `with context (SigningNonce, Tid)` INSERT-time
   * `Tid` is inert (no INSERT-time CHECK references `context.Tid` — only the D-18 UPDATE
   * transitions do), but a value must still be supplied.
   */
  async submitAssociationRequest (init: AssociationRequestInit, requesterKey: string, signatureOrCallback: SignatureOrCallback): Promise<string> {
    this.requireCtx('submitAssociationRequest')
    const ctx = this.ctx!
    try {
      // Pre-flight guard: produces an ATTRIBUTABLE error only. SignatureValid remains the actual
      // enforcement boundary (a mismatched DeviceKey fails signature verification regardless) —
      // this guard exists so a caller who bound the two independently gets a clear diagnosis
      // instead of an opaque "signature invalid" from deep inside the INSERT.
      if (init.deviceKey !== requesterKey) {
        throw new Error(
          `submitAssociationRequest: init.deviceKey (${init.deviceKey}) does not match requesterKey (${requesterKey}) — AssociationRequest.DeviceKey must be the same key that authorizes the insert`
        )
      }

      // A NEW allocator namespace, distinct from 'association' above — see doc comment.
      const tid = await allocateTid(ctx.db, 'association-request')

      // Defensive renames (rowAuthorityId, not authorityId) — this method runs no
      // seedSignedMutation today, but a future refactor that adds one must not silently collide
      // with its reserved bind names (nonce/authorityId/adminEffectiveAt/scope/userId/signerKey/
      // signature/now — see issueAttestationChallenge's NOTE).
      const rowAuthorityId = init.authorityId
      const registrantId = init.registrantId
      const deviceKey = requesterKey
      const electionId = init.electionId ?? null

      // L-3 (mirrors RegistrationEngine.submitRegistrationRequest): SubmittedAt is the
      // SUBMITTER's own value, bound VERBATIM. NEVER toIsoZDatetime(new Date()) /
      // nowCanonicalDatetime() here — an engine-generated value would make an offline courier's
      // own pre-resolved signature unverifiable, since the signer could not have known it at
      // signing time.
      const submittedAt = init.submittedAt
      if (Number.isNaN(Date.parse(submittedAt))) {
        // Attributable-error guard only; the schema's SignatureValid/SubmittedAt-shaped CHECKs remain the enforcement.
        throw new Error(`submitAssociationRequest: init.submittedAt does not parse as a date: ${submittedAt}`)
      }

      // ReceivedAt: the AUTHORITY's OWN observation of intake time, inside NO digest.
      const receivedAt = toIsoZDatetime(Date.now())

      // Skew guard: BOUNDS the submitter-supplied SubmittedAt, does not authenticate it — inside
      // the window it remains a submitter-chosen value covered only by the submitter's own
      // signature.
      const submittedAtMs = Date.parse(submittedAt)
      const receivedAtMs = Date.parse(receivedAt)
      if (submittedAtMs - receivedAtMs > SUBMITTED_AT_MAX_FUTURE_SKEW_MS) {
        throw new Error(
          `submitAssociationRequest: submittedAt (${submittedAt}) is more than ${SUBMITTED_AT_MAX_FUTURE_SKEW_MS}ms ahead of receivedAt (${receivedAt})`
        )
      }
      if (receivedAtMs - submittedAtMs > SUBMITTED_AT_MAX_AGE_MS) {
        throw new Error(
          `submitAssociationRequest: submittedAt (${submittedAt}) is more than ${SUBMITTED_AT_MAX_AGE_MS}ms before receivedAt (${receivedAt})`
        )
      }

      // D-02's ONLY authorization gate — AssociationRequest.SignatureValid, field for field
      // (51-01's landed digest tuple): Digest(Id, AuthorityId, RegistrantId, DeviceKey,
      // ElectionId, SubmittedAt). NO context.Tid — unlike RegistrationRequest's DG-1, this CHECK
      // is UNQUALIFIED so it re-evaluates on the D-18 UPDATE transitions too (51-01's schema
      // comment), and a Tid changes per statement.
      const digestRow = await ctx.db
        .prepare('select Digest(:id, :rowAuthorityId, :registrantId, :deviceKey, :electionId, :submittedAt) as d')
        .get({
          id: init.id,
          rowAuthorityId,
          registrantId,
          deviceKey,
          electionId,
          submittedAt
        })
      if (!digestRow || digestRow.d == null) {
        throw new Error('submitAssociationRequest: Digest() returned null — crypto plugin not registered?')
      }
      const digestBytes = digestToBytes(digestRow.d)
      const signature = await this.resolveSign(signatureOrCallback)(digestBytes)
      // D-02/D-04: `signature.signerUserId` is NEVER read here — a prospective registrant has no
      // user id, the field is a type artifact on this path, and touching it is how a User
      // dependency would creep back in.

      // No signing session exists at INSERT — SigningNonce binds null (D-02: run NO
      // seedSignedMutation, create NO AdminSigning row).
      await ctx.db.exec(
        `insert into AssociationRequest (
          Id, AuthorityId, RegistrantId, DeviceKey, ElectionId, Status, ChallengeNonce, SubmittedAt, ReceivedAt, DecidedAt, RejectionReason, RequesterSignature
        )
        with context SigningNonce = :signingNonce, Tid = ${tid}
        values (:id, :rowAuthorityId, :registrantId, :deviceKey, :electionId, :status, null, :submittedAt, :receivedAt, null, null, :requesterSignature)`,
        {
          id: init.id,
          rowAuthorityId,
          registrantId,
          deviceKey,
          electionId,
          status: 'p',
          submittedAt,
          receivedAt,
          requesterSignature: signature.signature,
          signingNonce: null
        }
      )

      return init.id
    } catch (err) {
      this.rethrow(err, 'submitAssociationRequest')
    }
  }

  /**
   * D-18: the second, distinct voter-to-authority message — stages an answer to the challenge
   * the authority issued for `answer.requestId`. ALL validation lives in
   * `validateStagedAttestationAnswer` below (T-51-08-09) — this method is a THIN caller of it, so
   * that 51-09's driver, which calls the SAME helper again on every staged document before
   * building an `AssociateInit`, keeps this check on the production path rather than a
   * pre-filter the driver could bypass.
   *
   * Writes NO `Association`, `AssociationPrivate` or `AttestationVerdict` row, and runs NO
   * `seedSignedMutation` — verification, signing and the two-row write remain `associate()`'s
   * (51-09's driver) job, not this intake leg's.
   */
  async submitAssociationAttestation (answer: AssociationAttestationAnswer, requesterKey: string, signatureOrCallback: SignatureOrCallback): Promise<void> {
    this.requireCtx('submitAssociationAttestation')
    try {
      const row = await this.validateStagedAttestationAnswer(answer, requesterKey, signatureOrCallback)
      // Stage the validated answer where the driver will find it — see pendingAttestationAnswers'
      // own doc comment for the transport-staging-area division this deliberately does NOT paper
      // over.
      this.pendingAttestationAnswers.set(row.id, answer)
    } catch (err) {
      this.rethrow(err, 'submitAssociationAttestation')
    }
  }

  /**
   * validateStagedAttestationAnswer(answer, requesterKey, signatureOrCallback) —
   * D-18's SHARED validation gate. Loads the `AssociationRequest` row by `answer.requestId` and
   * either THROWS or returns it. Called by `submitAssociationAttestation` above AND, by name, by
   * 51-09's `processPendingAssociationRequests` driver on every staged document before building
   * an `AssociateInit` — a rename breaks 51-09 (recorded verbatim in the plan SUMMARY).
   *
   * `registrantId`/`deviceKey`/`electionId` are read from THE PERSISTED ROW, never from
   * `answer` — `AssociationAttestationAnswer` does not even carry those fields — which is the
   * structural reason a second message cannot re-point an answer at a different registrant or
   * device (T-51-08-03).
   *
   * Rejects (throws) when:
   *   1. the row is missing;
   *   2. `Status !== 'c'` (nothing to answer yet, or already terminal);
   *   3. `requesterKey !== row.DeviceKey` (the answer must come from the same key that made the ask);
   *   4. `answer.nonce !== row.ChallengeNonce` (T-51-08-04 replay/wrong-nonce guard);
   *   5. the self-signature does not verify under `requesterKey`.
   *
   * ENGINE-SIDE ONLY verification (T-51-08-06, accepted risk) — declared here rather than left
   * implicit: the staged answer is not itself a schema row (`AssociationRequest.TransitionValid`
   * admits only the two 'vrg'-signed UPDATE transitions, neither of which this staging step is),
   * so there is NO schema CHECK behind this self-signature verification. Uses the same
   * `verifySig`/`verifySigP256` primitives (`../database/initialize.js`) the schema's
   * `SignatureValid`/`SignatureValidP256` UDFs call, mixed-curve "try both" exactly like the
   * schema's own `or` form — neither curve is privileged.
   *
   * The digest tuple, field for field: `Digest(RequestId, Nonce, AttestationJson, DeviceHash)`
   * where `AttestationJson = JSON.stringify(answer.attestation)` — mirrors `associate()`'s own
   * `attestationDetailsJson` precedent for turning a `DeviceAttestation`-shaped object into a
   * digestible string. Any party (including 51-06's transport bindings) that wants to reproduce
   * this digest independently must serialize `answer.attestation` with the SAME `JSON.stringify`
   * call — object key ORDER matters to the digest, matching every other JSON-digest site in this
   * codebase.
   */
  private async validateStagedAttestationAnswer (
    answer: AssociationAttestationAnswer,
    requesterKey: string,
    signatureOrCallback: SignatureOrCallback
  ): Promise<AssociationRequestRow> {
    const ctx = this.ctx!
    const row = await ctx.db
      .prepare('select Id, AuthorityId, RegistrantId, DeviceKey, ElectionId, Status, ChallengeNonce from AssociationRequest where Id = :requestId')
      .get({ requestId: answer.requestId })
    if (!row) {
      throw new Error(`validateStagedAttestationAnswer: AssociationRequest not found for requestId=${answer.requestId}`)
    }

    const status = asText(row.Status, 'AssociationRequest.Status') as AssociationRequestStatus
    const deviceKey = asText(row.DeviceKey, 'AssociationRequest.DeviceKey')
    const registrantId = asText(row.RegistrantId, 'AssociationRequest.RegistrantId')
    const authorityId = asText(row.AuthorityId, 'AssociationRequest.AuthorityId')
    const electionId = row.ElectionId == null ? undefined : asText(row.ElectionId, 'AssociationRequest.ElectionId')
    const challengeNonce = row.ChallengeNonce == null ? undefined : asText(row.ChallengeNonce, 'AssociationRequest.ChallengeNonce')

    if (status !== 'c') {
      throw new Error(
        `validateStagedAttestationAnswer: AssociationRequest ${answer.requestId} is not awaiting an attestation answer (Status=${status}, expected 'c')`
      )
    }
    if (requesterKey !== deviceKey) {
      throw new Error(
        `validateStagedAttestationAnswer: requesterKey (${requesterKey}) does not match the persisted AssociationRequest.DeviceKey — an answer must come from the same key that made the ask`
      )
    }
    if (answer.nonce !== challengeNonce) {
      throw new Error(
        `validateStagedAttestationAnswer: answer.nonce does not match the persisted ChallengeNonce for requestId=${answer.requestId}`
      )
    }

    // No schema CHECK behind this — see this method's doc comment (T-51-08-06).
    const attestationJson = JSON.stringify(answer.attestation)
    const digestRow = await ctx.db
      .prepare('select Digest(:requestId, :nonce, :attestationJson, :deviceHash) as d')
      .get({
        requestId: answer.requestId,
        nonce: answer.nonce,
        attestationJson,
        deviceHash: answer.deviceHash ?? null
      })
    if (!digestRow || digestRow.d == null) {
      throw new Error('validateStagedAttestationAnswer: Digest() returned null for the answer self-signature — crypto plugin not registered?')
    }
    const digestBytes = digestToBytes(digestRow.d)
    const signature = await this.resolveSign(signatureOrCallback)(digestBytes)
    const signatureValid =
      verifySig(digestRow.d, signature.signature, requesterKey) ||
      verifySigP256(digestRow.d, signature.signature, requesterKey)
    if (!signatureValid) {
      throw new Error(
        'validateStagedAttestationAnswer: self-signature does not verify under requesterKey (no schema CHECK behind this — engine-side only, T-51-08-06)'
      )
    }

    return { id: answer.requestId, authorityId, registrantId, deviceKey, electionId, status, challengeNonce }
  }

  /**
   * D-05/D-19 — the automatic authority-side processing driver. Turns the persisted D-02/D-18
   * intake into real records by orchestrating the two UNCHANGED engine methods
   * (`issueAttestationChallenge`, `associate`) across both legs of the D-18 challenge round-trip.
   * No `Task` row, no `SignatureType` reference, and no per-request human decision anywhere in this
   * method — D-05 is explicit that processing is automatic and authority-VERIFIED, not
   * officer-APPROVED. An officer key must still be present to SIGN (the `'vrg'` ceremonies below),
   * which is why D-19 sites the trigger in the existing "Sync Now" mechanism rather than a
   * background poller.
   *
   * LEG 1 (pending 'p' rows): for each, call the UNCHANGED `issueAttestationChallenge` — the
   * `'vrg'` ceremony, run HERE, on the authority side, with an officer key the voter does not
   * hold — then write the `'p' -> 'c'` signed transition and publish a `'c'` decision notice
   * carrying the fresh `challengeNonce`.
   *
   * LEG 2 (challenge-issued 'c' rows with a staged answer): for each staged document belonging to
   * THIS authority's still-'c' rows, validate the envelope through 51-08's SHARED
   * `validateStagedAttestationAnswer` helper — never a re-implemented nonce/deviceKey/status check
   * — build an `AssociateInit` from the PERSISTED ROW (registrantId, deviceKey) plus the staged
   * answer's wire fields (nonce, attestation, deviceHash), and call the UNCHANGED `associate()`.
   * On success: `'c' -> 'a'`. If `associate()` itself throws — the REQUESTER's own attestation
   * failing — a `'c' -> 'r'` transition carrying a GENERIC rejection-reason class, never a raw
   * verifier reason or `err.message`. Processing continues with the remaining staged documents;
   * one bad answer never stalls the batch (T-51-09-07).
   *
   * An ENVELOPE validation failure is NOT a decision (CR-05, 51-REVIEW). It means the document
   * did not come from the requester, so it is SKIPPED and the row is left in `'c'` — see the
   * catch block itself for why deciding on it would be a permanent, unrecoverable denial of
   * service on the honest voter's request.
   *
   * Idempotent by construction: LEG 1 only selects `Status = 'p'` rows (a row the previous run
   * already transitioned to `'c'` is invisible to a second run), and LEG 2 only matches a staged
   * document to a row that is STILL `Status = 'c'` (a row the previous run already resolved to
   * `'a'`/`'r'` is invisible too) — re-running this method over the same input issues no duplicate
   * challenge and creates no duplicate `Association`.
   *
   * Both signed transitions explicitly rebind `SubmittedAt`/`ReceivedAt` on every UPDATE — an
   * unqualified CHECK on this table re-evaluates against a Z-stripped row snapshot when a
   * timestamp column is left unbound (this project's own recorded partial-UPDATE trap).
   *
   * WIDENED BEYOND `IAssociationEngine`'s vote-core interface (Rule 3 — blocking-issue fix,
   * documented in 51-09-SUMMARY.md): 51-04's declared signature is 2-arg
   * (`authorityId, signatureOrCallback`). `IAssociationRequestIntake` is declared in the
   * filesystem-transport module named in this file's own type-only import above, an
   * ENGINE-layer file — `@votetorrent/vote-core` cannot type-reference it without inverting the
   * package dependency direction (vote-engine already depends on vote-core, never the reverse).
   * The intake is therefore an OPTIONAL third parameter here: type-compatible with the narrower
   * `IAssociationEngine` signature (an extra optional parameter does not break `implements`), but
   * REQUIRED at runtime — a call that omits it throws immediately, below, rather than reaching a
   * bare `undefined.readStagedAttestations` a layer away from its cause.
   */
  async processPendingAssociationRequests (
    authorityId: string,
    signatureOrCallback: SignatureOrCallback,
    intake?: IAssociationRequestIntake
  ): Promise<{ challengesIssued: number; associated: number; rejected: number }> {
    this.requireCtx('processPendingAssociationRequests')
    if (!intake) {
      throw new Error(
        'processPendingAssociationRequests: an IAssociationRequestIntake is required — this parameter widens IAssociationEngine\'s declared (2-arg) signature and cannot be defaulted (see 51-09-SUMMARY.md)'
      )
    }
    const ctx = this.ctx!
    let challengesIssued = 0
    let associated = 0
    let rejected = 0
    try {
      // ---------------- LEG 1: pending ('p') rows -> issue challenge, transition to 'c' ----------------
      const pendingRows: Array<{ id: string; registrantId: string; deviceKey: string; electionId?: string }> = []
      for await (const row of ctx.db.eval(
        "select Id, RegistrantId, DeviceKey, ElectionId from AssociationRequest where AuthorityId = :rowAuthorityId and Status = 'p'",
        { rowAuthorityId: authorityId }
      )) {
        pendingRows.push({
          id: asText(row.Id, 'AssociationRequest.Id'),
          registrantId: asText(row.RegistrantId, 'AssociationRequest.RegistrantId'),
          deviceKey: asText(row.DeviceKey, 'AssociationRequest.DeviceKey'),
          electionId: row.ElectionId == null ? undefined : asText(row.ElectionId, 'AssociationRequest.ElectionId')
        })
      }

      for (const row of pendingRows) {
        // D-01/D-03: the 'vrg' challenge-issuance ceremony runs HERE — nothing in this method may
        // accept a voter-supplied signer.
        const challenge = await this.issueAttestationChallenge(row.registrantId, row.deviceKey, signatureOrCallback, row.electionId)

        const rowBefore = await ctx.db
          .prepare('select SubmittedAt, ReceivedAt from AssociationRequest where Id = :id')
          .get({ id: row.id })
        if (!rowBefore) {
          throw new Error(`processPendingAssociationRequests: AssociationRequest ${row.id} disappeared between the leg-1 select and the transition UPDATE`)
        }
        // CRITICAL — partial-UPDATE trap: explicitly rebind BOTH untouched timestamp columns.
        const submittedAt = restoreCanonicalDatetime(rowBefore.SubmittedAt as string)
        const receivedAt = restoreCanonicalDatetime(rowBefore.ReceivedAt as string)

        const tid = await allocateTid(ctx.db, 'association-request')
        // TransitionValid's challenge-echo clause, field for field: Digest(context.Tid, new.Id, new.Status, new.ChallengeNonce).
        const digestExpr = 'select Digest(:tid, :requestId, :status, :challengeNonce) as d'
        const digestParams = { tid, requestId: row.id, status: 'c', challengeNonce: challenge.nonce }
        const signingNonce = await seedSignedMutation(ctx, authorityId, 'vrg', tid, digestExpr, digestParams, this.resolveSign(signatureOrCallback))

        await ctx.db.exec(
          `update AssociationRequest
           with context SigningNonce = :signingNonce, Tid = ${tid}
           set Status = :status, ChallengeNonce = :challengeNonce, SubmittedAt = :submittedAt, ReceivedAt = :receivedAt
           where Id = :requestId`,
          { requestId: row.id, status: 'c', challengeNonce: challenge.nonce, submittedAt, receivedAt, signingNonce }
        )

        await intake.publishDecision({ requestId: row.id, status: 'c', challengeNonce: challenge.nonce, decidedAt: toIsoZDatetime(Date.now()) })
        challengesIssued++
      }

      // ---------------- LEG 2: challenge-issued ('c') rows with a staged answer ----------------
      const stagedAnswers: StagedAttestation[] = await intake.readStagedAttestations()
      for (const doc of stagedAnswers) {
        const rowC = await ctx.db
          .prepare(
            "select Id, ChallengeNonce, SubmittedAt, ReceivedAt from AssociationRequest where Id = :id and AuthorityId = :rowAuthorityId and Status = 'c'"
          )
          .get({ id: doc.requestId, rowAuthorityId: authorityId })
        if (!rowC) {
          // Not one of THIS authority's still-'c' rows (a different authority's request, or a row
          // this method already resolved on a prior run) — this batch is scoped to `authorityId`,
          // and idempotency relies on this skip.
          continue
        }

        // LEG 2 MANDATORY GATE (T-51-08-09/T-51-09-10): route every staged answer through 51-08's
        // shared `validateStagedAttestationAnswer` BEFORE building an `AssociateInit` — never a
        // re-implemented nonce/deviceKey/status check. This is what keeps the self-signature check
        // on the production driver path rather than a bypassable pre-filter (the `e64e112` defect
        // class this phase exists to eliminate). `associate()`'s real attestation verification
        // remains the load-bearing gate for the attestation itself; this helper gates the ENVELOPE.
        let validated: { registrantId: string; deviceKey: string } | undefined
        // GENERIC rejection-reason vocabulary (T-51-09-03) — never a raw verifier `reason` or
        // `err.message` crosses to a notice a device reads, mirroring `ConfirmationScreen`'s
        // existing `classifyAttestationFailure` voter-side discipline.
        let rejectionReason: string | undefined
        try {
          const loaded = await this.validateStagedAttestationAnswer(doc.answer, doc.requesterKey, doc.signature)
          validated = { registrantId: loaded.registrantId, deviceKey: loaded.deviceKey }
        } catch (envelopeErr) {
          // CR-05 (51-REVIEW): SKIP, never DECIDE.
          //
          // Every way this gate throws — a self-signature that does not verify under
          // `requesterKey`, a `requesterKey` that is not the row's `DeviceKey`, a nonce that is
          // not the row's `ChallengeNonce` — means the SAME thing: this document is not an
          // answer from this requester at all. The staging channel is explicitly untrusted (a
          // drop directory anyone with filesystem access can write to, or a bridge whose own
          // header says it verifies nothing), and pending request ids are enumerable, so
          // letting such a document DECIDE the row hands any attacker a permanent denial of
          // service: `AssociationRequest` has `NoDelete` and `TransitionValid` admits no
          // `'r' -> *` transition, so the honest voter's request would be dead forever and
          // they would have to start over with a new request id.
          //
          // Skipping leaves the row in 'c', so the genuine answer can still land on a later
          // sync. The 'r' path below is retained for the case that IS the requester's own
          // decision: `associate()` failing on their own attestation.
          console.warn(
            `AssociationEngine.processPendingAssociationRequests: skipping a staged answer for requestId=${doc.requestId} whose envelope did not validate (not an answer from this requester) — the request stays 'c'`,
            envelopeErr instanceof Error ? envelopeErr.message : String(envelopeErr)
          )
          continue
        }

        if (validated) {
          // T-51-09-02: registrantId/deviceKey come from the PERSISTED ROW (via
          // validateStagedAttestationAnswer's own row load), never the wire — only nonce,
          // attestation and deviceHash come from the staged document.
          const associateInit: AssociateInit = {
            registrantId: validated.registrantId,
            deviceKey: validated.deviceKey,
            deviceHash: doc.answer.deviceHash,
            nonce: asText(rowC.ChallengeNonce, 'AssociationRequest.ChallengeNonce'),
            attestation: doc.answer.attestation
          }
          try {
            // THE DRIVER CALLS THIS UNCHANGED — no reimplementation of verification, verdict
            // recording, the two-row write, or D-11's challenge consumption.
            await this.associate(associateInit, signatureOrCallback)
          } catch {
            rejectionReason = 'attestation-verification-failed'
          }
        }

        const submittedAt = restoreCanonicalDatetime(rowC.SubmittedAt as string)
        const receivedAt = restoreCanonicalDatetime(rowC.ReceivedAt as string)
        const tid2 = await allocateTid(ctx.db, 'association-request')
        const decidedAt = toIsoZDatetime(Date.now())
        // `new.DecidedAt` is a datetime column inside TransitionValid's deferred (subquery)
        // clause — the digest argument MUST use toDeferredCheckDatetime, never the raw ISO-Z value
        // bound into the stored column below.
        const decidedAtDeferred = toDeferredCheckDatetime(decidedAt)
        const finalStatus = rejectionReason === undefined ? 'a' : 'r'
        const rejectionReasonBind = rejectionReason ?? null

        // TransitionValid's decision clause, field for field: Digest(context.Tid, new.Id,
        // new.Status, new.DecidedAt, new.RejectionReason).
        const digestExpr2 = 'select Digest(:tid, :requestId, :status, :decidedAtDeferred, :rejectionReason) as d'
        const digestParams2 = { tid: tid2, requestId: doc.requestId, status: finalStatus, decidedAtDeferred, rejectionReason: rejectionReasonBind }
        const signingNonce2 = await seedSignedMutation(ctx, authorityId, 'vrg', tid2, digestExpr2, digestParams2, this.resolveSign(signatureOrCallback))

        await ctx.db.exec(
          `update AssociationRequest
           with context SigningNonce = :signingNonce, Tid = ${tid2}
           set Status = :status, DecidedAt = :decidedAt, RejectionReason = :rejectionReason, SubmittedAt = :submittedAt, ReceivedAt = :receivedAt
           where Id = :requestId`,
          { requestId: doc.requestId, status: finalStatus, decidedAt, rejectionReason: rejectionReasonBind, submittedAt, receivedAt, signingNonce: signingNonce2 }
        )

        if (finalStatus === 'a') {
          await intake.publishDecision({ requestId: doc.requestId, status: 'a', decidedAt })
          associated++
        } else {
          await intake.publishDecision({ requestId: doc.requestId, status: 'r', reason: rejectionReasonBind ?? undefined, decidedAt })
          rejected++
        }
      }

      return { challengesIssued, associated, rejected }
    } catch (err) {
      this.rethrow(err, 'processPendingAssociationRequests')
    }
  }

  /**
   * D-06 — read-only, ordered newest-`submittedAt`-first (id as the tiebreak) so the status screen
   * does not render a shuffling list. SELECT-and-map only: no `insert`/`update`/`delete`/
   * `seedSignedMutation` anywhere in this method or `getAssociationRequest` below.
   */
  async listAssociationRequests (authorityId: string, status?: AssociationRequestStatus): Promise<AssociationRequestRead[]> {
    if (!this.ctx) return []
    const ctx = this.ctx
    const out: AssociationRequestRead[] = []
    try {
      // Reserved bind-name trap: never `:limit`/`:desc`/`:group`/`:order`/`:type` — `:rowStatus`
      // (not `:status`) sidesteps it defensively, mirroring this file's other `row`-prefixed binds.
      const sql = status === undefined
        ? `select Id, AuthorityId, RegistrantId, DeviceKey, ElectionId, Status, ChallengeNonce, SubmittedAt, ReceivedAt, DecidedAt, RejectionReason
             from AssociationRequest where AuthorityId = :rowAuthorityId order by SubmittedAt desc, Id desc`
        : `select Id, AuthorityId, RegistrantId, DeviceKey, ElectionId, Status, ChallengeNonce, SubmittedAt, ReceivedAt, DecidedAt, RejectionReason
             from AssociationRequest where AuthorityId = :rowAuthorityId and Status = :rowStatus order by SubmittedAt desc, Id desc`
      const params: Record<string, string> = status === undefined
        ? { rowAuthorityId: authorityId }
        : { rowAuthorityId: authorityId, rowStatus: status }
      for await (const row of ctx.db.eval(sql, params)) {
        out.push(this.mapAssociationRequestRow(row))
      }
      return out
    } catch (err) {
      this.rethrow(err, 'listAssociationRequests')
    }
  }

  /** D-06 — the single-row counterpart of `listAssociationRequests`. Returns `undefined` for an
   * unknown id rather than throwing, so the read-only screen's fail-conservative resolver has a
   * value to render. */
  async getAssociationRequest (requestId: string): Promise<AssociationRequestRead | undefined> {
    if (!this.ctx) return undefined
    try {
      const row = await this.ctx.db
        .prepare(
          `select Id, AuthorityId, RegistrantId, DeviceKey, ElectionId, Status, ChallengeNonce, SubmittedAt, ReceivedAt, DecidedAt, RejectionReason
             from AssociationRequest where Id = :id`
        )
        .get({ id: requestId })
      if (!row) return undefined
      return this.mapAssociationRequestRow(row)
    } catch (err) {
      this.rethrow(err, 'getAssociationRequest')
    }
  }

  /** Shared row->`AssociationRequestRead` mapper for both D-06 reads above. */
  private mapAssociationRequestRow (row: Record<string, unknown>): AssociationRequestRead {
    return {
      requestId: asText(row.Id, 'AssociationRequest.Id'),
      authorityId: asText(row.AuthorityId, 'AssociationRequest.AuthorityId'),
      registrantId: asText(row.RegistrantId, 'AssociationRequest.RegistrantId'),
      deviceKey: asText(row.DeviceKey, 'AssociationRequest.DeviceKey'),
      electionId: row.ElectionId == null ? undefined : asText(row.ElectionId, 'AssociationRequest.ElectionId'),
      status: asText(row.Status, 'AssociationRequest.Status') as AssociationRequestStatus,
      challengeNonce: row.ChallengeNonce == null ? undefined : asText(row.ChallengeNonce, 'AssociationRequest.ChallengeNonce'),
      // CR-02/T-42-06: a plain SELECT read-back of a datetime column is Z-stripped; re-stamp it.
      submittedAt: reZuluDatetime(asText(row.SubmittedAt, 'AssociationRequest.SubmittedAt')),
      receivedAt: reZuluDatetime(asText(row.ReceivedAt, 'AssociationRequest.ReceivedAt')),
      decidedAt: row.DecidedAt == null ? undefined : reZuluDatetime(asText(row.DecidedAt, 'AssociationRequest.DecidedAt')),
      rejectionReason: row.RejectionReason == null ? undefined : asText(row.RejectionReason, 'AssociationRequest.RejectionReason')
    }
  }
}
