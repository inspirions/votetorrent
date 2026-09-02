# @votetorrent/ui-web

Shared web UI package for `apps/VoteTorrentDashboard` (the authority dashboard) and the public
no-login election view (`apps/VoteTorrentPublic`, 53-06). Web only — the two React Native apps
(`VoteTorrentAuthority`, `VoteTorrentVoter`) are out of scope and never consume this package.

Ships as source, consumed as `workspace:*`. No build step, no `dist/`.

## Consumer recipe (D-16)

Rules with the measured reason attached, not prose — follow every step below to add a new
consumer.

### 1. Add the dependency

In the consuming app's `package.json` `dependencies`:

```json
"@votetorrent/ui-web": "workspace:*"
```

### 2. Add `resolve.dedupe` to the app's `vite.config.ts`

```ts
resolve: { dedupe: ['react', 'react-dom'] },
```

This is per-**app** config — a shared package cannot enforce its own correctness for a consumer
that omits it.

Measured reason: this repo has no hoisted React (`.yarnrc.yml` sets `nmHoistingLimits: workspaces`;
`node_modules/react` does not exist at the root). Each workspace owns its own `19.0.0` copy, and
this package declares `react`/`react-dom` in both `peerDependencies` and `devDependencies` — the
same on-disk layout that breaks *without* `dedupe`. `dedupe` is what makes it safe.

A duplicate React is harmless for purely presentational components — spike 089 measured a
dedupe-removed control passing 18/18 against a zero-hook component. It bites only at the **hook
dispatcher**: the same control dropped to 8/12 once a single `useState` was involved, in a build
that still exited 0. The failure surfaces long after the commit that caused it — add this line from
the app's first commit, not after the first hook lands.

53-12's repo-root static assertion (D-21) will make this line mandatory for every consumer of this
package; a comment merely discussing `dedupe` will not satisfy it, because that assertion strips
comment lines before scanning.

### 3. Import the stylesheet

```
@votetorrent/ui-web/tokens.css
```

One import per app. The canonical import form (an `index.html` `<link>` versus an import inside
`app.css`/`main.tsx`) is fixed by 53-03 (D-15) — this section is updated there. Do not guess a form
now.

### 4. Import the right subpath

- `@votetorrent/ui-web` — plain-JS values, importable from `node --test` with no bundler.
- `@votetorrent/ui-web/components` — React components, bundler-only.

Importing `@votetorrent/ui-web/components` under plain Node throws `ERR_MODULE_NOT_FOUND` — Vite
resolves a `./Name.js` specifier to a same-named `.tsx` file via its extension probing; plain Node
does not perform that probe. That throw is intended: it is what keeps a `.tsx` re-export out of the
bundler-less `node --test` tier.

### 5. Extend the shared tsconfig base

```json
"extends": "../../packages/ui-web/tsconfig.base.json"
```

By **relative path**, not by package specifier — a package-specifier `extends` would require a
fourth key in this package's `exports` map, and this package's own gate proves that map stays at
exactly three keys. `tsconfig.base.json` carries the full `compilerOptions` block (14 options); no
consumer redeclares any of them.

### 6. Binding rule: never hoist React

`react`/`react-dom` must NEVER appear in the root `package.json` (any dependency field) or the root
`resolutions`. The loud `Rollup failed to resolve import "react/jsx-runtime"` failure tempts you
into hoisting React to fix it — don't. The hoisted shape builds green and dies at the first hook,
which is strictly worse than the loud failure it "fixes".

This package declares `react`/`react-dom` in **both** `peerDependencies` and `devDependencies`.
Peer alone fails `tsc` with `TS2875: This JSX tag requires the module path 'react/jsx-runtime' to
exist` — the package needs a local React to resolve and typecheck itself. This is the same on-disk
layout that breaks *without* `dedupe` (step 2) — `dedupe` is what makes it safe.

### 7. Not provided: a shared vite-config factory

Declined at D-16. A shared package reaching into build config fights any consumer needing an
override. Revisit only if a fourth consumer appears.

## Consuming the design tokens

The canonical import form (D-15, decided in 53-03): make

```css
@import '@votetorrent/ui-web/tokens.css';
```

the **first statement** in the consumer's own `app.css`, above that app's own layout rules, with
only the file-header comment before it. Chosen over an `index.html` `<link>` and over an ESM
`import` in `main.tsx` for three reasons: it is literally the one import D-15 promises; it keeps
working through both an `index.html` `<link href="/src/app.css">` and a `main.tsx`
`import './app.css'` entry path with no change to either; and it fixes cascade order
deterministically — tokens and base/reset land before any consumer rule, which an ESM import
ordering across two entry paths cannot guarantee. Vite resolves the bare package specifier through
its own resolver, honouring the `exports` map from step 3. A CSS `@import` is only valid before any
other rule in the file, so it must never drift below the consumer's own layout rules.

The consumer's own `app.css` then holds only that app's own layout and component styles — see
`apps/VoteTorrentDashboard/src/app.css` for the reference shape (`.layout`, its `900px` collapse,
`.panel-grid`, and nothing else).

For the D-23 token probe's enumeration contract (one declaration per line, no comment inside
`:root`, no declaration-shaped text in any comment) and the `getComputedStyle` normalisation
semantics a consumer or a probe needs to know about, see the header of
`packages/ui-web/src/tokens.css` itself — that file is the single place to correct either if a real
browser run ever disagrees, so neither is restated here.

## Browser gates (D-19)

The shared browser-gate runner lives at `packages/ui-web/scripts/run-ui-gates.mjs`, with
`playwright: ^1.62.1` declared as a `packages/ui-web` **devDependency** — not at the repo root, and
not as a fourth `exports` entry.

**Why it lives here, not at the repo root (measured, not assumed).** `.yarnrc.yml` sets
`nmHoistingLimits: workspaces`, so nothing hoists to the repo root — root `node_modules` carries
`playwright-core` but not `playwright`. A runner at repo-root `scripts/` would therefore need a new
root-level dependency on a browser driver, on every workspace's resolution path. Each workspace
instead gets its own `node_modules` under this hoisting limit, so a script at
`packages/ui-web/scripts/` resolves `playwright` from `packages/ui-web/node_modules` by **file
location**, independent of the cwd it is invoked from — that file-location resolution is what lets
ONE declaration serve BOTH the dashboard and the public app. The declared range `^1.62.1` is
byte-identical to the dashboard's own existing declaration and resolves to the same
`"playwright@npm:^1.62.1"` lockfile entry — `git diff -- yarn.lock` after adding it gains zero new
`resolution:` lines.

**Invocation**, run from a consuming app directory:

```
node ../../packages/ui-web/scripts/run-ui-gates.mjs --app .
```

**The harness contract every consumer must satisfy** — four numbered requirements:

1. A gate vite config importing and merging the app's own `vite.config.ts`, overriding only
   `build.outDir`, `build.rollupOptions.input`, `build.emptyOutDir` and `publicDir: false`, and
   declaring no `dedupe` of its own — its path and its `outDir` are the app's own choice, passed to
   the runner as `--gate-config` and `--gate-dist` (the dashboard's own
   `test/browser/vite.gate.config.ts` → `test/browser/dist` are the runner's *defaults* only because
   it is the first consumer, never because they are canonical).
2. A harness HTML entry plus a module entry, the HTML filename passed as `--gate-entry` (default
   `ui-gate.html`).
3. The entry importing **exactly one** stylesheet — the app's own `src/app.css` — and naming no
   stylesheet the app itself is responsible for wiring. **Why this is a requirement:** if the
   harness imported `tokens.css` directly it would render correctly even on an app that forgot the
   import, and the D-23 probe could never catch the one failure it exists for.
4. The entry mounting every named export of `@votetorrent/ui-web/components` inside an element
   carrying `data-ui-gate="<ExportName>"`, driving props so each renders non-empty output, then
   publishing a frozen `window.__UI_GATE__` and setting `window.__UI_GATE_DONE__ = true`.

`--gate-config`, `--gate-dist`, `--gate-entry` and `--port` (or the `UI_GATE_PORT` environment
variable) are documented CLI overrides whose defaults are the dashboard's own layout values — see
`run-ui-gates.mjs`'s own header for the full flag catalogue and the port-policy note (5180/5181
dev-preview, 5183 the dashboard's gate port, 5191 the public app's).
