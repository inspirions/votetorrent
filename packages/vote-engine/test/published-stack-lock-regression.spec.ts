/**
 * published-stack-lock-regression.spec.ts
 *
 * Phase 40 CI regression locks — three lockfile/manifest invariants for the
 * published-package stack that no existing spec covers:
 *
 *   UPG-06 — patched @quereus/quereus 4.18.0 single copy. Extends
 *            quereus-single-copy-regression.spec.ts (UPG-03, "single copy,
 *            4.x") to the phase-specific version+patch: the resolved version
 *            must be exactly 4.3.1, the required forward-ported patch locator
 *            (@quereus-quereus-npm-4.3.1-6814ac0861 — applyViewDefaults +
 *            runBatchedMigrationLoop; npm's 4.3.1 ships applyViewDefaults=0,
 *            so the patch is not optional) must be present, and the
 *            superseded 4.2.1 patch locator must be gone.
 *
 *   PUB-01 (multiaddr clause) — a single resolved @multiformats/multiaddr
 *            version, and it is 13.x (VT's own libp2p matrix). A second
 *            resolved multiaddr line is the spike-021 Variant-B hazard
 *            (adopting a second libp2p matrix from a published dependency).
 *
 *   PUB-02 — @optimystic/quereus-plugin-optimystic reconciled to a single
 *            0.27.x version (off the formerly-patched 0.13.5), and the two
 *            dead patch locators from the pre-de-vendoring state
 *            (@optimystic-quereus-plugin-optimystic-npm-0.13.5,
 *            @serfab-cadre-core-npm-0.7.1) have zero references anywhere in
 *            yarn.lock — both packages superseded the hand-patches upstream
 *            (0.14.1 / 0.8.1) and the patches were deleted in 40-02.
 *
 * Mirrors quereus-single-copy-regression.spec.ts / no-portal-vendor-regression.spec.ts's
 * pattern: findRepoRoot() walks up to the dir containing yarn.lock (the source
 * of truth for what actually installs), reads it + the root package.json
 * directly, and asserts unconditional invariants with chai
 * expect(...).to.equal(...) — a lock, not a ledger.
 *
 * This is a lockfile/manifest guard, not a runtime-behaviour guard.
 */

import { expect } from 'chai'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Walk up from this spec to the repo root (the dir containing yarn.lock). */
function findRepoRoot (): string {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, 'yarn.lock'))) return dir
    dir = dirname(dir)
  }
  throw new Error('published-stack-lock-regression: could not locate yarn.lock walking up from the spec')
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

describe('published stack lock regression (UPG-06 / PUB-01 / PUB-02)', () => {
  const repoRoot = findRepoRoot()
  const lock = readFileSync(join(repoRoot, 'yarn.lock'), 'utf8')
  const rootPackageJson = readFileSync(join(repoRoot, 'package.json'), 'utf8')

  describe('UPG-06: patched @quereus/quereus 4.18.0 single copy', () => {
    it('resolves a single @quereus/quereus version, and it is exactly 4.18.0', () => {
      const versions = resolvedVersionsFor(lock, '@quereus/quereus')
      expect(versions.length, 'expected at least one resolved @quereus/quereus block in yarn.lock').to.be.greaterThan(0)

      const distinct = [...new Set(versions)]
      expect(
        distinct.length,
        `Expected a single resolved @quereus/quereus version, found ${distinct.length}: ${distinct.join(', ')} — dual-version install`
      ).to.equal(1)

      expect(
        distinct[0],
        `Resolved @quereus/quereus version must be exactly 4.18.0, got ${distinct[0]}`
      ).to.equal('4.18.0')
    })

    it('carries the required 4.18.0 patch (@quereus-quereus-npm-4.18.0-9b9f24c666)', () => {
      const count = (lock.match(/@quereus-quereus-npm-4\.18\.0-9b9f24c666/g) ?? []).length
      expect(
        count,
        'Expected the @quereus-quereus-npm-4.18.0-9b9f24c666 patch locator to be present in yarn.lock. Forward-ported ' +
        '4.11.0 -> 4.14.0 (spike 064) -> 4.17.1 -> 4.18.0 (2026-09-03, forced by @serfab/cadre-core 0.12.0, which ' +
        'requires quereus ^4.18.0). The 4.18.0 hop was NOT verbatim and GREW the patch from four files to five. ' +
        'Two things moved. (1) update.js: upstream replaced the phase-2 row-level `coerceGenerated = ' +
        'buildRowCoercion(...)` with a PER-CELL `generatedCoercions` Map read inside the loop, so "disabled" is now ' +
        'an EMPTY MAP rather than an undefined row-coercer — same net effect only because the `if (coerce)` guard ' +
        'survives; if a later version drops that guard the edit stops being inert. (2) write-coercion.js is NEW in ' +
        '4.18.0: a WriteCoercionNode now sits in the row-expansion projection, UPSTREAM of emitInsert, so the row ' +
        'arrives already converted and disabling the emitters\' own coercers no longer restores 4.3.1 semantics on ' +
        'its own. Measured: edits 1-4 alone left 73 failing, 49 of them this exact class; adding the write-coercion ' +
        'edit took it to the known floor. That fifth edit is BROADER than the others — it disables write-path ' +
        'coercion for every column and type, so a type MISMATCH that used to throw at plan time now surfaces from ' +
        'the storage layer. The patch still carries ONE concern: the datetime immediate-CHECK coercion restoration ' +
        '(4.4.1 moved declared-type conversion to the top of the DML pipeline and deleted constraint-check\'s ' +
        'coerceNewSection, collapsing 4.3.1\'s raw-immediate / coerced-deferred split). Re-measured on 4.18.0, not ' +
        'carried forward: installing UNPATCHED gives 1395 passing / 265 failing, and 224 of those 265 are exactly ' +
        'this class (ExpirationValid / SubmittedAtValid `isISODatetime(x) and like(\'%Z\', x)`); re-applying the ' +
        'patch returns the suite to its known floor. The 4.17.1 figures were 1396/264 with 225 in-class, so the ' +
        'defect tracks the suite, not the version. Upstream issue: gotchoices/quereus#28, still OPEN, so this patch ' +
        'is not yet retirable.'
      ).to.be.greaterThan(0)
    })

    it('has zero references to superseded quereus patch locators (4.2.1-64e8a4bca7, 4.3.1-6814ac0861, 4.14.0-042f7e4e5e, 4.17.1-831db23a51)', () => {
      const supersededCounts = {
        '4.2.1-64e8a4bca7': (lock.match(/4\.2\.1-64e8a4bca7/g) ?? []).length,
        '4.3.1-6814ac0861': (lock.match(/4\.3\.1-6814ac0861/g) ?? []).length,
        '4.14.0-042f7e4e5e': (lock.match(/4\.14\.0-042f7e4e5e/g) ?? []).length,
        '4.17.1-831db23a51': (lock.match(/4\.17\.1-831db23a51/g) ?? []).length,
      }
      const residue = Object.entries(supersededCounts).filter(([, n]) => n > 0)
      expect(
        residue.length,
        `Expected zero references to superseded quereus patch locators, found: ${residue.map(([k, n]) => `${k}×${n}`).join(', ')} — stale patch residue`
      ).to.equal(0)
    })
  })

  describe('PUB-01: single @multiformats/multiaddr copy (VT\'s own 13.x libp2p matrix)', () => {
    it('resolves a single @multiformats/multiaddr version, and it is 13.x', () => {
      const versions = resolvedVersionsFor(lock, '@multiformats/multiaddr')
      expect(versions.length, 'expected at least one resolved @multiformats/multiaddr block in yarn.lock').to.be.greaterThan(0)

      const distinct = [...new Set(versions)]
      expect(
        distinct.length,
        `Expected a single resolved @multiformats/multiaddr version, found ${distinct.length}: ${distinct.join(', ')} — dual-multiaddr install (spike-021 Variant-B hazard)`
      ).to.equal(1)

      expect(
        distinct[0],
        `Resolved @multiformats/multiaddr version must be 13.x, got ${distinct[0]}`
      ).to.match(/^13\./)
    })
  })

  describe('PUB-02: @optimystic/quereus-plugin-optimystic reconciled to ^0.27.x, dead patches retired', () => {
    it('resolves a single @optimystic/quereus-plugin-optimystic version, and it is 0.27.x', () => {
      const versions = resolvedVersionsFor(lock, '@optimystic/quereus-plugin-optimystic')
      expect(versions.length, 'expected at least one resolved @optimystic/quereus-plugin-optimystic block in yarn.lock').to.be.greaterThan(0)

      const distinct = [...new Set(versions)]
      expect(
        distinct.length,
        `Expected a single resolved @optimystic/quereus-plugin-optimystic version, found ${distinct.length}: ${distinct.join(', ')}`
      ).to.equal(1)

      expect(
        distinct[0],
        `Resolved @optimystic/quereus-plugin-optimystic version must be 0.27.x, got ${distinct[0]}`
      ).to.match(/^0\.27\./)
    })

    it('resolves ^0.27.0 in the root package.json dependency declaration', () => {
      const parsed = JSON.parse(rootPackageJson) as {
        dependencies?: Record<string, string>
        resolutions?: Record<string, string>
      }
      const declared = parsed.dependencies?.['@optimystic/quereus-plugin-optimystic'] ??
        parsed.resolutions?.['@optimystic/quereus-plugin-optimystic']
      expect(
        declared,
        'Expected root package.json to declare @optimystic/quereus-plugin-optimystic as ^0.27.0'
      ).to.equal('^0.27.0')
    })

    it('has zero references to the dead patch locators (0.13.5 plugin-optimystic patch, 0.7.1 cadre-core patch)', () => {
      const pluginPatchCount = (lock.match(/@optimystic-quereus-plugin-optimystic-npm-0\.13\.5/g) ?? []).length
      const cadreCorePatchCount = (lock.match(/@serfab-cadre-core-npm-0\.7\.1/g) ?? []).length

      expect(
        pluginPatchCount,
        `Expected zero references to @optimystic-quereus-plugin-optimystic-npm-0.13.5, found ${pluginPatchCount} — dead patch residue (superseded upstream in 0.14.1)`
      ).to.equal(0)

      expect(
        cadreCorePatchCount,
        `Expected zero references to @serfab-cadre-core-npm-0.7.1, found ${cadreCorePatchCount} — dead patch residue (connectionGater upstream in 0.8.1)`
      ).to.equal(0)
    })
  })
})
