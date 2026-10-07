# VoteTorrent encryption wire formats

Phase 62 Plan 04 (D-03, D-04, D-13, D-18, D-25). This is the normative
specification for `packages/vote-engine/src/crypto/`: the per-officer
multi-recipient envelope (`vt-env-1`), the DKG-joint-key block-content
cipher (`vt-block-1`), and the `IKeyVault` storage contract. The
implementation in `src/crypto/*.ts` must match this document exactly; a
mismatch discovered during the Plan 04 Task 3 security review is a bug and
is fixed in whichever side is wrong (code or spec), never silently
reconciled by relaxing a test.

Every construction here is built only from `@noble/curves`, `@noble/hashes`
and `@noble/ciphers` 2.2.0 (D-25) — no hand-rolled curve, KDF or cipher math.

## 1. Conventions

These apply to every format below.

- **Public keys** are 66-character lowercase hex: a compressed secp256k1
  point, prefix `02` or `03`, per [SEC 1 v2.0] section 2.3.3 ("Elliptic
  Curve Point to Octet String Conversion") and [SEC 2 v2.0]'s curve
  parameters.
- **Secret keys** are raw 32-byte `Uint8Array`. A secret key is never a
  string on any path in this module.
- **Nonces, tags and ciphertexts** are unpadded base64url (RFC 4648 section
  5, no `=` padding).
- **AAD and other multi-field byte strings** use a length-prefixed
  encoding: for each field, in order, a 4-byte big-endian uint32 byte
  length, then the field's UTF-8 bytes. The first field is always the
  domain label (`vt-env-1/content`, `vt-env-1/wrap`, or `vt-block-1/content`
  below) — this is what makes a content AAD structurally unable to collide
  with a wrap AAD, independent of what any later field happens to contain.
- **ECDH input keying material (IKM)** is the 32-byte x-coordinate of the
  shared point: [SEC 1 v2.0] section 3.3.1 ("Elliptic Curve Diffie-Hellman
  Primitive"). `getSharedSecret(sk, pub, true)` returns 33 compressed
  bytes; byte 0 is the y-parity prefix, bytes 1..32 are the x-coordinate.
  This deliberately differs from a raw 33-byte shared-secret convention
  sometimes seen in research notes — it is what matches OpenSSL's
  `createECDH('secp256k1').computeSecret(pub)` and the standard.

## 2. The `vt-env-1` multi-recipient envelope (D-03, D-04)

A staged registration or association payload (the `InitJson` column) is
sealed once under a random content key (CK), and CK is wrapped once per
current officer's secp256k1 encryption key (`UserEncryptionKey.Alg =
'secp256k1-ecdh-hkdf-sha256-aes256gcm'`). Every strand peer, including
non-officer voters, sees only ciphertext.

### 2.1 Seal

**Content:**

1. `CK` = 32 random bytes. `nonce` = 12 random bytes.
2. `(Kenc || kc) = HKDF-SHA256(IKM=CK, salt=zero-length, info=UTF-8
   "vt-env-1/content", L=64)`, per [RFC 5869]. `Kenc` is bytes 0..31; `kc`
   (the key-commitment tag) is bytes 32..63.
3. `ct = AES-256-GCM(Kenc, nonce, plaintext, AAD = lp["vt-env-1/content",
   requestId, digest])`, per [NIST SP 800-38D]. `lp[...]` is the
   length-prefixed encoding from section 1.

**Per recipient i** (for every `{userId, publicKey}` in the caller's
recipient list):

1. A fresh ephemeral scalar `e_i` and `E_i = compressed(G * e_i)`.
2. `Z_i = x(e_i * R_i)` where `R_i` is recipient i's public key point —
   the section 1 ECDH convention.
3. `KEK_i = HKDF-SHA256(IKM=Z_i, salt=E_i || R_i (66 raw bytes), info=UTF-8
   "vt-env-1/wrap", L=32)`.
4. `wrap_i = AES-256-GCM(KEK_i, nonce_i, CK, AAD = lp["vt-env-1/wrap",
   userId, pubHex, ephHex, requestId, digest])` — 48 bytes (32-byte
   plaintext + 16-byte GCM tag).

**Wire object** (`SealedEnvelope`), member order fixed:

```json
{
  "v": 1,
  "alg": "vt-env-1",
  "nonce": "<base64url, 12 bytes>",
  "kc": "<base64url, 32 bytes>",
  "ct": "<base64url, >= 16 bytes>",
  "recipients": [
    { "userId": "...", "pub": "<66-char hex>", "eph": "<66-char hex>", "nonce": "<base64url, 12 bytes>", "wrap": "<base64url, 48 bytes>" }
  ]
}
```

### 2.2 Open

`openEnvelope` never throws. The check order is normative:

1. **Local arguments** — `secretKey` a valid 32-byte scalar, `userId`
   non-empty, `binding.requestId`/`binding.digest` non-empty strings.
   Failure reason: `'invalid-argument'`.
2. **Structural validation** — parse a string input as JSON inside a
   `try`; check every top-level member's type, `recipients` length in
   1..64, no duplicate `userId` within the list, and every `pub`/`eph`
   decodes to a valid on-curve compressed point. Any failure:
   `'malformed-envelope'`.
3. **Version/alg check** — `v === 1 && alg === 'vt-env-1'`, run BEFORE any
   decryption is attempted. Otherwise: `'unsupported-version'`.
4. **Decode fixed-length top-level fields** — `nonce` (12 bytes), `kc` (32
   bytes), `ct` (>= 16 bytes). Any failure: `'malformed-envelope'`.
5. **Select the caller's entry** — the recipient whose `userId` equals the
   caller's AND whose `pub` equals `encryptionPublicKeyFromSecret(secretKey)`.
   If none matches: `'not-a-recipient'`. The recipient list is public (it
   is what everyone on the strand already sees), so this lookup is not an
   oracle.
6. **ECDH + KEK + unwrap** — `Z = x(secretKey * eph)`, `KEK = HKDF(...)` as
   in 2.1 step 3, `CK = AES-256-GCM-decrypt(KEK, wrapNonce, wrap, wrapAAD)`.
7. **Derive and compare `kc`** — `(Kenc || kc') = HKDF(CK, ...)` as in 2.1
   step 2; compare `kc'` to the envelope's `kc` with `equalBytes` (constant
   time).
8. **Decrypt content** — `plaintext = AES-256-GCM-decrypt(Kenc, nonce, ct,
   contentAAD)`.

Steps 6-8 run inside **one** `try`/`catch`. Every failure inside that block
— wrong key, tampered `wrap`, tampered `ct`, tampered `nonce`, a `kc`
mismatch, or a transplanted `requestId`/`digest` — collapses to the exact
same reason: `'authentication-failed'`. The caught error's message is
discarded. A `detail` string anywhere in this module names structure only
(a member name, an observed byte length) and never a byte of key,
ciphertext or plaintext.

### 2.3 Why key commitment (the `kc` tag)

Plain AES-GCM is not key-committing: [USENIX-ABUSE] ("How to Abuse and Fix
Authenticated Encryption Without Key Commitment", Albertini, Duong, Gueron,
Kölbl, Luykx, Schmieg, USENIX Security 2022) shows that for suitably crafted
inputs, a single ciphertext can decrypt to two *different* plaintexts under
two different keys, both producing a valid GCM tag. In this envelope's
threat model that means a malicious requester could, in principle, craft a
payload where officer A and officer B — each decrypting with their own
correct secret key via their own correct wrap — would read different
plaintexts, with neither able to detect the discrepancy from their own
decryption succeeding.

`kc` closes that gap: it is a tag derived from the *single* content key CK,
independent of any recipient's key material, and every recipient's open
path checks it before trusting the decrypted content. Because `kc` is
bound only to CK (not to any one recipient), all recipients either agree on
`kc` or none of them do — there is no way to craft an envelope whose `kc`
passes for one recipient and silently fails for another while both still
"successfully" decrypt.

### 2.4 Relationship to RFC 9180 (HPKE) — explicitly NOT a claim of conformance

[RFC 9180] sections 4 and 5 describe HPKE's KEM/KDF/AEAD composition
pattern, and this envelope's per-recipient ECDH-then-HKDF-then-AEAD shape
is structurally inspired by it. **This is NOT an HPKE ciphersuite.** RFC
9180 registers no secp256k1 KEM (its registered KEMs are the NIST P-curves
and X25519/X448; research Assumption A1), so there is no standard HPKE
ciphersuite identifier this construction could claim. Treat the RFC 9180
citation as "the shape of a well-reviewed design pattern," not as "this is
RFC 9180."

## 3. The `vt-block-1` block-content cipher (D-18)

Vote and voter records inside election blocks are encrypted under the
joint election public key `Y` (the DKG group public key — the 33-byte
`commitments[0]` from `secp256k1_FROST.trustedDealer`/DKG, hex-encoded by
the caller), and decrypt only with the matching joint secret `s`.

**IMPORTANT — scope note.** The block producer that would call
`encryptBlockContent` over real vote/voter-record bytes does not exist
anywhere in this repository as of this plan (research Finding 6, Open Q5).
This section specifies the cipher API that 62-20 integrates with
`reconstructElectionKey`; it makes no claim about a block *format* beyond
"some plaintext bytes."

### 3.1 Encrypt

1. A fresh ephemeral scalar `e` and `E = compressed(G * e)`.
2. `Z = x(e * Y)` — the section 1 ECDH convention, keyed on the joint
   public key.
3. `(K || kc) = HKDF-SHA256(IKM=Z, salt=E || Y (66 raw bytes), info=UTF-8
   "vt-block-1/key", L=64)`.
4. `ct = AES-256-GCM(K, nonce, plaintext, AAD = lp["vt-block-1/content",
   electionId, decimalString(revision), blockId])`, per [NIST SP 800-38D].

**Wire object** (`BlockCiphertext`), member order fixed:

```json
{
  "v": 1,
  "alg": "vt-block-1",
  "eph": "<66-char hex>",
  "nonce": "<base64url, 12 bytes>",
  "kc": "<base64url, 32 bytes>",
  "ct": "<base64url, >= 16 bytes>"
}
```

### 3.2 Decrypt

`decryptBlockContent` never throws. Check order:

1. **Local arguments** — `jointSecretKey` a valid 32-byte scalar; binding
   fields valid (non-empty `electionId`/`blockId`, `revision` a
   non-negative safe integer). Failure: `'invalid-argument'`.
2. **Structural validation** — parse, check member types, and that `eph`
   decodes to a valid on-curve compressed point. Failure:
   `'malformed-ciphertext'`.
3. **Version/alg check**, before any decryption. Failure:
   `'unsupported-version'`.
4. **Decode lengths** — `nonce` (12), `kc` (32), `ct` (>= 16). Failure:
   `'malformed-ciphertext'`.
5. **ECDH + derive + compare `kc` + decrypt**, inside one `try`. `Y` is
   recomputed as `getPublicKey(jointSecretKey)` — this module is never
   handed `Y` directly on the decrypt path. Every failure:
   `'authentication-failed'`.

**Caller obligation (62-20):** because this module recomputes `Y` from the
supplied `jointSecretKey` rather than being handed `Y` independently, it
cannot distinguish "wrong-but-otherwise-valid scalar" from "tampering" —
both simply fail the GCM tag check and both report
`'authentication-failed'`. The caller (62-20's `reconstructElectionKey`
integration) **must assert `getPublicKey(s) == Y`** against the
independently-known election joint public key before calling
`decryptBlockContent`, so a reconstruction bug is caught as a reconstruction
bug rather than silently reported as ciphertext tampering.

## 4. The `IKeyVault` contract (D-13 storage leg)

`src/crypto/vault.ts` declares the port; 62-21 implements it against the
Authority app's native hardware-backed storage. This section is the
normative contract the native adapter must honor — the software
`InMemoryTestKeyVault` in this package enforces the same contract today so
the port and at least one implementation are proven together.

- **Copy semantics.** `putSecret` must store a copy of the bytes it is
  given — mutating the caller's array after the call must never change
  what is stored. `getSecret` must return a fresh copy on every call —
  mutating a previously returned array must never change what is stored,
  and two calls must not share a backing buffer.
- **`'alias-exists'` refusal.** `putSecret` on an alias that already holds
  a secret rejects with `'alias-exists'` and does not overwrite. This
  exists because the only copy of a DKG share or an officer encryption key
  must never be silently clobbered by a second write; the caller must call
  `deleteSecret` first if replacement is actually intended.
- **`hasSecret` never prompts**, even for an alias whose policy requires
  user auth — it answers "is something stored here" without touching
  whatever gate protects reading it.
- **`null` for absent.** `getSecret` on an alias nothing was ever stored
  under (or that was since deleted) returns `null`, not a thrown error.
- **`deleteSecret` is idempotent** and returns whether it actually removed
  something.
- **Error codes:**
  - `'invalid-alias'` — the alias fails `KEY_VAULT_ALIAS_PATTERN =
    /^[A-Za-z0-9_.:-]{1,128}$/`. Every method rejects this uniformly.
  - `'invalid-secret'` — `putSecret` was given something that is not a
    non-empty `Uint8Array`.
  - `'alias-exists'` — see above.
  - `'auth-denied'` — the stored policy requires user auth and the user
    (or the test harness's `authorize` hook) refused.
  - `'unavailable'` — reserved for an adapter (62-21) whose native backend
    is missing or unreachable. The in-process test vault never returns
    this code.
- **No plaintext at rest in a real adapter.** `IKeyVault`'s JSDoc states
  that a production adapter stores only hardware-wrapped bytes (62-08's
  `wrapSecret`/`unwrapSecret`), never plaintext. `InMemoryTestKeyVault` is
  the one deliberate exception, and it is marked **TEST ONLY** and never
  re-exported from any barrel.

## 5. References

- **[SEC 1 v2.0]** — Standards for Efficient Cryptography Group, *SEC 1:
  Elliptic Curve Cryptography*, version 2.0, 2009. Sections 2.3.3 (point
  encoding) and 3.3.1 (ECDH primitive).
- **[SEC 2 v2.0]** — Standards for Efficient Cryptography Group, *SEC 2:
  Recommended Elliptic Curve Domain Parameters*, version 2.0, 2010. The
  secp256k1 curve parameters and generator point.
- **[RFC 5869]** — H. Krawczyk, P. Eronen, *HMAC-based Extract-and-Expand
  Key Derivation Function (HKDF)*, RFC 5869, May 2010.
- **[NIST SP 800-38D]** — NIST Special Publication 800-38D,
  *Recommendation for Block Cipher Modes of Operation: Galois/Counter Mode
  (GCM) and GMAC*, November 2007.
- **[GCM-TEST-VECTORS]** — D. McGrew, J. Viega, *The Galois/Counter Mode of
  Operation (GCM)*, submission to NIST, including the published AES-256-GCM
  test vectors (Test Case 16 is the one this module's KATs pin).
- **[RFC 5116]** — D. McGrew, *An Interface and Algorithms for Authenticated
  Encryption*, RFC 5116, January 2008. The general AEAD interface this
  module's AES-256-GCM usage conforms to.
- **[RFC 9180]** — R. Barnes, K. Bhargavan, B. Lipp, C. Wood, *Hybrid Public
  Key Encryption*, RFC 9180, February 2022. Cited as structural inspiration
  only — see section 2.4: this module is **not an HPKE ciphersuite**, since
  RFC 9180 registers no secp256k1 KEM.
- **[USENIX-ABUSE]** — A. Albertini, T. Duong, S. Gueron, S. Kölbl, A.
  Luykx, S. Schmieg, *How to Abuse and Fix Authenticated Encryption Without
  Key Commitment*, USENIX Security Symposium 2022. The rationale for this
  module's `kc` key-commitment tag — see section 2.3.

## 6. Non-claims

- **No forward secrecy** against a later compromise of a recipient's
  encryption secret key. Anyone who later obtains a recipient's secret key
  can decrypt every envelope ever wrapped to that recipient's public key.
- **Removed officers keep access to what was already wrapped to them**
  (D-04 + D-07: officer removal is forward-looking only). Conversely,
  **officers added later cannot read envelopes sealed before they were
  added**. This is a product rule, kept on purpose (D-51; user decision
  2026-10-07): officers added later, or who enable encrypted intake later,
  never receive access to envelopes sealed before they were added. No
  re-wrap or re-seal ceremony exists or is planned. An officer who was a
  recipient handles those records, and the app says so on the screens where
  it happens.
- **Not externally audited.** This is an in-repo, built-in review (D-25,
  Plan 04 Task 3) backed by published known-answer vectors and an
  independent `node:crypto` re-implementation — it is not a substitute for
  third-party cryptographic review.
- **Hermes device parity is unproven.** Every known-answer vector in this
  plan's test suite runs on Node only. The Metro/Hermes multi-copy `noble`
  bundling hazard (documented elsewhere in this project's spike findings)
  has not been re-checked against these specific vectors. 62-30 records
  this as proof debt; the FROZEN-ENV and FROZEN-BLOCK pins in
  `test/crypto-kat.spec.ts` / `test/block-cipher.spec.ts` are the exact
  vectors a future device-side KAT must reproduce byte-for-byte.
- **Officer encryption keys are stored without requiring user auth**
  (`OFFICER_ENCRYPTION_KEY_POLICY = { requireUserAuth: false }`), so that
  unattended intake processing can open envelopes without blocking on a
  biometric/PIN prompt per request (research Assumption A4). Keyholder DKG
  receiving keys and keyholder shares use `requireUserAuth: true`.
- **bigint arithmetic is not constant-time**, and the best-effort
  `.fill(0)` zeroization calls in `envelope.ts`/`block-cipher.ts` are
  exactly that — best effort. They are not a documented security property,
  and bigint/JIT copies of key material may still survive elsewhere in the
  process's memory after a call returns.

[SEC 1 v2.0]: #5-references
[SEC 2 v2.0]: #5-references
[RFC 5869]: #5-references
[NIST SP 800-38D]: #5-references
[GCM-TEST-VECTORS]: #5-references
[RFC 5116]: #5-references
[RFC 9180]: #5-references
[USENIX-ABUSE]: #5-references
