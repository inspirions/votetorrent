/**
 * Unit tests for ConfirmationScreen (D-01/D-02/D-03/D-05/D-07/D-08/D-09/D-11/D-12/D-18) — the
 * Face-ID confirming tap. Fully mocks `@react-navigation/native` (spy-able `popToTop`),
 * `providers/VoterAppProvider`, `providers/RegistrationDraftProvider`, `engines/device-user`,
 * `engines/device-signer`, `engines/attestation-producer` (D-11 two-step seam), and
 * `./attach-voter-request-transport` so the rewritten ceremony can be exercised without a real
 * navigator/provider/engine tree or a real network, mirroring Authority's full-replace mocking
 * pattern.
 *
 * Plan 11 — asserts the REWRITTEN ceremony: the screen submits a self-signed registration-request
 * document and a self-signed association-request document (never `register()`/
 * `issueAttestationChallenge()`/`associate()`/`.commit()`), polls (bounded) for a challenge-issued
 * decision notice, still runs `producer.produce(challenge)` in the same biometric-last position,
 * then submits a self-signed attestation-answer document — all through mocked
 * `IRegistrationRequestTransport`/`IAssociationRequestTransport` interfaces, never a concrete
 * binding. The officer signer (`useVoterApp().sign`) must never be passed to any transport mock,
 * proven by IDENTITY comparison, not a string/name check.
 */
import React from 'react';
import renderer from 'react-test-renderer';
import '../../../i18n'; // initializes the global i18next instance useTranslation() reads from

const mockPopToTop = jest.fn();
const mockSendIntent = jest.fn(async (..._args: unknown[]) => undefined);

jest.mock('@react-navigation/native', () => ({
	useNavigation: () => ({popToTop: mockPopToTop}),
	useTheme: () => ({
		colors: {
			primary: '#2196f3',
			background: '#fbfbfb',
			text: '#000000',
			textSecondary: '#7d7d7d',
			light: '#ffffff',
		},
		fonts: {
			regular: {fontFamily: 'System', fontWeight: '400'},
			medium: {fontFamily: 'System', fontWeight: '500'},
		},
		type: {
			h2: {fontSize: 28, lineHeight: 34},
			body: {fontSize: 16, lineHeight: 22},
			caption: {fontSize: 16, lineHeight: 20},
		},
		radii: {pill: 999},
	}),
}));

jest.mock('react-native/Libraries/Linking/Linking', () => ({
	sendIntent: (...args: unknown[]) => mockSendIntent(...args),
}));

// ---- Mocked engine boundary: getEngine('network') ----

const callOrder: string[] = [];

const mockGetDetails = jest.fn(async () => ({
	network: {primaryAuthorityId: 'authority-1'},
}));
const mockNetworkEngine = {getDetails: mockGetDetails};

const mockGetEngine = jest.fn(async (engineName: string) => {
	if (engineName === 'network') {
		return mockNetworkEngine;
	}
	throw new Error(`unexpected getEngine call: ${engineName}`);
});

const SEEDED_ELECTION_ID = 'election-1';
const P256_PUB = 'P256_PUB';
const CHALLENGE_NONCE = 'challenge-nonce-abc';
const DEVICE_IDENTITY_PUBLIC_KEY = 'DEVICE_IDENTITY_SECP256K1_PUBLIC_KEY';

// The officer signer — must NEVER be passed to any transport mock (identity-compared, not a
// string check).
const mockSign = jest.fn(async () => ({
	signerUserId: 'device-user-1',
	signerKey: 'device-pub-key',
	signature: 'stub-officer-signature',
}));

jest.mock('../../../providers/VoterAppProvider', () => ({
	useVoterApp: () => ({
		seededElectionId: SEEDED_ELECTION_ID,
		// Kept on the provider mock (51-12 owns the provider blast radius) even though this
		// rewritten screen never destructures it — the point under test is that it is never REACHED,
		// not that the provider stopped exposing it.
		sign: mockSign,
		getEngine: mockGetEngine,
	}),
}));

const mockClearDraft = jest.fn();
const sampleDraft = {
	firstName: 'Jane',
	lastName: 'Doe',
	dob: '01/01/1990',
	email: 'jane@example.com',
	phone: '555-1234',
	addressLine1: '123 Main St',
	addressLine2: '',
	addressLine3: '',
	party: 'democratic',
};
// Mutable so individual tests can vary the draft (e.g. a blank required field for WR-04);
// reset to a fresh copy of sampleDraft in beforeEach.
let mockDraft = {...sampleDraft};

jest.mock('../../../providers/RegistrationDraftProvider', () => ({
	useRegistrationDraft: () => ({
		draft: mockDraft,
		clearDraft: mockClearDraft,
	}),
}));

const mockGetOrCreateDeviceUser = jest.fn(async (..._args: unknown[]) => ({
	id: 'device-user-1',
	name: 'Dev Voter',
	activeKeys: [{key: DEVICE_IDENTITY_PUBLIC_KEY, type: 'mobile', expiration: 9999999999999}],
}));
jest.mock('../../../engines/device-user', () => ({
	getOrCreateDeviceUser: (...args: unknown[]) => mockGetOrCreateDeviceUser(...args),
}));

// The voter's OWN device signer (secp256k1, software) — distinct object identity from mockSign
// (the officer signer) even though both close over the same underlying key in the real app. This
// distinctness is exactly what the "never passes the officer signer" test proves.
const mockDeviceSign = jest.fn(async (_digest: Uint8Array) => ({
	signerUserId: 'device-user-1',
	signerKey: DEVICE_IDENTITY_PUBLIC_KEY,
	signature: 'device-identity-signature',
}));
const mockCreateDeviceSigner = jest.fn(async (..._args: unknown[]) => mockDeviceSign);
jest.mock('../../../engines/device-signer', () => ({
	createDeviceSigner: (...args: unknown[]) => mockCreateDeviceSigner(...args),
}));

const mockProvisionDeviceKey = jest.fn(async () => {
	callOrder.push('provisionDeviceKey');
	return {publicKey: P256_PUB};
});
const mockProduce = jest.fn(async (challenge: {nonce: string}) => {
	callOrder.push('produce');
	return {
		publicKey: P256_PUB,
		deviceId: 'DEVICE_ID',
		attestationTime: Date.now(),
		certificateChain: ['CERT'],
		platformDetails: {type: 'Android' as const, safetyNetAttestation: 'x', keystorePublicKey: P256_PUB, nonce: challenge.nonce},
	};
});
const mockSignDeviceKeyDigest = jest.fn(async (_digest: Uint8Array) => ({
	signerUserId: '',
	signerKey: P256_PUB,
	signature: 'p256-request-signature',
}));
const mockResolveAttestationProducer = jest.fn((..._args: unknown[]) => ({
	provisionDeviceKey: mockProvisionDeviceKey,
	produce: mockProduce,
	signDeviceKeyDigest: mockSignDeviceKeyDigest,
}));
jest.mock('../../../engines/attestation-producer', () => ({
	resolveAttestationProducer: (...args: unknown[]) => mockResolveAttestationProducer(...args),
}));

// ---- Mocked D-08 transport boundary: resolveVoterRequestTransports() ----

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const registrationRequestInits: any[] = [];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const registrationSubmitCalls: any[] = [];
const mockRegistrationSubmitRequest = jest.fn(
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	async (init: any, requesterKey: string, signatureOrCallback: unknown) => {
		callOrder.push('registration.submitRequest');
		registrationRequestInits.push(init);
		registrationSubmitCalls.push({init, requesterKey, signatureOrCallback});
		return init.id as string;
	},
);

let capturedAssociationRequestId: string | undefined;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const associationSubmitRequestCalls: any[] = [];
const mockAssociationSubmitRequest = jest.fn(
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	async (init: any, requesterKey: string, signatureOrCallback: unknown) => {
		callOrder.push('association.submitRequest');
		capturedAssociationRequestId = init.id;
		associationSubmitRequestCalls.push({init, requesterKey, signatureOrCallback});
		return init.id as string;
	},
);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const associationSubmitAttestationCalls: any[] = [];
const mockAssociationSubmitAttestation = jest.fn(
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	async (answer: any, requesterKey: string, signatureOrCallback: unknown) => {
		callOrder.push('association.submitAttestation');
		associationSubmitAttestationCalls.push({answer, requesterKey, signatureOrCallback});
	},
);

const mockPollDecisions = jest.fn(async (_sinceCursor?: string) => {
	callOrder.push('association.pollDecisions');
	return [
		{
			requestId: capturedAssociationRequestId,
			status: 'c',
			challengeNonce: CHALLENGE_NONCE,
			cursor: 'cursor-1',
		},
	];
});

const mockRegistrationTransport = {
	submitRequest: mockRegistrationSubmitRequest,
	pollDecisions: jest.fn(async () => []),
};
const mockAssociationTransport = {
	submitRequest: mockAssociationSubmitRequest,
	submitAttestation: mockAssociationSubmitAttestation,
	pollDecisions: mockPollDecisions,
};

type ResolvedTransports = {
	registrationTransport: typeof mockRegistrationTransport;
	associationTransport: typeof mockAssociationTransport;
};
const mockResolveVoterRequestTransports = jest.fn(
	(..._args: unknown[]): ResolvedTransports | undefined => ({
		registrationTransport: mockRegistrationTransport,
		associationTransport: mockAssociationTransport,
	}),
);
jest.mock('../attach-voter-request-transport', () => ({
	resolveVoterRequestTransports: (...args: unknown[]) => mockResolveVoterRequestTransports(...args),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const ConfirmationScreen = require('../ConfirmationScreen').default;

function renderScreen() {
	let tr!: renderer.ReactTestRenderer;
	renderer.act(() => {
		tr = renderer.create(<ConfirmationScreen />);
	});
	return tr;
}

/** Flushes chained microtasks. The rewritten ceremony has more awaited steps than the old one
 * (device signer resolution, two transport submits, a bounded decision poll, the attestation
 * submit), and the poll-exhaustion test drives up to MAX_POLL_ATTEMPTS (20) loop iterations — so
 * this flushes generously rather than counting exact ticks. */
async function flushMicrotasks(times = 60) {
	for (let i = 0; i < times; i++) {
		await Promise.resolve();
	}
}

async function pressConfirm(tr: renderer.ReactTestRenderer, testID = 'confirmation-confirm-face-id', flushes = 60) {
	const cta = tr.root.findByProps({testID});
	await renderer.act(async () => {
		cta.props.onPress();
		await flushMicrotasks(flushes);
	});
}

beforeEach(() => {
	mockPopToTop.mockClear();
	mockClearDraft.mockClear();
	mockSign.mockClear();
	mockCreateDeviceSigner.mockClear();
	mockDeviceSign.mockClear();
	mockGetOrCreateDeviceUser.mockClear();
	mockSendIntent.mockClear();
	mockProvisionDeviceKey.mockClear();
	mockProduce.mockClear();
	mockSignDeviceKeyDigest.mockClear();
	mockRegistrationSubmitRequest.mockClear();
	mockAssociationSubmitRequest.mockClear();
	mockAssociationSubmitAttestation.mockClear();
	mockPollDecisions.mockClear();
	mockResolveVoterRequestTransports.mockClear();

	mockProvisionDeviceKey.mockImplementation(async () => {
		callOrder.push('provisionDeviceKey');
		return {publicKey: P256_PUB};
	});
	mockProduce.mockImplementation(async (challenge: {nonce: string}) => {
		callOrder.push('produce');
		return {
			publicKey: P256_PUB,
			deviceId: 'DEVICE_ID',
			attestationTime: Date.now(),
			certificateChain: ['CERT'],
			platformDetails: {type: 'Android' as const, safetyNetAttestation: 'x', keystorePublicKey: P256_PUB, nonce: challenge.nonce},
		};
	});
	mockPollDecisions.mockImplementation(async (_sinceCursor?: string) => {
		callOrder.push('association.pollDecisions');
		return [
			{
				requestId: capturedAssociationRequestId,
				status: 'c',
				challengeNonce: CHALLENGE_NONCE,
				cursor: 'cursor-1',
			},
		];
	});
	mockResolveVoterRequestTransports.mockImplementation(() => ({
		registrationTransport: mockRegistrationTransport,
		associationTransport: mockAssociationTransport,
	}));

	callOrder.length = 0;
	capturedAssociationRequestId = undefined;
	registrationRequestInits.length = 0;
	registrationSubmitCalls.length = 0;
	associationSubmitRequestCalls.length = 0;
	associationSubmitAttestationCalls.length = 0;
	mockDraft = {...sampleDraft};
});

describe('ConfirmationScreen (D-01/D-02/D-03/D-05/D-07/D-08/D-09/D-11/D-12/D-18)', () => {
	it("renders the 'You're all set!' heading and the confirm CTA", () => {
		const tr = renderScreen();
		const text = JSON.stringify(tr.toJSON());
		expect(text).toContain("You're all set!");

		const cta = tr.root.findByProps({testID: 'confirmation-confirm-face-id'});
		expect(cta).toBeDefined();
	});

	it('does NOT navigate on mount (only on the deliberate press)', () => {
		renderScreen();
		expect(mockPopToTop).not.toHaveBeenCalled();
	});

	it(
		'pressing the CTA drives: registration submitRequest -> association submitRequest -> ' +
			'pollDecisions (challenge issued) -> produce -> submitAttestation, in that exact order, ' +
			'each exactly once, then shows the pending state (D-05/D-11/D-18)',
		async () => {
			const tr = renderScreen();
			await pressConfirm(tr);

			expect(callOrder).toEqual([
				'provisionDeviceKey',
				'registration.submitRequest',
				'association.submitRequest',
				'association.pollDecisions',
				'produce',
				'association.submitAttestation',
			]);
			expect(mockRegistrationSubmitRequest).toHaveBeenCalledTimes(1);
			expect(mockAssociationSubmitRequest).toHaveBeenCalledTimes(1);
			expect(mockPollDecisions).toHaveBeenCalledTimes(1);
			expect(mockProduce).toHaveBeenCalledTimes(1);
			expect(mockAssociationSubmitAttestation).toHaveBeenCalledTimes(1);

			// Order is also proven via jest's own invocation-call-order counters, not merely the
			// hand-rolled log above.
			const orders = [
				mockRegistrationSubmitRequest.mock.invocationCallOrder[0],
				mockAssociationSubmitRequest.mock.invocationCallOrder[0],
				mockPollDecisions.mock.invocationCallOrder[0],
				mockProduce.mock.invocationCallOrder[0],
				mockAssociationSubmitAttestation.mock.invocationCallOrder[0],
			];
			expect(orders).toEqual([...orders].sort((a, b) => a - b));

			const text = JSON.stringify(tr.toJSON());
			expect(text).toContain('submitted');
			expect(mockClearDraft).toHaveBeenCalledTimes(1);
			// The screen intentionally does NOT pop to top on this pending outcome — see
			// ConfirmationScreen.tsx's header comment. Popping would imply a decided success this
			// screen cannot yet prove.
			expect(mockPopToTop).not.toHaveBeenCalled();
		},
	);

	it('never passes the officer signer (useVoterApp().sign) to any transport mock — identity, not string, comparison (D-01/D-07)', async () => {
		const tr = renderScreen();
		await pressConfirm(tr);

		const allArgs = [
			...registrationSubmitCalls.flatMap(c => [c.requesterKey, c.signatureOrCallback]),
			...associationSubmitRequestCalls.flatMap(c => [c.requesterKey, c.signatureOrCallback]),
			...associationSubmitAttestationCalls.flatMap(c => [c.requesterKey, c.signatureOrCallback]),
		];
		expect(allArgs).not.toContain(mockSign);
		expect(mockSign).not.toHaveBeenCalled();
	});

	it('binds the association request to the P-256 provisioned key, never the secp256k1 device identity key (D-02/D-03)', async () => {
		const tr = renderScreen();
		await pressConfirm(tr);

		expect(associationSubmitRequestCalls).toHaveLength(1);
		expect(associationSubmitRequestCalls[0].init.deviceKey).toBe(P256_PUB);
		expect(associationSubmitRequestCalls[0].requesterKey).toBe(P256_PUB);
		expect(associationSubmitRequestCalls[0].init.deviceKey).not.toBe(DEVICE_IDENTITY_PUBLIC_KEY);
	});

	it('threads seededElectionId onto the association request and the registration payload (D-11/D-10)', async () => {
		const tr = renderScreen();
		await pressConfirm(tr);

		expect(associationSubmitRequestCalls[0].init.electionId).toBe(SEEDED_ELECTION_ID);
		expect(registrationRequestInits[0].payload.electionId).toBe(SEEDED_ELECTION_ID);
	});

	it('the transport resolver returning undefined (both dev gates closed) surfaces the generic failure class and does not crash', async () => {
		mockResolveVoterRequestTransports.mockReturnValueOnce(undefined);

		const tr = renderScreen();
		await pressConfirm(tr);

		const text = JSON.stringify(tr.toJSON());
		expect(text).toContain('Something went wrong verifying your device. Try again.');
		expect(mockRegistrationSubmitRequest).not.toHaveBeenCalled();
		expect(mockClearDraft).not.toHaveBeenCalled();
	});

	it('a pollDecisions that never yields a challenge-issued notice within the bounded attempts surfaces the generic failure class', async () => {
		mockPollDecisions.mockImplementation(async () => {
			callOrder.push('association.pollDecisions');
			return [];
		});

		const tr = renderScreen();
		await pressConfirm(tr, 'confirmation-confirm-face-id', 400);

		const text = JSON.stringify(tr.toJSON());
		expect(text).toContain('Something went wrong verifying your device. Try again.');
		expect(mockProduce).not.toHaveBeenCalled();
		expect(mockAssociationSubmitAttestation).not.toHaveBeenCalled();
		expect(mockClearDraft).not.toHaveBeenCalled();
		// Bounded — not unbounded (T-51-11-07).
		expect(mockPollDecisions.mock.calls.length).toBeGreaterThan(0);
		expect(mockPollDecisions.mock.calls.length).toBeLessThan(1000);
	});

	it('a produce() rejection surfaces the generic failure class and submitAttestation is NOT called', async () => {
		mockProduce.mockRejectedValueOnce(new Error('produce failed: attestation error'));

		const tr = renderScreen();
		await pressConfirm(tr);

		const text = JSON.stringify(tr.toJSON());
		expect(text).toContain('Something went wrong verifying your device. Try again.');
		expect(mockAssociationSubmitAttestation).not.toHaveBeenCalled();
		expect(mockClearDraft).not.toHaveBeenCalled();
		expect(mockPopToTop).not.toHaveBeenCalled();
	});

	it('reuses the same registration-request id across a retry (WR-02 — no duplicate/orphaned rows)', async () => {
		// First attempt: both requests submit fine but the attestation-answer submit rejects, so the
		// ceremony fails mid-flight and the CTA becomes "Try Again".
		mockAssociationSubmitAttestation.mockRejectedValueOnce(new Error('submitAttestation failed: transient'));

		const tr = renderScreen();
		await pressConfirm(tr); // attempt 1 — both submits + poll + produce ok, submitAttestation fails
		await pressConfirm(tr, 'confirmation-confirm-face-id'); // attempt 2 — retry of the SAME submission

		expect(registrationRequestInits).toHaveLength(2);
		expect(registrationRequestInits[0].id).toBe(registrationRequestInits[1].id);
		expect(associationSubmitRequestCalls).toHaveLength(2);
		expect(associationSubmitRequestCalls[0].init.id).toBe(associationSubmitRequestCalls[1].init.id);
		expect(associationSubmitRequestCalls[0].init.registrantId).toBe(associationSubmitRequestCalls[1].init.registrantId);
	});

	it('does not furnish a blank required field on the registration payload (WR-04 — empty required rejected by policy)', async () => {
		// A blank required private field (email) must NOT be furnished as {name:'email', value:''}
		// — that would satisfy the engine's name-presence check and slip past policy. With the
		// empty entry dropped, email is genuinely absent, so validateFieldPolicy rejects it.
		mockDraft = {...sampleDraft, email: '', phone: ''};

		const tr = renderScreen();
		await pressConfirm(tr);

		expect(registrationRequestInits).toHaveLength(1);
		const details = registrationRequestInits[0].payload.private.details as Array<{name: string; value: string}>;
		const names = details.map(d => d.name);
		expect(names).not.toContain('email');
		expect(names).not.toContain('phone');
		// No furnished detail is ever an empty-valued placeholder.
		expect(details.every(d => d.value !== '')).toBe(true);
	});

	describe('D-09 three-way failure UX', () => {
		it('NO_BIOMETRICS_ENROLLED renders the setup prompt + deep-link CTA, and a separate retry — no clearDraft/popToTop', async () => {
			mockProduce.mockRejectedValueOnce({code: 'NO_BIOMETRICS_ENROLLED'});

			const tr = renderScreen();
			await pressConfirm(tr);

			const text = JSON.stringify(tr.toJSON());
			expect(text).toContain('Set up fingerprint or face unlock to continue');
			expect(text).toContain('Set up device unlock');
			expect(mockClearDraft).not.toHaveBeenCalled();
			expect(mockPopToTop).not.toHaveBeenCalled();

			const setupCta = tr.root.findByProps({testID: 'confirmation-setup-cta'});
			await renderer.act(async () => {
				setupCta.props.onPress();
				await flushMicrotasks(10);
			});
			expect(mockSendIntent).toHaveBeenCalledWith('android.settings.BIOMETRIC_ENROLL');

			// The existing retry affordance re-runs onConfirm reusing the same registrantId.
			const retryCta = tr.root.findByProps({testID: 'confirmation-retry-cta'});
			expect(retryCta).toBeDefined();
		});

		it('falls back to SECURITY_SETTINGS when BIOMETRIC_ENROLL intent fails', async () => {
			mockProduce.mockRejectedValueOnce({code: 'NO_BIOMETRICS_ENROLLED'});
			mockSendIntent.mockImplementationOnce(async () => {
				throw new Error('intent not resolvable');
			});

			const tr = renderScreen();
			await pressConfirm(tr);

			const setupCta = tr.root.findByProps({testID: 'confirmation-setup-cta'});
			await renderer.act(async () => {
				setupCta.props.onPress();
				await flushMicrotasks(10);
			});

			expect(mockSendIntent).toHaveBeenNthCalledWith(1, 'android.settings.BIOMETRIC_ENROLL');
			expect(mockSendIntent).toHaveBeenNthCalledWith(2, 'android.settings.SECURITY_SETTINGS');
		});

		it("a transient-class code (e.g. LOCKOUT) renders the generic transient copy with a 'Try Again' retry", async () => {
			mockProduce.mockRejectedValueOnce({code: 'LOCKOUT'});

			const tr = renderScreen();
			await pressConfirm(tr);

			const text = JSON.stringify(tr.toJSON());
			expect(text).toContain('Something went wrong verifying your device. Try again.');
			expect(text).toContain('Try Again');
			const cta = tr.root.findByProps({testID: 'confirmation-confirm-face-id'});
			expect(cta).toBeDefined();
		});

		it('a terminal-class code (release build, __DEV__ false) renders the terminal wall with NO retry CTA', async () => {
			const originalDev = (globalThis as {__DEV__?: boolean}).__DEV__;
			(globalThis as {__DEV__?: boolean}).__DEV__ = false;
			mockProvisionDeviceKey.mockRejectedValueOnce({code: 'NO_STRONGBOX_OR_TEE'});

			const tr = renderScreen();
			await pressConfirm(tr);

			const text = JSON.stringify(tr.toJSON());
			expect(text).toContain("This device can't be used to vote");
			expect(tr.root.findAllByProps({testID: 'confirmation-confirm-face-id'})).toHaveLength(0);
			expect(tr.root.findAllByProps({testID: 'confirmation-retry-cta'})).toHaveLength(0);
			expect(tr.root.findAllByProps({testID: 'confirmation-setup-cta'})).toHaveLength(0);

			(globalThis as {__DEV__?: boolean}).__DEV__ = originalDev;
		});
	});
});
