/**
 * association-request-transport-conformance.p2p.spec.ts — Phase 51 Plan 07 (D-08/D-18): fills
 * this plan's own reserved-and-skipped peer-cluster conformance slot with a real factory.
 *
 * ============================================================================
 * WHY A SIDECAR, NOT AN EDIT
 * ============================================================================
 * `association-request-transport-conformance.spec.ts` carries committed structural gates —
 * including one asserting that file contains ZERO case-insensitive matches for
 * `p2p-association-transport|CadreNode|strand|optimystic|db-p2p`, and gates asserting its
 * shared-body sentinel region and its test-case counts are undisturbed. This file is a SIDECAR: it
 * imports that file's exported `runAssociationRequestTransportConformance` function and calls it
 * once more, from outside that file, with a real peer-cluster factory. That file is not touched
 * by this plan at all — its structural gates and test-case counts stay byte-unchanged.
 *
 * ============================================================================
 * THE BRANCH STAYS SKIPPED
 * ============================================================================
 * A skipped branch cannot fail a wave, and it cannot pass one either. The peer-cluster leg is
 * **code-complete, unverified** (D-08, mirroring Phase 48 D-11's framing verbatim) — even a future
 * green run of this file is NOT verification for it, because an in-memory strand stand-in
 * exercises the module's SHAPE, not the clustered protocol. Node results and jest results are
 * NOT verification for this leg and must never be cited as such.
 *
 * ============================================================================
 * DECLARED BLIND SPOT
 * ============================================================================
 * What this file could ever prove — even after a real device-attached factory replaces the
 * in-memory stand-in below — is that `P2pAssociationTransport` satisfies the SAME interface with
 * the SAME cursor and digest semantics as the filesystem and REST bindings: that its shapes agree.
 * It can NEVER prove that peers form a cohort, that the authority is reachable in a clustered
 * manner, or that P2P-11 is closed. Those are device/host proofs this suite does not attempt and
 * cannot substitute for. **This phase has NO dependency on P2P-11** — the filesystem binding
 * (51-06), the REST binding (51-06), and the shared conformance suite (51-07 Task 2) are already
 * complete and contain no P2P code; if this sidecar and the module it exercises were both deleted
 * outright, none of that would regress. P2P-11 was root-caused 2026-08-24 (devices refused as
 * cadre non-members, `fretCohort=1 connected=0`) and remains open, with its wall having moved
 * repeatedly across Phases 38 and 41 and again since.
 */

import { runAssociationRequestTransportConformance } from './association-request-transport-conformance.spec.js'
import { P2pAssociationTransport } from '../src/association/transport/p2p-association-transport.js'
import type { AssociationStrandPort } from '../src/association/transport/p2p-association-transport.js'

// ---------------------------------------------------------------------------
// Types derived structurally from the exported function's own signature — the conformance spec
// exports only `runAssociationRequestTransportConformance`, not `ConformanceCase`/
// `ConformanceBinding` by name, so this sidecar extracts them via TypeScript utility types rather
// than re-declaring anything (which would risk the two branches drifting apart, exactly what
// D-08's one-suite requirement exists to prevent).
// ---------------------------------------------------------------------------
type ConformanceCase = Parameters<typeof runAssociationRequestTransportConformance>[0]
type ConformanceBindingFactory = ConformanceCase['make']
type DigestIssuer = Parameters<ConformanceBindingFactory>[0]
type ConformanceBinding = Awaited<ReturnType<ConformanceBindingFactory>>

// ---------------------------------------------------------------------------
// An in-memory AssociationStrandPort stand-in — a real factory constructing a real
// P2pAssociationTransport, over a port that lives entirely in this test's own memory rather than
// a real CadreNode/strand. This is the DECLARED BLIND SPOT above, made concrete: the transport
// module under test is 100% real; the peer-cluster fabric it talks to is not.
// ---------------------------------------------------------------------------
interface InMemoryStagingRow { RequestId: string; InitJson: string; RequesterKey: string; SignatureJson: string; StagedAt: string; Cursor: string }
interface InMemoryAttestationStagingRow { RequestId: string; AnswerJson: string; RequesterKey: string; SignatureJson: string; StagedAt: string; Cursor: string }
interface InMemoryDecisionRow { RequestId: string; Status: string; ChallengeNonce: string | null; Reason: string | null; DecidedAt: string; Cursor: string }

function makeInMemoryPort (): AssociationStrandPort & {
  stagingRows: InMemoryStagingRow[]
  attestationStagingRows: InMemoryAttestationStagingRow[]
  decisionRows: InMemoryDecisionRow[]
} {
  const stagingRows: InMemoryStagingRow[] = []
  const attestationStagingRows: InMemoryAttestationStagingRow[] = []
  const decisionRows: InMemoryDecisionRow[] = []

  return {
    stagingRows,
    attestationStagingRows,
    decisionRows,
    async query<T> (sql: string, params: Record<string, unknown>): Promise<T[]> {
      const since = typeof params.sinceCursor === 'string' ? params.sinceCursor : undefined
      if (sql.includes('AssociationAttestationStaging')) {
        return attestationStagingRows
          .filter((r) => since === undefined || r.Cursor > since)
          .sort((a, b) => (a.Cursor < b.Cursor ? -1 : a.Cursor > b.Cursor ? 1 : 0)) as unknown as T[]
      }
      if (sql.includes('AssociationRequestStaging')) {
        return stagingRows
          .filter((r) => since === undefined || r.Cursor > since)
          .sort((a, b) => (a.Cursor < b.Cursor ? -1 : a.Cursor > b.Cursor ? 1 : 0)) as unknown as T[]
      }
      if (sql.includes('AssociationDecision')) {
        return decisionRows
          .filter((r) => since === undefined || r.Cursor > since)
          .sort((a, b) => (a.Cursor < b.Cursor ? -1 : a.Cursor > b.Cursor ? 1 : 0)) as unknown as T[]
      }
      throw new Error(`makeInMemoryPort.query: unrecognized sql: ${sql}`)
    },
    async mutate (sql: string, params: Record<string, unknown>): Promise<void> {
      if (sql.includes('AssociationAttestationStaging')) {
        attestationStagingRows.push({
          RequestId: params.requestId as string,
          AnswerJson: params.answerJson as string,
          RequesterKey: params.requesterKey as string,
          SignatureJson: params.signatureJson as string,
          StagedAt: params.stagedAt as string,
          Cursor: params.cursor as string
        })
        return
      }
      if (sql.includes('AssociationRequestStaging')) {
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
      if (sql.includes('AssociationDecision')) {
        decisionRows.push({
          RequestId: params.requestId as string,
          Status: params.status as string,
          ChallengeNonce: (params.challengeNonce as string | null | undefined) ?? null,
          Reason: (params.reason as string | null | undefined) ?? null,
          DecidedAt: params.decidedAt as string,
          Cursor: params.cursor as string
        })
        return
      }
      throw new Error(`makeInMemoryPort.mutate: unrecognized sql: ${sql}`)
    },
    async close (): Promise<void> {}
  }
}

/**
 * The real factory filling this plan's reserved slot. Constructs a real `P2pAssociationTransport`
 * over the in-memory stand-in above, driven by the SAME digest issuer the filesystem/rest
 * factories use — this is what lets the shared body run identical assertions against this
 * binding's shape, exactly as it does for the other two.
 */
async function makeP2pBinding (issuer: DigestIssuer): Promise<ConformanceBinding> {
  const port = makeInMemoryPort()
  const transport = new P2pAssociationTransport({
    openStrand: async () => port,
    computeDigest: async (init, requesterKey) => issuer.issueRequest(init, requesterKey).digest,
    computeAttestationDigest: async (answer, requesterKey) => issuer.issueAttestation(answer, requesterKey).digest,
    strandId: 'p2p-conformance-strand'
  })

  return {
    label: 'p2p-binding',
    transport,
    async deliveredRequests () {
      return await transport.readStagedRequests()
    },
    async deliveredAttestations () {
      return await transport.readStagedAttestations()
    },
    async publishDecision (decision: { requestId: string; status: string; challengeNonce?: string; reason?: string }) {
      // decidedAt is this binding's own write-time marker, unrelated to the submitter's
      // submittedAt — same discipline the filesystem/rest factories use.
      return await transport.publishDecision({
        requestId: decision.requestId,
        status: decision.status as Parameters<typeof transport.publishDecision>[0]['status'],
        challengeNonce: decision.challengeNonce,
        reason: decision.reason,
        decidedAt: new Date().toISOString()
      })
    },
    async close () {
      await transport.close()
    }
  }
}

// ---------------------------------------------------------------------------
// The one call — mode stays 'skip'. The shared spec's own binding table already reserves a 'p2p'
// entry (skipped, throwing `make`); this sidecar's call is a SEPARATE, additional invocation of
// the shared body from outside that file, with a real factory but the same 'skip' mode. This is
// not "fixing" that file's skip — that entry is untouched. This is filling THIS plan's own
// reserved slot.
// ---------------------------------------------------------------------------
runAssociationRequestTransportConformance({
  label: 'p2p-binding',
  mode: 'skip',
  make: makeP2pBinding
})
