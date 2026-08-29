/**
 * bootstrap.js -- the D-12 verify-before-commit orchestration: turn a pasted
 * sign-in code into either a verified local copy of one network's data, or a
 * refusal that costs the officer nothing.
 *
 * THE RULE THIS MODULE ENFORCES: verify completely, then and only then touch
 * storage; never merge. The numbered steps below are the mitigation, not an
 * implementation detail -- reordering them reopens exactly the "corrupt
 * payload destroys the good local copy" class this plan exists to close.
 *
 * DEVIATION FROM THE PLAN'S LITERAL STEP ORDER (recorded here and in the
 * plan's SUMMARY): the officer-identity derivation (originally specified as
 * a post-restore DB query) is performed HERE, directly from the verified
 * envelope's OWN `tables.User` member, BEFORE the registry/delete check --
 * not after `applySnapshotTables`. Deriving it in-memory, pre-delete, is
 * what makes `officer-indeterminate` byte-intact for an already-bootstrapped
 * network (a requirement this plan's own acceptance criteria state
 * explicitly), which a post-delete DB query could not satisfy. Reading
 * `envelope.tables.User` IS reading "the snapshot's single User row" --
 * <the_officer_identity>'s own phrasing -- so this is a faithful
 * implementation of that section's intent, not a departure from it.
 * `authorityName`/`domain` are derived the same way, from
 * `envelope.tables.Authority`, for the same reason and because it avoids an
 * extra DB round-trip for data already sitting in memory, verified.
 */

import {
	splitSignInCode,
	redeemSignInCode,
	InvalidSignInCodeError,
	BootstrapTransportUnreachableError,
	SealedPayloadUnreadableError,
} from '../transport/bootstrap-transport-client.js';
import { verifySnapshot, KNOWN_BOOTSTRAP_REDEMPTION_STATUS_CODES } from '@votetorrent/vote-engine/bootstrap';
import { nowCanonicalDatetime } from '@votetorrent/vote-engine/browser';
import { createNetworkDb, closeNetworkDb, deleteNetworkDb } from '../db/open-db.js';
import { writeRowCounts } from '../db/reattach.js';
import { findNetwork, upsertNetwork } from '../db/networks-registry.js';
import { applySnapshotTables, assertRestoreMatchesManifest, RestoreCountMismatchError } from './snapshot-restore.js';

/** The closed, frozen outcome vocabulary -- the single vocabulary the screen
 * renders against. Never re-declared in the `.tsx`. */
export const BOOTSTRAP_OUTCOME_CODES = Object.freeze(
	/** @type {const} */ ([
		'ok',
		'invalid-code',
		'code-refused',
		'transport-unreachable',
		'verify-failed',
		'already-bootstrapped',
		'restore-incomplete',
		'officer-indeterminate',
	]),
);

/** UI-SPEC Screens & States row 1's six-step progression, minus the two error
 * states (those are outcomes, not phases). Import this constant; never re-list
 * the phases in the screen. */
export const BOOTSTRAP_PHASES = Object.freeze(
	/** @type {const} */ (['submitting', 'verifying', 'applying-schema', 'seeding', 'success']),
);

/**
 * NOTE ON PHASE COPY LOOKUP: the screen (`Bootstrap.tsx`) looks up each
 * phase's copy directly, as `` t(`bootstrap.phase.${state.phase}`) `` --
 * `src/i18n/copy.js` carries one `bootstrap.phase.<value>` key per
 * `BOOTSTRAP_PHASES` member, keyed by the exact machine value, so the lookup
 * is a mechanical template rather than a hand-maintained mapping table that
 * could drift out of step with this array. `t()` is total: it throws naming
 * the key for anything unmapped, so a phase added here without a matching
 * copy-table key is a loud error, never a raw machine identifier on screen.
 * A dedicated `copyKeyForPhase` mapping function previously lived here and
 * has been removed -- it duplicated exactly the drift risk this note warns
 * against.
 */

/**
 * @typedef {object} RedeemAndBootstrapOptions
 * @property {string} pastedCode
 * @property {import('@votetorrent/vote-engine/bootstrap').IBootstrapTransport} transport
 * @property {import('../db/networks-registry.js').StorageAdapter} [storage]
 * @property {boolean} [replace] - 50-09's refresh/officer-swap paths only; no UI in this phase.
 * @property {(phase: string) => void} [onPhase]
 * @property {string} [expectedNetworkHash] - supplied by 50-09's replace paths; omitted on a first redemption.
 * @property {import('@quereus/quereus').Database} [db] - an already-open handle to the network being
 *   REPLACED, handed over so step 4's delete closes it first. `indexedDB.deleteDatabase` blocks while
 *   any connection is open, so a caller that holds one and does not hand it over is racing its own
 *   delete. Ignored on a first bootstrap, where there is nothing to replace.
 */

/**
 * @typedef {
 *   | { outcome: 'ok', network: import('../db/networks-registry.js').NetworkRegistryEntry }
 *   | { outcome: 'invalid-code' }
 *   | { outcome: 'code-refused', status: import('@votetorrent/vote-engine/bootstrap').BootstrapRedemptionStatus }
 *   | { outcome: 'transport-unreachable' }
 *   | { outcome: 'verify-failed', reason: import('@votetorrent/vote-engine/bootstrap').SnapshotVerifyFailureReason }
 *   | { outcome: 'already-bootstrapped', networkHash: string }
 *   | { outcome: 'restore-incomplete' }
 *   | { outcome: 'officer-indeterminate' }
 * } RedeemAndBootstrapResult
 */

/**
 * Redeem a pasted sign-in code and, if everything verifies, commit its
 * snapshot as a new (or replaced) per-network database. Never throws for an
 * EXPECTED refusal; throws only for a programming error.
 *
 * @param {RedeemAndBootstrapOptions} options
 * @returns {Promise<RedeemAndBootstrapResult>}
 */
export async function redeemAndBootstrap(options) {
	const { pastedCode, transport, storage, replace = false, onPhase = () => {}, expectedNetworkHash, db: handoverDb } = options;

	// 1. Split -- no transport object is constructed before this succeeds.
	/** @type {string} */
	let secret;
	/** @type {string} */
	let expectedDigest;
	try {
		({ secret, expectedDigest } = splitSignInCode(pastedCode));
	} catch (err) {
		if (err instanceof InvalidSignInCodeError) {
			return { outcome: 'invalid-code' };
		}
		throw err;
	}

	// 2. Redeem the SECRET half only. `redeemSignInCode` is the sealing
	//    boundary (D-06): what it returns is already OPENED, so everything
	//    below this point consumes a plaintext envelope exactly as before.
	//
	//    THE THREE-WAY MAPPING OF ITS THREE FAILURE CLASSES:
	//      - BootstrapTransportUnreachableError -> 'transport-unreachable'
	//        (unchanged: nothing arrived)
	//      - SealedPayloadUnreadableError       -> 'verify-failed',
	//        reason 'malformed-envelope'
	//      - InvalidSignInCodeError             -> 'invalid-code'
	//      - anything else                      -> rethrow
	//
	//    On the middle mapping: a payload that will not open under the code's
	//    OWN key is a payload this browser cannot authenticate, which is the
	//    `verify-failed` family by meaning, not by convenience.
	//    `'malformed-envelope'` is an existing member of the frozen
	//    `SnapshotVerifyFailureReason` union and is already routed to the
	//    verification copy family (`VERIFICATION_REASONS` in
	//    `copyKeysForOutcome` below), so NO new outcome code and NO new copy
	//    key is introduced here. Refusal copy is a later plan's work and must
	//    not be pre-empted from this line.
	//
	//    `InvalidSignInCodeError` cannot normally reach here -- step 1 already
	//    split and validated the same secret -- but `redeemSignInCode`
	//    re-derives from it, so the mapping is stated rather than left to a
	//    rethrow that would surface as an unhandled rejection.
	onPhase('submitting');
	/** @type {import('../transport/bootstrap-transport-client.js').OpenedRedemption} */
	let redemption;
	try {
		redemption = await redeemSignInCode(transport, secret);
	} catch (err) {
		if (err instanceof BootstrapTransportUnreachableError) {
			return { outcome: 'transport-unreachable' };
		}
		if (err instanceof SealedPayloadUnreadableError) {
			return { outcome: 'verify-failed', reason: 'malformed-envelope' };
		}
		if (err instanceof InvalidSignInCodeError) {
			return { outcome: 'invalid-code' };
		}
		throw err;
	}
	if (redemption.status !== 'ok' || !redemption.snapshot) {
		return { outcome: 'code-refused', status: redemption.status };
	}
	const envelope = redemption.snapshot;

	// 3. Verify BEFORE any storage call whatsoever. `expectedDigest` is the
	//    DIGEST HALF OF THE OFFICER'S OWN CODE -- the out-of-band trust
	//    anchor (D-13); this is the line that makes the snapshot authentic
	//    rather than merely self-consistent. `expectedNetworkHash` is
	//    supplied only on 50-09's replace paths, where the caller already
	//    knows which network it is re-bootstrapping. No third option is
	//    ever passed here for the schema hash: letting 50-02 compute it
	//    from the local schema is what makes a version divergence
	//    detectable.
	onPhase('verifying');
	const verified = verifySnapshot(
		envelope,
		expectedNetworkHash !== undefined ? { expectedDigest, expectedNetworkHash } : { expectedDigest },
	);
	if (!verified.ok) {
		return { outcome: 'verify-failed', reason: verified.reason };
	}

	// 3.1 CROSS-CHECK THE ENVELOPE'S OWN networkHash AGAINST THE DIGEST-COVERED
	//     TABLE CONTENT. The digest covers `tables` only -- deliberately, and
	//     correctly, for a corruption check. But on a FIRST bootstrap
	//     `expectedNetworkHash` is absent, so `envelope.networkHash` is an
	//     entirely unauthenticated field, and this function then uses it as the
	//     IndexedDB database name, the row-count storage key and the registry
	//     primary key. A transport or endpoint that can observe or replay a
	//     legitimate envelope could therefore re-serve the AUTHENTIC table
	//     content under an attacker-chosen identity and have it verify clean:
	//     digest, manifest and schema hash all match. The browser would then
	//     file the real authority's data under the wrong identity, while the
	//     panels went on showing the (digest-covered) `Network.Hash` that no
	//     longer matched either the registry key or the database name.
	//
	//     The envelope shape is frozen, so the containment is to require the
	//     unauthenticated field to AGREE with the authenticated content it
	//     claims to describe. Skipped when the snapshot carries no single
	//     `Network` row to check against -- silence is not evidence, and
	//     refusing there would reject legitimate partial fixtures.
	const networkRows = envelope.tables.Network ?? [];
	if (networkRows.length === 1) {
		const declaredHash = /** @type {Record<string, unknown>} */ (networkRows[0]).Hash;
		if (typeof declaredHash === 'string' && declaredHash !== envelope.networkHash) {
			return { outcome: 'verify-failed', reason: 'network-hash-mismatch' };
		}
	}

	// 3.5 Derive the officer identity from the VERIFIED envelope's own User
	//     rows, in memory, BEFORE anything is deleted -- see this module's
	//     header deviation note. The schema admits exactly one User by
	//     construction (User.InsertValid); any other count means the
	//     producing app is a build this dashboard does not understand.
	const userRows = envelope.tables.User ?? [];
	if (userRows.length !== 1) {
		return { outcome: 'officer-indeterminate' };
	}
	const officerUserId = String(/** @type {Record<string, unknown>} */ (userRows[0]).Id);

	const authorityRows = envelope.tables.Authority ?? [];
	const authorityRow = /** @type {Record<string, unknown> | undefined} */ (authorityRows[0]);
	const authorityName = typeof authorityRow?.Name === 'string' ? authorityRow.Name : '';
	const domain = typeof authorityRow?.DomainName === 'string' ? authorityRow.DomainName : '';

	// 4. Registry check. The delete below happens ONLY after step 3 (and
	//    the officer derivation above, which touches no storage) succeeded
	//    -- D-12's "verify before discarding" in one line, and what makes a
	//    corrupt payload harmless. `replace` has no UI in this phase (50-09
	//    owns the D-14 confirm dialog); it exists here so the destructive
	//    path has exactly one implementation.
	const existing = findNetwork(envelope.networkHash, storage);
	if (existing && !replace) {
		// `networkHash` is included so a caller (Bootstrap.tsx's
		// `onAlreadyBootstrapped` seam) can identify which network this is
		// without a redundant transport replay just to read it back off the
		// envelope it already redeemed.
		return { outcome: 'already-bootstrapped', networkHash: envelope.networkHash };
	}
	if (existing && replace) {
		// `handoverDb` closes first, inside deleteNetworkDb. A caller holding an
		// open connection to exactly this database and NOT handing it over
		// guarantees `DeleteBlockedError` -- the delete cannot proceed while
		// any connection is open, and this primitive deliberately refuses to
		// resolve on `onblocked`.
		await deleteNetworkDb(envelope.networkHash, { storage, db: handoverDb });
	}

	// 5. Apply the schema.
	//
	// EVERYTHING FROM HERE IS PROVISIONAL UNTIL STEP 10. `createNetworkDb`
	// runs `prepareDb`, which applies the schema and marks the store
	// initialized -- so the moment this line returns, an IndexedDB database
	// exists on disk. If seeding then fails, the old code returned or threw
	// with only `closeNetworkDb` in the `finally`, leaving that database
	// schema-initialized, partly populated with registrant rows, and with NO
	// registry entry (step 10 never ran). That orphan was unreachable by every
	// cleanup path this app has: `forgetNetwork` throws `UnknownNetworkError`
	// for a hash the registry does not list, and the menu that would call it
	// only renders for a listed network -- so the officer had no way to remove
	// registrant information a failed bootstrap left in their browser. It also
	// wedged retries: a second code for the same network found no registry
	// entry, so no delete happened, `createNetworkDb` re-opened the stale
	// database, and upserts cannot REDUCE a row count -- a re-issued snapshot
	// with fewer rows in any table failed the manifest re-check forever.
	onPhase('applying-schema');
	const db = await createNetworkDb(envelope.networkHash);
	let committed = false;
	try {
		// 6. Seed, then re-check EXACTLY against the manifest.
		onPhase('seeding');
		await applySnapshotTables(db, envelope);
		try {
			await assertRestoreMatchesManifest(db, envelope);
		} catch (err) {
			if (err instanceof RestoreCountMismatchError) {
				return { outcome: 'restore-incomplete' };
			}
			throw err;
		}

		// 9. Contract 6's obligation to 50-05: write the manifest that was
		//    just verified and re-checked, not a freshly recomputed one.
		await writeRowCounts(envelope.networkHash, /** @type {Record<string, number>} */ (envelope.manifest), storage);

		// 10. D-10: bootstrappedAt from nowCanonicalDatetime() only.
		const bootstrappedAt = nowCanonicalDatetime();
		const network = upsertNetwork(
			{ networkHash: envelope.networkHash, authorityName, domain, officerUserId, bootstrappedAt },
			storage,
		);

		// Order 9-before-10 is deliberate: the registry entry is what makes
		// a network VISIBLE to the switcher, so it is written last -- a
		// crash between them leaves an unlisted database (recoverable,
		// invisible) rather than a listed one with no expectation record
		// (which attachNetworkDb would reject on sight).
		onPhase('success');
		committed = true;
		return { outcome: 'ok', network };
	} finally {
		await closeNetworkDb(db);
		if (!committed) {
			// Best-effort, and deliberately swallowed: this cleanup runs while
			// an outcome or an exception is already on its way out, and a
			// failure to delete must not replace it with a less informative
			// one. The worst case is the orphan this block exists to prevent --
			// no worse than the previous behaviour, and now the exception.
			await deleteNetworkDb(envelope.networkHash, { storage }).catch(() => undefined);
		}
	}
}

/**
 * @typedef {{ headingKey: string, bodyKey: string, ctaKey: string }} CopyKeys
 */

const INVALID_CODE_KEYS = Object.freeze({
	headingKey: 'bootstrap.errorInvalidCodeHeading',
	bodyKey: 'bootstrap.errorInvalidCodeBody',
	ctaKey: 'bootstrap.errorInvalidCodeCta',
});

const TRANSPORT_KEYS = Object.freeze({
	headingKey: 'bootstrap.errorTransportHeading',
	bodyKey: 'bootstrap.errorTransportBody',
	ctaKey: 'bootstrap.errorTransportCta',
});

// snapshot.errorVerificationHeading/Body have no dedicated CTA key in the
// frozen copy table (contract 2 -- this plan adds no key), so both
// verification-flavoured families below borrow bootstrap.errorInvalidCodeCta
// as their action.
const VERIFICATION_KEYS = Object.freeze({
	headingKey: 'snapshot.errorVerificationHeading',
	bodyKey: 'snapshot.errorVerificationBody',
	ctaKey: 'bootstrap.errorInvalidCodeCta',
});

const SCHEMA_MISMATCH_KEYS = Object.freeze({
	headingKey: 'snapshot.errorSchemaMismatchHeading',
	bodyKey: 'snapshot.errorSchemaMismatchBody',
	ctaKey: 'bootstrap.errorInvalidCodeCta',
});

// --- The three refusal families (D-25) --------------------------------------
//
// One family per redemption status the service can answer, rather than one
// hedge for all three. These exist because the service ANSWERS the three
// distinguishably, and it can still do so late because it keeps a
// payload-free record for a grace window past the code's own expiry (D-16) --
// without that retention a late redemption would degrade to the weakest
// answer, "no record here", and all three of these constants would collapse
// back into one. The same argument is recorded in `src/i18n/copy.js` beside
// the strings themselves; it is stated twice on purpose, because the mapping
// and the copy are separately tempting to "simplify".
//
// Each borrows `bootstrap.errorInvalidCodeCta` ("Try another code"), the
// table's generic try-a-different-code action, exactly as the two
// verification-flavoured families above do.

const NOT_RECOGNIZED_KEYS = Object.freeze({
	headingKey: 'bootstrap.errorCodeNotRecognizedHeading',
	bodyKey: 'bootstrap.errorCodeNotRecognizedBody',
	ctaKey: 'bootstrap.errorInvalidCodeCta',
});

const ALREADY_USED_KEYS = Object.freeze({
	headingKey: 'bootstrap.errorCodeAlreadyUsedHeading',
	bodyKey: 'bootstrap.errorCodeAlreadyUsedBody',
	ctaKey: 'bootstrap.errorInvalidCodeCta',
});

const TIMED_OUT_KEYS = Object.freeze({
	headingKey: 'bootstrap.errorCodeTimedOutHeading',
	bodyKey: 'bootstrap.errorCodeTimedOutBody',
	ctaKey: 'bootstrap.errorInvalidCodeCta',
});

/** Status value -> copy family. Keyed by the EXACT wire value, so selection is
 * a lookup rather than a `switch` over three hand-written string literals that
 * nothing would check against the vocabulary. */
const REFUSAL_KEYS_BY_STATUS = Object.freeze({
	unknown: NOT_RECOGNIZED_KEYS,
	used: ALREADY_USED_KEYS,
	expired: TIMED_OUT_KEYS,
});

// IMPORT-TIME TOTALITY CHECK against the vocabulary's own exported set.
// `'ok'` is not a refusal and deliberately has no family, so it is added here
// rather than to the map. A FIFTH status added to
// `KNOWN_BOOTSTRAP_REDEMPTION_STATUS_CODES` without a copy family must be an
// error the moment this module loads -- not an unlabelled render, and not a
// silent fall-through discovered by an officer.
{
	const covered = new Set([...Object.keys(REFUSAL_KEYS_BY_STATUS), 'ok']);
	const missing = [...KNOWN_BOOTSTRAP_REDEMPTION_STATUS_CODES].filter((code) => !covered.has(code));
	const extra = [...covered].filter((code) => !KNOWN_BOOTSTRAP_REDEMPTION_STATUS_CODES.has(code));
	if (missing.length > 0 || extra.length > 0) {
		throw new Error(
			'bootstrap.js: the refusal copy map has drifted from KNOWN_BOOTSTRAP_REDEMPTION_STATUS_CODES -- ' +
				`statuses with no copy family: [${missing.join(', ')}]; ` +
				`mapped values outside the vocabulary: [${extra.join(', ')}]`,
		);
	}
}

/** The "checksum" family (50-02's steps 6-8: manifest, digest, out-of-band digest). */
const VERIFICATION_REASONS = new Set(['malformed-envelope', 'manifest-mismatch', 'digest-mismatch']);
/** The "wrong version" family (50-02's steps 2-3, 5: format version, canonical
 * generatedAt shape, schema hash). */
const SCHEMA_MISMATCH_REASONS = new Set(['format-version-mismatch', 'schema-hash-mismatch', 'non-canonical-generated-at']);

/**
 * The single place the outcome-to-copy-key mapping lives. Total over the
 * FAILURE union: throws naming the outcome for anything the union does not
 * recognize -- an unmapped outcome must be a loud programming error, not a
 * blank screen. `outcome: 'ok'` has no error copy and also throws (the
 * screen never calls this for `'ok'`; it renders the success state instead).
 *
 * `status` is the THIRD positional parameter, deliberately -- every existing
 * `(outcome, reason)` call site and test keeps working unchanged. It is
 * REQUIRED for, and meaningful only for, `'code-refused'`: that is the one
 * outcome carrying a `status` (see `RedeemAndBootstrapResult`), and it is what
 * selects which of the three D-25 refusal families the officer reads.
 *
 * @param {string} outcome
 * @param {string} [reason]
 * @param {string} [status] - the redemption status, for `'code-refused'` only.
 * @returns {CopyKeys}
 */
export function copyKeysForOutcome(outcome, reason, status) {
	switch (outcome) {
		case 'invalid-code':
			// NO LONGER SHARED WITH 'code-refused'. `'invalid-code'` is a pasted
			// string that failed the local shape check and never left this
			// browser; the three refusal families answer things the SERVICE said.
			return INVALID_CODE_KEYS;
		case 'code-refused':
			// THE LOAD-BEARING LINE OF THIS FUNCTION. A missing status THROWS
			// rather than falling back to INVALID_CODE_KEYS. That fallback is
			// exactly the pre-D-25 behaviour -- one hedging sentence for all
			// three refusals -- and a caller that forgot to plumb the status
			// would silently reinstate it, invisibly, for every officer. A
			// caller that forgets is a programming error, so it is loud.
			if (status === undefined) {
				throw new Error(
					'copyKeysForOutcome: outcome "code-refused" requires a status -- ' +
						'the redemption status selects which refusal copy family the officer reads, ' +
						'and defaulting would silently re-conflate all three',
				);
			}
			// A refusal carrying `ok` is a contradiction: the caller mis-mapped a
			// successful redemption into the refusal path. There is no family to
			// render for it, so say so rather than inventing one.
			if (status === 'ok') {
				throw new Error(
					'copyKeysForOutcome: status "ok" is not a refusal -- a "code-refused" outcome carrying it means the caller mis-mapped a successful redemption',
				);
			}
			if (Object.prototype.hasOwnProperty.call(REFUSAL_KEYS_BY_STATUS, status)) {
				return REFUSAL_KEYS_BY_STATUS[/** @type {'unknown'|'used'|'expired'} */ (status)];
			}
			// Same posture as `assertKnownBootstrapRedemptionStatus` at the wire:
			// name the offending value and refuse, never coerce.
			throw new Error(`copyKeysForOutcome: unmapped redemption status "${status}" for outcome "code-refused"`);
		case 'transport-unreachable':
			return TRANSPORT_KEYS;
		case 'verify-failed':
			if (reason === 'network-hash-mismatch') return INVALID_CODE_KEYS;
			if (reason !== undefined && VERIFICATION_REASONS.has(reason)) return VERIFICATION_KEYS;
			if (reason !== undefined && SCHEMA_MISMATCH_REASONS.has(reason)) return SCHEMA_MISMATCH_KEYS;
			throw new Error(`copyKeysForOutcome: unmapped verify-failed reason "${reason}"`);
		case 'restore-incomplete':
			return VERIFICATION_KEYS;
		case 'officer-indeterminate':
			return SCHEMA_MISMATCH_KEYS;
		case 'already-bootstrapped':
			// No UI in this phase -- 50-09 owns the D-14 swap dialog. Mapped
			// only so this function is total over the outcome union.
			return INVALID_CODE_KEYS;
		case 'ok':
			throw new Error('copyKeysForOutcome: "ok" has no error copy -- render the success state instead');
		default:
			throw new Error(`copyKeysForOutcome: unmapped outcome "${outcome}"`);
	}
}
