/**
 * timeline-layout (61-01, D-08) — the single hoisted source of truth for the Timeline card's
 * vertical margin.
 *
 * What this is: the vertical gap between stacked Timeline cards, raised from `8` to `16` per this
 * phase's UI-SPEC so the inter-card gap matches the card's own internal padding
 * (`globalStyles.cardSurface.paddingVertical`).
 *
 * Who consumes it: `TimelineRow`'s `styles.card.marginVertical` and `TimelineRail`'s
 * `dotCenterY` alignment formula. These two values MUST NOT desync — if the card's margin
 * changes and the rail's dot-centre math does not, the dots stop lining up with their card
 * titles.
 *
 * The literal `16` for this value lives in exactly ONE place in the repo: this constant.
 * Re-typing it anywhere else (a second hand-copied literal) is the specific defect this module
 * exists to prevent.
 *
 * Deliberately unimported as of this plan (61-01): the wiring lands in a later plan of this same
 * phase (61-06, wave 4). Until then, `TimelineRow.tsx` still reads `marginVertical: 8` and
 * `TimelineRail.tsx` still reads `const CARD_MARGIN_V = 8;` — both unmodified on purpose.
 */
export const TIMELINE_CARD_MARGIN_V = 16;
