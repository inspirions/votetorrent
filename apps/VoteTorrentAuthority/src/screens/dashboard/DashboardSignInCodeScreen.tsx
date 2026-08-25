/**
 * DashboardSignInCodeScreen — the D-09 producer screen. An officer generates a
 * short-expiry, single-use bearer code (D-05) here and reads it aloud, or shows
 * it, to the officer signing in to the web dashboard. There is deliberately NO
 * QR or camera affordance anywhere on this screen (D-03) — see
 * `NetworksScreen.tsx`'s own "not yet wired (no camera dependency)" comment for
 * the concrete precedent this decision follows.
 *
 * This screen has no text input, so — unlike `AddNetworkScreen.tsx`, whose
 * import/hook block this screen otherwise mirrors — `KeyboardAvoidingScreen`
 * and `CustomTextInput` are deliberately OMITTED. Do not "restore" either: a
 * `ScrollView` with `globalStyles` is the whole layout.
 */

import React, { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ScrollView, StyleSheet, View } from "react-native";
import { ExtendedTheme, useTheme } from "@react-navigation/native";
import Clipboard from "@react-native-clipboard/clipboard";
import { ThemedText } from "../../components/ThemedText";
import { CustomButton } from "../../components/CustomButton";
import { Footer } from "../../components/Footer";
import { InlineError } from "../../components/InlineError";
import { NoNetwork } from "../../components/NoNetwork";
import { globalStyles } from "../../theme/styles";
import { useApp } from "../../providers/AppProvider";
import { isNoNetworkEstablishedError } from "../../engines/engine-factory";
import {
	DASHBOARD_SIGNIN_CODE_SPAN_MINUTES,
	mintDashboardSignInCode,
	readStagedSignInCode,
} from "../../services/dashboard-signin-code";
import type { StagedSignInCode } from "../../services/dashboard-signin-code";

export default function DashboardSignInCodeScreen() {
	const { colors } = useTheme() as ExtendedTheme;
	const { t } = useTranslation();
	const { exportDashboardSnapshot } = useApp();

	const [record, setRecord] = useState<StagedSignInCode | undefined>(undefined);
	const [errorMessage, setErrorMessage] = useState<string>("");
	const [generating, setGenerating] = useState(false);
	// Distinct from errorMessage: "no network selected yet" is the expected
	// first-run state (mirrors TasksScreen/SettingsScreen's own convention), so
	// it renders the friendly <NoNetwork /> empty state rather than an error
	// banner carrying an internal EngineFactory message.
	const [hasNetwork, setHasNetwork] = useState(true);
	// Ticks once a second purely to re-render the live countdown; carries no
	// data of its own.
	const [nowTick, setNowTick] = useState(() => Date.now());

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
		setErrorMessage("");
		setGenerating(true);
		try {
			const snapshot = await exportDashboardSnapshot();
			const minted = await mintDashboardSignInCode(snapshot);
			setRecord(minted);
		} catch (error) {
			if (isNoNetworkEstablishedError(error)) {
				setHasNetwork(false);
				return;
			}
			// Never render a raw engine error message — surface it through the
			// same InlineError affordance every other screen in this app uses.
			setErrorMessage(error instanceof Error ? error.message : String(error));
		} finally {
			setGenerating(false);
		}
	}, [exportDashboardSnapshot]);

	if (!hasNetwork) {
		return <NoNetwork />;
	}

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
								onPress={() => Clipboard.setString(record.code)}
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
			{screenState !== "generated" ? (
				<Footer>
					<CustomButton
						title={t("dashboardSignInCodeGenerateButton")}
						icon="key"
						disabled={generating}
						backgroundColor={colors.important}
						forceDarkText={true}
						onPress={handleGenerate}
					/>
				</Footer>
			) : null}
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
