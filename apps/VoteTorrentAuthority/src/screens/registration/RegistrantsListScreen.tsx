import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { ExtendedTheme, useNavigation, useRoute, useTheme } from "@react-navigation/native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTranslation } from "react-i18next";
import FontAwesome6 from "react-native-vector-icons/FontAwesome6";
import { ThemedText } from "../../components/ThemedText";
import { ChipButton } from "../../components/ChipButton";
import { CustomTextInput } from "../../components/CustomTextInput";
import { DateField } from "../../components/DateField";
import { InlineError } from "../../components/InlineError";
import { globalStyles } from "../../theme/styles";
import { useApp } from "../../providers/AppProvider";
import { useCurrentOfficerScopes } from "../../hooks/useCurrentOfficerScopes";
import { scopeDescriptions } from "@votetorrent/vote-core";
import type { IRegistrationEngine, RegistrantListFilter, RegistrantListRow, RegistrantStatus } from "@votetorrent/vote-core";
import { REGISTRANT_STATUS_META } from "./registrant-display";
import { RegistrantRow } from "./components/RegistrantRow";

// D-08: RootStackParamList does not yet carry a `RegistrantDetail` key — 47-21
// owns adding all five Phase 47 routes and registering the Stack.Screens.
// This screen-local widening keeps the net-new typecheck-error count at zero
// without taking ownership of navigation/types.ts, which this plan does not
// edit (git status gate, see the plan's <verification> section). 47-21 must
// replace this with `useNavigation<NavigationProp>()` once RegistrantDetail
// is a real route.
type PendingRouteNavigation = {
	navigate: (screen: string, params?: Record<string, unknown>) => void;
	setOptions: (options: unknown) => void;
};

// UI-SPEC's 25-50 recommendation. This app has no virtualized-list-component
// precedent anywhere — every list in this codebase is a `.map()`-in-`ScrollView`
// — so pages are bounded here instead, keeping a bounded render regardless of
// roster size.
const REGISTRANTS_PAGE_SIZE = 25;

/**
 * RegistrantsListScreen — the roster surface every other Phase 47 registrant
 * screen is reached from (D-04/D-05/D-07/D-08/D-13). Composes, in order:
 * `InlineError` -> `'vrg'` scope-gate banner -> search + filter chip bar ->
 * `.map()`-in-`ScrollView` rows -> Load More / Loading more… / End of list.
 *
 * Doubles as the ELECTION roster (D-07): `electionFilter` from the route
 * pre-applies `RegistrantListFilter.electionId` — there is no second screen
 * and no second engine method.
 */
export default function RegistrantsListScreen() {
	const { t } = useTranslation();
	const { colors } = useTheme() as ExtendedTheme;
	const insets = useSafeAreaInsets();
	const { getEngine } = useApp();
	// D-08: RootStackParamList does not yet carry a `RegistrantDetail` key —
	// see the `PendingRouteNavigation` comment above. 47-21 must replace this
	// with `useNavigation<NavigationProp>()`.
	const navigation = useNavigation() as unknown as PendingRouteNavigation;
	const { authorityId, electionFilter } = useRoute().params as {
		authorityId: string;
		electionFilter?: { electionId: string; electionTitle?: string };
	};

	const { scopes, loading: scopesLoading } = useCurrentOfficerScopes(authorityId);
	const canWrite = !scopesLoading && scopes?.includes("vrg") === true;

	useLayoutEffect(() => {
		const title =
			electionFilter?.electionTitle && electionFilter.electionTitle.length > 0
				? t("registrantListRosterScreenTitle", { electionTitle: electionFilter.electionTitle })
				: t("registrantListScreenTitle");
		navigation.setOptions({ title });
	}, [navigation, t, electionFilter?.electionTitle]);

	// Filter state — primitives only, so the reload effect's dep array is
	// stable and comparable by value, not by reference.
	const [statusFilter, setStatusFilter] = useState<RegistrantStatus | undefined>(undefined);
	const [districtFilter, setDistrictFilter] = useState<string | undefined>(undefined);
	const [expiringBefore, setExpiringBefore] = useState<string>(""); // "" when unset, matching DateField's contract
	const [appliedName, setAppliedName] = useState<string | undefined>(undefined); // the SUBMITTED search term
	const [searchText, setSearchText] = useState<string>(""); // the live input buffer — deliberately NOT a filter input

	// Result state.
	const [rows, setRows] = useState<RegistrantListRow[]>([]);
	const [total, setTotal] = useState<number | undefined>(undefined);
	const [nextCursor, setNextCursor] = useState<string | undefined>(undefined);
	const [loadingInitial, setLoadingInitial] = useState(true);
	const [loadingMore, setLoadingMore] = useState(false);
	const [errorMessage, setErrorMessage] = useState("");
	const [districtOptions, setDistrictOptions] = useState<string[]>([]);

	// CR-02/WR-08 guard against a stale setState: reset on entry so a cleanup
	// that runs while the component stays mounted (StrictMode double-invoke,
	// Fast Refresh, remount-in-place) does not permanently latch every setState
	// in loadFirstPage/loadMore off (RegistrationPolicyScreen.tsx:102-111).
	const unmountedRef = useRef(false);
	useEffect(() => {
		unmountedRef.current = false;
		return () => {
			unmountedRef.current = true;
		};
	}, []);

	const buildFilter = useCallback((): RegistrantListFilter => {
		const filter: RegistrantListFilter = { authorityId };
		if (electionFilter?.electionId !== undefined) filter.electionId = electionFilter.electionId;
		if (statusFilter !== undefined) filter.status = statusFilter;
		if (districtFilter !== undefined) filter.district = districtFilter;
		if (expiringBefore !== "") filter.expiringBefore = expiringBefore;
		if (appliedName !== undefined) filter.name = appliedName;
		return filter;
		// authorityId is ALWAYS supplied — 47-05's T-47-05a accepts an omitted
		// authorityId as a whole-database read, and this screen must never
		// trigger that.
	}, [authorityId, electionFilter?.electionId, statusFilter, districtFilter, expiringBefore, appliedName]);

	const loadFirstPage = useCallback(async () => {
		setLoadingInitial(true);
		setErrorMessage("");
		try {
			const engine = await getEngine<IRegistrationEngine>("registration");
			// Cursor deliberately ABSENT — that is precisely what makes 47-05 run
			// the count query, and it happens exactly once per filter change
			// because this callback's identity only changes when a filter
			// primitive changes (buildFilter's own dep array).
			const result = await engine.listRegistrants(buildFilter(), { pageSize: REGISTRANTS_PAGE_SIZE });
			if (unmountedRef.current) return;
			setRows(result.rows);
			setNextCursor(result.nextCursor);
			// `result.total` being undefined here means the count query failed
			// (47-05 swallows it and returns the rows anyway) — store the
			// undefined and render registrantListCountUnknown. Never treat it as
			// an error, never set errorMessage, never skip rendering the rows.
			setTotal(result.total);

			// Honest limitation: no engine surface enumerates districts, so the
			// chip set reflects districts seen in loaded pages only.
			if (districtFilter === undefined) {
				const distinct = Array.from(
					new Set(result.rows.map((r) => r.district).filter((d): d is string => !!d)),
				).sort();
				setDistrictOptions(distinct);
			} else {
				// districtFilter IS set — leave districtOptions untouched and merely
				// union in districtFilter, otherwise selecting a district would
				// collapse the chip set to that one district and strand the
				// officer with no way to switch back.
				setDistrictOptions((prev) => (prev.includes(districtFilter) ? prev : [...prev, districtFilter].sort()));
			}
		} catch (err) {
			// The caught error's message is rendered as-is, but the filter
			// object, the officer's typed search term and the district value are
			// never interpolated into it and never passed to any logging call
			// (T-47-11-01; the engine side of the same rule is 47-05's T-47-06).
			if (!unmountedRef.current) setErrorMessage(err instanceof Error ? err.message : String(err));
		} finally {
			if (!unmountedRef.current) setLoadingInitial(false);
		}
	}, [getEngine, buildFilter, districtFilter]);

	// Plain effect, NOT useFocusEffect — mirrors RegistrationPolicyScreen.tsx:167-172's
	// reasoning: nothing else in the app mutates this roster mid-session, and a
	// focus refetch would also silently re-run the expensive count.
	useEffect(() => {
		loadFirstPage();
	}, [loadFirstPage]);

	async function loadMore() {
		if (loadingMore || nextCursor === undefined) return;
		setLoadingMore(true);
		try {
			const engine = await getEngine<IRegistrationEngine>("registration");
			const result = await engine.listRegistrants(buildFilter(), {
				cursor: nextCursor,
				pageSize: REGISTRANTS_PAGE_SIZE,
			});
			if (unmountedRef.current) return;
			setRows((prev) => [...prev, ...result.rows]);
			setNextCursor(result.nextCursor);
			// Deliberately NOT touching `total` here: a cursored call always
			// returns `total: undefined` (47-05's contract), so assigning it
			// would blank a perfectly good count on the second page.
		} catch (err) {
			if (!unmountedRef.current) setErrorMessage(err instanceof Error ? err.message : String(err));
		} finally {
			if (!unmountedRef.current) setLoadingMore(false);
		}
	}

	function onSubmitSearch() {
		// The name filter is applied on submit, never per keystroke, and there
		// is no debounce timer: a per-keystroke filter change re-runs the
		// expensive count(*) on every character (exactly what D-05 caches it to
		// avoid), and a setTimeout debounce is non-deterministic under
		// react-test-renderer, which this phase's D-16 bar requires every UI
		// decision to be assertable in.
		const q = searchText.trim();
		setAppliedName(q.length > 0 ? q : undefined);
	}

	const hasActiveFilters =
		statusFilter !== undefined || districtFilter !== undefined || expiringBefore !== "" || appliedName !== undefined;
	// electionFilter deliberately does NOT count as an active filter — it
	// arrives from the route and is the screen's identity, not something the
	// officer can clear.

	return (
		<ScrollView style={styles.container} contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}>
			<View style={styles.section} testID="registrants-list-error">
				<InlineError message={errorMessage} />
			</View>

			{/* D-13 scope-gate banner — a UI legibility affordance only, NEVER a
			    security boundary. The schema's 'vrg' AdminSignature CHECK is the
			    real and only control (T-47-04). This screen has no write controls
			    at all, so the banner is purely informational here — the roster
			    itself renders regardless of scope, because every column it shows
			    comes from Registrant and the current public tier (D-13 gates the
			    PRIVATE tier, on 47-20's detail screen, not this list). */}
			{!scopesLoading &&
				!canWrite &&
				(scopes === undefined ? (
					<View testID="registrants-list-readonly-no-officer-banner" style={localStyles.banner}>
						<FontAwesome6 name="lock" size={14} color={colors.textSecondary} />
						<ThemedText type="small" style={{ color: colors.textSecondary }}>
							{t("registrantScopeReadOnlyNoOfficerBanner")}
						</ThemedText>
					</View>
				) : (
					<View testID="registrants-list-readonly-banner" style={localStyles.banner}>
						<FontAwesome6 name="lock" size={14} color={colors.textSecondary} />
						<ThemedText type="small" style={{ color: colors.textSecondary }}>
							{t("registrantScopeReadOnlyBanner", { scope: scopeDescriptions.vrg })}
						</ThemedText>
					</View>
				))}

			<View style={styles.section} testID="registrants-list-filters">
				<View testID="registrants-list-search">
					<CustomTextInput
						placeholder={t("registrantListSearchPlaceholder")}
						value={searchText}
						onChangeText={setSearchText}
						onSubmitEditing={onSubmitSearch}
						returnKeyType="search"
						autoCapitalize="none"
						autoCorrect={false}
					/>
				</View>

				<View style={localStyles.chipRow}>
					<View testID="registrants-list-filter-status-all">
						<ChipButton
							label={t("registrantListFilterStatusAll")}
							icon={statusFilter === undefined ? "check" : undefined}
							onPress={() => setStatusFilter(undefined)}
						/>
					</View>
					<View testID="registrants-list-filter-status-a">
						<ChipButton
							label={t(REGISTRANT_STATUS_META.a.labelKey)}
							icon={statusFilter === "a" ? "check" : undefined}
							onPress={() => setStatusFilter("a")}
						/>
					</View>
					<View testID="registrants-list-filter-status-s">
						<ChipButton
							label={t(REGISTRANT_STATUS_META.s.labelKey)}
							icon={statusFilter === "s" ? "check" : undefined}
							onPress={() => setStatusFilter("s")}
						/>
					</View>
					<View testID="registrants-list-filter-status-r">
						<ChipButton
							label={t(REGISTRANT_STATUS_META.r.labelKey)}
							icon={statusFilter === "r" ? "check" : undefined}
							onPress={() => setStatusFilter("r")}
						/>
					</View>
				</View>

				<View testID="registrants-list-filter-expiration">
					{/* Binds RegistrantListFilter.expiringBefore — registrants expiring
					    BEFORE the picked instant. DateField emits a Z-suffixed ISO
					    string, which is exactly what Registrant.Expiration stores, so
					    the comparison is a chronological string compare (47-05's
					    <interface_contract>). */}
					<DateField
						title={t("registrantListFilterExpirationLabel")}
						value={expiringBefore}
						onChange={setExpiringBefore}
					/>
				</View>

				{districtOptions.length > 0 && (
					<View style={localStyles.filterCaption}>
						<ThemedText type="small">{t("registrantListFilterDistrictLabel")}</ThemedText>
						<View style={localStyles.chipRow}>
							{districtOptions.map((option) => (
								<View key={option} testID={"registrants-list-filter-district-" + option}>
									<ChipButton
										label={option}
										icon={option === districtFilter ? "check" : undefined}
										onPress={() => setDistrictFilter((prev) => (prev === option ? undefined : option))}
									/>
								</View>
							))}
						</View>
					</View>
				)}
			</View>

			{!loadingInitial && (
				<View testID="registrants-list-count">
					{/* D-05: there must be no comparison anywhere between rows.length
					    and total, and this line must never be tinted colors.error or
					    colors.warning — the two disagreeing by a row or two under
					    concurrent mutation is not a bug and must get no error
					    treatment. */}
					<ThemedText type="small" style={{ color: colors.textSecondary }}>
						{total !== undefined
							? t("registrantListCountLabel", { shown: rows.length, total })
							: t("registrantListCountUnknown", { shown: rows.length })}
					</ThemedText>
				</View>
			)}

			{loadingInitial ? (
				<View testID="registrants-list-loading">
					{/* Copy-gap: the registrantList* group has no dedicated
					    initial-loading key, and 47-02's contract test pins that
					    group at exactly 15 keys and the phase at 117, so adding one
					    here would turn that suite red. registrantListLoadingMore is
					    reused deliberately; a dedicated registrantListLoading key is
					    a follow-up for a later plan, not a licence to add one now. */}
					<ThemedText type="small" style={{ color: colors.textSecondary }}>
						{t("registrantListLoadingMore")}
					</ThemedText>
				</View>
			) : rows.length === 0 ? (
				hasActiveFilters ? (
					<View testID="registrants-list-empty-filtered">
						<ThemedText type="defaultSemiBold">{t("registrantListEmptyHeading")}</ThemedText>
						<ThemedText type="small" style={{ color: colors.textSecondary }}>
							{t("registrantListEmptyBody")}
						</ThemedText>
					</View>
				) : (
					<View testID="registrants-list-empty-none">
						<ThemedText type="defaultSemiBold">{t("registrantListEmptyHeadingNoFilters")}</ThemedText>
						<ThemedText type="small" style={{ color: colors.textSecondary }}>
							{t("registrantListEmptyBodyNoFilters")}
						</ThemedText>
					</View>
				)
			) : (
				// .map()-in-ScrollView is deliberate: this app has zero
				// virtualized-list-component precedent, and pages are bounded by
				// REGISTRANTS_PAGE_SIZE.
				rows.map((row) => (
					<RegistrantRow
						key={row.registrantId}
						row={row}
						// Identifiers only — never the row object, never the display
						// name. React Navigation params are persisted into navigation
						// state and can surface in crash/debug payloads (T-47-11-03).
						onPress={() =>
							navigation.navigate("RegistrantDetail", { registrantId: row.registrantId, authorityId })
						}
					/>
				))
			)}

			{rows.length > 0 &&
				(loadingMore ? (
					<View testID="registrants-list-loading-more">
						<ThemedText type="small" style={{ color: colors.textSecondary }}>
							{t("registrantListLoadingMore")}
						</ThemedText>
					</View>
				) : nextCursor !== undefined ? (
					<View testID="registrants-list-load-more">
						<ChipButton label={t("registrantListLoadMoreButton")} onPress={loadMore} />
					</View>
				) : (
					<View testID="registrants-list-end-of-list">
						<ThemedText type="small" style={{ color: colors.textSecondary }}>
							{t("registrantListEndOfList")}
						</ThemedText>
					</View>
				))}
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
	chipRow: {
		flexDirection: "row",
		gap: 8,
		flexWrap: "wrap",
		marginTop: 8,
	},
	filterCaption: {
		marginTop: 8,
	},
});

const styles = { ...globalStyles, ...localStyles };
