import type {VoterBallot, VoterElection} from '../types';

/**
 * TEST-ONLY election/ballot fixtures for the manual `VoterAppProvider` mock
 * (`providers/__mocks__/VoterAppProvider.tsx`) and the screen tests that assert against it. The
 * running app never imports this module — its election and ballot come from the real engine
 * (`engines/election-read.ts`), and the dev seed publishes the same ballot content as a real
 * `ProposedBallot` (`engines/dev-seed.ts`).
 *
 * Mixed `voteFor` by design: every office is `voteFor: 1` (radio) except State Board of
 * Education (`voteFor: 2`, capped checkbox), so both CandidateSelector variants are exercised.
 */
export const FIXTURE_ELECTION: Pick<VoterElection, 'id' | 'title'> = {
	id: 'fixture-election-1',
	title: 'Utah Network General Election',
};

export const FIXTURE_BALLOT: VoterBallot = {
	electionId: FIXTURE_ELECTION.id,
	unsupportedQuestionCount: 0,
	offices: [
		{
			id: 'office-us-senate',
			title: 'U.S. Senate',
			group: 'Federal',
			voteFor: 1,
			candidates: [
				{id: 'cand-us-senate-diana', name: 'Diana Foster', party: 'Democratic Party'},
				{id: 'cand-us-senate-marcus', name: 'Marcus Whitfield', party: 'Republican Party'},
				{id: 'cand-us-senate-elena', name: 'Elena Vasquez', party: 'Independent'},
			],
		},
		{
			id: 'office-us-house',
			title: 'U.S. House of Representatives, District 2',
			group: 'Federal',
			voteFor: 1,
			candidates: [
				{id: 'cand-us-house-james', name: 'James Okafor', party: 'Democratic Party'},
				{id: 'cand-us-house-laura', name: 'Laura Bennett', party: 'Republican Party'},
			],
		},
		{
			id: 'office-governor',
			title: 'Governor',
			group: 'State (UT)',
			voteFor: 1,
			candidates: [
				{id: 'cand-governor-priya', name: 'Priya Nandan', party: 'Democratic Party'},
				{id: 'cand-governor-robert', name: 'Robert Kessler', party: 'Republican Party'},
			],
		},
		{
			id: 'office-state-board-education',
			title: 'State Board of Education',
			group: 'State (UT)',
			voteFor: 2,
			candidates: [
				{id: 'cand-sboe-angela', name: 'Angela Torres', party: 'Nonpartisan'},
				{id: 'cand-sboe-brian', name: 'Brian Michaels', party: 'Nonpartisan'},
				{id: 'cand-sboe-cynthia', name: 'Cynthia Park', party: 'Nonpartisan'},
				{id: 'cand-sboe-david', name: 'David Nguyen', party: 'Nonpartisan'},
			],
		},
		{
			id: 'office-state-senate',
			title: 'State Senate, District 8',
			group: 'State (UT)',
			voteFor: 1,
			candidates: [
				{id: 'cand-state-senate-maria', name: 'Maria Gutierrez', party: 'Democratic Party'},
				{id: 'cand-state-senate-thomas', name: 'Thomas Reyes', party: 'Republican Party'},
			],
		},
	],
};
