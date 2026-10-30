// pool-agent.ts — one voter's side of doc/election.md "Pool Merging" (present / merge / inform /
// form), as built and measured in spike 102, with the decisions taken after it:
//
//   * Votes are encrypted to the election key BEFORE they join a pool (user decision): the voter
//     who forms a block holds ciphertexts only. It still learns which member handed it which
//     ciphertext, so it can read the link once the key is released — accepted.
//   * Every message goes through the authority's rendezvous as a sealed envelope (user decision):
//     voters only dial out, so a voter that nobody can dial still pools. The rendezvous reads no
//     body (pool-envelope.ts).
//   * A block never forms below `minSize` (user decision: 3). A pool still too small keeps
//     presenting and merging; the vote stays on the phone, not sent, until a pool forms or voting
//     closes (`deadlineAt`).
//   * "No ack" is not "drop" on the first miss (spike 102 finding 4): an inform is retried
//     `informAttempts` times before the member is dropped from the pool.
//   * A member signs only after checkFormedPoolBlock passes; one refusal or silence drops that
//     member and the rest carry on (the doc reverts the whole merge; spike 102's deviation kept).
//   * A member the commit names as already voted is dropped and the rest re-form (or keep
//     presenting below the minimum); it is not a whole-pool revert to solo.
//   * Discovery goes through a `PoolDiscovery` (the Authority rendezvous by default). A coordinator
//     climbs from a 2-bit and a 1-bit pool-hash bucket topic to the plain topic, per doc/election.md
//     "Pool Merging". That is client-side only: the server keys opaque topics. The plain topic is
//     reached within min(15 s, quietMs) and before the deadline's form lead, and a pool forms on the
//     quiet rule only after one quiet window on the plain topic. The parameters are ASSUMED (D-23).
//   * Pools order strictly by (size desc, peer id asc), so two coordinators never merge into each
//     other at once.
//
// The agent owns no database and no device key: `signConsent` (the device key, a biometric prompt
// on Android) and `commit` (one transaction, pool-block.ts `commitPoolBlock`) are handed in.

import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js'
import { verifySigP256 } from '../database/initialize.js'
import { openPoolEnvelope, sealPoolEnvelope, ed25519PublicKeyFromPeerId, type PoolIdentity } from './pool-envelope.js'
import { poolRequests, type PoolRendezvousClient, type CoordinatorListing, type RendezvousReply } from './pool-rendezvous.js'
import {
  checkFormedPoolBlock,
  consentDigest,
  formPoolBlock,
  poolTopic,
  type ConsentSignature,
  type FormedPoolBlock,
  type PoolBallot,
  type PoolCommitResult,
  type PoolContribution
} from './pool-block.js'
import {
  rendezvousDiscovery,
  ladderTopic,
  POOL_LADDER_RUNG_BITS,
  POOL_LADDER_DWELL_PRESENTS,
  POOL_LADDER_MAX_MS,
  type PoolDiscovery
} from './pool-discovery.js'

export const POOL_MIN_BLOCK_SIZE = 3

export interface PoolAgentOptions {
  identity: PoolIdentity
  rendezvous: PoolRendezvousClient
  ballot: PoolBallot
  /** this voter's sealed vote and signed voter entry; `member` must be `identity.peerId` */
  contribution: PoolContribution
  /** sign a consent digest with the voting key (Association.DeviceKey); returns compact low-S hex */
  signConsent: (digest: string) => Promise<string>
  /** write the block and its voter rows in one transaction */
  commit: (block: FormedPoolBlock, signatures: ConsentSignature[]) => Promise<PoolCommitResult>
  /**
   * The cid of the block this voter's vote is already recorded in (its replicated VoteBlockVoter
   * row), or null. Checked before pooling and again whenever this voter has signed a block, so a
   * vote whose `committed` outcome was lost is never pooled twice.
   */
  findRecordedVote?: () => Promise<string | null>
  /** smallest block this agent will form (never below POOL_MIN_BLOCK_SIZE) */
  minSize?: number
  /** a pool this big forms at once */
  capacity?: number
  /** a pool at or above minSize forms after this long without growing */
  quietMs?: number
  /** how often a coordinator re-presents and looks for a bigger pool */
  presentIntervalMs?: number
  /** wait for one reply (merged / ack) */
  replyTimeoutMs?: number
  /** inform attempts before a member counts as silent */
  informAttempts?: number
  /** wait for a member's signature (covers a biometric prompt) */
  signTimeoutMs?: number
  /** a member that hears nothing from its coordinator for this long goes back to pooling alone */
  memberTimeoutMs?: number
  /** held-poll length at the rendezvous */
  pollWaitMs?: number
  /** voting closes: stop (vote unsent) at this time; a pool at minSize forms `formLeadMs` before */
  deadlineAt?: number
  formLeadMs?: number
  /** how this coordinator finds others; default `rendezvousDiscovery(rendezvous, identity)`. `rendezvous` still carries the mailbox. */
  discovery?: PoolDiscovery
  /** the specific-then-general topic ladder (doc/election.md "Pool Merging"); default true. false presents only on the plain topic. */
  ladder?: boolean
  /** successful presents per rung before widening is considered (default POOL_LADDER_DWELL_PRESENTS) */
  rungDwellTicks?: number
  /** the plain topic is reached at most this long after run() starts (default min(POOL_LADDER_MAX_MS, quietMs), clamped to POOL_LADDER_MAX_MS) */
  ladderMaxMs?: number
  now?: () => number
  log?: (event: string, detail?: Record<string, unknown>) => void
  onStatus?: (status: PoolAgentStatus) => void
}

export type PoolAgentStatus =
  | { phase: 'pooling', size: number }
  | { phase: 'member', coordinator: string, size: number }
  | { phase: 'signing' }
  | { phase: 'committing', size: number }
  | { phase: 'done', outcome: PoolOutcome }

export type PoolOutcome =
  | { status: 'committed', cid: string, blockId: string, size: number, formedByMe: boolean }
  | { status: 'stopped', reason: 'deadline' | 'aborted' | 'already-voted' }

type PoolMessage =
  | { t: 'merge', id: string, topic: string, contributions: PoolContribution[] }
  | { t: 'merged', re: string, size: number }
  | { t: 'refuse', re: string, reason: string }
  | { t: 'inform', id: string, topic: string, size: number, hold: string, dropped?: string[] }
  | { t: 'ack', re: string }
  | { t: 'form', id: string, topic: string, block: FormedPoolBlock }
  | { t: 'sign', re: string, signature: ConsentSignature }
  | { t: 'outcome', topic: string, committed: boolean, cid?: string, reason?: string, code?: 'already-voted' }

const holdOf = (voteCiphertext: string): string => bytesToHex(sha256(utf8ToBytes(voteCiphertext)))
const better = (a: { size: number, peerId: string }, b: { size: number, peerId: string }): boolean =>
  a.size > b.size || (a.size === b.size && a.peerId < b.peerId)

function isContribution (c: unknown): c is PoolContribution {
  const x = c as PoolContribution
  if (x === null || typeof x !== 'object' || typeof x.member !== 'string' || typeof x.voteCiphertext !== 'string') return false
  if (x.voterEntry === null || typeof x.voterEntry !== 'object' || typeof x.voterEntry.registrantId !== 'string' || typeof x.voterEntry.deviceKey !== 'string') return false
  try { ed25519PublicKeyFromPeerId(x.member) } catch { return false }
  return true
}

export class PoolAgent {
  private readonly o: Required<Omit<PoolAgentOptions, 'deadlineAt' | 'log' | 'onStatus' | 'discovery'>> & Pick<PoolAgentOptions, 'deadlineAt' | 'log' | 'onStatus' | 'discovery'>
  private readonly me: string
  private readonly topic: string
  private readonly myHold: string
  private readonly discovery: PoolDiscovery
  /** index into POOL_LADDER_RUNG_BITS; POOL_LADDER_RUNG_BITS.length means the plain topic. Only ever grows. */
  private rungIndex = 0
  private rungPresents = 0
  private runStartedAt: number
  /** when this pool first became visible on the plain topic; null until then (always set with the ladder off) */
  private plainAt: number | null
  private readonly presentedTopics = new Set<string>()
  private lastPresentTopic: string | null = null
  private role: 'coordinator' | 'member' | 'done' = 'coordinator'
  private pool: PoolContribution[]
  private coordinator: string | null = null
  private busy = false
  private pendingInforms = 0
  private lastGrowthAt: number
  private lastHeardAt = 0
  private lastMergeAttempt: { target: string, at: number, size: number } | null = null
  private signedCid: string | null = null
  private everSigned = false
  /** members (peer id and registrant id) this coordinator refuses from now on: an invalid signature, or dropped at formation twice */
  private readonly excluded = new Set<string>()
  private readonly formationDrops = new Map<string, number>()
  /** members that acknowledged an inform since they joined this pool: only a fully confirmed pool forms */
  private readonly confirmed = new Set<string>()
  private outcome: PoolOutcome | null = null
  private stopped = false
  private seq = 0
  private readonly pending = new Map<string, { from: string, resolve: (m: PoolMessage | null) => void, timer: ReturnType<typeof setTimeout> }>()
  /** observability: message counts by type, sent and received */
  readonly counts: Record<string, number> = {}

  constructor (options: PoolAgentOptions) {
    if (options.contribution.member !== options.identity.peerId) throw new Error('PoolAgent: the contribution must name this agent\'s peer id')
    this.o = {
      minSize: Math.max(POOL_MIN_BLOCK_SIZE, options.minSize ?? POOL_MIN_BLOCK_SIZE),
      capacity: 16,
      quietMs: 20_000,
      presentIntervalMs: 1_000,
      replyTimeoutMs: 5_000,
      informAttempts: 3,
      signTimeoutMs: 120_000,
      memberTimeoutMs: 60_000,
      pollWaitMs: 2_000,
      formLeadMs: 60_000,
      now: () => Date.now(),
      ladder: true,
      rungDwellTicks: POOL_LADDER_DWELL_PRESENTS,
      ...options
    } as PoolAgent['o']
    this.o.rungDwellTicks = Math.max(1, Math.floor(this.o.rungDwellTicks))
    this.o.ladderMaxMs = Math.min(POOL_LADDER_MAX_MS, options.ladderMaxMs ?? this.o.quietMs)
    this.discovery = options.discovery ?? rendezvousDiscovery(options.rendezvous, options.identity)
    if (this.o.capacity < this.o.minSize) this.o.capacity = this.o.minSize
    this.me = options.identity.peerId
    this.topic = poolTopic(options.ballot)
    this.myHold = holdOf(options.contribution.voteCiphertext)
    this.pool = [options.contribution]
    this.lastGrowthAt = this.o.now()
    this.runStartedAt = this.lastGrowthAt
    if (!this.o.ladder) this.rungIndex = POOL_LADDER_RUNG_BITS.length
    this.plainAt = this.o.ladder ? null : this.lastGrowthAt
  }

  /** Pool until this vote is in a committed block, voting closes, or `signal` aborts. */
  async run (signal?: AbortSignal): Promise<PoolOutcome> {
    this.runStartedAt = this.o.now()
    const polling = this.pollLoop()
    try {
      this.status()
      while (this.outcome === null) {
        if (signal?.aborted === true) { await this.abandon('aborted'); break }
        if (this.o.deadlineAt !== undefined && this.o.now() >= this.o.deadlineAt) { await this.abandon('deadline'); break }
        try {
          await this.tick()
        } catch (err) {
          this.log('tick-error', { message: err instanceof Error ? err.message : String(err) })
        }
        if (this.outcome !== null) break
        await sleep(this.o.presentIntervalMs * (0.75 + Math.random() * 0.5))
      }
    } finally {
      this.stopped = true
      for (const [, p] of this.pending) { clearTimeout(p.timer); p.resolve(null) }
      this.pending.clear()
      await this.withdraw()
      await polling
    }
    return this.outcome!
  }

  // -------------------------------------------------------------------------------------------
  // the loop

  private async tick (): Promise<void> {
    if ((this.everSigned || this.seq === 0) && this.o.findRecordedVote !== undefined && this.role !== 'done') {
      const recorded = await this.o.findRecordedVote().catch(() => null)
      if (recorded !== null) {
        this.finish({ status: 'committed', cid: recorded, blockId: '', size: 0, formedByMe: false })
        return
      }
    }
    if (this.role === 'member') {
      if (this.o.now() - this.lastHeardAt > this.o.memberTimeoutMs) this.revertToSolo('coordinator went silent')
      return
    }
    if (this.role !== 'coordinator' || this.busy) return
    if (this.shouldForm()) { await this.form(); return }
    let list: CoordinatorListing[]
    const presentAt = this.o.now()
    if (!this.onPlain() && (presentAt - this.runStartedAt >= this.o.ladderMaxMs ||
      (this.o.deadlineAt !== undefined && presentAt >= this.o.deadlineAt - 2 * this.o.formLeadMs))) {
      const why = presentAt - this.runStartedAt >= this.o.ladderMaxMs ? 'cap' : 'deadline'
      this.rungIndex = POOL_LADDER_RUNG_BITS.length
      this.rungPresents = 0
      this.log('ladder-widen', { to: 'plain', why })
    }
    const topic = this.presentTopic()
    if (this.lastPresentTopic !== null && this.lastPresentTopic !== topic) {
      const old = this.lastPresentTopic
      this.presentedTopics.delete(old)
      void this.discovery.withdraw(old, presentAt).catch(() => undefined)
    }
    try {
      // Record the topic before the call: a present that fails after reaching the server must still be withdrawn.
      this.presentedTopics.add(topic)
      this.lastPresentTopic = topic
      list = await this.discovery.present(topic, this.pool.length, presentAt)
      this.count('present')
      if (this.onPlain()) {
        if (this.plainAt === null) this.plainAt = this.o.now()
      } else {
        this.rungPresents++
        const seen = list.reduce((n, c) => n + c.size, 0) + this.pool.length
        if (this.rungPresents >= this.o.rungDwellTicks && seen < this.o.minSize) {
          this.rungIndex++
          this.rungPresents = 0
          this.log('ladder-widen', { to: this.onPlain() ? 'plain' : POOL_LADDER_RUNG_BITS[this.rungIndex], why: 'few' })
        }
      }
    } catch (err) {
      this.log('present-failed', { message: err instanceof Error ? err.message : String(err) })
      return
    }
    if (this.role !== 'coordinator' || this.busy) return
    const mine = { size: this.pool.length, peerId: this.me }
    const best = list
      .filter(c => better(c, mine) && c.size + this.pool.length <= this.o.capacity)
      .sort((a, b) => (better(a, b) ? -1 : 1))[0]
    if (best !== undefined) await this.mergeInto(best.peerId)
  }

  private onPlain (): boolean {
    return this.rungIndex >= POOL_LADDER_RUNG_BITS.length
  }

  /**
   * The topic to present on. A rung topic is for present/withdraw ONLY: protocol messages carry the
   * plain poolTopic, or a cross-rung merge would be refused as "not pooling this ballot".
   */
  private presentTopic (): string {
    if (this.onPlain()) return this.topic
    return ladderTopic(this.topic, POOL_LADDER_RUNG_BITS[this.rungIndex]!, this.pool.map(c => holdOf(c.voteCiphertext)))
  }

  private shouldForm (): boolean {
    if (this.pool.length < this.o.minSize || this.pendingInforms > 0) return false
    // doc/election.md: inform, ack, then form. A member merged a moment ago has not heard from this
    // coordinator yet and would refuse the form as "not my coordinator" (measured, run product-2).
    if (!this.pool.every(c => c.member === this.me || this.confirmed.has(c.member))) return false
    const now = this.o.now()
    // The quiet rule also needs one full quiet window on the PLAIN topic: otherwise a trio sharing a
    // bucket forms on its rung while voters in other buckets are still waiting on plain.
    return this.pool.length >= this.o.capacity ||
      (this.plainAt !== null && now - Math.max(this.lastGrowthAt, this.plainAt) >= this.o.quietMs) ||
      (this.o.deadlineAt !== undefined && now >= this.o.deadlineAt - this.o.formLeadMs)
  }

  private async mergeInto (target: string): Promise<void> {
    this.busy = true
    this.lastMergeAttempt = { target, at: this.o.now(), size: this.pool.length }
    try {
      const reply = await this.request(target, { t: 'merge', id: this.nextId(), topic: this.topic, contributions: this.pool }, this.o.replyTimeoutMs)
      if (reply?.t === 'merged' && this.role === 'coordinator') this.becomeMemberOf(target)
    } finally {
      this.busy = false
    }
  }

  private becomeMemberOf (coordinator: string): void {
    this.confirmed.clear()
    this.role = 'member'
    this.coordinator = coordinator
    this.pool = []
    this.lastHeardAt = this.o.now()
    void this.withdraw()
    this.log('member-of', { coordinator: coordinator.slice(-6) })
    this.status()
  }

  private revertToSolo (why: string): void {
    this.confirmed.clear()
    this.role = 'coordinator'
    this.coordinator = null
    this.pool = [this.o.contribution]
    this.lastGrowthAt = this.o.now()
    this.busy = false
    this.signedCid = null
    this.log('solo', { why })
    this.status()
  }

  private async informAll (): Promise<void> {
    this.pendingInforms++
    try {
      const others = this.pool.filter(c => c.member !== this.me)
      const acked = await Promise.all(others.map(async (c) => {
        for (let attempt = 0; attempt < this.o.informAttempts; attempt++) {
          if (this.stopped) return false
          const reply = await this.request(c.member, { t: 'inform', id: this.nextId(), topic: this.topic, size: this.pool.length, hold: holdOf(c.voteCiphertext) }, this.o.replyTimeoutMs)
          if (reply?.t === 'ack') { this.confirmed.add(c.member); return true }
          if (reply?.t === 'refuse') return false
        }
        return false
      }))
      const silent = others.filter((_, i) => !acked[i]).map(c => c.member)
      if (silent.length > 0 && this.role === 'coordinator') {
        // Revert: drop every member that did not acknowledge, then tell the rest who was dropped.
        this.pool = this.pool.filter(c => !silent.includes(c.member))
        for (const m of silent) this.confirmed.delete(m)
        this.log('dropped', { members: silent.map(s => s.slice(-6)), size: this.pool.length })
        for (const c of this.pool) {
          if (c.member === this.me) continue
          void this.post(c.member, { t: 'inform', id: this.nextId(), topic: this.topic, size: this.pool.length, hold: holdOf(c.voteCiphertext), dropped: silent })
        }
        for (const s of silent) void this.post(s, { t: 'inform', id: this.nextId(), topic: this.topic, size: this.pool.length, hold: '', dropped: [s] })
        this.status()
      }
    } finally {
      this.pendingInforms--
    }
  }

  private async form (): Promise<void> {
    this.busy = true
    try {
      let block: FormedPoolBlock
      try {
        block = formPoolBlock(this.pool, this.o.ballot)
      } catch (err) {
        this.log('form-refused', { message: err instanceof Error ? err.message : String(err) })
        this.revertToSolo('pool could not form a block')
        return
      }
      this.log('forming', { size: this.pool.length, cid: block.cid.slice(-8) })
      this.o.onStatus?.({ phase: 'signing' })
      const others = this.pool.filter(c => c.member !== this.me)
      const mine = this.o.contribution
      const [ownSignature, ...replies] = await Promise.all([
        this.o.signConsent(consentDigest(block, this.o.ballot, mine.voterEntry.registrantId, mine.voterEntry.deviceKey)).catch(() => null),
        ...others.map(c => this.request(c.member, { t: 'form', id: this.nextId(), topic: this.topic, block }, this.o.signTimeoutMs))
      ])
      if (ownSignature === null) {
        // This voter declined its own consent: release the pool rather than hold it hostage.
        for (const c of others) void this.post(c.member, { t: 'outcome', topic: this.topic, committed: false, reason: 'the former declined to sign' })
        await this.abandon('aborted')
        return
      }
      // A signature that the schema's SignatureValid CHECK would refuse fails the whole commit, so
      // check each one here and drop only its signer.
      const signedOk = (c: PoolContribution, r: PoolMessage | null): boolean =>
        r?.t === 'sign' && r.signature.registrantId === c.voterEntry.registrantId && r.signature.deviceKey === c.voterEntry.deviceKey &&
        verifySigP256(consentDigest(block, this.o.ballot, c.voterEntry.registrantId, c.voterEntry.deviceKey), r.signature.signature, c.voterEntry.deviceKey)
      const refusers = others.filter((c, i) => !signedOk(c, replies[i] ?? null))
      if (refusers.length > 0) {
        const reasons = refusers.map((c) => {
          const r = replies[others.indexOf(c)]
          return r?.t === 'refuse' ? r.reason : r?.t === 'sign' ? 'invalid signature' : 'no answer'
        })
        this.log('form-refused-by', { members: refusers.map(c => c.member.slice(-6)), reasons })
        // doc/election.md's open question on repeat offenders: a member dropped here would otherwise
        // merge straight back in and stall the pool again. An invalid signature is refused from now
        // on; any other refusal or silence (a slow fingerprint, a state mismatch) gets one more try.
        refusers.forEach((c, k) => {
          const drops = (this.formationDrops.get(c.member) ?? 0) + 1
          this.formationDrops.set(c.member, drops)
          if (reasons[k] === 'invalid signature' || drops >= 2) { this.excluded.add(c.member); this.excluded.add(c.voterEntry.registrantId) }
        })
        this.dropMembers(refusers, { reason: 'dropped at formation' })
        return
      }
      const signatures: ConsentSignature[] = [
        { registrantId: mine.voterEntry.registrantId, deviceKey: mine.voterEntry.deviceKey, signature: ownSignature },
        ...replies.map(r => (r as Extract<PoolMessage, { t: 'sign' }>).signature)
      ]
      this.o.onStatus?.({ phase: 'committing', size: this.pool.length })
      const result = await this.o.commit(block, signatures)
      if (result.ok) {
        for (const c of others) void this.post(c.member, { t: 'outcome', topic: this.topic, committed: true, cid: block.cid })
        this.finish({ status: 'committed', cid: block.cid, blockId: block.blockId, size: this.pool.length, formedByMe: true })
        return
      }
      this.log('commit-failed', { reason: result.reason })
      // Only identified pool members may be dropped: the list is input from the commit.
      const named = new Set(result.duplicateRegistrants ?? [])
      const dup = this.pool.filter(c => named.has(c.voterEntry.registrantId))
      if (dup.length === 0) {
        for (const c of others) void this.post(c.member, { t: 'outcome', topic: this.topic, committed: false, reason: 'the block did not commit' })
        this.revertToSolo('commit failed')
        return
      }
      if (dup.some(c => c.member === this.me)) {
        // The former is itself the duplicate: tell everyone, then stop (or report its recorded cid).
        await Promise.all(others.map(async c => await this.post(c.member, dup.includes(c)
          ? { t: 'outcome', topic: this.topic, committed: false, reason: 'already voted', code: 'already-voted' }
          : { t: 'outcome', topic: this.topic, committed: false, reason: 'the former already voted' })))
        const recorded = (await this.o.findRecordedVote?.().catch(() => null)) ?? null
        if (recorded !== null) this.finish({ status: 'committed', cid: recorded, blockId: '', size: 0, formedByMe: false })
        else this.finish({ status: 'stopped', reason: 'already-voted' })
        return
      }
      // Never let a registrant that already voted merge back in and stall the pool again.
      for (const c of dup) { this.excluded.add(c.member); this.excluded.add(c.voterEntry.registrantId) }
      this.log('commit-duplicate', { count: dup.length, size: this.pool.length - dup.length })
      this.dropMembers(dup, { reason: 'already voted', code: 'already-voted' })
    } finally {
      if (this.role !== 'done') this.busy = false
    }
  }

  /**
   * Remove `gone` from the pool: tell the survivors who was dropped, tell the dropped through an
   * `outcome`, and restart the quiet window. The pool re-forms once it is at least `minSize` again.
   */
  private dropMembers (gone: PoolContribution[], outcome: { reason: string, code?: 'already-voted' }): void {
    const goneIds = gone.map(c => c.member)
    for (const c of gone) this.confirmed.delete(c.member)
    this.pool = this.pool.filter(c => !goneIds.includes(c.member))
    for (const c of this.pool) {
      if (c.member !== this.me) void this.post(c.member, { t: 'inform', id: this.nextId(), topic: this.topic, size: this.pool.length, hold: holdOf(c.voteCiphertext), dropped: goneIds })
    }
    for (const g of goneIds) {
      void this.post(g, outcome.code === undefined
        ? { t: 'outcome', topic: this.topic, committed: false, reason: outcome.reason }
        : { t: 'outcome', topic: this.topic, committed: false, reason: outcome.reason, code: outcome.code })
    }
    this.lastGrowthAt = this.o.now()
    this.status()
  }

  private async abandon (reason: 'deadline' | 'aborted'): Promise<void> {
    if (this.role === 'coordinator') {
      for (const c of this.pool) {
        if (c.member !== this.me) await this.post(c.member, { t: 'outcome', topic: this.topic, committed: false, reason })
      }
    }
    this.finish({ status: 'stopped', reason })
  }

  private finish (outcome: PoolOutcome): void {
    this.outcome = outcome
    this.role = 'done'
    this.o.onStatus?.({ phase: 'done', outcome })
    this.log('done', outcome as unknown as Record<string, unknown>)
  }

  // -------------------------------------------------------------------------------------------
  // inbound

  private async withdraw (): Promise<void> {
    // Clear before awaiting, so a present that lands meanwhile is not lost. Every rung presented on is withdrawn.
    const topics = [...this.presentedTopics]
    this.presentedTopics.clear()
    this.lastPresentTopic = null
    // best effort: the rendezvous expires stale coordinators anyway
    await Promise.all(topics.map(async (t) => await this.discovery.withdraw(t, this.o.now()).catch(() => undefined)))
  }

  private async pollLoop (): Promise<void> {
    while (!this.stopped) {
      const startedAt = Date.now()
      let envelopes
      try {
        const reply: RendezvousReply = await this.o.rendezvous.call(poolRequests.poll(this.o.identity, this.o.pollWaitMs, this.o.now()), this.o.pollWaitMs)
        if (reply.t !== 'envelopes') throw new Error(reply.t === 'error' ? reply.reason : 'unexpected reply')
        envelopes = reply.list
      } catch {
        await sleep(500)
        continue
      }
      // A poll released empty at once (a second poll for this identity, a rendezvous restarting)
      // must not spin: back off so timers and other work still run.
      if (envelopes.length === 0 && Date.now() - startedAt < 50) await sleep(200)
      for (const envelope of envelopes) {
        let opened
        try {
          opened = openPoolEnvelope<PoolMessage>(this.o.identity, envelope, this.o.now())
        } catch (err) {
          this.log('envelope-refused', { message: err instanceof Error ? err.message : String(err) })
          continue
        }
        this.count(`in:${opened.body?.t}`)
        void this.onMessage(opened.from, opened.body).catch((err) => this.log('handler-error', { message: err instanceof Error ? err.message : String(err) }))
      }
    }
  }

  private async onMessage (from: string, m: PoolMessage): Promise<unknown> {
    if (m === null || typeof m !== 'object') return
    if ('re' in m && typeof m.re === 'string') {
      const p = this.pending.get(m.re)
      if (p !== undefined && p.from === from) {
        this.pending.delete(m.re)
        clearTimeout(p.timer)
        p.resolve(m)
      }
      return
    }
    if (!('topic' in m) || m.topic !== this.topic || this.role === 'done') {
      if ('id' in m && typeof m.id === 'string') await this.post(from, { t: 'refuse', re: m.id, reason: 'not pooling this ballot' })
      return
    }
    switch (m.t) {
      case 'merge': await this.onMerge(from, m); return
      case 'inform': await this.onInform(from, m); return
      case 'form': await this.onForm(from, m); return
      case 'outcome': await this.onOutcome(from, m)
    }
  }

  private async onMerge (from: string, m: Extract<PoolMessage, { t: 'merge' }>): Promise<unknown> {
    const refuse = (reason: string) => this.post(from, { t: 'refuse', re: m.id, reason })
    if (this.role !== 'coordinator' || this.busy) return await refuse('not coordinating')
    if (!Array.isArray(m.contributions) || m.contributions.length === 0 || !m.contributions.every(isContribution)) return await refuse('bad contributions')
    if (better({ size: m.contributions.length, peerId: from }, { size: this.pool.length, peerId: this.me })) return await refuse('your pool is bigger')
    if (this.pool.length + m.contributions.length > this.o.capacity) return await refuse('full')
    if (m.contributions.some(c => this.excluded.has(c.member) || this.excluded.has(c.voterEntry.registrantId))) return await refuse('a member of your pool was dropped here before')
    const ids = new Set(this.pool.map(c => c.voterEntry.registrantId))
    const cts = new Set(this.pool.map(c => c.voteCiphertext))
    const fresh = m.contributions.filter(c => !ids.has(c.voterEntry.registrantId) && !cts.has(c.voteCiphertext))
    if (fresh.length !== m.contributions.length) return await refuse('a voter is already in this pool')
    this.pool.push(...fresh)
    this.lastGrowthAt = this.o.now()
    await this.post(from, { t: 'merged', re: m.id, size: this.pool.length })
    this.log('merged', { from: from.slice(-6), size: this.pool.length })
    this.status()
    void this.informAll()
  }

  private async onInform (from: string, m: Extract<PoolMessage, { t: 'inform' }>): Promise<unknown> {
    if (Array.isArray(m.dropped) && m.dropped.includes(this.me)) {
      if (this.role === 'member' && this.coordinator === from) this.revertToSolo('dropped by the coordinator')
      return
    }
    // The sender must prove it holds MY contribution (a digest of my vote ciphertext), so nobody
    // can talk a member out of its pool by claiming to be its new coordinator.
    if (m.hold !== this.myHold) return await this.post(from, { t: 'refuse', re: m.id, reason: 'you do not hold my vote' })
    if (this.role === 'member') {
      this.coordinator = from
      this.lastHeardAt = this.o.now()
      this.status()
      return await this.post(from, { t: 'ack', re: m.id })
    }
    // A coordinator accepts only if it is alone (its own merge reply may have been lost) or this is
    // the pool it just tried to merge into and nobody has joined it since.
    const recent = this.lastMergeAttempt
    const joinedIt = recent !== null && recent.target === from && this.o.now() - recent.at < 3 * this.o.replyTimeoutMs && this.pool.length === recent.size
    if (this.role === 'coordinator' && (this.pool.length === 1 || joinedIt)) {
      this.becomeMemberOf(from)
      return await this.post(from, { t: 'ack', re: m.id })
    }
    await this.post(from, { t: 'refuse', re: m.id, reason: 'already coordinating a pool' })
  }

  private async onForm (from: string, m: Extract<PoolMessage, { t: 'form' }>): Promise<unknown> {
    if (this.role !== 'member' || this.coordinator !== from) return await this.post(from, { t: 'refuse', re: m.id, reason: 'not my coordinator' })
    this.lastHeardAt = this.o.now() + this.o.signTimeoutMs
    const check = checkFormedPoolBlock(m.block, this.o.contribution, this.o.ballot)
    if (!check.ok) {
      this.log('refused-block', { reason: check.reason })
      this.lastHeardAt = this.o.now()
      return await this.post(from, { t: 'refuse', re: m.id, reason: check.reason })
    }
    this.o.onStatus?.({ phase: 'signing' })
    const mine = this.o.contribution.voterEntry
    let signature: string
    try {
      signature = await this.o.signConsent(consentDigest(m.block, this.o.ballot, mine.registrantId, mine.deviceKey))
    } catch {
      this.lastHeardAt = this.o.now()
      return await this.post(from, { t: 'refuse', re: m.id, reason: 'the voter declined to sign' })
    }
    this.signedCid = m.block.cid
    this.everSigned = true
    this.lastHeardAt = this.o.now()
    await this.post(from, { t: 'sign', re: m.id, signature: { registrantId: mine.registrantId, deviceKey: mine.deviceKey, signature } })
    this.status()
  }

  private async onOutcome (from: string, m: Extract<PoolMessage, { t: 'outcome' }>): Promise<void> {
    if (this.role !== 'member' || this.coordinator !== from) return
    if (m.committed && typeof m.cid === 'string' && m.cid === this.signedCid) {
      this.finish({ status: 'committed', cid: m.cid, blockId: '', size: 0, formedByMe: false })
      return
    }
    if (m.code === 'already-voted') {
      // Trust only what this voter's own strand read says (D-13): a recorded cid means sent.
      const recorded = (await this.o.findRecordedVote?.().catch(() => null)) ?? null
      // the role can change during the await; the cast defeats TS's narrowing to 'member'
      if ((this.role as 'coordinator' | 'member' | 'done') === 'done') return
      if (recorded !== null) this.finish({ status: 'committed', cid: recorded, blockId: '', size: 0, formedByMe: false })
      else this.finish({ status: 'stopped', reason: 'already-voted' })
      return
    }
    this.revertToSolo(`formation failed: ${m.reason ?? 'unknown'}`)
  }

  // -------------------------------------------------------------------------------------------
  // outbound

  private nextId (): string {
    this.seq++
    return `${this.me.slice(-8)}-${this.seq}-${Math.random().toString(36).slice(2, 8)}`
  }

  private async post (to: string, body: PoolMessage): Promise<boolean> {
    try {
      const reply = await this.o.rendezvous.call(poolRequests.send(sealPoolEnvelope(this.o.identity, to, body, this.o.now())))
      if (reply.t === 'error') throw new Error(reply.reason)
      this.count(`out:${body.t}`)
      return true
    } catch (err) {
      this.log('send-failed', { to: to.slice(-6), t: body.t, message: err instanceof Error ? err.message : String(err) })
      return false
    }
  }

  /** Send `body` (which carries an `id`) and wait for the reply naming it, or null on timeout. */
  private async request (to: string, body: Extract<PoolMessage, { id: string }>, timeoutMs: number): Promise<PoolMessage | null> {
    const reply = new Promise<PoolMessage | null>((resolve) => {
      const timer = setTimeout(() => { this.pending.delete(body.id); resolve(null) }, timeoutMs)
      this.pending.set(body.id, { from: to, resolve, timer })
    })
    if (!(await this.post(to, body))) {
      const p = this.pending.get(body.id)
      if (p !== undefined) { clearTimeout(p.timer); this.pending.delete(body.id) }
      return null
    }
    return await reply
  }

  private count (key: string): void { this.counts[key] = (this.counts[key] ?? 0) + 1 }
  private log (event: string, detail?: Record<string, unknown>): void { this.o.log?.(event, detail) }
  private status (): void {
    if (this.role === 'coordinator') this.o.onStatus?.({ phase: 'pooling', size: this.pool.length })
    else if (this.role === 'member' && this.coordinator !== null) this.o.onStatus?.({ phase: 'member', coordinator: this.coordinator, size: 0 })
  }
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
