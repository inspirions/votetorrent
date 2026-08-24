import { ExtendedTheme, useTheme } from "@react-navigation/native";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import React, { useState, useRef } from "react";
import { useTranslation } from "react-i18next";
import { ScrollView, StyleSheet, TouchableOpacity, View, Image } from "react-native";
import { ThemedText } from "../../components/ThemedText";
import FontAwesome6 from "react-native-vector-icons/FontAwesome6";
import { ChipButton } from "../../components/ChipButton";
import { CustomButton } from "../../components/CustomButton";
import { Footer } from "../../components/Footer";
import { KeyboardAvoidingScreen } from "../../components/KeyboardAvoidingScreen";
import { globalStyles } from "../../theme/styles";
import { CustomTextInput } from "../../components/CustomTextInput";
import { useApp } from "../../providers/AppProvider";
import { getOrCreateDeviceUser } from "../../engines/device-user";
import type { IDefaultUserEngine, INetworksEngine, NetworkInit, NetworkReference } from "@votetorrent/vote-core";
import { ElectionType } from "@votetorrent/vote-core";
import type { RootStackParamList } from "../../navigation/types";
import { InlineError } from "../../components/InlineError";
import { FOUNDING_OFFICER_SCOPES } from "../../utils/foundingOfficerScopes";
import { useDeviceSigningErrorHandler } from "../../hooks/useDeviceSigningErrorHandler";
import { useRecoveryKeyRegistrationGate } from "../../hooks/useRecoveryKeyRegistrationGate";

export default function AddNetworkScreen() {
	const { colors } = useTheme() as ExtendedTheme;
	const { t } = useTranslation();
	const { getEngine, networksEngine, selectNetwork } = useApp();
	const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
	const handleDeviceSigningError = useDeviceSigningErrorHandler();
	const promptRecoveryKeyRegistrationIfNeeded = useRecoveryKeyRegistrationGate();
	const [networkName, setNetworkName] = useState("");
	const [networkImageUrl, setNetworkImageUrl] = useState("");
	const [authorityName, setAuthorityName] = useState("");
	const [authorityImageUrl, setAuthorityImageUrl] = useState("");
	const [domainName, setDomainName] = useState("");
	const [adminName, setAdminName] = useState("");
	const [adminTitle, setAdminTitle] = useState("");
	const [isSigned, setIsSigned] = useState(false);
	const [showAdvanced, setShowAdvanced] = useState(false);
	const [relayAddresses, setRelayAddresses] = useState([""]);
	// Election Characteristics (Figma "New Network" frame) — keyholder usage and
	// single-vs-multiple authority.
	const [useKeyholders, setUseKeyholders] = useState(true);
	// CR-01: single-vs-multiple authority is not yet representable in NetworkInit;
	// the network is always created single-authority, so no toggle state is kept.
	// 16-08 item 4: surface the ACTUAL submit failure inline (not just console.error).
	const [errorMessage, setErrorMessage] = useState<string>("");
	// network-create-release-hang: track the in-flight create so the CREATE button shows
	// progress + is disabled during the (potentially slow / device-stalling) commit. Without
	// this the screen looks frozen for the whole `builder.commit()` await — indistinguishable
	// from a hang.
	const [creating, setCreating] = useState(false);
	const scrollViewRef = useRef<ScrollView>(null);

	const toggleAdvanced = () => {
		if (!showAdvanced) {
			setTimeout(() => {
				scrollViewRef.current?.scrollToEnd({ animated: true });
			}, 100);
		}
		setShowAdvanced(!showAdvanced);
	};

	const addRelayField = () => {
		setRelayAddresses([...relayAddresses, ""]);
	};

	const updateRelayAddress = (index: number, value: string) => {
		const newAddresses = [...relayAddresses];
		newAddresses[index] = value;
		setRelayAddresses(newAddresses);
	};

	const removeRelayField = (index: number) => {
		if (relayAddresses.length > 1) {
			const newAddresses = relayAddresses.filter((_, i) => i !== index);
			setRelayAddresses(newAddresses);
		}
	};

	const handleMakePermanent = () => {
		// Phase 22: media-pin to content-addressed storage (CID) — not yet implemented.
	};

	// network-create-release-hang: on real devices `builder.commit()` (strand/cadre/libp2p
	// network creation) can stall indefinitely with no error, leaving the screen frozen.
	// Race every create step against a timeout so an indefinite hang surfaces an actionable
	// inline error instead of an infinite silent spinner. The underlying promise can't be
	// cancelled, but the UI recovers and the user can retry.
	const CREATE_TIMEOUT_MS = 45000;
	const withTimeout = <T,>(p: Promise<T>, label: string): Promise<T> => {
		return Promise.race([
			p,
			new Promise<T>((_resolve, reject) =>
				setTimeout(
					() => reject(new Error(t("networkCreateTimeout", { step: label }))),
					CREATE_TIMEOUT_MS,
				),
			),
		]);
	};

	const handleCreate = async () => {
		// 16-08 item 4: clear any prior error so a retry starts clean.
		setErrorMessage("");
		// CR-01: the "Sign" affordance gates creation of a signed permanent record.
		// Do not create the network unless the administrator has signed.
		if (!isSigned) {
			setErrorMessage(t("mustSignBeforeCreating"));
			return;
		}
		setCreating(true);
		try {
			// Resolve NetworksEngine — available directly from AppProvider context (D-03).
			if (!networksEngine) {
				console.error("handleCreate: networksEngine not yet initialized");
				setErrorMessage("Networks engine not yet initialized — please wait and try again.");
				return;
			}
			const networksEng = networksEngine as INetworksEngine;

			// Resolve device identity (D-02 / generate-on-first-run).
			const defaultUserEng = await getEngine<IDefaultUserEngine>("defaultUser");
			const defaultUser = await defaultUserEng.get();
			const user = await getOrCreateDeviceUser(defaultUser?.name ?? "Device User");

			// Assemble NetworkInit from the 11 form-state fields (D-03).
			// ThresholdPolicy uses `policy` field (not `scope`) per vote-core interface.
			const networkInit: NetworkInit = {
				name: networkName,
				imageUrl: networkImageUrl || undefined,
				relays: relayAddresses.filter(Boolean),
				primaryAuthority: {
					name: authorityName,
					domainName: domainName,
				},
				admin: {
					officers: [
						{
							init: {
								name: adminName,
								title: adminTitle,
								scopes: [...FOUNDING_OFFICER_SCOPES],
							},
						},
					],
					effectiveAt: Date.now(),
					thresholdPolicies: [
						{ policy: "rn", threshold: 1 },
						{ policy: "mel", threshold: 1 },
						{ policy: "ceb", threshold: 1 },
					],
				},
				policies: {
					timestampAuthorities: [],
					numberRequiredTSAs: 0,
					electionType: useKeyholders ? ElectionType.official : ElectionType.adhoc,
				},
			};

			// Route through v1.1 NetworksCreateBuilder (D-03).
			// INetworksCreateBuilder.update() is the typed API for setting both fields
			// (setNetworkInit/setUser are on the concrete class, not the interface).
			const builder = networksEng.buildCreate().update({ networkInit, user });
			if (!builder.isValid()) {
				console.error("handleCreate: validation errors", builder.errors());
				const relayMissing = builder.errors().some((e) => e.path === "networkInit.relays");
				setErrorMessage(
					// network-create-release-hang: replace the raw "networkInit.relays must not be
					// empty" engine string with discoverable guidance (the relay field lives under
					// Advanced → ADD RELAY). Other validation errors fall through unchanged.
					relayMissing
						? t("errRelayRequired")
						: builder.errors().map((e) => e.message).join("\n") || t("validationFailed"),
				);
				if (relayMissing) setShowAdvanced(true);
				return;
			}
			// network-create-release-hang: instrument each create step so on-device logcat
			// pinpoints where a real-device hang occurs (console.info is allowed by the VER-01
			// stub guard). Race against a timeout so an indefinite stall surfaces an error.
			console.info("[network-create] commit() start", { network: networkName });
			const networkEngine = await withTimeout(builder.commit(), "commit");
			console.info("[network-create] commit() done");

			// Pitfall 4: re-establish currentNetworkHash in the factory by calling
			// getEngine("network", ref) with the full NetworkReference that the concrete
			// NetworkEngine exposes via its `init` property. INetworkEngine does not
			// declare `init` in the interface, so we access it via a cast.
			// This allows sibling engines (elections, signing, etc.) to resolve the
			// established ctx immediately after create without a separate open().
			const networkRef = (networkEngine as unknown as { init: NetworkReference }).init;
			// Auto-select the just-created network: bind it AND flip hasNetwork so the
			// app lands on the populated network home instead of "No network selected".
			// (selectNetwork re-establishes currentNetworkHash like the old getEngine call,
			// plus sets hasNetwork — Pitfall 4 still satisfied via its internal getEngine.)
			console.info("[network-create] selectNetwork() start");
			await withTimeout(selectNetwork(networkRef), "select");
			console.info("[network-create] selectNetwork() done");

			// 49-19 (recovery-key-registration gap): networks-engine.create() registers ONLY the
			// founding signing key -- its bootstrap branch writes user.activeKeys[0] and has no
			// analog for a second key -- so the officer's recovery key is still unregistered the
			// moment this network comes up. Registration lives in ProvisionSigningKeyScreen's
			// stage 2, which needs a resolvable network User and therefore CANNOT run before this
			// point; until now nothing brought the officer back to it, leaving them one biometric
			// enrolment away from a stranded device (addKey needs a valid signing key, and only
			// the recovery key can replace an invalidated one -- a closed loop whose only recorded
			// escape was a destructive `pm clear`). Measured unregistered on BOTH fleet devices.
			//
			// The ceremony is idempotent and reconciling (it registers only what is missing), so
			// routing into it here is safe; the gate keeps us from showing it when there is
			// nothing to do. Deliberately AFTER selectNetwork: the network is fully established
			// and stays selected, so declining leaves a usable network rather than a dead end.
			//
			// The `return` is load-bearing, and is why this mirrors NetworkDetailsScreen's join
			// path rather than calling the gate for its side effect: the `navigation.goBack()`
			// at the end of this function is UNCONDITIONAL, so without it the ceremony screen the
			// gate just pushed is popped straight back off and the officer lands on Add Network
			// again -- the gate's whole point undone one statement later. Measured on real
			// hardware (Pixel 7 Pro, 2026-08-24): the gate logged `needed: true` and navigated,
			// and the device still sat on Add Network. `finally` still runs on this path, so the
			// in-flight flag is cleared exactly as it is on every other exit.
			if (await promptRecoveryKeyRegistrationIfNeeded()) return;
		} catch (err) {
			console.error("handleCreate error:", err);
			// 49-16 (Gap A): this screen never invokes the per-use device-signing factory
			// (device-signer.ts's exported creator) and is therefore outside the 20-file rollout
			// inventory — but getOrCreateDeviceUser above is the exact second-half-of-the-
			// onboarding-cycle site that produced the dead end 49-13 reproduced four times on
			// device. Route its NO_KEY_PROVISIONED rejection through the same shared hook every
			// migrated call site uses, rather than re-deriving the mapping here, so the officer
			// lands on the provisioning screen instead of a raw error string. Any other failure
			// (validation, commit, network) is "not mine" to the hook and falls through to this
			// screen's own raw-message handling unchanged.
			const outcome = handleDeviceSigningError(err);
			if (outcome.handled) return;
			setErrorMessage(outcome.message ?? (err instanceof Error ? err.message : String(err)));
			return;
		} finally {
			// Always clear the in-flight flag so the button re-enables on error/timeout
			// (on success the screen unmounts via goBack, so this is a harmless no-op).
			setCreating(false);
		}
		navigation.goBack();
	};

	return (
		<KeyboardAvoidingScreen>
			<ScrollView ref={scrollViewRef} style={styles.container}>
				<ThemedText type="defaultSemiBold" style={styles.sectionTitle}>
					{t("createNewNetwork")}
				</ThemedText>

				<View style={styles.section}>
					<CustomTextInput title={t("name")} value={networkName} onChangeText={setNetworkName} />
					<CustomTextInput
						title={t("imageUrl")}
						value={networkImageUrl}
						placeholder={t("optionalImageAddress")}
						onChangeText={setNetworkImageUrl}
						isImageUrlField={true}
						makePermanentPressed={handleMakePermanent}
					/>
					{networkImageUrl ? (
						<Image
							source={{ uri: networkImageUrl }}
							style={styles.previewImage}
							resizeMode="cover"
						/>
					) : null}
				</View>

				<View style={styles.section}>
					<ThemedText type="defaultSemiBold" style={styles.sectionTitle}>
						{t("electionCharacteristics")}
					</ThemedText>
					<View style={styles.characteristicsGrid}>
						<TouchableOpacity
							style={styles.radioOption}
							onPress={() => setUseKeyholders(true)}
						>
							<View style={[styles.radioOuter, { borderColor: useKeyholders ? colors.primary : colors.textSecondary }]}>
								{useKeyholders && <View style={[styles.radioInner, { backgroundColor: colors.primary }]} />}
							</View>
							<ThemedText style={styles.radioLabel}>{t("useKeyholders")}</ThemedText>
						</TouchableOpacity>
						<TouchableOpacity
							style={styles.radioOption}
							onPress={() => setUseKeyholders(false)}
						>
							<View style={[styles.radioOuter, { borderColor: !useKeyholders ? colors.primary : colors.textSecondary }]}>
								{!useKeyholders && <View style={[styles.radioInner, { backgroundColor: colors.primary }]} />}
							</View>
							<ThemedText style={styles.radioLabel}>{t("noKeyholders")}</ThemedText>
						</TouchableOpacity>
					</View>
					{/* CR-01: NetworkInit can only represent a single primary authority, so
					    the multi-authority option is disabled (rather than a live control
					    that silently drops the user's choice). Single authority is always used. */}
					<View style={styles.characteristicsGrid}>
						<View style={styles.radioOption}>
							<View style={[styles.radioOuter, { borderColor: colors.primary }]}>
								<View style={[styles.radioInner, { backgroundColor: colors.primary }]} />
							</View>
							<ThemedText style={styles.radioLabel}>{t("singleAuthority")}</ThemedText>
						</View>
						<View style={[styles.radioOption, { opacity: 0.4 }]}>
							<View style={[styles.radioOuter, { borderColor: colors.textSecondary }]} />
							<ThemedText style={styles.radioLabel}>{t("multipleAuthorityNotYetSupported")}</ThemedText>
						</View>
					</View>
				</View>

				<View style={styles.section}>
					<ThemedText type="title" style={styles.sectionTitle}>
						{t("primaryAuthority")}
					</ThemedText>
					<CustomTextInput
						title={t("name")}
						value={authorityName}
						onChangeText={setAuthorityName}
					/>
					<CustomTextInput
						title={t("imageUrl")}
						value={authorityImageUrl}
						placeholder={t("optionalImageAddress")}
						onChangeText={setAuthorityImageUrl}
						isImageUrlField={true}
						makePermanentPressed={handleMakePermanent}
					/>
					{authorityImageUrl ? (
						<Image
							source={{ uri: authorityImageUrl }}
							style={styles.previewImage}
							resizeMode="cover"
						/>
					) : null}
					<CustomTextInput
						title={t("domainName")}
						value={domainName}
						onChangeText={setDomainName}
					/>
				</View>

				<View style={styles.section}>
					<ThemedText type="title" style={styles.sectionTitle}>
						{t("initialAdministrator")}
					</ThemedText>
					<CustomTextInput
						title={t("name")}
						value={adminName}
						placeholder={t("yourNameOnPermanentRecord")}
						onChangeText={setAdminName}
					/>
					<CustomTextInput
						title={t("title")}
						value={adminTitle}
						placeholder={t("yourTitleOnPermanentRecord")}
						onChangeText={setAdminTitle}
					/>
					<CustomButton
						title={t("sign")}
						icon={isSigned ? "square-check" : "square"}
						backgroundColor={colors.important}
						forceDarkText={true}
						onPress={() => setIsSigned(!isSigned)}
					/>
				</View>

				<TouchableOpacity
					style={styles.advancedHeader}
					onPress={() => {
						toggleAdvanced();
					}}
				>
					<FontAwesome6
						name={showAdvanced ? "chevron-down" : "chevron-right"}
						size={14}
						color={colors.text}
					/>
					<ThemedText type="default">{t("advanced")}</ThemedText>
				</TouchableOpacity>
				{showAdvanced ? (
					<View style={styles.section}>
						<View style={[styles.buttonHeader, styles.sectionTitle]}>
							<ThemedText type="title">{t("relays")}</ThemedText>
							<ChipButton
								label={t("import")}
								icon="circle-plus"
								disabled={true}
								onPress={undefined}
							/>
						</View>
						{relayAddresses.map((address, index) => (
							<CustomTextInput
								key={index}
								placeholder={t("multiaddress")}
								value={address}
								onChangeText={(value) => updateRelayAddress(index, value)}
								icon={relayAddresses.length > 1 ? "circle-xmark" : undefined}
								onIconPress={() => removeRelayField(index)}
							/>
						))}
						<View style={styles.buttonHeader}>
							<View />
							<ChipButton label={t("addRelay")} icon="circle-plus" onPress={addRelayField} />
						</View>
					</View>
				) : null}
			</ScrollView>

			<InlineError message={errorMessage} />
			<Footer>
				<CustomButton
					title={creating ? t("creating") : t("create")}
					icon={creating ? "spinner" : "floppy-disk"}
					backgroundColor={colors.success}
					forceDarkText={true}
					disabled={creating}
					onPress={handleCreate}
				/>
			</Footer>
		</KeyboardAvoidingScreen>
	);
}

const localStyles = StyleSheet.create({
	fieldLabel: {
		marginBottom: 8,
	},
	input: {
		padding: 16,
		borderRadius: 32,
		fontSize: 16,
		borderWidth: 1,
		marginTop: 8,
	},
	buttonHeader: {
		flexDirection: "row",
		justifyContent: "space-between",
		alignItems: "center",
	},
	permanentSection: {
		flexDirection: "row",
		alignItems: "center",
		gap: 8,
	},
	previewImage: {
		marginTop: 8,
		height: 200,
		borderRadius: 16,
	},
	characteristicsGrid: {
		flexDirection: "row",
		marginTop: 12,
	},
	radioOption: {
		flexDirection: "row",
		alignItems: "center",
		flex: 1,
	},
	radioOuter: {
		width: 20,
		height: 20,
		borderRadius: 10,
		borderWidth: 2,
		alignItems: "center",
		justifyContent: "center",
		marginRight: 8,
	},
	radioInner: {
		width: 10,
		height: 10,
		borderRadius: 5,
	},
	radioLabel: {
		flex: 1,
	},
	signButton: {
		flexDirection: "row",
		alignItems: "center",
		gap: 8,
		marginTop: 16,
		padding: 16,
		borderRadius: 32,
		borderWidth: 1,
	},
	signText: {
		fontSize: 16,
		fontWeight: "600",
	},
	advancedHeader: {
		flexDirection: "row",
		alignItems: "center",
		gap: 16,
		marginBottom: 16,
	},
	relayFieldContainer: {
		flexDirection: "row",
		alignItems: "center",
		gap: 8,
		marginBottom: 8,
	},
	removeButtonContainer: {
		width: 40,
		alignItems: "center",
	},
	removeButton: {
		padding: 8,
	},
});

const styles = { ...globalStyles, ...localStyles };
