import type { RegistrationRequestInit, RegistrationRequestStatus, Signature } from '@votetorrent/vote-core'

/**
 * registration-request-transport.ts — the D-01 authority-registration-request
 * transport seam.
 *
 * `authority-transport.ts` (the D-11 producer-to-authority seam this file's
 * shape is modeled on) was written assuming exactly ONE real binding today
 * plus a hypothetical future one — "the shape never changes when the real
 * transport plugs in later." It proved exactly one binding.
 *
 * **D-01 explicitly rejects that "prove one, add more later" framing for
 * this seam.** `IRegistrationRequestTransport` requires **two real bindings
 * from day one** — a filesystem drop-file binding and a pull-based REST
 * binding, both named in `doc/registration.md:12`, both P2P-free, both
 * exercised by **one shared conformance suite with identical assertions**.
 * Two interchangeable bindings are what make this an abstraction rather than
 * a speculative indirection; one binding would prove only that the interface
 * compiles.
 *
 * A **third**, peer-cluster binding exists and is **code-complete, unverified**
 * (D-11). Its conformance branch is reserved-and-skipped: it
 * never counts toward a pass and its failure gates nothing. **Node and jest
 * results are not verification for it** — this project has repeatedly had
 * "implemented but unproven" read as "done."
 *
 * Security property: a transport receives either a completed `Signature` or
 * a digest→`Signature` callback, and **NEVER a raw private key**, matching
 * `IRegistrationEngine`'s own methods exactly. A binding that crosses a
 * process, a filesystem, or a network therefore never has key material to
 * leak (D-01/D-19).
 *
 * This comment makes no claim that the `'vrg'` scope is enforced anywhere in
 * this seam.
 */
type SignatureOrCallback = Signature | ((digest: Uint8Array) => Promise<Signature>)

/**
 * D-06: a notification that a submitted request reached a terminal (or
 * updated) decision state, delivered to a binding via `pollDecisions`.
 * `status` reuses the vote-core `RegistrationRequestStatus` union so a
 * binding cannot invent a fourth status code. `reason` carries the recorded
 * rejection reason on a `'r'` notice (D-06); it is absent on any other
 * status.
 */
export interface RegistrationDecisionNotice {
  requestId: string
  status: RegistrationRequestStatus
  reason?: string
  cursor: string
}

export interface IRegistrationRequestTransport {
  /**
   * Submit a registration request through this binding. The parameter list
   * matches `IRegistrationEngine.submitRegistrationRequest` exactly so a
   * binding can delegate 1:1 with no shape translation (the same 1:1
   * property the analog documents for `submitAssociate`). The bridge case is
   * expressed through `init.issuerType` / `init.bridgeId` rather than a
   * separate transport method — one submit path, one signature discipline,
   * regardless of issuer (D-03).
   *
   * A binding copies `init.submittedAt` through **verbatim and without
   * interpretation**: it is the submitter's own signing-time timestamp and
   * the seventh argument of the digest the engine will verify at INSERT
   * (48-02 **L-3**). A binding that regenerates, normalizes, or re-formats
   * it invalidates the signature it is couriering, and the failure surfaces
   * at INSERT — a layer away from its cause.
   */
  submitRequest(init: RegistrationRequestInit, requesterKey: string, signatureOrCallback: SignatureOrCallback): Promise<string>

  /**
   * Pull model — the authority calls out and polls; it does not host an
   * inbound webhook receiver, because React Native cannot reliably run a
   * persistent background HTTP listener and an inbound port on a NAT'd
   * mobile device is an attack surface with no way to close it. If a genuine
   * push receiver is ever wanted it belongs in a standalone Node service,
   * not the app bundle.
   *
   * `cursor` advances monotonically and a binding must be safe to call with
   * a stale cursor — re-delivery is permitted; loss is not.
   */
  pollDecisions(sinceCursor?: string): Promise<RegistrationDecisionNotice[]>
}
