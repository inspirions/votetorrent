/**
 * browser-entry-purity.spec.ts
 *
 * Phase 50 (D-01/D-02/D-19) — the `./browser` subpath (backed by
 * `src/browser-entry.ts`) is the ONLY mechanism by which the new
 * `apps/VoteTorrentDashboard` Vite workspace reaches `@votetorrent/vote-engine`.
 * Nothing reachable from that subpath may import React Native, a Node builtin,
 * or `buffer` — all three are simply absent in a browser bundle.
 *
 * This spec walks the transitive SOURCE import graph (relative `./x.js`
 * specifiers resolved to `./x.ts`, comments stripped) rooted at
 * `src/browser-entry.ts` and asserts:
 *
 *   BROWSER-PURITY-a — zero forbidden (RN / Node-builtin / buffer) specifiers
 *                       reachable from the ./browser graph.
 *   BROWSER-PURITY-b — the graph's bare (non-relative) specifiers are EXACTLY
 *                       the 7-entry allowlist below — two-directional
 *                       set-equality, so a new dependency fails loudly rather
 *                       than silently widening the bundle.
 *   BROWSER-PURITY-c — the walker actually reaches a non-trivial graph
 *                       (>= 12 files) — guards (a)/(b) against a broken
 *                       resolver that walks almost nothing and passes
 *                       vacuously.
 *   BROWSER-PURITY-d — POSITIVE CONTROL: the identical walker, run over
 *                       `src/rn-entry.ts`, DOES report the async-storage and
 *                       buffer violations it is supposed to catch. Proves the
 *                       walker can actually detect a violation, not just fail
 *                       to find one.
 *   D-02-a            — no file under `src/` imports bare `'crypto'` (the one
 *                       open half of D-02 this plan closes).
 *   D-02-b            — POSITIVE CONTROL: `networks-engine.ts` still calls
 *                       `crypto.randomUUID()` at both surviving call sites —
 *                       proves the D-02-a fix removed only the dead import,
 *                       not a call site.
 *
 * Comment-stripping is MANDATORY, not optional: `src/utils.ts` contains the
 * literal word `Buffer` inside a comment, and `src/user/user-engine.ts`
 * contains English prose ("user lacks the scope.") that a naive multi-line
 * `[\s\S]*?` import regex misparses as an import specifier. Both were
 * observed with an unstripped scanner while developing this walker.
 */

import { expect } from 'chai'
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Exact bare specifiers that are never browser-safe. */
const FORBIDDEN_EXACT = [
  'react-native',
  '@react-native-async-storage/async-storage',
  'crypto',
  'fs',
  'fs/promises',
  'path',
  'os',
  'buffer',
  'child_process',
  'url',
  'stream',
  'util',
  'events'
]

/** Bare specifier prefixes that are never browser-safe. */
const FORBIDDEN_PREFIX = [
  'node:',
  'react-native/',
  '@react-native-community/',
  '@react-native-async-storage/'
]

/**
 * The exact 7-entry allowlist of bare specifiers reachable from
 * `src/browser-entry.ts` (measured 2026-08-25 by walking the transitive
 * source import graph — see 50-01-PLAN.md `<measured_facts>`).
 *
 * Each entry's "why browser-safe" rationale is recorded here so a future
 * widener has to argue against a stated reason, not just add a string:
 *
 *   - '@quereus/quereus'                          — ran in headless Chrome
 *     unchanged in spikes 075/076.
 *   - '@votetorrent/vote-core'                     — grep-verified zero
 *     react-native/async-storage/node:/crypto/buffer imports under
 *     packages/vote-core/src/.
 *   - '@noble/curves/utils.js'                     — pure-JS crypto, no Node
 *     builtins.
 *   - '@noble/hashes/sha2.js'                       — pure-JS crypto.
 *   - '@noble/hashes/utils.js'                      — pure-JS crypto.
 *   - '@optimystic/quereus-plugin-crypto'           — registered in-browser
 *     by spikes 075/076.
 *   - '@optimystic/quereus-plugin-crypto/plugin'    — same package, `exports`
 *     subpath (carries a pre-existing `@ts-ignore TS2307` at the import
 *     site in database/initialize.ts — leave it).
 */
const BROWSER_ALLOWLIST = [
  '@quereus/quereus',
  '@votetorrent/vote-core',
  '@noble/curves/utils.js',
  '@noble/hashes/sha2.js',
  '@noble/hashes/utils.js',
  '@optimystic/quereus-plugin-crypto',
  '@optimystic/quereus-plugin-crypto/plugin'
]

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/** Locate packages/vote-engine/src from this spec's own location. */
function findSrcDir (): string {
  const here = dirname(fileURLToPath(import.meta.url))
  // this spec lives at packages/vote-engine/test/browser-entry-purity.spec.ts
  return join(here, '..', 'src')
}

const SRC_DIR = findSrcDir()

// ---------------------------------------------------------------------------
// Comment stripping + import extraction
// ---------------------------------------------------------------------------

/**
 * Strip `/* ... *\/` block comments then `// ...` line comments from TS
 * source. MANDATORY before regex-scanning for imports — see file header.
 *
 * This is a best-effort stripper (does not special-case comment-looking
 * substrings inside string literals), which is acceptable here because the
 * walker's own throw-on-unresolvable-specifier behavior (see
 * `resolveRelative`) surfaces any resulting misparse loudly rather than
 * silently.
 */
function stripComments (src: string): string {
  const noBlockComments = src.replace(/\/\*[\s\S]*?\*\//g, '')
  return noBlockComments.replace(/\/\/.*$/gm, '')
}

/**
 * Declaration keywords that, immediately following `import`/`export`
 * (+ optional `type`), mark the statement as NOT a from-clause import/export
 * (e.g. `export const X = ...`, `export function f() {}`, `export default
 * class {}`) — these must never trigger the from-clause accumulator below.
 */
const DECLARATION_KEYWORDS = new Set([
  'const', 'let', 'var', 'function', 'class', 'interface', 'enum',
  'namespace', 'abstract', 'declare', 'default'
])

/**
 * Extract every import/export-from specifier (plus bare side-effect imports)
 * from stripped source.
 *
 * This is a bracket-depth-aware line accumulator, NOT a single `[\s\S]*?`
 * regex spanning arbitrary text (that shape is exactly what this plan's
 * `<read_first>` warns against — it can walk clean past unrelated code
 * hunting for a distant `from`). Instead: identify each line that begins a
 * genuine `import`/`export` statement, accumulate forward ONLY while braces
 * are unbalanced (bounded to 30 lines), then look for a `from '...'` clause
 * in the accumulated buffer. A statement with balanced/absent braces and no
 * `from` on the same accumulated buffer (e.g. a bare `export { A, B }`
 * re-export, or `export type Foo = { a: string }`) is correctly recorded as
 * having no specifier — matching real language semantics, not a heuristic
 * guess.
 *
 * `export type Foo = ...` (a type ALIAS, no specifier) is deliberately
 * distinguished from `export type { Foo } from '...'` (a type RE-EXPORT):
 * both start `export type `, but only the second's next token is `{`/`*`.
 * A naive regex without this line-shape discrimination misclassifies
 * `export type DbFactory = (h: string) => Promise<Database>`
 * (`packages/vote-engine/src/types.ts`) as an unterminated from-clause hunt.
 */
function extractSpecifiers (strippedSrc: string): string[] {
  const lines = strippedSrc.split('\n')
  const specifiers: string[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]
    const startMatch = line.match(/^\s*(import|export)\s+(type\s+)?(\S)/)
    if (!startMatch) { i++; continue }

    const keyword = startMatch[1]
    const nextChar = startMatch[3]

    if (nextChar !== '{' && nextChar !== '*' && nextChar !== "'" && nextChar !== '"') {
      // Next token is a bare identifier (not `{`, `*`, or a quote). Either a
      // declaration keyword (`const`/`function`/...) or, for `export`, any
      // other bare identifier (`export type Foo = ...`, `export Foo` is not
      // valid syntax outside `export default`) — neither is a from-clause
      // statement. `import Foo from '...'` (default import) is the one
      // legitimate bare-identifier case and falls through below.
      const wordMatch = line.match(/^\s*(?:import|export)\s+(?:type\s+)?([A-Za-z_$][\w$]*)/)
      const word = wordMatch ? wordMatch[1] : ''
      if (DECLARATION_KEYWORDS.has(word) || keyword === 'export') {
        i++
        continue
      }
    }

    if (nextChar === "'" || nextChar === '"') {
      const sideMatch = line.match(/^\s*import\s*['"]([^'"]+)['"]/)
      if (sideMatch) {
        specifiers.push(sideMatch[1])
        i++
        continue
      }
    }

    // From-clause candidate (named/star/default import, or a from-reexport).
    // Accumulate forward only while braces are unbalanced, bounded to 30
    // lines so a genuinely malformed/unresolvable statement fails fast
    // rather than silently consuming the rest of the file.
    let buffer = line
    let depth = (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length
    let j = i
    const maxLines = 30
    while (depth > 0 && j - i < maxLines && j + 1 < lines.length) {
      j++
      buffer += '\n' + lines[j]
      depth += (lines[j].match(/\{/g) ?? []).length - (lines[j].match(/\}/g) ?? []).length
    }

    let m = buffer.match(/\bfrom\s*['"]([^'"]+)['"]/)
    if (!m && j + 1 < lines.length && /^\s*from\s*['"]/.test(lines[j + 1])) {
      // Rare style: `from '...'` on its own line after the closing brace.
      j++
      buffer += '\n' + lines[j]
      m = buffer.match(/\bfrom\s*['"]([^'"]+)['"]/)
    }

    if (m) specifiers.push(m[1])
    i = j + 1
  }

  return specifiers
}

// ---------------------------------------------------------------------------
// The walker
// ---------------------------------------------------------------------------

/**
 * Resolve a relative specifier (as imported from `fromFile`) to an absolute
 * .ts path. Tries, in order: literal path with a trailing `.js` rewritten to
 * `.ts`; literal path plus `.ts`; literal path plus `/index.ts`.
 *
 * Throws if none exist — a walker that silently drops an edge is a walker
 * that passes vacuously.
 */
function resolveRelative (fromFile: string, specifier: string): string {
  const baseDir = dirname(fromFile)
  const literal = join(baseDir, specifier)

  const candidates: string[] = []
  if (specifier.endsWith('.js')) {
    candidates.push(literal.slice(0, -3) + '.ts')
  }
  candidates.push(literal + '.ts')
  candidates.push(join(literal, 'index.ts'))
  // Also allow an already-resolved .ts literal (defensive; not expected in this codebase).
  candidates.push(literal)

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }

  throw new Error(
    `browser-entry-purity walker: cannot resolve relative specifier '${specifier}' imported from '${fromFile}'. ` +
    `Tried: ${candidates.join(', ')}`
  )
}

interface GraphResult {
  /** Absolute paths of every file reached (including the entry file itself). */
  files: string[]
  /** Bare specifier -> relative (to src/) file paths that import it. */
  bare: Map<string, string[]>
}

/**
 * Walk the transitive import graph starting at `entryAbsPath`.
 *
 * Relative specifiers are recursed into; every non-relative (bare) specifier
 * is recorded in `bare`, attributed to the importing file (relative to
 * SRC_DIR for readable assertion messages).
 */
function collectGraph (entryAbsPath: string): GraphResult {
  const visited = new Set<string>()
  const bare = new Map<string, string[]>()
  const queue: string[] = [entryAbsPath]

  while (queue.length > 0) {
    const file = queue.shift() as string
    if (visited.has(file)) continue
    visited.add(file)

    const src = readFileSync(file, 'utf8')
    const stripped = stripComments(src)
    const specifiers = extractSpecifiers(stripped)

    for (const spec of specifiers) {
      if (spec.startsWith('.')) {
        const resolved = resolveRelative(file, spec)
        if (!visited.has(resolved)) queue.push(resolved)
      } else {
        const relFile = file.startsWith(SRC_DIR) ? file.slice(SRC_DIR.length + 1) : file
        const existing = bare.get(spec)
        if (existing) {
          existing.push(relFile)
        } else {
          bare.set(spec, [relFile])
        }
      }
    }
  }

  return { files: [...visited], bare }
}

/** A single forbidden-specifier violation: <specifier> <- <relative file>. */
interface Violation {
  specifier: string
  importedBy: string
}

/** Reduce a collected graph's bare-specifier map to the forbidden subset. */
function findForbiddenViolations (bare: Map<string, string[]>): Violation[] {
  const violations: Violation[] = []
  for (const [specifier, importers] of bare) {
    const isForbidden =
      FORBIDDEN_EXACT.includes(specifier) ||
      FORBIDDEN_PREFIX.some((prefix) => specifier.startsWith(prefix))
    if (!isForbidden) continue
    for (const importedBy of importers) {
      violations.push({ specifier, importedBy })
    }
  }
  return violations
}

function formatViolations (violations: Violation[]): string {
  return violations.map((v) => `${v.specifier} <- ${v.importedBy}`).join('; ')
}

// ---------------------------------------------------------------------------
// Specs
// ---------------------------------------------------------------------------

describe('browser-entry-purity (Phase 50 D-01/D-02/D-19)', () => {
  const browserEntryPath = join(SRC_DIR, 'browser-entry.ts')
  const rnEntryPath = join(SRC_DIR, 'rn-entry.ts')

  it('BROWSER-PURITY-a: the ./browser import graph contains zero React Native / Node-builtin / buffer specifiers', () => {
    const graph = collectGraph(browserEntryPath)
    const violations = findForbiddenViolations(graph.bare)
    expect(
      violations.length,
      `Expected zero forbidden specifiers reachable from browser-entry.ts, found: ${formatViolations(violations)}`
    ).to.equal(0)
  })

  it("BROWSER-PURITY-b: the ./browser graph's bare specifiers are exactly the 7-entry allowlist", () => {
    const graph = collectGraph(browserEntryPath)
    const actual = new Set(graph.bare.keys())
    const expected = new Set(BROWSER_ALLOWLIST)

    const unexpectedExtras = [...actual].filter((s) => !expected.has(s))
    const missingExpected = [...expected].filter((s) => !actual.has(s))

    expect(
      unexpectedExtras.length,
      `Unexpected bare specifiers reachable from browser-entry.ts (not in the allowlist): ${unexpectedExtras.join(', ')}`
    ).to.equal(0)
    expect(
      missingExpected.length,
      `Allowlisted specifiers NOT reachable from browser-entry.ts (allowlist has drifted from reality): ${missingExpected.join(', ')}`
    ).to.equal(0)
  })

  it('BROWSER-PURITY-c: the walker reaches a non-trivial graph (>= 12 files) from browser-entry.ts', () => {
    const graph = collectGraph(browserEntryPath)
    expect(
      graph.files.length,
      `Expected >= 12 files reached from browser-entry.ts, found ${graph.files.length} — the resolver may be walking almost nothing`
    ).to.be.at.least(12)
  })

  it('BROWSER-PURITY-d (positive control): the same walker reports async-storage and buffer violations for rn-entry.ts', () => {
    // Deliberately do NOT assert on bare 'crypto' here — Task 2 deletes that
    // import from networks-engine.ts, which is also reachable from
    // rn-entry.ts. A control keyed on 'crypto' would flip from green to red
    // partway through this plan; async-storage and buffer are permanent
    // rn-entry.ts violations that never go away.
    const graph = collectGraph(rnEntryPath)
    const violations = findForbiddenViolations(graph.bare)

    const hasAsyncStorage = violations.some(
      (v) => v.specifier === '@react-native-async-storage/async-storage' && v.importedBy.includes('local-storage-react.ts')
    )
    const hasBuffer = violations.some(
      (v) => v.specifier === 'buffer' && v.importedBy.includes('association/key-provider.ts')
    )

    expect(
      hasAsyncStorage,
      `Expected the walker to detect @react-native-async-storage/async-storage imported by local-storage-react.ts via rn-entry.ts, found violations: ${formatViolations(violations)}`
    ).to.equal(true)
    expect(
      hasBuffer,
      `Expected the walker to detect buffer imported by association/key-provider.ts via rn-entry.ts, found violations: ${formatViolations(violations)}`
    ).to.equal(true)
  })

  it("D-02-a: no file under src/ imports bare 'crypto'", () => {
    // Scope this to bare 'crypto' only: src/association/verifiers/key-attestation.ts
    // legitimately imports 'node:crypto' (device-side, barrel-excluded) — asserting
    // against 'node:crypto' tree-wide would be a false failure.
    const offenders: string[] = []

    function walkDir (dir: string): string[] {
      const out: string[] = []
      for (const entry of readdirSync(dir)) {
        const abs = join(dir, entry)
        const st = statSync(abs)
        if (st.isDirectory()) {
          out.push(...walkDir(abs))
        } else if (entry.endsWith('.ts')) {
          out.push(abs)
        }
      }
      return out
    }

    const allFiles = walkDir(SRC_DIR)
    for (const file of allFiles) {
      const stripped = stripComments(readFileSync(file, 'utf8'))
      const specifiers = extractSpecifiers(stripped)
      if (specifiers.includes('crypto')) {
        offenders.push(file.startsWith(SRC_DIR) ? file.slice(SRC_DIR.length + 1) : file)
      }
    }

    expect(
      offenders.length,
      `Expected zero files under src/ to import bare 'crypto', found: ${offenders.join(', ')}`
    ).to.equal(0)
  })

  it('D-02-b (positive control): networks-engine.ts still calls crypto.randomUUID() at both surviving call sites', () => {
    const file = join(SRC_DIR, 'networks', 'networks-engine.ts')
    const stripped = stripComments(readFileSync(file, 'utf8'))
    const matches = stripped.match(/crypto\.randomUUID\(\)/g) ?? []
    expect(
      matches.length,
      `Expected exactly 2 occurrences of crypto.randomUUID() in networks-engine.ts, found ${matches.length} — the D-02 crypto-import deletion must remove only the dead import, not a call site`
    ).to.equal(2)
  })
})
