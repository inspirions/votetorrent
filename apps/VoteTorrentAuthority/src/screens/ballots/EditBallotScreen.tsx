import React, { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { ExtendedTheme, useTheme, useNavigation, useRoute, useFocusEffect } from "@react-navigation/native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTranslation } from "react-i18next";
import type { Question } from "@votetorrent/vote-core";
import type { RouteProp } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type { RootStackParamList } from "../../navigation/types";
import { globalStyles } from "../../theme/styles";
import { useBallotDraft } from "./providers/BallotDraftProvider";
import { BallotTemplateForm } from "./components/BallotTemplateForm";
import { CustomButton } from "../../components/CustomButton";
import { InlineError } from "../../components/InlineError";
import { useApp } from "../../providers/AppProvider";
import { loadAuthoritiesWithRetry } from "../../utils/loadAuthoritiesWithRetry";
import { createDeviceSigner } from "../../engines/device-signer";
import { useDeviceSigningErrorHandler } from "../../hooks/useDeviceSigningErrorHandler";
import type { Authority, Ballot, INetworkEngine } from "@votetorrent/vote-core";

/**
 * EditBallotScreen — Ballot Template frame (Figma 57:490) in edit/populated mode.
 *
 * Reached from ElectionDetailsScreen's ballot template chevron list card (09-08).
 * Shares BallotTemplateForm with CreateBallotScreen (Decision 3).
 *
 * 09-10 G12: reads electionEngine + ballotId from route.params. When ballotId
 * is present, calls getBallotDetails(ballotId) on mount and seeds the draft so
 * the form pre-populates AND retains the SAME id. On PROPOSE, calls
 * engine.proposeBallot(ballot) with the existing id — the engine upserts by id
 * (from 09-09) so editing replaces the card instead of inserting a duplicate.
 *
 * UAT 62 test 13: "Submit for confirmation" and "Withdraw" live HERE, on the
 * persisted ballot. CreateBallotScreen's draft id has no ProposedBallot row, so the
 * engine refuses a submit from there; every persisted ballot opens this screen.
 * The footer is therefore state-driven: unlocked -> Propose + Submit, locked ->
 * Withdraw, confirmed -> no footer, readOnly preview -> no footer.
 */
const EditBallotScreen = () => {
	const { colors } = useTheme() as ExtendedTheme;
	const { t } = useTranslation();
	const route = useRoute<RouteProp<RootStackParamList, "EditBallot">>();
	const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
	const insets = useSafeAreaInsets();
	const { electionId, electionTitle, electionDate } = route.params ?? {};
	const electionEngine = (route.params as any)?.electionEngine;
	const ballotId = (route.params as any)?.ballotId;
	const readOnly = route.params?.readOnly === true;
	const { getEngine } = useApp();
	const [loadError, setLoadError] = useState("");
	const [errorMessage, setErrorMessage] = useState("");
	const [proposing, setProposing] = useState(false);
	const [submitting, setSubmitting] = useState(false);
	const [withdrawing, setWithdrawing] = useState(false);
	const [confirmationState, setConfirmationState] = useState<{ locked: boolean; confirmed: boolean } | null>(null);
	const handleDeviceSigningError = useDeviceSigningErrorHandler();
	const [authorities, setAuthorities] = useState<Authority[]>([]);
	const { ballotDraft, setBallotDraft, addQuestion, updateQuestion, removeQuestion } = useBallotDraft();

	// Seed the draft with electionId from route params (edit mode entry point)
	useEffect(() => {
		if (electionId && ballotDraft.electionId !== electionId) {
			setBallotDraft({ ...ballotDraft, electionId });
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [electionId]);

	// Load the real authorities so the dropdown stores a valid Authority.Id (the
	// ProposedBallot.AuthorityIdValid CHECK requires the id to exist in the
	// Authority table). Includes the primary/network-creator authority.
	const [primaryAuthorityId, setPrimaryAuthorityId] = useState("");
	useEffect(() => {
		async function loadAuthorities() {
			try {
				const engine = await getEngine<INetworkEngine>("network");
				if (!engine) return;
				// ballot-authority-empty fix: retry a zero-row result — see
				// loadAuthoritiesWithRetry for the strand-replication-race rationale.
				const buffer = await loadAuthoritiesWithRetry(engine);
				setAuthorities(buffer);
				const details = await engine.getDetails();
				if (details?.network?.primaryAuthorityId) {
					setPrimaryAuthorityId(details.network.primaryAuthorityId);
				}
			} catch (error) {
				console.warn("Error loading authorities for ballot:", error);
			}
		}
		loadAuthorities();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [getEngine]);

	// Default to the primary authority ONLY when the loaded ballot has no authority
	// (the getBallotDetails effect already seeds `authority` from the existing
	// ballot's authorityId, so this never clobbers an existing selection).
	useEffect(() => {
		if (primaryAuthorityId && !(ballotDraft as any).authority) {
			setBallotDraft({ ...ballotDraft, authority: primaryAuthorityId } as any);
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [primaryAuthorityId, (ballotDraft as any).authority]);

	// G12 edit/upsert: load existing ballot from engine on mount so the form
	// pre-populates AND the draft retains the SAME id for upsert on PROPOSE.
	useEffect(() => {
		if (!ballotId || !electionEngine) return;
		const loadBallot = async () => {
			try {
				const details = await electionEngine.getBallotDetails(ballotId);
				if (details?.ballot) {
					// WR-06: the async load replaces the whole draft, so it must not drop
					// the electionId that the synchronous seed effect set. setBallotDraft
					// is a plain setter (no functional updater), so fall back explicitly to
					// the loaded ballot's electionId, else the route's electionId param.
					// Map authorityId → authority (the loose key BallotTemplateForm's
					// dropdown reads) so the Authority field re-populates on reopen.
					setBallotDraft({
						...details.ballot,
						electionId: (details.ballot as any).electionId || electionId || "",
						authority: (details.ballot as any).authorityId ?? "",
					} as any);
				}
			} catch (error) {
				console.warn("getBallotDetails error", error);
				setLoadError(error instanceof Error ? error.message : String(error));
			}
		};
		loadBallot();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [ballotId]);

	// D-05: poll confirmation lock state on every focus so an edit screen opened
	// while a confirmation is pending shows the correct locked UI immediately.
	useFocusEffect(
		useCallback(() => {
			if (!electionEngine || !ballotId) return;
			const checkLock = async () => {
				try {
					const state = await electionEngine.getBallotConfirmationState(ballotId);
					setConfirmationState({ locked: !!state.locked, confirmed: !!state.confirmed });
				} catch (error) {
					console.warn("getBallotConfirmationState error", error);
					// Do not strand the officer with no footer if the read fails.
					setConfirmationState((prev) => prev ?? { locked: false, confirmed: false });
				}
			};
			checkLock();
		}, [electionEngine, ballotId])
	);

	const refreshConfirmationState = async () => {
		try {
			const state = await electionEngine.getBallotConfirmationState(ballotId);
			setConfirmationState({ locked: !!state.locked, confirmed: !!state.confirmed });
		} catch (error) {
			console.warn("getBallotConfirmationState error", error);
		}
	};

	// D-03/D-08: Submit the persisted ballot for confirmation.
	// `lazySign` is a LAZY factory thunk: `createDeviceSigner` is only invoked if the engine
	// actually calls this callback, which happens only when the authority's ceb threshold is
	// above 1 (IElectionEngine.submitBallotForConfirmation's own doc comment). A threshold-1
	// authority therefore needs neither a provisioned key nor a biometric prompt to submit
	// (it self-confirms), exactly as before 62-11.
	const handleSubmitForConfirmation = async () => {
		if (!electionEngine || !ballotId) return;
		setErrorMessage("");
		setSubmitting(true);
		try {
			const lazySign = async (digest: Uint8Array) => (await createDeviceSigner("Device User"))(digest);
			await electionEngine.submitBallotForConfirmation(ballotId, lazySign);
			// Re-read rather than guess: threshold 1 returns confirmed, higher thresholds locked.
			await refreshConfirmationState();
		} catch (error) {
			console.warn("submitBallotForConfirmation error", error);
			const outcome = handleDeviceSigningError(error);
			if (outcome.handled) return;
			setErrorMessage(outcome.message ?? t("ballotSubmitFailed"));
		} finally {
			setSubmitting(false);
		}
	};

	// D-05: Withdraw the pending confirmation — unlocks the ballot for editing.
	const handleWithdrawConfirmation = async () => {
		if (!electionEngine || !ballotId) return;
		setErrorMessage("");
		setWithdrawing(true);
		try {
			await electionEngine.withdrawBallotConfirmation(ballotId);
			await refreshConfirmationState();
		} catch (error) {
			console.warn("withdrawBallotConfirmation error", error);
			setErrorMessage(t("ballotWithdrawFailed"));
		} finally {
			setWithdrawing(false);
		}
	};

	// Carry-back from EditQuestionScreen SAVE: when editing an existing template,
	// EditQuestion popTos here with the assembled `question`. Merge it into the
	// draft (add or update by original code), then clear the param.
	const incomingQuestion = (route.params as { question?: Question } | undefined)?.question;
	useEffect(() => {
		if (!incomingQuestion) return;
		const originalQuestionCode = (
			route.params as { originalQuestionCode?: string } | undefined
		)?.originalQuestionCode;
		const lookupCode = originalQuestionCode ?? incomingQuestion.code;
		const existing = (ballotDraft.questions ?? []).some((q) => q.code === lookupCode);
		if (existing) {
			updateQuestion(lookupCode, incomingQuestion);
		} else {
			addQuestion(incomingQuestion);
		}
		navigation.setParams({
			question: undefined,
			originalQuestionCode: undefined,
		} as any);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [incomingQuestion?.code]);

	// Carry-back from EditQuestionScreen REMOVE: child passes removeQuestionCode via popTo.
	// We remove the question then clear the param to prevent re-fire (WARNING 7).
	const removeQuestionCode = (route.params as { removeQuestionCode?: string } | undefined)?.removeQuestionCode;
	useEffect(() => {
		if (!removeQuestionCode) return;
		removeQuestion(removeQuestionCode);
		navigation.setParams({ removeQuestionCode: undefined } as any);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [removeQuestionCode]);

	const handlePropose = async () => {
		// G12: upsert via engine (uses existing id to replace, not duplicate).
		if (!electionEngine) {
			// Guard: no engine in test/standalone contexts — still navigate back.
			navigation.goBack();
			return;
		}
		setErrorMessage("");
		setProposing(true);
		const ballot: Ballot = {
			id: (ballotDraft as any).id ?? ballotId ?? `ballot-${electionId}-${Date.now()}`,
			electionId: ballotDraft.electionId ?? electionId ?? "",
			authorityId: (ballotDraft as any).authority ?? (ballotDraft as any).authorityId ?? "",
			description: ballotDraft.description ?? "",
			districts: ballotDraft.districts ?? [],
			questions: ballotDraft.questions ?? [],
		};
		try {
			await electionEngine.proposeBallot(ballot);
			navigation.goBack();
		} catch (error) {
			console.warn("proposeBallot error", error);
			setErrorMessage(t("ballotProposeFailed"));
		} finally {
			setProposing(false);
		}
	};

	const handleAuthorityChange = (authority: string) => {
		setBallotDraft({ ...ballotDraft, authority } as any);
	};

	const handleDescriptionChange = (description: string) => {
		setBallotDraft({ ...ballotDraft, description });
	};

	const handleDistrictsChange = (districts: string[]) => {
		setBallotDraft({ ...ballotDraft, districts });
	};

	const handleAddQuestion = () => {
		navigation.navigate("EditQuestion", { electionTitle, electionDate });
	};

	const handleEditQuestion = (questionCode: string) => {
		// Pass the existing question so EditQuestion can pre-populate — its own
		// draft provider instance is separate/empty (screenLayout per-screen).
		const editQuestion = (ballotDraft.questions ?? []).find((q) => q.code === questionCode);
		navigation.navigate("EditQuestion", {
			questionCode,
			editQuestion,
			electionTitle,
			electionDate,
		} as any);
	};

	// D-05: edit is blocked when the ballot has a pending confirmation task.
	const locked = confirmationState?.locked === true;
	const confirmed = confirmationState?.confirmed === true;
	// No engine/ballot (standalone) -> nothing to poll; otherwise wait for the first read.
	const stateKnown = !electionEngine || !ballotId || confirmationState !== null;
	const editingDisabled = readOnly || locked || confirmed;

	return (
		<View style={globalStyles.content}>
			<BallotTemplateForm
				electionTitle={electionTitle}
				electionDate={electionDate}
				authority={(ballotDraft as any).authority ?? ""}
				onAuthorityChange={handleAuthorityChange}
				authorityOptions={authorities.map((a) => ({ id: a.id, name: a.name }))}
				description={ballotDraft.description ?? ""}
				onDescriptionChange={handleDescriptionChange}
				districts={ballotDraft.districts ?? []}
				onDistrictsChange={handleDistrictsChange}
				questions={ballotDraft.questions ?? []}
				onAddQuestion={editingDisabled ? undefined : handleAddQuestion}
				onEditQuestion={editingDisabled ? undefined : handleEditQuestion}
				disabled={editingDisabled}
			/>
			<InlineError message={loadError} />
			<InlineError message={errorMessage} />
			{/* Footer (UAT 62 test 13): hidden in readOnly preview and once confirmed.
			    Locked -> Withdraw only; otherwise Propose + Submit for confirmation. */}
			{!readOnly && stateKnown && !confirmed && (
				<View style={[globalStyles.footer, { backgroundColor: colors.card, paddingBottom: insets.bottom + 16 }]}>
					{locked ? (
						<CustomButton
							testID="edit-ballot-withdraw"
							title={t("withdrawConfirmation")}
							icon="rotate-left"
							onPress={handleWithdrawConfirmation}
							backgroundColor={colors.warning ?? colors.accent}
							disabled={withdrawing}
						/>
					) : (
						<>
							<CustomButton
								testID="edit-ballot-propose"
								title={t("propose")}
								icon="floppy-disk"
								onPress={handlePropose}
								backgroundColor={colors.success}
								forceDarkText={true}
								disabled={proposing || submitting}
							/>
							<CustomButton
								testID="edit-ballot-submit"
								title={t("submitForConfirmation")}
								icon="paper-plane"
								onPress={handleSubmitForConfirmation}
								backgroundColor={colors.accent}
								disabled={submitting || proposing}
							/>
						</>
					)}
				</View>
			)}
		</View>
	);
};

export default EditBallotScreen;
