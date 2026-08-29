/**
 * bootstrap-transport-conformance.spec.ts — Phase 50 Plan 03 (D-06): the
 * shared bootstrap-transport conformance suite.
 *
 * ============================================================================
 * 1. WHAT THIS PROVES
 * ============================================================================
 * D-06's claim is that `IBootstrapTransport`'s real bindings are
 * INTERCHANGEABLE. The only evidence for interchangeability is that the SAME
 * assertions ran against both. This file makes that mechanically true, not
 * merely claimed: five conformance cases are written EXACTLY ONCE, inside one
 * exported function delimited by a matching pair of numbered-comment
 * sentinels (see below). That function is called exactly ONCE per entry, in
 * a loop over a two-entry binding table. Five case literals therefore produce
 * TEN passing tests. If an executor ever duplicates the body per binding
 * instead of sharing it, the case count inside the sentinel region rises
 * above five and the structural regression gate fails: a duplicated body is a
 * GATE FAILURE, not a style preference.
 *
 * ============================================================================
 * 1b. WHAT CHANGED, AND WHY THE CASE COUNT DROPPED
 * ============================================================================
 * Under D-06 the bindings courier SEALED WRAPPERS, not envelopes: a binding
 * returns `{ status, sealed? }` and never opens what it carries. This suite
 * therefore SEALS AT THE SOURCE — inside each factory's `stageCode`, so the
 * shared body never has to know how a binding stores things — and UNSEALS IN
 * THE SHARED BODY, through the single `openDelivered` helper that expresses
 * the consumer half of D-06 exactly once. Tampering is likewise applied at
 * the source: unseal, mutate, re-seal, write back, so what the courier
 * carries is a legitimately-sealed payload with mutated content.
 *
 * The sixth case (a cursor-shaped freshness/re-delivery case over a pull-style
 * method) is GONE, with the method itself, under D-07. It must not come back:
 * a keyless pull has no out-of-band digest to verify against, and a shared
 * current document has no single key that opens it.
 *
 * The REST factory's receiver here is an in-test stand-in. `52-13` repoints
 * `makeRestBinding` at the real rendezvous service; this file must stay green
 * against the stand-in until then and must not pre-empt that work.
 *
 * ============================================================================
 * 2. NO THIRD SLOT
 * ============================================================================
 * Unlike the D-01 registration seam's conformance suite there is no reserved
 * peer-cluster entry here — D-06 excludes a peer-cluster binding outright,
 * and the standalone receiver service such a binding would need is not built
 * in this phase. Both binding-table entries run. There is no reserved
 * pending entry in this file and a later reader must not add one.
 *
 * ============================================================================
 * 3. DECLARED BLIND SPOT
 * ============================================================================
 * This suite proves the two real bindings agree WITH EACH OTHER and that a
 * tampered payload stays detectable through both. It does NOT prove the
 * producer's export path or the consumer's commit path — it proves only the
 * courier layer.
 *
 * ============================================================================
 * 4. WHAT THIS SUITE DELIBERATELY DOES NOT ASSERT
 * ============================================================================
 * Neither binding REJECTS a tampered snapshot — they are couriers. What is
 * proven is that tampering is detectable at the same point, with the same
 * evidence, through either binding, and that neither binding launders a
 * tampered payload by re-digesting the mutated content.
 *
 * ============================================================================
 * 5. NO CLAIM OF SCOPE ENFORCEMENT
 * ============================================================================
 * No sentence in this file claims that any scope is enforced in this seam.
 */

import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { expect } from 'chai'
import type { IBootstrapTransport, BootstrapRedemptionResult } from '../src/bootstrap/bootstrap-transport.js'
import { FilesystemBootstrapTransport } from '../src/bootstrap/filesystem-bootstrap-transport.js'
import { RestBootstrapTransport } from '../src/bootstrap/rest-bootstrap-transport.js'
import { deriveBootstrapKeys, sealPayload, unsealPayload } from '../src/bootstrap/sealed-payload.js'
import type { BootstrapKeySplit, SealedPayload } from '../src/bootstrap/sealed-payload.js'
import { parseSnapshot } from '../src/bootstrap/snapshot-codec.js'
import { buildSnapshot, verifySnapshot } from '../src/bootstrap/snapshot-manifest.js'
import type { BootstrapSnapshot, SnapshotTables } from '../src/bootstrap/snapshot-types.js'

// ---------------------------------------------------------------------------
// A. The shared fixture — ONE builder, used by both harnesses, so a
// divergence between the bindings can never hide behind two separate
// fixture constructions.
// ---------------------------------------------------------------------------

/** A distinctive registrant-PII stand-in used nowhere else in this file. */
const PII_MARKER = 'bootstrap-conformance-registrant-pii-marker'

/** Table names present in every fixture snapshot — used by case 6's
 * error-message hygiene check. */
const FIXTURE_TABLE_NAMES = ['User', 'Network'] as const

const FIXTURE_NETWORK_HASH = 'bootstrap-conformance-fixture-network-hash'

const GENERATED_AT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/

function buildFixtureTables (): SnapshotTables {
  return {
    User: [
      { Id: 'fixture-user-1', Name: PII_MARKER, Active: true }
    ],
    Network: [
      { Id: 'fixture-network-1', Hash: 'fixture-network-row-hash-1' },
      { Id: 'fixture-network-2', Hash: 'fixture-network-row-hash-2' }
    ]
  }
}

/** Builds one snapshot envelope through 50-02's own `buildSnapshot`,
 * containing two tables, one row carrying `PII_MARKER`, and a real
 * manifest, digest and schema hash. Called fresh per test so each case
 * starts from an independent envelope, while always going through this one
 * declaration — never two separately-implemented fixtures. */
function buildFixtureSnapshot (generatedAt?: string): BootstrapSnapshot {
  return buildSnapshot({
    networkHash: FIXTURE_NETWORK_HASH,
    tables: buildFixtureTables(),
    generatedAt
  })
}

/** The fixed 32-hex prefix of every conformance code; the remaining 8 hex
 * digits are the sequence counter, so successive calls differ. */
const CODE_PREFIX_HEX = 'c0de51ec7e57a1b2c3d4e5f60718293a'

let codeSeq = 0
/** A 40-character lowercase-hex code. The SHAPE is fixed, not cosmetic: the
 * REST binding derives the `lookupId` it transmits from these bytes (D-04),
 * and the filesystem binding uses the same string as a path segment. */
function nextCode (): string {
  codeSeq += 1
  return `${CODE_PREFIX_HEX}${codeSeq.toString(16).padStart(8, '0')}`
}

/** A canonical (19-char, no `Z`) datetime strictly in the past. */
function canonicalPast (): string {
  return new Date(Date.now() - 3_600_000).toISOString().slice(0, 19)
}

/** A canonical (19-char, no `Z`) datetime far enough in the future that no
 * conformance run can outlive it. */
function canonicalFuture (): string {
  return new Date(Date.now() + 365 * 86_400_000).toISOString().slice(0, 19)
}

/**
 * The D-04 key split for a conformance code. Hex-decoded with a LOCAL loop
 * rather than a library helper: `@noble/hashes`'s `hexToBytes` embeds two
 * characters of the offending string in its `RangeError`, and the offending
 * string here would be a bearer secret.
 */
function keysForCode (code: string): BootstrapKeySplit {
  const bytes = new Uint8Array(code.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(code.slice(i * 2, i * 2 + 2), 16)
  }
  return deriveBootstrapKeys(bytes)
}

/** Seal an envelope under a code's own `contentKey` — what a producer stages,
 * and what a courier is then given to carry unopened. */
function sealFor (code: string, envelope: BootstrapSnapshot): SealedPayload {
  return sealPayload(JSON.stringify(envelope), keysForCode(code))
}

/**
 * The CONSUMER HALF OF D-06, expressed exactly once: a delivered result
 * carries an unopened wrapper, and only the code's own key turns it back into
 * an envelope. Every case that needs an envelope goes through here, so no
 * case can accidentally assert against something a courier had already
 * opened.
 *
 * `verifySnapshot` is deliberately NOT called here — the order is unseal,
 * then parse, then verify, and the verify step belongs to the individual
 * cases that make a claim about it.
 */
function openDelivered (result: BootstrapRedemptionResult, code: string): BootstrapSnapshot {
  expect(result.sealed, 'a delivered ok result must carry a sealed payload').to.not.equal(undefined)
  const opened = unsealPayload(result.sealed, keysForCode(code))
  expect(
    opened.ok,
    `expected unsealPayload to succeed (reason if failed: ${opened.ok ? '' : opened.reason})`
  ).to.equal(true)
  const plaintext = opened.ok ? opened.plaintext : ''
  const parsed = parseSnapshot(plaintext)
  expect(
    parsed.ok,
    `expected parseSnapshot to succeed on the unsealed plaintext (reason if failed: ${parsed.ok ? '' : parsed.reason})`
  ).to.equal(true)
  if (!parsed.ok) throw new Error('unreachable: parseSnapshot failure already asserted')
  return parsed.envelope
}

// ---------------------------------------------------------------------------
// B. The harness contract — parameterize over construction, not over a bare
// transport, since the two bindings' storage shapes differ entirely
// (on-disk documents vs. an in-memory HTTP fixture).
// ---------------------------------------------------------------------------

interface StageCodeOptions {
  expiresAt: string
  snapshot: BootstrapSnapshot
}

interface ConformanceHarness {
  readonly label: string
  readonly transport: IBootstrapTransport
  /** Stages a code granting `opts.snapshot`. The envelope is SEALED here,
   * inside the factory, under the code's own `contentKey` — so the shared
   * body never has to know how a binding stores things. */
  stageCode: (code: string, opts: StageCodeOptions) => Promise<void>
  /** Mutates a cell value (never the row count, the `digest`, or the
   * `manifest`) of the MOST RECENTLY staged code's snapshot, AT THE SOURCE:
   * unseal, mutate, re-seal, write back — before the courier ever sees it,
   * which is precisely what the tampering case is about. Isolates the digest
   * check: row counts stay consistent so the manifest check still passes, and
   * only the recomputed content digest disagrees with the untouched `digest`
   * field. */
  tamperStagedTableContent: () => Promise<void>
  /** Arranges for the source to fail genuinely (not merely refuse) on the
   * next `redeem` call, and returns the code to redeem to trigger it. */
  makeFailingSource: () => Promise<string>
  close: () => Promise<void>
}

interface ConformanceCase {
  label: string
  mode: 'run'
  make: () => Promise<ConformanceHarness>
}

// ---------------------------------------------------------------------------
// C. Factory 1 — filesystem.
// ---------------------------------------------------------------------------
async function makeFilesystemBinding (): Promise<ConformanceHarness> {
  const rootDir = await mkdtemp(join(tmpdir(), 'bootstrap-conformance-fs-'))
  const codesDir = join(rootDir, 'codes')
  const snapshotsDir = join(rootDir, 'snapshots')
  await mkdir(codesDir, { recursive: true })
  await mkdir(snapshotsDir, { recursive: true })

  const transport = new FilesystemBootstrapTransport({ rootDir })
  let snapshotFileSeq = 0
  let lastSnapshotFile: string | undefined
  let lastStagedCode: string | undefined

  return {
    label: 'filesystem',
    transport,
    async stageCode (code, opts) {
      snapshotFileSeq += 1
      const snapshotFile = `snap-${snapshotFileSeq}`
      // The document on disk is a SEALED WRAPPER, never an envelope — the
      // binding reads it, deserializes it, and carries it unopened.
      await writeFile(join(snapshotsDir, `${snapshotFile}.json`), JSON.stringify(sealFor(code, opts.snapshot)), 'utf8')
      await writeFile(join(codesDir, `${code}.json`), JSON.stringify({ expiresAt: opts.expiresAt, snapshotFile }), 'utf8')
      lastSnapshotFile = snapshotFile
      lastStagedCode = code
    },
    async tamperStagedTableContent () {
      if (lastSnapshotFile === undefined || lastStagedCode === undefined) {
        throw new Error('makeFilesystemBinding.tamperStagedTableContent: no snapshot has been staged yet')
      }
      const filePath = join(snapshotsDir, `${lastSnapshotFile}.json`)
      const keys = keysForCode(lastStagedCode)
      const opened = unsealPayload(JSON.parse(await readFile(filePath, 'utf8')), keys)
      if (!opened.ok) {
        throw new Error(`makeFilesystemBinding.tamperStagedTableContent: staged document would not open (${opened.reason})`)
      }
      const parsed = JSON.parse(opened.plaintext) as { tables: { User: Array<{ Name: string }> } }
      parsed.tables.User[0]!.Name = `${parsed.tables.User[0]!.Name}-tampered`
      // Re-sealed, so what the courier carries is a legitimately sealed
      // payload with mutated content — the tampering happened at the source.
      await writeFile(filePath, JSON.stringify(sealPayload(JSON.stringify(parsed), keys)), 'utf8')
    },
    async makeFailingSource () {
      // A corrupted (not merely absent) granted document is a genuine source
      // fault the binding cannot refuse its way past — it must throw. The
      // code and snapshot-file names below are never derived from or
      // containing one another, so neither leaks into the other's error text.
      const code = nextCode()
      const snapshotFile = 'snap-corrupted'
      await writeFile(join(snapshotsDir, `${snapshotFile}.json`), 'not valid json {{{', 'utf8')
      await writeFile(join(codesDir, `${code}.json`), JSON.stringify({ expiresAt: canonicalFuture(), snapshotFile }), 'utf8')
      return code
    },
    async close () {
      await rm(rootDir, { recursive: true, force: true })
    }
  }
}

// ---------------------------------------------------------------------------
// D. Factory 2 — REST. A throwaway node:http receiver implementing exactly
// the B-1/B-2 wire protocol from the REST binding's own header.
// ---------------------------------------------------------------------------
interface StoredCode {
  expiresAt: string
  sealed: SealedPayload
  redeemed: boolean
}

async function makeRestBinding (): Promise<ConformanceHarness> {
  // KEYED BY `lookupId`, NEVER BY THE RAW CODE. The stand-in must model what
  // the real rendezvous service will see: the binding transmits only the
  // derived lookup half (D-04/D-10), so a receiver that could find a record
  // by raw secret would be modelling a protocol this phase forbids.
  const codes = new Map<string, StoredCode>()
  let lastStagedCode: string | undefined
  let forceFailure = false

  const send = (res: ServerResponse, status: number, body: unknown): void => {
    const json = JSON.stringify(body)
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(json)
  }

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      if (forceFailure) {
        send(res, 500, { error: 'forced conformance-harness failure' })
        return
      }

      const rawBody = Buffer.concat(chunks).toString('utf8')
      let parsedBody: unknown
      if (rawBody.length > 0) {
        try {
          parsedBody = JSON.parse(rawBody)
        } catch {
          parsedBody = undefined
        }
      }
      const method = req.method ?? 'GET'
      const url = req.url ?? '/'

      if (method === 'POST' && url === '/bootstrap/redemptions') {
        const body = parsedBody as { lookupId?: unknown }
        const lookupId = typeof body.lookupId === 'string' ? body.lookupId : ''
        const record = codes.get(lookupId)
        if (record === undefined) {
          send(res, 200, { status: 'unknown' })
          return
        }
        const nowCanonical = new Date().toISOString().slice(0, 19)
        if (!(record.expiresAt > nowCanonical)) {
          send(res, 200, { status: 'expired' })
          return
        }
        if (record.redeemed) {
          send(res, 200, { status: 'used' })
          return
        }
        record.redeemed = true
        send(res, 200, { status: 'ok', sealed: record.sealed })
        return
      }

      send(res, 404, { error: 'not found' })
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    // Ephemeral listen(0) only — never a fixed port.
    server.listen(0, '127.0.0.1', () => resolve())
  })

  const address = server.address() as AddressInfo
  const baseUrl = `http://127.0.0.1:${address.port}`
  // No fetchImpl override — the real global fetch is exercised against the
  // real socket above.
  const transport = new RestBootstrapTransport({ baseUrl })

  return {
    label: 'rest',
    transport,
    async stageCode (code, opts) {
      codes.set(keysForCode(code).lookupId, {
        expiresAt: opts.expiresAt,
        sealed: sealFor(code, opts.snapshot),
        redeemed: false
      })
      lastStagedCode = code
    },
    async tamperStagedTableContent () {
      if (lastStagedCode === undefined) {
        throw new Error('makeRestBinding.tamperStagedTableContent: no snapshot has been staged yet')
      }
      const keys = keysForCode(lastStagedCode)
      const record = codes.get(keys.lookupId)
      if (record === undefined) {
        throw new Error('makeRestBinding.tamperStagedTableContent: staged code record is missing')
      }
      const opened = unsealPayload(record.sealed, keys)
      if (!opened.ok) {
        throw new Error(`makeRestBinding.tamperStagedTableContent: staged payload would not open (${opened.reason})`)
      }
      const parsed = JSON.parse(opened.plaintext) as { tables: { User: Array<{ Name: string }> } }
      parsed.tables.User[0]!.Name = `${parsed.tables.User[0]!.Name}-tampered`
      record.sealed = sealPayload(JSON.stringify(parsed), keys)
    },
    async makeFailingSource () {
      forceFailure = true
      return nextCode()
    },
    async close () {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err !== undefined ? reject(err) : resolve()))
      })
    }
  }
}

// ---------------------------------------------------------------------------
// E. The binding table — two entries, both running. No reserved slot.
// ---------------------------------------------------------------------------
const CONFORMANCE_BINDINGS: ConformanceCase[] = [
  { label: 'filesystem', mode: 'run', make: makeFilesystemBinding },
  { label: 'rest', mode: 'run', make: makeRestBinding }
]

// ---------------------------------------------------------------------------
// F. The shared body — declared once, inside sentinels.
// ---------------------------------------------------------------------------
// #region SHARED-CONFORMANCE-BODY
export function runBootstrapTransportConformance (testCase: ConformanceCase): void {
  describe('bootstrap transport conformance: ' + testCase.label, () => {
    let binding: ConformanceHarness

    beforeEach(async () => {
      // Construction happens HERE, never at describe-registration time.
      binding = await testCase.make()
    })

    afterEach(async () => {
      await binding.close()
    })

    // "Verbatim" is now a STRONGER claim than it was: the envelope is sealed
    // at the source, carried by a courier that never opens it, and unsealed
    // here — so equality below proves it survived sealing AND couriering
    // unchanged, not merely that a courier copied an object.
    it('redeems a staged code and couriers the sealed envelope through verbatim', async () => {
      const code = nextCode()
      const snapshot = buildFixtureSnapshot()
      await binding.stageCode(code, { expiresAt: canonicalFuture(), snapshot })

      const result = await binding.transport.redeem(code)
      expect(result.status).to.equal('ok')
      const delivered = openDelivered(result, code)
      expect(delivered.networkHash).to.equal(snapshot.networkHash)
      expect(delivered.schemaHash).to.equal(snapshot.schemaHash)
      expect(delivered.generatedAt).to.equal(snapshot.generatedAt)
      expect(delivered.manifest).to.deep.equal(snapshot.manifest)
      expect(delivered.digest).to.equal(snapshot.digest)
      expect(GENERATED_AT_PATTERN.test(delivered.generatedAt)).to.equal(true)

      const verified = verifySnapshot(delivered)
      expect(
        verified.ok,
        `expected verifySnapshot to succeed (reason if failed: ${verified.ok ? '' : verified.reason})`
      ).to.equal(true)
    })

    it('refuses a second redemption of the same code as used, carrying no data', async () => {
      const code = nextCode()
      const snapshot = buildFixtureSnapshot()
      await binding.stageCode(code, { expiresAt: canonicalFuture(), snapshot })

      // Positive control: the first redemption succeeds.
      const first = await binding.transport.redeem(code)
      expect(first.status).to.equal('ok')

      // A cheap, permanent D-04 canary: what the courier carried is a
      // WRAPPER, with exactly the three wrapper members and nothing else. An
      // envelope leaking back into this slot — or a binding "helpfully"
      // annotating the wrapper — fails here immediately.
      expect(Object.keys(first.sealed as unknown as Record<string, unknown>).sort()).to.deep.equal([
        'ciphertext',
        'nonce',
        'v'
      ])

      const second = await binding.transport.redeem(code)
      expect(second.status).to.equal('used')
      expect(second.sealed).to.equal(undefined)
    })

    it('refuses expired and unknown codes with their own distinguishable reasons, alongside a fresh success', async () => {
      const expiredCode = nextCode()
      await binding.stageCode(expiredCode, { expiresAt: canonicalPast(), snapshot: buildFixtureSnapshot() })
      const expiredResult = await binding.transport.redeem(expiredCode)
      expect(expiredResult.status).to.equal('expired')
      expect(expiredResult.sealed).to.equal(undefined)

      const unknownCode = nextCode() // never staged
      const unknownResult = await binding.transport.redeem(unknownCode)
      expect(unknownResult.status).to.equal('unknown')
      expect(unknownResult.sealed).to.equal(undefined)

      expect(expiredResult.status).to.not.equal(unknownResult.status)

      // Positive control in the same test: a freshly staged code still succeeds.
      const freshCode = nextCode()
      const freshSnapshot = buildFixtureSnapshot()
      await binding.stageCode(freshCode, { expiresAt: canonicalFuture(), snapshot: freshSnapshot })
      const freshResult = await binding.transport.redeem(freshCode)
      expect(freshResult.status).to.equal('ok')
      expect(openDelivered(freshResult, freshCode)).to.deep.equal(freshSnapshot)
    })

    it('delivers a tampered payload unchanged and stays detectable, without laundering it', async () => {
      const code = nextCode()
      const snapshot = buildFixtureSnapshot()
      await binding.stageCode(code, { expiresAt: canonicalFuture(), snapshot })

      await binding.tamperStagedTableContent()

      const result = await binding.transport.redeem(code)
      expect(result.status).to.equal('ok')
      const delivered = openDelivered(result, code)
      // The binding did not recompute the digest over the mutated content.
      expect(delivered.digest).to.equal(snapshot.digest)

      const verified = verifySnapshot(delivered)
      expect(verified.ok, 'a tampered snapshot must fail verifySnapshot').to.equal(false)
      expect(verified.ok ? '' : verified.reason).to.equal('digest-mismatch')

      // Positive control: an untampered redemption from the same harness verifies clean.
      const cleanCode = nextCode()
      const cleanSnapshot = buildFixtureSnapshot()
      await binding.stageCode(cleanCode, { expiresAt: canonicalFuture(), snapshot: cleanSnapshot })
      const cleanResult = await binding.transport.redeem(cleanCode)
      const cleanVerified = verifySnapshot(openDelivered(cleanResult, cleanCode))
      expect(cleanVerified.ok, 'an untampered redemption must verify clean').to.equal(true)
    })

    it('leaks neither the bearer code nor snapshot content in a source-failure error message', async () => {
      const goodCode = nextCode()
      await binding.stageCode(goodCode, { expiresAt: canonicalFuture(), snapshot: buildFixtureSnapshot() })
      // Positive control: the harness succeeds before the source is broken.
      const positiveControl = await binding.transport.redeem(goodCode)
      expect(positiveControl.status).to.equal('ok')

      const failingCode = await binding.makeFailingSource()
      let thrown: Error | undefined
      try {
        await binding.transport.redeem(failingCode)
      } catch (err) {
        thrown = err instanceof Error ? err : new Error(String(err))
      }
      expect(thrown, 'expected the broken source to cause redeem to throw').to.not.equal(undefined)

      const message = thrown!.message
      expect(message.length).to.be.greaterThan(0)
      expect(message.includes(failingCode)).to.equal(false)
      expect(message.includes(PII_MARKER)).to.equal(false)
      for (const tableName of FIXTURE_TABLE_NAMES) {
        expect(message.includes(tableName)).to.equal(false)
      }
    })
  })
}
// #endregion SHARED-CONFORMANCE-BODY

for (const testCase of CONFORMANCE_BINDINGS) runBootstrapTransportConformance(testCase)

// ---------------------------------------------------------------------------
// G. Structural self-tests. These read THIS FILE's own source text (and, for
// the fourth gate, the barrel's source), so the properties that make this
// suite meaningful — the body is shared, no third slot exists, and both
// bindings route through one fixture and one envelope declaration — are
// permanent regression tests rather than paragraphs someone has to
// remember to read.
// ---------------------------------------------------------------------------
function findRepoRoot (startDir: string): string {
  let dir = startDir
  for (let i = 0; i < 64; i++) {
    if (existsSync(join(dir, 'package.json')) && existsSync(join(dir, '.git'))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  throw new Error('findRepoRoot: reached the filesystem root without finding a directory containing both package.json and .git')
}

const REPO_ROOT = findRepoRoot(process.cwd())
const THIS_FILE_PATH = join(REPO_ROOT, 'packages', 'vote-engine', 'test', 'bootstrap-transport-conformance.spec.ts')
const BARREL_SOURCE_PATH = join(REPO_ROOT, 'packages', 'vote-engine', 'src', 'bootstrap', 'index.ts')

// These gates read THIS FILE's own source text, so every marker string is
// built via concatenation rather than written as one contiguous literal —
// otherwise the gate's own source line would itself count as an extra
// occurrence of the marker it is trying to count.
const REGION_START_MARKER = '// #' + 'region SHARED-CONFORMANCE-BODY'
const REGION_END_MARKER = '// #' + 'endregion SHARED-CONFORMANCE-BODY'
const CONFORMANCE_FN_NAME = 'runBootstrapTransportConf' + 'ormance'
const BUILD_FIXTURE_FN_DECLARATION_TEXT = 'function ' + 'buildFixtureSnapshot'
const VOTE_ENGINE_BARREL_SPECIFIER = '@votetorrent' + '/vote-engine'
const FORBIDDEN_PEER_CLUSTER_TERMS = [
  'p' + '2p',
  'Cadre' + 'Node',
  'str' + 'and',
  'optimys' + 'tic',
  'db-' + 'p' + '2p'
]

describe('bootstrap transport conformance: structure', () => {
  const thisFileSource = readFileSync(THIS_FILE_PATH, 'utf8')

  it('declares the conformance body exactly once and shares it across every binding', () => {
    const start = thisFileSource.indexOf(REGION_START_MARKER)
    const end = thisFileSource.indexOf(REGION_END_MARKER)
    expect(start).to.be.greaterThan(-1)
    expect(end).to.be.greaterThan(start)
    expect(thisFileSource.split(REGION_START_MARKER).length - 1).to.equal(1)
    expect(thisFileSource.split(REGION_END_MARKER).length - 1).to.equal(1)

    const region = thisFileSource.slice(start, end)
    expect((region.match(/\bit\s*\(/g) ?? []).length).to.equal(5)
    expect(thisFileSource.split(CONFORMANCE_FN_NAME).length - 1).to.equal(2)

    expect(/testCase\.label\s*===/.test(region)).to.equal(false)
    expect(/label\s*===\s*'filesystem'/.test(region)).to.equal(false)
    expect(/label\s*===\s*'rest'/.test(region)).to.equal(false)
    expect(/instanceof\s+(FilesystemBootstrapTransport|RestBootstrapTransport)/.test(region)).to.equal(false)
  })

  it('carries no reserved third slot and no skips', () => {
    expect((thisFileSource.match(/describe\.skip/g) ?? []).length).to.equal(0)
    expect((thisFileSource.match(/\bit\.skip\s*\(/g) ?? []).length).to.equal(0)
    expect((thisFileSource.match(/\.only\(/g) ?? []).length).to.equal(0)

    // Scoped to the binding-table array literal itself (not the
    // `ConformanceCase` interface's own `mode: 'run'` field-type
    // declaration, which would otherwise be a third, spurious match).
    const declStart = thisFileSource.indexOf('const CONFORMANCE_BINDINGS')
    const literalStart = thisFileSource.indexOf('= [', declStart)
    const literalEnd = thisFileSource.indexOf(']', literalStart)
    expect(declStart).to.be.greaterThan(-1)
    expect(literalStart).to.be.greaterThan(declStart)
    expect(literalEnd).to.be.greaterThan(literalStart)
    const tableLiteral = thisFileSource.slice(literalStart, literalEnd)
    expect((tableLiteral.match(/mode:\s*'run'/g) ?? []).length).to.equal(2)
    expect((tableLiteral.match(/mode:\s*'skip'/g) ?? []).length).to.equal(0)
    for (const term of FORBIDDEN_PEER_CLUSTER_TERMS) {
      expect(
        thisFileSource.toLowerCase().includes(term.toLowerCase()),
        `this suite must carry no peer-cluster dependency: found forbidden term ${term}`
      ).to.equal(false)
    }
  })

  it('routes both bindings through one fixture and one envelope declaration', () => {
    expect(thisFileSource.includes("from '../src/bootstrap/filesystem-bootstrap-transport.js'")).to.equal(true)
    expect(thisFileSource.includes("from '../src/bootstrap/rest-bootstrap-transport.js'")).to.equal(true)
    expect(thisFileSource.includes(VOTE_ENGINE_BARREL_SPECIFIER)).to.equal(false)
    expect(thisFileSource.split(BUILD_FIXTURE_FN_DECLARATION_TEXT).length - 1).to.equal(1)

    for (const typeName of ['BootstrapSnapshot', 'SnapshotManifest', 'SnapshotTables']) {
      expect(
        new RegExp(`(interface|type)\\s+${typeName}\\b`).test(thisFileSource),
        `must not re-declare ${typeName} (owned by 50-02's snapshot-types.ts)`
      ).to.equal(false)
    }
  })

  it('proves the filesystem binding is barrel-excluded', () => {
    const barrelSource = readFileSync(BARREL_SOURCE_PATH, 'utf8')
    const barrelCode = barrelSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    expect(barrelCode.includes('filesystem-bootstrap-transport')).to.equal(false)
    expect(barrelCode.includes('node:')).to.equal(false)
  })
})
