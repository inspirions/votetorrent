/**
 * AcceptInvitationScreen.test.tsx - the paste-first dispatcher (UAT 62 test 10).
 * Pure parse + route: no engine call is made here; the role screens resolve the slot.
 */

import React from 'react';
import renderer from 'react-test-renderer';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex } from '@noble/curves/utils.js';

const mockReplace = jest.fn();
const mockSetOptions = jest.fn();
const mockGetEngine = jest.fn();

jest.mock('react-native-vector-icons/FontAwesome6', () => 'FontAwesome6');
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('../../../providers/SettingsProvider', () => ({ useSettings: () => ({ showHelpIcons: false }) }));
jest.mock('../../../providers/AppProvider', () => ({ useApp: () => ({ getEngine: mockGetEngine }) }));
jest.mock('@react-navigation/native', () => ({
  useTheme: () => ({
    colors: {
      primary: '#007AFF', background: '#FFFFFF', card: '#F2F2F7', text: '#000000', border: '#C6C6C8',
      notification: '#FF3B30', error: '#FF3B30', textSecondary: '#888888', important: '#FF9500', success: '#34C759',
    },
  }),
  useNavigation: () => ({ replace: mockReplace, navigate: jest.fn(), goBack: jest.fn(), setOptions: mockSetOptions }),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const mod = require('../AcceptInvitationScreen');
const AcceptInvitationScreen = mod.default ?? mod.AcceptInvitationScreen;

function share(type?: string) {
  const priv = secp256k1.utils.randomSecretKey();
  const invitePrivate = bytesToHex(priv);
  const body: Record<string, unknown> = { invitePrivate, inviteKey: bytesToHex(secp256k1.getPublicKey(priv)), name: 'Kay Two' };
  if (type) body.type = type;
  return { invitePrivate, text: JSON.stringify(body) };
}

async function render() {
  let tr!: renderer.ReactTestRenderer;
  await renderer.act(async () => {
    tr = renderer.create(<AcceptInvitationScreen />);
  });
  return tr;
}
const input = (tr: renderer.ReactTestRenderer) =>
  tr.root.findAll((n) => n.props?.testID === 'accept-invitation-input' && typeof n.props?.onChangeText === 'function')[0];
const cont = (tr: renderer.ReactTestRenderer) =>
  tr.root.findAll((n) => n.props?.testID === 'accept-invitation-continue' && typeof n.props?.onPress === 'function')[0];

async function paste(tr: renderer.ReactTestRenderer, text: string) {
  await renderer.act(async () => {
    input(tr).props.onChangeText(text);
  });
}
async function press(tr: renderer.ReactTestRenderer) {
  await renderer.act(async () => {
    await cont(tr).props.onPress();
  });
}

beforeEach(() => jest.clearAllMocks());

describe('AcceptInvitationScreen', () => {
  it('Continue is disabled with no paste', async () => {
    const tr = await render();
    expect(cont(tr).props.disabled).toBe(true);
    await paste(tr, 'x');
    expect(cont(tr).props.disabled).toBeFalsy();
  });

  it.each([
    ['k', 'KeyholderInvitation'],
    ['of', 'AdministratorInvitation'],
    ['au', 'AuthorityInvitation'],
  ])('routes a %s share to %s in accept mode carrying the pasted text', async (type, route) => {
    const tr = await render();
    const { text } = share(type);
    await paste(tr, text);
    await press(tr);
    expect(mockReplace).toHaveBeenCalledWith(route, { mode: 'accept', initialShare: text });
    expect(mockGetEngine).not.toHaveBeenCalled();
  });

  it('a raw hex key (no type) gets the malformed copy and does not navigate', async () => {
    const tr = await render();
    await paste(tr, share().invitePrivate);
    await press(tr);
    expect(mockReplace).not.toHaveBeenCalled();
    expect(JSON.stringify(tr.toJSON())).toContain('invitationAcceptMalformed');
  });

  it("type 'r' gets the wrong-type copy and does not navigate", async () => {
    const tr = await render();
    await paste(tr, share('r').text);
    await press(tr);
    expect(mockReplace).not.toHaveBeenCalled();
    expect(JSON.stringify(tr.toJSON())).toContain('invitationAcceptWrongType');
  });

  it('garbage gets the malformed copy and does not navigate', async () => {
    const tr = await render();
    await paste(tr, 'hello');
    await press(tr);
    expect(mockReplace).not.toHaveBeenCalled();
    expect(JSON.stringify(tr.toJSON())).toContain('invitationAcceptMalformed');
  });
});
