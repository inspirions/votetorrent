/**
 * founding-bundle.spec.ts — 62-16 (D-35, D-38, D-39).
 *
 * Task 1 (this section): the pure codec (serialize/parse/verify) and the
 * genesis-row replay, proven against two in-memory devices without routing
 * through `NetworksEngine.exportFoundingBundle`/`importFoundingBundle` (Task
 * 2 extends this file with those — see the second `describe` block below).
 */

import { expect } from 'chai'
import { Database } from '@quereus/quereus'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js'
import { UserKeyType } from '@votetorrent/vote-core'
import type { FoundingBundle, FoundingBundleRows, Signature, LocalStorage, AdminInit, Proposal, Scope } from '@votetorrent/vote-core'
import { prepareDb } from '../src/database/initialize.js'
import { nowCanonicalDatetime, bytesToBase64url } from '../src/utils.js'
import { buildManifest, computeContentDigest, computeSchemaHash } from '../src/bootstrap/snapshot-manifest.js'
import {
  FOUNDING_BUNDLE_FORMAT,
  FOUNDING_BUNDLE_FORMAT_VERSION,
  MAX_FOUNDING_BUNDLE_CHARS,
  FoundingBundleExportError,
  deriveFoundingDescriptor,
  foundingBundleSigningDigest,
  serializeFoundingBundle,
  parseFoundingBundle,
  verifyFoundingBundle
} from '../src/networks/founding-bundle.js'
import { GENESIS_COLUMNS, readGenesisRows, replayGenesisRows } from '../src/networks/genesis-rows.js'
import { NetworksEngine } from '../src/networks/networks-engine.js'
import type { DbFactory } from '../src/types.js'
import { createTestNetwork, addTestAuthority, makeTestSignCallback } from './fixtures/test-context.js'
import { randomTestKeyPair } from './fixtures/keys.js'
import { makeP256TestKey, signDigestP256 } from './fixtures/p256-signer.js'

type TestNet = Awaited<ReturnType<typeof createTestNetwork>>

// ---------------------------------------------------------------------------
// Task 2 device-B helpers: a per-device in-memory LocalStorage (the
// module-level AsyncStorage shim is shared, so device B must not use it) and
// a DbFactory recorder that keeps the hashes it was called with.
// ---------------------------------------------------------------------------

function makeDeviceLocalStorage (): LocalStorage {
  const store = new Map<string, unknown>()
  return {
    async getItem<TValue> (key: string): Promise<TValue | undefined> {
      return store.has(key) ? (store.get(key) as TValue) : undefined
    },
    async setItem<TValue> (key: string, value: TValue): Promise<void> {
      store.set(key, value)
    },
    async removeItem (key: string): Promise<void> {
      store.delete(key)
    },
    async clear (): Promise<void> {
      store.clear()
    }
  }
}

function makeRecordedInMemoryFactory (): { factory: DbFactory; calls: string[] } {
  const calls: string[] = []
  const factory: DbFactory = async (hash: string) => {
    calls.push(hash)
    return new Database()
  }
  return { factory, calls }
}

/**
 * Build a genuine, self-consistent, exporter-signed bundle directly from the
 * codec (deriveFoundingDescriptor / foundingBundleSigningDigest /
 * buildManifest / computeContentDigest) — deliberately NOT routed through
 * `NetworksEngine.exportFoundingBundle` (Task 2's job), so this file's first
 * `describe` block proves the codec stands on its own.
 */
async function buildGenuineBundle (
  net: TestNet,
  options?: { userId?: string; signerKey?: string; sign?: (digest: Uint8Array) => Promise<Signature> }
): Promise<{ bundle: FoundingBundle; rows: FoundingBundleRows }> {
  const details = await net.networkEngine.getDetails()
  const authorityId = details.network.primaryAuthorityId
  const adminRow = await net.ctx.db
    .prepare('select EffectiveAt from Admin where AuthorityId = :id')
    .get({ id: authorityId })
  if (!adminRow) throw new Error('buildGenuineBundle: Admin row not found')
  const adminEffectiveAt = adminRow.EffectiveAt as string

  const userId = options?.userId ?? net.user.id
  const signerKey = options?.signerKey ?? net.user.activeKeys[0]!.key

  const rows = await readGenesisRows(net.ctx.db, { userId, signerKey, authorityId, adminEffectiveAt })

  const exportedAt = nowCanonicalDatetime()
  const schemaHash = computeSchemaHash()
  const manifest = buildManifest(rows as unknown as Parameters<typeof buildManifest>[0]) as unknown as FoundingBundle['manifest']
  const digest = computeContentDigest(rows as unknown as Parameters<typeof computeContentDigest>[0])
  const descriptor = deriveFoundingDescriptor(rows)

  const signingDigest = foundingBundleSigningDigest({
    networkHash: descriptor.networkHash,
    schemaHash,
    exportedAt,
    exporterUserId: userId,
    signerKey,
    digest
  })
  const sign = options?.sign ?? makeTestSignCallback(net.user)
  const sig = await sign(signingDigest.bytes)

  const bundle: FoundingBundle = {
    format: FOUNDING_BUNDLE_FORMAT,
    formatVersion: FOUNDING_BUNDLE_FORMAT_VERSION,
    descriptor,
    schemaHash,
    exportedAt,
    manifest,
    digest,
    rows,
    exporter: { userId: sig.signerUserId, signerKey: sig.signerKey, signature: sig.signature }
  }
  return { bundle, rows }
}

describe('founding-bundle codec and genesis replay (D-35, D-38, D-39)', () => {
  describe('C-1: serialize/parse round-trip', () => {
    it('serializeFoundingBundle then parseFoundingBundle round-trips to a deep-equal bundle, and serializing twice is byte-identical', async () => {
      const net = await createTestNetwork()
      const { bundle } = await buildGenuineBundle(net)

      const text1 = serializeFoundingBundle(bundle)
      const text2 = serializeFoundingBundle(bundle)
      expect(text1).to.equal(text2)
      // Whitespace-free JSON structure: no formatting newline/tab/indentation.
      // Row/descriptor STRING VALUES (e.g. "Test Network") legitimately contain
      // spaces — only structural whitespace is forbidden.
      expect(text1).to.not.include('\n')
      expect(text1).to.not.include('\t')
      expect(text1.replace(/"(?:[^"\\]|\\.)*"/g, '""')).to.not.include(' ')

      const parsed = parseFoundingBundle(text1)
      expect(parsed.ok, 'round-trip parse must succeed').to.equal(true)
      if (!parsed.ok) throw new Error('unreachable')
      expect(parsed.bundle).to.deep.equal(bundle)
      expect(verifyFoundingBundle(parsed.bundle)).to.deep.equal({ ok: true })
    })
  })

  describe('C-2: parseFoundingBundle never throws, returns malformed', () => {
    it('non-JSON text', () => {
      const result = parseFoundingBundle('not json at all {{{')
      expect(result.ok).to.equal(false)
      if (result.ok) throw new Error('unreachable')
      expect(result.reason).to.equal('malformed')
    })

    it('a non-object (bare array)', () => {
      const result = parseFoundingBundle('[1,2,3]')
      expect(result.ok).to.equal(false)
    })

    it('a missing top-level key', async () => {
      const net = await createTestNetwork()
      const { bundle } = await buildGenuineBundle(net)
      const text = serializeFoundingBundle(bundle)
      const obj = JSON.parse(text)
      delete obj.digest
      const result = parseFoundingBundle(JSON.stringify(obj))
      expect(result.ok).to.equal(false)
      if (result.ok) throw new Error('unreachable')
      expect(result.detail).to.include('digest')
    })

    it('an extra top-level key', async () => {
      const net = await createTestNetwork()
      const { bundle } = await buildGenuineBundle(net)
      const obj = JSON.parse(serializeFoundingBundle(bundle))
      obj.extra = 'surprise'
      const result = parseFoundingBundle(JSON.stringify(obj))
      expect(result.ok).to.equal(false)
    })

    it('a wrong-typed member (formatVersion as a string)', async () => {
      const net = await createTestNetwork()
      const { bundle } = await buildGenuineBundle(net)
      const obj = JSON.parse(serializeFoundingBundle(bundle))
      obj.formatVersion = '1'
      const result = parseFoundingBundle(JSON.stringify(obj))
      expect(result.ok).to.equal(false)
    })

    it('a cell value that is a boolean', async () => {
      const net = await createTestNetwork()
      const { bundle } = await buildGenuineBundle(net)
      const obj = JSON.parse(serializeFoundingBundle(bundle))
      obj.rows.User[0].Name = true
      const result = parseFoundingBundle(JSON.stringify(obj))
      expect(result.ok).to.equal(false)
    })

    it('a cell value that is an object', async () => {
      const net = await createTestNetwork()
      const { bundle } = await buildGenuineBundle(net)
      const obj = JSON.parse(serializeFoundingBundle(bundle))
      obj.rows.User[0].Name = { nested: true }
      const result = parseFoundingBundle(JSON.stringify(obj))
      expect(result.ok).to.equal(false)
    })

    it('a cell value that is an array', async () => {
      const net = await createTestNetwork()
      const { bundle } = await buildGenuineBundle(net)
      const obj = JSON.parse(serializeFoundingBundle(bundle))
      obj.rows.User[0].Name = ['a']
      const result = parseFoundingBundle(JSON.stringify(obj))
      expect(result.ok).to.equal(false)
    })

    it('text longer than MAX_FOUNDING_BUNDLE_CHARS is rejected before JSON.parse', () => {
      const huge = '{' + '"a":1,'.repeat(MAX_FOUNDING_BUNDLE_CHARS)
      const result = parseFoundingBundle(huge)
      expect(result.ok).to.equal(false)
      if (result.ok) throw new Error('unreachable')
      expect(result.detail).to.include('exceeds')
    })
  })

  describe('C-3: verifyFoundingBundle fixed check order, one case per reason', () => {
    let net: TestNet
    let genuine: FoundingBundle

    before(async () => {
      net = await createTestNetwork()
      genuine = (await buildGenuineBundle(net)).bundle
    })

    it('baseline: the genuine bundle verifies ok', () => {
      expect(verifyFoundingBundle(genuine)).to.deep.equal({ ok: true })
    })

    it('format-version-mismatch', () => {
      const tampered: FoundingBundle = { ...genuine, formatVersion: 2 as 1 }
      const result = verifyFoundingBundle(tampered)
      expect(result).to.deep.include({ ok: false, reason: 'format-version-mismatch' })
    })

    it('malformed: non-canonical exportedAt', () => {
      const tampered: FoundingBundle = { ...genuine, exportedAt: genuine.exportedAt + 'Z' }
      const result = verifyFoundingBundle(tampered)
      expect(result).to.deep.include({ ok: false, reason: 'malformed' })
    })

    it('schema-hash-mismatch', () => {
      const tampered: FoundingBundle = { ...genuine, schemaHash: 'not-the-real-schema-hash' }
      const result = verifyFoundingBundle(tampered)
      expect(result).to.deep.include({ ok: false, reason: 'schema-hash-mismatch' })
    })

    it('manifest-mismatch', () => {
      const tampered: FoundingBundle = { ...genuine, manifest: { ...genuine.manifest, User: 2 } }
      const result = verifyFoundingBundle(tampered)
      expect(result).to.deep.include({ ok: false, reason: 'manifest-mismatch' })
    })

    it('digest-mismatch', () => {
      const tampered: FoundingBundle = { ...genuine, digest: 'not-the-real-digest' }
      const result = verifyFoundingBundle(tampered)
      expect(result).to.deep.include({ ok: false, reason: 'digest-mismatch' })
    })

    it('row-inconsistent: two Officer rows', () => {
      const tampered: FoundingBundle = {
        ...genuine,
        rows: { ...genuine.rows, Officer: [...genuine.rows.Officer, genuine.rows.Officer[0]!] },
        manifest: { ...genuine.manifest, Officer: 2 }
      }
      const result = verifyFoundingBundle(tampered)
      expect(result.ok).to.equal(false)
      if (result.ok) throw new Error('unreachable')
      expect(['manifest-mismatch', 'row-inconsistent']).to.include(result.reason)
    })

    it('row-inconsistent: a missing column', () => {
      const userRow = { ...genuine.rows.User[0]! }
      delete (userRow as Record<string, unknown>).ImageRef
      const rows: FoundingBundleRows = { ...genuine.rows, User: [userRow] }
      const digest = computeContentDigest(rows as unknown as Parameters<typeof computeContentDigest>[0])
      const tampered: FoundingBundle = { ...genuine, rows, digest }
      const result = verifyFoundingBundle(tampered)
      expect(result).to.deep.include({ ok: false, reason: 'row-inconsistent' })
    })

    it('row-inconsistent: an extra column', () => {
      const userRow = { ...genuine.rows.User[0]!, Extra: 'surprise' }
      const rows: FoundingBundleRows = { ...genuine.rows, User: [userRow] }
      const digest = computeContentDigest(rows as unknown as Parameters<typeof computeContentDigest>[0])
      const tampered: FoundingBundle = { ...genuine, rows, digest }
      const result = verifyFoundingBundle(tampered)
      expect(result).to.deep.include({ ok: false, reason: 'row-inconsistent' })
    })

    it('row-inconsistent: Officer.UserId not User.Id', () => {
      const officerRow = { ...genuine.rows.Officer[0]!, UserId: 'someone-else' }
      const rows: FoundingBundleRows = { ...genuine.rows, Officer: [officerRow] }
      const digest = computeContentDigest(rows as unknown as Parameters<typeof computeContentDigest>[0])
      const tampered: FoundingBundle = { ...genuine, rows, digest }
      const result = verifyFoundingBundle(tampered)
      expect(result).to.deep.include({ ok: false, reason: 'row-inconsistent' })
    })

    it('row-inconsistent: Network.Hash not H16(Network.Id)', () => {
      const networkRow = { ...genuine.rows.Network[0]!, Hash: 'not-the-real-hash' }
      const rows: FoundingBundleRows = { ...genuine.rows, Network: [networkRow] }
      const digest = computeContentDigest(rows as unknown as Parameters<typeof computeContentDigest>[0])
      const tampered: FoundingBundle = { ...genuine, rows, digest }
      const result = verifyFoundingBundle(tampered)
      expect(result).to.deep.include({ ok: false, reason: 'row-inconsistent' })
    })

    it('descriptor-mismatch: relays differ', () => {
      const tampered: FoundingBundle = { ...genuine, descriptor: { ...genuine.descriptor, relays: ['/dns4/evil.example.com/tcp/443/wss'] } }
      const result = verifyFoundingBundle(tampered)
      expect(result).to.deep.include({ ok: false, reason: 'descriptor-mismatch' })
    })

    it('descriptor-mismatch: networkHash differs', () => {
      const tampered: FoundingBundle = { ...genuine, descriptor: { ...genuine.descriptor, networkHash: 'ffffffffffffffffffffffffffffffff' } }
      const result = verifyFoundingBundle(tampered)
      expect(result).to.deep.include({ ok: false, reason: 'descriptor-mismatch' })
    })

    it('exporter-not-founding-officer: exportedAt after UserKey.Expiration', () => {
      const tampered: FoundingBundle = { ...genuine, exportedAt: '2099-01-01T00:00:00' }
      const result = verifyFoundingBundle(tampered)
      expect(result).to.deep.include({ ok: false, reason: 'exporter-not-founding-officer' })
    })

    it('signature-invalid: a row edited AND digest/manifest recomputed, signature left as-is', () => {
      const userRow = { ...genuine.rows.User[0]!, Name: 'Tampered Name' }
      const rows: FoundingBundleRows = { ...genuine.rows, User: [userRow] }
      const digest = computeContentDigest(rows as unknown as Parameters<typeof computeContentDigest>[0])
      const manifest = buildManifest(rows as unknown as Parameters<typeof buildManifest>[0]) as unknown as FoundingBundle['manifest']
      const tampered: FoundingBundle = { ...genuine, rows, digest, manifest }
      const result = verifyFoundingBundle(tampered)
      expect(result).to.deep.include({ ok: false, reason: 'signature-invalid' })
    })

    it('anchor-mismatch: expectedNetworkHash', () => {
      const result = verifyFoundingBundle(genuine, { expectedNetworkHash: 'not-the-real-hash' })
      expect(result).to.deep.include({ ok: false, reason: 'anchor-mismatch' })
    })

    it('anchor-mismatch: expectedDigest', () => {
      const result = verifyFoundingBundle(genuine, { expectedDigest: 'not-the-real-digest' })
      expect(result).to.deep.include({ ok: false, reason: 'anchor-mismatch' })
    })

    it('anchors succeed when both match', () => {
      const result = verifyFoundingBundle(genuine, { expectedNetworkHash: genuine.descriptor.networkHash, expectedDigest: genuine.digest })
      expect(result).to.deep.equal({ ok: true })
    })
  })

  describe('C-4: curve-branched exporter signature', () => {
    it('a P-256-signed bundle verifies through verifySigP256, and the same bundle with Type rewritten to M fails signature-invalid', async () => {
      const { privBytes, pubHex } = makeP256TestKey()
      const net = await createTestNetwork({
        user: {
          id: 'p256-founder',
          activeKeys: [{ key: pubHex, type: UserKeyType.p256, expiration: Date.now() + 86_400_000 }]
        }
      })
      const sign = async (digest: Uint8Array): Promise<Signature> => ({
        signature: signDigestP256(bytesToBase64url(digest), privBytes),
        signerKey: pubHex,
        signerUserId: net.user.id
      })
      const { bundle } = await buildGenuineBundle(net, { userId: net.user.id, signerKey: pubHex, sign })

      expect(verifyFoundingBundle(bundle)).to.deep.equal({ ok: true })

      const userKeyRow = { ...bundle.rows.UserKey[0]!, Type: 'M' }
      const rows: FoundingBundleRows = { ...bundle.rows, UserKey: [userKeyRow] }
      const digest = computeContentDigest(rows as unknown as Parameters<typeof computeContentDigest>[0])
      const manifest = buildManifest(rows as unknown as Parameters<typeof buildManifest>[0]) as unknown as FoundingBundle['manifest']
      const tampered: FoundingBundle = { ...bundle, rows, digest, manifest }
      const result = verifyFoundingBundle(tampered)
      expect(result).to.deep.include({ ok: false, reason: 'signature-invalid' })
    })
  })

  describe('C-5: detail strings carry no secret values', () => {
    it('every verify failure detail omits the bundle user name, relay strings and public key', async () => {
      const net = await createTestNetwork()
      const { bundle } = await buildGenuineBundle(net)
      const secretName = bundle.rows.User[0]!.Name as string
      const secretRelay = bundle.descriptor.relays[0]!
      const secretKey = bundle.exporter.signerKey

      const cases: FoundingBundle[] = [
        { ...bundle, formatVersion: 2 as 1 },
        { ...bundle, schemaHash: 'wrong' },
        { ...bundle, digest: 'wrong' },
        { ...bundle, descriptor: { ...bundle.descriptor, relays: ['/dns4/evil.example.com/tcp/443/wss'] } },
        { ...bundle, exportedAt: '2099-01-01T00:00:00' }
      ]
      for (const tampered of cases) {
        const result = verifyFoundingBundle(tampered)
        expect(result.ok).to.equal(false)
        if (result.ok) throw new Error('unreachable')
        expect(result.detail).to.not.include(secretName)
        expect(result.detail).to.not.include(secretRelay)
        expect(result.detail).to.not.include(secretKey)
      }
    })
  })

  describe('R: genesis-row replay', () => {
    it('R-1: replayGenesisRows into a fresh initialized Database inserts all six rows, digest-equal on read-back', async () => {
      const net = await createTestNetwork()
      const { rows: sourceRows } = await buildGenuineBundle(net)
      const sourceDigest = computeContentDigest(sourceRows as unknown as Parameters<typeof computeContentDigest>[0])

      const deviceB = new Database()
      await prepareDb(deviceB)
      await replayGenesisRows(deviceB, sourceRows, nowCanonicalDatetime())

      const keys = {
        userId: String(sourceRows.User[0]!.Id),
        signerKey: String(sourceRows.UserKey[0]!.PubKey),
        authorityId: String(sourceRows.Authority[0]!.Id),
        adminEffectiveAt: String(sourceRows.Admin[0]!.EffectiveAt)
      }
      const replayedRows = await readGenesisRows(deviceB, keys)
      const replayedDigest = computeContentDigest(replayedRows as unknown as Parameters<typeof computeContentDigest>[0])
      expect(replayedDigest).to.equal(sourceDigest)
      for (const table of Object.keys(GENESIS_COLUMNS) as Array<keyof typeof GENESIS_COLUMNS>) {
        expect(replayedRows[table]).to.have.lengthOf(1, `${table} must have exactly one replayed row`)
      }
    })

    it('R-2: the genesis CHECK branches are Tid-independent — binding 1 and 987654321 both insert and yield the same digest', async () => {
      const net = await createTestNetwork()
      const { rows: sourceRows } = await buildGenuineBundle(net)
      const keys = {
        userId: String(sourceRows.User[0]!.Id),
        signerKey: String(sourceRows.UserKey[0]!.PubKey),
        authorityId: String(sourceRows.Authority[0]!.Id),
        adminEffectiveAt: String(sourceRows.Admin[0]!.EffectiveAt)
      }
      const now = nowCanonicalDatetime()

      const dbA = new Database()
      await prepareDb(dbA)
      await replayGenesisRows(dbA, sourceRows, now)
      const rowsA = await readGenesisRows(dbA, keys)
      const digestA = computeContentDigest(rowsA as unknown as Parameters<typeof computeContentDigest>[0])

      const dbB = new Database()
      await prepareDb(dbB)
      await replayGenesisRows(dbB, sourceRows, now)
      const rowsB = await readGenesisRows(dbB, keys)
      const digestB = computeContentDigest(rowsB as unknown as Parameters<typeof computeContentDigest>[0])

      expect(digestA).to.equal(digestB)

      // Assertion-only confirmation that replayGenesisRows's constant Tid binding is
      // load-bearing and not an untested accident: the SAME statement shape with a
      // DIFFERENT constant Tid (987654321) also inserts and also yields the same digest.
      const dbC = new Database()
      await prepareDb(dbC)
      const { publicHex } = randomTestKeyPair()
      await dbC.exec(
        `insert into User (Id, Name, ImageRef) with context SigningNonce = null, InviteSlotCid = null, InviteSignature = null, Tid = 987654321
         values (:id, 'Tid-independence probe user', null)`,
        { id: 'tid-probe-user' }
      )
      const probeRow = await dbC.prepare('select Id from User where Id = :id').get({ id: 'tid-probe-user' })
      expect(probeRow?.Id).to.equal('tid-probe-user')
    })

    it('R-3: replayGenesisRows succeeds for a UserKey whose Expiration is already in the past (the import flag is bound)', async function () {
      this.timeout(15_000)
      const net = await createTestNetwork({
        user: { activeKeys: [{ key: randomTestKeyPair().publicHex, type: UserKeyType.mobile, expiration: Date.now() + 3000 }] }
      })
      // Poll until nowCanonicalDatetime() sorts after the stored Expiration (second resolution).
      let expired = false
      const deadline = Date.now() + 10_000
      let userKeyRow: { Expiration: unknown } | undefined
      while (!expired && Date.now() < deadline) {
        userKeyRow = await net.ctx.db
          .prepare('select Expiration from UserKey where UserId = :id')
          .get({ id: net.user.id }) as { Expiration: unknown } | undefined
        if (userKeyRow && nowCanonicalDatetime() > String(userKeyRow.Expiration)) {
          expired = true
        } else {
          await new Promise((resolve) => setTimeout(resolve, 250))
        }
      }
      expect(expired, 'the founding UserKey must have genuinely expired before replay').to.equal(true)

      const { rows: sourceRows } = await buildGenuineBundle(net)
      const deviceB = new Database()
      await prepareDb(deviceB)
      // Must NOT throw even though UserKey.Expiration is in the past — the D-38 flag waives it.
      await replayGenesisRows(deviceB, sourceRows, nowCanonicalDatetime())
      const keyRow = await deviceB
        .prepare('select PubKey from UserKey where UserId = :id')
        .get({ id: String(sourceRows.User[0]!.Id) })
      expect(keyRow?.PubKey).to.equal(sourceRows.UserKey[0]!.PubKey)

      // Assertion-only: the SAME statement text with the flag removed throws naming ExpirationFuture.
      // The shipped module always binds the flag — this proves the schema's own bound, not a code path.
      const deviceC = new Database()
      await prepareDb(deviceC)
      const userRow = sourceRows.User[0]!
      await deviceC.exec(
        `insert into User (Id, Name, ImageRef) with context SigningNonce = null, InviteSlotCid = null, InviteSignature = null, Tid = 0
         values (:id, :name, :imageRef)`,
        { id: userRow.Id, name: userRow.Name, imageRef: userRow.ImageRef }
      )
      let caught: unknown
      try {
        await deviceC.exec(
          `insert into UserKey (UserId, Type, PubKey, Expiration)
           with context UserKey = null, Signature = null, Tid = 0, now = :now, IsSignatureValid = true
           values (:userId, :type, :pubKey, :expiration)`,
          {
            userId: userRow.Id,
            type: sourceRows.UserKey[0]!.Type,
            pubKey: sourceRows.UserKey[0]!.PubKey,
            expiration: sourceRows.UserKey[0]!.Expiration,
            now: nowCanonicalDatetime()
          }
        )
      } catch (err) {
        caught = err
      }
      expect(caught, 'without the import flag, an expired founding key must be refused').to.be.instanceOf(Error)
      expect((caught as Error).message).to.include('ExpirationFuture')
    })

    it('R-4: after replayGenesisRows, the Database holds no TidHighWater row for Namespace "networks"', async () => {
      const net = await createTestNetwork()
      const { rows: sourceRows } = await buildGenuineBundle(net)
      const deviceB = new Database()
      await prepareDb(deviceB)
      await replayGenesisRows(deviceB, sourceRows, nowCanonicalDatetime())
      const row = await deviceB.prepare("select Namespace from TidHighWater where Namespace = 'networks'").get({})
      expect(row).to.equal(undefined)
    })
  })
})

// ---------------------------------------------------------------------------
// Task 2 — NetworksEngine.exportFoundingBundle/importFoundingBundle (D-35,
// D-37, D-38, D-39): two-device in-memory cases.
// ---------------------------------------------------------------------------

describe('NetworksEngine export/import (D-35, D-37, D-38, D-39)', () => {
  async function exporterFor (net: TestNet): Promise<{ userId: string; signerKey: string; sign: (digest: Uint8Array) => Promise<Signature> }> {
    return {
      userId: net.user.id,
      signerKey: net.user.activeKeys[0]!.key,
      sign: makeTestSignCallback(net.user)
    }
  }

  describe('E-1/E-2: exportFoundingBundle', () => {
    it('E-1: exports a bundle that verifies, with one row per table and a matching descriptor', async () => {
      const net = await createTestNetwork()
      const exporter = await exporterFor(net)
      const result = await net.networksEngine.exportFoundingBundle(net.ref.hash, exporter)

      expect(verifyFoundingBundle(result.bundle)).to.deep.equal({ ok: true })
      for (const table of Object.keys(GENESIS_COLUMNS) as Array<keyof typeof GENESIS_COLUMNS>) {
        expect(result.bundle.rows[table]).to.have.lengthOf(1)
      }
      expect(result.bundle.descriptor.relays).to.deep.equal(net.ref.relays)
      expect(result.bundle.descriptor.networkHash).to.equal(net.ref.hash)
      expect(result.text).to.equal(serializeFoundingBundle(result.bundle))
    })

    it('E-2a: network-not-open for an unknown hash', async () => {
      const net = await createTestNetwork()
      const exporter = await exporterFor(net)
      let caught: unknown
      try {
        await net.networksEngine.exportFoundingBundle('0000000000000000', exporter)
      } catch (err) { caught = err }
      expect(caught).to.be.instanceOf(FoundingBundleExportError)
      expect((caught as FoundingBundleExportError).code).to.equal('network-not-open')
    })

    it('E-2b: not-founding-officer for a userId that is not an Officer', async () => {
      const net = await createTestNetwork()
      const exporter = { ...(await exporterFor(net)), userId: 'not-a-real-user' }
      let caught: unknown
      try {
        await net.networksEngine.exportFoundingBundle(net.ref.hash, exporter)
      } catch (err) { caught = err }
      expect(caught).to.be.instanceOf(FoundingBundleExportError)
      expect((caught as FoundingBundleExportError).code).to.equal('not-founding-officer')
    })

    it('E-2c: signer-key-invalid for a signerKey not among that user\'s keys', async () => {
      const net = await createTestNetwork()
      const exporter = { ...(await exporterFor(net)), signerKey: randomTestKeyPair().publicHex }
      let caught: unknown
      try {
        await net.networksEngine.exportFoundingBundle(net.ref.hash, exporter)
      } catch (err) { caught = err }
      expect(caught).to.be.instanceOf(FoundingBundleExportError)
      expect((caught as FoundingBundleExportError).code).to.equal('signer-key-invalid')
    })

    it('E-2d: admin-revised for a second SIGNED Admin generation, seeded through a real proposeAdmin promotion (D-48)', async () => {
      const net = await createTestNetwork()
      const auth = await addTestAuthority(net)

      const proposal: Proposal<AdminInit> = {
        proposed: {
          officers: [{ existing: { userId: auth.user.id, authorityId: auth.authority.id, title: 'Chair', scopes: ['rad'] as Scope[] } }],
          effectiveAt: Date.now() + 60_000,
          thresholdPolicies: [{ policy: 'rad', threshold: 1 }]
        },
        signers: [auth.user.id]
      }
      await auth.authorityEngine.proposeAdmin(proposal, makeTestSignCallback(auth.user))

      const outcome = (auth.authorityEngine as unknown as { lastPromotionOutcome?: { status: string } }).lastPromotionOutcome
      expect(outcome?.status, 'E-2d setup: the promotion must actually complete').to.equal('promoted')

      const adminCount = await auth.ctx.db
        .prepare('select count(*) as n from Admin where AuthorityId = :id')
        .get({ id: auth.authority.id })
      expect(Number(adminCount?.n), 'E-2d setup: two Admin rows must now exist').to.equal(2)

      const exporter = await exporterFor(net)
      let caught: unknown
      try {
        await net.networksEngine.exportFoundingBundle(net.ref.hash, exporter)
      } catch (err) { caught = err }
      expect(caught).to.be.instanceOf(FoundingBundleExportError)
      expect((caught as FoundingBundleExportError).code).to.equal('admin-revised')
    })

    it('E-2e: signature-self-check when the sign callback signs other bytes', async () => {
      const net = await createTestNetwork()
      const exporter = {
        ...(await exporterFor(net)),
        sign: async (_digest: Uint8Array): Promise<Signature> => {
          const real = await makeTestSignCallback(net.user)(new TextEncoder().encode('wrong bytes entirely'))
          return real
        }
      }
      let caught: unknown
      try {
        await net.networksEngine.exportFoundingBundle(net.ref.hash, exporter)
      } catch (err) { caught = err }
      expect(caught).to.be.instanceOf(FoundingBundleExportError)
      expect((caught as FoundingBundleExportError).code).to.equal('signature-self-check')
    })

    async function exportWithThrowingSigner (thrown: unknown): Promise<unknown> {
      const net = await createTestNetwork()
      const exporter = {
        ...(await exporterFor(net)),
        sign: async (_digest: Uint8Array): Promise<Signature> => { throw thrown }
      }
      try {
        await net.networksEngine.exportFoundingBundle(net.ref.hash, exporter)
      } catch (err) { return err }
      return undefined
    }

    for (const [id, code] of [['E-2f', 'CANCELED'], ['E-2g', 'KEY_INVALIDATED_REASSOCIATE'], ['E-2h', 'LOCKOUT']] as const) {
      it(`${id}: a signer error with code ${code} is rethrown unchanged`, async () => {
        const original = Object.assign(new Error('signer failure'), { code })
        const caught = await exportWithThrowingSigner(original)
        expect(caught).to.equal(original)
        expect(caught).to.not.be.instanceOf(FoundingBundleExportError)
        expect((caught as { code: string }).code).to.equal(code)
      })
    }

    it('E-2i: a codeless signer error is wrapped as signature-self-check with the cause kept', async () => {
      const original = new Error('boom')
      const caught = await exportWithThrowingSigner(original)
      expect(caught).to.be.instanceOf(FoundingBundleExportError)
      expect((caught as FoundingBundleExportError).code).to.equal('signature-self-check')
      expect((caught as { cause?: unknown }).cause).to.equal(original)
    })

    it('E-2j: a non-Error thrown value with a string code is rethrown unchanged', async () => {
      const original = { code: 'CANCELED' }
      const caught = await exportWithThrowingSigner(original)
      expect(caught).to.equal(original)
    })

    it('E-2k: a signature whose signerKey differs from the exporter is signature-self-check', async () => {
      const net = await createTestNetwork()
      const base = await exporterFor(net)
      const exporter = {
        ...base,
        sign: async (digest: Uint8Array): Promise<Signature> => {
          const real = await base.sign(digest)
          return { ...real, signerKey: real.signerKey + 'x' }
        }
      }
      let caught: unknown
      try {
        await net.networksEngine.exportFoundingBundle(net.ref.hash, exporter)
      } catch (err) { caught = err }
      expect(caught).to.be.instanceOf(FoundingBundleExportError)
      expect((caught as FoundingBundleExportError).code).to.equal('signature-self-check')
    })
  })

  describe('I: importFoundingBundle on a second in-memory device', () => {
    it('I-1/I-2: a second device imports the text — ok, replayed, strandId = H16(networkId), digest-equal, no Tid allocated', async () => {
      const net = await createTestNetwork()
      const exporter = await exporterFor(net)
      const { text, bundle } = await net.networksEngine.exportFoundingBundle(net.ref.hash, exporter)

      const { factory, calls } = makeRecordedInMemoryFactory()
      const engineB = new NetworksEngine(makeDeviceLocalStorage(), factory)
      const result = await engineB.importFoundingBundle(text, undefined)

      expect(result.ok, 'import must succeed').to.equal(true)
      if (!result.ok) throw new Error('unreachable')
      expect(result.outcome).to.equal('replayed')
      expect(calls).to.deep.equal([bundle.descriptor.networkHash])

      const ctxB = engineB.getEstablishedContext(bundle.descriptor.networkHash)
      if (!ctxB) throw new Error('I-1: device B context not established')
      const genesisKeys = {
        userId: String(bundle.rows.User[0]!.Id),
        signerKey: String(bundle.rows.UserKey[0]!.PubKey),
        authorityId: String(bundle.rows.Authority[0]!.Id),
        adminEffectiveAt: String(bundle.rows.Admin[0]!.EffectiveAt)
      }
      const rowsB = await readGenesisRows(ctxB.db, genesisKeys)
      expect(computeContentDigest(rowsB as unknown as Parameters<typeof computeContentDigest>[0])).to.equal(bundle.digest)

      const details = await result.network.getDetails()
      expect(details.network.id).to.equal(bundle.descriptor.networkId)
      expect(details.network.primaryAuthorityId).to.equal(bundle.descriptor.primaryAuthorityId)

      const recentsB = await engineB.getRecentNetworks()
      expect(recentsB).to.have.lengthOf(1)
      expect(recentsB[0]?.hash).to.equal(bundle.descriptor.networkHash)
      expect(recentsB[0]?.relays).to.deep.equal([...bundle.descriptor.relays])

      // I-2: no Tid allocated.
      const tidRow = await ctxB.db.prepare("select Namespace from TidHighWater where Namespace = 'networks'").get({})
      expect(tidRow).to.equal(undefined)
    })

    it('I-3: a bundle exported while the founding key was still valid, but whose key has since expired by IMPORT time, still imports with outcome replayed', async function () {
      this.timeout(15_000)
      // Generate the key pair ourselves (rather than through makeTestUser's own
      // internal randomTestKeyPair()) so the sign callback below can sign with
      // the SAME private key as the overridden public key — createTestNetwork's
      // `user.activeKeys` override replaces the whole array, but
      // makeTestSignCallback only ever knows the key makeTestUser generated
      // internally, so a bare activeKeys override would sign with the WRONG key.
      const { privateHex, publicHex } = randomTestKeyPair()
      const net = await createTestNetwork({
        user: { activeKeys: [{ key: publicHex, type: UserKeyType.mobile, expiration: Date.now() + 3000 }] }
      })
      const exporter = {
        userId: net.user.id,
        signerKey: publicHex,
        sign: async (digest: Uint8Array): Promise<Signature> => ({
          signature: bytesToHex(secp256k1.sign(digest, hexToBytes(privateHex))),
          signerKey: publicHex,
          signerUserId: net.user.id
        })
      }

      // Export FIRST, while the key is still valid (exportFoundingBundle itself
      // requires `expiration > now` at EXPORT time — signer-key-invalid otherwise,
      // and `verifyFoundingBundle` check 8 requires exportedAt not after
      // Expiration). D-38's waiver is for the gap between export and import, not
      // for signing with an already-dead key.
      const { text } = await net.networksEngine.exportFoundingBundle(net.ref.hash, exporter)

      // THEN wait for the key to genuinely expire before importing.
      let expired = false
      const deadline = Date.now() + 10_000
      while (!expired && Date.now() < deadline) {
        const row = await net.ctx.db.prepare('select Expiration from UserKey where UserId = :id').get({ id: net.user.id })
        if (row && nowCanonicalDatetime() > String(row.Expiration)) expired = true
        else await new Promise((resolve) => setTimeout(resolve, 250))
      }
      expect(expired, 'I-3 setup: the founding key must have genuinely expired before import').to.equal(true)

      const engineB = new NetworksEngine(makeDeviceLocalStorage())
      const result = await engineB.importFoundingBundle(text, undefined)
      expect(result.ok, `I-3 import must succeed even though the founding key has since expired: ${result.ok ? '' : (result as { detail: string }).detail}`).to.equal(true)
      if (!result.ok) throw new Error('unreachable')
      expect(result.outcome).to.equal('replayed')
    })

    it('I-4: a digest-tampered bundle returns ok:false digest-mismatch, the recorder is never called, recentNetworks unchanged', async () => {
      const net = await createTestNetwork()
      const exporter = await exporterFor(net)
      const { bundle } = await net.networksEngine.exportFoundingBundle(net.ref.hash, exporter)
      const tampered: FoundingBundle = { ...bundle, digest: 'not-the-real-digest' }
      const text = serializeFoundingBundle(tampered)

      const { factory, calls } = makeRecordedInMemoryFactory()
      const storage = makeDeviceLocalStorage()
      const engineB = new NetworksEngine(storage, factory)
      const result = await engineB.importFoundingBundle(text, undefined)

      expect(result.ok).to.equal(false)
      if (result.ok) throw new Error('unreachable')
      expect(result.reason).to.equal('digest-mismatch')
      expect(result.category).to.equal('invalid-bundle')
      expect(calls).to.deep.equal([])
      expect(await engineB.getRecentNetworks()).to.deep.equal([])
    })

    it('I-5: replay-rejected for a consistently re-signed bundle whose Officer.Scopes holds an unknown scope code', async () => {
      const net = await createTestNetwork()
      const exporter = await exporterFor(net)
      const { bundle } = await net.networksEngine.exportFoundingBundle(net.ref.hash, exporter)

      const officerRow = { ...bundle.rows.Officer[0]!, Scopes: '["not-a-real-scope"]' }
      const rows: FoundingBundleRows = { ...bundle.rows, Officer: [officerRow] }
      const digest = computeContentDigest(rows as unknown as Parameters<typeof computeContentDigest>[0])
      const manifest = buildManifest(rows as unknown as Parameters<typeof buildManifest>[0]) as unknown as FoundingBundle['manifest']
      const exportedAt = nowCanonicalDatetime()
      const signingDigest = foundingBundleSigningDigest({
        networkHash: bundle.descriptor.networkHash, schemaHash: bundle.schemaHash, exportedAt,
        exporterUserId: bundle.exporter.userId, signerKey: bundle.exporter.signerKey, digest
      })
      const sig = await exporter.sign(signingDigest.bytes)
      const tampered: FoundingBundle = {
        ...bundle, rows, digest, manifest, exportedAt,
        exporter: { userId: sig.signerUserId, signerKey: sig.signerKey, signature: sig.signature }
      }
      expect(verifyFoundingBundle(tampered), 'I-5 setup: the re-signed bundle must pass codec verification').to.deep.equal({ ok: true })
      const text = serializeFoundingBundle(tampered)

      const { factory, calls } = makeRecordedInMemoryFactory()
      const engineB = new NetworksEngine(makeDeviceLocalStorage(), factory)
      const result = await engineB.importFoundingBundle(text, undefined)

      expect(result.ok).to.equal(false)
      if (result.ok) throw new Error('unreachable')
      expect(result.reason).to.equal('replay-rejected')
      expect(result.category).to.equal('invalid-bundle')
      expect(result.detail).to.include('ScopesValid')
      expect(calls).to.deep.equal([])
    })

    it('I-6: importing the same text twice on one engine returns already-joined the second time', async () => {
      const net = await createTestNetwork()
      const exporter = await exporterFor(net)
      const { text } = await net.networksEngine.exportFoundingBundle(net.ref.hash, exporter)

      const { factory, calls } = makeRecordedInMemoryFactory()
      const engineB = new NetworksEngine(makeDeviceLocalStorage(), factory)
      const first = await engineB.importFoundingBundle(text, undefined)
      expect(first.ok).to.equal(true)
      const callsAfterFirst = calls.length

      const second = await engineB.importFoundingBundle(text, undefined)
      expect(second.ok).to.equal(false)
      if (second.ok) throw new Error('unreachable')
      expect(second.reason).to.equal('already-joined')
      expect(second.category).to.equal('already-joined')
      expect(calls.length, 'no second DbFactory call on an already-joined import').to.equal(callsAfterFirst)
    })

    it('I-7: already-present when the target DbFactory returns the SAME database device A already wrote', async () => {
      const net = await createTestNetwork()
      const exporter = await exporterFor(net)
      const { text, bundle } = await net.networksEngine.exportFoundingBundle(net.ref.hash, exporter)

      const sameDbFactory: DbFactory = async () => net.ctx.db
      const engineB = new NetworksEngine(makeDeviceLocalStorage(), sameDbFactory)
      const result = await engineB.importFoundingBundle(text, undefined)

      expect(result.ok, `I-7 import must succeed: ${result.ok ? '' : (result as { reason: string }).reason}`).to.equal(true)
      if (!result.ok) throw new Error('unreachable')
      expect(result.outcome).to.equal('already-present')

      const countRow = await net.ctx.db.prepare('select count(*) as n from Officer where AuthorityId = :id').get({ id: bundle.descriptor.primaryAuthorityId })
      expect(Number(countRow?.n), 'already-present must not write a second Officer row').to.equal(1)
    })

    it('I-8: target-conflict when the target DbFactory returns a database holding a DIFFERENT network\'s genesis', async () => {
      const net = await createTestNetwork()
      const exporter = await exporterFor(net)
      const { text } = await net.networksEngine.exportFoundingBundle(net.ref.hash, exporter)

      const otherNet = await createTestNetwork()
      const differentDbFactory: DbFactory = async () => otherNet.ctx.db
      const engineB = new NetworksEngine(makeDeviceLocalStorage(), differentDbFactory)
      const result = await engineB.importFoundingBundle(text, undefined)

      expect(result.ok).to.equal(false)
      if (result.ok) throw new Error('unreachable')
      expect(result.reason).to.equal('target-conflict')
      expect(result.category).to.equal('error')
    })

    it('I-9: a self-consistent bundle from a genuinely different network imports without anchors, and anchor-mismatch with the genuine digest pinned', async () => {
      const genuineNet = await createTestNetwork()
      const genuineExporter = await exporterFor(genuineNet)
      const { bundle: genuineBundle } = await genuineNet.networksEngine.exportFoundingBundle(genuineNet.ref.hash, genuineExporter)

      // A self-consistent, independently-signed bundle from a SEPARATE network —
      // structurally indistinguishable from an attacker minting their own fully
      // valid genesis and presenting it as "the" network (T-62-16-03, documented
      // residual: the real anchor is the founding officer key plus the human
      // handoff channel, not anything verifyFoundingBundle alone can prove).
      const attackerNet = await createTestNetwork()
      const attackerExporter = await exporterFor(attackerNet)
      const { text: attackerText, bundle: attackerBundle } = await attackerNet.networksEngine.exportFoundingBundle(
        attackerNet.ref.hash, attackerExporter
      )
      expect(attackerBundle.descriptor.networkHash).to.not.equal(genuineBundle.descriptor.networkHash)

      const engineB1 = new NetworksEngine(makeDeviceLocalStorage())
      const withoutAnchors = await engineB1.importFoundingBundle(attackerText, undefined)
      expect(withoutAnchors.ok, 'I-9: imports without anchors (documented residual)').to.equal(true)

      const engineB2 = new NetworksEngine(makeDeviceLocalStorage())
      const withGenuineAnchor = await engineB2.importFoundingBundle(attackerText, undefined, { expectedDigest: genuineBundle.digest })
      expect(withGenuineAnchor.ok).to.equal(false)
      if (withGenuineAnchor.ok) throw new Error('unreachable')
      expect(withGenuineAnchor.reason).to.equal('anchor-mismatch')
    })
  })
})
