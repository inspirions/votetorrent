import type { Timestamp } from '../common/index.js'

/** ********* Association (device <-> registrant binding, admin-signed under 'vrg') ***********/
export interface Association {
  /** references Registrant.id */
  registrantId: string

  /** Public key for voting; private key held in a biometrically secured TPM */
  deviceKey: string

  /** sha256 hash of the device's ID (not the ID itself, for privacy); undefined = device uniqueness not publicly disclosed */
  deviceHash?: string

  /** Content-addressed hash of the authority-held AssociationPrivate (device attestation); undefined = no attestation committed on-network */
  attestationCid?: string

  expiration: Timestamp | string

  /** Public key of the authority signor */
  signorKey: string

  /** Signature of this record by the signor */
  signature: string
}

/**
 * Authority-issued device-attestation challenge (D-03). Before a device can
 * Associate, the authority issues a one-time nonce bound to
 * (RegistrantId, DeviceKey); the device's platform attestation must answer
 * this exact nonce. Short-lived (expiration). One-time use is structural
 * (the Association PK + nonce binding prevent replay) — no cross-row CHECK.
 */
export interface AttestationChallenge {
  /** Random challenge nonce the device must attest against */
  nonce: string

  /** Issuing authority */
  authorityId: string

  /** references Registrant.id */
  registrantId: string

  /** Device voting public key this challenge is bound to */
  deviceKey: string

  /**
   * references Election.id — which election this challenge is for (D-14b,
   * Pitfall 2). OPTIONAL in 45-03: additive, not yet threaded through
   * IAssociationEngine.issueAttestationChallenge or welded into the schema's
   * InsertValid Digest — both land atomically in 45-04. Existing callers that
   * don't set it stay valid.
   */
  electionId?: string

  /** Short TTL */
  expiration: Timestamp | string
}

/**
 * iOS App Attest platform detail (promoted from vote-core/oldsrc/structs/device-attestation.ts).
 * Real cert-chain/statement verification is deferred (D-07 — seam-only this phase).
 */
export interface IOSAttestationDetails {
  type: 'iOS'
  /**
   * The Secure Enclave P-256 VOTING key (`K_vote`), 33-byte compressed SEC1 point, hex-encoded —
   * the same `UserKey.PubKey` form Android registers. This MUST equal the `AttestationChallenge`'s
   * `deviceKey`; `AssociationAssociateBuilder.validateNonceCrossField` enforces it.
   *
   * Note this is NOT the attested key. Apple's App Attest key (`K_att`, identified by
   * `appAttestKeyId`) cannot sign arbitrary payloads — only `generateAssertion` — so it can never
   * be the voting key. The two are bound by `assertion`; see
   * `packages/vote-engine/ATTESTATION-CONTRACT-IOS.md` §0/§3.
   */
  secureEnclavePublicKey: string
  /**
   * Optional token from Apple's DeviceCheck API.
   *
   * UNUSED under integrity bar A (the settled decision): DeviceCheck requires an authority→Apple
   * round trip, which would break D-04's offline verifier posture. Retained so a future switch to
   * bar B is a flag rather than a model change. See ATTESTATION-CONTRACT-IOS.md §9.
   */
  deviceCheckToken?: string

  // ---- App Attest cross-sign (ATTESTATION-CONTRACT-IOS.md §3/§4) ----

  /** App Attest key id — base64 SHA-256 of `K_att`'s public key. Apple's credential identifier. */
  appAttestKeyId: string
  /**
   * Base64 CBOR `{ signature, authenticatorData }` from `DCAppAttestService.generateAssertion` —
   * THE CROSS-SIGN. This is what lets the attested app vouch that `K_vote` is its voting key.
   * Without it `K_vote` is an unattested key and the attestation proves nothing about the thing
   * doing the voting.
   */
  assertion: string
  /**
   * Assertion replay counter, read from the assertion's `authenticatorData`. Must be STRICTLY
   * greater than any counter previously stored for this `appAttestKeyId`; at association time there
   * is no stored value, so it must be >= 1.
   */
  assertionCounter: number
  /**
   * Proof of possession of `K_vote` (§4): a 64-byte compact low-S `r||s` hex signature by `K_vote`
   * itself over `SHA256(utf8(POP_DIGEST))`.
   *
   * REQUIRED, and with no Android counterpart: neither the attestation nor the assertion proves the
   * device holds `K_vote`'s private key — both are signed by `K_att`.
   */
  popSignature: string
  /**
   * The `BOUND_DIGEST` (`Digest(challenge.nonce, challenge.deviceKey)`, base64url) this ceremony
   * answered — iOS's analogue of `AndroidAttestationDetails.nonce`, and what makes the iOS
   * attestation checkable by the builder's cross-field anti-relay validator.
   *
   * The verifier RECOMPUTES this from authority-held values and never trusts the submitted value;
   * it is carried so a mismatch is caught early and legibly rather than as an opaque signature
   * failure.
   */
  boundDigest: string
  /**
   * Which App Attest environment produced the attestation. MUST match the credCert `aaguid`
   * (`appattestdevelop` vs `appattest` + 7 zero bytes) — a `development` attestation must NEVER be
   * accepted by a production authority, and the aaguid is the only thing distinguishing them.
   */
  environment: 'development' | 'production'
}

/**
 * Android Play Integrity / SafetyNet platform detail (promoted from
 * vote-core/oldsrc/structs/device-attestation.ts). Real statement/nonce
 * verification is deferred (D-07 — seam-only this phase).
 */
export interface AndroidAttestationDetails {
  type: 'Android'
  /** Base64-encoded response from Android's SafetyNet/Play Integrity API */
  safetyNetAttestation: string
  /** Public key from Android Keystore */
  keystorePublicKey: string
  /** Nonce used in the attestation request */
  nonce: string
}

/**
 * Device-produced platform attestation answering an AttestationChallenge
 * (D-03/D-04). Promoted from vote-core/oldsrc/structs/device-attestation.ts
 * into a first-class model. The authority stores the sensitive half
 * (deviceId/attestationTime/nonce promoted to columns; the remainder as
 * AssociationPrivate.attestationDetails json) and commits the public
 * Association via AttestationCid.
 */
export interface DeviceAttestation {
  /** Public key of the device */
  publicKey: string

  /** Unique identifier for the device, or the app install in the case of iOS */
  deviceId: string

  location?: { lat: number; lon: number }

  /** Encoded attestation statement from the device */
  attestationStatement?: string

  /** Unix time when attestation was performed */
  attestationTime: number

  /** Array of certificates used in the attestation */
  certificateChain: string[]

  platformDetails?: IOSAttestationDetails | AndroidAttestationDetails
}

/**
 * Authority-held private device-association data (D-04). Referenced by
 * Association.attestationCid; Association.signature commits to this record
 * via that hash. DeviceId, AttestationTime and Nonce are promoted for
 * authority-side uniqueness/replay checks; attestationDetails carries the
 * platform-specific remainder of the DeviceAttestation struct.
 */
export interface AssociationPrivate {
  /** Content-addressed hash of this record */
  cid: string

  /** references Registrant.id */
  registrantId: string

  /** Public voting key of the associated device (links to Association) */
  deviceKey: string

  /** Actual device / app-install id (sensitive; authority-held only) */
  deviceId: string

  /** When the platform attestation was performed */
  attestationTime: Timestamp | string

  /** The AttestationChallenge nonce this attestation answered */
  nonce: string

  /** Remaining DeviceAttestation fields: { location?, attestationStatement?, certificateChain, platformDetails? } */
  attestationDetails?: {
    location?: { lat: number; lon: number }
    attestationStatement?: string
    certificateChain: string[]
    platformDetails?: IOSAttestationDetails | AndroidAttestationDetails
  }

  expiration: Timestamp | string
}

/**
 * Draft payload for the Associate builder (D-02/D-03). Carries the device
 * key + the challenge nonce being answered + the platform-produced
 * DeviceAttestation.
 */
export interface AssociateInit {
  registrantId: string
  deviceKey: string
  deviceHash?: string

  /** The AttestationChallenge nonce this attestation answers */
  nonce: string

  attestation: DeviceAttestation
}

/**
 * D-03: text-code union mirroring the schema's `AttestationVerdictResult`
 * view (`Code` column: 'pass' | 'fail') — the same string-literal-union
 * precedent `RegistrantStatus` (registration/models.ts) uses for a schema
 * text-code column. The schema stores a TEXT code rather than a boolean
 * column because a `boolean default` column hits the quereus 4.x re-attach
 * ALTER-COLUMN coercion class (votetorrent.qsql:1661-1662's documented
 * rationale for this exact table).
 */
export type AttestationVerdictCode = 'pass' | 'fail'

/**
 * D-03: durably persists `IAttestationVerifier.verify()`'s otherwise
 * transient `{ ok, reason }` result. `AssociationPrivate` cannot carry it
 * after the fact: that table is `InsertOnly` and its `Cid` commits to a
 * fixed digest tuple over the device-produced attestation data, so folding
 * an authority-computed judgement into it would conflate the two. Multiple
 * rows accumulate per `(registrantId, deviceKey)` as `sequence` advances,
 * so re-verifications over time are representable. It is a record of a
 * judgement already made — it is not consulted by any code path and does
 * not gate, block, or prevent an association (D-03/T-47-03); the
 * fail-closed control is `associate()`'s own `if (!verification.ok) throw`.
 */
export interface AttestationVerdict {
  /** references Registrant.id */
  registrantId: string

  /** the device's public key, as attested */
  deviceKey: string

  /**
   * Per-(registrantId, deviceKey) monotonic ordering key, ASCENDING — the
   * last element of a `deviceKey`-narrowed read is the most recent verdict.
   */
  sequence: number

  verdict: AttestationVerdictCode

  /** The verifier's transient {reason} string, if any; absent on most passes */
  reason?: string

  /**
   * When the authority computed this judgement — NOT
   * AssociationPrivate.attestationTime, which is when the device produced
   * the attestation.
   */
  verifiedAt: Timestamp | string
}

/** ********* Association Request protocol (Phase 51) ***********/

/**
 * AssociationRequestStatus(Code) — Pending / Challenge issued / Associated /
 * Rejected, mirrors `view AssociationRequestStatus` (51-01).
 *
 * `'c'` (challenge issued) has NO `RegistrationRequestStatus` counterpart:
 * association is not single-round-trip like registration. The authority
 * must hand the device a nonce BEFORE the device can attest, because the
 * nonce is bound INTO the attestation itself — `expectedNonce =
 * SHA256(authData||clientDataHash)` on iOS, `attestationChallenge ==
 * Digest(nonce, deviceKey)` on Android (D-18). So a request necessarily
 * passes through an intermediate state between submission and its terminal
 * decision.
 */
export type AssociationRequestStatus = 'p' | 'c' | 'a' | 'r'

/**
 * What a device supplies to submit an association request (D-02/D-18).
 * Deliberately carries NO `userId`, `userKey`, or `IsUserValid` field — a
 * prospective registrant's device has a P-256 device keypair but no `User`
 * row and no officer scope. The row's own requester-key self-signature
 * (`SignatureValid`, `Digest(Id, AuthorityId, RegistrantId, DeviceKey,
 * ElectionId, SubmittedAt)` per 51-01) is the entire authorization gate —
 * this is the `ProposedX` `with context (UserId, UserKey, ..., IsUserValid)`
 * envelope D-02 explicitly rejects.
 *
 * `submittedAt` is **submitter-chosen, required, canonical ISO-Z** (trailing
 * `Z`), and inside the signed digest above. The engine neither generates
 * nor rewrites it — an engine-generated value would make the signer's own
 * signature unverifiable, since the signer could not have known it at
 * signing time (mirrors `RegistrationRequestInit.submittedAt`'s documented
 * rule verbatim).
 *
 * Field order matches the `SignatureValid` digest argument order exactly:
 * `id, authorityId, registrantId, deviceKey, electionId?, submittedAt`.
 */
export interface AssociationRequestInit {
  id: string
  authorityId: string
  registrantId: string
  deviceKey: string
  electionId?: string
  submittedAt: string
}

/**
 * D-18: the second voter-to-authority message, submitted once the device
 * has answered the authority-issued challenge. `attestation` reuses the
 * EXISTING `DeviceAttestation` type declared above in this same file — it
 * is NOT re-declared here.
 *
 * This answer maps 1:1 onto the existing `AssociateInit` the unchanged
 * `associate()` already consumes: deliberately, `registrantId` and
 * `deviceKey` are NOT carried on this type. They are read from the
 * persisted `AssociationRequest` row (looked up by `requestId`) rather than
 * accepted from the wire, so a second message structurally cannot re-point
 * an answer at a different registrant or device than the one that
 * submitted the original request.
 */
export interface AssociationAttestationAnswer {
  requestId: string
  nonce: string
  attestation: DeviceAttestation
  deviceHash?: string
}

/**
 * Backs the D-06 read-only association-request status screen.
 *
 * `receivedAt` is authority-observed at intake and inside no digest;
 * mirrors `RegistrationRequestRead.receivedAt`'s documented rule — surface
 * it BESIDE `submittedAt` and never substitute one for the other, since a
 * submitter-chosen `submittedAt` may diverge from when the authority
 * actually received the request.
 */
export interface AssociationRequestRead {
  requestId: string
  authorityId: string
  registrantId: string
  deviceKey: string
  electionId?: string
  status: AssociationRequestStatus
  challengeNonce?: string
  submittedAt: string
  receivedAt: string
  decidedAt?: string
  rejectionReason?: string
}
