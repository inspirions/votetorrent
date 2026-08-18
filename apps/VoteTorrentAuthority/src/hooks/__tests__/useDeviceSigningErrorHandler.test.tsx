/**
 * Behavioral tests for useDeviceSigningErrorHandler (49-11).
 *
 * Pins the hook's entire outcome contract:
 *   1. Each of the three navigating classes ('key-invalidated',
 *      'no-key-provisioned', 'no-device-credential') produces exactly one
 *      `navigate` call with the exact route name and `reason` value, and
 *      returns `{ handled: true }`.
 *   2. `{ code: 'CANCELED' }` returns `{ handled: true }` with no `navigate`
 *      call and no message.
 *   3. Each of the four inline classes returns `{ handled: false, message }`
 *      with the expected i18n key resolved.
 *   4. `new Error('engine write failed')`, `undefined`, `{}`, and
 *      `{ code: 'SOMETHING_NEW' }` all return `{ handled: false, message:
 *      undefined }` with no `navigate` call — the pass-through case that
 *      protects every non-device error at every call site.
 *
 * Approach mirrors useCurrentOfficerScopes.test.tsx: a minimal host component
 * exposing the handler via a testID-driven trigger, module-scope mocks for
 * @react-navigation/native and react-i18next.
 */

import React from 'react';
import { Text, TouchableOpacity } from 'react-native';
import renderer from 'react-test-renderer';

// ---------------------------------------------------------------------------
// Mocks — must be at module scope (jest hoists jest.mock calls).
// ---------------------------------------------------------------------------

const mockNavigate = jest.fn();

jest.mock('@react-navigation/native', () => ({
	useNavigation: () => ({ navigate: mockNavigate }),
}));

jest.mock('react-i18next', () => ({
	useTranslation: () => ({ t: (key: string) => key }),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { useDeviceSigningErrorHandler } = require('../useDeviceSigningErrorHandler');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const deviceSigningErrorModule = require('../../utils/deviceSigningError');

// ---------------------------------------------------------------------------
// Host component: exposes the handler's outcome for an on-press error.
// ---------------------------------------------------------------------------

let lastOutcome: { handled: boolean; message?: string } | undefined;

function Harness({ err }: { err: unknown }) {
	const handle = useDeviceSigningErrorHandler();
	return (
		<TouchableOpacity
			testID="trigger"
			onPress={() => {
				lastOutcome = handle(err);
			}}
		>
			<Text>trigger</Text>
		</TouchableOpacity>
	);
}

function run(err: unknown): { handled: boolean; message?: string } {
	let tr!: renderer.ReactTestRenderer;
	renderer.act(() => {
		tr = renderer.create(<Harness err={err} />);
	});
	renderer.act(() => {
		tr.root.findByProps({ testID: 'trigger' }).props.onPress();
	});
	return lastOutcome!;
}

beforeEach(() => {
	jest.clearAllMocks();
	lastOutcome = undefined;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useDeviceSigningErrorHandler — 49-11 outcome contract', () => {
	describe('navigating classes', () => {
		it("'key-invalidated' navigates to ProvisionSigningKey with reason: 'invalidated'", () => {
			const outcome = run({ code: 'KEY_INVALIDATED_REASSOCIATE' });

			expect(mockNavigate).toHaveBeenCalledTimes(1);
			expect(mockNavigate).toHaveBeenCalledWith('ProvisionSigningKey', { reason: 'invalidated' });
			expect(outcome).toEqual({ handled: true });
		});

		it("'no-key-provisioned' navigates to ProvisionSigningKey with reason: 'first-run'", () => {
			const outcome = run({ code: 'NO_KEY_PROVISIONED' });

			expect(mockNavigate).toHaveBeenCalledTimes(1);
			expect(mockNavigate).toHaveBeenCalledWith('ProvisionSigningKey', { reason: 'first-run' });
			expect(outcome).toEqual({ handled: true });
		});

		it("'no-device-credential' navigates to ProvisionSigningKey with reason: 'invalidated'", () => {
			const outcome = run({ code: 'NO_DEVICE_CREDENTIAL' });

			expect(mockNavigate).toHaveBeenCalledTimes(1);
			expect(mockNavigate).toHaveBeenCalledWith('ProvisionSigningKey', { reason: 'invalidated' });
			expect(outcome).toEqual({ handled: true });
		});
	});

	describe('cancellation', () => {
		it("{ code: 'CANCELED' } returns handled:true with no navigate call and no message", () => {
			const outcome = run({ code: 'CANCELED' });

			expect(mockNavigate).not.toHaveBeenCalled();
			expect(outcome).toEqual({ handled: true });
			expect(outcome.message).toBeUndefined();
		});
	});

	describe('inline classes', () => {
		it("'no-biometrics-enrolled' returns handled:false with the expected copy key", () => {
			const outcome = run({ code: 'NO_BIOMETRICS_ENROLLED' });

			expect(mockNavigate).not.toHaveBeenCalled();
			expect(outcome).toEqual({
				handled: false,
				message: 'deviceSigningErrorNoBiometricsEnrolled',
			});
		});

		it("'lockout' returns handled:false with the expected copy key", () => {
			const outcome = run({ code: 'LOCKOUT' });

			expect(outcome).toEqual({ handled: false, message: 'deviceSigningErrorLockout' });
		});

		it("'lockout-permanent' returns handled:false with the expected copy key", () => {
			const outcome = run({ code: 'LOCKOUT_PERMANENT' });

			expect(outcome).toEqual({ handled: false, message: 'deviceSigningErrorLockoutPermanent' });
		});

		it("'biometric-error' returns handled:false with the expected copy key (the hook's own switch branch — 'biometric-error' is mapDeviceSigningError's default for a code the taxonomy's lookup table does not recognize, which isDeviceSigningError's gate excludes by design; spying on the taxonomy functions isolates this branch from that gate rather than contradicting it)", () => {
			const isDeviceSigningErrorSpy = jest
				.spyOn(deviceSigningErrorModule, 'isDeviceSigningError')
				.mockReturnValueOnce(true);
			const mapDeviceSigningErrorSpy = jest
				.spyOn(deviceSigningErrorModule, 'mapDeviceSigningError')
				.mockReturnValueOnce('biometric-error');

			const outcome = run({ code: 'BIOMETRIC_ERROR' });

			expect(mockNavigate).not.toHaveBeenCalled();
			expect(outcome).toEqual({ handled: false, message: 'deviceSigningErrorGeneric' });

			isDeviceSigningErrorSpy.mockRestore();
			mapDeviceSigningErrorSpy.mockRestore();
		});
	});

	describe('49-14 follow-up — the SignatureValid desync rescue path', () => {
		it('a raw, unwrapped ConstraintError-shaped SignatureValid rejection navigates to ProvisionSigningKey with reason: invalidated', () => {
			const err = Object.assign(new Error('CHECK constraint failed: SignatureValid'), {
				name: 'ConstraintError',
			});
			const outcome = run(err);

			expect(mockNavigate).toHaveBeenCalledTimes(1);
			expect(mockNavigate).toHaveBeenCalledWith('ProvisionSigningKey', { reason: 'invalidated' });
			expect(outcome).toEqual({ handled: true });
		});

		it('the ElectionsEngine.rethrow-wrapped shape also navigates', () => {
			const outcome = run(new Error('Quereus error (code 19): CHECK constraint failed: SignatureValid'));

			expect(mockNavigate).toHaveBeenCalledTimes(1);
			expect(mockNavigate).toHaveBeenCalledWith('ProvisionSigningKey', { reason: 'invalidated' });
			expect(outcome).toEqual({ handled: true });
		});

		it('an unrelated CHECK failure is NOT routed into recovery — falls through to pass-through', () => {
			const outcome = run(new Error('CHECK constraint failed: RevisionDeadlineValid'));

			expect(mockNavigate).not.toHaveBeenCalled();
			expect(outcome).toEqual({ handled: false, message: undefined });
		});
	});

	describe('pass-through — the "not mine" case', () => {
		it('a generic Error yields handled:false, message:undefined, and no navigate call', () => {
			const outcome = run(new Error('engine write failed'));

			expect(mockNavigate).not.toHaveBeenCalled();
			expect(outcome).toEqual({ handled: false, message: undefined });
		});

		it('undefined yields handled:false, message:undefined, and no navigate call', () => {
			const outcome = run(undefined);

			expect(mockNavigate).not.toHaveBeenCalled();
			expect(outcome).toEqual({ handled: false, message: undefined });
		});

		it('{} yields handled:false, message:undefined, and no navigate call', () => {
			const outcome = run({});

			expect(mockNavigate).not.toHaveBeenCalled();
			expect(outcome).toEqual({ handled: false, message: undefined });
		});

		it("{ code: 'SOMETHING_NEW' } (unrecognized code) yields handled:false, message:undefined, and no navigate call", () => {
			const outcome = run({ code: 'SOMETHING_NEW' });

			expect(mockNavigate).not.toHaveBeenCalled();
			expect(outcome).toEqual({ handled: false, message: undefined });
		});
	});
});
