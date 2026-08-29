import type { ServiceLogger, SweepCounts } from './logging.js'
import type { RendezvousStores } from './store.js'

/**
 * sweeper.ts — the retention-sweep contract.
 *
 * **This file is a declared contract with a deliberately inert stub body.**
 * Plan `52-10` replaces the implementation. No spec written in this plan
 * asserts that `sweepOnce` is still a stub, because `52-10` may not edit those
 * spec files and such an assertion would become false inside a file nobody is
 * allowed to fix. The durable assertion is the *wiring* — that `startService`
 * calls `startSweeper` with the configured window and interval and calls
 * `stop()` on close — and that is what the route spec tests.
 *
 * ## Notes for the implementer
 *
 * **This is net-new.** No sweeper of any kind exists anywhere in this codebase
 * today; expiry is a lazy request-time comparison everywhere it appears.
 *
 * **The retention rule is "ciphertext early, record later".** Drop the
 * ciphertext at `expiresAt` for records that were never redeemed. Keep the
 * payload-free record for `graceWindowMinutes` past `expiresAt` so answers stay
 * `used`/`expired` rather than degrading to the weaker `unknown`. Then drop the
 * record — and its claim marker, which is why `claimsDir` is on the store
 * contract.
 *
 * **Compare canonical datetimes as raw strings.** They sort
 * lexicographically. Never route either side through a date parser. Import
 * `assertCanonicalBootstrapDatetime` from `@votetorrent/vote-engine/bootstrap`
 * rather than adding a fourth copy of the canonical-datetime guard pattern —
 * the source guard in `test/service-skeleton.spec.ts` fails the suite if you
 * do. Note that `@votetorrent/vote-engine` resolves through its `dist/`, so
 * build it before the first import.
 *
 * **Report progress through `logger.sweep(counts)` only.** That signature
 * cannot carry a record identifier, and that is deliberate.
 */

export interface SweepOptions {
	store: RendezvousStores
	graceWindowMinutes: number
	/** Injected canonical "now", 19 characters, no trailing `Z`. Passing it in
	 * is what lets a test drive the sweep without waiting on a wall clock. */
	nowCanonical: string
}

export interface SweeperOptions {
	store: RendezvousStores
	graceWindowMinutes: number
	sweepIntervalSeconds: number
	logger: ServiceLogger
}

export interface SweeperHandle {
	stop(): void
}

/**
 * One pure, directly drivable sweep step.
 *
 * `52-10` may narrow `SweepOptions.store` to the structural subset it actually
 * uses (`claimsDir`, `listRecordIds`, `getRecord`, `getCiphertext`,
 * `deleteCiphertext`, `deleteRecord`). Accepting the full store here is a
 * widening and is compatible with that narrowing — it is not a conflict.
 */
export async function sweepOnce (options: SweepOptions): Promise<SweepCounts> {
	throw new Error('bootstrap-rendezvous-service: sweepOnce is not implemented yet')
}

/**
 * Starts the periodic sweep and returns a handle the service closes on
 * shutdown.
 *
 * The stub **schedules nothing** and its `stop()` is a no-op. It deliberately
 * does not call `sweepOnce`: `startService` calls `startSweeper` during
 * startup, and a rejecting stub reached from there would break every boot until
 * `52-10` lands.
 */
export function startSweeper (options: SweeperOptions): SweeperHandle {
	return {
		stop (): void {
			// No timer was scheduled, so there is nothing to clear.
		}
	}
}
