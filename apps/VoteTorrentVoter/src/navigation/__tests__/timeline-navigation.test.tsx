/**
 * timeline-navigation.test.tsx (Phase 59, plan 59-10, D-13/D-14/D-15/D-22) — three gates over
 * `navigation/index.tsx`:
 *
 * Gate A — the provider-singleton source gate (D-22). A source-assertion test in the style of
 * `no-inline-mock-imports.test.ts`: strips comments, extracts each navigator function's body by
 * name via brace-matching, and asserts `VoteStackNavigator`/`RegistrationStackNavigator`/
 * `TimelineStackNavigator` mount neither `BallotSelectionProvider` nor `RegistrationDraftProvider`
 * — both live ONLY in `AppStateProviders`, the function `RootNavigator` delegates to (D-22's
 * lift). Includes a non-empty-body negative control for all five extracted functions.
 *
 * Gate B — the route-closure gate. For each component registered on the Timeline stack, collects
 * every `navigation.navigate('X')` / `navigation.replace('X')` string literal from its source and
 * asserts every `X` is a key of the Timeline stack's registered route-name set — a route the
 * stack does not own bubbles to the tab navigator and the action is silently dropped (D-14).
 * Includes a negative control: the collector must find at least `IndividualQuestion` from
 * `BallotScreen.tsx`.
 *
 * Gate C — push-in-place. Mounts the full production `RootNavigator` tree and proves that
 * navigating to the Timeline tab then to `Keyholders` leaves the Timeline TAB focused (not some
 * other tab) with `Keyholders` focused in the nested stack — the rendered proof that D-14's "the
 * Timeline tab stays highlighted, Back returns to the rail" property actually holds.
 *
 * Task 3 (D-13) extends this file with two more assertions: the exact five-tab route-name order,
 * and the EN/ES tab-bar label.
 */
import React from 'react';
import * as fs from 'fs';
import * as path from 'path';
import ReactTestRenderer from 'react-test-renderer';
import {NavigationContainer, ThemeProvider, createNavigationContainerRef} from '@react-navigation/native';
import '../../i18n'; // initializes the global i18next instance useTranslation() reads from
import i18n from '../../i18n';
import {lightTheme} from '../../theme/themes';

// Mirrors __tests__/App.test.tsx's mock set — Gate C mounts the FULL RootNavigator tree.
jest.mock('../../providers/VoterAppProvider');
jest.mock('../../providers/CadreNodeProvider', () => ({
	useCadreNode: () => ({node: null, syncState: 'offline', connectedPeers: () => 0}),
	CadreNodeProvider: ({children}: {children: React.ReactNode}) => children,
}));

import {VoterAppProvider} from '../../providers/VoterAppProvider';
import {RootNavigator} from '../index';

// ---------------------------------------------------------------------------------------------
// Gate A — provider-singleton source gate (D-22)
// ---------------------------------------------------------------------------------------------

const navigationSourcePath = path.join(__dirname, '../index.tsx');
const navigationSourceRaw = fs.readFileSync(navigationSourcePath, 'utf8');

function stripComments(text: string): string {
	return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

const strippedNavigationSource = stripComments(navigationSourceRaw);

/** Brace-matched extraction of `function <name>(...) { ... }`'s body, run against ALREADY
 * comment-stripped source (comments can carry unbalanced braces, so stripping must happen first,
 * not during extraction). Skips past the PARAMETER LIST via paren-depth counting before looking
 * for the function body's opening brace -- a destructured parameter like
 * `function AppStateProviders({children}: PropsWithChildren) {` has its own `{children}` brace
 * pair that a naive "first `{` after the marker" search would mistake for the body opener,
 * silently truncating the extracted body to just that destructuring pattern. Returns null if the
 * function marker is not found. */
function extractFunctionBody(source: string, name: string): string | null {
	const marker = `function ${name}(`;
	const start = source.indexOf(marker);
	if (start === -1) return null;

	// Walk past the parameter list, starting at the '(' the marker itself ends on.
	let parenDepth = 0;
	let i = start + marker.length - 1;
	for (; i < source.length; i++) {
		if (source[i] === '(') parenDepth += 1;
		else if (source[i] === ')') {
			parenDepth -= 1;
			if (parenDepth === 0) {
				i += 1;
				break;
			}
		}
	}

	const braceStart = source.indexOf('{', i);
	if (braceStart === -1) return null;
	let depth = 0;
	for (let j = braceStart; j < source.length; j++) {
		if (source[j] === '{') depth += 1;
		else if (source[j] === '}') {
			depth -= 1;
			if (depth === 0) {
				return source.slice(braceStart + 1, j);
			}
		}
	}
	return null;
}

const voteStackBody = extractFunctionBody(strippedNavigationSource, 'VoteStackNavigator');
const registrationStackBody = extractFunctionBody(strippedNavigationSource, 'RegistrationStackNavigator');
const timelineStackBody = extractFunctionBody(strippedNavigationSource, 'TimelineStackNavigator');
const rootNavigatorBody = extractFunctionBody(strippedNavigationSource, 'RootNavigator');
// AppStateProviders is where BallotSelectionProvider/RegistrationDraftProvider are ACTUALLY
// mounted (D-22's lift); RootNavigator's own body only opens <AppStateProviders> and delegates.
// Checking rootNavigatorBody + appStateProvidersBody together is the source-scan equivalent of
// "RootNavigator's transitive JSX subtree contains both providers" -- the real invariant this
// gate protects, not a literal string match against RootNavigator's own function alone.
const appStateProvidersBody = extractFunctionBody(strippedNavigationSource, 'AppStateProviders');

describe('Gate A -- provider-singleton source gate (D-22)', () => {
	it('(anti-vacuity) the extractor returns a non-empty body for all five navigator/composition functions, and VoteStackNavigator contains <VoteStack.Navigator', () => {
		for (const body of [voteStackBody, registrationStackBody, timelineStackBody, rootNavigatorBody, appStateProvidersBody]) {
			expect(body).not.toBeNull();
			expect((body ?? '').length).toBeGreaterThan(0);
		}
		expect(voteStackBody).toContain('<VoteStack.Navigator');
	});

	it('VoteStackNavigator, RegistrationStackNavigator and TimelineStackNavigator mount NEITHER provider', () => {
		for (const body of [voteStackBody, registrationStackBody, timelineStackBody]) {
			expect(body).not.toContain('<BallotSelectionProvider');
			expect(body).not.toContain('<RegistrationDraftProvider');
		}
	});

	it('RootNavigator (via AppStateProviders, the function it delegates to) mounts BOTH providers exactly once each', () => {
		expect(rootNavigatorBody).toContain('<AppStateProviders');
		expect(appStateProvidersBody).toContain('<BallotSelectionProvider');
		expect(appStateProvidersBody).toContain('<RegistrationDraftProvider');
	});

	it('(regression control) moving a provider back into a per-tab stack would be caught -- planted negative fixture', () => {
		const plantedRegression = stripComments(`
			function TimelineStackNavigator() {
				return (
					<BallotSelectionProvider>
						<TimelineStack.Navigator />
					</BallotSelectionProvider>
				);
			}
		`);
		const plantedBody = extractFunctionBody(plantedRegression, 'TimelineStackNavigator');
		expect(plantedBody).toContain('<BallotSelectionProvider');
	});
});

// ---------------------------------------------------------------------------------------------
// Gate B -- route-closure gate
// ---------------------------------------------------------------------------------------------

// The Timeline stack's registered route-name set (navigation/types.ts's TimelineStackParamList,
// as actually extended by this plan -- additive over 59-05's five-entry outline).
const TIMELINE_ROUTE_NAMES = new Set([
	'TimelineHome',
	'Ballot',
	'IndividualQuestion',
	'ReviewSubmit',
	'RegistrationHome',
	'RegistrationInfo',
	'DeviceAttestation',
	'RegisterPersonal',
	'RegisterAddressParty',
	'RegisterConfirm',
	'Confirmation',
	'Keyholders',
]);

// Component source file -> the route it's registered under, for every screen on the Timeline
// stack (TimelineHome's TimelineScreen.tsx through Keyholders' KeyholdersScreen.tsx).
const TIMELINE_STACK_COMPONENT_FILES = [
	'../../screens/timeline/TimelineScreen.tsx',
	'../../screens/ballot/BallotScreen.tsx',
	'../../screens/ballot/IndividualQuestionScreen.tsx',
	'../../screens/ballot/ReviewSubmitScreen.tsx',
	'../../screens/registration/RegistrationScreen.tsx',
	'../../components/PlaceholderModal.tsx',
	'../../screens/registration/DeviceAttestationScreen.tsx',
	'../../screens/registration/RegisterPersonalScreen.tsx',
	'../../screens/registration/RegisterAddressPartyScreen.tsx',
	'../../screens/registration/RegisterConfirmScreen.tsx',
	'../../screens/registration/ConfirmationScreen.tsx',
	'../../screens/timeline/KeyholdersScreen.tsx',
];

const NAVIGATE_CALL_RE = /navigation\.(?:navigate|replace)\(\s*['"]([\w]+)['"]/g;

function collectNavigationTargets(relativeFile: string): string[] {
	const abs = path.join(__dirname, relativeFile);
	const source = stripComments(fs.readFileSync(abs, 'utf8'));
	const targets: string[] = [];
	let m: RegExpExecArray | null;
	NAVIGATE_CALL_RE.lastIndex = 0;
	while ((m = NAVIGATE_CALL_RE.exec(source)) !== null) {
		targets.push(m[1]);
	}
	return targets;
}

describe('Gate B -- route-closure gate (D-14)', () => {
	it('(anti-vacuity) the collector finds at least IndividualQuestion from BallotScreen.tsx', () => {
		const targets = collectNavigationTargets('../../screens/ballot/BallotScreen.tsx');
		expect(targets).toContain('IndividualQuestion');
	});

	it('every navigation.navigate/replace target collected from every Timeline-stack component is itself a registered Timeline-stack route', () => {
		const offenders: Array<{file: string; target: string}> = [];
		for (const file of TIMELINE_STACK_COMPONENT_FILES) {
			for (const target of collectNavigationTargets(file)) {
				if (!TIMELINE_ROUTE_NAMES.has(target)) {
					offenders.push({file, target});
				}
			}
		}
		expect(offenders).toEqual([]);
	});
});

// ---------------------------------------------------------------------------------------------
// Gate C -- push-in-place (D-14)
// ---------------------------------------------------------------------------------------------

const navigationRef = createNavigationContainerRef<Record<string, object | undefined>>();

let activeRenderer: ReactTestRenderer.ReactTestRenderer | null = null;

afterEach(async () => {
	if (activeRenderer) {
		await ReactTestRenderer.act(async () => {
			activeRenderer!.unmount();
		});
		activeRenderer = null;
	}
	i18n.changeLanguage('en');
});

async function mountRootNavigator() {
	let tr!: ReactTestRenderer.ReactTestRenderer;
	await ReactTestRenderer.act(async () => {
		tr = ReactTestRenderer.create(
			<VoterAppProvider>
				<NavigationContainer ref={navigationRef}>
					<ThemeProvider value={lightTheme}>
						<RootNavigator />
					</ThemeProvider>
				</NavigationContainer>
			</VoterAppProvider>,
		);
	});
	// Flush HomeScreen's on-mount getElection() promise (mirrors App.test.tsx/provider-scope.test.tsx).
	await ReactTestRenderer.act(async () => {
		await Promise.resolve();
	});
	activeRenderer = tr;
	return tr;
}

// Gate C is written here (Task 2's <files> list per the plan) but SKIPPED until Task 3 lands:
// `navigationRef.navigate('Timeline')` cannot resolve until the fifth `Tab.Screen` exists on
// `RootNavigator` (react-navigation logs "not handled by any navigator" and the assertion below
// would spuriously read the default-focused 'Vote' tab instead of failing loudly) -- Task 2 only
// builds `TimelineStackNavigator` itself; Task 3 registers it as a Tab.Screen (D-13). Task 3's
// commit removes this `.skip`.
describe.skip('Gate C -- push-in-place: the Timeline tab stays highlighted (D-14)', () => {
	it('navigating Timeline -> Keyholders leaves the Timeline TAB focused, with Keyholders focused in the nested stack', async () => {
		const tr = await mountRootNavigator();
		expect(tr).toBeTruthy();

		await ReactTestRenderer.act(async () => {
			navigationRef.navigate('Timeline');
		});
		await ReactTestRenderer.act(async () => {
			navigationRef.navigate('Timeline', {screen: 'Keyholders'});
			await Promise.resolve();
		});

		const rootState = navigationRef.getRootState();
		expect(rootState).toBeDefined();
		const focusedTabRoute = rootState!.routes[rootState!.index ?? 0];
		expect(focusedTabRoute.name).toBe('Timeline');

		const nestedState = focusedTabRoute.state;
		expect(nestedState).toBeDefined();
		const focusedNestedRoute = nestedState!.routes[nestedState!.index ?? 0];
		expect(focusedNestedRoute.name).toBe('Keyholders');
	});
});
