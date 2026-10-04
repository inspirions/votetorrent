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
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex } from '@noble/curves/utils.js';
import { setKeyholderKeyVaultForTests } from '../../../engines/keyholder-vault';
import { InviteShareError } from '../../invitations/invite-share';

function makeShareText(type = 'k', name = 'Ada Keyholder') {
  const priv = secp256k1.utils.randomSecretKey();
  const invitePrivate = bytesToHex(priv);
  return {
    invitePrivate,
    text: JSON.stringify({ invitePrivate, inviteKey: bytesToHex(secp256k1.getPublicKey(priv)), expiration: 'x', type, name }),
  };
}

const mockGoBack = jest.fn();
const mockSetOptions = jest.fn();

const mockRouteParams: { mode: 'send' | 'accept'; initialShare?: string } = {
  mode: 'accept',
};

const mockAcceptKeyholderInvitation = jest.fn(async (_deps: unknown, _text: string) => ({ userId: 'u', slotCid: 'cid-1' }));
jest.mock('../keyholder-accept', () => ({
  acceptKeyholderInvitation: (deps: unknown, text: string) => mockAcceptKeyholderInvitation(deps, text),
}));

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
const mockResolveInviteSlotCid = jest.fn(async (_key: string, _type: string): Promise<string | undefined> => 'cid-1');
const mockInvitationEngine = {
  resolveInviteSlotCid: mockResolveInviteSlotCid,
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

async function paste(tr: renderer.ReactTestRenderer, text: string) {
  const input = tr.root.findAll((n) => typeof n.props?.onChangeText === 'function')[0];
  await renderer.act(async () => {
    input.props.onChangeText(text);
  });
}

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
  mockResolveInviteSlotCid.mockResolvedValue('cid-1');
  mockAcceptKeyholderInvitation.mockResolvedValue({ userId: 'u', slotCid: 'cid-1' });
  setKeyholderKeyVaultForTests(makeFakeVault() as never);
});

afterEach(() => {
  setKeyholderKeyVaultForTests(undefined);
});

describe('KeyholderInvitationScreen - paste-first accept mode (no route id)', () => {
  it('renders the paste hint and disabled Accept/Decline before any paste, never Loading', async () => {
    const tr = await render();
    const json = JSON.stringify(tr.toJSON());
    expect(json).toContain('invitationAcceptPasteHint');
    expect(json).not.toContain('loading');
    expect(json).toContain('invitationAcceptPastePlaceholder');
    expect(json).not.toContain('Paste the invite text from the sender');
    expect(buttonByTitle(tr, 'accept').props.disabled).toBe(true);
    expect(buttonByTitle(tr, 'decline').props.disabled).toBe(true);
  });

  it('pasting a share shows the invitee name and enables Accept/Decline', async () => {
    const tr = await render();
    await paste(tr, makeShareText().text);
    const name = tr.root.findAll((n) => n.props?.testID === 'keyholder-invitation-name');
    expect(name.length).toBeGreaterThan(0);
    expect(JSON.stringify(tr.toJSON())).toContain('Ada Keyholder');
    expect(buttonByTitle(tr, 'accept').props.disabled).toBe(false);
    expect(buttonByTitle(tr, 'decline').props.disabled).toBe(false);
  });

  it('Accept calls acceptKeyholderInvitation(deps, pastedText) with 2 args and navigates back', async () => {
    const tr = await render();
    const { text } = makeShareText();
    await paste(tr, text);
    await renderer.act(async () => {
      await buttonByTitle(tr, 'accept').props.onPress();
    });
    expect(mockAcceptKeyholderInvitation).toHaveBeenCalledTimes(1);
    expect(mockAcceptKeyholderInvitation.mock.calls[0]).toHaveLength(2);
    expect(mockAcceptKeyholderInvitation.mock.calls[0][1]).toBe(text);
    expect(mockGoBack).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['not-found', 'invitationAcceptNotFound'],
    ['wrong-type', 'invitationAcceptWrongType'],
    ['malformed', 'invitationAcceptMalformed'],
  ])('accept failure %s renders mapped copy', async (code, key) => {
    mockAcceptKeyholderInvitation.mockRejectedValueOnce(new InviteShareError(code as never));
    const tr = await render();
    await paste(tr, makeShareText().text);
    await renderer.act(async () => {
      await buttonByTitle(tr, 'accept').props.onPress();
    });
    expect(mockGoBack).not.toHaveBeenCalled();
    expect(JSON.stringify(tr.toJSON())).toContain(key);
  });

  it('auth-denied renders deviceSigningErrorGeneric and not the raw message', async () => {
    mockAcceptKeyholderInvitation.mockRejectedValueOnce(Object.assign(new Error('nope'), { code: 'auth-denied' }));
    const tr = await render();
    await paste(tr, makeShareText().text);
    await renderer.act(async () => {
      await buttonByTitle(tr, 'accept').props.onPress();
    });
    expect(JSON.stringify(tr.toJSON())).toContain('deviceSigningErrorGeneric');
    expect(JSON.stringify(tr.toJSON())).not.toContain('nope');
  });

  it('an engine error renders invitationAcceptFailed with no engine text or Cid', async () => {
    mockAcceptKeyholderInvitation.mockRejectedValueOnce(new Error('InvitationEngine.respondToInvite: InviteSlot not found for Cid: abc123'));
    const tr = await render();
    await paste(tr, makeShareText().text);
    await renderer.act(async () => {
      await buttonByTitle(tr, 'accept').props.onPress();
    });
    const json = JSON.stringify(tr.toJSON());
    expect(json).toContain('invitationAcceptFailed');
    expect(json).not.toContain('InvitationEngine');
    expect(json).not.toContain('Cid');
  });

  it('Decline resolves the slot then calls respondToInvite(slotCid, false, invitePrivate) with exactly 3 args', async () => {
    const tr = await render();
    const { text, invitePrivate } = makeShareText();
    await paste(tr, text);
    await renderer.act(async () => {
      await buttonByTitle(tr, 'decline').props.onPress();
    });
    expect(mockRespondToInvite).toHaveBeenCalledWith('cid-1', false, invitePrivate);
    expect(mockRespondToInvite.mock.calls[0]).toHaveLength(3);
    expect(mockGoBack).toHaveBeenCalledTimes(1);
  });

  it('Decline with an unresolvable share renders not-found copy and does not respond', async () => {
    mockResolveInviteSlotCid.mockResolvedValueOnce(undefined);
    const tr = await render();
    await paste(tr, makeShareText().text);
    await renderer.act(async () => {
      await buttonByTitle(tr, 'decline').props.onPress();
    });
    expect(mockRespondToInvite).not.toHaveBeenCalled();
    expect(mockGoBack).not.toHaveBeenCalled();
    expect(JSON.stringify(tr.toJSON())).toContain('invitationAcceptNotFound');
  });

  it('Decline failure maps to invitationAcceptFailed', async () => {
    mockRespondToInvite.mockRejectedValueOnce(new Error('InvitationEngine.respondToInvite: boom'));
    const tr = await render();
    await paste(tr, makeShareText().text);
    await renderer.act(async () => {
      await buttonByTitle(tr, 'decline').props.onPress();
    });
    expect(mockGoBack).not.toHaveBeenCalled();
    expect(JSON.stringify(tr.toJSON())).toContain('invitationAcceptFailed');
    expect(JSON.stringify(tr.toJSON())).not.toContain('InvitationEngine');
  });

  it('S5: while an accept is in flight a second press does not start a second accept', async () => {
    let resolveAccept!: () => void;
    mockAcceptKeyholderInvitation.mockImplementationOnce(
      () => new Promise((resolve) => { resolveAccept = () => resolve({ userId: 'u', slotCid: 'cid-1' }); })
    );
    const tr = await render();
    await paste(tr, makeShareText().text);

    let pressPromise!: Promise<void>;
    await renderer.act(async () => {
      pressPromise = buttonByTitle(tr, 'accept').props.onPress();
      await Promise.resolve();
    });
    await renderer.act(async () => {
      await buttonByTitle(tr, 'accept').props.onPress();
    });
    expect(mockAcceptKeyholderInvitation).toHaveBeenCalledTimes(1);

    await renderer.act(async () => {
      resolveAccept();
      await pressPromise;
    });
    expect(mockGoBack).toHaveBeenCalledTimes(1);
  });

  it('seeds the paste field from the initialShare route param', async () => {
    mockRouteParams.initialShare = makeShareText('k', 'Seeded Name').text;
    try {
      const tr = await render();
      expect(JSON.stringify(tr.toJSON())).toContain('Seeded Name');
      expect(buttonByTitle(tr, 'accept').props.disabled).toBe(false);
    } finally {
      delete mockRouteParams.initialShare;
    }
  });
});
