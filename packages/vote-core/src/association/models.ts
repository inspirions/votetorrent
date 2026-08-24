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
  /** Public key specifically for iOS Secure Enclave */
  secureEnclavePublicKey: string
  /** Optional token from Apple's DeviceCheck API */
  deviceCheckToken?: string
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
