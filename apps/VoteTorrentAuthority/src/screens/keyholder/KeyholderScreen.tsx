import React, { useCallback, useLayoutEffect, useRef, useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { ExtendedTheme, useFocusEffect, useNavigation, useRoute, useTheme } from "@react-navigation/native";
import { useTranslation } from "react-i18next";
import type { IElectionEngine, InviteStatus, SentKeyholderInvite } from "@votetorrent/vote-core";
import { ThemedText } from "../../components/ThemedText";
import { CustomButton } from "../../components/CustomButton";
import { InlineError } from "../../components/InlineError";
import { globalStyles } from "../../theme/styles";
import type { NavigationProp } from "../../navigation/types";
import { useApp } from "../../providers/AppProvider";
import { peerUnavailableMessage } from "../../utils/peerUnavailableMessage";
import { resolveKeyholderKeyVault } from "../../engines/keyholder-vault";
import { driveKeyholderDkg, keyholderDkgRowState, type KeyholderDkgRowState } from "./keyholder-dkg-driver";
import { KeyholderDkgStatusRow } from "./components/KeyholderDkgStatusRow";
import { KEYHOLDER_INVITE_STATE_META, keyholderInviteState } from "./keyholder-invite-status";

type KeyholderParams = {
	keyholder: InviteStatus<SentKeyholderInvite>;
	electionEngine: IElectionEngine;
};

export function KeyholderScreen() {
	const { t } = useTranslation();
	const { colors } = useTheme() as ExtendedTheme;
	const navigation = useNavigation<NavigationProp>();
	const { keyholder: routeKeyholder, electionEngine } = useRoute().params as KeyholderParams;
	const { getEngine } = useApp();
	// UAT 62 M: the route param is a snapshot taken when the card was tapped. Each focus re-reads
	// the election and swaps in the same-named keyholder from the engine, so an accept (or decline)
	// that happened since shows here without leaving the screen.
	const [keyholder, setKeyholder] = useState<InviteStatus<SentKeyholderInvite>>(routeKeyholder);

	useLayoutEffect(() => {
		navigation.setOptions({ title: t("keyholder") });
	}, [navigation, t]);

	// INV-03: navigate to KeyholderInvitation in send mode, passing the engine and keyholder
	// so the send screen can call electionEngine.inviteKeyholder (un-gated by 21-05).
	const onInvite = () => {
		navigation.navigate("KeyholderInvitation", {
			mode: "send",
			electionEngine,
			keyholder,
		});
	};

	const seedInvite = keyholder.invite;

	// D-19 (62-26): the keyholder DKG round driver runs pull-only, on screen focus — which
	// covers "open" too, since useFocusEffect fires on first focus. No timer, no interval.
	const [dkgRowState, setDkgRowState] = useState<KeyholderDkgRowState | null>("loading");
	const [dkgErrorMessage, setDkgErrorMessage] = useState<string>("");
	const inFlight = useRef(false);

	useFocusEffect(
		useCallback(() => {
			let active = true;
			if (!inFlight.current) {
				inFlight.current = true;
				(async () => {
					try {
						const details = await electionEngine.getElectionDetails();
						const electionId = details.election.id;
						const fresh = details.current?.keyholders?.find((k) => k.invite?.name === routeKeyholder.invite?.name);
						const current = fresh ?? routeKeyholder;
						if (active && fresh) setKeyholder(fresh);
						const outcome = await driveKeyholderDkg(
							{ getEngine, vault: resolveKeyholderKeyVault() },
							electionId,
							current.result?.invokedId
						);
						if (!active) return;
						// Per this screen's own contract: when the status is unknown (null) AND an
						// error occurred, render no row at all — the InlineError alone carries the
						// message. Any other outcome (including a null status with NO error, which
						// never happens, and every successful read) renders the row.
						setDkgRowState(outcome.status === null && outcome.error ? null : keyholderDkgRowState(outcome.status));
						if (outcome.error) {
							setDkgErrorMessage(outcome.error.authDenied ? t("deviceSigningErrorGeneric") : (peerUnavailableMessage({ message: outcome.error.message }, t, "write") ?? outcome.error.message));
						} else {
							setDkgErrorMessage("");
						}
					} finally {
						inFlight.current = false;
					}
				})();
			}
			return () => {
				active = false;
			};
		}, [electionEngine, getEngine, routeKeyholder, t])
	);

	return (
		<ScrollView style={styles.container}>
			<View style={styles.section}>
				<View style={styles.detail}>
					<ThemedText type="defaultSemiBold">{t("name")}: </ThemedText>
					<ThemedText>{seedInvite?.name ?? "(unnamed)"}</ThemedText>
				</View>
				<View style={styles.detail}>
					<ThemedText type="defaultSemiBold">{t("keyholderStatusLabel")}: </ThemedText>
					<ThemedText testID="keyholder-invite-status">{t(KEYHOLDER_INVITE_STATE_META[keyholderInviteState(keyholder)].labelKey)}</ThemedText>
				</View>
				{dkgRowState !== null ? <KeyholderDkgStatusRow state={dkgRowState} /> : null}
				<InlineError message={dkgErrorMessage} />
			</View>
			<View style={styles.section}>
				<CustomButton
					title={t("invite")}
					icon="paper-plane"
					backgroundColor={colors.accent}
					size="thin"
					onPress={onInvite}
				/>
			</View>
		</ScrollView>
	);
}

const localStyles = StyleSheet.create({
	detail: {
		flexDirection: "row",
		marginBottom: 8,
	},
});

const styles = { ...globalStyles, ...localStyles };

export default KeyholderScreen;
