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
 * THE PEER CARD ROUTES THROUGH THE SEAM AS OF 48-23 — `SyncBindingId` now admits `'peer'`, and
 * pressing the card calls `runSync('peer')`. No host in this repo registers a `'peer'` binding, so
 * with nothing attached the existing no-binding path in `runSync` reports `{ failed: true }` — an
 * honest failure, not a silent no-op. The peer-cluster leg itself remains **code-complete,
 * unverified** (D-11): a green press proves only that the seam resolved a handle, and Node or jest
 * results are not verification for it. Nothing in this phase depended on 48-23 landing — if it had
 * not, this screen would still work and still tell the truth about that leg.
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
	// The peer CARD renders no state — ExperimentalTransportStatusCard (48-17) carries no state
	// channel, and this entry is never passed to it. WR-15: the entry IS read now, for
	// `errorItemIds` only, so a peer binding's error identifiers reach the errors section instead
	// of being dropped after `runSync('peer')` had already produced them. The slot also still
	// gives runSync somewhere honest to record `{ failed: true }` when nothing is attached,
	// without special-casing the peer id out of runSync's shared logic.
	const [peerEntry, setPeerEntry] = useState<TransportCardEntry>({});

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

	// WR-16: a per-id in-flight guard. Every other signed/network control in this phase carries one
	// (`RejectReasonCard`'s `submittingRef`, the approval screen's `handleApprove`); this one did
	// not, so repeated "Sync Now" presses launched OVERLAPPING `syncNow()` calls against the same
	// binding and whichever settled LAST won the card state. For the REST binding that means
	// overlapping intake batches, and an early failure could overwrite a later success (or the
	// reverse), so the displayed counts need not have described the most recent run at all.
	//
	// Two representations, deliberately, and the split is the same one WR-13 fixes on the approval
	// screen: the REF is the correctness guard (two presses dispatched in the same JS tick both
	// read the same closure's state, so a state-only guard cannot close that gap), and the STATE is
	// the feedback (mutating a ref schedules no render, so a ref-only guard would never actually
	// disable the button). Neither alone is sufficient.
	const inFlightRef = useRef<Set<SyncBindingId>>(new Set());
	const [inFlight, setInFlight] = useState<ReadonlySet<SyncBindingId>>(new Set());

	const runSync = useCallback((id: SyncBindingId) => {
		// Synchronous, same-tick guard. Checked and set before any await/promise boundary.
		if (inFlightRef.current.has(id)) return;

		const setEntry =
			id === "filesystem" ? setFilesystemEntry : id === "rest" ? setRestEntry : setPeerEntry;
		const binding = resolveSyncBinding(id);
		if (!binding) {
			// An unattached binding must not read as a successful or idle sync — it is honestly an
			// ERROR state, not a silent no-op. 48-24 gave this state its own string
			// (`bulkImportSyncErrorBody`, fixed and interpolation-free so no transport-supplied text
			// can ever reach it) rather than leaving it to fall through into a dangling "Last synced"
			// with no date (48-UAT.md gap 1).
			if (!unmountedRef.current) setEntry({ failed: true });
			return;
		}

		if (!unmountedRef.current) setErrorMessage("");

		// Marked in flight only on the path that actually starts a call. The no-binding branch
		// above returns synchronously and starts nothing, so it must not latch the control.
		inFlightRef.current.add(id);
		if (!unmountedRef.current) setInFlight(new Set(inFlightRef.current));
		const settle = () => {
			inFlightRef.current.delete(id);
			// The ref is cleared unconditionally — the guard must not survive an unmount and wedge a
			// remounted screen — while the render-facing state is only updated while mounted.
			if (!unmountedRef.current) setInFlight(new Set(inFlightRef.current));
		};

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
			})
			.finally(settle);
	}, []);

	// WR-15: all three bindings are passed. `toSyncErrorRefs` reads `errorItemIds` and nothing
	// else, so this carries opaque identifiers only — no counts, no timestamps, no transport text.
	const errorRefs = toSyncErrorRefs({
		filesystem: filesystemEntry.report,
		rest: restEntry.report,
		peer: peerEntry.report,
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
					// WR-16: reads the STATE half of the in-flight guard — the ref half cannot drive
					// a render. Overlapping presses are refused by the ref regardless.
					disabled={!canSync || inFlight.has("filesystem")}
					onSyncNow={() => runSync("filesystem")}
				/>
			</View>

			<View style={styles.section}>
				<TransportStatusCard
					kind="rest"
					{...resolveTransportCardState(restEntry)}
					disabled={!canSync || inFlight.has("rest")}
					onSyncNow={() => runSync("rest")}
				/>
			</View>

			{/* The peer-cluster leg ships code-complete, unverified (D-11). 48-23 routes this
			    control's press through runSync('peer') against the widened SyncBindingId seam — no
			    host in this repo registers a 'peer' binding, so with nothing attached the existing
			    no-binding path in runSync sets { failed: true } and the transport is honestly
			    reported as failed rather than silently idle. A green press proves only that the seam
			    resolved a handle and nothing more; Node or jest results are not verification for this
			    leg. No conditional of any kind wraps this card: it renders every time this screen
			    renders, in this position, always — never reordered above the two proven bindings
			    above it. Nothing but `disabled` and `onTrySync` is passed: no state, no counts, no
			    connection flag, no `kind` — the card's own prop type carries no channel for any of
			    that, so this routing change alters what the control DOES, never what the card
			    SHOWS. */}
			<View style={styles.section}>
				<ExperimentalTransportStatusCard
					disabled={!canSync || inFlight.has("peer")}
					onTrySync={() => runSync("peer")}
				/>
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
