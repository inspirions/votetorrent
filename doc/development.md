# Development

This document is the day-to-day developer guide for working **inside** the
VoteTorrent monorepo: which commands to run where, how the build pipeline is
wired, how linting and the peer-requirements guard work, how the in-repo
vendoring and patching is maintained, and how to run the on-device proof
scripts.

For how the repository is laid out and how the packages compose at runtime, see
[Codebase Architecture](codebase-architecture.md). For toolchain and config
values, see [Configuration](configuration.md). For the test suites and how to
run them in isolation, see [Testing](testing.md).

## Local setup

Prerequisites:

- **Node `>=20.19`** (root `package.json` `engines`). The repo pins
  `22.15.0` in `.nvmrc`; `nvm use` selects it. The proof scripts and the Metro
  bundle steps in particular are validated under Node 22 — Node `<20.19` may
  fail to resolve the `portal:` dependencies.
- **Yarn `4.7.0`** (root `package.json` `packageManager`). It is invoked through
  the repo's Yarn shim, so once enabled via `corepack` no separate install is
  needed.

First-time setup is a single install at the repo root:

```bash
nvm use            # selects Node 22.15.0 from .nvmrc
yarn install
```

`yarn install` runs `scripts/check-peer-requirements.mjs` automatically through
the root `postinstall` hook (see [Peer-requirements guard](#peer-requirements-guard)
below). A clean clone builds with **no sibling checkout present** — the
`@serfab/*` and `@optimystic/db-*` dependencies are vendored in-repo under
`vendor/` and resolved through `portal:` entries in the root `resolutions`. You
do **not** need a `../sereus` or `../Optimystic` working tree to install or
build.

## Working in the monorepo

The workspaces are declared in the root `package.json` (`packages/*` and
`apps/*`):

| Workspace | Package name | Role |
|-----------|--------------|------|
| `packages/vote-core` | `@votetorrent/vote-core` | Shared types / protocol contracts (library) |
| `packages/vote-engine` | `@votetorrent/vote-engine` | Concrete engine implementation (library) |
| `packages/p2p-probe-host` | `p2p-probe-host` | Host-side dev drone for the dial proof |
| `apps/VoteTorrentAuthority` | `votetorrent-authority` | React Native reference app |

There are two ways to drive scripts.

**Across all workspaces** — the root scripts fan out with
`yarn workspaces foreach -A run <script>`:

```bash
yarn build     # build every workspace
yarn test      # test every workspace
yarn clean     # clean every workspace
yarn lint      # peer-requirements guard, then lint every workspace
```

**One workspace at a time** — target a single workspace by name (the package
`name`, not the directory):

```bash
yarn workspace @votetorrent/vote-engine build
yarn workspace @votetorrent/vote-core test
yarn workspace votetorrent-authority start
```

A few app-targeted shortcuts are exposed at the root for convenience:

```bash
yarn start      # = yarn workspace votetorrent-authority start  (Metro)
yarn android    # = yarn workspace votetorrent-authority android
yarn ios        # = yarn workspace votetorrent-authority ios
```

Note `yarn build` runs `foreach -A`, which is unordered. When you have just
edited `vote-core` and want `vote-engine` to pick up the change, build the
dependency first, then the dependent (see
[Editing across packages](#editing-across-packages)).

## Build pipeline

Each library workspace has its own `build`/`clean`/`lint`/`test` scripts; the
root simply fans them out. The two libraries are built differently.

**`@votetorrent/vote-core`** uses **aegir** for everything:

```bash
yarn workspace @votetorrent/vote-core build     # aegir build
yarn workspace @votetorrent/vote-core clean     # aegir clean
```

aegir compiles `src/` to `dist/` per `tsconfig.build.json` and the package's
`exports` map (`dist/src/index.js`, `dist/src/index.d.ts`).

**`@votetorrent/vote-engine`** builds with **`tsc` directly** (not aegir) so it
can emit the dual `.` / `./rn` entry points its `exports` map declares:

```bash
yarn workspace @votetorrent/vote-engine build   # tsc -p tsconfig.build.json
yarn workspace @votetorrent/vote-engine clean    # rm -rf dist
```

`tsconfig.build.json` extends `tsconfig.json`, emits declarations + source maps,
and uses `module: ESNext` / `moduleResolution: Bundler`. Output lands in
`dist/` with the package root entry at `dist/index.js` and the React Native
entry at `dist/rn-entry.js`. The `files` array publishes `src` and `dist` but
excludes `dist/test` and `*.tsbuildinfo`.

aegir runs without a checked-in `.aegir.*` config — it uses its defaults plus
each package's `tsconfig`.

## Linting, formatting, and the peer-requirements guard

### Lint / format

- **`@votetorrent/vote-core`** and **`@votetorrent/vote-engine`** lint with
  **aegir** (`aegir lint`, which wraps ESLint with `eslint-plugin-n`).
- **`votetorrent-authority`** lints with the React Native ESLint config
  (`eslint .`) and formats with **Prettier 2.8.8** (both are devDependencies of
  the app).

Run lint for one workspace or all of them:

```bash
yarn workspace @votetorrent/vote-engine lint
yarn lint        # runs the peer guard first, then lints every workspace
```

Editor style is enforced by `.editorconfig` at the repo root: **tabs**,
`indent_size = 2`, final newline, trimmed trailing whitespace, and single quotes
for `.ts`. Markdown is the exception (spaces, no max line length). The only
recommended VS Code extension is `EditorConfig.EditorConfig` (`.vscode/extensions.json`).

`aegir dep-check` is available in both libraries (`yarn workspace <name> dep-check`)
to catch unused / undeclared dependencies.

### Peer-requirements guard

`scripts/check-peer-requirements.mjs` is wired into the root `package.json` two
ways:

- as the `postinstall` hook (runs on every `yarn install`), and
- as the first step of root `lint`, and on its own as `yarn lint:peers`.

```bash
yarn lint:peers      # node scripts/check-peer-requirements.mjs
```

Why it exists: under Yarn 4 with `nodeLinker: node-modules`, an unmet-peer
summary (`YN0086`) is emitted project-wide. `.yarnrc.yml` discards `YN0086`
globally so the **known-allowed** `@optimystic/quereus-plugin-*` peer mismatches
(which are expected, because those plugins target a different `@quereus/quereus`
range than the pinned `3.3.0`) stay quiet. Because that discard is broad, this
guard restores the signal for the one surface it could mask: it runs
`yarn explain peer-requirements`, drills into each folded detail tree, and
fails closed if it sees an `@optimystic/quereus-plugin-*` mismatch that is not
in its `KNOWN_ALLOWED` set. The currently-allowed set is:

- `@optimystic/quereus-plugin-crypto@npm:0.13.5`
- `@optimystic/quereus-plugin-crypto@npm:0.14.1`
- `@optimystic/quereus-plugin-optimystic@npm:0.13.5`

If you intentionally introduce a new mismatch (e.g. bumping a plugin), update
`KNOWN_ALLOWED` in that script. If upstream publishes a clean version, remove
the entry **and** drop the matching `logFilters: YN0086` line from `.yarnrc.yml`
(the script prints an `INFO: disappeared` hint when a known mismatch stops
showing up).

## Vendoring and patching

Nothing is vendored. `@serfab/*` and `@optimystic/*` come from npm; edits that
are not upstream yet are yarn patches under `.yarn/patches/`, referenced from
the root `resolutions` and each consumer's manifest. Current inventory:

| Package | Patch | What it carries |
|---------|-------|-----------------|
| `@serfab/cadre-core@1.9.0` | `@serfab-cadre-core-npm-1.9.0-votetorrent.patch` | The public-observer protocol (`patches/serfab-cadre-core-public-observer.md`) and the strand cohort topic (`patches/serfab-cadre-core-strand-cohort-topic.md`) |
| `@optimystic/db-p2p@1.8.1` | `@optimystic-db-p2p-npm-1.8.1-votetorrent.patch` | `.unref?.()` guards in `cluster-repo.js`, whose timers return plain numbers on React Native and in browsers |
| `@quereus/quereus@4.20.0` | `@quereus-quereus-npm-4.20.0-6fd16bc9e5.patch` | The datetime immediate-CHECK fix |
| `react-native-quick-base64@3.0.1` | `react-native-quick-base64-npm-3.0.1-f6009a6514.patch` | |

To change a patch, run `yarn patch <pkg>@npm:<version>`, edit the extracted
copy, and `yarn patch-commit`. On a version bump, dry-run the old patch against
the new tarball first (`patch -p1 --dry-run`) and re-base only the hunks that
fail.

### Verifying the vendor / portal wiring

`scripts/verify-vendoring.sh`, `scripts/verify-portal-adoption.sh` and
`scripts/sync-vendor.sh` belong to the retired `vendor/` model and assert
things that are no longer true (a `vendor/` copy of `@serfab/cadre-core`). The
live guard is `packages/vote-engine/test/no-portal-vendor-regression.spec.ts`.

## vote-engine build guard

`@votetorrent/vote-engine` has an extra guard script:

```bash
yarn workspace @votetorrent/vote-engine guard:builders   # bash scripts/ci-grep-guard.sh
```

`scripts/ci-grep-guard.sh` greps the `src/**/builders/*.ts` files and **rejects
colon-prefix SQL bind keys** (e.g. a quoted `':userId'`). The Quereus
colon-prefix parameter-binding quirk must stay contained at the engine layer —
builders construct domain objects, never SQL bind objects. It scans only files
inside `builders/` subdirectories by default (override with `BUILDERS_DIR=`),
exits `0` when clean and `1` on a violation. Run it after touching anything
under a `builders/` directory.

## Editing across packages

The dependency direction is `vote-core` → `vote-engine` → `votetorrent-authority`.
The app consumes the libraries through `workspace:*`, so it picks up local
changes once the library's `dist/` is rebuilt.

A typical cross-package edit loop:

1. Edit `packages/vote-core/src/...`.
2. Rebuild the dependency first:
   `yarn workspace @votetorrent/vote-core build`.
3. Rebuild the dependent:
   `yarn workspace @votetorrent/vote-engine build`.
4. If a `builders/` file changed, run
   `yarn workspace @votetorrent/vote-engine guard:builders`.
5. Restart Metro (`yarn start --reset-cache`) so the app re-bundles the updated
   `dist/`.

Because `yarn build` at the root is unordered, prefer building the specific
workspaces in order during an edit loop rather than relying on a single root
`yarn build`.

## On-device proof scripts

`scripts/run-*.sh` are runnable proofs that exercise the app on a connected
Android device/emulator (via `adb`) and parse `logcat` for a verdict line. They
are dev/CI tooling, not part of the app build. Each is self-documented in its
header; all anchor their working directory to the repo root and restore any
temporary state on exit.

| Script | What it proves |
|--------|----------------|
| `scripts/run-dial-probe.sh` | A device→host WebSocket dial completes with no "connection gater denied" — validates the cadre-core `connectionGater` patch. Needs the `p2p-probe-host` drone running first (`cd packages/p2p-probe-host && node drone.mjs`) and `CONTROL_ADDR` set in the app. |
| `scripts/run-replication-proof.sh` | Symmetric P2P replication across two emulators (`emulator-5554` + `emulator-5556`): both must emit `REPLICATION VERDICT: PASS`, peerId is stable across a relaunch, and peer count ≥ 1. The drone launch is automated. |
| `scripts/run-signing-proof.sh` | An on-device signing round-trip (`SIGNING VERDICT: PASS`) on initial boot **and** after a force-stop/relaunch, and that the pre-fix `sign is not a function` FATAL does not reproduce. Invoke as `SERIAL=emulator-5554 ./scripts/run-signing-proof.sh`. |
| `scripts/run-vtest02.sh` | Full-chain restart persistence: force-stops and relaunches the app, then polls for `FULL-CHAIN VERDICT: PASS` from the in-app persistence-proof runner (requires the app to have completed its write phase once). |

Common prerequisites: `adb` on `PATH` (Android SDK Platform Tools), the app
(`org.votetorrent.authority`) installed on a connected device/AVD, and (for the
replication and signing proofs) `nvm` with Node 22. The signing and persistence
proofs flip a generated flag file and restore it with `git checkout` on exit, so
keep your working tree clean before running them. The shared logcat
wait/poll helper lives in `scripts/lib/logcat-wait.sh`.

## Editor / debugging

`.vscode/launch.json` ships three launch configurations:

- **Mocha – Current test file (vote-engine)** — debugs the open `*.spec.ts`
  under `register-ts-node.mjs`.
- **Mocha – All tests (vote-engine)** — debugs the whole `vote-engine` suite.
- **Debug Core Tests** — an aegir test debug config.

`.vscode/settings.json` configures the PlantUML export targets (`doc/figures`)
and a project `cSpell` word list.

## Where to go next

- [Testing](testing.md) — the `vote-core` / `vote-engine` suites and how to run
  a single file.
- [Codebase Architecture](codebase-architecture.md) — workspace layout and
  runtime composition.
- [Configuration](configuration.md) — toolchain, resolutions, and environment
  variables.
- `vendor/VENDOR.md` — vendored-package provenance and the published/vendored
  boundary.
