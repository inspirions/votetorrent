/**
 * freshness.js -- D-10's display half: how old this browser's copy of a
 * network is, computed from the `bootstrappedAt` instant 50-08 persisted.
 *
 * This module answers *how old this browser's copy is*, and it must NEVER
 * imply liveness -- there is no polling, no subscription and no reactivity
 * in this phase; the age is computed at mount and after each successful
 * swap and does NOT tick, because a ticking clock beside static data reads
 * as a live feed. `@quereus/plugin-indexeddb` ships `CrossTabSync`,
 * unexercised in any spike, as one option a future reactivity spike could
 * consider -- nothing in this module, or anywhere else in this plan, is
 * built on it.
 *
 * THE DATETIME RULE: canonical values are exactly 19 characters, no `Z`.
 * A raw `Date.parse` call, a raw `toISOString()` call and a bare
 * `new Date(...)` construction are all forbidden in this file.
 * `fromCanonicalDatetime` from `@votetorrent/vote-engine/browser` is the
 * ONLY sanctioned conversion -- its internal `Z` append is display-only
 * arithmetic on a value this dashboard did not produce, not a re-derivation
 * of the datetime rule.
 */

import { fromCanonicalDatetime, nowCanonicalDatetime } from '@votetorrent/vote-engine/browser';

/**
 * The single place this number lives. The UI-SPEC states the staleness
 * threshold is an implementation parameter and that copy must read the
 * configured value, never a literal in a component -- this constant is that
 * value, and `formatStaleThreshold` (below) is its only rendering.
 * @type {24}
 */
export const STALE_THRESHOLD_HOURS = 24;

const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60 * MS_PER_SECOND;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
const MS_PER_DAY = 24 * MS_PER_HOUR;

const CANONICAL_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;

/** A value handed to this module was not a canonical 19-character, no-`Z`
 * datetime. Never carries the offending value -- a `bootstrappedAt` field is
 * snapshot-derived and this project's PII-hygiene rule applies to error
 * strings just as much as to the snapshot content itself. */
export class InvalidSnapshotInstantError extends Error {
	/** @param {string} label */
	constructor(label) {
		super(`freshness: "${label}" must be a canonical 19-character datetime with no "Z" suffix`);
		this.name = 'InvalidSnapshotInstantError';
		this.label = label;
	}
}

/**
 * Assert `value` is a canonical instant, throwing `InvalidSnapshotInstantError`
 * naming `label` (never the value) otherwise.
 *
 * @param {unknown} value
 * @param {string} label
 * @returns {asserts value is string}
 */
export function assertCanonicalInstant(value, label) {
	if (typeof value !== 'string' || !CANONICAL_INSTANT_RE.test(value)) {
		throw new InvalidSnapshotInstantError(label);
	}
}

/**
 * How many milliseconds separate `bootstrappedAt` from `atCanonical`,
 * clamped at zero. Device and host clocks drift in this project's own
 * measured experience (see the skill's clock-skew note), so a snapshot
 * instant a few seconds in the future must render as "now", not as a
 * future-tense phrase or a negative number.
 *
 * @param {string} bootstrappedAt
 * @param {string} atCanonical
 * @returns {number}
 */
export function snapshotAgeMillis(bootstrappedAt, atCanonical) {
	assertCanonicalInstant(bootstrappedAt, 'bootstrappedAt');
	assertCanonicalInstant(atCanonical, 'atCanonical');
	const diff = fromCanonicalDatetime(atCanonical) - fromCanonicalDatetime(bootstrappedAt);
	return diff > 0 ? diff : 0;
}

/**
 * Render `ageMillis` as a short relative-time phrase, choosing the largest
 * whole unit for which the floored magnitude is at least one: `day`,
 * `hour`, `minute`, else `second`. The phrase itself comes from the
 * platform's `Intl.RelativeTimeFormat`, not from the copy table -- do not
 * "move it to copy.js"; that would break the frozen table's completeness
 * guarantee (contract 2), since this text is formatted, not authored.
 *
 * @param {number} ageMillis
 * @returns {string}
 */
export function formatSnapshotAge(ageMillis) {
	const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

	if (Math.floor(ageMillis / MS_PER_DAY) >= 1) {
		return rtf.format(-Math.floor(ageMillis / MS_PER_DAY), 'day');
	}
	if (Math.floor(ageMillis / MS_PER_HOUR) >= 1) {
		return rtf.format(-Math.floor(ageMillis / MS_PER_HOUR), 'hour');
	}
	if (Math.floor(ageMillis / MS_PER_MINUTE) >= 1) {
		return rtf.format(-Math.floor(ageMillis / MS_PER_MINUTE), 'minute');
	}
	return rtf.format(-Math.floor(ageMillis / MS_PER_SECOND), 'second');
}

/**
 * Render the configured staleness threshold as a localized duration, e.g.
 * "24 hours". This is the ONLY place a component may learn the threshold's
 * wording -- a numeric literal for the threshold must never appear in a
 * screen.
 *
 * @returns {string}
 */
export function formatStaleThreshold() {
	return new Intl.NumberFormat(undefined, { style: 'unit', unit: 'hour', unitDisplay: 'long' }).format(
		STALE_THRESHOLD_HOURS,
	);
}

/**
 * @param {number} ageMillis
 * @returns {boolean}
 */
export function isSnapshotStale(ageMillis) {
	return ageMillis > STALE_THRESHOLD_HOURS * MS_PER_HOUR;
}

/**
 * @typedef {object} SnapshotFreshness
 * @property {number} ageMillis
 * @property {string} relativeTime
 * @property {string} absolute
 * @property {boolean} stale
 * @property {boolean} skewed
 */

/**
 * The one call a screen needs: everything about how old a snapshot is, and
 * whether it is stale, computed once at mount (or after a successful swap)
 * -- never on a timer.
 *
 * @param {string} bootstrappedAt
 * @param {string} [atCanonical] - defaults to now; a caller supplies this
 *   explicitly only for testing.
 * @returns {SnapshotFreshness}
 */
export function snapshotFreshness(bootstrappedAt, atCanonical = nowCanonicalDatetime()) {
	assertCanonicalInstant(bootstrappedAt, 'bootstrappedAt');
	assertCanonicalInstant(atCanonical, 'atCanonical');

	const skewed = fromCanonicalDatetime(bootstrappedAt) > fromCanonicalDatetime(atCanonical);
	const ageMillis = snapshotAgeMillis(bootstrappedAt, atCanonical);

	return {
		ageMillis,
		relativeTime: formatSnapshotAge(ageMillis),
		// Byte-identical to the value this function was given -- the
		// indicator's tooltip binds the raw canonical timestamp, untouched.
		absolute: bootstrappedAt,
		stale: isSnapshotStale(ageMillis),
		skewed,
	};
}
