/**
 * InviteShareBlock (UAT 62 L2/L3, Redmi 8). The invite JSON used to be cut at 4 lines with no
 * ellipsis, and SHARE silently called Clipboard.setString, which left the system clipboard empty
 * with no feedback. The block now shows the whole text, SHARE opens the OS share sheet, and COPY
 * reports "Copied" only after an Android read-back matches.
 */

import React from 'react';
import { Platform, Share } from 'react-native';
import renderer, { act } from 'react-test-renderer';

jest.mock('react-native-vector-icons/FontAwesome6', () => 'FontAwesome6');

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

jest.mock('@react-navigation/native', () => ({
  useTheme: () => ({
    dark: false,
    colors: { text: '#T', textSecondary: '#TS', card: '#CA', accent: '#AC', success: '#SU', error: '#ER', light: '#LI', dark: '#DA' },
  }),
}));

const mockSetString = jest.fn();
const mockGetString = jest.fn(async () => '');
jest.mock('@react-native-clipboard/clipboard', () => ({
  __esModule: true,
  default: {
    setString: (s: string) => mockSetString(s),
    getString: () => mockGetString(),
  },
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { InviteShareBlock } = require('../InviteShareBlock');

const SHARE = JSON.stringify({
  invitePrivate: 'a'.repeat(64),
  inviteKey: 'b'.repeat(66),
  expiration: '2026-10-06T12:00:00.000Z',
  type: 'k',
  name: 'Kay Holder',
});

function render() {
  let tr!: renderer.ReactTestRenderer;
  act(() => {
    tr = renderer.create(<InviteShareBlock label="invitationKey" shareText={SHARE} testIDPrefix="p" />);
  });
  return tr;
}

async function press(tr: renderer.ReactTestRenderer, testID: string) {
  const button = tr.root.findAll((n) => n.props?.testID === testID && typeof n.props?.onPress === 'function')[0];
  await act(async () => {
    await button.props.onPress();
  });
}

function statusText(tr: renderer.ReactTestRenderer): string | undefined {
  const found = tr.root.findAll((n) => n.props?.testID === 'p-status' && typeof n.props?.children === 'string');
  return found[0]?.props.children;
}

const originalOS = Platform.OS;

beforeEach(() => {
  jest.clearAllMocks();
  Object.defineProperty(Platform, 'OS', { value: 'android', configurable: true });
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterAll(() => {
  Object.defineProperty(Platform, 'OS', { value: originalOS, configurable: true });
});

describe('InviteShareBlock', () => {
  it('shows the whole invite text, selectable, with no line cap', () => {
    const tr = render();
    const text = tr.root.findAll((n) => n.props?.testID === 'p-text' && n.props?.children === SHARE)[0];
    expect(text).toBeTruthy();
    expect(text.props.selectable).toBe(true);
    expect(text.props.numberOfLines).toBeUndefined();
  });

  it('SHARE opens the OS share sheet with the invite text', async () => {
    const spy = jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' } as never);
    const tr = render();
    await press(tr, 'p-share');
    expect(spy).toHaveBeenCalledWith({ message: SHARE });
    expect(statusText(tr)).toBeUndefined();
  });

  it('a share-sheet failure shows the share-failed copy', async () => {
    jest.spyOn(Share, 'share').mockRejectedValue(new Error('no activity'));
    const tr = render();
    await press(tr, 'p-share');
    expect(statusText(tr)).toBe('invitationShareSheetFailed');
  });

  it('COPY confirms "Copied" only when the Android read-back matches', async () => {
    mockGetString.mockResolvedValueOnce(SHARE);
    const tr = render();
    await press(tr, 'p-copy');
    expect(mockSetString).toHaveBeenCalledWith(SHARE);
    expect(statusText(tr)).toBe('invitationShareCopied');
  });

  it('COPY reports a failure when the clipboard stays empty (the Redmi 8 symptom)', async () => {
    mockGetString.mockResolvedValueOnce('');
    const tr = render();
    await press(tr, 'p-copy');
    expect(statusText(tr)).toBe('invitationShareCopyFailed');
  });

  it('COPY reports a failure when the clipboard module throws', async () => {
    mockSetString.mockImplementationOnce(() => {
      throw new Error('TurboModuleRegistry: RNCClipboard not found');
    });
    const tr = render();
    await press(tr, 'p-copy');
    expect(statusText(tr)).toBe('invitationShareCopyFailed');
  });

  it('iOS skips the read-back (it would raise the Allow Paste prompt) and confirms the copy', async () => {
    Object.defineProperty(Platform, 'OS', { value: 'ios', configurable: true });
    const tr = render();
    await press(tr, 'p-copy');
    expect(mockGetString).not.toHaveBeenCalled();
    expect(statusText(tr)).toBe('invitationShareCopied');
  });
});
