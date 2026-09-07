/**
 * Typed error for the R2/D-04/D-05 registration idempotency guard (Phase 57
 * Plan 02). Mirrors `BuilderAlreadyCommittedError`'s shape verbatim: explicit
 * `readonly` identifying field, explicit `this.name`, and a message that
 * states the recovery — never a raw SQL constraint string.
 */

/**
 * Thrown by `RegistrationEngine.register()` / `createRegistrant()` when the
 * given `registrantId` already has a `Registrant` row. Registration is a
 * multi-step ceremony (biometric, attestation, association) — the caller
 * must RESUME the ceremony for the existing id, never delete/rotate the
 * existing row and retry, which risks destroying key-bound state.
 */
export class RegistrantAlreadyExistsError extends Error {
  readonly registrantId: string

  constructor (registrantId: string) {
    super(`Registrant "${registrantId}" already exists — resume the registration ceremony for this id instead of re-registering it`)
    this.name = 'RegistrantAlreadyExistsError'
    this.registrantId = registrantId
  }
}
