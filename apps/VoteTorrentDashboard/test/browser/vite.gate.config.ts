/**
 * vite.gate.config.ts — the dashboard's own gate build config for the shared
 * browser-gate runner (D-19, packages/ui-web/scripts/run-ui-gates.mjs).
 *
 * Imports and MERGES the app's own `../../vite.config` — never re-declares
 * `plugins`, `resolve`, or (critically) `resolve.dedupe` — so everything
 * that makes the production build production-SHAPED (the D-16 dedupe fix,
 * the D-19 zero-Node-polyfill plugin set) is INHERITED, not restated. This
 * is what lets 53-11's `--prove-dedupe-removed` control invert this gate at
 * all: if this file declared its own `dedupe`, removing it from
 * `vite.config.ts` would not propagate into a gate rebuild, and that control
 * could never fire.
 *
 * `root` is set explicitly (via `fileURLToPath`) rather than left to the
 * invoking cwd, so the gate build's behaviour does not depend on which
 * directory `vite build --config` happens to be run from.
 *
 * `test/browser/dist` is already covered by the root `.gitignore`'s bare
 * `dist` rule — no `.gitignore` edit needed here.
 */
import { fileURLToPath } from 'node:url';
import { mergeConfig } from 'vite';
import baseConfig from '../../vite.config';

const APP_ROOT = fileURLToPath(new URL('../..', import.meta.url));

// vite.config.ts's own export is a plain UserConfig object today (never a
// function) — the `as any` call below only ever matters if that ever
// changes to the `(env) => UserConfig` form; TypeScript otherwise narrows
// the `typeof === 'function'` branch to `never` and refuses the call.
const resolvedBaseConfig =
	typeof baseConfig === 'function' ? (baseConfig as any)({ command: 'build', mode: 'production' }) : baseConfig;

export default mergeConfig(resolvedBaseConfig, {
	root: APP_ROOT,
	build: {
		outDir: fileURLToPath(new URL('./dist', import.meta.url)),
		emptyOutDir: true,
		rollupOptions: {
			input: fileURLToPath(new URL('./ui-gate.html', import.meta.url)),
		},
	},
	publicDir: false,
});
