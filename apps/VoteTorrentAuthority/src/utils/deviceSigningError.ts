/**
 * deviceSigningError.ts — D-13 device-signing error taxonomy contract (49-01,
 * Wave 0 scaffolding).
 *
 * Single source of truth for mapping `signWithDeviceKey`'s native rejection
 * `code` to a UI class. Every one of this phase's 22 `createDeviceSigner`
 * call sites routes its catch block through `mapDeviceSigningError` rather
 * than re-deriving the mapping locally (see `49-UI-SPEC.md`
 * §Cross-Cutting: Error Taxonomy Contract).
 *
 * Pure TypeScript — no React Native, native-module, or navigation imports,
 * so it is fully jest-testable and importable from any call site without
 * pulling in the bridge.
 *
 * Analog: `apps/VoteTorrentVoter/src/engines/attestation-failure.ts` (Phase
 * 45's D-09 code -> UX class mapper). This file is one taxonomy tier deeper
 * (routes by exact code, not just a 3-way class) and does NOT reproduce
 * that analog's `__DEV__` terminal-class downgrade — this phase's taxonomy
 * has no release-only terminal class (StrongBox/TEE absence is Phase 45's
 * D-07 concern, not this phase's).
 */

/**
 * D-13 taxonomy + UI-SPEC routing decision for `signWithDeviceKey` rejections.
 *
 * `'cancellation'` through `'key-invalidated'` are D-13's five native codes.
 * `'no-key-provisioned'` and `'no-device-credential'` are NOT part of D-13's
 * five — they are documented additions:
 *   - `'no-key-provisioned'` is `49-UI-SPEC.md`'s explicitly-flagged sixth
 *     condition: the Keystore alias is absent, detected BEFORE any prompt is
 *     shown.
 *   - `'no-device-credential'` is D-18's terminal no-recovery state: the
 *     device has no screen lock, so on-device recovery is impossible.
 */
export type DeviceSigningErrorClass =
	| 'cancellation' // no UI at all — silent dismissal
	| 'no-biometrics-enrolled'
	| 'lockout'
	| 'lockout-permanent'
	| 'biometric-error'
	| 'key-invalidated' // navigate, never inline
	| 'no-key-provisioned' // navigate, never inline — detected BEFORE any prompt
	| 'no-device-credential'; // D-18 terminal — no recovery possible

/**
 * Native reject code -> UI class. Reused verbatim from Phase 45's taxonomy
 * where applicable (D-13), extended with the two sibling conditions above.
 * Any code NOT present here (including the explicit `BIOMETRIC_ERROR`
 * catch-all, and any unrecognized/future code) falls through
 * `mapDeviceSigningError`'s default to `'biometric-error'`.
 */
export const CODE_TO_CLASS: Record<string, DeviceSigningErrorClass> = {
	CANCELED: 'cancellation',
	NO_BIOMETRICS_ENROLLED: 'no-biometrics-enrolled',
	LOCKOUT: 'lockout',
	LOCKOUT_PERMANENT: 'lockout-permanent',
	KEY_INVALIDATED_REASSOCIATE: 'key-invalidated',
	NO_KEY_PROVISIONED: 'no-key-provisioned',
	NO_DEVICE_CREDENTIAL: 'no-device-credential',
};

/**
 * Classify a `signWithDeviceKey` rejection into a D-13 UI class. Reads
 * `(err as {code?: string}).code`; any unrecognized or missing code
 * classifies as `'biometric-error'` — never silently treated as a success
 * path (T-49-KEY mitigation) and mirrors `attestation-failure.ts`'s own
 * "unknown code is never silently terminal" default.
 */
export function mapDeviceSigningError(err: unknown): DeviceSigningErrorClass {
	const code = (err as { code?: string } | null | undefined)?.code;
	if (code !== undefined && code in CODE_TO_CLASS) {
		return CODE_TO_CLASS[code]!;
	}
	return 'biometric-error';
}

/**
 * i18n copy key for each INLINE-rendered error class (the four classes
 * `49-UI-SPEC.md`'s Error Taxonomy Contract table renders as `InlineError`
 * on the calling screen).
 *
 * `cancellation`, `key-invalidated`, `no-key-provisioned`, and
 * `no-device-credential` are DELIBERATELY ABSENT from this map — that
 * absence IS the contract, not an omission: `cancellation` renders nothing
 * (silent dismissal), and the other three always navigate (to
 * `ProvisionSigningKey` or a terminal no-recovery screen) rather than
 * rendering inline.
 */
export const DEVICE_SIGNING_ERROR_COPY_KEY: Partial<Record<DeviceSigningErrorClass, string>> = {
	'no-biometrics-enrolled': 'deviceSigningErrorNoBiometricsEnrolled',
	lockout: 'deviceSigningErrorLockout',
	'lockout-permanent': 'deviceSigningErrorLockoutPermanent',
	'biometric-error': 'deviceSigningErrorGeneric',
};

/**
 * True for the two classes `49-UI-SPEC.md`'s degradation clause marks
 * load-bearing at every one of the 22 call sites: a navigation-class error
 * must never be rendered inline (there is no `InlineError` copy for it —
 * see `DEVICE_SIGNING_ERROR_COPY_KEY` above), it must route the officer to
 * the provisioning/recovery screen instead.
 */
export function isNavigationClass(c: DeviceSigningErrorClass): boolean {
	return c === 'key-invalidated' || c === 'no-key-provisioned';
}
