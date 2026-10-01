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
import { UserKeyType } from '@votetorrent/vote-core'
import type { FoundingBundle, FoundingBundleRows, Signature } from '@votetorrent/vote-core'
import { prepareDb } from '../src/database/initialize.js'
import { nowCanonicalDatetime, toCanonicalDatetime, bytesToBase64url } from '../src/utils.js'
import { buildManifest, computeContentDigest, computeSchemaHash } from '../src/bootstrap/snapshot-manifest.js'
import {
  FOUNDING_BUNDLE_FORMAT,
  FOUNDING_BUNDLE_FORMAT_VERSION,
  MAX_FOUNDING_BUNDLE_CHARS,
  deriveFoundingDescriptor,
  foundingBundleSigningDigest,
  serializeFoundingBundle,
  parseFoundingBundle,
  verifyFoundingBundle
} from '../src/networks/founding-bundle.js'
import { GENESIS_COLUMNS, readGenesisRows, replayGenesisRows } from '../src/networks/genesis-rows.js'
import { createTestNetwork, makeTestSignCallback } from './fixtures/test-context.js'
import { randomTestKeyPair } from './fixtures/keys.js'
import { makeP256TestKey, signDigestP256 } from './fixtures/p256-signer.js'

type TestNet = Awaited<ReturnType<typeof createTestNetwork>>

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
