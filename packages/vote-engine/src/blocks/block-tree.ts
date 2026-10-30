// block-tree.ts — R5 (D-50, D-51): the Merkle tree over one election revision's committed VoteBlock rows.
//
// Role:
//   - A pure, deterministic function from the committed VoteBlock rows of one (election, revision) to a
//     tree whose root anyone can recompute to the same value, whatever order the rows arrive in. It also
//     yields inclusion proofs (for the Voter's slice check, R6) and the full node table (for the tally
//     tree, R8).
//
// Format contract (third parties must be able to reproduce this byte for byte):
//   - Leaf data: canonicalJson([ElectionId, ElectionRevision, BallotId, Id, Cid, EntryCount]), with both
//     integers as plain numbers.
//   - Leaf hash: sha256(0x00 || utf8(leafData)).  Node hash: sha256(0x01 || leftHash || rightHash).
//   - Leaf order: ascending by the UTF-8 bytes of Cid (a shorter prefix sorts first).
//   - Shape: RFC 6962. A range of width n > 1 splits at the largest power of two strictly below n; a lone
//     node is carried up and NEVER duplicated.
//   - Empty set: the root is sha256(utf8('vt-block-tree/1/empty')). One leaf: the root is its own hash.
//   - Final gate: a FINAL root is produced only once nowMs >= timeline.hashingVotes.
//
// Rules:
//   - Results are typed unions; nothing here reports failure by throwing.
//   - Pure: no clock (nowMs is a parameter), no randomness, no Node-only globals, no logging. Imports are
//     limited to the noble hash helpers and ../voting/canonical.js so this file stays inside the browser
//     entry allowlist (D-52).

import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js'
import { canonicalJson } from '../voting/canonical.js'

export const BLOCK_TREE_DOMAIN = 'vt-block-tree/1' as const

/** Root of the empty set (no committed blocks). */
export const BLOCK_TREE_EMPTY_ROOT: string = bytesToHex(sha256(utf8ToBytes(`${BLOCK_TREE_DOMAIN}/empty`)))

/** Structural subset of a VoteBlock row; other columns (TemplateDigest, VoterRegistrantIds, Ciphertext) are ignored. */
export interface BlockTreeRow {
  Cid: string
  Id: string
  ElectionId: string
  ElectionRevision: number | bigint
  BallotId: string
  EntryCount: number | bigint
}

export interface BlockTreeScope { electionId: string, electionRevision: number }

export interface BlockTreeLeaf {
  /** Position after canonical ordering. */
  index: number
  cid: string
  blockId: string
  ballotId: string
  /** Normalised safe integer. */
  entryCount: number
  leafData: string
  hash: string
}

export interface BlockTreeNode {
  /** Position in BlockTree.nodes (post-order: children before parent). */
  index: number
  hash: string
  /** Leaf index range [lo, hi); a leaf node has hi - lo === 1. */
  range: readonly [number, number]
  left?: number
  right?: number
}

/** side = where the SIBLING sits relative to the running hash. */
export interface BlockProofStep { side: 'left' | 'right', hash: string }

export interface BlockInclusionProof {
  leafIndex: number
  treeSize: number
  /** Leaf-to-root order. */
  path: readonly BlockProofStep[]
}

export type BlockProofResult = { ok: true, proof: BlockInclusionProof } | { ok: false, reason: 'unknown-block' }

export interface BlockTree {
  electionId: string
  electionRevision: number
  root: string
  size: number
  /** Ascending by UTF-8 bytes of Cid. */
  leaves: readonly BlockTreeLeaf[]
  /** 2*size-1 entries, root last; empty when size === 0. */
  nodes: readonly BlockTreeNode[]
  proofFor: (cid: string) => BlockProofResult
}

export type BlockTreeRefusal = 'malformed-row' | 'duplicate-block' | 'mixed-election' | 'mixed-revision'
export type BlockTreeResult = { ok: true, tree: BlockTree } | { ok: false, reason: BlockTreeRefusal, detail: string }
export type InclusionCheck = { ok: true } | { ok: false, reason: 'malformed-proof' | 'root-mismatch' }

/** Structural; an Election.timeline fits. */
export interface BlockTreeTimeline { accruingVotes: number, hashingVotes: number }

export type BlockTreeStatus =
  | { ok: true, final: true }
  | { ok: false, reason: 'accruing-not-ended', finalAtMs: number }
  | { ok: false, reason: 'timeline-invalid' | 'clock-invalid' }

export type FinalBlockTreeResult =
  | { ok: true, final: true, tree: BlockTree }
  | { ok: false, reason: 'accruing-not-ended', finalAtMs: number, provisional: BlockTree }
  | { ok: false, reason: 'timeline-invalid' | 'clock-invalid' }
  | { ok: false, reason: BlockTreeRefusal, detail: string }

const HEX64 = /^[0-9a-f]{64}$/

function compareUtf8 (a: string, b: string): number {
  const x = utf8ToBytes(a)
  const y = utf8ToBytes(b)
  const n = Math.min(x.length, y.length)
  for (let i = 0; i < n; i++) {
    const d = x[i]! - y[i]!
    if (d !== 0) return d
  }
  return x.length - y.length
}

/** Largest power of two strictly below n (n >= 2). */
function splitPoint (n: number): number {
  let k = 1
  while (k * 2 < n) k *= 2
  return k
}

/**
 * The A6 format contract: the exact string a block's leaf hash is taken over. Both integers are
 * normalised to plain numbers first, because a Quereus row read may surface a bigint and JSON cannot
 * carry one.
 */
export function blockLeafData (row: BlockTreeRow): string {
  return canonicalJson([row.ElectionId, Number(row.ElectionRevision), row.BallotId, row.Id, row.Cid, Number(row.EntryCount)])
}

/** hex(sha256(0x00 || utf8(leafData))). */
export function blockLeafHash (leafData: string): string {
  return bytesToHex(sha256(concatBytes(Uint8Array.of(0x00), utf8ToBytes(leafData))))
}

/** hex(sha256(0x01 || left || right)). */
export function blockNodeHash (leftHex: string, rightHex: string): string {
  return bytesToHex(sha256(concatBytes(Uint8Array.of(0x01), hexToBytes(leftHex), hexToBytes(rightHex))))
}

function intField (value: unknown, min: number): number | undefined {
  if (typeof value === 'bigint') {
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) return undefined
    value = Number(value)
  }
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) return undefined
  return value
}

interface NormalRow { cid: string, id: string, ballotId: string, entryCount: number }

type RowCheck = { ok: true, row: NormalRow } | { ok: false, reason: BlockTreeRefusal, detail: string }

function normaliseRow (raw: unknown, position: number, scope: BlockTreeScope): RowCheck {
  const bad = (detail: string): RowCheck => ({ ok: false, reason: 'malformed-row', detail: `row ${position}: ${detail}` })
  if (raw === null || typeof raw !== 'object') return bad('not an object')
  const r = raw as Record<string, unknown>
  for (const field of ['Cid', 'Id', 'ElectionId', 'BallotId']) {
    if (typeof r[field] !== 'string' || r[field] === '') return bad(`${field} must be a non-empty string`)
  }
  const revision = intField(r.ElectionRevision, 0)
  if (revision === undefined) return bad('ElectionRevision must be a non-negative safe integer')
  const entryCount = intField(r.EntryCount, 1)
  if (entryCount === undefined) return bad('EntryCount must be a safe integer >= 1')
  if (r.ElectionId !== scope.electionId) {
    return { ok: false, reason: 'mixed-election', detail: `row ${position}: ElectionId ${String(r.ElectionId)} is not ${scope.electionId}` }
  }
  if (revision !== scope.electionRevision) {
    return { ok: false, reason: 'mixed-revision', detail: `row ${position}: ElectionRevision ${revision} is not ${scope.electionRevision}` }
  }
  return { ok: true, row: { cid: r.Cid as string, id: r.Id as string, ballotId: r.BallotId as string, entryCount } }
}

/**
 * Build the block tree for one election revision. The rows may arrive in any order; the result does not
 * depend on it. Malformed input, a duplicate Cid or Id, and rows from another election or revision are
 * refused with a typed reason.
 */
export function buildBlockTree (rows: readonly BlockTreeRow[], scope: BlockTreeScope): BlockTreeResult {
  if (!Array.isArray(rows)) return { ok: false, reason: 'malformed-row', detail: 'rows must be an array' }
  const normal: NormalRow[] = []
  const cids = new Set<string>()
  const ids = new Set<string>()
  for (let i = 0; i < rows.length; i++) {
    const checked = normaliseRow(rows[i], i, scope)
    if (!checked.ok) return checked
    const row = checked.row
    if (cids.has(row.cid)) return { ok: false, reason: 'duplicate-block', detail: `Cid ${row.cid} appears twice` }
    if (ids.has(row.id)) return { ok: false, reason: 'duplicate-block', detail: `Id ${row.id} appears twice` }
    cids.add(row.cid)
    ids.add(row.id)
    normal.push(row)
  }
  normal.sort((a, b) => compareUtf8(a.cid, b.cid))

  const leaves: BlockTreeLeaf[] = normal.map((row, index) => {
    const leafData = blockLeafData({
      Cid: row.cid, Id: row.id, ElectionId: scope.electionId, ElectionRevision: scope.electionRevision, BallotId: row.ballotId, EntryCount: row.entryCount
    })
    return { index, cid: row.cid, blockId: row.id, ballotId: row.ballotId, entryCount: row.entryCount, leafData, hash: blockLeafHash(leafData) }
  })

  const nodes: BlockTreeNode[] = []
  const nodeAt = new Map<string, number>()
  const buildRange = (lo: number, hi: number): number => {
    let entry: BlockTreeNode
    if (hi - lo === 1) {
      entry = { index: nodes.length, hash: leaves[lo]!.hash, range: [lo, hi] }
    } else {
      const k = splitPoint(hi - lo)
      const left = buildRange(lo, lo + k)
      const right = buildRange(lo + k, hi)
      entry = { index: nodes.length, hash: blockNodeHash(nodes[left]!.hash, nodes[right]!.hash), range: [lo, hi], left, right }
    }
    nodes.push(entry)
    nodeAt.set(`${lo}:${hi}`, entry.index)
    return entry.index
  }
  if (leaves.length > 0) buildRange(0, leaves.length)

  const size = leaves.length
  const root = size === 0 ? BLOCK_TREE_EMPTY_ROOT : nodes[nodes.length - 1]!.hash
  const leafIndexOf = new Map(leaves.map(l => [l.cid, l.index]))

  const proofFor = (cid: string): BlockProofResult => {
    const leafIndex = leafIndexOf.get(cid)
    if (leafIndex === undefined) return { ok: false, reason: 'unknown-block' }
    const rootDown: BlockProofStep[] = []
    let lo = 0
    let hi = size
    while (hi - lo > 1) {
      const k = splitPoint(hi - lo)
      const mid = lo + k
      if (leafIndex < mid) {
        rootDown.push({ side: 'right', hash: nodes[nodeAt.get(`${mid}:${hi}`)!]!.hash })
        hi = mid
      } else {
        rootDown.push({ side: 'left', hash: nodes[nodeAt.get(`${lo}:${mid}`)!]!.hash })
        lo = mid
      }
    }
    return { ok: true, proof: { leafIndex, treeSize: size, path: rootDown.reverse() } }
  }

  return { ok: true, tree: { electionId: scope.electionId, electionRevision: scope.electionRevision, root, size, leaves, nodes, proofFor } }
}

/** Sibling sides, leaf-to-root, that a leaf at `index` in a tree of `size` leaves must have. */
function expectedSides (index: number, size: number): Array<'left' | 'right'> {
  const rootDown: Array<'left' | 'right'> = []
  let lo = 0
  let hi = size
  while (hi - lo > 1) {
    const mid = lo + splitPoint(hi - lo)
    if (index < mid) { rootDown.push('right'); hi = mid } else { rootDown.push('left'); lo = mid }
  }
  return rootDown.reverse()
}

/**
 * Check an inclusion proof against a root. Position and tree size are bound: the side sequence is derived
 * from (leafIndex, treeSize) and must match the path exactly, so an internal node cannot pose as a leaf.
 * The caller recomputes `leafHash` from its own row (blockLeafHash(blockLeafData(row))), never from the proof.
 * Never throws.
 */
export function verifyInclusion (leafHash: string, proof: BlockInclusionProof, root: string): InclusionCheck {
  const malformed: InclusionCheck = { ok: false, reason: 'malformed-proof' }
  if (typeof leafHash !== 'string' || !HEX64.test(leafHash)) return malformed
  if (typeof root !== 'string' || !HEX64.test(root)) return malformed
  if (proof === null || typeof proof !== 'object') return malformed
  const { leafIndex, treeSize, path } = proof
  if (!Number.isSafeInteger(leafIndex) || !Number.isSafeInteger(treeSize)) return malformed
  if (leafIndex < 0 || leafIndex >= treeSize) return malformed
  if (!Array.isArray(path)) return malformed
  const sides = expectedSides(leafIndex, treeSize)
  if (path.length !== sides.length) return malformed
  for (let i = 0; i < path.length; i++) {
    const step = path[i] as BlockProofStep | null | undefined
    if (step === null || step === undefined || typeof step !== 'object') return malformed
    if (step.side !== sides[i]) return malformed
    if (typeof step.hash !== 'string' || !HEX64.test(step.hash)) return malformed
  }
  let h = leafHash
  for (const step of path) {
    h = step.side === 'left' ? blockNodeHash(step.hash, h) : blockNodeHash(h, step.hash)
  }
  return h === root ? { ok: true } : { ok: false, reason: 'root-mismatch' }
}

/**
 * D-51: the accruing period is [accruingVotes, hashingVotes), so it ends at hashingVotes (research A5). A
 * FINAL root is allowed only once nowMs >= hashingVotes. This is a computation gate and NOT a security
 * boundary: the caller chooses nowMs (spike 101 signal 2).
 */
export function blockTreeStatus (timeline: BlockTreeTimeline, nowMs: number): BlockTreeStatus {
  if (typeof nowMs !== 'number' || !Number.isFinite(nowMs)) return { ok: false, reason: 'clock-invalid' }
  if (timeline === null || typeof timeline !== 'object') return { ok: false, reason: 'timeline-invalid' }
  const { accruingVotes, hashingVotes } = timeline
  if (typeof accruingVotes !== 'number' || typeof hashingVotes !== 'number' ||
    !Number.isFinite(accruingVotes) || !Number.isFinite(hashingVotes) || hashingVotes < accruingVotes) {
    return { ok: false, reason: 'timeline-invalid' }
  }
  if (nowMs < hashingVotes) return { ok: false, reason: 'accruing-not-ended', finalAtMs: hashingVotes }
  return { ok: true, final: true }
}

/**
 * The tree, labelled final or provisional by blockTreeStatus. Before the end of the accruing period the
 * refusal still carries the provisional tree. Who stores or publishes the root is out of scope (D-51).
 */
export function finalBlockTree (rows: readonly BlockTreeRow[], scope: BlockTreeScope, timeline: BlockTreeTimeline, nowMs: number): FinalBlockTreeResult {
  const status = blockTreeStatus(timeline, nowMs)
  if (!status.ok && (status.reason === 'timeline-invalid' || status.reason === 'clock-invalid')) return status
  const built = buildBlockTree(rows, scope)
  if (!built.ok) return built
  if (!status.ok && status.reason === 'accruing-not-ended') {
    return { ok: false, reason: 'accruing-not-ended', finalAtMs: status.finalAtMs, provisional: built.tree }
  }
  return { ok: true, final: true, tree: built.tree }
}
