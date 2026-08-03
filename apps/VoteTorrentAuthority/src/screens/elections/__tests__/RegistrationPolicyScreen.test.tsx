/**
 * RegistrationPolicyScreen.test.tsx — the VALIDATION Wave-0 screen integration
 * suite for Phase 46 (46-09), covering D-02 (District field), D-03 (compound
 * 'district' audience gate), D-04/D-05 (reconciliation + repair), D-07
 * (tri-state attestation), D-10 (scope-gated read-only render), D-13
 * (warn-don't-block confirmation) and D-14 (immediate per-row apply).
 *
 * PATTERN SOURCE: apps/VoteTorrentAuthority/src/screens/ballots/__tests__/BallotConfirmation.test.tsx
 * — a REAL MockRegistrationEngine instance imported via a relative `dist/`
 * require, NOT AdministratorInvitationScreen.test.tsx's `jest.fn()`-mock
 * pattern. react-test-renderer ONLY; @testing-library/react-native and
 * @testing-library/react-hooks are NOT dependencies of this app.
 *
 * ============================================================================
 * DECLARED BLIND SPOT — read before trusting a single green test in this file.
 * ============================================================================
 * `MockRegistrationEngine.addElectionRegistrationField` and
 * `addElectionDisclosurePolicy` are `Map.set` — an UPSERT. The real engine's
 * equivalents are plain `insert into` against an `(ElectionId, FieldName)`
 * primary key, so an in-place tier/requirement/audience edit MUST be executed
 * as remove-then-add (two separate 'mel'-signed calls — 46-08 T-46-08-01).
 * Because the mock upserts, a single bare `add` on an existing row silently
 * succeeds there too. THIS SUITE THEREFORE PASSES WHETHER OR NOT 46-08's
 * remove-then-add sequencing is correct — it is structurally blind to that
 * entire defect class. The D-14 test below (test 15) asserts the *callback
 * contract* only (one remove, then one add, in that order) and states plainly
 * that this proves call sequencing, NOT that the real engine accepts the
 * sequence. Real-engine proof is routed to 46-10's device run, and 46-10's
 * single signed write is an add-of-a-new-field, which does not exercise the
 * *edit* path either — an edit against the real engine remains unproven after
 * this phase unless 46-10 or a follow-up performs one. Making
 * MockRegistrationEngine throw on duplicate keys is a CANDIDATE FOLLOW-UP
 * ONLY, deliberately not done here — it would change a shared fixture every
 * other suite in this workspace depends on.
 * ============================================================================
 */

import React from "react";
import renderer from "react-test-renderer";

// ---------------------------------------------------------------------------
// Mutable module-level slots. Prefixed `mock` so the jest babel transform
// (babel-plugin-jest-hoist) allows the jest.mock() factories below to close
// over them despite being declared outside the factory's own scope.
// ---------------------------------------------------------------------------
let mockCurrentElectionEngine: any = null;

interface TestOfficer {
  userId: string;
  authorityId: string;
  title: string;
  scopes: string[];
}
let mockOfficers: TestOfficer[] = [];

const mockGetAdminDetails = jest.fn(async () => ({ admin: { officers: mockOfficers } }));

let mockRegistrationEngine: any;

const mockNetworkEngine = {
  openAuthority: jest.fn(async () => ({ getAdminDetails: mockGetAdminDetails })),
};

// The getEngine dispatcher: serves the current real MockRegistrationEngine
// instance for "registration" and the network-engine fixture (officer lookup
// chain) for "network" — everything else resolves null.
const mockGetEngine = jest.fn(async (name: string): Promise<any> => {
  if (name === "registration") return mockRegistrationEngine;
  if (name === "network") return mockNetworkEngine;
  return null;
});

// ---------------------------------------------------------------------------
// Module mocks — all heavy native / cross-cutting deps, module scope, before
// any import of the screen (mirrors BallotConfirmation.test.tsx exactly).
// ---------------------------------------------------------------------------

jest.mock("react-native-vector-icons/FontAwesome6", () => "FontAwesome6");

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock("@votetorrent/vote-engine/rn", () => ({}), { virtual: true });

jest.mock("../../../providers/SettingsProvider", () => ({
  useSettings: () => ({ showHelpIcons: false }),
}));

// react-i18next: an interpolation-ECHOING t(), load-bearing for the D-10
// scope-naming test — it returns the bare key with no options, and
// `key + "|" + String(options.scope)` when an options object carries a
// `scope` field, so a test can prove scopeDescriptions.mel was actually bound
// rather than merely that some key rendered.
jest.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { scope?: string }) =>
      options && "scope" in options ? key + "|" + String(options.scope) : key,
  }),
}));

const mockGoBack = jest.fn();
const mockNavigate = jest.fn();
const mockSetOptions = jest.fn();
const mockSetParams = jest.fn();

jest.mock("@react-navigation/native", () => ({
  // Distinct sentinel values for every color token so a color assertion can
  // never pass by accidental equality between two tokens.
  useTheme: () => ({
    colors: {
      primary: "sentinel-primary",
      background: "sentinel-background",
      card: "sentinel-card",
      text: "sentinel-text",
      border: "sentinel-border",
      notification: "sentinel-notification",
      error: "sentinel-error",
      textSecondary: "sentinel-textSecondary",
      important: "sentinel-important",
      success: "sentinel-success",
      accent: "sentinel-accent",
      warning: "sentinel-warning",
      dark: "sentinel-dark",
      light: "sentinel-light",
    },
  }),
  useNavigation: () => ({
    navigate: mockNavigate,
    goBack: mockGoBack,
    setOptions: mockSetOptions,
    setParams: mockSetParams,
  }),
  // useFocusEffect: call the callback synchronously (simulating focus on mount).
  useFocusEffect: (cb: () => void | (() => void)) => {
    cb();
  },
  useRoute: () => ({
    params: {
      electionEngine: mockCurrentElectionEngine,
      electionId: "test-election",
      authorityId: "auth-1",
    },
  }),
}));

jest.mock("../../../engines/device-user", () => ({
  getOrCreateDeviceUser: jest.fn(async () => ({ id: "device-user-1", name: "Device User" })),
}));

jest.mock("../../../engines/device-signer", () => ({
  createDeviceSigner: jest.fn(async () => async () => ({
    signature: "mock-sig",
    signerKey: "mock-key",
    signerUserId: "device-user-1",
  })),
}));

jest.mock("../../../providers/AppProvider", () => ({
  useApp: () => ({ getEngine: mockGetEngine }),
}));

// ---------------------------------------------------------------------------
// The REAL mock engine — required by relative dist path, exactly six levels
// up, matching BallotConfirmation.test.tsx. NOT `@votetorrent/vote-engine` —
// the package's `exports` field blocks this subpath. 46-01 rebuilds
// vote-engine's dist/; without that rebuild the attestation methods this
// suite needs are invisible to this require (see the stale-dist guard below).
// ---------------------------------------------------------------------------
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { MockRegistrationEngine } = require(
  "../../../../../../packages/vote-engine/dist/registration/mock-registration-engine",
);

// ---------------------------------------------------------------------------
// Election-engine fixture. `registrationEnds` is the only registration
// member of ElectionEvent — there is no registrationOpens/registrationCloses
// member on ElectionEvent itself (those are Timeline.tsx display labels
// mapped onto this one member). Default registrationEndsAt is one day in the
// PAST (window CLOSED) so D-13's card stays off unless a test opts in.
// getElectionRegistrants is stubbed to [] (D-08), so D-13's rosterNonEmpty
// leg can never be exercised by this suite — the window leg (below) is the
// only reachable trigger.
// ---------------------------------------------------------------------------
interface ElectionEngineFixtureOptions {
  districts?: string[];
  registrationEndsAt?: number;
}

function makeElectionEngine(options: ElectionEngineFixtureOptions) {
  const districts = options.districts ?? [];
  const registrationEndsAt = options.registrationEndsAt ?? Date.now() - 86400000;
  return {
    getBallots: jest.fn(async () => [{ id: "b1" }]),
    getBallotDetails: jest.fn(async (id: string) => ({ ballot: { id, districts } })),
    getElectionDetails: jest.fn(async () => ({
      election: {},
      current: { timeline: { registrationEnds: registrationEndsAt } },
    })),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A stable, reusable sign callback for directly-seeded engine state (bypasses createDeviceSigner). */
const SEED_SIGN = async () => ({
  signature: "seed-sig",
  signerKey: "seed-key",
  signerUserId: "seed-user",
});

async function flushTicks(count: number): Promise<void> {
  await renderer.act(async () => {
    for (let i = 0; i < count; i++) {
      await Promise.resolve();
    }
  });
}

async function renderScreen(): Promise<renderer.ReactTestRenderer> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const RegistrationPolicyScreenModule = require("../RegistrationPolicyScreen");
  const RegistrationPolicyScreen =
    RegistrationPolicyScreenModule.default ?? RegistrationPolicyScreenModule.RegistrationPolicyScreen;

  let tr!: renderer.ReactTestRenderer;
  await renderer.act(async () => {
    tr = renderer.create(<RegistrationPolicyScreen />);
  });

  // Flush AT LEAST four ticks — this screen's load chain is deeper than a
  // typical screen: registration engine acquisition -> 3 policy reads ->
  // getBallots -> Promise.all of getBallotDetails -> registrants length ->
  // getElectionDetails, PLUS useCurrentOfficerScopes' own device-user ->
  // network engine -> openAuthority -> getAdminDetails walk.
  await flushTicks(6);

  return tr;
}

/**
 * Fires the real handler on a write control reachable under `testID`.
 *
 * ChipButton binds `onPressIn`, NOT `onPress`, and forwards no testID of its
 * own — the testID lives on writeWrap's wrapping View, which itself carries
 * neither handler. A press helper that only checks `onPress` on the exact
 * testID node finds nothing and silently no-ops, letting every press-driven
 * test pass vacuously. Asserting a non-empty candidate list BEFORE firing
 * turns a renamed/restructured control into a loud failure instead.
 */
async function press(tr: renderer.ReactTestRenderer, testID: string): Promise<void> {
  const wrapper = tr.root.findByProps({ testID });
  const candidates = wrapper.findAll(
    (node) => typeof node.props.onPressIn === "function" || typeof node.props.onPress === "function",
  );
  expect(candidates.length).toBeGreaterThan(0);
  const target = candidates[0]!;
  await renderer.act(async () => {
    if (typeof target.props.onPressIn === "function") {
      target.props.onPressIn();
    } else {
      target.props.onPress();
    }
  });
  await flushTicks(4);
}

/**
 * The D-10 read-only variant of `press` — used ONLY where an EMPTY candidate
 * list is the CORRECT outcome. `findByProps` itself is the "control still
 * present" assertion (it throws if the testID is missing). ChipButton-backed
 * controls (writeWrap) genuinely have no live handler when canWrite is false
 * (onPress is set to `undefined`, not a no-op). AttestationPolicySection's
 * CustomButton controls instead bind a stable NOOP — RN's `disabled` prop
 * alone does not stop a directly-invoked (non-touch-driven) onPress
 * reference from firing, so NOOP exists specifically to make a direct
 * programmatic call safe. Either way, firing whatever is found here must
 * produce zero engine calls.
 */
function attemptPress(tr: renderer.ReactTestRenderer, testID: string): void {
  const wrapper = tr.root.findByProps({ testID });
  const candidates = wrapper.findAll(
    (node) => typeof node.props.onPressIn === "function" || typeof node.props.onPress === "function",
  );
  candidates.forEach((c) => {
    if (typeof c.props.onPressIn === "function") c.props.onPressIn();
    else if (typeof c.props.onPress === "function") c.props.onPress();
  });
}

function present(tr: renderer.ReactTestRenderer, testID: string): void {
  expect(() => tr.root.findByProps({ testID })).not.toThrow();
}

function absent(tr: renderer.ReactTestRenderer, testID: string): void {
  expect(() => tr.root.findByProps({ testID })).toThrow();
}

function treeText(tr: renderer.ReactTestRenderer): string {
  return JSON.stringify(tr.toJSON());
}

/** Seeds an ElectionRegistrationField directly through the mock's own engine surface. */
async function seedField(
  engine: any,
  args: { fieldName: string; tier: string; requirement: string },
): Promise<void> {
  await engine.addElectionRegistrationField(
    { electionId: "test-election", fieldName: args.fieldName, tier: args.tier, requirement: args.requirement },
    SEED_SIGN,
  );
}

/** Seeds an ElectionDisclosurePolicy directly through the mock's own engine surface. */
async function seedDisclosure(
  engine: any,
  args: { fieldName: string; audience: string },
): Promise<void> {
  await engine.addElectionDisclosurePolicy(
    { electionId: "test-election", fieldName: args.fieldName, audience: args.audience },
    SEED_SIGN,
  );
}

/**
 * Spies on all six 'mel'-signed write methods WITHOUT replacing their
 * implementation — the mock's state must keep mutating for real so the
 * screen's post-write loadPolicy() reload observes real changes.
 */
function spyWrites(engine: any) {
  return {
    addElectionRegistrationField: jest.spyOn(engine, "addElectionRegistrationField"),
    removeElectionRegistrationField: jest.spyOn(engine, "removeElectionRegistrationField"),
    addElectionDisclosurePolicy: jest.spyOn(engine, "addElectionDisclosurePolicy"),
    removeElectionDisclosurePolicy: jest.spyOn(engine, "removeElectionDisclosurePolicy"),
    setElectionAttestationPolicy: jest.spyOn(engine, "setElectionAttestationPolicy"),
    removeElectionAttestationPolicy: jest.spyOn(engine, "removeElectionAttestationPolicy"),
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.clearAllMocks();
  mockRegistrationEngine = new MockRegistrationEngine();
  mockOfficers = [{ userId: "device-user-1", authorityId: "auth-1", title: "Chair", scopes: ["mel"] }];
  mockCurrentElectionEngine = makeElectionEngine({});
  // Do NOT call jest.resetModules() — that would break the cached dist
  // require and the mock factory closures (the same note
  // BallotConfirmation.test.tsx carries).
});

describe("RegistrationPolicyScreen — VALIDATION Wave 0 (D-02/D-03/D-04/D-05/D-07/D-10/D-13/D-14)", () => {

  // -------------------------------------------------------------------------
  // Stale-dist guard
  // -------------------------------------------------------------------------

  it("stale-dist guard: MockRegistrationEngine exposes the attestation trio on a fresh instance", () => {
    // A failure here means packages/vote-engine/dist/ is stale relative to
    // 46-01's engine-surface additions and must be rebuilt — this makes a
    // stale dist fail loudly and legibly here instead of surfacing as an
    // obscure downstream render error deep inside this suite.
    const engine = new MockRegistrationEngine();
    expect(typeof engine.setElectionAttestationPolicy).toBe("function");
    expect(typeof engine.getElectionAttestationPolicy).toBe("function");
    expect(typeof engine.removeElectionAttestationPolicy).toBe("function");
  });

  // -------------------------------------------------------------------------
  // D-07 tri-state attestation
  // -------------------------------------------------------------------------

  it("D-07: not-configured is a real state — reachable with no row present (T-46-02)", async () => {
    const tr = await renderScreen();
    present(tr, "attestation-state-not-configured");
    // The fail-closed default MUST be a distinct UI state the read never
    // synthesizes — collapsing "no row" into either explicit state would
    // silently invert D-07's fail-closed rule.
    absent(tr, "attestation-state-required");
    absent(tr, "attestation-state-not-required");
    absent(tr, "attestation-action-revert");
  });

  it("D-07: required (set) renders the required state only", async () => {
    await mockRegistrationEngine.setElectionAttestationPolicy("test-election", true, SEED_SIGN);
    const tr = await renderScreen();
    present(tr, "attestation-state-required");
    absent(tr, "attestation-state-not-configured");
    absent(tr, "attestation-state-not-required");
    present(tr, "attestation-action-revert");
  });

  it("D-07: not-required (set) renders the not-required state only", async () => {
    await mockRegistrationEngine.setElectionAttestationPolicy("test-election", false, SEED_SIGN);
    const tr = await renderScreen();
    present(tr, "attestation-state-not-required");
    absent(tr, "attestation-state-not-configured");
    absent(tr, "attestation-state-required");
    present(tr, "attestation-action-revert");
  });

  // -------------------------------------------------------------------------
  // D-10 scope gate
  // -------------------------------------------------------------------------

  it("D-10: an officer holding 'mel' sees neither read-only banner", async () => {
    mockOfficers = [{ userId: "device-user-1", authorityId: "auth-1", title: "Chair", scopes: ["mel"] }];
    const tr = await renderScreen();
    absent(tr, "registration-policy-readonly-banner");
    absent(tr, "registration-policy-readonly-no-officer-banner");
  });

  it("D-10: an officer WITHOUT 'mel' sees the scoped banner naming Manage Elections", async () => {
    mockOfficers = [{ userId: "device-user-1", authorityId: "auth-1", title: "Clerk", scopes: ["ceb"] }];
    const tr = await renderScreen();
    present(tr, "registration-policy-readonly-banner");
    absent(tr, "registration-policy-readonly-no-officer-banner");
    // The interpolation-echoing t() proves scopeDescriptions.mel ("Manage
    // Elections") was actually bound into the translated string, not merely
    // that some key rendered.
    expect(treeText(tr)).toContain("registrationPolicyReadOnlyBanner|Manage Elections");
  });

  it("D-10: a device with no matching Officer row sees the DISTINCT no-officer banner", async () => {
    mockOfficers = [];
    const tr = await renderScreen();
    present(tr, "registration-policy-readonly-no-officer-banner");
    absent(tr, "registration-policy-readonly-banner");
    // scopes === undefined (no matching officer) and scopes === [] (an
    // officer holding zero scopes) are two distinct facts and must never
    // collapse to one banner (T-46-03).
  });

  it("D-10: the read-only render fires ZERO writes while every control stays present", async () => {
    mockOfficers = [{ userId: "device-user-1", authorityId: "auth-1", title: "Clerk", scopes: ["ceb"] }];
    await mockRegistrationEngine.addElectionRegistrationField(
      { electionId: "test-election", fieldName: "LastName", tier: "public", requirement: "required" },
      SEED_SIGN,
    );

    const addField = jest.spyOn(mockRegistrationEngine, "addElectionRegistrationField");
    const removeField = jest.spyOn(mockRegistrationEngine, "removeElectionRegistrationField");
    const addDisclosure = jest.spyOn(mockRegistrationEngine, "addElectionDisclosurePolicy");
    const removeDisclosure = jest.spyOn(mockRegistrationEngine, "removeElectionDisclosurePolicy");
    const setAttestation = jest.spyOn(mockRegistrationEngine, "setElectionAttestationPolicy");
    const removeAttestation = jest.spyOn(mockRegistrationEngine, "removeElectionAttestationPolicy");

    const tr = await renderScreen();

    // Press every write control reachable in this read-only render. Controls
    // stay PRESENT (findByProps does not throw) even though canWrite=false.
    attemptPress(tr, "registration-field-tier-LastName-selective");
    attemptPress(tr, "registration-field-requirement-LastName-optional");
    attemptPress(tr, "registration-field-remove-LastName");
    attemptPress(tr, "attestation-action-require");
    attemptPress(tr, "attestation-action-dont-require");

    // T-46-03: this pins the UI affordance ONLY. The real control is the
    // DB-side 'mel'-scoped AdminSignature CHECK on all three policy tables —
    // no assertion here may be read as a canWrite=false render itself
    // preventing a write; only a rejected signed mutation against the real
    // engine proves that.
    const totalCalls =
      addField.mock.calls.length +
      removeField.mock.calls.length +
      addDisclosure.mock.calls.length +
      removeDisclosure.mock.calls.length +
      setAttestation.mock.calls.length +
      removeAttestation.mock.calls.length;
    expect(totalCalls).toBe(0);
  });

  // -------------------------------------------------------------------------
  // D-02 District field
  // -------------------------------------------------------------------------

  it("D-02: District is offered, visually separated, and rendered once declared", async () => {
    const tr1 = await renderScreen();
    present(tr1, "registration-field-picker-known");
    present(tr1, "registration-field-picker-divider");
    present(tr1, "registration-field-picker-district");
    present(tr1, "registration-field-district-hint");

    await seedField(mockRegistrationEngine, { fieldName: "District", tier: "public", requirement: "optional" });
    const tr2 = await renderScreen();
    present(tr2, "registration-field-row-District");
  });

  // -------------------------------------------------------------------------
  // D-03 compound 'district' audience gate — proven at the SCREEN level via
  // the screen's own N+1 getBallots -> getBallotDetails read. The remaining
  // two truth-table legs (Leg B alone; both legs closed) are proven at the
  // component level by 46-06's DisclosurePolicySection.test.tsx and are not
  // duplicated here.
  // -------------------------------------------------------------------------

  it("D-03: the compound gate is OPEN when both legs hold, proven via the screen's own N+1 read", async () => {
    await seedField(mockRegistrationEngine, { fieldName: "District", tier: "public", requirement: "optional" });
    await seedField(mockRegistrationEngine, { fieldName: "Address", tier: "selective", requirement: "optional" });
    mockCurrentElectionEngine = makeElectionEngine({ districts: ["D1"] });

    const tr = await renderScreen();
    present(tr, "disclosure-audience-Address-district");
    expect(mockCurrentElectionEngine.getBallotDetails).toHaveBeenCalled();
  });

  it("D-03: the compound gate is CLOSED (chip ABSENT, not disabled) when Leg A alone fails", async () => {
    await seedField(mockRegistrationEngine, { fieldName: "District", tier: "public", requirement: "optional" });
    await seedField(mockRegistrationEngine, { fieldName: "Address", tier: "selective", requirement: "optional" });
    mockCurrentElectionEngine = makeElectionEngine({ districts: [] });

    const tr = await renderScreen();
    absent(tr, "disclosure-audience-Address-district");
    present(tr, "disclosure-audience-Address-everyone");
    expect(tr.root.findAllByProps({ testID: "disclosure-district-unavailable-hint" }, { deep: false }).length).toBe(1);
  });

  // -------------------------------------------------------------------------
  // D-04/D-05 reconciliation + repair
  // -------------------------------------------------------------------------

  it("D-04/D-05: an orphan disclosure is flagged, its repair removes the row on the real mock, and the flag clears", async () => {
    await seedDisclosure(mockRegistrationEngine, { fieldName: "ZipCode", audience: "everyone" });
    const spies = spyWrites(mockRegistrationEngine);

    const tr = await renderScreen();
    present(tr, "registration-policy-issues-card");
    present(tr, "registration-policy-issue-orphan-ZipCode");

    await press(tr, "registration-policy-issue-repair-remove-ZipCode");

    expect(spies.removeElectionDisclosurePolicy).toHaveBeenCalledTimes(1);
    const [electionIdArg, fieldNameArg, signArg] = spies.removeElectionDisclosurePolicy.mock.calls[0]!;
    expect(electionIdArg).toBe("test-election");
    expect(fieldNameArg).toBe("ZipCode");
    expect(typeof signArg).toBe("function");

    const remaining = await mockRegistrationEngine.getElectionDisclosurePolicies("test-election");
    expect(remaining).toEqual([]);

    absent(tr, "registration-policy-issue-orphan-ZipCode");
  });

  it("D-04/D-05: an audience-less selective field is flagged, its repair sets an audience on the real mock, and the flag clears", async () => {
    await seedField(mockRegistrationEngine, { fieldName: "Address", tier: "selective", requirement: "optional" });
    const spies = spyWrites(mockRegistrationEngine);

    const tr = await renderScreen();
    present(tr, "registration-policy-issue-no-audience-Address");

    // Reveal the inline Everyone/District choice first — it is never defaulted.
    await press(tr, "registration-policy-issue-repair-set-audience-Address");
    await press(tr, "registration-policy-issue-audience-Address-everyone");

    expect(spies.addElectionDisclosurePolicy).toHaveBeenCalledTimes(1);
    const [payload, signArg] = spies.addElectionDisclosurePolicy.mock.calls[0]!;
    expect(payload).toEqual({ electionId: "test-election", fieldName: "Address", audience: "everyone" });
    expect(typeof signArg).toBe("function");

    const rows = await mockRegistrationEngine.getElectionDisclosurePolicies("test-election");
    expect(rows.length).toBe(1);

    absent(tr, "registration-policy-issue-no-audience-Address");
  });

  it("clean state: a selective field with its matching disclosure renders no issues card", async () => {
    // The control that stops the two tests above from passing on an
    // always-on card.
    await seedField(mockRegistrationEngine, { fieldName: "Address", tier: "selective", requirement: "optional" });
    await seedDisclosure(mockRegistrationEngine, { fieldName: "Address", audience: "everyone" });

    const tr = await renderScreen();
    absent(tr, "registration-policy-issues-card");
  });

  // -------------------------------------------------------------------------
  // D-14 — call sequencing only (T-46-09-01, see the header's declared blind
  // spot). MockRegistrationEngine's addElectionRegistrationField is a Map.set
  // upsert, so a single bare `add` on an existing LastName row would ALSO
  // succeed here — this test cannot and does not distinguish that from the
  // correct remove-then-add sequence. It asserts the CALLBACK CONTRACT only:
  // one edit produces exactly one remove followed by exactly one add against
  // the mock, and nothing else. A green run here does not prove policy
  // editing works against the real engine's plain-insert (ElectionId,
  // FieldName) PK — that proof is routed to 46-10's device run, and 46-10's
  // add-a-new-field write does not exercise this edit path either. Do NOT
  // "fix" this by making the mock throw on duplicate keys — that changes a
  // shared fixture every other suite in this workspace depends on; it is a
  // candidate follow-up only.
  // -------------------------------------------------------------------------

  it("D-14: one tier edit fires exactly one remove then one add, and nothing else — CALL SEQUENCING ONLY", async () => {
    await seedField(mockRegistrationEngine, { fieldName: "LastName", tier: "public", requirement: "required" });
    const spies = spyWrites(mockRegistrationEngine);

    const tr = await renderScreen();
    await press(tr, "registration-field-tier-LastName-selective");

    expect(spies.removeElectionRegistrationField).toHaveBeenCalledTimes(1);
    expect(spies.removeElectionRegistrationField).toHaveBeenCalledWith(
      "test-election",
      "LastName",
      expect.any(Function),
    );

    expect(spies.addElectionRegistrationField).toHaveBeenCalledTimes(1);
    const [addPayload] = spies.addElectionRegistrationField.mock.calls[0]!;
    expect(addPayload).toEqual({
      electionId: "test-election",
      fieldName: "LastName",
      tier: "selective",
      requirement: "required", // unchanged requirement carried through
    });

    expect(spies.addElectionDisclosurePolicy).toHaveBeenCalledTimes(0);
    expect(spies.removeElectionDisclosurePolicy).toHaveBeenCalledTimes(0);
    expect(spies.setElectionAttestationPolicy).toHaveBeenCalledTimes(0);
    expect(spies.removeElectionAttestationPolicy).toHaveBeenCalledTimes(0);

    expect(spies.removeElectionRegistrationField.mock.invocationCallOrder[0]).toBeLessThan(
      spies.addElectionRegistrationField.mock.invocationCallOrder[0]!,
    );
  });

});
