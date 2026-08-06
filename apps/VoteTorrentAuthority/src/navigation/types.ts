import type {
	Authority,
	Officer,
	DefaultUser,
	IDefaultUserEngine,
	User,
	IUserEngine,
	ReleaseKeyTask,
	SignatureTask,
	IElectionEngine,
	InviteStatus,
	SentKeyholderInvite,
	NetworkReference,
} from '@votetorrent/vote-core';

export type RootStackParamList = {
	Home: undefined;
	Networks: undefined;
	AddNetwork: undefined;
	NetworkDetails: { network: NetworkReference };
	Hosting: undefined;
	// Phase 8 plan 08-06 — Networks routes (NETUI-05, NETUI-06; D-12 / D-13)
	NetworkStatistics: { networkId: string };
	NetworkRevision: { networkId: string };
	AuthorityDetails: { authority: Authority };
	// Phase 8 plan 08-01: typed entry for ProposedAdministration (screen lands in 08-02 per D-04)
	ProposedAdministration: { authorityId: string };
	OfficerDetails: { officer: Officer; userName?: string; authority: Authority };
	// Phase 8 plan 08-03 — Administrator + Authority invitation routes (D-08, D-09)
	AdministratorInvitation: { mode: "send" | "accept"; invitationId?: string; authority?: Authority };
	AuthorityInvitation: { mode: "send" | "accept"; invitationId?: string };
	EditOfficer: {
		authority: Authority;
		officerId?: string;
	};
	DefaultUser: { defaultUser: DefaultUser; defaultUserEngine: IDefaultUserEngine };
	UserDetails: { user: User; userEngine: IUserEngine };
	ReviseUser: { user: User; userEngine: IUserEngine };
	AddKey: { user: User; userEngine: IUserEngine };
	RevokeKey: { user: User; userEngine: IUserEngine };
	AddDevice: undefined;
	// Phase 10 plan 10-01 (USRUI-05, USRUI-09; D-01, D-04) — display-only confirmation routes
	AddedKey: { user: User; keyValue: string; keyType: string; expiration: number };
	AddedDevice: { multiaddress: string; token: string };
	// Phase 10 plan 10-02 (KHUI-01/02; D-05, D-06) — keyholder detail + invitation routes
	Keyholder: { keyholder: InviteStatus<SentKeyholderInvite>; electionEngine: IElectionEngine };
	// 21-11 (INV-03): extended with electionEngine + keyholder so send mode can call inviteKeyholder
	KeyholderInvitation: { mode: "send" | "accept"; invitationId?: string; electionEngine?: IElectionEngine; keyholder?: InviteStatus<SentKeyholderInvite> };
	KeyTask: { task: ReleaseKeyTask };
	SignatureTask: { task: SignatureTask };
	// Phase 7 scaffold routes (07-05; renamed by 07-08) — standalone screens per D-09; real impls land in Phases 8–10
	EditElection: { taskId?: string };
	// Phase 9 plan 09-13 (ELECUI-04) — dedicated Election Revision route (Screen C, Figma #16/#17).
	// Separate from the task-flow EditElection route above. electionEngine? mirrors ElectionDetails shape.
	EditElectionRevision: { electionEngine?: IElectionEngine };
	// Phase 19 plan 19-07 (SURF-03) — carries the authority id (to open the authority engine
	// via getEngine("authority", authorityId) → networkEngine.openAuthority) plus the invite
	// slot Cid so the screen can call IAuthorityEngine.cancelInvite/resendInvite. taskId kept
	// optional for legacy callers.
	AuthorityDetail: { authorityId: string; slotCid: string; taskId?: string };
	EditElectionWithFilter: { taskId?: string };
	EditRevisionForm: { taskId?: string };
	ProposedElection: { taskId?: string };
	// Phase 19 plan 19-07 (SURF-04) — carries (name, revision) so the screen can call
	// INetworkEngine.cancelRevision/resendRevision. revision is a NUMBER (engine PK-join contract).
	ProposedRevision: { name: string; revision: number; taskId?: string };
	// Dev-entry route per D-12 — temporary; replaced by real callers in phases 8–10 (renamed by 07-08)
	ScreenScaffoldsDebug: undefined;
	ElectionDetails: { electionEngine: IElectionEngine };
	// Phase 46 (D-01) — the single RegistrationPolicy route; all three params are
	// required (not optional) since the screen destructures them unconditionally, and
	// electionId/authorityId are passed to avoid a redundant getElectionDetails()
	// round-trip just to learn them.
	RegistrationPolicy: { electionEngine: IElectionEngine; electionId: string; authorityId: string };
	// Phase 48 plan 48-21 (D-12) — the three Phase 48 routes: the Registration
	// Requests inbox, its per-request approval ceremony, and Bulk Import / Sync.
	// T-48-21-01: params carry identifiers only — authorityId, requestId. React
	// Navigation serializes route params into navigation state, and that state
	// surfaces in crash and debug payloads, so a requester name, a district, an
	// IssuerType payload value or an engine handle must never be added here.
	// Unlike RegistrationPolicy, no engine handle is threaded: every Phase 48
	// screen resolves its engine from useApp().getEngine(...). Placement: this
	// block sits ABOVE the Phase 47 comment/block (not folded into it) so
	// phase47Routes.test.tsx's param-hygiene source-block extraction (which
	// starts at the Phase 47 RegistrantsList route entry and ends at the
	// EditBallot route entry) stays byte-identical in coverage — do not
	// "tidy" this block down next to Phase 47's, that silently breaks that
	// gate.
	RegistrationInbox: { authorityId: string };
	RegistrationRequestApproval: { requestId: string; authorityId: string };
	BulkImportSync: { authorityId: string };
	// Phase 47 plan 47-21 (D-07/D-08/D-09) — the five Phase 47 routes, split by owning domain.
	// D-07: RegistrantsList is BOTH the authority-wide roster (no electionFilter) and the
	// election roster (electionFilter pre-applied). There is deliberately no second roster route.
	// D-08: RegistrantDetail is reached only from a RegistrantsList row press — no deep link
	// this phase.
	// T-47-21-01: params carry identifiers only. electionTitle is the single exception and is
	// public election metadata used for the header; a registrant name, a district, or any
	// RegistrantPrivate value must never be added, because React Navigation serializes route
	// params into navigation state and that state surfaces in crash and debug payloads.
	// Unlike RegistrationPolicy, no engine handle is threaded: every Phase 47 screen resolves
	// its engine from useApp().getEngine(...).
	RegistrantsList: { authorityId: string; electionFilter?: { electionId: string; electionTitle?: string } };
	RegistrantDetail: { registrantId: string; authorityId: string };
	AttestationProvisioningStatus: undefined;
	PollingDevices: { authorityId: string };
	AuthorityPeers: { authorityId: string };
	EditBallot: { electionId?: string; electionTitle?: string; electionDate?: string; ballotId?: string; electionEngine?: IElectionEngine; removeQuestionCode?: string; question?: any; originalQuestionCode?: string; readOnly?: boolean };
	// Phase 9 plan 09-01 — type entries for routes whose screens land in later
	// plans (CreateElection in 09-02, CreateBallot in 09-04). Stack.Screen
	// registration is deferred; only the type signature is added here so the
	// navigate(...) calls in ElectionsScreen / ElectionDetailsScreen compile.
	CreateElection: undefined;
	// Phase 9 plan 09-04 — Ballot flow screen-stack (BALUI-01..04). Route-param
	// shapes are intentionally loose-typed (no Question/Option imports) to
	// avoid circular imports between navigation/types and vote-core models;
	// consumers narrow via local casts. popTo carry-back fields are optional.
	// Phase 9 plan 09-07 — electionTitle/electionDate added so screens can show
	// real election context without engine imports (display strings passed by caller).
	CreateBallot: { electionId: string; question?: any; originalQuestionCode?: string; electionTitle?: string; electionDate?: string; removeQuestionCode?: string; electionEngine?: IElectionEngine };
	EditQuestion: { questionCode?: string; editQuestion?: any; newOption?: any; originalOptionCode?: string; electionTitle?: string; electionDate?: string; removeOptionCode?: string };
	EditQuestionOption: { questionCode: string; optionCode?: string; editOption?: any; electionTitle?: string; electionDate?: string };
};

export type TabParamList = {
	Elections: undefined;
	Signers: undefined;
	Authorities: undefined;
	Settings: undefined;
};

export type NavigationProp = {
	navigate: (screen: keyof RootStackParamList, params?: any) => void;
	setOptions: (options: any) => void;
	goBack: () => void;
};
