/**
 * Device-token record helpers: the single source of truth for the bytes a node
 * signs when publishing its own `DeviceToken` row and re-verifies when resolving
 * another peer's row.
 *
 * Modeled directly on {@link peerRecordSignedPayload} (peer-record.ts): the signed
 * payload is a single SHA-256 digest over the shared domain-tagged field vector
 * (see control-authorization.ts) — the crypto plugin's injective multi-field
 * encoding, so no field split is ambiguous even with an opaque platform token. It
 * is intentionally NOT JSON-canonicalized (deterministic across node/browser/RN,
 * no key ordering) and is reconstructable inside the `DeviceToken.AuthorizedUpdate`
 * SQL constraint from the row's own columns:
 *
 *   digest('CadreControl.DeviceToken', 'publish',
 *          new.PeerId, new.Platform, new.Token, cast(new.UpdatedAt as text))
 *
 * Keep {@link deviceTokenSignedPayload} and that constraint byte-for-byte in sync.
 * The `'publish'` action tag marks this as a peer's SELF-signed record (signed with
 * the peer's own key, not an owner key) and keeps it disjoint from every
 * owner-signed digest.
 *
 * Unlike a peer-address record, a device-token record carries NO public key: the
 * signature is verified against the `CadrePeer.PublicKey` bound to the same PeerId
 * (the resolver supplies it), so the key binding is checked exactly once, where the
 * membership row already lives.
 */
import { digest, sign, verify } from '@optimystic/quereus-plugin-crypto';
import { controlAuthorizationFields } from './control-authorization.js';
/**
 * Build the base64url SHA-256 digest that the self-signature covers. Mirrors the
 * `DeviceToken.AuthorizedUpdate` constraint exactly; both sides take the default
 * base64url output of a single `digest(...)`, which round-trips cleanly.
 */
export function deviceTokenSignedPayload(record) {
    const fields = controlAuthorizationFields('CadreControl.DeviceToken', 'publish', [record.peerId, record.platform, record.token, String(record.updatedAt)]);
    return digest(fields, 'sha256', 'base64url');
}
/**
 * Sign a device-token record with the ed25519 private key behind its `peerId`.
 * Returns a fully-populated {@link DeviceTokenRecord}.
 *
 * @param fields - the record fields to sign
 * @param privateKeyB64 - base64url ed25519 seed (see `ed25519KeyPairFromLibp2p`)
 */
export function signDeviceTokenRecord(fields, privateKeyB64) {
    const payloadDigest = deviceTokenSignedPayload(fields);
    const sig = sign(payloadDigest, privateKeyB64, 'ed25519', 'base64url', 'base64url', 'base64url');
    return { peerId: fields.peerId, platform: fields.platform, token: fields.token, updatedAt: fields.updatedAt, sig };
}
/**
 * Verify a record's self-signature against the `CadrePeer.PublicKey` (base64url)
 * bound to its `peerId`. Reconstructs the signed bytes from the record exactly as
 * {@link signDeviceTokenRecord} produced them. Returns false on a missing key/sig or
 * any verification failure.
 */
export function verifyDeviceTokenSignature(record, publicKeyB64) {
    if (!publicKeyB64 || !record.sig) {
        return false;
    }
    const payloadDigest = deviceTokenSignedPayload(record);
    return verify(payloadDigest, record.sig, publicKeyB64, 'ed25519', 'base64url', 'base64url', 'base64url');
}
/** Narrow an arbitrary stored string to a known {@link PushPlatform}. */
export function isPushPlatform(value) {
    return value === 'fcm' || value === 'apns';
}
//# sourceMappingURL=device-token.js.map