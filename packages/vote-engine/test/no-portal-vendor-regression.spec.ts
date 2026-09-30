/**
 * no-portal-vendor-regression.spec.ts
 *
 * PUB-01 / PUB-02 CI regression lock — the 6 previously-vendored `@serfab/*` +
 * `@optimystic/db-*` packages stay on published npm; nothing re-introduces a
 * `portal:./vendor/...` resolution or descriptor.
 *
 * Mirrors quereus-single-copy-regression.spec.ts's pattern: `findRepoRoot()` walks
 * up to the dir containing yarn.lock (the source of truth for what actually
 * installs), reads it directly, and asserts unconditional invariants with chai
 * `expect(...).to.equal(0)` — a lock, not a ledger.
 *
 * Three invariants:
 *
 *   PUB-01-a — zero `portal:` locators for the 6 packages remain in yarn.lock. A
 *              future edit that re-vendors one of the 6 (e.g. `portal:./vendor/...`
 *              re-added to a root resolution or a workspace package.json
 *              descriptor) would reintroduce a portal locator for that package —
 *              this assertion catches it.
 *
 *   PUB-01-b — zero `./vendor/` resolution targets remain in the root
 *              package.json `resolutions` block. Guards the root manifest
 *              directly (belt-and-suspenders alongside PUB-01-a's lockfile
 *              check) and would catch a re-vendoring edit even before a
 *              `yarn install` regenerates the lockfile.
 *
 *   PUB-01-c — the 6 packages resolve to their published version lines
 *              (`@serfab/* ` 0.8.x, `@optimystic/db-*` 0.14.x) in yarn.lock —
 *              hardening beyond "not portal" to "actually the expected
 *              published range".
 *
 * This is a lockfile/manifest guard, not a runtime-behaviour guard.
 *
 * TEMPORARY EXCEPTION (2026-09-30): `@serfab/cadre-core` and `@serfab/quereus-plugin-sereus`
 * are consumed from sereus master through `portal:./vendor/@serfab/*`, because the fixes for
 * sereus#19-#22 are on master but not released (npm latest is 1.7.0). Only those two, and
 * only at exactly that path; the other four stay guarded as before, and the version check
 * reads the vendored package.json. See `vendor/@serfab/README.md`. Remove
 * `SANCTIONED_VENDOR` and the vendor copy together once a release carrying the fixes is
 * adopted.
 */

import { expect } from 'chai'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The 6 packages that were vendored via portal:./vendor/... and are now published. */
const DEVENDORED_PACKAGES = [
  '@serfab/cadre-core',
  '@serfab/quereus-plugin-sereus',
  '@serfab/strand-proto',
  '@optimystic/db-core',
  '@optimystic/db-p2p',
  '@optimystic/db-p2p-storage-rn'
]

/**
 * The two packages temporarily vendored from sereus master, and the only portal target
 * each may use.
 */
const SANCTIONED_VENDOR: Record<string, string> = {
  '@serfab/cadre-core': 'portal:./vendor/@serfab/cadre-core',
  '@serfab/quereus-plugin-sereus': 'portal:./vendor/@serfab/quereus-plugin-sereus'
}
const GUARDED_PACKAGES = DEVENDORED_PACKAGES.filter((pkg) => !(pkg in SANCTIONED_VENDOR))

/** Walk up from this spec to the repo root (the dir containing yarn.lock). */
function findRepoRoot (): string {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, 'yarn.lock'))) return dir
    dir = dirname(dir)
  }
  throw new Error('no-portal-vendor-regression: could not locate yarn.lock walking up from the spec')
}

/**
 * Count lockfile lines that co-occur a `portal:` resolution string with one of
 * the de-vendored package names — catches both a top-level descriptor key
 * (`"@serfab/cadre-core@portal:./vendor/@serfab/cadre-core::...":`) and a
 * `resolution:` line inside a block.
 */
function countPortalLocatorsFor (lock: string, packages: string[]): number {
  const lines = lock.split('\n')
  let count = 0
  for (const line of lines) {
    if (!line.includes('portal:')) continue
    if (packages.some((pkg) => line.includes(pkg))) count++
  }
  return count
}

/**
 * Collect the resolved `version:` of every block for a given package in
 * yarn.lock. Mirrors quereus-single-copy-regression.spec.ts's block-scan
 * approach: a top-level (column-0) key line whose descriptor set includes
 * `${pkg}@`, followed by an indented `version:` line.
 */
function resolvedVersionsFor (lock: string, pkg: string): string[] {
  const lines = lock.split('\n')
  const versions: string[] = []
  let inBlock = false
  const escaped = pkg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const keyRe = new RegExp(`(^|[",])${escaped}@`)
  for (const line of lines) {
    const isTopLevelKey = line.length > 0 && line[0] !== ' ' && line[0] !== '#' && line.trimEnd().endsWith(':')
    if (isTopLevelKey) {
      inBlock = keyRe.test(line)
      continue
    }
    if (inBlock) {
      const m = line.match(/^\s+version:\s*"?([^"\s]+)"?/)
      if (m) versions.push(m[1])
    }
  }
  return versions
}

describe('no-portal / no-vendor regression (PUB-01 / PUB-02)', () => {
  const repoRoot = findRepoRoot()
  const lock = readFileSync(join(repoRoot, 'yarn.lock'), 'utf8')
  const rootPackageJson = readFileSync(join(repoRoot, 'package.json'), 'utf8')

  // PUB-01-a — zero portal: locators for the 6 de-vendored packages in yarn.lock.
  it('PUB-01-a: yarn.lock has zero portal: locators for the de-vendored packages outside the sanctioned vendor', () => {
    const count = countPortalLocatorsFor(lock, GUARDED_PACKAGES)
    expect(
      count,
      `Expected zero portal: locators for ${GUARDED_PACKAGES.join(', ')}, found ${count} — a package has been re-vendored (PUB-01 violation)`
    ).to.equal(0)
    // A sanctioned package may only portal to its own vendor dir.
    for (const line of lock.split('\n')) {
      if (!line.includes('portal:')) continue
      for (const [pkg, target] of Object.entries(SANCTIONED_VENDOR)) {
        if (line.includes(`${pkg}@portal:`)) {
          expect(line, `${pkg} portals somewhere other than ${target}`).to.include(`${pkg}@${target}`)
        }
      }
    }
  })

  // PUB-01-b — zero ./vendor/ resolution targets in the root package.json resolutions block.
  it('PUB-01-b: root package.json has zero ./vendor/ resolution targets', () => {
    const parsed = JSON.parse(rootPackageJson) as { resolutions?: Record<string, string> }
    const resolutions = parsed.resolutions ?? {}
    const vendorEntries = Object.entries(resolutions).filter(([key, value]) =>
      value.includes('./vendor/') && SANCTIONED_VENDOR[key] !== value)
    expect(
      vendorEntries.length,
      `Expected zero ./vendor/ resolution targets in root package.json, found: ${vendorEntries.map(([k]) => k).join(', ')} — a package has been re-vendored (PUB-02 violation)`
    ).to.equal(0)
  })

  // PUB-01-c — the 6 packages resolve to their published version lines.
  it('PUB-01-c: the 6 de-vendored packages resolve to published versions (@serfab 1.7.x, @optimystic/db-* 1.7.x)', () => {
    for (const pkg of DEVENDORED_PACKAGES) {
      if (pkg in SANCTIONED_VENDOR) {
        // A portal locks as 0.0.0-use.local, so read the vendored manifest instead.
        const vendored = JSON.parse(readFileSync(join(repoRoot, 'vendor', pkg, 'package.json'), 'utf8')) as { version: string }
        expect(vendored.version, `vendored ${pkg} must be on the 1.7 line`).to.match(/^1\.7\./)
        continue
      }
      const versions = resolvedVersionsFor(lock, pkg)
      expect(versions.length, `expected at least one resolved ${pkg} block in yarn.lock`).to.be.greaterThan(0)

      const distinct = [...new Set(versions)]
      expect(
        distinct.length,
        `Expected a single resolved ${pkg} version, found ${distinct.length}: ${distinct.join(', ')}`
      ).to.equal(1)

      // @serfab/strand-proto is still on the 0.11 line (neither 0.12 nor 0.13 was ever
      // published for it); cadre-core and quereus-plugin-sereus moved 0.12.0 -> 0.13.0
      // with the bump in eb5302af. @optimystic/db-* moved 1.0.0-beta.3 -> 1.1.0 on
      // 2026-09-21: 1.1.0 is the first STABLE optimystic line, and taking it was not
      // optional once its two quereus plugins narrowed their peer range to ^4.19.4.
      // NOTE the @serfab line is deliberately NOT moved in that bump even though
      // cadre-core 1.0.0 exists — cadre-core 0.13.0's `^1.0.0-beta.2` range already
      // admits 1.1.0, so the families were decoupled for this hop on purpose.
      // This assertion had drifted TWO bumps behind once already (it still named 0.12.x /
      // 0.27.x) because nothing re-runs it on a dependency change.
      // It drifted AGAIN (still 0.13.x / 1.1.x) across the cadre-core 1.2.0 and the
      // @optimystic 1.2.0 -> 1.3.0 -> 1.5.0 bumps; re-keyed 2026-09-28 with the
      // @optimystic 1.5.0 -> 1.7.0 and @serfab 1.2.0 -> 1.6.0 bumps to what yarn.lock actually resolves.
      // Spike 094: @serfab 1.6.0 -> 1.7.0 (strand peer book; the local fwdport patch carried verbatim).
      const expectedPrefix = pkg === '@serfab/strand-proto' ? '0.11.'
        : pkg.startsWith('@serfab/') ? '1.7.' : '1.7.'
      expect(
        distinct[0],
        `Resolved ${pkg} version must start with ${expectedPrefix}, got ${distinct[0]}`
      ).to.match(new RegExp(`^${expectedPrefix.replace(/\./g, '\\.')}`))
    }
  })
})
