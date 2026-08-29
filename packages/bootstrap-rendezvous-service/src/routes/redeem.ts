import { sendNotImplemented, type RouteHandler } from '../http.js'

/**
 * routes/redeem.ts — `POST /bootstrap/redemptions`.
 *
 * **Stub. Plan `52-09` fills this one file and never edits `server.ts`**, whose
 * route table already maps this path to this exported handler.
 *
 * ## What lands here
 *
 * This is the B-1 half of the locked wire protocol declared at
 * `packages/vote-engine/src/bootstrap/rest-bootstrap-transport.ts:35-44`. The
 * request is keyed on the **derived look-up id**, never on the raw secret the
 * officer read aloud — the secret half never reaches this process at all, and
 * is what the browser uses to unseal.
 *
 * **Preserve the shipped refusal ordering exactly:** unknown -> expired ->
 * used -> ok, as at
 * `packages/vote-engine/src/bootstrap/filesystem-bootstrap-transport.ts:114-159`.
 * The atomic claim happens **before** anything is served, so two concurrent
 * redemptions cannot both win.
 *
 * **Compare `expiresAt` as a raw string** against
 * `new Date().toISOString().slice(0, 19)`. Canonical form sorts
 * lexicographically; never route either side through a date parser.
 *
 * **Erase the ciphertext on serve.** The record survives its grace window
 * payload-free so later answers stay `used`/`expired` instead of degrading to
 * `unknown`; the payload does not.
 *
 * **Delivery is at-most-once.** If the response is lost in transit the code is
 * burned and the officer mints a new one. That is the intended trade: a
 * replayable delivery would defeat the single-use property that makes a
 * ten-minute code safe to read aloud.
 *
 * Return the outcome; do not log. `server.ts` owns the single logging call.
 */
export const handleRedeem: RouteHandler = async (_req, res, _ctx) => {
	return sendNotImplemented(res)
}
