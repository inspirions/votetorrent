#!/usr/bin/env node
/**
 * Tier-2 gate runner: seed in one page load, verify in a SECOND, genuinely
 * fresh page load. Exit 0 only if both phases pass and row counts match.
 *
 * `--prove-trap`: runs the SAME two-page structure with `&trap=novtab`
 * appended to page load 1, and INVERTS the expectation — the underlying
 * two-page run must FAIL. If it passes with the mandatory
 * `setDefaultVtabName` omitted, the gate itself is inert; this script then
 * exits non-zero with an explicit "gate is inert" message. A guard that
 * cannot fire is not a guard, and this is the phase's single most important
 * guard.
 *
 * `--tier3` / `--prove-drift` (50-12): the D-20 model↔DOM cross-check, added
 * at this file's natural extension point rather than a named comment left by
 * 50-05 — no such literal marker exists in the as-built file; this is
 * recorded as a finding in 50-12-SUMMARY.md rather than invented here. Both
 * flags run ONLY the tier-3 flow (three `gate-matrix.html` page loads) and
 * return before the tier-2 db-gate/shell-gate phases below — they are
 * separate CI invocations, exactly like `--prove-trap` is a separate
 * invocation of the tier-2 flow, never combined in one run.
 *
 * `--prove-blank` (50-14): the composed-shell gate's own inertness control.
 * Runs ONLY the compose-gate flow (`compose-seed`, then
 * `compose-verify&officer=none`) and returns before the tier-2
 * db-gate/shell-gate phases below, exactly like `--prove-trap` and
 * `--tier3`/`--prove-drift` are their own separate invocations. It INVERTS
 * the expectation: the underlying compose run, against an officer the
 * database grants nothing, must FAIL its nine-panel assertion. If it
 * passes, the composed rung cannot discriminate a real officer from one the
 * database denies everything to — the gate is inert — and this script exits
 * non-zero with an explicit "is inert" message, in the same shape as the two
 * existing inertness controls above.
 *
 * `import { chromium } from 'playwright'` — the FULL package, never the
 * lighter core-only sibling package, and never a hardcoded system-Chrome
 * binary path option (Pitfall 6: the spikes' macOS path does not exist on
 * `ubuntu-24.04`).
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(__dirname, '..', '..');

const PORT = process.env.DASHBOARD_GATE_PORT ?? '5181';
const BASE = `http://localhost:${PORT}`;
const PROVE_TRAP = process.argv.includes('--prove-trap');
const TIER3 = process.argv.includes('--tier3');
const PROVE_DRIFT = process.argv.includes('--prove-drift');
const PROVE_BLANK = process.argv.includes('--prove-blank');

/** @returns {Promise<import('node:child_process').ChildProcess>} */
async function startViteDevServer() {
	const viteBin = path.join(APP_ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
	const child = spawn(process.execPath, [viteBin, '--port', PORT, '--strictPort'], {
		cwd: APP_ROOT,
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	child.stdout?.on('data', (d) => process.stdout.write(`[vite] ${d}`));
	child.stderr?.on('data', (d) => process.stderr.write(`[vite] ${d}`));

	const deadline = Date.now() + 60_000;
	while (Date.now() < deadline) {
		try {
			const res = await fetch(BASE + '/');
			if (res.ok || res.status < 500) return child;
		} catch {
			// not up yet
		}
		await new Promise((r) => setTimeout(r, 250));
	}
	child.kill();
	throw new Error(`Vite dev server did not answer on ${BASE} within 60s`);
}

/**
 * Drive a single ALREADY-OPEN page to a URL and read its `__DB_GATE__`
 * readout. Takes the page as a parameter (rather than opening it itself) so
 * each of the two call sites in `main()` makes its own explicit
 * `ctx.newPage()` call — the tier-2 criterion this whole file exists to
 * satisfy is that phase 2 runs on a DISTINCT, genuinely fresh page, not a
 * same-page reload simulation or a re-invocation of the driver in place.
 *
 * @param {import('playwright').Page} page
 * @param {string} url
 * @param {string} label
 */
async function runOnPage(page, url, label) {
	/** @type {string[]} */
	const lines = [];
	page.on('console', (m) => lines.push(`[${m.type()}] ${m.text()}`));
	page.on('pageerror', (e) => lines.push(`[pageerror] ${e.message}`));
	await page.goto(url, { waitUntil: 'load' });
	await page
		.waitForFunction(() => /** @type {any} */ (window).__DB_GATE_DONE__ === true, null, { timeout: 60_000 })
		.catch(() => {});
	const res = await page.evaluate(() => /** @type {any} */ (window).__DB_GATE__ ?? null);
	await page.close();

	console.log(`\n===== ${label} =====`);
	for (const l of lines) console.log(l);
	if (!res) {
		console.log('NO RESULT');
		return null;
	}
	if (res.crashed) {
		console.log('CRASHED:\n' + res.crashed);
		return res;
	}
	for (const e of res.log ?? []) {
		const m = e.meta ? '\n              ' + JSON.stringify(e.meta) : '';
		console.log(`${String(e.ms).padStart(8)}ms  ${String(e.category).toUpperCase().padEnd(9)} ${e.message}${m}`);
	}
	console.log(`RUNGS: ${res.passed}/${res.total}`);
	if (res.failed?.length) console.log('FAILED: ' + res.failed.join(' | '));
	return res;
}

/**
 * 50-09's sibling of `runOnPage` above, reading `shell-gate.js`'s DISTINCT
 * `__SHELL_GATE__` / `__SHELL_GATE_DONE__` readout names instead of
 * `db-gate.js`'s `__DB_GATE__` / `__DB_GATE_DONE__` — so the two gates can
 * never be confused with one another. A new function rather than a
 * parameterized `runOnPage` so 50-05's own two-page db-gate sequence above
 * is not touched by this extension.
 *
 * @param {import('playwright').Page} page
 * @param {string} url
 * @param {string} label
 */
async function runOnShellGatePage(page, url, label) {
	/** @type {string[]} */
	const lines = [];
	page.on('console', (m) => lines.push(`[${m.type()}] ${m.text()}`));
	page.on('pageerror', (e) => lines.push(`[pageerror] ${e.message}`));
	await page.goto(url, { waitUntil: 'load' });
	await page
		.waitForFunction(() => /** @type {any} */ (window).__SHELL_GATE_DONE__ === true, null, { timeout: 60_000 })
		.catch(() => {});
	const res = await page.evaluate(() => /** @type {any} */ (window).__SHELL_GATE__ ?? null);
	await page.close();

	console.log(`\n===== ${label} =====`);
	for (const l of lines) console.log(l);
	if (!res) {
		console.log('NO RESULT');
		return null;
	}
	if (res.crashed) {
		console.log('CRASHED:\n' + res.crashed);
		return res;
	}
	for (const e of res.log ?? []) {
		const m = e.meta ? '\n              ' + JSON.stringify(e.meta) : '';
		console.log(`${String(e.ms).padStart(8)}ms  ${String(e.category).toUpperCase().padEnd(9)} ${e.message}${m}`);
	}
	console.log(`RUNGS: ${res.passed}/${res.total}`);
	if (res.failed?.length) console.log('FAILED: ' + res.failed.join(' | '));
	return res;
}

/**
 * 50-14's sibling of `runOnPage` / `runOnShellGatePage` above, reading
 * `compose-gate.tsx`'s DISTINCT `__COMPOSE_GATE__` / `__COMPOSE_GATE_DONE__`
 * readout names, for the SAME reason: the composed-shell gate must never be
 * confused with either tier-2 gate or the tier-3 matrix.
 *
 * @param {import('playwright').Page} page
 * @param {string} url
 * @param {string} label
 */
async function runOnComposeGatePage(page, url, label) {
	/** @type {string[]} */
	const lines = [];
	page.on('console', (m) => lines.push(`[${m.type()}] ${m.text()}`));
	page.on('pageerror', (e) => lines.push(`[pageerror] ${e.message}`));
	await page.goto(url, { waitUntil: 'load' });
	await page
		.waitForFunction(() => /** @type {any} */ (window).__COMPOSE_GATE_DONE__ === true, null, { timeout: 60_000 })
		.catch(() => {});
	const res = await page.evaluate(() => /** @type {any} */ (window).__COMPOSE_GATE__ ?? null);
	await page.close();

	console.log(`\n===== ${label} =====`);
	for (const l of lines) console.log(l);
	if (!res) {
		console.log('NO RESULT');
		return null;
	}
	if (res.crashed) {
		console.log('CRASHED:\n' + res.crashed);
		return res;
	}
	for (const e of res.log ?? []) {
		console.log(`${String(e.ms).padStart(8)}ms  ${String(e.category).toUpperCase().padEnd(9)} ${e.message}`);
	}
	console.log(`RUNGS: ${res.passed}/${res.total}  panels: ${res.panels}  badge: ${res.badgeText} (${res.badgeClass})`);
	return res;
}

/**
 * 50-12's sibling of `runOnPage` / `runOnShellGatePage` above, reading
 * `gate-matrix.tsx`'s DISTINCT `__GATE_MATRIX__` / `__GATE_MATRIX_DONE__`
 * readout names, for the SAME reason: the tier-3 gate must never be
 * confused with either tier-2 gate.
 *
 * @param {import('playwright').Page} page
 * @param {string} url
 * @param {string} label
 */
async function runOnGateMatrixPage(page, url, label) {
	/** @type {string[]} */
	const lines = [];
	page.on('console', (m) => lines.push(`[${m.type()}] ${m.text()}`));
	page.on('pageerror', (e) => lines.push(`[pageerror] ${e.message}`));
	await page.goto(url, { waitUntil: 'load' });
	await page
		.waitForFunction(() => /** @type {any} */ (window).__GATE_MATRIX_DONE__ === true, null, { timeout: 60_000 })
		.catch(() => {});
	const res = await page.evaluate(() => /** @type {any} */ (window).__GATE_MATRIX__ ?? null);

	console.log(`\n===== ${label} =====`);
	for (const l of lines) console.log(l);
	if (!res) {
		console.log('NO RESULT');
		return { res: null, lines };
	}
	if (res.crashed) {
		console.log('CRASHED:\n' + res.crashed);
		return { res, lines };
	}
	for (const e of res.log ?? []) {
		console.log(`${String(e.ms).padStart(8)}ms  ${String(e.category).toUpperCase().padEnd(9)} ${e.message}`);
	}
	console.log(`RUNGS: ${res.passed}/${res.total}`);
	return { res, lines };
}

/** The five `<measured_facts>` scope-set fixture ids, in `<measured_facts>`'s own order. */
const TIER3_SCOPE_SET_IDS = ['real-all-nine', 'vrg-only', 'election-ops', 'authority-admin', 'no-scopes'];
/** The three lifecycle phase ids -- D-17 says the rendered panel set must not depend on which one is active. */
const TIER3_PHASE_IDS = ['organizing', 'running', 'released'];
/** Per-scope-set expected visible-capability counts, from `<measured_facts>`. @type {Record<string, number>} */
const TIER3_EXPECTED_VISIBLE = {
	'real-all-nine': 9,
	'vrg-only': 1,
	'election-ops': 3,
	'authority-admin': 6,
	'no-scopes': 0,
};

/**
 * Drives all 20 (or, under `--prove-drift`, exactly 1) rungs against an
 * already-mounted `gate-matrix.html?mode=matrix` page, via its
 * `window.__GATE_MATRIX_RUN__` seam. Every call is individually try/caught
 * so a thrown rung becomes a recorded failure (assertion I) rather than
 * crashing the whole runner.
 *
 * Iterating IN-PAGE against one shared mounted tree (rather than one page
 * load per rung) is deliberate: this tier asserts model↔DOM agreement, not
 * persistence. 50-VALIDATION.md's two-page rule binds PERSISTENCE claims
 * and is 50-05's tier-2 job; this loop must not imply it re-proves that --
 * the tier-2 db-gate/shell-gate phases above are what prove persistence, and
 * this loop proves something orthogonal to it.
 *
 * @param {import('playwright').Page} page
 * @param {boolean} proveDrift
 */
async function driveTier3Rungs(page, proveDrift) {
	/** @type {any[]} */
	const rungs = [];

	/** @param {[string, string, boolean, string?]} args */
	async function callRung(args) {
		try {
			const result = await page.evaluate(
				([scopeSetId, phaseId, reveal, driftAs]) =>
					/** @type {any} */ (window).__GATE_MATRIX_RUN__(scopeSetId, phaseId, reveal, driftAs),
				args,
			);
			rungs.push(result);
		} catch (err) {
			rungs.push({
				scopeSetId: args[0],
				phaseId: args[1],
				reveal: args[2],
				threw: String(/** @type {any} */ (err)?.message ?? err),
			});
		}
	}

	if (proveDrift) {
		await callRung(['election-ops', 'organizing', true, 'authority-admin']);
		return rungs;
	}

	// 15 headline combinations: 5 scope sets x 3 phases, reveal=1 -- denied
	// panels render as frames with no body, so assertion B can be the strong
	// form (frame present, body absent).
	for (const scopeSetId of TIER3_SCOPE_SET_IDS) {
		for (const phaseId of TIER3_PHASE_IDS) {
			// eslint-disable-next-line no-await-in-loop -- deliberately sequential against one shared page/root, see this function's header
			await callRung([scopeSetId, phaseId, true]);
		}
	}
	// 5 additional rungs, one per scope set, phase=organizing, reveal=0 --
	// a denied panel's FRAME must be entirely absent, not just its body.
	for (const scopeSetId of TIER3_SCOPE_SET_IDS) {
		// eslint-disable-next-line no-await-in-loop
		await callRung([scopeSetId, 'organizing', false]);
	}
	return rungs;
}

/**
 * Assertions A-I over the driven rungs. Returns a structured verdict rather
 * than throwing, so the caller can print the full spike-078-style summary
 * table before deciding the process exit code.
 *
 * @param {any[]} rungs
 */
function assertTier3(rungs) {
	/** @type {string[]} */
	const failures = [];
	let headlineComparisons = 0;
	let headlinePassed = 0;

	const headline = rungs.filter((r) => r.reveal === true);
	const revealOff = rungs.filter((r) => r.reveal === false);

	for (const rung of rungs) {
		if (rung.threw) {
			failures.push(`${rung.scopeSetId}/${rung.phaseId}: rung threw: ${rung.threw}`);
			continue;
		}
		const expectReal = rung.scopeSetId === 'real-all-nine';

		// A/B — model<->DOM agreement, and reveal semantics.
		for (const modelEntry of rung.model ?? []) {
			const domEntry = (rung.dom ?? []).find((/** @type {any} */ d) => d.id === modelEntry.id);
			const isHeadline = rung.reveal === true;
			if (isHeadline) headlineComparisons += 1;
			if (!domEntry) {
				failures.push(`${rung.scopeSetId}/${rung.phaseId}/${modelEntry.id}: no DOM entry`);
				continue;
			}
			if (domEntry.bodyPresent === modelEntry.visible) {
				if (isHeadline) headlinePassed += 1;
			} else {
				failures.push(
					`${rung.scopeSetId}/${rung.phaseId}/${modelEntry.id}: model.visible=${modelEntry.visible} but dom.bodyPresent=${domEntry.bodyPresent}`,
				);
			}
			if (rung.reveal === true && !domEntry.framePresent) {
				failures.push(`${rung.scopeSetId}/${rung.phaseId}/${modelEntry.id}: reveal=1 but frame absent`);
			}
			if (rung.reveal === false && !modelEntry.visible && domEntry.framePresent) {
				failures.push(`${rung.scopeSetId}/${rung.phaseId}/${modelEntry.id}: reveal=0 denied capability still has a frame`);
			}
		}

		// F — badge wording, exact strings, keyed by scopeSetId (not reveal).
		const expectedBadgeText = expectReal ? 'answered by the database' : 'simulated scope set';
		const expectedBadgeClass = expectReal ? 'pv-badge--real' : 'pv-badge--sim';
		if (rung.badgeText !== expectedBadgeText) {
			failures.push(`${rung.scopeSetId}/${rung.phaseId}: badgeText="${rung.badgeText}", expected "${expectedBadgeText}"`);
		}
		if (!String(rung.badgeClass ?? '').includes(expectedBadgeClass)) {
			failures.push(`${rung.scopeSetId}/${rung.phaseId}: badgeClass="${rung.badgeClass}", missing "${expectedBadgeClass}"`);
		}

		// G — disclosure present on every rung.
		if (!rung.disclosurePresent) {
			failures.push(`${rung.scopeSetId}/${rung.phaseId}: disclosure not present`);
		}
	}

	// C — expected visible counts per scope set (headline rungs only).
	for (const scopeSetId of TIER3_SCOPE_SET_IDS) {
		const rung = headline.find((r) => r.scopeSetId === scopeSetId);
		const visibleCount = (rung?.model ?? []).filter((/** @type {any} */ m) => m.visible).length;
		if (visibleCount !== TIER3_EXPECTED_VISIBLE[scopeSetId]) {
			failures.push(`${scopeSetId}: expected ${TIER3_EXPECTED_VISIBLE[scopeSetId]} visible, got ${visibleCount}`);
		}
	}

	// D — phase invariance: the visible id SET is identical across all three phases, per scope set.
	for (const scopeSetId of TIER3_SCOPE_SET_IDS) {
		/** @type {Set<string>[]} */
		const sets = TIER3_PHASE_IDS.map((phaseId) => {
			const rung = headline.find((r) => r.scopeSetId === scopeSetId && r.phaseId === phaseId);
			return new Set((rung?.model ?? []).filter((/** @type {any} */ m) => m.visible).map((/** @type {any} */ m) => m.id));
		});
		const [first, ...rest] = sets;
		for (const [i, s] of rest.entries()) {
			const same = first && s.size === first.size && [...first].every((id) => s.has(id));
			if (!same) {
				failures.push(`${scopeSetId}: phase invariance broken between ${TIER3_PHASE_IDS[0]} and ${TIER3_PHASE_IDS[i + 1]}`);
			}
		}
	}

	// E — discrimination: vrg-only and authority-admin must not render the same panel set.
	const vrgOnly = headline.find((r) => r.scopeSetId === 'vrg-only' && r.phaseId === 'organizing');
	const authorityAdmin = headline.find((r) => r.scopeSetId === 'authority-admin' && r.phaseId === 'organizing');
	const vrgVisible = new Set((vrgOnly?.model ?? []).filter((/** @type {any} */ m) => m.visible).map((/** @type {any} */ m) => m.id));
	const adminVisible = new Set(
		(authorityAdmin?.model ?? []).filter((/** @type {any} */ m) => m.visible).map((/** @type {any} */ m) => m.id),
	);
	const discriminates = vrgVisible.size !== adminVisible.size || [...vrgVisible].some((id) => !adminVisible.has(id));
	if (!discriminates) {
		failures.push('discrimination: vrg-only and authority-admin rendered the identical panel set');
	}

	// Summary table, spike-078 style.
	console.log('\n--- tier-3 matrix ---');
	console.log('scopeSet'.padEnd(18) + 'phase'.padEnd(12) + 'reveal'.padEnd(8) + 'granted'.padEnd(9) + 'visible'.padEnd(9) + 'domBodies'.padEnd(11) + 'badge');
	for (const rung of rungs) {
		if (rung.threw) {
			console.log(`${String(rung.scopeSetId).padEnd(18)}${String(rung.phaseId).padEnd(12)}${String(rung.reveal).padEnd(8)}THREW: ${rung.threw}`);
			continue;
		}
		const grantedCount = (rung.effective ?? []).length;
		const visibleCount = (rung.model ?? []).filter((/** @type {any} */ m) => m.visible).length;
		const domBodyCount = (rung.dom ?? []).filter((/** @type {any} */ d) => d.bodyPresent).length;
		console.log(
			String(rung.scopeSetId).padEnd(18) +
				String(rung.phaseId).padEnd(12) +
				String(rung.reveal).padEnd(8) +
				String(grantedCount).padEnd(9) +
				String(visibleCount).padEnd(9) +
				String(domBodyCount).padEnd(11) +
				`${rung.badgeText} (${rung.badgeClass})`,
		);
	}
	console.log(revealOff.length ? `reveal=0 rungs: ${revealOff.length}` : '');

	return { ok: failures.length === 0, failures, headlineComparisons, headlinePassed };
}

/**
 * `--tier3` / `--prove-drift`'s entry point. Runs entirely on its own —
 * never combined with the tier-2 db-gate/shell-gate flow in one invocation.
 *
 * @param {import('playwright').BrowserContext} ctx
 */
async function runTier3(ctx) {
	const page1 = await ctx.newPage();
	const { res: seedRes } = await runOnGateMatrixPage(page1, `${BASE}/test/browser/gate-matrix.html?mode=seed`, 'TIER-3 PAGE 1 — seed');
	await page1.close();
	const seedOk = seedRes && !seedRes.crashed && seedRes.passed === seedRes.total;
	if (!seedOk) {
		console.log('\nTIER-3: FAIL (gate-matrix seed failed)');
		process.exitCode = 1;
		return;
	}

	const page2 = await ctx.newPage();
	/** @type {string[]} */
	const matrixLines = [];
	page2.on('pageerror', (e) => matrixLines.push(`[pageerror] ${e.message}`));
	const { res: mountRes } = await runOnGateMatrixPage(
		page2,
		`${BASE}/test/browser/gate-matrix.html?mode=matrix`,
		'TIER-3 PAGE 2 — matrix (mount)',
	);
	const mountOk = mountRes && !mountRes.crashed && mountRes.passed === mountRes.total;
	if (!mountOk) {
		console.log('\nTIER-3: FAIL (gate-matrix mount failed)');
		await page2.close();
		process.exitCode = 1;
		return;
	}

	const rungs = await driveTier3Rungs(page2, PROVE_DRIFT);
	const pageErrors = matrixLines.filter((l) => l.startsWith('[pageerror]'));
	await page2.close();

	if (PROVE_DRIFT) {
		const rung = rungs[0];
		const divergent = (rung?.model ?? []).filter((/** @type {any} */ m) => {
			const domEntry = (rung.dom ?? []).find((/** @type {any} */ d) => d.id === m.id);
			return domEntry && domEntry.bodyPresent !== m.visible;
		});
		console.log(`\n--prove-drift rung: scopeSetId=election-ops, driftAs=authority-admin, effective(model)=${JSON.stringify(rung?.effective)}`);
		if (divergent.length === 0) {
			console.log(
				'\nTIER-3 --prove-drift: FAIL — cross-check is inert: a deliberately mismatched scope set was not detected',
			);
			process.exitCode = 1;
			return;
		}
		console.log(
			`\nTIER-3 --prove-drift: PASS — the deliberately mismatched scope set was correctly detected as a FAILURE (diverged: ${divergent.map((/** @type {any} */ d) => d.id).join(', ')})`,
		);
		process.exitCode = 0;
		return;
	}

	const verdict = assertTier3(rungs);

	const page3 = await ctx.newPage();
	const { res: freshRes } = await runOnGateMatrixPage(
		page3,
		`${BASE}/test/browser/gate-matrix.html?mode=fresh`,
		'TIER-3 PAGE 3 — fresh (a preview must never survive a reload)',
	);
	await page3.close();
	const freshOk = freshRes && !freshRes.crashed && freshRes.badgeText === 'answered by the database' && freshRes.disclosurePresent === true;
	if (!freshOk) {
		verdict.failures.push(`mode=fresh: badgeText="${freshRes?.badgeText}", disclosurePresent=${freshRes?.disclosurePresent}`);
		verdict.ok = false;
	}

	if (pageErrors.length > 0) {
		verdict.failures.push(`page emitted ${pageErrors.length} pageerror(s): ${pageErrors.join(' | ')}`);
		verdict.ok = false;
	}

	console.log(`\n${verdict.headlinePassed}/${verdict.headlineComparisons} headline model<->DOM comparisons passed`);
	console.log(`${rungs.filter((r) => !r.threw).length}/${rungs.length} rungs completed without throwing`);
	if (verdict.failures.length) {
		console.log('FAILURES:\n  ' + verdict.failures.join('\n  '));
	}
	console.log(`\nTIER-3: ${verdict.ok ? 'PASS' : 'FAIL'} (${rungs.length}/${rungs.length} rungs, ${verdict.headlinePassed}/${verdict.headlineComparisons} headline comparisons)`);
	process.exitCode = verdict.ok ? 0 : 1;
}

/**
 * `--prove-blank`'s entry point (50-14). Runs entirely on its own -- never
 * combined with the tier-2/tier-3 flows in one invocation, exactly like
 * `--prove-trap` and `--tier3`/`--prove-drift` are their own separate runs.
 *
 * @param {import('playwright').BrowserContext} ctx
 */
async function runProveBlank(ctx) {
	const page1 = await ctx.newPage();
	const seedRes = await runOnComposeGatePage(
		page1,
		`${BASE}/test/browser/compose-gate.html?phase=compose-seed`,
		'PROVE-BLANK PAGE 1 — compose-seed',
	);
	const seedOk = seedRes && !seedRes.crashed && seedRes.passed === seedRes.total;
	if (!seedOk) {
		console.log('\nPROVE-BLANK: FAIL (compose-seed itself failed -- the inertness control could not run)');
		process.exitCode = 1;
		return;
	}

	const page2 = await ctx.newPage();
	const verifyRes = await runOnComposeGatePage(
		page2,
		`${BASE}/test/browser/compose-gate.html?phase=compose-verify&officer=none`,
		'PROVE-BLANK PAGE 2 — compose-verify&officer=none (deliberately scope-less officer)',
	);
	const underlyingRunPassed = verifyRes && !verifyRes.crashed && verifyRes.passed === verifyRes.total;

	// INVERTED: the underlying run against a scope-less officer must FAIL its
	// nine-panel assertion. If it passed, this rung cannot tell a real
	// officer from one the database denies everything to -- the gate is
	// inert, in the same shape as the two pre-existing inertness controls.
	if (underlyingRunPassed) {
		console.log(
			'\nCOMPOSE GATE --prove-blank: FAIL — the composed rung is inert: an officer the database grants nothing still reported the full panel set',
		);
		process.exitCode = 1;
		return;
	}
	console.log(
		`\nCOMPOSE GATE --prove-blank: PASS — the scope-less officer genuinely failed the nine-panel assertion (panels: ${verifyRes?.panels})`,
	);
	process.exitCode = 0;
}

async function main() {
	const viteChild = await startViteDevServer();
	let browser;
	try {
		browser = await chromium.launch({ headless: true });
		// One persistent context so IndexedDB survives between the two page loads.
		const ctx = await browser.newContext();

		// --prove-blank runs ONLY the compose-gate flow and returns here -- see
		// this file's header note.
		if (PROVE_BLANK) {
			return await runProveBlank(ctx);
		}

		// --tier3 / --prove-drift run ONLY the tier-3 flow and return here --
		// see this file's header note. Everything below this block is the
		// unchanged 50-05/50-09 tier-2 flow.
		if (TIER3 || PROVE_DRIFT) {
			return await runTier3(ctx);
		}

		// Page load 1 — seed. Its own, dedicated ctx.newPage() call.
		const page1 = await ctx.newPage();
		const seedUrl = `${BASE}/test/browser/db-gate.html?phase=seed${PROVE_TRAP ? '&trap=novtab' : ''}`;
		const seedRes = await runOnPage(page1, seedUrl, `PHASE 1 — seed${PROVE_TRAP ? ' (TRAP: novtab)' : ''}`);

		const seedOk = seedRes && !seedRes.crashed && seedRes.passed === seedRes.total;
		if (!seedOk) {
			return finishRun(false, 'phase 1 failed', PROVE_TRAP);
		}

		const expect = encodeURIComponent(JSON.stringify(seedRes.counts ?? {}));

		// Page load 2 — verify. D-20's binding rule: this is a SECOND, distinct
		// ctx.newPage() call against a brand-new JS realm — never a re-navigation
		// of page1, never an in-place re-run of the driver. That distinction is
		// exactly what makes this tier able to catch a same-session-invisible
		// bug (a missing setDefaultVtabName looks fine right up until a real
		// fresh page boundary).
		const page2 = await ctx.newPage();
		const verifyRes = await runOnPage(
			page2,
			`${BASE}/test/browser/db-gate.html?phase=verify&expect=${expect}`,
			'PHASE 2 — reopen on a genuinely fresh page load',
		);

		const dbGateOk = verifyRes && !verifyRes.crashed && verifyRes.passed === verifyRes.total;

		console.log('\n--- cross-phase (db-gate) ---');
		console.log('phase1 stores:', seedRes.stores?.length, '| phase2 stores:', verifyRes?.stores?.length);
		console.log('phase1 counts:', JSON.stringify(seedRes.counts), '| phase2 counts:', JSON.stringify(verifyRes?.counts));

		if (!dbGateOk) {
			return finishRun(false, 'db-gate phase 2 failed', PROVE_TRAP);
		}

		// --prove-trap already returned above: the trap fails phase 1 (a
		// missing setDefaultVtabName), so `seedOk` is false and this point is
		// never reached in trap mode. Everything below runs only for an
		// ordinary invocation.

		// ---------------------------------------------------------------
		// 50-09 extension: the restored-snapshot + forget-network legs,
		// against the SAME persistent context so IndexedDB and localStorage
		// both carry across every page load below.
		// ---------------------------------------------------------------

		// Page load 3 — shell restore-seed. Its own, dedicated ctx.newPage() call.
		const page3 = await ctx.newPage();
		const restoreSeedRes = await runOnShellGatePage(
			page3,
			`${BASE}/test/browser/shell-gate.html?phase=restore-seed`,
			'PHASE 3 — shell restore-seed',
		);
		const restoreSeedOk = restoreSeedRes && !restoreSeedRes.crashed && restoreSeedRes.passed === restoreSeedRes.total;
		if (!restoreSeedOk) {
			return finishRun(false, 'shell restore-seed failed', PROVE_TRAP);
		}

		const shellExpect = encodeURIComponent(JSON.stringify(restoreSeedRes.counts ?? {}));

		// 50-VALIDATION.md's binding rule: a same-page reload SIMULATION does
		// not satisfy tier 2 -- only a genuinely fresh page load counts. This
		// is a brand-new ctx.newPage() call against a brand-new JS realm.
		const page4 = await ctx.newPage();
		const restoreVerifyRes = await runOnShellGatePage(
			page4,
			`${BASE}/test/browser/shell-gate.html?phase=restore-verify&expect=${shellExpect}`,
			'PHASE 4 — shell restore-verify (fresh page load)',
		);
		const restoreVerifyOk =
			restoreVerifyRes && !restoreVerifyRes.crashed && restoreVerifyRes.passed === restoreVerifyRes.total;
		if (!restoreVerifyOk) {
			return finishRun(false, 'shell restore-verify failed', PROVE_TRAP);
		}

		// Page load 5 — the destructive forget leg (plus its paired negative
		// control on a second, neighbouring network). Its own ctx.newPage() call.
		const page5 = await ctx.newPage();
		const forgetRes = await runOnShellGatePage(page5, `${BASE}/test/browser/shell-gate.html?phase=forget`, 'PHASE 5 — shell forget');
		const forgetOk = forgetRes && !forgetRes.crashed && forgetRes.passed === forgetRes.total;
		if (!forgetOk) {
			return finishRun(false, 'shell forget failed', PROVE_TRAP);
		}

		// 50-VALIDATION.md's binding rule: a same-page reload SIMULATION does
		// not satisfy tier 2 -- only a genuinely fresh page load counts. This
		// is the whole point of D-15: the proof that a forgotten network is
		// actually gone belongs to a page load that never created it.
		const page6 = await ctx.newPage();
		const forgetVerifyRes = await runOnShellGatePage(
			page6,
			`${BASE}/test/browser/shell-gate.html?phase=forget-verify`,
			'PHASE 6 — shell forget-verify (fresh page load)',
		);
		const forgetVerifyOk =
			forgetVerifyRes && !forgetVerifyRes.crashed && forgetVerifyRes.passed === forgetVerifyRes.total;

		console.log('\n--- cross-phase (shell-gate) ---');
		console.log('restore-seed counts:', JSON.stringify(restoreSeedRes.counts));
		console.log('restore-verify:', `${restoreVerifyRes.passed}/${restoreVerifyRes.total}`);
		console.log('forget:', `${forgetRes.passed}/${forgetRes.total}`, '| forget-verify:', `${forgetVerifyRes?.passed}/${forgetVerifyRes?.total}`);

		// ---------------------------------------------------------------
		// 50-14 extension: the composed-shell leg. Two MORE fresh page loads,
		// each its own ctx.newPage(), against the SAME persistent context --
		// eight page loads total in the default run. This is the rung that
		// mounts the real, production DashboardShell (never a control or a
		// grid harnessed by hand) and would have caught CR-01.
		// ---------------------------------------------------------------

		const page7 = await ctx.newPage();
		const composeSeedRes = await runOnComposeGatePage(
			page7,
			`${BASE}/test/browser/compose-gate.html?phase=compose-seed`,
			'PHASE 7 — composed shell: compose-seed',
		);
		const composeSeedOk = composeSeedRes && !composeSeedRes.crashed && composeSeedRes.passed === composeSeedRes.total;
		if (!composeSeedOk) {
			return finishRun(false, 'compose-seed failed', PROVE_TRAP);
		}

		// A brand-new ctx.newPage() call against a brand-new JS realm -- the
		// same fresh-page-boundary discipline every other verify phase in
		// this file already holds to.
		const page8 = await ctx.newPage();
		const composeVerifyRes = await runOnComposeGatePage(
			page8,
			`${BASE}/test/browser/compose-gate.html?phase=compose-verify`,
			'PHASE 8 — composed shell: compose-verify (fresh page load, zero interaction)',
		);
		const composeVerifyOk =
			composeVerifyRes &&
			!composeVerifyRes.crashed &&
			composeVerifyRes.passed === composeVerifyRes.total &&
			composeVerifyRes.panels === 9;

		console.log('\n--- cross-phase (compose-gate) ---');
		console.log(
			'compose-verify:',
			`${composeVerifyRes?.passed}/${composeVerifyRes?.total}`,
			'| panels:',
			composeVerifyRes?.panels,
			'| badge:',
			composeVerifyRes?.badgeText,
		);

		console.log('\n=== SUMMARY ===');
		console.log('db-gate leg (D-11 re-attach):', dbGateOk ? 'PASS' : 'FAIL');
		console.log('shell-gate leg (restored snapshot + forget network):', forgetVerifyOk ? 'PASS' : 'FAIL');
		console.log('compose-gate leg (composed DashboardShell, nine populated panels):', composeVerifyOk ? 'PASS' : 'FAIL');

		return finishRun(
			dbGateOk && forgetVerifyOk && composeVerifyOk,
			composeVerifyOk ? 'all eight phases passed' : 'compose-gate phase failed',
			PROVE_TRAP,
		);
	} finally {
		await browser?.close();
		viteChild.kill();
	}
}

/**
 * @param {boolean} underlyingRunPassed
 * @param {string} reason
 * @param {boolean} proveTrap
 */
function finishRun(underlyingRunPassed, reason, proveTrap) {
	if (!proveTrap) {
		console.log(`\nDB GATE: ${underlyingRunPassed ? 'PASS' : 'FAIL'} (${reason})`);
		process.exitCode = underlyingRunPassed ? 0 : 1;
		return;
	}

	// --prove-trap inverts the expectation: the trapped run must FAIL.
	if (underlyingRunPassed) {
		console.log(
			'\nDB GATE --prove-trap: FAIL — gate is inert: a missing setDefaultVtabName was not detected',
		);
		process.exitCode = 1;
		return;
	}
	console.log(`\nDB GATE --prove-trap: PASS — the trapped run genuinely failed (${reason})`);
	process.exitCode = 0;
}

main().catch((err) => {
	if (String(err?.message ?? err).includes('Executable doesn\'t exist')) {
		console.error(
			'\n[db-gate] Playwright could not find the Chromium binary. Run:\n' +
				'  yarn workspace votetorrent-dashboard exec playwright install chromium\n',
		);
		process.exitCode = 1;
		return;
	}
	console.error('[db-gate] runner crashed:', err);
	process.exitCode = 1;
});
