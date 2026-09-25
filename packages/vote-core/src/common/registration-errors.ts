/**
 * Typed error for the R2/D-04/D-05 registration idempotency guard (Phase 57
 * Plan 02). Mirrors `BuilderAlreadyCommittedError`'s shape verbatim: explicit
 * `readonly` identifying field, explicit `this.name`, and a message that
 * states the recovery — never a raw SQL constraint string.
 */

/**
 * Thrown by `RegistrationEngine.register()` / `createRegistrant()`, and by
 * `SignatureTasksEngine`'s registrant-approval pre-check/finalize guards, when
 * the given `registrantId` already has a `Registrant` row. Registration is a
 * multi-step ceremony (biometric, attestation, association) — the caller must
 * RESUME the ceremony for the existing id, never delete/rotate the existing
 * row and retry, which risks destroying key-bound state.
 *
 * `requestId` is OPTIONAL — the engine-level guard (`register()`/
 * `createRegistrant()`) has no `RegistrationRequest` in scope and omits it;
 * the approval-side guard (`SignatureTasksEngine.resolveAcceptableRegistrant
 * Approval`) does have one and names it, so a caller can tell WHICH pending
 * request was refused. This is still exactly one message shape produced by
 * exactly one class — not two independently-worded errors for the same root
 * condition.
 */
export class RegistrantAlreadyExistsError extends Error {
  readonly registrantId: string
  readonly requestId?: string

  constructor (registrantId: string, requestId?: string) {
    const requestSuffix = requestId ? ` (refused while deciding RegistrationRequest ${requestId})` : ''
    super(`Registrant "${registrantId}" already exists — resume the registration ceremony for this id instead of re-registering it${requestSuffix}`)
    this.name = 'RegistrantAlreadyExistsError'
    this.registrantId = registrantId
    this.requestId = requestId
  }
}
