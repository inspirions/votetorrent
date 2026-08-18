import {
	CODE_TO_CLASS,
	DEVICE_SIGNING_ERROR_COPY_KEY,
	isNavigationClass,
	isSignatureDesyncError,
	mapDeviceSigningError,
} from '../deviceSigningError';

describe('deviceSigningError (D-13 taxonomy)', () => {
	test('every code in CODE_TO_CLASS maps to its declared class', () => {
		for (const [code, expectedClass] of Object.entries(CODE_TO_CLASS)) {
			expect(mapDeviceSigningError({ code })).toBe(expectedClass);
		}
	});

	test('undefined maps to biometric-error', () => {
		expect(mapDeviceSigningError(undefined)).toBe('biometric-error');
	});

	test('null maps to biometric-error', () => {
		expect(mapDeviceSigningError(null)).toBe('biometric-error');
	});

	test('an empty object maps to biometric-error', () => {
		expect(mapDeviceSigningError({})).toBe('biometric-error');
	});

	test('a plain Error (no code) maps to biometric-error', () => {
		expect(mapDeviceSigningError(new Error('x'))).toBe('biometric-error');
	});

	test('an unrecognized code maps to biometric-error', () => {
		expect(mapDeviceSigningError({ code: 'SOMETHING_NEW' })).toBe('biometric-error');
	});

	test('the explicit BIOMETRIC_ERROR code also maps to biometric-error (via the default branch)', () => {
		expect(mapDeviceSigningError({ code: 'BIOMETRIC_ERROR' })).toBe('biometric-error');
	});

	test('CANCELED maps to cancellation', () => {
		expect(mapDeviceSigningError({ code: 'CANCELED' })).toBe('cancellation');
	});

	test('DEVICE_SIGNING_ERROR_COPY_KEY has no entry for cancellation, key-invalidated, no-key-provisioned, or no-device-credential', () => {
		expect(DEVICE_SIGNING_ERROR_COPY_KEY['cancellation']).toBeUndefined();
		expect(DEVICE_SIGNING_ERROR_COPY_KEY['key-invalidated']).toBeUndefined();
		expect(DEVICE_SIGNING_ERROR_COPY_KEY['no-key-provisioned']).toBeUndefined();
		expect(DEVICE_SIGNING_ERROR_COPY_KEY['no-device-credential']).toBeUndefined();
	});

	test('DEVICE_SIGNING_ERROR_COPY_KEY has an entry for each of the four inline-rendered classes', () => {
		expect(DEVICE_SIGNING_ERROR_COPY_KEY['no-biometrics-enrolled']).toBe(
			'deviceSigningErrorNoBiometricsEnrolled'
		);
		expect(DEVICE_SIGNING_ERROR_COPY_KEY['lockout']).toBe('deviceSigningErrorLockout');
		expect(DEVICE_SIGNING_ERROR_COPY_KEY['lockout-permanent']).toBe(
			'deviceSigningErrorLockoutPermanent'
		);
		expect(DEVICE_SIGNING_ERROR_COPY_KEY['biometric-error']).toBe('deviceSigningErrorGeneric');
	});

	test('isNavigationClass is true for exactly key-invalidated and no-key-provisioned', () => {
		expect(isNavigationClass('key-invalidated')).toBe(true);
		expect(isNavigationClass('no-key-provisioned')).toBe(true);

		expect(isNavigationClass('cancellation')).toBe(false);
		expect(isNavigationClass('no-biometrics-enrolled')).toBe(false);
		expect(isNavigationClass('lockout')).toBe(false);
		expect(isNavigationClass('lockout-permanent')).toBe(false);
		expect(isNavigationClass('biometric-error')).toBe(false);
		expect(isNavigationClass('no-device-credential')).toBe(false);
	});
});

// 49-14 follow-up (interrupted-handleRecovery Keystore/metadata desync): isSignatureDesyncError
// is the RESCUE-path predicate — a message-based classification, not part of the code-based
// taxonomy above (see its own doc comment).
describe('isSignatureDesyncError (49-14 follow-up)', () => {
	test('recognizes the raw, unwrapped ConstraintError shape observed on real hardware', () => {
		const err = Object.assign(new Error('CHECK constraint failed: SignatureValid'), {
			name: 'ConstraintError',
		});
		expect(isSignatureDesyncError(err)).toBe(true);
	});

	test('recognizes the wrapped shape produced by ElectionsEngine.rethrow/NetworkEngine-style catch blocks', () => {
		const err = new Error('Quereus error (code 19): CHECK constraint failed: SignatureValid');
		expect(isSignatureDesyncError(err)).toBe(true);
	});

	test('recognizes a plain string message carrying the same shape', () => {
		expect(isSignatureDesyncError('CHECK constraint failed: SignatureValid')).toBe(true);
	});

	test('does NOT match InviteSignatureValid — a different table, different signing path', () => {
		const err = new Error('CHECK constraint failed: InviteSignatureValid');
		expect(isSignatureDesyncError(err)).toBe(false);
	});

	test('does NOT match a CHECK failure unrelated to any signature', () => {
		const err = new Error('CHECK constraint failed: RevisionDeadlineValid');
		expect(isSignatureDesyncError(err)).toBe(false);
	});

	test('does NOT match a SignatureValid-mentioning message with no constraint marker at all', () => {
		const err = new Error('SignatureValid failed for some unrelated reason');
		expect(isSignatureDesyncError(err)).toBe(false);
	});

	test('does NOT match undefined, null, {}, or a device-signing-coded error', () => {
		expect(isSignatureDesyncError(undefined)).toBe(false);
		expect(isSignatureDesyncError(null)).toBe(false);
		expect(isSignatureDesyncError({})).toBe(false);
		expect(isSignatureDesyncError({ code: 'CANCELED' })).toBe(false);
	});

	test('does NOT match a generic engine failure (the pass-through case must stay pass-through)', () => {
		expect(isSignatureDesyncError(new Error('engine write failed'))).toBe(false);
	});
});
