/**
 * Control-cohort dial selection: the pure policy behind
 * {@link CadreNode.reconcileControlCohort}. Decides WHICH known cadre siblings a
 * node proactively dials each pass to keep the `CadreControl` collections' cohort
 * connected (and thus replicating), without devolving into an N² mesh.
 *
 * FRET only needs a *connected* graph with the block clusters reachable, not a
 * full mesh. Storage/owner nodes are the stable, publicly-dialable backbone
 * that hold the control blocks, so the policy is **backbone-preferential with a
 * bounded out-degree**:
 *
 * - **Always dial every backbone (owner) member** — the owner set is
 *   small by design, and routing cohort formation through publicly-dialable
 *   owner nodes keeps the cohort ≥2 where owner-signed writes originate.
 * - **Fill the remainder** up to `targetDegree` with non-owner members,
 *   ordered deterministically (peerId sort) so every node makes the same stable
 *   choice across passes and load spreads predictably.
 *
 * For a small party (members ≤ degree) this degenerates to a full mesh, which is
 * correct, cheap, and matches what the convergence tests do by hand; for a large
 * party it bounds out-degree to `backbone + targetDegree`.
 */
import type { CohortPeerRow } from './strand-cohort.js';
/**
 * Default recurring cadence for {@link CadreNode.reconcileControlCohort} (ms).
 * In the same spirit as the 5s strand-watch poll but lighter, since a control
 * cohort changes far less often than strand activity.
 *
 * An interval between pass starts, not a deadline on a pass. Passes are
 * single-flight, so a pass that runs longer than this is joined rather than
 * stacked, and the effective cadence becomes the pass length: one unreachable
 * sibling's dial alone can take the whole per-peer dial budget (64 s at the
 * default declared link).
 */
export declare const DEFAULT_CONTROL_COHORT_RECONCILE_MS = 15000;
/**
 * Default cap on the number of **non-owner** members a single reconcile pass
 * proactively dials. Backbone (owner) members are always dialed and do NOT
 * count against this cap.
 */
export declare const DEFAULT_CONTROL_COHORT_TARGET_DEGREE = 6;
/** Outcome of {@link selectControlCohortDials}: who to dial + what the cap dropped. */
export interface ControlCohortSelection {
    /**
     * Siblings to dial this pass, backbone first then the bounded non-owner
     * fill. Already self-excluded (the caller must pass self-excluded `siblings`).
     * Still includes peers that may turn out to be already-connected — the caller
     * diffs against live connections separately.
     */
    dials: CohortPeerRow[];
    /** Non-owner members dropped by the `targetDegree` cap (0 when none). */
    cappedNonOwner: number;
}
/** What one {@link CadreNode.reconcileControlCohort} pass did. */
export interface ControlCohortReconcileResult {
    /**
     * Peer ids this pass dialled and whose dial resolved, in dial order: selected
     * siblings on the steady-state pass, retained bootstrap peers on the cold-start
     * pass (the pass takes one branch or the other, never both). A peer already
     * connected when the pass began is never listed — the pass skips it. A resolved
     * dial can still be refused moments later by the remote's membership gate, so
     * an entry means "this pass opened a connection", not "that connection is still
     * open".
     */
    dialed: string[];
}
/**
 * Backbone-preferential, bounded-out-degree selection of control-cohort siblings
 * to dial.
 *
 * A member is **backbone** iff the ed25519 key derived from its peerId
 * (see {@link ed25519PublicKeyB64FromPeerId}) is in `ownerKeys`. All backbone
 * members are selected; non-owner members fill up to `targetDegree` in
 * deterministic peerId order.
 *
 * @param siblings - cadre members EXCLUDING self (the caller filters self out).
 * @param ownerKeys - the converged `OwnerKey` set; may be empty/partial
 *   before owner convergence, in which case no member classifies as backbone
 *   yet and the bounded fill still makes progress (preference sharpens later).
 * @param targetDegree - cap on non-owner dials (negative is treated as 0).
 */
export declare function selectControlCohortDials(siblings: CohortPeerRow[], ownerKeys: ReadonlySet<string>, targetDegree: number): ControlCohortSelection;
