/**
 * election-address.js — the pure, never-throwing URL election-address
 * parser (D-14, ASVS V5). No React, no DOM, no import of anything under
 * `test/`.
 *
 * Four things a later reader cannot infer:
 *
 * 1. `'missing'` is not `'malformed'`. The shipped root URL — the one every
 *    real visitor lands on first — carries no `election` parameter at all,
 *    and that is the page's ordinary, honest state, not a broken one. Only
 *    a parameter that IS present and fails validation is `'malformed'`.
 * 2. A repeated `election` parameter is `'malformed'`, never "first wins".
 *    This page's entire purpose is that its claims can be checked; an
 *    address that could mean two different elections must refuse rather
 *    than silently pick one, because the visitor and the page could
 *    silently disagree about which id "the" address means.
 * 3. `electionId` is `null` in the `'malformed'` case, on purpose. The
 *    offending value is never returned to a caller, so nobody can later
 *    "improve" the not-found message by interpolating the rejected value
 *    back into the page — there is nothing to interpolate.
 * 4. The lifecycle comparison instant this app renders against is
 *    deliberately NOT a URL parameter (see `ElectionShell.tsx`'s `at`
 *    prop). If it were readable from the query string, a link author could
 *    choose which lifecycle phase any visitor is shown — a false claim
 *    about an election's state, on a page whose only value is that its
 *    claims can be checked. That threat is named in this plan's own
 *    threat model as T-53-07-04; naming it here too so a reader of this
 *    file does not have to go looking for why `at` is not parsed alongside
 *    `election`.
 *
 * Validate the DECODED value, never the raw query string — validating
 * before decoding is the classic ASVS V5 bypass (a value that looks benign
 * percent-encoded can decode into something the pattern would reject, and
 * the reverse: a value that looks like it fails could decode into
 * something that passes). `URLSearchParams` performs WHATWG percent-
 * decoding and `+` → space conversion for us; this module never touches
 * the raw string itself.
 *
 * This function must NEVER throw. A public verifiability page that
 * white-screens on a hand-edited URL has failed at exactly the moment
 * someone was checking its work — so `typeof search !== 'string'` is
 * guarded up front, and the parse itself is wrapped so any unexpected
 * `URLSearchParams` behaviour degrades to `'missing'` rather than an
 * uncaught exception.
 */

/** The one URL query parameter this app ever reads (T-53-07-04). @type {string} */
export const ELECTION_ADDRESS_PARAM = 'election';

/**
 * Deliberately looser than the repo's existing 43-character base64url digest
 * idiom (`apps/VoteTorrentDashboard/src/transport/bootstrap-transport-client.js`'s
 * `DIGEST_PATTERN`) — `Election.Id` (`packages/vote-core/schema/votetorrent.qsql:828`)
 * is documented only as a "32 byte random id" with no encoding constraint and
 * no CHECK, so pinning the 43-character base64url form here would reject a
 * real id in Phase 54. This pattern is purely syntactic: 1-128 characters of
 * unreserved URL-safe text, applied to the PERCENT-DECODED value.
 * @type {RegExp}
 */
export const ELECTION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * @typedef {object} ElectionAddress
 * @property {'missing' | 'malformed' | 'ok'} status
 * @property {string | null} electionId
 */

/**
 * Parse a `location.search`-shaped string into an `ElectionAddress`. Never
 * throws. The returned object is frozen.
 *
 * @param {string} search
 * @returns {Readonly<ElectionAddress>}
 */
export function parseElectionAddress(search) {
	if (typeof search !== 'string') {
		return Object.freeze({ status: 'missing', electionId: null });
	}

	try {
		const params = new URLSearchParams(search);
		const values = params.getAll(ELECTION_ADDRESS_PARAM);

		if (values.length === 0) {
			return Object.freeze({ status: 'missing', electionId: null });
		}
		if (values.length > 1) {
			// An ambiguous address on a page whose purpose is verifiability
			// must refuse rather than pick — see header point 2.
			return Object.freeze({ status: 'malformed', electionId: null });
		}

		const decoded = values[0];
		if (decoded === '') {
			return Object.freeze({ status: 'missing', electionId: null });
		}
		if (!ELECTION_ID_PATTERN.test(decoded)) {
			return Object.freeze({ status: 'malformed', electionId: null });
		}

		return Object.freeze({ status: 'ok', electionId: decoded });
	} catch {
		return Object.freeze({ status: 'missing', electionId: null });
	}
}
