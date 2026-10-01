/**
 * Unit tests for RegistrationScreen (REG-01/REG-05) — the real not-registered/registered card
 * host. Mocks `useNavigation` (spy-able jest.fn()) while keeping the rest of
 * `@react-navigation/native` real (ThemeProvider + useTheme) so the composed `RegistrationCard`
 * renders through the real theme, and mocks `useVoterApp`/`useRegistrationDraft` to drive
 * fixture provider state without mounting either real provider — mirrors
 * `RegistrationCard.test.tsx`'s theme-wrapping convention and
 * `DeviceAttestationScreen.test.tsx`'s navigation-mock convention.
 *
 * Phase 44-07 (D-02): `isRegistered`/`registeredAt`/`setIsRegistered` are no longer
 * `useVoterApp()` context fields — `RegistrationScreen` now owns them as local component state,
 * driven via its own `__DEV__`-gated dev-toggle (testID `registration-dev-toggle`) rather than a
 * mocked context setter (see `RegistrationScreen.tsx`'s file header comment). The mocked
 * `useVoterApp` now only needs to supply `isInitialized`.
 */
import React from 'react';
import renderer from 'react-test-renderer';
import {ThemeProvider} from '@react-navigation/native';
import {lightTheme} from '../../../theme/themes';
import {EMPTY_DRAFT} from '../../../providers/RegistrationDraftProvider';
import type {RegistrationDraft} from '../../../providers/RegistrationDraftProvider';
import '../../../i18n'; // initializes the global i18next instance useTranslation() reads from

const mockNavigate = jest.fn();
let latestFocusCallback: (() => void) | null = null;

jest.mock('@react-navigation/native', () => {
	const actual = jest.requireActual('@react-navigation/native');
	return {
		...actual,
		useNavigation: () => ({navigate: mockNavigate}),
		// Plan 28 (D-45): the real `useFocusEffect` needs a NavigationContainer ancestor this test
		// never mounts (mirrors `ConfirmationScreen.test.tsx`'s own shim) — runs the callback on
		// mount/dependency-change and exposes it so a test can re-fire a "focus".
		useFocusEffect: (cb: () => void) => {
			latestFocusCallback = cb;
			// eslint-disable-next-line @typescript-eslint/no-var-requires, react-hooks/rules-of-hooks
			require('react').useEffect(() => {
				const cleanup = cb();
				return typeof cleanup === 'function' ? cleanup : undefined;
			}, [cb]);
		},
	};
});

// Phase 44-07 (D-02/D-04): do NOT jest.requireActual the real VoterAppProvider module here —
// it now transitively imports CadreNodeProvider (real @serfab/cadre-core +
// @optimystic/db-p2p-storage-rn, ESM-only native deps this Jest RN environment cannot resolve).
// This test never renders <VoterAppProvider> (only RegistrationScreen's useVoterApp() call,
// mocked below), so a plain inert stand-in is sufficient.
jest.mock('../../../providers/VoterAppProvider', () => ({
	useVoterApp: jest.fn(),
	VoterAppProvider: ({children}: {children: React.ReactNode}) => children,
}));

jest.mock('../../../providers/RegistrationDraftProvider', () => {
	const actual = jest.requireActual('../../../providers/RegistrationDraftProvider');
	return {
		...actual,
		useRegistrationDraft: jest.fn(),
	};
});

// Plan 28 (D-45): mock resolveRegistrationCodeAvailability only — a pure stand-in, never the real
// engine reads (this test drives no real network/engine tree).
const mockResolveRegistrationCodeAvailability = jest.fn(
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	async (..._args: unknown[]): Promise<any> => ({kind: 'unavailable'}),
);
jest.mock('../../../engines/continuity', () => ({
	resolveRegistrationCodeAvailability: (...args: unknown[]) => mockResolveRegistrationCodeAvailability(...args),
}));
jest.mock('../../../engines/attestation-producer', () => ({
	resolveAttestationProducer: () => ({
		provisionDeviceKey: async () => ({publicKey: 'P256_PUB'}),
	}),
}));

import {useVoterApp} from '../../../providers/VoterAppProvider';
import {useRegistrationDraft} from '../../../providers/RegistrationDraftProvider';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const RegistrationScreen = require('../RegistrationScreen').default;

const mockUseVotingApp = useVoterApp as jest.Mock;
const mockUseRegistrationDraft = useRegistrationDraft as jest.Mock;
const mockGetEngine = jest.fn(async () => {
	throw new Error('getEngine is not available in this test — mock resolveRegistrationCodeAvailability instead');
});

function setProviderState(overrides: {draft?: RegistrationDraft} = {}) {
	mockUseVotingApp.mockReturnValue({
		isInitialized: true,
		getEngine: mockGetEngine,
	});
	mockUseRegistrationDraft.mockReturnValue({
		draft: overrides.draft ?? EMPTY_DRAFT,
		updateField: jest.fn(),
		resetDraft: jest.fn(),
	});
}

function renderScreen() {
	let tr!: renderer.ReactTestRenderer;
	renderer.act(() => {
		tr = renderer.create(
			<ThemeProvider value={lightTheme}>
				<RegistrationScreen />
			</ThemeProvider>,
		);
	});
	return tr;
}

/** Presses RegistrationScreen's own __DEV__-gated dev-toggle to flip local isRegistered true
 * (Phase 44-07: isRegistered is local component state, not a mocked context field). */
function flipToRegistered(tr: renderer.ReactTestRenderer) {
	const toggle = tr.root.findByProps({testID: 'registration-dev-toggle'});
	renderer.act(() => {
		toggle.props.onPress();
	});
}

describe('RegistrationScreen (REG-01/REG-05)', () => {
	beforeEach(() => {
		mockNavigate.mockClear();
		mockResolveRegistrationCodeAvailability.mockClear();
		mockResolveRegistrationCodeAvailability.mockImplementation(async () => ({kind: 'unavailable'}));
		latestFocusCallback = null;
	});

	it('not-registered: Register-now CTA navigates to DeviceAttestation', () => {
		setProviderState();
		const tr = renderScreen();

		const cta = tr.root.findByProps({testID: 'registration-card-register-now'});
		renderer.act(() => {
			cta.props.onPress();
		});
		expect(mockNavigate).toHaveBeenCalledWith('DeviceAttestation');
	});

	it('registered: Update CTA navigates to RegisterPersonal (NOT DeviceAttestation, D-04)', () => {
		setProviderState({draft: {...EMPTY_DRAFT, firstName: 'Jane', lastName: 'Doe'}});
		const tr = renderScreen();
		flipToRegistered(tr);

		const cta = tr.root.findByProps({testID: 'registration-card-update'});
		renderer.act(() => {
			cta.props.onPress();
		});
		expect(mockNavigate).toHaveBeenCalledWith('RegisterPersonal');
		expect(mockNavigate).not.toHaveBeenCalledWith('DeviceAttestation');
	});

	it('registered: help (?) navigates to RegistrationInfo', () => {
		setProviderState();
		const tr = renderScreen();
		flipToRegistered(tr);

		const helpButton = tr.root.findByProps({testID: 'registration-card-help'});
		renderer.act(() => {
			helpButton.props.onPress();
		});
		expect(mockNavigate).toHaveBeenCalledWith('RegistrationInfo');
	});

	it('contains no Phase-39 dev-trigger Pressables', () => {
		setProviderState();
		const tr = renderScreen();
		const text = JSON.stringify(tr.toJSON());
		expect(text).not.toContain('Open Device Attestation (dev)');
		expect(text).not.toContain('Open Confirmation (dev)');
	});
});

describe('RegistrationScreen — registration code re-show / entry links (D-40/D-45)', () => {
	beforeEach(() => {
		mockNavigate.mockClear();
		mockResolveRegistrationCodeAvailability.mockClear();
		latestFocusCallback = null;
	});

	async function flush(times = 10) {
		for (let i = 0; i < times; i++) {
			await Promise.resolve();
		}
	}

	it("'available' renders code.showAgainLink; pressing it re-resolves and reveals the card with the fresh code", async () => {
		mockResolveRegistrationCodeAvailability.mockImplementation(async () => ({kind: 'available', code: 'ABCDE12345'}));
		setProviderState();
		let tr!: renderer.ReactTestRenderer;
		await renderer.act(async () => {
			tr = renderer.create(
				<ThemeProvider value={lightTheme}>
					<RegistrationScreen />
				</ThemeProvider>,
			);
			await flush();
		});

		const link = tr.root.findByProps({testID: 'registration-code-show-again-link'});
		const flatStyle = Object.assign({}, ...[].concat(link.props.style));
		expect(flatStyle.minHeight).toBeGreaterThanOrEqual(44);

		const callsBefore = mockResolveRegistrationCodeAvailability.mock.calls.length;
		mockResolveRegistrationCodeAvailability.mockImplementationOnce(async () => ({kind: 'available', code: 'ABCDEFGHJK'}));
		await renderer.act(async () => {
			link.props.onPress();
			await flush();
		});
		expect(mockResolveRegistrationCodeAvailability.mock.calls.length).toBeGreaterThan(callsBefore);

		const value = tr.root.findByProps({testID: 'registration-code-value'});
		expect(value.props.children).toBe('ABCDE-FGHJK');
	});

	it("'available' then a second resolve returning 'unavailable' shows the card's unavailable state", async () => {
		mockResolveRegistrationCodeAvailability.mockImplementation(async () => ({kind: 'available', code: 'ABCDE12345'}));
		setProviderState();
		let tr!: renderer.ReactTestRenderer;
		await renderer.act(async () => {
			tr = renderer.create(
				<ThemeProvider value={lightTheme}>
					<RegistrationScreen />
				</ThemeProvider>,
			);
			await flush();
		});

		mockResolveRegistrationCodeAvailability.mockImplementationOnce(async () => ({kind: 'unavailable'}));
		const link = tr.root.findByProps({testID: 'registration-code-show-again-link'});
		await renderer.act(async () => {
			link.props.onPress();
			await flush();
		});

		expect(tr.root.findAllByProps({testID: 'registration-code-value'})).toHaveLength(0);
	});

	it("'not-registered' renders newDevice.entryLink, whose press navigates to ContinueOnAnotherDevice", async () => {
		mockResolveRegistrationCodeAvailability.mockImplementation(async () => ({kind: 'not-registered'}));
		setProviderState();
		let tr!: renderer.ReactTestRenderer;
		await renderer.act(async () => {
			tr = renderer.create(
				<ThemeProvider value={lightTheme}>
					<RegistrationScreen />
				</ThemeProvider>,
			);
			await flush();
		});

		const link = tr.root.findByProps({testID: 'continue-device-entry-link'});
		renderer.act(() => {
			link.props.onPress();
		});
		expect(mockNavigate).toHaveBeenCalledWith('ContinueOnAnotherDevice');
	});

	it.each(['not-sent', 'not-holder'])(
		"'%s' renders neither link but renders the code.notAvailableOnDevice notice, with no numberOfLines",
		async kind => {
			mockResolveRegistrationCodeAvailability.mockImplementation(async () => ({kind}));
			setProviderState();
			let tr!: renderer.ReactTestRenderer;
			await renderer.act(async () => {
				tr = renderer.create(
					<ThemeProvider value={lightTheme}>
						<RegistrationScreen />
					</ThemeProvider>,
				);
				await flush();
			});

			expect(tr.root.findAllByProps({testID: 'registration-code-show-again-link'})).toHaveLength(0);
			expect(tr.root.findAllByProps({testID: 'continue-device-entry-link'})).toHaveLength(0);
			const notice = tr.root.findByProps({testID: 'registration-code-not-available'});
			expect(notice.props.numberOfLines).toBeUndefined();
		},
	);

	it("'unavailable' renders neither link nor the notAvailableOnDevice notice", async () => {
		mockResolveRegistrationCodeAvailability.mockImplementation(async () => ({kind: 'unavailable'}));
		setProviderState();
		let tr!: renderer.ReactTestRenderer;
		await renderer.act(async () => {
			tr = renderer.create(
				<ThemeProvider value={lightTheme}>
					<RegistrationScreen />
				</ThemeProvider>,
			);
			await flush();
		});

		expect(tr.root.findAllByProps({testID: 'registration-code-show-again-link'})).toHaveLength(0);
		expect(tr.root.findAllByProps({testID: 'continue-device-entry-link'})).toHaveLength(0);
		expect(tr.root.findAllByProps({testID: 'registration-code-not-available'})).toHaveLength(0);
	});
});
