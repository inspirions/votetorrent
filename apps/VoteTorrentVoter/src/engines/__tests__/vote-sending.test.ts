/**
 * vote-sending.test.ts — sending a saved vote (spike 102, applied). Real vote-engine pool agents,
 * a real in-process rendezvous and real P-256 consent signatures; only the strand is a fake that
 * keeps the committed blocks in memory (the SQL commit runs in vote-engine's host proof).
 */
import {p256} from '@noble/curves/nist.js';
import {secp256k1} from '@noble/curves/secp256k1.js';
import {bytesToHex} from '@noble/curves/utils.js';
import {
	PoolRendezvous,
	createInMemoryRendezvousClient,
	verifySigP256,
	type PoolRendezvousClient,
} from '@votetorrent/vote-engine/rn';
import {sendSavedVote, statusForOutcome, type BallotSendStatus, type VoteSendingPort, type VoteSentStore} from '../vote-sending';
import type {VoteRecord} from '../vote-record-vault';

const electionSecret = secp256k1.utils.randomSecretKey();
const jointPublicKey = bytesToHex(secp256k1.getPublicKey(electionSecret, true));
const ELECTION = 'election-send-1';
const REVISION = 1;
const BALLOTS = ['ballot-a', 'ballot-b'];

function clientFor(rv: PoolRendezvous, transportPeerId: string): PoolRendezvousClient {
	return createInMemoryRendezvousClient(rv, transportPeerId);
}

/** One shared fake strand: committed voter rows per (ballot, registrant). */
function fakeStrand(closesAt: number) {
	const rows = new Map<string, string>();
	const commits: Array<{ballotId: string, size: number}> = [];
	const port: VoteSendingPort = {
		readElectionKey: async () => jointPublicKey,
		readVotingClose: async () => closesAt,
		commit: async (block, ballot, signatures) => {
			for (const s of signatures) {
				if (rows.has(`${ballot.ballotId}/${s.registrantId}`)) return {ok: false, reason: 'already voted'};
			}
			for (const s of signatures) rows.set(`${ballot.ballotId}/${s.registrantId}`, block.cid);
			commits.push({ballotId: ballot.ballotId, size: signatures.length});
			return {ok: true};
		},
		findRecordedVote: async (_e, ballotId, registrantId) => rows.get(`${ballotId}/${registrantId}`) ?? null,
	};
	return {port, rows, commits};
}

function memorySentStore(): VoteSentStore & {data: Record<string, Record<string, string>>} {
	const data: Record<string, Record<string, string>> = {};
	return {
		data,
		read: async (e) => ({...(data[e] ?? {})}),
		record: async (e, _r, b, cid) => { data[e] = {...(data[e] ?? {}), [b]: cid}; },
	};
}

function makeVoter(i: number) {
	const priv = p256.utils.randomSecretKey();
	const deviceKey = bytesToHex(p256.getPublicKey(priv, true));
	const record: VoteRecord = {
		v: 1, electionId: ELECTION, electionRevision: REVISION, savedAt: new Date().toISOString(),
		votes: BALLOTS.map(ballotId => ({
			v: 1, electionId: ELECTION, electionRevision: REVISION, ballotId, templateDigest: `template-${ballotId}`,
			answers: [{questionCode: 'q1', optionCodes: [i % 2 ? 'yes' : 'no']}], nonce: bytesToHex(crypto.getRandomValues(new Uint8Array(32))),
		})),
		voter: {
			v: 1, electionId: ELECTION, electionRevision: REVISION, registrantId: `registrant-${i}`, privateCid: `private-${i}`, publicCid: null,
			deviceKey, attestationCid: null, ballots: BALLOTS.map(b => ({ballotId: b, templateDigest: `template-${b}`})), signature: 'cd'.repeat(32),
		},
	};
	return {record, priv, deviceKey, phone: `phone-${i}`};
}

const fastAgent = {quietMs: 300, presentIntervalMs: 50, replyTimeoutMs: 400, informAttempts: 2, signTimeoutMs: 2_000, memberTimeoutMs: 3_000, pollWaitMs: 200, formLeadMs: 0};

function signWith(priv: Uint8Array, probe?: {active: number, maxActive: number}) {
	return async (digest: string) => {
		if (probe) { probe.active++; probe.maxActive = Math.max(probe.maxActive, probe.active); }
		await new Promise(r => setTimeout(r, 20));
		const bytes = Uint8Array.from(atob(digest.replace(/-/g, '+').replace(/_/g, '/') + '='), c => c.charCodeAt(0));
		const sig = bytesToHex(p256.sign(bytes, priv)); // noble v2 defaults: prehash, low-S, compact — the native signer's contract
		if (probe) probe.active--;
		return sig;
	};
}

describe('sendSavedVote (spike 102)', () => {
	jest.setTimeout(30_000);

	it('three voters send both ballots: one block of three per ballot, every ballot recorded as sent', async () => {
		const rv = new PoolRendezvous();
		const strand = fakeStrand(Date.now() + 60_000);
		const voters = [0, 1, 2].map(makeVoter);
		const probes = voters.map(() => ({active: 0, maxActive: 0}));
		const stores = voters.map(() => memorySentStore());
		const statuses: Array<Array<[string, BallotSendStatus]>> = voters.map(() => []);
		const results = await Promise.all(voters.map((v, i) => sendSavedVote({
			port: strand.port, sentStore: stores[i]!, record: v.record, rendezvous: clientFor(rv, v.phone),
			signConsent: signWith(v.priv, probes[i]), nowMs: () => Date.now(), agentOptions: fastAgent,
			onStatus: (b, s) => statuses[i]!.push([b, s]),
		})));
		rv.close();
		expect(strand.commits.sort((a, b) => a.ballotId.localeCompare(b.ballotId))).toEqual([{ballotId: 'ballot-a', size: 3}, {ballotId: 'ballot-b', size: 3}]);
		for (const r of results) {
			expect(r.ok).toBe(true);
			if (r.ok) expect(r.ballots.map(b => b.status.phase)).toEqual(['sent', 'sent']);
		}
		for (const s of stores) expect(Object.keys(s.data[ELECTION] ?? {}).sort()).toEqual(BALLOTS);
		// one prompt at a time per phone, even with two ballots pooling at once
		for (const p of probes) expect(p.maxActive).toBe(1);
		// every voter saw itself confirm before it was sent
		for (const st of statuses) expect(st.some(([, s]) => s.phase === 'confirming')).toBe(true);
	});

	it('the consent signature a voter gives verifies with the schema\'s own P-256 check', async () => {
		const v = makeVoter(9);
		const digest = 'A'.repeat(43);
		const sig = await signWith(v.priv)(digest);
		expect(verifySigP256(digest, sig, v.deviceKey)).toBe(true);
	});

	it('a vote already recorded on the strand is not pooled again', async () => {
		const rv = new PoolRendezvous();
		const strand = fakeStrand(Date.now() + 60_000);
		const v = makeVoter(4);
		for (const b of BALLOTS) strand.rows.set(`${b}/${v.record.voter.registrantId}`, `cid-${b}`);
		const store = memorySentStore();
		const sign = jest.fn();
		const result = await sendSavedVote({
			port: strand.port, sentStore: store, record: v.record, rendezvous: clientFor(rv, v.phone),
			signConsent: sign, nowMs: () => Date.now(), agentOptions: fastAgent,
		});
		rv.close();
		expect(result).toEqual({ok: true, ballots: [{ballotId: 'ballot-a', status: {phase: 'sent', cid: 'cid-ballot-a'}}, {ballotId: 'ballot-b', status: {phase: 'sent', cid: 'cid-ballot-b'}}]});
		expect(sign).not.toHaveBeenCalled();
		expect(rv.stats.present).toBe(0);
		expect(store.data[ELECTION]).toEqual({'ballot-a': 'cid-ballot-a', 'ballot-b': 'cid-ballot-b'});
	});

	it('a lone voter is never sent (minimum 3): it stays not sent when voting closes', async () => {
		const rv = new PoolRendezvous();
		const strand = fakeStrand(Date.now() + 1_500);
		const v = makeVoter(5);
		const result = await sendSavedVote({
			port: strand.port, sentStore: memorySentStore(), record: v.record, rendezvous: clientFor(rv, v.phone),
			signConsent: signWith(v.priv), nowMs: () => Date.now(), agentOptions: fastAgent,
		});
		rv.close();
		expect(strand.commits).toEqual([]);
		expect(result).toEqual({ok: true, ballots: BALLOTS.map(ballotId => ({ballotId, status: {phase: 'not-sent', reason: 'voting-closed'}}))});
	});

	it('refuses before pooling when voting has closed or the election key is not published', async () => {
		const v = makeVoter(6);
		const base = {sentStore: memorySentStore(), record: v.record, rendezvous: clientFor(new PoolRendezvous(), v.phone), signConsent: jest.fn(), nowMs: () => Date.now()};
		const closed = fakeStrand(Date.now() - 1);
		expect(await sendSavedVote({...base, port: closed.port})).toEqual({ok: false, reason: 'voting-closed'});
		const noKey = fakeStrand(Date.now() + 60_000);
		expect(await sendSavedVote({...base, port: {...noKey.port, readElectionKey: async () => null}})).toEqual({ok: false, reason: 'election-key-missing'});
		expect(await sendSavedVote({...base, port: {...noKey.port, readVotingClose: async () => null}})).toEqual({ok: false, reason: 'window-unreadable'});
	});
});

// 'already-voted' reaches here only from this phone's OWN failed commit as the block's former; a
// peer's already-voted claim is a hint the agent checks and never stops on (CR-01).
describe('statusForOutcome (R1 already voted, own commit)', () => {
	const committed = {status: 'committed', cid: 'c1', blockId: 'b', size: 3, formedByMe: true} as const;
	const stopped = (reason: string) => ({status: 'stopped', reason}) as never;

	it('maps committed, deadline and aborted without re-reading the strand', async () => {
		const recheck = jest.fn(async () => 'never');
		expect(await statusForOutcome(committed, recheck)).toEqual({phase: 'sent', cid: 'c1'});
		expect(await statusForOutcome(stopped('deadline'), recheck)).toEqual({phase: 'not-sent', reason: 'voting-closed'});
		expect(await statusForOutcome(stopped('aborted'), recheck)).toEqual({phase: 'not-sent', reason: 'stopped'});
		expect(recheck).not.toHaveBeenCalled();
	});

	it('already-voted with a readable row is sent with that cid, re-read exactly once', async () => {
		const recheck = jest.fn(async () => 'cid-x');
		expect(await statusForOutcome(stopped('already-voted'), recheck)).toEqual({phase: 'sent', cid: 'cid-x'});
		expect(recheck).toHaveBeenCalledTimes(1);
	});

	it('already-voted with no readable row, or a failing read, is not-sent already-voted', async () => {
		expect(await statusForOutcome(stopped('already-voted'), async () => null)).toEqual({phase: 'not-sent', reason: 'already-voted'});
		expect(await statusForOutcome(stopped('already-voted'), async () => { throw new Error('strand down'); })).toEqual({phase: 'not-sent', reason: 'already-voted'});
	});
});
