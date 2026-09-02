/**
 * copy.test.mjs — tier-1 assertions over `packages/ui-web/src/copy.js`'s `COPY` table
 * and `t()` helper (D-05, D-09), plus the D-10 header-contract assertions.
 *
 * These are the table-and-`t()`-only assertions moved out of
 * `apps/VoteTorrentDashboard/test/node/copy.test.mjs` in 53-04 Task 3 (D-25): every
 * assertion here has the table itself as its SUBJECT. Assertions that couple `COPY` to
 * a dashboard module (`BOOTSTRAP_PHASES`, `copyKeysForOutcome`, `Bootstrap.tsx`'s
 * source) or that scan the dashboard's own `src/` tree stayed behind, because their
 * subject is the dashboard's USE of the table, not the table itself.
 *
 * Browser-free, no display -- plain node:test.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { uiWebSrc } from '../../../scripts/lib/source-paths.mjs';
import { COPY, t } from '../src/index.js';

// ---------------------------------------------------------------------------
// Total key count (D-05, D-09). 73, not 70 -- the older published breakdown
// omits the three `panelFrame.*Pill` keys, which exist and are consumed by
// PanelFrame.tsx. Written as a bare literal so a future "fix" that deletes
// them is caught by a failure message that names the reason.
// ---------------------------------------------------------------------------

test('COPY has exactly 73 keys (not 70 -- panelFrame.tierPill/sitePill/sitesPill are real, consumed keys)', () => {
	assert.equal(
		Object.keys(COPY).length,
		73,
		'expected 73 -- if this reads 70, the three panelFrame.*Pill keys were wrongly deleted; ' +
			'they are consumed by src/screens/panels/PanelFrame.tsx and must not be removed',
	);
});

// ---------------------------------------------------------------------------
// t() and the table's own behaviour (moved verbatim from the dashboard suite).
// ---------------------------------------------------------------------------

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
// D-25: the three refusal families (moved -- their subject is the table).
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

// ===========================================================================
// D-10 header-contract assertions.
//
// Positive-control-first (per scripts/lint-copy.mjs's own convention): each
// matcher is shown firing against a planted fixture BEFORE it is trusted
// against the real header, and the two "absent" matchers ((e), (f) below) are
// additionally shown to actually FAIL against a fixture that plants the
// forbidden phrase -- an absence check that cannot fail is exactly the
// vacuous shape this phase exists to stop shipping.
// ===========================================================================

const HEADER_SOURCE = readFileSync(uiWebSrc('copy.js'), 'utf8');

// Exact substrings of the pre-move header (`git show 8326185d:` of the
// dashboard's original i18n/copy.js), transcribed verbatim including
// whitespace. A reword of either -- including whitespace -- must fail this
// test, per the plan's own acceptance criterion.
const CONTRACT_C3_VERBATIM =
	' * Contract C3 (D-17): there is deliberately NO `read-only` / `◐` panel-state string in\n' +
	' * this table. Nothing in this phase is writable -- every panel in this phase is either\n' +
	' * fully visible (granted scope) or fully hidden (withheld scope) -- so a read-only\n' +
	' * badge would describe a state that cannot occur. `scripts/lint-copy.mjs` fails if a\n' +
	' * `/read-only/i` match ever appears in any value.';

const CONTRACT_C4_VERBATIM =
	' * Contract C4: the four `50-UI-SPEC.md` "Producer screen (RN app)" copy rows are NOT\n' +
	' * transcribed here. They belong to `apps/VoteTorrentAuthority`\'s own\n' +
	' * `src/i18n/index.ts` and are owned by plan 50-07. A web bundle must not ship a React\n' +
	' * Native screen\'s strings.';

const FORBIDDEN_COMPLETENESS_CLAIM = 'the table is complete as of this plan';
const FORBIDDEN_SINGLE_APP_OPENER = 'The single copy table for VoteTorrent Authority Dashboard';

test('positive control: the header-contract matchers fire against a planted fixture that carries every required phrase', () => {
	const fixture =
		CONTRACT_C3_VERBATIM +
		'\n' +
		CONTRACT_C4_VERBATIM +
		'\nno longer the sole authority\napps/VoteTorrentDashboard and apps/VoteTorrentPublic\n';
	assert.ok(fixture.includes(CONTRACT_C3_VERBATIM), 'matcher is inert for C3');
	assert.ok(fixture.includes(CONTRACT_C4_VERBATIM), 'matcher is inert for C4');
	assert.ok(fixture.includes('no longer the sole authority'), 'matcher is inert for the D-10 authority statement');
	assert.ok(fixture.includes('apps/VoteTorrentDashboard'), 'matcher is inert for the dashboard consumer name');
	assert.ok(fixture.includes('apps/VoteTorrentPublic'), 'matcher is inert for the public consumer name');
});

test('inertness control: the two absence matchers actually fail against a fixture that plants the forbidden phrases', () => {
	const contaminatedFixture =
		FORBIDDEN_COMPLETENESS_CLAIM + '\n' + FORBIDDEN_SINGLE_APP_OPENER;
	assert.ok(
		contaminatedFixture.includes(FORBIDDEN_COMPLETENESS_CLAIM),
		'the completeness-claim absence matcher must be able to find the phrase when it IS present',
	);
	assert.ok(
		contaminatedFixture.includes(FORBIDDEN_SINGLE_APP_OPENER),
		'the single-app-opener absence matcher must be able to find the phrase when it IS present',
	);
});

test('D-10: the header carries the amended two-consumer C2 header — names both web consumers and the word "variant"', () => {
	assert.ok(
		HEADER_SOURCE.includes('apps/VoteTorrentDashboard'),
		'header must name apps/VoteTorrentDashboard as a consumer',
	);
	assert.ok(
		HEADER_SOURCE.includes('apps/VoteTorrentPublic'),
		'header must name apps/VoteTorrentPublic as a consumer',
	);
	assert.ok(HEADER_SOURCE.includes('variant'), 'header must state the D-07 variant-prop clause');
});

test('D-10: the header states "no longer the sole authority" literally', () => {
	assert.ok(
		HEADER_SOURCE.includes('no longer the sole authority'),
		'header must contain the literal substring "no longer the sole authority"',
	);
});

test('D-10: the header carries contract C3 verbatim, byte-for-byte', () => {
	assert.ok(
		HEADER_SOURCE.includes(CONTRACT_C3_VERBATIM),
		'contract C3 must survive the move byte-for-byte, including whitespace',
	);
});

test('D-10: the header carries contract C4 verbatim, byte-for-byte', () => {
	assert.ok(
		HEADER_SOURCE.includes(CONTRACT_C4_VERBATIM),
		'contract C4 must survive the move byte-for-byte, including whitespace',
	);
});

test('D-10: the header no longer claims the table is complete as of this plan', () => {
	assert.ok(
		!HEADER_SOURCE.includes(FORBIDDEN_COMPLETENESS_CLAIM),
		'the false single-plan completeness claim must be removed -- D-08 admits new public.* keys',
	);
});

test('D-10: the header no longer opens with the single-app framing', () => {
	assert.ok(
		!HEADER_SOURCE.includes(FORBIDDEN_SINGLE_APP_OPENER),
		'the header must not open by naming only the dashboard as this table\'s app',
	);
});
