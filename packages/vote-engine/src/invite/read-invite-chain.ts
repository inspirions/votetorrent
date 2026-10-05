import type { InviteSlotResolution } from '@votetorrent/vote-core'
import type { EngineContext } from '../types.js'
import { fromCanonicalDatetime } from '../utils.js'

/**
 * The ONE copy of the share-liveness rule. Callers: InvitationEngine.resolveInviteSlot,
 * InvitationEngine.respondToInvite (via assertSlotIsLiveHead) and AuthorityEngine (pending list,
 * cancelInvite, resendInvite).
 * Chain = every InviteSlot with the same (InviteKey, Type), optionally filtered to one SigningNonce in
 * TypeScript. Per-row facts are read with separate PK-keyed single-row reads (never one compound WHERE:
 * the Quereus AND+IN/OR zero-row trap would make a silently empty read look like a refusal).
 * Not exported from the package index.
 */
export async function readInviteChain (db: EngineContext['db'], inviteKey: string, slotType: string, now: string, onlyNonce?: string): Promise<InviteSlotResolution> {
  const rows: Array<{ cid: string, nonce: string, salt: string | null }> = []
  for await (const row of db.eval(
    'SELECT Cid, SigningNonce, ResendSalt FROM InviteSlot WHERE InviteKey = :inviteKey AND Type = :slotType',
    { inviteKey, slotType }
  )) {
    // respondToInvite names one slot, so it knows which invitation it belongs to: unrelated
    // invitations that merely share an InviteKey are filtered here (in TypeScript, not a third
    // WHERE term). resolveInviteSlot has only the share, so it passes no nonce and an
    // InviteKey shared by two invitations stays ambiguous.
    if (onlyNonce !== undefined && row.SigningNonce !== onlyNonce) continue
    rows.push({ cid: row.Cid as string, nonce: row.SigningNonce as string, salt: (row.ResendSalt as string | null) ?? null })
  }
  if (rows.length === 0) return { status: 'not-found' }

  // Per-row facts.
  const cancelledAt = new Map<string, string | number>()
  let answeredCid: string | undefined
  for (const r of rows) {
    const result = await db
      .prepare('SELECT 1 AS x FROM InviteResult WHERE SlotCid = :slotCid')
      .get({ slotCid: r.cid })
    if (result && answeredCid === undefined) answeredCid = r.cid
    const cancel = await db
      .prepare('SELECT CancelledAt FROM InviteCancellation WHERE SlotCid = :slotCid')
      .get({ slotCid: r.cid })
    if (cancel) cancelledAt.set(r.cid, cancel.CancelledAt as string | number)
  }
  if (answeredCid !== undefined) return { status: 'answered', cid: answeredCid }

  // Fail closed on structure: one signing nonce, one original, parseable salts, distinct order keys.
  if (new Set(rows.map(r => r.nonce)).size > 1) return { status: 'ambiguous' }
  if (rows.filter(r => r.salt === null).length > 1) return { status: 'ambiguous' }
  const ordered: Array<{ cid: string, tid: number, nowMs: number }> = []
  for (const r of rows) {
    if (r.salt === null) {
      ordered.push({ cid: r.cid, tid: -1, nowMs: 0 })
      continue
    }
    const parts = r.salt.split('|')
    const tid = Number(parts[1])
    const nowMs = fromCanonicalDatetime(parts[2] ?? '')
    if (parts.length !== 3 || parts[0] !== 'resend' || !Number.isInteger(tid) || Number.isNaN(nowMs)) {
      return { status: 'ambiguous' }
    }
    ordered.push({ cid: r.cid, tid, nowMs })
  }
  ordered.sort((a, b) => a.tid - b.tid || a.nowMs - b.nowMs)
  for (let i = 1; i < ordered.length; i++) {
    const cur = ordered[i]
    const prev = ordered[i - 1]
    if (cur && prev && cur.tid === prev.tid && cur.nowMs === prev.nowMs) return { status: 'ambiguous' }
  }
  const head = ordered[ordered.length - 1]
  if (!head) return { status: 'not-found' }

  // Backstop: a non-head cancellation strictly later than the head's resend time.
  let backstopClosed = false
  for (const o of ordered.slice(0, -1)) {
    const at = cancelledAt.get(o.cid)
    if (at === undefined) continue
    const atMs = fromCanonicalDatetime(at)
    if (Number.isNaN(atMs)) return { status: 'ambiguous' }
    if (atMs > head.nowMs) backstopClosed = true
  }

  if (cancelledAt.has(head.cid) || backstopClosed) return { status: 'no-longer-valid' }
  const unexpired = await db
    .prepare('SELECT 1 AS x FROM InviteSlot WHERE Cid = :slotCid AND Expiration > :now')
    .get({ slotCid: head.cid, now })
  if (!unexpired) return { status: 'no-longer-valid' }
  return { status: 'live', cid: head.cid }
}
