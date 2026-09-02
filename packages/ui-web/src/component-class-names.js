#!/usr/bin/env node
/**
 * component-class-names.js — the single enumerated list of every class name
 * a shared `@votetorrent/ui-web` component can render, keyed by the export
 * name each consumer's harness (and any tier-1 CSS class-name coverage
 * checker) mounts.
 *
 * Manually maintained rather than parsed out of each component's own `.tsx`
 * source, because `LifecyclePill`'s phase modifier is constructed at runtime
 * (`` `lifecycle-pill--${phase}` ``, `LifecyclePill.tsx`) from a TypeScript
 * union type, not a literal string a regex could safely enumerate without
 * either missing a modifier or hallucinating one. `AdvisoryDisclosure` and
 * `DetailsToggle` render only literal class names, so those two entries
 * ARE mechanically checkable — see `test/component-class-names.test.mjs` for
 * the positive-control proof that every entry below agrees with what its own
 * component source can literally produce.
 *
 * This module is tooling, not public API: it is deliberately NOT in this
 * package's `exports` map. `scripts/lib/css-class-coverage.mjs` (CR-01, the
 * repo's tier-1 dependency-free CSS-coverage check) reads it via a direct
 * `file://` import of this file's own path — never through the
 * `@votetorrent/ui-web` package specifier, so Node's `exports` encapsulation
 * never applies to it.
 *
 * `.dt-toggle` and `.dt-body` are included here (they are, after all, class
 * names `DetailsToggle` renders) even though CR-01 found no styling gap for
 * them in either current consumer — both apps already authored those two
 * rules independently in their own `app.css`. Omitting them here would make
 * the coverage check silently blind to a FUTURE regression (an app that
 * removes its own `.dt-toggle`/`.dt-body` rule while still mounting
 * `DetailsToggle`), which is exactly the class of gap this checker exists to
 * close.
 *
 * @type {Readonly<Record<string, ReadonlyArray<string>>>}
 */
export const COMPONENT_CLASS_NAMES = Object.freeze({
	AdvisoryDisclosure: Object.freeze(['pv-disclosure']),
	LifecyclePill: Object.freeze([
		'lifecycle-pill',
		'lifecycle-pill--organizing',
		'lifecycle-pill--running',
		'lifecycle-pill--released',
	]),
	DetailsToggle: Object.freeze(['dt-toggle-group', 'dt-toggle', 'dt-body']),
});
