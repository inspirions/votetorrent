import { ExtendedTheme, useTheme } from "@react-navigation/native";
import { useTranslation } from "react-i18next";
import { CustomButton } from "./CustomButton";
import { Footer } from "./Footer";

export interface SignatureTaskFooterProps {
	onAccept: () => void;
	onReject: () => void;
	acceptLabel?: string;
	rejectLabel?: string;
	// 49-11: optional in-flight-signing disable, applied to BOTH buttons —
	// backward-compatible (defaults false), so every pre-existing caller of
	// this shared footer (KeyholderInvitationScreen, AuthorityInvitationScreen,
	// AdministratorInvitationScreen) is unaffected unless it opts in.
	disabled?: boolean;
}

export function SignatureTaskFooter({
	onAccept,
	onReject,
	acceptLabel,
	rejectLabel,
	disabled,
}: SignatureTaskFooterProps) {
	const { colors } = useTheme() as ExtendedTheme;
	const { t } = useTranslation();
	return (
		<Footer row>
			<CustomButton
				title={acceptLabel ?? t("accept")}
				icon="check"
				backgroundColor={colors.success}
				size="thin"
				flex={true}
				onPress={onAccept}
				disabled={disabled}
			/>
			<CustomButton
				title={rejectLabel ?? t("reject")}
				icon="xmark"
				backgroundColor={colors.error}
				size="thin"
				flex={true}
				onPress={onReject}
				disabled={disabled}
			/>
		</Footer>
	);
}
