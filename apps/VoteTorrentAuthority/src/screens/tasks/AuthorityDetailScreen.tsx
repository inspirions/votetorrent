import { useLayoutEffect, useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import {
	ExtendedTheme,
	useNavigation,
	useRoute,
	useTheme,
} from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type { IAuthorityEngine } from "@votetorrent/vote-core";
import { useTranslation } from "react-i18next";
import { globalStyles } from "../../theme/styles";
import { ThemedText } from "../../components/ThemedText";
import { CustomButton } from "../../components/CustomButton";
import { Footer } from "../../components/Footer";
import { InlineError } from "../../components/InlineError";
import type { RootStackParamList } from "../../navigation/types";
import { useApp } from "../../providers/AppProvider";

export default function AuthorityDetailScreen() {
	const { t } = useTranslation();
	const { colors } = useTheme() as ExtendedTheme;
	const navigation =
		useNavigation<NativeStackNavigationProp<RootStackParamList>>();
	const { authorityId, slotCid } = useRoute()
		.params as RootStackParamList["AuthorityDetail"];
	const { getEngine } = useApp();

	const [loading, setLoading] = useState(false);
	const [errorMessage, setErrorMessage] = useState<string>("");
	const [answered, setAnswered] = useState(false);

	useLayoutEffect(() => {
		navigation.setOptions({ title: t("authorityDetailTitle") });
	}, [navigation, t]);

	// The engine refuses an answered invitation before any write (CR-01, 62-REVIEW.md). The screen
	// maps that refusal by its code, never shows engine text, and stops offering actions that cannot succeed.
	const mapInviteActionError = (err: unknown): string => {
		if ((err as { code?: unknown } | null)?.code === "invite-already-answered") {
			setAnswered(true);
			return t("authorityDetailAlreadyAnswered");
		}
		return t("authorityDetailActionFailed");
	};

	const onResend = async () => {
		if (loading || answered) return; // re-entrancy guard: prevent concurrent engine calls on rapid double-press
		setErrorMessage("");
		setLoading(true);
		try {
			const engine = await getEngine<IAuthorityEngine>("authority", authorityId);
			await engine.resendInvite(slotCid);
			navigation.goBack();
		} catch (err) {
			console.warn("authorityDetail-resend failed", err instanceof Error ? err.name : "unknown");
			setErrorMessage(mapInviteActionError(err));
		} finally {
			setLoading(false);
		}
	};

	const onCancelInvitation = async () => {
		if (loading || answered) return; // re-entrancy guard: prevent concurrent engine calls on rapid double-press
		setErrorMessage("");
		setLoading(true);
		try {
			const engine = await getEngine<IAuthorityEngine>("authority", authorityId);
			await engine.cancelInvite(slotCid);
			navigation.goBack();
		} catch (err) {
			console.warn("authorityDetail-cancelInvitation failed", err instanceof Error ? err.name : "unknown");
			setErrorMessage(mapInviteActionError(err));
		} finally {
			setLoading(false);
		}
	};

	return (
		<View style={styles.content}>
			<ScrollView style={styles.container}>
				<View style={styles.section}>
					<ThemedText type="default">{t("authorityDetailBodyPrimary")}</ThemedText>
				</View>
				<View style={styles.section}>
					<ThemedText type="default">{t("authorityDetailBodySecondary")}</ThemedText>
				</View>
				<View style={styles.section}>
					<InlineError message={errorMessage} />
				</View>
			</ScrollView>
			<Footer row>
				<CustomButton
					title={t("authorityDetailResend")}
					backgroundColor={colors.accent}
					size="thin"
					flex={true}
					disabled={loading || answered}
					testID="authority-detail-resend"
					onPress={onResend}
				/>
				<CustomButton
					title={t("authorityDetailCancelInvitation")}
					backgroundColor={colors.accent}
					size="thin"
					flex={true}
					disabled={loading || answered}
					testID="authority-detail-cancel"
					onPress={onCancelInvitation}
				/>
			</Footer>
		</View>
	);
}

const localStyles = StyleSheet.create({});

const styles = { ...globalStyles, ...localStyles };
