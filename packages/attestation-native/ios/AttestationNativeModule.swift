//
//  AttestationNativeModule.swift — iOS counterpart of the Android `AttestationNative` TurboModule.
//
//  STATUS: TYPECHECKS against the iOS 26.2 SDK (arm64-apple-ios15.1, exit 0). RUNTIME behaviour is
//  still UNPROVEN — App Attest returns `isSupported == false` on the Simulator, so every
//  Secure Enclave / App Attest / biometric claim below needs a physical iPhone. A clean typecheck
//  is not working attestation. See ../README.md for the remaining proof legs.
//
//  The one exception: the DER -> compact low-S signature conversion (SignatureEncoding.swift) is
//  pure byte manipulation and IS fully proven on the host — 17/17 against @noble/curves v2 vectors.
//
//  Mirrors the 5-method surface of
//  `packages/attestation-native/src/specs/NativeAttestation.ts` so the JS orchestration layer
//  (`real-attestation-producer.ts`) can stay platform-agnostic apart from the payload shape.
//
//  THE STRUCTURAL DIFFERENCE FROM ANDROID (spike 080): Android's Keystore key both carries the
//  attestation cert chain AND signs votes. Apple's App Attest key can ONLY be used via
//  `generateAssertion` — it cannot sign arbitrary payloads. So this module manages TWO keys:
//
//    K_att  — the App Attest key. Attests once, then only ever produces assertions.
//    K_vote — a separate Secure Enclave P-256 key. Signs ballots. Has NO attestation of its own.
//
//  K_vote is bound to the attested identity by an ASSERTION over a clientDataHash that commits to
//  K_vote's public bytes. That cross-sign is the entire security argument; without it K_vote is an
//  unattested key and the attestation proves nothing about the thing doing the voting.
//

import Foundation
// RCTPromiseResolveBlock / RCTPromiseRejectBlock live here. Guarded by canImport so the
// standalone `typecheck:ios` gate (which has no RN headers and supplies its own typealiases)
// still runs — but note that gate CANNOT catch a missing import: see scripts/typecheck-ios.sh.
// The authoritative check that this file compiles as the app compiles it is an actual
// `xcodebuild` of an app that pods this package.
#if canImport(React)
import React
#endif
import DeviceCheck
import CryptoKit
import LocalAuthentication
import Security

@objc(AttestationNative)
class AttestationNativeModule: NSObject {

  // Distinct from the Android aliases by design (D-07: different apps, different threat surfaces).
  private static let voteKeyTag = "org.votetorrent.voter.VOTE_KEY_V1"
  private static let recoveryKeyTag = "org.votetorrent.voter.RECOVERY_KEY_V1"
  private static let appAttestKeyIdDefaultsKey = "org.votetorrent.voter.APPATTEST_KEY_ID"

  @objc static func requiresMainQueueSetup() -> Bool { return false }

  // MARK: - Secure Enclave key helpers

  /// Creates a Secure Enclave P-256 key.
  ///
  /// `.biometryCurrentSet` is the iOS analogue of Android's
  /// `setInvalidatedByBiometricEnrollment(true)`: the key is destroyed if the enrolled biometric set
  /// changes. `.devicePasscode` is the analogue of `DEVICE_CREDENTIAL` and is NOT governed by
  /// biometric enrolment — which is exactly why the recovery key uses it (D-16).
  private func createSecureEnclaveKey(tag: String, requireBiometry: Bool) throws -> SecKey {
    var accessError: Unmanaged<CFError>?
    guard let access = SecAccessControlCreateWithFlags(
      kCFAllocatorDefault,
      kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
      requireBiometry ? [.privateKeyUsage, .biometryCurrentSet] : [.privateKeyUsage, .devicePasscode],
      &accessError
    ) else {
      throw accessError!.takeRetainedValue() as Error
    }

    let attributes: [String: Any] = [
      kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
      // The Secure Enclave supports P-256 and nothing else — which happens to match the project's
      // existing P-256/prehash/lowS signing contract exactly. No negotiation needed.
      kSecAttrKeySizeInBits as String: 256,
      kSecAttrTokenID as String: kSecAttrTokenIDSecureEnclave,
      kSecPrivateKeyAttrs as String: [
        kSecAttrIsPermanent as String: true,
        kSecAttrApplicationTag as String: tag.data(using: .utf8)!,
        kSecAttrAccessControl as String: access
      ]
    ]

    var error: Unmanaged<CFError>?
    guard let key = SecKeyCreateRandomKey(attributes as CFDictionary, &error) else {
      throw error!.takeRetainedValue() as Error
    }
    return key
  }

  private func loadKey(tag: String) -> SecKey? {
    let query: [String: Any] = [
      kSecClass as String: kSecClassKey,
      kSecAttrApplicationTag as String: tag.data(using: .utf8)!,
      kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
      kSecReturnRef as String: true
    ]
    var item: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess else { return nil }
    return (item as! SecKey)
  }

  // MARK: - Invalidated-key recovery (measured 2026-08-25)

  /// What a stored key can still DO, as opposed to whether it is merely present.
  ///
  /// These are not the same question, and conflating them wedged this app permanently. A Secure
  /// Enclave key destroyed by a biometric re-enrolment (`.biometryCurrentSet`) still satisfies
  /// `SecItemCopyMatching` and still yields a public key from `SecKeyCopyPublicKey` — it fails only
  /// at the moment of signing. So `loadKey(tag:) ?? create...` kept handing back a DEAD key forever:
  /// every ceremony would attest a key the device can never sign with, with no path back. Measured
  /// on an iPhone 13, 2026-08-25 — the vote key survived a Face ID change, `provisionDeviceKey`
  /// happily returned its public bytes, App Attest attested it, and only the §4 possession signature
  /// failed (CryptoTokenKit -3). Android never reaches this state because its path deletes and
  /// regenerates on every call.
  private enum KeyLiveness {
    case usable
    case invalidated
    /// Could not tell. Treated as usable — see `provisionDeviceKey`. NEVER delete on this.
    case indeterminate
  }

  /// Probe a key's liveness WITHOUT raising a biometric prompt.
  ///
  /// `provisionDeviceKey` is documented as key-creation-only and must never prompt, so this attaches
  /// an `LAContext` with `interactionNotAllowed` and attempts a signature over a throwaway digest.
  /// The point is the ERROR, not the signature:
  ///
  ///   * a LIVE biometry-gated key refuses for want of UI  -> `errSecInteractionNotAllowed` /
  ///     `LAError.notInteractive`, i.e. the key is fine, it just needs a prompt we deliberately
  ///     withheld;
  ///   * a DESTROYED key refuses because it no longer exists -> CryptoTokenKit -3 /
  ///     `errSecItemNotFound`.
  ///
  /// Anything else is `.indeterminate`. That asymmetry is deliberate and load-bearing: a false
  /// positive here DELETES a voter's device identity and forces a re-association, so this reports
  /// `.invalidated` only on a positive, specific signal and never on a generic failure.
  private func probeKeyLiveness(tag: String) -> (liveness: KeyLiveness, detail: String) {
    let context = LAContext()
    context.interactionNotAllowed = true

    let query: [String: Any] = [
      kSecClass as String: kSecClassKey,
      kSecAttrApplicationTag as String: tag.data(using: .utf8)!,
      kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
      kSecReturnRef as String: true,
      kSecUseAuthenticationContext as String: context
    ]
    var item: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &item)
    if status == errSecItemNotFound { return (.invalidated, "load:errSecItemNotFound") }
    guard status == errSecSuccess, let key = item else { return (.indeterminate, "load:OSStatus \(status)") }

    var error: Unmanaged<CFError>?
    // Content is irrelevant — only whether the Enclave will engage with the key at all.
    let scratch = Data(repeating: 0, count: 32)
    if SecKeyCreateSignature(key as! SecKey, .ecdsaSignatureDigestX962SHA256,
                             scratch as CFData, &error) != nil {
      // A key that signs with no interaction at all is alive (and simply not biometry-gated).
      return (.usable, "signed-without-interaction")
    }
    let err = error!.takeRetainedValue() as Error as NSError
    let detail = "\(err.domain):\(err.code)"

    // DOMAIN FIRST — the code spaces overlap (see signWith's identical warning).
    if err.domain == "CryptoTokenKit" && err.code == -3 { return (.invalidated, detail) }
    if err.domain == NSOSStatusErrorDomain && err.code == Int(errSecItemNotFound) { return (.invalidated, detail) }
    // The key is alive and correctly demanding the prompt we withheld.
    if err.code == Int(errSecInteractionNotAllowed) || err.code == LAError.notInteractive.rawValue {
      return (.usable, detail)
    }
    return (.indeterminate, detail)
  }

  private func deleteKey(tag: String) {
    let query: [String: Any] = [
      kSecClass as String: kSecClassKey,
      kSecAttrApplicationTag as String: tag.data(using: .utf8)!,
      kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom
    ]
    SecItemDelete(query as CFDictionary)
  }

  /// 33-byte compressed SEC1 point, hex — the `publicKeyCompressedHex` contract (D-04/D-08).
  /// `SecKeyCopyExternalRepresentation` yields UNCOMPRESSED X9.62 (0x04‖X‖Y); compression is ours
  /// to do. Getting this wrong registers a `UserKey.PubKey` that can never verify, and `verify()`
  /// swallows exceptions and returns false — so it fails closed AND silently.
  private func compressedHex(from publicKey: SecKey) throws -> String {
    var error: Unmanaged<CFError>?
    guard let data = SecKeyCopyExternalRepresentation(publicKey, &error) as Data? else {
      throw error!.takeRetainedValue() as Error
    }
    guard data.count == 65, data[0] == 0x04 else {
      throw NSError(domain: "AttestationNative", code: 1,
                    userInfo: [NSLocalizedDescriptionKey: "unexpected public key encoding (\(data.count) bytes)"])
    }
    let x = data.subdata(in: 1..<33)
    let y = data.subdata(in: 33..<65)
    let prefix: UInt8 = (y[y.count - 1] % 2 == 0) ? 0x02 : 0x03
    return ([prefix] + x).map { String(format: "%02x", $0) }.joined()
  }

  // DER -> compact low-S conversion lives in SignatureEncoding.swift as free functions so it can be
  // unit-tested on the host without an iPhone (it is pure byte manipulation). It is PROVEN there
  // against @noble/curves v2 vectors — 12 signatures incl. 6 high-S, plus 5 malformed inputs.
  //
  // THE TRAP it exists to close: Android's signWithDeviceKey returns compact low-S already; iOS
  // SecKeyCreateSignature returns DER and does NOT normalize S. Forwarding it unchanged fails
  // @noble/curves v2's default lowS:true as an ordinary "invalid signature", never a crash.

  // MARK: - (1) provisionDeviceKey

  /// Generates the App Attest key AND the separate Secure Enclave vote key.
  /// Resolves `{ publicKeyCompressedHex, appAttestKeyId, keyAlias }`.
  @objc(provisionDeviceKey:resolver:rejecter:)
  func provisionDeviceKey(_ keyAlias: String,
                          resolver resolve: @escaping RCTPromiseResolveBlock,
                          rejecter reject: @escaping RCTPromiseRejectBlock) {
    let service = DCAppAttestService.shared
    // Simulator and unsupported hardware land here. This is the ONLY honest place to fail — do not
    // fall back to a software key: an unattestable device must not silently become attestable.
    guard service.isSupported else {
      reject("ATTESTATION_UNSUPPORTED", "App Attest is not supported on this device", nil)
      return
    }

    service.generateKey { keyId, error in
      if let error = error {
        reject("APPATTEST_GENERATE_KEY_FAILED", error.localizedDescription, error)
        return
      }
      guard let keyId = keyId else {
        reject("APPATTEST_GENERATE_KEY_FAILED", "generateKey returned no keyId", nil)
        return
      }
      do {
        UserDefaults.standard.set(keyId, forKey: Self.appAttestKeyIdDefaultsKey)

        // Recover from a destroyed vote key instead of handing it back forever. Only a POSITIVE
        // invalidation signal deletes; `.indeterminate` keeps the existing key, because wrongly
        // deleting a live one destroys the voter's device identity.
        var existing = self.loadKey(tag: Self.voteKeyTag)
        var reprovisioned = false
        var probeDetail = "no-existing-key"
        if existing != nil {
          let probe = self.probeKeyLiveness(tag: Self.voteKeyTag)
          probeDetail = probe.detail
          if probe.liveness == .invalidated {
            self.deleteKey(tag: Self.voteKeyTag)
            existing = nil
            reprovisioned = true
          }
        }
        let voteKey = try existing
          ?? self.createSecureEnclaveKey(tag: Self.voteKeyTag, requireBiometry: true)
        guard let pub = SecKeyCopyPublicKey(voteKey) else {
          reject("KEY_ERROR", "could not derive the vote key's public key", nil); return
        }
        resolve([
          "publicKeyCompressedHex": try self.compressedHex(from: pub),
          "appAttestKeyId": keyId,
          "keyAlias": keyAlias,
          // TRUE means K_vote CHANGED: any challenge already issued against the previous key is
          // void, and an existing Association no longer describes this device.
          "reprovisioned": reprovisioned,
          // The raw probe verdict, carried so a failure can be diagnosed from captured output
          // rather than re-derived from a guess about what the Enclave returns.
          "voteKeyProbe": probeDetail
        ])
      } catch {
        reject("KEY_ERROR", error.localizedDescription, error)
      }
    }
  }

  // MARK: - (2) produceAttestation

  /// Answers an issued challenge. Implements ATTESTATION-CONTRACT-IOS.md §2 and §3.
  ///
  /// - `boundDigest` — the base64url `Digest(nonce, deviceKey)` STRING (§1).
  /// - `assertionDigest` — the base64url `ASSERTION_DIGEST` STRING (§3.1), i.e.
  ///   `digestFields(['votetorrent/ios-assertion/v1', BOUND_DIGEST, voteKeyCompressedHex])`.
  ///
  /// **Both are computed in JS and passed down finished.** This method must NEVER construct either
  /// value natively. `digestFields`' encoding is length-prefixed and type-tagged, and re-deriving it
  /// in a second language is exactly the "independent reimplementation" SIGN-05 forbids — the
  /// earlier draft of this file built the assertion clientData as `boundDigest + "|" + voteKeyHex`,
  /// a non-injective concatenation the contract explicitly rejects.
  ///
  /// Both are hashed the SAME way to reach a `clientDataHash`: `SHA256(UTF-8 bytes of the string)`.
  /// One rule covers both, so there is one place to get it wrong instead of two. This is a THIRD
  /// encoding of BOUND_DIGEST alongside Android's two (spike 080 P5).
  ///
  /// **Caller obligation (§3.4):** the returned `publicKeyCompressedHex` MUST be compared against
  /// the vote key the caller used to build `assertionDigest`. This method reads whatever key is
  /// currently under the vote alias; if it ever differs from the one JS hashed, the assertion binds
  /// the wrong key and the authority's `verifyCrossSign` rejects with "K_vote is not bound to this
  /// attestation" — a legible failure, but one the caller should catch first.
  ///
  /// **`attestKey` may be called only ONCE per App Attest key.** Unlike Android's
  /// delete-and-regenerate, a re-attestation needs a NEW `generateKey`. This yields the same
  /// key-non-reuse property D-13 was rewritten around, for free.
  ///
  /// Proof of possession of K_vote (§4) is a SEPARATE `signWithDeviceKey` call made by JS after
  /// this one — it is not produced here, because it requires the biometric prompt this method's
  /// App Attest path does not use.
  @objc(produceAttestation:boundDigest:assertionDigest:enableDeviceCheck:resolver:rejecter:)
  func produceAttestation(_ keyAlias: String,
                          boundDigest: String,
                          assertionDigest: String,
                          enableDeviceCheck: Bool,
                          resolver resolve: @escaping RCTPromiseResolveBlock,
                          rejecter reject: @escaping RCTPromiseRejectBlock) {
    let service = DCAppAttestService.shared
    guard service.isSupported else {
      reject("ATTESTATION_UNSUPPORTED", "App Attest is not supported on this device", nil); return
    }
    guard let keyId = UserDefaults.standard.string(forKey: Self.appAttestKeyIdDefaultsKey) else {
      reject("NO_KEY_PROVISIONED", "provisionDeviceKey has not run", nil); return
    }
    guard let voteKey = self.loadKey(tag: Self.voteKeyTag), let votePub = SecKeyCopyPublicKey(voteKey) else {
      reject("NO_KEY_PROVISIONED", "no vote key present", nil); return
    }

    let clientDataHash = Data(SHA256.hash(data: Data(boundDigest.utf8)))

    service.attestKey(keyId, clientDataHash: clientDataHash) { attestation, error in
      if let error = error {
        reject("APPATTEST_ATTEST_FAILED", error.localizedDescription, error); return
      }
      guard let attestation = attestation else {
        reject("APPATTEST_ATTEST_FAILED", "attestKey returned no attestation object", nil); return
      }
      do {
        // THE CROSS-SIGN (§3). The assertion is what lets the attested app vouch for K_vote.
        // `assertionDigest` arrives finished from JS — hashed here exactly as `boundDigest` was.
        let voteKeyHex = try self.compressedHex(from: votePub)
        let assertionClientDataHash = Data(SHA256.hash(data: Data(assertionDigest.utf8)))
        service.generateAssertion(keyId, clientDataHash: assertionClientDataHash) { assertion, assertError in
          if let assertError = assertError {
            reject("APPATTEST_ASSERT_FAILED", assertError.localizedDescription, assertError); return
          }
          // An empty assertion would silently produce an unbindable ceremony — fail loudly instead.
          guard let assertion = assertion else {
            reject("APPATTEST_ASSERT_FAILED", "generateAssertion returned no assertion", nil); return
          }
          resolve([
            "attestationObjectBase64": attestation.base64EncodedString(),
            "assertionBase64": assertion.base64EncodedString(),
            "appAttestKeyId": keyId,
            // §3.4: the caller MUST check this equals the vote key it hashed into assertionDigest.
            "publicKeyCompressedHex": voteKeyHex,
            "attestationTimeMillis": Int(Date().timeIntervalSince1970 * 1000),
            // D-12 analogue: the DeviceCheck leg is independently gated, exactly as
            // `enablePlayIntegrity` gates Play Integrity on Android. Unused under bar A (spike 082).
            "deviceCheckToken": ""
          ])
        }
      } catch {
        reject("KEY_ERROR", error.localizedDescription, error)
      }
    }
  }

  // MARK: - (3) signWithDeviceKey

  /// Biometric-gated P-256 signature over `digestBase64`.
  /// `digestBase64` is PLAIN base64 of the RAW digest bytes — never base64url, never UTF-8-of-a-
  /// string. Identical contract to Android's `signWithDeviceKey`.
  @objc(signWithDeviceKey:digestBase64:promptTitle:promptSubtitle:promptNegativeButton:resolver:rejecter:)
  func signWithDeviceKey(_ keyAlias: String,
                         digestBase64: String,
                         promptTitle: String,
                         promptSubtitle: String,
                         promptNegativeButton: String,
                         resolver resolve: @escaping RCTPromiseResolveBlock,
                         rejecter reject: @escaping RCTPromiseRejectBlock) {
    signWith(tag: Self.voteKeyTag, digestBase64: digestBase64, reason: promptSubtitle,
             resolve: resolve, reject: reject)
  }

  // MARK: - (4)(5) recovery key

  @objc(provisionRecoveryKey:resolver:rejecter:)
  func provisionRecoveryKey(_ keyAlias: String,
                            resolver resolve: @escaping RCTPromiseResolveBlock,
                            rejecter reject: @escaping RCTPromiseRejectBlock) {
    let context = LAContext()
    var authError: NSError?
    // D-18 analogue: no passcode set at all means no recovery ceremony can EVER succeed. Detect it
    // before creating anything, and report it distinctly from a ceremony that was attempted.
    guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &authError) else {
      reject("NO_DEVICE_CREDENTIAL", "no device passcode is configured", authError); return
    }
    do {
      let key = try loadKey(tag: Self.recoveryKeyTag)
        ?? createSecureEnclaveKey(tag: Self.recoveryKeyTag, requireBiometry: false)
      guard let pub = SecKeyCopyPublicKey(key) else {
        reject("KEY_ERROR", "could not derive the recovery key's public key", nil); return
      }
      resolve(["publicKeyCompressedHex": try compressedHex(from: pub), "keyAlias": keyAlias])
    } catch {
      reject("KEY_ERROR", error.localizedDescription, error)
    }
  }

  @objc(signWithRecoveryKey:digestBase64:promptTitle:promptSubtitle:promptNegativeButton:resolver:rejecter:)
  func signWithRecoveryKey(_ keyAlias: String,
                           digestBase64: String,
                           promptTitle: String,
                           promptSubtitle: String,
                           promptNegativeButton: String,
                           resolver resolve: @escaping RCTPromiseResolveBlock,
                           rejecter reject: @escaping RCTPromiseRejectBlock) {
    signWith(tag: Self.recoveryKeyTag, digestBase64: digestBase64, reason: promptSubtitle,
             resolve: resolve, reject: reject)
  }

  // MARK: - shared signing path

  private func signWith(tag: String, digestBase64: String, reason: String,
                        resolve: @escaping RCTPromiseResolveBlock,
                        reject: @escaping RCTPromiseRejectBlock) {
    guard let digest = Data(base64Encoded: digestBase64), digest.count == 32 else {
      reject("INVALID_DIGEST_ENCODING",
             "digestBase64 must be plain base64 of 32 raw digest bytes", nil)
      return
    }
    guard let key = loadKey(tag: tag) else {
      reject("NO_KEY_PROVISIONED", "no key under \(tag)", nil); return
    }

    var error: Unmanaged<CFError>?
    // `.ecdsaSignatureDigestX962SHA256` signs an ALREADY-HASHED 32-byte digest — the `prehash: true`
    // half of the contract. Using the `...MessageX962...` variant would hash the digest a second
    // time and silently produce a signature over the wrong bytes.
    guard let sig = SecKeyCreateSignature(key, .ecdsaSignatureDigestX962SHA256,
                                          digest as CFData, &error) as Data? else {
      let err = error!.takeRetainedValue() as Error as NSError
      // LAError.userCancel / .userFallback / .biometryLockout map onto the Android code table.
      // DOMAIN FIRST — these code spaces OVERLAP, measured 2026-08-25 (spike 085 leg 7):
      //
      //     LAError.userFallback            = -3   (com.apple.LocalAuthentication)
      //     key invalidated by re-enrolment = -3   (CryptoTokenKit)
      //
      // Matching on the raw code alone reports an INVALIDATED KEY as CANCELED — a permanent,
      // recoverable-by-re-provisioning condition disguised as "the user tapped cancel", so the app
      // would retry forever instead of re-provisioning. An earlier revision of this fix had exactly
      // that bug: it checked CryptoTokenKit only in `default`, which `-3` never reached because the
      // CANCELED case matched first. Do not collapse this back into a single switch on `err.code`.
      let code: String
      if err.domain == "CryptoTokenKit" {
        // -3 is the observed invalidation code. Other CryptoTokenKit failures are token-level
        // faults with no better mapping than the generic bucket.
        code = err.code == -3 ? "KEY_INVALIDATED_REASSOCIATE" : "BIOMETRIC_ERROR"
      } else {
      switch err.code {
      case Int(errSecUserCanceled), LAError.userCancel.rawValue, LAError.systemCancel.rawValue,
           LAError.appCancel.rawValue, LAError.userFallback.rawValue:
        // MEASURED: cancelling the prompt yields com.apple.LocalAuthentication code -2
        // (LAError.userCancel) — this mapping is correct.
        code = "CANCELED"
      case LAError.biometryNotEnrolled.rawValue: code = "NO_BIOMETRICS_ENROLLED"
      case LAError.biometryLockout.rawValue:     code = "LOCKOUT_PERMANENT"
      // A genuinely absent key. Distinct from invalidation (see above) but the same recovery
      // action, and it may be how other iOS versions surface invalidation.
      case Int(errSecItemNotFound):              code = "KEY_INVALIDATED_REASSOCIATE"
      default:                                   code = "BIOMETRIC_ERROR"
      }
      }
      reject(code, err.localizedDescription, err)
      return
    }
    do {
      resolve(["signatureHex": try derToCompactLowSHex(sig)])
    } catch {
      reject("KEY_ERROR", error.localizedDescription, error)
    }
  }
}
