import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { ExtendedTheme, useNavigation, useRoute, useTheme } from "@react-navigation/native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTranslation } from "react-i18next";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type {
	IRegistrationEngine,
	ISignatureTasksEngine,
	PriorRejection,
	RegistrantSignatureTask,
	RegistrationRequestRead,
	RegistrationVerificationChecklistItem,
} from "@votetorrent/vote-core";
import { ThemedText } from "../../components/ThemedText";
import { CustomButton } from "../../components/CustomButton";
import { Footer } from "../../components/Footer";
import { InlineError } from "../../components/InlineError";
import { globalStyles } from "../../theme/styles";
import { useApp } from "../../providers/AppProvider";
import { createDeviceSigner } from "../../engines/device-signer";
import { useCurrentOfficerScopes } from "../../hooks/useCurrentOfficerScopes";
import {
	REGISTRATION_REQUEST_STATUS_META,
	formatRequestTimestamp,
	registrationRequestDisplayName,
} from "./registration-request-display";
import { truncateId } from "./registrant-display";
import { BridgeSourceCallout } from "./components/BridgeSourceBadge";
import { PriorRejectionsCallout } from "./components/PriorRejectionsCallout";
import { VerificationChecklist } from "./components/VerificationChecklist";
import { RejectReasonCard } from "./components/RejectReasonCard";
import { pillStyles, tintPill } from "./components/pill";
import type { RootStackParamList } from "../../navigation/types";

/**
 * RegistrationRequestApprovalScreen — the ceremony where an authority
 * officer actually decides a registration request (D-03/D-06/D-07).
 *
 * (1) This is a STANDALONE screen reached by its own route
 * (`RegistrationRequestApproval`, wired by 48-21). It deliberately adds NO
 * `'registrant'` branch to `SignatureTaskScreen.tsx`'s `titleKey` record or
 * its `signatureType` switch — that file is byte-unchanged by this phase.
 * What is reused from it is the ceremony SHAPE only: fetch the
 * engine-authoritative digest via `getSignatureDigest` -> sign with the
 * device-signer callback -> call the completion method -> `navigation.goBack()`,
 * with `InlineError` as the sole failure surface. The reason this is a
 * separate screen is D-07: the verification checklist is a screen-local gate
 * `SignatureTaskScreen.tsx` has no equivalent of, and bolting a seventh
 * branch onto a switch serving six unrelated ceremonies would put the
 * checklist one refactor away from every other signature type.
 *
 * (2) The render order below is a safety property, not a layout preference.
 * `BridgeSourceCallout` renders first because D-03 requires a bridge
 * assertion to be unmissable. `PriorRejectionsCallout` renders directly
 * beneath it, above the summary and the checklist, because an officer who
 * never scrolls past a re-submitted request must still see that this person
 * was refused before (D-06).
 *
 * (3) Never-log rule: the request summary renders unmasked — an officer
 * cannot honestly complete the D-07 checklist against a masked value, so
 * masking would make the checklist dishonest. The compensating control is
 * that no payload value, no `rejectionReason`, and neither `read.submittedAt`
 * nor `read.receivedAt` ever reaches `console.*`, an `errorMessage`, an i18n
 * interpolation, or a crash payload — the same contract Phase 47's
 * `RegistrantDetailScreen` states for `RegistrantPrivate`. This file
 * deliberately contains ZERO `console.*` calls — a divergence from
 * `SignatureTaskScreen.tsx`, which does `console.warn` on its own catch
 * branches: that screen's tasks carry no registrant PII, this screen's
 * summary does.
 *
 * (4) `useCurrentOfficerScopes()` here is a UI legibility convenience, not a
 * security boundary. `AdminSigning.SignerKeyValid` and
 * `OfficerSignature.OfficerValid` are hardcoded stub CHECKs, and
 * `AdminSigning.UserIdValid` requires the signer to be some officer at the
 * authority, not one scoped to any particular value — a pre-existing,
 * cross-cutting gap tracked under Phase 999.1 and out of scope here. This
 * file makes no claim anywhere that write access is scope-gated at the data
 * layer; `canDecide` decides only which write controls render `disabled`.
 */

export interface RequestSummaryRow {
	key: string;
	labelKey?: string;
	label?: string;
	value: string;
}

/** Recursion guard mirroring `registrant-detail-model.ts`'s flatten discipline — malformed stored JSON must never hang a render. */
const MAX_PRIVATE_DETAIL_DEPTH = 8;

function slugifyFieldName(name: string): string {
	return name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

/** Pushes one row IFF `value` is not `undefined`/`null` — an empty string IS pushed (a declared-but-blank field is information the officer needs). Coerces with `String(...)`. */
function pushFieldRow(rows: RequestSummaryRow[], key: string, label: string, value: unknown): void {
	if (value === undefined || value === null) return;
	rows.push({ key, label, value: String(value) });
}

function pushPrivateDetailRows(
	rows: RequestSummaryRow[],
	details: ReadonlyArray<{ name: string; value: string | number | boolean | unknown[]; hint?: string }>,
	depth: number,
	namePrefix: string
): void {
	if (depth >= MAX_PRIVATE_DETAIL_DEPTH) return;
	for (const detail of details) {
		if (typeof detail?.name !== "string" || detail.name.trim().length === 0) continue;
		const qualifiedName = namePrefix.length > 0 ? namePrefix + "." + detail.name : detail.name;
		if (Array.isArray(detail.value)) {
			pushPrivateDetailRows(
				rows,
				detail.value as ReadonlyArray<{ name: string; value: string | number | boolean | unknown[]; hint?: string }>,
				depth + 1,
				qualifiedName
			);
		} else {
			pushFieldRow(rows, "private-" + slugifyFieldName(qualifiedName), qualifiedName, detail.value);
		}
	}
}

/**
 * `buildRequestSummaryRows` — the pure, exported helper the render loop
 * consumes. No React, no `t()`, no theme: the caller translates `labelKey`
 * and renders `label` verbatim (there is NO i18n key for a dynamic payload
 * field name — 48-03 owns the i18n map and none is invented here).
 *
 * Rows 1 and 2 are the provenance pair and they LEAD the summary — this
 * ordering is a safety property, not a layout preference. `submittedAt` is
 * submitter-chosen, a claim carried inside the request's own signature and
 * attacker-controlled within 48-07's skew bound; `receivedAt` is the
 * authority's own observation, inside no digest, and the key 48-08's triage
 * queue is ordered by. T-48-05-09, T-48-07-12 and T-48-08-11 all ACCEPT a
 * misstated `submittedAt` on the explicit ground that the officer can see
 * the divergence, and this screen is where the decision is actually made —
 * so the pair sits above every payload field, where an officer who never
 * scrolls still sees it. BOTH rows are emitted unconditionally, in every
 * mode, even when the two values are equal — this screen applies NO
 * divergence threshold (unlike 48-14's list row) and never calls
 * `resolveRowTimestamps`: that threshold exists to protect the D-03 marker's
 * weight in a dense list, and a detail screen has no such budget. Never emit
 * one value under the other's row key, and never merge the two into one row.
 *
 * This function performs no masking, no truncation of payload values (other
 * than the final `requesterKey` row, which truncates the same way every
 * other truncated-key surface in this app does), and no logging.
 */
export function buildRequestSummaryRows(read: RegistrationRequestRead): RequestSummaryRow[] {
	const rows: RequestSummaryRow[] = [];

	rows.push({
		key: "received-at",
		labelKey: "registrationRequestApprovalReceivedAtLabel",
		value: formatRequestTimestamp(read.receivedAt),
	});
	rows.push({
		key: "submitted-at",
		labelKey: "registrationRequestApprovalSubmittedAtLabel",
		value: formatRequestTimestamp(read.submittedAt),
	});

	const publicTier = read.payload.public;
	if (publicTier) {
		pushFieldRow(rows, "public-lastname", "lastName", publicTier.lastName);
		pushFieldRow(rows, "public-firstname", "firstName", publicTier.firstName);
		pushFieldRow(rows, "public-district", "district", publicTier.district);
		if (publicTier.extraFields) {
			for (const name of Object.keys(publicTier.extraFields)) {
				pushFieldRow(rows, "public-" + slugifyFieldName(name), name, publicTier.extraFields[name]);
			}
		}
	}

	const privateDetails = read.payload.private?.details;
	if (Array.isArray(privateDetails)) {
		pushPrivateDetailRows(rows, privateDetails, 0, "");
	}

	const selectiveDetails = read.payload.selective?.details;
	if (Array.isArray(selectiveDetails)) {
		for (const item of selectiveDetails) {
			pushFieldRow(rows, "selective-" + slugifyFieldName(item.name), item.name, item.value);
		}
	}

	rows.push({
		key: "requester-key",
		labelKey: "registrationRequestApprovalRequesterKeyLabel",
		value: truncateId(read.requesterKey),
	});

	return rows;
}

type ApprovalMode = "loading" | "pending" | "approved" | "rejected";

export default function RegistrationRequestApprovalScreen() {
	const { requestId, authorityId } = useRoute().params as { requestId: string; authorityId: string };
	const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
	const { t } = useTranslation();
	const { colors } = useTheme() as ExtendedTheme;
	const insets = useSafeAreaInsets();
	const { getEngine } = useApp();
	const { scopes } = useCurrentOfficerScopes(authorityId);

	useLayoutEffect(() => {
		navigation.setOptions({ title: t("registrationRequestApprovalScreenTitle") });
	}, [navigation, t]);

	const [read, setRead] = useState<RegistrationRequestRead | undefined>(undefined);
	const [priorRejections, setPriorRejections] = useState<PriorRejection[]>([]);
	const [priorRejectionsUnavailable, setPriorRejectionsUnavailable] = useState(false);
	const [task, setTask] = useState<RegistrantSignatureTask | undefined>(undefined);
	const [checked, setChecked] = useState<RegistrationVerificationChecklistItem[]>([]);
	const [gateMet, setGateMet] = useState(false);
	const [showRejectCard, setShowRejectCard] = useState(false);
	const [errorMessage, setErrorMessage] = useState("");
	const [loading, setLoading] = useState(true);

	// CR-02/WR-08 stale-setState guard, copied from RegistrantDetailScreen.tsx.
	const unmountedRef = useRef(false);
	useEffect(() => {
		unmountedRef.current = false;
		return () => {
			unmountedRef.current = true;
		};
	}, []);

	// A SYNCHRONOUS double-press guard on Approve — a signed, irreversible
	// write. Two touches dispatched in the same JS tick both read the SAME
	// closure's state (React does not re-render synchronously between them),
	// so a `useState`-only guard cannot close that gap; a ref mutation is
	// visible to every subsequent call in the same tick. This app has already
	// shipped double-press defects on signed writes (RejectReasonCard's own
	// `submittingRef` doc comment carries the identical reasoning). Read
	// directly in the Approve button's `disabled` expression below so the
	// visual freeze tracks the ref without a redundant state variable.
	const submittingRef = useRef(false);

	const mode: ApprovalMode =
		read?.status === "p" ? "pending" : read?.status === "a" ? "approved" : read?.status === "r" ? "rejected" : "loading";
	// A UI legibility convenience only — see the file header (4). Gates
	// `disabled` on the two write controls below and nothing else; no data
	// path anywhere in this file branches on it.
	const canDecide = scopes?.includes("vrg") ?? false;

	useEffect(() => {
		async function load() {
			setLoading(true);
			setErrorMessage("");
			try {
				const reg = await getEngine<IRegistrationEngine>("registration");
				const r = await reg.getRegistrationRequest(requestId);
				if (r === undefined) {
					// requestId is a plain identifier and carries no PII (48-21's own
					// param-hygiene gate enforces the same allow-list) — routing this
					// through the existing catch/InlineError surface avoids inventing
					// an i18n key 48-03 does not own.
					throw new Error(`RegistrationRequestApprovalScreen: request not found (${requestId})`);
				}
				if (unmountedRef.current) return;
				setRead(r);
				setChecked(r.verificationChecklist ?? []);

				try {
					const prior = await reg.getPriorRejections(r.requesterKey);
					if (!unmountedRef.current) setPriorRejections(prior);
				} catch (err) {
					// L-3: rendering nothing here would be indistinguishable from "no
					// prior rejections", the exact misreading D-06 exists to prevent —
					// so the failure is surfaced and Approve is blocked while Reject
					// stays available. Refusing under uncertainty is safe; approving
					// under it is not.
					if (!unmountedRef.current) {
						setPriorRejectionsUnavailable(true);
						setErrorMessage(err instanceof Error ? err.message : String(err));
					}
				}

				if (r.status === "p") {
					const tasksEngine = await getEngine<ISignatureTasksEngine>("signatureTasksEngine");
					const tasks = await tasksEngine.getRequestedSignatures(true);
					// 48-11 L-3: the requestId equality below is mandatory — an
					// officer legitimately has several pending registration requests
					// at once, and taking the first 'registrant' task would hand the
					// officer a DIFFERENT request's digest to sign.
					const found = tasks.find(
						(x) => x.signatureType === "registrant" && (x as RegistrantSignatureTask).requestId === requestId
					) as RegistrantSignatureTask | undefined;
					if (!unmountedRef.current) setTask(found);
				}
			} catch (err) {
				if (!unmountedRef.current) setErrorMessage(err instanceof Error ? err.message : String(err));
			} finally {
				if (!unmountedRef.current) setLoading(false);
			}
		}
		load();
	}, [requestId, getEngine]);

	// G. handleApprove — the accept ceremony (D-07). Four steps: fetch the
	// engine-authoritative digest, sign it device-side, complete the
	// signature with the checklist bound into `decision`, then leave.
	async function handleApprove() {
		if (submittingRef.current) return;
		submittingRef.current = true;
		try {
			setErrorMessage("");
			if (!task) {
				throw new Error(`RegistrationRequestApprovalScreen: no pending signature task for requestId=${requestId}`);
			}
			const engine = await getEngine<ISignatureTasksEngine>("signatureTasksEngine");
			// The engine is authoritative; the screen never recomputes a digest
			// itself (48-11 L-3 scoped this lookup by requestId).
			const digest = await engine.getSignatureDigest(task);
			const signer = await createDeviceSigner("Device User");
			const signature = await signer(digest);
			// `sign: signer` is passed UNCONDITIONALLY — this screen deliberately
			// does NOT copy SignatureTaskScreen.tsx's ballot-only narrowing. Per
			// 48-11 L-2: DG-2 is signed at decision time inside
			// finalizeRegistrantApproval, and an accept whose `result.sign` is
			// undefined THROWS in the engine — there is no placeholder fallback,
			// because a placeholder would produce an approval whose checklist is
			// covered by nothing. `decision.checklist` is the SAME array instance
			// `VerificationChecklist` rendered, so what the officer sees and what
			// the officer signs cannot diverge.
			await engine.completeSignature(task, {
				isAccepted: true,
				signature,
				sign: signer,
				decision: { checklist: checked },
			});
			// No toast, no checkmark — this is a ceremony screen, mirroring
			// SignatureTaskScreen.tsx.
			navigation.goBack();
		} catch (err) {
			setErrorMessage(err instanceof Error ? err.message : String(err));
		} finally {
			submittingRef.current = false;
		}
	}

	// H. handleReject — the refusal.
	//
	// D-12 (48-12, carried verbatim from signature-tasks-engine.ts): a rejection that advances the signing session is a critical integrity hole.
	// On THIS path a completed 'vrg' session would drive
	// finalizeRegistrantApproval -> the unchanged register(), so a rejection
	// that advanced the session would create the very Registrant the officer
	// refused, while the request row still read Status = 'r' — silently,
	// invisible to anyone reading only RegistrationRequest.Status.
	//
	// L-2 (48-11): `rejectRegistrationRequest` takes a signer because the
	// rejection RECORD must itself be signed and attributable (D-06) — that
	// is a different act from advancing the signing session, and this
	// handler performs the first and NEVER the second: it never calls
	// `getSignatureDigest` and never invokes `signer(digest)` itself.
	async function handleReject(reason: string): Promise<void> {
		setErrorMessage("");
		try {
			const reg = await getEngine<IRegistrationEngine>("registration");
			// The screen never calls getSignatureDigest and never invokes
			// signer(digest) itself on this path — the signer is handed to the
			// engine, which signs the rejection RECORD, not the signing session.
			const signer = await createDeviceSigner("Device User");
			// `reason` arrives already trimmed from RejectReasonCard — not
			// re-trimmed here.
			await reg.rejectRegistrationRequest(requestId, { checklist: checked, rejectionReason: reason }, signer);
			if (task) {
				const tasksEngine = await getEngine<ISignatureTasksEngine>("signatureTasksEngine");
				// The blank triple, byte-identical to SignatureTaskScreen.tsx's own
				// reject path — no `sign` field, no `decision` field. Closing the
				// task and advancing the signature are different things; only the
				// second is forbidden.
				await tasksEngine.completeSignature(task, {
					isAccepted: false,
					signature: { signature: "", signerKey: "", signerUserId: "" },
				});
			}
			navigation.goBack();
		} catch (err) {
			setErrorMessage(err instanceof Error ? err.message : String(err));
			// Re-thrown so RejectReasonCard's own submit latch (idle ->
			// submitting -> submitted) sees a REJECTED onConfirm and returns to
			// idle — mirroring RegistrantDetailScreen.tsx's handleConfirmLifecycle
			// precedent. Without this a failed reject would latch the card on
			// "submitted" permanently, stranding the officer with no retry.
			throw err;
		}
	}

	const summaryRows = read ? buildRequestSummaryRows(read) : [];
	const rejectedMeta = REGISTRATION_REQUEST_STATUS_META.r;

	return (
		<View testID="registration-request-approval-screen" style={styles.content}>
			{/* Neither decided mode renders a footer (see below), so nothing else
			    clears the Android gesture bar / iOS home indicator below the last
			    line of the approved or rejected block — the rejected block's
			    trailing decided-at line was unreachable at maximum scroll for
			    exactly this reason (48-UAT.md gap 3 / DEFECT-3). Applied
			    unconditionally (not just in decided modes) so this does not become
			    a third three-valued branch; in pending mode the Footer supplies its
			    own inset clearance and the extra scroll room is harmless. Mirrors
			    RegistrationInboxScreen.tsx's contentContainerStyle exactly — do not
			    delete this as redundant-looking. */}
			<ScrollView
				testID="registration-request-approval-scroll"
				style={styles.container}
				contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
			>
				{/* InlineError renders null for an empty message and carries no
				    testID prop, so its absence is otherwise unassertable — the
				    wrapping View is what makes presence/absence testable. */}
				{errorMessage ? (
					<View testID="registration-request-approval-error">
						<InlineError message={errorMessage} />
					</View>
				) : null}

				{read ? (
					<>
						{/* D-03: BridgeSourceCallout owns its own issuerType === 'bridge'
						    absence rule. No screen-level condition is added around it —
						    duplicating that condition is how the two drift. */}
						<BridgeSourceCallout issuerType={read.issuerType} bridgeLabel={read.bridgeLabel} bridgeId={read.bridgeId} />

						{/* D-06: PriorRejectionsCallout returns null for an empty array —
						    rendered unconditionally, no wrapping length check. */}
						<PriorRejectionsCallout rejections={priorRejections} />

						<View
							testID="registration-request-approval-summary"
							style={[styles.cardSurface, { backgroundColor: colors.card }]}
						>
							<ThemedText type="title" testID="registration-request-approval-summary-title">
								{t("registrationRequestApprovalSummaryTitle")}
							</ThemedText>
							{summaryRows.map((row) => (
								<View
									key={row.key}
									testID={`registration-request-approval-summary-row-${row.key}`}
									style={localStyles.summaryRow}
								>
									<ThemedText
										type="small"
										style={{ color: colors.textSecondary }}
										testID={`registration-request-approval-summary-label-${row.key}`}
									>
										{row.labelKey ? t(row.labelKey) : row.label}
									</ThemedText>
									{/* row.value has exactly ONE destination — this ThemedText
									    child. No console.*, no interpolation into any other
									    string, no error message. */}
									<ThemedText
										type="default"
										testID={`registration-request-approval-summary-value-${row.key}`}
									>
										{row.value}
									</ThemedText>
								</View>
							))}
						</View>

						<VerificationChecklist
							checked={checked}
							onChange={(next, met) => {
								setChecked(next);
								setGateMet(met);
							}}
							readOnly={mode !== "pending"}
							decidedAt={read.decidedAt}
						/>

						{mode === "approved" ? (
							<View testID="registration-request-approval-approved-block">
								<ThemedText type="default" testID="registration-request-approval-approved-by">
									{t("registrationRequestApprovalApprovedByLabel", {
										officer: read.decidingOfficerUserId ?? "",
										date: formatRequestTimestamp(read.decidedAt ?? ""),
									})}
								</ThemedText>
								{/* registrantId is resolved by the engine (48-05/48-08), never
								    guessed by the UI — its absence on an approved request means
								    the engine could not resolve it, and the CTA must not render a
								    broken navigation. */}
								{read.registrantId ? (
									<View testID="registration-request-approval-view-registrant">
										<CustomButton
											title={t("registrationRequestApprovalViewRegistrantButton")}
											backgroundColor={colors.accent}
											onPress={() =>
												navigation.navigate("RegistrantDetail", {
													registrantId: read.registrantId!,
													authorityId,
												})
											}
										/>
									</View>
								) : null}
							</View>
						) : null}

						{mode === "rejected" ? (
							<View testID="registration-request-approval-rejected-block">
								<View
									testID="registration-request-approval-rejected-pill"
									style={[pillStyles.pill, { backgroundColor: tintPill(colors[rejectedMeta.colorKey]) }]}
								>
									<ThemedText type="smallBold" style={{ color: colors[rejectedMeta.colorKey] }}>
										{t(rejectedMeta.labelKey)}
									</ThemedText>
								</View>
								<ThemedText type="default" testID="registration-request-approval-rejection-reason">
									{read.rejectionReason ?? ""}
								</ThemedText>
								<ThemedText type="small" testID="registration-request-approval-rejecting-officer">
									{read.decidingOfficerUserId ?? ""}
								</ThemedText>
								<ThemedText type="tiny" testID="registration-request-approval-decided-at">
									{formatRequestTimestamp(read.decidedAt ?? "")}
								</ThemedText>
							</View>
						) : null}
					</>
				) : null}
			</ScrollView>

			{/* Neither decided mode renders a footer of any kind. */}
			{mode === "pending" && !showRejectCard ? (
				<View testID="registration-request-approval-footer">
					<Footer row>
						<View testID="registration-request-approval-approve" style={localStyles.footerSlot}>
							<CustomButton
								title={t("registrationRequestApprovalApproveButton")}
								icon="check"
								backgroundColor={colors.success}
								size="thin"
								flex
								disabled={!gateMet || !canDecide || priorRejectionsUnavailable || submittingRef.current}
								onPress={handleApprove}
							/>
						</View>
						<View testID="registration-request-approval-reject" style={localStyles.footerSlot}>
							<CustomButton
								title={t("registrationRequestApprovalRejectButton")}
								icon="xmark"
								backgroundColor={colors.error}
								size="thin"
								flex
								disabled={!canDecide}
								// Fires NO engine call whatsoever — only reveals the card.
								onPress={() => setShowRejectCard(true)}
							/>
						</View>
					</Footer>
				</View>
			) : null}

			{mode === "pending" && showRejectCard && read ? (
				<RejectReasonCard
					requesterName={registrationRequestDisplayName({
						requestId,
						lastName: read.payload.public?.lastName,
						firstName: read.payload.public?.firstName,
						requesterKey: read.requesterKey,
					})}
					onConfirm={handleReject}
					onDismiss={() => setShowRejectCard(false)}
				/>
			) : null}
		</View>
	);
}

const localStyles = StyleSheet.create({
	summaryRow: {
		marginBottom: 8,
	},
	footerSlot: {
		flex: 1,
	},
});

const styles = { ...globalStyles, ...localStyles };
