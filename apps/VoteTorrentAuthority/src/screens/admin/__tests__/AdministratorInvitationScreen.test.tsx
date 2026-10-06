/**
 * AdministratorInvitationScreen.test.tsx — INV-02/04/05 screen-layer coverage.
 *
 * Phase 39 plan 39-04 (DEBT-09 test-coverage backfill, todo
 * 2026-06-24-inv-02-04-05-test-coverage). No jest coverage previously existed
 * for this screen (21-14 was UAT-only). Scaffolded from
 * RevokeKeyScreen.test.tsx / AuthorityInvitationScreen.test.tsx (same
 * react-test-renderer + mock*-prefixed module slots convention).
 *
 * Pins two invariants (Admin analog of INV-02/04/05):
 *   INV-02 (send mode): onSend calls createOfficerInvite({...}) then
 *     saveInviteWithSigning(invite, 'rad', signer), and the resulting share
 *     text contains the ephemeral invitePrivate (D-05/D-06).
 *   INV-04/05 (accept mode, accept + decline): navigation.goBack() is called
 *     ONLY when respondToInvite resolves; on a thrown/rejected
 *     respondToInvite, goBack is NOT called and errorMessage is set (rendered
 *     by <InlineError>).
 */

import React from 'react';
import renderer from 'react-test-renderer';
import { StyleSheet } from 'react-native';
import { globalStyles } from '../../../theme/styles';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex } from '@noble/curves/utils.js';

function makeShare(type: string) {
  const priv = secp256k1.utils.randomSecretKey();
  const invitePrivate = bytesToHex(priv);
  return {
    invitePrivate,
    text: JSON.stringify({ invitePrivate, inviteKey: bytesToHex(secp256k1.getPublicKey(priv)), expiration: 'x', type, name: 'Invitee' }),
  };
}
const mockResolveInviteSlot = jest.fn(async (_key: string, _type: string): Promise<any> => ({ status: 'live', cid: 'slot-cid-1' }));

const mockGoBack = jest.fn();
const mockSetOptions = jest.fn();

let mockRouteParams: {
  mode: 'send' | 'accept';
  initialShare?: string;
  authority?: { id: string };
  officerInit?: { name: string; title: string };
} = { mode: 'send', authority: { id: 'authority-1' } };

const mockCreateOfficerInvite = jest.fn();
const mockSaveInviteWithSigning = jest.fn(async () => {});
const mockAuthorityEngine = {
  createOfficerInvite: mockCreateOfficerInvite,
  saveInviteWithSigning: mockSaveInviteWithSigning,
};

const mockGetNetworkDetails = jest.fn(async () => ({ network: { name: 'Test Network' } }));
const mockNetworkEngine = { getDetails: mockGetNetworkDetails };

const mockRespondToInvite = jest.fn(async () => {});
const mockGetOfficerInvite = jest.fn(async (_cid: string): Promise<any> => undefined);
const mockInvitationEngine = {
  resolveInviteSlot: mockResolveInviteSlot,
  respondToInvite: mockRespondToInvite,
  getOfficerInvite: mockGetOfficerInvite,
};

// getEngine<T>(name, initParams?) — dispatch by engine name; 'authority' is
// keyed by authority.id (AdministratorInvitationScreen passes it as initParams).
const mockGetEngine = jest.fn(async (name: string) => {
  if (name === 'network') return mockNetworkEngine;
  if (name === 'invitations') return mockInvitationEngine;
  if (name === 'authority') return mockAuthorityEngine;
  return undefined;
});

jest.mock('react-native-vector-icons/FontAwesome6', () => 'FontAwesome6');

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
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

jest.mock('../../../engines/device-signer', () => ({
  createDeviceSigner: jest.fn(async () => ({
    signature: 'sig',
    signerKey: 'device-pub-key',
    signerUserId: 'user-1',
  })),
}));
jest.mock('../../../engines/device-user', () => ({
  getOrCreateDeviceUser: jest.fn(async () => ({ id: 'user-1', name: 'Device User' })),
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
const AdministratorInvitationModule = require('../AdministratorInvitationScreen');
const AdministratorInvitationScreen =
  AdministratorInvitationModule.default ?? AdministratorInvitationModule.AdministratorInvitationScreen;

async function render() {
  let tr!: renderer.ReactTestRenderer;
  await renderer.act(async () => {
    tr = renderer.create(<AdministratorInvitationScreen />);
  });
  await renderer.act(async () => {
    await Promise.resolve();
  });
  return tr;
}

function buttonByTitle(tr: renderer.ReactTestRenderer, title: string) {
  return tr.root.findAll((n) => n.props?.title === title && typeof n.props?.onPress === 'function')[0];
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRouteParams = { mode: 'send', authority: { id: 'authority-1' } };
  mockCreateOfficerInvite.mockReturnValue({
    invitePrivate: 'admin-ephemeral-private-hex',
    inviteKey: 'admin-invite-key-hex',
    inviteSignature: 'admin-invite-sig',
    expiration: '2027-01-01T00:00:00.000Z',
    type: 'o',
    name: 'New Officer',
    title: 'Clerk',
  });
  mockSaveInviteWithSigning.mockResolvedValue(undefined);
  mockRespondToInvite.mockResolvedValue(undefined);
});

describe('AdministratorInvitationScreen — INV-02 (send mode real invitePrivate sharing)', () => {
  it('onSend calls createOfficerInvite then saveInviteWithSigning("rad") and the share text contains invitePrivate', async () => {
    const tr = await render();

    await renderer.act(async () => {
      const nameInput = tr.root.findAll(
        (n) => n.props?.title === 'name' && typeof n.props?.onChangeText === 'function',
      )[0];
      nameInput.props.onChangeText('New Officer');
    });
    await renderer.act(async () => {
      const titleInput = tr.root.findAll(
        (n) => n.props?.title === 'title' && typeof n.props?.onChangeText === 'function',
      )[0];
      titleInput.props.onChangeText('Clerk');
    });

    await renderer.act(async () => {
      await buttonByTitle(tr, 'send').props.onPress();
      await Promise.resolve();
    });

    expect(mockCreateOfficerInvite).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'New Officer', title: 'Clerk' }),
    );
    expect(mockSaveInviteWithSigning).toHaveBeenCalledTimes(1);
    const [invitePassed, scopePassed] = mockSaveInviteWithSigning.mock.calls[0];
    expect(invitePassed).toEqual(
      expect.objectContaining({ invitePrivate: 'admin-ephemeral-private-hex' }),
    );
    expect(scopePassed).toBe('rad');

    const rendered = JSON.stringify(tr.toJSON());
    expect(rendered).toContain('invitePrivate');
    expect(rendered).toContain('admin-ephemeral-private-hex');
  });
});

describe('AdministratorInvitationScreen - send mode prefill', () => {
  const inputByTitle = (tr: renderer.ReactTestRenderer, title: string) =>
    tr.root.findAll((n) => n.props?.title === title && typeof n.props?.onChangeText === 'function')[0];

  it('starts Name and Title from officerInit and keeps them editable', async () => {
    mockRouteParams = { mode: 'send', authority: { id: 'authority-1' }, officerInit: { name: 'Bea Two', title: 'Clerk' } };
    const tr = await render();
    expect(inputByTitle(tr, 'name').props.value).toBe('Bea Two');
    expect(inputByTitle(tr, 'title').props.value).toBe('Clerk');
    await renderer.act(async () => {
      inputByTitle(tr, 'name').props.onChangeText('Bea Three');
    });
    expect(inputByTitle(tr, 'name').props.value).toBe('Bea Three');
  });

  it('starts empty without officerInit', async () => {
    const tr = await render();
    expect(inputByTitle(tr, 'name').props.value).toBe('');
    expect(inputByTitle(tr, 'title').props.value).toBe('');
  });
});

describe('AdministratorInvitationScreen - accept mode resolves the slot from the paste', () => {
  const SLOT = 'slot-cid-1';
  let share!: { invitePrivate: string; text: string };
  beforeEach(() => {
    share = makeShare('of');
    mockRouteParams = { mode: 'accept', initialShare: share.text };
    mockResolveInviteSlot.mockResolvedValue({ status: 'live', cid: SLOT });
    mockGetOfficerInvite.mockResolvedValue({ invite: { name: 'Invitee', title: 'Clerk', scopes: [] } });
  });

  it('resolves by (InviteKey, of), loads the invite from the resolved Cid, and accept signs with it', async () => {
    const tr = await render();
    expect(mockResolveInviteSlot).toHaveBeenCalledWith(expect.any(String), 'of');
    expect(mockGetOfficerInvite).toHaveBeenCalledWith(SLOT);
    await renderer.act(async () => {
      await buttonByTitle(tr, 'accept').props.onPress();
      await Promise.resolve();
    });
    expect(mockRespondToInvite).toHaveBeenCalledWith(SLOT, true, share.invitePrivate);
    expect(mockGoBack).toHaveBeenCalledTimes(1);
  });

  it('decline signs with the resolved Cid and navigates back', async () => {
    const tr = await render();
    await renderer.act(async () => {
      await buttonByTitle(tr, 'reject').props.onPress();
      await Promise.resolve();
    });
    expect(mockRespondToInvite).toHaveBeenCalledWith(SLOT, false, share.invitePrivate);
    expect(mockGoBack).toHaveBeenCalledTimes(1);
  });

  it('a respondToInvite failure maps to invitationAcceptFailed, shows no engine text, does not navigate', async () => {
    mockRespondToInvite.mockRejectedValueOnce(new Error('InvitationEngine.respondToInvite: InviteSlot not found for Cid: x'));
    const tr = await render();
    await renderer.act(async () => {
      await buttonByTitle(tr, 'accept').props.onPress();
      await Promise.resolve();
    });
    const rendered = JSON.stringify(tr.toJSON());
    expect(mockGoBack).not.toHaveBeenCalled();
    expect(rendered).toContain('invitationAcceptFailed');
    expect(rendered).not.toContain('InvitationEngine');
    expect(rendered).not.toContain('Cid');
  });

  it('the refusal copy renders inside the screen padding, not flush at x=0 (UAT gap 4 item 6)', async () => {
    mockRespondToInvite.mockRejectedValueOnce(new Error('boom'));
    const tr = await render();
    await renderer.act(async () => {
      await buttonByTitle(tr, 'accept').props.onPress();
      await Promise.resolve();
    });
    const wrapper = tr.root.findByProps({ testID: 'administrator-invitation-error' });
    const style = StyleSheet.flatten(wrapper.props.style);
    expect(style.paddingHorizontal).toBe(globalStyles.container.padding);
    // the copy itself is a descendant of the padded wrapper
    const texts = wrapper.findAll((n) => n.props?.children === 'invitationAcceptFailed');
    expect(texts.length).toBeGreaterThan(0);
  });

  it('not-found renders invitationAcceptNotFound and never navigates', async () => {
    mockResolveInviteSlot.mockResolvedValue({ status: 'not-found' });
    const tr = await render();
    await renderer.act(async () => {
      await buttonByTitle(tr, 'accept').props.onPress();
      await Promise.resolve();
    });
    expect(JSON.stringify(tr.toJSON())).toContain('invitationAcceptNotFound');
    expect(mockRespondToInvite).not.toHaveBeenCalled();
    expect(mockGoBack).not.toHaveBeenCalled();
  });

  it('a withdrawn or expired share renders invitationAcceptNoLongerValid, disables accept and reject, and never signs', async () => {
    mockResolveInviteSlot.mockResolvedValue({ status: 'no-longer-valid' });
    const tr = await render();
    const rendered = JSON.stringify(tr.toJSON());
    expect(rendered).toContain('invitationAcceptNoLongerValid');
    expect(rendered).not.toContain('InvitationEngine');
    expect(rendered).not.toContain('Cid');
    expect(buttonByTitle(tr, 'accept').props.disabled).toBe(true);
    expect(buttonByTitle(tr, 'reject').props.disabled).toBe(true);
    expect(mockRespondToInvite).not.toHaveBeenCalled();
    expect(mockGoBack).not.toHaveBeenCalled();
  });

  it('an engine-side refusal that races past the helper renders the generic failure copy, not the engine text', async () => {
    mockRespondToInvite.mockRejectedValueOnce(new Error('InvitationEngine.respondToInvite: This invitation was withdrawn or has expired'));
    const tr = await render();
    await renderer.act(async () => {
      await buttonByTitle(tr, 'accept').props.onPress();
      await Promise.resolve();
    });
    const rendered = JSON.stringify(tr.toJSON());
    expect(rendered).toContain('invitationAcceptFailed');
    expect(rendered).not.toContain('InvitationEngine');
    expect(rendered).not.toContain('withdrawn');
    expect(mockGoBack).not.toHaveBeenCalled();
  });

  it('a share of another type renders invitationAcceptWrongType and never signs', async () => {
    mockRouteParams = { mode: 'accept', initialShare: makeShare('k').text };
    const tr = await render();
    await renderer.act(async () => {
      await buttonByTitle(tr, 'accept').props.onPress();
      await Promise.resolve();
    });
    expect(JSON.stringify(tr.toJSON())).toContain('invitationAcceptWrongType');
    expect(mockRespondToInvite).not.toHaveBeenCalled();
  });

  it('with no paste, accept and reject are disabled and the paste hint shows', async () => {
    mockRouteParams = { mode: 'accept' };
    const tr = await render();
    expect(buttonByTitle(tr, 'accept').props.disabled).toBe(true);
    expect(buttonByTitle(tr, 'reject').props.disabled).toBe(true);
    const rendered = JSON.stringify(tr.toJSON());
    expect(rendered).toContain('invitationAcceptPasteHint');
    expect(rendered).not.toContain('"loading"');
  });

  it('uses the shared paste placeholder, not hardcoded English', async () => {
    const tr = await render();
    expect(JSON.stringify(tr.toJSON())).toContain('invitationAcceptPastePlaceholder');
  });

  it('labels the paste field once: no duplicate invitationKey heading above the input (UAT 62 K)', async () => {
    const tr = await render();
    const labels = tr.root.findAll((n) => (n.type as unknown) === 'Text' && n.props.children === 'invitationKey');
    expect(labels).toHaveLength(1);
  });
});
