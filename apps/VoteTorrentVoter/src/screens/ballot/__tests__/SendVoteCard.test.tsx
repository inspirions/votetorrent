/**
 * SendVoteCard (spike 102): the receipt's "Send your vote" card shows each ballot's pooling status
 * as the send flow reports it, says when everything is sent, maps every refusal to plain copy, and
 * never shows raw error text.
 */
import React from 'react';
import renderer from 'react-test-renderer';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {NavigationContainer} from '@react-navigation/native';
jest.mock('../../../providers/VoterAppProvider');
jest.mock('@votetorrent/attestation-native', () => ({}));
jest.mock('../../../engines/vote-send-flow', () => ({runVoteSendFlow: jest.fn()}));
import {VoterAppProvider} from '../../../providers/VoterAppProvider';
import {runVoteSendFlow} from '../../../engines/vote-send-flow';
import {recordVoteSent} from '../../../engines/vote-sent-store';
import SendVoteCard from '../SendVoteCard';
import {lightTheme} from '../../../theme/themes';
import i18n from '../../../i18n';

let tr: renderer.ReactTestRenderer | null = null;
const onAllSent = jest.fn();

async function flush() {
	for (let i = 0; i < 6; i++) {
		await renderer.act(async () => { await new Promise<void>(r => setTimeout(r, 0)); });
	}
}
async function mount(ballotIds = ['b1', 'b2']) {
	await renderer.act(async () => {
		tr = renderer.create(
			<NavigationContainer theme={lightTheme}>
				<VoterAppProvider>
					<SendVoteCard electionId="e1" electionRevision={1} envelope={{} as never} ballotIds={ballotIds} onAllSentChange={onAllSent} />
				</VoterAppProvider>
			</NavigationContainer>,
		);
	});
	await flush();
}
const hosts = (id: string) => tr!.root.findAll(n => typeof n.type === 'string' && n.props.testID === id);
const textOf = (n: renderer.ReactTestInstance | string): string => (typeof n === 'string' ? n : n.children.map(c => textOf(c as renderer.ReactTestInstance)).join(''));
const text = (id: string) => textOf(hosts(id)[0]!);
async function press(id: string) {
	const node = tr!.root.findAllByProps({testID: id}).find(n => typeof n.props.onPress === 'function');
	await renderer.act(async () => { node!.props.onPress(); });
	await flush();
}

beforeEach(async () => {
	await AsyncStorage.clear();
	await i18n.changeLanguage('en');
	jest.clearAllMocks();
});
afterEach(() => { renderer.act(() => tr?.unmount()); tr = null; });

describe('SendVoteCard', () => {
	it('shows each ballot\'s status as the flow reports it, then "sent"', async () => {
		(runVoteSendFlow as jest.Mock).mockImplementation(async (deps: {onStatus: (b: string, s: unknown) => void}) => {
			deps.onStatus('b1', {phase: 'waiting', size: 2});
			deps.onStatus('b2', {phase: 'confirming'});
			return {kind: 'done', ballots: [{ballotId: 'b1', status: {phase: 'sent', cid: 'c1'}}, {ballotId: 'b2', status: {phase: 'sent', cid: 'c2'}}]};
		});
		await mount();
		expect(hosts('send-all-sent')).toHaveLength(0);
		await press('send-vote');
		expect(text('send-all-sent')).toBe('Your vote has been sent to the election.');
		expect(text('send-ballot-0')).toBe('Ballot 1: Sent to the election.');
		expect(hosts('send-vote')).toHaveLength(0);
		expect(onAllSent).toHaveBeenLastCalledWith(true);
	});

	it('a ballot whose pool never filled says so and offers a retry', async () => {
		(runVoteSendFlow as jest.Mock).mockResolvedValue({kind: 'done', ballots: [{ballotId: 'b1', status: {phase: 'not-sent', reason: 'voting-closed'}}]});
		await mount(['b1']);
		await press('send-vote');
		expect(text('send-ballot-0')).toContain('Not sent: voting closed before enough voters were ready');
		expect(textOf(tr!.root.findAllByProps({testID: 'send-vote'}).find(n => typeof n.type === 'string')!)).toBe('Try again');
		expect(onAllSent).toHaveBeenLastCalledWith(false);
	});

	it('maps refusals to plain copy, never raw text', async () => {
		for (const [kind, copy] of [
			['no-network', "This phone isn't connected to an election network yet"],
			['canceled', 'Sending was cancelled'],
			['failed', "We couldn't send your vote"],
			['rendezvous-unreachable', "We couldn't send your vote"],
		] as const) {
			(runVoteSendFlow as jest.Mock).mockResolvedValueOnce({kind});
			await mount(['b1']);
			await press('send-vote');
			expect(text('send-outcome')).toContain(copy);
			renderer.act(() => tr?.unmount());
		}
		(runVoteSendFlow as jest.Mock).mockRejectedValueOnce(new Error('StreamStateError: raw internals'));
		await mount(['b1']);
		await press('send-vote');
		expect(text('send-outcome')).not.toContain('StreamStateError');
	});

	it('already-sent ballots read as sent on open, without pressing anything', async () => {
		await recordVoteSent('e1', 1, 'b1', 'cid-1');
		await mount(['b1']);
		expect(text('send-all-sent')).toBe('Your vote has been sent to the election.');
		expect(runVoteSendFlow).not.toHaveBeenCalled();
	});
});
