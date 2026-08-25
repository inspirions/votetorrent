/**
 * src/bootstrap/index.ts — the `./bootstrap` subpath barrel (D-06, D-07).
 *
 * Re-exports the seam (`bootstrap-transport.ts`), the REST binding
 * (`rest-bootstrap-transport.ts`), and 50-02's envelope contract
 * (`snapshot-types.ts` / `snapshot-codec.ts` / `snapshot-manifest.ts`).
 *
 * **The filesystem binding is deliberately EXCLUDED from this barrel.**
 * `filesystem-bootstrap-transport.ts` imports `node:fs/promises` and is
 * therefore not bundleable by a browser or by React Native. It must not be
 * added here, must not get an index re-export, and must not become
 * reachable from the package root. In Phase 50 its only consumer is this
 * package's own conformance suite, which imports its deep source path
 * directly (`../src/bootstrap/filesystem-bootstrap-transport.js`). A future
 * edit that adds a filesystem-bootstrap-transport re-export to this barrel
 * would drag `node:fs` into the browser dashboard bundle and the React
 * Native app bundle at once — exactly the failure class this project has
 * hit before.
 */

export * from './bootstrap-transport.js'
export { RestBootstrapTransport } from './rest-bootstrap-transport.js'
export type { RestBootstrapTransportOptions } from './rest-bootstrap-transport.js'
export * from './snapshot-types.js'
export * from './snapshot-codec.js'
export * from './snapshot-manifest.js'
