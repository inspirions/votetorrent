/**
 * Tier-1 assertions over `src/i18n/copy.js`'s `COPY` table and `t()` helper.
 *
 * Browser-free, no display -- plain node:test. Each test below corresponds 1:1 to a
 * `<behavior>` bullet in 50-04-PLAN.md Task 2.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { COPY, t } = await import('../../src/i18n/copy.js');
const { BOOTSTRAP_PHASES } = await import('../../src/lifecycle/bootstrap.js');

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
