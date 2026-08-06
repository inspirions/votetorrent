/**
 * Co-located renderer suite for RejectReasonCard — the D-06 safeguard proof.
 * Every assertion here is proven by EXECUTION, not by inspection: what is
 * being protected is that a doubled reject fires two signed, permanent,
 * attributable rejection records, and that a rejection with no reason
 * reaches the engine at all.
 *
 * Scaffold copied from `LifecycleConfirmCard.test.tsx`: react-test-renderer
 * only (no external component-testing-library package is a dependency of
 * this app), the FontAwesome6 string mock, the react-i18next key-echo mock,
 * the distinct-sentinel PALETTE, and the @react-navigation/native useTheme
 * mock. Because RejectReasonCard interpolates its body copy, the `t` mock
 * here additionally accepts `(key, params)` and returns a deterministic
 * composite of both, so the `{{name}}` binding is independently observable.
 */

import React from 'react';
import renderer from 'react-test-renderer';

jest.mock('react-native-vector-icons/FontAwesome6', () => 'FontAwesome6');

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params ? `${key}::${JSON.stringify(params)}` : key,
  }),
}));

// Distinct sentinel values for every color token so a color assertion cannot
// pass by accidental equality (e.g. two tokens sharing the same hex).
const PALETTE = {
  text: '#T',
  textSecondary: '#TS',
  success: '#SU',
  warning: '#WA',
  error: '#ER',
  accent: '#AC',
  card: '#CA',
  background: '#BG',
  border: '#BO',
  dark: '#DA',
  light: '#LI',
  primary: '#PR',
  notification: '#NO',
};

jest.mock('@react-navigation/native', () => ({
  useTheme: () => ({
    dark: false,
    colors: PALETTE,
  }),
}));

jest.mock('../../../../providers/SettingsProvider', () => ({
  useSettings: () => ({ showHelpIcons: false }),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const RejectReasonCardModule = require('../RejectReasonCard');
const RejectReasonCard = RejectReasonCardModule.RejectReasonCard;
const isRejectReasonValid = RejectReasonCardModule.isRejectReasonValid;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findPressable(tr: renderer.ReactTestRenderer, testID: string) {
  const wrapper = tr.root.findByProps({ testID });
  return [wrapper, ...wrapper.findAll(() => true)].find((node) => typeof node.props.onPress === 'function');
}

function press(tr: renderer.ReactTestRenderer, testID: string) {
  const pressable = findPressable(tr, testID);
  renderer.act(() => {
    pressable!.props.onPress();
  });
}

function isDisabled(tr: renderer.ReactTestRenderer, testID: string): boolean {
  const wrapper = tr.root.findByProps({ testID });
  const disabledNode = [wrapper, ...wrapper.findAll(() => true)].find((node) => 'disabled' in node.props);
  return disabledNode?.props.disabled === true;
}

function type(tr: renderer.ReactTestRenderer, prefix: string, text: string) {
  const input = tr.root.findByProps({ testID: `${prefix}-reason-input` });
  renderer.act(() => {
    input.props.onChangeText(text);
  });
}

async function flush(tr: renderer.ReactTestRenderer) {
  await renderer.act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function treeText(tr: renderer.ReactTestRenderer): string {
  return JSON.stringify(tr.toJSON());
}

function styleValue(tr: renderer.ReactTestRenderer, testID: string, key: string): unknown {
  const node = tr.root.findByProps({ testID });
  const style = Array.isArray(node.props.style) ? node.props.style.flat(5) : [node.props.style];
  const withKey = style.find(
    (s: unknown) => s !== null && typeof s === 'object' && key in (s as Record<string, unknown>),
  ) as Record<string, unknown> | undefined;
  return withKey?.[key];
}

function buttonBackground(tr: renderer.ReactTestRenderer, wrapperTestID: string): unknown {
  const wrapper = tr.root.findByProps({ testID: wrapperTestID });
  const withBg = [wrapper, ...wrapper.findAll(() => true)].find((node) => 'backgroundColor' in node.props);
  return withBg?.props.backgroundColor;
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const PREFIX = 'reject-reason';

function renderCard(overrides: Record<string, unknown> = {}) {
  const onConfirm = (overrides.onConfirm as jest.Mock) ?? jest.fn().mockResolvedValue(undefined);
  const onDismiss = (overrides.onDismiss as jest.Mock) ?? jest.fn();

  const props = {
    requesterName: 'Jane Doe',
    onConfirm,
    onDismiss,
    testIDPrefix: PREFIX,
    ...overrides,
  };

  let tr!: renderer.ReactTestRenderer;
  renderer.act(() => {
    tr = renderer.create(<RejectReasonCard {...props} />);
  });
  return { tr, onConfirm, onDismiss };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('isRejectReasonValid (D-06 non-empty-trimmed-reason gate)', () => {
  it.each([
    ['', false],
    ['   ', false],
    ['\t\n ', false],
    ['x', true],
    [' x ', true],
    ['A long, multi-line reason.\nSecond line of detail.', true],
  ])('isRejectReasonValid(%p) -> %p', (reason, expected) => {
    expect(isRejectReasonValid(reason as string)).toBe(expected);
  });

  it('does not perform a name match: a value equal to the requester name is accepted like any other non-empty string', () => {
    expect(isRejectReasonValid('Jane Doe')).toBe(true);
  });
});

describe('RejectReasonCard — D-06', () => {
  it('1. card renders title/body/reason-input/dismiss/confirm; confirm starts disabled and fires nothing when invoked directly', () => {
    const { tr, onConfirm } = renderCard();

    expect(() => tr.root.findByProps({ testID: `${PREFIX}-card` })).not.toThrow();
    expect(() => tr.root.findByProps({ testID: `${PREFIX}-title` })).not.toThrow();
    expect(() => tr.root.findByProps({ testID: `${PREFIX}-body` })).not.toThrow();
    expect(() => tr.root.findByProps({ testID: `${PREFIX}-reason-input` })).not.toThrow();
    expect(() => tr.root.findByProps({ testID: `${PREFIX}-dismiss` })).not.toThrow();

    expect(isDisabled(tr, `${PREFIX}-confirm`)).toBe(true);

    const pressable = findPressable(tr, `${PREFIX}-confirm`);
    renderer.act(() => {
      pressable!.props.onPress();
    });
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('2. body binds registrationRequestRejectBody and interpolates the requester name', () => {
    const { tr } = renderCard({ requesterName: 'Ada Vasquez' });
    const bodyNode = tr.root.findByProps({ testID: `${PREFIX}-body` });
    const text = JSON.stringify(bodyNode.props.children);

    expect(text).toContain('registrationRequestRejectBody');
    expect(text).toContain('Ada Vasquez');
  });

  it('3. gate wiring: whitespace-only reason leaves confirm disabled; a real reason opens it', async () => {
    const { tr, onConfirm } = renderCard();

    type(tr, PREFIX, '   ');
    expect(isDisabled(tr, `${PREFIX}-confirm`)).toBe(true);
    expect(onConfirm).not.toHaveBeenCalled();

    type(tr, PREFIX, 'Address could not be verified');
    expect(isDisabled(tr, `${PREFIX}-confirm`)).toBe(false);

    press(tr, `${PREFIX}-confirm`);
    await flush(tr);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('4. trimming: onConfirm receives the trimmed reason, not the raw padded value', async () => {
    const { tr, onConfirm } = renderCard();
    type(tr, PREFIX, '  no proof of residence  ');

    press(tr, `${PREFIX}-confirm`);
    await flush(tr);

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledWith('no proof of residence');
  });

  it('5. double press — same-tick, no await between: exactly one onConfirm call', () => {
    const { promise } = deferred<void>();
    const onConfirm = jest.fn().mockReturnValue(promise);
    const { tr } = renderCard({ onConfirm });
    type(tr, PREFIX, 'Address could not be verified');

    const pressable = findPressable(tr, `${PREFIX}-confirm`);
    renderer.act(() => {
      pressable!.props.onPress();
      pressable!.props.onPress();
    });

    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('6. latch after success: once resolved, a further press fires no additional call', async () => {
    const d = deferred<void>();
    const onConfirm = jest.fn().mockReturnValue(d.promise);
    const { tr } = renderCard({ onConfirm });
    type(tr, PREFIX, 'Address could not be verified');

    press(tr, `${PREFIX}-confirm`);
    expect(onConfirm).toHaveBeenCalledTimes(1);

    d.resolve();
    await flush(tr);

    const pressable = findPressable(tr, `${PREFIX}-confirm`);
    renderer.act(() => {
      pressable!.props.onPress();
    });
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('7. retry after failure: idle is restored, a second press fires a second call, nothing is logged', async () => {
    const logSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const onConfirm = jest.fn().mockRejectedValueOnce(new Error('write failed')).mockResolvedValue(undefined);
    const { tr } = renderCard({ onConfirm });
    type(tr, PREFIX, 'Address could not be verified');

    press(tr, `${PREFIX}-confirm`);
    await flush(tr);

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(isDisabled(tr, `${PREFIX}-confirm`)).toBe(false);
    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();

    press(tr, `${PREFIX}-confirm`);
    await flush(tr);

    expect(onConfirm).toHaveBeenCalledTimes(2);

    logSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('8. dismiss discipline (empty reason): dismiss fires onDismiss once, onConfirm zero times', () => {
    const { tr, onConfirm, onDismiss } = renderCard();

    press(tr, `${PREFIX}-dismiss`);

    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('9. dismiss discipline (valid reason): dismiss fires onDismiss once, onConfirm zero times', () => {
    const { tr, onConfirm, onDismiss } = renderCard();
    type(tr, PREFIX, 'Address could not be verified');
    expect(isDisabled(tr, `${PREFIX}-confirm`)).toBe(false);

    press(tr, `${PREFIX}-dismiss`);

    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('10. dismiss disabled while a confirm is in flight: programmatic press fires zero onDismiss calls', () => {
    const { promise } = deferred<void>();
    const onConfirm = jest.fn().mockReturnValue(promise);
    const { tr, onDismiss } = renderCard({ onConfirm });
    type(tr, PREFIX, 'Address could not be verified');

    press(tr, `${PREFIX}-confirm`);
    expect(isDisabled(tr, `${PREFIX}-dismiss`)).toBe(true);

    const dismissPressable = findPressable(tr, `${PREFIX}-dismiss`);
    renderer.act(() => {
      dismissPressable!.props.onPress();
    });
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('11. colors: confirm is colors.error, dismiss is colors.accent, card left border is colors.error/4, warning never appears', () => {
    const { tr } = renderCard();

    expect(buttonBackground(tr, `${PREFIX}-confirm`)).toBe(PALETTE.error);
    expect(buttonBackground(tr, `${PREFIX}-dismiss`)).toBe(PALETTE.accent);
    expect(styleValue(tr, `${PREFIX}-card`, 'borderLeftColor')).toBe(PALETTE.error);
    expect(styleValue(tr, `${PREFIX}-card`, 'borderLeftWidth')).toBe(4);
    expect(treeText(tr)).not.toContain(PALETTE.warning);
  });

  it('12. reset on requester change: typed text and gate state clear when the same instance renders a different requester', () => {
    const { tr } = renderCard({ requesterName: 'Jane Doe' });
    type(tr, PREFIX, 'Address could not be verified');
    expect(isDisabled(tr, `${PREFIX}-confirm`)).toBe(false);

    renderer.act(() => {
      tr.update(
        <RejectReasonCard
          requesterName="Ada Vasquez"
          onConfirm={jest.fn().mockResolvedValue(undefined)}
          onDismiss={jest.fn()}
          testIDPrefix={PREFIX}
        />,
      );
    });

    expect(tr.root.findByProps({ testID: `${PREFIX}-reason-input` }).props.value).toBe('');
    expect(isDisabled(tr, `${PREFIX}-confirm`)).toBe(true);
  });
});
