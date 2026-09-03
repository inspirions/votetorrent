/**
 * election-shell.test.mjs — the eleven lettered assertions from 53-07 Task 2
 * over `src/screens/ElectionShell.tsx` and its neighbours. Every path is
 * resolved through `scripts/lib/source-paths.mjs`'s `publicSrc()`/
 * `publicRoot()` and `uiWebSrc()` (D-25/53-01) — never re-derived from
 * `import.meta.url`. Every matcher gets a planted-fixture positive control
 * BEFORE it runs against real source, per this repo's own standing rule
 * that a comment merely DISCUSSING a forbidden term must never trip a
 * matcher (so every scan below strips comment lines first).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { publicSrc, publicRoot, uiWebSrc, uiWebRoot } from '../../../../scripts/lib/source-paths.mjs';
import { COPY } from '../../../../packages/ui-web/src/index.js';
import { FACT_COPY_KEYS } from '../../../../packages/ui-web/src/lifecycle/facts.js';
import { ELECTION_ADDRESS_PARAM, NETWORK_ADDRESS_PARAM } from '../../src/election-address.js';

/** @param {string} source @returns {string} */
function stripCommentLines(source) {
	return source
		.split('\n')
		.filter((line) => {
			const trimmed = line.trim();
			return !(trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*'));
		})
		.join('\n');
}

/** @param {string} dir @returns {string[]} */
function walkAll(dir) {
	/** @type {string[]} */
	const out = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			out.push(...walkAll(full));
		} else {
			out.push(full);
		}
	}
	return out;
}

const SHELL_PATH = publicSrc('screens', 'ElectionShell.tsx');
const SHELL_SOURCE_RAW = readFileSync(SHELL_PATH, 'utf8');
const SHELL_SOURCE = stripCommentLines(SHELL_SOURCE_RAW);

// ---------------------------------------------------------------------------
// 1. Single return.
// ---------------------------------------------------------------------------

/** @param {string} source @returns {number} */
function countReturns(source) {
	return (source.match(/\breturn\b/g) ?? []).length;
}

test('positive control: the single-return matcher fires (counts 2) on a planted two-return fixture', () => {
	const fixture = 'function Foo() {\n\tif (x) {\n\t\treturn null;\n\t}\n\treturn <div />;\n}';
	assert.equal(countReturns(fixture), 2, 'matcher is inert against a planted two-return fixture');
});

test('ElectionShell.tsx contains exactly one `return` statement', () => {
	assert.equal(countReturns(SHELL_SOURCE), 1, 'expected exactly one return statement in ElectionShell.tsx');
});

// ---------------------------------------------------------------------------
// 2. Genuine mounts.
// ---------------------------------------------------------------------------

test('ElectionShell.tsx mounts <LifecyclePill, <AdvisoryDisclosure and <DetailsToggle each exactly once, with the literal variant="public"', () => {
	assert.equal((SHELL_SOURCE.match(/<LifecyclePill\b/g) ?? []).length, 1);
	assert.equal((SHELL_SOURCE.match(/<AdvisoryDisclosure\b/g) ?? []).length, 1);
	assert.equal((SHELL_SOURCE.match(/<DetailsToggle\b/g) ?? []).length, 1);
	assert.match(SHELL_SOURCE, /variant="public"/, 'expected the literal variant="public" (not a variable) so a grep can see it');
});

// ---------------------------------------------------------------------------
// 3. The toggle is never wrapped around the advisory.
// ---------------------------------------------------------------------------

/** @param {string} source @returns {boolean} true if <AdvisoryDisclosure appears between a <DetailsToggle open tag and its matching close tag. */
function advisoryNestedInToggle(source) {
	const openIdx = source.indexOf('<DetailsToggle');
	if (openIdx === -1) return false;
	const closeIdx = source.indexOf('</DetailsToggle>', openIdx);
	if (closeIdx === -1) return false;
	const between = source.slice(openIdx, closeIdx);
	return between.includes('<AdvisoryDisclosure');
}

test('positive control: the nesting matcher fires on a planted <DetailsToggle>...<AdvisoryDisclosure />...</DetailsToggle> fixture', () => {
	const fixture = '<DetailsToggle summary="x"><AdvisoryDisclosure variant="public" /></DetailsToggle>';
	assert.ok(advisoryNestedInToggle(fixture), 'matcher is inert against a planted nested fixture');
});

test('ElectionShell.tsx never nests <AdvisoryDisclosure inside <DetailsToggle (D-16 consumer-side half)', () => {
	assert.equal(advisoryNestedInToggle(SHELL_SOURCE), false);
});

// ---------------------------------------------------------------------------
// 4. A hook-calling component is mounted — classified by NAME, not
//    hard-coded to DetailsToggle.
// ---------------------------------------------------------------------------

const HOOK_CALL_RE = /\buse[A-Z]\w*\(/;

/** @param {string} name @returns {string} the .tsx source of a component re-exported from components.js by that name. */
function readComponentSource(name) {
	return stripCommentLines(readFileSync(uiWebSrc('components', `${name}.tsx`), 'utf8'));
}

/** @returns {string[]} every component name re-exported from packages/ui-web/src/components.js. */
function listExportedComponentNames() {
	const barrel = stripCommentLines(readFileSync(uiWebSrc('components.js'), 'utf8'));
	const names = [];
	const re = /export\s*\{\s*(\w+)\s*\}\s*from\s*'\.\/components\/\1\.js'/g;
	let m;
	while ((m = re.exec(barrel))) names.push(m[1]);
	return names;
}

test('positive control: the hook-call classifier identifies a planted useState( fixture as hook-calling and a planted hook-free fixture as not', () => {
	assert.match('function X() { const [a, setA] = useState(0); return null; }', HOOK_CALL_RE);
	assert.doesNotMatch('function X() { return null; }', HOOK_CALL_RE);
});

test('at least one hook-calling component re-exported from components.js has its JSX tag mounted in ElectionShell.tsx', () => {
	const names = listExportedComponentNames();
	assert.ok(names.length > 0, 'sanity: components.js must re-export at least one component');
	const classified = names.map((name) => ({ name, hookCalling: HOOK_CALL_RE.test(readComponentSource(name)) }));
	const hookCallingNames = classified.filter((c) => c.hookCalling).map((c) => c.name);
	const nonHookCallingNames = classified.filter((c) => !c.hookCalling).map((c) => c.name);
	assert.ok(hookCallingNames.length > 0, `no hook-calling component found among: ${JSON.stringify(classified)}`);
	const mountedHookCalling = hookCallingNames.filter((name) => SHELL_SOURCE.includes(`<${name}`));
	assert.ok(
		mountedHookCalling.length > 0,
		`ElectionShell.tsx mounts none of the classified hook-calling components (${hookCallingNames.join(', ')}); ` +
			`non-hook-calling set was (${nonHookCallingNames.join(', ')})`,
	);
});

// ---------------------------------------------------------------------------
// 5. No dangerouslySetInnerHTML anywhere under src/ or test/.
// ---------------------------------------------------------------------------

const RAW_HTML_ESCAPE_HATCH_RE = /dangerouslySetInnerHTML/;

test('positive control: the raw-HTML-injection matcher fires on a planted occurrence', () => {
	assert.match('<div dangerouslySetInnerHTML={{ __html: x }} />', RAW_HTML_ESCAPE_HATCH_RE);
});

test('no file under src/ or test/ (excluding test/node/*.test.mjs, whose own positive-control fixture literally plants the sentinel) uses the raw-HTML-injection escape hatch', () => {
	// test/node/ is this app's OWN scanner tooling — this very file, and
	// app-shape.test.mjs, each plant the sentinel string as a positive-control
	// fixture literal (never as real JSX usage), so excluding that one
	// directory is what keeps this check from permanently self-tripping on
	// its own control. The real subject of this scan is application code
	// (src/) and any browser-harness/fixture code Task 3 adds under
	// test/browser/ and test/fixtures/ — neither of which may plant the
	// escape hatch for real.
	const testNodeDir = publicRoot('test', 'node');
	const files = [...walkAll(publicSrc()), ...walkAll(publicRoot('test'))].filter((f) => !f.startsWith(testNodeDir));
	const offenders = [];
	for (const file of files) {
		const stripped = stripCommentLines(readFileSync(file, 'utf8'));
		if (RAW_HTML_ESCAPE_HATCH_RE.test(stripped)) offenders.push(file);
	}
	assert.deepEqual(offenders, [], `these files use the raw-HTML-injection escape hatch: ${offenders.join(', ')}`);
});

// ---------------------------------------------------------------------------
// 6. A CLOSED URL parameter set, under src/.
//
// AMENDMENT LEDGER (54-11, wave 6) -------------------------------------------
//
// Until now this asserted that "election" was the ONLY parameter name
// reachable under src/. D-33 makes that claim false by design, and for a
// stated reason rather than for convenience: a browser holds one store per
// network and a network holds several elections, so an election id alone
// resolves only by walking the local networks registry and taking whichever
// network happened to come first -- an answer that is a function of a local
// inventory's ORDER, on a page whose entire value is that its claims can be
// checked. The address therefore names both, and this assertion's subject
// changes from "one name" to "a CLOSED SET of exactly two".
//
// What did NOT change, and is the part carrying the security content: the
// set is still asserted by `deepEqual` against an explicit list, so a THIRD
// parameter name still fails here; and the `forbidden` probe below -- the
// phase/time-selection names of T-53-07-04 and D-24 -- is UNCHANGED and
// still asserted absent. 54-10 anticipated exactly this amendment when it
// wrote, in section 10's own vocabulary comment, that the parameter set
// "deliberately EXCLUDES `election` (and any network parameter a later wave
// adds): those address WHICH election is shown, not WHICH PHASE it is shown
// in, and D-33 requires them."
//
// The two admitted names are read from `election-address.js`'s own exported
// constants, never transcribed here, so a rename in that module fails this
// assertion loudly instead of silently admitting a name nobody declared.
// ---------------------------------------------------------------------------

test('positive control: the closed-parameter-set assertion still REFUSES a third name — an exact deepEqual, not a containment check', () => {
	const admitted = [ELECTION_ADDRESS_PARAM, NETWORK_ADDRESS_PARAM].sort();
	const withAThirdName = [...admitted, 'audience'].sort();
	assert.notDeepEqual(withAThirdName, admitted, 'the amended assertion would admit a third parameter name — it has been widened into a containment check');
	assert.deepEqual([...admitted].sort(), admitted, 'sanity: the admitted set compares equal to itself');
});

test('the URL parameter names reachable anywhere under src/ are exactly the two the address module exports — no third name, and none of the phase/time-selection names (test/browser/ is excluded from this scan — its own ?phase= selector lives there, never in src/)', () => {
	const files = walkAll(publicSrc());
	/** @type {Map<string, string>} */
	const contents = new Map();
	for (const file of files) contents.set(file, stripCommentLines(readFileSync(file, 'utf8')));

	const CALL_SITE_RE = /\.(?:get|getAll)\(\s*([\w$]+|(['"`])([\w-]+)\2)\s*\)/g;
	/** @type {Set<string>} */
	const resolvedNames = new Set();
	const forbidden = ['at', 'phase', 'now'];

	for (const [, source] of contents) {
		let m;
		const re = new RegExp(CALL_SITE_RE.source, 'g');
		while ((m = re.exec(source))) {
			if (m[3] !== undefined) {
				resolvedNames.add(m[3]);
				continue;
			}
			const identifier = m[1];
			let found = null;
			for (const [, otherSource] of contents) {
				const constMatch = otherSource.match(new RegExp(`\\b${identifier}\\s*=\\s*(['"\`])([\\w-]+)\\1`));
				if (constMatch) {
					found = constMatch[2];
					break;
				}
			}
			resolvedNames.add(found ?? `<unresolved:${identifier}>`);
		}
	}

	const admitted = [ELECTION_ADDRESS_PARAM, NETWORK_ADDRESS_PARAM].sort();
	assert.equal(admitted.length, 2, 'sanity: the address module must export exactly two parameter-name constants for this scan to be written against');
	assert.deepEqual(
		[...resolvedNames].sort(),
		admitted,
		`expected the URL parameter names in src/ to be exactly ${admitted.join(' + ')}, found: ${[...resolvedNames].join(', ')}`,
	);

	for (const name of forbidden) {
		assert.ok(!resolvedNames.has(name), `"${name}" must not be reachable from the URL anywhere in src/ (T-53-07-04)`);
	}
});

// ---------------------------------------------------------------------------
// 7. D-18 inertness, CSS side.
// ---------------------------------------------------------------------------

const CSS_ANIMATION_RE = /(@keyframes|animation(?:-name)?\s*:|transition\s*:|linear-gradient\()/;

test('positive control: the CSS-animation matcher fires on planted @keyframes and transition fixtures', () => {
	assert.match('@keyframes shimmer{}', CSS_ANIMATION_RE);
	assert.match('transition: opacity .3s;', CSS_ANIMATION_RE);
});

test('no *.css file under src/ contains @keyframes, animation, animation-name, transition or linear-gradient (D-18)', () => {
	const cssFiles = walkAll(publicSrc()).filter((f) => f.endsWith('.css'));
	assert.ok(cssFiles.length > 0, 'sanity: expected at least one .css file under src/');
	const offenders = [];
	for (const file of cssFiles) {
		const stripped = stripCommentLines(readFileSync(file, 'utf8'));
		if (CSS_ANIMATION_RE.test(stripped)) offenders.push(file);
	}
	assert.deepEqual(offenders, [], `these CSS files carry an animation/transition/gradient construct: ${offenders.join(', ')}`);
});

// ---------------------------------------------------------------------------
// 8. D-18 inertness, DOM side.
// ---------------------------------------------------------------------------

test('ElectionShell.tsx contains no busy/status/progress/alert role and no spinner/shimmer/pulse/loading/pending identifier', () => {
	assert.doesNotMatch(SHELL_SOURCE, /aria-busy/);
	assert.doesNotMatch(SHELL_SOURCE, /role="status"/);
	assert.doesNotMatch(SHELL_SOURCE, /role="progressbar"/);
	assert.doesNotMatch(SHELL_SOURCE, /role="alert"/);
	assert.doesNotMatch(SHELL_SOURCE, /<progress/);
	assert.doesNotMatch(SHELL_SOURCE, /spinner|shimmer|pulse|loading|pending/i);
});

// ---------------------------------------------------------------------------
// 9. D-08 key totality, now across THREE scan roots (I-16, 54-05 Task 2 Part
// C). 54-04 places facts.js at packages/ui-web/src/lifecycle/facts.js, so
// every public.headline.*/public.tone.*/public.gap.* literal it mounts (as
// a DATA FIELD -- labelKey/sentenceKey/detailKey/etc, never a literal t()
// call site) sat in a directory neither prior root walked. Left unfixed,
// the moment 54-09 (wave 3) declared those keys in COPY this case would go
// red and stay red for the remaining eight waves -- a known-red suite is
// exactly where a genuine regression hides. This hunk is a SEPARATE,
// unrelated concern from case 10's fence narrowing below: it widens WHERE
// the scan looks, never WHAT it accepts -- both directions stay asserted
// empty, exactly as before.
// ---------------------------------------------------------------------------

const PUBLIC_VOICE_KEY_RE = /^(public\.|advisory\.public\.)/;
const KEY_LITERAL_RE = /['"`](public\.[\w.]+|advisory\.public\.[\w.]+)['"`]/g;

/**
 * The mounted-key walk, extracted so both the real case-9 assertion and
 * Control 1 below can exercise the identical routine over different root
 * sets. `KEY_LITERAL_RE` is anchored to the `public.`/`advisory.public.`
 * prefixes, so a `packages/ui-web/src/lifecycle/` file can only ever
 * contribute a key in that shape -- verified against the two files
 * currently in that directory (`election-phase.js`, `phase-ids.js`, plus
 * `facts.js` once 54-04 lands), none of which can trip the
 * mounted-not-declared direction with a `lifecycle.*`-shaped key. The
 * `variant="public"` special case is moved here UNCHANGED (it is
 * behaviour, not scaffolding): `advisory.public.body` is never spelled out
 * as a literal, resolved instead by `AdvisoryDisclosure`'s
 * `advisory.${variant}.body` TEMPLATE, so its literal mount evidence is
 * `variant="public"` itself.
 *
 * @param {string[]} scanDirs
 * @returns {Set<string>}
 */
function collectMountedPublicKeys(scanDirs) {
	/** @type {Set<string>} */
	const mountedKeys = new Set();
	for (const dir of scanDirs) {
		for (const file of walkAll(dir)) {
			const source = readFileSync(file, 'utf8');
			let m;
			const re = new RegExp(KEY_LITERAL_RE.source, 'g');
			while ((m = re.exec(source))) mountedKeys.add(m[1]);
			if (/variant="public"/.test(source)) mountedKeys.add('advisory.public.body');
		}
	}
	return mountedKeys;
}

// 54-09 REMOVED the interim dynamic skip 54-05 installed here (I-23). The
// literal call is deliberately not quoted anywhere in this file, so a
// reader grepping the suite for a disabled test finds nothing. Its one
// and only cause -- ~42 `facts.js` keys mounted but not yet declared in
// COPY -- is gone: `copy.js` now declares all 50 members of
// `FACT_COPY_KEYS`, `mountedNotDeclared` is empty, and the guard's own
// `mountedNotDeclared.length > 0` condition can no longer hold. It was
// removed rather than left in place because a skip whose reason has expired
// is indistinguishable, in a test report, from a test somebody switched off.
// The assertion below now runs unconditionally.
//
// -- TEMPLATE MOUNT EVIDENCE (54-09) ---------------------------------------
//
// `KEY_LITERAL_RE` can only see a key spelled out as a quoted literal, and
// eight keys are genuinely mounted without ever being spelled out:
// `facts.js` builds `public.tone.<tone>` and `public.group.<group>` from
// TEMPLATE EXPRESSIONS over its own frozen `TONES` and `FACT_GROUPS`
// arrays. They are as mounted as any literal -- `FACT_COPY_KEYS` publishes
// them, and a render site resolves them through those two functions -- but
// no literal scan can ever see them. This is the same situation, and takes
// the same shape of answer, as the `variant="public"` exemption already
// built into the walk above.
//
// The exemption is guarded so it cannot go vacuous, which is the whole
// difference between an exemption and a hole: a key qualifies only if it is
// BOTH a member of `FACT_COPY_KEYS` AND its generating template is still
// present in comment-stripped `facts.js` source. Delete either template and
// its four keys go straight back to being reported as never mounted.
const KEY_TEMPLATE_SOURCES = Object.freeze([
	{ prefix: 'public.tone.', template: 'public.tone.${' },
	{ prefix: 'public.group.', template: 'public.group.${' },
]);

const FACTS_SOURCE_STRIPPED = stripCommentLines(readFileSync(uiWebSrc('lifecycle', 'facts.js'), 'utf8'));

/**
 * Keys emitted by a template expression rather than a literal. Empty unless
 * the template is really there, so a removed template is a red rung.
 * @returns {Set<string>}
 */
function collectTemplateMountedKeys() {
	/** @type {Set<string>} */
	const out = new Set();
	for (const { prefix, template } of KEY_TEMPLATE_SOURCES) {
		if (!FACTS_SOURCE_STRIPPED.includes(template)) continue;
		for (const key of FACT_COPY_KEYS) if (key.startsWith(prefix)) out.add(key);
	}
	return out;
}

// -- PENDING MOUNT, an expiring list (54-09) --------------------------------
//
// The eleven keys 54-09 authored that sit OUTSIDE the fact model. They are
// declared now and mounted later, on purpose: `t()` throws on an unknown
// key, so the copy has to exist before the screens that render it, and the
// header of `copy.js` records the amended warrant under which they arrive
// early. Each is bound BY NAME by a render plan in a later wave -- the
// index strings and the incomplete-holdings qualifier by the index screen,
// the two details-toggle labels and the key-release fail-closed line by the
// fact-card screen, the freshness line and the two standing caveats by the
// page-voice screen, and the disclosure-policy failure line by the rules
// card.
//
// This list is NOT a relaxation of the assertion, and two properties make
// that true rather than merely asserted:
//   - `declaredNotMounted` must be a SUBSET of it. Any other declared key
//     with no mount site still fails, exactly as before.
//   - Any member that HAS since been mounted must be deleted from it. A
//     stale entry fails loudly, naming itself, instead of quietly
//     forgiving something that no longer needs forgiving. That is what
//     makes the list shrink to empty as the render plans land, rather than
//     outliving its reason the way the removed skip would have.
/** @type {ReadonlyArray<string>} */
const PENDING_MOUNT_KEYS = Object.freeze([
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

test('the public-voice key set in COPY equals, in both directions, the set of public-voice keys mounted under src/, packages/ui-web/src/components/ and packages/ui-web/src/lifecycle/ -- as a literal, as the variant="public" template, or as one of facts.js own key templates -- apart from the named PENDING_MOUNT_KEYS still awaiting their render plan', () => {
	const declaredKeys = new Set(Object.keys(COPY).filter((k) => PUBLIC_VOICE_KEY_RE.test(k)));
	const scanDirs = [publicSrc(), uiWebRoot('src', 'components'), uiWebRoot('src', 'lifecycle')];
	const mountedKeys = collectMountedPublicKeys(scanDirs);
	for (const key of collectTemplateMountedKeys()) mountedKeys.add(key);

	const declaredNotMounted = [...declaredKeys].filter((k) => !mountedKeys.has(k));
	const mountedNotDeclared = [...mountedKeys].filter((k) => !declaredKeys.has(k));

	const pending = new Set(PENDING_MOUNT_KEYS);
	const unexplainedDeclaredNotMounted = declaredNotMounted.filter((k) => !pending.has(k));

	assert.deepEqual(
		unexplainedDeclaredNotMounted,
		[],
		`declared public-voice key(s) never mounted, and not on the pending-mount list: ${unexplainedDeclaredNotMounted.join(', ')}`,
	);
	assert.deepEqual(mountedNotDeclared, [], `mounted public-voice key(s) never declared in COPY: ${mountedNotDeclared.join(', ')}`);
});

test('the pending-mount list is not stale -- every key on it is still both declared in COPY and genuinely unmounted, so an entry whose render plan has landed fails here instead of quietly forgiving nothing', () => {
	const declaredKeys = new Set(Object.keys(COPY).filter((k) => PUBLIC_VOICE_KEY_RE.test(k)));
	const scanDirs = [publicSrc(), uiWebRoot('src', 'components'), uiWebRoot('src', 'lifecycle')];
	const mountedKeys = collectMountedPublicKeys(scanDirs);
	for (const key of collectTemplateMountedKeys()) mountedKeys.add(key);

	/** @type {string[]} */
	const stale = [];
	for (const key of PENDING_MOUNT_KEYS) {
		if (!declaredKeys.has(key)) stale.push(`${key}: no longer declared in COPY -- remove it from the list`);
		else if (mountedKeys.has(key)) stale.push(`${key}: now mounted -- remove it from the list`);
	}
	assert.deepEqual(stale, [], `the pending-mount list has stale entries:\n${stale.join('\n')}`);
});

test('control: the template mount-evidence exemption is real and can fail -- both facts.js key templates are present in comment-stripped source, and each contributes its four keys; a fabricated template contributes none', () => {
	for (const { template } of KEY_TEMPLATE_SOURCES) {
		assert.ok(
			FACTS_SOURCE_STRIPPED.includes(template),
			`facts.js no longer builds "${template}" -- the exemption for those keys must be deleted, not widened`,
		);
	}
	const templateMounted = collectTemplateMountedKeys();
	assert.equal(templateMounted.size, 8, `expected 4 tone + 4 group keys, got ${templateMounted.size}`);
	assert.ok(templateMounted.has('public.tone.go'));
	assert.ok(templateMounted.has('public.group.outcome'));
	// Inertness: a prefix whose template does NOT appear in facts.js
	// contributes nothing, which is what proves the guard is the thing doing
	// the work rather than the FACT_COPY_KEYS membership alone.
	assert.ok(!FACTS_SOURCE_STRIPPED.includes('public.__absent_template__.${'));
	assert.ok(!templateMounted.has('public.headline.voting'), 'headline keys are literals and must not arrive through the template path');
});

test('control 1: root membership actually drives discovery -- a synthetic key mounted only in a throwaway directory is found when that directory is in scanDirs and absent otherwise', () => {
	// Never added to COPY, and the real roots are never walked while it
	// exists, so this synthetic key cannot pollute either direction of the
	// real case-9 assertion above.
	const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'election-shell-case9-control-'));
	try {
		writeFileSync(path.join(tmpDir, 'Control.tsx'), "t('public.__control__.probe')");
		const foundInTmp = collectMountedPublicKeys([tmpDir]);
		const foundInRealSrc = collectMountedPublicKeys([publicSrc()]);
		assert.ok(foundInTmp.has('public.__control__.probe'), 'expected the synthetic key to be found when the throwaway root is in scanDirs');
		assert.ok(!foundInRealSrc.has('public.__control__.probe'), 'the synthetic key must not leak into a scan of the real src/ root');
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

test('control 2: the new packages/ui-web/src/lifecycle/ root exists on disk and yields at least one file', () => {
	// A mistyped path would make the widening above permanently inert while
	// looking perfectly correct in review -- this is the cheap check that
	// catches it.
	const lifecycleDir = uiWebRoot('src', 'lifecycle');
	assert.ok(existsSync(lifecycleDir), `expected ${lifecycleDir} to exist on disk`);
	assert.ok(walkAll(lifecycleDir).length > 0, `expected at least one file under ${lifecycleDir}`);
});

// ---------------------------------------------------------------------------
// 10. D-24 — no URL input selects a phase.
//
// RETIREMENT LEDGER (54-10, wave 5) ------------------------------------------
//
// What stood here until now was a single regex asserting ZERO occurrences of
// a named token list anywhere under src/. Phase 53 built it as a deliberate
// SCOPE FENCE -- a marker saying "the empty-shell phase has not started on
// the next phase's territory" -- and never as a security control. D-01 and
// D-06 move that boundary on purpose, so the fence is obsolete BY DESIGN:
// this phase IS that territory.
//
// The removal is PLANNED WORK owned by 54-10, recorded at
// `.planning/phases/54-public-no-login-election-view/54-ISSUES.md` I-02 and
// `54-RESEARCH.md` Pitfall 1. Left in place it would have turned red during
// waves 6-7 as a mystery CI failure, and the pressure at that moment is to
// delete it quietly -- which is exactly the thing I-02 exists to prevent.
//
// This is the COMPLETION OF A STAGED RETIREMENT, not a second unrelated
// deletion. 54-05 (wave 2) already dropped two of the nine alternatives for
// its own forced reason -- the shell's phase-derivation function and one real
// phase id, both made unsatisfiable by its ElectionShell.tsx repoint -- and
// left a comment naming 54-10 as the owner of the rest. Seven alternatives
// remained in force when this plan opened the file.
//
// Where each retired term's coverage went, term by term, so a later reader
// does not have to infer it:
//
//   - The four DATABASE-OPENING PRIMITIVES lose NOTHING AT ALL. They are the
//     terms spelled out in `test/node/engine-reach.test.mjs`'s own matcher --
//     deliberately not re-spelled in this comment, because a checker's
//     neighbour quoting the literals another checker hunts is how this repo
//     has manufactured a permanently-green gate several times in this phase.
//     That file's source scan enforced those terms INDEPENDENTLY of this one
//     and SURVIVES; 54-10 narrows it from a prohibition into a DELEGATION
//     rule -- the app may never open a database itself, and reaches one only
//     through `@votetorrent/web-data/public` (D-03/D-04).
//   - The three-bucket term is covered phase-wide, with its own positive
//     control, by `packages/ui-web/test/three-bucket-absent.test.mjs`
//     (54-05, D-07).
//   - The remaining two -- a module filename and a networks-listing function
//     name -- were pure territory markers with no security content. They go
//     uncovered, deliberately and on the record.
//
// WHAT SECTION 10 PROVES INSTEAD (D-24) --------------------------------------
//
// No URL input may choose which lifecycle phase a visitor is shown. The `at`
// prop stays exactly the injectable, test-only seam Phase 53 built (see
// `ElectionShell.tsx`'s `at` doc comment and `election-address.js`'s header
// point 4, which names the same threat as T-53-07-04).
//
// The two matchers below run over TWO ROOTS WITH OPPOSITE EXPECTATIONS --
// zero matches under `src/`, at least one under `test/browser/` -- rather
// than over one root with an exception list. An exception list is the
// weakening path, and a shared root would force the whole assertion to be
// dropped the first time the harness legitimately tripped it. The harness
// half is also the only thing proving the production half's green is a REAL
// absence rather than an inert matcher.
// ---------------------------------------------------------------------------

/**
 * The phase/time-selection query-parameter vocabulary D-24 forbids as an
 * input. Held as a delimited frozen constant so no matcher literal is ever
 * loose in prose. Deliberately EXCLUDES `election` (and any network
 * parameter a later wave adds): those address WHICH election is shown, not
 * WHICH PHASE it is shown in, and D-33 requires them.
 * @type {ReadonlyArray<string>}
 */
const PHASE_SELECTION_PARAM_NAMES = Object.freeze(['phase', 'at', 'now', 'instant', 'asof', 'when', 'time', 'clock']);

const PHASE_SELECTION_ALTERNATION = PHASE_SELECTION_PARAM_NAMES.join('|');

/**
 * Matches a query-parameter READ, never a bare identifier — built
 * programmatically from the frozen array above so the two can never drift.
 * Two branches: a `.get`/`.getAll`/`.has` call whose argument is one of the
 * names in single, double or backtick quotes; and a raw `?name=`/`&name=`
 * query-string literal. Matching the READ rather than the word is what keeps
 * an ordinary local variable called `now` or `time` from false-firing.
 * @type {RegExp}
 */
const PHASE_PARAM_READ_RE = new RegExp(
	`\\.(?:get|getAll|has)\\(\\s*(['"\`])(?:${PHASE_SELECTION_ALTERNATION})\\1\\s*\\)|[?&](?:${PHASE_SELECTION_ALTERNATION})=`,
	'i',
);

/**
 * Matches a JSX attribute of the form `at={`, with optional whitespace either
 * side of the `=`. Scoped to `.tsx` files only, because only a JSX mount site
 * can pass the prop.
 *
 * The lookbehind is what keeps this from firing on the two `at` forms that
 * legitimately live INSIDE `ElectionShell.tsx`: the interface field is
 * `at?:` (a colon, never a brace) and the destructured default is `at = null`
 * (a null literal, never a brace). It also blocks any longer identifier
 * ending in those two letters — a `format={...}` prop is not an `at` prop.
 * @type {RegExp}
 */
const AT_PROP_MOUNT_RE = /(?<![\w$.-])at\s*=\s*\{/;

// -- Controls first, before either matcher touches real source --------------

/** One planted line per vocabulary member, cycling the four accepted syntactic
 * forms, so a term that silently fell out of the fixture fails as a FIXTURE
 * defect rather than as a matcher defect. */
const PHASE_PARAM_READ_FIXTURE_LINES = PHASE_SELECTION_PARAM_NAMES.map((name, i) => {
	const form = i % 4;
	if (form === 0) return `const a${i} = params.get('${name}');`;
	if (form === 1) return `const b${i} = searchParams.has("${name}");`;
	if (form === 2) return `const c${i} = params.getAll(\`${name}\`);`;
	return `const d${i} = '/index.html?${name}=x';`;
});

test('positive control: the phase-parameter-read matcher fires on a planted fixture, once per vocabulary member and across all four accepted forms', () => {
	assert.equal(PHASE_PARAM_READ_FIXTURE_LINES.length, PHASE_SELECTION_PARAM_NAMES.length);
	PHASE_SELECTION_PARAM_NAMES.forEach((name, i) => {
		assert.ok(PHASE_PARAM_READ_FIXTURE_LINES[i].includes(name), `fixture sanity: line ${i} must literally contain "${name}"`);
		assert.match(PHASE_PARAM_READ_FIXTURE_LINES[i], PHASE_PARAM_READ_RE, `matcher is inert against the planted read of "${name}"`);
	});
	assert.match(PHASE_PARAM_READ_FIXTURE_LINES.join('\n'), PHASE_PARAM_READ_RE);
});

test('benign control: the phase-parameter-read matcher does NOT fire on election-address.js\'s real shape — a getAll through a constant, a quoted "election" literal, and the address query string D-33 requires', () => {
	const benign = [
		'const values = params.getAll(ELECTION_ADDRESS_PARAM);',
		"const single = params.get('election');",
		"const href = '/index.html?election=abc';",
		'const now = Date.now();',
		'const time = clock.read();',
	].join('\n');
	assert.doesNotMatch(benign, PHASE_PARAM_READ_RE, 'matcher cannot discriminate a phase override from the election address parameter');
	// And against the real file, not just a hand-written approximation of it.
	assert.doesNotMatch(stripCommentLines(readFileSync(publicSrc('election-address.js'), 'utf8')), PHASE_PARAM_READ_RE);
});

test('positive control: the at-prop mount matcher fires on a planted <ElectionShell at={x} /> and does not fire on the two at forms inside ElectionShell.tsx or on a longer prop name ending in those letters', () => {
	assert.match('<ElectionShell at={FIXTURE_INSTANTS[phase]} />', AT_PROP_MOUNT_RE);
	assert.match('\t\t\t\tat = { instant }', AT_PROP_MOUNT_RE);
	assert.doesNotMatch('\tat?: string | null;', AT_PROP_MOUNT_RE);
	assert.doesNotMatch('export function ElectionShell({ search, at = null, election = null }: ElectionShellProps) {', AT_PROP_MOUNT_RE);
	assert.doesNotMatch('<Stamp format={iso} />', AT_PROP_MOUNT_RE);
	assert.doesNotMatch('<LifecyclePill phase={phase} />', AT_PROP_MOUNT_RE);
});

// -- The production scans: both expect ZERO ---------------------------------

const D24_FAILURE_REASON =
	'A URL-selectable lifecycle instant would let a link author choose which lifecycle state any visitor is shown — ' +
	'a false claim about an election\'s state, delivered by a hostile link, on a page whose only value is that its ' +
	'claims can be checked (D-24; successor to T-53-07-04).';

test('D-24: no file under src/ reads a phase- or time-selection query parameter', () => {
	const offenders = [];
	for (const file of walkAll(publicSrc())) {
		const stripped = stripCommentLines(readFileSync(file, 'utf8'));
		if (PHASE_PARAM_READ_RE.test(stripped)) offenders.push(file);
	}
	assert.deepEqual(offenders, [], `these files read a phase/time-selection query parameter: ${offenders.join(', ')}. ${D24_FAILURE_REASON}`);
});

test('D-24: no .tsx file under src/ passes an at prop to a mount site — the seam stays test-only', () => {
	const tsxFiles = walkAll(publicSrc()).filter((f) => f.endsWith('.tsx'));
	assert.ok(tsxFiles.length > 0, 'sanity: expected at least one .tsx file under src/');
	const offenders = [];
	for (const file of tsxFiles) {
		const stripped = stripCommentLines(readFileSync(file, 'utf8'));
		if (AT_PROP_MOUNT_RE.test(stripped)) offenders.push(file);
	}
	assert.deepEqual(offenders, [], `these production .tsx files pass the at prop at a mount site: ${offenders.join(', ')}. ${D24_FAILURE_REASON}`);
});

// -- The harness scan: same two matchers, opposite expectation --------------

test('harness discrimination: test/browser/ DOES exercise both seams — at least one file reads a phase-selection parameter and at least one .tsx passes the at prop, so the two production scans above are proving a real absence rather than running an inert matcher', () => {
	// Asserted over the DIRECTORY, never against a file by name, so later
	// harness work can relocate or split the gate without breaking this.
	const harnessDir = publicRoot('test', 'browser');
	const files = walkAll(harnessDir);
	assert.ok(files.length > 0, `sanity: expected at least one file under ${harnessDir}`);

	const paramReaders = [];
	const atMounters = [];
	for (const file of files) {
		const stripped = stripCommentLines(readFileSync(file, 'utf8'));
		if (PHASE_PARAM_READ_RE.test(stripped)) paramReaders.push(file);
		if (file.endsWith('.tsx') && AT_PROP_MOUNT_RE.test(stripped)) atMounters.push(file);
	}

	assert.ok(
		paramReaders.length > 0,
		`no file under ${harnessDir} reads a phase-selection query parameter. The browser harness is the ONLY sanctioned ` +
			'consumer of that seam; if it has stopped exercising it, the src/ scan above is no longer proving anything and ' +
			'must be re-pointed rather than left green.',
	);
	assert.ok(
		atMounters.length > 0,
		`no .tsx file under ${harnessDir} passes the at prop. Same reasoning: the harness is the only sanctioned consumer ` +
			'of the injectable instant, and a production-absence scan whose matcher has never been seen to fire on real ' +
			'code is a vacuous gate.',
	);
});

// -- Argument provenance: the instant can never be re-plumbed from the URL --
//
// The two scans above would both stay green if somebody parsed the address
// and handed the result to the instant resolver under a different name. This
// closes that path in the direction that matters most: every call site's
// argument text must name the injected binding and must name nothing
// address-derived.

const INSTANT_CALL_SOURCE = 'resolveComparisonInstant\\(([^)]*)\\)';
const INSTANT_ARG_FORBIDDEN_RE = /\b(search|address|params|location|URLSearchParams)\b/;

/** @param {string} source @returns {string[]} the argument text of every call site. */
function instantCallArguments(source) {
	/** @type {string[]} */
	const out = [];
	const re = new RegExp(INSTANT_CALL_SOURCE, 'g');
	let m;
	while ((m = re.exec(source))) out.push(m[1]);
	return out;
}

test('positive control: the instant-provenance check fires on a planted address-derived argument and on a planted argument that never names the injected binding', () => {
	const addressDerived = 'const { phase } = derivePhase(x, y, resolveComparisonInstant(parseElectionAddress(search).instant));';
	const addressArgs = instantCallArguments(addressDerived);
	assert.equal(addressArgs.length, 1, 'fixture sanity: exactly one planted call site');
	assert.match(addressArgs[0], INSTANT_ARG_FORBIDDEN_RE, 'the forbidden-provenance matcher is inert against an address-derived argument');

	const urlDerived = 'resolveComparisonInstant(params.get("at") ?? undefined)';
	const urlArgs = instantCallArguments(urlDerived);
	assert.equal(urlArgs.length, 1);
	assert.match(urlArgs[0], INSTANT_ARG_FORBIDDEN_RE);

	const unbound = 'resolveComparisonInstant(fromSomewhereElse)';
	const unboundArgs = instantCallArguments(unbound);
	assert.equal(unboundArgs.length, 1);
	assert.doesNotMatch(unboundArgs[0], /\bat\b/, 'the names-the-binding check is inert against an argument that never names it');
});

test('D-24 structural: every resolveComparisonInstant call site in ElectionShell.tsx passes the injected at binding and nothing address-derived', () => {
	const args = instantCallArguments(SHELL_SOURCE);
	assert.ok(args.length > 0, 'sanity: expected at least one resolveComparisonInstant call site in ElectionShell.tsx');
	for (const arg of args) {
		assert.match(arg, /\bat\b/, `a resolveComparisonInstant call site does not pass the injected at binding: "${arg}". ${D24_FAILURE_REASON}`);
		assert.doesNotMatch(arg, INSTANT_ARG_FORBIDDEN_RE, `a resolveComparisonInstant call site takes an address-derived argument: "${arg}". ${D24_FAILURE_REASON}`);
	}
});

// ---------------------------------------------------------------------------
// 11. 53-06's invariants survive.
// ---------------------------------------------------------------------------

test("53-06's invariants survive: app.css's leading @import, no :root/custom property, main.tsx's frozen __PUBLIC_APP__ and app.css-first import, AppChrome.tsx's wordlessness", () => {
	const cssSource = readFileSync(publicSrc('app.css'), 'utf8');
	const lines = cssSource.split('\n');
	let firstMeaningfulLine;
	let inBlockComment = false;
	for (const rawLine of lines) {
		const line = rawLine.trim();
		if (line === '') continue;
		if (inBlockComment) {
			if (line.includes('*/')) inBlockComment = false;
			continue;
		}
		if (line.startsWith('/*')) {
			if (!line.includes('*/')) inBlockComment = true;
			continue;
		}
		firstMeaningfulLine = line;
		break;
	}
	assert.equal(firstMeaningfulLine, "@import '@votetorrent/ui-web/tokens.css';");
	assert.doesNotMatch(cssSource, /:root/);
	assert.doesNotMatch(cssSource, /^\s*--/m);

	const mainSource = readFileSync(publicSrc('main.tsx'), 'utf8');
	assert.equal(mainSource.trim().split('\n')[0].trim(), "import './app.css';");
	assert.match(mainSource, /window\.__PUBLIC_APP__\s*=\s*Object\.freeze\(/);

	const JSX_TEXT_RUN_RE = /[>][^<>{}]*[A-Za-z]{2,}[^<>{}]*[<]/;
	const chromeSource = readFileSync(publicSrc('screens', 'AppChrome.tsx'), 'utf8');
	const offendingLines = chromeSource.split('\n').filter((line) => JSX_TEXT_RUN_RE.test(line));
	assert.deepEqual(offendingLines, [], `AppChrome.tsx contains a JSX text run: ${JSON.stringify(offendingLines)}`);
});
