import type { AttestationVerdict } from '@votetorrent/vote-core';

/**
 * verdicts.ts — the ONE reduction from a registrant's full D-03 verdict list
 * to the single latest verdict per device key.
 *
 * Previously this function existed TWICE, once in `AttestationChallengesSection`
 * and once in `AssociationsSection`, with the same name, the same semantics,
 * different return types (`Record` vs. `Map`) and two doc comments giving
 * different rationales for the same `>=` comparison. Any change to the
 * reduction rule had to be made in both places, and the `Record` copy carried a
 * real (if not currently reachable) correctness bug: `result[verdict.deviceKey]`
 * reads through the prototype chain, so a `deviceKey` of `"toString"` /
 * `"valueOf"` / `"constructor"` resolved `existing` to the inherited `Function`
 * — truthy, with an `undefined` `.sequence`, making the comparison false — and
 * the verdict was NEVER stored, silently degrading the badge to "none". A `Map`
 * has no prototype-chain lookup and no such string is special to it.
 *
 * That matters because this function's whole purpose is "never render a false
 * Pass and never a false Fail": a false Pass is an unearned assurance, a false
 * Fail an unearned accusation, and a silently-dropped verdict produces the
 * "none" badge, which asserts something the caller does not actually know.
 */

/**
 * The latest verdict per `deviceKey`, keyed by max `sequence`.
 *
 * Deliberately does NOT depend on the engine's `deviceKey asc, sequence asc`
 * read ordering (47-08). Folding left-to-right and overwriting each key would
 * be correct under that contract, but reducing by max `sequence` stays correct
 * if a future engine change relaxes the `order by` — at negligible cost, and
 * on this surface an ordering regression would mean showing an officer a Pass
 * that has since been superseded by a Fail.
 *
 * `>=` rather than `>` so that among equal sequences the LAST element wins,
 * matching the read-ordering fold this replaces.
 */
export function latestVerdictByDeviceKey(
	verdicts: readonly AttestationVerdict[]
): Map<string, AttestationVerdict> {
	const result = new Map<string, AttestationVerdict>();
	for (const verdict of verdicts) {
		const existing = result.get(verdict.deviceKey);
		if (!existing || verdict.sequence >= existing.sequence) {
			result.set(verdict.deviceKey, verdict);
		}
	}
	return result;
}
