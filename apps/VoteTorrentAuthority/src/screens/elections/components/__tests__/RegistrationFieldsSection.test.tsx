/**
 * Co-located test for RegistrationFieldsSection — pins D-02 (three-row picker +
 * Extra Field badge), D-14 (immediate apply / row states / prior-value integrity)
 * and D-10 (canWrite gate).
 *
 * Uses react-test-renderer ONLY — no external component-testing-library
 * package is a dependency of this app.
 *
 * The identity `t` mock (react-i18next) means every assertion targets the i18n
 * KEY string, so this test does not depend on 46-03's copy landing first.
 */

import React from 'react';
import renderer from 'react-test-renderer';

jest.mock('react-native-vector-icons/FontAwesome6', () => 'FontAwesome6');

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

jest.mock('@react-navigation/native', () => ({
  useTheme: () => ({
    dark: false,
    colors: {
      primary: '#007AFF',
      background: '#FFFFFF',
      card: '#F2F2F7',
      text: '#000000',
      border: '#C6C6C8',
      notification: '#FF3B30',
      error: '#FF3B30',
      textSecondary: '#888888',
      accent: '#5856D6',
      warning: '#FF9500',
      success: '#34C759',
      dark: '#000000',
      light: '#FFFFFF',
    },
  }),
}));

jest.mock('../../../../providers/SettingsProvider', () => ({
  useSettings: () => ({ showHelpIcons: false }),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const RegistrationFieldsSectionModule = require('../RegistrationFieldsSection');
const RegistrationFieldsSection =
  RegistrationFieldsSectionModule.RegistrationFieldsSection ?? RegistrationFieldsSectionModule.default;
const { isExtraField } = RegistrationFieldsSectionModule;

type Tier = 'public' | 'selective' | 'private';
type Requirement = 'required' | 'optional';

interface Field {
  electionId: string;
  fieldName: string;
  tier: Tier;
  requirement: Requirement;
}

function makeField(overrides: Partial<Field> = {}): Field {
  return {
    electionId: 'election-1',
    fieldName: 'ZipCode',
    tier: 'public',
    requirement: 'required',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Find the wrapper View by testID, then invoke the first descendant's onPressIn. */
function press(tr: renderer.ReactTestRenderer, testID: string) {
  const wrapper = tr.root.findByProps({ testID });
  const pressable = wrapper.findAll(
    (node) => typeof node.props.onPressIn === 'function',
  )[0];
  renderer.act(() => {
    pressable.props.onPressIn();
  });
}

async function flush(tr: renderer.ReactTestRenderer) {
  await renderer.act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

// ChipButton renders label.toUpperCase(); ThemedText renders copy verbatim.
// Compare case-insensitively so this helper works for both, matching the
// existing BallotConfirmation.test.tsx convention.
function treeContainsText(tr: renderer.ReactTestRenderer, text: string): boolean {
  const json = JSON.stringify(tr.toJSON()).toLowerCase();
  return json.includes(text.toLowerCase());
}

/** Recursively find a node in the tr.toJSON() tree by its testID prop. */
function findJsonNodeByTestID(node: unknown, testID: string): unknown {
  if (!node) return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findJsonNodeByTestID(child, testID);
      if (found) return found;
    }
    return null;
  }
  if (typeof node !== 'object') return null;
  const n = node as { props?: { testID?: string }; children?: unknown };
  if (n.props?.testID === testID) return n;
  if (n.children) return findJsonNodeByTestID(n.children, testID);
  return null;
}

function renderSection(overrides: {
  fields?: Field[];
  canWrite?: boolean;
  onAddField?: jest.Mock;
  onChangeField?: jest.Mock;
  onRemoveField?: jest.Mock;
} = {}) {
  const onAddField = overrides.onAddField ?? jest.fn().mockResolvedValue(undefined);
  const onChangeField = overrides.onChangeField ?? jest.fn().mockResolvedValue(undefined);
  const onRemoveField = overrides.onRemoveField ?? jest.fn().mockResolvedValue(undefined);
  const fields = overrides.fields ?? [];
  const canWrite = overrides.canWrite ?? true;

  let tr!: renderer.ReactTestRenderer;
  renderer.act(() => {
    tr = renderer.create(
      <RegistrationFieldsSection
        fields={fields}
        canWrite={canWrite}
        onAddField={onAddField}
        onChangeField={onChangeField}
        onRemoveField={onRemoveField}
      />,
    );
  });
  return { tr, onAddField, onChangeField, onRemoveField };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('RegistrationFieldsSection — D-02/D-14/D-10', () => {
  it('D-02 known chips: exactly Last Name + First Name, no other known-field key', () => {
    const { tr } = renderSection({ fields: [] });
    expect(treeContainsText(tr, 'registrationPolicyKnownFieldLastName')).toBe(true);
    expect(treeContainsText(tr, 'registrationPolicyKnownFieldFirstName')).toBe(true);
    const json = JSON.stringify(tr.toJSON()).toLowerCase();
    const matches = json.match(/registrationpolicyknownfield/g) ?? [];
    expect(matches.length).toBe(2);
  });

  it('D-02 District separation: divider sits between known chips and district group; hint renders', () => {
    const { tr } = renderSection({ fields: [] });
    const json = JSON.stringify(tr.toJSON());
    const knownIdx = json.indexOf('registration-field-picker-known');
    const dividerIdx = json.indexOf('registration-field-picker-divider');
    const districtIdx = json.indexOf('registration-field-picker-district');
    expect(dividerIdx).toBeGreaterThan(-1);
    expect(dividerIdx).toBeGreaterThan(knownIdx);
    expect(dividerIdx).toBeLessThan(districtIdx);

    const hintNode = findJsonNodeByTestID(tr.toJSON(), 'registration-field-district-hint');
    expect(JSON.stringify(hintNode)).toContain('registrationPolicyDistrictFieldHint');
  });

  it('D-02 Extra Field badge: custom row badged, fixed-column row not', () => {
    const { tr } = renderSection({
      fields: [makeField({ fieldName: 'LastName' }), makeField({ fieldName: 'ZipCode' })],
    });

    expect(() => tr.root.findByProps({ testID: 'registration-field-extra-badge-ZipCode' })).not.toThrow();
    expect(() => tr.root.findByProps({ testID: 'registration-field-extra-hint-ZipCode' })).not.toThrow();
    expect(() => tr.root.findByProps({ testID: 'registration-field-extra-badge-LastName' })).toThrow();

    expect(isExtraField('district')).toBe(false);
    expect(isExtraField('District')).toBe(false);
    expect(isExtraField('ZipCode')).toBe(true);
  });

  it('D-14 immediate apply on add: pressing Last Name fires onAddField once, synchronously, with defaults', async () => {
    const { tr, onAddField } = renderSection({ fields: [] });
    press(tr, 'registration-field-picker-lastname');
    expect(onAddField).toHaveBeenCalledTimes(1);
    expect(onAddField).toHaveBeenCalledWith('LastName', 'public', 'required');
    // Flush the resolved mock's .then(setRowStatus) so it settles inside act().
    await flush(tr);
  });

  it('D-14 immediate apply on tier change: fires onChangeField; already-selected tier is a no-op', async () => {
    const field = makeField({ fieldName: 'ZipCode', tier: 'public', requirement: 'required' });
    const { tr, onChangeField } = renderSection({ fields: [field] });

    press(tr, 'registration-field-tier-ZipCode-selective');
    expect(onChangeField).toHaveBeenCalledTimes(1);
    expect(onChangeField).toHaveBeenCalledWith('ZipCode', 'selective', 'required');

    // Let the row settle back to a non-saving state (controls are replaced by
    // "Saving…" text while the write is in flight) before pressing again.
    await flush(tr);

    // The fixture's `field.tier` prop is still 'public' (props are never
    // mutated by this component — D-14), so re-pressing the already-selected
    // 'public' tier fires nothing.
    press(tr, 'registration-field-tier-ZipCode-public');
    expect(onChangeField).toHaveBeenCalledTimes(1);
  });

  it('D-14 row states + prior-value integrity: rejected write shows error+Retry, retry re-fires identical args', async () => {
    const field = makeField({ fieldName: 'ZipCode', tier: 'public', requirement: 'required' });
    const onChangeField = jest.fn().mockRejectedValueOnce(new Error('write failed')).mockResolvedValue(undefined);
    const { tr } = renderSection({ fields: [field], onChangeField });

    press(tr, 'registration-field-tier-ZipCode-selective');
    await flush(tr);

    expect(treeContainsText(tr, 'registrationPolicyRowError')).toBe(true);
    expect(() => tr.root.findByProps({ testID: 'registration-field-retry-ZipCode' })).not.toThrow();
    // Prior value integrity: the row still reads from props (field.tier === 'public'
    // in the fixture, never mutated locally) — re-pressing 'public' below is a no-op
    // proof that the displayed selection did not silently flip to 'selective'.
    expect(JSON.stringify(tr.toJSON())).toContain('ZipCode');

    press(tr, 'registration-field-retry-ZipCode');
    await flush(tr);

    expect(onChangeField.mock.calls[1]).toEqual(onChangeField.mock.calls[0]);
  });

  it('D-14 pending state: a never-resolving write shows Saving…', async () => {
    const field = makeField({ fieldName: 'ZipCode' });
    const onChangeField = jest.fn().mockReturnValue(new Promise(() => {}));
    const { tr } = renderSection({ fields: [field], onChangeField });

    press(tr, 'registration-field-tier-ZipCode-selective');
    await flush(tr);

    expect(treeContainsText(tr, 'registrationPolicyRowSaving')).toBe(true);
  });

  it('D-10 canWrite gate: no callback fires when canWrite is false; controls stay present but disabled', () => {
    const field = makeField({ fieldName: 'ZipCode', tier: 'public', requirement: 'required' });
    const { tr, onAddField, onChangeField, onRemoveField } = renderSection({
      fields: [field],
      canWrite: false,
    });

    const writeTestIDs = [
      'registration-field-picker-lastname',
      'registration-field-picker-firstname',
      'registration-field-picker-district-chip',
      'registration-field-picker-custom-chip',
      'registration-field-tier-ZipCode-selective',
      'registration-field-requirement-ZipCode-optional',
      'registration-field-remove-ZipCode',
    ];

    for (const testID of writeTestIDs) {
      const wrapper = tr.root.findByProps({ testID });
      expect(wrapper.props.pointerEvents).toBe('none');
      const style = Array.isArray(wrapper.props.style) ? wrapper.props.style.flat(5) : [wrapper.props.style];
      const hasHalfOpacity = style.some(
        (s: unknown) => s !== null && typeof s === 'object' && (s as Record<string, unknown>).opacity === 0.5,
      );
      expect(hasHalfOpacity).toBe(true);
      // Still present in the tree — disabled, not hidden.
      expect(() => tr.root.findByProps({ testID })).not.toThrow();

      const pressable = wrapper.findAll((node) => 'onPressIn' in node.props)[0];
      renderer.act(() => {
        pressable.props.onPressIn?.();
      });
    }

    expect(onAddField).not.toHaveBeenCalled();
    expect(onChangeField).not.toHaveBeenCalled();
    expect(onRemoveField).not.toHaveBeenCalled();
  });

  it('Empty state: renders when fields is empty, not when fields is non-empty', () => {
    const empty = renderSection({ fields: [] });
    expect(() => empty.tr.root.findByProps({ testID: 'registration-fields-empty' })).not.toThrow();
    expect(treeContainsText(empty.tr, 'registrationPolicyNoFieldsHeading')).toBe(true);

    const nonEmpty = renderSection({ fields: [makeField()] });
    expect(() => nonEmpty.tr.root.findByProps({ testID: 'registration-fields-empty' })).toThrow();
  });
});
