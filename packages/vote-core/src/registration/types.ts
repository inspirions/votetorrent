import type { Signature } from '../common/index.js'
import type { IBuilder } from '../common/builder.js'
import type {
  DisclosedSelective,
  ElectionAttestationPolicy,
  ElectionDisclosurePolicy,
  ElectionRegistrant,
  ElectionRegistrationField,
  RegisterInit,
  Registrant,
  RegistrantAccessEvent,
  RegistrantListFilter,
  RegistrantListPage,
  RegistrantListResult,
  RegistrantPrivate,
  RegistrantPublic,
  RegistrantSelective,
  RegistrantStatus
} from './models.js'

/**
 * D-01/D-19: every mutating method's signing parameter is a `Signature` OR a
 * callback that receives the canonical digest bytes and returns one — NEVER
 * a raw private key. The engine never holds the key (D-01).
 */
type SignatureOrCallback = Signature | ((digest: Uint8Array) => Promise<Signature>)

export interface IRegistrationEngine {
  /** D-02: Register is a builder — multi-field draft + signing + serialization. */
  buildRegister(): IRegistrationRegisterBuilder

  /**
   * Direct register — the Register builder's commit() delegates 1:1 to this
   * method. Drives the multi-row ceremony (Registrant + optional Public/
   * Private/Selective tiers) under one or more 'vrg'-scoped AdminSignatures.
   */
  register(init: RegisterInit, signatureOrCallback: SignatureOrCallback): Promise<void>

  /** Core Registrant row read. */
  getRegistrant(registrantId: string): Promise<Registrant | undefined>

  /** Public tier read. */
  getRegistrantPublic(registrantId: string): Promise<RegistrantPublic | undefined>

  /** Private tier read — authority-side only, never disclosed. */
  getRegistrantPrivate(registrantId: string): Promise<RegistrantPrivate | undefined>

  /** Selective tier read — authority-side, full (undisclosed) record. */
  getRegistrantSelective(registrantId: string): Promise<RegistrantSelective | undefined>

  /**
   * D-14: reveal a per-field subset of a registrant's selective-disclosure
   * set, filtered by `ElectionDisclosurePolicy` for `audience` (or the
   * 'everyone' audience). Returns `null` when the registrant has no
   * `RegistrantSelective` row. The returned `{ disclosed, hidden }` subset
   * independently verifies against `root` via the crypto plugin's
   * `setVerify` — withheld leaves never appear as more than opaque digests.
   */
  getDisclosedSelective(electionId: string, registrantId: string, audience: string): Promise<DisclosedSelective | null>

  /**
   * D-04: the registrant roster read — ONE method, ONE optional filter
   * object (no separate `searchRegistrants`). D-05: keyset paging on the
   * `Registrant.Id` PK; `total` is computed only on a cursor-absent call and
   * cached by the caller for the duration of the scroll. D-06: rows carry
   * the CURRENT `RegistrantPublic` district/name only — never a stale
   * historical row.
   */
  listRegistrants(filter?: RegistrantListFilter, page?: RegistrantListPage): Promise<RegistrantListResult>

  /**
   * D-16: change Status ('a' | 's' | 'r'). Status transitions stay permissive —
   * any 'vrg'-admin-signed change is allowed; the AdminSignature is the control.
   */
  changeStatus(registrantId: string, status: RegistrantStatus, signatureOrCallback: SignatureOrCallback): Promise<void>

  /** D-16: renewal — change Expiration under a fresh 'vrg'-signed mutation. */
  changeExpiration(registrantId: string, expiration: string, signatureOrCallback: SignatureOrCallback): Promise<void>

  /** D-17: authority-only roster enrollment ('vrg'-signed insert). */
  enrollElectionRegistrant(electionId: string, registrantId: string, signatureOrCallback: SignatureOrCallback): Promise<void>

  /** D-17: authority-only roster removal ('vrg'-signed delete). */
  removeElectionRegistrant(electionId: string, registrantId: string, signatureOrCallback: SignatureOrCallback): Promise<void>

  /** Roster read for an election. */
  getElectionRegistrants(electionId: string): Promise<ElectionRegistrant[]>

  /**
   * D-01: record one app-mediated read of a registrant's private tier — the
   * authority-held, append-only accountability/deterrence/regulatory-posture
   * record described on `RegistrantAccessEvent`. It is not a security control:
   * direct local database access bypasses it entirely and writes no row.
   * D-02: deliberately **unsigned** — there is no signature parameter,
   * because `vrg`-signing every read would grow `AdminSignature` with read
   * traffic. `fields` carries attribute NAMES, never values; the engine
   * filters them against the registrant's own `RegistrantPrivate` vocabulary,
   * and a call whose names all fail that filter resolves without writing a
   * row.
   */
  recordRegistrantAccessEvent(registrantId: string, viewerUserId: string, fields: string[]): Promise<void>

  /**
   * D-01: the reviewer read — a write-only trail was explicitly rejected.
   * Returns every `RegistrantAccessEvent` for `registrantId`, newest first
   * (`Sequence` descending), unbounded.
   */
  getRegistrantAccessEvents(registrantId: string): Promise<RegistrantAccessEvent[]>

  /** D-08/D-09/D-10: per-election field policy CRUD ('mel'-signed, election-scoped). */
  addElectionRegistrationField(field: ElectionRegistrationField, signatureOrCallback: SignatureOrCallback): Promise<void>

  removeElectionRegistrationField(electionId: string, fieldName: string, signatureOrCallback: SignatureOrCallback): Promise<void>

  getElectionRegistrationFields(electionId: string): Promise<ElectionRegistrationField[]>

  /**
   * D-14: per-election selective-disclosure policy CRUD ('mel'-signed,
   * election-scoped). Declares which `RegistrantSelective` field names may be
   * disclosed, and to which audience — consumed by `getDisclosedSelective`.
   */
  addElectionDisclosurePolicy(policy: ElectionDisclosurePolicy, signatureOrCallback: SignatureOrCallback): Promise<void>

  removeElectionDisclosurePolicy(electionId: string, fieldName: string, signatureOrCallback: SignatureOrCallback): Promise<void>

  getElectionDisclosurePolicies(electionId: string): Promise<ElectionDisclosurePolicy[]>

  /**
   * D-14b: election policy declaring whether device attestation is required
   * to Associate ('mel'-signed, single row per election). An UPSERT — a
   * second call replaces the stored value rather than erroring/duplicating.
   */
  setElectionAttestationPolicy(electionId: string, attestationRequired: boolean, signatureOrCallback: SignatureOrCallback): Promise<void>

  /** D-14b: read the stored policy; `undefined` when no row exists — MUST NOT synthesize a default. */
  getElectionAttestationPolicy(electionId: string): Promise<ElectionAttestationPolicy | undefined>

  /**
   * D-07: revert-to-default — deletes the `ElectionAttestationPolicy` row so
   * the fail-closed "absent row = attestation REQUIRED" default (owned by the
   * associate() ceremony and, for Phase 46, the UI) applies again.
   */
  removeElectionAttestationPolicy(electionId: string, signatureOrCallback: SignatureOrCallback): Promise<void>
}

export interface IRegistrationRegisterBuilder extends IBuilder<RegisterInit, void> {
  fromPayload(payload: RegisterInit): this
}
