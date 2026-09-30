/**
 * Merging verified cadre addresses into a libp2p node's **address book** (its
 * peerStore), so that every layer below cadre-core which dials by bare peer id
 * — Optimystic's cluster client, repo client, FRET ping/announce, all funnelling
 * into `libp2p.dialProtocol(peerId, …)` — has an address to use for a sibling
 * whose connection has dropped, instead of failing with `NoValidAddressesError`
 * until the next reconcile pass happens to re-dial it.
 *
 * Shared by the control-cohort reconcile pass and the strand one (both in
 * `CadreNode`): each resolves a peer's addresses its own way and then needs
 * exactly this write, with exactly this workaround.
 *
 * Two exports, in the order a caller uses them: {@link groupAddrsByPeerId} turns
 * a flat address list into per-peer groups (the strand path starts from the
 * peer-agnostic union the strand-addr RPC returns), and {@link mergePeerAddrs}
 * writes one peer's group.
 */
import type { PeerId, PeerStore } from '@libp2p/interface';
import { type Multiaddr } from '@multiformats/multiaddr';
/** Outcome of one address-book merge, for logging and tests. */
export type MergeAddrsResult = 'merged' | 'restamped' | 'skipped' | 'failed';
/**
 * The slice of a libp2p node {@link mergePeerAddrs} touches. Structurally
 * satisfied by `Libp2p`; narrow so a caller (or a test) can pass a bare
 * peerStore holder.
 */
export interface PeerAddrBookHost {
    peerStore: PeerStore;
}
/**
 * Write `addrs` into `host`'s address book for `peerId`, best-effort. `peerId`
 * may be the string form callers hold (a `CadrePeer.PeerId` column, a strand-addr
 * RPC result); parsing it is part of the best-effort contract below, so no caller
 * has to wrap this in a second try/catch of its own.
 *
 * - **Empty `addrs` writes nothing** and reports `'skipped'`. That is how a
 *   revoked / stale / untrusted peer's existing entry is allowed to age out on
 *   its own: the caller resolves `[]` for it, and nothing here refreshes it.
 * - Otherwise the addresses are merged, and — see the timestamp trap below —
 *   re-saved when the merge alone leaves them invisible (`'restamped'`).
 * - Any throw (unparsable peer id, datastore failure, a peerStore double without
 *   `merge`) is logged and folded to `'failed'`. Callers are best-effort loops:
 *   an address-book failure must never abort a reconcile pass.
 *
 * NOTE: `peerStore.merge` cannot refresh an address's `observed` timestamp in
 * `@libp2p/peer-store` 12.0.10 — `to-peer-pb.js` shadows its own loop variable
 * (`…addresses?.find(addr => uint8ArrayEquals(addr.multiaddr, addr.multiaddr))`,
 * always true, so it returns the FIRST stored address's timestamp), and every
 * read filters out addresses older than `MAX_ADDRESS_AGE` (1 hour). So an entry
 * silently dies at the one-hour mark and no amount of re-merging revives it —
 * not even merging a brand-new address. The `save` below is the workaround:
 * `save` is the one write path that omits `existingPeer` and therefore stamps
 * `Date.now()`. Drop it once upstream stamps `Date.now()` on merge.
 *
 * NOTE: raising the store's own `maxAddressAge` (libp2p forwards `init.peerStore`
 * straight into `persistentPeerStore`) would sidestep the bug in one line, and is
 * deliberately NOT done: expiry is load-bearing here. Only *verified* addresses
 * come through this helper, and the design relies on everything else — the
 * cold-start seed entries, identify-learned addresses — still ageing out on the
 * stock schedule. A global age bump would keep those alive too.
 *
 * NOTE: if the store ever REJECTS an address we hand it, the restamp repeats
 * every pass forever — `allVisible` stays false, and `save` re-submits the same
 * rejected address. libp2p wires the store's `addressFilter` to
 * `connectionGater.filterMultiaddrForPeer`, which nothing in this repo implements
 * today (`createMembershipConnectionGater` gates dials, not addresses), so the
 * loop is unreachable. If an app ever supplies that gater hook via
 * `NetworkConfig.connectionGater`, bound the retry — the cost is one redundant
 * datastore write per gated sibling per reconcile pass.
 */
export declare function mergePeerAddrs(host: PeerAddrBookHost, peerId: PeerId | string, addrs: Multiaddr[]): Promise<MergeAddrsResult>;
/**
 * Group multiaddr strings by the peer id in their final `/p2p/` component — the
 * attribution step between a flat, peer-agnostic address list and the per-peer
 * writes {@link mergePeerAddrs} takes.
 *
 * The **last** `/p2p/` component is the addressed peer, not the first: a relayed
 * address (`…/p2p/<relay>/p2p-circuit/p2p/<dst>`) names the relay first and the
 * destination last, while a direct address (`…/tcp/…/p2p/<dst>`) names only the
 * destination. Taking the last therefore attributes both shapes to the peer the
 * address actually reaches.
 *
 * Three shapes are dropped rather than attributed, because none of them names a
 * peer the address reaches: one that does not parse, one carrying no `/p2p/`
 * component at all (a peer advertising a bare listen addr), and one whose
 * `p2p-circuit` comes AFTER its last `/p2p/` (`…/p2p/<relay>/p2p-circuit`) — that
 * last one is a relay hop with the destination missing, so its trailing peer id
 * is the RELAY's and filing it under the relay would claim the relay is reachable
 * at a circuit leading nowhere. Duplicates collapse within a group. Insertion
 * order is preserved, both between groups and inside one.
 */
export declare function groupAddrsByPeerId(addrs: string[]): Map<string, Multiaddr[]>;
