/**
 * TransportStatusCard — D-01/D-11 proofs.
 *
 * Suites A-E (this file, Task 2) prove the filesystem/REST cards: transportCopy pairs
 * testIDBase/headingKey/bodyKey correctly per (kind, syncState), TRANSPORT_STATE_ICONS resolves
 * the right icon/colorRole, the six rendered (kind, syncState) combinations show the right
 * heading+body+icon+color together, the disabled control renders-not-hides, and the counts line
 * omits undefined segments.
 *
 * Suites F-H (appended in Task 3) prove the D-11 guarantee for the peer-to-peer card: it renders
 * byte-identically across every state payload a caller could try to push into it — including
 * success — and its branch reads no per-state lookup and no success/accent color.
 *
 * testIDBase inventory this file proves (built from `${kind}-${syncState}`, all six pairs are
 * exercised below), e.g. `transport-status-filesystem-never` and `transport-status-rest-success`.
 */

import React from 'react';
import renderer from 'react-test-renderer';

// ---------------------------------------------------------------------------
// Mock preamble — copied from SyncChip.test.tsx.
// ---------------------------------------------------------------------------

// Mock react-i18next: no i18next instance is initialized in this isolated unit test. `t` echoes
// its key — these assertions are about key *selection*, never about copy text, which 48-03's own
// gates own.
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

// Sentinel palette — visually impossible, uniquely greppable color strings so a color assertion
// is an exact string match rather than a judgement call. Every color assertion in this suite is a
// substring test against a serialized rendered subtree.
const SENTINEL_COLORS = {
  accent: '#ACCENT0',
  success: '#SUCCES0',
  error: '#ERROR00',
  warning: '#WARN000',
  textSecondary: '#MUTED00',
  card: '#CARD000',
  text: '#TEXT000',
  dark: '#DARK000',
  light: '#LIGHT00',
  primary: '#PRIMAR0',
};

jest.mock('@react-navigation/native', () => ({
  useTheme: () => ({ colors: SENTINEL_COLORS }),
}));

jest.mock('react-native-vector-icons/FontAwesome6', () => 'FontAwesome6');

// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  TransportStatusCard,
  ExperimentalTransportStatusCard,
  transportCopy,
  TRANSPORT_STATE_ICONS,
} = require('../TransportStatusCard');

function renderCard(tree: React.ReactElement): renderer.ReactTestRenderer {
  let tr!: renderer.ReactTestRenderer;
  renderer.act(() => {
    tr = renderer.create(tree);
  });
  return tr;
}

// `findAll` matches BOTH the composite (component/forwardRef) fiber and the host
// (platform-primitive) fiber for the same element — a `View` with a given `testID` therefore
// counts twice unless filtered to host nodes only (`typeof node.type === 'string'`). This mirrors
// the convention in TransparencyStatsCard.test.tsx.
function findByTestID(
  root: renderer.ReactTestInstance,
  id: string,
): renderer.ReactTestInstance[] {
  return root.findAll(
    (node) => typeof node.type === 'string' && node.props.testID === id,
  );
}

// `ReactTestInstance` has no `.toJSON()` (that only exists on the top-level renderer). This walks
// a subtree and concatenates each node's non-children props (JSON-stringified) plus leaf text, so
// substring assertions (colors, i18n keys) can run against an arbitrary subtree, not just the
// whole page.
function serializeSubtree(node: renderer.ReactTestInstance): string {
  const parts: string[] = [];
  function visit(n: renderer.ReactTestInstance | string): void {
    if (typeof n === 'string') {
      parts.push(n);
      return;
    }
    const { children: _children, ...rest } = n.props;
    try {
      parts.push(JSON.stringify(rest));
    } catch {
      // Non-serializable prop bag (e.g. a function-valued prop that circularly references the
      // fiber) — skip, the leaf text/other props still get walked.
    }
    n.children.forEach(visit);
  }
  visit(node);
  return parts.join('|');
}

function findHostDescendants(
  root: renderer.ReactTestInstance,
  predicate: (node: renderer.ReactTestInstance) => boolean,
): renderer.ReactTestInstance[] {
  return root.findAll((node) => typeof node.type === 'string' && predicate(node));
}

const KINDS = ['filesystem', 'rest'] as const;
const STATES = ['never', 'success', 'error'] as const;

// ---------------------------------------------------------------------------
// Suite A — transportCopy as a pure unit (no rendering).
// ---------------------------------------------------------------------------

describe('transportCopy — pure resolver', () => {
  const expectedHeadingKey = {
    filesystem: 'bulkImportSyncFilesystemHeading',
    rest: 'bulkImportSyncRestHeading',
  };
  const expectedBodyKey = {
    never: 'bulkImportSyncNeverSyncedBody',
    success: 'bulkImportSyncLastSyncedLabel',
    error: 'bulkImportSyncLastSyncedLabel',
  };

  for (const kind of KINDS) {
    for (const state of STATES) {
      it(`returns testIDBase/headingKey/bodyKey together for (${kind}, ${state})`, () => {
        const copy = transportCopy(kind, state);
        expect(copy.testIDBase).toBe(`transport-status-${kind}-${state}`);
        expect(copy.headingKey).toBe(expectedHeadingKey[kind]);
        expect(copy.bodyKey).toBe(expectedBodyKey[state]);
      });
    }
  }

  it('heading key is a pure function of kind alone, across all six pairs', () => {
    for (const kind of KINDS) {
      const headingKeys = STATES.map((state) => transportCopy(kind, state).headingKey);
      expect(new Set(headingKeys).size).toBe(1);
      expect(headingKeys[0]).toBe(expectedHeadingKey[kind]);
    }
  });

  it('body key is a pure function of syncState alone, across all six pairs', () => {
    for (const state of STATES) {
      const bodyKeys = KINDS.map((kind) => transportCopy(kind, state).bodyKey);
      expect(new Set(bodyKeys).size).toBe(1);
      expect(bodyKeys[0]).toBe(expectedBodyKey[state]);
    }
  });
});

// ---------------------------------------------------------------------------
// Suite B — TRANSPORT_STATE_ICONS shape.
// ---------------------------------------------------------------------------

describe('TRANSPORT_STATE_ICONS — shape', () => {
  it('has exactly three keys', () => {
    expect(Object.keys(TRANSPORT_STATE_ICONS).sort()).toEqual(['error', 'never', 'success']);
  });

  it('maps never -> circle-question / muted', () => {
    expect(TRANSPORT_STATE_ICONS.never).toEqual({ icon: 'circle-question', colorRole: 'muted' });
  });

  it('maps success -> circle-check / success', () => {
    expect(TRANSPORT_STATE_ICONS.success).toEqual({ icon: 'circle-check', colorRole: 'success' });
  });

  it('maps error -> circle-xmark / error', () => {
    expect(TRANSPORT_STATE_ICONS.error).toEqual({ icon: 'circle-xmark', colorRole: 'error' });
  });
});

// ---------------------------------------------------------------------------
// Suite C — rendered filesystem/REST cards, all three states, both kinds (six renders).
// ---------------------------------------------------------------------------

describe('TransportStatusCard — rendered state proofs', () => {
  const expectedIconColor: Record<string, string> = {
    never: SENTINEL_COLORS.textSecondary,
    success: SENTINEL_COLORS.success,
    error: SENTINEL_COLORS.error,
  };
  const expectedIconName: Record<string, string> = {
    never: 'circle-question',
    success: 'circle-check',
    error: 'circle-xmark',
  };

  for (const kind of KINDS) {
    for (const state of STATES) {
      it(`renders the ${state} state correctly for kind=${kind} (root, icon, heading+body together)`, () => {
        const onSyncNow = jest.fn();
        const tree = renderCard(
          <TransportStatusCard kind={kind} syncState={state} onSyncNow={onSyncNow} />,
        );

        // Root node exists.
        expect(findByTestID(tree.root, `transport-status-card-${kind}`)).toHaveLength(1);

        // Icon carries the expected name and sentinel color.
        const iconWrap = findByTestID(tree.root, `transport-status-icon-${kind}`)[0];
        const iconNode = iconWrap.findByType('FontAwesome6');
        expect(iconNode.props.name).toBe(expectedIconName[state]);
        expect(iconNode.props.color).toBe(expectedIconColor[state]);

        // Heading and body asserted together, in the same test, so a mismatch fails as one
        // named failure.
        const copy = transportCopy(kind, state);
        const headingNode = findByTestID(tree.root, `${copy.testIDBase}-heading`)[0];
        const bodyNode = findByTestID(tree.root, `${copy.testIDBase}-body`)[0];
        expect(serializeSubtree(headingNode)).toContain(copy.headingKey);
        expect(serializeSubtree(bodyNode)).toContain(copy.bodyKey);
      });
    }

    it(`Sync Now button (kind=${kind}) is accent-colored and never warning-colored`, () => {
      const onSyncNow = jest.fn();
      const tree = renderCard(
        <TransportStatusCard kind={kind} syncState="never" onSyncNow={onSyncNow} />,
      );
      const buttonSubtree = findByTestID(tree.root, `transport-sync-now-${kind}`)[0];
      const serialized = serializeSubtree(buttonSubtree);
      expect(serialized).toContain(SENTINEL_COLORS.accent);
      expect(serialized).not.toContain(SENTINEL_COLORS.warning);
    });
  }
});

// ---------------------------------------------------------------------------
// Suite D — the disabled legibility contract. Legibility control, NOT a security boundary —
// the 'vrg' scope gate is not enforcement (Phase 999.1).
// ---------------------------------------------------------------------------

describe('TransportStatusCard — disabled legibility contract', () => {
  for (const kind of KINDS) {
    it(`renders the Sync Now control (not hidden) with disabled=true for kind=${kind}, and does not invoke onSyncNow`, () => {
      const onSyncNow = jest.fn();
      const tree = renderCard(
        <TransportStatusCard kind={kind} syncState="never" disabled onSyncNow={onSyncNow} />,
      );
      const buttonWrap = findByTestID(tree.root, `transport-sync-now-${kind}`)[0];
      expect(buttonWrap).toBeDefined();

      // `disabled` is consumed by TouchableOpacity itself (a composite, not a host primitive) —
      // it is never forwarded onto the underlying host View, so this search deliberately does
      // NOT filter to host-only nodes the way findByTestID/findHostDescendants do elsewhere.
      const disabledTouchables = buttonWrap.findAll((node) => node.props.disabled === true);
      expect(disabledTouchables.length).toBeGreaterThanOrEqual(1);
      disabledTouchables[0].props.onPress?.();
      expect(onSyncNow).not.toHaveBeenCalled();
    });
  }
});

// ---------------------------------------------------------------------------
// Suite E — counts line.
// ---------------------------------------------------------------------------

describe('TransportStatusCard — counts line', () => {
  for (const kind of KINDS) {
    it(`omits the counts node (kind=${kind}) when all three counts are undefined`, () => {
      const onSyncNow = jest.fn();
      const tree = renderCard(
        <TransportStatusCard kind={kind} syncState="never" onSyncNow={onSyncNow} />,
      );
      expect(findByTestID(tree.root, `transport-status-counts-${kind}`)).toHaveLength(0);
    });

    it(`renders only the imported segment (kind=${kind}) when importedCount=12 and the rest are undefined`, () => {
      const onSyncNow = jest.fn();
      const tree = renderCard(
        <TransportStatusCard
          kind={kind}
          syncState="success"
          importedCount={12}
          onSyncNow={onSyncNow}
        />,
      );
      const countsNode = findByTestID(tree.root, `transport-status-counts-${kind}`)[0];
      expect(countsNode).toBeDefined();
      const serialized = serializeSubtree(countsNode);
      expect(serialized).toContain('bulkImportSyncImportedCountLabel');
      expect(serialized).not.toContain('bulkImportSyncPendingCountLabel');
      expect(serialized).not.toContain('bulkImportSyncErrorCountLabel');
    });
  }
});

// ExperimentalTransportStatusCard is destructured above for use by the suites appended below
// (peer-card proofs) — see the block at the end of this file.
