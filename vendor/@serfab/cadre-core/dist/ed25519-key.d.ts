import type { PrivateKey } from '@libp2p/interface';
/**
 * An Ed25519 keypair expressed in the base64url form that
 * `@optimystic/quereus-plugin-crypto` (`sign`/`verify`/`getPublicKey`) consumes.
 * Generic bridge type — reused for owner keys, member keys, and any other
 * seed→public keypair the control/strand databases sign with.
 */
export interface Ed25519KeyPair {
    /** 32-byte Ed25519 seed, base64url-encoded — the crypto-plugin private key. */
    privateKeyB64: string;
    /** 32-byte Ed25519 public key, base64url-encoded. */
    publicKeyB64: string;
}
/**
 * Bridge a libp2p Ed25519 private key into the base64url keypair used by the
 * control- and strand-database signing constraints.
 *
 * libp2p stores an Ed25519 private key as 64 raw bytes: the first 32 are the
 * seed (the actual scalar source), the last 32 are the public key — see
 * `@libp2p/crypto`'s `Ed25519PrivateKey`. `@optimystic/quereus-plugin-crypto`
 * (via `@noble/curves`) treats the 32-byte seed *as* the private key and
 * derives the public key from it with standard Ed25519. The two derivations
 * agree, so the node's peer identity and its signing key are one keypair:
 * `getPublicKey(privateKeyB64)` === `publicKeyB64`.
 *
 * @param privateKey - The node's libp2p Ed25519 private key.
 * @returns The base64url seed/public-key pair for signing operations.
 * @throws If the key is not Ed25519 or the raw bytes aren't the expected length.
 */
export declare function ed25519KeyPairFromLibp2p(privateKey: PrivateKey): Ed25519KeyPair;
/**
 * Derive the base64url Ed25519 public key from a base64url 32-byte private seed
 * — the same derivation the seed-bootstrap signer uses internally
 * (`SeedBootstrapService` constructor). Use this to enroll a standalone
 * (non-libp2p) key into the control DB before minting an invite, when the
 * key is *not* the node's peer identity (so `ed25519KeyPairFromLibp2p`,
 * which needs a libp2p key object, does not apply).
 *
 * @param privateKeyB64 - The base64url-encoded 32-byte Ed25519 seed.
 * @returns The base64url-encoded Ed25519 public key.
 */
export declare function ed25519PublicKeyFromPrivate(privateKeyB64: string): string;
/**
 * Reject a value that isn't shaped like a base64url-encoded 32-byte Ed25519 public key
 * before it reaches the control database, where a malformed key would otherwise sit
 * indistinguishable from a real one until some later, unrelated signature check fails.
 *
 * Trims first, reusing the blank-value message for an empty result so that case keeps its
 * existing wording instead of a confusing base64url error. Every rejection names the offending
 * value (capped, see {@link describeRejected}) — with several keys in one batch, the message is
 * the only thing that says WHICH one. Does not check the decoded bytes
 * are a valid point on the Ed25519 curve — a well-formed-but-off-curve key still fails
 * signature verification later exactly like any other wrong key.
 *
 * **This rule is restated once outside this package**, in `validateOwnerKey`
 * (`packages/cadre-provider/src/server/owner-key-validation.ts`): cadre-provider declares no
 * `workspace:` dependencies and validates `POST /containers` pins over `uint8arrays`
 * directly. Change the rule here and change it there — the copies are kept in step by
 * hand, since neither package can import the other's. Each side pins its own copy to the
 * same accept/reject table (`test/ed25519-key.spec.ts` here,
 * `create-container-owner-keys.test.ts` there), so a change fails the suite of the
 * package it was made in and lands the editor on this pointer.
 *
 * @param value - Candidate base64url-encoded Ed25519 public key.
 * @param label - Human-readable name of the field, used in error messages.
 * @returns The trimmed value, so callers write the same bytes they validated.
 */
export declare function requireEd25519PublicKeyB64(value: string, label: string): string;
