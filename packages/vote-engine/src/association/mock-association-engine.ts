import { AssociationAssociateBuilder } from './builders/association-associate-builder.js'
import type {
  AssociateInit,
  Association,
  AttestationChallenge,
  AttestationVerdict,
  AttestationVerification,
  IAssociationAssociateBuilder,
  IAssociationEngine,
  Signature
} from '@votetorrent/vote-core'

type SignatureOrCallback = Signature | ((digest: Uint8Array) => Promise<Signature>)

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
 */
export class MockAssociationEngine implements IAssociationEngine {
  private readonly challenges = new Map<string, AttestationChallenge>()
  private readonly associations = new Map<string, Association>()
  /** D-03 in-memory parity — append-only, ordered; an array (not a Map) mirrors the real store's shape. */
  private readonly verdicts: AttestationVerdict[] = []

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
}
