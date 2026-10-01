/**
 * two-node-strand.ts — D-24 two-node strand harness.
 *
 * Boots two REAL CadreNodes inside vote-engine (`test/`, never `src/`): node-A, a
 * founder drone, and node-B, a peer it enrols. The bring-up shape (baseConfig +
 * droneOptions, the bring-up order, the enrol() retry loop, the settle gate) is
 * COPIED from `tools/multipeer-gate/lib/topology.mjs` / `ceremony.mjs` /
 * `gate-run.mjs` per D-24. `tools/multipeer-gate` is never imported or extended —
 * this harness is vote-engine's own, independent copy, free to diverge where the
 * 1.9.0 stack requires it (the "Deviations from topology.mjs" section below).
 *
 * Every strand it opens runs the real votetorrent schema
 * (`VOTETORRENT_INNER_DDL`, stripped exactly as `rn-db-factory.ts` strips it) and
 * the real UDFs (`SignatureValid`, `Digest`) via `registerDbPlugins` +
 * `declareViewsInMain` — the same calls production `NetworksEngine.createContext`
 * makes on a strand database.
 *
 * `requireSignedSchemas: false` is a TEST POSTURE, copied verbatim from
 * topology.mjs's `baseConfig`, and is NEVER a production posture — no app config
 * sets it.
 *
 * Relay traversal is explicitly OUT OF SCOPE here: both nodes listen directly on
 * loopback, so nothing in this file exercises circuit-relay addressing. That is
 * P2P-11's concern, not D-24's.
 *
 * Deviations from topology.mjs, re-checked against the installed 1.9.0 stack
 * (D-24 "stack in flux" note):
 *   - `StrandConfig` carries no `mode` field in 1.9.0 (topology.mjs still passes
 *     one; it is silently ignored there). This harness never sets it.
 *   - `initializeSeedBootstrap` is ASYNC in 1.9.0 (handles.mjs's `genesis()` does
 *     not await it) — this harness awaits it.
 *   - Membership is judged from node-A's own `isAuthorizedMember(peerId)` view,
 *     never `listAuthorizedMembers()` filtered for self (that call excludes self
 *     — a documented instrument defect on this stack).
 *
 * P2P packages are reached ONLY through dynamic `import()` inside
 * `startTwoNodeHarness`, so the default (flag-off) suite never loads libp2p.
 */

import type { Database } from '@quereus/quereus'
import { randomUUID } from 'node:crypto'
import { VOTETORRENT_SCHEMA_SQL } from '../../src/database/schema-sql.js'
import { registerDbPlugins, declareViewsInMain } from '../../src/database/initialize.js'
import type { DbFactory } from '../../src/types.js'

// ---------------------------------------------------------------------------
// Flag, describe wrapper
// ---------------------------------------------------------------------------

/** process.env.RUN_P2P_HARNESS === '1' */
export const P2P_HARNESS_ENABLED: boolean = process.env.RUN_P2P_HARNESS === '1'

/** P2P_HARNESS_ENABLED ? describe : describe.skip — consumers wrap their suites in this. */
export const describeP2PHarness: Mocha.SuiteFunction | Mocha.PendingSuiteFunction =
  P2P_HARNESS_ENABLED ? describe : describe.skip

// ---------------------------------------------------------------------------
// Timeouts
// ---------------------------------------------------------------------------

const TIMEOUT_SCALE = Number(process.env.P2P_HARNESS_TIMEOUT_SCALE ?? 1)

function scaled (ms: number): number {
  return Math.round(ms * TIMEOUT_SCALE)
}

/**
 * Measured 2026-10-01 against the sereus 1.9.0 / optimystic 1.8.1 stack on this
 * host (Task 3 of 62-06-PLAN.md tunes these from a >=5-run measurement; see the
 * SUMMARY "Timing" section for the raw numbers). Initial Task 2 defaults, before
 * tuning, are the gate-derived values below. Every value is multiplied by
 * `P2P_HARNESS_TIMEOUT_SCALE` (default 1).
 */
export const HARNESS_TIMEOUTS: Readonly<{
  startMs: number
  meshMs: number
  enrolMs: number
  addStrandMs: number
  writableMs: number
  replicationMs: number
  pollMs: number
  suiteMs: number
}> = Object.freeze({
  startMs: scaled(45_000),
  meshMs: scaled(30_000),
  enrolMs: scaled(30_000),
  addStrandMs: scaled(60_000),
  writableMs: scaled(60_000),
  replicationMs: scaled(60_000),
  pollMs: scaled(500),
  suiteMs: scaled(300_000)
})

// ---------------------------------------------------------------------------
// Schema / sApp constants
// ---------------------------------------------------------------------------

/**
 * VOTETORRENT_SCHEMA_SQL with the outer `declare schema main { ... } apply
 * schema main;` wrapper stripped — the SAME two regexes `rn-db-factory.ts:30-33`
 * uses. cadre-core's `StrandDatabase.executeSchema()` re-wraps the inner DDL as
 * `declare schema App { ... } apply schema App;`; passing the unstripped string
 * would nest invalidly (`got '}'`).
 */
export const VOTETORRENT_INNER_DDL: string = VOTETORRENT_SCHEMA_SQL
  .replace(/^\s*declare\s+schema\s+\w+\s*\{/, '')
  .replace(/\}\s*apply\s+schema\s+\w+\s*;\s*$/, '')
  .trim()

/** 'org.votetorrent' — the same sApp id rn-db-factory.ts uses. */
export const HARNESS_SAPP_ID = 'org.votetorrent'

// ---------------------------------------------------------------------------
// Public types (LOCKED — see 62-06-PLAN.md <interfaces>)
// ---------------------------------------------------------------------------

/** Structurally identical to RegistrationStrandPort and AssociationStrandPort. */
export interface HarnessStrandPort {
  query<T>(sql: string, params: Record<string, unknown>): Promise<T[]>
  mutate(sql: string, params: Record<string, unknown>): Promise<void>
  close(): Promise<void>
}

export interface HarnessNode {
  readonly name: 'node-A' | 'node-B'
  readonly role: 'founder-drone' | 'peer'
  readonly peerId: string
  /** escape hatch (typed loosely: the instance of the dynamically imported CadreNode) */
  readonly node: any
  /** rn-db-factory semantics: addStrand(strandId = networkHash) + whenStrandWritable + setSchemaPath(['App','main']); NO plugin registration (the engine does that). Memoized per strandId. */
  readonly dbFactory: DbFactory
  /** dbFactory + registerDbPlugins + declareViewsInMain, memoized per strandId — the engine-free handle. */
  openStrand(strandId: string): Promise<Database>
  /** port over openStrand(strandId); every call increments stats */
  strandPort(strandId: string): Promise<HarnessStrandPort>
  /** counts of port calls made THROUGH THIS NODE — the writer-identity tripwire */
  readonly stats: { mutateCount: number; queryCount: number }
}

export interface HarnessTimings {
  startAMs: number
  genesisMs: number
  startBMs: number
  meshMs: number
  enrolMs: number
  strandOpenMs: Record<string, { aMs?: number; bMs?: number }>
}

export interface TwoNodeHarness {
  readonly runId: string
  readonly partyId: string
  readonly nodeA: HarnessNode
  readonly nodeB: HarnessNode
  /** opens strandId on node-A, then on node-B. Default strandId: `vt-harness-${runId}` */
  openSharedStrand (strandId?: string): Promise<{
    strandId: string
    dbA: Database
    dbB: Database
    portA: HarnessStrandPort
    portB: HarnessStrandPort
  }>
  readonly timings: HarnessTimings
  /** stops node-B then node-A; idempotent; never throws (logs instead) */
  stop (): Promise<void>
}

export interface TwoNodeHarnessOptions {
  partyId?: string
  clusterSize?: number
  log?: (line: string) => void
}

// ---------------------------------------------------------------------------
// pollUntil
// ---------------------------------------------------------------------------

/**
 * Polls read() every opts.intervalMs (default HARNESS_TIMEOUTS.pollMs) until
 * done(value); throws Error(`${label} timed out after ${timeoutMs}ms;
 * last=${JSON.stringify(last)}`) on timeout.
 */
export async function pollUntil<T> (
  read: () => Promise<T>,
  done: (v: T) => boolean,
  opts: { timeoutMs: number; intervalMs?: number; label: string }
): Promise<T> {
  const intervalMs = opts.intervalMs ?? HARNESS_TIMEOUTS.pollMs
  const deadline = Date.now() + opts.timeoutMs
  let last: T
  for (;;) {
    last = await read()
    if (done(last)) return last
    if (Date.now() >= deadline) {
      throw new Error(`${opts.label} timed out after ${opts.timeoutMs}ms; last=${JSON.stringify(last)}`)
    }
    await new Promise<void>((resolve) => setTimeout(resolve, intervalMs))
  }
}

// ---------------------------------------------------------------------------
// Internal: node bring-up
// ---------------------------------------------------------------------------

/** Pick a loopback websocket address — the gate-run.mjs `loopbackWs` rule. */
function loopbackWs (addrs: string[]): string {
  return addrs.find((a) => a.includes('/ip4/127.0.0.1/') && a.includes('/ws')) ?? addrs[0] ?? ''
}

class MeshTimeoutError extends Error {}

/**
 * One attempt at the full bring-up sequence, at a given pair of listen
 * addresses. Throws MeshTimeoutError if the control mesh never forms within
 * meshMs — the caller decides whether to retry with a different listen address.
 * Any other failure is fatal (both nodes are stopped before the throw).
 */
async function attemptBringUp (
  listenAddrs: string[],
  opts: { partyId: string; clusterSize: number; log: (line: string) => void }
): Promise<{
  nodeA: any
  nodeB: any
  timings: HarnessTimings
}> {
  const { partyId, clusterSize, log } = opts

  const { CadreNode } = await import('@serfab/cadre-core')
  const { MemoryRawStorage } = await import('@optimystic/db-p2p')
  const { webSockets } = await import('@libp2p/websockets')
  const { generateKeyPair } = await import('@libp2p/crypto/keys')

  const timings: HarnessTimings = {
    startAMs: 0,
    genesisMs: 0,
    startBMs: 0,
    meshMs: 0,
    enrolMs: 0,
    strandOpenMs: {}
  }

  function buildConfig (bootstrapNodes: string[], privateKey: unknown): any {
    const storage = new MemoryRawStorage()
    return {
      privateKey,
      controlNetwork: { partyId, bootstrapNodes },
      // Test posture only (topology.mjs baseConfig) — never a production config.
      requireSignedSchemas: false,
      strandFilter: { mode: 'all' },
      storage: { provider: () => storage },
      strandClusterSize: clusterSize,
      hibernation: { enabled: false },
      profile: 'storage',
      network: { transports: [webSockets()], listenAddrs }
    }
  }

  let nodeA: any
  let nodeB: any

  try {
    // --- 1. Start node-A, bounded by startMs. ---
    const t0 = Date.now()
    const privateKeyA = await generateKeyPair('Ed25519')
    nodeA = new CadreNode(buildConfig([], privateKeyA))
    await withTimeout(nodeA.start(), HARNESS_TIMEOUTS.startMs, 'node-A start')
    timings.startAMs = Date.now() - t0

    // --- 2. Owner genesis on node-A while it is STILL SOLO (handles.mjs genesis()). ---
    const t1 = Date.now()
    const owner = nodeA.getIdentityOwnerKey()
    await nodeA.trustOwnerKeys([owner.publicKeyB64], 'operator')
    const controlDb = nodeA.getControlDatabase()
    if (!controlDb) throw new Error('two-node harness: no control database after node-A start()')
    await controlDb.ensureOwnerKey(owner.publicKeyB64)
    // 1.9.0: initializeSeedBootstrap is ASYNC — awaited (D-24 re-checked workaround).
    await nodeA.initializeSeedBootstrap(owner.privateKeyB64)
    timings.genesisMs = Date.now() - t1

    // --- 3. Start node-B, bootstrapped to node-A's loopback websocket address. ---
    const t2 = Date.now()
    const nodeAAddr = loopbackWs((nodeA.getControlNode()?.getMultiaddrs() ?? []).map((m: any) => m.toString()))
    const privateKeyB = await generateKeyPair('Ed25519')
    nodeB = new CadreNode(buildConfig([nodeAAddr], privateKeyB))
    await withTimeout(nodeB.start(), HARNESS_TIMEOUTS.startMs, 'node-B start')
    timings.startBMs = Date.now() - t2

    // --- 4. Settle: poll until both nodes have >= 1 connection, then grace 3000ms. ---
    const t3 = Date.now()
    const settled = await pollSettle(nodeA, nodeB, HARNESS_TIMEOUTS.meshMs)
    if (!settled) {
      throw new MeshTimeoutError(`control mesh did not settle within ${HARNESS_TIMEOUTS.meshMs}ms on listen ${listenAddrs.join(',')}`)
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 3000))
    timings.meshMs = Date.now() - t3

    // --- 5. Enrol node-B (ceremony.mjs enrol(), up to 5 attempts, linear backoff). ---
    const t4 = Date.now()
    await enrolNodeB(nodeA, nodeB, log)
    const memberNow = await nodeA.isAuthorizedMember(nodeB.peerId.toString())
    if (!memberNow) {
      throw new Error('two-node harness: node-B is not an authorized member after enrolment attempts')
    }
    timings.enrolMs = Date.now() - t4

    return { nodeA, nodeB, timings }
  } catch (error) {
    // Any failure (including MeshTimeoutError) stops whatever nodes started.
    await stopQuietly(nodeB, log)
    await stopQuietly(nodeA, log)
    throw error
  }
}

async function pollSettle (nodeA: any, nodeB: any, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const aConns = (nodeA.getControlNode()?.getConnections() ?? []).length
    const bConns = (nodeB.getControlNode()?.getConnections() ?? []).length
    if (aConns >= 1 && bConns >= 1) return true
    if (Date.now() >= deadline) return false
    await new Promise<void>((resolve) => setTimeout(resolve, 500))
  }
}

async function enrolNodeB (nodeA: any, nodeB: any, log: (line: string) => void): Promise<void> {
  const peerId = nodeB.peerId.toString()
  const attempts = 5
  let lastErr: unknown = null
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const before = await nodeA.isAuthorizedMember(peerId)
      if (before === true) { lastErr = null; break }
    } catch (e) {
      log(`membership read before attempt ${attempt} failed: ${(e as Error)?.message ?? e}`)
    }

    try {
      const { encodedInvite } = await withTimeout<any>(nodeA.createInvite(), HARNESS_TIMEOUTS.enrolMs, 'node-A createInvite')
      await withTimeout(nodeB.dialInvite(nodeB.decodeInvite(encodedInvite)), HARNESS_TIMEOUTS.enrolMs, 'node-B dialInvite')
      try {
        await nodeA.acceptPhone({ phonePeerId: peerId }, nodeA.decodeInvite(encodedInvite))
      } catch (e) {
        log(`node-A acceptPhone attempt ${attempt} logged (non-fatal): ${(e as Error)?.message ?? e}`)
      }
      log(`enrol ceremony ran (attempt ${attempt})`)
    } catch (e) {
      lastErr = e
      log(`enrol ceremony attempt ${attempt}/${attempts} failed: ${(e as Error)?.message ?? e}`)
    }

    try {
      const settled = await nodeA.isAuthorizedMember(peerId)
      if (settled === true) { lastErr = null; break }
    } catch (e) {
      log(`membership read after attempt ${attempt} failed: ${(e as Error)?.message ?? e}`)
    }

    await new Promise<void>((resolve) => setTimeout(resolve, 2000 * attempt))
  }
  if (lastErr) {
    throw new Error(`two-node harness: node-B did not enrol after ${attempts} attempt(s): ${(lastErr as Error)?.message ?? lastErr}`)
  }
}

async function withTimeout<T> (p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
  })
  try {
    return await Promise.race([p, timeout])
  } finally {
    clearTimeout(timer!)
  }
}

async function stopQuietly (node: any, log: (line: string) => void): Promise<void> {
  if (!node) return
  try {
    await node.stop()
  } catch (e) {
    log(`stop() failed (ignored): ${(e as Error)?.message ?? e}`)
  }
}

// ---------------------------------------------------------------------------
// Internal: strand open / port
// ---------------------------------------------------------------------------

function buildHarnessNode (
  name: 'node-A' | 'node-B',
  role: 'founder-drone' | 'peer',
  node: any,
  isNodeA: boolean,
  openedByA: Set<string>,
  timings: HarnessTimings,
  log: (line: string) => void
): HarnessNode {
  const dbFactoryCache = new Map<string, Promise<Database>>()
  const openStrandCache = new Map<string, Promise<Database>>()
  const stats = { mutateCount: 0, queryCount: 0 }

  function assertOrdering (strandId: string): void {
    if (!isNodeA && !openedByA.has(strandId)) {
      throw new Error(`two-node harness: open strand ${strandId} on node-A (founder) before node-B`)
    }
  }

  async function rawOpen (strandId: string): Promise<Database> {
    const started = Date.now()
    const addStrandConfig: any = {
      strandRow: { Id: strandId, MemberPrivateKey: null, Type: 'o', FounderOwnerKey: null },
      sAppConfig: { id: HARNESS_SAPP_ID, version: '1.0.0', schema: VOTETORRENT_INNER_DDL, latencyHint: 'interactive' },
      // awaitFirstSync: false — mirrors topology.mjs strandConfig(): cadre-core >= 1.1.0
      // defaults a JOINER's addStrand to block on first sync; opting out lets the strand
      // launch immediately and this harness awaits whenStrandWritable itself.
      awaitFirstSync: false
    }
    if (isNodeA) addStrandConfig.founder = true

    await withTimeout(node.addStrand(addStrandConfig), HARNESS_TIMEOUTS.addStrandMs, `${name} addStrand(${strandId})`)
    await node.whenStrandWritable(strandId, { timeoutMs: HARNESS_TIMEOUTS.writableMs })
    const strand = node.getStrand(strandId)
    const db: Database = strand.database.getDatabase()
    db.setSchemaPath(['App', 'main'])

    const elapsed = Date.now() - started
    const entry = timings.strandOpenMs[strandId] ?? {}
    if (isNodeA) entry.aMs = elapsed
    else entry.bMs = elapsed
    timings.strandOpenMs[strandId] = entry

    return db
  }

  const dbFactory: DbFactory = async (strandId: string) => {
    assertOrdering(strandId)
    let p = dbFactoryCache.get(strandId)
    if (!p) {
      if (isNodeA) openedByA.add(strandId)
      p = rawOpen(strandId)
      dbFactoryCache.set(strandId, p)
    }
    return p
  }

  async function openStrand (strandId: string): Promise<Database> {
    assertOrdering(strandId)
    let p = openStrandCache.get(strandId)
    if (!p) {
      if (isNodeA) openedByA.add(strandId)
      p = (async () => {
        const db = await dbFactory(strandId)
        await registerDbPlugins(db)
        await declareViewsInMain(db)
        return db
      })()
      openStrandCache.set(strandId, p)
    }
    return p
  }

  async function strandPort (strandId: string): Promise<HarnessStrandPort> {
    const db = await openStrand(strandId)
    return {
      async query<T> (sql: string, params: Record<string, unknown>): Promise<T[]> {
        stats.queryCount++
        const rows: T[] = []
        for await (const row of db.eval(sql, params as any)) {
          rows.push(row as unknown as T)
        }
        return rows
      },
      async mutate (sql: string, params: Record<string, unknown>): Promise<void> {
        stats.mutateCount++
        await db.exec(sql, params as any)
      },
      async close (): Promise<void> {
        // NEVER closes the shared strand — no-op by design.
      }
    }
  }

  return {
    name,
    role,
    peerId: node.peerId.toString(),
    node,
    dbFactory,
    openStrand,
    strandPort,
    stats
  }
}

// ---------------------------------------------------------------------------
// startTwoNodeHarness
// ---------------------------------------------------------------------------

/**
 * Boots node-A, runs owner genesis while A is solo, boots node-B bootstrapped to
 * A, enrols B, waits until nodeA.node.isAuthorizedMember(B.peerId) === true.
 * Opens NO strand. Throws (after stopping both nodes) on any failure.
 */
export async function startTwoNodeHarness (options: TwoNodeHarnessOptions = {}): Promise<TwoNodeHarness> {
  const runId = randomUUID().slice(0, 8)
  const partyId = options.partyId ?? `vote-engine-p2p-harness-${runId}`
  const clusterSize = options.clusterSize ?? 2
  const log = options.log ?? ((line: string) => console.log(`[p2p-harness] ${line}`))

  let built: { nodeA: any; nodeB: any; timings: HarnessTimings }
  try {
    built = await attemptBringUp(['/ip4/127.0.0.1/tcp/0/ws'], { partyId, clusterSize, log })
  } catch (error) {
    if (error instanceof MeshTimeoutError) {
      log(`DEVIATION: control mesh did not settle on 127.0.0.1 (${(error as Error).message}); falling back to 0.0.0.0 per topology.mjs`)
      built = await attemptBringUp(['/ip4/0.0.0.0/tcp/0/ws'], { partyId, clusterSize, log })
    } else {
      throw error
    }
  }

  const { nodeA, nodeB, timings } = built
  const openedByA = new Set<string>()

  const harnessNodeA = buildHarnessNode('node-A', 'founder-drone', nodeA, true, openedByA, timings, log)
  const harnessNodeB = buildHarnessNode('node-B', 'peer', nodeB, false, openedByA, timings, log)

  let stopped = false

  return {
    runId,
    partyId,
    nodeA: harnessNodeA,
    nodeB: harnessNodeB,
    timings,
    async openSharedStrand (strandId: string = `vt-harness-${runId}`) {
      const dbA = await harnessNodeA.openStrand(strandId)
      const dbB = await harnessNodeB.openStrand(strandId)
      const portA = await harnessNodeA.strandPort(strandId)
      const portB = await harnessNodeB.strandPort(strandId)
      return { strandId, dbA, dbB, portA, portB }
    },
    async stop () {
      if (stopped) return
      stopped = true
      await stopQuietly(nodeB, log)
      await stopQuietly(nodeA, log)
    }
  }
}
