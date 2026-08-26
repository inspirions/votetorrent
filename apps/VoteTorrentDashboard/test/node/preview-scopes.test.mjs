/**
 * preview-scopes.test.mjs — the pure preview state model's truth table,
 * including the sticky-badge rule and its `resetToReal` positive control,
 * and the cross-product against the REAL gate (never re-implemented here).
 *
 * `node:test` + `node:assert/strict`. No `fake-indexeddb/auto` import — this
 * module touches no storage, and importing the shim would imply a
 * persistence claim this tier cannot make (50-04's gate-contract test states
 * that limit).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	createPreviewState,
	toggleScope,
	resetToReal,
	resyncRealScopes,
	isSimulated,
	effectiveScopes,
	badgeKey,
} from '../../src/auth/preview-scopes.js';
import { CAPABILITIES, SCOPE_CODES } from '../../src/auth/capabilities.js';
import { evaluate } from '../../src/auth/gate.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(__dirname, '..', '..');
const MODULE_PATH = path.join(APP_ROOT, 'src', 'auth', 'preview-scopes.js');
const RAW = readFileSync(MODULE_PATH, 'utf8');

/** Same shape as gate.test.mjs's own helper — strip `//` and `/* *\/`-style
 * comment lines so this module's own JSDoc prose cannot self-invalidate a
 * source-hygiene scan.
 * @param {string} source @returns {string} */
function stripComments(source) {
	return source
		.split('\n')
		.filter((line) => {
			const trimmed = line.trim();
			return !(trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*'));
		})
		.join('\n');
}
const STRIPPED = stripComments(RAW);

test('createPreviewState(["vrg"]) starts real: effectiveScopes ["vrg"], not simulated, real badge', () => {
	const s = createPreviewState(['vrg']);
	assert.deepEqual(effectiveScopes(s), ['vrg']);
	assert.equal(isSimulated(s), false);
	assert.equal(badgeKey(s), 'gate.badgeReal');
});

test('createPreviewState(SCOPE_CODES) (the founding officer\'s real nine) has 9 effective scopes and a real badge', () => {
	const s = createPreviewState(SCOPE_CODES);
	assert.equal(effectiveScopes(s).length, 9);
	assert.equal(badgeKey(s), 'gate.badgeReal');
});

test('toggleScope off from the all-nine state drops exactly that scope and flips to simulated', () => {
	const s0 = createPreviewState(SCOPE_CODES);
	const s1 = toggleScope(s0, 'vrg');
	const eff = effectiveScopes(s1);
	assert.equal(eff.length, 8);
	assert.ok(!eff.includes('vrg'));
	assert.equal(isSimulated(s1), true);
	assert.equal(badgeKey(s1), 'gate.badgeSimulated');
});

test('toggling ON a scope the officer does not hold works, ordered by CAPABILITIES, and is also simulated', () => {
	const s0 = createPreviewState(['vrg']);
	const s1 = toggleScope(s0, 'mel');
	assert.deepEqual(effectiveScopes(s1), ['vrg', 'mel']);
	assert.equal(isSimulated(s1), true);
});

test('sticky-badge rule: toggling a scope off then back on stays simulated -- the badge is not a set comparison', () => {
	const s0 = createPreviewState(SCOPE_CODES);
	const s1 = toggleScope(s0, 'vrg');
	const s2 = toggleScope(s1, 'vrg');
	assert.deepEqual(effectiveScopes(s2), s0.realScopes);
	assert.equal(isSimulated(s2), true);
	assert.equal(badgeKey(s2), 'gate.badgeSimulated');
});

test('positive control: resetToReal on that same round-tripped state clears touched and restores the real badge', () => {
	const s0 = createPreviewState(SCOPE_CODES);
	const s1 = toggleScope(s0, 'vrg');
	const s2 = toggleScope(s1, 'vrg');
	const reset = resetToReal(s2);
	assert.deepEqual(effectiveScopes(reset), s0.realScopes);
	assert.equal(isSimulated(reset), false);
	assert.equal(badgeKey(reset), 'gate.badgeReal');
});

test('effectiveScopes is always ordered by CAPABILITIES order regardless of toggle order', () => {
	const s0 = createPreviewState([]);
	const s1 = toggleScope(s0, 'ik');
	const s2 = toggleScope(s1, 'vrg');
	assert.deepEqual(effectiveScopes(s2), ['vrg', 'ik']);
});

test('toggleScope and resetToReal return new frozen objects; the input state is left unchanged', () => {
	const s0 = createPreviewState(['vrg']);
	const s1 = toggleScope(s0, 'mel');
	assert.notEqual(s1, s0);
	assert.deepEqual(effectiveScopes(s0), ['vrg']);
	assert.ok(Object.isFrozen(s1));
	assert.ok(Object.isFrozen(s1.selected));
	assert.ok(Object.isFrozen(s1.realScopes));
	assert.throws(() => {
		/** @type {any} */ (s1.selected).push('rn');
	});
	assert.throws(() => {
		/** @type {any} */ (s1).touched = false;
	});
});

test('toggleScope(s, "zzz") throws an Error naming zzz', () => {
	const s0 = createPreviewState(['vrg']);
	assert.throws(() => toggleScope(s0, /** @type {any} */ ('zzz')), /zzz/);
});

test('createPreviewState(["zzz"]) throws an Error naming zzz', () => {
	assert.throws(() => createPreviewState(/** @type {any} */ (['zzz'])), /zzz/);
});

test('createPreviewState accepts duplicates and normalises them', () => {
	const s = createPreviewState(['vrg', 'vrg']);
	assert.deepEqual(effectiveScopes(s), ['vrg']);
});

// --- resyncRealScopes (CR-01: the officer's real scopes arrive asynchronously) ---

test('resyncRealScopes: untouched + same real scopes returns the SAME object reference', () => {
	const s0 = createPreviewState(['vrg', 'mel']);
	const s1 = resyncRealScopes(s0, ['vrg', 'mel']);
	assert.equal(s1, s0);
});

test('resyncRealScopes: untouched + different real scopes returns a NEW state deep-equal to createPreviewState(next)', () => {
	const s0 = createPreviewState(['vrg']);
	const s1 = resyncRealScopes(s0, ['vrg', 'mel']);
	assert.notEqual(s1, s0);
	assert.deepEqual(s1, createPreviewState(['vrg', 'mel']));
	assert.equal(isSimulated(s1), false);
	assert.equal(badgeKey(s1), 'gate.badgeReal');
});

test('resyncRealScopes: the CR-01 transition -- an empty real-scope state re-synced to all nine yields 9 effective scopes and the real badge', () => {
	const s0 = createPreviewState([]);
	const s1 = resyncRealScopes(s0, SCOPE_CODES);
	assert.equal(effectiveScopes(s1).length, 9);
	assert.equal(badgeKey(s1), 'gate.badgeReal');
});

test('resyncRealScopes: touched + different real scopes returns the SAME reference -- an in-progress preview is never yanked out', () => {
	const s0 = createPreviewState(['vrg']);
	const touched = toggleScope(s0, 'mel');
	const resynced = resyncRealScopes(touched, ['ceb']);
	assert.equal(resynced, touched);
	assert.deepEqual(effectiveScopes(resynced), effectiveScopes(touched));
	assert.equal(isSimulated(resynced), true);
});

test('positive control: the SAME input with touched false DOES change -- proves the touched guard above is load-bearing, not a function that never changes anything', () => {
	const s0 = createPreviewState(['vrg']);
	const resynced = resyncRealScopes(s0, ['ceb']);
	assert.notEqual(resynced, s0);
	assert.deepEqual(effectiveScopes(resynced), ['ceb']);
});

test('resyncRealScopes: order-insensitive -- untouched, next real scopes equal to the current set in a different order returns the SAME reference', () => {
	const s0 = createPreviewState(['vrg', 'mel']);
	const s1 = resyncRealScopes(s0, ['mel', 'vrg']);
	assert.equal(s1, s0);
});

test('resyncRealScopes: duplicates in nextRealScopes normalise exactly as createPreviewState does', () => {
	const s0 = createPreviewState(['vrg']);
	const s1 = resyncRealScopes(s0, ['vrg', 'vrg']);
	assert.equal(s1, s0);
});

test('resyncRealScopes: validation parity -- an unknown scope code throws an Error naming it, exactly as createPreviewState does, and is not bypassable while touched', () => {
	const s0 = createPreviewState(['vrg']);
	assert.throws(() => resyncRealScopes(s0, /** @type {any} */ (['zzz'])), /zzz/);
	const touched = toggleScope(s0, 'mel');
	assert.throws(() => resyncRealScopes(touched, /** @type {any} */ (['zzz'])), /zzz/);
});

test('resyncRealScopes: returned states are frozen; the input state is left unchanged', () => {
	const s0 = createPreviewState(['vrg']);
	const s1 = resyncRealScopes(s0, ['vrg', 'mel']);
	assert.ok(Object.isFrozen(s1));
	assert.ok(Object.isFrozen(s1.selected));
	assert.ok(Object.isFrozen(s1.realScopes));
	assert.deepEqual(effectiveScopes(s0), ['vrg']);
});

/** The five `<measured_facts>` scope sets, harness fixture ids -- never rendered.
 * @type {Record<string, ReadonlyArray<import('../../src/auth/capabilities.js').ScopeCode>>} */
const FIXTURE_SETS = {
	'real-all-nine': SCOPE_CODES,
	'vrg-only': ['vrg'],
	'election-ops': ['vrg', 'mel', 'ceb'],
	'authority-admin': ['rn', 'uai', 'cap', 'rad', 'ik', 'iad'],
	'no-scopes': [],
};
const EXPECTED_VISIBLE = {
	'real-all-nine': 9,
	'vrg-only': 1,
	'election-ops': 3,
	'authority-admin': 6,
	'no-scopes': 0,
};

test('cross-product against the real gate: each of the five scope sets yields its expected visible count', () => {
	/** @type {Set<unknown>} */
	const seenDenialReasons = new Set();
	for (const [id, scopes] of Object.entries(FIXTURE_SETS)) {
		const state = createPreviewState(scopes);
		const eff = effectiveScopes(state);
		let visibleCount = 0;
		for (const cap of CAPABILITIES) {
			const result = evaluate(cap, eff);
			if (result.visible) visibleCount += 1;
			seenDenialReasons.add(result.denialReason);
		}
		assert.equal(
			visibleCount,
			EXPECTED_VISIBLE[/** @type {keyof typeof EXPECTED_VISIBLE} */ (id)],
			`scope set "${id}" expected ${EXPECTED_VISIBLE[/** @type {keyof typeof EXPECTED_VISIBLE} */ (id)]} visible, got ${visibleCount}`,
		);
	}
	assert.deepEqual([...seenDenialReasons].sort(), [null, 'missing-scope'].sort());
});

test('positive control: the storage matcher hits a fixture "window.localStorage.setItem(\'x\',\'y\')" -- else the inertness check below proves nothing', () => {
	const fixture = "window.localStorage.setItem('x','y')";
	assert.match(fixture, /localStorage|sessionStorage|indexedDB/, 'matcher is inert');
});

test('preview-scopes.js contains no localStorage, sessionStorage or indexedDB reference -- a preview is in-memory only', () => {
	assert.doesNotMatch(STRIPPED, /localStorage|sessionStorage|indexedDB/);
});

test('preview-scopes.js contains no hasScope, visible or denialReason identifier -- it decides no visibility, the gate alone does', () => {
	assert.doesNotMatch(STRIPPED, /hasScope|visible|denialReason/i);
});

test('preview-scopes.js contains none of the tokens read-only, ◐, writable -- comments included, contract §14/§9', () => {
	assert.doesNotMatch(RAW, /read-only|◐|writable/i);
});
