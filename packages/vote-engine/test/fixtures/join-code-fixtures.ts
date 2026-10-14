/**
 * join-code-fixtures.ts — phase 64 plan 04: real-encoder inputs for join-code tests.
 *
 * Test-only. Every invitation here is minted by cadre-core's real `encodeCadreInvitation`
 * from random keys that admit nobody to any network. Every random field has a FIXED
 * length, so the code lengths are deterministic.
 */
import { randomBytes, randomUUID, generateKeyPairSync } from 'node:crypto'
import { encodeCadreInvitation, type CadreInvitation } from '@serfab/cadre-core'
import type { NetworkJoinAnchor } from '@votetorrent/vote-core'
import { bytesToBase64url } from '../../src/utils.js'

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

/** A 52-char peer id, the length of a real Ed25519 libp2p peer id. */
export function randomPeerId (): string {
  const bytes = randomBytes(44)
  let s = '12D3KooW'
  for (let i = 0; i < 44; i++) s += BASE58[bytes[i]! % BASE58.length]
  return s
}

/** A real Ed25519 public key, 32 raw bytes as unpadded base64url (43 chars). */
export function randomEd25519KeyB64 (): string {
  const { publicKey } = generateKeyPairSync('ed25519')
  const der = publicKey.export({ format: 'der', type: 'spki' })
  return bytesToBase64url(new Uint8Array(der.subarray(der.length - 32)))
}

export function relayCircuitAddr (i: number): string {
  return `/ip4/192.168.1.${20 + i}/tcp/4001/ws/p2p/${randomPeerId()}/p2p-circuit/p2p/${randomPeerId()}`
}

const b64 = (n: number): string => bytesToBase64url(new Uint8Array(randomBytes(n)))

/** A cadre invitation in cadre-core's own mint key order. */
export function randomCadreInvitation (opts: { members: number }): CadreInvitation {
  const issuerKey = randomEd25519KeyB64()
  const members: string[] = []
  for (let i = 0; i < opts.members; i++) members.push(relayCircuitAddr(i))
  return {
    v: 1,
    partyId: 'votetorrent',
    invitePrivateKey: b64(32),
    invite: {
      key: randomEd25519KeyB64(),
      peerId: null,
      grantsOwner: false,
      expiresAt: '2099-12-31T23:59:59.000',
      totalUses: 1000,
      stampId: b64(32),
      issuerKey,
      issuerSig: b64(64)
    },
    ownerKeys: [issuerKey],
    members
  } as unknown as CadreInvitation
}

const hex = (n: number): string => randomBytes(n).toString('hex')

export function randomJoinAnchor (opts: { name?: string } = {}): NetworkJoinAnchor {
  return {
    networkHash: hex(16),
    name: opts.name ?? 'Utah County Elections',
    genesis: {
      userId: randomUUID(),
      signerKey: '02' + hex(32),
      authorityId: randomUUID(),
      adminEffectiveAt: '2026-10-12T10:00:00.000'
    },
    digest: b64(32)
  }
}

/** The real cadre-core mint of an invitation. */
export function mintInvitation (inv: CadreInvitation): string {
  return encodeCadreInvitation(inv)
}
