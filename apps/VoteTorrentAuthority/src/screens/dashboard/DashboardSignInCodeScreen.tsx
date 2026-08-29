/**
 * DashboardSignInCodeScreen — the D-09 producer screen. An officer generates a
 * short-expiry, single-use bearer code (D-05) here and reads it aloud, or shows
 * it, to the officer signing in to the web dashboard. There is deliberately NO
 * QR or camera affordance anywhere on this screen (D-03) — see
 * `NetworksScreen.tsx`'s own "not yet wired (no camera dependency)" comment for
 * the concrete precedent this decision follows.
 *
 * GENERATING IS A BLOCKING TWO-STEP, DELIBERATELY, AND THE SECOND STEP COSTS A
 * REAL SIGNATURE. Pressing the generate button raises an in-screen
 * confirmation naming exactly what is about to leave the device, gated behind
 * a typed "I confirm" (the same `iConfirm`/`typeIConfirm` idiom
 * `RevokeKeyScreen.tsx` uses). Only confirming that calls `handleGenerate`,
 * which — BEFORE `exportDashboardSnapshot()` — obtains
 * `createDeviceSigner(...)` and produces one signature over a locally
 * constructed, throwaway challenge. This is the one action in this app that
 * copies the ENTIRE local database, registrant information included, into a
 * bearer-readable artifact — every other authority action that touches
 * authority data goes through this SAME hardware-bound, biometric-gated
 * signing ceremony, so this screen now matches that posture rather than
 * settling for a confirmation alone. The signature itself is a LOCAL
 * PRESENCE PROOF ONLY (see the comment at its call site in `handleGenerate`):
 * it is discarded immediately, never persisted, transmitted, or handed to
 * `vote-engine`, and no schema CHECK ever verifies it — the entire value is
 * the biometric prompt the Keystore raises to produce it at all. A
 * cancellation of that prompt exports nothing and is not treated as an error
 * (`useDeviceSigningErrorHandler`'s existing "cancellation" no-op).
 *
 * This screen has no text input, so — unlike `AddNetworkScreen.tsx`, whose
 * import/hook block this screen otherwise mirrors — `KeyboardAvoidingScreen`
 * and `CustomTextInput` are deliberately OMITTED. Do not "restore" either: a
 * `ScrollView` with `globalStyles` is the whole layout.
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ScrollView, StyleSheet, View } from "react-native";
import { ExtendedTheme, useTheme } from "@react-navigation/native";
import Clipboard from "@react-native-clipboard/clipboard";
import { sha256 } from "@noble/hashes/sha2.js";
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { ThemedText } from "../../components/ThemedText";
import { CustomButton } from "../../components/CustomButton";
import { CustomTextInput } from "../../components/CustomTextInput";
import { Footer } from "../../components/Footer";
import { InlineError } from "../../components/InlineError";
import { NoNetwork } from "../../components/NoNetwork";
import { globalStyles } from "../../theme/styles";
import { useApp } from "../../providers/AppProvider";
import { isNoNetworkEstablishedError } from "../../engines/engine-factory";
import { createDeviceSigner } from "../../engines/device-signer";
import { useDeviceSigningErrorHandler } from "../../hooks/useDeviceSigningErrorHandler";
import {
	DASHBOARD_SIGNIN_CODE_SPAN_MINUTES,
	clearStagedSignInCode,
	mintDashboardSignInCode,
	readStagedSignInCode,
} from "../../services/dashboard-signin-code";
import type { StagedSignInCode } from "../../services/dashboard-signin-code";
import {
	createBootstrapUploadHandle,
	isBootstrapUploadConfigured,
	uploadFailureCopyKey,
} from "../../services/bootstrap-upload";

export default function DashboardSignInCodeScreen() {
	const { colors } = useTheme() as ExtendedTheme;
	const { t } = useTranslation();
	const { exportDashboardSnapshot } = useApp();
	const handleDeviceSigningError = useDeviceSigningErrorHandler();

	const [record, setRecord] = useState<StagedSignInCode | undefined>(undefined);
	const [errorMessage, setErrorMessage] = useState<string>("");
	// The generate sequence's phase. `signing` covers the biometric and the
	// whole-database export; `uploading` covers the seal and the network round
	// trip, which happen together inside `mintDashboardSignInCode`.
	const [generatePhase, setGeneratePhase] = useState<"idle" | "signing" | "uploading">("idle");
	// DERIVED, so every `disabled={generating ...}` expression below is
	// byte-identical to what the confirm-gate tests already pin. Widening the
	// state without deriving this would have quietly re-opened a gate.
	const generating = generatePhase !== "idle";
	// The ref is the CORRECTNESS guard; the phase above is the FEEDBACK. A
	// state write schedules no synchronous render, so two presses dispatched in
	// one tick both read the same closure and a state-only guard cannot close
	// that gap; a ref mutation is visible to every subsequent call in the same
	// tick. The window here is now a network round trip rather than a local
	// computation, so it is wide enough to hit by accident — and two mints
	// would emit two revokes, retiring a code the officer may still be holding.
	const generatingRef = useRef(false);
	// The confirmation step in front of the export. `false` is the resting
	// state, so nothing about this screen's normal render implies an export is
	// pending.
	const [confirming, setConfirming] = useState(false);
	// The typed "I confirm" gate (RevokeKeyScreen's own idiom) in front of the
	// confirm step's destructive button. Reset whenever the confirm step is
	// entered or left, so a stale confirmation typed for a PRIOR attempt can
	// never silently carry over.
	const [confirmText, setConfirmText] = useState("");
	const readyToConfirmExport = confirmText === t("iConfirm");
	// Distinct from errorMessage: "no network selected yet" is the expected
	// first-run state (mirrors TasksScreen/SettingsScreen's own convention), so
	// it renders the friendly <NoNetwork /> empty state rather than an error
	// banner carrying an internal EngineFactory message.
	const [hasNetwork, setHasNetwork] = useState(true);
	// Ticks once a second purely to re-render the live countdown; carries no
	// data of its own.
	const [nowTick, setNowTick] = useState(() => Date.now());

	// THE CLIPBOARD OUTLIVES THE CODE UNLESS SOMEONE ENDS IT. `Clipboard
	// .setString(record.code)` puts a credential that unlocks the entire
	// authority database onto the SYSTEM clipboard, where it survives the
	// code's expiry, survives app backgrounding, appears in the Android 13+
	// clipboard preview and in clipboard-history utilities, and on older
	// Android is readable by any app holding READ_CLIPBOARD. Nothing used to
	// clear it — not expiry, not redemption, not leaving the screen.
	//
	// `copiedRef` is what keeps this honest: the clear only ever runs if THIS
	// screen is the one that wrote the code there. Clearing unconditionally
	// would wipe whatever the officer copied somewhere else, which is a
	// different kind of rude.
	//
	// NOT DONE, and worth knowing: this app's clipboard module (v1.x) exposes
	// `setString`/`setStrings` only — there is no sensitive-content flag to
	// opt into here, so the copy is an ordinary clipboard write for as long as
	// it is on the clipboard.
	const copiedRef = useRef(false);

	const clearCopiedCode = useCallback(() => {
		if (!copiedRef.current) return;
		copiedRef.current = false;
		Clipboard.setString("");
	}, []);

	useEffect(() => {
		let cancelled = false;
		readStagedSignInCode().then((staged) => {
			if (!cancelled) setRecord(staged);
		});
		return () => {
			cancelled = true;
		};
	}, []);

	useEffect(() => {
		const interval = setInterval(() => setNowTick(Date.now()), 1_000);
		return () => clearInterval(interval);
	}, []);

	const handleGenerate = useCallback(async () => {
		if (generatingRef.current) return;
		generatingRef.current = true;
		setErrorMessage("");
		setConfirming(false);
		setConfirmText("");
		setGeneratePhase("signing");

		// THE CONFIGURATION CHECK BELONGS HERE, not inside the uploader.
		// Reaching the uploader means the biometric has already been raised and
		// the entire database already exported; spending both on an attempt
		// that provably cannot succeed is a worse experience than an immediate
		// refusal. The uploader keeps its own identical refusal as the second
		// layer — this screen is a courtesy, never the enforcement point.
		if (!isBootstrapUploadConfigured()) {
			setErrorMessage(t(uploadFailureCopyKey("not-configured")));
			generatingRef.current = false;
			setGeneratePhase("idle");
			return;
		}

		// Created before the `try` so the `catch` can read the classification
		// off it. The reason cannot travel on the error: the mint deliberately
		// attaches no `cause`, because a `cause` is the vector by which a raw
		// upstream message reaches a log line or a crash report.
		const handle = createBootstrapUploadHandle();
		try {
			// PRESENCE PROOF, BEFORE anything is exported or minted. Every other
			// authority action that touches authority data goes through this
			// SAME hardware-bound, biometric-gated signing ceremony; exporting
			// the whole database is the one action that must not be cheaper than
			// that. `createDeviceSigner` throws `NO_KEY_PROVISIONED` before any
			// native call when nothing is provisioned, which the catch block
			// below routes to the provisioning screen via the existing hook —
			// no new branch needed here.
			//
			// The digest signed here is a LOCAL PRESENCE PROOF ONLY: a purpose
			// label, a canonical timestamp and a fresh random nonce, all
			// generated on THIS device and never derived from the database. The
			// resulting `Signature` is discarded immediately below — never put
			// into state, never logged, never persisted, never transmitted, and
			// never handed to `vote-engine`. No schema CHECK ever verifies it;
			// the entire value is the biometric prompt the Keystore raises to
			// produce it at all (mirrors this app's rule that a screen never
			// constructs signed bytes the engine will verify — here nothing
			// verifies them).
			const signer = await createDeviceSigner("Device User");
			const nonceBytes = new Uint8Array(16);
			globalThis.crypto.getRandomValues(nonceBytes);
			let nonceHex = "";
			for (const byte of nonceBytes) nonceHex += byte.toString(16).padStart(2, "0");
			const presenceProofTimestamp = new Date().toISOString().slice(0, 19);
			const preimage = `dashboard-signin-code-export.${presenceProofTimestamp}.${nonceHex}`;
			const challengeDigest = sha256(utf8ToBytes(preimage));
			await signer(challengeDigest);

			const snapshot = await exportDashboardSnapshot();
			// Set BEFORE the mint, because the mint now seals the export and
			// sends it in one call — which is why the in-flight copy names
			// sealing as well as sending. A string that named only the network
			// would be describing the shorter half of the wait.
			setGeneratePhase("uploading");
			// The uploader is passed UNCONDITIONALLY. A branch that omitted it
			// would take the filesystem-binding path instead, persisting a
			// payload locally and handing the officer a code no browser could
			// ever redeem — the exact failure this sequence exists to end.
			const minted = await mintDashboardSignInCode(snapshot, { uploader: handle.upload });
			// THE FAIL-CLOSED POINT. This line is reachable only after the mint
			// resolves, and the mint resolves only after the service has
			// acknowledged the upload — so no code can reach the officer's eyes
			// before the browser can redeem it.
			setRecord(minted);
		} catch (error) {
			if (isNoNetworkEstablishedError(error)) {
				setHasNetwork(false);
				return;
			}
			const outcome = handleDeviceSigningError(error);
			if (outcome.handled) return;
			// A COPY-TABLE STRING, and the error CLASS to the console. The
			// comment here used to say "never render a raw engine error
			// message" while the line below rendered exactly that. On this
			// screen it mattered more than usual: the reachable errors come
			// from `exportDatabaseSnapshot`, whose messages name internal
			// schema structure ("unsupported value type in <Table>.<Column>",
			// "failed to read table <Table>"), and from an absent engine
			// factory, which surfaced as "Cannot read properties of null
			// (reading 'exportDashboardSnapshot')" in the officer's face.
			// eslint-disable-next-line no-console
			console.error("DashboardSignInCodeScreen: generating a code failed:", (error as { name?: string })?.name ?? "Error");
			// A MINT THAT SUCCEEDED BUT COULD NOT SEND IS NOT A MINT THAT
			// FAILED, and the remedies differ, so this branch never falls back
			// on `dashboardSignInCodeGenerateFailed`. The classification is
			// read off the handle THIS call created rather than off the error,
			// which by contract carries no detail at all. `unreachable` is the
			// safe default for an unclassified failure: its remedy — check the
			// service is running, then try again — is the correct advice when
			// nothing more specific is known.
			const uploadFailed = (error as { name?: string })?.name === "BootstrapUploadFailedError";
			setErrorMessage(
				uploadFailed
					? t(uploadFailureCopyKey(handle.lastFailureReason() ?? "unreachable"))
					: (outcome.message ?? t("dashboardSignInCodeGenerateFailed")),
			);
		} finally {
			generatingRef.current = false;
			setGeneratePhase("idle");
		}
	}, [exportDashboardSnapshot, handleDeviceSigningError, t]);

	const handleRequestGenerate = useCallback(() => {
		setErrorMessage("");
		setConfirmText("");
		setConfirming(true);
	}, []);

	const handleCancelGenerate = useCallback(() => {
		setConfirming(false);
		setConfirmText("");
	}, []);

	// The ONE path in this app that reaches `clearStagedSignInCode`. Without
	// it a staged export sat in AsyncStorage indefinitely, so the officer had
	// no way to end the exposure window early. Deliberately unconfirmed: it is
	// the SAFE direction (it destroys a credential and a copy of data the
	// device still holds elsewhere), which is the opposite of the generate
	// action below it.
	const handleDiscard = useCallback(async () => {
		setErrorMessage("");
		setConfirming(false);
		clearCopiedCode();
		await clearStagedSignInCode();
		setRecord(undefined);
	}, [clearCopiedCode]);

	const isRedeemed = record?.redeemedAt !== undefined;
	// Countdown arithmetic — DISPLAY ONLY. The stored `expiresAt` is canonical
	// UTC with the `Z` suffix stripped (dashboard-signin-code.ts's `toCanonical`).
	// Appending `Z` here exists SOLELY inside this countdown's arithmetic and is
	// NEVER written back into a stored, displayed or transmitted value — every
	// freshness/expiry DECISION lives in `redeemStagedSignInCode`'s raw string
	// comparison; this is presentation only.
	const expiresAtMillis = record !== undefined ? Date.parse(`${record.expiresAt}Z`) : undefined;
	const isExpired =
		record !== undefined && !isRedeemed && expiresAtMillis !== undefined && expiresAtMillis <= nowTick;

	useEffect(() => {
		if (isExpired || isRedeemed) clearCopiedCode();
	}, [isExpired, isRedeemed, clearCopiedCode]);

	useEffect(() => () => clearCopiedCode(), [clearCopiedCode]);

	if (!hasNetwork) {
		return <NoNetwork />;
	}

	const screenState: "idle" | "generated" | "used" | "expired" =
		record === undefined ? "idle" : isRedeemed ? "used" : isExpired ? "expired" : "generated";

	const remainingSeconds =
		expiresAtMillis !== undefined ? Math.max(0, Math.round((expiresAtMillis - nowTick) / 1_000)) : 0;
	const remainingLabel = `${Math.floor(remainingSeconds / 60)}:${String(remainingSeconds % 60).padStart(2, "0")}`;

	return (
		<View style={styles.content}>
			<ScrollView style={styles.container}>
				<View style={styles.section}>
					<ThemedText type="title" style={styles.sectionTitle}>
						{t("dashboardSignInCodeTitle")}
					</ThemedText>

					{/* OUTSIDE the screenState branches, deliberately. During a
					    re-mint the screen is in the generated state showing the
					    PRIOR code, and an indicator that only rendered in the
					    idle state would be invisible in exactly the case where
					    the officer most needs to know something is happening. */}
					{generatePhase === "uploading" ? (
						<ThemedText type="default" style={styles.body} testID="dashboard-signin-code-uploading">
							{t("dashboardSignInCodeUploading")}
						</ThemedText>
					) : null}

					{screenState === "idle" ? (
						<ThemedText type="default" style={styles.body}>
							{t("dashboardSignInCodeIdle")}
						</ThemedText>
					) : null}

					{screenState === "generated" && record ? (
						<>
							<ThemedText type="default" style={styles.body}>
								{t("dashboardSignInCodeBody", { minutes: DASHBOARD_SIGNIN_CODE_SPAN_MINUTES })}
							</ThemedText>
							<ThemedText type="defaultSemiBold" style={styles.code} selectable numberOfLines={1}>
								{record.code}
							</ThemedText>
							<ThemedText type="small" style={styles.countdown}>
								{t("dashboardSignInCodeCountdown", { remaining: remainingLabel })}
							</ThemedText>
							<CustomButton
								title={t("dashboardSignInCodeCopyButton")}
								icon="copy"
								onPress={() => {
									Clipboard.setString(record.code);
									copiedRef.current = true;
								}}
							/>
						</>
					) : null}

					{screenState === "used" ? (
						<ThemedText type="default" style={styles.body}>
							{t("dashboardSignInCodeUsed")}
						</ThemedText>
					) : null}

					{screenState === "expired" ? (
						<ThemedText type="default" style={styles.body}>
							{t("dashboardSignInCodeExpired")}
						</ThemedText>
					) : null}
				</View>
			</ScrollView>
			<InlineError message={errorMessage} />
			{confirming ? (
				<View style={styles.section} testID="dashboard-signin-code-confirm">
					<ThemedText type="defaultSemiBold" style={styles.body}>
						{t("dashboardSignInCodeConfirmHeading")}
					</ThemedText>
					<ThemedText type="default" style={styles.body}>
						{t("dashboardSignInCodeConfirmBody")}
					</ThemedText>
					<CustomTextInput
						title={t("typeIConfirm")}
						placeholder={t("confirmIfSure")}
						value={confirmText}
						onChangeText={setConfirmText}
					/>
				</View>
			) : null}
			<Footer>
				{screenState !== "generated" && !confirming ? (
					<CustomButton
						title={t("dashboardSignInCodeGenerateButton")}
						icon="key"
						disabled={generating}
						backgroundColor={colors.important}
						forceDarkText={true}
						onPress={handleRequestGenerate}
					/>
				) : null}
				{confirming ? (
					<>
						<CustomButton
							title={t("dashboardSignInCodeGenerateButton")}
							icon="key"
							disabled={generating || !readyToConfirmExport}
							backgroundColor={colors.error}
							onPress={handleGenerate}
						/>
						<CustomButton title={t("cancel")} size="thin" onPress={handleCancelGenerate} />
					</>
				) : null}
				{record !== undefined && !confirming ? (
					<CustomButton
						title={t("dashboardSignInCodeDiscardButton")}
						icon="trash"
						size="thin"
						disabled={generating}
						onPress={handleDiscard}
					/>
				) : null}
			</Footer>
		</View>
	);
}

const localStyles = StyleSheet.create({
	body: {
		marginBottom: 16,
	},
	code: {
		fontFamily: "monospace",
		fontSize: 18,
		marginBottom: 8,
	},
	countdown: {
		marginBottom: 16,
	},
});

const styles = { ...globalStyles, ...localStyles };
