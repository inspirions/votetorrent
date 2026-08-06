import React, { useCallback, useEffect, useRef, useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { ExtendedTheme, useRoute, useTheme } from "@react-navigation/native";
import { useTranslation } from "react-i18next";
import { scopeDescriptions } from "@votetorrent/vote-core";
import { ThemedText } from "../../components/ThemedText";
import { InlineError } from "../../components/InlineError";
import {
	ExperimentalTransportStatusCard,
	TransportStatusCard,
} from "../../components/TransportStatusCard";
import { globalStyles } from "../../theme/styles";
import { useCurrentOfficerScopes } from "../../hooks/useCurrentOfficerScopes";
import {
	INERT_PEER_SYNC,
	resolveSyncBinding,
	resolveTransportCardState,
	toSyncErrorRefs,
	type SyncBindingId,
	type TransportCardEntry,
} from "./bulk-import-sync-model";

/**
 * BulkImportSyncScreen — the officer-facing surface for the D-01 transport bridges (D-01/D-11).
 *
 * Renders, in a FIXED order that is never reordered by any state:
 *   1. `InlineError`
 *   2. the scope-gate banner (only when ungated for `'vrg'`)
 *   3. Filesystem `TransportStatusCard` — first-listed, most-trusted binding
 *   4. REST `TransportStatusCard`
 *   5. the peer-to-peer card in its mandatory experimental treatment
 *      (`ExperimentalTransportStatusCard`) — never reordered above the two proven bindings
 *   6. the sync-errors section, identifier-only
 *
 * The Filesystem and REST cards call REAL bindings resolved through the seam
 * (`bulk-import-sync-model.ts`'s registry) — this screen imports no transport module itself, so it
 * cannot drag `node:fs` into the Metro bundle (48-09's bundling clause).
 *
 * THE PEER CARD HAS NO BINDING ATTACHED IN THIS PLAN and its action is inert by construction —
 * pressing it invokes `INERT_PEER_SYNC`, a no-op, and nothing else. 48-23 attaches a real peer
 * binding through this same seam, widening `SyncBindingId` to admit it out loud. Nothing in this
 * phase depends on 48-23: if it never lands, this screen still works and still tells the truth —
 * the peer-cluster leg ships **code-complete, unverified**, and this screen presents that honestly
 * rather than as a working third bridge.
 *
 * The errors section renders a transport heading and an item IDENTIFIER only — never a payload
 * value, a requester name, or a transport's error text (T-48-20-02).
 *
 * The `'vrg'` scope gate DISABLES write controls, it does not hide them, and it is a legibility
 * control only — `useCurrentOfficerScopes()`'s own file header says so verbatim. No claim anywhere
 * in this file that this gate is enforcement (Phase 999.1's pre-existing, out-of-scope gap).
 */

// Route params typed screen-locally, following `RegistrantsListScreen.tsx:26-35`'s own precedent
// in spirit: `RootStackParamList` does not carry a `BulkImportSync` key until 48-21 registers the
// three Phase-48 routes, so a screen-local param type is used here and 48-21 tightens it to
// `RouteProp<RootStackParamList, 'BulkImportSync'>`. This widening is a dated placeholder, not a
// permanent loosening. `authorityId` is a plain identifier used only for the scope lookup and
// reaches no crash payload.
interface BulkImportSyncRouteParams {
	authorityId: string;
}

export function BulkImportSyncScreen() {
	const { colors } = useTheme() as ExtendedTheme;
	const { t } = useTranslation();
	const { authorityId } = useRoute().params as BulkImportSyncRouteParams;

	const { scopes, loading } = useCurrentOfficerScopes(authorityId);
	// Legibility/convenience control only — NOT a security boundary. The real control is the
	// signed ceremony downstream (see `useCurrentOfficerScopes.ts`'s own file header).
	const canSync = !loading && scopes?.includes("vrg") === true;

	const [errorMessage, setErrorMessage] = useState("");
	const [filesystemEntry, setFilesystemEntry] = useState<TransportCardEntry>({});
	const [restEntry, setRestEntry] = useState<TransportCardEntry>({});

	// CR-02/WR-08-class guard against a stale setState: a `syncNow()` resolving after this screen
	// has been navigated away from must not `setState` on an unmounted screen
	// (`RegistrantsListScreen.tsx`'s convention).
	const unmountedRef = useRef(false);
	useEffect(() => {
		unmountedRef.current = false;
		return () => {
			unmountedRef.current = true;
		};
	}, []);

	const runSync = useCallback((id: SyncBindingId) => {
		const setEntry = id === "filesystem" ? setFilesystemEntry : setRestEntry;
		const binding = resolveSyncBinding(id);
		if (!binding) {
			// An unattached binding must not read as a successful or idle sync — it is honestly an
			// ERROR state, not a silent no-op. The card's existing copy plus its error icon carry
			// this with no new string (T-48-20-05).
			if (!unmountedRef.current) setEntry({ failed: true });
			return;
		}

		if (!unmountedRef.current) setErrorMessage("");

		binding
			.syncNow()
			.then((report) => {
				if (!unmountedRef.current) setEntry({ report });
			})
			.catch(() => {
				// The caught error's `message` is NEVER put into state, into `InlineError`, into a
				// `testID`, or into any log — a transport error message can echo an adversarial or
				// misconfigured endpoint's response body, exactly the leak vector 48-10 closed at
				// the binding (T-48-20-02). No screen-level message is set from this catch at all.
				if (!unmountedRef.current) {
					setEntry((prev) => ({ failed: true, report: prev.report }));
				}
			});
	}, []);

	const errorRefs = toSyncErrorRefs({
		filesystem: filesystemEntry.report,
		rest: restEntry.report,
	});

	return (
		<ScrollView style={styles.container} testID="bulk-import-sync-screen">
			<View style={styles.section} testID="bulk-import-sync-error">
				<InlineError message={errorMessage} />
			</View>

			{/* Two-branch scope-gate banner — a UI legibility affordance ONLY, never a security
			    boundary. Callers must NOT collapse the two branches: "not an officer here"
			    (scopes === undefined) and "an officer but lacking this permission" (a real,
			    'vrg'-less scope array) are different facts with different remedies. */}
			{!loading &&
				!canSync &&
				(scopes === undefined ? (
					<View testID="bulk-import-sync-scope-banner" style={styles.banner}>
						<ThemedText type="small" style={{ color: colors.textSecondary }}>
							{t("registrationRequestScopeReadOnlyNoOfficerBanner")}
						</ThemedText>
					</View>
				) : (
					<View testID="bulk-import-sync-scope-banner" style={styles.banner}>
						<ThemedText type="small" style={{ color: colors.textSecondary }}>
							{t("registrationRequestScopeReadOnlyBanner", { scope: scopeDescriptions.vrg })}
						</ThemedText>
					</View>
				))}

			<View style={styles.section}>
				<TransportStatusCard
					kind="filesystem"
					{...resolveTransportCardState(filesystemEntry)}
					disabled={!canSync}
					onSyncNow={() => runSync("filesystem")}
				/>
			</View>

			<View style={styles.section}>
				<TransportStatusCard
					kind="rest"
					{...resolveTransportCardState(restEntry)}
					disabled={!canSync}
					onSyncNow={() => runSync("rest")}
				/>
			</View>

			{/* The peer-cluster leg ships code-complete, unverified (D-11). This plan attaches no
			    binding, so this action is inert — `INERT_PEER_SYNC` invokes nothing. 48-23 attaches
			    one through the same seam; nothing in this phase depends on 48-23. No conditional of
			    any kind wraps this card: it renders every time this screen renders, in this
			    position, always — never reordered above the two proven bindings above it. Nothing
			    but `disabled` and `onTrySync` is passed: no state, no counts, no connection flag,
			    no `kind` — the card's own prop type carries no channel for any of that. */}
			<View style={styles.section}>
				<ExperimentalTransportStatusCard disabled={!canSync} onTrySync={INERT_PEER_SYNC} />
			</View>

			{errorRefs.length > 0 && (
				<View style={styles.section} testID="bulk-import-sync-errors-section">
					<ThemedText type="defaultSemiBold">{t("bulkImportSyncErrorsSectionTitle")}</ThemedText>
					{errorRefs.map((ref, index) => (
						<ThemedText
							key={ref.transport + ":" + ref.itemId}
							type="small"
							style={[styles.errorRow, { color: colors.error }]}
							testID={"bulk-import-sync-error-row-" + index}
						>
							{/* An IDENTIFIER only, never a payload value — a failing item is a
							    registration payload carrying real registrant PII, and the
							    never-log-values discipline Phase 47 established for
							    `RegistrantPrivate` applies here unchanged. */}
							{t(
								ref.transport === "filesystem"
									? "bulkImportSyncFilesystemHeading"
									: "bulkImportSyncRestHeading",
							)}
							{": "}
							{ref.itemId}
						</ThemedText>
					))}
				</View>
			)}
		</ScrollView>
	);
}

const localStyles = StyleSheet.create({
	banner: {
		flexDirection: "row",
		alignItems: "center",
		gap: 8,
		marginBottom: 12,
	},
	errorRow: {
		marginTop: 4,
	},
});

const styles = { ...globalStyles, ...localStyles };
