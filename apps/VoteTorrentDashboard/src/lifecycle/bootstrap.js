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
} from '../transport/bootstrap-transport-client.js';
import { verifySnapshot } from '@votetorrent/vote-engine/bootstrap';
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
 * @typedef {object} RedeemAndBootstrapOptions
 * @property {string} pastedCode
 * @property {import('@votetorrent/vote-engine/bootstrap').IBootstrapTransport} transport
 * @property {import('../db/networks-registry.js').StorageAdapter} [storage]
 * @property {boolean} [replace] - 50-09's refresh/officer-swap paths only; no UI in this phase.
 * @property {(phase: string) => void} [onPhase]
 * @property {string} [expectedNetworkHash] - supplied by 50-09's replace paths; omitted on a first redemption.
 */

/**
 * @typedef {
 *   | { outcome: 'ok', network: import('../db/networks-registry.js').NetworkRegistryEntry }
 *   | { outcome: 'invalid-code' }
 *   | { outcome: 'code-refused', status: import('@votetorrent/vote-engine/bootstrap').BootstrapRedemptionStatus }
 *   | { outcome: 'transport-unreachable' }
 *   | { outcome: 'verify-failed', reason: import('@votetorrent/vote-engine/bootstrap').SnapshotVerifyFailureReason }
 *   | { outcome: 'already-bootstrapped' }
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
	const { pastedCode, transport, storage, replace = false, onPhase = () => {}, expectedNetworkHash } = options;

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

	// 2. Redeem the SECRET half only.
	onPhase('submitting');
	/** @type {import('@votetorrent/vote-engine/bootstrap').BootstrapRedemptionResult} */
	let redemption;
	try {
		redemption = await redeemSignInCode(transport, secret);
	} catch (err) {
		if (err instanceof BootstrapTransportUnreachableError) {
			return { outcome: 'transport-unreachable' };
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
		return { outcome: 'already-bootstrapped' };
	}
	if (existing && replace) {
		await deleteNetworkDb(envelope.networkHash);
	}

	// 5. Apply the schema.
	onPhase('applying-schema');
	const db = await createNetworkDb(envelope.networkHash);
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
		return { outcome: 'ok', network };
	} finally {
		await closeNetworkDb(db);
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
 * @param {string} outcome
 * @param {string} [reason]
 * @returns {CopyKeys}
 */
export function copyKeysForOutcome(outcome, reason) {
	switch (outcome) {
		case 'invalid-code':
		case 'code-refused':
			return INVALID_CODE_KEYS;
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
