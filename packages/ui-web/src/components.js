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
 * This barrel re-exports nothing yet. `AdvisoryDisclosure` and `LifecyclePill`
 * arrive in 53-05 (D-01/D-02/D-07), each behind its own `./components/Name.js`
 * specifier backed by a same-named `.tsx` file — never a `.js` file on disk,
 * or the ERR_MODULE_NOT_FOUND proof stops being real.
 */

export {};
