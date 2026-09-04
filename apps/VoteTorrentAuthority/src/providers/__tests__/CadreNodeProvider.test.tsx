/**
 * Behavioral tests for CadreNodeProvider — P2P-02 (GAP 1) + D-14 config-fault
 * wiring (56-10).
 *
 * Pins the documented boot invariants from 22-02-SUMMARY.md:
 *   - node.start() is NOT called synchronously during render (T-22-03 / D-06):
 *     CadreNode is constructed, but start() fires only after mount (in a useEffect).
 *   - NO setInterval / no polling anywhere (D-10 hard requirement).
 *   - syncState is event-driven: starts 'offline', listeners registered via on(),
 *     and a 'control:connected' / 'strand:started' event transitions to 'connected'.
 *   - useCadreNode() throws when called outside a CadreNodeProvider.
 *
 * D-14 adds: resolveBootstrapNodes keeps its exact one-string/string[]
 * signature and blank-safe contract; a bootstrap-config fault reaches the
 * context as `configFault` without blocking boot; the mocked CadreNode
 * constructor receives `controlNetwork.bootstrapNodes` derived from the
 * (mocked) config document, proving the wiring is load-bearing; and no
 * document content — including a recognisable probe value — ever reaches
 * the context value or a `console.error` call.
 *
 * CadreNode (@serfab/cadre-core) and openOptimysticRNDb / loadOrCreateRNPeerKey /
 * LevelDBRawStorage (@optimystic/db-p2p-storage-rn), plus rn-leveldb and the
 * libp2p transports, are ESM-only / native deps that cannot load under the
 * react-native jest preset — so they are virtual-mocked here. CadreNode is mocked
 * as a class whose start()/stop() are jest.fns and which records on()/off()
 * listener registrations so the test can drive events.
 */

import React from 'react';
import renderer from 'react-test-renderer';

// ---------------------------------------------------------------------------
// Capture each constructed fake CadreNode so the test can drive its events and
// assert on start()/on()/off() without reaching into module internals.
// ---------------------------------------------------------------------------

type Listener = (...args: unknown[]) => void;

// `mock`-prefixed so jest's hoisted module factory is allowed to reference it.
// Each constructed fake CadreNode pushes itself here for the test to drive.
const mockConstructedNodes: FakeCadreNode[] = [];

interface FakeCadreNode {
  start: jest.Mock;
  stop: jest.Mock;
  getStrand: jest.Mock;
  onCalls: Array<[string, Listener]>;
  offCalls: Array<[string, Listener]>;
  /** The options object the constructor was called with (D-14 wiring proof). */
  receivedOptions: unknown;
  emit(event: string): void;
  hasListener(event: string): boolean;
}

jest.mock(
  '@serfab/cadre-core',
  () => {
    class FakeCadreNode {
      public start = jest.fn(async () => {});
      public stop = jest.fn(async () => {});
      public getStrand = jest.fn(() => undefined);
      private listeners: Record<string, Listener[]> = {};
      public onCalls: Array<[string, Listener]> = [];
      public offCalls: Array<[string, Listener]> = [];
      public receivedOptions: unknown;

      constructor(opts: unknown) {
        this.receivedOptions = opts;
        mockConstructedNodes.push(this);
      }

      on(event: string, cb: Listener) {
        this.onCalls.push([event, cb]);
        (this.listeners[event] ??= []).push(cb);
      }

      off(event: string, cb: Listener) {
        this.offCalls.push([event, cb]);
        this.listeners[event] = (this.listeners[event] ?? []).filter((l) => l !== cb);
      }

      emit(event: string) {
        (this.listeners[event] ?? []).forEach((l) => l());
      }

      hasListener(event: string) {
        return (this.listeners[event] ?? []).length > 0;
      }
    }
    return { CadreNode: FakeCadreNode };
  },
  { virtual: true },
);

jest.mock(
  'rn-leveldb',
  () => ({ LevelDB: class {}, LevelDBWriteBatch: class {} }),
  { virtual: true },
);

jest.mock(
  '@optimystic/db-p2p-storage-rn',
  () => ({
    openOptimysticRNDb: jest.fn(() => ({})),
    LevelDBRawStorage: class {},
    loadOrCreateRNPeerKey: jest.fn(async () => ({ type: 'Ed25519' })),
  }),
  { virtual: true },
);

jest.mock('@libp2p/websockets', () => ({ webSockets: () => ({}) }), { virtual: true });
jest.mock(
  '@libp2p/circuit-relay-v2',
  () => ({ circuitRelayTransport: () => ({}) }),
  { virtual: true },
);

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { CadreNodeProvider, useCadreNode, resolveBootstrapNodes } = require('../CadreNodeProvider');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Renders the provider with a probe child that captures the current context
 * value on every render, so the test can read syncState / node as they update.
 */
function renderProvider() {
  const captured: { value: ReturnType<typeof useCadreNode> | null } = { value: null };

  function Probe() {
    captured.value = useCadreNode();
    return null;
  }

  let tr!: renderer.ReactTestRenderer;
  renderer.act(() => {
    tr = renderer.create(
      <CadreNodeProvider>
        <Probe />
      </CadreNodeProvider>,
    );
  });
  return { tr, captured };
}

beforeEach(() => {
  mockConstructedNodes.length = 0;
  jest.clearAllMocks();
});

/** Flush the async microtasks queued by the provider's boot effect (construct + start). */
async function flushBoot() {
  await renderer.act(async () => {
    // Several turns: openOptimysticRNDb (sync) → await loadOrCreateRNPeerKey →
    // construct CadreNode → await start() → setNode → listener effect.
    for (let i = 0; i < 10; i++) {
      // eslint-disable-next-line no-await-in-loop
      await Promise.resolve();
    }
  });
}

describe('CadreNodeProvider — P2P-02 boot invariants', () => {
  it('does NOT call node.start() synchronously during render (T-22-03 / D-06)', () => {
    // Render synchronously (act flushes only the render + sync effect scheduling).
    // The boot effect's body is async: it awaits loadOrCreateRNPeerKey BEFORE the
    // CadreNode is even constructed, so start() cannot have run during render.
    const { captured } = renderProvider();

    // Initial synchronous render must expose a context value with node === null
    // (start() resolves and calls setNode only later, off the render path).
    expect(captured.value).not.toBeNull();
    expect(captured.value!.node).toBeNull();

    // And no node has been started in the synchronous render pass.
    const started = mockConstructedNodes.some((n) => n.start.mock.calls.length > 0);
    expect(started).toBe(false);
  });

  it('starts the node only after mount, via an effect (start() eventually called)', async () => {
    renderProvider();
    await flushBoot();

    expect(mockConstructedNodes.length).toBe(1);
    const node = mockConstructedNodes[0];
    expect(node.start).toHaveBeenCalledTimes(1);
  });

  it('does NOT call setInterval anywhere (no polling — D-10)', async () => {
    const setIntervalSpy = jest.spyOn(globalThis, 'setInterval');
    renderProvider();
    await flushBoot();
    expect(setIntervalSpy).not.toHaveBeenCalled();
    setIntervalSpy.mockRestore();
  });

  it('defaults syncState to "offline" before any event fires', () => {
    const { captured } = renderProvider();
    expect(captured.value!.syncState).toBe('offline');
  });

  it('registers event listeners on the node and transitions to "connected" on control:connected (event-driven, D-10)', async () => {
    const { captured } = renderProvider();

    // Let the boot effect resolve so setNode runs and the listener effect fires.
    await flushBoot();
    const node = mockConstructedNodes[0];

    // Event-driven proof: a listener is registered for the connected event.
    expect(node.hasListener('control:connected')).toBe(true);
    expect(captured.value!.syncState).toBe('offline');

    // Drive the event → syncState transitions to 'connected'.
    renderer.act(() => {
      node.emit('control:connected');
    });
    expect(captured.value!.syncState).toBe('connected');
  });

  it('transitions to "connected" on strand:started as well', async () => {
    const { captured } = renderProvider();
    await flushBoot();
    const node = mockConstructedNodes[0];

    expect(node.hasListener('strand:started')).toBe(true);
    renderer.act(() => {
      node.emit('strand:started');
    });
    expect(captured.value!.syncState).toBe('connected');
  });

  it('removes its event listeners on unmount (cleanup via off())', async () => {
    const { tr } = renderProvider();
    await flushBoot();
    const node = mockConstructedNodes[0];
    expect(node.onCalls.length).toBeGreaterThan(0);

    renderer.act(() => {
      tr.unmount();
    });
    expect(node.offCalls.length).toBeGreaterThan(0);
  });

  it('useCadreNode() throws when used outside a CadreNodeProvider', () => {
    function Orphan() {
      useCadreNode();
      return null;
    }
    expect(() => {
      renderer.act(() => {
        renderer.create(<Orphan />);
      });
    }).toThrow('useCadreNode must be used within a CadreNodeProvider');
  });
});

// ---------------------------------------------------------------------------
// resolveBootstrapNodes — blank-safe single-address guard (D-14, 56-10).
//
// D-14 replaced the CONTROL_ADDR/BOOTSTRAP_PLACEHOLDER sentinel with a
// validated config document (bootstrap-config.ts). resolveBootstrapNodes
// itself keeps its EXACT signature and contract: one string in, string[]
// out, [] for empty/blank, never throw. Only the input SOURCE changed — it
// now receives one already-validated address at a time via
// `bootstrapConfig.addrs.flatMap(resolveBootstrapNodes)`, rather than one
// hard-coded constant.
// ---------------------------------------------------------------------------
describe('resolveBootstrapNodes — blank-safe single-address guard (D-14)', () => {
  it('returns [] for an empty string', () => {
    expect(resolveBootstrapNodes('')).toEqual([]);
  });

  it('returns [] for undefined', () => {
    expect(resolveBootstrapNodes(undefined as unknown as string)).toEqual([]);
  });

  it('returns [] for a whitespace-only string', () => {
    expect(resolveBootstrapNodes('   ')).toEqual([]);
  });

  it('returns [addr] for a real address', () => {
    const real = '/ip4/203.0.113.9/tcp/443/wss/p2p/12D3KooWReal';
    expect(resolveBootstrapNodes(real)).toEqual([real]);
  });

  it('signature lock: still takes exactly one parameter', () => {
    // A later refactor widening this to take a list would silently break the
    // D-14 contract — this pins the arity so that regression fails loudly.
    expect(resolveBootstrapNodes.length).toBe(1);
  });

  it('is still exported from the module', () => {
    expect(typeof resolveBootstrapNodes).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// Config-fault wiring (D-14, 56-10). Each test loads a FRESH instance of the
// provider module with `bootstrap.config.json` mocked to a specific document,
// so the module-scope `readBootstrapConfig(bootstrapConfigDoc)` call re-runs
// against that document. jest.resetModules() clears the module registry
// (NOT the top-level virtual mocks registered above, which persist).
// ---------------------------------------------------------------------------
describe('CadreNodeProvider — config-fault wiring (D-14)', () => {
  // `bootstrapConfig` is computed at MODULE SCOPE in CadreNodeProvider.tsx (by
  // design — see its D-14 header comment), so proving a fault reaches the
  // context for a GIVEN document requires re-requiring the whole module fresh
  // per document. jest.resetModules() clears the module registry — including
  // 'react' — which would otherwise hand the freshly-required provider a
  // SECOND react module instance with its own hook-dispatcher state, crashing
  // every hook call with "Cannot read properties of null (reading 'useState')"
  // (the exact multi-copy-React trap memory records for shared components).
  // Pinning 'react' to the single instance already loaded by this test file
  // (captured once, before any reset) keeps the dispatcher singular.
  const actualReact = jest.requireActual('react');

  afterEach(() => {
    jest.dontMock('../../../bootstrap.config.json');
    jest.dontMock('react');
  });

  function loadProviderModuleWithDoc(doc: unknown) {
    jest.resetModules();
    jest.doMock('react', () => actualReact);
    jest.doMock('../../../bootstrap.config.json', () => doc, { virtual: true });
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('../CadreNodeProvider');
  }

  it('a missing/empty document reaches the context as configFault, and node still becomes non-null', async () => {
    const mod = loadProviderModuleWithDoc({ bootstrapNodes: [] });
    const captured: { value: ReturnType<typeof mod.useCadreNode> | null } = { value: null };

    function Probe() {
      captured.value = mod.useCadreNode();
      return null;
    }

    await renderer.act(async () => {
      renderer.create(
        <mod.CadreNodeProvider>
          <Probe />
        </mod.CadreNodeProvider>,
      );
      for (let i = 0; i < 10; i++) {
        // eslint-disable-next-line no-await-in-loop
        await Promise.resolve();
      }
    });

    expect(captured.value!.configFault).toEqual({ kind: 'missing', reason: 'empty-address-list' });
    // Boot is not blocked by a fault — the node still constructs and starts.
    expect(captured.value!.node).not.toBeNull();
  });

  it('a valid document reports configFault: null, and the mocked CadreNode receives the derived bootstrapNodes', async () => {
    const validAddr = '/ip4/203.0.113.9/tcp/443/wss/p2p/12D3KooWExample';
    const mod = loadProviderModuleWithDoc({ bootstrapNodes: [validAddr] });
    const captured: { value: ReturnType<typeof mod.useCadreNode> | null } = { value: null };

    function Probe() {
      captured.value = mod.useCadreNode();
      return null;
    }

    await renderer.act(async () => {
      renderer.create(
        <mod.CadreNodeProvider>
          <Probe />
        </mod.CadreNodeProvider>,
      );
      for (let i = 0; i < 10; i++) {
        // eslint-disable-next-line no-await-in-loop
        await Promise.resolve();
      }
    });

    expect(captured.value!.configFault).toBeNull();
    // mockConstructedNodes is the shared, file-scoped capture array the
    // '@serfab/cadre-core' virtual mock pushes every constructed FakeCadreNode
    // into (module-level, survives jest.resetModules()). The most recently
    // constructed instance is this test's node; its receivedOptions is the
    // exact object the REAL provider passed to `new CadreNode(...)` — this is
    // the assertion that proves the wiring is load-bearing, not decorative.
    const lastNode = mockConstructedNodes[mockConstructedNodes.length - 1];
    const receivedOptions = lastNode.receivedOptions as { controlNetwork: { bootstrapNodes: string[] } };
    expect(receivedOptions.controlNetwork.bootstrapNodes).toEqual([validAddr]);
  });

  it('no document echo: a malformed document carrying a recognisable probe never reaches context or console.error', async () => {
    const LEAK_PROBE = 'LEAKPROBE0123';
    const mod = loadProviderModuleWithDoc({ bootstrapNodes: [`/ip4/${LEAK_PROBE}/tcp/443/wss`] });
    const captured: { value: ReturnType<typeof mod.useCadreNode> | null } = { value: null };
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    function Probe() {
      captured.value = mod.useCadreNode();
      return null;
    }

    await renderer.act(async () => {
      renderer.create(
        <mod.CadreNodeProvider>
          <Probe />
        </mod.CadreNodeProvider>,
      );
      for (let i = 0; i < 10; i++) {
        // eslint-disable-next-line no-await-in-loop
        await Promise.resolve();
      }
    });

    expect(JSON.stringify(captured.value!.configFault)).not.toContain(LEAK_PROBE);
    for (const call of errorSpy.mock.calls) {
      for (const arg of call) {
        expect(String(arg)).not.toContain(LEAK_PROBE);
      }
    }

    errorSpy.mockRestore();
  });
});
