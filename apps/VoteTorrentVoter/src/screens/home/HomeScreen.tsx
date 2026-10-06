/**
 * HomeScreen — Vote tab root (D-07 per-domain screen file). Reads through `useVoterApp()`
 * (D-06 / SHELL-03 — no direct fixture-module import), fetches the election on mount and
 * whenever the `__DEV__` lifecycle override changes, and composes the real `ElectionCard` (Phase
 * 40, HOME-01/02/03) once loaded — or an unavailable message when there is no election to read.
 * Also hosts the `__DEV__`-gated lifecycle cycler (D-03): it steps live -> each forced state ->
 * back to live. Dev-only affordance, compiled out of release builds.
 *
 * HomeScreen remains the only `useVoterApp()` caller on this surface (SHELL-03) — `ElectionCard`
 * is presentational (election prop + navigation callback props), never reading the provider or
 * `useNavigation()` itself (RESEARCH.md Anti-Patterns).
 *
 * Phase 44-07 (D-02): `hasVoted` is no longer a `useVoterApp()` context field (the mock booleans
 * were removed alongside the registration-flow real-engine swap) — it is now local, session-only
 * component state, mirroring `ReviewSubmitScreen`'s own local `submitted` flag. This is a
 * deliberate, documented simplification (not a silent regression): Phase 44's scope is the
 * registration flow only (44-CONTEXT.md Phase Boundary), so cross-screen vote-status sync via a
 * shared real engine read is deferred to the phase that swaps the ballot/vote surface for real.
 */
import React, {useCallback, useEffect, useState} from 'react';
import {Pressable, ScrollView, StyleSheet, Text, View} from 'react-native';
import {useNavigation, useTheme} from '@react-navigation/native';
import type {ExtendedTheme} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import {useTranslation} from 'react-i18next';
import {useVoterApp} from '../../providers/VoterAppProvider';
import {LIFECYCLE_ORDER} from '../../providers/types';
import type {LifecycleState, VoterElection} from '../../providers/types';
import type {VoteStackParamList} from '../../navigation/types';
import {ElectionCard} from '../../components/ElectionCard';
import {NetworkHeader} from '../../components/NetworkHeader';
import {ConfigFaultNotice} from '../../components/ConfigFaultNotice';
import {InfoDialog} from '../../components/InfoDialog';
import {InfoDetails} from '../../components/InfoDetails';
import {readElectionInfo} from '../../engines/info-read';
import {useInfoRead} from '../../hooks/useInfoRead';

type HomeNavigationProp = NativeStackNavigationProp<VoteStackParamList, 'Home'>;

export default function HomeScreen() {
	// D-06/SHELL-03: every screen routes through useVoterApp() — no inline fixture-module import.
	const {isInitialized, lifecycleOverride, setLifecycleOverride, clockOffsetMs, getElection, getEngine, seededElectionId} = useVoterApp();
	const {colors, type: typeScale} = useTheme() as ExtendedTheme;
	const {t, i18n} = useTranslation('home');
	const {t: tCommon} = useTranslation('common');
	const navigation = useNavigation<HomeNavigationProp>();
	const [election, setElection] = useState<VoterElection | null>(null);
	const [unavailable, setUnavailable] = useState(false);
	const [electionInfoVisible, setElectionInfoVisible] = useState(false);
	// Phase 44-07 (D-02): local session-only flag — see file header comment.
	const [hasVoted] = useState(false);
	// The election dialog's authority-published detail, read only while the dialog is open.
	const loadElectionInfo = useCallback(
		() => readElectionInfo({getEngine, fallbackElectionId: __DEV__ ? seededElectionId : undefined}),
		[getEngine, seededElectionId],
	);
	const electionInfo = useInfoRead(electionInfoVisible ? loadElectionInfo : null);
	const info = electionInfo.data;

	// Fetch on mount and re-fetch whenever the override changes — getElection's identity changes
	// with lifecycleOverride (VoterAppProvider's useCallback deps), so this effect naturally
	// re-runs on every cycler step (and on a shared dev-clock shift, D-02). A rejected read (no election on this network, or an
	// indeterminate timeline) renders the unavailable message, never a stale or guessed card.
	useEffect(() => {
		let live = true;
		getElection().then(
			result => {
				if (live) {
					setElection(result);
					setUnavailable(false);
				}
			},
			() => {
				if (live) {
					setElection(null);
					setUnavailable(true);
				}
			},
		);
		return () => {
			live = false;
		};
	}, [getElection]);

	// live -> LIFECYCLE_ORDER[0] -> ... -> LIFECYCLE_ORDER[last] -> live.
	const nextLifecycleOverride = () => {
		const currentIndex = lifecycleOverride === null ? -1 : LIFECYCLE_ORDER.indexOf(lifecycleOverride);
		const next: LifecycleState | null =
			currentIndex + 1 < LIFECYCLE_ORDER.length ? LIFECYCLE_ORDER[currentIndex + 1] : null;
		setLifecycleOverride(next);
	};

	return (
		<View style={[styles.screen, {backgroundColor: colors.background}]}>
			<NetworkHeader />
			<ConfigFaultNotice />

			<ScrollView contentContainerStyle={styles.content}>
				{isInitialized && election ? (
					<ElectionCard
						election={election}
						onVoteNow={() => navigation.navigate('Ballot')}
						onViewValidationDetails={() => navigation.navigate('ValidationDetails')}
						onLearnAboutElection={() => setElectionInfoVisible(true)}
						hasVoted={hasVoted}
						nowOffsetMs={clockOffsetMs}
					/>
				) : null}

				{isInitialized && unavailable ? (
					<Text
						testID="home-election-unavailable"
						style={{color: colors.textSecondary, fontSize: typeScale.body.fontSize, lineHeight: typeScale.body.lineHeight}}>
						{t('electionUnavailable')}
					</Text>
				) : null}

				{/* D-03: __DEV__-gated lifecycle cycler — never ships to release builds. Dev-only
				    text, deliberately not localized (it is not user-facing copy). */}
				{__DEV__ && isInitialized ? (
					<Pressable testID="home-dev-lifecycle-cycler" onPress={nextLifecycleOverride} style={styles.devCycler}>
						<Text style={{color: colors.muted, fontSize: typeScale.caption.fontSize}}>
							Dev state: {lifecycleOverride ?? 'live'} (tap to cycle)
						</Text>
					</Pressable>
				) : null}
			</ScrollView>

			<InfoDialog
				visible={electionInfoVisible}
				title={t('electionInfo.title')}
				subtitle={t('electionInfo.subtitle')}
				body={t('electionInfo.body')}
				closeLabel={tCommon('close')}
				onClose={() => setElectionInfoVisible(false)}>
				<InfoDetails
					testID="election-info-details"
					loading={electionInfo.loading}
					failed={electionInfo.failed}
					unavailableLabel={tCommon('info.unavailable')}
					rows={[
						{label: t('electionInfo.authority'), value: info?.authorityName},
						{label: t('electionInfo.date'), value: info ? formatElectionDay(info.date, i18n.language) : undefined},
						{label: t('electionInfo.instructions'), value: info?.instructions},
						{label: t('electionInfo.tags'), value: info?.tags.join(', ')},
					]}
				/>
			</InfoDialog>
		</View>
	);
}

/** `Election.Date` is a DAY stored as a datetime at UTC midnight — format it in UTC so a voter west
 *  of Greenwich doesn't see the day before. */
function formatElectionDay(ms: number, language: string): string {
	return new Intl.DateTimeFormat(language, {timeZone: 'UTC', year: 'numeric', month: 'long', day: 'numeric'}).format(new Date(ms));
}

const styles = StyleSheet.create({
	screen: {
		flex: 1,
	},
	content: {
		padding: 16,
	},
	devCycler: {
		alignSelf: 'center',
		paddingVertical: 8,
	},
});
