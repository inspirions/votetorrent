/**
 * self-voucher.ts — isSelfVouched (QUICK-260928-jwi).
 *
 * Mirrors @serfab/cadre-core 1.6.0's PRIVATE `CadreNode#hasAnchoredVoucher(row)`
 * (cadre-node.js:6081) — checks 2-4 of the authorized-membership predicate (complete
 * voucher, `VouchOwner` anchored in the node-local trust store, signature verifies over
 * the row's (PeerId, StampId) digest) — applied to THIS peer's own `CadrePeer` row.
 * Check 5 (revocation) is already applied upstream by `ControlDatabase.queryCadrePeers`.
 *
 * It exists because `listAuthorizedMembers()` / `isAuthorizedMember()` unconditionally
 * exclude self (check 1: `row.peerId !== selfPeerId`, cadre-node.js:6058), so neither can
 * ever answer true for our own row, and `isMember(self)` is the addressable surface — it
 * reads true before any owner has vouched at all. Only public `CadreNode` API is read
 * here (`getControlDatabase()`, `getTrustedOwnerStore()`, the exported
 * `verifyCadrePeerVoucher`) — no private cadre-core field.
 *
 * Pinned to cadre-core 1.6.0's `hasAnchoredVoucher` shape — a future cadre-core bump
 * should re-diff this against the new `cadre-node.js` before trusting it unchanged.
 * Re-diffed on cadre-core 1.9.0 (2026-10-01), 1.12.0 (2026-10-05) and 1.13.0 (2026-10-06): `hasAnchoredVoucher` is byte-identical.
 */

import { verifyCadrePeerVoucher } from '@serfab/cadre-core';
import type { CadrePeerRow } from '@serfab/cadre-core';

type VoucherRow = Pick<CadrePeerRow, 'peerId' | 'stampId' | 'vouchOwner' | 'vouchSig'>;

/**
 * Structural subset of `CadreNode` this predicate needs — the real `CadreNode` satisfies
 * it with no cast (see replication-proof-runner.ts's `authNode` usage).
 */
export interface SelfVoucherNode {
  getControlDatabase(): { queryCadrePeers(retry?: boolean): Promise<ReadonlyArray<VoucherRow>> } | null;
  getTrustedOwnerStore(): { has(ownerKey: string): boolean } | null;
}

/**
 * True when THIS peer's own replicated `CadrePeer` row carries a complete voucher from an
 * owner anchored in the node-local trust store, with a signature that verifies. Cheap
 * synchronous surfaces (the store, the DB) are checked before the async row read.
 */
export async function isSelfVouched(node: SelfVoucherNode, peerId: string): Promise<boolean> {
  const store = node.getTrustedOwnerStore();
  if (!store) {
    return false;
  }
  const db = node.getControlDatabase();
  if (!db) {
    return false;
  }
  const rows = await db.queryCadrePeers();
  const self = rows.find((r) => r.peerId === peerId);
  if (!self) {
    return false;
  }
  if (self.stampId === null || self.vouchOwner === null || self.vouchSig === null) {
    return false;
  }
  if (!store.has(self.vouchOwner)) {
    return false;
  }
  return verifyCadrePeerVoucher(self.peerId, self.stampId, self.vouchOwner, self.vouchSig);
}
