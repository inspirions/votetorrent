/**
 * RegistrationScreen — Registration tab root. Renders the branded blue NetworkHeader (Figma) then
 * the not-registered / registered RegistrationCard, reading draft from useRegistrationDraft().
 * Card callbacks map to navigation: Register now -> DeviceAttestation, Update registration ->
 * RegisterPersonal, (?) help -> RegistrationInfo.
 *
 * Phase 44-07 (D-02): `isRegistered`/`registeredAt` are no longer `useVoterApp()` context fields
 * (the mock booleans were removed alongside the registration-flow real-engine swap) — they are now
 * local, session-only component state (same shape/behavior as the old context setter: flipping
 * true freezes `registeredAt` to the confirm-time ISO timestamp). This is a deliberate, documented
 * simplification: deriving real registration status from the engine's `Registrant` rows is a later
 * phase's concern (44-CONTEXT.md Phase Boundary scopes this phase to the registration FLOW, not
 * the status-read surface).
 *
 * headerShown:false for RegistrationHome (navigation/index.tsx) — NetworkHeader replaces the plain
 * native header. A __DEV__-gated isRegistered toggle is kept for manual QA (compiled out of release).
 *
 * Phase 62 Plan 28 (D-40/D-45) addition: below the card, a `useFocusEffect`-driven read of
 * `resolveRegistrationCodeAvailability` offers 'available' -> the show-again link (re-resolves
 * fresh on tap, never cached — 59 D-23), 'not-registered' -> `newDevice.entryLink` into
 * `ContinueOnAnotherDevice`, 'not-sent'/'not-holder'/'unavailable' -> the code-unavailable notice,
 * and an unsettled read (null) -> a distinct "checking" line, so "still loading" is never visually
 * identical to "settled with nothing to show" (UAT 62 test 14: a settled 'unavailable' rendered
 * nothing and read as a hang).
 * Known limitation (flagged in the plan SUMMARY): this read is independent of the session-only
 * `isRegistered` toggle above, so a toggled-off approved device can show the not-registered card
 * alongside "Show my registration code".
 */
import React, {useCallback, useState} from 'react';
import {Pressable, ScrollView, StyleSheet, Text, View} from 'react-native';
import {useFocusEffect, useNavigation, useTheme} from '@react-navigation/native';
import type {ExtendedTheme} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import {useTranslation} from 'react-i18next';
import {useVoterApp} from '../../providers/VoterAppProvider';
import {useRegistrationDraft} from '../../providers/RegistrationDraftProvider';
import {resolveAttestationProducer} from '../../engines/attestation-producer';
import {resolveRegistrationCodeAvailability} from '../../engines/continuity';
import type {RegistrationCodeAvailability} from '../../engines/continuity';
import {RegistrationConfirmationCodeCard} from './RegistrationConfirmationCodeCard';
import type {RegistrationStackParamList} from '../../navigation/types';
import {RegistrationCard} from '../../components/RegistrationCard';
import {NetworkHeader} from '../../components/NetworkHeader';

type RegistrationNavigationProp = NativeStackNavigationProp<
	RegistrationStackParamList,
	'RegistrationHome'
>;

export default function RegistrationScreen() {
	// D-06/SHELL-03: every screen routes through useVoterApp() — no inline fixture-module import.
	const {isInitialized, getEngine} = useVoterApp();
	const {draft} = useRegistrationDraft();
	// Phase 44-07 (D-02): local session-only state — see file header comment.
	const [isRegistered, setIsRegisteredState] = useState(false);
	const [registeredAt, setRegisteredAt] = useState<string | null>(null);
	const setIsRegistered = useCallback((value: boolean) => {
		setIsRegisteredState(value);
		if (value) {
			setRegisteredAt(new Date().toISOString());
		}
	}, []);
	const {colors, type: typeScale} = useTheme() as ExtendedTheme;
	const navigation = useNavigation<RegistrationNavigationProp>();
	const {t} = useTranslation('continuity');

	const [codeAvailability, setCodeAvailability] = useState<RegistrationCodeAvailability | null>(null);
	// Explicit, voter-initiated reveal (D-23/D-45) — set only by the showAgainLink tap below, and
	// cleared on blur so a return visit is a fresh, un-revealed state, never a stale one.
	const [revealed, setRevealed] = useState<RegistrationCodeAvailability | null>(null);

	useFocusEffect(
		useCallback(() => {
			let cancelled = false;
			(async () => {
				const result = await resolveRegistrationCodeAvailability({
					getEngine,
					getCurrentDeviceKey: () => resolveAttestationProducer().getCurrentDeviceKey(),
				});
				if (!cancelled) setCodeAvailability(result);
			})();
			return () => {
				cancelled = true;
				setRevealed(null);
			};
			// eslint-disable-next-line react-hooks/exhaustive-deps
		}, [getEngine]),
	);

	async function onShowAgain() {
		const result = await resolveRegistrationCodeAvailability({
			getEngine,
			getCurrentDeviceKey: () => resolveAttestationProducer().getCurrentDeviceKey(),
		});
		setRevealed(result);
	}

	return (
		<View style={[styles.screen, {backgroundColor: colors.background}]}>
			<NetworkHeader onPressNetwork={() => navigation.navigate('RegistrationInfo')} />

			<ScrollView contentContainerStyle={styles.content}>
				{isInitialized ? (
					<RegistrationCard
						isRegistered={isRegistered}
						draft={draft}
						registeredAt={registeredAt}
						onRegisterNow={() => navigation.navigate('DeviceAttestation')}
						onUpdateRegistration={() => navigation.navigate('RegisterPersonal')}
						onHelp={() => navigation.navigate('RegistrationInfo')}
					/>
				) : null}

				{codeAvailability?.kind === 'available' ? (
					<View style={styles.codeSection}>
						<Pressable testID="registration-code-show-again-link" onPress={onShowAgain} style={styles.link}>
							<Text style={[styles.linkText, {color: colors.link, fontSize: typeScale.body.fontSize}]}>
								{t('code.showAgainLink')}
							</Text>
						</Pressable>
						{revealed ? (
							<RegistrationConfirmationCodeCard
								state={revealed.kind === 'available' ? {kind: 'code', code: revealed.code} : {kind: 'unavailable'}}
							/>
						) : null}
					</View>
				) : codeAvailability?.kind === 'not-registered' ? (
					<View style={styles.codeSection}>
						<Pressable
							testID="continue-device-entry-link"
							onPress={() => navigation.navigate('ContinueOnAnotherDevice')}
							style={styles.link}>
							<Text style={[styles.linkText, {color: colors.link, fontSize: typeScale.body.fontSize}]}>
								{t('newDevice.entryLink')}
							</Text>
						</Pressable>
					</View>
				) : codeAvailability?.kind === 'not-sent' ||
				  codeAvailability?.kind === 'not-holder' ||
				  codeAvailability?.kind === 'unavailable' ? (
					<View style={styles.codeSection}>
						<Text
							testID="registration-code-not-available"
							style={{color: colors.textSecondary, fontSize: typeScale.body.fontSize}}>
							{t('code.notAvailableOnDevice')}
						</Text>
					</View>
				) : codeAvailability === null && isInitialized ? (
					<View style={styles.codeSection}>
						<Text
							testID="registration-code-checking"
							style={{color: colors.textSecondary, fontSize: typeScale.body.fontSize}}>
							{t('code.checking')}
						</Text>
					</View>
				) : null}

				{/* D-03: __DEV__-gated isRegistered toggle — manual QA only, never ships to release. */}
				{__DEV__ && isInitialized ? (
					<Pressable
						onPress={() => setIsRegistered(!isRegistered)}
						style={styles.devToggle}
						testID="registration-dev-toggle">
						<Text style={{color: colors.muted, fontSize: typeScale.caption.fontSize}}>
							Toggle isRegistered (dev): {String(isRegistered)}
						</Text>
					</Pressable>
				) : null}
			</ScrollView>
		</View>
	);
}

const styles = StyleSheet.create({
	screen: {
		flex: 1,
	},
	content: {
		padding: 16,
	},
	codeSection: {
		marginTop: 16, // md
	},
	link: {
		minHeight: 44,
		justifyContent: 'center',
	},
	linkText: {},
	devToggle: {
		alignSelf: 'center',
		paddingVertical: 8,
	},
});
