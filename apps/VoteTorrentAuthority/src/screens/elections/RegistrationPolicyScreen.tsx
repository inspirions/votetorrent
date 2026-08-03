import React, { useCallback, useEffect, useRef, useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { ExtendedTheme, useRoute, useTheme } from "@react-navigation/native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTranslation } from "react-i18next";
import FontAwesome6 from "react-native-vector-icons/FontAwesome6";
import { ThemedText } from "../../components/ThemedText";
import { ChipButton } from "../../components/ChipButton";
import { InlineError } from "../../components/InlineError";
import { globalStyles } from "../../theme/styles";
import { useApp } from "../../providers/AppProvider";
import { createDeviceSigner } from "../../engines/device-signer";
import type { SignCallback } from "../../engines/device-signer";
import { useCurrentOfficerScopes } from "../../hooks/useCurrentOfficerScopes";
import { reconcilePolicyState } from "./registration-policy-reconciliation";
import { RegistrationFieldsSection } from "./components/RegistrationFieldsSection";
import { DisclosurePolicySection } from "./components/DisclosurePolicySection";
import { AttestationPolicySection } from "./components/AttestationPolicySection";
import { ElectionEvent, scopeDescriptions } from "@votetorrent/vote-core";
import type {
	IElectionEngine,
	IRegistrationEngine,
	ElectionRegistrationField,
	ElectionDisclosurePolicy,
	ElectionAttestationPolicy,
	DisclosureAudience,
	RegistrantTier,
	FieldRequirement,
} from "@votetorrent/vote-core";

/**
 * RegistrationPolicyScreen — the single RegistrationPolicy route (D-01). Owns every
 * IRegistrationEngine read, every 'mel'-signed write, the createDeviceSigner plumbing,
 * the D-10 scope-gate banner, the D-04/D-05 Policy Issues card (Task 2), the D-13
 * warn-don't-block confirmation (Task 2), and the D-03 Leg A N+1 ballot-districts read.
 * The three section components (46-05/46-06/46-07) are pure presentational — they make
 * no engine calls of their own.
 */
export default function RegistrationPolicyScreen() {
	const { t } = useTranslation();
	const { colors } = useTheme() as ExtendedTheme;
	const insets = useSafeAreaInsets();
	const { getEngine } = useApp();
	const { electionEngine, electionId, authorityId } = useRoute().params as {
		electionEngine: IElectionEngine;
		electionId: string;
		authorityId: string;
	};

	const [fields, setFields] = useState<ElectionRegistrationField[]>([]);
	const [disclosures, setDisclosures] = useState<ElectionDisclosurePolicy[]>([]);
	const [attestationPolicy, setAttestationPolicy] = useState<ElectionAttestationPolicy | undefined>(undefined);
	const [hasDistrictedBallot, setHasDistrictedBallot] = useState(false);
	const [rosterNonEmpty, setRosterNonEmpty] = useState(false);
	const [registrationOpen, setRegistrationOpen] = useState(false);
	const [errorMessage, setErrorMessage] = useState("");

	// Default-open, unlike ElectionDetailsScreen's "More" section (which defaults
	// closed): this is policy-review content an auditing read-only officer must see
	// immediately, matching D-10's transparency intent.
	const [fieldsOpen, setFieldsOpen] = useState(true);
	const [disclosureOpen, setDisclosureOpen] = useState(true);
	const [attestationOpen, setAttestationOpen] = useState(true);

	// Bumped only by Task 2's Keep-Current-Policy path to remount the three section
	// components below, resetting their internal row-status maps back to idle. Declared
	// here (unincremented) so Task 1's render already keys every section on it.
	const [sectionEpoch, setSectionEpoch] = useState(0);

	const { scopes, loading: scopesLoading } = useCurrentOfficerScopes(authorityId);
	const canWrite = !scopesLoading && scopes?.includes("mel") === true;
	const reconciliation = reconcilePolicyState(fields, disclosures);

	// CR-02 guard against a stale setState: loadPolicy is invoked both from the mount
	// effect below AND from runSignedWrite after every write, so a single effect-scoped
	// `cancelled` closure would only cover the mount call. A ref shared across every
	// caller generalizes the same "never setState after unmount" guarantee.
	const unmountedRef = useRef(false);
	useEffect(() => {
		return () => {
			unmountedRef.current = true;
		};
	}, []);

	const loadPolicy = useCallback(async () => {
		try {
			const registrationEngine = await getEngine<IRegistrationEngine>("registration");

			const fetchedFields = await registrationEngine.getElectionRegistrationFields(electionId);
			if (!unmountedRef.current) setFields(fetchedFields);

			const fetchedDisclosures = await registrationEngine.getElectionDisclosurePolicies(electionId);
			if (!unmountedRef.current) setDisclosures(fetchedDisclosures);

			// Store the raw result unchanged — never coalesce, never synthesize a row.
			// `undefined` is a real state AttestationPolicySection's resolveAttestationState
			// discriminates on FIRST (T-46-02); collapsing an absent policy to a false-y
			// default here would tell the officer attestation is off when the associate
			// ceremony will in fact require it.
			const fetchedAttestationPolicy = await registrationEngine.getElectionAttestationPolicy(electionId);
			if (!unmountedRef.current) setAttestationPolicy(fetchedAttestationPolicy);

			// D-03 Leg A — the N+1 read. BallotSummary carries NO districts field, so the
			// per-ballot detail read below is mandatory: reading districts off getBallots()
			// alone would silently pin this gate to false forever. Leg B (a declared
			// District field) is evaluated inside DisclosurePolicySection via
			// isDistrictAudienceAvailable — this screen supplies Leg A only and does not
			// restate Leg B here.
			const summaries = await electionEngine.getBallots();
			const ballotDetails = await Promise.all(summaries.map((b) => electionEngine.getBallotDetails(b.id)));
			if (!unmountedRef.current) {
				setHasDistrictedBallot(ballotDetails.some((d) => (d.ballot.districts?.length ?? 0) > 0));
			}

			// D-13 inputs. The roster length read below is STUBBED
			// (registration-engine.ts:865 returns an empty array), so this leg is dormant
			// until Phase 47 implements the real read — only the LENGTH may ever be
			// consumed here. No registrant name, field, count display, or roster list may
			// be rendered anywhere on this screen (D-08/D-09 — Phase 47 owns the roster
			// surface).
			const registrantsLength = (await registrationEngine.getElectionRegistrants(electionId)).length;
			if (!unmountedRef.current) setRosterNonEmpty(registrantsLength > 0);

			// ElectionEvent declares exactly ONE registration member, registrationEnds —
			// there is no registrationOpens/registrationCloses member on ElectionEvent
			// itself (those i18n key names are Timeline.tsx display labels mapped onto
			// this one member).
			const details = await electionEngine.getElectionDetails();
			if (!unmountedRef.current) {
				setRegistrationOpen(Date.now() < details.current.timeline[ElectionEvent.registrationEnds]);
			}
		} catch (err) {
			// Write failures must NOT set errorMessage here — they surface per-row inside
			// the three section components via their own runWrite state machines.
			if (!unmountedRef.current) setErrorMessage(err instanceof Error ? err.message : String(err));
		}
	}, [getEngine, electionEngine, electionId]);

	useEffect(() => {
		loadPolicy();
		// Plain effect, NOT a focus-triggered re-fetch: nothing else in the app mutates
		// this policy during a session, and this screen re-reads via loadPolicy() at the
		// end of every write it fires itself.
	}, [loadPolicy]);

	// D-14: every edit fires its signed engine call immediately — there is no draft
	// state and no Save button anywhere in this screen. Acquire "Device User" — the
	// same literal bootstrap fallback AppProvider.tsx:75 and useCurrentOfficerScopes
	// use, so a first-run identity cannot diverge. This helper never catches: every
	// rejection propagates to the section's own runWrite, which is what renders
	// Couldn't-save plus Retry.
	async function runSignedWrite(op: (sign: SignCallback) => Promise<void>): Promise<void> {
		const sign = await createDeviceSigner("Device User");
		await op(sign);
		await loadPolicy();
	}

	async function onAddField(fieldName: string, tier: RegistrantTier, requirement: FieldRequirement) {
		// Plain add: RegistrationFieldsSection already dedupes against existing names, so
		// this row does not yet exist.
		await runSignedWrite(async (sign) => {
			const registrationEngine = await getEngine<IRegistrationEngine>("registration");
			await registrationEngine.addElectionRegistrationField({ electionId, fieldName, tier, requirement }, sign);
		});
	}

	// PRIMARY-KEY HAZARD (shared by onChangeField and onSetAudience below):
	// addElectionRegistrationField (registration-engine.ts:915-928) and
	// addElectionDisclosurePolicy (registration-engine.ts:1017-1024) both execute a
	// plain `insert into`, NOT `insert or replace`, against an (ElectionId, FieldName)
	// primary key. Changing an existing row therefore has to be remove-then-add — two
	// separate 'mel'-signed calls under the same acquired signer, since a single add on
	// an existing row is a PK violation on the real engine. MockRegistrationEngine
	// implements both add* methods as a Map.set upsert (mock-registration-engine.ts:196/
	// 210), so a mock-backed jest test passes either way — correctness lives here, and
	// only the 46-10 device run exercises the real engine's constraint.
	//
	// The remove and the add are NOT atomic. If the add fails after the remove has
	// already committed, the row is gone from the table until the officer retries — and
	// the very next loadPolicy() reconciliation pass is what surfaces that gap as a
	// flagged Policy Issues row (D-04/D-05). CONTEXT.md D-04 enumerates this as a state
	// that genuinely occurs in a live database, not a theoretical one.
	async function onChangeField(fieldName: string, tier: RegistrantTier, requirement: FieldRequirement) {
		await runSignedWrite(async (sign) => {
			const registrationEngine = await getEngine<IRegistrationEngine>("registration");
			await registrationEngine.removeElectionRegistrationField(electionId, fieldName, sign);
			await registrationEngine.addElectionRegistrationField({ electionId, fieldName, tier, requirement }, sign);
		});
	}

	async function onRemoveField(fieldName: string) {
		await runSignedWrite(async (sign) => {
			const registrationEngine = await getEngine<IRegistrationEngine>("registration");
			await registrationEngine.removeElectionRegistrationField(electionId, fieldName, sign);
		});
	}

	async function onSetAudience(fieldName: string, audience: DisclosureAudience) {
		await runSignedWrite(async (sign) => {
			const registrationEngine = await getEngine<IRegistrationEngine>("registration");
			// When a disclosure row for this field already exists, delete it FIRST using
			// its STORED casing — the PK argument the delete is keyed on — then always add
			// under the caller-supplied field-row casing.
			const existing = disclosures.find((d) => d.fieldName.toLowerCase() === fieldName.toLowerCase());
			if (existing) {
				await registrationEngine.removeElectionDisclosurePolicy(electionId, existing.fieldName, sign);
			}
			await registrationEngine.addElectionDisclosurePolicy({ electionId, fieldName, audience }, sign);
		});
	}

	async function onRemoveDisclosure(fieldName: string) {
		await runSignedWrite(async (sign) => {
			const registrationEngine = await getEngine<IRegistrationEngine>("registration");
			await registrationEngine.removeElectionDisclosurePolicy(electionId, fieldName, sign);
		});
	}

	async function onSetAttestation(required: boolean) {
		await runSignedWrite(async (sign) => {
			const registrationEngine = await getEngine<IRegistrationEngine>("registration");
			// insert or replace (registration-engine.ts:1108) — no remove-then-add needed.
			await registrationEngine.setElectionAttestationPolicy(electionId, required, sign);
		});
	}

	async function onRevertToDefault() {
		await runSignedWrite(async (sign) => {
			const registrationEngine = await getEngine<IRegistrationEngine>("registration");
			await registrationEngine.removeElectionAttestationPolicy(electionId, sign);
		});
	}

	return (
		<ScrollView style={styles.container} contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}>
			<View style={styles.section}>
				<InlineError message={errorMessage} />
			</View>

			{/* D-10 scope-gate banner — persistent, non-collapsible, rendered only once the
			    hook has resolved (never flashes the not-an-officer copy during load). The
			    two branches are DELIBERATELY not collapsed: `scopes === undefined` (no
			    matching Officer row) and a real scopes array missing 'mel' are two distinct
			    facts and bind to two distinct copies. This gate is a UI affordance for
			    legibility, NOT a security boundary — the DB-side 'mel' AdminSignature CHECK
			    is the real control (T-46-03, D-10). */}
			{!scopesLoading && !canWrite && (
				scopes === undefined ? (
					<View testID="registration-policy-readonly-no-officer-banner" style={localStyles.banner}>
						<FontAwesome6 name="lock" size={14} color={colors.textSecondary} />
						<ThemedText type="small" style={{ color: colors.textSecondary }}>
							{t("registrationPolicyReadOnlyNoOfficerBanner")}
						</ThemedText>
					</View>
				) : (
					<View testID="registration-policy-readonly-banner" style={localStyles.banner}>
						<FontAwesome6 name="lock" size={14} color={colors.textSecondary} />
						<ThemedText type="small" style={{ color: colors.textSecondary }}>
							{t("registrationPolicyReadOnlyBanner", { scope: scopeDescriptions.mel })}
						</ThemedText>
					</View>
				)
			)}

			{/* Policy Issues card slot (D-04/D-05) — Task 2. */}

			<View style={styles.section} testID="registration-policy-fields-section">
				<View testID="registration-policy-fields-toggle">
					<ChipButton
						label={t("registrationPolicyFieldsSectionTitle")}
						icon={fieldsOpen ? "chevron-down" : "chevron-right"}
						onPress={() => setFieldsOpen((v) => !v)}
					/>
				</View>
				{fieldsOpen && (
					<RegistrationFieldsSection
						key={"fields-" + sectionEpoch}
						fields={fields}
						canWrite={canWrite}
						onAddField={onAddField}
						onChangeField={onChangeField}
						onRemoveField={onRemoveField}
					/>
				)}
			</View>

			{/* DisclosurePolicySection and AttestationPolicySection each render their own
			    internal ThemedText type="title" header (their 46-06/46-07 contracts) — this
			    screen adds ONLY the ChipButton toggle above them and does not add a second
			    title. The resulting word-level redundancy between the toggle chip and those
			    inner titles is accepted this phase, since 46-06/46-07 are finished
			    contracts outside this plan's edit surface. */}
			<View style={styles.section} testID="registration-policy-disclosure-section">
				<View testID="registration-policy-disclosure-toggle">
					<ChipButton
						label={t("registrationPolicyDisclosureSectionTitle")}
						icon={disclosureOpen ? "chevron-down" : "chevron-right"}
						onPress={() => setDisclosureOpen((v) => !v)}
					/>
				</View>
				{disclosureOpen && (
					<DisclosurePolicySection
						key={"disclosure-" + sectionEpoch}
						fields={fields}
						disclosures={disclosures}
						hasDistrictedBallot={hasDistrictedBallot}
						canWrite={canWrite}
						onSetAudience={onSetAudience}
						onRemoveDisclosure={onRemoveDisclosure}
					/>
				)}
			</View>

			<View style={styles.section} testID="registration-policy-attestation-section">
				<View testID="registration-policy-attestation-toggle">
					<ChipButton
						label={t("registrationPolicyAttestationSectionTitle")}
						icon={attestationOpen ? "chevron-down" : "chevron-right"}
						onPress={() => setAttestationOpen((v) => !v)}
					/>
				</View>
				{attestationOpen && (
					<AttestationPolicySection
						key={"attestation-" + sectionEpoch}
						policy={attestationPolicy}
						canWrite={canWrite}
						onSetAttestation={onSetAttestation}
						onRevertToDefault={onRevertToDefault}
					/>
				)}
			</View>
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
});

const styles = { ...globalStyles, ...localStyles };
