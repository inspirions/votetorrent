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
import {useTheme} from '@react-navigation/native';
import type {ExtendedTheme} from '@react-navigation/native';
import {useTranslation} from 'react-i18next';
import type {ElectionSummary, IElectionsEngine} from '@votetorrent/vote-core';
import {useVoterApp} from '../../providers/VoterAppProvider';
import {TimelineRail} from '../../components/TimelineRail';
import {deriveTimeline} from '../../timeline';
import type {TimelineViewModelConfident} from '../../timeline';

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

type ScreenState =
	| {kind: 'loading'}
	| {kind: 'ready'; title: string; date: number; view: TimelineViewModelConfident}
	| {kind: 'indeterminate'};

export default function TimelineScreen() {
	// D-06/SHELL-03 (mirrors HomeScreen.tsx): every screen routes through useVoterApp() — no
	// inline mock-data-module import, and no direct election-record read either (D-04 read-scope
	// fence: this screen touches only the engine chain below).
	const {getEngine, seededElectionId} = useVoterApp();
	const {colors, type: typeScale} = useTheme() as ExtendedTheme;
	const {t} = useTranslation('timeline');
	// eslint-disable-next-line @typescript-eslint/no-unused-vars -- bound here per D-20; consumed
	// by the stage-details InfoDialog this screen composes alongside the rail.
	const {t: tCommon} = useTranslation('common');

	const [state, setState] = useState<ScreenState>({kind: 'loading'});
	const [reloadNonce, setReloadNonce] = useState(0);

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

	return (
		<ScrollView style={[styles.screen, {backgroundColor: colors.background}]} contentContainerStyle={styles.content}>
			<TimelineRail rows={state.view.rows} />
		</ScrollView>
	);
}

const styles = StyleSheet.create({
	screen: {
		flex: 1,
	},
	content: {
		padding: 16,
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
