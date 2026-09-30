/**
 * identity-key — the load-or-create rule for a {@link KeyStore}-backed node
 * identity, plus the "prove you hold this node key" signer built on top of it.
 *
 * Both live here because both are needed *outside* `CadreNode`: an embedding app
 * (the React Native reference app) has to resolve its identity key before the node
 * is constructed, so it can sign an out-of-band HTTP request with the same key the
 * node will then load. Keeping one copy of the load-or-create rule is load-bearing
 * — a second copy that drifted could generate a fresh key and orphan the real
 * identity.
 *
 * Dependency-free beyond `@libp2p/crypto` + `uint8arrays` (both already core
 * dependencies), so this module is safe in every (RN / browser / Node) entry graph.
 */
import debug from 'debug';
import { generateKeyPair, privateKeyToProtobuf, privateKeyFromProtobuf, publicKeyToProtobuf } from '@libp2p/crypto/keys';
import { toString as uint8ArrayToString } from 'uint8arrays';
import { DEFAULT_IDENTITY_KEY_ID } from './key-store.js';
const log = debug('sereus:cadre:identity-key');
/**
 * Load the node identity key from `keyStore`, generating and persisting a fresh
 * Ed25519 key when the slot is empty.
 *
 * A rejected `get` (e.g. {@link KeyStoreAccessError} from a cancelled biometric
 * prompt) **propagates** — we never fall through to generation on a read error,
 * because that would silently orphan an existing but momentarily unreadable
 * identity. Corrupt bytes in the slot likewise throw rather than regenerate.
 *
 * Idempotent in effect: a second call on a populated store loads the stored key
 * and writes nothing.
 *
 * @param keyStore - Backend the identity is read from / persisted to.
 * @param keyId - Slot id; defaults to {@link DEFAULT_IDENTITY_KEY_ID}.
 * @returns The resolved libp2p private key.
 */
export async function loadOrCreateIdentityKey(keyStore, keyId = DEFAULT_IDENTITY_KEY_ID) {
    // A rejection here (e.g. KeyStoreAccessError) must propagate — do NOT fall
    // through to generation, which would orphan an existing but unreadable key.
    const bytes = await keyStore.get(keyId);
    if (bytes) {
        // Corrupt/garbage bytes throw here; surface loudly rather than
        // regenerating (which would orphan the real identity).
        const loaded = privateKeyFromProtobuf(bytes);
        log('Identity key loaded from key store (slot present)');
        return loaded;
    }
    const generated = await generateKeyPair('Ed25519');
    await keyStore.set(keyId, privateKeyToProtobuf(generated));
    log('Identity key generated and persisted to key store (first run)');
    return generated;
}
/**
 * Wrap a libp2p private key as a {@link PeerKeySigner}.
 *
 * Ed25519 only: the peer id is derived as an identity multihash (so
 * `publicKey.toString()` already *is* the base58btc peer id — no `@libp2p/peer-id`
 * round trip needed), and verifiers of this proof accept nothing else.
 *
 * @param privateKey - The node's libp2p Ed25519 private key.
 * @returns A signer exposing the peer id, the encoded public key, and `sign`.
 * @throws If the key is not Ed25519.
 */
export function peerKeySigner(privateKey) {
    if (privateKey.type !== 'Ed25519') {
        throw new Error(`peerKeySigner requires an Ed25519 key, got ${privateKey.type}`);
    }
    const publicKey = privateKey.publicKey;
    // For Ed25519 the public key's digest is an identity multihash, so its string
    // form is the peer id itself — the same value `peerIdFromPrivateKey` produces.
    const peerId = publicKey.toString();
    const publicKeyB64 = uint8ArrayToString(publicKeyToProtobuf(publicKey), 'base64url');
    return {
        peerId,
        publicKeyB64,
        async sign(message) {
            const signature = await privateKey.sign(new TextEncoder().encode(message));
            return uint8ArrayToString(signature, 'base64url');
        }
    };
}
//# sourceMappingURL=identity-key.js.map