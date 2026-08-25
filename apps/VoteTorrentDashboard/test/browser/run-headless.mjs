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

async function main() {
	const viteChild = await startViteDevServer();
	let browser;
	try {
		browser = await chromium.launch({ headless: true });
		// One persistent context so IndexedDB survives between the two page loads.
		const ctx = await browser.newContext();

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

		console.log('\n=== SUMMARY ===');
		console.log('db-gate leg (D-11 re-attach):', dbGateOk ? 'PASS' : 'FAIL');
		console.log('shell-gate leg (restored snapshot + forget network):', forgetVerifyOk ? 'PASS' : 'FAIL');

		return finishRun(
			dbGateOk && forgetVerifyOk,
			forgetVerifyOk ? 'all six phases passed' : 'shell-gate phase failed',
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
