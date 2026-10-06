import React, { useEffect, useLayoutEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ScrollView, StyleSheet, View } from "react-native";
import { ExtendedTheme, useNavigation, useRoute, useTheme } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type {
	Authority,
	IAuthorityEngine,
	IInvitationEngine,
	INetworkEngine,
	InviteStatus,
	Scope,
	SentOfficerInvite,
} from "@votetorrent/vote-core";
import { scopeDescriptions } from "@votetorrent/vote-core";
import { ThemedText } from "../../components/ThemedText";
import { ChipButton } from "../../components/ChipButton";
import { CustomButton } from "../../components/CustomButton";
import { CustomTextInput } from "../../components/CustomTextInput";
import { InviteShareBlock } from "../invitations/InviteShareBlock";
import { Footer } from "../../components/Footer";
import { InfoCard } from "../../components/InfoCard";
import { InlineError } from "../../components/InlineError";
import { SignatureTaskFooter } from "../../components/SignatureTaskFooter";
import type { RootStackParamList } from "../../navigation/types";
import { useApp } from "../../providers/AppProvider";
import { createDeviceSigner } from "../../engines/device-signer";
import { getOrCreateDeviceUser } from "../../engines/device-user";
import { globalStyles } from "../../theme/styles";
import { FOUNDING_OFFICER_SCOPES } from "../../utils/foundingOfficerScopes";
import { useDeviceSigningErrorHandler } from "../../hooks/useDeviceSigningErrorHandler";
import { KeyboardAvoidingScreen } from "../../components/KeyboardAvoidingScreen";
import { inviteShareErrorKey, parseInviteShare, resolveInviteFromShare } from "../invitations/invite-share";

type AdministratorInvitationParams = {
	mode: "send" | "accept";
	initialShare?: string;
	authority?: Authority;
};

export default function AdministratorInvitationScreen() {
	const { t } = useTranslation();
	const { colors } = useTheme() as ExtendedTheme;
	const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
	const { mode, initialShare, authority } = useRoute().params as AdministratorInvitationParams;
	const { getEngine } = useApp();

	// Send-mode form state
	const [name, setName] = useState("");
	const [title, setTitle] = useState("");
	// Share text shown after a successful send (D-05)
	const [shareText, setShareText] = useState<string>("");
	const [errorMessage, setErrorMessage] = useState<string>("");
	const [isSending, setIsSending] = useState(false);
	const handleDeviceSigningError = useDeviceSigningErrorHandler();

	// Accept-mode paste field (D-06 — invitee pastes the share text here)
	const [pastedInvite, setPastedInvite] = useState<string>(initialShare ?? "");
	const parsed = useMemo(() => parseInviteShare(pastedInvite), [pastedInvite]);
	// The slot resolved from the paste (by InviteKey + type); accept and decline sign against it.
	const [resolved, setResolved] = useState<{ slotCid: string; invitePrivate: string } | undefined>(undefined);

	// Accept-mode fetched invite
	const [invite, setInvite] = useState<InviteStatus<SentOfficerInvite> | undefined>(undefined);
	// Set when the invite fetch fails, so the screen stops showing "Loading…" forever.
	const [inviteLoadFailed, setInviteLoadFailed] = useState(false);
	const [networkName, setNetworkName] = useState("");

	useEffect(() => {
		// Network context for the invitation header (best-effort; real engine later).
		async function loadNetwork() {
			try {
				const engine = await getEngine<INetworkEngine>("network");
				const details = await engine?.getDetails();
				if (details?.network?.name) setNetworkName(details.network.name);
			} catch (error) {
				console.warn("Error loading network for invitation:", error);
			}
		}
		loadNetwork();
	}, [getEngine]);

	useLayoutEffect(() => {
		navigation.setOptions({
			title: mode === "send" ? t("sendInvitation") : t("invitation"),
		});
	}, [navigation, t, mode]);

	// Map a failed resolve/accept/decline to user copy. Never render engine text or any Cid.
	const mapAcceptError = (error: unknown): string => {
		const shareKey = inviteShareErrorKey(error);
		if (shareKey) return t(shareKey);
		return t("invitationAcceptFailed");
	};

	// Resolve the slot from the pasted share, then load the invite details from the resolved Cid.
	useEffect(() => {
		if (mode !== "accept") return;
		setResolved(undefined);
		setInvite(undefined);
		setInviteLoadFailed(false);
		if (!pastedInvite.trim()) {
			setErrorMessage("");
			return;
		}
		if (!parsed) return; // still typing; the paste hint stays up
		let cancelled = false;
		(async () => {
			try {
				const engine = await getEngine<IInvitationEngine>("invitations");
				const r = await resolveInviteFromShare(engine, pastedInvite, "of");
				const status = await engine.getOfficerInvite(r.slotCid);
				if (cancelled) return;
				setErrorMessage("");
				setResolved({ slotCid: r.slotCid, invitePrivate: r.invitePrivate });
				setInvite(status);
			} catch (error) {
				if (cancelled) return;
				console.warn("Error loading officer invite:", error instanceof Error ? error.name : "unknown");
				setInviteLoadFailed(true);
				setErrorMessage(mapAcceptError(error));
			}
		})();
		return () => {
			cancelled = true;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [mode, pastedInvite, getEngine]);

	// INV-01: real officer invite send with device signature (D-01/D-03/D-04)
	const onSend = async () => {
		// Pattern B: clear any prior error so a retry starts clean.
		setErrorMessage("");
		setIsSending(true);
		try {
			if (!authority?.id) {
				setErrorMessage("Authority not available — navigate from an authority context.");
				return;
			}

			// Resolve device user for the signing identity (D-01).
			const deviceUser = await getOrCreateDeviceUser("Device User");

			// Open the authority engine for this authority.
			const authorityEngine = await getEngine<IAuthorityEngine>("authority", authority.id);

			// Mint the one-time officer invite (key material stays in engine scope).
			// createOfficerInvite is synchronous and returns an OfficerInviteShare
			// containing the ephemeral invitePrivate (one-time only — D-05/D-27).
			const officerInvite = authorityEngine.createOfficerInvite({
				name,
				title,
				scopes: [...FOUNDING_OFFICER_SCOPES],
			});

			// D-01/D-03/D-04: device signer callback — engine computes Digest(InviteSlot.Cid)
			// internally and passes the bytes to this callback (engine-authoritative, D-03).
			// The callback closes over the device private key; the key never crosses into
			// vote-engine (D-01). Never { prehash:false } (WR-10).
			const signer = await createDeviceSigner(deviceUser.name);

			// Save invite with signing — engine computes digest, calls signer, commits.
			await authorityEngine.saveInviteWithSigning(officerInvite, "rad" as Scope, signer);

			// D-05: render the one-time invite material as text for Copy-to-clipboard share.
			// Include all fields the invitee needs to reconstruct the ephemeral key (D-06).
			const sharePayload = JSON.stringify({
				invitePrivate: officerInvite.invitePrivate,
				inviteKey: officerInvite.inviteKey,
				inviteSignature: officerInvite.inviteSignature,
				expiration: officerInvite.expiration,
				type: officerInvite.type,
				name: officerInvite.name,
				title: officerInvite.title,
			});
			setShareText(sharePayload);
			// D-08: do NOT navigate away immediately — keep screen so Copy affordance shows.
		} catch (error) {
			console.warn("onSend error:", error);
			const outcome = handleDeviceSigningError(error);
			if (outcome.handled) return;
			setErrorMessage(outcome.message ?? (error instanceof Error ? error.message : String(error)));
		} finally {
			setIsSending(false);
		}
	};

	// D-06: accept - the slot is resolved from the pasted share, never from a route id.
	const respond = async (accept: boolean) => {
		setErrorMessage("");
		try {
			const engine = await getEngine<IInvitationEngine>("invitations");
			const target = resolved ?? (await resolveInviteFromShare(engine, pastedInvite, "of"));
			// T-21-11-03: accept and decline both call the SIGNED respondToInvite path (D-09).
			await engine.respondToInvite(target.slotCid, accept, target.invitePrivate);
			// GAP-2: navigate ONLY on success - the InviteResult is now written.
			navigation.goBack();
		} catch (error) {
			console.warn("Error responding to invite:", error instanceof Error ? error.name : "unknown");
			setErrorMessage(mapAcceptError(error));
		}
	};
	const onAccept = () => respond(true);
	const onDecline = () => respond(false);

	if (mode === "send") {
		return (
			<View style={styles.content}>
				<ScrollView style={styles.container}>
					<View style={styles.section}>
						<ThemedText type="title" style={styles.sectionTitle}>
							{t("administratorInvitation")}
						</ThemedText>
						<CustomTextInput title={t("name")} value={name} onChangeText={setName} />
						<CustomTextInput title={t("title")} value={title} onChangeText={setTitle} />

						{/* D-05: render share text + Copy button after a successful send */}
						{shareText ? (
							<InviteShareBlock label={t("invitationKey")} shareText={shareText} testIDPrefix="administrator-invitation-share" />
						) : null}

						{/* Pattern B error display */}
						<InlineError message={errorMessage} />
					</View>
				</ScrollView>
				{!shareText ? (
					<Footer>
						<CustomButton
							title={isSending ? `${t("send")}…` : t("send")}
							icon="paper-plane"
							disabled={isSending}
							backgroundColor={colors.success}
							forceDarkText={true}
							onPress={onSend}
						/>
					</Footer>
				) : null}
			</View>
		);
	}

	// Accept mode (Figma frame 32)
	const seedInvite = invite?.invite;
	const permissions = (seedInvite?.scopes ?? [])
		.map((scope: Scope) => scopeDescriptions[scope] ?? t(`scope_${scope}`))
		.join(", ");
	return (
		<KeyboardAvoidingScreen>
			<ScrollView style={styles.container} contentContainerStyle={{ paddingBottom: 24 }}>
				<View style={styles.section}>
					{seedInvite ? (
						<>
							{networkName ? (
								<View style={styles.detailRow}>
									<ThemedText type="defaultSemiBold">{t("network")}: </ThemedText>
									<ThemedText>{networkName}</ThemedText>
								</View>
							) : null}
							<View style={styles.detailRow}>
								<ThemedText type="defaultSemiBold">{t("name")}: </ThemedText>
								<ThemedText>{seedInvite.name}</ThemedText>
							</View>
							<View style={styles.detailRow}>
								<ThemedText type="defaultSemiBold">{t("title")}: </ThemedText>
								<ThemedText>{seedInvite.title}</ThemedText>
							</View>
							<View style={styles.detailRow}>
								<ThemedText type="defaultSemiBold">{t("permissions")}: </ThemedText>
								<ThemedText style={styles.permissionsText}>{permissions}</ThemedText>
							</View>

							{/* Create a new user, OR sign with the existing profile (Figma frame 32) */}
							<ChipButton
								label={t("createUser")}
								icon="circle-plus"
								fullWidth
								onPress={() => {}}
							/>
							<ThemedText type="defaultSemiBold" style={styles.orText}>
								{t("or")}
							</ThemedText>
							<InfoCard
								additionalInfo={[
									{ label: t("user"), value: seedInvite.name },
									{ label: t("sid"), value: (seedInvite as any).userId },
								]}
								icon="chevron-right"
								onPress={() => {}}
							/>
							<CustomButton
								title={t("sign")}
								icon="signature"
								backgroundColor={colors.important}
								forceDarkText={true}
								size="thin"
								onPress={() => {}}
							/>
						</>
					) : !parsed ? (
						<ThemedText>{t("invitationAcceptPasteHint")}</ThemedText>
					) : inviteLoadFailed ? null : (
						<ThemedText>{t("loading")}</ThemedText>
					)}

					{/* D-06: paste field for the share text the sender copied. CustomTextInput's `title` is
					    the field's only label (a separate heading here rendered it twice). */}
					<CustomTextInput
						title={t("invitationKey")}
						value={pastedInvite}
						onChangeText={setPastedInvite}
						placeholder={t("invitationAcceptPastePlaceholder")}
					/>
				</View>
			</ScrollView>
			{/* GAP-2: surface respondToInvite failures inline in accept mode */}
			<View testID="administrator-invitation-error" style={{ paddingHorizontal: globalStyles.container.padding }}>
				<InlineError message={errorMessage} />
			</View>
			<SignatureTaskFooter
				onAccept={onAccept}
				onReject={onDecline}
				acceptLabel={t("accept")}
				rejectLabel={t("reject")}
				disabled={!resolved}
			/>
		</KeyboardAvoidingScreen>
	);
}

const localStyles = StyleSheet.create({
	detailRow: {
		flexDirection: "row",
		marginBottom: 8,
	},
	permissionsText: {
		flex: 1,
		flexWrap: "wrap",
	},
	orText: {
		textAlign: "center",
		marginVertical: 8,
	},
	scopesSection: {
		marginTop: 16,
	},
	scopesTitle: {
		marginBottom: 8,
	},
	scopeItem: {
		flexDirection: "row",
		marginBottom: 4,
	},
	bullet: {
		marginRight: 8,
	},
	scopeDescription: {
		flex: 1,
	},
});

const styles = { ...globalStyles, ...localStyles };
