/**
 * shell-wiring.test.mjs — source-level assertions over `DashboardShell.tsx`'s
 * wiring, added by the phase-50 code-review fixes.
 *
 * DECLARED LIMIT, STATED FIRST. `node --test` cannot import `.tsx`, so this
 * suite reads the file as TEXT — the same idiom `preview-control.test.mjs`,
 * `registry.test.mjs` and `authority-admin-panels.test.mjs` already use. A
 * text assertion pins the SHAPE of a fix, not its behaviour: it cannot prove
 * the effect actually re-attaches after a swap, only that the dependency list
 * names what the body reads. The composed shell has no behavioural gate at any
 * tier in this phase (nothing mounts `DashboardShell`), which is exactly the
 * gap CR-01 was found in; closing it properly needs a rung that mounts the
 * real shell, and that is recorded as outstanding rather than pretended away
 * here. Every matcher below is paired with an inertness control.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHELL = readFileSync(path.resolve(__dirname, '..', '..', 'src', 'screens', 'DashboardShell.tsx'), 'utf8');

/** Drop whole-line comments, so prose ABOUT a defect is never read as the defect.
 * @param {string} source @returns {string} */
function stripComments(source) {
	return source
		.split('\n')
		.filter((/** @type {string} */ line) => {
			const trimmed = line.trim();
			return !(trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*'));
		})
		.join('\n');
}

const CODE = stripComments(SHELL);

const ATTACH_DEPS_RE =
	/\}, \[activeNetwork\?\.networkHash, activeNetwork\?\.officerUserId, activeNetwork\?\.bootstrappedAt\]\);/;

test('the attach effect depends on officerUserId and bootstrappedAt, not on networkHash alone', () => {
	// A successful officer swap replaces the registry entry's officerUserId and
	// bootstrappedAt while KEEPING the same networkHash. With a hash-only
	// dependency the effect never re-ran, so db stayed null and grantedScopes
	// stayed [] for the rest of the page's life -- while PanelGrid, whose
	// remount key DOES include both, remounted around the dead handle.
	assert.match(CODE, ATTACH_DEPS_RE);
});

test('inertness control: the dependency matcher does NOT accept the hash-only list', () => {
	assert.doesNotMatch('	}, [activeNetwork?.networkHash]);', ATTACH_DEPS_RE, 'matcher is inert');
});

test('handleConfirmSwap does not also tear the session down locally -- the re-keyed effect owns it', () => {
	const swapBody = CODE.slice(CODE.indexOf('async function handleConfirmSwap'), CODE.indexOf('function handleCancelSwap'));
	assert.ok(swapBody.length > 0, 'could not locate handleConfirmSwap');
	assert.doesNotMatch(swapBody, /setGrantedScopes\(\[\]\)/, 'two owners for one transition');
});

test('inertness control: the two-owners matcher hits a synthetic setGrantedScopes([]) fixture', () => {
	assert.match('setGrantedScopes([]);', /setGrantedScopes\(\[\]\)/, 'matcher is inert');
});

const HANDOVER_RE = /const handoverDb = dbRef\.current \?\? undefined;[\s\S]{0,600}?db: handoverDb,/;

test('handleConfirmSwap hands its open handle to performOfficerSwap BEFORE the swap runs', () => {
	// performOfficerSwap -> refreshNetwork -> redeemAndBootstrap({ replace:
	// true }) deletes this exact database, and indexedDB.deleteDatabase blocks
	// while any connection is open -- deleteNetworkDb deliberately refuses to
	// resolve on onblocked and throws DeleteBlockedError after its timeout. The
	// shell used to close its handle only AFTER the swap returned, so it raced
	// its own delete and every confirmed swap failed, burning the officer's
	// single-use code.
	assert.match(CODE, HANDOVER_RE);

	// And the handover must precede the call, not follow it. The call is now
	// reached through withNetworkDbLifecycleLock (CR-04), so this looks for
	// performOfficerSwap( itself rather than an immediately-preceding await.
	const handoverAt = CODE.indexOf('const handoverDb = dbRef.current');
	const swapCallAt = CODE.indexOf('performOfficerSwap(', handoverAt);
	assert.ok(handoverAt >= 0 && swapCallAt >= 0, 'could not locate both the handover and the swap call');
	assert.ok(handoverAt < swapCallAt, 'the handle is taken AFTER the swap call -- the delete is still racing it');
});

test('inertness control: the handover matcher does NOT accept a close-after-the-swap fixture', () => {
	const fixture = [
		'const result = await performOfficerSwap({ networkHash, pastedCode, transport });',
		'if (dbRef.current) { await closeNetworkDb(dbRef.current); dbRef.current = null; }',
	].join('\n');
	assert.doesNotMatch(fixture, HANDOVER_RE, 'matcher is inert');
});

test('every destructive call site that can hold a handle passes it: forgetNetwork and performOfficerSwap alike', () => {
	assert.match(CODE, /forgetNetwork\(\{[\s\S]{0,200}?db: dbRef\.current \?\? undefined,/);
	assert.match(CODE, /performOfficerSwap\(\{[\s\S]{0,200}?db: handoverDb,/);
});

// --- Panel console hygiene (WR-12) --------------------------------------------

const PANELS_DIR = path.resolve(__dirname, '..', '..', 'src', 'screens', 'panels');
/** Every panel body, plus the shell -- the ten console.error call sites this app ships. */
const CONSOLE_SITES = readdirSync(PANELS_DIR)
	.filter((/** @type {string} */ name) => name.endsWith('.tsx'))
	.map((/** @type {string} */ name) => ({ name, source: readFileSync(path.join(PANELS_DIR, name), 'utf8') }))
	.concat([{ name: 'DashboardShell.tsx', source: SHELL }]);

const RAW_MESSAGE_RE = /console\.error\([^)]*err(or)?\s*instanceof\s*Error\s*\?\s*err(or)?\.message/;

test('no panel and not the shell logs a raw database error MESSAGE to the console', () => {
	// `err` comes from a query against tables full of registrant information,
	// and Quereus and its constraint layer routinely embed the offending row
	// and column values in an error message. The browser console is a durable,
	// exportable, screenshot-able sink.
	const offenders = CONSOLE_SITES.filter((f) => RAW_MESSAGE_RE.test(stripComments(f.source))).map((f) => f.name);
	assert.deepEqual(offenders, [], `these files log a raw error message: ${offenders.join(', ')}`);
});

test('inertness control: the raw-message matcher hits the exact shape all nine panels used to carry', () => {
	const fixture = "console.error('RegistrationsPanel: a read failed:', err instanceof Error ? err.message : String(err));";
	assert.match(fixture, RAW_MESSAGE_RE, 'matcher is inert');
});

test('every console.error in a panel logs the error CLASS instead -- and there are nine of them', () => {
	const withClassLogging = CONSOLE_SITES.filter((f) =>
		/console\.error\([^)]*\)\?\.name \?\? 'Error'\)/.test(stripComments(f.source)),
	);
	assert.equal(withClassLogging.length, 9, 'expected exactly the nine panel bodies to log an error class');
});

// --- Attach-failure banner (WR-16) ---------------------------------------------

test('the error banner is the DEFAULT for any attachError, and PanelGrid is reserved for a clean attach', () => {
	// Only two error classes used to reach a banner; every other attach failure
	// -- a corrupt row-count record, a Quereus DDL reconcile error, a quota
	// refusal, a plugin registration error -- fell through to the grid with a
	// null handle, and every panel then showed its own "No registrants yet."
	// For election infrastructure, "database broken" presented as "zero
	// registrants" is the worst available confusion.
	assert.match(CODE, /\{attachError \? \(/);
	assert.doesNotMatch(
		CODE,
		/\{attachError instanceof MissingRowCountsError \|\| attachError instanceof RowCountMismatchError \? \(\s*<div className="sh-error-banner">/,
	);
});

test('inertness control: the old two-class-only condition would be rejected by the matcher above', () => {
	const fixture = '{attachError instanceof MissingRowCountsError || attachError instanceof RowCountMismatchError ? (\n\t<div className="sh-error-banner">';
	assert.doesNotMatch(fixture, /\{attachError \? \(/, 'matcher is inert');
	assert.match(
		fixture,
		/\{attachError instanceof MissingRowCountsError \|\| attachError instanceof RowCountMismatchError \? \(\s*<div className="sh-error-banner">/,
		'the old-shape matcher is inert',
	);
});

test('an unrecognised attach failure gets its OWN copy, not the verification wording', () => {
	// "Your data failed its checksum" is a wrong answer for a database that
	// simply would not open.
	assert.match(CODE, /t\('snapshot\.errorAttachHeading'\)/);
	assert.match(CODE, /t\('snapshot\.errorAttachBody'\)/);
	assert.match(CODE, /t\('snapshot\.errorVerificationHeading'\)/);
});

// --- Forget confirmation (WR-18) -----------------------------------------------

test('the forget dialog stays disabled when there is no expected name to confirm against', () => {
	assert.match(CODE, /forgetExpectedName\.length === 0 \|\| forgetConfirmationInput\.trim\(\) !== forgetExpectedName/);
});

test('inertness control: the old comparison, which enabled the button on open for an empty name, is rejected', () => {
	const fixture = 'const forgetConfirmDisabled = forgetConfirmationInput.trim() !== activeNetwork.authorityName.trim();';
	assert.doesNotMatch(
		fixture,
		/forgetExpectedName\.length === 0 \|\| forgetConfirmationInput\.trim\(\) !== forgetExpectedName/,
		'matcher is inert',
	);
});

// --- Surfaced classify() failure (CR-03) ----------------------------------------

const CLASSIFY_CATCH_RE = /\} catch \(err\) \{\s*if \(!cancelled\) setSwapError\(err\);[\s\S]{0,80}?\} finally \{/;

test('classify() has a catch clause that surfaces the failure via setSwapError, positioned before the finally', () => {
	// Every throwing call inside classify() -- splitSignInCode on a malformed
	// code, transport.redeem rejecting, classifyRedemption, and a throw from
	// performOfficerSwap on the same-officer-refresh branch -- used to escape
	// as an unhandled promise rejection, leaving db === null with no banner
	// and no dialog while PanelGrid rendered nine panels each showing their
	// own empty copy.
	assert.match(CODE, CLASSIFY_CATCH_RE);
});

test('inertness control: the classify-catch matcher does NOT accept a bare try/finally with no catch', () => {
	const fixture = 'try {\n\t\t\t\t// work\n\t\t\t} finally {\n\t\t\t\tif (!cancelled) onSwapContextConsumed?.();\n\t\t\t}';
	assert.doesNotMatch(fixture, CLASSIFY_CATCH_RE, 'matcher is inert');
});

const MAIN_REGION_SWAP_ERROR_RE = /\{attachError \? \([\s\S]{0,900}?\) : swapError && !pendingSwap \? \(/;

test('the main region renders a dedicated banner for a surfaced swapError only when no swap dialog is pending', () => {
	// A classification failure must never be represented by nine panels each
	// showing their own empty copy -- an officer whose database failed must
	// never be told their authority has no registrants. The banner only
	// applies when no swap dialog is open: a confirmed-swap failure belongs
	// in the dialog the officer is already looking at.
	assert.match(CODE, MAIN_REGION_SWAP_ERROR_RE);
});

test('inertness control: the main-region matcher does NOT accept the old attachError-or-grid-only shape', () => {
	const fixture =
		'{attachError ? (\n\t\t\t\t\t\t<div className="sh-error-banner">\n\t\t\t\t\t\t\tstuff\n\t\t\t\t\t\t</div>\n\t\t\t\t\t) : (\n\t\t\t\t\t\t<PanelGrid';
	assert.doesNotMatch(fixture, MAIN_REGION_SWAP_ERROR_RE, 'matcher is inert');
});

test('the surfaced swap-error banner renders through t() with the two new copy keys', () => {
	assert.match(CODE, /t\('network\.swapErrorHeading'\)/);
	assert.match(CODE, /t\('network\.swapErrorBody'\)/);
});

// --- Handed-off transport cache ownership (D-14 continuity, 50-22) -------------

const RESET_CALL_RE = /\.reset\(\)/g;

test('the handed-off single-flight cache is reset on at least 7 terminal call sites', () => {
	// handleCancelSwap (unchanged) + the classify catch clause + the
	// fail-closed replay branch + officer-indeterminate + new-network + BOTH
	// routes of same-officer-refresh + all three terminal routes of
	// handleConfirmSwap. The one path that must NOT reset is 'officer-swap'
	// -- the confirm dialog still needs the cached envelope.
	const matches = CODE.match(RESET_CALL_RE) ?? [];
	assert.ok(matches.length >= 7, `expected at least 7 .reset() call sites, found ${matches.length}`);
});

const OFFICER_SWAP_CASE_RE = /case 'officer-swap':[\s\S]*?break;/;

test("the officer-swap case body resets nothing -- the confirm dialog still needs the cached envelope", () => {
	const match = CODE.match(OFFICER_SWAP_CASE_RE);
	assert.ok(match, 'could not locate the officer-swap case');
	assert.doesNotMatch(match[0], /\.reset\(\)/);
});

test('inertness control: the officer-swap-no-reset matcher DOES flag a fixture with a reset call inside that case', () => {
	const fixture = "case 'officer-swap':\n\tsetPendingSwap({ networkHash });\n\tswapContext.transport.reset();\n\tbreak;";
	const match = fixture.match(OFFICER_SWAP_CASE_RE);
	assert.ok(match);
	assert.match(match[0], /\.reset\(\)/, 'matcher is inert -- it correctly flags the misplaced reset');
});

const CLASSIFY_FINALLY_RE = /\} finally \{\s*if \(!cancelled\) onSwapContextConsumed\?\.\(\);\s*\}/;

test("classify()'s finally block contains no reset call -- officer-swap falls through the SAME finally and must keep its cache", () => {
	assert.match(CODE, CLASSIFY_FINALLY_RE);
});

test('inertness control: the finally-no-reset matcher rejects a fixture where reset was moved into finally (which would break the confirm path)', () => {
	const fixture =
		'} finally {\n\t\t\t\tswapContext.transport.reset();\n\t\t\t\tif (!cancelled) onSwapContextConsumed?.();\n\t\t\t}';
	assert.doesNotMatch(fixture, CLASSIFY_FINALLY_RE, 'matcher is inert');
});

// --- Every destructive db path queued onto the per-network lock (CR-04) --------

const FORGET_INSIDE_LOCK_RE = /withNetworkDbLifecycleLock\([^,]+,\s*\(\) =>\s*forgetNetwork\(/;

test('forgetNetwork is called only from inside withNetworkDbLifecycleLock', () => {
	// CR-04: withNetworkDbLifecycleLock serialized exactly attachNetworkDb and
	// closeNetworkDb. It did NOT wrap handleConfirmForget -> forgetNetwork ->
	// deleteNetworkDbSettled -> indexedDB.deleteDatabase, one of the two most
	// destructive open/close operations in the app against the same
	// networkHash.
	assert.match(CODE, FORGET_INSIDE_LOCK_RE);
	const forgetCallCount = (CODE.match(/forgetNetwork\(/g) ?? []).length;
	assert.equal(forgetCallCount, 1, 'expected exactly one forgetNetwork( call site');
});

test('inertness control: the forget-lock matcher rejects a bare (unwrapped) forgetNetwork call', () => {
	const fixture = 'const result = await forgetNetwork({ networkHash, typedConfirmation, db });';
	assert.doesNotMatch(fixture, FORGET_INSIDE_LOCK_RE, 'matcher is inert');
});

const PERFORM_OFFICER_SWAP_INSIDE_LOCK_RE = /withNetworkDbLifecycleLock\([^,]+,\s*\(\) =>\s*performOfficerSwap\(/g;

test('both performOfficerSwap call sites are wrapped in withNetworkDbLifecycleLock, and there are exactly two', () => {
	// CR-04: neither the handleConfirmSwap call site nor the classify
	// effect's same-officer-refresh call site was queued onto the lock that
	// already serializes attach and close for the same networkHash.
	const wrapped = CODE.match(PERFORM_OFFICER_SWAP_INSIDE_LOCK_RE) ?? [];
	assert.equal(wrapped.length, 2, `expected exactly 2 wrapped performOfficerSwap call sites, found ${wrapped.length}`);
	const totalCallSites = (CODE.match(/performOfficerSwap\(/g) ?? []).length;
	assert.equal(totalCallSites, 2, `expected exactly 2 performOfficerSwap( call sites total, found ${totalCallSites}`);
});

test('inertness control: the performOfficerSwap-lock matcher rejects a bare (unwrapped) call', () => {
	const fixture = 'const result = await performOfficerSwap({ networkHash, pastedCode, transport, db });';
	assert.doesNotMatch(fixture, PERFORM_OFFICER_SWAP_INSIDE_LOCK_RE, 'matcher is inert');
});
