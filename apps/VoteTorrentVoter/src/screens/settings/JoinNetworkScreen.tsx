/**
 * JoinNetworkScreen — a voter joins an election authority's network from a join code (spike 100).
 *
 * The authority's "Invite voters" card produces the code (`vtjoin1.…`): a cadre invitation plus the
 * network's founding anchor. The voter pastes it here, sees the network's name and fingerprint —
 * which they compare with the fingerprint the authority published — and taps Join. The provider's
 * `joinNetwork` redeems the invitation, opens the network's strand, accepts it only if its founding
 * rows match the code, and makes it the current network.
 *
 * Registered on the Settings, Registration and Timeline stacks (route closure, D-14); it only ever
 * goes back, so it adds no onward routes. Every failure is shown as translated copy chosen by the
 * typed reason — never the engine's own text (it can carry cadre-core error messages). The code
 * holds the invitation's private key (a bearer credential for cadre membership), so nothing here
 * logs it.
 */
import React, {useMemo, useState} from 'react';
import {ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View} from 'react-native';
import {useNavigation, useTheme} from '@react-navigation/native';
import type {ExtendedTheme} from '@react-navigation/native';
import {useTranslation} from 'react-i18next';
import Clipboard from '@react-native-clipboard/clipboard';
import {decodeNetworkJoinCode} from '@votetorrent/vote-engine/rn';
import type {NetworkJoinFailureReason, NetworkJoinStep} from '@votetorrent/vote-engine/rn';
import {useVoterApp} from '../../providers/VoterAppProvider';
import {globalStyles} from '../../theme/styles';
import {errorClassName} from '../../utils/errorClassName';

/** The translated copy for each way a join can fail (keys in the `join` namespace). */
export function joinFailureKey(reason: NetworkJoinFailureReason): string {
	switch (reason) {
		case 'invitation-malformed':
			return 'invalidCode';
		case 'invitation-expired':
			return 'error.invitationExpired';
		case 'not-admitted':
			return 'error.notAdmitted';
		case 'no-peers':
			return 'error.noPeers';
		case 'not-synced':
			return 'error.notSynced';
		case 'digest-mismatch':
			return 'error.digestMismatch';
		case 'open-failed':
			return 'error.openFailed';
		default:
			return 'error.generic';
	}
}

type Phase = {kind: 'idle'} | {kind: 'joining'; step: NetworkJoinStep} | {kind: 'joined'; name: string} | {kind: 'failed'; key: string};

export default function JoinNetworkScreen() {
	const {joinNetwork} = useVoterApp();
	const navigation = useNavigation();
	const {colors, fonts, type: typeScale, radii} = useTheme() as ExtendedTheme;
	const {t} = useTranslation('join');
	const [text, setText] = useState('');
	const [phase, setPhase] = useState<Phase>({kind: 'idle'});

	const decoded = useMemo(() => (text.trim().length === 0 ? null : decodeNetworkJoinCode(text)), [text]);
	const busy = phase.kind === 'joining';

	async function onPaste() {
		const pasted = await Clipboard.getString().catch(() => '');
		if (pasted) {
			setText(pasted);
			setPhase({kind: 'idle'});
		}
	}

	async function onJoin() {
		if (!decoded?.ok || busy) return;
		setPhase({kind: 'joining', step: 'admitting'});
		try {
			const result = await joinNetwork(decoded.code, step => setPhase({kind: 'joining', step}));
			if (result.ok) {
				setPhase({kind: 'joined', name: result.networkRef.name});
			} else {
				// The reason token only; `detail` can carry cadre-core text and is never shown.
				console.warn('JoinNetworkScreen: join refused:', result.reason);
				setPhase({kind: 'failed', key: joinFailureKey(result.reason)});
			}
		} catch (error) {
			console.error('JoinNetworkScreen: join failed:', errorClassName(error));
			setPhase({kind: 'failed', key: 'error.generic'});
		}
	}

	const bodyStyle = {color: colors.text, fontSize: typeScale.body.fontSize, lineHeight: typeScale.body.lineHeight};
	const secondaryStyle = {color: colors.textSecondary, fontSize: typeScale.body.fontSize, lineHeight: typeScale.body.lineHeight};

	if (phase.kind === 'joined') {
		return (
			<ScrollView style={[styles.screen, {backgroundColor: colors.background}]} contentContainerStyle={globalStyles.container}>
				<Text testID="join-network-joined" style={[styles.heading, bodyStyle, {fontFamily: fonts.bold.fontFamily, fontWeight: fonts.bold.fontWeight}]}>
					{t('joinedTitle', {name: phase.name})}
				</Text>
				<Pressable
					testID="join-network-done"
					accessibilityRole="button"
					onPress={() => navigation.goBack()}
					style={[styles.cta, {backgroundColor: colors.primary, borderRadius: radii.pill}]}>
					<Text style={[styles.ctaLabel, {color: colors.light, fontFamily: fonts.bold.fontFamily, fontWeight: fonts.bold.fontWeight}]}>
						{t('doneButton')}
					</Text>
				</Pressable>
			</ScrollView>
		);
	}

	return (
		<ScrollView
			style={[styles.screen, {backgroundColor: colors.background}]}
			contentContainerStyle={globalStyles.container}
			keyboardShouldPersistTaps="handled">
			<Text style={[styles.paragraph, secondaryStyle]}>{t('intro')}</Text>

			<View style={[globalStyles.cardSurface, {backgroundColor: colors.card}]}>
				<View style={styles.labelRow}>
					<Text style={[styles.fieldLabel, secondaryStyle]}>{t('codeLabel')}</Text>
					<Pressable testID="join-network-paste" accessibilityRole="button" onPress={onPaste} disabled={busy} style={styles.pasteButton}>
						<Text style={{color: colors.link, fontSize: typeScale.body.fontSize}}>{t('pasteButton')}</Text>
					</Pressable>
				</View>
				<TextInput
					testID="join-network-code-input"
					value={text}
					editable={!busy}
					onChangeText={value => {
						setText(value);
						if (phase.kind === 'failed') setPhase({kind: 'idle'});
					}}
					placeholder={t('codePlaceholder')}
					placeholderTextColor={colors.textSecondary}
					autoCapitalize="none"
					autoCorrect={false}
					multiline
					style={[
						styles.input,
						{
							color: colors.text,
							borderColor: decoded && !decoded.ok ? colors.error : colors.primary,
							fontFamily: fonts.regular.fontFamily,
							fontSize: typeScale.caption.fontSize,
						},
					]}
				/>
				{decoded && !decoded.ok ? (
					<Text testID="join-network-code-error" style={[styles.fieldError, {color: colors.error, fontSize: typeScale.caption.fontSize}]}>
						{t(decoded.reason === 'unsupported-version' ? 'newerCode' : 'invalidCode')}
					</Text>
				) : null}

				{decoded?.ok ? (
					<View testID="join-network-preview" style={styles.preview}>
						<Text style={secondaryStyle}>{t('previewNetwork')}</Text>
						<Text testID="join-network-preview-name" style={[styles.previewValue, bodyStyle, {fontFamily: fonts.bold.fontFamily, fontWeight: fonts.bold.fontWeight}]}>
							{decoded.code.name}
						</Text>
						<Text style={secondaryStyle}>{t('previewFingerprint')}</Text>
						<Text
							testID="join-network-preview-fingerprint"
							selectable
							style={[styles.previewValue, bodyStyle, {fontFamily: fonts.bold.fontFamily, fontWeight: fonts.bold.fontWeight}]}>
							{decoded.fingerprint}
						</Text>
						<Text style={[styles.paragraph, secondaryStyle]}>{t('previewCheck')}</Text>
					</View>
				) : null}

				{phase.kind === 'failed' ? (
					<Text testID="join-network-error" style={[styles.fieldError, {color: colors.error, fontSize: typeScale.body.fontSize}]}>
						{t(phase.key)}
					</Text>
				) : null}

				{phase.kind === 'joining' ? (
					<View testID="join-network-progress" style={styles.progress}>
						<ActivityIndicator color={colors.primary} />
						<Text testID="join-network-step" style={[styles.progressLabel, secondaryStyle]}>
							{t(`step.${phase.step}`)}
						</Text>
					</View>
				) : (
					<Pressable
						testID="join-network-submit"
						accessibilityRole="button"
						accessibilityState={{disabled: !decoded?.ok}}
						disabled={!decoded?.ok}
						onPress={onJoin}
						style={[
							styles.cta,
							{backgroundColor: decoded?.ok ? colors.primary : colors.secondaryButtonSurface, borderRadius: radii.pill},
						]}>
						<Text
							style={[
								styles.ctaLabel,
								{
									color: decoded?.ok ? colors.light : colors.textSecondary,
									fontFamily: fonts.bold.fontFamily,
									fontWeight: fonts.bold.fontWeight,
								},
							]}>
							{t('joinButton')}
						</Text>
					</Pressable>
				)}
			</View>
		</ScrollView>
	);
}

const styles = StyleSheet.create({
	screen: {
		flex: 1,
	},
	paragraph: {
		marginBottom: 16, // md
	},
	heading: {
		marginBottom: 16,
	},
	labelRow: {
		flexDirection: 'row',
		justifyContent: 'space-between',
		alignItems: 'center',
	},
	fieldLabel: {
		marginBottom: 8, // sm
	},
	pasteButton: {
		minHeight: 44,
		minWidth: 44,
		justifyContent: 'center',
		alignItems: 'flex-end',
	},
	input: {
		borderWidth: 1,
		borderRadius: 8,
		paddingHorizontal: 12,
		paddingVertical: 12,
		minHeight: 96,
		textAlignVertical: 'top',
	},
	fieldError: {
		marginTop: 8,
	},
	preview: {
		marginTop: 16,
	},
	previewValue: {
		marginBottom: 12,
	},
	progress: {
		marginTop: 16,
		flexDirection: 'row',
		alignItems: 'center',
		minHeight: 44,
	},
	progressLabel: {
		marginLeft: 12,
		flexShrink: 1,
	},
	cta: {
		marginTop: 16,
		minHeight: 44,
		alignItems: 'center',
		justifyContent: 'center',
		paddingHorizontal: 24,
	},
	ctaLabel: {
		fontWeight: '600',
	},
});
