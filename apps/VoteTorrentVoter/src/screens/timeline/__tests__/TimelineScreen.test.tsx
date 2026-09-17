/**
 * Unit tests for TimelineScreen (Phase 59, plan 59-08, Task 1 — D-01/D-02/D-03/D-04/D-12).
 *
 * Mocks `@react-navigation/native` (spy-able `navigate`, a hand-typed `useTheme` token shape —
 * this path is outside the no-hardcoded-hex gate's scanned roots, so hex literals here are fine,
 * exactly as `ConfirmationScreen.test.tsx:29-46`) and `../../../providers/VoterAppProvider` with
 * an inline factory whose `getEngine` dispatches on engine name and whose `getElection` must stay
 * uncalled (D-04 read-scope fence). Imports the real `'../../../i18n'` instance so `useTranslation`
 * resolves production copy, and uses a 10-key timeline built from `dev-seed.ts`'s own relative
 * shape (`electionDate` anchor, offsets in days/hours) rather than hand-picked instants.
 */
import React from 'react';
import renderer from 'react-test-renderer';
import '../../../i18n';
import {TimelineRail} from '../../../components/TimelineRail';
import {TIMELINE_STAGE_IDS} from '../../../timeline';

const mockNavigate = jest.fn();

// ---------------------------------------------------------------------------
// useFocusEffect mock registry — mirrors
// RegistrationInboxScreen.test.tsx's 48-25 pattern exactly (the precedent
// `TimelineScreen.tsx`'s own registration-status effect fix follows). Fires
// each registered callback once per callback-identity change (deps `[cb]`,
// matching the real hook while focused) AND exposes `mockTriggerFocus` to
// simulate an explicit re-focus with NO identity change at all — the
// tab-away-and-back case this regression suite is about. Prefixed `mock` —
// babel-plugin-jest-hoist forbids a jest.mock() factory from closing over a
// non-`mock`-prefixed out-of-scope binding.
// ---------------------------------------------------------------------------
interface MockFocusEntry {
	cb: () => void | (() => void);
	cleanup: (() => void) | undefined;
}
let mockFocusEntries: MockFocusEntry[] = [];

/**
 * Simulates a real re-focus: runs every registered callback's cleanup (if
 * any), then re-invokes the callback and records its new cleanup. Call from
 * inside `renderer.act(...)`.
 */
function mockTriggerFocus(): void {
	for (const entry of mockFocusEntries) {
		if (typeof entry.cleanup === 'function') entry.cleanup();
		entry.cleanup = entry.cb() ?? undefined;
	}
}

jest.mock('@react-navigation/native', () => ({
	useNavigation: () => ({navigate: mockNavigate}),
	// Deferred via a real useEffect keyed on [cb] (NOT called synchronously during render) —
	// mirrors RegistrationInboxScreen.test.tsx's own mock exactly.
	useFocusEffect: (cb: () => void | (() => void)) => {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const ReactLib = require('react');
		ReactLib.useEffect(() => {
			const entry: MockFocusEntry = {cb, cleanup: undefined};
			entry.cleanup = cb() ?? undefined;
			mockFocusEntries.push(entry);
			return () => {
				mockFocusEntries = mockFocusEntries.filter(e => e !== entry);
				if (typeof entry.cleanup === 'function') entry.cleanup();
			};
		}, [cb]);
	},
	useTheme: () => ({
		colors: {
			primary: '#2196f3',
			background: '#fbfbfb',
			card: '#ffffff',
			text: '#000000',
			textSecondary: '#7d7d7d',
			border: '#e5e5e5',
			error: '#971d1d',
			warning: '#bcb600',
			light: '#ffffff',
			link: '#2196f3',
			secondaryButtonSurface: '#f5f5f5',
		},
		fonts: {
			regular: {fontFamily: 'System', fontWeight: '400'},
			medium: {fontFamily: 'System', fontWeight: '500'},
			bold: {fontFamily: 'System', fontWeight: '700'},
		},
		// CR-01: was a hand-copied SUBSET of the real scale (display/h2/h4/body/caption only). When
		// CountdownTimer started reading `type.captionSmall`, every test through this mock crashed
		// on `undefined.fontSize` -- the component was correct and the stub was stale. Sourced from
		// the real module instead, so a new token can never again break tests that never named it.
		// `jest.requireActual` is used because a jest.mock factory is hoisted and may not close over
		// imported bindings.
		type: jest.requireActual('../../../theme/themes').type,
		radii: jest.requireActual('../../../theme/themes').radii,
	}),
}));

// ---- Production-length fixtures (59-UI-SPEC.md, no hand-picked short strings) ----

const PRODUCTION_ELECTION_TITLE = 'Salt Lake County School Board Special Election 2025'; // 53 chars

const SEEDED_ELECTION_ID = 'election-1';

// dev-seed.ts:216-248's own relative shape, extended to ten (59-01) — 180 days out, offsets in
// days/hours from that anchor. Deliberately NOT a hand-picked absolute date set.
const ELECTION_DATE = Date.now() + 180 * 86_400_000;

// `anchor` mirrors dev-seed.ts's own `electionDate`. This fixture is a deliberately frozen
// monotonic ten-event shape, parameterized so header-range tests (Task 2) can anchor it at an
// explicit UTC calendar point instead of "now" (determinism) — it is NOT pinned to dev-seed.ts's
// exact per-event deltas (61-05 widened dev-seed.ts's registrationEnds/ballotsFinal/votingStarts
// gaps to a 31-day votingStarts window; this fixture's own offsets stay as they were so the
// header-range assertions below stay stable).
function buildValidTimeline(anchor: number = ELECTION_DATE, overrides: Partial<Record<string, number>> = {}): Record<string, number> {
	return {
		registrationEnds: anchor - 25 * 86_400_000,
		ballotsFinal: anchor - 14 * 86_400_000,
		votingStarts: anchor - 2 * 86_400_000,
		accruingVotes: anchor - 20 * 3_600_000,
		hashingVotes: anchor - 16 * 3_600_000,
		releasingKeys: anchor - 12 * 3_600_000,
		tallyingStarts: anchor,
		validation: anchor + 86_400_000,
		certificationStarts: anchor + 2 * 86_400_000,
		closed: anchor + 3 * 86_400_000,
		...overrides,
	};
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildElectionDetails(timeline: Record<string, number> = buildValidTimeline(), anchor: number = ELECTION_DATE): any {
	return {
		election: {
			id: SEEDED_ELECTION_ID,
			authorityId: 'authority-1',
			title: PRODUCTION_ELECTION_TITLE,
			date: anchor,
			revisionDeadline: anchor - 30 * 86_400_000,
			ballotDeadline: anchor - 7 * 86_400_000,
			type: 'adhoc',
		},
		current: {
			electionId: SEEDED_ELECTION_ID,
			revision: 0,
			revisionTimestamp: [],
			tags: [],
			instructions: '',
			keyholders: [],
			timeline,
			keyholderThreshold: 1,
		},
	};
}

const SUMMARY_A = {id: SEEDED_ELECTION_ID, title: PRODUCTION_ELECTION_TITLE, authorityName: 'Salt Lake County', date: ELECTION_DATE, type: 'adhoc'};

// ---- Mocked engine boundary: getEngine('elections') -> getElections/openElection/getElectionDetails ----

const mockGetElectionDetails = jest.fn(async () => buildElectionDetails());
const mockElectionEngine = {getElectionDetails: mockGetElectionDetails};

const mockOpenElection = jest.fn(async (_id: string) => mockElectionEngine);
const mockGetElections = jest.fn(async () => [SUMMARY_A]);
const mockElectionsEngine = {getElections: mockGetElections, openElection: mockOpenElection};

// ---- 59-09's registration-status read: `getEngine('network' | 'association' | 'registration')`.
// Stubbed here to resolve cleanly to a "not registered" answer (zero Association rows, zero
// outstanding requests) so this Task 1/2 suite's PRE-EXISTING assertions -- none of which are
// about the registration panel -- aren't disturbed by 59-09's additional, legitimate engine
// calls. `TimelineScreen.test.tsx` still has no test of its own asserting on the panel's
// content; that coverage lives in `RegistrationPanel.test.tsx` and `registration-status.test.ts`.
const mockGetNetworkDetails = jest.fn(async () => ({
	network: {id: 'network-1', hash: 'network-hash-1', name: 'Stub Network', primaryAuthorityId: 'authority-1', relays: [] as string[]},
}));
const mockNetworkEngine = {getDetails: mockGetNetworkDetails};
const mockGetAssociationsByDeviceKey = jest.fn(async () => [] as unknown[]);
const mockListAssociationRequests = jest.fn(async () => [] as unknown[]);
const mockAssociationEngine = {getAssociationsByDeviceKey: mockGetAssociationsByDeviceKey, listAssociationRequests: mockListAssociationRequests};

const mockGetEngine = jest.fn(async (engineName: string) => {
	if (engineName === 'elections') {
		return mockElectionsEngine;
	}
	if (engineName === 'network') {
		return mockNetworkEngine;
	}
	if (engineName === 'association') {
		return mockAssociationEngine;
	}
	throw new Error(`unexpected getEngine call: ${engineName}`);
});

const mockGetElection = jest.fn(async () => {
	throw new Error('getElection() must never be called by TimelineScreen (D-04 read-scope fence)');
});

// ---- 59-09: `resolveAttestationProducer().provisionDeviceKey()` -- mocked exactly as
// `ConfirmationScreen.test.tsx` mocks the same module, so this suite never reaches the REAL
// hardware-backed producer (`@votetorrent/attestation-native`'s `TurboModuleRegistry` call,
// which is unregistered under Jest and throws `Invariant Violation`).
const mockProvisionDeviceKey = jest.fn(async () => ({publicKey: 'p256-stub-device-key'}));
const mockResolveAttestationProducer = jest.fn((..._args: unknown[]) => ({provisionDeviceKey: mockProvisionDeviceKey}));
jest.mock('../../../engines/attestation-producer', () => ({
	resolveAttestationProducer: (...args: unknown[]) => mockResolveAttestationProducer(...args),
}));

let mockSeededElectionId: string | undefined = SEEDED_ELECTION_ID;

jest.mock('../../../providers/VoterAppProvider', () => ({
	useVoterApp: () => ({
		getEngine: mockGetEngine,
		getElection: mockGetElection,
		get seededElectionId() {
			return mockSeededElectionId;
		},
	}),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const TimelineScreenModule = require('../TimelineScreen');
const TimelineScreen = TimelineScreenModule.default;
const {pickElectionId} = TimelineScreenModule;

function renderScreen() {
	let tr!: renderer.ReactTestRenderer;
	renderer.act(() => {
		tr = renderer.create(<TimelineScreen />);
	});
	return tr;
}

async function flushMicrotasks(times = 30) {
	for (let i = 0; i < times; i++) {
		await Promise.resolve();
	}
}

async function renderAndFlush(flushes = 30) {
	const tr = renderScreen();
	await renderer.act(async () => {
		await flushMicrotasks(flushes);
	});
	return tr;
}

function hasTestId(tr: renderer.ReactTestRenderer, testID: string): boolean {
	return tr.root.findAllByProps({testID}).length > 0;
}

// ---- CR-01: device-time-zone mocking. `TimelineScreen.tsx`'s `resolveDeviceTimeZone()` is the
// ONLY zero-argument `Intl.DateTimeFormat()` call anywhere under `src/timeline/` or
// `src/screens/timeline/` (every other call site passes `(language, options)` to FORMAT an
// already-resolved zone, never to resolve one) -- so intercepting exactly the zero-arg shape and
// delegating every other call to the real constructor lets these tests pin the "device" zone
// deterministically (this repo's CI/dev hosts do not all run in UTC) without touching how any
// actual date gets formatted.
const RealDateTimeFormat = Intl.DateTimeFormat;

function mockDeviceTimeZone(zone: string): void {
	jest.spyOn(Intl, 'DateTimeFormat').mockImplementation(((...args: unknown[]) => {
		if (args.length === 0) {
			return {resolvedOptions: () => ({timeZone: zone}) as Intl.ResolvedDateTimeFormatOptions} as Intl.DateTimeFormat;
		}
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		return new (RealDateTimeFormat as any)(...args);
	}) as unknown as typeof Intl.DateTimeFormat);
}

/** WR-01 (59-REVIEW-2): forces the zero-arg `Intl.DateTimeFormat()` call — the one
 * `resolveDeviceTimeZone()` makes — to THROW, simulating a device/Hermes/ICU build where the
 * resolved-options lookup is unavailable. Every other `Intl` call site in this phase
 * (`relative-date.ts`'s `dateParts`/`weekdayName`) already guards this with try/catch; this
 * proves the screen degrades to its documented UTC fallback instead of crashing render, which
 * would otherwise defeat D-03's "never blank, never silent" guarantee (the voter app has no
 * ErrorBoundary to catch a render throw). */
function mockDeviceTimeZoneThrows(): void {
	jest.spyOn(Intl, 'DateTimeFormat').mockImplementation(((...args: unknown[]) => {
		if (args.length === 0) {
			throw new RangeError('resolvedOptions unavailable on this build');
		}
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		return new (RealDateTimeFormat as any)(...args);
	}) as unknown as typeof Intl.DateTimeFormat);
}

beforeEach(() => {
	// Pins the "device" zone to UTC by default so every PRE-EXISTING test below (written and
	// reasoned about against UTC-anchored fixtures) stays deterministic regardless of the actual
	// host's local zone. The CR-01 describe block below overrides this per-test to prove the
	// screen actually forwards a non-UTC device zone end to end.
	mockDeviceTimeZone('UTC');
	mockNavigate.mockClear();
	mockGetEngine.mockClear();
	mockGetElection.mockClear();
	mockGetElections.mockClear();
	mockOpenElection.mockClear();
	mockGetElectionDetails.mockClear();
	mockGetNetworkDetails.mockClear();
	mockProvisionDeviceKey.mockClear();
	mockGetAssociationsByDeviceKey.mockClear();
	mockListAssociationRequests.mockClear();

	mockGetEngine.mockImplementation(async (engineName: string) => {
		if (engineName === 'elections') {
			return mockElectionsEngine;
		}
		if (engineName === 'network') {
			return mockNetworkEngine;
		}
		if (engineName === 'association') {
			return mockAssociationEngine;
		}
		throw new Error(`unexpected getEngine call: ${engineName}`);
	});
	mockGetElections.mockImplementation(async () => [SUMMARY_A]);
	mockOpenElection.mockImplementation(async (_id: string) => mockElectionEngine);
	mockGetElectionDetails.mockImplementation(async () => buildElectionDetails());
	mockGetNetworkDetails.mockImplementation(async () => ({
		network: {id: 'network-1', hash: 'network-hash-1', name: 'Stub Network', primaryAuthorityId: 'authority-1', relays: [] as string[]},
	}));
	mockGetAssociationsByDeviceKey.mockImplementation(async () => []);
	mockListAssociationRequests.mockImplementation(async () => []);

	mockSeededElectionId = SEEDED_ELECTION_ID;

	// A focus-callback entry leaked from a previous test is its own defect class — reset the
	// registry alongside every other mock (mirrors RegistrationInboxScreen.test.tsx:506).
	mockFocusEntries = [];
});

afterEach(() => {
	jest.restoreAllMocks(); // undoes mockDeviceTimeZone's Intl.DateTimeFormat spy, every test.
});

describe('pickElectionId (D-02)', () => {
	it('a single summary -> that summary id', () => {
		expect(pickElectionId([SUMMARY_A], undefined)).toBe(SUMMARY_A.id);
	});

	it('several summaries -> the one nearest to now, ties broken by ascending id', () => {
		const now = Date.now();
		const near = {...SUMMARY_A, id: 'z-far-but-picked-by-tie', date: now + 1000};
		const far = {...SUMMARY_A, id: 'a-election', date: now + 50_000};
		// Exact tie on |date - now| against a THIRD summary decides by ascending id.
		const tieA = {...SUMMARY_A, id: 'b-tie', date: now + 5000};
		const tieB = {...SUMMARY_A, id: 'a-tie', date: now + 5000};

		expect(pickElectionId([far, near], undefined)).toBe(near.id);
		expect(pickElectionId([tieA, tieB], undefined)).toBe('a-tie');
	});

	it('empty list + a fallback id supplied -> the fallback wins (the __DEV__ gate lives at the call site, not here)', () => {
		expect(pickElectionId([], 'seeded-1')).toBe('seeded-1');
	});

	it('empty list + no fallback supplied -> undefined (covers both __DEV__ false, and __DEV__ true with no seed)', () => {
		expect(pickElectionId([], undefined)).toBeUndefined();
	});
});

describe('TimelineScreen — real elections read (D-01)', () => {
	it('drives getEngine -> getElections -> openElection -> getElectionDetails exactly once each, then renders the rail', async () => {
		const tr = await renderAndFlush();

		// 59-09: `getEngine('elections')` fires from THIS effect, exactly once; the screen's
		// SEPARATE registration-status effect (Task 3) also resolves `'network'`/`'association'`
		// through the SAME shared `getEngine` mock, so the TOTAL call count grows from 1 to 3 --
		// asserted by call-args below rather than re-counting a shared mock across two unrelated
		// effects into one brittle total.
		expect(mockGetEngine).toHaveBeenCalledWith('elections');
		expect(mockGetEngine.mock.calls.filter(call => call[0] === 'elections')).toHaveLength(1);
		expect(mockGetElections).toHaveBeenCalledTimes(1);
		expect(mockOpenElection).toHaveBeenCalledTimes(1);
		expect(mockOpenElection).toHaveBeenCalledWith(SEEDED_ELECTION_ID);
		expect(mockGetElectionDetails).toHaveBeenCalledTimes(1);

		expect(hasTestId(tr, 'timeline-rail')).toBe(true);
		expect(hasTestId(tr, 'timeline-indeterminate')).toBe(false);
	});

	it('never calls useVoterApp().getElection() (D-04 read-scope fence)', async () => {
		await renderAndFlush();
		expect(mockGetElection).not.toHaveBeenCalled();
	});

	it('before the first read resolves, neither the rail nor the indeterminate frame is mounted', () => {
		const tr = renderScreen();
		expect(hasTestId(tr, 'timeline-rail')).toBe(false);
		expect(hasTestId(tr, 'timeline-indeterminate')).toBe(false);
	});
});

describe('TimelineScreen — D-03 indeterminate frame, four rejection points', () => {
	it('getEngine rejects -> indeterminate frame, rail absent', async () => {
		mockGetEngine.mockRejectedValueOnce(new Error('engine boot failed'));
		const tr = await renderAndFlush();
		expect(hasTestId(tr, 'timeline-indeterminate')).toBe(true);
		expect(hasTestId(tr, 'timeline-rail')).toBe(false);
	});

	it('getElections rejects -> indeterminate frame, rail absent', async () => {
		mockGetElections.mockRejectedValueOnce(new Error('network read failed'));
		const tr = await renderAndFlush();
		expect(hasTestId(tr, 'timeline-indeterminate')).toBe(true);
		expect(hasTestId(tr, 'timeline-rail')).toBe(false);
	});

	it('openElection rejects -> indeterminate frame, rail absent', async () => {
		mockOpenElection.mockRejectedValueOnce(new Error('Election election-1 not found'));
		const tr = await renderAndFlush();
		expect(hasTestId(tr, 'timeline-indeterminate')).toBe(true);
		expect(hasTestId(tr, 'timeline-rail')).toBe(false);
	});

	it('getElectionDetails rejects -> indeterminate frame, rail absent', async () => {
		mockGetElectionDetails.mockRejectedValueOnce(new Error('details read failed'));
		const tr = await renderAndFlush();
		expect(hasTestId(tr, 'timeline-indeterminate')).toBe(true);
		expect(hasTestId(tr, 'timeline-rail')).toBe(false);
	});

	it('no election id resolvable (empty list, no usable fallback) -> indeterminate frame, rail absent', async () => {
		mockGetElections.mockImplementation(async () => []);
		mockSeededElectionId = undefined;
		const tr = await renderAndFlush();
		expect(hasTestId(tr, 'timeline-indeterminate')).toBe(true);
		expect(hasTestId(tr, 'timeline-rail')).toBe(false);
		expect(mockOpenElection).not.toHaveBeenCalled();
	});

	it("the derivation's own indeterminate verdict (all-absent timeline) -> indeterminate frame, rail absent — never a partial/guessed rail", async () => {
		mockGetElectionDetails.mockImplementation(async () => buildElectionDetails({}));
		const tr = await renderAndFlush();
		expect(hasTestId(tr, 'timeline-indeterminate')).toBe(true);
		expect(hasTestId(tr, 'timeline-rail')).toBe(false);
	});
});

describe('TimelineScreen — retry (D-03)', () => {
	it('a getElections that rejects once then resolves renders the rail after the retry press', async () => {
		mockGetElections.mockRejectedValueOnce(new Error('transient'));
		const tr = await renderAndFlush();
		expect(hasTestId(tr, 'timeline-indeterminate')).toBe(true);

		const retry = tr.root.findByProps({testID: 'timeline-indeterminate-retry'});
		await renderer.act(async () => {
			retry.props.onPress();
			await flushMicrotasks(30);
		});

		expect(hasTestId(tr, 'timeline-rail')).toBe(true);
		expect(hasTestId(tr, 'timeline-indeterminate')).toBe(false);
		expect(mockGetElections).toHaveBeenCalledTimes(2);
	});
});

describe('TimelineScreen — D-04/D-12 read-scope source fence', () => {
	it('the screen source references none of ElectionCard, mockData, LIFECYCLE_CONTENT, keysReleased, checksComplete', () => {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const fs = require('fs');
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const path = require('path');
		const source: string = fs.readFileSync(path.resolve(__dirname, '../TimelineScreen.tsx'), 'utf8');

		for (const forbidden of ['ElectionCard', 'mockData', 'LIFECYCLE_CONTENT', 'keysReleased', 'checksComplete']) {
			expect(source).not.toContain(forbidden);
		}
	});
});

// ==== Task 2: header, rail composition, row-action callbacks ====

function textOf(node: renderer.ReactTestInstance): string {
	return JSON.stringify(node.props.children ?? '');
}

describe('TimelineScreen — header (Task 2)', () => {
	it('the 53-char production title renders in full, with no numberOfLines prop', async () => {
		const tr = await renderAndFlush();
		const title = tr.root.findByProps({testID: 'timeline-header-title'});
		expect(title.props.numberOfLines).toBeUndefined();
		expect(textOf(title)).toContain(PRODUCTION_ELECTION_TITLE);
	});

	it('same-month/year range -> endDate is the bare day number ("January 3" - "31")', async () => {
		// Jan 28 2030 UTC anchor: registrationEnds = Jan 3, closed = Jan 31 -- both January 2030.
		const anchor = Date.UTC(2030, 0, 28);
		mockGetElectionDetails.mockImplementation(async () => buildElectionDetails(buildValidTimeline(anchor), anchor));

		const tr = await renderAndFlush();
		const range = tr.root.findByProps({testID: 'timeline-header-date-range'});
		expect(textOf(range)).toContain('January 3');
		expect(textOf(range)).toContain('31');
		expect(textOf(range)).not.toContain('January 31');
	});

	it('cross-month range -> endDate carries its own month name', async () => {
		// Jan 10 2030 UTC anchor: registrationEnds = Dec 16 2029, closed = Jan 13 2030.
		const anchor = Date.UTC(2030, 0, 10);
		mockGetElectionDetails.mockImplementation(async () => buildElectionDetails(buildValidTimeline(anchor), anchor));

		const tr = await renderAndFlush();
		const range = tr.root.findByProps({testID: 'timeline-header-date-range'});
		expect(textOf(range)).toContain('December 16');
		expect(textOf(range)).toContain('January 13');
	});

	it('fewer than two distinct calendar days among present instants -> the date-range line is omitted, title still renders', async () => {
		const dayAnchor = Date.UTC(2030, 2, 15, 0, 0, 0);
		const singleDayTimeline: Record<string, number> = {
			registrationEnds: dayAnchor + 1 * 3_600_000,
			ballotsFinal: dayAnchor + 2 * 3_600_000,
			votingStarts: dayAnchor + 3 * 3_600_000,
			accruingVotes: dayAnchor + 4 * 3_600_000,
			hashingVotes: dayAnchor + 5 * 3_600_000,
			releasingKeys: dayAnchor + 6 * 3_600_000,
			tallyingStarts: dayAnchor + 7 * 3_600_000,
			validation: dayAnchor + 8 * 3_600_000,
			certificationStarts: dayAnchor + 9 * 3_600_000,
			closed: dayAnchor + 10 * 3_600_000,
		};
		// buildElectionDetails' generic ballotDeadline formula (anchor - 7 DAYS) assumes a
		// day-scale anchor; this fixture is hour-scale, so ballotDeadline is set directly here
		// (just after ballotsFinal) instead of reusing that helper's offset.
		mockGetElectionDetails.mockImplementation(async () => ({
			election: {
				id: SEEDED_ELECTION_ID,
				authorityId: 'authority-1',
				title: PRODUCTION_ELECTION_TITLE,
				date: dayAnchor + 7 * 3_600_000,
				revisionDeadline: dayAnchor - 30 * 86_400_000,
				ballotDeadline: dayAnchor + 2.5 * 3_600_000,
				type: 'adhoc',
			},
			current: {
				electionId: SEEDED_ELECTION_ID,
				revision: 0,
				revisionTimestamp: [],
				tags: [],
				instructions: '',
				keyholders: [],
				timeline: singleDayTimeline,
				keyholderThreshold: 1,
			},
		}));

		const tr = await renderAndFlush();
		expect(hasTestId(tr, 'timeline-indeterminate')).toBe(false);
		expect(tr.root.findAllByProps({testID: 'timeline-header-date-range'})).toHaveLength(0);
		expect(textOf(tr.root.findByProps({testID: 'timeline-header-title'}))).toContain(PRODUCTION_ELECTION_TITLE);
	});

	it('a 7-of-10-key timeline (pre-D-08 signed row) still produces a range from the seven present instants -- not indeterminate', async () => {
		const anchor = Date.UTC(2030, 0, 10);
		const sevenKeyTimeline = buildValidTimeline(anchor);
		// The three D-08 additions absent -- a pre-D-08 signed row (parseTimeline tolerates a
		// missing key; MISSING_EVENT degrades per-row, never the whole view-model).
		delete sevenKeyTimeline.accruingVotes;
		delete sevenKeyTimeline.hashingVotes;
		delete sevenKeyTimeline.releasingKeys;
		mockGetElectionDetails.mockImplementation(async () => buildElectionDetails(sevenKeyTimeline, anchor));

		const tr = await renderAndFlush();
		expect(hasTestId(tr, 'timeline-indeterminate')).toBe(false);
		const range = tr.root.findByProps({testID: 'timeline-header-date-range'});
		expect(textOf(range)).toContain('December 16');
		expect(textOf(range)).toContain('January 13');
	});
});

// ==== CR-01: TimelineScreen must resolve and forward the DEVICE-local zone, not a hardcoded
// UTC default (types.ts:122's "device-local, never UTC" contract), to both computeHeaderDateRange
// and deriveTimeline. Before the fix, TimelineScreen.tsx never passed `timeZone` to either call
// at all -- so `mockDeviceTimeZone` below (which only intercepts the zero-arg
// `Intl.DateTimeFormat()` resolution call `resolveDeviceTimeZone()` makes) had NO observable
// effect pre-fix, and every assertion in this block that expects a Denver-shifted date failed. ====

// 2030-01-01T03:00:00Z -- January 1 in UTC, but still December 31, 2029 in America/Denver (MST,
// UTC-7, no DST in January): a deliberately zone-sensitive boundary instant, not a hand-picked
// coincidence.
const ZONE_BOUNDARY_INSTANT = Date.UTC(2030, 0, 1, 3, 0, 0);
const ZONE_BOUNDARY_ANCHOR = Date.UTC(2030, 3, 1);

describe('TimelineScreen — device-local time zone default (CR-01)', () => {
	it('header date range: a device zone of America/Denver renders the boundary instant as "December 31", not "January 1"', async () => {
		mockDeviceTimeZone('America/Denver');
		const timeline = buildValidTimeline(ZONE_BOUNDARY_ANCHOR, {registrationEnds: ZONE_BOUNDARY_INSTANT});
		mockGetElectionDetails.mockImplementation(async () => buildElectionDetails(timeline, ZONE_BOUNDARY_ANCHOR));

		const tr = await renderAndFlush();
		expect(hasTestId(tr, 'timeline-indeterminate')).toBe(false);
		const range = tr.root.findByProps({testID: 'timeline-header-date-range'});
		expect(textOf(range)).toContain('December 31');
		expect(textOf(range)).not.toContain('January 1');
	});

	it('header date range: the SAME boundary instant renders as "January 1" under a UTC device zone -- proving the Denver assertion above is genuinely zone-sensitive, not a fixture artifact', async () => {
		mockDeviceTimeZone('UTC');
		const timeline = buildValidTimeline(ZONE_BOUNDARY_ANCHOR, {registrationEnds: ZONE_BOUNDARY_INSTANT});
		mockGetElectionDetails.mockImplementation(async () => buildElectionDetails(timeline, ZONE_BOUNDARY_ANCHOR));

		const tr = await renderAndFlush();
		const range = tr.root.findByProps({testID: 'timeline-header-date-range'});
		expect(textOf(range)).toContain('January 1');
		expect(textOf(range)).not.toContain('December 31');
	});

	it('rail MM/DD label: deriveTimeline itself receives the forwarded device zone -- registrationEnds\' rail label shifts a day between America/Denver and UTC', async () => {
		const timeline = buildValidTimeline(ZONE_BOUNDARY_ANCHOR, {registrationEnds: ZONE_BOUNDARY_INSTANT});
		mockGetElectionDetails.mockImplementation(async () => buildElectionDetails(timeline, ZONE_BOUNDARY_ANCHOR));

		type Row = {stageId: string; railLabel: {kind: string; text?: string}};

		mockDeviceTimeZone('America/Denver');
		const denverTr = await renderAndFlush();
		const denverRow = (denverTr.root.findByType(TimelineRail).props.rows as Row[]).find(r => r.stageId === 'registrationEnds');

		mockDeviceTimeZone('UTC');
		const utcTr = await renderAndFlush();
		const utcRow = (utcTr.root.findByType(TimelineRail).props.rows as Row[]).find(r => r.stageId === 'registrationEnds');

		expect(denverRow?.railLabel).toEqual({kind: 'date', text: '12/31'});
		expect(utcRow?.railLabel).toEqual({kind: 'date', text: '01/01'});
	});
});

describe('TimelineScreen — rail composition and callback wiring (Task 2)', () => {
	it('TimelineRail is mounted exactly once in the ready state, zero times in the indeterminate state', async () => {
		const ready = await renderAndFlush();
		expect(ready.root.findAllByType(TimelineRail)).toHaveLength(1);

		mockGetElections.mockImplementation(async () => {
			throw new Error('boom');
		});
		const indeterminate = await renderAndFlush();
		expect(indeterminate.root.findAllByType(TimelineRail)).toHaveLength(0);
	});

	it('every callback prop TimelineRail declares is bound to a function -- none is undefined', async () => {
		const tr = await renderAndFlush();
		const rail = tr.root.findByType(TimelineRail);

		for (const propName of [
			'onHelp',
			'onSeeDetails',
			'onEditRegistration',
			'onPreviewBallot',
			'onVoteNow',
			'onViewSubmission',
			'onViewKeyholders',
		]) {
			expect(typeof rail.props[propName]).toBe('function');
		}
	});

	it.each([
		['onVoteNow', 'Ballot'],
		['onPreviewBallot', 'Ballot'],
		['onViewSubmission', 'ReviewSubmit'],
		['onEditRegistration', 'RegistrationHome'],
		['onViewKeyholders', 'Keyholders'],
	])('%s navigates to %s', async (propName, routeName) => {
		const tr = await renderAndFlush();
		const rail = tr.root.findByType(TimelineRail);

		renderer.act(() => {
			(rail.props[propName] as () => void)();
		});

		expect(mockNavigate).toHaveBeenCalledWith(routeName);
	});

	it('see-details and the row help affordance both open a dialog titled with the stage\'s translated title, and it closes on its close control', async () => {
		const tr = await renderAndFlush();
		const rail = tr.root.findByType(TimelineRail);

		renderer.act(() => {
			(rail.props.onSeeDetails as (stageId: string) => void)('votingStarts');
		});

		const dialog = tr.root.findByProps({testID: 'info-dialog'});
		expect(dialog).toBeDefined();
		expect(JSON.stringify(tr.toJSON())).toContain('Voting Period');

		const close = tr.root.findByProps({testID: 'info-dialog-close'});
		renderer.act(() => {
			close.props.onPress();
		});
		expect(tr.root.findAllByProps({testID: 'info-dialog'})).toHaveLength(0);

		// The same dialog seam serves the row `?` help affordance.
		renderer.act(() => {
			(rail.props.onHelp as (stageId: string) => void)('registrationEnds');
		});
		expect(JSON.stringify(tr.toJSON())).toContain('Registration Ends');
	});
});

// ==== Task 3: __DEV__ clock-offset control (D-05) ====

type RailRow = {stageId: string; status: string};

function currentStageId(tr: renderer.ReactTestRenderer): string | undefined {
	const rail = tr.root.findByType(TimelineRail);
	const rows = rail.props.rows as RailRow[];
	return rows.find(row => row.status === 'current')?.stageId;
}

async function pressClockOffset(tr: renderer.ReactTestRenderer) {
	const control = tr.root.findByProps({testID: 'timeline-dev-clock-offset'});
	await renderer.act(async () => {
		control.props.onPress();
		await flushMicrotasks(30);
	});
}

describe('TimelineScreen — __DEV__ clock-offset control (Task 3, D-05)', () => {
	const originalDev = (globalThis as {__DEV__?: boolean}).__DEV__;

	afterEach(() => {
		(globalThis as {__DEV__?: boolean}).__DEV__ = originalDev;
	});

	it('with __DEV__ false, no control renders and no dev-offset label appears anywhere in the tree', async () => {
		(globalThis as {__DEV__?: boolean}).__DEV__ = false;
		const tr = await renderAndFlush();
		expect(hasTestId(tr, 'timeline-dev-clock-offset')).toBe(false);
		expect(JSON.stringify(tr.toJSON())).not.toContain('DEV:');
	});

	it('with __DEV__ true, the control renders above the header, outside the rail, with a dashed colors.warning border', async () => {
		(globalThis as {__DEV__?: boolean}).__DEV__ = true;
		const tr = await renderAndFlush();

		const control = tr.root.findByProps({testID: 'timeline-dev-clock-offset'});
		const flatStyle = Object.assign({}, ...(Array.isArray(control.props.style) ? control.props.style : [control.props.style]));
		expect(flatStyle.borderStyle).toBe('dashed');
		expect(flatStyle.borderColor).toBe('#bcb600'); // colors.warning, per this file's mocked theme

		const label = tr.root.findByProps({testID: 'timeline-dev-clock-offset-label'});
		expect(textOf(label)).toContain('DEV:');
	});

	it('starts at the live position: offset 0 (label shows a zero delta) and no row is current against the far-future production fixture', async () => {
		(globalThis as {__DEV__?: boolean}).__DEV__ = true;
		const tr = await renderAndFlush();

		const label = tr.root.findByProps({testID: 'timeline-dev-clock-offset-label'});
		expect(textOf(label)).toContain('0');
		expect(currentStageId(tr)).toBeUndefined();
	});

	it('walking the full press cycle makes each of the ten stages current exactly once, collected as a SET (D-09) -- not a spot check', async () => {
		(globalThis as {__DEV__?: boolean}).__DEV__ = true;
		const tr = await renderAndFlush();

		const seen = new Set<string>();
		for (let i = 0; i < TIMELINE_STAGE_IDS.length; i++) {
			await pressClockOffset(tr);
			const id = currentStageId(tr);
			if (id) seen.add(id);
		}

		expect(seen).toEqual(new Set(TIMELINE_STAGE_IDS));
	});

	it('wraps back to the live stop after the last stage stop', async () => {
		(globalThis as {__DEV__?: boolean}).__DEV__ = true;
		const tr = await renderAndFlush();

		for (let i = 0; i < TIMELINE_STAGE_IDS.length; i++) {
			await pressClockOffset(tr);
		}
		// One more press than there are stages returns to the live stop.
		await pressClockOffset(tr);

		const label = tr.root.findByProps({testID: 'timeline-dev-clock-offset-label'});
		expect(textOf(label)).toContain('0');
		expect(textOf(label)).not.toContain('Registration Ends');
	});

	it('a 7-of-10-key timeline offers exactly 8 stops (7 stages + live) -- absent instants are skipped, never a dead stop', async () => {
		(globalThis as {__DEV__?: boolean}).__DEV__ = true;
		const anchor = Date.UTC(2030, 0, 10);
		const sevenKeyTimeline = buildValidTimeline(anchor);
		delete sevenKeyTimeline.accruingVotes;
		delete sevenKeyTimeline.hashingVotes;
		delete sevenKeyTimeline.releasingKeys;
		mockGetElectionDetails.mockImplementation(async () => buildElectionDetails(sevenKeyTimeline, anchor));

		const tr = await renderAndFlush();

		const seen = new Set<string>();
		for (let i = 0; i < 7; i++) {
			await pressClockOffset(tr);
			const id = currentStageId(tr);
			if (id) seen.add(id);
		}
		expect(seen.size).toBe(7);

		// The 8th press (index 7, zero-based) is the live stop again.
		await pressClockOffset(tr);
		const label = tr.root.findByProps({testID: 'timeline-dev-clock-offset-label'});
		expect(textOf(label)).toContain('0');
	});

	it("the label at a stage stop names that stage's translated title", async () => {
		(globalThis as {__DEV__?: boolean}).__DEV__ = true;
		const tr = await renderAndFlush();

		await pressClockOffset(tr); // first D-09 stop: registrationEnds
		const label = tr.root.findByProps({testID: 'timeline-dev-clock-offset-label'});
		expect(textOf(label)).toContain('Registration Ends');
	});

	it('never calls setLifecycleState and never imports LIFECYCLE_ORDER; HomeScreen keeps its own cycler untouched', () => {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const fs = require('fs');
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const path = require('path');

		const screenSource: string = fs.readFileSync(path.resolve(__dirname, '../TimelineScreen.tsx'), 'utf8');
		expect(screenSource).not.toContain('setLifecycleState');
		expect(screenSource).not.toContain('LIFECYCLE_ORDER');

		const homeSource: string = fs.readFileSync(path.resolve(__dirname, '../../home/HomeScreen.tsx'), 'utf8');
		expect(homeSource).toContain('nextLifecycleState');
		expect(homeSource).toContain('LIFECYCLE_ORDER');
		expect(homeSource).toContain('setLifecycleState');
	});
});

// ==== Regression: the registration-status panel must re-read on focus, not just at mount ====
//
// React Navigation keeps tab screens MOUNTED when a voter tabs away and back — leaving the
// Timeline tab and returning must NOT require a full app restart to see a fresh registration
// answer. This suite's own DECLARED BLIND SPOT (mirrors RegistrationInboxScreen.test.tsx 48-25):
// `mockTriggerFocus()` simulates a re-focus by re-invoking every `useFocusEffect` callback
// currently registered; it does not prove React Navigation actually delivers a focus event on a
// real tab switch — that is a navigation-container behavior this mock stands in for. What IS
// proven here: mounting once, changing the underlying engine's answer, and refocusing (no
// remount) makes the SAME rendered tree reflect the new answer — the exact distinction a
// fresh-mount-only test can never make.
describe('TimelineScreen — registration panel re-reads on focus (regression, stale-vs-fresh)', () => {
	beforeEach(() => {
		// `TimelineRow.tsx`'s `showPanel = !isDeemphasized && panel != null` never renders the
		// panel for a `future`-status row -- so this block needs `registrationEnds` already in the
		// PAST relative to "now" (an election 5 days out, registration having closed 20 days ago),
		// unlike every other describe block in this file which uses the 180-day-out default.
		const anchor = Date.now() + 5 * 86_400_000;
		mockGetElectionDetails.mockImplementation(async () => buildElectionDetails(buildValidTimeline(anchor), anchor));
	});

	it('renders notRegistered at mount, then pending after a simulated refocus with no remount', async () => {
		const tr = await renderAndFlush();

		const initialSentence = tr.root.findByProps({testID: 'timeline-registration-panel-sentence'});
		expect(textOf(initialSentence)).toContain('You are not registered');

		// The device just completed a real Register ceremony elsewhere -- the engine's own answer
		// has changed, but nothing has remounted this screen.
		mockListAssociationRequests.mockImplementation(async () => [
			{deviceKey: 'p256-stub-device-key', status: 'p', electionId: SEEDED_ELECTION_ID},
		]);

		await renderer.act(async () => {
			mockTriggerFocus();
			await flushMicrotasks(30);
		});

		const refocusedSentence = tr.root.findByProps({testID: 'timeline-registration-panel-sentence'});
		expect(textOf(refocusedSentence)).toContain('awaiting a decision');
		expect(textOf(refocusedSentence)).not.toContain('You are not registered');
	});

	it('a refocus with an unchanged answer does not spam the association engine (no refresh storm)', async () => {
		const tr = await renderAndFlush();
		const callsAfterMount = mockListAssociationRequests.mock.calls.length;
		expect(callsAfterMount).toBeGreaterThan(0);

		await renderer.act(async () => {
			mockTriggerFocus();
			await flushMicrotasks(30);
		});

		// Exactly one MORE read fired for the one refocus -- not zero (proves it re-ran) and not a
		// loop (proves it ran only once per refocus).
		expect(mockListAssociationRequests.mock.calls.length).toBe(callsAfterMount + 1);
		void tr;
	});
});

describe('TimelineScreen — device time-zone resolution degrades safely (WR-01)', () => {
	it('still renders the timeline when the zero-arg Intl.DateTimeFormat() throws, instead of crashing render', async () => {
		mockDeviceTimeZoneThrows();
		const tr = await renderAndFlush();
		// The rail must still be on screen. Before the fix this line is never reached: the throw
		// escapes `resolveDeviceTimeZone()` during render and takes the whole screen down.
		expect(hasTestId(tr, 'timeline-rail')).toBe(true);
	});
});
