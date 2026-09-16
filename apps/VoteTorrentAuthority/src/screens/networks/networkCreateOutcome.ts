import type { NetworkReference } from "@votetorrent/vote-core";

/**
 * D-01/D-02/D-03 support module for AddNetworkScreen's `handleCreate`.
 *
 * Why the recents diff and nothing else (hard constraint): `NetworksEngine.create()` mints its
 * hash internally (`crypto.randomUUID()` -> `H16()`) and never exposes it until `commit()`
 * resolves, so there is no hash to probe with. Worse, `NetworksEngine.open()` is NOT
 * side-effect-free on a cache miss — it calls `dbFactory(ref.hash)`, which can run `initDB`, and
 * `rnDbFactory` opens with `createIfMissing: true`, so probing an unknown hash would mint an
 * empty on-disk store under it. `getRecentNetworks()` is a bare
 * `localStorage.getItem('recentNetworks')` — no `Database`, no `dbFactory`, no DDL. Never use
 * `open()` as an existence probe anywhere in this reconciliation path.
 */

/** The reconciliation's own deadline (D-01) — deliberately shorter than CREATE_TIMEOUT_MS
 * (45000): by the time this runs the officer has already waited one full commit budget, and the
 * read it bounds is a single AsyncStorage fetch. Assumption (unmeasured): no measured figure
 * exists for an AsyncStorage read on a saturated JS thread; 10s is a generous multiple of a
 * normal (<50ms) read. */
export const RECONCILE_TIMEOUT_MS = 10_000;

/** Own-property key marking a deadline rejection produced by `createStepTimeoutError`. */
export const NETWORK_CREATE_STEP_TIMEOUT = "networkCreateStepTimeout";

/**
 * Builds an Error carrying `message` verbatim plus an own property keyed
 * `NETWORK_CREATE_STEP_TIMEOUT` whose value is `step`. `Object.assign(new Error(...), {...})`,
 * not an Error subclass — `instanceof` across a subclassed built-in is not reliable under
 * Babel/Hermes, and the existing suite's own idiom for a coded error is
 * `Object.assign(new Error(...), { code: ... })`.
 */
export function createStepTimeoutError(step: string, message: string): Error {
	return Object.assign(new Error(message), { [NETWORK_CREATE_STEP_TIMEOUT]: step });
}

/**
 * Returns the marked step when `err` is a non-null object whose `NETWORK_CREATE_STEP_TIMEOUT`
 * property is a non-empty string; `undefined` for everything else (plain Error, null, a string,
 * a wrong-typed marker).
 */
export function timedOutStep(err: unknown): string | undefined {
	if (typeof err !== "object" || err === null) return undefined;
	const value = (err as Record<string, unknown>)[NETWORK_CREATE_STEP_TIMEOUT];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Returns the last element of `after` whose `hash` is absent from `before` AND whose `name` and
 * `primaryAuthorityDomainName` both equal `expected`'s. Returns `undefined` when nothing matches
 * or when either input is not an array.
 *
 * The name/domain match is what stops an unrelated concurrent recents append from being claimed
 * as ours; `hash` is the only field `create()` mints, so it is the identity key.
 */
export function findLandedNetwork(
	before: NetworkReference[],
	after: NetworkReference[],
	expected: { name: string; primaryAuthorityDomainName: string },
): NetworkReference | undefined {
	if (!Array.isArray(before) || !Array.isArray(after)) return undefined;
	const beforeHashes = new Set(before.map((ref) => ref.hash));
	let match: NetworkReference | undefined;
	for (const ref of after) {
		if (
			!beforeHashes.has(ref.hash) &&
			ref.name === expected.name &&
			ref.primaryAuthorityDomainName === expected.primaryAuthorityDomainName
		) {
			match = ref;
		}
	}
	return match;
}
