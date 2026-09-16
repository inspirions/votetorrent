import type { AssociationAttestationAnswer, AssociationRequestInit, Signature } from '@votetorrent/vote-core'
import type { IAssociationRequestTransport, AssociationDecisionNotice } from './association-request-transport.js'
import { assertKnownAssociationStatus } from './association-request-transport.js'
import type {
  IAssociationRequestIntake,
  StagedAssociationRequest,
  StagedAttestation,
  AssociationDecisionDocument,
  RequestDigestFn,
  AttestationDigestFn
} from './filesystem-association-transport.js'

/**
 * p2p-association-transport.ts — the D-08/D-18 peer-cluster authority-protocol transport binding,
 * `IAssociationRequestTransport`'s THIRD implementation (`doc/registration.md:11` — the authority
 * reached in a clustered manner as one or more peers on the Election Network).
 *
 * ============================================================================
 * THIS LEG SHIPS code-complete, unverified.
 * ============================================================================
 * That is the deliverable's label, and it is load-bearing (D-08, and the locked `<blocker>` in
 * `48-CONTEXT.md`, whose framing this phase reuses verbatim). Node results and jest results are
 * NOT verification for this leg and must never be cited as such — this project has a documented
 * history of "implemented but unproven" being read as "done" (Phase 45 closed with four such legs;
 * Phase 41's Node gate was device-REFUTED). P2P-11 was root-caused 2026-08-24 (devices refused as
 * cadre non-members) and remains open; its wall has moved repeatedly across Phases 38 and 41 and
 * again since.
 *
 * **Nothing in this phase depends on this module.** The filesystem binding (51-06), the REST
 * binding (51-06), and the shared conformance suite (51-07) are all already complete and contain
 * no P2P code. If this module were deleted outright, none of that would regress. P2P-11 remains
 * open and is explicitly NOT a dependency of this phase.
 *
 * ============================================================================
 * THE SEAM ARRIVES INJECTED — this module imports NO P2P package.
 * ============================================================================
 * The CadreNode/strand fabric (`@serfab/cadre-core`, `@optimystic/db-p2p`, `libp2p`, ...) is never
 * imported here. Instead this file declares a narrow `AssociationStrandPort` — three methods,
 * `query`/`mutate`/`close` — and the host that CAN actually construct a `CadreNode` and open its
 * strand supplies one via `P2pAssociationTransportOptions.openStrand`. Two reasons, stated plainly:
 *
 *   1. Zero new npm dependency — this module adds nothing to `package.json` or `yarn.lock`.
 *   2. It cannot drag an `@optimystic/*`/`@serfab/*`/`db-p2p`/`libp2p` transitive into the Metro
 *      bundle through this seam — exactly the RN-bundling failure class Phase 44 spent two plans
 *      unsticking (the `@peculiar` device-boot wall), and one jest is structurally blind to (jest
 *      runs on Node, where any such import would resolve fine; the failure only ever surfaces as a
 *      device boot crash).
 *
 * A useful consequence, not a coincidence: this module compiles and type-checks whether or not the
 * P2P stack works at all, which is the only reason this plan is completable while P2P-11 is open.
 * A green `tsc` run here proves shapes line up; it proves nothing about peers reaching a cohort.
 *
 * ============================================================================
 * WIRE SHAPE — reused, not reinvented.
 * ============================================================================
 * `readStagedRequests`/`readStagedAttestations`/`publishDecision` return the exact
 * `StagedAssociationRequest`/`StagedAttestation`/`AssociationDecisionDocument` shapes 51-06's
 * filesystem binding declared (`IAssociationRequestIntake`, imported below, never re-declared) — a
 * third wire shape here would be exactly how bindings drift apart behind a shared interface name.
 * Cursors use the same 16-digit zero-padded decimal-string discipline 51-06 landed, so a stale
 * cursor re-delivers (never loses a row) with the identical string-order semantics across all three
 * bindings.
 *
 * ============================================================================
 * KEY-MATERIAL DISCIPLINE — unchanged from the other two bindings.
 * ============================================================================
 * `submitRequest` and `submitAttestation` each receive either an already-resolved `Signature` or a
 * digest -> `Signature` callback, and never a raw private key (matching
 * `IAssociationRequestTransport`'s own documented security property). A binding that crosses a
 * strand therefore never has key material to leak, exactly like the filesystem and REST bindings.
 *
 * This file makes no claim about scope enforcement anywhere in the authority ceremony this binding
 * eventually feeds.
 */

/** Local restatement of the seam's signature union (not exported by
 * `association-request-transport.ts`, so this module redeclares it — mirrors
 * `filesystem-association-transport.ts`'s own local alias). */
type SignatureOrCallback = Signature | ((digest: Uint8Array) => Promise<Signature>)

/** Same zero-padded cursor width 51-06 landed — plain string comparison is what makes
 * lexicographic ordering identical to numeric ordering across all three bindings. */
const CURSOR_WIDTH = 16

/**
 * The narrow, injected seam a host must supply to construct this transport. Deliberately NOT a
 * `CadreNode` or a strand handle directly — a structural port keeps this module's import graph
 * free of any P2P package (see the module header). `query`/`mutate` accept a SQL-shaped string plus
 * named params; the host's real strand implementation is free to route these however its
 * CadreNode/strand fabric actually executes statements.
 */
export interface AssociationStrandPort {
  query<T>(sql: string, params: Record<string, unknown>): Promise<T[]>
  mutate(sql: string, params: Record<string, unknown>): Promise<void>
  close(): Promise<void>
}

/**
 * `openStrand` is called at most once per transport instance (lazily, on first use, and memoized)
 * — the host that can actually open a strand supplies it; this module never opens one eagerly at
 * construction time, so constructing a `P2pAssociationTransport` never itself touches the P2P
 * fabric. `computeDigest`/`computeAttestationDigest` mirror 51-06's injected-digest discipline
 * exactly (two SEPARATE functions, one per leg, per D-18), so the shared conformance issuer can
 * drive this binding the same way it drives the filesystem one.
 */
export interface P2pAssociationTransportOptions {
  openStrand: () => Promise<AssociationStrandPort>
  computeDigest: RequestDigestFn
  computeAttestationDigest: AttestationDigestFn
  strandId: string
}

interface StagingRow {
  RequestId: string
  InitJson: string
  RequesterKey: string
  SignatureJson: string
  StagedAt: string
  Cursor: string
}

interface AttestationStagingRow {
  RequestId: string
  AnswerJson: string
  RequesterKey: string
  SignatureJson: string
  StagedAt: string
  Cursor: string
}

interface DecisionRow {
  RequestId: string
  Status: string
  ChallengeNonce: string | null
  Reason: string | null
  DecidedAt: string
  Cursor: string
}

const STAGING_SELECT_SQL =
  'select RequestId, InitJson, RequesterKey, SignatureJson, StagedAt, Cursor ' +
  'from AssociationRequestStaging where StrandId = :strandId ' +
  'and (:sinceCursor is null or Cursor > :sinceCursor) order by Cursor asc'

const STAGING_INSERT_SQL =
  'insert into AssociationRequestStaging (StrandId, Cursor, RequestId, InitJson, RequesterKey, SignatureJson, StagedAt) ' +
  'values (:strandId, :cursor, :requestId, :initJson, :requesterKey, :signatureJson, :stagedAt)'

const ATTESTATION_STAGING_SELECT_SQL =
  'select RequestId, AnswerJson, RequesterKey, SignatureJson, StagedAt, Cursor ' +
  'from AssociationAttestationStaging where StrandId = :strandId ' +
  'and (:sinceCursor is null or Cursor > :sinceCursor) order by Cursor asc'

const ATTESTATION_STAGING_INSERT_SQL =
  'insert into AssociationAttestationStaging (StrandId, Cursor, RequestId, AnswerJson, RequesterKey, SignatureJson, StagedAt) ' +
  'values (:strandId, :cursor, :requestId, :answerJson, :requesterKey, :signatureJson, :stagedAt)'

const DECISION_SELECT_SQL =
  'select RequestId, Status, ChallengeNonce, Reason, DecidedAt, Cursor ' +
  'from AssociationDecision where StrandId = :strandId ' +
  'and (:sinceCursor is null or Cursor > :sinceCursor) order by Cursor asc'

const DECISION_INSERT_SQL =
  'insert into AssociationDecision (StrandId, Cursor, RequestId, Status, ChallengeNonce, Reason, DecidedAt) ' +
  'values (:strandId, :cursor, :requestId, :status, :challengeNonce, :reason, :decidedAt)'

/**
 * `P2pAssociationTransport` — the D-08/D-18 peer-cluster binding. See the module header above for
 * the injected-seam discipline, the wire-shape reuse, and the **code-complete, unverified** label
 * this class's every consumer must preserve.
 */
export class P2pAssociationTransport implements IAssociationRequestTransport, IAssociationRequestIntake {
  private readonly openStrandFn: () => Promise<AssociationStrandPort>
  private readonly computeDigest: RequestDigestFn
  private readonly computeAttestationDigest: AttestationDigestFn
  private readonly strandId: string
  private strandPromise: Promise<AssociationStrandPort> | undefined

  constructor (options: P2pAssociationTransportOptions) {
    this.openStrandFn = options.openStrand
    this.computeDigest = options.computeDigest
    this.computeAttestationDigest = options.computeAttestationDigest
    this.strandId = options.strandId
  }

  /** Opens the injected strand at most once per instance, memoized. Constructing this class never
   * itself opens a strand — only the first real call does. */
  private async strand (): Promise<AssociationStrandPort> {
    if (this.strandPromise === undefined) {
      this.strandPromise = this.openStrandFn()
    }
    return await this.strandPromise
  }

  /**
   * Stages a signed association request onto the strand (leg 1). This transport never receives,
   * derives, or persists key material: it holds either a finished `Signature` or a callback
   * (D-01/D-08), never a raw private key.
   *
   * `init.submittedAt` is copied through byte-for-byte, same as every other binding — this module
   * never generates, defaults, or re-formats it, and never falls back to a clock when it is absent.
   */
  async submitRequest (
    init: AssociationRequestInit,
    requesterKey: string,
    signatureOrCallback: SignatureOrCallback
  ): Promise<string> {
    let signature: Signature
    if (typeof signatureOrCallback === 'function') {
      const digest = await this.computeDigest(init, requesterKey)
      signature = await signatureOrCallback(digest)
    } else {
      signature = signatureOrCallback
    }

    const port = await this.strand()
    const cursor = await this.allocateCursor(port, 'staging')
    await port.mutate(STAGING_INSERT_SQL, {
      strandId: this.strandId,
      cursor,
      requestId: init.id,
      initJson: JSON.stringify(init),
      requesterKey,
      signatureJson: JSON.stringify(signature),
      // This binding's own write-time marker — deliberately NOT init.submittedAt (51-06's same
      // StagedAssociationRequestDocument.stagedAt discipline).
      stagedAt: new Date().toISOString()
    })
    return init.id
  }

  /**
   * Stages a signed attestation-answer onto the strand (leg 2, D-18). Not a widened
   * `submitRequest` — a distinct second message with its own digest tuple, written into a THIRD
   * staging table, mirroring the filesystem binding's THIRD subdirectory (`attestations/`).
   */
  async submitAttestation (
    answer: AssociationAttestationAnswer,
    requesterKey: string,
    signatureOrCallback: SignatureOrCallback
  ): Promise<void> {
    let signature: Signature
    if (typeof signatureOrCallback === 'function') {
      const digest = await this.computeAttestationDigest(answer, requesterKey)
      signature = await signatureOrCallback(digest)
    } else {
      signature = signatureOrCallback
    }

    const port = await this.strand()
    const cursor = await this.allocateCursor(port, 'attestation-staging')
    await port.mutate(ATTESTATION_STAGING_INSERT_SQL, {
      strandId: this.strandId,
      cursor,
      requestId: answer.requestId,
      answerJson: JSON.stringify(answer),
      requesterKey,
      signatureJson: JSON.stringify(signature),
      // This binding's own write-time marker. In NO digest.
      stagedAt: new Date().toISOString()
    })
  }

  /**
   * Pull model, matching the seam's own documented reasoning (no inbound listener). Cursors
   * advance monotonically; a stale cursor re-delivers rather than losing a row.
   */
  async pollDecisions (sinceCursor?: string): Promise<AssociationDecisionNotice[]> {
    const port = await this.strand()
    const rows = await port.query<DecisionRow>(DECISION_SELECT_SQL, {
      strandId: this.strandId,
      sinceCursor: sinceCursor ?? null
    })
    return rows.map((row) => ({
      requestId: row.RequestId,
      // WR-10: the seam's shared status guard — same rule, same message, one definition across the
      // bindings (filesystem and REST route through this exact helper too).
      status: assertKnownAssociationStatus(row.Status, 'P2pAssociationTransport.pollDecisions'),
      challengeNonce: row.ChallengeNonce ?? undefined,
      reason: row.Reason ?? undefined,
      cursor: row.Cursor
    }))
  }

  /**
   * The authority-side intake read for leg 1 (`IAssociationRequestIntake`, imported from 51-06's
   * single declaration — not re-declared here). A caller hands each result to
   * `AssociationEngine.submitAssociationRequest(doc.init, doc.requesterKey, doc.signature)`,
   * exactly as the filesystem and REST bindings' own callers do.
   */
  async readStagedRequests (sinceCursor?: string): Promise<StagedAssociationRequest[]> {
    const port = await this.strand()
    const rows = await port.query<StagingRow>(STAGING_SELECT_SQL, {
      strandId: this.strandId,
      sinceCursor: sinceCursor ?? null
    })
    return rows.map((row) => ({
      version: 1,
      requestId: row.RequestId,
      init: JSON.parse(row.InitJson) as AssociationRequestInit,
      requesterKey: row.RequesterKey,
      signature: JSON.parse(row.SignatureJson) as Signature,
      stagedAt: row.StagedAt,
      cursor: row.Cursor
    }))
  }

  /**
   * The authority-side intake read for leg 2 (D-18). Mirrors `readStagedRequests` exactly, reading
   * the attestation staging table instead and parsing the `answer` member instead of `init`.
   */
  async readStagedAttestations (sinceCursor?: string): Promise<StagedAttestation[]> {
    const port = await this.strand()
    const rows = await port.query<AttestationStagingRow>(ATTESTATION_STAGING_SELECT_SQL, {
      strandId: this.strandId,
      sinceCursor: sinceCursor ?? null
    })
    return rows.map((row) => ({
      version: 1,
      requestId: row.RequestId,
      answer: JSON.parse(row.AnswerJson) as AssociationAttestationAnswer,
      requesterKey: row.RequesterKey,
      signature: JSON.parse(row.SignatureJson) as Signature,
      stagedAt: row.StagedAt,
      cursor: row.Cursor
    }))
  }

  /** Publishes a decision outcome (including a `'c'` challenge-issued notice) onto the strand and
   * returns the allocated cursor. */
  async publishDecision (decision: Omit<AssociationDecisionDocument, 'version'>): Promise<string> {
    const port = await this.strand()
    const cursor = await this.allocateCursor(port, 'decision')
    await port.mutate(DECISION_INSERT_SQL, {
      strandId: this.strandId,
      cursor,
      requestId: decision.requestId,
      status: decision.status,
      challengeNonce: decision.challengeNonce ?? null,
      reason: decision.reason ?? null,
      decidedAt: decision.decidedAt
    })
    return cursor
  }

  /** Closes the injected strand port, if one was ever opened. Safe to call on an instance that
   * never made a real call. */
  async close (): Promise<void> {
    if (this.strandPromise !== undefined) {
      const port = await this.strandPromise
      await port.close()
      this.strandPromise = undefined
    }
  }

  /**
   * Same zero-padded cursor discipline 51-06 landed: reads the current rows for the relevant
   * table, takes the lexicographically-greatest `Cursor` (equivalent to numeric-greatest at fixed
   * width), and allocates the next one. Reusing the same SELECT statements
   * `pollDecisions`/`readStagedRequests`/`readStagedAttestations` already use keeps this module's
   * query surface to exactly two statements per table, rather than inventing a fourth "max cursor"
   * query shape for the injected port to support.
   */
  private async allocateCursor (port: AssociationStrandPort, kind: 'staging' | 'attestation-staging' | 'decision'): Promise<string> {
    const rows = kind === 'staging'
      ? await port.query<StagingRow>(STAGING_SELECT_SQL, { strandId: this.strandId, sinceCursor: null })
      : kind === 'attestation-staging'
        ? await port.query<AttestationStagingRow>(ATTESTATION_STAGING_SELECT_SQL, { strandId: this.strandId, sinceCursor: null })
        : await port.query<DecisionRow>(DECISION_SELECT_SQL, { strandId: this.strandId, sinceCursor: null })
    let max = ''
    for (const row of rows) {
      if (row.Cursor > max) max = row.Cursor
    }
    const next = max === '' ? 1 : Number(max) + 1
    return next.toString().padStart(CURSOR_WIDTH, '0')
  }
}
