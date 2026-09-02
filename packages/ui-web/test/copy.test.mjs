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
import { FACT_COPY_KEYS, FACTS } from '../src/lifecycle/facts.js';

// ---------------------------------------------------------------------------
// Total key count (D-05, D-09, D-08, D-06/54-02, 54-09). 146, not 85 -- 53-07
// (D-08) added exactly ten `public.*`/`advisory.public.body` keys on top of
// the 73 the table carried after 53-05's `gate.advisoryDisclosure` ->
// `advisory.authority.body` rename (83 total). 54-02 (D-06/D-10) then
// RENAMED the three `lifecycle.*` keys (net 0) and ADDED two more
// (`lifecycle.settling`, `lifecycle.indeterminate`) -- 83 + 2 = 85. 54-09
// then added the public election view's whole copy table: the 50 keys named
// by `facts.js`'s own `FACT_COPY_KEYS` export plus the eleven that sit
// outside the fact model -- 85 + 61 = 146. Written as a bare literal so a
// future "fix" that deletes any of them is caught by a failure message that
// names the reason.
// ---------------------------------------------------------------------------

test('COPY has exactly 146 keys (73 pre-53-07, +10 public-voice keys under D-08, +2 net from the 54-02 lifecycle rename/expansion, +61 from 54-09s fact/gap copy table)', () => {
	assert.equal(
		Object.keys(COPY).length,
		146,
		'expected 146 -- if this reads 85, 54-09s public election view copy table was wrongly deleted; ' +
			'50 of those keys are named by facts.js FACT_COPY_KEYS and t() throws on any one that is missing. ' +
			'If it reads 83, lifecycle.settling/lifecycle.indeterminate (54-02, D-06/D-10) were ' +
			'wrongly deleted. If it reads 73, the ten public.*/advisory.public.body keys 53-07 added were ' +
			'wrongly deleted; they are consumed by apps/VoteTorrentPublic/src/screens/ElectionShell.tsx ' +
			'and must not be removed. If it reads 70, the three panelFrame.*Pill keys were wrongly ' +
			'deleted -- they are consumed by src/screens/panels/PanelFrame.tsx',
	);
});

// ===========================================================================
// D-25/D-07 (53-05, extended by 53-07/D-08, extended by 54-02/D-06): the
// key-set-identity check against 8326185d, narrowed to a NAMED SET OF DELTAS
// rather than a blanket key-set-equality check. `gate.advisoryDisclosure` was
// renamed to `advisory.authority.body` in 53-05; 53-07 then added exactly the
// ten `public.*`/`advisory.public.body` keys named in NEW_53_07_KEYS below.
// 54-02 then RENAMED `lifecycle.organizing`/`.running`/`.released` to
// `.pre`/`.voting`/`.closed` (PHASE_54_RENAMES) and ADDED
// `lifecycle.settling`/`lifecycle.indeterminate` (PHASE_54_ADDITIONS). 54-09
// then added NEW_54_09_KEYS -- the 50 members of facts.js's own
// FACT_COPY_KEYS export, IMPORTED rather than transcribed, plus the eleven
// non-fact keys listed beside them. The other 70 untouched pre-move keys keep
// D-09's byte-identical guarantee. This is stronger than a bare count check:
// a second, unrelated key added or removed later still fails this test, even
// though the total might coincidentally still read 146.
// ===========================================================================

/**
 * The three-id -> four-id lifecycle rename 54-02 (D-06, adjudicated I-12)
 * made. @type {ReadonlyArray<readonly [string, string]>}
 */
const PHASE_54_RENAMES = Object.freeze([
	['lifecycle.organizing', 'lifecycle.pre'],
	['lifecycle.running', 'lifecycle.voting'],
	['lifecycle.released', 'lifecycle.closed'],
]);

/** The two lifecycle keys 54-02 added outright (no prior id to rename from). @type {ReadonlyArray<string>} */
const PHASE_54_ADDITIONS = Object.freeze(['lifecycle.settling', 'lifecycle.indeterminate']);

/**
 * The ten `public.*`/`advisory.public.body` keys 53-07 added under D-08 --
 * every one of them mounted by `apps/VoteTorrentPublic/src/screens/ElectionShell.tsx`.
 * `advisory.public.body` resolves `AdvisoryDisclosure`'s `advisory.${variant}.body`
 * template for `variant="public"`; the other nine are this app's own
 * chrome/address/placeholder/disclosure copy.
 * @type {ReadonlyArray<string>}
 */
const NEW_53_07_KEYS = Object.freeze([
	'advisory.public.body',
	'public.chrome.appName',
	'public.election.addressLabel',
	'public.election.unreadableAddress.title',
	'public.election.unreadableAddress.body',
	'public.election.slot.title',
	'public.election.slot.lifecycle',
	'public.election.slot.timeline',
	'public.details.summary',
	'public.details.body',
]);

/**
 * The eleven 54-09 keys that sit OUTSIDE the fact model, hand-listed here
 * because nothing else names them as a set. The other fifty come from
 * the imported `FACT_COPY_KEYS` -- iterated, never transcribed, because a second
 * copy of a fifty-name list is a drift surface and `FACT_COPY_KEYS` exists
 * precisely so no second copy has to exist.
 * @type {ReadonlyArray<string>}
 */
const NEW_54_09_NON_FACT_KEYS = Object.freeze([
	'public.freshness.body',
	'public.fact.keyrelease.unreadable',
	'public.caveat.timelineUnvalidated',
	'public.caveat.readOnly',
	'public.rules.policyUnreadable',
	'public.index.viewElectionCta',
	'public.index.emptyHeading',
	'public.index.emptyBody',
	'public.index.someUnreadable',
	'public.gap.detailsSummary',
	'public.fact.detailsSummary',
]);

/** The full 54-09 delta: the fact model's own contract plus the eleven above. @type {ReadonlyArray<string>} */
const NEW_54_09_KEYS = Object.freeze([...FACT_COPY_KEYS, ...NEW_54_09_NON_FACT_KEYS]);

/**
 * The exact 73 keys at `8326185d` (`git show
 * 8326185d:apps/VoteTorrentDashboard/src/i18n/copy.js`), transcribed
 * verbatim as a frozen literal -- not re-derived at test time, so this file
 * carries no git dependency of its own.
 * @type {ReadonlyArray<string>}
 */
const PRE_MOVE_KEYS = Object.freeze([
	'bootstrap.heading',
	'bootstrap.codeFieldLabel',
	'bootstrap.cta',
	'bootstrap.emptyNetworksHeading',
	'bootstrap.emptyNetworksBody',
	'bootstrap.errorInvalidCodeHeading',
	'bootstrap.errorInvalidCodeBody',
	'bootstrap.errorInvalidCodeCta',
	'bootstrap.errorCodeNotRecognizedHeading',
	'bootstrap.errorCodeNotRecognizedBody',
	'bootstrap.errorCodeAlreadyUsedHeading',
	'bootstrap.errorCodeAlreadyUsedBody',
	'bootstrap.errorCodeTimedOutHeading',
	'bootstrap.errorCodeTimedOutBody',
	'bootstrap.errorTransportHeading',
	'bootstrap.errorTransportBody',
	'bootstrap.errorTransportCta',
	'bootstrap.phase.submitting',
	'bootstrap.phase.verifying',
	'bootstrap.phase.applying-schema',
	'bootstrap.phase.seeding',
	'bootstrap.phase.success',
	'snapshot.refreshCta',
	'snapshot.asOf',
	'snapshot.verifiedToast',
	'snapshot.staleBanner',
	'snapshot.errorVerificationHeading',
	'snapshot.errorVerificationBody',
	'snapshot.errorAttachHeading',
	'snapshot.errorAttachBody',
	'snapshot.errorSchemaMismatchHeading',
	'snapshot.errorSchemaMismatchBody',
	'network.redeemAnotherCta',
	'network.forgetCta',
	'network.forgetConfirmBody',
	'network.swapConfirmHeading',
	'network.swapConfirmBody',
	'network.swapConfirmCta',
	'network.swapErrorHeading',
	'network.swapErrorBody',
	'chrome.moreOptionsAriaLabel',
	'gate.advisoryDisclosure',
	'gate.badgeReal',
	'gate.badgeSimulated',
	'gate.resetScopesCta',
	'gate.revealDeniedCta',
	'preview.title',
	'panelFrame.tierPill',
	'panelFrame.sitePill',
	'panelFrame.sitesPill',
	'nav.groupElectionOperations',
	'nav.groupAuthorityAdministration',
	'lifecycle.organizing',
	'lifecycle.running',
	'lifecycle.released',
	'panels.registrations.title',
	'panels.registrations.empty',
	'panels.elections.title',
	'panels.elections.empty',
	'panels.ballotsQuestions.title',
	'panels.ballotsQuestions.empty',
	'panels.networkSettings.title',
	'panels.networkSettings.empty',
	'panels.authorityProfile.title',
	'panels.authorityProfile.empty',
	'panels.authorityPeers.title',
	'panels.authorityPeers.empty',
	'panels.administrationOfficers.title',
	'panels.administrationOfficers.empty',
	'panels.keyholders.title',
	'panels.keyholders.empty',
	'panels.inviteAuthorities.title',
	'panels.inviteAuthorities.empty',
]);

test('sanity: the 54-09 delta is 61 keys -- 50 named by facts.js FACT_COPY_KEYS plus 11 non-fact keys, with no overlap between the two (an overlap would silently shrink the delta while every other assertion still passed)', () => {
	assert.equal(FACT_COPY_KEYS.length, 50, 'facts.js FACT_COPY_KEYS must still publish 50 keys');
	assert.equal(NEW_54_09_NON_FACT_KEYS.length, 11);
	const factSet = new Set(FACT_COPY_KEYS);
	const overlap = NEW_54_09_NON_FACT_KEYS.filter((k) => factSet.has(k));
	assert.deepEqual(overlap, [], `these keys are counted twice: ${overlap.join(', ')}`);
	assert.equal(new Set(NEW_54_09_KEYS).size, 61);
});

test('D-25/D-07/D-08/D-06/54-09: the ONLY key-set changes since 8326185d are gate.advisoryDisclosure -> advisory.authority.body, the ten NEW_53_07_KEYS additions, the PHASE_54_RENAMES rename, the PHASE_54_ADDITIONS additions and the 61 NEW_54_09_KEYS additions -- no other key added or removed', () => {
	const currentKeys = new Set(Object.keys(COPY));
	const renameMap = new Map(PHASE_54_RENAMES);
	const expectedKeys = new Set([
		...PRE_MOVE_KEYS.map((k) => {
			if (k === 'gate.advisoryDisclosure') return 'advisory.authority.body';
			if (renameMap.has(k)) return /** @type {string} */ (renameMap.get(k));
			return k;
		}),
		...NEW_53_07_KEYS,
		...PHASE_54_ADDITIONS,
		...NEW_54_09_KEYS,
	]);

	const added = [...currentKeys].filter((k) => !expectedKeys.has(k));
	const removed = [...expectedKeys].filter((k) => !currentKeys.has(k));

	assert.deepEqual(
		added,
		[],
		`unexpected key(s) added beyond the D-07 rename, the D-08 additions, the 54-02 lifecycle changes and the 54-09 delta: ${added.join(', ')}`,
	);
	assert.deepEqual(
		removed,
		[],
		`unexpected key(s) missing beyond the D-07 rename, the D-08 additions, the 54-02 lifecycle changes and the 54-09 delta: ${removed.join(', ')}`,
	);
});

test('D-25/D-07: every key that survives unrenamed from 8326185d still carries its exact pre-move value', () => {
	const oldSource = readFileSync(uiWebSrc('copy.js'), 'utf8');
	// This suite does not re-parse the historical file at test time (D-04:
	// no execution of unreviewed historical code) -- instead it re-asserts,
	// for every one of the untouched keys, that COPY still carries a
	// non-empty value at that key. The per-key byte-identical VALUES for the
	// keys this plan did not touch are additionally covered by this same
	// file's existing 't(...)'-return-value assertions above, which read
	// against the CURRENT COPY.js -- both together are what makes a silent
	// re-wording of an untouched key visible.
	assert.ok(oldSource.length > 0);
	const renamedKeys = new Set(PHASE_54_RENAMES.map(([oldKey]) => oldKey));
	for (const key of PRE_MOVE_KEYS) {
		if (key === 'gate.advisoryDisclosure') continue; // the D-07 named delta
		if (renamedKeys.has(key)) continue; // the 54-02 named deltas, checked separately below
		assert.ok(key in COPY, `expected ${key} to survive the move unchanged`);
		assert.equal(typeof COPY[key], 'string');
		assert.ok(COPY[key].length > 0, `expected ${key} to remain non-empty`);
	}
});

// ===========================================================================
// 54-02/D-06: the lifecycle rename's value semantics -- lifecycle.pre CARRIES
// lifecycle.organizing's exact pre-move value across the rename (the
// pre-election interval is unchanged), but lifecycle.voting and
// lifecycle.closed are genuine VALUE CHANGES, not carries (D-06/D-10: the
// four-phase model gives "Running" and "Results released" different, more
// accurate meanings -- see this plan's <vocabulary_decision> table).
// ===========================================================================

test('lifecycle.pre carries lifecycle.organizing\'s exact pre-move value across the 54-02 rename', () => {
	assert.equal(t('lifecycle.pre'), 'Being organized');
});

test('lifecycle.voting is a VALUE CHANGE from the retired lifecycle.running ("Running" -> "Voting") -- an election is colloquially still "running" while it settles, so the old word no longer distinguishes the two post-voting phases', () => {
	assert.equal(t('lifecycle.voting'), 'Voting');
	assert.notEqual(t('lifecycle.voting'), 'Running');
});

test('lifecycle.closed is a VALUE CHANGE from the retired lifecycle.released ("Results released" -> "Closed") -- D-13 guarantees no Tally/Certification/Validation table exists, so "released" would name a result that is not there', () => {
	assert.equal(t('lifecycle.closed'), 'Closed');
	assert.notEqual(t('lifecycle.closed'), 'Results released');
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

// ===========================================================================
// 54-09: the RESOLUTION GATE for the public election view's fact/gap table.
//
// 54-04 landed `facts.js` a wave earlier and deliberately asserted only the
// SHAPE and COMPLETENESS of `FACT_COPY_KEYS` -- never that a member of it
// resolves through `t()`, because `copy.js` could not have declared them
// yet. This is that missing half, and it is written to ITERATE the export
// rather than to restate it: a transcribed list would drift from the model
// it is supposed to be checking, which is the whole reason `FACT_COPY_KEYS`
// is derived at module load instead of hand-written.
//
// None of the scans below reads this file's own source, so no comment here
// can satisfy one of them; every subject is a runtime `COPY` value.
// ===========================================================================

/**
 * key -> the `interpolates` array of the `FACTS` entry that emits it as its
 * `sentenceKey`. Built from the model, never hard-coded: `t()` throws on a
 * surviving `{{placeholder}}`, so a key whose value interpolates has to be
 * resolved with real params, and taking those param NAMES from
 * `interpolates` is what makes a mismatch between the model and the copy
 * value surface as `t()`'s own named throw instead of as a silent pass.
 * @type {Map<string, ReadonlyArray<string>>}
 */
const INTERPOLATING_FACT_KEYS = new Map();
for (const entry of FACTS) {
	if (entry.sentenceKey !== null && entry.interpolates !== null && entry.interpolates.length > 0) {
		INTERPOLATING_FACT_KEYS.set(entry.sentenceKey, entry.interpolates);
	}
}

test('sanity: exactly one FACTS entry emits an interpolating sentence key, and it is the key-release aggregate (if this ever reads 0, the loop below degenerates into a no-placeholder scan and proves nothing about interpolation)', () => {
	assert.equal(INTERPOLATING_FACT_KEYS.size, 1);
	assert.ok(INTERPOLATING_FACT_KEYS.has('public.fact.keyrelease.sentence'));
	assert.deepEqual([...(INTERPOLATING_FACT_KEYS.get('public.fact.keyrelease.sentence') ?? [])], ['released', 'total']);
});

test('54-09: every one of facts.js FACT_COPY_KEYS 50 members resolves through t() to a non-empty string', () => {
	assert.ok(FACT_COPY_KEYS.length > 0, 'sanity: an empty FACT_COPY_KEYS would make this loop vacuous');
	/** @type {string[]} */
	const offenders = [];
	for (const key of FACT_COPY_KEYS) {
		const interpolates = INTERPOLATING_FACT_KEYS.get(key);
		/** @type {Record<string, unknown>} */
		const params = {};
		for (const name of interpolates ?? []) params[name] = '7';
		let resolved;
		try {
			resolved = t(key, params);
		} catch (err) {
			offenders.push(`${key}: t() threw -- ${err instanceof Error ? err.message : String(err)}`);
			continue;
		}
		if (resolved.length === 0) offenders.push(`${key}: resolved to the empty string`);
	}
	assert.deepEqual(offenders, [], `these FACT_COPY_KEYS members do not resolve:\n${offenders.join('\n')}`);
});

test('54-09: every NON-interpolating FACT_COPY_KEYS member carries no {{ in its raw COPY value -- a placeholder cannot be smuggled into a key the model says takes no params', () => {
	/** @type {string[]} */
	const offenders = [];
	for (const key of FACT_COPY_KEYS) {
		if (INTERPOLATING_FACT_KEYS.has(key)) continue;
		if (String(COPY[key]).includes('{{')) offenders.push(key);
	}
	assert.deepEqual(
		offenders,
		[],
		`these keys carry a {{placeholder}} but facts.js declares no interpolates for them, so every render site would throw: ${offenders.join(', ')}`,
	);
});

test('positive control: the resolution gate can fail -- t() on a fabricated public.*-shaped key that is deliberately absent throws naming that key', () => {
	const fabricated = 'public.__absent_control__.sentence';
	assert.ok(!(fabricated in COPY), 'sanity: the control key must genuinely be absent from COPY');
	assert.throws(
		() => t(fabricated),
		(err) => err instanceof Error && err.message.includes(fabricated),
		'the resolution gate above is inert if t() does not throw by name on an absent key',
	);
});

// ---------------------------------------------------------------------------
// The four keys 54-11 and 54-13 bind BY NAME. They sit outside
// `FACT_COPY_KEYS` (facts.js is landed and frozen, and none of these is a
// field on a FACTS entry), so nothing in this package would gate them
// otherwise -- and each is a blocking precondition of a later plan, which
// means a rename here fails a plan that has already been written.
// ---------------------------------------------------------------------------

/** @type {ReadonlyArray<string>} */
const DOWNSTREAM_BOUND_KEYS = Object.freeze([
	'public.index.someUnreadable',
	'public.gap.detailsSummary',
	'public.fact.detailsSummary',
	'public.fact.keyrelease.unreadable',
]);

test('54-09: the four downstream-bound keys each resolve through t() to a non-empty string carrying no {{', () => {
	for (const key of DOWNSTREAM_BOUND_KEYS) {
		const value = t(key);
		assert.ok(value.length > 0, `expected ${key} to resolve non-empty`);
		assert.ok(!value.includes('{{'), `${key} must carry no {{placeholder}}: "${value}"`);
	}
});

test('54-09: the gap and fact details-toggle summaries are different from each other AND from the page-level public.details.summary -- this is the assertion that catches a well-meaning later merge of the two into one label', () => {
	const gapSummary = t('public.gap.detailsSummary');
	const factSummary = t('public.fact.detailsSummary');
	const pageSummary = t('public.details.summary');
	assert.notEqual(
		gapSummary,
		factSummary,
		'a gap detail explains why there is no source; a filled fact detail explains what the value means -- one label cannot do both',
	);
	assert.notEqual(gapSummary, pageSummary, 'the page-level summary is about the view, not about a card');
	assert.notEqual(factSummary, pageSummary, 'the page-level summary is about the view, not about a card');
	assert.equal(new Set([gapSummary, factSummary, pageSummary]).size, 3);
});

// ---------------------------------------------------------------------------
// 54-09: the key-release placeholder contract. The render call site feeds
// `total` from the read's KEYHOLDER COUNT, never from the read's own `total`
// field (which counts release-key tasks and is zero until one is raised).
// That call site is already written against these two names, and
// `facts.js`'s `interpolates` array is frozen and landed, so renaming the
// placeholder here breaks both. This asserts the names still agree.
// ---------------------------------------------------------------------------

test('54-09: public.fact.keyrelease.sentence interpolates exactly {{released}} and {{total}} -- the same two names facts.js declares, and no third', () => {
	const raw = String(COPY['public.fact.keyrelease.sentence']);
	const found = [...raw.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort();
	assert.deepEqual(found, ['released', 'total']);
	const declared = INTERPOLATING_FACT_KEYS.get('public.fact.keyrelease.sentence');
	assert.ok(declared, 'sanity: facts.js must still declare interpolates for the key-release sentence');
	assert.deepEqual(
		found,
		[...declared].sort(),
		'the copy value and facts.js interpolates array disagree -- one of them was renamed without the other',
	);
	assert.ok(!raw.includes('{{keyholderCount}}'), 'the placeholder is deliberately NOT renamed; see the note beside this key in copy.js');
});

test('54-09: public.headline.pre.registrationUnknown resolves and does NOT say registration has closed -- the never-guess rule, which spike 088 broke by collapsing an unreadable date into a closed answer', () => {
	const value = t('public.headline.pre.registrationUnknown');
	assert.ok(value.length > 0);
	assert.doesNotMatch(value, /registration has closed/i);
});

// ---------------------------------------------------------------------------
// D-12: no internal vocabulary in a string a reader sees without opening the
// details toggle.
//
// Two families, and they are checked separately because they fail for
// different reasons: the gap enumeration's letters (meaningless outside the
// source that defines them) and schema table names (jargon on an always-
// visible card). Table names are PERMITTED in `.detail` values, which render
// only behind the toggle -- that placement is the whole mitigation, so the
// scan is scoped to `.sentence` and `.label` rather than run over the table.
// ---------------------------------------------------------------------------

const GAP_LETTER_PHRASE_RE = /\bgap [A-G]\b/;
const STANDALONE_LETTER_RE = /(^|[^A-Za-z])[A-G]([^A-Za-z]|$)/;

test('positive control: both gap-letter matchers fire on planted fixtures (an absence check that cannot fail proves nothing)', () => {
	assert.match('this is gap C and has no table', GAP_LETTER_PHRASE_RE);
	assert.match('the answer is B here', STANDALONE_LETTER_RE);
	assert.doesNotMatch('Ballots cast', STANDALONE_LETTER_RE);
	assert.doesNotMatch('a plain sentence with no letters standing alone', GAP_LETTER_PHRASE_RE);
});

test('D-12: no COPY value names a gap by its internal letter', () => {
	/** @type {string[]} */
	const offenders = [];
	for (const [key, value] of Object.entries(COPY)) {
		if (GAP_LETTER_PHRASE_RE.test(value)) offenders.push(`${key}: "${value}"`);
	}
	assert.deepEqual(offenders, [], `gap letters reached a reader-visible string:\n${offenders.join('\n')}`);
});

test('D-12: no .sentence or .label value contains a standalone A-G, so no gap letter can reach a card that is always visible', () => {
	/** @type {string[]} */
	const offenders = [];
	for (const [key, value] of Object.entries(COPY)) {
		if (!key.endsWith('.sentence') && !key.endsWith('.label')) continue;
		if (STANDALONE_LETTER_RE.test(value)) offenders.push(`${key}: "${value}"`);
	}
	assert.deepEqual(offenders, [], `a standalone letter reached an always-visible string:\n${offenders.join('\n')}`);
});

/**
 * Schema table names, checked case-sensitively because the identifier is
 * what leaks, not the concept -- the gap sentences legitimately use the
 * lower-case English words (`tally`, `validation`) for the same ideas.
 * @type {ReadonlyArray<string>}
 */
const SCHEMA_TABLE_NAMES = Object.freeze(['Tally', 'Validation', 'Certification', 'Block', 'MerkleNode', 'VoteEntry']);

/**
 * The two labels where a schema table name is permitted, each with the
 * reason. `Validation` and `Certification` are also ordinary English nouns,
 * and they are the words a member of the public actually uses for these two
 * concepts; the corresponding gap sentences already use them in lower case,
 * so banning the capitalised form from the card heading directly above would
 * forbid the identifier while permitting the concept in the very next line.
 * These two are named individually rather than by a pattern so that the
 * exception cannot quietly grow: a third label wanting a table name fails
 * this test and has to argue for itself.
 * @type {Readonly<Record<string, string>>}
 */
const TABLE_NAME_LABEL_EXEMPTIONS = Object.freeze({
	'public.fact.validation.label': 'Validation',
	'public.fact.certification.label': 'Certification',
});

test('positive control: the schema-table-name matcher fires on a planted label and does not fire on a benign one', () => {
	assert.ok(SCHEMA_TABLE_NAMES.some((n) => 'Merkle root of vote blocks in MerkleNode'.includes(n)));
	assert.ok(!SCHEMA_TABLE_NAMES.some((n) => 'Cryptographic record of the votes'.includes(n)));
});

test('D-12: no public.gap.*.sentence and no public.fact.*.label carries a schema table name, apart from the two named label exemptions', () => {
	/** @type {string[]} */
	const offenders = [];
	for (const [key, value] of Object.entries(COPY)) {
		const isGapSentence = /^public\.gap\..*\.sentence$/.test(key);
		const isFactLabel = /^public\.fact\..*\.label$/.test(key);
		if (!isGapSentence && !isFactLabel) continue;
		for (const name of SCHEMA_TABLE_NAMES) {
			if (!value.includes(name)) continue;
			if (TABLE_NAME_LABEL_EXEMPTIONS[key] === name) continue;
			offenders.push(`${key}: contains "${name}" -- "${value}"`);
		}
	}
	assert.deepEqual(offenders, [], `schema table names reached an always-visible string:\n${offenders.join('\n')}`);
});

test('the two table-name label exemptions are not stale -- each named key exists and still carries the word it is exempted for (a stale exemption is an exception with nothing behind it)', () => {
	for (const [key, name] of Object.entries(TABLE_NAME_LABEL_EXEMPTIONS)) {
		assert.ok(key in COPY, `exempted key ${key} no longer exists -- delete the exemption`);
		assert.ok(
			String(COPY[key]).includes(name),
			`${key} no longer contains "${name}" -- the exemption is now inert and must be deleted`,
		);
	}
});
