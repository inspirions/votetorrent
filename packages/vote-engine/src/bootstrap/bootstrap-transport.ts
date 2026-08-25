import type { BootstrapSnapshot } from './snapshot-types.js'

/**
 * bootstrap-transport.ts — the D-06 bootstrap-transport seam.
 *
 * **1. Two real bindings from day one.** D-06 follows Phase 48's D-01
 * precedent verbatim, and D-01 explicitly rejects "prove one, add more
 * later" for a transport seam. `IBootstrapTransport` requires two real
 * bindings — a filesystem binding (`filesystem-bootstrap-transport.ts`) and
 * a pull-based REST binding (`rest-bootstrap-transport.ts`), both P2P-free,
 * both exercised by one shared conformance suite whose assertion body is
 * written exactly once and run once per binding. One binding would prove
 * only that the interface compiles.
 *
 * **2. No third slot.** Unlike the D-01 registration seam this file does
 * NOT reserve a peer-cluster entry. D-06 excludes a peer-cluster binding
 * outright, and the standalone receiver service such a binding would need
 * is explicitly not built in this phase ("That service is NOT built in
 * Phase 50"). A later reader must not "restore" a third slot here — none
 * ever existed for this seam.
 *
 * **3. Security property.** The browser holds no key and can never sign
 * (D-04). This transport carries a bearer redemption code, a snapshot
 * envelope, and that envelope's manifest + content digest — NEVER key
 * material. A binding that crosses a filesystem or a network therefore has
 * no key to leak.
 *
 * **4. The trust anchor.** An `https://` origin, a configured bearer
 * header, and a filesystem permission bit authorize NOTHING. The only thing
 * that makes a delivered snapshot trustworthy is 50-02's manifest
 * row-count + content digest + schema-hash verification (`verifySnapshot`),
 * performed by the CONSUMER after this seam returns. A binding that trusted
 * its endpoint instead of the content check would be trusting the network.
 *
 * **5. Couriers do not reject.** Neither binding inspects, repairs,
 * re-serializes, or re-digests a delivered payload. Tampering must remain
 * detectable at the same point, with the same evidence, through either
 * binding; a binding that re-computed the digest over mutated bytes would
 * launder a tampered payload into a verifiable one.
 *
 * **6. No ceremony, no scope claim.** No sentence in this file claims that
 * any scope is enforced here.
 */

/**
 * D-06: the closed redemption-status vocabulary, declared ONCE here — the
 * same discipline `registration-request-transport.ts` records after two of
 * its three bindings coerced an untrusted status instead of checking it.
 *
 * `'schema-mismatch'` is deliberately ABSENT from this union: a schema-hash
 * divergence is detected by 50-02's `verifySnapshot` on the consumer side,
 * not by a courier. Adding a verification-flavoured status here would put
 * verification in the transport and break rule 5 above — couriers do not
 * reject, they only report what the source told them (ok / expired / used /
 * unknown).
 */
export type BootstrapRedemptionStatus = 'ok' | 'expired' | 'used' | 'unknown'

/** The closed set backing `assertKnownBootstrapRedemptionStatus`. Exactly
 * four members; see the type doc comment above for why `'schema-mismatch'`
 * is not a fifth. */
export const KNOWN_BOOTSTRAP_REDEMPTION_STATUS_CODES: ReadonlySet<string> = new Set([
  'ok',
  'expired',
  'used',
  'unknown'
])

/**
 * The single narrowing helper every binding routes an untrusted `status`
 * value through. `where` is a caller-supplied prefix (e.g.
 * `'RestBootstrapTransport.redeem'`) so the thrown error still names the
 * binding that produced it. The message carries the offending status value
 * and NOTHING else — no snapshot body, no filename, no redemption code.
 *
 * This THROWS rather than coercing or skipping: a status outside this set
 * means the producer and this seam disagree about the vocabulary, which
 * will mis-decide every subsequent redemption from the same source, not
 * just the one that surfaced it.
 */
export function assertKnownBootstrapRedemptionStatus (status: unknown, where: string): BootstrapRedemptionStatus {
  if (typeof status !== 'string' || !KNOWN_BOOTSTRAP_REDEMPTION_STATUS_CODES.has(status)) {
    throw new Error(`${where}: redemption result carries a status outside the known vocabulary: ${JSON.stringify(status)}`)
  }
  return status as BootstrapRedemptionStatus
}

/**
 * The 19-character canonical-datetime pattern used throughout this
 * project: `YYYY-MM-DDTHH:MM:SS` with NO trailing `Z`. A `Z` suffix makes
 * every `Digest` mismatch and surfaces as a bare `InsertValid` failure,
 * indistinguishable from a real authorization failure — so this guard
 * rejects it rather than stripping it.
 */
const CANONICAL_DATETIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/

/**
 * Declared locally rather than importing `toCanonicalDatetime` from
 * `../utils.js`: `utils.ts` imports `./database/initialize.js`, which would
 * drag the Quereus database layer into a barrel this plan must keep
 * bundleable by a browser (this seam is part of the `./bootstrap` barrel).
 *
 * All freshness comparisons in this seam and its bindings are RAW STRING
 * comparisons against values validated by this guard — canonical form sorts
 * lexicographically — and must never route through `new Date()` or
 * `Date.parse`, which would treat two textually different but
 * instant-equal strings as identical.
 */
export function assertCanonicalBootstrapDatetime (value: unknown, where: string): string {
  if (typeof value !== 'string' || !CANONICAL_DATETIME_PATTERN.test(value)) {
    throw new Error(`${where}: expected a 19-character canonical datetime with no Z suffix, got: ${JSON.stringify(value)}`)
  }
  return value
}

/**
 * The result of a redemption attempt. `snapshot` is present IF AND ONLY IF
 * `status === 'ok'` — every binding must omit it on a refusal so a caller
 * cannot accidentally consume a partial artifact.
 */
export interface BootstrapRedemptionResult {
  status: BootstrapRedemptionStatus
  snapshot?: BootstrapSnapshot
}

/**
 * D-06: the bootstrap-transport seam. Two methods, both pull-only,
 * mirroring `IRegistrationRequestTransport`'s `submitRequest`/
 * `pollDecisions` shape.
 *
 * **Pull-by-design.** Neither the browser dashboard nor the React Native
 * authority app can listen; nothing here binds a port or hosts a webhook
 * receiver. If a push receiver is ever wanted it belongs in a small
 * standalone Node service (precedent: `packages/p2p-probe-host`), never
 * inside an app bundle. None is added in this phase.
 */
export interface IBootstrapTransport {
  /**
   * Redeem a bearer bootstrap code for one call, returning the resolved
   * artifact.
   *
   * The code is a bearer secret, short-expiry, and SINGLE-USE (D-05): a
   * binding must treat a second redemption of the same code as `'used'`,
   * and the single-use marker must be created ATOMICALLY so two concurrent
   * redemptions can never both observe it absent.
   */
  redeem(code: string): Promise<BootstrapRedemptionResult>

  /**
   * The pull-cursor-shaped refresh path (50-09's manual refresh, D-12),
   * mirroring `pollDecisions`'s contract: safe to call with a stale value,
   * re-delivery is permitted, loss is not. Returns `undefined` when the
   * source has nothing whose `generatedAt` is strictly greater than
   * `sinceGeneratedAt`.
   *
   * This method carries NO session credential: D-05's code is one-shot,
   * and a refreshable session credential is a deferred decision that
   * belongs with the relay service. Its safety therefore rests entirely on
   * the consumer's manifest+digest+schema-hash verification, not on who
   * answered.
   */
  pullSnapshot(sinceGeneratedAt?: string): Promise<BootstrapSnapshot | undefined>
}
