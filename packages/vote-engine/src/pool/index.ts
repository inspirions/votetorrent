// pool/index.ts — vote pools (spike 102): voters negotiate one block per pool through the
// authority's rendezvous, with every vote encrypted to the election key before it leaves the phone.
// Named exports only. See pool-agent.ts's header for the rules and the decisions behind them.
export { PoolAgent, POOL_MIN_BLOCK_SIZE } from './pool-agent.js'
export type { PoolAgentOptions, PoolAgentStatus, PoolOutcome } from './pool-agent.js'
export {
  poolTopic,
  poolBlockId,
  poolBlockCid,
  consentDigest,
  formPoolBlock,
  checkFormedPoolBlock,
  commitPoolBlock
} from './pool-block.js'
export type { PoolContribution, PoolBallot, FormedPoolBlock, ConsentSignature, PoolBlockCheck } from './pool-block.js'
export {
  sealPoolEnvelope,
  openPoolEnvelope,
  poolIdentityFromRawKey,
  createPoolIdentity,
  signPoolRequest,
  verifyPoolRequest,
  ed25519PublicKeyFromPeerId,
  peerIdFromEd25519PublicKey,
  PoolEnvelopeError,
  POOL_ENVELOPE_MAX_SKEW_MS,
  POOL_REQUEST_MAX_SKEW_MS
} from './pool-envelope.js'
export type { SealedPoolEnvelope, OpenedPoolEnvelope, PoolIdentity } from './pool-envelope.js'
export { PoolRendezvous, createInMemoryRendezvousClient, poolRequests, signedFields } from './pool-rendezvous.js'
export type { PoolRendezvousClient, PoolRendezvousOptions, CoordinatorListing, RendezvousRequest, RendezvousReply } from './pool-rendezvous.js'
export { POOL_RENDEZVOUS_PROTOCOL, attachPoolRendezvous, createLibp2pRendezvousClient } from './pool-wire.js'
