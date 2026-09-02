/**
 * phase-ids.js -- the dependency-free half of the election lifecycle phase
 * model (WR-11, Phase 53 review).
 *
 * Split out of `election-phase.js` specifically so `LifecyclePill.tsx` (a
 * `./components` barrel member, per `src/components.js`) can depend on
 * `PHASE_IDS`/`phaseCopyKey` WITHOUT transitively pulling in
 * `@votetorrent/vote-engine/browser` -- a database engine that
 * `election-phase.js`'s header explicitly names as the reason `./lifecycle`
 * is kept OUT of the `.` barrel (measured 0.30-0.44s vs 0.02s bare). Before
 * this split, `LifecyclePill.tsx` imported `phaseCopyKey` directly from
 * `election-phase.js`, so `@votetorrent/ui-web/components` (the bundler-only
 * barrel `index.js`'s own header says stays plain-JS-consumer-safe) pulled
 * the engine in anyway -- exactly the coupling `index.js`'s split rationale
 * says should not happen.
 *
 * This module imports NOTHING beyond plain JavaScript: no `vote-engine`, no
 * `react`. Do not add an import here without re-checking that invariant --
 * it is what makes it safe for a bundler-only, React-only barrel to depend
 * on.
 *
 * `election-phase.js` re-exports both names below unchanged, so its own
 * `./lifecycle` public surface (and every existing consumer of
 * `@votetorrent/ui-web/lifecycle`) is unaffected by this split.
 */

/** @typedef {'organizing' | 'running' | 'released'} PhaseId */

/** The three lifecycle phase ids, in their natural order. Frozen; never derived at runtime. @type {ReadonlyArray<PhaseId>} */
export const PHASE_IDS = Object.freeze(['organizing', 'running', 'released']);

/**
 * @param {PhaseId | null} phase
 * @returns {string | null}
 */
export function phaseCopyKey(phase) {
	if (phase === 'organizing' || phase === 'running' || phase === 'released') {
		return `lifecycle.${phase}`;
	}
	return null;
}
