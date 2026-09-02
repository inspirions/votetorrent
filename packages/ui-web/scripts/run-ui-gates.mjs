#!/usr/bin/env node
/**
 * run-ui-gates.mjs — the ONE shared browser-gate runner (D-19), invoked once
 * per consuming app against THAT app's own production build.
 *
 * WHY `vite dev` IS DISQUALIFIED AS A TRANSPORT: every gate that existed in
 * this repository before this file passed on all four candidate shared-
 * package shapes spike 090 measured, including one that cannot build at all
 * and two that ship broken — because a dev server compiles and serves
 * source on demand, which is not what a consumer's browser ever receives.
 * `yarn build` itself misses a real `TS2322` (Vite does not typecheck) and
 * misses the entire design-token layer being absent; counting the page's
 * loaded style resources is likewise blind — that count is unchanged even
 * with every token removed, which is exactly why this runner never gates on
 * it (see `token-declared-values` below instead). This runner therefore
 * NEVER starts a dev server: it always builds (unless `--skip-build`) and
 * serves the resulting `dist/`-shaped directory over `lib/serve-dist.mjs`.
 *
 * FLAG CATALOGUE:
 *   --app <dir>            App directory to gate. Default: `.` (resolved to
 *                           an absolute path from the invoking cwd).
 *   --gate-config <path>   Vite config for the GATE build, resolved relative
 *                           to `--app`. Default: `test/browser/vite.gate.config.ts`
 *                           (the dashboard's own layout — see "Per-app
 *                           layout" below for why that default is not a
 *                           canonical fact).
 *   --gate-dist <path>     Directory the gate build emits into, resolved
 *                           relative to `--app`. Default: `test/browser/dist`.
 *   --gate-entry <name>    Filename of the harness HTML entry the gate build
 *                           must emit exactly one of. Default: `ui-gate.html`.
 *   --port <n>              Port `serve-dist.mjs` binds. Default: `5183`, or
 *                           the `UI_GATE_PORT` environment variable.
 *   --skip-build            Reuse an existing `--gate-dist` build rather than
 *                           rebuilding it.
 *   --list-rungs             Print the frozen rung ids, one per line, and
 *                           exit 0.
 * Any other argument, including any unrecognised `--prove-*`, exits 2 naming
 * the offending flag — an unknown flag must never be silently ignored into a
 * green run.
 *
 * PER-APP LAYOUT — named defaults, not frozen facts. D-19's requirement is
 * that ONE shared runner is invoked ONCE PER CONSUMING APP against that
 * app's OWN production build. The two consumers do not, and will not, share
 * a directory layout: the dashboard's gate config lives under `test/browser/`
 * and emits into `test/browser/dist` (this plan's own Task 3), while the
 * public app's lives at the app root and emits into `dist-gate/` with its
 * own entry filename (53-06/53-07 own that app's layout). A runner that
 * could only express one app's layout could not satisfy D-19 — so
 * `--gate-config`/`--gate-dist`/`--gate-entry`/`--port` are documented CLI
 * overrides, each resolved relative to `--app` (except `--port`), and every
 * downstream reference in this file uses the RESOLVED per-invocation value,
 * never a constant directly. The dashboard's values are the DEFAULTS purely
 * because it is the first consumer, never because they are canonical.
 *
 * PORT POLICY, stated once for the whole phase. `5180` is the dashboard's
 * dev/preview port. `5181` is `run-headless.mjs`'s dev-server port AND the
 * public app's dev/preview port (53-06) — that overlap is harmless and
 * deliberately tolerated, because `vite dev` is never a gate and CI never
 * starts the public app's dev or preview server, so the two never bind
 * concurrently. `5183` is the dashboard's gate port (this plan) and `5191`
 * is the public app's gate port (53-09); they are distinct from each other
 * and from 5180/5181. A BOUND PORT MUST FAIL THE RUN LOUDLY:
 * `lib/serve-dist.mjs` propagates the `listen` error rather than retrying,
 * falling back, or picking another port, and this runner exits 2 with a
 * message naming the port and the flag that would change it.
 *
 * THE INVERSION SEAM (53-11's landing site, per D-20). `INVERSION_CONTROLS`
 * is declared below as an empty, frozen object. 53-11 adds exactly two
 * entries — `--prove-token-missing` and `--prove-dedupe-removed` — that each
 * rebuild a MUTATED PRODUCTION VARIANT (never mutate `--gate-dist` post-
 * build, never inject at runtime: spike 089 measured a runtime React-
 * identity check as false-negative because esbuild hands importers
 * different namespace wrappers around one module) and must print the
 * literal string `is inert` and exit non-zero when the underlying run it
 * inverts still passes. `finishRun(underlyingRunPassed, reason, inversionId)`
 * is implemented now, in the shape of `run-headless.mjs`'s own `finishRun`:
 * with `inversionId === null` it sets `process.exitCode` from
 * `underlyingRunPassed` directly; with a non-null id it inverts and emits
 * the `is inert` verdict line. This plan only ever calls it with `null`;
 * 53-11 supplies the ids.
 *
 * `import { chromium } from 'playwright'` — the FULL package, never the
 * lighter core-only sibling, and never a hardcoded system-Chrome binary path
 * (the spikes' macOS Chrome path does not exist on `ubuntu-24.04`). No
 * `channel: 'chrome'` option — `chromium.launch({ headless: true })` works
 * locally at HEAD; the CONTEXT.md caveat about Playwright not running
 * locally is stale (53-08-PLAN.md constraint 3).
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readdirSync, existsSync, readFileSync } from 'node:fs';
import { serveDist } from './lib/serve-dist.mjs';
import { parseTokensCss, normaliseTokenValue, hexToRgb, compareToken, BASE_RULE_CHECKS } from './lib/tokens.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Cross-page readout channel names — a shared runner and a shared name, so no consumer invents its own. */
export const GATE_READOUT_GLOBAL = '__UI_GATE__';
export const GATE_DONE_GLOBAL = '__UI_GATE_DONE__';

/**
 * Frozen rung-id registry, module-level, single source of truth. `record()`
 * throws on any id outside this array — the structural enforcement of "do
 * not interpolate a value under test into a check's name": a rung cannot be
 * named after anything computed. `gate-source-integrity.test.mjs` greps for
 * this literal name.
 */
export const RUNG_IDS = Object.freeze([
	'harness-readout',
	'shared-components-mounted',
	'token-declared-values',
	'base-rule-used-values',
]);

/** Per-app layout defaults — see this file's header "PER-APP LAYOUT" note. */
const DEFAULT_GATE_CONFIG_REL = 'test/browser/vite.gate.config.ts';
const DEFAULT_GATE_DIST_REL = 'test/browser/dist';
const DEFAULT_GATE_ENTRY_NAME = 'ui-gate.html';
const DEFAULT_PORT = 5183;

/**
 * The inversion seam. 53-11 adds exactly two entries here — see this file's
 * header "THE INVERSION SEAM" note for the full contract each must satisfy.
 */
const INVERSION_CONTROLS = Object.freeze({});

const KNOWN_FLAGS = new Set([
	'--app',
	'--gate-config',
	'--gate-dist',
	'--gate-entry',
	'--port',
	'--skip-build',
	'--list-rungs',
]);

/**
 * @param {string[]} argv
 */
function parseArgs(argv) {
	/** @type {{ app: string, gateConfig: string | null, gateDist: string | null, gateEntry: string | null, port: string | null, skipBuild: boolean, listRungs: boolean }} */
	const opts = {
		app: '.',
		gateConfig: null,
		gateDist: null,
		gateEntry: null,
		port: null,
		skipBuild: false,
		listRungs: false,
	};
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (!KNOWN_FLAGS.has(arg)) {
			process.stderr.write(
				`[run-ui-gates] unrecognised argument "${arg}" — every flag must be one of ${[...KNOWN_FLAGS].join(', ')}. An unknown flag is never silently ignored.\n`,
			);
			process.exit(2);
		}
		switch (arg) {
			case '--app':
				opts.app = argv[(i += 1)];
				break;
			case '--gate-config':
				opts.gateConfig = argv[(i += 1)];
				break;
			case '--gate-dist':
				opts.gateDist = argv[(i += 1)];
				break;
			case '--gate-entry':
				opts.gateEntry = argv[(i += 1)];
				break;
			case '--port':
				opts.port = argv[(i += 1)];
				break;
			case '--skip-build':
				opts.skipBuild = true;
				break;
			case '--list-rungs':
				opts.listRungs = true;
				break;
			default:
				break;
		}
	}
	return opts;
}

/**
 * Resolves `relPath` against `appDir` and requires the result to remain
 * inside `appDir` — a `--gate-config`/`--gate-dist`/`--gate-entry` value that
 * escapes the `--app` directory exits 2.
 *
 * @param {string} appDir
 * @param {string} relPath
 * @param {string} flagName
 */
function resolveWithinApp(appDir, relPath, flagName) {
	const resolved = path.resolve(appDir, relPath);
	const relative = path.relative(appDir, resolved);
	const escapes = relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative);
	if (escapes) {
		process.stderr.write(`[run-ui-gates] ${flagName} "${relPath}" resolves outside --app "${appDir}"\n`);
		process.exit(2);
	}
	return resolved;
}

/** @type {Array<{ id: string, passed: boolean, detail: string }>} */
const rungs = [];

/**
 * @param {string} id
 * @param {boolean} passed
 * @param {string} detail
 */
function record(id, passed, detail) {
	if (!RUNG_IDS.includes(id)) {
		throw new Error(`record(): "${id}" is not a member of RUNG_IDS`);
	}
	rungs.push({ id, passed, detail });
}

/**
 * Spawns `vite build --config <gateConfigRel>` with `cwd: appDir`, streaming
 * stdout/stderr prefixed `[vite build]`. Rejects (via process.exit(2)) if
 * `gateConfigAbs` does not exist — a consuming app without a gate config is
 * a setup error, not a gate failure.
 *
 * @param {string} appDir
 * @param {string} gateConfigAbs
 * @param {string} gateConfigRel
 */
async function buildGateEntry(appDir, gateConfigAbs, gateConfigRel) {
	if (!existsSync(gateConfigAbs)) {
		process.stderr.write(
			`[run-ui-gates] gate config not found at "${gateConfigAbs}" (--gate-config "${gateConfigRel}"). ` +
				`Every consumer of this runner must supply a gate vite config that imports and merges its ` +
				`own vite.config.ts — see packages/ui-web/README.md's "Browser gates (D-19)" harness contract.\n`,
		);
		process.exit(2);
	}
	const viteBin = path.join(appDir, 'node_modules', 'vite', 'bin', 'vite.js');
	await new Promise((resolvePromise, rejectPromise) => {
		const child = spawn(process.execPath, [viteBin, 'build', '--config', gateConfigRel], {
			cwd: appDir,
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		child.stdout?.on('data', (d) => process.stdout.write(`[vite build] ${d}`));
		child.stderr?.on('data', (d) => process.stderr.write(`[vite build] ${d}`));
		child.on('error', rejectPromise);
		child.on('exit', (code) => {
			if (code === 0) resolvePromise(undefined);
			else rejectPromise(new Error(`vite build (--config ${gateConfigRel}) exited with code ${code}`));
		});
	});
}

/**
 * Walks `gateDistDir` recursively for files named `gateEntryName`, requiring
 * EXACTLY ONE match. Resolves by search rather than by predicting Vite's
 * output path algebra for a non-root HTML input.
 *
 * @param {string} gateDistDir
 * @param {string} gateEntryName
 */
function resolveGateEntry(gateDistDir, gateEntryName) {
	if (!existsSync(gateDistDir)) {
		process.stderr.write(`[run-ui-gates] gate dist directory "${gateDistDir}" does not exist — did the build run?\n`);
		process.exit(2);
	}

	/** @param {string} dir @returns {string[]} */
	function walk(dir) {
		/** @type {string[]} */
		const out = [];
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				out.push(...walk(full));
			} else if (entry.name === gateEntryName) {
				out.push(full);
			}
		}
		return out;
	}

	const matches = walk(gateDistDir);
	if (matches.length === 0) {
		process.stderr.write(
			`[run-ui-gates] gate build emitted no "${gateEntryName}" under "${gateDistDir}" (--gate-entry "${gateEntryName}" names the file to look for)\n`,
		);
		process.exit(2);
	}
	if (matches.length > 1) {
		process.stderr.write(
			`[run-ui-gates] gate build emitted ${matches.length} files named "${gateEntryName}":\n${matches.map((m) => `  - ${m}`).join('\n')}\n`,
		);
		process.exit(2);
	}
	return path.relative(gateDistDir, matches[0]);
}

/**
 * Drives an already-open page to `url` and reads its `__UI_GATE__` /
 * `__UI_GATE_DONE__` readout. Deliberately does NOT close `page` — unlike
 * `run-headless.mjs`'s per-call close (that file's tier-2 flow needs
 * page ISOLATION across seed/verify pairs), this runner's remaining rungs
 * (`shared-components-mounted`, `token-declared-values`,
 * `base-rule-used-values`) all need to query the SAME already-rendered DOM
 * and the SAME `getComputedStyle` the harness produced — closing here would
 * make every rung after this one unable to run. The caller closes the page
 * once every rung that needs it has run.
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
		.waitForFunction((name) => /** @type {any} */ (globalThis)[name] === true, GATE_DONE_GLOBAL, { timeout: 60_000 })
		.catch(() => {});
	const readout = await page.evaluate((name) => /** @type {any} */ (globalThis)[name] ?? null, GATE_READOUT_GLOBAL);

	console.log(`\n===== ${label} =====`);
	for (const l of lines) console.log(l);
	return readout;
}

/**
 * `harness-readout`: passes when the readout is non-null, its `error` field
 * is `null`, and its `mounted` field is a non-empty array.
 *
 * @param {any} readout
 */
function runHarnessReadoutRung(readout) {
	const passed = readout != null && readout.error === null && Array.isArray(readout.mounted) && readout.mounted.length > 0;
	record('harness-readout', passed, passed ? `mounted=${readout.mounted.length}` : `readout=${JSON.stringify(readout)}`);
	return passed;
}

/**
 * Parses the named exports of `components.js`, matching only the explicit
 * form `export { Name } from './components/Name.js';`, one per line.
 * Exits 2 if the file contains an `export *` — a star re-export makes the
 * export set unenumerable and this rung un-total.
 *
 * @param {string} componentsSource
 */
function parseComponentExportNames(componentsSource) {
	if (/export\s*\*/.test(componentsSource)) {
		process.stderr.write(
			'[run-ui-gates] packages/ui-web/src/components.js contains an `export *` — a star re-export makes the export set unenumerable, which makes the shared-components-mounted rung un-total. Rewrite it as explicit `export { Name } from \'./components/Name.js\';` lines.\n',
		);
		process.exit(2);
	}
	/** @type {string[]} */
	const names = [];
	const re = /^export \{ (\w+) \} from '\.\/components\/\1\.js';$/gm;
	let match;
	while ((match = re.exec(componentsSource)) !== null) {
		names.push(match[1]);
	}
	return names;
}

/**
 * `shared-components-mounted`: every named export of `components.js` must
 * appear in `readout.mounted` AND the built page must have a
 * `[data-ui-gate="Name"]` element with `childElementCount > 0` for each — a
 * component that mounts but renders nothing fails.
 *
 * @param {import('playwright').Page} page
 * @param {any} readout
 */
async function runSharedComponentsRung(page, readout) {
	const componentsSource = readFileSync(new URL('../src/components.js', import.meta.url), 'utf8');
	const names = parseComponentExportNames(componentsSource);
	const mountedSet = new Set(readout?.mounted ?? []);
	/** @type {string[]} */
	const problems = [];
	for (const name of names) {
		if (!mountedSet.has(name)) {
			problems.push(`${name}: not present in readout.mounted`);
			continue;
		}
		// eslint-disable-next-line no-await-in-loop -- sequential DOM reads against the one shared page, mirrors run-headless.mjs's own driveTier3Rungs discipline
		const hasNonEmptyBody = await page.evaluate((n) => {
			const el = document.querySelector(`[data-ui-gate="${n}"]`);
			return el != null && el.childElementCount > 0;
		}, name);
		if (!hasNonEmptyBody) {
			problems.push(`${name}: [data-ui-gate="${name}"] missing or has zero child elements`);
		}
	}
	record(
		'shared-components-mounted',
		problems.length === 0,
		problems.length === 0 ? `${names.length}/${names.length} components mounted and non-empty` : problems.join('; '),
	);
}

/**
 * `token-declared-values` (D-23, TOTAL) and `base-rule-used-values` (the
 * D-15 base/reset half). Reads `packages/ui-web/src/tokens.css` via a
 * package-relative URL — the package's OWN source, never the app's.
 *
 * @param {import('playwright').Page} page
 * @returns {Promise<number>} the token count enumerated, for the receipt line
 */
async function runTokenRungs(page) {
	const tokensCssSource = readFileSync(new URL('../src/tokens.css', import.meta.url), 'utf8');
	const { tokens, rootDeclarationLineCount, hasRegisteredProperty } = parseTokensCss(tokensCssSource);

	if (tokens.size === 0) {
		record('token-declared-values', false, 'parsed zero tokens from tokens.css');
		record('base-rule-used-values', false, 'skipped — zero tokens parsed, see token-declared-values');
		return 0;
	}
	if (tokens.size !== rootDeclarationLineCount) {
		record(
			'token-declared-values',
			false,
			`tokens.size=${tokens.size} !== rootDeclarationLineCount=${rootDeclarationLineCount} — the two independent parses disagree`,
		);
		record('base-rule-used-values', false, 'skipped — parser disagreement, see token-declared-values');
		return tokens.size;
	}
	if (hasRegisteredProperty) {
		process.stderr.write(
			'[run-ui-gates] tokens.css contains an @property registration — a registered custom property has a COMPUTED, engine-normalised value, which invalidates this probe\'s exact declared-value comparison. Extend this probe deliberately before such a token lands.\n',
		);
		process.exit(2);
	}

	const names = [...tokens.keys()];
	const actual = await page.evaluate((tokenNames) => {
		const cs = getComputedStyle(document.documentElement);
		/** @type {Record<string, string>} */
		const out = {};
		for (const name of tokenNames) out[name] = cs.getPropertyValue(name);
		return out;
	}, names);

	/** @type {Array<{ name: string, expected: string, actual: string }>} */
	const mismatches = [];
	for (const name of names) {
		const expected = /** @type {string} */ (tokens.get(name));
		const actualValue = actual[name] ?? '';
		const { passed } = compareToken(expected, actualValue);
		if (!passed) mismatches.push({ name, expected, actual: actualValue });
	}
	record(
		'token-declared-values',
		mismatches.length === 0,
		mismatches.length === 0 ? `${names.length}/${names.length} tokens resolved to their declared value` : `${mismatches.length}/${names.length} mismatched`,
	);
	if (mismatches.length > 0) {
		console.log('\n--- token-declared-values mismatches ---');
		for (const m of mismatches) console.log(`${m.name} / ${JSON.stringify(m.expected)} / ${JSON.stringify(m.actual)}`);
	}

	const bodyActual = await page.evaluate((checks) => {
		const cs = getComputedStyle(document.body);
		/** @type {Record<string, string>} */
		const out = {};
		for (const check of checks) out[check.id] = String(/** @type {any} */ (cs)[check.cssProperty]);
		return out;
	}, BASE_RULE_CHECKS);

	/** @type {Array<{ id: string, expected: string, actual: string }>} */
	const baseMismatches = [];
	for (const check of BASE_RULE_CHECKS) {
		const declared = /** @type {string} */ (tokens.get(check.token));
		const expected = check.normaliser === 'hexToRgb' ? hexToRgb(declared) : normaliseTokenValue(declared);
		const actualValue = bodyActual[check.id];
		const passed = normaliseTokenValue(actualValue) === normaliseTokenValue(expected);
		if (!passed) baseMismatches.push({ id: check.id, expected, actual: actualValue });
	}
	record(
		'base-rule-used-values',
		baseMismatches.length === 0,
		baseMismatches.length === 0 ? `${BASE_RULE_CHECKS.length}/${BASE_RULE_CHECKS.length} base rules matched` : `${baseMismatches.length}/${BASE_RULE_CHECKS.length} mismatched`,
	);
	if (baseMismatches.length > 0) {
		console.log('\n--- base-rule-used-values mismatches ---');
		for (const m of baseMismatches) console.log(`${m.id} / ${JSON.stringify(m.expected)} / ${JSON.stringify(m.actual)}`);
	}

	return tokens.size;
}

function printSummaryTable() {
	console.log('\n--- ui-gates summary ---');
	for (const r of rungs) {
		console.log(`${r.id.padEnd(28)} ${r.passed ? 'PASS' : 'FAIL'}  ${r.detail}`);
	}
}

function getPlaywrightVersion() {
	try {
		const pkgUrl = new URL('../node_modules/playwright-core/package.json', import.meta.url);
		const pkg = JSON.parse(readFileSync(pkgUrl, 'utf8'));
		return pkg.version;
	} catch {
		return 'unknown';
	}
}

/**
 * In the shape of `run-headless.mjs`'s own `finishRun` — see this file's
 * header "THE INVERSION SEAM" note.
 *
 * @param {boolean} underlyingRunPassed
 * @param {string} reason
 * @param {string | null} inversionId
 */
function finishRun(underlyingRunPassed, reason, inversionId) {
	if (inversionId === null) {
		console.log(`\nUI GATES: ${underlyingRunPassed ? 'PASS' : 'FAIL'} (${reason})`);
		process.exitCode = underlyingRunPassed ? 0 : 1;
		return;
	}
	// 53-11 supplies real inversion ids via INVERSION_CONTROLS; this branch is
	// unreachable from this plan's own call sites (which always pass null).
	if (underlyingRunPassed) {
		console.log(`\nUI GATES ${inversionId}: FAIL — gate is inert (${reason})`);
		process.exitCode = 1;
		return;
	}
	console.log(`\nUI GATES ${inversionId}: PASS — the underlying run genuinely failed (${reason})`);
	process.exitCode = 0;
}

async function main() {
	const argv = process.argv.slice(2);
	const opts = parseArgs(argv);

	if (opts.listRungs) {
		for (const id of RUNG_IDS) console.log(id);
		return;
	}

	const appDir = path.resolve(process.cwd(), opts.app);
	const gateConfigRel = opts.gateConfig ?? DEFAULT_GATE_CONFIG_REL;
	const gateDistRel = opts.gateDist ?? DEFAULT_GATE_DIST_REL;
	const gateEntryName = opts.gateEntry ?? DEFAULT_GATE_ENTRY_NAME;
	const portRaw = opts.port ?? process.env.UI_GATE_PORT ?? String(DEFAULT_PORT);
	const port = Number(portRaw);

	const gateConfigAbs = resolveWithinApp(appDir, gateConfigRel, '--gate-config');
	const gateDistAbs = resolveWithinApp(appDir, gateDistRel, '--gate-dist');

	console.log(`[run-ui-gates] app=${appDir}`);
	console.log(`[run-ui-gates] gate-config=${gateConfigRel} (resolved: ${gateConfigAbs})`);
	console.log(`[run-ui-gates] gate-dist=${gateDistRel} (resolved: ${gateDistAbs})`);
	console.log(`[run-ui-gates] gate-entry=${gateEntryName}`);
	console.log(`[run-ui-gates] port=${port}`);

	if (!opts.skipBuild) {
		await buildGateEntry(appDir, gateConfigAbs, gateConfigRel);
	}

	const entryRel = resolveGateEntry(gateDistAbs, gateEntryName);

	let serverHandle;
	try {
		serverHandle = await serveDist(gateDistAbs, port);
	} catch (err) {
		const code = /** @type {any} */ (err)?.code;
		if (code === 'EADDRINUSE') {
			process.stderr.write(
				`[run-ui-gates] port ${port} is already bound — pass --port <n> (or set UI_GATE_PORT) to use a different one\n`,
			);
			process.exit(2);
		}
		throw err;
	}

	let browser;
	try {
		try {
			browser = await chromium.launch({ headless: true });
		} catch (err) {
			if (String(/** @type {any} */ (err)?.message ?? err).includes("Executable doesn't exist")) {
				process.stderr.write(
					'[run-ui-gates] Playwright could not find the Chromium binary. Run:\n  yarn workspace @votetorrent/ui-web exec playwright install chromium\n',
				);
				process.exit(2);
			}
			throw err;
		}

		const page = await browser.newPage();
		const url = `${serverHandle.url}/${entryRel}`;
		const readout = await runOnPage(page, url, `app=${path.basename(appDir)}`);

		runHarnessReadoutRung(readout);
		await runSharedComponentsRung(page, readout);
		const tokenCount = await runTokenRungs(page);

		await page.close();

		printSummaryTable();
		const allPassed = rungs.every((r) => r.passed);
		const playwrightVersion = getPlaywrightVersion();
		console.log(
			`RECEIPT ui-gates app=${path.basename(appDir)} rungs=${rungs.length} passed=${rungs.filter((r) => r.passed).length} playwright=${playwrightVersion} tokens=${tokenCount}`,
		);
		finishRun(allPassed, allPassed ? 'all rungs passed' : 'one or more rungs failed', null);
	} finally {
		await browser?.close();
		await serverHandle?.close();
	}
}

main().catch((err) => {
	console.error('[run-ui-gates] runner crashed:', err);
	process.exitCode = 1;
});
