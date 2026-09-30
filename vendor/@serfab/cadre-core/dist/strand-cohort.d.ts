/**
 * A single CadrePeer membership row, as returned by
 * `ControlDatabase.queryCadrePeers()`.
 */
export interface CohortPeerRow {
    peerId: string;
    /** Comma-joined list of multiaddr strings; `''` when no addrs were recorded. */
    multiaddr: string | null;
}
/**
 * Derive the membership view of a strand's cohort from the control network's
 * CadrePeer rows: the peerIds of members other than `selfPeerId` — the
 * strand-addr RPC fan-out targets, deduplicated, in row order.
 *
 * Deliberately does NOT read `CadrePeer.Multiaddr` — that field carries each
 * node's *control*-network address, which must not seed the *strand* mesh
 * (dialing it reaches the remote's control instance, not its strand instance).
 * The strand-network bootstrap addresses are resolved on demand over the control
 * mesh from these peerIds.
 */
export declare function deriveCohortMembers(peers: CohortPeerRow[], selfPeerId?: string): string[];
