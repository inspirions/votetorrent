/**
 * Translate `network.relayAddrs` — the operator-facing "use these relay servers"
 * setting — into the listen entry a node needs before it can hold a circuit-relay
 * slot, and validate the operator's entries while doing it.
 *
 * `@libp2p/circuit-relay-v2`'s listener branches on the SHAPE of the listen addr:
 *
 * | listen entry                        | libp2p behaviour                                                |
 * | ----------------------------------- | --------------------------------------------------------------- |
 * | `<relayAddr>/p2p-circuit`           | CONFIGURED: dial that relay from inside `listen()` and reserve, or throw |
 * | bare `/p2p-circuit`                 | SEARCH: register a pending reservation; open no connection      |
 *
 * Every cadre-built node takes the SEARCH shape, and something explicit drives the
 * reservation afterwards (`relay-reservation.ts`):
 *
 * - The CONTROL node resolves `relayAddrs` here to ONE bare entry (whichever relay
 *   answers first fills it) and `CadreNode.start()` drives the reservation once the
 *   control database is up. That ordering is the point: a configured circuit
 *   listener dials the relay from inside `libp2p.start()`, so the control database
 *   was being built while a sibling relay was already in this node's cohort — and a
 *   sibling that has not yet replicated this node's `CadrePeer` row correctly refuses
 *   its control-DB streams, which killed `start()` outright. See `cadre-node.ts` →
 *   `start()`.
 * - Each STRAND node resolves the same `relayAddrs` to one bare entry PER relay and
 *   runs one reservation supervisor per relay (`strand-network-config.ts`,
 *   `strand-instance-manager.ts`).
 *
 * The CONFIGURED shape is deliberately not producible from a `NetworkConfig` any
 * more: it loses its address and never recovers when the relay restarts, when either
 * side hangs up, and — with no network event at all — on libp2p's own reservation
 * refresh, which removes the reservation before re-creating it while a configured
 * listener republishes only from inside its own `listen()`. A hand-written
 * `<relay>/p2p-circuit` entry in `network.listenAddrs` is rejected on the control
 * node ({@link resolveListenAddrs}) and folded into the supervised relay set on a
 * strand node.
 *
 * `network.relayAddrs` is FAIL-FAST for the operator by default: a malformed entry
 * throws here at config resolution regardless of posture, and on the control node a
 * first reservation attempt that does not land throws out of `start()`
 * (`RelayReservationFailedError`). Naming a relay that is down still means the control
 * node does not come up. `network.requireRelay: false` softens the second half only —
 * for a node that must still boot with no network (a phone, a browser tab) — logging
 * the failed attempt instead of throwing and leaving the retry supervisor running in
 * the background; the malformed-entry check is unaffected. A strand node is
 * fail-SOFT regardless of `requireRelay` (its supervisor keeps trying while the
 * strand serves).
 *
 * The bare `/p2p-circuit` search listener cannot open a connection on its own:
 * libp2p fills a pending reservation from `RelayDiscovery`, which nominates a peer
 * only once the relay-hop protocol id is in that peer's peer-store protocol list,
 * and that list is written exclusively by IDENTIFY — which `@optimystic/db-p2p`
 * namespaces per network, so a cadre node and a stock relay never identify each
 * other. See `relay-reservation.ts`'s module doc and `docs/architecture.md`.
 */
import type { NetworkConfig } from './types.js';
import type { RelayReservationState } from './relay-reservation.js';
/**
 * The direct listener a node keeps when it configures `relayAddrs` but no
 * `listenAddrs`. Without this, naming a relay would silently REPLACE the node's
 * direct TCP listener with a circuit-only one. Shared with the strand-node
 * derivation (`strand-network-config.ts`), which applies the same rule.
 *
 * NOTE: mirrors `createLibp2pNode`'s own default listen addr in
 * `../optimystic/packages/db-p2p/src/libp2p-node.ts` (`/ip4/0.0.0.0/tcp/<port>`,
 * and `CadreNode` passes `port: 0`) — that file is the source of truth. If it
 * ever changes its default, this constant has to follow.
 */
export declare const DEFAULT_DIRECT_LISTEN_ADDR = "/ip4/0.0.0.0/tcp/0";
/**
 * libp2p's relay SEARCH listener: registers one pending reservation and dials
 * nothing. The pending reservation is per-LISTENER, not per-relay: the control
 * node binds one entry for its whole relay list (`relay-reservation.ts` fills it
 * with whichever relay answers first), a strand node binds one entry per relay so
 * each relay's supervisor has a slot of its own to fill.
 */
export declare const RELAY_SEARCH_LISTEN_ADDR = "/p2p-circuit";
/**
 * The circuit-listen multiaddr for each configured relay: `<relayAddr>/p2p-circuit`.
 * An entry that already carries `/p2p-circuit` is passed through unchanged.
 * Throws on an entry that is unparsable or names no relay peerId — this is
 * operator configuration, so a typo must fail loudly at start rather than
 * silently costing the node its reachability.
 *
 * No node LISTENS on these any more (see the module doc); they are the validated
 * form of `relayAddrs`, read by `CadreNode.circuitRelayTargets` for the delegate
 * announce and by `strand-network-config.ts` for the per-relay supervisor list.
 *
 * Deliberately unlike `extractCircuitRelayTargets` (`delegate-admission.ts`), which
 * SKIPS a bad entry: that one reads addresses discovered at runtime from peers, where
 * one bad entry must not be fatal.
 */
export declare function relayCircuitAddrs(relayAddrs: readonly string[]): string[];
/**
 * The listen multiaddrs the CONTROL node binds: configured `listenAddrs` plus ONE
 * bare `/p2p-circuit` search entry when `relayAddrs` names any relay, deduplicated,
 * order-stable (configured entries first). Returns `undefined` when neither field
 * is set, so callers keep omitting `listenAddrs` and inherit db-p2p's default.
 *
 * Every `relayAddrs` entry is validated even though the search entry discards the
 * resolved circuit addrs — an operator typo must fail at config resolution. A
 * hand-written `<relay>/p2p-circuit` entry in `listenAddrs` is rejected outright
 * (see {@link rejectConfiguredCircuitListenAddrs}).
 *
 * Strand nodes derive their own listen set from the same config in
 * `strand-network-config.ts` (`strandNodeAddrs`) — one search entry per relay,
 * fixed direct ports made ephemeral.
 */
export declare function resolveListenAddrs(network: NetworkConfig | undefined): string[] | undefined;
/**
 * The transport-derived `createLibp2pNode` options a resolved listen set implies —
 * see {@link resolveTransportOptions}.
 */
export interface ListenTransportOptions {
    /**
     * Present when some listen entry names WebSocket. Its VALUE is never bound; it is
     * the switch that makes `@optimystic/db-p2p` add `webSockets()` — see
     * {@link WS_TRANSPORT_SWITCH_PORT}.
     */
    wsPort?: number;
}
/**
 * The transport-derived libp2p options `listenAddrs` implies, and the gate that stops a
 * listen address the node has no transport for from being SILENTLY dropped.
 *
 * libp2p's transport manager sorts configured listen addresses by which transport claims
 * them, discards the unclaimed ones, and raises `UnsupportedListenAddressesError` only
 * when EVERY address was discarded. Pair a TCP address with a WebSocket one — which is
 * exactly what the shipped configs do — and the TCP address carries the start while the
 * missing WebSocket listener is never reported. Two halves of `NetworkConfig` that have
 * to agree (`listenAddrs`, and the transports the node will actually have) were never
 * checked against each other; this is that check, and it covers both node kinds because
 * both derive their listen set from the same config here ({@link resolveListenAddrs}) or
 * in `strand-network-config.ts`, and both call this on the result.
 *
 * The two transport classes are handled differently, on purpose:
 *
 * - **WebSocket is DERIVED.** It is the one non-TCP transport the shipped configs need
 *   (the React Native reference app's companion drone; `cadre start --ws-port`), and
 *   `@optimystic/db-p2p` already knows how to add it. `cadre-core` grows no dependency
 *   and decides no transport policy — it flips db-p2p's own switch
 *   ({@link WS_TRANSPORT_SWITCH_PORT}).
 * - **Everything else is REFUSED.** Deriving `/quic-v1`, `/webrtc` or `/webtransport`
 *   would mean importing transport packages into every `cadre-core` consumer including
 *   the React Native and browser bundles (against the cross-platform rule in
 *   `AGENTS.md`) and duplicating policy `libp2p-node.ts` owns. So name the address, name
 *   the transport it needs, and refuse to start — matching how `network.relayAddrs` and
 *   `network.announceAddrs` already treat an operator typo.
 *
 * Returns `{}` unconditionally when `network.transports` is set: a programmatic embedder
 * supplying transport factories owns the policy, and the factories are opaque — nothing
 * can be inferred from them. That is what keeps the RN phone, the web app, and the
 * integration-test harness unaffected.
 *
 * NOTE: pairing this with {@link resolveListenAddrs} is a CONVENTION, not a structure —
 * a third libp2p-node build site could resolve listen addrs and forget to call this,
 * putting the original bug back on that path. Both existing sites are covered
 * (`cadre-node.ts` → `buildControlNodeOptions`, `strand-network-config.ts` →
 * `strandNodeAddrs`), and they are the only two `createLibp2pNode` callers in this repo
 * that derive their listen set from a `NetworkConfig` — the other callers
 * (`integration-tests/src/harness/test-party.ts`, `quereus-plugin-sereus`'s `connect.ts`
 * and `connect-browser.ts`) pass no `listenAddrs` at all, or pass their own transports
 * with it. If a third CONFIG-derived site appears, fold the two functions into one that
 * returns listen addrs and transport options together, so forgetting becomes impossible
 * rather than merely unlikely.
 *
 * @param listenAddrs the ALREADY-resolved listen set — the output of
 *   {@link resolveListenAddrs}, or the strand derivation, after any per-node rewriting —
 *   so the check reads what this node will actually bind.
 * @throws {UnbindableListenAddressError} when a listen entry names a transport outside
 *   {tcp, ws/wss, p2p-circuit}.
 */
export declare function resolveTransportOptions(network: NetworkConfig | undefined, listenAddrs: readonly string[] | undefined): ListenTransportOptions;
/**
 * Thrown at config resolution when `network.listenAddrs` names an address none of the
 * default transports can bind. Names each offending address alongside the libp2p
 * transport package it would need — what the operator has without this is a node that
 * starts and silently never listens there.
 */
export declare class UnbindableListenAddressError extends Error {
    readonly listenAddrs: readonly string[];
    constructor(listenAddrs: readonly string[]);
}
/**
 * Thrown out of `CadreNode.start()` when the boot-path reservation drive for
 * `network.relayAddrs` produces no `/p2p-circuit` address on its FIRST attempt,
 * UNLESS `network.requireRelay` is explicitly `false` (see `driveControlRelayReservation`,
 * which logs and returns instead on that posture).
 *
 * This is what keeps `network.relayAddrs` fail-fast by default now that the control node
 * listens on the bare search entry: libp2p's own `UnsupportedListenAddressesError` used
 * to abort start from inside `listen()`, and an operator who names a relay is
 * telling the node it has no other reachability — coming up undialable is worse
 * than not coming up. Names the relays and the reservation's own reason, both of
 * which the libp2p error omitted.
 */
export declare class RelayReservationFailedError extends Error {
    readonly relayAddrs: readonly string[];
    readonly state: RelayReservationState;
    constructor(relayAddrs: readonly string[], state: RelayReservationState);
}
/**
 * `<something>/p2p-circuit` — the configured shape, as opposed to the bare search
 * addr. An unparsable entry is `false`: libp2p reports a bad listen addr itself,
 * and this helper only ever ADDS a denial (or, on the strand path, a supervisor).
 */
export declare function isConfiguredCircuitListenAddr(listenAddr: string): boolean;
