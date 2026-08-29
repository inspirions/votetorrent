/**
 * Tier-1 assertions over `src/i18n/copy.js`'s `COPY` table and `t()` helper.
 *
 * Browser-free, no display -- plain node:test. Each test below corresponds 1:1 to a
 * `<behavior>` bullet in 50-04-PLAN.md Task 2.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { COPY, t } = await import('../../src/i18n/copy.js');
const { BOOTSTRAP_PHASES, BOOTSTRAP_OUTCOME_CODES, copyKeysForOutcome } = await import(
	'../../src/lifecycle/bootstrap.js'
);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(__dirname, '..', '..');

test('t("bootstrap.cta") returns exactly "Redeem Code"', () => {
	assert.equal(t('bootstrap.cta'), 'Redeem Code');
});

test('t("gate.badgeReal") and t("gate.badgeSimulated") return the D-18 binding wording', () => {
	assert.equal(t('gate.badgeReal'), 'answered by the database');
	assert.equal(t('gate.badgeSimulated'), 'simulated scope set');
});

test('t("network.forgetConfirmBody", {...}) interpolates and leaves no residual {{', () => {
	const result = t('network.forgetConfirmBody', { authorityName: 'Acme County' });
	assert.ok(result.includes('Acme County'), 'expected interpolated value in output');
	assert.ok(!result.includes('{{'), 'expected no residual {{ placeholder marker');
});

test('t("does.not.exist") throws an Error naming the missing key', () => {
	assert.throws(
		() => t('does.not.exist'),
		(err) => err instanceof Error && err.message.includes('does.not.exist'),
	);
});

test('t("network.forgetConfirmBody") with no params throws naming the unresolved placeholder', () => {
	assert.throws(
		() => t('network.forgetConfirmBody'),
		(err) => err instanceof Error && err.message.includes('authorityName'),
	);
});

test('every value in COPY is a non-empty string', () => {
	for (const [key, value] of Object.entries(COPY)) {
		assert.equal(typeof value, 'string', `COPY.${key} must be a string`);
		assert.ok(value.length > 0, `COPY.${key} must be non-empty`);
	}
});

test('no COPY value contains a GSD decision ID (D-\\d{2})', () => {
	const pattern = /\bD-\d{2}\b/;
	for (const [key, value] of Object.entries(COPY)) {
		assert.ok(!pattern.test(value), `COPY.${key} must not contain a decision ID: "${value}"`);
	}
});

test('no COPY value contains a GSD phase number ("Phase \\d+")', () => {
	const pattern = /\bPhase\s+\d+\b/;
	for (const [key, value] of Object.entries(COPY)) {
		assert.ok(!pattern.test(value), `COPY.${key} must not contain a phase number: "${value}"`);
	}
});

test('no COPY value matches /read-only/i (D-17: no read-only panel state exists)', () => {
	const pattern = /read-only/i;
	for (const [key, value] of Object.entries(COPY)) {
		assert.ok(!pattern.test(value), `COPY.${key} must not mention "read-only": "${value}"`);
	}
});

test('COPY is frozen -- assigning a new key throws in strict mode', () => {
	// COPY's JSDoc type is `Record<string, string>`, which TS permits assigning
	// into via its index signature -- this is a RUNTIME check of Object.freeze's
	// strict-mode behavior, not a compile-time one, so no @ts-expect-error is
	// expected here.
	assert.throws(() => {
		COPY.__newKey__ = 'nope';
	});
});

test('every BOOTSTRAP_PHASES member has a matching bootstrap.phase.<value> key in COPY, derived mechanically -- never a hand-written phase list', () => {
	// The defect this pins: the screen rendered `{state.phase}` directly, so
	// the officer saw the literal machine identifiers "submitting",
	// "applying-schema" and friends in an aria-live region. The expectation
	// here is built from the imported BOOTSTRAP_PHASES array itself, exactly
	// mirroring the template Bootstrap.tsx applies
	// (`` `bootstrap.phase.${state.phase}` ``) -- a hand-written list of five
	// strings in this test would not catch a drift between the two.
	for (const phase of BOOTSTRAP_PHASES) {
		const key = `bootstrap.phase.${phase}`;
		assert.ok(key in COPY, `expected COPY to have a "${key}" key for BOOTSTRAP_PHASES member "${phase}"`);
		assert.ok(t(key).length > 0);
	}
});

test('t(`bootstrap.phase.<unmapped>`) throws naming the key, so a new phase cannot silently render raw', () => {
	assert.throws(
		() => t('bootstrap.phase.not-a-phase'),
		(err) => err instanceof Error && err.message.includes('bootstrap.phase.not-a-phase'),
	);
});

test('panelFrame.tierPill, panelFrame.sitePill and panelFrame.sitesPill exist and interpolate their placeholders', () => {
	assert.equal(t('panelFrame.tierPill', { tier: '2' }), 'tier 2');
	assert.equal(t('panelFrame.sitePill', { count: '1' }), '1 site');
	assert.equal(t('panelFrame.sitesPill', { count: '3' }), '3 sites');
});

// --- Surfaced swap-failure banner (CR-03, 50-22) --------------------------------

test('t("network.swapErrorHeading") and t("network.swapErrorBody") resolve to non-empty strings with no residual {{', () => {
	const heading = t('network.swapErrorHeading');
	const body = t('network.swapErrorBody');
	assert.ok(heading.length > 0, 'expected a non-empty heading');
	assert.ok(body.length > 0, 'expected a non-empty body');
	assert.ok(!heading.includes('{{'), 'expected no residual {{ placeholder marker in heading');
	assert.ok(!body.includes('{{'), 'expected no residual {{ placeholder marker in body');
});

// ===========================================================================
// D-25: the three refusal families
//
// The defect: `bootstrap.errorInvalidCodeBody` read "It may have expired or
// already been used. Ask the officer for a new one." -- one sentence answering
// three distinguishable service refusals plus a locally malformed paste. Every
// assertion below exists to keep the three genuinely apart, because "three
// different sentences that all say ask for a new code" is the same defect with
// more words.
//
// The bar is THREE DIFFERENT NEXT ACTIONS, so each family declares an action
// TOKEN and the suite proves that token appears in its own body and in neither
// of the other two. That makes convergence mechanical to detect rather than a
// matter of taste.
//
// Every assertion is driven off this one table, so a fourth refusal status
// added later needs ONE row here rather than four scattered edits.
// ===========================================================================

/** @type {ReadonlyArray<{ status: string, headingKey: string, bodyKey: string, token: string }>} */
const REFUSAL_FAMILIES = Object.freeze([
	{
		status: 'unknown',
		headingKey: 'bootstrap.errorCodeNotRecognizedHeading',
		bodyKey: 'bootstrap.errorCodeNotRecognizedBody',
		// Re-checking the paste is the ONLY action that is right here and wrong
		// for the other two -- a typo produces exactly this answer.
		token: 'typo',
	},
	{
		status: 'used',
		headingKey: 'bootstrap.errorCodeAlreadyUsedHeading',
		bodyKey: 'bootstrap.errorCodeAlreadyUsedBody',
		// The fact that makes retrying pointless, as opposed to merely unlucky.
		token: 'only once',
	},
	{
		status: 'expired',
		headingKey: 'bootstrap.errorCodeTimedOutHeading',
		bodyKey: 'bootstrap.errorCodeTimedOutBody',
		// Promptness: for a spent code delay is irrelevant, for a timed-out one
		// delay is the whole cause. That is the genuinely different instruction.
		token: 'right away',
	},
]);

test('D-25: every refusal heading and body resolves to a non-empty string carrying no residual {{', () => {
	for (const family of REFUSAL_FAMILIES) {
		for (const key of [family.headingKey, family.bodyKey]) {
			const value = t(key);
			assert.ok(value.length > 0, `expected ${key} to resolve non-empty`);
			assert.ok(
				!value.includes('{{'),
				`${key} must carry no {{placeholder}} -- t() throws on an unresolved one, and this web bundle has no span value to interpolate (contract C4): "${value}"`,
			);
		}
	}
});

test('D-25: the three refusal HEADINGS are pairwise different', () => {
	const seen = new Map();
	for (const family of REFUSAL_FAMILIES) {
		const value = t(family.headingKey);
		const collidesWith = seen.get(value);
		assert.equal(
			collidesWith,
			undefined,
			`${family.headingKey} and ${collidesWith} resolve to the SAME text ("${value}") -- two refusal conditions would read identically`,
		);
		seen.set(value, family.headingKey);
	}
	assert.equal(seen.size, 3, `expected 3 distinct headings, observed ${seen.size}`);
});

test('D-25: the three refusal BODIES are pairwise different', () => {
	const seen = new Map();
	for (const family of REFUSAL_FAMILIES) {
		const value = t(family.bodyKey);
		const collidesWith = seen.get(value);
		assert.equal(
			collidesWith,
			undefined,
			`${family.bodyKey} and ${collidesWith} resolve to the SAME text ("${value}") -- two refusal conditions would read identically`,
		);
		seen.set(value, family.bodyKey);
	}
	assert.equal(seen.size, 3, `expected 3 distinct bodies, observed ${seen.size}`);
});

test('D-25: each refusal body carries its OWN action token and neither of the other two -- three sentences, three next actions', () => {
	for (const family of REFUSAL_FAMILIES) {
		const body = t(family.bodyKey).toLowerCase();
		assert.ok(
			body.includes(family.token),
			`${family.bodyKey} must name its own action token "${family.token}": "${t(family.bodyKey)}"`,
		);
		for (const other of REFUSAL_FAMILIES) {
			if (other === family) continue;
			assert.ok(
				!body.includes(other.token),
				`${family.bodyKey} contains "${other.token}", which belongs to ${other.bodyKey} -- the two families give the same next action`,
			);
		}
	}
});

/** Every file under `src/`, so the conflated-sentence check below covers the
 * whole surface the behavior bullet names -- not just the copy table. A
 * comment quoting the old sentence would re-introduce it as searchable text
 * and is deliberately caught too. */
function walkSrc(/** @type {string} */ dir) {
	/** @type {string[]} */
	const out = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name === 'node_modules' || entry.name === 'dist') continue;
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) out.push(...walkSrc(full));
		else out.push(full);
	}
	return out;
}

test('D-25: the conflated sentence is REPLACED, not supplemented -- "already been used" appears in no file under src/', () => {
	const copyFile = path.join(APP_ROOT, 'src', 'i18n', 'copy.js');
	// Positive control FIRST: the same substring matcher, on the same file,
	// finds a string that IS present. Without this, a matcher that silently
	// stopped working (wrong path, empty read) would report a green pass.
	assert.ok(
		readFileSync(copyFile, 'utf8').includes('Try another code'),
		'matcher is inert -- the "Try another code" positive control was not found in copy.js',
	);
	const offenders = walkSrc(path.join(APP_ROOT, 'src')).filter((/** @type {string} */ file) =>
		readFileSync(file, 'utf8').includes('already been used'),
	);
	assert.deepEqual(
		offenders.map((/** @type {string} */ f) => path.relative(APP_ROOT, f)),
		[],
		'the conflated sentence fragment "already been used" survives -- the old string must be replaced, not moved under a new key or quoted back into a comment',
	);
});

test('D-25: bootstrap.errorInvalidCodeCta survives -- VERIFICATION_KEYS and SCHEMA_MISMATCH_KEYS borrow it', () => {
	assert.ok('bootstrap.errorInvalidCodeCta' in COPY);
	assert.ok(t('bootstrap.errorInvalidCodeCta').length > 0);
});

test('D-25: bootstrap.errorInvalidCodeBody now answers the LOCAL malformed-paste case only', () => {
	const body = t('bootstrap.errorInvalidCodeBody');
	assert.ok(
		!body.toLowerCase().includes('already been used'),
		`errorInvalidCodeBody must not answer a refusal it cannot know about: "${body}"`,
	);
	// A code that never left the browser cannot have gone stale or been spent,
	// so the only honest next action is a local one: re-copy and re-paste.
	assert.ok(body.toLowerCase().includes('paste'), `expected a local next action in: "${body}"`);
});

// ---------------------------------------------------------------------------
// D-25 selection: the status the service answered picks the family.
//
// Each rejection below asserts the REASON in the thrown message and is paired,
// in the same test, with a call that SUCCEEDS -- so a `copyKeysForOutcome`
// that threw unconditionally could not pass any of them.
// ---------------------------------------------------------------------------

test('D-25: the three redemption statuses select three DIFFERENT copy families', () => {
	const selected = REFUSAL_FAMILIES.map((family) => ({
		status: family.status,
		keys: copyKeysForOutcome('code-refused', undefined, family.status),
	}));
	for (const { status, keys } of selected) {
		const expected = REFUSAL_FAMILIES.find((f) => f.status === status);
		assert.ok(expected, `no declared family for status "${status}"`);
		assert.equal(keys.headingKey, expected.headingKey, `status "${status}" selected the wrong heading key`);
		assert.equal(keys.bodyKey, expected.bodyKey, `status "${status}" selected the wrong body key`);
	}
	const headingKeys = new Set(selected.map((s) => s.keys.headingKey));
	const bodyKeys = new Set(selected.map((s) => s.keys.bodyKey));
	assert.equal(headingKeys.size, 3, `expected 3 distinct heading keys, observed ${[...headingKeys].join(', ')}`);
	assert.equal(bodyKeys.size, 3, `expected 3 distinct body keys, observed ${[...bodyKeys].join(', ')}`);
});

test('D-25: copyKeysForOutcome("code-refused") with NO status throws naming the outcome and the requirement -- never a silent fall back to the generic copy', () => {
	// Positive control in the same test: the identical call WITH a status
	// succeeds, so this cannot pass by the function being broken outright.
	assert.deepEqual(copyKeysForOutcome('code-refused', undefined, 'unknown'), {
		headingKey: 'bootstrap.errorCodeNotRecognizedHeading',
		bodyKey: 'bootstrap.errorCodeNotRecognizedBody',
		ctaKey: 'bootstrap.errorInvalidCodeCta',
	});
	assert.throws(
		() => copyKeysForOutcome('code-refused'),
		(err) =>
			err instanceof Error &&
			err.message.includes('code-refused') &&
			/requires a status/.test(err.message),
		'a code-refused with no status must be a LOUD programming error -- defaulting would re-conflate all three refusals invisibly',
	);
});

test('D-25: copyKeysForOutcome("code-refused", undefined, "ok") throws -- an ok status is not a refusal', () => {
	assert.doesNotThrow(() => copyKeysForOutcome('code-refused', undefined, 'used'));
	assert.throws(
		() => copyKeysForOutcome('code-refused', undefined, 'ok'),
		(err) => err instanceof Error && err.message.includes('"ok"') && /not a refusal/.test(err.message),
	);
});

test('D-25: copyKeysForOutcome("code-refused", undefined, <unmapped>) throws NAMING the offending value', () => {
	assert.doesNotThrow(() => copyKeysForOutcome('code-refused', undefined, 'expired'));
	assert.throws(
		() => copyKeysForOutcome('code-refused', undefined, 'not-a-status'),
		(err) => err instanceof Error && err.message.includes('not-a-status'),
	);
});

test('D-25: every other outcome is unchanged -- only the code-refused arm moved', () => {
	const invalid = { headingKey: 'bootstrap.errorInvalidCodeHeading', bodyKey: 'bootstrap.errorInvalidCodeBody', ctaKey: 'bootstrap.errorInvalidCodeCta' };
	const transport = { headingKey: 'bootstrap.errorTransportHeading', bodyKey: 'bootstrap.errorTransportBody', ctaKey: 'bootstrap.errorTransportCta' };
	const verification = { headingKey: 'snapshot.errorVerificationHeading', bodyKey: 'snapshot.errorVerificationBody', ctaKey: 'bootstrap.errorInvalidCodeCta' };
	const schema = { headingKey: 'snapshot.errorSchemaMismatchHeading', bodyKey: 'snapshot.errorSchemaMismatchBody', ctaKey: 'bootstrap.errorInvalidCodeCta' };

	assert.deepEqual(copyKeysForOutcome('invalid-code'), invalid);
	assert.deepEqual(copyKeysForOutcome('already-bootstrapped'), invalid);
	assert.deepEqual(copyKeysForOutcome('verify-failed', 'network-hash-mismatch'), invalid);
	assert.deepEqual(copyKeysForOutcome('transport-unreachable'), transport);
	assert.deepEqual(copyKeysForOutcome('restore-incomplete'), verification);
	assert.deepEqual(copyKeysForOutcome('officer-indeterminate'), schema);
	for (const reason of ['malformed-envelope', 'manifest-mismatch', 'digest-mismatch']) {
		assert.deepEqual(copyKeysForOutcome('verify-failed', reason), verification, `verify-failed/${reason}`);
	}
	for (const reason of ['format-version-mismatch', 'schema-hash-mismatch', 'non-canonical-generated-at']) {
		assert.deepEqual(copyKeysForOutcome('verify-failed', reason), schema, `verify-failed/${reason}`);
	}
	assert.throws(() => copyKeysForOutcome('ok'), /has no error copy/);
	assert.throws(() => copyKeysForOutcome('not-a-real-outcome'), /unmapped outcome/);
});

// ---------------------------------------------------------------------------
// The machine-identifier gate (T-52-12-01).
//
// SCOPE: exactly the copy `copyKeysForOutcome` can produce -- enumerated by
// WALKING the outcome / reason / status space, never from a hand-written key
// list, so a twelfth key added later is covered the day it is added.
//
// NOT the whole COPY table, deliberately: `network.swapErrorBody` belongs to
// DashboardShell's swap banner (a family reached through `swapError`, never
// through `copyKeysForOutcome`) and legitimately contains the word "used" in
// ordinary English. A table-wide ban would be unsatisfiable without editing a
// string this plan has no business editing.
//
// The forbidden token list is DERIVED: every BOOTSTRAP_OUTCOME_CODES member
// (all hyphenated, so no false positives) plus the three refusal statuses.
// `'ok'` is deliberately excluded -- a two-letter substring match fires on
// ordinary prose ("looks", "broken"), and a check that cries wolf is a check
// that gets deleted.
// ---------------------------------------------------------------------------

const ALL_VERIFY_REASONS_FOR_GATE = Object.freeze([
	'malformed-envelope',
	'format-version-mismatch',
	'non-canonical-generated-at',
	'network-hash-mismatch',
	'schema-hash-mismatch',
	'manifest-mismatch',
	'digest-mismatch',
]);

/** Every (key, value) pair reachable through copyKeysForOutcome. */
function reachableCopy() {
	/** @type {Array<[string, string]>} */
	const pairs = [];
	const collect = (/** @type {{ headingKey: string, bodyKey: string, ctaKey: string }} */ keys) => {
		for (const key of [keys.headingKey, keys.bodyKey, keys.ctaKey]) pairs.push([key, t(key)]);
	};
	for (const outcome of BOOTSTRAP_OUTCOME_CODES) {
		if (outcome === 'ok') continue;
		if (outcome === 'verify-failed') {
			for (const reason of ALL_VERIFY_REASONS_FOR_GATE) collect(copyKeysForOutcome(outcome, reason));
			continue;
		}
		if (outcome === 'code-refused') {
			for (const status of REFUSAL_FAMILIES.map((f) => f.status)) collect(copyKeysForOutcome(outcome, undefined, status));
			continue;
		}
		collect(copyKeysForOutcome(outcome));
	}
	return pairs;
}

test('D-25: copyKeysForOutcome is TOTAL over the whole outcome/reason/status space -- every key resolves through t()', () => {
	const pairs = reachableCopy();
	assert.ok(pairs.length >= 11, `expected at least 11 reachable (key, value) pairs, observed ${pairs.length}`);
	const distinctKeys = new Set(pairs.map(([key]) => key));
	assert.ok(distinctKeys.size >= 11, `expected at least 11 distinct reachable keys, observed ${distinctKeys.size}`);
	for (const [key, value] of pairs) {
		assert.equal(typeof value, 'string', `${key} did not resolve to a string`);
		assert.ok(value.length > 0, `${key} resolved empty`);
	}
});

test('T-52-12-01: no copy an officer can reach through copyKeysForOutcome contains a machine identifier', () => {
	const forbidden = [...BOOTSTRAP_OUTCOME_CODES.filter((code) => code !== 'ok'), 'unknown', 'expired', 'used'];

	// POSITIVE CONTROL FIRST: the matcher fires on a fixture that DOES contain
	// one. Without this, a matcher broken to always-false would report green
	// over the whole space.
	const fixture = 'Sorry, the service answered unknown for that code.';
	const fixtureHits = forbidden.filter((token) => fixture.toLowerCase().includes(token));
	assert.deepEqual(fixtureHits, ['unknown'], 'matcher is inert -- the positive-control fixture did not trip it');

	for (const [key, value] of reachableCopy()) {
		const lowered = value.toLowerCase();
		for (const token of forbidden) {
			assert.ok(
				!lowered.includes(token),
				`COPY.${key} leaks the machine identifier "${token}" into text an officer reads: "${value}"`,
			);
		}
	}
});

// ---------------------------------------------------------------------------
// Source-level wiring for the .tsx (`node --test` cannot import it) -- the
// idiom `bootstrap-redemption.test.mjs` already established. Both matchers are
// paired with an inertness control.
// ---------------------------------------------------------------------------

const BOOTSTRAP_TSX_SOURCE = readFileSync(path.join(APP_ROOT, 'src', 'screens', 'Bootstrap.tsx'), 'utf8');
const BOOTSTRAP_TSX_CODE = BOOTSTRAP_TSX_SOURCE.split('\n')
	.filter((line) => {
		const trimmed = line.trim();
		return !(trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*'));
	})
	.join('\n');

test('D-25 wiring: Bootstrap.tsx passes the status as the THIRD argument to copyKeysForOutcome', () => {
	// Positive control: the file really was read and really is the screen.
	assert.ok(
		BOOTSTRAP_TSX_CODE.includes('export function Bootstrap('),
		'matcher is inert -- Bootstrap.tsx was not read (wrong path or empty file)',
	);
	assert.ok(
		BOOTSTRAP_TSX_CODE.includes('copyKeysForOutcome(state.outcome, state.reason, state.status)'),
		'Bootstrap.tsx must plumb the redemption status into the copy lookup -- without it every refusal renders the same family',
	);
});

test('inertness control: the three-argument matcher does NOT accept the old two-argument call', () => {
	const fixture = "const errorCopy = copyKeysForOutcome(state.outcome, state.reason);";
	assert.ok(
		!fixture.includes('copyKeysForOutcome(state.outcome, state.reason, state.status)'),
		'matcher is inert -- it accepted the pre-plan two-argument call site',
	);
});

test('D-25 wiring: ScreenState\'s error variant declares the optional status field', () => {
	assert.match(BOOTSTRAP_TSX_CODE, /kind: 'error';[^}]*status\?: string/);
	// Inertness control: a variant WITHOUT the field must not match.
	assert.doesNotMatch("| { kind: 'error'; outcome: string; reason?: string }", /kind: 'error';[^}]*status\?: string/);
});
