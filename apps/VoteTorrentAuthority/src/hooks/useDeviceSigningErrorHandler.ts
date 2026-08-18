import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';
import {
	DEVICE_SIGNING_ERROR_COPY_KEY,
	isDeviceSigningError,
	isSignatureDesyncError,
	mapDeviceSigningError,
} from '../utils/deviceSigningError';

/**
 * useDeviceSigningErrorHandler — the single catch-block contract (49-11)
 * every migrated `createDeviceSigner` call site routes through.
 *
 * Caller shape (documented here, followed at every call site): invoke the
 * returned handler INSIDE your existing `catch (err) { ... }` block. If
 * `outcome.handled` is true, `return` immediately — the handler has already
 * done everything the UI needs (a navigation, or a deliberate no-op for a
 * cancellation). Otherwise, call your screen's existing `setErrorMessage`
 * with `outcome.message`, falling back to the caught error's own message
 * when `outcome.message` is `undefined` (the "not mine" pass-through case):
 *
 *   const handleDeviceSigningError = useDeviceSigningErrorHandler();
 *   try {
 *     ...
 *   } catch (err) {
 *     const outcome = handleDeviceSigningError(err);
 *     if (outcome.handled) return;
 *     setErrorMessage(outcome.message ?? (err instanceof Error ? err.message : String(err)));
 *   }
 *
 * This hook owns the ENTIRE mapping from a `signWithDeviceKey` native reject
 * code to a UI outcome — no call site re-derives any part of it. See
 * `deviceSigningError.ts` for the underlying D-13 taxonomy this hook
 * consumes (`mapDeviceSigningError`, `DEVICE_SIGNING_ERROR_COPY_KEY`) and the
 * 49-11 addition it also consumes (`isDeviceSigningError`).
 */
export type DeviceSigningErrorOutcome = { handled: boolean; message?: string };

export function useDeviceSigningErrorHandler(): (err: unknown) => DeviceSigningErrorOutcome {
	const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
	const { t } = useTranslation();

	return useCallback(
		(err: unknown): DeviceSigningErrorOutcome => {
			// 49-14 follow-up rescue path: a `SignatureValid` CHECK rejection from an
			// interrupted `handleRecovery` desync is NOT a `signWithDeviceKey` native-code
			// rejection — `isDeviceSigningError` below would never recognize it, since it
			// carries no `code` at all. Recognized separately (message-based, see
			// `isSignatureDesyncError`'s doc comment) and routed IDENTICALLY to
			// `key-invalidated`: re-entering `handleRecovery` self-heals the desync regardless
			// of how stale the local metadata is, or whether this device's interruption
			// predates the `device-signer.ts` in-progress marker.
			if (isSignatureDesyncError(err)) {
				navigation.navigate('ProvisionSigningKey', { reason: 'invalidated' });
				return { handled: true };
			}

			// "Not mine": an error without a recognized device-signing `code`
			// (a plain Error, undefined, {}, or an unrecognized code) is left
			// entirely alone. The caller keeps its own raw-message fallback.
			// This is the single most important behavior in this file — it is
			// what keeps a real engine/network/validation failure from ever
			// being relabeled as a biometric failure (T-49-USER-7).
			if (!isDeviceSigningError(err)) {
				return { handled: false, message: undefined };
			}

			const cls = mapDeviceSigningError(err);

			switch (cls) {
				case 'cancellation':
					// Per D-13: a dismissal is not a fault. No InlineError, no log.
					return { handled: true };

				case 'key-invalidated':
					navigation.navigate('ProvisionSigningKey', { reason: 'invalidated' });
					return { handled: true };

				case 'no-key-provisioned':
					// 49-UI-SPEC.md's Contract, exact: there is deliberately no third
					// `reason: 'no-key-yet'` route param — this condition reuses the
					// visually-identical first-run variant.
					navigation.navigate('ProvisionSigningKey', { reason: 'first-run' });
					return { handled: true };

				case 'no-device-credential':
					// D-18 terminal state has no entry in DEVICE_SIGNING_ERROR_COPY_KEY
					// and is not one of isNavigationClass's pair — 49-01 scoped it as a
					// provisioning-screen-local terminal condition. Routing it here to
					// the SAME `reason: 'invalidated'` destination is deliberate: if it
					// ever does surface at a call site (rather than inside the
					// provisioning screen's own recovery ceremony, where it is more
					// likely to originate), the provisioning screen's terminal
					// no-recovery body is the only surface that explains it — an
					// unhandled `undefined` copy key here would otherwise render an
					// empty InlineError, which is worse than routing to a screen that
					// can at least explain the condition even though it arrives via
					// the "invalidated" reason rather than a dedicated one.
					navigation.navigate('ProvisionSigningKey', { reason: 'invalidated' });
					return { handled: true };

				default:
					// The four inline classes: no-biometrics-enrolled, lockout,
					// lockout-permanent, biometric-error.
					return { handled: false, message: t(DEVICE_SIGNING_ERROR_COPY_KEY[cls]!) };
			}
		},
		[navigation, t]
	);
}
