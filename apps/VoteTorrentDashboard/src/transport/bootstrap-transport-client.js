/**
 * bootstrap-transport-client.js — the D-13 trust-anchor split and the REST
 * transport factory this dashboard redeems a bearer sign-in code through.
 *
 * THE TWO-HALVES TABLE (50-08-PLAN.md's <the_code_split>, decided by 50-07
 * and cashed in here):
 *
 *   | Half   | Length / alphabet | Destination                                   |
 *   |--------|--------------------|-----------------------------------------------|
 *   | secret | 40 lowercase hex   | IBootstrapTransport.redeem(secret) -- the ONLY |
 *   |        |                    | thing that ever crosses the wire               |
 *   | digest | 43 base64url       | verifySnapshot(envelope, { expectedDigest }) - |
 *   |        |                    | NEVER sent anywhere                            |
 *
 * The envelope-carried `digest` member authenticates NOTHING: whoever
 * controls the payload controls that field too. The expected digest arrives
 * on the officer's phone screen, out-of-band from the endpoint that serves
 * the payload -- that is the entire reason `verifySnapshot` accepts
 * `expectedDigest` as an option instead of trusting the envelope's own
 * `digest` field. THIS MODULE NEVER SENDS THE DIGEST HALF ANYWHERE, and that
 * is load-bearing, not incidental: sending it to the endpoint would collapse
 * the whole mechanism back to self-consistency, and the party being verified
 * would be handed the value it must match.
 *
 * Splitting is input validation, not parsing (ASVS V5): the pasted code is
 * untrusted text that becomes a request body in the REST binding and a path
 * segment in the filesystem binding. It is validated against a pinned
 * pattern BEFORE any transport object is constructed, let alone called.
 */

import { RestBootstrapTransport } from '@votetorrent/vote-engine/bootstrap';

/** 40 lowercase hex characters -- 20 bytes of crypto.getRandomValues output (50-07 contract 8). */
const SECRET_LENGTH = 40;
/** 43 base64url characters -- the envelope's digest verbatim (50-07 contract 8). */
const DIGEST_LENGTH = 43;

const SECRET_PATTERN = new RegExp(`^[0-9a-f]{${SECRET_LENGTH}}$`);
const DIGEST_PATTERN = new RegExp(`^[A-Za-z0-9_-]{${DIGEST_LENGTH}}$`);

/**
 * The single anchored pattern a well-formed pasted code matches as a whole:
 * SECRET_LENGTH lowercase hex, a literal dot, DIGEST_LENGTH base64url.
 * Exported for callers that want a cheap pre-check; `splitSignInCode` does
 * NOT use this directly -- see its own ordered checks below, which report
 * which half and which rule failed instead of one opaque failure.
 * @type {RegExp}
 */
export const SIGNIN_CODE_PATTERN = new RegExp(`^[0-9a-f]{${SECRET_LENGTH}}\\.[A-Za-z0-9_-]{${DIGEST_LENGTH}}$`);

/** A pasted sign-in code failed shape validation. Never carries either half's value. */
export class InvalidSignInCodeError extends Error {
	/** @param {string} message */
	constructor(message) {
		super(message);
		this.name = 'InvalidSignInCodeError';
	}
}

/** The configured transport binding could not complete a redemption. Never carries
 * the secret or any response payload -- the request body carries the BEARER SECRET
 * and the response body is a WHOLE-DATABASE snapshot including registrant PII. */
export class BootstrapTransportUnreachableError extends Error {
	/** @param {string} message */
	constructor(message) {
		super(message);
		this.name = 'BootstrapTransportUnreachableError';
	}
}

/**
 * Split a pasted sign-in code into its two halves.
 *
 * ORDER OF OPERATIONS IS LOAD-BEARING (ASVS V5): coerce to string, trim the
 * ends, reject empty, reject any INTERNAL whitespace, count the dots and
 * reject anything other than exactly one, THEN validate each half against
 * its own pattern, THEN return. No transport object is ever constructed from
 * unvalidated text anywhere in this module -- this function must succeed
 * before `redeemSignInCode` (below) is ever reached.
 *
 * @param {unknown} pasted
 * @returns {{ secret: string, expectedDigest: string }}
 */
export function splitSignInCode(pasted) {
	const raw = typeof pasted === 'string' ? pasted : String(pasted ?? '');
	const trimmed = raw.trim();

	if (trimmed.length === 0) {
		throw new InvalidSignInCodeError('sign-in code must not be empty');
	}
	if (/\s/.test(trimmed)) {
		throw new InvalidSignInCodeError('sign-in code must not contain internal whitespace');
	}

	const parts = trimmed.split('.');
	if (parts.length !== 2) {
		throw new InvalidSignInCodeError(
			`sign-in code must contain exactly one "." separator, found ${parts.length - 1}`,
		);
	}

	const secret = /** @type {string} */ (parts[0]);
	const expectedDigest = /** @type {string} */ (parts[1]);

	if (!SECRET_PATTERN.test(secret)) {
		throw new InvalidSignInCodeError(`secret half must be exactly ${SECRET_LENGTH} lowercase hex characters`);
	}
	if (!DIGEST_PATTERN.test(expectedDigest)) {
		throw new InvalidSignInCodeError(`digest half must be exactly ${DIGEST_LENGTH} base64url characters`);
	}

	return { secret, expectedDigest };
}

/**
 * Construct the REST bootstrap transport binding. `baseUrl` is an EXPLICIT
 * required argument -- this file deliberately never reads `import.meta.env`:
 * it is a tier-1-reachable `.js` module `node --test` imports directly, and
 * `import.meta.env` is `undefined` under plain Node, so a property read on
 * it throws. `src/screens/Bootstrap.tsx` reads the Vite env var and passes
 * the value down here. Do not "simplify" this back to an internal read --
 * that is exactly what would break the tier-1 suite.
 *
 * @param {{ baseUrl: string, headers?: Record<string, string>, timeoutMs?: number }} options
 * @returns {import('@votetorrent/vote-engine/bootstrap').RestBootstrapTransport}
 */
export function createRestBootstrapTransport(options) {
	if (typeof options?.baseUrl !== 'string' || options.baseUrl.length === 0) {
		throw new TypeError('createRestBootstrapTransport: baseUrl is required and must be a non-empty string');
	}
	return new RestBootstrapTransport({
		baseUrl: options.baseUrl,
		headers: options.headers,
		timeoutMs: options.timeoutMs,
	});
}

/**
 * Redeem the SECRET half only through the given transport binding. Returns
 * the transport's `BootstrapRedemptionResult` UNCHANGED for every one of the
 * four statuses -- `expired`, `used` and `unknown` render one copy family
 * downstream but must stay distinguishable in this return value (50-07's
 * handoff). A thrown transport failure becomes `BootstrapTransportUnreachableError`
 * naming only the binding -- never the secret, never any response content.
 *
 * @param {import('@votetorrent/vote-engine/bootstrap').IBootstrapTransport} transport
 * @param {string} secret
 * @returns {Promise<import('@votetorrent/vote-engine/bootstrap').BootstrapRedemptionResult>}
 */
export async function redeemSignInCode(transport, secret) {
	try {
		return await transport.redeem(secret);
	} catch {
		throw new BootstrapTransportUnreachableError(
			'bootstrap-transport-client: the configured transport binding could not complete a redemption',
		);
	}
}
