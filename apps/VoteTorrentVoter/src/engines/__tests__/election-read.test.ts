/**
 * election-read.ts — the voter's real election/ballot read (replacing the in-memory mockData
 * fixture). The engine chain is stubbed at the `getEngine('elections')` boundary; everything past
 * it (election pick, timeline derivation, ballot flattening, the confirmed-only filter) is real.
 */
import type {Ballot, Question} from '@votetorrent/vote-core';
import {NoElectionError, readVoterBallot, readVoterElection, toVoterBallot} from '../election-read';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// Relative offsets mirror dev-seed.ts's own timeline, so the fixture is a shape the app really sees.
const D = Date.UTC(2031, 0, 15, 12);
const TIMELINE = {
	registrationEnds: D - 52 * DAY,
	ballotsFinal: D - 40 * DAY,
	votingStarts: D - 31 * DAY,
	accruingVotes: D - 20 * HOUR,
	hashingVotes: D - 16 * HOUR,
	releasingKeys: D - 12 * HOUR,
	tallyingStarts: D,
	validation: D + DAY,
	certificationStarts: D + 2 * DAY,
	closed: D + 3 * DAY,
};

interface FakeOptions {
	summaries?: Array<{id: string; date: number}>;
	timeline?: unknown;
	keyholders?: unknown[];
	ballots?: Array<{ballot: Ballot; confirmed: boolean}>;
	/** Serves the vault-less 'keyRelease' engine; when omitted, getEngine('keyRelease') THROWS like any unknown name. */
	keyRelease?: {getKeyReleaseStatus: (electionId: string) => Promise<unknown>};
}

function fakeDeps(options: FakeOptions = {}, fallbackElectionId?: string) {
	const ballots = options.ballots ?? [];
	const opened: string[] = [];
	const electionEngine = {
		getElectionDetails: async () => ({
			election: {id: 'e-1', authorityId: 'a-1', title: 'Real Election', date: D, revisionDeadline: D - 30 * DAY, ballotDeadline: D - 7 * DAY, type: 'a'},
			current: {timeline: options.timeline ?? TIMELINE, keyholders: options.keyholders ?? []},
		}),
		getBallots: async () => ballots.map(({ballot}) => ({id: ballot.id, electionId: ballot.electionId, authorityId: ballot.authorityId})),
		getBallotConfirmationState: async (id: string) => ({locked: false, confirmed: ballots.find(b => b.ballot.id === id)!.confirmed}),
		getBallotDetails: async (id: string) => ({ballot: ballots.find(b => b.ballot.id === id)!.ballot}),
	};
	const electionsEngine = {
		getElections: async () => (options.summaries ?? [{id: 'e-1', date: D}]).map(s => ({...s, title: 't', authorityName: 'a', type: 'a'})),
		openElection: async (id: string) => {
			opened.push(id);
			return electionEngine;
		},
	};
	const getEngine = async <T,>(name: string): Promise<T> => {
		if (name === 'keyRelease' && options.keyRelease) return options.keyRelease as unknown as T;
		if (name !== 'elections') throw new Error(`unexpected engine ${name}`);
		return electionsEngine as unknown as T;
	};
	return {deps: {getEngine, fallbackElectionId}, opened};
}

function question(code: string, overrides: Partial<Question> = {}): Question {
	return {
		code,
		title: `Title ${code}`,
		instructions: '',
		type: 'select',
		options: [
			{code: 'x', title: `${code} X`, details: 'Party X'},
			{code: 'y', title: `${code} Y`},
		],
		...overrides,
	};
}

function ballot(id: string, questions: Question[]): Ballot {
	return {id, electionId: 'e-1', authorityId: 'a-1', description: '', districts: [], questions};
}

describe('readVoterElection — lifecycle state derived from the real timeline', () => {
	it.each([
		['before voting opens', 'Upcoming', D - 60 * DAY, TIMELINE.votingStarts],
		['during voting', 'Open', D - 10 * DAY, TIMELINE.accruingVotes],
		['once voting closes (accruingVotes)', 'ReleasingKeys', D - 18 * HOUR, TIMELINE.tallyingStarts],
		['while keys release', 'ReleasingKeys', D - 6 * HOUR, TIMELINE.tallyingStarts],
		['during tallying/validation/certification', 'Validation', D + 2.5 * DAY, TIMELINE.closed],
	] as const)('%s -> %s, counting down to the event that ends it', async (_label, state, now, endMs) => {
		const election = await readVoterElection(fakeDeps().deps, now);
		expect(election.lifecycleState).toBe(state);
		expect(election.countdownTarget).toBe(new Date(endMs).toISOString());
	});

	it('after close -> Complete, with no countdown', async () => {
		const election = await readVoterElection(fakeDeps().deps, D + 4 * DAY);
		expect(election.lifecycleState).toBe('Complete');
		expect(election.countdownTarget).toBeUndefined();
	});

	it('carries the real id and title, and NEVER fills a field with no engine source', async () => {
		const election = await readVoterElection(fakeDeps({keyholders: [{}, {}, {}]}).deps, D - 6 * HOUR);
		expect(election).toMatchObject({id: 'e-1', title: 'Real Election', keysTotal: 3});
		// No keyRelease engine is served here, so keysReleased is absent too (the read failed).
		for (const unsourced of ['progress', 'keysReleased', 'checksComplete', 'checksTotal', 'fingerprint', 'certified', 'evidence']) {
			expect(election).not.toHaveProperty(unsourced);
		}
	});

	it('omits keysTotal when the election has no keyholders', async () => {
		expect(await readVoterElection(fakeDeps().deps, D - 60 * DAY)).not.toHaveProperty('keysTotal');
	});

	it('rejects on an indeterminate timeline rather than guessing a state', async () => {
		await expect(readVoterElection(fakeDeps({timeline: {}}).deps, D)).rejects.toThrow(/indeterminate timeline/);
	});

	it('rejects with NoElectionError when the network lists no election and there is no fallback', async () => {
		await expect(readVoterElection(fakeDeps({summaries: []}).deps, D)).rejects.toBeInstanceOf(NoElectionError);
	});

	it('opens the fallback (dev-seeded) election when the network lists none', async () => {
		const {deps, opened} = fakeDeps({summaries: []}, 'seeded-1');
		await readVoterElection(deps, D - 60 * DAY);
		expect(opened).toEqual(['seeded-1']);
	});
});

describe('readVoterElection — keysReleased from the release engine (62-29, D-17)', () => {
	const KEY = {jointPublicKey: '02aa'};
	const status = (overrides: Record<string, unknown>) => ({phase: 'releasing', releasedCount: 3, rejectedReleases: [], electionKey: KEY, ...overrides});
	const stub = (value: unknown) => {
		const getKeyReleaseStatus = jest.fn(async (_electionId: string) => value);
		return {getKeyReleaseStatus};
	};
	const FIVE = [{}, {}, {}, {}, {}];

	it('V1: fills keysReleased with the ACCEPTED count only (never counting a rejected row) in ReleasingKeys', async () => {
		const keyRelease = stub(status({releasedCount: 3, rejectedReleases: [{userId: 'u-9', reason: 'share-invalid'}]}));
		const election = await readVoterElection(fakeDeps({keyholders: FIVE, keyRelease}).deps, D - 6 * HOUR);
		expect(election.lifecycleState).toBe('ReleasingKeys');
		expect(election.keysReleased).toBe(3);
		expect(election.keysTotal).toBe(5);
		expect(keyRelease.getKeyReleaseStatus).toHaveBeenCalledWith('e-1');
	});

	it.each([
		['Validation', D + 2.5 * DAY],
		['Complete', D + 4 * DAY],
	] as const)('V2: phase reconstructable fills keysReleased in the %s state', async (state, now) => {
		const keyRelease = stub(status({phase: 'reconstructable', releasedCount: 4}));
		const election = await readVoterElection(fakeDeps({keyholders: FIVE, keyRelease}).deps, now);
		expect(election.lifecycleState).toBe(state);
		expect(election.keysReleased).toBe(4);
	});

	it.each(['no-election-key', 'election-key-inconsistent', 'no-current-revision'] as const)('V3: phase %s leaves keysReleased absent', async phase => {
		const keyRelease = stub(status({phase, releasedCount: 0, electionKey: phase === 'election-key-inconsistent' ? KEY : null}));
		const election = await readVoterElection(fakeDeps({keyholders: FIVE, keyRelease}).deps, D - 6 * HOUR);
		expect(election).not.toHaveProperty('keysReleased');
	});

	it('V3b: a null electionKey leaves keysReleased absent even in a measurable phase', async () => {
		const keyRelease = stub(status({phase: 'releasing', electionKey: null}));
		expect(await readVoterElection(fakeDeps({keyholders: FIVE, keyRelease}).deps, D - 6 * HOUR)).not.toHaveProperty('keysReleased');
	});

	it('V4: a throwing getEngine or a rejecting status read leaves keysReleased absent and the election still resolves', async () => {
		const withoutEngine = await readVoterElection(fakeDeps({keyholders: FIVE}).deps, D - 6 * HOUR);
		expect(withoutEngine).toMatchObject({id: 'e-1', keysTotal: 5});
		expect(withoutEngine).not.toHaveProperty('keysReleased');

		const rejecting = {getKeyReleaseStatus: jest.fn(async () => {
			throw new Error('read failed');
		})};
		const election = await readVoterElection(fakeDeps({keyholders: FIVE, keyRelease: rejecting}).deps, D - 6 * HOUR);
		expect(election).toMatchObject({id: 'e-1', keysTotal: 5});
		expect(election).not.toHaveProperty('keysReleased');
		expect(rejecting.getKeyReleaseStatus).toHaveBeenCalled();
	});

	it.each([
		['Upcoming', D - 60 * DAY],
		['Open', D - 10 * DAY],
	] as const)('V5: the %s state never calls getKeyReleaseStatus and has no keysReleased', async (state, now) => {
		const keyRelease = stub(status({}));
		const election = await readVoterElection(fakeDeps({keyholders: FIVE, keyRelease}).deps, now);
		expect(election.lifecycleState).toBe(state);
		expect(keyRelease.getKeyReleaseStatus).not.toHaveBeenCalled();
		expect(election).not.toHaveProperty('keysReleased');
	});
});

describe('toVoterBallot — authority ballot -> voter offices', () => {
	it('maps a select question to an office with literal text, voteFor from optionRange.max, and optional party', () => {
		const result = toVoterBallot('e-1', [ballot('b-1', [question('q1', {optionRange: {min: 1, max: 2}, group: 'Federal'})])]);
		expect(result).toEqual({
			electionId: 'e-1',
			unsupportedQuestionCount: 0,
			offices: [
				{
					id: 'b-1:q1',
					ballotId: 'b-1',
					questionCode: 'q1',
					title: 'Title q1',
					group: 'Federal',
					voteFor: 2,
					required: true,
					hasDependsOn: false,
					candidates: [
						{id: 'b-1:q1:x', optionCode: 'x', name: 'q1 X', party: 'Party X'},
						{id: 'b-1:q1:y', optionCode: 'y', name: 'q1 Y'},
					],
				},
			],
		});
	});

	it('defaults voteFor to 1 and treats an absent type as select', () => {
		const q = question('q1');
		delete (q as Partial<Question>).type;
		expect(toVoterBallot('e-1', [ballot('b-1', [q])]).offices[0].voteFor).toBe(1);
	});

	it('counts rank/score/text questions as unsupported instead of rendering or silently dropping them', () => {
		const result = toVoterBallot('e-1', [
			ballot('b-1', [question('q1'), question('q2', {type: 'rank'}), question('q3', {type: 'text'})]),
		]);
		expect(result.offices.map(o => o.id)).toEqual(['b-1:q1']);
		expect(result.unsupportedQuestionCount).toBe(2);
	});

	it('orders by group first appearance, then sequence, then declaration order — so sections stay contiguous', () => {
		const result = toVoterBallot('e-1', [
			ballot('b-1', [
				question('s2', {group: 'State', sequence: 2}),
				question('f1', {group: 'Federal'}),
				question('s1', {group: 'State', sequence: 1}),
				question('f0', {group: 'Federal'}),
			]),
		]);
		expect(result.offices.map(o => o.id)).toEqual(['b-1:s1', 'b-1:s2', 'b-1:f1', 'b-1:f0']);
	});

	it('flattens several ballots in id order with ids unique across ballots', () => {
		const result = toVoterBallot('e-1', [ballot('b-2', [question('q')]), ballot('b-1', [question('q')])]);
		expect(result.offices.map(o => o.id)).toEqual(['b-1:q', 'b-2:q']);
	});
});

describe('toVoterBallot — structured codes for the vote builders (D-04, D-05, spike 096 finding 6)', () => {
	const requiredOf = (q: Question) => toVoterBallot('e-1', [ballot('b-1', [q])]).offices[0].required;

	it('S2: an absent required flag reads as required; true is required; false is optional (D-04)', () => {
		expect(requiredOf(question('q1'))).toBe(true);
		expect(requiredOf(question('q1', {required: true}))).toBe(true);
		expect(requiredOf(question('q1', {required: false}))).toBe(false);
	});

	it('S3: dependsOn present is detected; absent or null is not (R-2)', () => {
		const has = (q: Question) => toVoterBallot('e-1', [ballot('b-1', [q])]).offices[0].hasDependsOn;
		expect(has(question('q1', {dependsOn: {code: 'q0'}}))).toBe(true);
		expect(has(question('q1'))).toBe(false);
		expect(has(question('q1', {dependsOn: null as unknown as Question['dependsOn']}))).toBe(false);
	});

	it('S4: codes containing the id separator survive; nothing is recovered by splitting', () => {
		const result = toVoterBallot('e-1', [ballot('b:1', [question('q:2', {options: [{code: 'o:3', title: 'O'}]})])]);
		const office = result.offices[0];
		expect(office.id).toBe('b:1:q:2');
		expect(office.ballotId).toBe('b:1');
		expect(office.questionCode).toBe('q:2');
		expect(office.candidates[0].id).toBe('b:1:q:2:o:3');
		expect(office.candidates[0].optionCode).toBe('o:3');
	});

	it('S5: the structured fields are independent of the question read order (proposal vs Code order)', () => {
		const make = (code: string) => question(code, {
			required: code !== 'governor',
			dependsOn: code === 'us-house' ? {code: 'governor'} : undefined,
			options: [{code: `${code}-a`, title: 'A'}, {code: `${code}-b`, title: 'B'}],
		});
		const byCode = (codes: string[]) => new Map(
			toVoterBallot('e-1', [ballot('b-1', codes.map(make))]).offices.map(o => [
				o.questionCode,
				{ballotId: o.ballotId, required: o.required, hasDependsOn: o.hasDependsOn, optionCodes: o.candidates.map(c => c.optionCode)},
			])
		);
		const proposal = byCode(['us-senate', 'us-house', 'governor']);
		const codeOrder = byCode(['governor', 'us-house', 'us-senate']);
		expect(proposal).toEqual(codeOrder);
		expect(proposal.get('governor')).toEqual({ballotId: 'b-1', required: false, hasDependsOn: false, optionCodes: ['governor-a', 'governor-b']});
		expect(proposal.get('us-house')?.hasDependsOn).toBe(true);
	});
});

describe('readVoterBallot — only officer-confirmed ballots reach a voter', () => {
	const ballots = [
		{ballot: ballot('confirmed', [question('c')]), confirmed: true},
		{ballot: ballot('proposed', [question('p')]), confirmed: false},
	];

	it('excludes proposed-but-unconfirmed ballots by default', async () => {
		const result = await readVoterBallot(fakeDeps({ballots}).deps, {includeProposed: false});
		expect(result.offices.map(o => o.id)).toEqual(['confirmed:c']);
	});

	it('admits proposed ballots only when asked (the __DEV__ path)', async () => {
		const result = await readVoterBallot(fakeDeps({ballots}).deps, {includeProposed: true});
		expect(result.offices.map(o => o.id)).toEqual(['confirmed:c', 'proposed:p']);
	});

	it('returns an empty ballot (not a rejection) when the election has none', async () => {
		expect((await readVoterBallot(fakeDeps().deps, {includeProposed: false})).offices).toEqual([]);
	});
});
