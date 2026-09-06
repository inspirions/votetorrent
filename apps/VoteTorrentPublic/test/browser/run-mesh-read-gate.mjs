#!/usr/bin/env node
/**
 * run-mesh-read-gate.mjs — the driver: origin preflight, runtime
 * config/expectations emission, pinned-TLS browser launch, rung grading, and
 * the exported liveness-rung id list `56-13` consumes.
 *
 * Usage, from `apps/VoteTorrentPublic`:
 *
 *   NODE_EXTRA_CA_CERTS="$(mkcert -CAROOT)/rootCA.pem" node test/browser/run-mesh-read-gate.mjs
 *
 * `56-08`'s user_setup (inherited, not re-decided here): `mkcert -install`
 * must already have been run on this host, and this gate dials the
 * gateway's REAL WSS listener from a real Chromium — it does not disable
 * TLS validation, it PINS the leaf's SPKI.
 *
 * `vite build` is SPAWNED, never imported, so the gate exercises a real
 * artefact of a real build — same discipline `run-live-read-gate.mjs`
 * established. This driver binds port 5197 (the settled map in
 * `56-PLAN-OUTLINE.md` Amendment 3) and fails loudly on `EADDRINUSE` rather
 * than silently grading another server's page.
 *
 * FAILURE TAXONOMY, on stderr: `PREFLIGHT_FAILED:<reason>` for every way
 * this gate could certify something false before a browser is launched (a
 * `PreflightFailedError`, thrown from anywhere in the run — including
 * post-launch checks like the served-bundle-provenance value check and the
 * origin-mutate handshake, both of which are preconditions for a
 * MEANINGFUL grade, not a graded rung themselves); `RUNGS_FAILED` for every
 * other failure, once rungs actually ran. The origin is ALWAYS told to stop
 * and its exit ALWAYS awaited, in one `finally`, regardless of which path
 * was taken — an aborted run must leave no orphaned CadreNode.
 *
 * DELIBERATELY NOT WIRED into a `gate:prove-*` script: `56-13` owns every
 * inversion this gate's design makes possible. Adding one here would be
 * this plan claiming a control it does not run.
 */
import { spawn } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { randomBytes } from 'node:crypto';

import { chromium } from 'playwright';
import { serveDist } from '../../../../packages/ui-web/scripts/lib/serve-dist.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(__dirname, '..', '..');
const REPO_ROOT = path.resolve(APP_ROOT, '..', '..');
const DIST_MESH_READ = path.join(APP_ROOT, 'dist-mesh-read');
const BUILD_CONFIG = 'vite.mesh-read.config.ts';
const ENTRY_NAME = 'mesh-read-gate.html';
const ORIGIN_SCRIPT = path.join(APP_ROOT, 'test', 'browser', 'mesh-read-origin.mjs');
const GATEWAY_CONFIG = path.join(REPO_ROOT, 'packages', 'p2p-probe-host', 'gateway.config.json');
const EDGE_NODE_SOURCE = path.join(APP_ROOT, 'src', 'peer', 'edge-node.js');
const PORT = 5197;

/** The D-16 inversion's exact rung ids — exported so `56-13` imports this
 * contract instead of re-typing two integers that can drift.
 * @type {ReadonlyArray<number>} */
export const LIVENESS_RUNGS = Object.freeze([9, 10]);
/** @type {number} */
export const TOTAL_RUNGS = 10;

/**
 * `56-24`: the exact `weald` (the `@libp2p/logger` wrapper) namespace list
 * enabled on the page BEFORE any page script runs, so libp2p's OWN dial-path
 * diagnostics reach this driver's captured console instead of being
 * swallowed into a logger nobody enables. Each component name below is
 * read from the app's OWN resolved `node_modules`, at the exact site named,
 * never guessed:
 *   - `libp2p:bootstrap` — `@libp2p/bootstrap` `dist/src/index.js:59` — the
 *     module whose fire-and-forget dial this measurement is instrumenting.
 *   - `libp2p:connection-manager` — `libp2p` `dist/src/connection-manager/index.js:55`.
 *   - `libp2p:connection-manager:dial-queue` — `libp2p`
 *     `dist/src/connection-manager/dial-queue.js:47` — the actual dial
 *     attempt path `openConnection` reaches.
 *   - `libp2p:websockets` — `@libp2p/websockets` `dist/src/index.js:39`.
 *   - `libp2p:websockets:connection` — `@libp2p/websockets`
 *     `dist/src/index.js:65`.
 * An empty string here (this driver's own negative control) disables every
 * namespace, proving the constant is load-bearing rather than dead config.
 * @type {string}
 */
export const LIBP2P_DIAL_DEBUG_NAMESPACES =
	'libp2p:bootstrap,libp2p:connection-manager,libp2p:connection-manager:dial-queue,libp2p:websockets,libp2p:websockets:connection';

/** A way this gate could certify something false, named and thrown from
 * anywhere in the run — never a bare `process.exit`, so the origin is
 * always stopped and every opened resource always closed. */
class PreflightFailedError extends Error {
	/** @param {string} reason */
	constructor(reason) {
		super(`PREFLIGHT_FAILED:${reason}`);
		this.name = 'PreflightFailedError';
		this.reason = reason;
	}
}

/**
 * Wraps the spawned origin child: parses its `ORIGIN_*` stdout lines into a
 * fact map, exposes a line-matching wait primitive for the handshake, and
 * forwards every line (both streams) into this process's own log.
 */
class OriginController {
	/** @param {import('node:child_process').ChildProcessWithoutNullStreams} child */
	constructor(child) {
		this.child = child;
		/** @type {Record<string, string>} */
		this.facts = {};
		/** @type {string[]} */
		this.controlAddrs = [];
		/** @type {Set<(line: string) => void>} */
		this.listeners = new Set();
		this.exited = false;
		this.exitCode = /** @type {number | null} */ (null);
		const rl = createInterface({ input: child.stdout });
		rl.on('line', (line) => this._onLine(line));
		child.stderr.on('data', (d) => process.stderr.write(`[origin] ${d}`));
		child.on('exit', (code) => {
			this.exited = true;
			this.exitCode = code;
		});
	}

	/** @param {string} line */
	_onLine(line) {
		console.log(`[origin] ${line}`);
		const eq = line.indexOf('=');
		if (eq > 0) {
			const key = line.slice(0, eq);
			const value = line.slice(eq + 1);
			if (key === 'ORIGIN_CONTROL_ADDR') this.controlAddrs.push(value);
			else this.facts[key] = value;
		}
		for (const fn of [...this.listeners]) fn(line);
	}

	/**
	 * @param {(line: string) => boolean} matchFn
	 * @param {number} timeoutMs
	 * @param {string} label
	 * @returns {Promise<string>}
	 */
	waitForLine(matchFn, timeoutMs, label) {
		return new Promise((resolve, reject) => {
			/** @type {(line: string) => void} */
			let listener;
			const timer = setTimeout(() => {
				this.listeners.delete(listener);
				reject(new Error(`timed out waiting for ${label}`));
			}, timeoutMs);
			listener = (line) => {
				if (matchFn(line)) {
					clearTimeout(timer);
					this.listeners.delete(listener);
					resolve(line);
				}
			};
			this.listeners.add(listener);
		});
	}

	/** @param {string} command */
	send(command) {
		this.child.stdin.write(command + '\n');
	}

	/** Sends `stop`, then awaits exit up to 10s. @returns {Promise<void>} */
	async stopAndAwaitExit() {
		try {
			this.send('stop');
		} catch {
			// The child may already be gone; nothing to do.
		}
		await new Promise((resolve) => {
			if (this.exited) {
				resolve(undefined);
				return;
			}
			this.child.once('exit', () => resolve(undefined));
			setTimeout(() => resolve(undefined), 10_000);
		});
	}
}

/** @returns {Promise<void>} */
function buildGate() {
	return new Promise((resolve, reject) => {
		const viteBin = path.join(APP_ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
		const child = spawn(process.execPath, [viteBin, 'build', '--config', BUILD_CONFIG], {
			cwd: APP_ROOT,
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		child.stdout?.on('data', (d) => process.stdout.write(`[vite] ${d}`));
		child.stderr?.on('data', (d) => process.stderr.write(`[vite] ${d}`));
		child.on('error', reject);
		child.on('exit', (code) =>
			code === 0 ? resolve(undefined) : reject(new Error(`vite build --config ${BUILD_CONFIG} exited ${code}`)),
		);
	});
}

/**
 * Walk `dir` for the one file named `name` and return its path RELATIVE to
 * `dir`. Zero matches and more than one are both hard failures.
 * @param {string} dir
 * @param {string} name
 * @returns {string}
 */
function resolveEntry(dir, name) {
	/** @type {string[]} */
	const matches = [];
	/** @param {string} current */
	const walk = (current) => {
		for (const entry of readdirSync(current, { withFileTypes: true })) {
			const full = path.join(current, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (entry.name === name) matches.push(path.relative(dir, full));
		}
	};
	walk(dir);
	if (matches.length === 0) throw new Error(`the gate build emitted no "${name}" under ${dir}`);
	if (matches.length > 1) throw new Error(`the gate build emitted ${matches.length} files named "${name}": ${matches.join(', ')}`);
	return matches[0];
}

/**
 * The exact string-literal contract token, read from a comment-stripped
 * scan of the harness's own SOURCE (never from the served/built artefact) —
 * this is the value the served page must publish at runtime.
 * @returns {string}
 */
function readContractFromSource() {
	const source = readFileSync(path.join(APP_ROOT, 'test', 'browser', 'mesh-read-gate.js'), 'utf8');
	const stripped = source
		.split('\n')
		.filter((line) => !/^\s*[*/]/.test(line))
		.join('\n');
	const match = stripped.match(/MESH_READ_GATE_CONTRACT\s*=\s*'([^']+)'/);
	if (!match) throw new Error('could not find MESH_READ_GATE_CONTRACT in mesh-read-gate.js source');
	return match[1];
}

/**
 * The exact integer `PUBLIC_COHORT_MIN_SIGS` this deployment's browser Edge
 * node is built with, read from a comment-stripped scan of `edge-node.js`'s
 * own SOURCE — never `import()`ed (that module pulls browser-only packages
 * and cannot load in this Node process). Companion read to
 * `readContractFromSource`, same discipline.
 * @returns {number}
 */
function readBrowserCohortMinSigsFromSource() {
	const source = readFileSync(EDGE_NODE_SOURCE, 'utf8');
	const stripped = source
		.split('\n')
		.filter((line) => !/^\s*[*/]/.test(line))
		.join('\n');
	const match = stripped.match(/PUBLIC_COHORT_MIN_SIGS\s*=\s*(\d+)/);
	if (!match) {
		throw new PreflightFailedError('cohort-parameter-unreadable: could not find PUBLIC_COHORT_MIN_SIGS in edge-node.js source');
	}
	return Number(match[1]);
}

/**
 * The one cross-source drift that would produce a red gate for a
 * configuration reason while looking exactly like a code defect — the
 * browser's exported cohort threshold and the operator's gateway config's
 * `strandCohortTopic.minSigs` disagreeing (56-17's `PUBLIC_COHORT_MIN_SIGS`
 * and 56-18's `strandCohortTopic.minSigs` are a two-sided deployment
 * parameter; see `56-17-COHORT-TOPIC-POSTURE.md`'s dedicated section).
 * Refuses BEFORE the origin boots or a browser launches — this is a source-
 * level read on both sides, so it needs neither.
 * @returns {void}
 */
function checkCohortParameterAgreement() {
	const browserMinSigs = readBrowserCohortMinSigsFromSource();

	/** @type {any} */
	let gatewayConfig;
	try {
		gatewayConfig = JSON.parse(readFileSync(GATEWAY_CONFIG, 'utf8'));
	} catch (err) {
		throw new PreflightFailedError(`cohort-parameter-config-unreadable: ${/** @type {any} */ (err)?.message}`);
	}
	if (
		!gatewayConfig ||
		typeof gatewayConfig.strandCohortTopic !== 'object' ||
		gatewayConfig.strandCohortTopic === null ||
		!Number.isInteger(gatewayConfig.strandCohortTopic.minSigs)
	) {
		throw new PreflightFailedError(
			'cohort-parameter-config-missing-key: gateway config has no strandCohortTopic.minSigs integer key',
		);
	}

	const gatewayMinSigs = gatewayConfig.strandCohortTopic.minSigs;
	if (gatewayMinSigs !== browserMinSigs) {
		throw new PreflightFailedError(
			`cohort-parameter-drift: browser PUBLIC_COHORT_MIN_SIGS=${browserMinSigs} !== gateway strandCohortTopic.minSigs=${gatewayMinSigs}`,
		);
	}
	console.log(`[mesh-read-gate] cohort-parameter agreement PASS: minSigs=${browserMinSigs} on both sides`);
}

/**
 * Spawn the origin and drive it to `ORIGIN_READY`, then re-assert every
 * precondition at THIS consumer boundary — read back, never inferred from
 * the origin's own exit code alone.
 * @param {string} strandId
 * @returns {Promise<OriginController>}
 */
async function bootOrigin(strandId) {
	const originChild = spawn(process.execPath, [ORIGIN_SCRIPT, '--config', GATEWAY_CONFIG, '--strand-id', strandId], {
		cwd: APP_ROOT,
		stdio: ['pipe', 'pipe', 'pipe'],
	});
	const origin = new OriginController(originChild);

	try {
		await origin.waitForLine((line) => line === 'ORIGIN_READY' || line.startsWith('ORIGIN_FATAL:'), 120_000, 'ORIGIN_READY');
	} catch (err) {
		throw new PreflightFailedError(`origin-startup-timeout: ${/** @type {any} */ (err)?.message}`);
	}
	if (origin.exited) {
		throw new PreflightFailedError(`origin-crashed: exited with code ${origin.exitCode} before ORIGIN_READY`);
	}

	if (origin.facts.ORIGIN_PROVENANCE !== 'PASS') {
		throw new PreflightFailedError(`origin-provenance: verdict is "${origin.facts.ORIGIN_PROVENANCE}", expected "PASS"`);
	}
	const authorizedMembers = Number(origin.facts.ORIGIN_AUTHORIZED_MEMBERS ?? 'NaN');
	if (!(authorizedMembers >= 1)) {
		throw new PreflightFailedError(`origin-cold-start: ORIGIN_AUTHORIZED_MEMBERS is "${origin.facts.ORIGIN_AUTHORIZED_MEMBERS}", expected >= 1`);
	}
	if (origin.facts.ORIGIN_ENROLLMENT_WINDOW_UNTIL !== '0') {
		throw new PreflightFailedError(
			`origin-enrollment-window-open: ORIGIN_ENROLLMENT_WINDOW_UNTIL is "${origin.facts.ORIGIN_ENROLLMENT_WINDOW_UNTIL}", expected "0"`,
		);
	}
	if (origin.controlAddrs.length === 0 || !origin.controlAddrs.every((addr) => addr.includes('/tls/ws'))) {
		throw new PreflightFailedError('origin-plaintext-addr: no ORIGIN_CONTROL_ADDR carries /tls/ws');
	}
	if (!origin.facts.ORIGIN_TLS_SPKI) {
		throw new PreflightFailedError('tls-pin-absent: ORIGIN_TLS_SPKI is empty');
	}
	if (origin.facts.ORIGIN_SEEDED !== 'ok') {
		throw new PreflightFailedError(`origin-seed: ORIGIN_SEEDED is "${origin.facts.ORIGIN_SEEDED}", expected "ok"`);
	}

	console.log('[mesh-read-gate] origin preflight PASS');
	return origin;
}

/**
 * @param {OriginController} origin
 * @param {string} strandId
 * @returns {Promise<any>} the page's published readout
 */
async function runBrowserPhase(origin, strandId) {
	await buildGate();
	const entryRel = resolveEntry(DIST_MESH_READ, ENTRY_NAME);

	// Write the two runtime files AFTER the build so emptyOutDir cannot erase
	// them. 56-06's recorded reason: the peerId is minted per run, so a
	// build-time copy would be stale by construction.
	const configJson = { bootstrapNodes: [origin.controlAddrs[0]] };
	writeFileSync(path.join(DIST_MESH_READ, 'config.json'), JSON.stringify(configJson, null, 2));
	const gateExpectations = {
		electionId: origin.facts.ORIGIN_ELECTION_ID,
		networkHash: strandId,
		title: origin.facts.ORIGIN_ELECTION_TITLE,
		atInstant: origin.facts.ORIGIN_AT_INSTANT,
		keyholdersBefore: Number(origin.facts.ORIGIN_KEYHOLDERS_BEFORE ?? '0'),
	};
	writeFileSync(path.join(DIST_MESH_READ, 'gate-expectations.json'), JSON.stringify(gateExpectations, null, 2));

	const server = await serveDist(DIST_MESH_READ, PORT);
	/** @type {string[]} */
	const lines = [];
	/** @type {import('playwright').Browser | undefined} */
	let browser;
	try {
		// The pin, and NOTHING else — a different certificate still fails, so
		// this gate can still fail on a bad chain. The bare
		// `--ignore-certificate-errors` is forbidden.
		browser = await chromium.launch({
			headless: true,
			args: [`--ignore-certificate-errors-spki-list=${origin.facts.ORIGIN_TLS_SPKI}`],
		});
		const context = await browser.newContext();
		// 56-24: enable weald's browser debug namespaces BEFORE any page script
		// runs, so libp2p's own dial-path diagnostics reach this driver's
		// captured console. `weald`'s browser build reads `localStorage`'s
		// `debug` key at module load (`dist/src/browser.js:190`), so this must
		// land before `context.newPage()` navigates anywhere. Wrapped so a
		// storage-denied context can never fail the run; touches nothing else
		// -- no rung, no pin, no navigation and no exit condition.
		try {
			await context.addInitScript((/** @type {string} */ namespaces) => {
				try {
					window.localStorage.setItem('debug', namespaces);
				} catch {
					// A storage-denied context must never fail this run.
				}
			}, LIBP2P_DIAL_DEBUG_NAMESPACES);
		} catch {
			// addInitScript itself failing must never fail this run either.
		}
		const page = await context.newPage();
		page.on('console', (m) => lines.push(`[${m.type()}] ${m.text()}`));
		page.on('pageerror', (e) => lines.push(`[pageerror] ${e.message}`));

		// ONE navigation, for the whole run. No second `page.goto` and no
		// `location.reload()` anywhere — either would prove nothing about the
		// seam.
		const url = `${server.url}/${entryRel}?network=${encodeURIComponent(strandId)}&election=${encodeURIComponent(origin.facts.ORIGIN_ELECTION_ID)}`;
		console.log(`[mesh-read-gate] ${url}`);
		await page.goto(url, { waitUntil: 'load' });

		await page
			.waitForFunction(() => /** @type {any} */ (window).__MESH_READ_GATE_READY__ === true, null, { timeout: 240_000 })
			.catch(() => {});

		// Served-artefact provenance — a VALUE check, not a presence check.
		const expectedContract = readContractFromSource();
		const publishedContract = await page.evaluate(() => /** @type {any} */ (window).__MESH_READ_GATE__?.contract ?? null);
		if (publishedContract !== expectedContract) {
			throw new PreflightFailedError(`served-bundle-stale: served contract "${publishedContract}" !== source contract "${expectedContract}"`);
		}

		origin.send('mutate');
		const mutatedLine = await origin.waitForLine((line) => line.startsWith('ORIGIN_MUTATED='), 30_000, 'ORIGIN_MUTATED');
		if (mutatedLine !== 'ORIGIN_MUTATED=ok') {
			throw new PreflightFailedError(`origin-mutate: origin replied "${mutatedLine}"`);
		}
		await page.evaluate(() => {
			/** @type {any} */ (window).__MESH_READ_GATE_MUTATED__ = true;
		});

		await page
			.waitForFunction(() => /** @type {any} */ (window).__MESH_READ_GATE_DONE__ === true, null, { timeout: 240_000 })
			.catch(() => {});
		return await page.evaluate(() => /** @type {any} */ (window).__MESH_READ_GATE__ ?? null);
	} finally {
		console.log('\n===== page output =====');
		for (const line of lines) console.log(line);
		if (browser) await browser.close();
		await server.close();
	}
}

async function main() {
	const strandId = `vtx-mesh-read-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
	console.log(`[mesh-read-gate] strandId=${strandId} port=${PORT} config=${BUILD_CONFIG} out=dist-mesh-read`);

	/** @type {OriginController | null} */
	let origin = null;
	let exitCode = 0;
	try {
		// Catches the one cross-source drift that would produce a red gate for
		// a configuration reason -- before the origin boots (CPU-heavy) or a
		// browser launches. See this function's own module-level docstring.
		checkCohortParameterAgreement();

		origin = await bootOrigin(strandId);
		const readout = await runBrowserPhase(origin, strandId);

		if (!readout) {
			console.error('[mesh-read-gate] NO READOUT — the page never published __MESH_READ_GATE__');
			exitCode = 1;
		} else {
			if (readout.crashed) console.error('[mesh-read-gate] CRASHED:\n' + readout.crashed);
			console.log('\n===== rungs =====');
			for (const r of readout.rungs ?? []) {
				console.log(`  ${r.ok ? 'ok  ' : 'FAIL'}  ${String(r.id).padStart(2)} · ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
			}
			console.log(`RUNGS: ${readout.passed}/${readout.total}`);
			console.log(`before: ${JSON.stringify(String(readout.beforeText ?? '').slice(0, 200))}`);
			console.log(`after:  ${JSON.stringify(String(readout.afterText ?? '').slice(0, 200))}`);
			console.log(`navigation entries: ${readout.navBefore} -> ${readout.navAfter}; load nonce ${readout.loadNonce}`);
			console.log(`peerId: ${readout.peerId}`);

			if (readout.passed !== readout.total || readout.total !== TOTAL_RUNGS) {
				console.error(`[mesh-read-gate] FAIL — expected ${TOTAL_RUNGS}/${TOTAL_RUNGS}, got ${readout.passed}/${readout.total}`);
				exitCode = 1;
			} else {
				console.log('[mesh-read-gate] PASS — mesh read proven, liveness proven in one page load');
			}
		}
	} catch (err) {
		if (err instanceof PreflightFailedError) {
			console.error(err.message);
		} else {
			console.error('[mesh-read-gate] RUNGS_FAILED:', err);
		}
		exitCode = 1;
	} finally {
		// Always stop the origin and await its exit — an aborted run must leave
		// no orphaned CadreNode.
		if (origin) await origin.stopAndAwaitExit();
	}

	if (exitCode !== 0) process.exit(1);
}

main().catch((err) => {
	console.error('[mesh-read-gate] driver error:', err);
	process.exit(1);
});
