// block-tree.ts — R5 (D-50, D-51): the Merkle tree over one election revision's committed VoteBlock rows.
//
// Role:
//   - A pure, deterministic function from the committed VoteBlock rows of one (election, revision) to a
//     tree whose root anyone can recompute to the same value, whatever order the rows arrive in. It also
//     yields inclusion proofs (for the Voter's slice check, R6) and the full node table (for the tally
//     tree, R8).
//
// Format contract (third parties must be able to reproduce this byte for byte):
//   - Leaf data: canonicalJson([ElectionId, ElectionRevision, BallotId, Id, Cid, EntryCount, TemplateDigest,
//     voterListDigest]), with both integers as plain numbers, TemplateDigest exactly as stored, and
//     voterListDigest = hex(sha256(utf8(VoterRegistrantIds))) over the stored JSON text. The root so binds the
//     block's frozen voter list and its template column, which no other hash covers (the Cid covers only the
//     ciphertext). The list enters as a digest because the leaf data is published inside the tally tree and
//     must not carry registrant ids.
//   - Leaf hash: sha256(0x00 || utf8(leafData)).  Node hash: sha256(0x01 || leftHash || rightHash).
//   - Leaf order: ascending by the UTF-8 bytes of Cid (a shorter prefix sorts first). A Cid must be a base32
//     CID ('b' then a-z, 2-7), so that order is total.
//   - Shape: RFC 6962. A range of width n > 1 splits at the largest power of two strictly below n; a lone
//     node is carried up and NEVER duplicated.
//   - Empty set: the root is sha256(utf8('vt-block-tree/1/empty')). One leaf: the root is its own hash.
//   - Final gate: a FINAL root is produced only once nowMs >= timeline.hashingVotes.
//
// Row policy (WR-06, TOLERANT, shared with R7 through selectBlockRows): one bad row never refuses the tree.
//   - A row that is not shaped like a block is set aside as `malformed-row` in `rejected`.
//   - Rows sharing a Cid or an Id are reduced to one: the preferred row is the one whose Cid is the digest of
//     its own Ciphertext (blockCidOf, the integrity check R7 runs without the key), then the one with the lowest
//     UTF-8 bytes of canonicalJson([Cid, Id, BallotId, EntryCount, TemplateDigest, VoterRegistrantIds,
//     Ciphertext]). Rows are taken greedily in that order; a row whose Cid or Id is already taken goes to
//     `rejected` as `duplicate-block`. The Id check of R7 needs the key, so it cannot rank rows here.
//   - Only a row of another election or revision refuses the whole tree (`mixed-election`, `mixed-revision`):
//     that is a caller error (rows are selected per election revision), and R7 refuses it the same way.
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

/** Structural subset of a VoteBlock row; other columns are ignored. */
export interface BlockTreeRow {
  /** optional here: used only to rank rows that share a Cid or an Id (blockCidOf) */
  Ciphertext?: string
  Cid: string
  Id: string
  ElectionId: string
  ElectionRevision: number | bigint
  BallotId: string
  EntryCount: number | bigint
  TemplateDigest: string
  /** the stored JSON text of the sorted registrant ids; the leaf binds its sha256 (voterListDigest) */
  VoterRegistrantIds: string
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
  /** rows set aside (WR-06), ascending by UTF-8 bytes of cid then detail; they have no leaf */
  rejected: readonly BlockTreeRejection[]
  proofFor: (cid: string) => BlockProofResult
}

export type BlockTreeRejectReason = 'malformed-row' | 'duplicate-block'

/** A row that has no leaf. No position: the result does not depend on input order. */
export interface BlockTreeRejection {
  /** the row's Cid when it is a string, else '' */
  cid: string
  reason: BlockTreeRejectReason
  detail: string
}

/** The rows selectBlockRows keeps (leaf order) and sets aside; `row` is the caller's own object. */
export type BlockRowSelection<R> =
  | { ok: true, accepted: readonly R[], rejected: ReadonlyArray<BlockTreeRejection & { row: unknown }> }
  | { ok: false, reason: BlockTreeRefusal, detail: string }

/** Whole-tree refusals: `malformed-row` only when `rows` is not an array. `duplicate-block` is kept for type compatibility and no longer returned. */
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

/**
 * IN-05: a VoteBlock Cid is a CIDv1 in multibase base32 (prefix 'b', RFC 4648 lowercase alphabet, no
 * padding), the form `cid(Digest(Ciphertext))` produces. Only this character set is accepted, so the UTF-8
 * byte order of leaves is a total order: distinct strings never encode to equal bytes (a lone surrogate
 * would encode to U+FFFD).
 */
const BASE32_CID = /^b[a-z2-7]+$/

/** Is `cid` shaped like a base32 CIDv1 string (character set only)? */
export function isBase32Cid (cid: unknown): cid is string {
  return typeof cid === 'string' && BASE32_CID.test(cid)
}

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
 * carry one. The voter list enters as voterListDigest, never as registrant ids.
 */
export function blockLeafData (row: BlockTreeRow): string {
  return canonicalJson([
    row.ElectionId, Number(row.ElectionRevision), row.BallotId, row.Id, row.Cid, Number(row.EntryCount),
    row.TemplateDigest, voterListDigest(row.VoterRegistrantIds)
  ])
}

/** hex(sha256(utf8(VoterRegistrantIds))): the leaf's commitment to the stored voter list text. */
export function voterListDigest (voterRegistrantIds: string): string {
  return bytesToHex(sha256(utf8ToBytes(voterRegistrantIds)))
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

interface NormalRow { cid: string, id: string, ballotId: string, entryCount: number, templateDigest: string, voterRegistrantIds: string }

type RowCheck =
  | { ok: true, row: NormalRow }
  | { ok: false, reason: 'malformed-row', detail: string }
  | { ok: false, reason: 'mixed-election' | 'mixed-revision', detail: string }

const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567'

/** RFC 4648 base32, lowercase, no padding. */
function base32Lower (bytes: Uint8Array): string {
  let out = ''
  let bits = 0
  let value = 0
  for (const b of bytes) {
    value = (value << 8) | b
    bits += 8
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
    value &= (1 << bits) - 1
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31]
  return out
}

/**
 * The Cid a VoteBlock row must carry for this ciphertext: the noble-only twin of SQL `cid(Digest(Ciphertext))`
 * and of pool-block's poolBlockCid (block-tree.spec pins the parity). Digest frames one text field as
 * [0x01 format][0x03 text tag][varint length][UTF-8 bytes] and hashes it with SHA-256; `cid` then hashes those
 * 32 bytes again and wraps them as CIDv1 (0x01), codec raw (0x55), multihash sha2-256 (0x12, 0x20), printed in
 * multibase base32 ('b'). Never throws for a string.
 */
export function blockCidOf (ciphertext: string): string {
  const text = utf8ToBytes(ciphertext)
  const header: number[] = [0x01, 0x03]
  let n = text.length
  while (n >= 128) { header.push((n & 127) | 128); n = Math.floor(n / 128) }
  header.push(n)
  const digest = sha256(concatBytes(Uint8Array.from(header), text))
  return `b${base32Lower(concatBytes(Uint8Array.of(0x01, 0x55, 0x12, 0x20), sha256(digest)))}`
}

/** Scope first (so a foreign row refuses even when it is also malformed, as in R7), then shape. */
function normaliseRow (raw: unknown, position: number, scope: BlockTreeScope): RowCheck {
  const bad = (detail: string): RowCheck => ({ ok: false, reason: 'malformed-row', detail })
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return bad('the row is not an object')
  const r = raw as Record<string, unknown>
  if (typeof r.ElectionId === 'string' && r.ElectionId !== scope.electionId) {
    return { ok: false, reason: 'mixed-election', detail: `row ${position}: ElectionId ${r.ElectionId} is not ${scope.electionId}` }
  }
  const scopeRevision = intField(r.ElectionRevision, 0)
  if (scopeRevision !== undefined && scopeRevision !== scope.electionRevision) {
    return { ok: false, reason: 'mixed-revision', detail: `row ${position}: ElectionRevision ${scopeRevision} is not ${scope.electionRevision}` }
  }
  for (const field of ['Cid', 'Id', 'ElectionId', 'BallotId']) {
    if (typeof r[field] !== 'string' || r[field] === '') return bad(`${field} must be a non-empty string`)
  }
  for (const field of ['TemplateDigest', 'VoterRegistrantIds']) {
    if (typeof r[field] !== 'string') return bad(`${field} must be a string`)
  }
  if (!isBase32Cid(r.Cid)) return bad('Cid must be a base32 CID (b followed by a-z and 2-7)')
  const revision = intField(r.ElectionRevision, 0)
  if (revision === undefined) return bad('ElectionRevision must be a non-negative safe integer')
  const entryCount = intField(r.EntryCount, 1)
  if (entryCount === undefined) return bad('EntryCount must be a safe integer >= 1')
  return {
    ok: true,
    row: {
      cid: r.Cid as string, id: r.Id as string, ballotId: r.BallotId as string, entryCount,
      templateDigest: r.TemplateDigest as string, voterRegistrantIds: r.VoterRegistrantIds as string
    }
  }
}

/** A stable text key of an unreadable or malformed row, safe for bigint and odd values; only orders rejections. */
function looseKey (row: unknown): string {
  if (row === null || typeof row !== 'object') return `<${row === null ? 'null' : typeof row}>`
  try {
    return Object.keys(row).sort().map(k => {
      const v = (row as Record<string, unknown>)[k]
      return `${k}=${typeof v === 'string' ? JSON.stringify(v) : `${typeof v}:${String(v)}`}`
    }).join('|')
  } catch {
    return '<unreadable>'
  }
}

interface Candidate { raw: unknown, row: NormalRow, cidOk: boolean, rank: string }

/**
 * WR-06: the row policy shared by R5 and R7. Keeps every well-formed row whose Cid and Id are unique after the
 * preference rule (see the header), in leaf order, and returns every other row in `rejected` with a typed reason.
 * Refuses only a non-array input (`malformed-row`) and a row of another election or revision. The outcome does
 * not depend on input order. Never throws.
 */
export function selectBlockRows<R> (rows: readonly R[], scope: BlockTreeScope): BlockRowSelection<R> {
  if (!Array.isArray(rows)) return { ok: false, reason: 'malformed-row', detail: 'rows must be an array' }
  const candidates: Candidate[] = []
  const rejected: Array<BlockTreeRejection & { row: unknown, key: string }> = []
  for (let i = 0; i < rows.length; i++) {
    const raw: unknown = rows[i]
    const checked = normaliseRow(raw, i, scope)
    if (!checked.ok) {
      if (checked.reason !== 'malformed-row') return checked
      const cid = raw !== null && typeof raw === 'object' && typeof (raw as Record<string, unknown>).Cid === 'string' ? (raw as Record<string, unknown>).Cid as string : ''
      rejected.push({ cid, reason: 'malformed-row', detail: checked.detail, row: raw, key: looseKey(raw) })
      continue
    }
    const ct = (raw as Record<string, unknown>).Ciphertext
    const row = checked.row
    const cidOk = typeof ct === 'string' && blockCidOf(ct) === row.cid
    const rank = canonicalJson([row.cid, row.id, row.ballotId, row.entryCount, row.templateDigest, row.voterRegistrantIds, typeof ct === 'string' ? ct : null])
    candidates.push({ raw, row, cidOk, rank })
  }
  // UTF-8 bytes first; code units break the tie two distinct lone surrogates would leave, so the order is total
  const byRank = (a: string, b: string): number => compareUtf8(a, b) || (a < b ? -1 : a > b ? 1 : 0)
  candidates.sort((a, b) => (a.cidOk === b.cidOk ? byRank(a.rank, b.rank) : a.cidOk ? -1 : 1))
  const cids = new Set<string>()
  const ids = new Set<string>()
  const kept: Candidate[] = []
  for (const c of candidates) {
    const taken = cids.has(c.row.cid) ? `Cid ${c.row.cid}` : ids.has(c.row.id) ? `Id ${c.row.id}` : null
    if (taken !== null) {
      rejected.push({ cid: c.row.cid, reason: 'duplicate-block', detail: `${taken} is already taken by a preferred row`, row: c.raw, key: c.rank })
      continue
    }
    cids.add(c.row.cid)
    ids.add(c.row.id)
    kept.push(c)
  }
  kept.sort((a, b) => compareUtf8(a.row.cid, b.row.cid))
  rejected.sort((a, b) => byRank(a.cid, b.cid) || byRank(a.detail, b.detail) || byRank(a.key, b.key))
  return {
    ok: true,
    accepted: kept.map(c => c.raw as R),
    rejected: rejected.map(({ cid, reason, detail, row }) => ({ cid, reason, detail, row }))
  }
}

/**
 * Build the block tree for one election revision. The rows may arrive in any order; the result does not
 * depend on it. Rows are selected by selectBlockRows (WR-06): malformed rows and the non-preferred rows of a
 * shared Cid or Id are set aside in `tree.rejected` and the tree is built over the rest. Only rows from another
 * election or revision, or a non-array input, refuse the whole tree.
 */
export function buildBlockTree (rows: readonly BlockTreeRow[], scope: BlockTreeScope): BlockTreeResult {
  const selected = selectBlockRows(rows, scope)
  if (!selected.ok) return selected
  const normal: NormalRow[] = []
  for (let i = 0; i < selected.accepted.length; i++) {
    const checked = normaliseRow(selected.accepted[i], i, scope)
    if (checked.ok) normal.push(checked.row)
  }
  const rejected: BlockTreeRejection[] = selected.rejected.map(({ cid, reason, detail }) => ({ cid, reason, detail }))

  const leaves: BlockTreeLeaf[] = normal.map((row, index) => {
    const leafData = blockLeafData({
      Cid: row.cid, Id: row.id, ElectionId: scope.electionId, ElectionRevision: scope.electionRevision, BallotId: row.ballotId,
      EntryCount: row.entryCount, TemplateDigest: row.templateDigest, VoterRegistrantIds: row.voterRegistrantIds
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

  return { ok: true, tree: { electionId: scope.electionId, electionRevision: scope.electionRevision, root, size, leaves, nodes, rejected, proofFor } }
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
