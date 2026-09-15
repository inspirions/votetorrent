/**
 * Per-tab param-list types (D-08/D-09) — mirrors Authority's flat-object-literal style
 * (`apps/VoteTorrentAuthority/src/navigation/types.ts`), NOT a class/enum. Unlike Authority's
 * single flat `RootStackParamList`, Voting's `RootNavigator` IS the `Tab.Navigator` itself and
 * each `Tab.Screen`'s `component` is its own `createNativeStackNavigator()` instance owning that
 * tab's full screen list including modals (D-08) — so there is one param list per tab stack
 * plus a `RootTabParamList` for the tab navigator.
 *
 * All params are `undefined` this phase — no route params for placeholders (39-05 scope). Wired
 * together by 39-07's RootNavigator.
 *
 * The 5 tabs (Phase 59, D-13): Vote · Timeline · Registration · Scan · Settings.
 */

// Vote tab: Home root + Ballot pushed + the 4 question/info modals (D-09 topology) +
// ValidationDetails (HOME-03/D-11 trust-story drill-in, plain push — not a modal).
export type VoteStackParamList = {
	Home: undefined;
	Ballot: undefined;
	IndividualQuestion: undefined;
	ElectionInfo: undefined;
	OfficeInfo: undefined;
	CandidateInfo: undefined;
	ValidationDetails: undefined;
	// Phase 42 (VOTE-04, D-05) — per-office selection summary + final Submit. All `undefined`
	// like every other entry above: selection state (selectionMap, currentQuestionIndex) lives
	// on BallotSelectionProvider, never a navigation param.
	ReviewSubmit: undefined;
};

// Registration tab: root + Device Attestation + Confirmation modals + the 3 form-step
// routes (RegisterPersonal/RegisterAddressParty/RegisterConfirm, 41-06/07/08) + the
// RegistrationInfo help modal (41-08). All `undefined` — draft state lives in
// `RegistrationDraftProvider`, not navigation params (RESEARCH Pattern 1/2).
export type RegistrationStackParamList = {
	RegistrationHome: undefined;
	DeviceAttestation: undefined;
	Confirmation: undefined;
	RegisterPersonal: undefined;
	RegisterAddressParty: undefined;
	RegisterConfirm: undefined;
	RegistrationInfo: undefined;
};

// Scan tab: single root screen, no modals.
export type ScanStackParamList = {
	ScanHome: undefined;
};

// Settings tab: single root screen, no modals.
export type SettingsStackParamList = {
	SettingsHome: undefined;
};

// Timeline tab (Phase 59, D-14/D-13/D-20/D-22). 59-05 landed the outline's five routes as TYPES
// ONLY; 59-10 (wave 5) builds the `TimelineStackNavigator` + `Tab.Screen` and extends this list
// ADDITIVELY to the full reachable route closure — the outline's five are not closed under
// onward navigation (BallotScreen navigates to IndividualQuestion, RegistrationScreen navigates
// to RegistrationInfo/DeviceAttestation/RegisterPersonal, etc.), and shipping them alone would
// dead-end the voter mid-flow (a `navigate` to an unregistered route is silently dropped — see
// D-14 in `59-CONTEXT.md`). All entries stay `undefined` like every other tab's param list —
// state lives in providers (`BallotSelectionProvider`/`RegistrationDraftProvider`, both lifted
// above `<Tab.Navigator>` per D-22), never a route param.
//
// `Ballot` / `IndividualQuestion` / `ReviewSubmit` / `RegistrationHome` / `RegistrationInfo` /
// `DeviceAttestation` / `RegisterPersonal` / `RegisterAddressParty` / `RegisterConfirm` /
// `Confirmation` are D-14's exact route names — 59-10 registers them a SECOND time in this new
// stack (reusing the same screen components as the Vote/Registration stacks) so a row action
// pushes within the Timeline stack and Back returns to the rail. `TimelineHome` / `Keyholders`
// resolve the OUTLINE↔PATTERNS naming discrepancy (59-05 preflight) and are binding: every
// existing tab stack names its root `<Tab>Home` (Home, RegistrationHome, ScanHome,
// SettingsHome) — `Timeline` itself is already taken by the `RootTabParamList` tab entry below
// — and no existing route carries a `Screen` suffix.
export type TimelineStackParamList = {
	TimelineHome: undefined;
	Ballot: undefined;
	IndividualQuestion: undefined;
	ReviewSubmit: undefined;
	RegistrationHome: undefined;
	RegistrationInfo: undefined;
	DeviceAttestation: undefined;
	RegisterPersonal: undefined;
	RegisterAddressParty: undefined;
	RegisterConfirm: undefined;
	Confirmation: undefined;
	Keyholders: undefined;
};

// The 5 tabs, in D-13 locked order: Vote · Timeline · Registration · Scan · Settings.
export type RootTabParamList = {
	Vote: undefined;
	Timeline: undefined;
	Registration: undefined;
	Scan: undefined;
	Settings: undefined;
};
