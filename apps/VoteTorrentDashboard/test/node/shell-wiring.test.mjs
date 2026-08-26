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

const HANDOVER_RE = /const handoverDb = dbRef\.current \?\? undefined;[\s\S]{0,400}?db: handoverDb,/;

test('handleConfirmSwap hands its open handle to performOfficerSwap BEFORE the swap runs', () => {
	// performOfficerSwap -> refreshNetwork -> redeemAndBootstrap({ replace:
	// true }) deletes this exact database, and indexedDB.deleteDatabase blocks
	// while any connection is open -- deleteNetworkDb deliberately refuses to
	// resolve on onblocked and throws DeleteBlockedError after its timeout. The
	// shell used to close its handle only AFTER the swap returned, so it raced
	// its own delete and every confirmed swap failed, burning the officer's
	// single-use code.
	assert.match(CODE, HANDOVER_RE);

	// And the handover must precede the call, not follow it.
	const handoverAt = CODE.indexOf('const handoverDb = dbRef.current');
	const swapCallAt = CODE.indexOf('await performOfficerSwap(');
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
