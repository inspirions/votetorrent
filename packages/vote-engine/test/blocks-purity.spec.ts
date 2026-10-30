/**
 * blocks-purity.spec.ts — Phase 65 Plan 05 (D-50..D-52; R5-R8 purity)
 *
 * Gates for `src/blocks/*`, cloned from voting-purity.spec.ts:
 *   VP-0 — the scan list is built from readdir (so files 65-06/07/08 add later are scanned
 *          automatically) and is not vacuous.
 *   P-1a — every bare specifier is allowlisted (voting's five plus @votetorrent/vote-core, which P-1c
 *          restricts to type imports). The list is wide enough for the R6-R8 modules that land here, so
 *          those plans do not need to edit this spec.
 *   P-1b — every relative specifier is ./<name>.js resolving to an existing src/blocks file, or one of
 *          ALLOWED_RELATIVE (all already in the rn-entry graph, Hermes-proven).
 *   P-1c — @votetorrent/vote-core appears only in `import type`.
 *   P-1d — D-52 browser readiness: block-tree.ts reaches only the browser allowlist.
 *   P-2  — no forbidden token (node:, console., TextDecoder, TextEncoder, Date.now, Math.random, the
 *          byte-buffer identifier) in comment-stripped src/blocks.
 *   P-3a — blocks/index.ts has no export-star and exactly the R5 contract names.
 *   P-3c — src/index.ts carries exactly one export-star of the blocks barrel.
 *   P-4  — runtime surface of the barrel.
 *   P-5  — positive controls proving each scanner can fire.
 *
 * Added by 65-09, which owns this file in W5: P-3b (rn-entry parity) and the browser-entry check.
 */

import { expect } from 'chai'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as blocks from '../src/blocks/index.js'

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')
const BLOCKS_DIR = join(SRC_DIR, 'blocks')

function stripComments (src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
}

function extractFromSpecifiers (strippedSrc: string): string[] {
  const specifiers: string[] = []
  for (const match of strippedSrc.matchAll(/\bfrom\s*['"]([^'"]+)['"]/g)) {
    specifiers.push(match[1]!)
  }
  return specifiers
}

// Built with a join so this spec cannot trip its own scanner.
const bufferIdentifier = ['B', 'uffer'].join('')

function scanTokens (stripped: string): string[] {
  const hits: string[] = []
  if (/node:/.test(stripped)) hits.push('node:')
  if (/console\./.test(stripped)) hits.push('console.')
  if (/TextDecoder/.test(stripped)) hits.push('TextDecoder')
  if (/TextEncoder/.test(stripped)) hits.push('TextEncoder')
  if (/Date\.now/.test(stripped)) hits.push('Date.now')
  if (/Math\.random/.test(stripped)) hits.push('Math.random')
  if (new RegExp(`\\b${bufferIdentifier}\\b`).test(stripped)) hits.push(bufferIdentifier)
  return hits
}

function blocksSourceFiles (): string[] {
  return readdirSync(BLOCKS_DIR).filter((f) => f.endsWith('.ts')).sort()
}

function readBlocks (name: string): string {
  return stripComments(readFileSync(join(BLOCKS_DIR, name), 'utf8'))
}

/** Collect identifiers inside `export {...}` / `export type {...}` braces, optionally for one `from`. */
function parseNamedExports (stripped: string, fromSpecifier?: string): string[] {
  const names: string[] = []
  for (const match of stripped.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g)) {
    if (fromSpecifier !== undefined && match[2] !== fromSpecifier) continue
    for (const part of match[1]!.split(',')) {
      const name = part.trim()
      if (name !== '') names.push(name)
    }
  }
  return names.sort()
}

const ALLOWED_BARE_SPECIFIERS = [
  '@optimystic/quereus-plugin-crypto',
  '@noble/hashes/sha2.js',
  '@noble/hashes/utils.js',
  '@noble/curves/nist.js',
  '@noble/curves/utils.js',
  // Restricted to `import type` by P-1c.
  '@votetorrent/vote-core'
]

// Already in the rn-entry graph (Hermes-proven). What each serves for R6-R8:
//   ../voting/canonical.js        canonicalJson, sortByCanonicalBytes
//   ../voting/vote-entries.js     voterEntryDigest, ballotTemplateDigest
//   ../voting/index.js            the voting barrel (same names)
//   ../pool/pool-block.js         poolBlockId, poolBlockCid, consentDigest
//   ../key-release/election-block.js  openElectionBlock, openVoteEntries
//   ../database/initialize.js     verifySigP256
//   ../crypto/index.js            serializeBlockCiphertext
const ALLOWED_RELATIVE = [
  '../voting/canonical.js',
  '../voting/vote-entries.js',
  '../voting/index.js',
  '../pool/pool-block.js',
  '../key-release/election-block.js',
  '../database/initialize.js',
  '../crypto/index.js'
]

/** Returns the relative specifiers that are neither a sibling ./<name>.js that exists nor allowlisted. */
function badRelativeSpecifiers (specifiers: string[], siblingExists: (name: string) => boolean): string[] {
  return specifiers.filter((s) => {
    if (!s.startsWith('.')) return false
    if (ALLOWED_RELATIVE.includes(s)) return false
    const sibling = /^\.\/([A-Za-z0-9_-]+)\.js$/.exec(s)
    return !(sibling !== null && siblingExists(sibling[1]!))
  })
}

/** Value (non-`import type`) imports of vote-core. */
function voteCoreValueImports (stripped: string): string[] {
  const hits: string[] = []
  for (const match of stripped.matchAll(/import\s+(type\s+)?([^'";]*?)\s*from\s*['"]@votetorrent\/vote-core['"]/g)) {
    if (match[1] === undefined) hits.push(match[0])
  }
  return hits
}

const BLOCK_TREE_ALLOWED = ['@noble/hashes/sha2.js', '@noble/hashes/utils.js', '../voting/canonical.js']
const CANONICAL_ALLOWED = ['@noble/hashes/utils.js']

const CONTRACT_VALUES = [
  'BLOCK_TREE_DOMAIN', 'BLOCK_TREE_EMPTY_ROOT', 'blockLeafData', 'blockLeafHash', 'blockNodeHash',
  'buildBlockTree', 'verifyInclusion', 'blockTreeStatus', 'finalBlockTree'
]
const CONTRACT_TYPES = [
  'BlockTreeRow', 'BlockTreeScope', 'BlockTreeLeaf', 'BlockTreeNode', 'BlockProofStep', 'BlockInclusionProof',
  'BlockProofResult', 'BlockTree', 'BlockTreeRefusal', 'BlockTreeResult', 'InclusionCheck', 'BlockTreeTimeline',
  'BlockTreeStatus', 'FinalBlockTreeResult'
]
const CONTRACT_UNION = [...CONTRACT_VALUES, ...CONTRACT_TYPES].sort()

describe('blocks-purity (65-05: D-50..D-52)', () => {
  it('VP-0 the scan covers every blocks source file and none is empty', () => {
    const files = blocksSourceFiles()
    for (const f of ['block-tree.ts', 'index.ts']) expect(files, `missing ${f}`).to.include(f)
    for (const f of files) expect(readBlocks(f).trim().length, `${f} is empty`).to.be.greaterThan(0)
  })

  it('P-1a every bare specifier in src/blocks is allowlisted', () => {
    const violations: string[] = []
    for (const f of blocksSourceFiles()) {
      for (const s of extractFromSpecifiers(readBlocks(f))) {
        if (s.startsWith('.')) continue
        if (!ALLOWED_BARE_SPECIFIERS.includes(s)) violations.push(`${f}: ${s}`)
      }
    }
    expect(violations, violations.join('; ')).to.deep.equal([])
  })

  it('P-1b every relative specifier is a sibling or allowlisted', () => {
    const violations: string[] = []
    for (const f of blocksSourceFiles()) {
      for (const s of badRelativeSpecifiers(extractFromSpecifiers(readBlocks(f)), (n) => existsSync(join(BLOCKS_DIR, `${n}.ts`)))) {
        violations.push(`${f}: ${s}`)
      }
    }
    expect(violations, violations.join('; ')).to.deep.equal([])
  })

  it('P-1c @votetorrent/vote-core appears only in import type', () => {
    const violations: string[] = []
    for (const f of blocksSourceFiles()) {
      for (const hit of voteCoreValueImports(readBlocks(f))) violations.push(`${f}: ${hit}`)
    }
    expect(violations, violations.join('; ')).to.deep.equal([])
  })

  it('P-1d (D-52) block-tree.ts reaches only the browser-entry allowlist', () => {
    const tree = extractFromSpecifiers(readBlocks('block-tree.ts'))
    expect(tree.filter((s) => !BLOCK_TREE_ALLOWED.includes(s))).to.deep.equal([])
    const canonical = extractFromSpecifiers(stripComments(readFileSync(join(SRC_DIR, 'voting', 'canonical.ts'), 'utf8')))
    expect(canonical.filter((s) => !CANONICAL_ALLOWED.includes(s))).to.deep.equal([])
  })

  it('P-2 no forbidden token in comment-stripped src/blocks', () => {
    const violations: string[] = []
    for (const f of blocksSourceFiles()) {
      for (const t of scanTokens(readBlocks(f))) violations.push(`${f}: ${t}`)
    }
    expect(violations, violations.join('; ')).to.deep.equal([])
  })

  it('P-3a blocks/index.ts has no export-star and exactly the R5 contract names', () => {
    const stripped = readBlocks('index.ts')
    expect(/export\s*\*/.test(stripped)).to.equal(false)
    expect(parseNamedExports(stripped)).to.deep.equal(CONTRACT_UNION)
  })

  it('P-3c index.ts carries exactly one export-star of the blocks barrel', () => {
    const stripped = stripComments(readFileSync(join(SRC_DIR, 'index.ts'), 'utf8'))
    expect(stripped.split("export * from './blocks/index.js'").length - 1).to.equal(1)
  })

  it('P-4 runtime surface equals the R5 contract values', () => {
    const b = blocks as unknown as Record<string, unknown>
    expect(Object.keys(b).sort()).to.deep.equal([...CONTRACT_VALUES].sort())
    for (const n of CONTRACT_VALUES.filter((x) => !x.startsWith('BLOCK_TREE_'))) {
      expect(typeof b[n], n).to.equal('function')
    }
    expect(blocks.BLOCK_TREE_DOMAIN).to.equal('vt-block-tree/1')
    expect(blocks.BLOCK_TREE_EMPTY_ROOT).to.match(/^[0-9a-f]{64}$/)
  })

  describe('P-5 positive controls', () => {
    it('the specifier extractor reports node and vote-core imports; the P-1c checker flags the value import', () => {
      const src = "import { x } from 'node:crypto'\nimport { y } from '@votetorrent/vote-core'\nimport type { Z } from '@votetorrent/vote-core'\n"
      const stripped = stripComments(src)
      expect(extractFromSpecifiers(stripped)).to.include.members(['node:crypto', '@votetorrent/vote-core'])
      expect(ALLOWED_BARE_SPECIFIERS.includes('node:crypto')).to.equal(false)
      const hits = voteCoreValueImports(stripped)
      expect(hits).to.have.length(1)
      expect(hits[0]).to.contain('{ y }')
    })

    it('the token scan fires on code and stays silent inside both comment styles', () => {
      const lines = `console.log('x')\nconst b = new ${bufferIdentifier}()\nconst t = Date.now()\nconst r = Math.random()\n`
      expect(scanTokens(stripComments(lines))).to.include.members(['console.', bufferIdentifier, 'Date.now', 'Math.random'])
      expect(scanTokens(stripComments(lines.split('\n').map((l) => `// ${l}`).join('\n')))).to.deep.equal([])
      expect(scanTokens(stripComments(`/* ${lines} */`))).to.deep.equal([])
    })

    it('parseNamedExports on a barrel missing a name does not equal the contract', () => {
      const synthetic = "export { buildBlockTree } from './block-tree.js'\n"
      expect(parseNamedExports(synthetic)).to.not.deep.equal(CONTRACT_UNION)
    })

    it('the P-1b checker rejects a pool-agent import and accepts a real sibling', () => {
      const exists = (n: string): boolean => n === 'block-tree'
      expect(badRelativeSpecifiers(['../pool/pool-agent.js'], exists)).to.deep.equal(['../pool/pool-agent.js'])
      expect(badRelativeSpecifiers(['./block-tree.js', '../voting/canonical.js'], exists)).to.deep.equal([])
      expect(badRelativeSpecifiers(['./missing.js'], exists)).to.deep.equal(['./missing.js'])
    })
  })
})
