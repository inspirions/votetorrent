import { sendNotImplemented, type RouteHandler } from '../http.js'

/**
 * routes/upload.ts — `POST /bootstrap/uploads`.
 *
 * **Stub. Plan `52-08` fills this one file and never edits `server.ts`**, whose
 * route table already maps this path to this exported handler.
 *
 * ## What lands here
 *
 * The request body is
 * `{ lookupId, expiresAt, sealed: { v, nonce, ciphertext }, revokeLookupId? }`.
 *
 * **The bearer gate.** Uploads are gated by the operator-configured token in
 * `ctx.config.uploadToken`. Compare it in constant time with `node:crypto`'s
 * `timingSafeEqual` — an ungated write endpoint is a disk-fill invitation the
 * service cannot detect, because it can read neither a real upload nor a junk
 * one. Redemption needs no equivalent guessing rate limit (the secret is 160
 * bits), but this endpoint does.
 *
 * **The size ceiling.** `readJsonBody(req, ctx.config.maxUploadBytes)` from
 * `../http.js` already enforces a streaming byte ceiling that does not trust
 * `Content-Length`. Map its `RequestBodyTooLargeError` to a `413` whose body
 * **names** `ctx.config.maxUploadBytes`, so an operator who hits it learns the
 * limit rather than guessing at it.
 *
 * **Revocation is a field, not an endpoint.** A second mint revokes the first,
 * and the service cannot infer that for itself — it sees only a look-up id and
 * an expiry and has no notion that two codes belong to one authority. So
 * `revokeLookupId` travels on this request and must be applied **before** the
 * new record is written.
 *
 * Return the outcome; do not log. `server.ts` owns the single logging call.
 */
export const handleUpload: RouteHandler = async (_req, res, _ctx) => {
	return sendNotImplemented(res)
}
