package org.votetorrent.attestationnative

import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyInfo
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.KeyProperties
import android.security.keystore.StrongBoxUnavailableException
import android.util.Log
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.UiThreadUtil
import java.security.KeyStore
import java.security.ProviderException
import javax.crypto.AEADBadTagException
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.GCMParameterSpec

private const val ANDROID_KEYSTORE = "AndroidKeyStore"

/** D-42 generic wrap-key alias pattern — defence in depth beside the JS-side check
 * (`secret-wrap.ts`'s `WRAP_KEY_ALIAS_PATTERN`), so a generic alias can never reach (or collide
 * with) the existing EC signing aliases (`VOTETORRENT_DEVICE_KEY_V1`,
 * `VOTETORRENT_AUTHORITY_SIGNING_KEY_V1`, `VOTETORRENT_AUTHORITY_RECOVERY_KEY_V1`). */
private val WRAP_KEY_ALIAS_PATTERN = Regex("^VOTETORRENT_[A-Z0-9_]+_WRAP_KEY_V[0-9]+$")

/** D-07-style rung observability for the wrap-key StrongBox->TEE ladder, distinct from
 * [KeyAttestationHelper]'s `VtKeygenRung` tag (different keys, same reasoning). */
private const val TAG_WRAP_KEY_RUNG = "VtWrapKeyRung"

/** Typed exception mapping to the `INVALID_ARGUMENT` reject code (invalid alias). */
class InvalidWrapKeyAliasException(alias: String) : Exception("invalid wrap key alias: $alias")

/** Typed exception mapping to `WRAP_KEY_POLICY_MISMATCH` — an existing alias's stored
 * auth policy (or key type) does not match the caller's `requireAuth` request. Never silently
 * downgraded/upgraded (T-62-08-11). */
class WrapKeyPolicyMismatchException(message: String) : Exception(message)

/** Typed exception mapping to `NO_WRAP_KEY` — no key exists under the requested alias. */
class NoWrapKeyException(alias: String) : Exception("no wrap key under alias $alias")

/**
 * SecretWrapHelper — D-42 (Phase 62 plan 08): AndroidKeyStore AES-256-GCM get-or-create +
 * wrap/unwrap, with an optional BiometricPrompt/CryptoObject path when `requireAuth` is true.
 * Generic across every `VOTETORRENT_*_WRAP_KEY_V<n>` alias — this is NOT the P-256 signing-key
 * flow [KeyAttestationHelper] owns.
 *
 * **CRITICAL — never regenerate, never delete.** Unlike [KeyAttestationHelper.regenerateAttested]
 * (which deliberately deletes and regenerates its alias on every call — D-13 key non-reuse, the
 * right design for an attested SIGNING key), a wrap key protects the ONLY copy of a secret
 * (D-42/D-40's enrollment identity key is the first consumer). Deleting or regenerating it would
 * make every ciphertext wrapped under it permanently unreadable. This class contains no
 * `deleteEntry` call anywhere, and [getOrCreateKey] NEVER regenerates an alias that already
 * exists — it returns the existing key, or rejects `WRAP_KEY_POLICY_MISMATCH` if the existing
 * key's auth policy does not match the request.
 */
class SecretWrapHelper(private val reactContext: ReactApplicationContext) {

	private val keyStore: KeyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }

	/** Get-or-create the AES-256-GCM wrap key under [alias]. Serialized so a concurrent
	 * create/create race can never generate two keys under the same alias (T-62-08-03). */
	@Synchronized
	fun getOrCreateKey(alias: String, requireAuth: Boolean): Pair<SecretKey, String> {
		if (!WRAP_KEY_ALIAS_PATTERN.matches(alias)) {
			throw InvalidWrapKeyAliasException(alias)
		}

		if (keyStore.containsAlias(alias)) {
			val entry = keyStore.getEntry(alias, null)
			if (entry !is KeyStore.SecretKeyEntry) {
				throw WrapKeyPolicyMismatchException("alias $alias does not hold a SecretKeyEntry (wrong key type)")
			}
			val secretKey = entry.secretKey
			val keyInfo = SecretKeyFactory.getInstance(secretKey.algorithm, ANDROID_KEYSTORE)
				.getKeySpec(secretKey, KeyInfo::class.java) as KeyInfo
			if (keyInfo.isUserAuthenticationRequired != requireAuth) {
				// Never a silent downgrade/upgrade (T-62-08-11) — a policy mismatch on an
				// existing alias must be rejected, not reconciled.
				throw WrapKeyPolicyMismatchException(
					"alias $alias was created with requireAuth=${keyInfo.isUserAuthenticationRequired}, " +
						"but this call requested requireAuth=$requireAuth",
				)
			}
			return secretKey to resolveSecurityLevel(keyInfo)
		}

		return generateKey(alias, requireAuth)
	}

	private fun buildSpec(alias: String, requireAuth: Boolean, strongBox: Boolean): KeyGenParameterSpec {
		val builder = KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
			.setBlockModes(KeyProperties.BLOCK_MODE_GCM)
			.setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
			.setKeySize(256)
			.setRandomizedEncryptionRequired(true)
			// D-42/Pitfall 2: the identity alias passes requireAuth=false — protection here is
			// against EXTRACTION (a rooted device / backup / stolen RKStorage file), not against
			// use by whoever already holds the unlocked device. NEVER
			// setUserAuthenticationValidityDurationSeconds — an auth-per-use-or-never contract
			// only, matching D-10's reasoning for the P-256 signing keys.
			.setUserAuthenticationRequired(requireAuth)
		if (requireAuth) {
			// Only the auth-required branch (e.g. 62-26's keyholder-share alias) sets these —
			// the D-42 identity alias (requireAuth=false) never does.
			builder.setInvalidatedByBiometricEnrollment(true)
			if (Build.VERSION.SDK_INT >= 30) {
				builder.setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG) // 0 = per-use
			}
		}
		if (strongBox) {
			builder.setIsStrongBoxBacked(true)
		}
		return builder.build()
	}

	/** StrongBox->TEE rung ladder (D-07 class), no debug software-stub rung — a keygen failure on
	 * either rung is WRAP_FAILED. */
	private fun generateKey(alias: String, requireAuth: Boolean): Pair<SecretKey, String> {
		try {
			val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
			generator.init(buildSpec(alias, requireAuth, strongBox = true))
			val key = generator.generateKey()
			Log.i(TAG_WRAP_KEY_RUNG, "StrongBox rung selected for alias=$alias")
			return key to "strongbox"
		} catch (e: StrongBoxUnavailableException) {
			Log.i(TAG_WRAP_KEY_RUNG, "StrongBox unavailable for alias=$alias — stepping down to TEE")
		} catch (e: ProviderException) {
			// Mirrors KeyAttestationHelper.generateKey's identical reasoning: a StrongBox chip IS
			// present but rejected this request — step down to TEE rather than fail outright.
			// This is a rung DOWNGRADE, not an absent chip.
			Log.w(TAG_WRAP_KEY_RUNG, "StrongBox present but REJECTED alias=$alias — stepping down to TEE (downgrade, not absent chip)", e)
		}

		val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
		generator.init(buildSpec(alias, requireAuth, strongBox = false))
		val key = generator.generateKey()
		return key to "tee"
	}

	private fun resolveSecurityLevel(keyInfo: KeyInfo): String {
		if (Build.VERSION.SDK_INT >= 31) {
			return when (keyInfo.securityLevel) {
				KeyProperties.SECURITY_LEVEL_STRONGBOX -> "strongbox"
				KeyProperties.SECURITY_LEVEL_TRUSTED_ENVIRONMENT -> "tee"
				KeyProperties.SECURITY_LEVEL_SOFTWARE -> "software"
				else -> "unknown"
			}
		}
		return if (keyInfo.isInsideSecureHardware) "tee" else "software"
	}

	/** Wrap [plaintext] under [alias]'s key. Native generates a fresh 12-byte IV (no caller IV). */
	fun wrap(
		alias: String,
		plaintext: ByteArray,
		aad: ByteArray,
		requireAuth: Boolean,
		activity: FragmentActivity?,
		promptTitle: String,
		promptSubtitle: String,
		promptNegativeButton: String,
		onResult: (ciphertext: ByteArray, iv: ByteArray, securityLevel: String) -> Unit,
		onError: (code: String, throwable: Throwable?) -> Unit,
	) {
		val (key, securityLevel) = try {
			getOrCreateKey(alias, requireAuth)
		} catch (e: InvalidWrapKeyAliasException) {
			onError("INVALID_ARGUMENT", e); return
		} catch (e: WrapKeyPolicyMismatchException) {
			onError("WRAP_KEY_POLICY_MISMATCH", e); return
		} catch (e: Exception) {
			onError("WRAP_FAILED", e); return
		}

		val cipher: Cipher
		try {
			cipher = Cipher.getInstance("AES/GCM/NoPadding")
			cipher.init(Cipher.ENCRYPT_MODE, key)
		} catch (e: Exception) {
			onError("WRAP_FAILED", e); return
		}

		fun doWrap(c: Cipher) {
			try {
				c.updateAAD(aad)
				val ciphertext = c.doFinal(plaintext)
				val iv = c.iv
				if (iv.size != 12) {
					onError("WRAP_FAILED", IllegalStateException("unexpected IV length ${iv.size}")); return
				}
				onResult(ciphertext, iv, securityLevel)
			} catch (e: Exception) {
				onError("WRAP_FAILED", e)
			}
		}

		if (!requireAuth) {
			doWrap(cipher)
			return
		}

		if (activity == null) {
			onError("NO_ACTIVITY", IllegalStateException("no current FragmentActivity available to host the BiometricPrompt"))
			return
		}

		val cryptoObject = BiometricPrompt.CryptoObject(cipher)
		val promptInfo = BiometricPrompt.PromptInfo.Builder()
			.setTitle(promptTitle)
			.setSubtitle(promptSubtitle)
			.setNegativeButtonText(promptNegativeButton)
			.build()

		UiThreadUtil.runOnUiThread {
			val biometricPrompt = BiometricPrompt(
				activity,
				ContextCompat.getMainExecutor(reactContext),
				object : BiometricPrompt.AuthenticationCallback() {
					override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
						doWrap(result.cryptoObject!!.cipher!!)
					}

					override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
						onError(mapBiometricErrorCode(errorCode), RuntimeException(errString.toString()))
					}

					override fun onAuthenticationFailed() {
						// Biometric mismatch — a retry, not an error (BiometricPrompt re-prompts itself).
					}
				},
			)
			biometricPrompt.authenticate(promptInfo, cryptoObject)
		}
	}

	/** Unwrap a previously-wrapped secret under [alias]. */
	fun unwrap(
		alias: String,
		ciphertext: ByteArray,
		iv: ByteArray,
		aad: ByteArray,
		requireAuth: Boolean,
		activity: FragmentActivity?,
		promptTitle: String,
		promptSubtitle: String,
		promptNegativeButton: String,
		onResult: (plaintext: ByteArray) -> Unit,
		onError: (code: String, throwable: Throwable?) -> Unit,
	) {
		if (!WRAP_KEY_ALIAS_PATTERN.matches(alias)) {
			onError("INVALID_ARGUMENT", InvalidWrapKeyAliasException(alias)); return
		}
		if (!keyStore.containsAlias(alias)) {
			// Decided BEFORE any prompt — a backup-restored device with ciphertext but no key
			// fails closed here (T-62-08-10), never regenerating or overwriting anything.
			onError("NO_WRAP_KEY", NoWrapKeyException(alias)); return
		}
		if (iv.size != 12) {
			onError("INVALID_ENCODING", IllegalArgumentException("iv must be 12 bytes, got ${iv.size}")); return
		}

		val (key, _) = try {
			getOrCreateKey(alias, requireAuth)
		} catch (e: WrapKeyPolicyMismatchException) {
			onError("WRAP_KEY_POLICY_MISMATCH", e); return
		} catch (e: Exception) {
			onError("UNWRAP_FAILED", e); return
		}

		val cipher: Cipher
		try {
			cipher = Cipher.getInstance("AES/GCM/NoPadding")
			cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, iv))
		} catch (e: KeyPermanentlyInvalidatedException) {
			onError("KEY_INVALIDATED", e); return
		} catch (e: Exception) {
			onError("UNWRAP_FAILED", e); return
		}

		fun doUnwrap(c: Cipher) {
			try {
				c.updateAAD(aad)
				val plaintext = c.doFinal(ciphertext)
				onResult(plaintext)
			} catch (e: KeyPermanentlyInvalidatedException) {
				onError("KEY_INVALIDATED", e)
			} catch (e: AEADBadTagException) {
				onError("UNWRAP_TAG_MISMATCH", e)
			} catch (e: Exception) {
				onError("UNWRAP_FAILED", e)
			}
		}

		if (!requireAuth) {
			doUnwrap(cipher)
			return
		}

		if (activity == null) {
			onError("NO_ACTIVITY", IllegalStateException("no current FragmentActivity available to host the BiometricPrompt"))
			return
		}

		val cryptoObject = BiometricPrompt.CryptoObject(cipher)
		val promptInfo = BiometricPrompt.PromptInfo.Builder()
			.setTitle(promptTitle)
			.setSubtitle(promptSubtitle)
			.setNegativeButtonText(promptNegativeButton)
			.build()

		UiThreadUtil.runOnUiThread {
			val biometricPrompt = BiometricPrompt(
				activity,
				ContextCompat.getMainExecutor(reactContext),
				object : BiometricPrompt.AuthenticationCallback() {
					override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
						doUnwrap(result.cryptoObject!!.cipher!!)
					}

					override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
						onError(mapBiometricErrorCode(errorCode), RuntimeException(errString.toString()))
					}

					override fun onAuthenticationFailed() {
						// Biometric mismatch — a retry, not an error.
					}
				},
			)
			biometricPrompt.authenticate(promptInfo, cryptoObject)
		}
	}

	/** Reuses [KeyAttestationHelper.signWithDeviceKey]'s errorCode -> code mapping verbatim
	 * (CANCELED/NO_BIOMETRICS_ENROLLED/LOCKOUT/LOCKOUT_PERMANENT/BIOMETRIC_ERROR). */
	private fun mapBiometricErrorCode(errorCode: Int): String = when (errorCode) {
		BiometricPrompt.ERROR_CANCELED,
		BiometricPrompt.ERROR_USER_CANCELED,
		BiometricPrompt.ERROR_NEGATIVE_BUTTON -> "CANCELED"
		BiometricPrompt.ERROR_NO_BIOMETRICS -> "NO_BIOMETRICS_ENROLLED"
		BiometricPrompt.ERROR_LOCKOUT -> "LOCKOUT"
		BiometricPrompt.ERROR_LOCKOUT_PERMANENT -> "LOCKOUT_PERMANENT"
		else -> "BIOMETRIC_ERROR"
	}
}
