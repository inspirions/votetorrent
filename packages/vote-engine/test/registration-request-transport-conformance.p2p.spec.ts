/**
 * registration-request-transport-conformance.p2p.spec.ts — Phase 48 Plan 23 (D-01/D-11): fills
 * 48-13's reserved-and-skipped peer-cluster conformance slot with a real factory.
 *
 * ============================================================================
 * WHY A SIDECAR, NOT AN EDIT
 * ============================================================================
 * 48-13's `registration-request-transport-conformance.spec.ts` carries committed structural
 * gates — including one asserting that file contains ZERO case-insensitive matches for
 * `p2p-registration-transport|CadreNode|strand|optimystic|db-p2p`, and gates asserting its
 * shared-body sentinel region and its `it()` counts are undisturbed. This file is a SIDECAR: it
 * imports 48-13's exported `runRegistrationRequestTransportConformance` function and calls it
 * once more, from outside that file, with a real peer-cluster factory. 48-13's own file is not
 * touched by this plan at all — its structural gates and `it()` counts stay byte-unchanged.
 *
 * ============================================================================
 * THE BRANCH STAYS SKIPPED
 * ============================================================================
 * A skipped branch cannot fail a wave, and it cannot pass one either. The peer-cluster leg is
 * **code-complete, unverified** (D-11) — even a future green run of this file is NOT verification
 * for it, because an in-memory strand stand-in exercises the module's SHAPE, not the clustered
 * protocol. Node results and jest results are not verification for this leg and must never be
 * cited as such.
 *
 * ============================================================================
 * DECLARED BLIND SPOT
 * ============================================================================
 * What this file could ever prove — even after a real device-attached factory replaces the
 * in-memory stand-in below — is that `P2pRegistrationTransport` satisfies the SAME interface with
 * the SAME cursor and digest semantics as the filesystem and REST bindings: that its shapes agree.
 * It can NEVER prove that peers form a cohort, that the authority is reachable in a clustered
 * manner, or that P2P-11 is closed. Those are device/host proofs this suite does not attempt and
 * cannot substitute for — see `.planning/phases/48-.../48-P2P-STATUS.md` for the execution-time
 * record of what the live wall actually looked like when this file was written.
 */

import { runRegistrationRequestTransportConformance } from './registration-request-transport-conformance.spec.js'
import { P2pRegistrationTransport } from '../src/registration/transport/p2p-registration-transport.js'
import type { RegistrationStrandPort } from '../src/registration/transport/p2p-registration-transport.js'
import type { RegistrationRequestStatus } from '@votetorrent/vote-core'

// ---------------------------------------------------------------------------
// Types derived structurally from the exported function's own signature — 48-13 exports only
// `runRegistrationRequestTransportConformance`, not `ConformanceCase`/`ConformanceBinding` by
// name, so this sidecar extracts them via TypeScript utility types rather than re-declaring
// anything (which would risk the two branches drifting apart, exactly what D-01's one-suite
// requirement exists to prevent).
// ---------------------------------------------------------------------------
type ConformanceCase = Parameters<typeof runRegistrationRequestTransportConformance>[0]
type ConformanceBindingFactory = ConformanceCase['make']
type DigestIssuer = Parameters<ConformanceBindingFactory>[0]
type ConformanceBinding = Awaited<ReturnType<ConformanceBindingFactory>>

// ---------------------------------------------------------------------------
// An in-memory RegistrationStrandPort stand-in — a real factory constructing a real
// P2pRegistrationTransport, over a port that lives entirely in this test's own memory rather than
// a real CadreNode/strand. This is the DECLARED BLIND SPOT above, made concrete: the transport
// module under test is 100% real; the "strand" it talks to is not.
// ---------------------------------------------------------------------------
interface InMemoryStagingRow { RequestId: string; InitJson: string; RequesterKey: string; SignatureJson: string; StagedAt: string; Cursor: string }
interface InMemoryDecisionRow { RequestId: string; Status: string; Reason: string | null; DecidedAt: string; Cursor: string }

function makeInMemoryStrandPort (): RegistrationStrandPort & {
  stagingRows: InMemoryStagingRow[]
  decisionRows: InMemoryDecisionRow[]
} {
  const stagingRows: InMemoryStagingRow[] = []
  const decisionRows: InMemoryDecisionRow[] = []

  return {
    stagingRows,
    decisionRows,
    async query<T> (sql: string, params: Record<string, unknown>): Promise<T[]> {
      const since = typeof params.sinceCursor === 'string' ? params.sinceCursor : undefined
      if (sql.includes('RegistrationRequestStaging')) {
        return stagingRows
          .filter((r) => since === undefined || r.Cursor > since)
          .sort((a, b) => (a.Cursor < b.Cursor ? -1 : a.Cursor > b.Cursor ? 1 : 0)) as unknown as T[]
      }
      if (sql.includes('RegistrationDecision')) {
        return decisionRows
          .filter((r) => since === undefined || r.Cursor > since)
          .sort((a, b) => (a.Cursor < b.Cursor ? -1 : a.Cursor > b.Cursor ? 1 : 0)) as unknown as T[]
      }
      throw new Error(`makeInMemoryStrandPort.query: unrecognized sql: ${sql}`)
    },
    async mutate (sql: string, params: Record<string, unknown>): Promise<void> {
      if (sql.includes('RegistrationRequestStaging')) {
        stagingRows.push({
          RequestId: params.requestId as string,
          InitJson: params.initJson as string,
          RequesterKey: params.requesterKey as string,
          SignatureJson: params.signatureJson as string,
          StagedAt: params.stagedAt as string,
          Cursor: params.cursor as string
        })
        return
      }
      if (sql.includes('RegistrationDecision')) {
        decisionRows.push({
          RequestId: params.requestId as string,
          Status: params.status as string,
          Reason: (params.reason as string | null | undefined) ?? null,
          DecidedAt: params.decidedAt as string,
          Cursor: params.cursor as string
        })
        return
      }
      throw new Error(`makeInMemoryStrandPort.mutate: unrecognized sql: ${sql}`)
    },
    async close (): Promise<void> {}
  }
}

/**
 * The real factory filling 48-13's reserved slot. Constructs a real `P2pRegistrationTransport`
 * over the in-memory stand-in above, driven by the SAME digest issuer the filesystem/rest
 * factories use — this is what lets the shared body run identical assertions against this
 * binding's shape, exactly as it does for the other two.
 */
async function makeP2pBinding (issuer: DigestIssuer): Promise<ConformanceBinding> {
  const port = makeInMemoryStrandPort()
  const transport = new P2pRegistrationTransport({
    openStrand: async () => port,
    computeDigest: async (init, requesterKey) => issuer.issue(init, requesterKey).digest,
    strandId: 'p2p-conformance-strand'
  })

  return {
    label: 'p2p-binding',
    transport,
    async deliveredSubmissions () {
      return await transport.readStagedRequests()
    },
    async publishDecision (decision: { requestId: string; status: RegistrationRequestStatus; reason?: string }) {
      // decidedAt is this binding's own write-time marker, unrelated to the submitter's
      // submittedAt — same discipline the filesystem factory uses.
      return await transport.publishDecision({ ...decision, decidedAt: new Date().toISOString() })
    },
    async tamperDeliveredPayload (requestId: string) {
      const row = port.stagingRows.find((r) => r.RequestId === requestId)
      if (row === undefined) {
        throw new Error(`makeP2pBinding.tamperDeliveredPayload: no staged row for ${requestId}`)
      }
      const parsed = JSON.parse(row.InitJson) as { payload: Record<string, unknown> }
      parsed.payload = { ...parsed.payload, __tampered: true }
      row.InitJson = JSON.stringify(parsed)
    },
    capturedWireText () {
      return JSON.stringify({ staging: port.stagingRows, decisions: port.decisionRows })
    },
    async close () {
      await transport.close()
    }
  }
}

// ---------------------------------------------------------------------------
// The one call — mode stays 'skip'. 48-13's own binding table already reserves a 'p2p' entry
// (skipped, throwing `make`); this sidecar's call is a SEPARATE, additional invocation of the
// shared body from outside that file, with a real factory but the same 'skip' mode. This is not
// "fixing" 48-13's skip — that entry is untouched. This is filling THIS plan's own reserved slot.
// ---------------------------------------------------------------------------
runRegistrationRequestTransportConformance({
  label: 'p2p-binding',
  mode: 'skip',
  make: makeP2pBinding
})
