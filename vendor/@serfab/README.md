# vendor/@serfab: sereus master, consumed through portal

**Temporary.** Remove this directory when a published `@serfab/cadre-core` release carries
the fixes below.

`@serfab/cadre-core` and `@serfab/quereus-plugin-sereus` are built from sereus master,
because the fixes VoteTorrent needs are on master but not published (npm latest is 1.7.0,
2026-09-28):

| Issue | Fix on master (ticket) |
|---|---|
| sereus#19 relay caps every relayed connection | `bug-party-run-relay-caps-every-relayed-connection` |
| sereus#20 relay dials a sibling through its own circuit | `relay-node-dials-a-sibling-through-its-own-circuit` |
| sereus#21 strand-addr refresh throttled per strand | `strand-addr-status-and-per-sibling-refresh` |
| sereus#22 failed answers read as "no addresses"; `void node.handle` | `strand-addr-status-and-per-sibling-refresh`, `await-protocol-handler-registration` |

`@serfab/cadre-rn` did not change on master, so it stays on npm 1.7.0.

## Provenance

- Source: `gotchoices/sereus` @ `12a50d8f061c13b74d3b7d902e4c863cebf43283` (2026-09-29).
- Built against the SAME published deps this repo runs: `@optimystic/*` 1.7.0 and
  `@quereus/quereus` 4.20.0. Sereus's root `link:../optimystic`, `link:../quereus`
  resolutions were dropped for the build.
- `yarn workspace @serfab/quereus-plugin-sereus build && yarn workspace @serfab/cadre-core build`,
  then `yarn pack` for each (which rewrites `workspace:^` to `^1.7.0`). Tarball sha256:
  - cadre-core `9a2a13b5f50d5c165c64df6914f76e550eef6728d11136461cad4f204b43f068`
  - quereus-plugin-sereus `f5a794abc116f66a400b1c3ed49473eb561d0cbe2be0e2fb26ff0764b1251504`
- Copied without `*.map` files and without `src/` (the plugin's browser map alone is 11 MB).
  The package version still reads 1.7.0.
- `cadre-core.votetorrent.patch` is then applied to `cadre-core/` (`patch -p1`). It is the old
  `.yarn/patches/@serfab-cadre-core-npm-1.7.0-fwdport.patch` WITHOUT its two
  `relayServerInit` forward hunks, which #19 made redundant: the public-observer protocol
  (sereus#23, still open) and the strand cohort topic. Three hunks were re-based by hand onto
  master's `cadre-node.js`.

## How it is wired

- The root `resolutions` and each consumer's descriptor use `portal:./vendor/@serfab/*`.
- A symlinked package resolves its imports from its REAL path, which would load a second
  copy of libp2p / db-p2p / multiaddr from the root `node_modules`. Two things keep a
  single copy:
  - Metro (Authority, Voter): `resolveRequest` re-roots bare imports that come from
    `vendor/@serfab/` onto the app's own `node_modules/@serfab/` link.
  - Node drones: `--preserve-symlinks` (`scripts/run-replication-proof.sh`,
    `packages/p2p-probe-host` `start`).
- The apps declare `@optimystic/quereus-plugin-crypto` and `@serfab/quereus-plugin-sereus`
  directly. From npm, cadre-core brought those into each app's `node_modules`; through a
  root-owned portal it doesn't, and the root copy of plugin-crypto pulled in a second
  `@quereus/quereus`.
- `packages/vote-engine/test/no-portal-vendor-regression.spec.ts` allows exactly these two
  portals (`SANCTIONED_VENDOR`).

## Removing it

1. Bump `@serfab/cadre-core` / `@serfab/quereus-plugin-sereus` to the new release in the root
   `resolutions` and in each consumer, and turn this patch back into a yarn patch
   (`.yarn/patches/`).
2. Delete this directory, the `.gitignore` exception, the Metro re-rooting, the drones'
   `--preserve-symlinks`, `SANCTIONED_VENDOR`, and the two direct app deps above if nothing
   else needs them.
3. Re-run the sereus#19-#23 regression tests
   (`.planning/quick/260928-qge-file-upstream-cadre-core-issues-with-rep/issues/tests`).
   Each test reads its own env var for the dependency dir (`CADRE_CORE_DEPS_FROM`,
   `CADRE_CORE_DEPS_DIR`, `CADRE_DEPS_DIR`, `CADRE_CORE_DEPS`).
