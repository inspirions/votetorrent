#!/usr/bin/env node
/**
 * mutations.mjs — the shared BUILD-TIME mutation machinery for the two D-20
 * negative controls (`--prove-no-dedupe`, `--prove-token-missing` in
 * `run-ui-gates.mjs`). Imports nothing outside `node:` builtins and Vite's
 * own `mergeConfig` — this module is loaded by a Vite CONFIG file running in
 * a Node process, never by a bundler, so it lives on the plain-JS tier
 * alongside the package's `.` barrel (see `package.json`'s `./mutations`
 * export subpath), never behind `./components`.
 *
 * WHY BUILD TIME, NEVER RUNTIME OR POST-BUILD: spike 089 measured a runtime
 * React-identity check as false-negative, because esbuild hands different
 * importers different namespace WRAPPERS around one underlying module. Every
 * mutation here is applied to a Vite CONFIG before a real `vite build` runs
 * — never to an already-built `dist/`-shaped directory, and never injected
 * into a page after it loads. `resolveMutation()`'s fail-closed throw is
 * what makes a mutant config unable to become a second, quietly-healthy
 * shipping path: without `UI_GATE_MUTATION` naming a real mutation, there is
 * no build at all.
 *
 * `.mutation-report.json`, written into the mutant build's own `outDir` by
 * `writeMutationReportPlugin`/`stripTokensPlugin`, is what lets the runner
 * (`readMutationReport`) prove the mutation actually fired BEFORE computing
 * any verdict — a machine-readable fact, never a log-scrape.
 */
import path from 'node:path';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mergeConfig } from 'vite';

/**
 * The frozen mutation-name set — the single source of the valid set.
 * Nothing else in this module or its consumers may hard-code a mutation
 * name outside this array.
 * @type {readonly ['no-dedupe', 'token-missing']}
 */
export const MUTATIONS = Object.freeze(/** @type {const} */ (['no-dedupe', 'token-missing']));

/**
 * Reads `process.env.UI_GATE_MUTATION` and throws when it is unset, empty,
 * or not a member of `MUTATIONS` — the fail-closed rule that keeps a
 * `vite.mutant.config.ts` from ever quietly emitting a healthy bundle.
 * @returns {string}
 */
export function resolveMutation() {
	const raw = process.env.UI_GATE_MUTATION;
	if (!raw || !MUTATIONS.includes(/** @type {any} */ (raw))) {
		throw new Error(
			`UI_GATE_MUTATION must be set to one of: ${MUTATIONS.join(', ')} — got ${JSON.stringify(raw ?? null)}. ` +
				'A mutant config that ran with no selector could quietly become a second, healthy shipping path; this throw is what stops that.',
		);
	}
	return raw;
}

/**
 * Removes `resolve.dedupe` from `productionConfig` (throwing `MUTATION IS A
 * NO-OP` if it was not there to remove), merges `gateOverrides` onto the
 * result with Vite's own `mergeConfig`, then re-reads the MERGED result's
 * `resolve.dedupe` — throwing `GATE CONFIG SELF-REFERENCE` if the gate
 * overrides re-declared it (53-09's carried-forward finding, made
 * mechanical: a gate config that carries its own `resolve.dedupe` would
 * observe itself rather than the shipped production config, and this
 * mutation would silently fail to reach it).
 *
 * @param {Record<string, any>} productionConfig the app's own resolved production vite config
 * @param {Record<string, any>} gateOverrides the app's own gate-build overrides (NOT pre-merged)
 * @param {string} [productionConfigLabel] a human label for the production config, for error messages only
 * @returns {{ config: Record<string, any>, report: { removedDedupe: string[], selfReference: false } }}
 */
export function applyNoDedupe(productionConfig, gateOverrides, productionConfigLabel = 'the production vite config') {
	const dedupe = productionConfig?.resolve?.dedupe;
	const hasBoth = Array.isArray(dedupe) && dedupe.includes('react') && dedupe.includes('react-dom');
	if (!hasBoth) {
		throw new Error(
			`MUTATION IS A NO-OP: ${productionConfigLabel} does not declare a resolve.dedupe containing both ` +
				`"react" and "react-dom" (found: ${JSON.stringify(dedupe ?? null)}). Removing something that was ` +
				'never there mutates nothing, and a gate run against an unmutated build would falsely report the gate inert.',
		);
	}

	const { resolve: prodResolve, ...restProd } = productionConfig;
	const { dedupe: _removed, ...restResolve } = prodResolve;
	const mutatedProd = Object.keys(restResolve).length > 0 ? { ...restProd, resolve: restResolve } : { ...restProd };

	const merged = mergeConfig(mutatedProd, gateOverrides);
	const mergedDedupe = merged?.resolve?.dedupe;
	if (Array.isArray(mergedDedupe) && mergedDedupe.length > 0) {
		throw new Error(
			`GATE CONFIG SELF-REFERENCE: after removing resolve.dedupe from ${productionConfigLabel}, the merged ` +
				`gate build still carries resolve.dedupe=${JSON.stringify(mergedDedupe)} — the gate overrides ` +
				're-declared it, so this gate build observes its own config rather than the one that actually ships. ' +
				'Remove the resolve block from the gate config so it inherits the production config unchanged.',
		);
	}

	return { config: merged, report: { removedDedupe: dedupe, selfReference: false } };
}

/**
 * A tiny Vite plugin that writes `report` to `<outDir>/.mutation-report.json`
 * once the build finishes — shared plumbing used by the `no-dedupe` mutant
 * config (whose mutation happens at config-authoring time, before any Vite
 * build hook runs, so it needs a plugin purely to persist the report after
 * `emptyOutDir` has already run).
 *
 * @param {Record<string, any>} report
 * @returns {import('vite').Plugin}
 */
export function writeMutationReportPlugin(report) {
	/** @type {string | null} */
	let outDirAbs = null;
	return {
		name: 'ui-web-mutation-write-report',
		configResolved(resolvedConfig) {
			outDirAbs = path.resolve(resolvedConfig.root ?? process.cwd(), resolvedConfig.build.outDir);
		},
		closeBundle() {
			if (!outDirAbs) {
				throw new Error('writeMutationReportPlugin: outDir was never resolved (configResolved did not run)');
			}
			writeFileSync(path.join(outDirAbs, '.mutation-report.json'), JSON.stringify(report, null, 2));
		},
	};
}

/**
 * Escapes `s` for literal use inside a `RegExp` constructor.
 * @param {string} s
 */
function escapeRegExp(s) {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The one specifier every delivery form below removes a reference to. */
const TOKENS_SPECIFIER = '@votetorrent/ui-web/tokens.css';

/**
 * A Vite plugin, `ui-web-mutation-strip-tokens`, that removes the shared
 * tokens stylesheet REFERENCE from a build — never the file, never its
 * contents. Handles all three delivery forms a consumer could plausibly use
 * (only the CSS `@import` form is actually in use by either app today, per
 * this plan's own read of `app.css`/`index.html`, but the plugin is written
 * against the general contract rather than the one form currently present):
 *   - a JS/TS side-effect import whose specifier is the tokens specifier,
 *     removed in `transform` for `.js`/`.jsx`/`.ts`/`.tsx`/`.mjs`/`.cjs` ids;
 *   - a CSS `@import` of the same specifier, removed in `transform` for
 *     `.css` ids;
 *   - an HTML `<link rel="stylesheet">` naming the same specifier, removed
 *     in `transformIndexHtml`.
 *
 * `closeBundle` throws `MUTATION IS A NO-OP` if nothing was ever removed,
 * and otherwise writes `.mutation-report.json` into the build's `outDir`
 * recording `{ mutation: 'token-missing', removals, forms }` — the runner
 * reads this file rather than parsing build stdout.
 *
 * @returns {import('vite').Plugin}
 */
export function stripTokensPlugin() {
	let removals = 0;
	/** @type {Set<string>} */
	const forms = new Set();
	/** @type {string | null} */
	let outDirAbs = null;

	return {
		name: 'ui-web-mutation-strip-tokens',
		// `enforce: 'pre'` (D-20): Vite's own internal CSS handling resolves an
		// `@import` (via PostCSS import resolution) INSIDE its own `transform`
		// hook, inlining the imported file's content before a normal-priority
		// user plugin would ever see the literal `@import` text — measured live
		// against the real app.css: without `enforce: 'pre'` this plugin counted
		// zero removals on a build that still exited 0 (a genuine no-op, caught
		// by this plugin's own `closeBundle` guard, not a false pass). Running
		// `pre` intercepts the raw, unresolved source instead.
		enforce: 'pre',
		configResolved(resolvedConfig) {
			outDirAbs = path.resolve(resolvedConfig.root ?? process.cwd(), resolvedConfig.build.outDir);
		},
		transform(code, id) {
			const bareId = id.split('?')[0];
			if (/\.(jsx?|tsx?|mjs|cjs)$/.test(bareId)) {
				const importRe = new RegExp(
					`^[ \\t]*import\\s+['"]${escapeRegExp(TOKENS_SPECIFIER)}['"];?[ \\t]*\\r?\\n?`,
					'gm',
				);
				if (importRe.test(code)) {
					removals += 1;
					forms.add('js-side-effect-import');
					return { code: code.replace(importRe, ''), map: null };
				}
				return null;
			}
			if (bareId.endsWith('.css')) {
				const atImportRe = new RegExp(`@import\\s+['"]${escapeRegExp(TOKENS_SPECIFIER)}['"];?`, 'g');
				if (atImportRe.test(code)) {
					removals += 1;
					forms.add('css-at-import');
					return { code: code.replace(atImportRe, '/* stripped by ui-web-mutation-strip-tokens */'), map: null };
				}
				return null;
			}
			return null;
		},
		transformIndexHtml(html) {
			const linkRe = /<link\b[^>]*href=["'][^"']*tokens\.css[^"']*["'][^>]*>\s*/gi;
			if (linkRe.test(html)) {
				removals += 1;
				forms.add('html-link');
				return html.replace(linkRe, '');
			}
			return html;
		},
		closeBundle() {
			if (removals === 0) {
				throw new Error(
					"MUTATION IS A NO-OP: stripTokensPlugin removed zero references to '@votetorrent/ui-web/tokens.css' " +
						'across the JS-import, CSS-@import and HTML-link forms — the token-missing mutation did not fire.',
				);
			}
			if (!outDirAbs) {
				throw new Error('stripTokensPlugin: outDir was never resolved (configResolved did not run)');
			}
			writeFileSync(
				path.join(outDirAbs, '.mutation-report.json'),
				JSON.stringify({ mutation: 'token-missing', removals, forms: [...forms] }, null, 2),
			);
		},
	};
}

/**
 * Reads and parses `<outDir>/.mutation-report.json`, throwing a distinct
 * message when the file is absent — a control can never treat a missing
 * report as a passing mutation.
 *
 * @param {string} outDirAbs
 * @returns {Record<string, any>}
 */
export function readMutationReport(outDirAbs) {
	const reportPath = path.join(outDirAbs, '.mutation-report.json');
	if (!existsSync(reportPath)) {
		throw new Error(
			`MUTATION REPORT MISSING at "${reportPath}" — a control can never treat a missing report as a passing mutation.`,
		);
	}
	return JSON.parse(readFileSync(reportPath, 'utf8'));
}
