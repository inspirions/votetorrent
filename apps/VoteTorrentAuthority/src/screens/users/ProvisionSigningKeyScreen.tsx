import React, { useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { ExtendedTheme, useNavigation, useRoute, useTheme } from "@react-navigation/native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTranslation } from "react-i18next";
import FontAwesome6 from "react-native-vector-icons/FontAwesome6";
import type { INetworkEngine, IUserEngine, Signature } from "@votetorrent/vote-core";
import { UserKeyType } from "@votetorrent/vote-core";
import type { Spec as NativeAttestationSpec } from "@votetorrent/attestation-native/src/specs/NativeAttestation";
import { ThemedText } from "../../components/ThemedText";
import { CustomButton } from "../../components/CustomButton";
import { InlineError } from "../../components/InlineError";
import { globalStyles } from "../../theme/styles";
import { useApp } from "../../providers/AppProvider";
import { persistProvisionedDeviceUser } from "../../engines/device-user";
import { SIGNING_KEY_ALIAS, RECOVERY_KEY_ALIAS } from "../../engines/device-signer";
import { mapDeviceSigningError, DEVICE_SIGNING_ERROR_COPY_KEY } from "../../utils/deviceSigningError";
import type { DeviceSigningErrorClass } from "../../utils/deviceSigningError";

/**
 * ProvisionSigningKeyScreen — D-14's dedicated first-run and recovery signing-key surface.
 *
 * signingKeyProvisioning — this file's own D-14/D-16/D-18 marker (see 49-UI-SPEC.md's
 * "Screen Composition Reference" and "ProvisionSigningKeyScreen" contract, exact).
 *
 * D-14 boot invariant (explicit, load-bearing): this screen is reached ONLY by an explicit
 * Settings press (`reason: 'first-run'`) or an explicit catch-and-navigate from one of the 22
 * `createDeviceSigner` call sites (`reason: 'invalidated'`, 49-11/49-12). It is NEVER
 * auto-navigated-to during provider construction or cold start, and no signer is ever resolved
 * here as a side effect of merely rendering. `AppProvider.tsx`'s lazy factory (its own
 * comment block, ~line 199) is the reason: resolving a signer — or, by the same logic,
 * redirecting to a signer-setup screen — during boot can turn a successful re-attach into a
 * spurious "Failed to load network". This file must never be imported by `AppProvider.tsx`.
 *
 * D-15 clean cut: the first UserKey is registered through the schema's first-key bootstrap
 * branch (`count(*) = 1 and context.UserKey is null`, `packages/vote-core/schema/votetorrent.qsql`
 * `UserKey.InsertValid`) — no signature required. Nothing has shipped; the only identities are
 * dev-team testers who clear app data. There is no legacy rotation ceremony and no migration path
 * here, deliberately.
 *
 * D-08: the provision-time attestation cert chain is captured (via `produceAttestation`) even
 * though nothing in this phase consumes it — it is the only mechanism that ever makes user
 * presence verifiable in-schema, and capturing it now avoids re-provisioning keys later. The
 * X.509 chain proves hardware and key continuity, never user identity; same-user continuity
 * across provisioning events is the deferred master-password item, not this screen's job. Unlike
 * the Voter app's device-association flow (45-05), there is no server-issued challenge nonce in
 * this ceremony, so the bound digest is self-issued over a locally generated nonce plus the new
 * key's own public value.
 *
 * DEVICE-PROOF HONESTY: jest cannot exercise the real Android Keystore, `BiometricPrompt`, or
 * `KeyguardManager`. This screen's own test suite proves the JS-side wiring and rendering against
 * a faked native module ONLY — not that provisioning works on real hardware. That proof is D-24
 * leg 1 (49-13) and leg 3 (49-14).
 */

type ProvisionReason = "first-run" | "invalidated";

/** Ten years in milliseconds — expiration epoch for every key this screen registers. */
const TEN_YEARS_MS = 10 * 365 * 24 * 60 * 60 * 1000;

/**
 * Plain base64 (`Base64.NO_WRAP` equivalent) of RAW digest bytes — never base64url. Mirrors
 * `device-signer.ts`'s identical `signWithDeviceKey`/`signWithRecoveryKey` `digestBase64`
 * contract. Duplicated locally (not imported) because that file's own helper is private, and
 * widening its exported surface for one shared 6-line helper is not worth the coupling.
 */
function base64FromDigestBytes(digest: Uint8Array): string {
	let binary = "";
	for (let i = 0; i < digest.length; i++) binary += String.fromCharCode(digest[i]!);
	const { btoa: btoaFn } = globalThis as unknown as { btoa: (data: string) => string };
	return btoaFn(binary);
}

/**
 * Base64 of the UTF-8 bytes of a string — mirrors `real-attestation-producer.ts`'s identical
 * `base64FromUtf8` contract. Used ONLY for `produceAttestation`'s `boundDigestUtf8Base64`
 * argument (the Keystore `setAttestationChallenge` payload) — never for `digestBase64` above,
 * which is a deliberately different encoding of a deliberately different input (D-08's own
 * asymmetry, documented in `ATTESTATION-CONTRACT.md` §3).
 */
function base64FromUtf8(value: string): string {
	const { TextEncoder: TextEncoderCtor, btoa: btoaFn } = globalThis as unknown as {
		TextEncoder: new () => { encode(input: string): Uint8Array };
		btoa: (data: string) => string;
	};
	const bytes = new TextEncoderCtor().encode(value);
	let binary = "";
	for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
	return btoaFn(binary);
}

/**
 * Lazily resolve the native TurboModule via a plain CommonJS `require()` — never a top-level
 * import. `TurboModuleRegistry.getEnforcing(...)` throws under Node/jest whenever the native
 * module isn't registered (documented in `device-signer.ts` and `real-attestation-producer.ts`);
 * this screen, like those files, is reachable from real jest suites without a native-bridge mock,
 * so an eager top-level touch here would break them.
 */
function getNative(): NativeAttestationSpec {
	// eslint-disable-next-line @typescript-eslint/no-var-requires -- deliberate lazy require, see comment above.
	return require("@votetorrent/attestation-native/src/specs/NativeAttestation").default as NativeAttestationSpec;
}

type ScreenPhase = "idle" | "pending" | "success" | "no-recovery";

export default function ProvisionSigningKeyScreen() {
	const insets = useSafeAreaInsets();
	const { colors } = useTheme() as ExtendedTheme;
	const { t } = useTranslation();
	const navigation = useNavigation();
	const { getEngine } = useApp();
	const { reason } = useRoute().params as { reason: ProvisionReason };

	const [phase, setPhase] = useState<ScreenPhase>("idle");
	const [errorClass, setErrorClass] = useState<DeviceSigningErrorClass | undefined>(undefined);
	const pending = phase === "pending";
	const isFirstRun = reason === "first-run";

	/**
	 * `EngineFactory.getEngine("user")` is cache-keyed by name alone and returns the SAME
	 * `UserEngine` instance (and therefore the SAME stale `activeKeys` snapshot) on every call.
	 * `addKey`'s signed subsequent-key path binds `context.UserKey` from that snapshot (its own
	 * doc comment, `user-engine.ts`), never from the `Signature` object passed in — so a second
	 * write against a cached engine would bind against the PRE-write key set, not the one just
	 * inserted. Going through the (also cached, but read-fresh-on-call) network engine's
	 * `getCurrentUser()` directly, instead of the app-wide `getEngine("user")` cache entry, gives
	 * a real DB read every time this is called.
	 */
	async function resolveFreshUserEngine(): Promise<IUserEngine> {
		const networkEngine = await getEngine<INetworkEngine>("network");
		const userEngine = await networkEngine.getCurrentUser();
		if (!userEngine) {
			throw new Error(
				"ProvisionSigningKeyScreen: no current user resolved for this network — cannot register a signing key.",
			);
		}
		return userEngine;
	}

	async function handleFirstRun(): Promise<void> {
		setErrorClass(undefined);
		setPhase("pending");
		try {
			const native = getNative();

			// Step 1 — the biometric-gated primary signing key.
			const deviceKey = (await native.provisionDeviceKey(SIGNING_KEY_ALIAS)) as {
				publicKeyCompressedHex: string;
			};
			// Step 2 (D-16) — the device-credential recovery key.
			const recoveryKey = (await native.provisionRecoveryKey(RECOVERY_KEY_ALIAS)) as {
				publicKeyCompressedHex: string;
			};

			// Step 3 (D-08) — capture the provision-time attestation cert chain. See this file's
			// header comment: nothing consumes it this phase, and the chain proves hardware/key
			// continuity, never user identity. There is no server-issued challenge nonce to bind
			// against in this ceremony (unlike the Voter app's device-association flow, which uses
			// `computeBoundDigest(nonce, deviceKey)` against an authority-issued nonce — 45-05); a
			// self-issued, locally generated string stands in as `boundDigest` since nothing
			// verifies this binding this phase (T-49-PLAIN: only the public cert chain itself is
			// persisted, never key material).
			const boundDigest = `signing-key-provisioning-${Date.now()}-${deviceKey.publicKeyCompressedHex}`;
			const attestation = await native.produceAttestation(
				SIGNING_KEY_ALIAS,
				boundDigest,
				base64FromUtf8(boundDigest),
				false,
			);
			// Persisted nowhere yet in this phase — see the header comment on why capturing it
			// now, unconsumed, is still correct. Referenced so it is not an unused local.
			void attestation;

			const expiration = Date.now() + TEN_YEARS_MS;

			// Step 4 (D-15) — the first-key bootstrap branch: no signature required, ONLY legal
			// when this is genuinely the user's first key.
			const userEngine = await resolveFreshUserEngine();
			await userEngine.addKey({ key: deviceKey.publicKeyCompressedHex, type: UserKeyType.p256, expiration });

			// Step 5 — the recovery key as a SECOND UserKey, via the signed subsequent-key path,
			// authorized by the signing key just registered above (one biometric prompt). A fresh
			// engine is resolved so context.UserKey binds to the key inserted in step 4, not the
			// pre-provisioning empty snapshot (see resolveFreshUserEngine's doc comment).
			const userEngineAfterFirstKey = await resolveFreshUserEngine();
			await userEngineAfterFirstKey.addKey(
				{ key: recoveryKey.publicKeyCompressedHex, type: UserKeyType.p256, expiration },
				async (digest: Uint8Array): Promise<Signature> => {
					const result = (await native.signWithDeviceKey(
						SIGNING_KEY_ALIAS,
						base64FromDigestBytes(digest),
						t("deviceSigningPromptTitle"),
						t("signingKeyProvisioningPromptSubtitle"),
						t("deviceSigningPromptNegativeButton"),
					)) as { signatureHex: string };
					return {
						signerUserId: (await userEngine.getSummary())?.id ?? "",
						signerKey: deviceKey.publicKeyCompressedHex,
						signature: result.signatureHex,
					};
				},
			);

			// Step 6 (D-14) — persist the local device identity LAST, only once both UserKey rows
			// are real: never leave a "provisioned" local record pointing at an unregistered key.
			const displayName = (await userEngine.getSummary())?.name ?? "Device User";
			await persistProvisionedDeviceUser(displayName, deviceKey.publicKeyCompressedHex);

			setPhase("success");
		} catch (err) {
			handleCeremonyError(err);
		}
	}

	async function handleRecovery(): Promise<void> {
		setErrorClass(undefined);
		setPhase("pending");
		try {
			const native = getNative();

			// Step 1 — a fresh signing key under the SAME alias (the old one is permanently
			// invalidated; the native side regenerates under this alias, `KeyAttestationHelper.kt`).
			const deviceKey = (await native.provisionDeviceKey(SIGNING_KEY_ALIAS)) as {
				publicKeyCompressedHex: string;
			};
			// Re-resolve the recovery key's current public value (idempotent — the same alias
			// already provisioned during first-run) so the old, invalidated key can be identified
			// and the replacement's signature can be attributed to the correct signer.
			const recoveryKey = (await native.provisionRecoveryKey(RECOVERY_KEY_ALIAS)) as {
				publicKeyCompressedHex: string;
			};

			const before = await resolveFreshUserEngine();
			const beforeSummary = await before.getSummary();
			const oldKey = beforeSummary?.activeKeys.find((k) => k.key !== recoveryKey.publicKeyCompressedHex)?.key;

			// Revoke the invalidated key FIRST, authorized by the recovery key's own signature
			// (revokeKey binds context.UserKey from `signature.signerKey` directly — unlike
			// addKey, it does not depend on array order). This collapses the user down to exactly
			// one active key (the recovery key) BEFORE the signed add below, so that add's
			// context.UserKey — bound from the engine snapshot's activeKeys[0] — is unambiguously
			// the recovery key, regardless of how UserKey rows happen to sort when read back.
			// Legal per UserKey.DeleteValid: this is never the user's LAST key while the recovery
			// key remains registered.
			if (oldKey !== undefined) {
				const revokeDigest = await before.getRevokeKeyDigest(oldKey);
				const revokeResult = (await native.signWithRecoveryKey(
					RECOVERY_KEY_ALIAS,
					base64FromDigestBytes(revokeDigest),
					t("deviceSigningPromptTitle"),
					t("signingKeyRecoveryPromptSubtitle"),
					t("deviceSigningPromptNegativeButton"),
				)) as { signatureHex: string };
				await before.revokeKey(oldKey, {
					signerUserId: beforeSummary?.id ?? "",
					signerKey: recoveryKey.publicKeyCompressedHex,
					signature: revokeResult.signatureHex,
				});
			}

			const expiration = Date.now() + TEN_YEARS_MS;

			// Register the replacement key via the signed subsequent-key path, authorized by the
			// SAME recovery key (D-16/D-26): BiometricPrompt's DEVICE_CREDENTIAL authenticator on
			// API 30+, KeyguardManager below it — entirely a native branch, same four JS strings
			// either way.
			const userEngineAfterRevoke = await resolveFreshUserEngine();
			await userEngineAfterRevoke.addKey(
				{ key: deviceKey.publicKeyCompressedHex, type: UserKeyType.p256, expiration },
				async (digest: Uint8Array): Promise<Signature> => {
					const result = (await native.signWithRecoveryKey(
						RECOVERY_KEY_ALIAS,
						base64FromDigestBytes(digest),
						t("deviceSigningPromptTitle"),
						t("signingKeyRecoveryPromptSubtitle"),
						t("deviceSigningPromptNegativeButton"),
					)) as { signatureHex: string };
					return {
						signerUserId: beforeSummary?.id ?? "",
						signerKey: recoveryKey.publicKeyCompressedHex,
						signature: result.signatureHex,
					};
				},
			);

			// Update the persisted local device identity so activeKeys[0] is the replacement key.
			const displayName = beforeSummary?.name ?? "Device User";
			await persistProvisionedDeviceUser(displayName, deviceKey.publicKeyCompressedHex);

			setPhase("success");
		} catch (err) {
			handleCeremonyError(err);
		}
	}

	/**
	 * Shared catch-path classification (D-13). `cancellation` silently restores the pre-press
	 * state — no `InlineError`, no logged fault. D-18's terminal `no-device-credential` class
	 * replaces the ENTIRE recovery body with the no-recovery message and renders no button at
	 * all — see the render branch below. Every other class renders inline and re-enables the
	 * button.
	 */
	function handleCeremonyError(err: unknown): void {
		const cls = mapDeviceSigningError(err);
		if (cls === "cancellation") {
			setPhase("idle");
			return;
		}
		if (cls === "no-device-credential") {
			setPhase("no-recovery");
			return;
		}
		setErrorClass(cls);
		setPhase("idle");
	}

	if (phase === "success") {
		return (
			<ScrollView
				testID="signing-key-provisioning-screen"
				style={styles.container}
				contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
			>
				<View style={localStyles.iconRow}>
					<FontAwesome6 name="circle-check" size={32} color={colors.success} />
				</View>
				<ThemedText type="default" style={{ color: colors.text }}>
					{t("signingKeyProvisioningSuccessHeading")}
				</ThemedText>
				<ThemedText type="small" style={[localStyles.body, { color: colors.textSecondary }]}>
					{t("signingKeyProvisioningSuccessBody")}
				</ThemedText>
				<View testID="signing-key-provisioning-continue-button">
					<CustomButton
						title={t("signingKeyProvisioningContinueButton")}
						backgroundColor={colors.accent}
						onPress={() => navigation.goBack()}
					/>
				</View>
			</ScrollView>
		);
	}

	// D-18 terminal state: both keys are unrecoverable on this device. No icon, no button — see
	// this file's header comment and 49-UI-SPEC.md's "No-recovery terminal state" for why an
	// accent-colored dead-end button would be a lie here.
	if (phase === "no-recovery") {
		return (
			<ScrollView
				testID="signing-key-provisioning-screen"
				style={styles.container}
				contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
			>
				<ThemedText type="default" style={{ color: colors.error }}>
					{t("signingKeyProvisioningNoRecoveryHeading")}
				</ThemedText>
				<ThemedText type="small" style={[localStyles.body, { color: colors.text }]}>
					{t("signingKeyProvisioningNoRecoveryBody")}
				</ThemedText>
			</ScrollView>
		);
	}

	// The one place this screen reads the "needs attention" token, reserved exclusively for the
	// recovery variant's icon — distinct from InlineError's fixed "already failed" token.
	const recoveryIconColor = colors.warning;
	const icon = isFirstRun ? "fingerprint" : "key";
	const iconColor = isFirstRun ? colors.text : recoveryIconColor;
	const headingKey = isFirstRun ? "signingKeyProvisioningFirstRunHeading" : "signingKeyProvisioningRecoveryHeading";
	const bodyKey = isFirstRun ? "signingKeyProvisioningFirstRunBody" : "signingKeyProvisioningRecoveryBody";
	const buttonTitleKey = isFirstRun ? "signingKeyProvisioningSetupButton" : "signingKeyProvisioningRecoveryButton";
	const buttonTitle = t(buttonTitleKey) + (pending ? "…" : "");
	const errorMessage =
		errorClass !== undefined
			? t(DEVICE_SIGNING_ERROR_COPY_KEY[errorClass] ?? DEVICE_SIGNING_ERROR_COPY_KEY["biometric-error"]!)
			: undefined;

	return (
		<ScrollView
			testID="signing-key-provisioning-screen"
			style={styles.container}
			contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
		>
			<View style={localStyles.iconRow}>
				<FontAwesome6 name={icon} size={32} color={iconColor} />
			</View>
			<ThemedText type="default" style={{ color: colors.text }}>
				{t(headingKey)}
			</ThemedText>
			<ThemedText type="small" style={[localStyles.body, { color: colors.textSecondary }]}>
				{t(bodyKey)}
			</ThemedText>
			<InlineError message={errorMessage} />
			<View testID="signing-key-provisioning-primary-button">
				<CustomButton
					title={buttonTitle}
					disabled={pending}
					backgroundColor={colors.accent}
					onPress={() => {
						if (isFirstRun) {
							handleFirstRun();
						} else {
							handleRecovery();
						}
					}}
				/>
			</View>
		</ScrollView>
	);
}

const localStyles = StyleSheet.create({
	iconRow: {
		alignItems: "center",
		marginTop: 24,
		marginBottom: 12,
	},
	body: {
		marginTop: 8,
		marginBottom: 16,
	},
});

const styles = { ...globalStyles, ...localStyles };
