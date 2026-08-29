import { sendNotImplemented, type RouteHandler } from './http.js'

/**
 * static.ts — the fallback handler for every path outside the reserved
 * `/bootstrap/` API prefix.
 *
 * **Stub. Plan `52-04` fills this one file and never edits `server.ts`**, whose
 * dispatcher already falls through to this exported handler.
 *
 * ## What lands here
 *
 * **Why one process serves both.** The dashboard sets its API base URL to
 * `window.location.origin` (`Bootstrap.tsx:55`), so the API and the built
 * `dist/` must share one origin. Serving both from this process is what makes
 * that true with no CORS story and no extra configuration surface.
 *
 * **Serve from `ctx.config.distDir`** — an operator-configured path, never a
 * build-time copy into this package. The parsed field is the contract; the
 * environment variable behind it is `BOOTSTRAP_RENDEZVOUS_DIST_DIR` and nothing
 * outside `config.ts` should read it.
 *
 * **SPA fallback to `index.html`** for any path that is not a real file. That
 * is safe here precisely because `server.ts` reserves the whole `/bootstrap/`
 * prefix for the API and answers `404` there itself — this handler is never
 * reached for an API path, so it can never mask one with an HTML page.
 *
 * **Carry the stale-`dist/` warning into the operator docs.** A stale build
 * silently serves old JavaScript against a new API, and this project has
 * already paid for that defect class more than once. The failure mode is a
 * screen that looks fine and behaves as though a fix were never made.
 *
 * Return the outcome; do not log. `server.ts` owns the single logging call.
 */
export const handleStatic: RouteHandler = async (_req, res, _ctx) => {
	return sendNotImplemented(res)
}
