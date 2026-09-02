/**
 * vite.mutant.config.ts — the public app's MUTANT build config (53-11, D-20).
 *
 * This config exists ONLY to produce a deliberately broken bundle for a
 * negative control (`--prove-no-dedupe` / `--prove-token-missing` in
 * `packages/ui-web/scripts/run-ui-gates.mjs`). Its output is never served,
 * never deployed and never committed — `dist-mutant-` + the mutation name is gitignored
 * app-locally (see `.gitignore`, beside 53-07's `dist-gate` entry). It
 * cannot run at all without `UI_GATE_MUTATION` naming a known mutation
 * (`resolveMutation()` throws at module scope, before Vite does anything),
 * which is what stops this file from ever becoming a second, quietly-healthy
 * shipping path — mirroring the binding-rule discipline `vite.config.ts`'s
 * own header comment states for that file.
 *
 * Merges the app's own PRODUCTION config (`./vite.config`) with its own GATE
 * overrides (`./vite.gate.config`'s named `GATE_OVERRIDES` export, not its
 * merged default export — the two halves `applyNoDedupe` needs separately),
 * applies exactly the selected mutation, then overrides ONLY
 * `build.outDir`/`build.emptyOutDir` to land in a mutation-named, gitignored
 * directory. Nothing else about the build is overridden — same
 * `build.target`, same harness entry, same everything the healthy gate
 * build already uses, or a control run against this bundle would be
 * inverting a different build than the one it claims to invert.
 */
import { fileURLToPath } from 'node:url';
import { mergeConfig } from 'vite';
import baseConfig from './vite.config';
import { GATE_OVERRIDES } from './vite.gate.config';
import { resolveMutation, applyNoDedupe, stripTokensPlugin, writeMutationReportPlugin } from '@votetorrent/ui-web/mutations';

// Throws before Vite does anything if UI_GATE_MUTATION is unset, empty, or unknown.
const mutation = resolveMutation();

const OUT_DIR = fileURLToPath(new URL(`./dist-mutant-${mutation}`, import.meta.url));

// vite.config.ts's own export is a plain UserConfig object today (never a
// function) — mirrors vite.gate.config.ts's own `as any` note.
const resolvedBaseConfig =
	typeof baseConfig === 'function' ? (baseConfig as any)({ command: 'build', mode: 'production' }) : baseConfig;

let mutatedConfig: Record<string, any>;

if (mutation === 'no-dedupe') {
	const { config, report } = applyNoDedupe(resolvedBaseConfig, GATE_OVERRIDES, 'apps/VoteTorrentPublic/vite.config.ts');
	mutatedConfig = mergeConfig(config, {
		plugins: [
			writeMutationReportPlugin({ mutation, removedDedupe: report.removedDedupe, selfReference: report.selfReference }),
		],
	});
} else {
	// token-missing: the gate build's own shape, unchanged, plus the
	// token-stripping plugin — no config-level mutation, the mutation is
	// entirely inside the Vite plugin pipeline.
	const merged = mergeConfig(resolvedBaseConfig, GATE_OVERRIDES);
	mutatedConfig = mergeConfig(merged, { plugins: [stripTokensPlugin()] });
}

export default mergeConfig(mutatedConfig, {
	build: {
		outDir: OUT_DIR,
		emptyOutDir: true,
	},
});
