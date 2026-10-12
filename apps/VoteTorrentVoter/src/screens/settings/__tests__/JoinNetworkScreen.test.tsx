/**
 * JoinNetworkScreen (spike 100): paste a join code, check the network's fingerprint, join.
 *
 * The provider is mocked (its `joinNetwork` is the seam); the join code is a REAL one, encoded by
 * vote-engine's `encodeNetworkJoinCode`, so the screen's decode path is the shipped one.
 */
import React from 'react';
import renderer from 'react-test-renderer';
import {Text} from 'react-native';
import {ThemeProvider} from '@react-navigation/native';
import '../../../i18n';
import {encodeNetworkJoinCode} from '@votetorrent/vote-engine/rn';
import type {NetworkJoinCode, NetworkJoinResult} from '@votetorrent/vote-engine/rn';
import {lightTheme} from '../../../theme/themes';

const mockJoinNetwork = jest.fn();
jest.mock('../../../providers/VoterAppProvider', () => ({
	useVoterApp: () => ({joinNetwork: (...args: unknown[]) => mockJoinNetwork(...args)}),
}));
const mockGoBack = jest.fn();
jest.mock('@react-navigation/native', () => ({
	...jest.requireActual('@react-navigation/native'),
	useNavigation: () => ({goBack: mockGoBack}),
}));

import JoinNetworkScreen, {joinFailureKey} from '../JoinNetworkScreen';

const CODE: NetworkJoinCode = {
	v: 1,
	invitation: 'eyJ2IjoxfQ',
	networkHash: 'a1b2c3d4e5f60718',
	name: 'Utah County Elections',
	genesis: {userId: 'u', signerKey: 'k', authorityId: 'a', adminEffectiveAt: '2026-10-12T10:00:00'},
	// base64url of bytes 17 b0 65 08 2f d5 aa b2 … → fingerprint "17b0 6508 2fd5 aab2"
	digest: 'F7BlCC_VqrIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
};
const CODE_TEXT = encodeNetworkJoinCode(CODE);
const NET_REF = {hash: CODE.networkHash, relays: [], name: CODE.name, primaryAuthorityDomainName: 'example.org'};

function render() {
	let tr!: renderer.ReactTestRenderer;
	renderer.act(() => {
		tr = renderer.create(
			<ThemeProvider value={lightTheme}>
				<JoinNetworkScreen />
			</ThemeProvider>,
		);
	});
	return tr;
}
const byId = (tr: renderer.ReactTestRenderer, id: string) => tr.root.find(node => node.props.testID === id);
const hasId = (tr: renderer.ReactTestRenderer, id: string) => tr.root.findAll(node => node.props.testID === id).length > 0;
const textOf = (tr: renderer.ReactTestRenderer) =>
	tr.root
		.findAllByType(Text)
		.map(node => (Array.isArray(node.props.children) ? node.props.children.join('') : String(node.props.children ?? '')))
		.join(' | ');
function type(tr: renderer.ReactTestRenderer, value: string) {
	renderer.act(() => {
		byId(tr, 'join-network-code-input').props.onChangeText(value);
	});
}
async function pressJoin(tr: renderer.ReactTestRenderer) {
	await renderer.act(async () => {
		await byId(tr, 'join-network-submit').props.onPress();
	});
}

beforeEach(() => {
	mockJoinNetwork.mockReset();
	mockGoBack.mockReset();
});

describe('JoinNetworkScreen', () => {
	it('starts with the Join button disabled and no preview', () => {
		const tr = render();
		expect(byId(tr, 'join-network-submit').props.disabled).toBe(true);
		expect(hasId(tr, 'join-network-preview')).toBe(false);
	});

	it('a pasted code shows the network name and fingerprint to compare, and enables Join', () => {
		const tr = render();
		type(tr, `  ${CODE_TEXT}\n`);
		expect(byId(tr, 'join-network-preview-name').props.children).toBe('Utah County Elections');
		expect(byId(tr, 'join-network-preview-fingerprint').props.children).toBe('17b0 6508 2fd5 aab2');
		expect(textOf(tr)).toContain('matches the one your election authority published');
		expect(byId(tr, 'join-network-submit').props.disabled).toBe(false);
	});

	it('text that is not a join code shows the invalid-code copy and keeps Join disabled', () => {
		const tr = render();
		type(tr, 'vtjoin1.not-really');
		expect(byId(tr, 'join-network-code-error').props.children).toContain("isn't a valid join code");
		expect(byId(tr, 'join-network-submit').props.disabled).toBe(true);
	});

	it('Join runs the provider join with the decoded code and shows the joined state; Done goes back', async () => {
		mockJoinNetwork.mockImplementation(async (_code: NetworkJoinCode, onStep: (s: string) => void): Promise<NetworkJoinResult> => {
			onStep('syncing');
			return {ok: true, outcome: 'joined', admittedVia: 'redeemed', networkRef: NET_REF, fingerprint: '17b0 6508 2fd5 aab2'};
		});
		const tr = render();
		type(tr, CODE_TEXT);
		await pressJoin(tr);
		expect(mockJoinNetwork).toHaveBeenCalledWith(CODE, expect.any(Function));
		expect(byId(tr, 'join-network-joined').props.children).toBe('You joined Utah County Elections');
		renderer.act(() => {
			byId(tr, 'join-network-done').props.onPress();
		});
		expect(mockGoBack).toHaveBeenCalled();
	});

	it('shows the current step while joining', async () => {
		let release!: (r: NetworkJoinResult) => void;
		mockJoinNetwork.mockImplementation((_code: NetworkJoinCode, onStep: (s: string) => void) => {
			onStep('verifying');
			return new Promise(resolve => {
				release = resolve;
			});
		});
		const tr = render();
		type(tr, CODE_TEXT);
		renderer.act(() => {
			void byId(tr, 'join-network-submit').props.onPress();
		});
		expect(byId(tr, 'join-network-step').props.children).toBe('Checking the network matches the code…');
		await renderer.act(async () => {
			release({ok: false, reason: 'no-peers', detail: 'x'});
		});
		expect(byId(tr, 'join-network-error').props.children).toContain("couldn't reach the election authority's network");
	});

	it('a refused join shows translated copy for its reason, never the engine detail', async () => {
		mockJoinNetwork.mockResolvedValue({ok: false, reason: 'digest-mismatch', detail: 'join: RAW ENGINE TEXT'});
		const tr = render();
		type(tr, CODE_TEXT);
		await pressJoin(tr);
		expect(byId(tr, 'join-network-error').props.children).toContain("doesn't match the join code");
		expect(textOf(tr)).not.toContain('RAW ENGINE TEXT');
	});

	it('a thrown join (identity failure) shows the generic copy', async () => {
		mockJoinNetwork.mockRejectedValue(new Error('IdentityLost: raw'));
		const tr = render();
		type(tr, CODE_TEXT);
		await pressJoin(tr);
		expect(byId(tr, 'join-network-error').props.children).toBe('Something went wrong while joining. Try again.');
		expect(textOf(tr)).not.toContain('IdentityLost');
	});

	it('maps every failure reason to its own copy key', () => {
		expect(joinFailureKey('invitation-malformed')).toBe('invalidCode');
		expect(joinFailureKey('invitation-expired')).toBe('error.invitationExpired');
		expect(joinFailureKey('not-admitted')).toBe('error.notAdmitted');
		expect(joinFailureKey('no-peers')).toBe('error.noPeers');
		expect(joinFailureKey('not-synced')).toBe('error.notSynced');
		expect(joinFailureKey('digest-mismatch')).toBe('error.digestMismatch');
		expect(joinFailureKey('open-failed')).toBe('error.openFailed');
	});
});
