/**
 * KeyholderInvitationScreen.test.tsx — INV-04/05 screen-layer coverage, extended by Phase 62 Plan
 * 26 (D-21, D-26) for the accept path's keyholder-provisioning behavior (S1-S5).
 *
 * Phase 39 plan 39-04 (DEBT-09 test-coverage backfill, todo
 * 2026-06-24-inv-02-04-05-test-coverage). No jest coverage previously existed
 * for this screen (21-14 was UAT-only). Scaffolded from
 * RevokeKeyScreen.test.tsx / AuthorityInvitationScreen.test.tsx (same
 * react-test-renderer + mock*-prefixed module slots convention).
 *
 * KeyholderInvitationScreen's send path (INV-03) calls the un-gated
 * `electionEngine.inviteKeyholder` directly — there is no
 * createXInvite/saveInviteWithSigning device-signer ceremony here (WR-04:
 * no fabricated inviteSignature), so this file covers the shared
 * success-gated-navigation contract (INV-04/05, accept + decline):
 * navigation.goBack() is called ONLY when the accept/decline resolves; on a
 * thrown/rejected respondToInvite, goBack is NOT called and errorMessage is
 * set (rendered by <InlineError>).
 *
 * 62-26: accept now provisions a fresh keyholder identity (D-21) through
 * `acceptKeyholderInvitation`/`resolveKeyholderKeyVault`, so this file sets a test vault override
 * via `setKeyholderKeyVaultForTests` in `beforeEach`/clears it in `afterEach`, and mocks
 * `../../../engines/device-signer` to prove the officer's device key is never touched by accept.
 */

import React from 'react';
import renderer from 'react-test-renderer';
import { setKeyholderKeyVaultForTests } from '../../../engines/keyholder-vault';

const mockGoBack = jest.fn();
const mockSetOptions = jest.fn();

const mockRouteParams: { mode: 'send' | 'accept'; invitationId?: string } = {
  mode: 'accept',
  invitationId: 'invite-1',
};

const mockRespondToInvite = jest.fn(
  async (
    _invitationId: string,
    _accept: boolean,
    _invitePrivate?: string,
    _digest?: string,
    _invokedId?: string,
    _provisioning?: { signingKey: { key: string; type: string; expiration: number }; dkgPublicKey: string; sign: (digest: Uint8Array) => Promise<unknown> }
  ) => {}
);
const mockGetKeyholderInvite = jest.fn(async () => undefined);
const mockInvitationEngine = {
  respondToInvite: mockRespondToInvite,
  getKeyholderInvite: mockGetKeyholderInvite,
};

const mockGetEngine = jest.fn(async (name: string) => {
  if (name === 'invitations') return mockInvitationEngine;
  return undefined;
});

const mockCreateDeviceSigner = jest.fn(async (_displayName: string) => jest.fn());

jest.mock('../../../engines/device-signer', () => ({
  createDeviceSigner: (displayName: string) => mockCreateDeviceSigner(displayName),
}));

jest.mock('react-native-vector-icons/FontAwesome6', () => 'FontAwesome6');

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  // 49-07: device-signer.ts now imports the app's `i18n` singleton (src/i18n/index.ts) at
  // module scope to resolve the native BiometricPrompt's prompt strings, and this screen
  // imports device-signer.ts directly (not mocked, unlike every other createDeviceSigner call
  // site's test — see this file's own header comment on why). `src/i18n/index.ts` calls
  // `i18n.use(initReactI18next).init(...)` at ITS OWN module scope, so this mock must supply a
  // real-shaped plugin object (i18next's actual duck-type contract: `{ type: '3rdParty', init }`
  // — see react-i18next's own initReactI18next.js) or `i18n.use(undefined)` throws before this
  // test file's real assertions ever run.
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock('../../../providers/SettingsProvider', () => ({
  useSettings: () => ({ showHelpIcons: false }),
}));

jest.mock('../../../providers/AppProvider', () => ({
  useApp: () => ({ getEngine: mockGetEngine }),
}));

jest.mock('@react-navigation/native', () => ({
  useTheme: () => ({
    colors: {
      primary: '#007AFF',
      background: '#FFFFFF',
      card: '#F2F2F7',
      text: '#000000',
      border: '#C6C6C8',
      notification: '#FF3B30',
      error: '#FF3B30',
      textSecondary: '#888888',
      important: '#FF9500',
      success: '#34C759',
    },
  }),
  useRoute: () => ({ params: mockRouteParams }),
  useNavigation: () => ({ goBack: mockGoBack, navigate: jest.fn(), setOptions: mockSetOptions }),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const KeyholderInvitationModule = require('../KeyholderInvitationScreen');
const KeyholderInvitationScreen =
  KeyholderInvitationModule.default ?? KeyholderInvitationModule.KeyholderInvitationScreen;

async function render() {
  let tr!: renderer.ReactTestRenderer;
  await renderer.act(async () => {
    tr = renderer.create(<KeyholderInvitationScreen />);
  });
  await renderer.act(async () => {
    await Promise.resolve();
  });
  return tr;
}

function buttonByTitle(tr: renderer.ReactTestRenderer, title: string) {
  return tr.root.findAll((n) => n.props?.title === title && typeof n.props?.onPress === 'function')[0];
}

function makeFakeVault(overrides?: { putSecret?: jest.Mock }) {
  return {
    putSecret: overrides?.putSecret ?? jest.fn(async () => undefined),
    getSecret: jest.fn(async () => null),
    hasSecret: jest.fn(async () => false),
    deleteSecret: jest.fn(async () => true),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRespondToInvite.mockResolvedValue(undefined);
  setKeyholderKeyVaultForTests(makeFakeVault() as never);
});

afterEach(() => {
  setKeyholderKeyVaultForTests(undefined);
});

describe('KeyholderInvitationScreen — INV-04/05 + D-21/D-26 (accept mode)', () => {
  it('S1: onAccept calls respondToInvite with 6 arguments (a fresh provisioning), never createDeviceSigner, then navigates back', async () => {
    const tr = await render();

    await renderer.act(async () => {
      await buttonByTitle(tr, 'accept').props.onPress();
      await Promise.resolve();
    });

    expect(mockRespondToInvite).toHaveBeenCalledTimes(1);
    const callArgs = mockRespondToInvite.mock.calls[0];
    expect(callArgs).toHaveLength(6);
    expect(callArgs[0]).toBe('invite-1');
    expect(callArgs[1]).toBe(true);
    expect(callArgs[2]).toBeUndefined();
    expect(callArgs[3]).toBeUndefined();
    expect(typeof callArgs[4]).toBe('string');
    expect(callArgs[4]).toMatch(/^[0-9a-f-]{36}$/i);
    const provisioning = callArgs[5] as { signingKey: { type: string }; dkgPublicKey: string; sign: unknown };
    expect(provisioning.signingKey.type).toBe('M');
    expect(provisioning.dkgPublicKey).toMatch(/^(02|03)[0-9a-f]{64}$/);
    expect(typeof provisioning.sign).toBe('function');

    expect(mockCreateDeviceSigner).not.toHaveBeenCalled();
    expect(mockGoBack).toHaveBeenCalledTimes(1);
  });

  it('S2: a respondToInvite rejection keeps the screen open, shows the message, and discards the minted identity', async () => {
    mockRespondToInvite.mockRejectedValueOnce(new Error('keyholder accept rejected'));
    const fakeVault = makeFakeVault();
    setKeyholderKeyVaultForTests(fakeVault as never);
    const tr = await render();

    await renderer.act(async () => {
      await buttonByTitle(tr, 'accept').props.onPress();
      await Promise.resolve();
    });

    expect(mockGoBack).not.toHaveBeenCalled();
    expect(JSON.stringify(tr.toJSON())).toContain('keyholder accept rejected');
    expect(fakeVault.deleteSecret).toHaveBeenCalled();
    const deletedAliases: string[] = fakeVault.deleteSecret.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(deletedAliases.some((a) => a.startsWith('vt.keyholder-signing.'))).toBe(true);
  });

  it('S3: a vault put rejecting auth-denied renders deviceSigningErrorGeneric, and respondToInvite is never called', async () => {
    const authDeniedError = Object.assign(new Error('nope'), { name: 'KeyVaultError', code: 'auth-denied' });
    setKeyholderKeyVaultForTests(makeFakeVault({ putSecret: jest.fn(async () => { throw authDeniedError; }) }) as never);
    const tr = await render();

    await renderer.act(async () => {
      await buttonByTitle(tr, 'accept').props.onPress();
      await Promise.resolve();
    });

    expect(mockRespondToInvite).not.toHaveBeenCalled();
    expect(JSON.stringify(tr.toJSON())).toContain('deviceSigningErrorGeneric');
    expect(JSON.stringify(tr.toJSON())).not.toContain('nope');
  });

  it('S4: onDecline calls respondToInvite with exactly 3 arguments and provisions nothing', async () => {
    const fakeVault = makeFakeVault();
    setKeyholderKeyVaultForTests(fakeVault as never);
    const tr = await render();

    await renderer.act(async () => {
      await buttonByTitle(tr, 'decline').props.onPress();
      await Promise.resolve();
    });

    expect(mockRespondToInvite).toHaveBeenCalledWith('invite-1', false, undefined);
    expect(mockRespondToInvite.mock.calls[0]).toHaveLength(3);
    expect(fakeVault.putSecret).not.toHaveBeenCalled();
    expect(mockGoBack).toHaveBeenCalledTimes(1);
  });

  it('onDecline does NOT navigate back and sets errorMessage when respondToInvite throws', async () => {
    mockRespondToInvite.mockRejectedValueOnce(new Error('keyholder decline rejected'));
    const tr = await render();

    await renderer.act(async () => {
      await buttonByTitle(tr, 'decline').props.onPress();
      await Promise.resolve();
    });

    expect(mockGoBack).not.toHaveBeenCalled();
    expect(JSON.stringify(tr.toJSON())).toContain('keyholder decline rejected');
  });

  it('S2b: isAccepting resets after a failure, allowing a retry that succeeds', async () => {
    mockRespondToInvite.mockRejectedValueOnce(new Error('transient failure'));
    const tr = await render();

    await renderer.act(async () => {
      await buttonByTitle(tr, 'accept').props.onPress();
      await Promise.resolve();
    });
    expect(mockGoBack).not.toHaveBeenCalled();

    await renderer.act(async () => {
      await buttonByTitle(tr, 'accept').props.onPress();
      await Promise.resolve();
    });
    expect(mockRespondToInvite).toHaveBeenCalledTimes(2);
    expect(mockGoBack).toHaveBeenCalledTimes(1);
  });

  it('S1b: a pasted raw (non-JSON) invite string is still forwarded as invitePrivate', async () => {
    const tr = await render();
    const input = tr.root.findAll((n) => typeof n.props?.onChangeText === 'function')[0];

    await renderer.act(async () => {
      input.props.onChangeText('deadbeef');
    });
    await renderer.act(async () => {
      await buttonByTitle(tr, 'accept').props.onPress();
      await Promise.resolve();
    });

    expect(mockRespondToInvite.mock.calls[0][2]).toBe('deadbeef');
  });

  it('S5: while an accept is in flight, the footer disables and a second press does not start a second accept', async () => {
    let resolveRespond!: () => void;
    mockRespondToInvite.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveRespond = resolve;
        })
    );
    const tr = await render();

    let pressPromise!: Promise<void>;
    await renderer.act(async () => {
      pressPromise = buttonByTitle(tr, 'accept').props.onPress();
      await Promise.resolve();
    });

    // A second press while in flight must not start a second accept.
    await renderer.act(async () => {
      await buttonByTitle(tr, 'accept').props.onPress();
      await Promise.resolve();
    });
    expect(mockRespondToInvite).toHaveBeenCalledTimes(1);

    await renderer.act(async () => {
      resolveRespond();
      await pressPromise;
      await Promise.resolve();
    });
    expect(mockGoBack).toHaveBeenCalledTimes(1);
  });
});
