/**
 * @votetorrent/ui-web — the `./components` barrel.
 *
 * Binding rule (D-16, counterpart to src/index.js's contract): every
 * re-export in this file uses a `./components/Name.js` specifier that
 * resolves to a same-named `./components/Name.tsx` file on disk. Vite (and
 * every bundler in this repo) resolves that `.js` specifier to the `.tsx`
 * file via its `moduleResolution: "bundler"` extension-probing; plain Node
 * does NOT perform that probe and throws `ERR_MODULE_NOT_FOUND` importing
 * this subpath directly. That throw is the intended, gated behaviour — proof
 * that a consumer never reaches this subpath from a bundler-less `node --test`
 * tier — not a bug to be "fixed" by merging this barrel into `./index.js`.
 *
 * `AdvisoryDisclosure`, `LifecyclePill` and `DetailsToggle` landed in 53-05
 * (D-01/D-02/D-07/D-12), each behind its own `./components/Name.js`
 * specifier backed by a same-named `.tsx` file — never a `.js` file on disk,
 * or the ERR_MODULE_NOT_FOUND proof stops being real. Only the runtime
 * value is re-exported here, not the prop-type interfaces: this file has a
 * plain `.js` extension and a bundler's default JS/JSX loader does not parse
 * TypeScript-only syntax such as `export type { ... }`, so a type-only
 * re-export would break parsing rather than merely being redundant.
 */

export { AdvisoryDisclosure } from './components/AdvisoryDisclosure.js';
export { LifecyclePill } from './components/LifecyclePill.js';
export { DetailsToggle } from './components/DetailsToggle.js';
