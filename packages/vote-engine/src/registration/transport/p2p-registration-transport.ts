import type { RegistrationRequestInit, RegistrationRequestStatus, Signature } from '@votetorrent/vote-core'
import type { IRegistrationRequestTransport, RegistrationDecisionNotice } from './registration-request-transport.js'
import type {
  IRegistrationRequestIntake,
  StagedRequest,
  DecisionDocument,
  RequestDigestFn
} from './filesystem-registration-transport.js'

/**
 * p2p-registration-transport.ts — the D-01/D-11 peer-cluster authority-protocol transport binding,
 * `IRegistrationRequestTransport`'s THIRD implementation (`doc/registration.md:11` — the authority
 * reached in a clustered manner as one or more peers on the Election Network).
 *
 * ============================================================================
 * THIS LEG SHIPS code-complete, unverified.
 * ============================================================================
 * That is the deliverable's label, and it is load-bearing (D-11, and the locked `<blocker>` in
 * `48-CONTEXT.md`). Node results and jest results are NOT verification for this leg and must
 * never be cited as such — this project has a documented history of "implemented but unproven"
 * being read as "done" (Phase 45 closed with four such legs; Phase 41's Node gate was
 * device-REFUTED). P2P-11 is device-REFUTED and its wall has moved repeatedly across Phases 38
 * and 41 — and again during this very plan's own Task 1 (a THIRD, brand-new signature observed
 * at execution time). The failure signature this module was written against is therefore dated,
 * not permanent; see `.planning/phases/48-.../48-P2P-STATUS.md` for the execution-time record —
 * the installed-vs-declared `node_modules` audit and the live wall signature as actually
 * observed, not assumed from any prior snapshot.
 *
 * **Nothing in Phase 48 depends on this module.** The filesystem binding (48-09), the REST
 * binding (48-10), the shared conformance suite (48-13), and the device-demonstrated approval
 * flow (48-22) are all already complete and contain no P2P code. If this module were deleted
 * outright, none of that would regress.
 *
 * ============================================================================
 * THE SEAM ARRIVES INJECTED — this module imports NO P2P package.
 * ============================================================================
 * The CadreNode/strand fabric (`@serfab/cadre-core`, `@optimystic/db-p2p`, `libp2p`, ...) is
 * never imported here. Instead this file declares a narrow `RegistrationStrandPort` — three
 * methods, `query`/`mutate`/`close` — and the host that CAN actually construct a `CadreNode` and
 * open its strand supplies one via `P2pRegistrationTransportOptions.openStrand`. Two reasons,
 * stated plainly:
 *
 *   1. Zero new npm dependency — this module adds nothing to `package.json` or `yarn.lock`.
 *   2. It cannot drag an `@optimystic/*`/`@serfab/*`/`db-p2p`/`libp2p` transitive into the Metro
 *      bundle through this seam — exactly the RN-bundling failure class Phase 44 spent two plans
 *      unsticking (the `@peculiar` device-boot wall), and one jest is structurally blind to
 *      (jest runs on Node, where any such import would resolve fine; the failure only ever
 *      surfaces as a device boot crash).
 *
 * A useful consequence, not a coincidence: this module compiles and type-checks whether or not
 * the P2P stack works at all, which is the only reason this plan is completable while P2P-11 is
 * open. A green `tsc` run here proves shapes line up; it proves nothing about peers reaching a
 * cohort.
 *
 * ============================================================================
 * WIRE SHAPE — reused, not reinvented.
 * ============================================================================
 * `readStagedRequests`/`publishDecision` return the exact `StagedRequest`/`DecisionDocument`
 * shapes 48-09's filesystem binding declared (`IRegistrationRequestIntake`, imported below, never
 * re-declared) — a third wire shape here would be exactly how bindings drift apart behind a
 * shared interface name. Cursors use the same 16-digit zero-padded decimal-string discipline
 * 48-09 landed, so a stale cursor re-delivers (never loses a row) with the identical string-order
 * semantics across all three bindings.
 *
 * ============================================================================
 * KEY-MATERIAL DISCIPLINE — unchanged from the other two bindings.
 * ============================================================================
 * `submitRequest` receives either an already-resolved `Signature` or a digest -> `Signature`
 * callback, and never a raw private key (matching `IRegistrationRequestTransport`'s own
 * documented security property). A binding that crosses a strand therefore never has key
 * material to leak, exactly like the filesystem and REST bindings.
 *
 * This file makes no claim about scope enforcement anywhere in the authority ceremony this
 * binding eventually feeds.
 */

/** Local restatement of the seam's signature union (not exported by
 * `registration-request-transport.ts`, so this module redeclares it — mirrors
 * `filesystem-registration-transport.ts`'s own local alias). */
type SignatureOrCallback = Signature | ((digest: Uint8Array) => Promise<Signature>)

/** Same zero-padded cursor width 48-09 landed (`SEQ_WIDTH`) — plain string comparison is what
 * makes lexicographic ordering identical to numeric ordering across all three bindings. */
const CURSOR_WIDTH = 16

/**
 * The narrow, injected seam a host must supply to construct this transport. Deliberately NOT a
 * `CadreNode` or a strand handle directly — a structural port keeps this module's import graph
 * free of any P2P package (see the module header). `query`/`mutate` accept a SQL-shaped string
 * plus named params; the host's real strand implementation is free to route these however its
 * CadreNode/strand fabric actually executes statements.
 */
export interface RegistrationStrandPort {
  query<T>(sql: string, params: Record<string, unknown>): Promise<T[]>
  mutate(sql: string, params: Record<string, unknown>): Promise<void>
  close(): Promise<void>
}

/**
 * `openStrand` is called at most once per transport instance (lazily, on first use, and memoized)
 * — the host that can actually open a strand supplies it; this module never opens one eagerly at
 * construction time, so constructing a `P2pRegistrationTransport` never itself touches the P2P
 * fabric. `computeDigest` mirrors 48-09's injected-digest discipline exactly, so the shared
 * conformance issuer can drive this binding the same way it drives the filesystem one.
 */
export interface P2pRegistrationTransportOptions {
  openStrand: () => Promise<RegistrationStrandPort>
  computeDigest: RequestDigestFn
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

interface DecisionRow {
  RequestId: string
  Status: string
  Reason: string | null
  DecidedAt: string
  Cursor: string
}

const STAGING_SELECT_SQL =
  'select RequestId, InitJson, RequesterKey, SignatureJson, StagedAt, Cursor ' +
  'from RegistrationRequestStaging where StrandId = :strandId ' +
  'and (:sinceCursor is null or Cursor > :sinceCursor) order by Cursor asc'

const STAGING_INSERT_SQL =
  'insert into RegistrationRequestStaging (StrandId, Cursor, RequestId, InitJson, RequesterKey, SignatureJson, StagedAt) ' +
  'values (:strandId, :cursor, :requestId, :initJson, :requesterKey, :signatureJson, :stagedAt)'

const DECISION_SELECT_SQL =
  'select RequestId, Status, Reason, DecidedAt, Cursor ' +
  'from RegistrationDecision where StrandId = :strandId ' +
  'and (:sinceCursor is null or Cursor > :sinceCursor) order by Cursor asc'

const DECISION_INSERT_SQL =
  'insert into RegistrationDecision (StrandId, Cursor, RequestId, Status, Reason, DecidedAt) ' +
  'values (:strandId, :cursor, :requestId, :status, :reason, :decidedAt)'

/**
 * `P2pRegistrationTransport` — the D-01/D-11 peer-cluster binding. See the module header above
 * for the injected-seam discipline, the wire-shape reuse, and the **code-complete, unverified**
 * label this class's every consumer must preserve.
 */
export class P2pRegistrationTransport implements IRegistrationRequestTransport, IRegistrationRequestIntake {
  private readonly openStrandFn: () => Promise<RegistrationStrandPort>
  private readonly computeDigest: RequestDigestFn
  private readonly strandId: string
  private strandPromise: Promise<RegistrationStrandPort> | undefined

  constructor (options: P2pRegistrationTransportOptions) {
    this.openStrandFn = options.openStrand
    this.computeDigest = options.computeDigest
    this.strandId = options.strandId
  }

  /** Opens the injected strand at most once per instance, memoized. Constructing this class never
   * itself opens a strand — only the first real call does. */
  private async strand (): Promise<RegistrationStrandPort> {
    if (this.strandPromise === undefined) {
      this.strandPromise = this.openStrandFn()
    }
    return await this.strandPromise
  }

  /**
   * Stages a signed registration request onto the strand. The bridge case needs no separate
   * method — expressed entirely through `init.issuerType`/`init.bridgeId`, copied through
   * verbatim (D-03), exactly like the filesystem and REST bindings. This transport never
   * receives, derives, or persists key material: it holds either a finished `Signature` or a
   * callback (D-01), never a raw private key.
   *
   * `init.submittedAt` is copied through byte-for-byte alongside them, same as every other
   * binding — this module never generates, defaults, or re-formats it, and never falls back to a
   * clock when it is absent.
   */
  async submitRequest (
    init: RegistrationRequestInit,
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
      // This binding's own write-time marker — deliberately NOT init.submittedAt (48-09's same
      // StagedRequestDocument.stagedAt discipline).
      stagedAt: new Date().toISOString()
    })
    return init.id
  }

  /**
   * Pull model, matching the seam's own documented reasoning (no inbound listener). Cursors
   * advance monotonically; a stale cursor re-delivers rather than losing a row.
   */
  async pollDecisions (sinceCursor?: string): Promise<RegistrationDecisionNotice[]> {
    const port = await this.strand()
    const rows = await port.query<DecisionRow>(DECISION_SELECT_SQL, {
      strandId: this.strandId,
      sinceCursor: sinceCursor ?? null
    })
    return rows.map((row) => ({
      requestId: row.RequestId,
      status: row.Status as RegistrationRequestStatus,
      reason: row.Reason ?? undefined,
      cursor: row.Cursor
    }))
  }

  /**
   * The authority-side intake read (`IRegistrationRequestIntake`, imported from 48-09's single
   * declaration — not re-declared here). A caller hands each result to
   * `RegistrationEngine.submitRegistrationRequest(doc.init, doc.requesterKey, doc.signature)`,
   * exactly as the filesystem and REST bindings' own callers do.
   */
  async readStagedRequests (sinceCursor?: string): Promise<StagedRequest[]> {
    const port = await this.strand()
    const rows = await port.query<StagingRow>(STAGING_SELECT_SQL, {
      strandId: this.strandId,
      sinceCursor: sinceCursor ?? null
    })
    return rows.map((row) => ({
      version: 1,
      requestId: row.RequestId,
      init: JSON.parse(row.InitJson) as RegistrationRequestInit,
      requesterKey: row.RequesterKey,
      signature: JSON.parse(row.SignatureJson) as Signature,
      stagedAt: row.StagedAt,
      cursor: row.Cursor
    }))
  }

  /** Publishes a decision outcome onto the strand and returns the allocated cursor. */
  async publishDecision (decision: Omit<DecisionDocument, 'version'>): Promise<string> {
    const port = await this.strand()
    const cursor = await this.allocateCursor(port, 'decision')
    await port.mutate(DECISION_INSERT_SQL, {
      strandId: this.strandId,
      cursor,
      requestId: decision.requestId,
      status: decision.status,
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
   * Same zero-padded cursor discipline 48-09 landed: reads the current rows for the relevant
   * table, takes the lexicographically-greatest `Cursor` (equivalent to numeric-greatest at fixed
   * width), and allocates the next one. Reusing the same SELECT statements `pollDecisions`/
   * `readStagedRequests` already use keeps this module's query surface to exactly two statements
   * per table, rather than inventing a third "max cursor" query shape for the injected port to
   * support.
   */
  private async allocateCursor (port: RegistrationStrandPort, kind: 'staging' | 'decision'): Promise<string> {
    const rows = kind === 'staging'
      ? await port.query<StagingRow>(STAGING_SELECT_SQL, { strandId: this.strandId, sinceCursor: null })
      : await port.query<DecisionRow>(DECISION_SELECT_SQL, { strandId: this.strandId, sinceCursor: null })
    let max = ''
    for (const row of rows) {
      if (row.Cursor > max) max = row.Cursor
    }
    const next = max === '' ? 1 : Number(max) + 1
    return next.toString().padStart(CURSOR_WIDTH, '0')
  }
}
