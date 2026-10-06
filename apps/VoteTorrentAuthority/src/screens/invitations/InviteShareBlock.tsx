import React, { useEffect, useRef, useState } from "react";
import { Share, StyleSheet, View } from "react-native";
import { ExtendedTheme, useTheme } from "@react-navigation/native";
import { useTranslation } from "react-i18next";
import { ThemedText } from "../../components/ThemedText";
import { CustomButton } from "../../components/CustomButton";
import { useToast } from "../../components/Toast";
import { copyToClipboard } from "../../utils/copyToClipboard";

export interface InviteShareBlockProps {
	/** Already-translated heading shown above the share text. */
	label: string;
	/** The one-time invite material the invitee pastes on their device. */
	shareText: string;
	/** Prefix for this block's testIDs (`<prefix>-text`, `-share`, `-copy`, `-status`). */
	testIDPrefix: string;
}


/**
 * InviteShareBlock — the after-send surface shared by the keyholder, administrator and authority
 * invitation screens (UAT 62, Redmi 8 / 360dp).
 *
 * - The invite text renders IN FULL (selectable, wrapping). It used to be cut at 4 lines with no
 *   ellipsis and no way to read the rest.
 * - SHARE opens the OS share sheet (`Share.share`), which matches its label. Android's sheet also
 *   offers its own Copy, so the invite can always leave the device even where the clipboard
 *   module fails.
 * - COPY goes through `copyToClipboard`, which reads the clipboard back on Android (its native
 *   `setString` fails silently — the Redmi 8 showed an empty clipboard and no feedback). The result
 *   is a toast: "Copied" only when the copy is known to have landed, otherwise the copy-failed line.
 */
export function InviteShareBlock({ label, shareText, testIDPrefix }: InviteShareBlockProps) {
	const { t } = useTranslation();
	const { colors } = useTheme() as ExtendedTheme;
	const showToast = useToast();
	const [shareFailed, setShareFailed] = useState(false);
	const mountedRef = useRef(true);

	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
		};
	}, []);

	const onShare = async () => {
		setShareFailed(false);
		try {
			await Share.share({ message: shareText });
		} catch (error) {
			console.warn("InviteShareBlock: share sheet failed:", error instanceof Error ? error.name : typeof error);
			if (mountedRef.current) setShareFailed(true);
		}
	};

	const onCopy = async () => {
		setShareFailed(false);
		const ok = await copyToClipboard(shareText);
		showToast(t(ok ? "invitationShareCopied" : "invitationShareCopyFailed"));
	};

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
			{shareFailed ? (
				<ThemedText
					testID={`${testIDPrefix}-status`}
					accessibilityLiveRegion="polite"
					style={[styles.status, { color: colors.error }]}
				>
					{t("invitationShareSheetFailed")}
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
