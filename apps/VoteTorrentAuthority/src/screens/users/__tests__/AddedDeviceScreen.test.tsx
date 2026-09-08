/**
 * AddedDeviceScreen.test.tsx — 57-17/57-18 gap closure (UAT-10 scroll-container regression
 * guard).
 *
 * No test file existed for this screen before this file. `AddedDeviceScreen.tsx` uses the plain
 * list recipe (57-17-SUMMARY.md): the whole root element is itself the `ScrollView`. This test
 * asserts the RENDERED `RCTScrollView` host node — mirroring
 * apps/VoteTorrentAuthority/src/screens/settings/SettingsScreen.scrollContainer.test.tsx, the
 * canonical model for this gap class — not source text, since a source grep would also pass on
 * an imported-but-unrendered ScrollView.
 */
import React from 'react';
import renderer from 'react-test-renderer';

jest.mock('react-native-vector-icons/FontAwesome6', () => 'FontAwesome6');

jest.mock('react-i18next', () => ({
	useTranslation: () => ({t: (key: string) => key}),
}));

jest.mock('react-native-safe-area-context', () => ({
	useSafeAreaInsets: () => ({top: 0, bottom: 0, left: 0, right: 0}),
}));

const mockRouteParams = {
	multiaddress: '/dns/relayrus.com/tcp/22134/vtad',
	token: '1234567890',
};

jest.mock('@react-navigation/native', () => ({
	useTheme: () => ({
		colors: {
			primary: 'sentinel-primary',
			background: 'sentinel-background',
			card: 'sentinel-card',
			text: 'sentinel-text',
			border: 'sentinel-border',
			notification: 'sentinel-notification',
			error: 'sentinel-error',
			textSecondary: 'sentinel-textSecondary',
			important: 'sentinel-important',
			success: 'sentinel-success',
			accent: 'sentinel-accent',
			warning: 'sentinel-warning',
			dark: 'sentinel-dark',
			light: 'sentinel-light',
		},
	}),
	useRoute: () => ({params: mockRouteParams}),
	useNavigation: () => ({navigate: jest.fn(), goBack: jest.fn(), setOptions: jest.fn()}),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const AddedDeviceModule = require('../AddedDeviceScreen');
const AddedDeviceScreen = AddedDeviceModule.default ?? AddedDeviceModule.AddedDeviceScreen;

type TreeNode = {
	type: string;
	props: Record<string, unknown>;
	children: Array<TreeNode | string> | null;
};

function findHostNodeByType(json: unknown, targetType: string): TreeNode | null {
	if (json === null || json === undefined) return null;
	const nodes: unknown[] = Array.isArray(json) ? json : [json];
	for (const node of nodes) {
		if (node === null || typeof node !== 'object') continue;
		const typed = node as TreeNode;
		if (typed.type === targetType) {
			return typed;
		}
		if (typed.children) {
			const found = findHostNodeByType(typed.children, targetType);
			if (found) return found;
		}
	}
	return null;
}

function renderScreen() {
	let tr!: renderer.ReactTestRenderer;
	renderer.act(() => {
		tr = renderer.create(<AddedDeviceScreen />);
	});
	return tr;
}

describe('AddedDeviceScreen — scroll container regression guard (57-17/57-18)', () => {
	it('Test 1: renders a real RCTScrollView host node as its outermost scrollable', () => {
		const tr = renderScreen();
		const scrollNode = findHostNodeByType(tr.toJSON(), 'RCTScrollView');
		expect(scrollNode).not.toBeNull();
	});

	it('Test 2 (anti-vacuity): the walker returns null against a View-only synthetic tree', () => {
		const syntheticTree = {
			type: 'View',
			props: {},
			children: [
				{type: 'View', props: {}, children: null},
				{type: 'View', props: {}, children: [{type: 'View', props: {}, children: null}]},
			],
		};
		expect(findHostNodeByType(syntheticTree, 'RCTScrollView')).toBeNull();
	});

	it('renders the multiaddress/token content the caller passed via route params (mount precondition)', () => {
		const tr = renderScreen();
		const text = JSON.stringify(tr.toJSON());
		expect(text).toContain(mockRouteParams.multiaddress);
		expect(text).toContain(mockRouteParams.token);
	});
});
