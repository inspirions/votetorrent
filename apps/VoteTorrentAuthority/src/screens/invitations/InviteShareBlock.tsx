import React, { useEffect, useRef, useState } from "react";
import { Platform, Share, StyleSheet, View } from "react-native";
import { ExtendedTheme, useTheme } from "@react-navigation/native";
import { useTranslation } from "react-i18next";
import Clipboard from "@react-native-clipboard/clipboard";
import { ThemedText } from "../../components/ThemedText";
import { CustomButton } from "../../components/CustomButton";

export interface InviteShareBlockProps {
	/** Already-translated heading shown above the share text. */
	label: string;
	/** The one-time invite material the invitee pastes on their device. */
	shareText: string;
	/** Prefix for this block's testIDs (`<prefix>-text`, `-share`, `-copy`, `-status`). */
	testIDPrefix: string;
}

type Status = "idle" | "copied" | "copyFailed" | "shareFailed";

/**
 * InviteShareBlock — the after-send surface shared by the keyholder, administrator and authority
 * invitation screens (UAT 62, Redmi 8 / 360dp).
 *
 * - The invite text renders IN FULL (selectable, wrapping). It used to be cut at 4 lines with no
 *   ellipsis and no way to read the rest.
 * - SHARE opens the OS share sheet (`Share.share`), which matches its label. Android's sheet also
 *   offers its own Copy, so the invite can always leave the device even where the clipboard
 *   module fails.
 * - COPY writes to the clipboard and, on Android, READS IT BACK. The Android native `setString`
 *   swallows its own exceptions (`ClipboardModule.setString` only `printStackTrace`s, and it is a
 *   void TurboModule method, so JS never sees a failure). A silent failure is otherwise
 *   indistinguishable from success, which is what the Redmi 8 showed: an empty clipboard and no
 *   feedback. The officer sees "Copied" only when the read-back matches. iOS skips the read-back:
 *   UIPasteboard writes do not fail silently, and a programmatic read raises the iOS 16+ "Allow
 *   Paste" prompt on every Copy.
 */
export function InviteShareBlock({ label, shareText, testIDPrefix }: InviteShareBlockProps) {
	const { t } = useTranslation();
	const { colors } = useTheme() as ExtendedTheme;
	const [status, setStatus] = useState<Status>("idle");
	const mountedRef = useRef(true);

	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
		};
	}, []);

	const onShare = async () => {
		setStatus("idle");
		try {
			await Share.share({ message: shareText });
		} catch (error) {
			console.warn("InviteShareBlock: share sheet failed:", error instanceof Error ? error.name : typeof error);
			if (mountedRef.current) setStatus("shareFailed");
		}
	};

	const onCopy = async () => {
		setStatus("idle");
		let ok = false;
		try {
			Clipboard.setString(shareText);
			ok = Platform.OS === "android" ? (await Clipboard.getString()) === shareText : true;
		} catch (error) {
			console.warn("InviteShareBlock: clipboard copy failed:", error instanceof Error ? error.name : typeof error);
			ok = false;
		}
		if (mountedRef.current) setStatus(ok ? "copied" : "copyFailed");
	};

	const statusCopy =
		status === "copied"
			? t("invitationShareCopied")
			: status === "copyFailed"
				? t("invitationShareCopyFailed")
				: status === "shareFailed"
					? t("invitationShareSheetFailed")
					: "";

	return (
		<View>
			<ThemedText type="defaultSemiBold" style={styles.label}>
				{label}
			</ThemedText>
			<ThemedText testID={`${testIDPrefix}-text`} style={styles.text} selectable>
				{shareText}
			</ThemedText>
			<CustomButton testID={`${testIDPrefix}-share`} title={t("share")} icon="share-nodes" onPress={onShare} />
			<CustomButton
				testID={`${testIDPrefix}-copy`}
				title={t("invitationShareCopy")}
				icon="copy"
				backgroundColor={colors.card}
				onPress={onCopy}
			/>
			{statusCopy ? (
				<ThemedText
					testID={`${testIDPrefix}-status`}
					accessibilityLiveRegion="polite"
					style={[styles.status, { color: status === "copied" ? colors.success : colors.error }]}
				>
					{statusCopy}
				</ThemedText>
			) : null}
		</View>
	);
}

const styles = StyleSheet.create({
	label: {
		marginTop: 12,
		marginBottom: 4,
	},
	text: {
		marginBottom: 8,
		fontFamily: "monospace",
	},
	status: {
		marginTop: 4,
	},
});

export default InviteShareBlock;
