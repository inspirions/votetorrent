/**
 * recovery-branch-proof.test.ts — jest coverage for the D-26a RESCOPED 2026-08-21 error
 * classification (49-22, gap round 2 closure of Gap C criterion 7).
 *
 * 49-19 removed the sub-API-30 dispatch branch from the native layer entirely; below API 30,
 * `signWithRecoveryKey` now rejects with an exact `code: 'RECOVERY_UNSUPPORTED_OS'` before any key
 * handle or UI. These three cases prove `runRecoveryBranchProof` classifies that rejection as a
 * dedicated `'unsupported-os'` outcome — not a defect — while leaving the existing
 * `'precondition-unmet'` and `'fail'` buckets exactly as they were.
 *
 * Virtual-mock preamble mirrors rn-db-factory.test.ts's convention: `@votetorrent/vote-engine/rn`
 * is virtual-mocked with only the export this module actually uses (`verifySigP256`), and
 * `./device-user` is mocked per recovery-key-registration.test.ts's sibling convention so the
 * function reaches the sign call rather than short-circuiting on the missing-public-key
 * precondition.
 */

jest.mock(
	'@votetorrent/vote-engine/rn',
	() => ({ verifySigP256: jest.fn() }),
	{ virtual: true },
);

jest.mock('../device-user', () => ({
	getDeviceProvisioningRecord: jest.fn(),
}));

import { runRecoveryBranchProof } from '../recovery-branch-proof';
import { getDeviceProvisioningRecord } from '../device-user';

const mockGetRecord = getDeviceProvisioningRecord as jest.MockedFunction<
	typeof getDeviceProvisioningRecord
>;

const RECOVERY_PUB_HEX =
	'030a52df56ee0151548b4f6922774d5ca70ef5d9a50a212583b71cc02da0622243';

const PROMPTS = { title: 'Recovery signing proof', subtitle: 'Confirm', negative: 'Cancel' };

function fakeNative(signWithRecoveryKey: jest.Mock) {
	return {
		provisionRecoveryKey: jest.fn(),
		signWithRecoveryKey,
	};
}

describe('runRecoveryBranchProof — D-26a RESCOPED error classification', () => {
	beforeEach(() => {
		jest.resetAllMocks();
		mockGetRecord.mockResolvedValue({
			recoveryPublicKeyCompressedHex: RECOVERY_PUB_HEX,
			attestedPublicKeyCompressedHex: RECOVERY_PUB_HEX,
			signingKeyAlias: 'signing-key',
			certificateChainBase64: [],
			capturedAt: Date.now(),
		});
	});

	it('classifies an exact RECOVERY_UNSUPPORTED_OS code as unsupported-os, not fail', async () => {
		const err = Object.assign(new Error('recovery is not supported on this OS version'), {
			code: 'RECOVERY_UNSUPPORTED_OS',
		});
		const native = fakeNative(jest.fn().mockRejectedValue(err));

		const result = await runRecoveryBranchProof(native, 'recovery-key-alias', 29, PROMPTS);

		expect(result).toEqual({
			passed: false,
			outcome: 'unsupported-os',
			sdkInt: 29,
			branch: 'unsupported-below-api-30',
		});
	});

	it('still classifies an invalidated-recovery-key error as precondition-unmet (existing bucket unwidened)', async () => {
		const err = new Error('recovery key invalidated — re-association required');
		const native = fakeNative(jest.fn().mockRejectedValue(err));

		const result = await runRecoveryBranchProof(native, 'recovery-key-alias', 30, PROMPTS);

		expect(result).toEqual({
			passed: false,
			outcome: 'precondition-unmet',
			sdkInt: 30,
			branch: 'biometric-prompt-device-credential',
		});
	});

	it('classifies an arbitrary unrelated error as fail, keyed on code not a message regex', async () => {
		// The message text below deliberately contains the words "RECOVERY_UNSUPPORTED_OS" without
		// the matching `code` field, proving the classification reads the exact code — never a
		// message regex — so an unrelated error mentioning the words cannot be misclassified.
		const err = new Error(
			'unexpected native failure (not a RECOVERY_UNSUPPORTED_OS condition): keystore busy',
		);
		const native = fakeNative(jest.fn().mockRejectedValue(err));

		const result = await runRecoveryBranchProof(native, 'recovery-key-alias', 29, PROMPTS);

		expect(result).toEqual({
			passed: false,
			outcome: 'fail',
			sdkInt: 29,
			branch: 'unsupported-below-api-30',
		});
	});
});
