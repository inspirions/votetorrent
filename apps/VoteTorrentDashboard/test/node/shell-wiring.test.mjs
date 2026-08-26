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
import { readFileSync } from 'node:fs';
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
