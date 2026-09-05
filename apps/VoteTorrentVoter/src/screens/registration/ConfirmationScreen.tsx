/**
 * ConfirmationScreen (D-01/D-02/D-03/D-05/D-07/D-08/D-09/D-11/D-12/D-18) — the Face-ID confirmation
 * screen. The "Confirm with Face ID" tap IS the deliberate confirming gesture (D-05), not decorative
 * or an auto-advance. `navigation.popToTop()` clears the whole `DeviceAttestation → RegisterPersonal
 * → RegisterAddressParty → RegisterConfirm → Confirmation` chain in one call (41-RESEARCH.md
 * Pattern 5) — NOT `navigate('RegistrationHome')`, which would leave that entire chain on the back
 * stack.
 *
 * Plan 11 (D-07 — the whole point of this phase) — REWRITTEN: the voter no longer runs the
 * authority's admin-signed ceremony for either the register step or the associate step.
 * `doc/registration.md:10/:105/:119` puts issuing the challenge, verifying the produced attestation,
 * signing and writing on the AUTHORITY's side; the voter's job is to SUBMIT self-signed requests and
 * an answer, never to sign as an officer. The officer signer (`useVoterApp().sign`) is deliberately
 * not even destructured in this file — it must not appear anywhere in this ceremony.
 *
 * The ceremony (order matters — the biometric-last property, D-06/D-15/D-16, is unchanged):
 *   1. `provisionDeviceKey()` — resolves the hardware-backed P-256 public key BEFORE any request is
 *      submitted. Idempotent; does NOT prompt biometric.
 *   2. Map the shared draft onto `RegisterInit` tiers (unchanged tier mapping / WR-04).
 *   3. Submit a self-signed registration-request document through the REST transport
 *      (`attach-voter-request-transport.ts`), signed under the voter's OWN secp256k1 device
 *      identity — never the officer signer.
 *   4. Submit a self-signed association-request document bound to the P-256 device key, then poll
 *      (bounded, no timer-based background poller) for the authority's challenge-issued decision
 *      notice — never calling the authority's challenge-issuing engine method directly.
 *   5. `producer.produce(challenge)` — the D-11 second step; this is where BiometricPrompt fires
 *      ("Confirm with Face ID"). Its position is UNCHANGED: after the challenge is obtained, before
 *      the attestation answer is submitted.
 *   6. Submit the self-signed attestation-answer document. The screen does NOT wait for a further
 *      approved/rejected decision — the authority's automatic driver is triggered separately (by
 *      "Sync Now" elsewhere), not by this submission — so it shows an honest PENDING state instead
 *      of claiming a success it cannot yet prove.
 *
 * D-12: the voter proposes NO expiration for a record the authority signs. `RegisterInit` still
 * requires an `expiration` field on `registrant`/`private`/`selective` (the type is unchanged this
 * phase); a clearly-named placeholder is passed and IGNORED — the authority's approval path
 * overrides it with its own policy-derived value before ever creating the Registrant record.
 *
 * On any thrown step, `classifyAttestationFailure(err)` (D-09) drives the failure UX exactly as
 * before: `'recoverable-action'` renders a setup prompt + retry reusing the same `registrantId`
 * (WR-02); `'recoverable-transient'` renders a generic retry; `'terminal'` (release-only) renders a
 * terminal message with no retry. Classified copy is generic by design — raw reject codes / internal
 * error messages never reach the UI.
 */
import React, {useRef, useState} from 'react';
import {Linking, Pressable, StyleSheet, Text, View} from 'react-native';
import {useNavigation, useTheme} from '@react-navigation/native';
import type {ExtendedTheme} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import {useTranslation} from 'react-i18next';
import FontAwesome6 from 'react-native-vector-icons/FontAwesome6';
import type {
	AssociationAttestationAnswer,
	AssociationRequestInit,
	AttestationChallenge,
	INetworkEngine,
	PrivateDetail,
	RegisterInit,
	RegistrationRequestInit,
	Signature,
} from '@votetorrent/vote-core';
import {useVoterApp} from '../../providers/VoterAppProvider';
import {useRegistrationDraft} from '../../providers/RegistrationDraftProvider';
import {getOrCreateDeviceUser} from '../../engines/device-user';
import {createDeviceSigner} from '../../engines/device-signer';
import {resolveAttestationProducer} from '../../engines/attestation-producer';
import {classifyAttestationFailure, type AttestationFailureClass} from '../../engines/attestation-failure';
import {resolveVoterRequestTransports} from './attach-voter-request-transport';
import {globalStyles} from '../../theme/styles';
import type {RegistrationStackParamList} from '../../navigation/types';

type ConfirmationNavigationProp = NativeStackNavigationProp<RegistrationStackParamList, 'Confirmation'>;

/**
 * D-12: `RegisterInit`'s `registrant`/`private`/`selective` tiers still declare an expiration field
 * as required this phase (the type itself is untouched) — but the voter proposes NO validity window
 * for a record the authority signs. This value is a clearly-non-real placeholder, deliberately in
 * the deep past, and is IGNORED: the authority's approval path overrides all three occurrences with
 * its own policy-derived value before ever creating the Registrant record.
 */
const IGNORED_EXPIRATION_PLACEHOLDER = new Date(0).toISOString();

/**
 * The bounded number of decision-poll attempts before giving up — never an unbounded or
 * timer-based background poll. Each attempt is a real, awaited transport round trip; there is no
 * scheduled-delay call anywhere in this loop.
 */
const MAX_POLL_ATTEMPTS = 20;

interface DecisionNoticeLike {
	requestId: string;
	status: string;
	cursor: string;
	challengeNonce?: string;
}

/**
 * Polls `poll` (bounded, `MAX_POLL_ATTEMPTS`) until a notice for `requestId` reaches one of
 * `terminalStatuses`, forwarding the cursor between calls. Throws on exhaustion — re-delivery is
 * tolerated, an unbounded wait is not.
 */
async function pollForNotice<T extends DecisionNoticeLike>(
	poll: (sinceCursor?: string) => Promise<T[]>,
	requestId: string,
	terminalStatuses: ReadonlySet<string>,
): Promise<T> {
	let cursor: string | undefined;
	for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
		const notices = await poll(cursor);
		for (const notice of notices) {
			cursor = notice.cursor;
			if (notice.requestId === requestId && terminalStatuses.has(notice.status)) {
				return notice;
			}
		}
	}
	throw new Error('Timed out waiting for a response from the authority.');
}

export default function ConfirmationScreen() {
	const {seededElectionId, getEngine} = useVoterApp();
	const {draft, clearDraft} = useRegistrationDraft();
	const navigation = useNavigation<ConfirmationNavigationProp>();
	const {colors, fonts, type: typeScale, radii} = useTheme() as ExtendedTheme;
	const {t} = useTranslation('registration');

	const [isSubmitting, setIsSubmitting] = useState(false);
	const [failureClass, setFailureClass] = useState<AttestationFailureClass | null>(null);
	const [isPending, setIsPending] = useState(false);

	// WR-02: one registrantId (and, per this rewrite, one registration-request id and one
	// association-request id) per registration attempt (this mounted ceremony) — minted once and
	// reused on every "Try Again" retry, exactly as before. A brand-new registration is a fresh
	// mount, so the refs reset naturally without leaking the prior attempt's ids.
	const registrantIdRef = useRef<string | null>(null);
	const associationRequestIdRef = useRef<string | null>(null);

	async function onConfirm() {
		if (isSubmitting) {
			return;
		}
		setIsSubmitting(true);
		setFailureClass(null);
		try {
			// WR-03: the registration request's payload only enforces field policy when
			// init.electionId is set. Fail closed rather than submit with policy unenforced.
			if (!seededElectionId) {
				throw new Error('No election configured — cannot register (field policy would be unenforced).');
			}

			// D-11: resolve the producer once and provision the hardware P-256 key BEFORE any
			// request is submitted — idempotent, does NOT prompt biometric (biometric fires later,
			// inside produce()).
			const producer = resolveAttestationProducer();
			const {publicKey: p256DeviceKey} = await producer.provisionDeviceKey();

			// The seeded network's authority — resolved from the already-established network
			// context, never hand-rolled.
			const networkEngine = await getEngine<INetworkEngine>('network');
			const details = await networkEngine.getDetails();
			const authorityId = details.network.primaryAuthorityId;

			// The voter's OWN device identity (secp256k1, device-user.ts) — self-signs both requests
			// below as ITSELF. This is the SAME underlying keypair `useVoterApp().sign` wraps as the
			// dev-seeded founding officer, but it is deliberately resolved HERE, freshly, rather than
			// destructured from useVoterApp() — the officer signer must not appear anywhere in this
			// ceremony.
			const deviceUser = await getOrCreateDeviceUser('Device User');
			const deviceUserKey = deviceUser.activeKeys[0]!.key;
			const deviceSign = await createDeviceSigner('Device User');

			// D-07/D-08: reach the authority ONLY through the D-01 REST transport pair, behind two
			// independent dev gates. Unreachable is a user-visible condition, never a crash.
			const transports = resolveVoterRequestTransports();
			if (!transports) {
				throw new Error('Cannot reach the authority right now — please try again later.');
			}

			// WR-02: mint each id once per attempt and reuse it on retry.
			let registrantId = registrantIdRef.current;
			if (registrantId === null) {
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				registrantId = (globalThis as any).crypto.randomUUID() as string;
				registrantIdRef.current = registrantId;
			}
			let associationRequestId = associationRequestIdRef.current;
			if (associationRequestId === null) {
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				associationRequestId = (globalThis as any).crypto.randomUUID() as string;
				associationRequestIdRef.current = associationRequestId;
			}

			// Pattern 4 tier mapping — name -> public, contact/dob/address -> private, party ->
			// selective. WR-04: only furnish details that actually have a value. Furnishing an empty
			// {name, value:''} entry would satisfy the engine's name-presence check for a
			// policy-required private field (e.g. a blank required email), letting a blank required
			// field slip past field-policy enforcement.
			const privateDetails: PrivateDetail[] = [
				{name: 'dob', value: draft.dob},
				{name: 'email', value: draft.email},
				{name: 'phone', value: draft.phone},
				{name: 'addressLine1', value: draft.addressLine1},
				{name: 'addressLine2', value: draft.addressLine2},
				{name: 'addressLine3', value: draft.addressLine3},
			].filter(detail => detail.value !== '');

			const init: RegisterInit = {
				electionId: seededElectionId,
				registrant: {id: registrantId, authorityId, expiration: IGNORED_EXPIRATION_PLACEHOLDER},
				public: {firstName: draft.firstName, lastName: draft.lastName},
				private: {expiration: IGNORED_EXPIRATION_PLACEHOLDER, details: privateDetails},
				// D-13: an absent/empty selective payload means no RegistrantSelective row at all —
				// only enter this branch when the voter actually picked a party.
				selective: draft.party
					? {expiration: IGNORED_EXPIRATION_PLACEHOLDER, details: [{name: 'party', value: draft.party}]}
					: undefined,
			};

			// (1) Submit the self-signed registration request document — never a direct write, and
			// never the officer signer. Reuses the registrantId as the request document's own id (no
			// cross-table uniqueness constraint requires otherwise, and it keeps a single id to reuse
			// on retry).
			const registrationRequestInit: RegistrationRequestInit = {
				id: registrantId,
				authorityId,
				payload: init,
				submittedAt: new Date().toISOString(),
			};
			await transports.registrationTransport.submitRequest(registrationRequestInit, deviceUserKey, deviceSign);

			// (2) Submit the self-signed association-request document, bound to the P-256 device
			// key. The requester key MUST equal the device key (the authority's engine enforces this
			// with a pre-flight guard) — both are p256DeviceKey.
			const associationRequestInit: AssociationRequestInit = {
				id: associationRequestId,
				authorityId,
				registrantId,
				deviceKey: p256DeviceKey,
				electionId: seededElectionId,
				submittedAt: new Date().toISOString(),
			};
			// The association-request self-signature must verify directly against the P-256 device
			// key (the schema checks the signature against that exact public key, not against any
			// registered identity) — `signDeviceKeyDigest` is the producer seam for that.
			const associationSign = async (digest: Uint8Array): Promise<Signature> => {
				if (typeof producer.signDeviceKeyDigest !== 'function') {
					throw new Error('Device attestation signer is not available yet — please try again later.');
				}
				return producer.signDeviceKeyDigest(digest);
			};
			await transports.associationTransport.submitRequest(associationRequestInit, p256DeviceKey, associationSign);

			// (3) Obtain the challenge nonce from a challenge-issued decision notice — never call the
			// authority's challenge-issuing engine method directly. Bounded, no timer-based
			// background poller.
			const decisionNotice = await pollForNotice(
				transports.associationTransport.pollDecisions.bind(transports.associationTransport),
				associationRequestId,
				new Set(['c', 'r']),
			);
			if (decisionNotice.status === 'r') {
				throw new Error('The authority rejected the association request.');
			}
			if (!decisionNotice.challengeNonce) {
				throw new Error('The authority issued a challenge notice with no nonce.');
			}

			// (4) The D-11 second producer step answers the challenge; this is the "Confirm with
			// Face ID" biometric step (D-06/D-15/D-16 biometric-last) — its position is UNCHANGED:
			// after the challenge is obtained, before the attestation answer is submitted.
			const challenge: AttestationChallenge = {
				nonce: decisionNotice.challengeNonce,
				authorityId,
				registrantId,
				deviceKey: p256DeviceKey,
				electionId: seededElectionId,
			};
			const attestation = await producer.produce(challenge);

			// (5) Submit the self-signed attestation-answer document — never a direct associate
			// write.
			const answer: AssociationAttestationAnswer = {
				requestId: associationRequestId,
				nonce: decisionNotice.challengeNonce,
				attestation,
			};
			await transports.associationTransport.submitAttestation(answer, p256DeviceKey, associationSign);

			// The authority's automatic driver processes the answer separately, on its own "Sync
			// Now" trigger — this screen has no further decision to await synchronously, and
			// claiming success here would be a lie about what has actually happened. Show an honest
			// pending state instead. The local draft's job (holding the answers before submission) is
			// done regardless of the eventual decision, so it is safe to clear now; the screen itself
			// is NOT popped — the voter stays here and sees the pending state rather than being told
			// "you're all set" for something not yet decided.
			clearDraft();
			setIsPending(true);
		} catch (err) {
			console.error('ConfirmationScreen: registration ceremony failed:', err);
			// D-09/T-45-06-04: classify to a generic UX class — raw reject codes / internal
			// error messages never reach the UI.
			setFailureClass(classifyAttestationFailure(err));
		} finally {
			setIsSubmitting(false);
		}
	}

	/**
	 * D-09 recoverable-action remediation: deep-link to Android's biometric enrollment
	 * settings. Falls back to the general security-settings screen if the specific
	 * enrollment intent isn't resolvable on this device/OS version.
	 */
	async function handleSetupDeviceUnlock() {
		try {
			await Linking.sendIntent('android.settings.BIOMETRIC_ENROLL');
		} catch (err) {
			console.error('ConfirmationScreen: BIOMETRIC_ENROLL intent failed, falling back to security settings:', err);
			try {
				await Linking.sendIntent('android.settings.SECURITY_SETTINGS');
			} catch (fallbackErr) {
				console.error('ConfirmationScreen: SECURITY_SETTINGS fallback intent also failed:', fallbackErr);
			}
		}
	}

	const errorCopy =
		failureClass === 'recoverable-action'
			? t('confirmation.error.biometricNotEnrolled')
			: failureClass === 'terminal'
				? t('confirmation.error.terminal')
				: failureClass === 'recoverable-transient'
					? t('confirmation.error.transient')
					: null;

	return (
		<View style={[globalStyles.container, styles.screen, {backgroundColor: colors.background}]}>
			<View style={styles.centerColumn}>
				<Text
					style={[
						styles.heading,
						{
							color: colors.text,
							fontFamily: fonts.medium.fontFamily,
							fontWeight: fonts.medium.fontWeight,
							fontSize: typeScale.h2.fontSize,
							lineHeight: typeScale.h2.lineHeight,
						},
					]}>
					{t('confirmation.heading')}
				</Text>
				<Text
					style={[
						styles.body,
						{
							color: colors.textSecondary,
							fontFamily: fonts.regular.fontFamily,
							fontWeight: fonts.regular.fontWeight,
							fontSize: typeScale.body.fontSize,
							lineHeight: typeScale.body.lineHeight,
						},
					]}>
					{t('confirmation.body')}
				</Text>
				<View style={styles.iconWrap}>
					<FontAwesome6 name="fingerprint" size={96} color={colors.primary} />
				</View>
				<Text
					style={[
						styles.caption,
						{
							color: colors.textSecondary,
							fontFamily: fonts.regular.fontFamily,
							fontWeight: fonts.regular.fontWeight,
							fontSize: typeScale.caption.fontSize,
							lineHeight: typeScale.caption.lineHeight,
						},
					]}>
					{t('confirmation.caption')}
				</Text>
				{isPending ? (
					<Text
						testID="confirmation-pending"
						style={[
							styles.error,
							{
								color: colors.text,
								fontFamily: fonts.regular.fontFamily,
								fontWeight: fonts.regular.fontWeight,
								fontSize: typeScale.body.fontSize,
								lineHeight: typeScale.body.lineHeight,
							},
						]}>
						Your registration has been submitted. We'll let you know once the authority confirms
						your device.
					</Text>
				) : (
					<>
						{errorCopy ? (
							<Text
								testID="confirmation-error"
								style={[
									styles.error,
									{
										color: colors.text,
										fontFamily: fonts.regular.fontFamily,
										fontWeight: fonts.regular.fontWeight,
										fontSize: typeScale.body.fontSize,
										lineHeight: typeScale.body.lineHeight,
									},
								]}>
								{errorCopy}
							</Text>
						) : null}
						{failureClass === 'terminal' ? null : failureClass === 'recoverable-action' ? (
							<>
								<Pressable
									testID="confirmation-setup-cta"
									onPress={handleSetupDeviceUnlock}
									style={[styles.cta, {backgroundColor: colors.primary, borderRadius: radii.pill}]}>
									<Text style={[styles.ctaLabel, {color: colors.light}]}>{t('confirmation.error.setupCta')}</Text>
								</Pressable>
								<Pressable
									testID="confirmation-retry-cta"
									onPress={onConfirm}
									disabled={isSubmitting}
									style={[styles.retryCta, {borderColor: colors.primary, borderRadius: radii.pill}]}>
									<Text style={[styles.ctaLabel, {color: colors.primary}]}>Try Again</Text>
								</Pressable>
							</>
						) : (
							<Pressable
								testID="confirmation-confirm-face-id"
								onPress={onConfirm}
								disabled={isSubmitting}
								style={[styles.cta, {backgroundColor: colors.primary, borderRadius: radii.pill}]}>
								<Text style={[styles.ctaLabel, {color: colors.light}]}>
									{errorCopy ? 'Try Again' : t('confirmation.cta')}
								</Text>
							</Pressable>
						)}
					</>
				)}
			</View>
		</View>
	);
}

const styles = StyleSheet.create({
	screen: {
		flex: 1,
	},
	centerColumn: {
		flex: 1,
		justifyContent: 'center',
		alignItems: 'center',
	},
	heading: {
		textAlign: 'center',
	},
	body: {
		marginTop: 16, // md spacing token
		textAlign: 'center',
	},
	iconWrap: {
		marginTop: 32, // xl spacing token
	},
	caption: {
		marginTop: 8, // sm spacing token
		textAlign: 'center',
	},
	error: {
		marginTop: 16, // md spacing token
		textAlign: 'center',
	},
	cta: {
		marginTop: 32, // xl spacing token
		minHeight: 44, // minimum touch target
		alignItems: 'center',
		justifyContent: 'center',
		paddingHorizontal: 24,
	},
	retryCta: {
		marginTop: 16, // md spacing token
		minHeight: 44, // minimum touch target
		alignItems: 'center',
		justifyContent: 'center',
		paddingHorizontal: 24,
		borderWidth: 1,
	},
	ctaLabel: {
		fontWeight: '600',
	},
});
