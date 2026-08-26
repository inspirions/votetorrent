/**
 * officer-swap.js -- D-14: a different officer redeeming a code for a
 * network this browser already holds.
 *
 * THE BEHAVIOUR, STATED EXACTLY (the four-row table):
 *
 *   | Situation                                            | kind                  |
 *   |-------------------------------------------------------|-----------------------|
 *   | envelope's networkHash not in the registry             | new-network           |
 *   | hash held, derived officer EQUALS the entry's officer   | same-officer-refresh  |
 *   | hash held, derived officer DIFFERS                      | officer-swap          |
 *   | envelope's User table does not hold exactly one row     | officer-indeterminate |
 *
 * A different officer's code is a FULL RE-BOOTSTRAP behind a blocking
 * confirmation -- identity and data arrive together; there is no
 * partial-state combination in which one changed and the other did not.
 *
 * THE SEAM DEFECT 50-08 PROPOSED DOES NOT WORK AS WRITTEN. 50-08's handoff
 * suggested intercepting the `already-bootstrapped` outcome and
 * "re-invoking with `replace: true`". That cannot work: the code is
 * SINGLE-USE (D-05), so it is already spent by `redeemAndBootstrap`'s step
 * 2 by the time `already-bootstrapped` is returned, and a second invocation
 * would be refused as `used`. The `already-bootstrapped` result also does
 * not carry the envelope, so the snapshot cannot be recovered from it
 * either. The decision must be made BETWEEN verification (step 3) and
 * deletion (step 4), and the only injection point 50-08 offers there is the
 * `transport` argument -- hence the single-flight decorator below.
 *
 * THE SINGLE-FLIGHT TRANSPORT'S FOUR CONSTRAINTS ARE SECURITY CONSTRAINTS,
 * NOT CONVENIENCES:
 *   - At most ONE entry, keyed by the secret, held in module-local memory
 *     for the duration of one user-initiated attempt.
 *   - NEVER PERSISTED -- the cached value is a whole-database snapshot
 *     including registrant PII; it must not reach `localStorage`,
 *     `sessionStorage`, IndexedDB or any log.
 *   - REFUSALS ARE NEVER CACHED -- `expired`, `used` and `unknown` pass
 *     straight through every time, so the decorator can never turn a
 *     refused code into an accepted one.
 *   - `reset()` on completion, on cancel and on unmount, so a cancelled
 *     swap does not leave a redeemable snapshot in memory across officer
 *     actions.
 *
 * OFFICER DERIVATION HAPPENS ON THE ENVELOPE, NOT ON A DATABASE.
 * `deriveOfficerUserIdFromEnvelope` reads `envelope.tables.User` -- exactly
 * one row yields its `Id` (`votetorrent.qsql:655`, the text primary key);
 * anything else yields `null` and the caller fails closed. This mirrors
 * 50-08's own officer-identity derivation (contract 8) and rests on the
 * same `User.InsertValid` `count(*) = 1` shoe-in (`votetorrent.qsql:672`).
 * IT IS A LIVE CONSTRAINT ON THE MULTI-OFFICER PHASE: when the
 * multi-officer invite ceremony ships, this derivation stops being sound
 * and the code format must start carrying the user id explicitly.
 *
 * WHY THE SWAP MUST CLEAR THE SCREEN, NOT JUST THE DATABASE:
 * `deleteNetworkDb` inside `redeemAndBootstrap`'s step 4 removes the prior
 * officer's rows, but React state does not vacate on its own. The shell
 * (Task 3) must close its handle, drop `grantedScopes` and the active
 * selection, and remount `PanelGrid` under a key derived from
 * `networkHash:officerUserId:bootstrappedAt` so no panel component retains
 * a prior-officer row in local state. There is no server session -- the
 * session IS the browser's own IndexedDB state -- so that remount is part
 * of session termination, not cosmetics.
 */

import { refreshNetwork } from './refresh.js';
import { findNetwork } from '../db/networks-registry.js';

/** The frozen, closed classification set. */
export const SWAP_KINDS = Object.freeze(
	/** @type {const} */ (['new-network', 'same-officer-refresh', 'officer-swap', 'officer-indeterminate']),
);

/** A caller may throw this when a classification of `officer-indeterminate`
 * needs a typed error, e.g. to route to the `snapshot.errorSchemaMismatch*`
 * copy family (contract 8) the same way 50-08's own bootstrap path does.
 * `officer-swap.js` itself never throws this -- `classifyRedemption` always
 * returns a `kind` rather than throwing, so a caller can render a
 * classification without exception-driven control flow. */
export class OfficerIndeterminateError extends Error {
	/** @param {string} networkHash */
	constructor(networkHash) {
		super(`officer-swap: network "${networkHash}"'s envelope does not hold exactly one User row -- officer identity cannot be derived`);
		this.name = 'OfficerIndeterminateError';
		this.networkHash = networkHash;
	}
}

/**
 * @typedef {import('@votetorrent/vote-engine/bootstrap').IBootstrapTransport} IBootstrapTransport
 * @typedef {import('@votetorrent/vote-engine/bootstrap').BootstrapRedemptionResult} BootstrapRedemptionResult
 */

/**
 * @typedef {IBootstrapTransport & { reset(): void }} SingleFlightTransport
 */

/**
 * Wrap an `IBootstrapTransport` so the SAME secret can be redeemed twice --
 * once to classify, once (after confirmation) to actually replace -- while
 * spending the underlying single-use code exactly once.
 *
 * @param {IBootstrapTransport} inner
 * @returns {{ transport: SingleFlightTransport, reset: () => void, innerCallCount: number }}
 */
export function createSingleFlightTransport(inner) {
	/** @type {{ secret: string, result: BootstrapRedemptionResult } | null} */
	let cached = null;
	let innerCallCount = 0;

	function reset() {
		// Clears the ONE entry this decorator ever holds. Called on
		// completion, on cancel and on unmount (Task 3) so a cancelled swap
		// never leaves a redeemable whole-database snapshot sitting in
		// memory across officer actions.
		cached = null;
	}

	/** @type {SingleFlightTransport} */
	const transport = {
		/** @param {string} secret */
		async redeem(secret) {
			if (cached && cached.secret === secret) {
				// Replay -- no second call to `inner`. This is what lets the
				// classify pass and the confirmed replace pass share ONE
				// spent code instead of two.
				return cached.result;
			}
			innerCallCount += 1;
			const result = await inner.redeem(secret);
			if (result.status === 'ok') {
				// Cache ONLY an acceptance. A refusal (`expired`/`used`/`unknown`)
				// must reach the wire again every time -- caching it would let
				// the decorator turn a refused code into an accepted one on
				// the second call, which is exactly the elevation this
				// decorator must never permit.
				cached = { secret, result };
			}
			return result;
		},
		async pullSnapshot() {
			// Phase 50 never pulls (see refresh.js's header). A decorator that
			// silently forwarded this would be a way around that rule, so it
			// throws BY NAME instead.
			throw new Error(
				'createSingleFlightTransport: pullSnapshot must never be called -- Phase 50 has no refreshable session credential',
			);
		},
		reset,
	};

	return {
		transport,
		reset,
		get innerCallCount() {
			return innerCallCount;
		},
	};
}

/**
 * Read `envelope.tables.User` and return the single row's `Id`, or `null`
 * for zero rows, more than one row, or an absent table. NEVER throws on
 * shape -- the caller decides the outcome. Basis: `User.InsertValid`'s
 * `count(*) = 1` shoe-in (`votetorrent.qsql:672`); `User.Id` is the text
 * primary key (`votetorrent.qsql:655`).
 *
 * @param {import('@votetorrent/vote-engine/bootstrap').BootstrapSnapshot} envelope
 * @returns {string | null}
 */
export function deriveOfficerUserIdFromEnvelope(envelope) {
	const rows = envelope?.tables?.User;
	if (!Array.isArray(rows) || rows.length !== 1) return null;
	const id = /** @type {Record<string, unknown>} */ (rows[0]).Id;
	return typeof id === 'string' ? id : null;
}

/**
 * @param {import('@votetorrent/vote-engine/bootstrap').BootstrapSnapshot} envelope
 * @returns {string}
 */
function authorityNameFromEnvelope(envelope) {
	const rows = envelope?.tables?.Authority ?? [];
	const row = /** @type {Record<string, unknown> | undefined} */ (rows[0]);
	return typeof row?.Name === 'string' ? row.Name : '';
}

/**
 * @typedef {object} ClassifyRedemptionResult
 * @property {(typeof SWAP_KINDS)[number]} kind
 * @property {string} networkHash
 * @property {string | null} incomingOfficerUserId
 * @property {string | null} heldOfficerUserId
 * @property {string} authorityName
 */

/**
 * Classify an already-verified envelope against this browser's registry,
 * per the four-row table above.
 *
 * @param {{ envelope: import('@votetorrent/vote-engine/bootstrap').BootstrapSnapshot, storage?: import('../db/networks-registry.js').StorageAdapter }} options
 * @returns {ClassifyRedemptionResult}
 */
export function classifyRedemption({ envelope, storage }) {
	const networkHash = envelope.networkHash;
	const existing = findNetwork(networkHash, storage);
	const incomingOfficerUserId = deriveOfficerUserIdFromEnvelope(envelope);

	// `authorityName` comes from the HELD registry entry when one exists --
	// that is what the swap dialog names -- otherwise from the envelope's
	// own Authority row (there is nothing held yet to prefer).
	const authorityName = existing ? existing.authorityName : authorityNameFromEnvelope(envelope);

	if (incomingOfficerUserId === null) {
		return {
			kind: 'officer-indeterminate',
			networkHash,
			incomingOfficerUserId: null,
			heldOfficerUserId: existing ? existing.officerUserId : null,
			authorityName,
		};
	}

	if (!existing) {
		return {
			kind: 'new-network',
			networkHash,
			incomingOfficerUserId,
			heldOfficerUserId: null,
			authorityName,
		};
	}

	if (existing.officerUserId === incomingOfficerUserId) {
		return {
			kind: 'same-officer-refresh',
			networkHash,
			incomingOfficerUserId,
			heldOfficerUserId: existing.officerUserId,
			authorityName,
		};
	}

	return {
		kind: 'officer-swap',
		networkHash,
		incomingOfficerUserId,
		heldOfficerUserId: existing.officerUserId,
		authorityName,
	};
}

/**
 * @typedef {object} PerformOfficerSwapOptions
 * @property {string} networkHash
 * @property {string} pastedCode
 * @property {SingleFlightTransport} transport - the SAME instance
 *   `classifyRedemption`'s envelope came from.
 * @property {import('../db/networks-registry.js').StorageAdapter} [storage]
 * @property {(phase: string) => void} [onPhase]
 * @property {import('@quereus/quereus').Database} [db] - an already-open handle to this
 *   network, handed over so the replace path's delete closes it first. `forgetNetwork`
 *   already passes its handle this way; this path is the one that did not, and every
 *   confirmed swap failed on `DeleteBlockedError` because of it.
 */

/**
 * The CONFIRMED path: replace this browser's copy and its officer identity
 * together, in one call, replaying the single-flight transport's cached
 * `ok` result so the already-spent code is never redeemed a second time.
 * Confirmation is the CALLER's responsibility -- this function must never
 * be reachable without it.
 *
 * @param {PerformOfficerSwapOptions} options
 * @returns {Promise<import('./bootstrap.js').RedeemAndBootstrapResult>}
 */
export async function performOfficerSwap(options) {
	const { networkHash, pastedCode, transport, storage, onPhase, db: handoverDb } = options;
	try {
		return await refreshNetwork({ networkHash, pastedCode, transport, storage, onPhase, db: handoverDb });
	} finally {
		// Runs on completion AND on a thrown failure -- either way, the
		// cached snapshot must not survive this attempt.
		transport.reset();
	}
}
