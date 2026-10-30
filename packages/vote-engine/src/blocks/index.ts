// blocks/index.ts — phase 65 plan 05 (D-50/D-51/D-52).
//
// Role:
//   - Publishes the R5 block Merkle tree for the Voter, the Authority and the dashboard. The R6-R8 names
//     (slice checks, block validation, tally tree) are added by 65-09.
//
// Rules:
//   - Named exports only, never export-star, so a later addition to a module file cannot silently widen
//     the surface.
//   - Browser and rn-entry exposure is decided in 65-09 (D-52), not here.
export {
  BLOCK_TREE_DOMAIN,
  BLOCK_TREE_EMPTY_ROOT,
  blockLeafData,
  blockLeafHash,
  blockNodeHash,
  buildBlockTree,
  verifyInclusion,
  blockTreeStatus,
  finalBlockTree
} from './block-tree.js'
export type {
  BlockTreeRow,
  BlockTreeScope,
  BlockTreeLeaf,
  BlockTreeNode,
  BlockProofStep,
  BlockInclusionProof,
  BlockProofResult,
  BlockTree,
  BlockTreeRefusal,
  BlockTreeResult,
  InclusionCheck,
  BlockTreeTimeline,
  BlockTreeStatus,
  FinalBlockTreeResult
} from './block-tree.js'
