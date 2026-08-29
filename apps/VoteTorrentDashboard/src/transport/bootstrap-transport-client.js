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
 *   |        |                    | half a binding is ever handed                  |
 *   | digest | 43 base64url       | verifySnapshot(envelope, { expectedDigest }) - |
 *   |        |                    | NEVER sent anywhere                            |
 *   | secret | derived, D-04      | lookupId  -> SENT by the REST binding, in place |
 *   | split  |                    | of the secret; contentKey -> NEVER SENT, kept   |
 *   |        |                    | in this browser and used only to unseal here    |
 *
 * THE THIRD ROW IS THE D-04 SPLIT. The secret still never leaves this module
 * as itself on the network path: `secretToKeySplit` derives two
 * domain-separated halves from it, the REST binding transmits only the lookup
 * half, and the content half stays in this browser. Were the raw secret sent,
 * the receiver could derive the content half from the very request that asks
 * for the payload, and the sealing would be theatre. The digest half is still
 * transmitted nowhere at all, by anyone, for the reason stated below.
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

import {
	RestBootstrapTransport,
	deriveBootstrapKeys,
	unsealPayload,
	parseSnapshot,
} from '@votetorrent/vote-engine/bootstrap';

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
 * The transport DELIVERED something, and the key derived from the pasted code
 * could not turn it into a parseable envelope.
 *
 * This is distinguishable, by class, from both of its neighbours: a
 * `BootstrapTransportUnreachableError` means nothing arrived, and an
 * `InvalidSignInCodeError` means the pasted text never got as far as a
 * request. This one means bytes arrived and this browser cannot authenticate
 * them.
 *
 * IT CARRIES A STRUCTURAL REASON AND NOTHING ELSE -- no ciphertext byte, no
 * key byte, no plaintext, no registrant content, and not the secret. The only
 * values ever interpolated into its message come from two closed vocabularies
 * (`SealedUnsealFailureReason` and `SnapshotParseResult`'s reason), both of
 * which name structure only.
 */
export class SealedPayloadUnreadableError extends Error {
	/** @param {string} message */
	constructor(message) {
		super(message);
		this.name = 'SealedPayloadUnreadableError';
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
 * Derive the D-04 key split from a secret half.
 *
 * THE PATTERN GATE RUNS FIRST, AND THAT ORDERING IS THE POINT. A hex decoder
 * that rejects bad input almost always names the offending characters --
 * `@noble/hashes`'s own `hexToBytes` embeds two of them in its `RangeError`
 * -- and here the offending string IS the bearer secret. Screening against
 * `SECRET_PATTERN` before a single character is decoded means no decoder
 * error message can ever exist to carry a fragment of it. The refusal this
 * function raises names the rule and the OBSERVED LENGTH only.
 *
 * `lookupId` is the half the REST binding transmits; `contentKey` is the half
 * that stays in this browser and opens the payload. Both are derived here,
 * from the same call, so the two sides can never drift apart.
 *
 * @param {string} secret
 * @returns {import('@votetorrent/vote-engine/bootstrap').BootstrapKeySplit}
 */
export function secretToKeySplit(secret) {
	if (typeof secret !== 'string' || !SECRET_PATTERN.test(secret)) {
		const observed = typeof secret === 'string' ? secret.length : -1;
		throw new InvalidSignInCodeError(
			`secret half must be exactly ${SECRET_LENGTH} lowercase hex characters (observed length ${observed})`,
		);
	}
	const bytes = new Uint8Array(secret.length / 2);
	for (let i = 0; i < bytes.length; i++) {
		bytes[i] = parseInt(secret.slice(i * 2, i * 2 + 2), 16);
	}
	return deriveBootstrapKeys(bytes);
}

/**
 * A redemption AFTER this module has opened it: plaintext, exactly the shape
 * every existing consumer of `redemption.snapshot` already expects.
 * @typedef {{ status: import('@votetorrent/vote-engine/bootstrap').BootstrapRedemptionStatus, snapshot?: import('@votetorrent/vote-engine/bootstrap').BootstrapSnapshot }} OpenedRedemption
 */

/**
 * Redeem the SECRET half only through the given transport binding, and OPEN
 * what comes back.
 *
 * THIS FUNCTION IS THE SEALING BOUNDARY (D-06): below it results are sealed,
 * above it they are plaintext. That is deliberate and is what keeps this
 * change small -- `redeemAndBootstrap` and `DashboardShell` go on consuming
 * `redemption.snapshot` exactly as they did, because this is the ONE place in
 * the dashboard that unseals. Nothing else in `src/` may call
 * `unsealPayload`; adding a second call site would mean a second, unaudited
 * definition of what "the payload opened correctly" means.
 *
 * The four-status pass-through contract is UNCHANGED: `expired`, `used` and
 * `unknown` render one copy family downstream but must stay distinguishable
 * in this return value (50-07's handoff).
 *
 * The order below is load-bearing. Unsealing comes before parsing, and
 * parsing before verification (which the caller performs), because verifying
 * ahead of unsealing would be verifying opaque bytes. Opening the wrapper
 * proves the payload was sealed by someone holding the secret; it does NOT
 * prove the payload is the snapshot the officer's screen described. Only
 * `expectedDigest`, read off the phone out of band and passed to
 * `verifySnapshot` by the caller, does that.
 *
 * Three failure classes, deliberately distinct:
 *   - nothing arrived                    -> BootstrapTransportUnreachableError
 *   - the pasted secret was malformed    -> InvalidSignInCodeError
 *   - bytes arrived and would not open   -> SealedPayloadUnreadableError
 *
 * @param {import('@votetorrent/vote-engine/bootstrap').IBootstrapTransport} transport
 * @param {string} secret
 * @returns {Promise<OpenedRedemption>}
 */
export async function redeemSignInCode(transport, secret) {
	// 1. Derive BEFORE any network call -- a malformed secret must never
	//    reach a socket, and the derivation cannot fail later on.
	const keys = secretToKeySplit(secret);

	// 2. The `await` of the transport call is the ONLY statement inside this
	//    try. Widening it would let the unseal/parse refusals raised below be
	//    swallowed and reported as an unreachable endpoint, collapsing three
	//    distinguishable failures into one.
	/** @type {import('@votetorrent/vote-engine/bootstrap').BootstrapRedemptionResult} */
	let result;
	try {
		result = await transport.redeem(secret);
	} catch {
		throw new BootstrapTransportUnreachableError(
			'bootstrap-transport-client: the configured transport binding could not complete a redemption',
		);
	}

	// 3. A refusal carries no payload, by the seam's own contract.
	if (result.status !== 'ok') {
		return { status: result.status };
	}

	// 4. An `ok` that carries nothing is a source defect, not a refusal.
	if (!result.sealed) {
		throw new SealedPayloadUnreadableError(
			"bootstrap-transport-client: the redemption reported status 'ok' but carried no sealed payload",
		);
	}

	// 5. Unseal, then parse. Both reasons are closed structural vocabularies;
	//    nothing else from either result is interpolated.
	const opened = unsealPayload(result.sealed, keys);
	if (!opened.ok) {
		throw new SealedPayloadUnreadableError(
			`bootstrap-transport-client: the delivered payload could not be opened with the key derived from the pasted code (${opened.reason})`,
		);
	}
	const parsed = parseSnapshot(opened.plaintext);
	if (!parsed.ok) {
		throw new SealedPayloadUnreadableError(
			`bootstrap-transport-client: the opened payload is not a parseable snapshot envelope (${parsed.reason})`,
		);
	}
	return { status: 'ok', snapshot: parsed.envelope };
}
