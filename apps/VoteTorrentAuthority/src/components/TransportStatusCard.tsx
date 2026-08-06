import React from "react";
import { StyleSheet, View } from "react-native";
import FontAwesome6 from "react-native-vector-icons/FontAwesome6";
import { useTranslation } from "react-i18next";
import { ExtendedTheme, useTheme } from "@react-navigation/native";
import { ThemedText } from "./ThemedText";
import { CustomButton } from "./CustomButton";
import { globalStyles } from "../theme/styles";

/**
 * TransportStatusCard — the Bulk Import / Sync screen's per-binding status card (D-01/D-11).
 *
 * This file exports two structurally different components:
 *
 * (a) `TransportStatusCard` — filesystem and REST. These are the two *provable* D-01 bindings:
 *     real transports whose sync outcome is a fact this app can observe and report. Their cards
 *     are state-driven — icon, color and copy all resolve from the reported `syncState`.
 *
 * (b) `ExperimentalTransportStatusCard` — peer-to-peer. This card is categorically different.
 *     The peer-cluster transport ships **code-complete, unverified** (D-11): P2P-11 is
 *     device-REFUTED, its wall has moved repeatedly, and this project has a documented history of
 *     "implemented but unproven" being read as "done" (Phase 45 closed with four such legs, Phase
 *     41's Node gate was device-REFUTED). So the warning treatment here is not a *state* the card
 *     enters — it is a *property* of the component. A successful peer sync does not license
 *     success styling because **connectivity in a given session is not verification**: a socket
 *     opening and bytes moving proves nothing about the correctness or safety of the underlying
 *     protocol, only that a session happened to connect this time.
 *
 *     That reasoning must be foreclosed *in the file*, not merely stated in a planning document,
 *     so the severance is structural: `ExperimentalTransportStatusCard` accepts **no** sync-state
 *     input of any kind. There is no prop through which a connection or sync result could reach
 *     this component's presentation, so a caller cannot make it look successful even by accident,
 *     and a state-driven treatment is not merely discouraged here — it is unwritable without first
 *     changing this component's prop type. Anyone who adds a state prop to
 *     `ExperimentalTransportStatusCard` is deleting the D-11 guarantee and must say so out loud.
 *
 * `disabled` on either card is a legibility/convenience control only, mirroring Phase 46's
 * `useCurrentOfficerScopes()` class of gate — it is **not** a security boundary.
 * `AdminSigning.SignerKeyValid` and `OfficerSignature.OfficerValid` are stub CHECKs (tracked under
 * Phase 999.1), so write controls here render **disabled, not hidden**, and no claim is made
 * anywhere in this file that the `'vrg'` scope gate is enforcement.
 */

/** A local view-model type — deliberately not imported from the engine seam, so this card can
 * render with no transport binding attached. */
export type TransportSyncState = "never" | "success" | "error";

/** `'p2p'` is deliberately absent from this union: passing the peer-to-peer binding through the
 * state-driven `TransportStatusCard` is a type error, not merely a style choice, because there is
 * no `TransportKind` value that would let it compile. */
export type TransportKind = "filesystem" | "rest";

/**
 * Per-state icon + color-role lookup for the filesystem/REST cards, in the
 * `{ state: { … } }[currentState]` shape copied from `SyncChip.tsx:31-35`.
 *
 * Every icon named here is verified present in the FontAwesome6 **Free** solid glyphmap
 * (`node_modules/react-native-vector-icons/glyphmaps/FontAwesome6Free_meta.json`). `SyncChip.tsx`
 * documents a live trap: `wifi-slash` is Pro-only and renders as a tofu glyph. Any future
 * addition to this table must be checked against that glyphmap the same way.
 *
 * `colorRole` is an indirection rather than a raw theme color so this stays a module-level
 * constant instead of being rebuilt from `useTheme()` on every render — the role is mapped to a
 * concrete color at the render site (`success -> colors.success`, `error -> colors.error`,
 * `muted -> colors.textSecondary`), feeding one const to both the icon and any state tint so they
 * can never disagree (the `statusColor` discipline from
 * `AttestationProvisioningStatusScreen.tsx:105`).
 */
export const TRANSPORT_STATE_ICONS: Record<
	TransportSyncState,
	{ icon: string; colorRole: "success" | "error" | "muted" }
> = {
	never: { icon: 'circle-question', colorRole: 'muted' },
	success: { icon: 'circle-check', colorRole: 'success' },
	error: { icon: 'circle-xmark', colorRole: 'error' },
};

/**
 * The ONE discriminant producing `testIDBase` + `headingKey` + `bodyKey` together (the
 * `provisioningCopy` discipline from `AttestationProvisioningStatusScreen.tsx:74-91`), so a
 * wrong-state heading can never render above a wrong-state body, and a future state addition adds
 * a branch here and nowhere else.
 *
 * The success/error distinction is carried by the icon (`TRANSPORT_STATE_ICONS`) and the counts
 * line, not by a second body key: the UI-SPEC's copy table defines no error-specific body string,
 * and inventing one here would fork the copy contract away from the keys 48-03 owns.
 */
export function transportCopy(
	kind: TransportKind,
	syncState: TransportSyncState,
): { testIDBase: string; headingKey: string; bodyKey: string } {
	const headingKey =
		kind === "filesystem" ? "bulkImportSyncFilesystemHeading" : "bulkImportSyncRestHeading";
	const bodyKey =
		syncState === "never" ? "bulkImportSyncNeverSyncedBody" : "bulkImportSyncLastSyncedLabel";
	return {
		testIDBase: `transport-status-${kind}-${syncState}`,
		headingKey,
		bodyKey,
	};
}

/** Belt-and-suspenders no-op, matching the discipline at
 * `RegistrantDetailScreen.tsx:89` — `disabled` already gates the button visually and via
 * `CustomButton`'s native `disabled` prop; this ensures a stray `onPress` can never fire the
 * caller's handler while disabled. */
const NOOP = () => {};

interface TransportStatusCardProps {
	kind: TransportKind;
	syncState: TransportSyncState;
	lastSyncedAt?: string;
	importedCount?: number;
	pendingCount?: number;
	errorCount?: number;
	/** Legibility/convenience control only — mirrors Phase 46's `useCurrentOfficerScopes()` class
	 * of gate. NOT a security boundary (see file doc comment). */
	disabled?: boolean;
	onSyncNow: () => void;
}

export function TransportStatusCard({
	kind,
	syncState,
	lastSyncedAt,
	importedCount,
	pendingCount,
	errorCount,
	disabled = false,
	onSyncNow,
}: TransportStatusCardProps) {
	const { colors } = useTheme() as ExtendedTheme;
	const { t } = useTranslation();

	const copy = transportCopy(kind, syncState);
	const { icon, colorRole } = TRANSPORT_STATE_ICONS[syncState];
	// One const feeds both the icon and any state tint so they can never disagree — the
	// `statusColor` discipline from AttestationProvisioningStatusScreen.tsx:105.
	const statusColor =
		colorRole === "success" ? colors.success : colorRole === "error" ? colors.error : colors.textSecondary;

	const countSegments: string[] = [];
	if (importedCount !== undefined) {
		countSegments.push(t("bulkImportSyncImportedCountLabel", { count: importedCount }));
	}
	if (pendingCount !== undefined) {
		countSegments.push(t("bulkImportSyncPendingCountLabel", { count: pendingCount }));
	}
	if (errorCount !== undefined) {
		countSegments.push(t("bulkImportSyncErrorCountLabel", { count: errorCount }));
	}

	return (
		// No left border strip — its absence is the normal-case signal here, and is exactly what
		// makes the peer card's warning border read as a deviation rather than mere decoration.
		<View
			testID={`transport-status-card-${kind}`}
			style={[styles.cardSurface, { backgroundColor: colors.card }]}
		>
			<View style={localStyles.headingRow}>
				<View testID={`transport-status-icon-${kind}`}>
					<FontAwesome6 name={icon} size={16} color={statusColor} />
				</View>
				<ThemedText type="defaultSemiBold" testID={`${copy.testIDBase}-heading`}>
					{t(copy.headingKey)}
				</ThemedText>
			</View>

			{/* The interpolation object is passed unconditionally; the `never` body ignores it. */}
			<ThemedText type="default" style={localStyles.bodyText} testID={`${copy.testIDBase}-body`}>
				{t(copy.bodyKey, { date: lastSyncedAt })}
			</ThemedText>

			{countSegments.length > 0 && (
				<ThemedText
					type="small"
					style={[localStyles.countsText, { color: colors.textSecondary }]}
					testID={`transport-status-counts-${kind}`}
				>
					{countSegments.join(" · ")}
				</ThemedText>
			)}

			<View testID={`transport-sync-now-${kind}`} style={localStyles.footer}>
				<CustomButton
					title={t("bulkImportSyncNowButton")}
					backgroundColor={colors.accent}
					size="thin"
					disabled={disabled}
					onPress={disabled ? NOOP : onSyncNow}
				/>
			</View>
		</View>
	);
}

/**
 * The structural severance (T-48-17-01/02, the central risk this plan mitigates): exactly two
 * props, neither of which is a sync-state signal. There is no `syncState`, no `lastSyncedAt`, no
 * counts, no `connected`, no `peerCount`, no `kind` — no input through which a connection or sync
 * result could reach this component's presentation. This omission IS the enforcement mechanism.
 * Anyone adding a state prop here is deleting the D-11 guarantee and must say so out loud.
 */
interface ExperimentalTransportStatusCardProps {
	/** Legibility/convenience control only — NOT a security boundary (see file doc comment). */
	disabled?: boolean;
	onTrySync: () => void;
}

export function ExperimentalTransportStatusCard({
	disabled = false,
	onTrySync,
}: ExperimentalTransportStatusCardProps) {
	const { colors } = useTheme() as ExtendedTheme;
	const { t } = useTranslation();

	return (
		<View
			testID="transport-status-card-p2p"
			style={[
				styles.cardSurface,
				// The 4px warning left border is hardcoded, never computed from any input. 48-14's
				// "warning left border reserved exclusively for bridge provenance" reservation is
				// scoped to RegistrationRequestRow in the inbox list; on THIS screen the 4px warning
				// border is the established callout treatment already shared by
				// AttestationProvisioningStatusScreen and PriorRejectionsCallout.
				{ backgroundColor: colors.card, borderLeftWidth: 4, borderLeftColor: colors.warning },
			]}
		>
			<View style={localStyles.headingRow}>
				<View testID="transport-status-icon-p2p">
					<FontAwesome6 name={'flask-vial'} size={16} color={colors.warning} />
				</View>
				<ThemedText type="defaultSemiBold" testID="transport-status-p2p-heading">
					{t("bulkImportSyncP2pHeading")}
				</ThemedText>
			</View>

			{/* Unconditional — no surrounding conditional of any kind. This is not an error state and
			    cannot be dismissed by a successful sync (D-11). */}
			<ThemedText type="default" style={localStyles.bodyText} testID="transport-status-p2p-body">
				{t("bulkImportSyncP2pBody")}
			</ThemedText>

			<View testID="transport-try-peer-sync-p2p" style={localStyles.footer}>
				{/* The accent role is forbidden here so this control can never read as an
				    equally-trusted third option beside the two proven bindings' Sync Now buttons. */}
				<CustomButton
					title={t("bulkImportSyncP2pTryButton")}
					backgroundColor={colors.warning}
					forceDarkText
					size="thin"
					disabled={disabled}
					onPress={disabled ? NOOP : onTrySync}
				/>
			</View>
		</View>
	);
}

const localStyles = StyleSheet.create({
	headingRow: {
		flexDirection: "row",
		alignItems: "center",
		gap: 8,
	},
	bodyText: {
		marginTop: 8,
	},
	countsText: {
		marginTop: 8,
	},
	footer: {
		marginTop: 12,
	},
});

const styles = { ...globalStyles, ...localStyles };
