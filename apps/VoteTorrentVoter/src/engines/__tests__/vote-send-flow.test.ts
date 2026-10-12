/**
 * vote-send-flow.test.ts — the Send button's wiring (spike 102): it refuses before any prompt when
 * the phone has no network or no rendezvous, opens the sealed record once, signs consent with the
 * voting key through the producer, dials the FIRST joined address, and maps every failure to a
 * closed kind.
 */
jest.mock('@votetorrent/attestation-native', () => ({}));
jest.mock('../vote-receipt', () => ({revealVoteReceipt: jest.fn()}));
jest.mock('@votetorrent/vote-engine/rn', () => ({createLibp2pRendezvousClient: jest.fn(() => ({call: jest.fn()}))}));
jest.mock('../vote-sending', () => ({sendSavedVote: jest.fn()}));
jest.mock('../vote-casting', () => ({digestBytesFromBase64Url: jest.fn(() => new Uint8Array(32).fill(7))}));
jest.mock('../attestation-producer', () => ({resolveVoteSigningProducer: jest.fn((p: unknown) => p)}));

import {revealVoteReceipt} from '../vote-receipt';
import {createLibp2pRendezvousClient} from '@votetorrent/vote-engine/rn';
import {sendSavedVote} from '../vote-sending';
import {runVoteSendFlow} from '../vote-send-flow';
import type {VoteSendFlowDeps} from '../vote-send-flow';

const prompt = {title: 't', subtitle: 's', negativeButton: 'n'};
const control = {dialProtocol: jest.fn(), handle: jest.fn()};
const record = {v: 1, electionId: 'e1', electionRevision: 1, savedAt: '', votes: [], voter: {}};

function deps(over: Partial<VoteSendFlowDeps> = {}): VoteSendFlowDeps {
	return {
		electionId: 'e1',
		envelope: {} as never,
		getEngine: jest.fn(async () => ({port: true})) as never,
		node: {getControlNode: () => control},
		recordPrompt: prompt,
		consentPrompt: {...prompt, title: 'consent'},
		nowMs: () => 1,
		producer: {signDeviceKeyDigest: jest.fn(async () => ({signature: 'sig-hex', signerKey: 'k'}))} as never,
		readRendezvousAddrs: async () => ['/ip4/1.2.3.4/tcp/1/ws/p2p/first', '/ip4/5.6.7.8/tcp/1/ws/p2p/second'],
		toDialTarget: (a) => `dial:${a}`,
		...over,
	};
}

beforeEach(() => {
	jest.clearAllMocks();
	(revealVoteReceipt as jest.Mock).mockResolvedValue({kind: 'ok', record});
	(sendSavedVote as jest.Mock).mockResolvedValue({ok: true, ballots: [{ballotId: 'b1', status: {phase: 'sent', cid: 'c1'}}]});
});

describe('runVoteSendFlow (spike 102)', () => {
	it('opens the record once, dials the first joined address and returns the ballots', async () => {
		const d = deps();
		expect(await runVoteSendFlow(d)).toEqual({kind: 'done', ballots: [{ballotId: 'b1', status: {phase: 'sent', cid: 'c1'}}]});
		expect(revealVoteReceipt).toHaveBeenCalledTimes(1);
		expect(revealVoteReceipt).toHaveBeenCalledWith('e1', d.envelope, prompt);
		expect(createLibp2pRendezvousClient).toHaveBeenCalledWith(control, 'dial:/ip4/1.2.3.4/tcp/1/ws/p2p/first');
		expect((sendSavedVote as jest.Mock).mock.calls[0][0].record).toBe(record);
	});

	it('signs consent with the voting key and the consent prompt', async () => {
		const d = deps();
		await runVoteSendFlow(d);
		const signConsent = (sendSavedVote as jest.Mock).mock.calls[0][0].signConsent as (digest: string) => Promise<string>;
		expect(await signConsent('A'.repeat(43))).toBe('sig-hex');
		expect((d.producer as unknown as {signDeviceKeyDigest: jest.Mock}).signDeviceKeyDigest).toHaveBeenCalledWith(expect.any(Uint8Array), {prompt: d.consentPrompt});
	});

	it('refuses before any prompt with no network or no rendezvous', async () => {
		expect(await runVoteSendFlow(deps({node: null}))).toEqual({kind: 'no-network'});
		expect(await runVoteSendFlow(deps({node: {getControlNode: () => null}}))).toEqual({kind: 'no-network'});
		expect(await runVoteSendFlow(deps({readRendezvousAddrs: async () => []}))).toEqual({kind: 'no-rendezvous'});
		expect(revealVoteReceipt).not.toHaveBeenCalled();
	});

	it('maps a cancelled record prompt, a send refusal and a throw to closed kinds', async () => {
		(revealVoteReceipt as jest.Mock).mockResolvedValueOnce({kind: 'canceled'});
		expect(await runVoteSendFlow(deps())).toEqual({kind: 'canceled'});
		expect(sendSavedVote).not.toHaveBeenCalled();
		(sendSavedVote as jest.Mock).mockResolvedValueOnce({ok: false, reason: 'voting-closed'});
		expect(await runVoteSendFlow(deps())).toEqual({kind: 'voting-closed'});
		(sendSavedVote as jest.Mock).mockRejectedValueOnce(new Error('boom: raw'));
		expect(await runVoteSendFlow(deps())).toEqual({kind: 'failed'});
	});
});
