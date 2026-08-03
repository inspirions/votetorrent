import React, { useState } from "react";
import { StyleSheet, View } from "react-native";
import FontAwesome6 from "react-native-vector-icons/FontAwesome6";
import { ExtendedTheme, useTheme } from "@react-navigation/native";
import { useTranslation } from "react-i18next";
import type { ElectionRegistrationField, RegistrantTier, FieldRequirement } from "@votetorrent/vote-core";
import { ThemedText } from "../../../components/ThemedText";
import { ChipButton } from "../../../components/ChipButton";
import { CustomTextInput } from "../../../components/CustomTextInput";
import { globalStyles } from "../../../theme/styles";

/**
 * RegistrationFieldsSection — the ElectionRegistrationField editor for the
 * Registration Policy screen (D-02), with immediate per-row apply (D-14) and a
 * canWrite affordance gate (D-10).
 *
 * Purely presentational: receives data + callbacks as props. No engine calls,
 * no signing, no schema access — the owning screen is responsible for reads,
 * writes and device-side signing.
 */

/** The fixed, lowercase RegistrantPublic column names — everything else is an Extra Field (D-02/D-18). */
export const PUBLIC_FIXED_FIELD_NAMES = ["lastname", "firstname", "district"] as const;

/**
 * Case-insensitive check for whether a fieldName is a custom (ExtraFields-json-stored)
 * entry rather than a fixed RegistrantPublic column. This is the single source of the
 * "Extra Field" badge decision (D-02/D-18).
 */
export function isExtraField(fieldName: string): boolean {
	return !(PUBLIC_FIXED_FIELD_NAMES as readonly string[]).includes(fieldName.toLowerCase());
}

const TIERS: RegistrantTier[] = ["public", "selective", "private"];
const REQUIREMENTS: FieldRequirement[] = ["required", "optional"];

const TIER_LABEL_KEYS: Record<RegistrantTier, string> = {
	public: "registrationPolicyTierPublic",
	selective: "registrationPolicyTierSelective",
	private: "registrationPolicyTierPrivate",
};

const REQUIREMENT_LABEL_KEYS: Record<FieldRequirement, string> = {
	required: "registrationPolicyRequirementRequired",
	optional: "registrationPolicyRequirementOptional",
};

type RowStatus = "idle" | "saving" | "saved" | "error";

export interface RegistrationFieldsSectionProps {
	fields: ElectionRegistrationField[];
	canWrite: boolean;
	onAddField: (fieldName: string, tier: RegistrantTier, requirement: FieldRequirement) => Promise<void>;
	onChangeField: (fieldName: string, tier: RegistrantTier, requirement: FieldRequirement) => Promise<void>;
	onRemoveField: (fieldName: string) => Promise<void>;
}

export function RegistrationFieldsSection({
	fields,
	canWrite,
	onAddField,
	onChangeField,
	onRemoveField,
}: RegistrationFieldsSectionProps) {
	const { colors } = useTheme() as ExtendedTheme;
	const { t } = useTranslation();

	const [showCustomInput, setShowCustomInput] = useState(false);
	const [customName, setCustomName] = useState("");

	// D-14 per-row write state. Keyed by fieldName (a pending add uses the name
	// being added as its key, so one map covers adds, changes and removes).
	const [rowStatus, setRowStatus] = useState<Record<string, RowStatus>>({});
	const [retryHandlers, setRetryHandlers] = useState<Record<string, () => void>>({});

	async function runWrite(fieldName: string, op: () => Promise<void>) {
		setRowStatus(prev => ({ ...prev, [fieldName]: "saving" }));
		try {
			await op();
			setRowStatus(prev => ({ ...prev, [fieldName]: "saved" }));
		} catch {
			setRowStatus(prev => ({ ...prev, [fieldName]: "error" }));
			setRetryHandlers(prev => ({ ...prev, [fieldName]: () => runWrite(fieldName, op) }));
		}
	}

	function isDuplicate(fieldName: string): boolean {
		return fields.some(f => f.fieldName.toLowerCase() === fieldName.toLowerCase());
	}

	function handleAdd(fieldName: string) {
		const trimmed = fieldName.trim();
		if (!trimmed || isDuplicate(trimmed)) return;
		runWrite(trimmed, () => onAddField(trimmed, "public", "required"));
	}

	function handleCommitCustom() {
		const trimmed = customName.trim();
		if (!trimmed || isDuplicate(trimmed)) return;
		handleAdd(trimmed);
		setCustomName("");
		setShowCustomInput(false);
	}

	function handleTierChange(field: ElectionRegistrationField, nextTier: RegistrantTier) {
		if (nextTier === field.tier) return;
		runWrite(field.fieldName, () => onChangeField(field.fieldName, nextTier, field.requirement));
	}

	function handleRequirementChange(field: ElectionRegistrationField, nextRequirement: FieldRequirement) {
		if (nextRequirement === field.requirement) return;
		runWrite(field.fieldName, () => onChangeField(field.fieldName, field.tier, nextRequirement));
	}

	function handleRemove(field: ElectionRegistrationField) {
		runWrite(field.fieldName, () => onRemoveField(field.fieldName));
	}

	function handleRetry(fieldName: string) {
		const retry = retryHandlers[fieldName];
		if (retry) retry();
	}

	/**
	 * D-10 canWrite gate. ChipButton has no `disabled` prop, so every write
	 * control is wrapped in a pointerEvents-gated View and its onPress is
	 * conditionally undefined. This is a UI affordance for legibility, NOT a
	 * security boundary — the DB-side 'mel' AdminSignature CHECK on
	 * ElectionRegistrationField (MutationValid/DeleteValid) is the real
	 * control (T-46-03, D-10). Controls stay visible/rendered when disabled;
	 * only interaction is blocked.
	 */
	function writeWrap(testID: string, onPress: (() => void) | undefined, child: React.ReactNode) {
		return (
			<View
				key={testID}
				testID={testID}
				pointerEvents={canWrite ? "auto" : "none"}
				style={canWrite ? undefined : styles.disabledControl}
			>
				{React.isValidElement(child)
					? React.cloneElement(child as React.ReactElement<{ onPress?: () => void }>, {
							onPress: canWrite ? onPress : undefined,
						})
					: child}
			</View>
		);
	}

	return (
		<View testID="registration-fields-section" style={styles.section}>
			{/* Row 1: Last Name / First Name — the only two always-known chips. */}
			<View testID="registration-field-picker-known" style={localStyles.chipRow}>
				{writeWrap(
					"registration-field-picker-lastname",
					() => handleAdd("LastName"),
					<ChipButton label={t("registrationPolicyKnownFieldLastName")} />,
				)}
				{writeWrap(
					"registration-field-picker-firstname",
					() => handleAdd("FirstName"),
					<ChipButton label={t("registrationPolicyKnownFieldFirstName")} />,
				)}
			</View>

			<View testID="registration-field-picker-divider" style={[localStyles.divider, { backgroundColor: colors.border }]} />

			{/* Row 2: District — its own group, visually separated (D-02). */}
			<View testID="registration-field-picker-district" style={localStyles.districtGroup}>
				{writeWrap(
					"registration-field-picker-district-chip",
					() => handleAdd("District"),
					<ChipButton label={t("registrationPolicyDistrictFieldLabel")} />,
				)}
				<View testID="registration-field-district-hint">
					<ThemedText type="small" style={{ color: colors.textSecondary }}>
						{t("registrationPolicyDistrictFieldHint")}
					</ThemedText>
				</View>
			</View>

			{/* Row 3: Custom entry. */}
			<View testID="registration-field-picker-custom" style={localStyles.customGroup}>
				{writeWrap(
					"registration-field-picker-custom-chip",
					() => setShowCustomInput(prev => !prev),
					<ChipButton label={t("registrationPolicyCustomFieldOption")} />,
				)}
				{showCustomInput && (
					<CustomTextInput
						testID="registration-field-custom-input"
						value={customName}
						onChangeText={setCustomName}
						placeholder={t("registrationPolicyCustomFieldPlaceholder")}
						icon="check"
						onIconPress={canWrite ? handleCommitCustom : undefined}
						onSubmitEditing={canWrite ? handleCommitCustom : undefined}
						editable={canWrite}
					/>
				)}
			</View>

			{/* Field rows. */}
			{fields.length === 0 ? (
				<View testID="registration-fields-empty">
					<ThemedText type="defaultSemiBold">{t("registrationPolicyNoFieldsHeading")}</ThemedText>
					<ThemedText type="small" style={{ color: colors.textSecondary }}>
						{t("registrationPolicyNoFieldsBody")}
					</ThemedText>
				</View>
			) : (
				fields.map(field => {
					const status: RowStatus = rowStatus[field.fieldName] ?? "idle";
					const extra = isExtraField(field.fieldName);
					return (
						<View testID={`registration-field-row-${field.fieldName}`} key={field.fieldName} style={localStyles.fieldRow}>
							<View style={localStyles.fieldNameRow}>
								<ThemedText type="defaultSemiBold">{field.fieldName}</ThemedText>
								{status === "saved" && (
									<FontAwesome6 name="check" size={14} color={colors.success} />
								)}
							</View>

							{extra && (
								<>
									<View
										testID={`registration-field-extra-badge-${field.fieldName}`}
										style={[localStyles.extraBadge, { backgroundColor: colors.accent }]}
									>
										<ThemedText type="smallBold">{t("registrationPolicyExtraFieldBadge")}</ThemedText>
									</View>
									<View testID={`registration-field-extra-hint-${field.fieldName}`}>
										<ThemedText type="small" style={{ color: colors.textSecondary }}>
											{t("registrationPolicyExtraFieldHint")}
										</ThemedText>
									</View>
								</>
							)}

							<View testID={`registration-field-status-${field.fieldName}`}>
								{status === "saving" ? (
									<ThemedText type="small" style={{ color: colors.textSecondary }}>
										{t("registrationPolicyRowSaving")}
									</ThemedText>
								) : (
									<>
										{/* Tier chip group. */}
										<View style={localStyles.chipRow}>
											<ThemedText type="small">{t("registrationPolicyTierLabel")}</ThemedText>
											{TIERS.map(tier =>
												writeWrap(
													`registration-field-tier-${field.fieldName}-${tier}`,
													() => handleTierChange(field, tier),
													<ChipButton label={t(TIER_LABEL_KEYS[tier])} />,
												),
											)}
										</View>

										{/* Requirement chip group. */}
										<View style={localStyles.chipRow}>
											{REQUIREMENTS.map(requirement =>
												writeWrap(
													`registration-field-requirement-${field.fieldName}-${requirement}`,
													() => handleRequirementChange(field, requirement),
													<ChipButton label={t(REQUIREMENT_LABEL_KEYS[requirement])} />,
												),
											)}
										</View>

										{/* Remove control. */}
										{writeWrap(
											`registration-field-remove-${field.fieldName}`,
											() => handleRemove(field),
											<ChipButton label={t("registrationPolicyRemoveButton")} />,
										)}
									</>
								)}

								{status === "error" && (
									<>
										<ThemedText type="small" style={{ color: colors.error }}>
											{t("registrationPolicyRowError")}
										</ThemedText>
										<View testID={`registration-field-retry-${field.fieldName}`}>
											<ChipButton
												label={t("registrationPolicyRetryButton")}
												onPress={() => handleRetry(field.fieldName)}
											/>
										</View>
									</>
								)}
							</View>
						</View>
					);
				})
			)}
		</View>
	);
}

const localStyles = StyleSheet.create({
	chipRow: {
		flexDirection: "row",
		alignItems: "center",
		gap: 8,
		flexWrap: "wrap",
	},
	divider: {
		height: 1,
		marginVertical: 8,
	},
	districtGroup: {
		gap: 4,
		marginBottom: 8,
	},
	customGroup: {
		gap: 4,
		marginBottom: 8,
	},
	fieldRow: {
		gap: 4,
		marginTop: 8,
	},
	fieldNameRow: {
		flexDirection: "row",
		alignItems: "center",
		gap: 8,
	},
	extraBadge: {
		paddingHorizontal: 8,
		paddingVertical: 2,
		borderRadius: 10,
		alignSelf: "flex-start",
	},
	disabledControl: {
		opacity: 0.5,
	},
});

const styles = { ...globalStyles, ...localStyles };
