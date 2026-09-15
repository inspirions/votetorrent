/**
 * TimelineScreen (Phase 59, plan 59-08) — the Timeline tab's root screen, and the voter app's
 * FIRST real election read (D-01; Phase 44 swapped only the registration flow). This screen owns
 * the provider read and nothing else owns it: it resolves the election identity (D-02), reads
 * `current.timeline` through the engine chain `getEngine('elections')` -> `getElections()` ->
 * `openElection(id)` -> `getElectionDetails()`, hands the raw blob to 59-06's pure
 * `deriveTimeline()` adapter, and composes 59-07's presentational `TimelineRail`. When the answer
 * is not trustworthy it says so out loud and replaces the rail entirely (D-03) — never a partial
 * rail, never a blank tab.
 *
 * Read scope is narrow by construction (D-04): `details.election.title`, `details.election.date`
 * and `details.current.timeline` only. The voter app's mock lifecycle-content surface (the Home
 * tab's own election card and its per-state fixture data, D-12) is never referenced here — that
 * surface keeps consuming the mock data it always has, unchanged.
 *
 * `TimelineRail` / `TimelineRow` stay presentational (props only) — this file is the one place on
 * this surface that calls `useVoterApp()` and `useNavigation()`.
 */
import React, {useEffect, useState} from 'react';
import {Pressable, ScrollView, StyleSheet, Text, View} from 'react-native';
import {useNavigation, useTheme} from '@react-navigation/native';
import type {ExtendedTheme} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import {useTranslation} from 'react-i18next';
import type {ElectionSummary, IElectionsEngine} from '@votetorrent/vote-core';
import {useVoterApp} from '../../providers/VoterAppProvider';
import {TimelineRail} from '../../components/TimelineRail';
import {InfoDialog} from '../../components/InfoDialog';
import i18n from '../../i18n';
import type {TimelineStackParamList} from '../../navigation/types';
import {STAGE_TITLE_KEY, deriveTimeline} from '../../timeline';
import type {TimelineStageId, TimelineViewModelConfident} from '../../timeline';

/**
 * D-02's election-identity rule, exported as a pure helper so it is testable without rendering.
 * `ElectionsEngine.getElections()` filters `where E.Date >= :now` (elections-engine.ts:474), so
 * every summary this function ever receives is already in the FUTURE — picking the summary
 * nearest to now is therefore picking the soonest upcoming election, not "most recent" in the
 * sense of "just happened". Ties broken by ascending `id` for determinism. The single-summary
 * case (today's dev seed and every current deployment) is identical under either reading; the
 * multi-election surface (an election picker) is a deferred phase — see 59-CONTEXT.md Deferred
 * Ideas.
 *
 * `fallbackId` is passed as `__DEV__ ? seededElectionId : undefined` at the call site so the
 * `__DEV__` gate lives in one visible place: `seededElectionId` is `undefined` in every release
 * build (`providers/types.ts:203-209`), so relying on it alone would render an empty tab in
 * production.
 */
export function pickElectionId(summaries: ElectionSummary[], fallbackId: string | undefined): string | undefined {
	if (summaries.length === 0) {
		return fallbackId;
	}
	if (summaries.length === 1) {
		return summaries[0].id;
	}

	const nowMs = Date.now();
	let best: ElectionSummary | undefined;
	let bestDiff = Number.POSITIVE_INFINITY;
	for (const summary of summaries) {
		const diff = Math.abs(summary.date - nowMs);
		if (diff < bestDiff || (diff === bestDiff && best !== undefined && summary.id < best.id)) {
			best = summary;
			bestDiff = diff;
		}
	}
	return best?.id;
}

export interface HeaderDateRangeParts {
	startDate: string;
	endDate: string;
	// Index signature so this type structurally satisfies i18next's `t(key, options)` params
	// bag (`$Dictionary`) -- a plain interface without one fails TS2345 at the `t()` call site.
	[key: string]: string;
}

/** Numeric `YYYY-MM-DD` calendar-day key for `ms` in `timeZone`, read back from
 * `Intl.DateTimeFormat.formatToParts` (never a formatted/localized string) — mirrors
 * `src/timeline/relative-date.ts`'s `dateParts` idiom. Locale-independent (uses `'en'`
 * regardless of the caller's display language) because this key is used only for equality
 * comparisons, never rendered. */
function calendarDayKey(ms: number, timeZone: string): string {
	const parts = new Intl.DateTimeFormat('en', {timeZone, year: 'numeric', month: '2-digit', day: '2-digit'}).formatToParts(new Date(ms));
	const get = (type: string) => parts.find(p => p.type === type)?.value ?? '';
	return `${get('year')}-${get('month')}-${get('day')}`;
}

/** The active-language `"March 20"`-shaped month-name-plus-day string for `ms`, or just the
 * bare day number when `dayOnly` is set (the UI-SPEC's "endDate is the day number alone" same-
 * month case). Built from `formatToParts`, never string concatenation of a formatted date. */
function formatHeaderDay(ms: number, language: string, timeZone: string, dayOnly: boolean): string {
	const options: Intl.DateTimeFormatOptions = dayOnly ? {timeZone, day: 'numeric'} : {timeZone, month: 'long', day: 'numeric'};
	const parts = new Intl.DateTimeFormat(language, options).formatToParts(new Date(ms));
	if (dayOnly) {
		return parts.find(p => p.type === 'day')?.value ?? '';
	}
	const month = parts.find(p => p.type === 'month')?.value ?? '';
	const day = parts.find(p => p.type === 'day')?.value ?? '';
	return `${month} ${day}`;
}

/**
 * UI-SPEC `header.dateRange` (D-20 discretion): the earliest/latest PRESENT timeline instants
 * (59-06's `rangeStartMs`/`rangeEndMs`), formatted in the active i18n language. Returns `null`
 * when the present instants collapse to a single calendar day — the date-range line is then
 * omitted entirely rather than rendering "March 20 - March 20" (a 7-of-10-key timeline still
 * produces a range from its seven present instants; it is not this function's job to decide
 * whether the INPUT was indeterminate, only whether the range is degenerate).
 */
export function computeHeaderDateRange(rangeStartMs: number, rangeEndMs: number, language: string, timeZone = 'UTC'): HeaderDateRangeParts | null {
	const startKey = calendarDayKey(rangeStartMs, timeZone);
	const endKey = calendarDayKey(rangeEndMs, timeZone);
	if (startKey === endKey) {
		return null;
	}

	const sameMonthAndYear = startKey.slice(0, 7) === endKey.slice(0, 7); // 'YYYY-MM' prefix
	return {
		startDate: formatHeaderDay(rangeStartMs, language, timeZone, false),
		endDate: formatHeaderDay(rangeEndMs, language, timeZone, sameMonthAndYear),
	};
}

type ScreenState =
	| {kind: 'loading'}
	| {kind: 'ready'; title: string; date: number; view: TimelineViewModelConfident}
	| {kind: 'indeterminate'};

export default function TimelineScreen() {
	// D-06/SHELL-03 (mirrors HomeScreen.tsx): every screen routes through useVoterApp() — no
	// inline mock-data-module import, and no direct election-record read either (D-04 read-scope
	// fence: this screen touches only the engine chain below).
	const {getEngine, seededElectionId} = useVoterApp();
	const {colors, fonts, type: typeScale} = useTheme() as ExtendedTheme;
	const {t} = useTranslation('timeline');
	const {t: tCommon} = useTranslation('common');
	const navigation = useNavigation<NativeStackNavigationProp<TimelineStackParamList, 'TimelineHome'>>();

	const [state, setState] = useState<ScreenState>({kind: 'loading'});
	const [reloadNonce, setReloadNonce] = useState(0);
	// D-20 discretion: neither `see details` nor the row `?` help affordance has a Details route
	// (59-05 fixed the Timeline stack's param list at five entries) or its own copy, so both open
	// the same in-place InfoDialog HomeScreen already uses for `onLearnAboutElection` — modal,
	// not a push, and no new i18n key.
	const [dialogStageId, setDialogStageId] = useState<TimelineStageId | null>(null);

	// HomeScreen.tsx:50-61's `let live = true` cancellation-guard shape, exactly: an async IIFE
	// inside the effect, every set* call guarded by `live`, `live = false` in the cleanup. One
	// try/catch over the WHOLE chain — any rejection anywhere (getEngine, getElections,
	// openElection, getElectionDetails, or the derivation throwing) lands in the indeterminate
	// state, never a partial render.
	useEffect(() => {
		let live = true;

		(async () => {
			try {
				const electionsEngine = await getEngine<IElectionsEngine>('elections');
				const summaries = await electionsEngine.getElections();
				const electionId = pickElectionId(summaries, __DEV__ ? seededElectionId : undefined);

				if (!electionId) {
					if (live) setState({kind: 'indeterminate'});
					return;
				}

				const electionEngine = await electionsEngine.openElection(electionId);
				const details = await electionEngine.getElectionDetails();

				const view = deriveTimeline({
					timeline: details.current.timeline,
					now: Date.now(),
					election: {
						ballotDeadline: details.election.ballotDeadline,
						date: details.election.date,
					},
				});

				if (view.indeterminate) {
					if (live) setState({kind: 'indeterminate'});
					return;
				}

				if (live) {
					setState({kind: 'ready', title: details.election.title, date: details.election.date, view});
				}
			} catch {
				// Any rejection in the chain above (getEngine/getElections/openElection/
				// getElectionDetails) lands here — D-03's explicit indeterminate path, never silence.
				if (live) setState({kind: 'indeterminate'});
			}
		})();

		return () => {
			live = false;
		};
	}, [getEngine, seededElectionId, reloadNonce]);

	if (state.kind === 'indeterminate') {
		return (
			<View testID="timeline-indeterminate" style={[styles.screen, styles.centered, {backgroundColor: colors.background}]}>
				<Text
					testID="timeline-indeterminate-heading"
					style={{color: colors.error, fontSize: typeScale.h4.fontSize, lineHeight: typeScale.h4.lineHeight}}>
					{t('indeterminate.heading')}
				</Text>
				<Text
					testID="timeline-indeterminate-body"
					style={{color: colors.error, fontSize: typeScale.body.fontSize, lineHeight: typeScale.body.lineHeight, marginTop: 8}}>
					{t('indeterminate.body')}
				</Text>
				<Pressable
					testID="timeline-indeterminate-retry"
					accessibilityRole="button"
					style={styles.retry}
					onPress={() => setReloadNonce(n => n + 1)}>
					<Text style={{color: colors.error, fontSize: typeScale.body.fontSize, lineHeight: typeScale.body.lineHeight}}>
						{t('indeterminate.retryCta')}
					</Text>
				</Pressable>
			</View>
		);
	}

	if (state.kind === 'loading') {
		// Loading is a THIRD, distinct state — neither the rail nor the indeterminate frame renders
		// before the first read resolves (flashing the error frame first would be its own defect).
		return <View testID="timeline-loading" style={[styles.screen, {backgroundColor: colors.background}]} />;
	}

	// From here on `state.kind === 'ready'` is narrowed for the rest of the render (both earlier
	// branches returned above).
	const dateRange = computeHeaderDateRange(state.view.rangeStartMs, state.view.rangeEndMs, i18n.language);
	const dialogRow = dialogStageId ? state.view.rows.find(row => row.stageId === dialogStageId) : undefined;
	const dialogSubtitle = dialogRow
		? dialogRow.railLabel.kind === 'date'
			? dialogRow.railLabel.text
			: dialogRow.railLabel.kind === 'now'
				? t('rail.now')
				: ''
		: '';
	const dialogBody = dialogRow?.subtitle ? t(dialogRow.subtitle.key, dialogRow.subtitle.params) : '';

	return (
		<>
			<ScrollView style={[styles.screen, {backgroundColor: colors.background}]} contentContainerStyle={styles.content}>
				<View testID="timeline-header" style={styles.header}>
					<Text
						testID="timeline-header-title"
						style={{
							color: colors.text,
							fontFamily: fonts.regular.fontFamily,
							fontWeight: fonts.regular.fontWeight,
							fontSize: typeScale.h2.fontSize,
							lineHeight: typeScale.h2.lineHeight,
						}}>
						{state.title}
					</Text>
					{dateRange ? (
						<Text
							testID="timeline-header-date-range"
							style={{
								color: colors.textSecondary,
								fontFamily: fonts.regular.fontFamily,
								fontWeight: fonts.regular.fontWeight,
								fontSize: typeScale.body.fontSize,
								lineHeight: typeScale.body.lineHeight,
								marginTop: 8,
							}}>
							{t('header.dateRange', dateRange)}
						</Text>
					) : null}
				</View>

				<TimelineRail
					rows={state.view.rows}
					onHelp={stageId => setDialogStageId(stageId)}
					onSeeDetails={stageId => setDialogStageId(stageId)}
					onEditRegistration={() => navigation.navigate('RegistrationHome')}
					onViewRegistration={() => navigation.navigate('RegistrationHome')}
					onPreviewBallot={() => navigation.navigate('Ballot')}
					onVoteNow={() => navigation.navigate('Ballot')}
					onViewSubmission={() => navigation.navigate('ReviewSubmit')}
					onViewKeyholders={() => navigation.navigate('Keyholders')}
				/>
			</ScrollView>

			<InfoDialog
				visible={dialogStageId !== null}
				title={dialogStageId ? t(STAGE_TITLE_KEY[dialogStageId]) : ''}
				subtitle={dialogSubtitle}
				body={dialogBody}
				closeLabel={tCommon('close')}
				onClose={() => setDialogStageId(null)}
			/>
		</>
	);
}

const styles = StyleSheet.create({
	screen: {
		flex: 1,
	},
	content: {
		padding: 16,
	},
	header: {
		paddingHorizontal: 8,
		paddingBottom: 16,
	},
	centered: {
		justifyContent: 'center',
		alignItems: 'center',
		paddingHorizontal: 24,
	},
	retry: {
		marginTop: 24,
		minHeight: 44,
		justifyContent: 'center',
	},
});
