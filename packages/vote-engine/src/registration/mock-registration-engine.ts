import { setCommit, setDisclose, randomBytes } from '@optimystic/quereus-plugin-crypto'
import { RegistrationRegisterBuilder } from './builders/registration-register-builder.js'
import { clampPageSize } from './registrant-list-query.js'
import { collectPrivateFieldNames, sanitizeAccessTrailFields } from './access-trail-fields.js'
import type {
  DisclosedSelective,
  ElectionAttestationPolicy,
  ElectionDisclosurePolicy,
  ElectionRegistrant,
  ElectionRegistrationField,
  IRegistrationEngine,
  IRegistrationRegisterBuilder,
  PriorRejection,
  PrivateDetail,
  RegisterInit,
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
  Signature
} from '@votetorrent/vote-core'

type SignatureOrCallback = Signature | ((digest: Uint8Array) => Promise<Signature>)

/**
 * MockRegistrationEngine — UI-layer-only, in-memory parity implementation of
 * `IRegistrationEngine` (D-01). Mirrors `MockElectionsEngine`'s `Map`-keyed
 * shape (elections/mock-elections-engine.ts) — no DB, no real signing.
 * DEBT-02 style: methods this plan doesn't own (lifecycle/roster/policy/
 * selective) throw a clear "not implemented in mock" error rather than
 * silently no-op-ing, mirroring `MockElectionsEngine.seedElectionSigning`.
 */
export class MockRegistrationEngine implements IRegistrationEngine {
  private readonly registrants = new Map<string, Registrant>()
  private readonly registrantPublics = new Map<string, RegistrantPublic>()
  private readonly registrantPrivates = new Map<string, RegistrantPrivate>()
  /** D-11/D-12/D-13: in-memory parity for RegistrantSelective, keyed by registrantId. */
  private readonly registrantSelectives = new Map<string, RegistrantSelective>()
  /**
   * D-01/D-02: in-memory parity for RegistrantAccessEvent, keyed by
   * registrantId. Append-only by construction (never spliced/cleared) — the
   * in-memory form of the schema's `InsertOnly` constraint. `sequence` is
   * derived from array length at append time (see
   * `recordRegistrantAccessEvent`), which is only correct because nothing
   * ever removes an entry; adding a `clear()`-style method later would be a
   * deliberate parity break, not a refactor.
   */
  private readonly registrantAccessEvents = new Map<string, RegistrantAccessEvent[]>()
  /** D-17: authority-only roster — in-memory parity for ElectionRegistrant, keyed by `${electionId}/${registrantId}`. */
  private readonly electionRegistrants = new Map<string, ElectionRegistrant>()
  /** D-08/D-10: in-memory parity for ElectionRegistrationField policy, keyed by `${electionId}/${fieldName}`. */
  private readonly electionRegistrationFields = new Map<string, ElectionRegistrationField>()
  /** D-14: in-memory parity for ElectionDisclosurePolicy, keyed by `${electionId}/${fieldName}`. */
  private readonly electionDisclosurePolicies = new Map<string, ElectionDisclosurePolicy>()
  /** D-14b: in-memory parity for ElectionAttestationPolicy, keyed by `electionId` ALONE (single-row-per-election). */
  private readonly electionAttestationPolicies = new Map<string, ElectionAttestationPolicy>()
  /** 48-07/D-02: in-memory parity for RegistrationRequest, keyed by requestId. Verifies no signature. */
  private readonly registrationRequests = new Map<string, {
    id: string
    authorityId: string
    payload: RegisterInit
    submittedAt: string
    requesterKey: string
    issuerType: string
    bridgeId: string | null
    receivedAt: string
    status: string
  }>()
  /** 48-07/D-03: in-memory parity for the RegistrationBridgeKey registry, keyed by bridge key id. */
  private readonly registrationBridgeKeys = new Map<string, RegistrationBridgeKey>()

  buildRegister (): IRegistrationRegisterBuilder {
    return new RegistrationRegisterBuilder(this)
  }

  async register (init: RegisterInit, signatureOrCallback: SignatureOrCallback): Promise<void> {
    const registrantId = init.registrant.id
    const sig = typeof signatureOrCallback === 'function'
      ? await signatureOrCallback(new Uint8Array())
      : signatureOrCallback

    const publicCid = init.public ? `mock-public-cid-${registrantId}` : undefined
    const privateCid = `mock-private-cid-${registrantId}`

    // D-11/D-12/D-13: mirrors RegistrationEngine's selective branch — ONLY a
    // non-empty selective.details list generates leaves + a Cid (Pitfall 3);
    // salts come from the plugin's own randomBytes (D-13, never an ad-hoc
    // JS RNG); Cid is the plugin's genuine setCommit root (parity with the
    // real engine's SQL cid(set_commit(...)), just JS-computed since the
    // mock has no DB).
    let selectiveLeaves: SelectiveLeaf[] | undefined
    let selectiveCid: string | undefined
    if (init.selective && init.selective.details.length > 0) {
      const seen = new Set<string>()
      for (const field of init.selective.details) {
        if (seen.has(field.name)) {
          throw new Error(`MockRegistrationEngine.register: duplicate selective field name '${field.name}' (D-13)`)
        }
        seen.add(field.name)
      }
      selectiveLeaves = init.selective.details.map((field) => {
        const salt = randomBytes(128) as string
        if (!salt) {
          throw new Error(`MockRegistrationEngine.register: engine could not obtain a non-empty salt for selective field '${field.name}' (D-13)`)
        }
        return { name: field.name, value: field.value, salt }
      })
      selectiveCid = setCommit(selectiveLeaves) as string
    }

    const registrant: Registrant = {
      id: registrantId,
      authorityId: init.registrant.authorityId,
      privateCid,
      publicCid,
      selectiveCid,
      status: 'a',
      expiration: init.registrant.expiration,
      signorKey: sig.signerKey,
      signature: sig.signature
    }
    this.registrants.set(registrantId, registrant)

    if (init.public) {
      this.registrantPublics.set(registrantId, {
        cid: publicCid!,
        registrantId,
        lastName: init.public.lastName,
        firstName: init.public.firstName,
        district: init.public.district,
        extraFields: init.public.extraFields
      })
    }

    this.registrantPrivates.set(registrantId, {
      cid: privateCid,
      registrantId,
      expiration: init.private.expiration,
      privateDetails: init.private.details
    })

    if (selectiveLeaves && selectiveCid) {
      this.registrantSelectives.set(registrantId, {
        cid: selectiveCid,
        registrantId,
        expiration: init.selective!.expiration,
        selectiveDetails: selectiveLeaves
      })
    }
  }

  async getRegistrant (registrantId: string): Promise<Registrant | undefined> {
    return this.registrants.get(registrantId)
  }

  async getRegistrantPublic (registrantId: string): Promise<RegistrantPublic | undefined> {
    return this.registrantPublics.get(registrantId)
  }

  async getRegistrantPrivate (registrantId: string): Promise<RegistrantPrivate | undefined> {
    return this.registrantPrivates.get(registrantId)
  }

  async getRegistrantSelective (registrantId: string): Promise<RegistrantSelective | undefined> {
    return this.registrantSelectives.get(registrantId)
  }

  /**
   * D-01/D-02: mirrors RegistrationEngine.recordRegistrantAccessEvent —
   * accountability/deterrence/regulatory posture only, NOT a security
   * control, and deliberately UNSIGNED (no ceremony). Derives the same
   * names-only allowlist from `RegistrantPrivate.PrivateDetails` via the
   * SAME shared `collectPrivateFieldNames`/`sanitizeAccessTrailFields`
   * functions the real engine uses, so the mock cannot disagree about what
   * may be recorded.
   */
  async recordRegistrantAccessEvent (registrantId: string, viewerUserId: string, fields: string[]): Promise<void> {
    const privateDetails: PrivateDetail[] | undefined = this.registrantPrivates.get(registrantId)?.privateDetails
    const allowedNames = collectPrivateFieldNames(privateDetails)
    const safeFields = sanitizeAccessTrailFields(fields, allowedNames)
    if (safeFields.length === 0) return

    const existing = this.registrantAccessEvents.get(registrantId) ?? []
    // `sequence: existing.length` reproduces the real engine's
    // `coalesce(max(Sequence), -1) + 1` because this array is append-only
    // and never deleted from (see the field's own doc comment).
    existing.push({
      registrantId,
      viewerUserId,
      sequence: existing.length,
      timestamp: new Date().toISOString(),
      fields: safeFields
    })
    this.registrantAccessEvents.set(registrantId, existing)
  }

  /** D-01: mirrors RegistrationEngine.getRegistrantAccessEvents — newest first, a copy (never the stored array by reference). */
  async getRegistrantAccessEvents (registrantId: string): Promise<RegistrantAccessEvent[]> {
    const events = this.registrantAccessEvents.get(registrantId) ?? []
    return [...events].sort((a, b) => b.sequence - a.sequence)
  }

  /** D-14: mirrors RegistrationEngine.getDisclosedSelective using the plugin's own setDisclose (parity). */
  async getDisclosedSelective (electionId: string, registrantId: string, audience: string): Promise<DisclosedSelective | null> {
    const row = this.registrantSelectives.get(registrantId)
    if (!row) return null
    const leaves = row.selectiveDetails ?? []

    const permitted = new Set<string>()
    for (const policy of this.electionDisclosurePolicies.values()) {
      if (policy.electionId === electionId && (policy.audience === audience || policy.audience === 'everyone')) {
        permitted.add(policy.fieldName)
      }
    }

    const { disclosed, hidden } = setDisclose(leaves, [...permitted])
    const disclosedOut: SelectiveLeaf[] = disclosed.map((leaf) => ({
      name: leaf.name,
      value: leaf.value as SelectiveLeaf['value'],
      salt: typeof leaf.salt === 'string' ? leaf.salt : String(leaf.salt)
    }))
    const root = setCommit(leaves) as string

    return { cid: row.cid, root, disclosed: disclosedOut, hidden: [...hidden] }
  }

  /** D-16: permissive — no transition guard, mirrors the real engine's lack of one. */
  async changeStatus (registrantId: string, status: RegistrantStatus, _signatureOrCallback: SignatureOrCallback): Promise<void> {
    const existing = this.registrants.get(registrantId)
    if (!existing) {
      throw new Error(`MockRegistrationEngine.changeStatus: Registrant not found for registrantId=${registrantId}`)
    }
    this.registrants.set(registrantId, { ...existing, status })
  }

  /** D-16: permissive — any Expiration value succeeds (no insert-only future check on update). */
  async changeExpiration (registrantId: string, expiration: string, _signatureOrCallback: SignatureOrCallback): Promise<void> {
    const existing = this.registrants.get(registrantId)
    if (!existing) {
      throw new Error(`MockRegistrationEngine.changeExpiration: Registrant not found for registrantId=${registrantId}`)
    }
    this.registrants.set(registrantId, { ...existing, expiration })
  }

  /** D-17: authority-only roster — in-memory Map set, no signing. */
  async enrollElectionRegistrant (electionId: string, registrantId: string, _signatureOrCallback: SignatureOrCallback): Promise<void> {
    this.electionRegistrants.set(`${electionId}/${registrantId}`, { electionId, registrantId })
  }

  /** D-17: authority-only roster — in-memory Map delete, no signing. */
  async removeElectionRegistrant (electionId: string, registrantId: string, _signatureOrCallback: SignatureOrCallback): Promise<void> {
    this.electionRegistrants.delete(`${electionId}/${registrantId}`)
  }

  /** D-07: mirrors RegistrationEngine.getElectionRegistrants — real enrolled pairs, not always []. */
  async getElectionRegistrants (electionId: string): Promise<ElectionRegistrant[]> {
    return [...this.electionRegistrants.values()].filter((r) => r.electionId === electionId)
  }

  /**
   * D-04/D-07: in-memory parity for `listRegistrants`, applying filter
   * dimensions in the SAME predicate order as the real engine's SQL fragment
   * (`registrant-list-query.ts`). The mock stores one CURRENT public row per
   * registrant, so the D-06 currency question is structurally absent here —
   * that invariant lives entirely in `REGISTRANT_PUBLIC_CURRENCY_JOIN` on the
   * real engine.
   */
  async listRegistrants (filter?: RegistrantListFilter, page?: RegistrantListPage): Promise<RegistrantListResult> {
    let candidates = [...this.registrants.values()]

    if (filter?.authorityId !== undefined) {
      candidates = candidates.filter((r) => r.authorityId === filter.authorityId)
    }
    if (filter?.status !== undefined) {
      candidates = candidates.filter((r) => r.status === filter.status)
    }
    if (filter?.expiringBefore !== undefined) {
      candidates = candidates.filter((r) => String(r.expiration) < filter.expiringBefore!)
    }
    if (filter?.expiringAfter !== undefined) {
      candidates = candidates.filter((r) => String(r.expiration) > filter.expiringAfter!)
    }
    if (filter?.district !== undefined) {
      candidates = candidates.filter((r) => this.registrantPublics.get(r.id)?.district === filter.district)
    }
    if (filter?.electionId !== undefined) {
      candidates = candidates.filter((r) => this.electionRegistrants.has(`${filter.electionId}/${r.id}`))
    }
    if (filter?.name !== undefined) {
      // The ONE mock/real parity assumption in this method: mirrors SQL
      // `like '%q%'` with a case-insensitive substring test. 47-06 confirms
      // Quereus `like`'s actual case behavior against a real DB fixture and
      // reconciles the mock if it differs.
      const q = filter.name.toLowerCase()
      candidates = candidates.filter((r) => {
        const pub = this.registrantPublics.get(r.id)
        return (pub?.lastName ?? '').toLowerCase().includes(q) || (pub?.firstName ?? '').toLowerCase().includes(q)
      })
    }

    // Sort ascending by id with a plain relational comparison — a
    // locale-collation-aware string comparator would diverge from the SQL
    // `order by R.Id asc` text ordering and break keyset parity.
    candidates.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

    const total = page?.cursor === undefined ? candidates.length : undefined

    const cursor = page?.cursor
    const afterCursor = cursor === undefined ? candidates : candidates.filter((r) => r.id > cursor)
    const pageSize = clampPageSize(page?.pageSize)
    const pageRegistrants = afterCursor.slice(0, pageSize)

    const rows: RegistrantListRow[] = pageRegistrants.map((r) => {
      const pub = this.registrantPublics.get(r.id)
      return {
        registrantId: r.id,
        authorityId: r.authorityId,
        status: r.status,
        expiration: String(r.expiration),
        privateCid: r.privateCid,
        publicCid: r.publicCid,
        selectiveCid: r.selectiveCid,
        lastName: pub?.lastName,
        firstName: pub?.firstName,
        district: pub?.district
      }
    })

    const nextCursor = rows.length === pageSize ? rows[rows.length - 1]!.registrantId : undefined

    return { rows, nextCursor, total }
  }

  /** D-08/D-10: policy declaration — in-memory Map add, no signing. */
  async addElectionRegistrationField (field: ElectionRegistrationField, _signatureOrCallback: SignatureOrCallback): Promise<void> {
    this.electionRegistrationFields.set(`${field.electionId}/${field.fieldName}`, field)
  }

  /** D-08/D-10: policy removal — in-memory Map delete, no signing. */
  async removeElectionRegistrationField (electionId: string, fieldName: string, _signatureOrCallback: SignatureOrCallback): Promise<void> {
    this.electionRegistrationFields.delete(`${electionId}/${fieldName}`)
  }

  async getElectionRegistrationFields (electionId: string): Promise<ElectionRegistrationField[]> {
    return [...this.electionRegistrationFields.values()].filter((f) => f.electionId === electionId)
  }

  /** D-14: policy declaration — in-memory Map add, no signing (additive, mirrors addElectionRegistrationField). */
  async addElectionDisclosurePolicy (policy: ElectionDisclosurePolicy, _signatureOrCallback: SignatureOrCallback): Promise<void> {
    this.electionDisclosurePolicies.set(`${policy.electionId}/${policy.fieldName}`, policy)
  }

  /** D-14: policy removal — in-memory Map delete, no signing. */
  async removeElectionDisclosurePolicy (electionId: string, fieldName: string, _signatureOrCallback: SignatureOrCallback): Promise<void> {
    this.electionDisclosurePolicies.delete(`${electionId}/${fieldName}`)
  }

  async getElectionDisclosurePolicies (electionId: string): Promise<ElectionDisclosurePolicy[]> {
    return [...this.electionDisclosurePolicies.values()].filter((p) => p.electionId === electionId)
  }

  /** D-14b: policy declaration — in-memory Map set (upsert), no signing (additive, mirrors addElectionRegistrationField). */
  async setElectionAttestationPolicy (electionId: string, attestationRequired: boolean, _signatureOrCallback: SignatureOrCallback): Promise<void> {
    this.electionAttestationPolicies.set(electionId, { electionId, attestationRequired })
  }

  /** D-14b: returns `undefined` when absent — do NOT synthesize a `true` default (the fail-closed rule is the UI's job). */
  async getElectionAttestationPolicy (electionId: string): Promise<ElectionAttestationPolicy | undefined> {
    return this.electionAttestationPolicies.get(electionId)
  }

  /** D-07: revert-to-default — in-memory Map delete, no signing. */
  async removeElectionAttestationPolicy (electionId: string, _signatureOrCallback: SignatureOrCallback): Promise<void> {
    this.electionAttestationPolicies.delete(electionId)
  }

  // ---------- Registration Request protocol + approval inbox (Phase 48) ----------
  // Throwing stub bodies only — 48-05 declares the contract; 48-07 (intake +
  // bridge registry), 48-08 (read surface + stats), and 48-12 (rejection)
  // replace these with real mock parity implementations. A stub MUST throw
  // and MUST NOT return a plausible empty value.

  /**
   * Mock parity — verifies NO signature, enforces NO CHECK, applies NO skew
   * bound. Exists for navigation/legibility only; a passing screen test here
   * proves an affordance, not a boundary (the same DECLARED BLIND SPOT
   * discipline the app suite already uses). `init.submittedAt` is stored
   * unmodified; `receivedAt` is a mock-stamped observation. Never calls
   * `signatureOrCallback` and never fabricates a `Signature`.
   */
  async submitRegistrationRequest (init: RegistrationRequestInit, requesterKey: string, _signatureOrCallback: SignatureOrCallback): Promise<string> {
    this.registrationRequests.set(init.id, {
      id: init.id,
      authorityId: init.authorityId,
      payload: init.payload,
      submittedAt: init.submittedAt,
      requesterKey,
      issuerType: init.issuerType ?? 'registrant',
      bridgeId: init.bridgeId ?? null,
      receivedAt: new Date().toISOString(),
      status: 'p'
    })
    return init.id
  }

  /** Mock parity — verifies NO signature, enforces NO CHECK. See submitRegistrationRequest's comment. */
  async registerBridgeKey (init: RegistrationBridgeKeyInit, _signatureOrCallback: SignatureOrCallback): Promise<void> {
    this.registrationBridgeKeys.set(init.id, { id: init.id, authorityId: init.authorityId, label: init.label, key: init.key })
  }

  async listBridgeKeys (authorityId: string): Promise<RegistrationBridgeKey[]> {
    return [...this.registrationBridgeKeys.values()].filter((k) => k.authorityId === authorityId)
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
}
