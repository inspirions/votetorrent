import { AssociationAssociateBuilder } from './builders/association-associate-builder.js'
import type {
  AssociateInit,
  Association,
  AssociationAttestationAnswer,
  AssociationRequestInit,
  AssociationRequestRead,
  AssociationRequestStatus,
  AttestationChallenge,
  AttestationVerdict,
  AttestationVerification,
  IAssociationAssociateBuilder,
  IAssociationEngine,
  Signature
} from '@votetorrent/vote-core'

type SignatureOrCallback = Signature | ((digest: Uint8Array) => Promise<Signature>)

/** Construction-time knobs for the mock's divergences from the real engine. */
export interface MockAssociationEngineOptions {
  /**
   * Whether `associate()` records a verdict at all — the mock's stand-in for
   * `ElectionAttestationPolicy.AttestationRequired` (47-REVIEW IN-04).
   *
   * The real engine records NO verdict when `AttestationRequired = 0`
   * (`association-engine.ts`), which per Phase 45 D-14a is the common
   * non-attested path and the exact state `VerdictBadge`'s "none" branch
   * exists for. The mock holds no policy store, so it cannot derive this
   * itself; without this knob the "none" state was unreachable from any
   * mock-driven screen test, and a screen test could wrongly conclude the
   * "none" badge was dead code.
   *
   * Defaults to `true` — the pre-existing behaviour, so no existing caller
   * changes.
   */
  attestationRequired?: boolean
}

/**
 * MockAssociationEngine — UI-layer-only, in-memory parity implementation of
 * `IAssociationEngine` (D-01). Mirrors `MockElectionsEngine`'s `Map`-keyed
 * shape (elections/mock-elections-engine.ts) and `MockRegistrationEngine`'s
 * DEBT-02 conventions — no DB, no real signing.
 *
 * Challenges are keyed by `Nonce`; associations are keyed by
 * `${registrantId}:${deviceKey}` — a second `associate()` for the same key
 * throws (mock replay parity, matching the real engine's Association PK
 * collision behavior for D-06 replay).
 *
 * DECLARED DIVERGENCES from the real engine — both about `associate()`'s
 * verdict write, both stated here so no screen test infers a false invariant
 * from a green mock-driven run:
 *   1. The mock holds no `IAttestationVerifier`, so a verdict it records is
 *      always `'pass'`. Fail-path parity is proven against the REAL engine
 *      only.
 *   2. The mock holds no `ElectionAttestationPolicy`, so whether a verdict is
 *      recorded AT ALL comes from `options.attestationRequired` rather than
 *      from the policy row. Pass `{ attestationRequired: false }` to reproduce
 *      the real engine's `AttestationRequired = 0` path — association written,
 *      no verdict row — which is `VerdictBadge`'s "none" state.
 */
export class MockAssociationEngine implements IAssociationEngine {
  private readonly challenges = new Map<string, AttestationChallenge>()
  private readonly associations = new Map<string, Association>()
  /** D-03 in-memory parity — append-only, ordered; an array (not a Map) mirrors the real store's shape. */
  private readonly verdicts: AttestationVerdict[] = []
  private readonly attestationRequired: boolean

  constructor (options?: MockAssociationEngineOptions) {
    this.attestationRequired = options?.attestationRequired ?? true
  }

  async issueAttestationChallenge (
    registrantId: string,
    deviceKey: string,
    expiration: string,
    _signatureOrCallback: SignatureOrCallback,
    electionId?: string
  ): Promise<AttestationChallenge> {
    const nonce = crypto.randomUUID()
    const challenge: AttestationChallenge = {
      nonce,
      authorityId: 'mock-authority',
      registrantId,
      deviceKey,
      electionId,
      expiration
    }
    this.challenges.set(nonce, challenge)
    return challenge
  }

  async removeAttestationChallenge (nonce: string, _signatureOrCallback: SignatureOrCallback): Promise<void> {
    this.challenges.delete(nonce)
  }

  async getAttestationChallenges (registrantId?: string): Promise<AttestationChallenge[]> {
    return [...this.challenges.values()].filter((c) => registrantId === undefined || c.registrantId === registrantId)
  }

  buildAssociate (): IAssociationAssociateBuilder {
    return new AssociationAssociateBuilder(this)
  }

  async associate (init: AssociateInit, signatureOrCallback: SignatureOrCallback): Promise<void> {
    const key = `${init.registrantId}:${init.deviceKey}`
    if (this.associations.has(key)) {
      throw new Error(`MockAssociationEngine.associate: an Association already exists for ${key} (mock replay parity — D-06)`)
    }
    const sig = typeof signatureOrCallback === 'function'
      ? await signatureOrCallback(new Uint8Array())
      : signatureOrCallback
    const challenge = this.challenges.get(init.nonce)
    this.associations.set(key, {
      registrantId: init.registrantId,
      deviceKey: init.deviceKey,
      deviceHash: init.deviceHash,
      attestationCid: `mock-attestation-cid-${key}`,
      expiration: challenge?.expiration ?? new Date(Date.now() + 3_600_000).toISOString(),
      signorKey: sig.signerKey,
      signature: sig.signature
    })
    // The policy gate, standing in for ElectionAttestationPolicy.
    // AttestationRequired (see the class doc's divergence 2): when false, the
    // association is written and NO verdict row is — the real engine's
    // AttestationRequired = 0 path, and VerdictBadge's "none" state.
    if (!this.attestationRequired) return
    // The mock holds no IAttestationVerifier (see recordAttestationVerdict
    // below) and therefore can only ever record a 'pass' verdict here — no
    // screen may infer from the mock that a 'fail' verdict is unreachable.
    // Fail-path parity is proven against the REAL engine only.
    await this.recordAttestationVerdict(init.registrantId, init.deviceKey, { ok: true })
  }

  async getAssociation (registrantId: string, deviceKey: string): Promise<Association | undefined> {
    return this.associations.get(`${registrantId}:${deviceKey}`)
  }

  async getAssociations (registrantId: string): Promise<Association[]> {
    return [...this.associations.values()].filter((a) => a.registrantId === registrantId)
  }

  async removeAssociation (registrantId: string, deviceKey: string, _signatureOrCallback: SignatureOrCallback): Promise<void> {
    this.associations.delete(`${registrantId}:${deviceKey}`)
  }

  /** D-03 mock parity — no signature parameter, matching the real engine's unsigned (D-02) shape. */
  async recordAttestationVerdict (registrantId: string, deviceKey: string, verification: AttestationVerification): Promise<void> {
    const sequence = this.verdicts.filter((v) => v.registrantId === registrantId && v.deviceKey === deviceKey).length
    this.verdicts.push({
      registrantId,
      deviceKey,
      sequence,
      verdict: verification.ok ? 'pass' : 'fail',
      reason: verification.reason,
      verifiedAt: new Date().toISOString()
    })
  }

  /** D-03 mock parity — mutates nothing; returns a sorted copy, never the internal array by reference. */
  async getAttestationVerdicts (registrantId: string, deviceKey?: string): Promise<AttestationVerdict[]> {
    return this.verdicts
      .filter((v) => v.registrantId === registrantId && (deviceKey === undefined || v.deviceKey === deviceKey))
      .sort((a, b) => (a.deviceKey < b.deviceKey ? -1 : a.deviceKey > b.deviceKey ? 1 : a.sequence - b.sequence))
  }

  // ---------- 51-04: stub bodies for the widened IAssociationEngine ----------
  // 51-08/51-09 own mock parity — a half-real mock that silently succeeds here
  // would be worse than one that throws.

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
