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

const mockNavigate = jest.fn();

jest.mock('@react-navigation/native', () => ({
	useNavigation: () => ({navigate: mockNavigate}),
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
			bold: {fontFamily: 'System', fontWeight: '700'},
		},
		type: {
			display: {fontSize: 40, lineHeight: 48},
			h2: {fontSize: 28, lineHeight: 34},
			h4: {fontSize: 20, lineHeight: 26},
			body: {fontSize: 16, lineHeight: 22},
			caption: {fontSize: 16, lineHeight: 20},
		},
		radii: {pill: 999},
	}),
}));

// ---- Production-length fixtures (59-UI-SPEC.md, no hand-picked short strings) ----

const PRODUCTION_ELECTION_TITLE = 'Salt Lake County School Board Special Election 2025'; // 53 chars

const SEEDED_ELECTION_ID = 'election-1';

// dev-seed.ts:216-248's own relative shape, extended to ten (59-01) — 180 days out, offsets in
// days/hours from that anchor. Deliberately NOT a hand-picked absolute date set.
const ELECTION_DATE = Date.now() + 180 * 86_400_000;

function buildValidTimeline(overrides: Partial<Record<string, number>> = {}): Record<string, number> {
	return {
		registrationEnds: ELECTION_DATE - 25 * 86_400_000,
		ballotsFinal: ELECTION_DATE - 14 * 86_400_000,
		votingStarts: ELECTION_DATE - 2 * 86_400_000,
		accruingVotes: ELECTION_DATE - 20 * 3_600_000,
		hashingVotes: ELECTION_DATE - 16 * 3_600_000,
		releasingKeys: ELECTION_DATE - 12 * 3_600_000,
		tallyingStarts: ELECTION_DATE,
		validation: ELECTION_DATE + 86_400_000,
		certificationStarts: ELECTION_DATE + 2 * 86_400_000,
		closed: ELECTION_DATE + 3 * 86_400_000,
		...overrides,
	};
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildElectionDetails(timeline: Record<string, number> = buildValidTimeline()): any {
	return {
		election: {
			id: SEEDED_ELECTION_ID,
			authorityId: 'authority-1',
			title: PRODUCTION_ELECTION_TITLE,
			date: ELECTION_DATE,
			revisionDeadline: ELECTION_DATE - 30 * 86_400_000,
			ballotDeadline: ELECTION_DATE - 7 * 86_400_000,
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

const mockGetEngine = jest.fn(async (engineName: string) => {
	if (engineName === 'elections') {
		return mockElectionsEngine;
	}
	throw new Error(`unexpected getEngine call: ${engineName}`);
});

const mockGetElection = jest.fn(async () => {
	throw new Error('getElection() must never be called by TimelineScreen (D-04 read-scope fence)');
});

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

beforeEach(() => {
	mockNavigate.mockClear();
	mockGetEngine.mockClear();
	mockGetElection.mockClear();
	mockGetElections.mockClear();
	mockOpenElection.mockClear();
	mockGetElectionDetails.mockClear();

	mockGetEngine.mockImplementation(async (engineName: string) => {
		if (engineName === 'elections') {
			return mockElectionsEngine;
		}
		throw new Error(`unexpected getEngine call: ${engineName}`);
	});
	mockGetElections.mockImplementation(async () => [SUMMARY_A]);
	mockOpenElection.mockImplementation(async (_id: string) => mockElectionEngine);
	mockGetElectionDetails.mockImplementation(async () => buildElectionDetails());

	mockSeededElectionId = SEEDED_ELECTION_ID;
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

		expect(mockGetEngine).toHaveBeenCalledTimes(1);
		expect(mockGetEngine).toHaveBeenCalledWith('elections');
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
