import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { getLocales } from 'react-native-localize';

const resources = {
	en: {
		translation: {
			elections: 'Elections',
			tasks: 'Tasks',
			authorities: 'Authorities',
			signers: 'Signers',
			settings: 'Settings',
			account: 'Account',
			appearance: 'Appearance',
			language: 'Language',
			about: 'About',
			dark: 'Dark',
			light: 'Light',
			english: 'English',
			recentNetworks: 'Recent Networks',
			connectedNetworks: 'Connected Networks',
			directAdvanced: 'Direct (advanced)',
			or: 'OR',
			// Phase 8 plan 08-05 (NETUI-01): empty-state hint when no recents.
			noRecentNetworks: 'No recent networks yet. Find one below to get started.',
			find: 'Find',
			scanQrCode: 'Scan QR Code',
			enterBootstrap: 'Enter Bootstrap (advanced)',
			useLocation: 'Use Location',
			scan: 'Scan',
			useBootstrap: 'Use Bootstrap',
			enterAddressOrLocation: 'Enter address or location...',
			enterBootstrapPlaceholder: 'Enter bootstrap...',
			syncConnected: 'Connected',
			syncSyncing: 'Syncing',
			syncOffline: 'Offline',
			invalidBootstrapAddress: 'Invalid bootstrap address',
			joinFailed: 'Could not join network',
			qrScanUnavailable: 'QR scanning is not available yet',
			cameraPermissionMessage: 'We need your permission to show the camera',
			grantPermission: 'Grant Permission',
			close: 'Close',
			addAuthority: 'Add Authority',
			noPinnedAuthorities: 'No pinned authorities yet',
			noAuthoritiesFound: 'No authorities found',
			filterAuthorities: 'Filter authorities...',
			authority: 'Authority',
			administration: 'Administration',
			pin: 'Pin',
			unpin: 'Unpin',
			handoff: 'Hand-off',
			name: 'Name',
			domainName: 'Domain Name',
			domain: 'Domain',
			sid: 'SID',
			cid: 'CID',
			address: 'Address',
			signature: 'Signature',
			coreSignature: 'Core Signature',
			revisionSignature: 'Revision Signature',
			priorCid: 'Prior CID',
			handoffSignature: 'Hand-Off Signature',
			handoffSignatures: 'Hand-off Signatures',
			invitedAuthorities: 'Invited Authorities',
			inviteAuthority: 'Invite Authority',
			valid: 'valid',
			of: 'of',
			createUser: 'Create User',
			invitingAuthority: 'Inviting Authority',
			invitingAdministrator: 'Inviting Administrator',
			newAuthority: 'New Authority',
			invitationName: 'Invitation Name',
			invitationKey: 'Invitation Key',
			soleInitialAdministratorNote:
				'Please create a user on this network. Your user will be the sole initial administrator.',
			userIsSoleAdministratorNote:
				'Your following user profile will be the sole initial administrator for the new authority.',
			expires: 'Expires',
			position: 'Position',
			switchingNetworks: 'Switching networks...',
			officer: 'Officer',
			nameOnInvitation: "Name on invitation (replaced with user's name)",
			officialTitle: 'Official title',
			key: 'Key',
			scopes: 'Scopes',
			signatures: 'Signatures',
			proposeReplacement: 'Propose Replacement',
			id: 'ID',
			title: 'Title',
			useOneOfTheFollowingToGetConnected: 'Use one of the following to get connected:',
			addNetwork: 'Add Network',
			createNewNetwork: 'Create a new network:',
			electionCharacteristics: 'Election Characteristics',
			useKeyholders: 'Use keyholders',
			noKeyholders: 'No keyholders',
			singleAuthority: 'Single authority',
			multiple: 'Multiple',
			multipleAuthorityNotYetSupported: 'Multiple (not yet supported)',
			mustSignBeforeCreating: 'You must sign before creating the network.',
			atLeastOneKeyholderRequired: 'At least one keyholder is required.',
			invalidDate: 'Please enter a valid date.',
			errAuthorityNameRequired: 'Please enter an authority name.',
			creating: 'Creating…',
			networkCreateTimeout:
				'Network creation timed out at the {{step}} step. Check your connection and try again.',
			errRelayRequired:
				'Add at least one relay address under Advanced → Add Relay before creating the network.',
			validationFailed: 'Validation failed.',
			errTitleRequired: 'Please enter an election title.',
			errElectionDateRequired: 'Please choose an election date.',
			errRevisionDeadlineRequired: 'Please choose a revision deadline.',
			errElectionDateInvalid: 'Please enter a valid election date.',
			errRevisionDeadlineInvalid: 'Please enter a valid revision deadline.',
			errRevisionDeadlineAfterDate: 'The revision deadline must be on or before the election date.',
			errElectionDateTooSoon:
				'The election date is too soon — choose a date on or after {{date}} so the ballot deadline can fall before it.',
			errBallotDeadlineAfterDate:
				'The election date is too soon for the ballot deadline. Please choose a later election date.',
			errTimelineOrder:
				'Please order the timeline so voting starts before tallying, and tallying before certification.',
			errThresholdExceedsKeyholders:
				'The signing threshold cannot be more than the number of key holders.',
			errCouldNotSaveElection:
				'Could not save the election. Please review the dates and try again.',
			initialAdministrator: 'Initial Administrator',
			imageUrl: 'Image URL',
			makePermanent: 'Make Permanent',
			optionalImageAddress: 'Optional image address',
			primaryAuthority: 'Primary Authority',
			authorityName: 'Authority name',
			authorityImageUrl: 'Authority image URL',
			domainNameOptional: 'Domain Name (optional)',
			initialOfficer: 'Initial Officer',
			yourNameOnPermanentRecord: 'Your name (on permanent record)',
			yourTitleOnPermanentRecord: 'Your title (on permanent record)',
			sign: 'SIGN',
			createNetwork: 'Create Network',
			relays: 'Relays',
			multiaddress: 'Multiaddress',
			advanced: 'Advanced',
			import: 'Import',
			addRelay: 'Add Relay',
			addTsa: 'Add TSA',
			statistics: 'Statistics',
			estimatedNodes: 'Estimated Nodes:',
			estimatedServers: 'Estimated Servers:',
			hostMyOwn: 'Host my own',
			configuration: 'Configuration',
			seeInstructions: 'See',
			votetorrentInstructions: 'VoteTorrent Instructions',
			forConfiguringAServer: 'for configuring a server.',
			useHostingProvider: 'Use Hosting Provider',
			addProvider: 'Add provider',
			hosting: 'Hosting',
			addServers: 'Add Servers',
			addServersToThisNetwork: 'Add servers to this network:',
			createProposedReplacement: 'Create a proposed replacement administration:',
			addOfficer: 'Add officer',
			createProposal: 'Create Proposal',
			noNetworkTitle: 'Choose a network to get started',
			noNetwork:
				'Tap “Select Network” at the top to join an existing network — or create your own.',
			selectNetwork: 'Select Network',
			remove: 'Remove',
			permissions: 'Permissions',
			publicKey: 'Public Key',
			proposedAdministration: 'Proposed Administration',
			share: 'Share',
			reviseAdministration: 'Revise Administration',
			authorization: 'Authorization',
			adjustProposal: 'Adjust Proposal',
			serverConfigurationPlaceholder: '{"network": { "name": ...',
			inviteId: 'Invite ID',
			showHelpIcons: 'Show help icons',
			defaultUser: 'Default User',
			connectDevice: 'Connect this device\nto existing user',
			connect: 'Connect',
			enterName: 'Enter name',
			enterImageUrl: 'Enter image URL',
			unknownUser: 'Unknown user',
			noUserFound: 'No user found for this network',
			user: 'User',
			noDefaultUserFound: 'No default user found',
			activeKeys: 'Active Keys',
			type: 'Type',
			expiration: 'Expiration',
			reviseUser: 'Revise User',
			addKey: 'Add Key',
			revokeKey: 'Revoke Key',
			history: 'History',
			mobile: 'Mobile',
			yubico: 'Yubico',
			addAnotherDeviceQrCode:
				'To add another device using a QR code, install the Authority App on that device, go to settings, press "Add this device to existing user", create a key using your biometrics, then scan the resulting QR code using the below button.',
			scanDevice: 'Scan Device',
			addYubicoDongleKey: 'Add Yubico (dongle) key',
			detailedInstructions: 'Detailed instructions',
			addYubicoInstructions: 'Insert or hold next to a Yubico dongle, then press this button:',
			generateExternalKey: 'Generate External Key',
			successfullyScannedKey: 'Successfully scanned key',
			signed: 'Signed',
			unchanged: 'Unchanged',
			revoke: 'Revoke',
			// D-20 / 49-05: rendered when the engine/schema rejects a revokeKey signature
			// (UserKey.DeleteValid CHECK) — see RevokeKeyScreen.tsx's constraint-name match.
			revokeKeySignatureInvalid: 'This revocation could not be verified and was not applied.',
			// D-13/D-14/D-16: native BiometricPrompt string contract + the signingKeyProvisioning*
			// screen copy (ProvisionSigningKeyScreen) + settingsSigningKeyRow. See
			// 49-UI-SPEC.md's Copywriting Contract for the full table this mirrors verbatim.
			deviceSigningPromptTitle: 'Confirm your identity',
			deviceSigningPromptSubtitle: 'Verify to sign this action',
			deviceSigningPromptNegativeButton: 'Cancel',
			signingKeyProvisioningPromptSubtitle: 'Verify to set up secure signing',
			signingKeyRecoveryPromptSubtitle:
				'Verify with your device PIN, pattern, or password to replace your signing key',
			deviceSigningErrorNoBiometricsEnrolled:
				'This device has no biometrics enrolled. Enroll a fingerprint or face in your device settings, then try again.',
			deviceSigningErrorLockout: 'Too many attempts. Wait a moment and try again.',
			deviceSigningErrorLockoutPermanent:
				'Biometric verification is locked. Unlock your device with your PIN, pattern, or password to reset it, then try again.',
			deviceSigningErrorGeneric: "Couldn't verify your biometrics. Try again.",
			// 49-14 follow-up (D-16 observability defect + DeleteValid precondition) — distinct from
			// deviceSigningErrorGeneric on purpose: neither of these is "couldn't verify your
			// biometrics," and rendering them that way hides the real, structural fault.
			deviceSigningErrorRecoveryKeyInvalidated:
				"This device's recovery key can no longer be used — it was invalidated along with your signing key. Contact an administrator to re-invite this device.",
			deviceSigningErrorRecoveryKeyNotRegistered:
				'Your recovery key was never registered on this network. Go to Settings and tap "Set Up Secure Signing" while connected to your network, then try recovery again.',
			signingKeyProvisioningScreenTitle: 'Secure Signing Setup',
			signingKeyProvisioningFirstRunHeading: 'Set up hardware-backed signing',
			signingKeyProvisioningFirstRunBody:
				"Your officer signature will be produced by a key stored in this device's secure hardware and protected by your biometrics. The key never leaves the device.",
			signingKeyProvisioningSetupButton: 'Set Up Secure Signing',
			signingKeyProvisioningPending: 'Setting up your signing key…',
			signingKeyProvisioningSuccessHeading: 'Signing key ready',
			signingKeyProvisioningSuccessBody: 'You can now sign officer actions with your biometrics.',
			signingKeyProvisioningAwaitingNetworkHeading: 'Secure signing is set up on this device',
			signingKeyProvisioningAwaitingNetworkBody:
				'Your signing key is protected by your biometrics. Select or create a network to finish registering it.',
			signingKeyProvisioningContinueButton: 'Return to App',
			// 49-14 follow-up: distinct from awaiting-network — the network resolved, but this
			// device's account on it did not (see ProvisionSigningKeyScreen.tsx's
			// tryResolveNetworkUserEngine doc comment).
			signingKeyProvisioningNetworkUserUnresolvedHeading: "We couldn't find your account on this network",
			signingKeyProvisioningNetworkUserUnresolvedBody:
				"This device is connected, but your officer account hasn't finished syncing to this network yet. Wait a moment and try again.",
			signingKeyProvisioningNetworkUserUnresolvedRetryButton: 'Try Again',
			signingKeyProvisioningRecoveryHeading: 'Your signing key needs to be replaced',
			signingKeyProvisioningRecoveryBody:
				"Your device's biometrics changed, which invalidated your previous signing key for security. Verify with your device PIN, pattern, or password to sign in a replacement key.",
			signingKeyProvisioningRecoveryButton: 'Replace Signing Key',
			signingKeyProvisioningRecoveryPending: 'Replacing your signing key…',
			signingKeyProvisioningNoRecoveryHeading: 'This device no longer has a screen lock',
			signingKeyProvisioningNoRecoveryBody:
				'Both your signing key and its recovery key were protected by your device\'s screen lock, which has been removed. They cannot be recovered on this device — ask an officer to invite this device again.',
			signingKeyProvisioningRecoveryUnsupportedOsHeading: "Recovery isn't available on this Android version",
			signingKeyProvisioningRecoveryUnsupportedOsBody:
				"Replacing a signing key requires Android 11 or newer. This device runs an older version, so its signing key can't be replaced here — ask an officer to invite this device again.",
			settingsSigningKeyRow: 'Secure Signing',
			warningIrrevocableAction: 'WARNING: This is an irrevocable action; proceed with caution.',
			typeIConfirm: 'Type "I confirm" to continue',
			confirmIfSure: '"I confirm" if you are sure',
			iConfirm: 'I confirm',
			addDevice: 'Add Device',
			qrInformation: 'QR Information',
			token: 'Token',
			fromOtherDevice:
				'From the other device, select the user, press Add Key, the Scan, using the following QR code:',
			select: 'Select',
			hash: 'Hash',
			requiredTimestampAuthorities: 'Required Timestamp Authorities',
			timestampAuthorities: 'Timestamp Authorities',
			// Phase 8 plan 08-05 (NETUI-02): label used in the Proposed Changes diff row.
			electionType: 'Election Type',
			reviseNetwork: 'Revise Network',
			servers: 'Server(s)',
			proposedChanges: 'Proposed Changes',
			network: 'Network',
			onboardingTasks: 'Onboarding Tasks',
			keysToRelease: 'Keys to Release',
			requestedSignatures: 'Requested Signatures',
			date: 'Date',
			revisionDeadline: 'Revision Deadline',
			registrationEnds: 'Registration Ends',
			ballotsFinal: 'Ballots Final',
			votingStarts: 'Voting Starts',
			tallyingStarts: 'Tallying Starts',
			validation: 'Validation',
			certificationStarts: 'Certification Starts',
			closed: 'Closed',
			revision: 'Revision',
			tags: 'Tags',
			timeline: 'Timeline',
			keyholderThreshold: 'Keyholder Threshold',
			keyholderPolicy: 'Keyholder Policy',
			official: 'Official',
			adhoc: 'Ad-hoc',
			dateTime: 'Date/time',
			sent: 'Sent',
			unsent: 'Unsent',
			accepted: 'Accepted',
			invite: 'Invite',
			administrators: 'Administrators',
			pending: 'Pending',
			accept: 'Accept',
			reject: 'Reject',
			networkRevision: 'Network Revision',
			proposalTimestamp: 'Proposal timestamp',
			informational: 'informational',
			noProposedElectionsCurrently: 'No proposed elections currently',
			ready: 'Ready',
			remaining: 'remaining',
			keyholderRelease: 'Keyholder Release',
			release: 'Release',
			createElection: 'Create Election',
			proposedElections: 'Proposed Elections',
			noCurrentElections: 'No current elections',
			noProposedElections: 'No proposed elections',
			electionHistory: 'Election History',
			// Phase 9 plan 09-01 (ELECUI-01/02/05) — D-17: en-only, Spanish deferred to Phase 11.
			noHistoryFound: 'No history found.',
			noBallotYet: 'No ballot has been created for this election yet.',
			createBallot: 'Create Ballot',
			viewBallot: 'View Ballot',
			registrationOpens: 'Registration Opens',
			registrationCloses: 'Registration Closes',
			votingOpens: 'Voting Opens',
			votingCloses: 'Voting Closes',
			// Phase 9 plan 09-02 (ELECUI-03) — Create Election wizard keys.
			// D-17: en-only; Spanish backfill deferred to Phase 11 COMUI-02.
			basics: 'Basics',
			review: 'Review',
			next: 'Next',
			back: 'Back',
			edit: 'Edit',
			step: 'Step',
			addTag: 'Add a tag (comma-separated)',
			registrationDeadline: 'Registration Deadline',
			selectKeyholders: 'Select keyholders for this election:',
			noKeyholdersSelected: 'No keyholders selected yet.',
			preview: 'Preview',
			election: 'Election',
			keyholders: 'Keyholders',
			cloneElection: 'Clone Election',
			reviseElection: 'Revise Election',
			ballotTemplates: 'Ballot Templates',
			pendingBallotTemplates: 'Pending Ballot Templates',
			noAssociatedAuthoritiesHaveTemplates:
				'No authorities you are associated with have submitted ballot templates for this election.',
			noBallotTemplates: 'No ballot templates have been submitted for this election.',
			createBallotTemplate: 'Create Ballot Template',
			more: 'More',
			reviseAuthority: 'Revise Authority',
			ballotTemplate: 'Ballot Template',
			description: 'Description',
			addQuestion: 'Add Question',
			districtsGroups: 'Districts / Groups',
			clearAll: 'Clear All',
			addRange: 'Add Range',
			propose: 'Propose',
			// Phase 9 plan 09-08 — Ballot Template parity (BALUI-01/02).
			// D-17: en-only; Spanish deferred to Phase 11.
			authorityPlaceholder: 'Select authority',
			addDistrictCode: 'Add district code',
			itemsRangeCount: '{{from}}–{{to}} of {{total}} items',
			// Phase 7 foundation keys (07-01)
			adminRevision: 'Admin Revision',
			authorityRevision: 'Authority Revision',
			electionRevision: 'Election Revision',
			ballotRevision: 'Ballot Revision',
			allNetworks: 'All Networks',
			noTasks: 'No tasks',
			noTasksHelper: 'You have no pending tasks.',
			chipSignature: 'Signature',
			chipRelease: 'Release',
			chipOnboarding: 'Onboarding',
			closeScreen: 'Close screen',
			proposal: 'Proposal',
			details: 'Details',
			policies: 'Policies',
			admin: 'Admin',
			image: 'Image',
			electionTitle: 'Election Title',
			// Phase 7 onboarding keys (07-05) — flat camelCase per D-13; dotted forms PROHIBITED
			// Slug fallback: FrameN per plan contingency (semantic rename deferred — see 07-05-SUMMARY)
			screenScaffoldsDebugTitle: 'Onboarding Debug',
			screenScaffoldsDebugIntro:
				'Direct entry points for the six onboarding screens. Temporary dev route per D-12; replaced by real callers in phases 8–10.',
			// Phase 8 gap-closure 08-07 — interim accept/send-mode invitation entries
			debugAdministratorInvitationAccept: 'Administrator Invitation (Accept)',
			debugAuthorityInvitationSend: 'Authority Invitation (Send)',
			debugAuthorityInvitationAccept: 'Authority Invitation (Accept)',
			// Frame 2 — Invitation sent (initial confirmation)
			editElectionTitle: 'Invitation Sent',
			editElectionBodyPrimary:
				'Your invitation has been sent. You will be notified when the recipient responds.',
			editElectionBodySecondary: 'If no response is received soon, you can resend the invitation.',
			editElectionResend: 'Resend Invitation',
			editElectionBackToTasks: 'Back to Tasks',
			// Frame 7 — Awaiting response
			authorityDetailTitle: 'Awaiting Response',
			authorityDetailBodyPrimary: 'Waiting for the recipient to respond to your invitation.',
			authorityDetailBodySecondary:
				'You can resend the invitation or cancel it if no longer needed.',
			authorityDetailResend: 'Resend Invitation',
			authorityDetailCancelInvitation: 'Cancel Invitation',
			// Frame 18 — Sent confirmation
			editElectionWithFilterTitle: 'Request Sent',
			editElectionWithFilterBodyPrimary: 'Your request has been submitted successfully.',
			editElectionWithFilterGotIt: 'Got It',
			// Frame 19 — Awaiting (variant)
			editRevisionFormTitle: 'Awaiting Approval',
			editRevisionFormBodyPrimary: 'Your submission is pending approval from the authority.',
			editRevisionFormBodySecondary: 'You will receive a notification once it is reviewed.',
			editRevisionFormResend: 'Resend Request',
			editRevisionFormDismissRequest: 'Dismiss Request',
			// Frame 20 — Release request sent
			proposedElectionTitle: 'Release Request Sent',
			proposedElectionBodyPrimary: 'Your key release request has been delivered to the keyholders.',
			proposedElectionBackToTasks: 'Back to Tasks',
			// Frame 21 — Release awaiting
			proposedRevisionTitle: 'Awaiting Release',
			proposedRevisionBodyPrimary: 'Waiting for keyholders to complete the release.',
			proposedRevisionBodySecondary: 'You can resend the release request or cancel it.',
			proposedRevisionResendRequest: 'Resend Request',
			proposedRevisionCancelRequest: 'Cancel Request',
			// Phase 8 plan 08-01 — Authorities polish + OfficerCard extraction
			noAuthorities: 'No authorities',
			noAuthoritiesHelper: 'Authorities you join or pin will appear here',
			manageProposal: 'Manage Proposal',
			// Phase 8 plan 08-02 — Proposed Administration screen (AUTHUI-03)
			thresholdPolicies: 'Threshold Policies',
			addAdministrator: 'Add Administrator',
			// Fallback for missing scopeDescriptions[rnp] (vote-core defines 8/9 — D-03)
			scope_rnp: 'Revise Network Policies',
			loading: 'Loading...',
			// Phase 8 plan 08-03 — OfficerDetails + Invitation screens (AUTHUI-04, 05, 06)
			administrator: 'Administrator',
			administratorInvitation: 'Administrator Invitation',
			authorityInvitation: 'Authority Invitation',
			sendInvitation: 'Send Invitation',
			invitation: 'Invitation',
			send: 'Send',
			decline: 'Decline',
			userId: 'User ID',
			// Phase 9 plan 09-04 — Ballot flow polish + Create Ballot (BALUI-01..04)
			save: 'Save',
			code: 'Code',
			question: 'Question',
			option: 'Option',
			addOption: 'Add Option',
			questionNeedsTwoOptions: 'Choice questions need at least two options.',
			rank: 'Rank',
			score: 'Score',
			text: 'Text',
			additionalInstructions: 'Additional Instructions',
			dependsOn: 'Depends On',
			addDependency: 'Add Dependency',
			additionalDetails: 'Additional Details',
			informationUrl: 'Information URL',
			videoUrl: 'Video URL',
			optionalVideoAddress: 'Optional video address',
			// Phase 9 plan 09-07 — Ballot Question + Question Option parity (BALUI-03/04).
			// D-17: en-only; Spanish deferred to Phase 11.
			ballotQuestion: 'Ballot Question',
			questionOption: 'Question Option',
			selectionLimits: 'Selection Limits',
			min: 'Min',
			max: 'Max',
			forceOrder: 'Force Order',
			required: 'Required',
			group: 'Group',
			sequence: 'Sequence',
			groupPlaceholder: 'county/seats',
			// Phase 9 plan 09-10 — mock authority dropdown options (G6). EN only; es deferred per D-17.
			mockAuthorityA: 'Mock Authority A',
			mockAuthorityB: 'Mock Authority B',
			// Phase 9 plan 09-11 (ELECUI-03/04) — Election-flow form keys. EN only; es deferred per D-17.
			newElection: 'New Election',
			electionRevisionTitle: 'Election Revision',
			coreSectionHeader: 'Core (cannot change once approved)',
			initialRevisionHeader: 'Initial Revision (can change)',
			proposedRevisionHeader: 'Proposed Revision',
			coreDateHelp: 'The core date of the election',
			revisionDeadlineHelp: 'Last date/time changes are allowed',
			releasingKeys: 'Releasing Keys',
			selectDate: 'Select date',
			keyHolders: 'Key holders',
			addKeyHolder: 'Add Key Holder',
			thresholdPolicy: 'Threshold Policy',
			thresholdValue: '{{n}} of {{m}}',
			instructions: 'Instructions',
			instructionsOptional: 'Instructions (optional)',
			keyholderName: 'Key holder name',
			adjustRevision: 'Adjust Revision',
			signRevision: 'Sign',
			shareRevision: 'Share',
			previewBallots: 'Preview…',
			questionsLabel: 'Questions',
			validForAuthority: '[valid for {{authority}}]',
			filterAuthoritiesField: 'Filter authorities...',
			// Phase 21 plan 21-07 (UKEY-03) — D-15 copy: external-key honest-state strings with no phase numbers
			scanDeviceNotAvailable: 'Requires a paired device',
			generateExternalKeyNotAvailable: 'Requires a hardware key device',
			// Phase 10 plan 10-01 (USRUI-05/09; USRUI-01 polish) — D-17: en-only; Spanish deferred to Phase 11
			addedKey: 'Added Key',
			noActiveKeysFound: 'No active keys found.',
			addedDevice: 'Added Device',
			deviceAdded: 'Device Added',
			done: 'Done',
			// Phase 10 plan 10-02 (KHUI-01/02) — D-17: en-only; Spanish deferred to Phase 11
			keyholder: 'Keyholder',
			keyholderInvitation: 'Keyholder Invitation',
			debugKeyholderInvitationSend: 'Keyholder Invitation (Send)',
			debugKeyholderInvitationAccept: 'Keyholder Invitation (Accept)',
			// Phase 11 plan 11-01 (D-11) — en mirrors added for es orphan keys (create/revise)
			create: 'Create', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			revise: 'Revise', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			// D-03/D-05/D-09 ballot confirmation actions (31-05)
			submitForConfirmation: 'Submit for confirmation',
			withdrawConfirmation: 'Withdraw',
			statusProposed: 'Proposed',
			statusConfirmed: 'Confirmed',
			// Debug seed keys — debug-only affordance; never appears in release UI
			debugSeedTasksTitle: 'Seed Pending Tasks (Debug)',
			debugSeedTasksSuccess: 'Pending tasks seeded — check Tasks tab',
			debugSeedTasksError: 'Seed failed: ',
			// Phase 39 plan 39-04 (DEBT-09 app-Jest gate) — DistrictsGroupsEditor range fields.
			from: 'From',
			to: 'To',
			add: 'Add',
			cancel: 'Cancel',
			// Phase 46 (D-11) — registrationPolicy* group; copy verbatim from 46-UI-SPEC.md § Copywriting Contract.
			// Navigation entry
			registrationPolicyEntryTitle: 'Registration Policy',
			// Screen header / section titles
			registrationPolicyFieldsSectionTitle: 'Fields',
			registrationPolicyDisclosureSectionTitle: 'Disclosure',
			registrationPolicyAttestationSectionTitle: 'Attestation',
			registrationPolicyIssuesSectionTitle: 'Policy Issues',
			// Scope gate (D-10)
			registrationPolicyReadOnlyBanner:
				'Viewing only. You need the {{scope}} permission to change this policy.',
			registrationPolicyReadOnlyNoOfficerBanner:
				'Viewing only. You are not a registered officer of this authority, so changes are disabled.',
			// Field editor (D-02)
			registrationPolicyKnownFieldLastName: 'Last Name',
			registrationPolicyKnownFieldFirstName: 'First Name',
			registrationPolicyDistrictFieldLabel: 'District',
			registrationPolicyDistrictFieldHint: 'Only if this election uses districts',
			registrationPolicyCustomFieldOption: 'Custom…',
			registrationPolicyCustomFieldPlaceholder: 'Field name',
			registrationPolicyExtraFieldBadge: 'Extra Field',
			registrationPolicyExtraFieldHint: 'Stored in Extra Fields, not a dedicated column',
			registrationPolicyTierLabel: 'Visibility',
			registrationPolicyTierPublic: 'Public',
			registrationPolicyTierSelective: 'Selective',
			registrationPolicyTierPrivate: 'Private',
			registrationPolicyRequirementRequired: 'Required',
			registrationPolicyRequirementOptional: 'Optional',
			registrationPolicyAddFieldButton: 'Add Field',
			registrationPolicyNoFieldsHeading: 'No fields configured yet',
			registrationPolicyNoFieldsBody: 'Add a field above to define what registrants must provide.',
			// Disclosure editor (D-03/D-04/D-05)
			registrationPolicyAudienceLabel: 'Audience',
			registrationPolicyAudienceEveryone: 'Everyone',
			registrationPolicyAudienceDistrict: 'Same district (neighboring voters)',
			registrationPolicyAudienceNotSet: 'Not set',
			registrationPolicyAudienceDistrictUnavailableHint:
				"Same-district disclosure isn't available yet — it needs BOTH a District field declared above AND a ballot template for this election that declares districts.",
			registrationPolicyNoDisclosureHeading: 'No selective fields yet',
			registrationPolicyNoDisclosureBody:
				"Selective-tier fields you add in Fields above will appear here so you can set who they're disclosed to.",
			registrationPolicyOrphanDisclosureFlag: 'Orphan disclosure:',
			registrationPolicyOrphanDisclosureBody: 'This audience rule has no matching selective field.',
			registrationPolicyMissingAudienceFlag: 'No audience set:',
			registrationPolicyMissingAudienceBody:
				"This selective field can't be disclosed to anyone until an audience is set.",
			registrationPolicySetAudienceButton: 'Set Audience',
			registrationPolicyRemoveButton: 'Remove',
			// Attestation editor — tri-state (D-07)
			registrationPolicyAttestationNotConfiguredLabel: 'Not configured — required by default',
			registrationPolicyAttestationNotConfiguredBody:
				'No policy has been set, so device attestation is REQUIRED for this election (the fail-closed default).',
			registrationPolicyAttestationRequiredLabel: 'Required',
			registrationPolicyAttestationRequiredBody:
				'Device attestation is explicitly required for this election.',
			registrationPolicyAttestationNotRequiredLabel: 'Not required',
			registrationPolicyAttestationNotRequiredBody:
				'Device attestation is explicitly turned off for this election.',
			registrationPolicyAttestationRequireButton: 'Require Attestation',
			registrationPolicyAttestationDontRequireButton: "Don't Require Attestation",
			registrationPolicyAttestationRevertButton: 'Revert to Default',
			// Policy editability window (D-13)
			registrationPolicyConfirmTitle: 'Change registration policy?',
			registrationPolicyConfirmRosterBody:
				'This election already has registrants. They were validated against the previous policy and will not be re-validated.',
			registrationPolicyConfirmWindowOpenBody:
				'Registration is already open for this election. Registrants who already signed up were validated against the previous policy and will not be re-validated.',
			registrationPolicyConfirmProceedButton: 'Proceed Anyway',
			registrationPolicyConfirmCancelButton: 'Keep Current Policy',
			// Per-row immediate-apply affordance (D-14)
			registrationPolicyRowSaving: 'Saving…',
			registrationPolicyRowSaved: 'Saved',
			registrationPolicyRowError: "Couldn't save",
			registrationPolicyRetryButton: 'Retry',
			// Phase 47 (D-04/D-05/D-07) — registrantList* group; copy verbatim from 47-UI-SPEC.md § Copywriting Contract.
			registrantListScreenTitle: 'Registrants',
			registrantListRosterScreenTitle: '{{electionTitle}} Registrants',
			registrantListSearchPlaceholder: 'Search by name',
			registrantListFilterStatusAll: 'All Statuses',
			registrantListFilterExpirationLabel: 'Expiration',
			registrantListFilterDistrictLabel: 'District',
			registrantListCountLabel: 'Showing {{shown}} of {{total}}',
			registrantListCountUnknown: 'Showing {{shown}}',
			registrantListLoadMoreButton: 'Load More',
			registrantListLoadingMore: 'Loading more…',
			registrantListEndOfList: 'End of list',
			registrantListEmptyHeading: 'No registrants match these filters',
			registrantListEmptyBody: 'Try a different status, district, or search term.',
			registrantListEmptyHeadingNoFilters: 'No registrants yet',
			registrantListEmptyBodyNoFilters:
				'Registrants will appear here once people register for this authority.',
			// Phase 47 (D-10) — registrantStatus* group; copy verbatim from 47-UI-SPEC.md § Copywriting Contract.
			registrantStatusActive: 'Active',
			registrantStatusSuspended: 'Suspended',
			registrantStatusRevoked: 'Revoked',
			// Phase 47 (D-12/D-13/D-14) — registrantDetail* group; copy verbatim from 47-UI-SPEC.md § Copywriting Contract.
			registrantDetailScreenTitle: 'Registrant',
			registrantDetailPublicTierTitle: 'Public',
			registrantDetailSelectiveTierTitle: 'Selective',
			registrantDetailPrivateTierTitle: 'Private',
			registrantDetailNoPublicTier: 'No public details recorded',
			registrantDetailNoSelectiveTier: 'No selective details recorded',
			registrantDetailNoPrivateTier: 'No private details recorded',
			registrantDetailSignorKeyLabel: 'Signed by',
			registrantDetailExpirationLabel: 'Expires',
			registrantDetailSelectiveAudiencePreviewTitle: 'Audience Preview',
			registrantDetailSelectiveAudiencePreviewHint:
				'Shows what each audience would receive if this election discloses selective details.',
			registrantDetailSelectiveDisclosedLabel: 'Disclosed',
			registrantDetailSelectiveNotDisclosedLabel: 'Not disclosed to this audience',
			registrantDetailPrivateMaskedValue: '••••••',
			registrantDetailPrivateRevealHint: 'Tap to reveal',
			registrantDetailPrivateHideHint: 'Tap to hide',
			registrantDetailPrivateGateHeading: 'Private details require the {{scope}} permission',
			// Phase 47 (D-10) — registrantLifecycle* group; copy verbatim from 47-UI-SPEC.md § Copywriting Contract.
			registrantLifecycleRenewButton: 'Renew Registration',
			registrantLifecycleReinstateButton: 'Reinstate to Active',
			registrantLifecycleSuspendButton: 'Suspend Registrant',
			registrantLifecycleRevokeButton: 'Revoke Registration',
			registrantLifecycleRenewTitle: 'Renew registration?',
			registrantLifecycleRenewBody: "Extends {{name}}'s registration to {{newExpiration}}.",
			registrantLifecycleReinstateTitle: 'Reinstate to active?',
			registrantLifecycleReinstateBody: "Changes {{name}}'s status from {{oldStatus}} to Active.",
			registrantLifecycleSuspendTitle: 'Suspend {{name}}?',
			registrantLifecycleSuspendBody:
				"This immediately changes {{name}}'s status to Suspended. There is no automatic undo — reinstating requires a separate signed action. Type {{name}}'s name to confirm.",
			registrantLifecycleRevokeTitle: "Revoke {{name}}'s registration?",
			registrantLifecycleRevokeBody:
				"This immediately and permanently revokes {{name}}'s voter registration. There is no undo. Type {{name}}'s name to confirm.",
			registrantLifecycleTypedConfirmPlaceholder: 'Type {{name}} to confirm',
			registrantLifecycleKeepCurrentStatus: 'Keep Current Status',
			registrantLifecycleKeepCurrentExpiration: 'Keep Current Expiration',
			registrantLifecycleConfirmRenewal: 'Confirm Renewal',
			registrantLifecycleConfirmReinstatement: 'Confirm Reinstatement',
			// Phase 47 (D-01/D-02/D-14) — registrantAccessTrail* group; copy verbatim from 47-UI-SPEC.md § Copywriting Contract.
			registrantAccessTrailSectionTitle: 'Access History',
			// D-01: load-bearing framing — accountability/transparency, NOT a security control. Do not paraphrase.
			registrantAccessTrailDisclaimer:
				'Records when an officer viewed private details for this registrant through this app, and which fields were revealed — for accountability and transparency, not as a security control. It only captures access made through this app; direct database access is not recorded here.',
			registrantAccessTrailEmptyHeading: 'No recorded access yet',
			registrantAccessTrailEmptyBody:
				"Private details haven't been revealed for this registrant through this app.",
			registrantAccessTrailRow: '{{viewer}} revealed {{fields}} — {{timestamp}}',
			// Phase 47 (D-03) — associationList* group; copy verbatim from 47-UI-SPEC.md § Copywriting Contract.
			associationListSectionTitle: 'Associated Devices',
			associationListEmptyHeading: 'No devices associated',
			associationListEmptyBody: 'This registrant has not associated a device yet.',
			associationListDeviceKeyLabel: 'Device Key',
			associationListExpirationLabel: 'Expires',
			associationListRemoveButton: 'Remove Association',
			associationListRemoveTitle: 'Remove this device association?',
			associationListRemoveBody:
				'{{name}} will need to associate a device again before voting. This does not change their registration status.',
			associationListRemoveConfirm: 'Remove Association',
			associationListKeepAssociation: 'Keep Association',
			// Phase 47 (D-11) — attestationChallenge* group; copy verbatim from 47-UI-SPEC.md § Copywriting Contract.
			attestationChallengeSectionTitle: 'Attestation Challenges',
			attestationChallengeEmptyHeading: 'No outstanding challenges',
			attestationChallengeEmptyBody:
				'No attestation challenges are currently outstanding for this registrant.',
			attestationChallengeDeviceKeyLabel: 'Device Key',
			attestationChallengeElectionLabel: 'Election',
			attestationChallengeExpiryLabel: 'Expires',
			attestationChallengeExpireButton: 'Expire Challenge',
			attestationChallengeExpireTitle: 'Expire this challenge?',
			attestationChallengeExpireBody:
				"The device holding this challenge will no longer be able to complete attestation with it. A new challenge can only be issued by the device's own registration/association attempt.",
			attestationChallengeExpireConfirm: 'Expire Challenge',
			attestationChallengeKeepChallenge: 'Keep Challenge',
			// Phase 47 (D-03) — attestationVerdict* group; copy verbatim from 47-UI-SPEC.md § Copywriting Contract.
			attestationVerdictPass: 'Pass',
			attestationVerdictFail: 'Fail',
			attestationVerdictNone: 'No verdict yet',
			attestationVerdictReasonLabel: 'Reason',
			attestationVerdictVerifiedAtLabel: 'Verified',
			// Phase 47 (D-09) — attestationProvisioning* group; copy verbatim from 47-UI-SPEC.md § Copywriting Contract.
			attestationProvisioningScreenTitle: 'Device Attestation Setup',
			attestationProvisioningProvisionedHeading: 'Play Console keys are configured',
			attestationProvisioningProvisionedBody:
				'Device attestation is fully operational — new device associations can be verified.',
			attestationProvisioningNotProvisionedHeading: 'Play Console keys are not configured',
			attestationProvisioningNotProvisionedBody:
				'Device association will fail until Play Console key material is provisioned. Registrant and association data can still be viewed and managed normally.',
			attestationProvisioningSetupLink: 'See SETUP.md for provisioning steps',
			attestationProvisioningInlineBannerBody:
				"Device attestation isn't configured. Associate ceremonies will fail closed until this is fixed.",
			attestationProvisioningInlineBannerLink: 'View setup status',
			// Phase 47 (D-08/D-13) — pollingDevice* group; copy verbatim from 47-UI-SPEC.md § Copywriting Contract.
			pollingDeviceScreenTitle: 'Polling Devices',
			pollingDeviceAddButton: 'Add Polling Device',
			pollingDeviceLabelField: 'Label',
			pollingDeviceLabelPlaceholder: 'e.g. Precinct 4 tablet',
			pollingDeviceHashLabel: 'Device Hash',
			pollingDeviceRemoveButton: 'Remove',
			pollingDeviceRemoveTitle: 'Remove this polling device?',
			pollingDeviceRemoveBody:
				'{{label}} will no longer be able to operate as an in-person polling device for this authority. It can be added back at any time.',
			pollingDeviceRemoveConfirm: 'Remove Device',
			pollingDeviceKeepDevice: 'Keep Device',
			pollingDeviceEmptyHeading: 'No polling devices whitelisted',
			pollingDeviceEmptyBody:
				'Add a device to allow it to operate as an in-person polling device for this authority.',
			// Phase 47 (D-08/D-13) — authorityPeer* group; copy verbatim from 47-UI-SPEC.md § Copywriting Contract.
			authorityPeerScreenTitle: 'Authority Peers',
			authorityPeerAddButton: 'Add Authority Peer',
			authorityPeerIdLabel: 'Peer ID',
			authorityPeerIdPlaceholder: 'Peer ID',
			authorityPeerRemoveButton: 'Remove',
			authorityPeerRemoveTitle: 'Remove this authority peer?',
			authorityPeerRemoveBody:
				"This peer will be dropped from this authority's P2P cluster. It can be added back at any time.",
			authorityPeerRemoveConfirm: 'Remove Peer',
			authorityPeerKeepPeer: 'Keep Peer',
			authorityPeerEmptyHeading: 'No authority peers configured',
			authorityPeerEmptyBody: "Add a peer to expand this authority's P2P cluster.",
			// 47-REVIEW IN-06. Deliberately carries NO {{peerId}} interpolation: the
			// rejected value is operator-supplied text and stays visible in the add
			// form's input, so naming it again in the message buys nothing and would
			// put unvalidated input inside a translated sentence.
			authorityPeerDuplicateError: 'That peer is already configured for this authority.',
			// D-13: UI legibility affordance, NOT the enforcement boundary — the schema's AdminSignature CHECK is the real control.
			authorityPeerScopeReadOnlyBanner:
				'Viewing only. You need the {{scope}} permission to change authority peers.',
			// Phase 47 (D-13) — registrantScope* group; copy verbatim from 47-UI-SPEC.md § Copywriting Contract.
			registrantScopeReadOnlyBanner:
				'Viewing only. You need the {{scope}} permission to change registrants, associations, or devices.',
			registrantScopeReadOnlyNoOfficerBanner:
				'Viewing only. You are not a registered officer of this authority, so changes are disabled.',
			// Phase 48 (D-01/D-03/D-09) — registrationRequest* group; copy verbatim from 48-UI-SPEC.md § Copywriting Contract.
			registrationRequestScreenTitle: 'Registration Requests',
			registrationRequestSearchPlaceholder: 'Search by name',
			registrationRequestFilterStatusAll: 'All',
			registrationRequestFilterStatusPending: 'Pending',
			registrationRequestFilterStatusApproved: 'Approved',
			registrationRequestFilterStatusRejected: 'Rejected',
			registrationRequestFilterIssuerAll: 'All Sources',
			registrationRequestFilterIssuerRegistrant: 'Registrant-Submitted',
			registrationRequestFilterIssuerBridge: 'Bridge-Imported',
			registrationRequestCountLabel: 'Showing {{shown}} of {{total}}',
			registrationRequestCountUnknown: 'Showing {{shown}}',
			registrationRequestSortedByReceivedLabel: 'Sorted by date received (oldest first)',
			registrationRequestLoadMoreButton: 'Load More',
			registrationRequestLoadingMore: 'Loading more…',
			registrationRequestEndOfList: 'End of list',
			registrationRequestEmptyHeading: 'No requests match these filters',
			registrationRequestEmptyBody: 'Try a different status or source.',
			registrationRequestEmptyHeadingNoFilters: 'No registration requests yet',
			registrationRequestEmptyBodyNoFilters:
				'Requests submitted through any sync method will appear here for review.',
			registrationRequestBulkImportSyncButton: 'Bulk Import / Sync',
			registrationRequestPreviouslyRejectedFlag: 'Previously rejected',
			registrationRequestReceivedAtLabel: 'Received',
			registrationRequestClaimedSubmittedAtLabel: 'Claimed sent',
			registrationRequestScopeReadOnlyBanner:
				'Viewing only. You need the {{scope}} permission to review registration requests.',
			registrationRequestScopeReadOnlyNoOfficerBanner:
				'Viewing only. You are not a registered officer of this authority, so changes are disabled.',
			registrationRequestStatusPending: 'Pending',
			registrationRequestStatusApproved: 'Approved',
			registrationRequestStatusRejected: 'Rejected',
			// Phase 48 (D-06/D-07) — registrationRequestApproval* group; copy verbatim from 48-UI-SPEC.md § Copywriting Contract.
			registrationRequestApprovalScreenTitle: 'Request Detail',
			registrationRequestApprovalSummaryTitle: 'Request',
			registrationRequestApprovalReceivedAtLabel: 'Received',
			registrationRequestApprovalSubmittedAtLabel: 'Claimed sent',
			registrationRequestApprovalRequesterKeyLabel: 'Requester Key',
			registrationRequestApprovalApproveButton: 'Approve Registration',
			registrationRequestApprovalRejectButton: 'Reject Request',
			registrationRequestApprovalApprovedByLabel: 'Approved by {{officer}} on {{date}}',
			registrationRequestApprovalViewRegistrantButton: 'View Registrant',
			// Phase 48 (D-06) — registrationRequestReject* group; copy verbatim from 48-UI-SPEC.md § Copywriting Contract.
			registrationRequestRejectTitle: 'Reject this request?',
			registrationRequestRejectBody:
				'This will be recorded permanently with your name attached. If {{name}} submits again, this rejection and your reason will be shown to whoever reviews it next.',
			registrationRequestRejectReasonPlaceholder: 'Reason for rejection',
			registrationRequestRejectConfirmButton: 'Confirm Rejection',
			registrationRequestRejectKeepReviewingButton: 'Keep Reviewing',
			// Phase 48 (D-03) — bridgeSource* group; copy verbatim from 48-UI-SPEC.md § Copywriting Contract.
			bridgeSourceBadgeLabel: 'Bridge Import',
			bridgeSourceCalloutHeading: 'Submitted by an import bridge',
			bridgeSourceCalloutBody:
				"This request was signed by {{bridgeLabel}}, an import bridge, on the submitter's behalf. It is the bridge's assertion, not a signature from the registrant themselves. Verify accordingly.",
			// Phase 48 (D-07) — verificationChecklist* group; copy verbatim from 48-UI-SPEC.md § Copywriting Contract.
			verificationChecklistSectionTitle: 'Out-of-Band Verification',
			verificationChecklistItemId: 'Verified government-issued photo ID',
			verificationChecklistItemRoll: 'Checked against existing voter roll',
			verificationChecklistItemEligibility:
				'Confirmed eligibility (age, residency, citizenship per policy)',
			verificationChecklistItemNone: 'No additional out-of-band verification performed',
			verificationChecklistBindingNotice:
				'This checklist becomes part of your signed approval and cannot be changed afterward.',
			verificationChecklistDecidedAtLabel: 'Recorded at decision',
			// Phase 48 (D-06) — priorRejections* group; copy verbatim from 48-UI-SPEC.md § Copywriting Contract.
			priorRejectionsCalloutHeading: 'This requester was rejected before',
			priorRejectionsCalloutRow: 'Rejected {{date}} by {{officer}} — {{reason}}',
			// Phase 48 (D-09) — transparencyStats* group; copy verbatim from 48-UI-SPEC.md § Copywriting Contract.
			transparencyStatsSectionTitle: 'Transparency',
			transparencyStatsPendingLabel: 'Pending',
			transparencyStatsApprovedLabel: 'Approved',
			transparencyStatsRejectedLabel: 'Rejected',
			transparencyStatsMedianTimeLabel: 'Median time to decision',
			transparencyStatsMedianTimeUnknown: 'Not enough data yet',
			// Phase 48 (D-01/D-11) — bulkImportSync* group; copy verbatim from 48-UI-SPEC.md § Copywriting Contract.
			bulkImportSyncScreenTitle: 'Bulk Import / Sync',
			bulkImportSyncFilesystemHeading: 'Filesystem',
			bulkImportSyncRestHeading: 'Webhook / REST',
			bulkImportSyncP2pHeading: 'Peer-to-Peer (Experimental)',
			bulkImportSyncP2pBody:
				'This sync method is still under development and has not been verified to work reliably. Use Filesystem or REST sync for dependable results.',
			bulkImportSyncNeverSyncedBody: 'Not synced yet',
			bulkImportSyncSyncedBody: 'Sync completed.',
			bulkImportSyncErrorBody:
				'Sync failed. No sync method is connected, or the connected one could not be reached.',
			// bulkImportSyncLastSyncedLabel is no longer a body key — it is a separate line rendered
			// only when a real timestamp exists (48-UAT.md gap 1).
			bulkImportSyncLastSyncedLabel: 'Last successful sync {{date}}',
			bulkImportSyncImportedCountLabel: '{{count}} imported',
			bulkImportSyncPendingCountLabel: '{{count}} pending review',
			bulkImportSyncErrorCountLabel: '{{count}} errors',
			bulkImportSyncNowButton: 'Sync Now',
			bulkImportSyncP2pTryButton: 'Try Peer Sync (Experimental)',
			bulkImportSyncErrorsSectionTitle: 'Sync Errors',
		},
	},
	es: {
		translation: {
			elections: 'Elecciones',
			tasks: 'Tareas', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			authorities: 'Autoridades',
			signers: 'Firmantes',
			settings: 'Ajustes',
			account: 'Cuenta',
			appearance: 'Apariencia',
			language: 'Idioma',
			about: 'Acerca de',
			dark: 'Oscuro',
			light: 'Claro',
			english: 'Inglés',
			recentNetworks: 'Redes Recientes',
			connectedNetworks: 'Redes Conectadas',
			directAdvanced: 'Directo (avanzado)',
			or: 'O',
			// Phase 8 plan 08-05 (NETUI-01): empty-state hint when no recents.
			noRecentNetworks: 'Aún no hay redes recientes. Encuentra una abajo para comenzar.',
			find: 'Buscar',
			scanQrCode: 'Escanear Código QR',
			enterBootstrap: 'Ingresar Bootstrap (avanzado)',
			useLocation: 'Usar Ubicación',
			scan: 'Escanear',
			useBootstrap: 'Usar Bootstrap',
			enterAddressOrLocation: 'Ingresar dirección o ubicación...',
			enterBootstrapPlaceholder: 'Ingresar bootstrap...',
			syncConnected: 'Conectado',
			syncSyncing: 'Sincronizando',
			syncOffline: 'Sin conexión',
			invalidBootstrapAddress: 'Dirección de bootstrap no válida',
			joinFailed: 'No se pudo unir a la red',
			qrScanUnavailable: 'El escaneo de QR aún no está disponible',
			cameraPermissionMessage: 'Necesitamos tu permiso para mostrar la cámara',
			grantPermission: 'Permitir',
			close: 'Cerrar',
			addAuthority: 'Agregar Autoridad',
			noPinnedAuthorities: 'No hay autoridades marcadas',
			noAuthoritiesFound: 'No se encontraron autoridades',
			filterAuthorities: 'Filtrar autoridades...',
			authority: 'Autoridad',
			administration: 'Administración',
			pin: 'Marcar',
			unpin: 'Desmarcar',
			handoff: 'Pasar',
			name: 'Nombre',
			domainName: 'Nombre de Dominio',
			domain: 'Dominio',
			sid: 'SID',
			cid: 'CID',
			address: 'Dirección',
			signature: 'Firma',
			coreSignature: 'Firma Principal',
			revisionSignature: 'Firma de Revisión',
			priorCid: 'CID Anterior',
			handoffSignature: 'Firma de Transferencia',
			handoffSignatures: 'Firmas de Transferencia',
			invitedAuthorities: 'Autoridades Invitadas',
			inviteAuthority: 'Invitar Autoridad',
			valid: 'válida',
			of: 'de',
			createUser: 'Crear Usuario',
			invitingAuthority: 'Autoridad Invitante',
			invitingAdministrator: 'Administrador Invitante',
			newAuthority: 'Nueva Autoridad',
			invitationName: 'Nombre de Invitación',
			invitationKey: 'Clave de Invitación',
			soleInitialAdministratorNote:
				'Cree un usuario en esta red. Su usuario será el único administrador inicial.',
			userIsSoleAdministratorNote:
				'El siguiente perfil de usuario será el único administrador inicial de la nueva autoridad.',
			expires: 'Expira',
			position: 'Cargo',
			switchingNetworks: 'Cambiando redes...',
			officer: 'Oficial',
			nameOnInvitation: 'Nombre en la invitación (reemplazado con el nombre del usuario)',
			officialTitle: 'Título oficial',
			key: 'Clave',
			scopes: 'Alcances',
			signatures: 'Firmas',
			proposeReplacement: 'Proponer Reemplazo',
			id: 'ID',
			title: 'Título',
			useOneOfTheFollowingToGetConnected: 'Usa una de las siguientes para conectarte:',
			addNetwork: 'Agregar Red',
			createNewNetwork: 'Crear una nueva red:',
			electionCharacteristics: 'Características de la Elección',
			useKeyholders: 'Usar custodios',
			noKeyholders: 'Sin custodios',
			singleAuthority: 'Autoridad única',
			multiple: 'Múltiple',
			multipleAuthorityNotYetSupported: 'Múltiple (aún no soportado)',
			mustSignBeforeCreating: 'Debe firmar antes de crear la red.',
			atLeastOneKeyholderRequired: 'Se requiere al menos un custodio.',
			invalidDate: 'Ingrese una fecha válida.',
			errAuthorityNameRequired: 'Ingrese un nombre de autoridad.',
			creating: 'Creando…',
			networkCreateTimeout:
				'La creación de la red expiró en el paso {{step}}. Verifique su conexión e inténtelo de nuevo.',
			errRelayRequired:
				'Agregue al menos una dirección de relay en Avanzado → Agregar relay antes de crear la red.',
			validationFailed: 'Error de validación.',
			errTitleRequired: 'Ingrese un título para la elección.',
			errElectionDateRequired: 'Elija una fecha para la elección.',
			errRevisionDeadlineRequired: 'Elija una fecha límite de revisión.',
			errElectionDateInvalid: 'Ingrese una fecha de elección válida.',
			errRevisionDeadlineInvalid: 'Ingrese una fecha límite de revisión válida.',
			errRevisionDeadlineAfterDate:
				'La fecha límite de revisión debe ser igual o anterior a la fecha de la elección.',
			errElectionDateTooSoon:
				'La fecha de la elección es demasiado pronto: elija una fecha igual o posterior al {{date}} para que la fecha límite de boletas quede antes.',
			errBallotDeadlineAfterDate:
				'La fecha de la elección es demasiado pronto para la fecha límite de boletas. Elija una fecha de elección posterior.',
			errTimelineOrder:
				'Ordene el cronograma para que la votación comience antes del recuento, y el recuento antes de la certificación.',
			errThresholdExceedsKeyholders:
				'El umbral de firmas no puede ser mayor que el número de custodios.',
			errCouldNotSaveElection:
				'No se pudo guardar la elección. Revise las fechas e intente de nuevo.',
			initialAdministrator: 'Administrador Inicial',
			imageUrl: 'URL de Imagen',
			makePermanent: 'Hacer Permanente',
			optionalImageAddress: 'Dirección de imagen opcional',
			primaryAuthority: 'Autoridad Primaria',
			authorityName: 'Nombre de la autoridad',
			authorityImageUrl: 'URL de la imagen de la autoridad',
			domainNameOptional: 'Nombre de Dominio (opcional)',
			initialOfficer: 'Oficial Inicial',
			yourNameOnPermanentRecord: 'Tu nombre (en registro permanente)',
			yourTitleOnPermanentRecord: 'Tu título (en registro permanente)',
			sign: 'FIRMAR',
			createNetwork: 'Crear Red',
			relays: 'Relays',
			multiaddress: 'Multiaddress',
			advanced: 'Avanzado',
			import: 'Importar',
			addRelay: 'Agregar Relay',
			addTsa: 'Agregar TSA',
			statistics: 'Estadísticas',
			estimatedNodes: 'Nodos Estimados:',
			estimatedServers: 'Servidores Estimados:',
			hostMyOwn: 'Hostear mi propio',
			configuration: 'Configuración',
			seeInstructions: 'Ver',
			votetorrentInstructions: 'Instrucciones de VoteTorrent',
			forConfiguringAServer: 'para configurar un servidor.',
			useHostingProvider: 'Usar Proveedor de Hosting',
			addProvider: 'Agregar proveedor',
			hosting: 'Hosting',
			addServers: 'Agregar Servidores',
			addServersToThisNetwork: 'Agregar servidores a esta red:',
			createProposedReplacement: 'Crear una propuesta de reemplazo de administración:',
			addOfficer: 'Agregar Oficial',
			createProposal: 'Crear Propuesta',
			noNetworkTitle: 'Elige una red para comenzar',
			noNetwork:
				'Toca «Seleccionar Red» en la parte superior para unirte a una red existente, o crea la tuya propia.',
			selectNetwork: 'Seleccionar Red',
			remove: 'Eliminar',
			permissions: 'Permisos',
			publicKey: 'Clave Pública',
			proposedAdministration: 'Administración Propuesta',
			share: 'Compartir',
			reviseAdministration: 'Revisar Administración',
			authorization: 'Autorización',
			adjustProposal: 'Ajustar Propuesta',
			serverConfigurationPlaceholder: '{"red": { "nombre": ...',
			inviteId: 'ID de Invitación',
			showHelpIcons: 'Mostrar iconos de ayuda',
			defaultUser: 'Usuario predeterminado',
			connectDevice: 'Conectar este dispositivo\na usuario existente', // Phase 11 plan 11-03 (D-10) — line-break for ES overflow.
			connect: 'Conectar',
			enterName: 'Ingrese el nombre',
			enterImageUrl: 'Ingrese la URL de la imagen',
			unknownUser: 'Usuario desconocido',
			noUserFound: 'No se encontró usuario para esta red',
			user: 'Usuario',
			noDefaultUserFound: 'No se encontró usuario predeterminado',
			activeKeys: 'Claves Activas',
			type: 'Tipo',
			expiration: 'Expiración',
			reviseUser: 'Revisar Usuario',
			addKey: 'Agregar Clave',
			revokeKey: 'Revocar Clave',
			history: 'Historial',
			create: 'Crear',
			revise: 'Revisar',
			mobile: 'Móvil',
			yubico: 'Yubico',
			addAnotherDeviceQrCode:
				'Para agregar otro dispositivo usando un código QR, instala la aplicación de Autoridad en ese dispositivo, ve a ajustes, presiona "Agregar este dispositivo a usuario existente", crea una clave usando tus biometrías, luego escanea el código QR resultante usando el botón de abajo.',
			scanDevice: 'Escanear Dispositivo',
			addYubicoDongleKey: 'Agregar Clave Yubico (dongle)',
			detailedInstructions: 'Instrucciones detalladas',
			addYubicoInstructions:
				'Inserta o sostén junto a un dongle Yubico, luego presiona este botón:',
			generateExternalKey: 'Generar Clave Externa',
			successfullyScannedKey: 'Clave escaneada exitosamente',
			signed: 'Firmada',
			unchanged: 'Sin cambios',
			revoke: 'Revocar',
			revokeKeySignatureInvalid:
				'Esta revocación no pudo verificarse y no se aplicó.',
			// D-13/D-14/D-16: ver el bloque EN equivalente (mismas claves) para el
			// contexto completo — 49-UI-SPEC.md's Copywriting Contract.
			deviceSigningPromptTitle: 'Confirma tu identidad',
			deviceSigningPromptSubtitle: 'Verifica para firmar esta acción',
			deviceSigningPromptNegativeButton: 'Cancelar',
			signingKeyProvisioningPromptSubtitle: 'Verifica para configurar la firma segura',
			signingKeyRecoveryPromptSubtitle:
				'Verifica con el PIN, patrón o contraseña de tu dispositivo para reemplazar tu clave de firma',
			deviceSigningErrorNoBiometricsEnrolled:
				'Este dispositivo no tiene biometría registrada. Registra una huella o el rostro en la configuración del dispositivo e inténtalo de nuevo.',
			deviceSigningErrorLockout: 'Demasiados intentos. Espera un momento e inténtalo de nuevo.',
			deviceSigningErrorLockoutPermanent:
				'La verificación biométrica está bloqueada. Desbloquea tu dispositivo con el PIN, patrón o contraseña para restablecerla, luego inténtalo de nuevo.',
			deviceSigningErrorGeneric: 'No se pudo verificar tu biometría. Inténtalo de nuevo.',
			deviceSigningErrorRecoveryKeyInvalidated:
				'La clave de recuperación de este dispositivo ya no se puede usar — se invalidó junto con tu clave de firma. Contacta a un administrador para volver a invitar este dispositivo.',
			deviceSigningErrorRecoveryKeyNotRegistered:
				'Tu clave de recuperación nunca se registró en esta red. Ve a Configuración y toca "Configurar Firma Segura" mientras estás conectado a tu red, luego intenta la recuperación de nuevo.',
			signingKeyProvisioningScreenTitle: 'Configuración de Firma Segura',
			signingKeyProvisioningFirstRunHeading: 'Configura la firma respaldada por hardware',
			signingKeyProvisioningFirstRunBody:
				'Tu firma de funcionario será producida por una clave almacenada en el hardware seguro de este dispositivo y protegida por tu biometría. La clave nunca sale del dispositivo.',
			signingKeyProvisioningSetupButton: 'Configurar Firma Segura',
			signingKeyProvisioningPending: 'Configurando tu clave de firma…',
			signingKeyProvisioningSuccessHeading: 'Clave de firma lista',
			signingKeyProvisioningSuccessBody: 'Ahora puedes firmar acciones de funcionario con tu biometría.',
			signingKeyProvisioningAwaitingNetworkHeading: 'La firma segura está configurada en este dispositivo',
			signingKeyProvisioningAwaitingNetworkBody:
				'Tu clave de firma está protegida por tu biometría. Selecciona o crea una red para terminar de registrarla.',
			signingKeyProvisioningContinueButton: 'Volver a la Aplicación',
			signingKeyProvisioningNetworkUserUnresolvedHeading: 'No pudimos encontrar tu cuenta en esta red',
			signingKeyProvisioningNetworkUserUnresolvedBody:
				'Este dispositivo está conectado, pero tu cuenta de funcionario aún no ha terminado de sincronizarse con esta red. Espera un momento e inténtalo de nuevo.',
			signingKeyProvisioningNetworkUserUnresolvedRetryButton: 'Intentar de Nuevo',
			signingKeyProvisioningRecoveryHeading: 'Tu clave de firma debe reemplazarse',
			signingKeyProvisioningRecoveryBody:
				'La biometría de tu dispositivo cambió, lo que invalidó tu clave de firma anterior por seguridad. Verifica con el PIN, patrón o contraseña de tu dispositivo para firmar una clave de reemplazo.',
			signingKeyProvisioningRecoveryButton: 'Reemplazar Clave de Firma',
			signingKeyProvisioningRecoveryPending: 'Reemplazando tu clave de firma…',
			signingKeyProvisioningNoRecoveryHeading: 'Este dispositivo ya no tiene bloqueo de pantalla',
			signingKeyProvisioningNoRecoveryBody:
				'Tanto tu clave de firma como su clave de recuperación estaban protegidas por el bloqueo de pantalla de tu dispositivo, que fue eliminado. No se pueden recuperar en este dispositivo — pídele a un funcionario que invite a este dispositivo nuevamente.',
			signingKeyProvisioningRecoveryUnsupportedOsHeading: 'La recuperación no está disponible en esta versión de Android',
			signingKeyProvisioningRecoveryUnsupportedOsBody:
				'Reemplazar una clave de firma requiere Android 11 o una versión más reciente. Este dispositivo usa una versión anterior, por lo que su clave de firma no se puede reemplazar aquí — pídele a un funcionario que invite a este dispositivo nuevamente.',
			settingsSigningKeyRow: 'Firma Segura',
			warningIrrevocableAction:
				'¡ATENCIÓN: Esta es una acción irrevocable; proceda con precaución.',
			typeIConfirm: 'Escribe "Confirmo" para continuar',
			confirmIfSure: '"Confirmo" si estás seguro',
			iConfirm: 'Confirmo',
			addDevice: 'Agregar Dispositivo',
			qrInformation: 'Información del Código QR',
			token: 'Token',
			fromOtherDevice:
				'Desde el otro dispositivo, selecciona el usuario, presiona Agregar Clave, escanea, usando el siguiente código QR:',
			select: 'Seleccionar',
			hash: 'Hash',
			requiredTimestampAuthorities: 'Autoridades de Temporizador Requeridas',
			timestampAuthorities: 'Autoridades de Temporizador',
			// Phase 8 plan 08-05 (NETUI-02): label used in the Proposed Changes diff row.
			electionType: 'Tipo de Elección',
			reviseNetwork: 'Revisar Red',
			servers: 'Servidor(es)',
			proposedChanges: 'Cambios Propuestos',
			network: 'Red',
			onboardingTasks: 'Tareas de Inscripción',
			keysToRelease: 'Claves a Liberar',
			requestedSignatures: 'Firmas Requeridas',
			date: 'Fecha',
			revisionDeadline: 'Fecha de Revisión',
			registrationEnds: 'Finaliza Registro',
			ballotsFinal: 'Boletas Finales',
			votingStarts: 'Inicia Votación',
			tallyingStarts: 'Inicia el Recuento', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			validation: 'Validación',
			certificationStarts: 'Inicia Certificación',
			closed: 'Cerrado',
			revision: 'Revisión',
			tags: 'Etiquetas',
			timeline: 'Cronograma',
			keyholderThreshold: 'Umbral de Custodios', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			keyholderPolicy: 'Política de Custodios', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			official: 'Oficial',
			adhoc: 'Ad-hoc',
			dateTime: 'Fecha/hora',
			sent: 'Enviada',
			unsent: 'No enviada',
			accepted: 'Aceptado',
			invite: 'Invitar',
			administrators: 'Administradores',
			pending: 'Pendiente',
			accept: 'Aceptar',
			reject: 'Rechazar',
			networkRevision: 'Revisión de Red',
			proposalTimestamp: 'Marca de tiempo de la propuesta',
			informational: 'informativo',
			noProposedElectionsCurrently: 'No hay elecciones propuestas actualmente',
			ready: 'Listo',
			remaining: 'restante',
			keyholderRelease: 'Liberación de Custodio', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			release: 'Liberar',
			createElection: 'Crear Elecciones',
			proposedElections: 'Elecciones Propuestas',
			noCurrentElections: 'No hay elecciones actuales',
			noProposedElections: 'No hay elecciones propuestas',
			electionHistory: 'Historial de Elecciones',
			preview: 'Vista Previa',
			election: 'Elección',
			keyholders: 'Custodios', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			cloneElection: 'Clonar Elecciones',
			reviseElection: 'Revisar Elecciones',
			ballotTemplates: 'Plantillas de Boletas',
			pendingBallotTemplates: 'Plantillas de Boletas Pendientes',
			noAssociatedAuthoritiesHaveTemplates:
				'No hay autoridades con las que estés asociado que hayan enviado plantillas de boletas para esta elección.',
			noBallotTemplates: 'No hay plantillas de boletas enviadas para esta elección.',
			createBallotTemplate: 'Crear Plantilla de Boletas',
			more: 'Más',
			reviseAuthority: 'Revisar Autoridad',
			ballotTemplate: 'Plantilla de Boletas',
			description: 'Descripción',
			addQuestion: 'Agregar Pregunta',
			districtsGroups: 'Distritos / Grupos',
			clearAll: 'Limpiar Todo',
			addRange: 'Agregar Rango',
			propose: 'Proponer',
			// Phase 7 foundation keys (07-01) — Phase 11 plan 11-01 (D-11) — Spanish backfill.
			adminRevision: 'Revisión de Admin', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			authorityRevision: 'Revisión de Autoridad', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			electionRevision: 'Revisión de Elección', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			ballotRevision: 'Revisión de Boleta', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			allNetworks: 'Todas las Redes', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			noTasks: 'Sin tareas', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			noTasksHelper: 'No tienes tareas pendientes.', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			chipSignature: 'Firma', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			chipRelease: 'Liberar', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			chipOnboarding: 'Incorporación', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			closeScreen: 'Cerrar pantalla', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			proposal: 'Propuesta', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			details: 'Detalles', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			policies: 'Políticas', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			admin: 'Administrador', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			image: 'Imagen', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			electionTitle: 'Título de la Elección', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			// Phase 7 onboarding keys (07-05) — Phase 11 plan 11-01 (D-11) — Spanish backfill.
			screenScaffoldsDebugTitle: 'Depuración de Incorporación', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			screenScaffoldsDebugIntro:
				'Puntos de entrada directos a las seis pantallas de incorporación. Ruta temporal de desarrollo; reemplazada por llamadas reales en las fases 8–10.', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			// Phase 8 gap-closure 08-07 — interim accept/send-mode invitation entries
			debugAdministratorInvitationAccept: 'Invitación de administrador (aceptar)',
			debugAuthorityInvitationSend: 'Invitación de autoridad (enviar)',
			debugAuthorityInvitationAccept: 'Invitación de autoridad (aceptar)',
			editElectionTitle: 'Invitación Enviada', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			editElectionBodyPrimary:
				'Tu invitación ha sido enviada. Se te notificará cuando el destinatario responda.', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			editElectionBodySecondary: 'Si no se recibe respuesta pronto, puedes reenviar la invitación.', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			editElectionResend: 'Reenviar Invitación', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			editElectionBackToTasks: 'Volver a Tareas', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			authorityDetailTitle: 'Esperando Respuesta', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			authorityDetailBodyPrimary: 'Esperando que el destinatario responda tu invitación.', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			authorityDetailBodySecondary:
				'Puedes reenviar la invitación o cancelarla si ya no es necesaria.', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			authorityDetailResend: 'Reenviar Invitación', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			authorityDetailCancelInvitation: 'Cancelar Invitación', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			editElectionWithFilterTitle: 'Solicitud Enviada', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			editElectionWithFilterBodyPrimary: 'Tu solicitud ha sido enviada exitosamente.', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			editElectionWithFilterGotIt: 'Entendido', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			editRevisionFormTitle: 'Esperando Aprobación', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			editRevisionFormBodyPrimary:
				'Tu envío está pendiente de aprobación por parte de la autoridad.', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			editRevisionFormBodySecondary: 'Recibirás una notificación una vez que sea revisado.', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			editRevisionFormResend: 'Reenviar Solicitud', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			editRevisionFormDismissRequest: 'Descartar Solicitud', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			proposedElectionTitle: 'Solicitud de Liberación Enviada', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			proposedElectionBodyPrimary:
				'Tu solicitud de liberación de clave ha sido entregada a los custodios.', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			proposedElectionBackToTasks: 'Volver a Tareas', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			proposedRevisionTitle: 'Esperando Liberación', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			proposedRevisionBodyPrimary: 'Esperando que los custodios completen la liberación.', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			proposedRevisionBodySecondary: 'Puedes reenviar la solicitud de liberación o cancelarla.', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			proposedRevisionResendRequest: 'Reenviar Solicitud', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			proposedRevisionCancelRequest: 'Cancelar Solicitud', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			// Phase 8 plan 08-01 — Phase 11 plan 11-01 (D-11) — Spanish backfill.
			noAuthorities: 'Sin autoridades', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			noAuthoritiesHelper: 'Las autoridades a las que te unes o marcas aparecerán aquí.', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			manageProposal: 'Gestionar Propuesta', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			// Phase 8 plan 08-02 — Phase 11 plan 11-01 (D-11) — Spanish backfill.
			thresholdPolicies: 'Políticas de Umbral', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			addAdministrator: 'Agregar Administrador', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			scope_rnp: 'Revisar Políticas de Red', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			loading: 'Cargando...', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			// Phase 8 plan 08-03 — Phase 11 plan 11-01 (D-11) — Spanish backfill.
			administrator: 'Administrador', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			administratorInvitation: 'Invitación de Administrador', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			authorityInvitation: 'Invitación de Autoridad', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			sendInvitation: 'Enviar Invitación', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			invitation: 'Invitación', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			send: 'Enviar', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			decline: 'Rechazar', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			userId: 'ID de Usuario', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			// Phase 9 plan 09-01 (ELECUI-01/02/05) — Phase 11 plan 11-01 (D-11) — Spanish backfill.
			noHistoryFound: 'No se encontró historial.', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			noBallotYet: 'Aún no se ha creado una boleta para esta elección.', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			createBallot: 'Crear Boleta', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			viewBallot: 'Ver Boleta', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			registrationOpens: 'Abre el Registro', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			registrationCloses: 'Cierra el Registro', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			votingOpens: 'Inicia la Votación', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			votingCloses: 'Cierra la Votación', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			// Phase 9 plan 09-02 (ELECUI-03) — Create Election wizard — Phase 11 plan 11-01 (D-11) — Spanish backfill.
			basics: 'Básico', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			review: 'Revisar', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			next: 'Siguiente', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			back: 'Atrás', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			edit: 'Editar', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			step: 'Paso', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			addTag: 'Agregar etiqueta (separadas por coma)', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			registrationDeadline: 'Fecha Límite de Registro', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			selectKeyholders: 'Selecciona custodios para esta elección:', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			noKeyholdersSelected: 'No se han seleccionado custodios.', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			authorityPlaceholder: 'Seleccionar autoridad', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			addDistrictCode: 'Agregar código de distrito', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			itemsRangeCount: '{{from}}–{{to}} de {{total}} elementos', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			// Phase 9 plan 09-04 (BALUI-01..04) — Ballot Question/Option — Phase 11 plan 11-01 (D-11) — Spanish backfill.
			save: 'Guardar', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			code: 'Código', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			question: 'Pregunta', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			option: 'Opción', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			addOption: 'Agregar Opción', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			questionNeedsTwoOptions: 'Las preguntas de opción necesitan al menos dos opciones.',
			rank: 'Rango', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			score: 'Puntuación', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			text: 'Texto', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			additionalInstructions: 'Instrucciones Adicionales', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			dependsOn: 'Depende de', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			addDependency: 'Agregar Dependencia', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			additionalDetails: 'Detalles Adicionales', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			informationUrl: 'URL de Información', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			videoUrl: 'URL de Video', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			optionalVideoAddress: 'Dirección de video opcional', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			// Phase 9 plan 09-07 (BALUI-03/04) — Phase 11 plan 11-01 (D-11) — Spanish backfill.
			ballotQuestion: 'Pregunta de Boleta', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			questionOption: 'Opción de Pregunta', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			selectionLimits: 'Límites de Selección', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			min: 'Mín', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			max: 'Máx', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			forceOrder: 'Orden Obligatorio', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			required: 'Obligatorio', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			group: 'Grupo', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			sequence: 'Secuencia', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			groupPlaceholder: 'condado/escaños', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			// Phase 9 plan 09-10 — mock authority dropdown — Phase 11 plan 11-01 (D-11) — Spanish backfill.
			mockAuthorityA: 'Autoridad Mock A', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			mockAuthorityB: 'Autoridad Mock B', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			// Phase 9 plan 09-11 (ELECUI-03/04) — election form — Phase 11 plan 11-01 (D-11) — Spanish backfill.
			newElection: 'Nueva Elección', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			electionRevisionTitle: 'Revisión de Elección', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			coreSectionHeader: 'Principal (no se puede cambiar una vez aprobado)', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			initialRevisionHeader: 'Revisión Inicial (puede cambiar)', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			proposedRevisionHeader: 'Revisión Propuesta', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			coreDateHelp: 'La fecha principal de la elección', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			revisionDeadlineHelp: 'Última fecha/hora en que se permiten cambios', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			releasingKeys: 'Liberando Claves', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			selectDate: 'Seleccionar fecha', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			keyHolders: 'Custodios de Clave', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			addKeyHolder: 'Agregar Custodio', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			thresholdPolicy: 'Política de Umbral', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			thresholdValue: '{{n}} de {{m}}', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			instructions: 'Instrucciones', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			instructionsOptional: 'Instrucciones (opcional)', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			keyholderName: 'Nombre del custodio', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			adjustRevision: 'Ajustar Revisión', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			signRevision: 'Firmar', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			shareRevision: 'Compartir', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			previewBallots: 'Previsualizar…', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			questionsLabel: 'Preguntas', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			validForAuthority: '[válido para {{authority}}]', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			filterAuthoritiesField: 'Filtrar autoridades...', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			// Phase 21 plan 21-07 (UKEY-03) — D-15 copy: external-key honest-state strings
			scanDeviceNotAvailable: 'Requiere un dispositivo emparejado',
			generateExternalKeyNotAvailable: 'Requiere un dispositivo con clave de hardware',
			// Phase 10 plan 10-01 (USRUI-05/09) — Phase 11 plan 11-01 (D-11) — Spanish backfill.
			addedKey: 'Clave Agregada', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			noActiveKeysFound: 'No se encontraron claves activas.', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			addedDevice: 'Dispositivo Agregado', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			deviceAdded: 'Dispositivo Añadido', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			done: 'Listo', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			// Phase 10 plan 10-02 (KHUI-01/02) — Phase 11 plan 11-01 (D-11) — Spanish backfill.
			keyholder: 'Custodio de Clave', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			keyholderInvitation: 'Invitación de Custodio', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			debugKeyholderInvitationSend: 'Invitación de Custodio (Enviar)', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			debugKeyholderInvitationAccept: 'Invitación de Custodio (Aceptar)', // Phase 11 plan 11-01 (D-11) — Spanish backfill.
			// D-03/D-05/D-09 ballot confirmation actions (31-05)
			submitForConfirmation: 'Enviar para confirmación',
			withdrawConfirmation: 'Retirar',
			statusProposed: 'Propuesto',
			statusConfirmed: 'Confirmado',
			// Debug seed keys — Spanish mirrors
			debugSeedTasksTitle: 'Sembrar Tareas Pendientes (Debug)',
			debugSeedTasksSuccess: 'Tareas pendientes sembradas — ver pestaña Tareas',
			debugSeedTasksError: 'Error al sembrar: ',
			// Phase 39 plan 39-04 (DEBT-09 app-Jest gate) — DistrictsGroupsEditor range fields.
			from: 'Desde',
			to: 'Hasta',
			add: 'Agregar',
			cancel: 'Cancelar',
			// Phase 46 (D-11) — registrationPolicy* group; copy verbatim from 46-UI-SPEC.md § Copywriting Contract.
			// Navigation entry (D-11)
			registrationPolicyEntryTitle: 'Política de Registro',
			// Screen header / section titles (D-11)
			registrationPolicyFieldsSectionTitle: 'Campos',
			registrationPolicyDisclosureSectionTitle: 'Divulgación',
			registrationPolicyAttestationSectionTitle: 'Certificación',
			registrationPolicyIssuesSectionTitle: 'Problemas de la Política',
			// Scope gate (D-10) (D-11)
			registrationPolicyReadOnlyBanner:
				'Solo visualización. Necesitas el permiso {{scope}} para cambiar esta política.',
			registrationPolicyReadOnlyNoOfficerBanner:
				'Solo visualización. No eres un funcionario registrado de esta autoridad, así que los cambios están desactivados.',
			// Field editor (D-02) (D-11)
			registrationPolicyKnownFieldLastName: 'Apellido',
			registrationPolicyKnownFieldFirstName: 'Nombre',
			registrationPolicyDistrictFieldLabel: 'Distrito',
			registrationPolicyDistrictFieldHint: 'Solo si esta elección usa distritos',
			registrationPolicyCustomFieldOption: 'Personalizado…',
			registrationPolicyCustomFieldPlaceholder: 'Nombre del campo',
			registrationPolicyExtraFieldBadge: 'Campo Adicional',
			registrationPolicyExtraFieldHint:
				'Se guarda en Campos Adicionales, no en una columna dedicada',
			registrationPolicyTierLabel: 'Visibilidad',
			registrationPolicyTierPublic: 'Público',
			registrationPolicyTierSelective: 'Selectivo',
			registrationPolicyTierPrivate: 'Privado',
			registrationPolicyRequirementRequired: 'Obligatorio',
			registrationPolicyRequirementOptional: 'Opcional',
			registrationPolicyAddFieldButton: 'Agregar Campo',
			registrationPolicyNoFieldsHeading: 'Aún no hay campos configurados',
			registrationPolicyNoFieldsBody:
				'Agrega un campo arriba para definir lo que deben proporcionar los registrantes.',
			// Disclosure editor (D-03/D-04/D-05) (D-11)
			registrationPolicyAudienceLabel: 'Audiencia',
			registrationPolicyAudienceEveryone: 'Todos',
			registrationPolicyAudienceDistrict: 'Mismo distrito (votantes vecinos)',
			registrationPolicyAudienceNotSet: 'Sin definir',
			registrationPolicyAudienceDistrictUnavailableHint:
				'La divulgación por mismo distrito aún no está disponible — requiere AMBAS cosas: un campo Distrito declarado arriba Y una plantilla de boleta de esta elección que declare distritos.',
			registrationPolicyNoDisclosureHeading: 'Aún no hay campos selectivos',
			registrationPolicyNoDisclosureBody:
				'Los campos de nivel selectivo que agregues arriba en Campos aparecerán aquí para que definas a quién se divulgan.',
			registrationPolicyOrphanDisclosureFlag: 'Divulgación huérfana:',
			registrationPolicyOrphanDisclosureBody:
				'Esta regla de audiencia no corresponde a ningún campo selectivo.',
			registrationPolicyMissingAudienceFlag: 'Sin audiencia definida:',
			registrationPolicyMissingAudienceBody:
				'Este campo selectivo no puede divulgarse a nadie hasta que se defina una audiencia.',
			registrationPolicySetAudienceButton: 'Definir Audiencia',
			registrationPolicyRemoveButton: 'Eliminar',
			// Attestation editor — tri-state (D-07) (D-11)
			registrationPolicyAttestationNotConfiguredLabel: 'No configurado — obligatorio por defecto',
			registrationPolicyAttestationNotConfiguredBody:
				'No se ha definido una política, por lo que la certificación del dispositivo es OBLIGATORIA para esta elección (el valor predeterminado de falla-cerrada).',
			registrationPolicyAttestationRequiredLabel: 'Obligatorio',
			registrationPolicyAttestationRequiredBody:
				'La certificación del dispositivo es explícitamente obligatoria para esta elección.',
			registrationPolicyAttestationNotRequiredLabel: 'No obligatorio',
			registrationPolicyAttestationNotRequiredBody:
				'La certificación del dispositivo está explícitamente desactivada para esta elección.',
			registrationPolicyAttestationRequireButton: 'Exigir Certificación',
			registrationPolicyAttestationDontRequireButton: 'No Exigir Certificación',
			registrationPolicyAttestationRevertButton: 'Restablecer Predeterminado',
			// Policy editability window (D-13) (D-11)
			registrationPolicyConfirmTitle: '¿Cambiar la política de registro?',
			registrationPolicyConfirmRosterBody:
				'Esta elección ya tiene registrantes. Fueron validados contra la política anterior y no se volverán a validar.',
			registrationPolicyConfirmWindowOpenBody:
				'El registro ya está abierto para esta elección. Los registrantes que ya se inscribieron fueron validados contra la política anterior y no se volverán a validar.',
			registrationPolicyConfirmProceedButton: 'Continuar de Todos Modos',
			registrationPolicyConfirmCancelButton: 'Mantener Política Actual',
			// Per-row immediate-apply affordance (D-14) (D-11)
			registrationPolicyRowSaving: 'Guardando…',
			registrationPolicyRowSaved: 'Guardado',
			registrationPolicyRowError: 'No se pudo guardar',
			registrationPolicyRetryButton: 'Reintentar',
			// Phase 47 (D-04/D-05/D-07) — registrantList* group; copy verbatim from 47-UI-SPEC.md § Copywriting Contract.
			registrantListScreenTitle: 'Registrantes',
			registrantListRosterScreenTitle: 'Registrantes de {{electionTitle}}',
			registrantListSearchPlaceholder: 'Buscar por nombre',
			registrantListFilterStatusAll: 'Todos los Estados',
			registrantListFilterExpirationLabel: 'Vencimiento',
			registrantListFilterDistrictLabel: 'Distrito',
			registrantListCountLabel: 'Mostrando {{shown}} de {{total}}',
			registrantListCountUnknown: 'Mostrando {{shown}}',
			registrantListLoadMoreButton: 'Cargar Más',
			registrantListLoadingMore: 'Cargando más…',
			registrantListEndOfList: 'Fin de la lista',
			registrantListEmptyHeading: 'Ningún registrante coincide con estos filtros',
			registrantListEmptyBody: 'Prueba con un estado, distrito o término de búsqueda diferente.',
			registrantListEmptyHeadingNoFilters: 'Aún no hay registrantes',
			registrantListEmptyBodyNoFilters:
				'Los registrantes aparecerán aquí una vez que las personas se registren en esta autoridad.',
			// Phase 47 (D-10) — registrantStatus* group; copy verbatim from 47-UI-SPEC.md § Copywriting Contract.
			registrantStatusActive: 'Activo',
			registrantStatusSuspended: 'Suspendido',
			registrantStatusRevoked: 'Revocado',
			// Phase 47 (D-12/D-13/D-14) — registrantDetail* group; copy verbatim from 47-UI-SPEC.md § Copywriting Contract.
			registrantDetailScreenTitle: 'Registrante',
			registrantDetailPublicTierTitle: 'Público',
			registrantDetailSelectiveTierTitle: 'Selectivo',
			registrantDetailPrivateTierTitle: 'Privado',
			registrantDetailNoPublicTier: 'No hay detalles públicos registrados',
			registrantDetailNoSelectiveTier: 'No hay detalles selectivos registrados',
			registrantDetailNoPrivateTier: 'No hay detalles privados registrados',
			registrantDetailSignorKeyLabel: 'Firmado por',
			registrantDetailExpirationLabel: 'Vence',
			registrantDetailSelectiveAudiencePreviewTitle: 'Vista Previa de Audiencia',
			registrantDetailSelectiveAudiencePreviewHint:
				'Muestra lo que cada audiencia recibiría si esta elección divulga detalles selectivos.',
			registrantDetailSelectiveDisclosedLabel: 'Divulgado',
			registrantDetailSelectiveNotDisclosedLabel: 'No divulgado a esta audiencia',
			registrantDetailPrivateMaskedValue: '••••••',
			registrantDetailPrivateRevealHint: 'Toca para revelar',
			registrantDetailPrivateHideHint: 'Toca para ocultar',
			registrantDetailPrivateGateHeading: 'Los detalles privados requieren el permiso {{scope}}',
			// Phase 47 (D-10) — registrantLifecycle* group; copy verbatim from 47-UI-SPEC.md § Copywriting Contract.
			registrantLifecycleRenewButton: 'Renovar Registro',
			registrantLifecycleReinstateButton: 'Reincorporar a Activo',
			registrantLifecycleSuspendButton: 'Suspender Registrante',
			registrantLifecycleRevokeButton: 'Revocar Registro',
			registrantLifecycleRenewTitle: '¿Renovar registro?',
			registrantLifecycleRenewBody: 'Extiende el registro de {{name}} hasta {{newExpiration}}.',
			registrantLifecycleReinstateTitle: '¿Reincorporar a activo?',
			registrantLifecycleReinstateBody: 'Cambia el estado de {{name}} de {{oldStatus}} a Activo.',
			registrantLifecycleSuspendTitle: '¿Suspender a {{name}}?',
			registrantLifecycleSuspendBody:
				'Esto cambia de inmediato el estado de {{name}} a Suspendido. No hay deshacer automático — reincorporar requiere una acción firmada aparte. Escribe el nombre de {{name}} para confirmar.',
			registrantLifecycleRevokeTitle: '¿Revocar el registro de {{name}}?',
			registrantLifecycleRevokeBody:
				'Esto revoca de inmediato y de forma permanente el registro de votante de {{name}}. No hay deshacer. Escribe el nombre de {{name}} para confirmar.',
			registrantLifecycleTypedConfirmPlaceholder: 'Escribe {{name}} para confirmar',
			registrantLifecycleKeepCurrentStatus: 'Mantener Estado Actual',
			registrantLifecycleKeepCurrentExpiration: 'Mantener Vencimiento Actual',
			registrantLifecycleConfirmRenewal: 'Confirmar Renovación',
			registrantLifecycleConfirmReinstatement: 'Confirmar Reincorporación',
			// Phase 47 (D-01/D-02/D-14) — registrantAccessTrail* group; copy verbatim from 47-UI-SPEC.md § Copywriting Contract.
			registrantAccessTrailSectionTitle: 'Historial de Acceso',
			// D-01: load-bearing framing — accountability/transparency, NOT a security control. Do not paraphrase.
			registrantAccessTrailDisclaimer:
				'Registra cuándo un funcionario vio los detalles privados de este registrante a través de esta aplicación, y qué campos fueron revelados — para rendición de cuentas y transparencia, no como control de seguridad. Solo captura el acceso realizado a través de esta aplicación; el acceso directo a la base de datos no queda registrado aquí.',
			registrantAccessTrailEmptyHeading: 'Aún no hay acceso registrado',
			registrantAccessTrailEmptyBody:
				'Los detalles privados de este registrante no se han revelado a través de esta aplicación.',
			registrantAccessTrailRow: '{{viewer}} reveló {{fields}} — {{timestamp}}',
			// Phase 47 (D-03) — associationList* group; copy verbatim from 47-UI-SPEC.md § Copywriting Contract.
			associationListSectionTitle: 'Dispositivos Asociados',
			associationListEmptyHeading: 'No hay dispositivos asociados',
			associationListEmptyBody: 'Este registrante aún no ha asociado un dispositivo.',
			associationListDeviceKeyLabel: 'Clave del Dispositivo',
			associationListExpirationLabel: 'Vence',
			associationListRemoveButton: 'Eliminar Asociación',
			associationListRemoveTitle: '¿Eliminar esta asociación de dispositivo?',
			associationListRemoveBody:
				'{{name}} deberá asociar un dispositivo nuevamente antes de votar. Esto no cambia su estado de registro.',
			associationListRemoveConfirm: 'Eliminar Asociación',
			associationListKeepAssociation: 'Mantener Asociación',
			// Phase 47 (D-11) — attestationChallenge* group; copy verbatim from 47-UI-SPEC.md § Copywriting Contract.
			attestationChallengeSectionTitle: 'Certificaciones Pendientes',
			attestationChallengeEmptyHeading: 'No hay certificaciones pendientes',
			attestationChallengeEmptyBody:
				'No hay certificaciones de dispositivo pendientes para este registrante.',
			attestationChallengeDeviceKeyLabel: 'Clave del Dispositivo',
			attestationChallengeElectionLabel: 'Elección',
			attestationChallengeExpiryLabel: 'Vence',
			attestationChallengeExpireButton: 'Vencer Certificación',
			attestationChallengeExpireTitle: '¿Vencer esta certificación?',
			attestationChallengeExpireBody:
				'El dispositivo que posee esta certificación ya no podrá completarla. Una nueva certificación solo puede ser emitida por el propio intento de registro/asociación del dispositivo.',
			attestationChallengeExpireConfirm: 'Vencer Certificación',
			attestationChallengeKeepChallenge: 'Mantener Certificación',
			// Phase 47 (D-03) — attestationVerdict* group; copy verbatim from 47-UI-SPEC.md § Copywriting Contract.
			attestationVerdictPass: 'Aprobado',
			attestationVerdictFail: 'Rechazado',
			attestationVerdictNone: 'Sin resultado aún',
			attestationVerdictReasonLabel: 'Motivo',
			attestationVerdictVerifiedAtLabel: 'Verificado',
			// Phase 47 (D-09) — attestationProvisioning* group; copy verbatim from 47-UI-SPEC.md § Copywriting Contract.
			attestationProvisioningScreenTitle: 'Configuración de Certificación de Dispositivo',
			attestationProvisioningProvisionedHeading: 'Las claves de Play Console están configuradas',
			attestationProvisioningProvisionedBody:
				'La certificación de dispositivos está completamente operativa — las nuevas asociaciones de dispositivos pueden verificarse.',
			attestationProvisioningNotProvisionedHeading:
				'Las claves de Play Console no están configuradas',
			attestationProvisioningNotProvisionedBody:
				'La asociación de dispositivos fallará hasta que se configuren las claves de Play Console. Los datos de registrantes y asociaciones aún pueden verse y gestionarse con normalidad.',
			attestationProvisioningSetupLink: 'Consulta SETUP.md para los pasos de configuración',
			attestationProvisioningInlineBannerBody:
				'La certificación de dispositivos no está configurada. Las ceremonias de asociación fallarán hasta que esto se corrija.',
			attestationProvisioningInlineBannerLink: 'Ver estado de configuración',
			// Phase 47 (D-08/D-13) — pollingDevice* group; copy verbatim from 47-UI-SPEC.md § Copywriting Contract.
			pollingDeviceScreenTitle: 'Dispositivos de Votación',
			pollingDeviceAddButton: 'Agregar Dispositivo',
			pollingDeviceLabelField: 'Etiqueta',
			pollingDeviceLabelPlaceholder: 'ej. Tableta del Recinto 4',
			pollingDeviceHashLabel: 'Hash del Dispositivo',
			pollingDeviceRemoveButton: 'Eliminar',
			pollingDeviceRemoveTitle: '¿Eliminar este dispositivo de votación?',
			pollingDeviceRemoveBody:
				'{{label}} ya no podrá operar como dispositivo de votación presencial para esta autoridad. Puede agregarse nuevamente en cualquier momento.',
			pollingDeviceRemoveConfirm: 'Eliminar Dispositivo',
			pollingDeviceKeepDevice: 'Mantener Dispositivo',
			pollingDeviceEmptyHeading: 'No hay dispositivos de votación en la lista blanca',
			pollingDeviceEmptyBody:
				'Agrega un dispositivo para permitirle operar como dispositivo de votación presencial para esta autoridad.',
			// Phase 47 (D-08/D-13) — authorityPeer* group; copy verbatim from 47-UI-SPEC.md § Copywriting Contract.
			authorityPeerScreenTitle: 'Pares de Autoridad',
			authorityPeerAddButton: 'Agregar Par de Autoridad',
			authorityPeerIdLabel: 'ID del Par',
			authorityPeerIdPlaceholder: 'ID del par',
			authorityPeerRemoveButton: 'Eliminar',
			authorityPeerRemoveTitle: '¿Eliminar este par de autoridad?',
			authorityPeerRemoveBody:
				'Este par será eliminado del clúster P2P de esta autoridad. Puede agregarse nuevamente en cualquier momento.',
			authorityPeerRemoveConfirm: 'Eliminar Par',
			authorityPeerKeepPeer: 'Mantener Par',
			authorityPeerEmptyHeading: 'No hay pares de autoridad configurados',
			authorityPeerEmptyBody: 'Agrega un par para expandir el clúster P2P de esta autoridad.',
			// 47-REVIEW IN-06. Sin interpolación de {{peerId}} — ver la nota en la versión en inglés.
			authorityPeerDuplicateError: 'Ese par ya está configurado para esta autoridad.',
			// D-13: UI legibility affordance, NOT the enforcement boundary — the schema's AdminSignature CHECK is the real control.
			authorityPeerScopeReadOnlyBanner:
				'Solo visualización. Necesitas el permiso {{scope}} para cambiar pares de autoridad.',
			// Phase 47 (D-13) — registrantScope* group; copy verbatim from 47-UI-SPEC.md § Copywriting Contract.
			registrantScopeReadOnlyBanner:
				'Solo visualización. Necesitas el permiso {{scope}} para cambiar registrantes, asociaciones o dispositivos.',
			registrantScopeReadOnlyNoOfficerBanner:
				'Solo visualización. No eres un funcionario registrado de esta autoridad, así que los cambios están desactivados.',
			// Phase 48 (D-01/D-03/D-09) — registrationRequest* group; copy verbatim from 48-UI-SPEC.md § Copywriting Contract.
			registrationRequestScreenTitle: 'Solicitudes de Registro',
			registrationRequestSearchPlaceholder: 'Buscar por nombre',
			registrationRequestFilterStatusAll: 'Todas',
			registrationRequestFilterStatusPending: 'Pendientes',
			registrationRequestFilterStatusApproved: 'Aprobadas',
			registrationRequestFilterStatusRejected: 'Rechazadas',
			registrationRequestFilterIssuerAll: 'Todas las Fuentes',
			registrationRequestFilterIssuerRegistrant: 'Enviadas por el Registrante',
			registrationRequestFilterIssuerBridge: 'Importadas por Puente',
			registrationRequestCountLabel: 'Mostrando {{shown}} de {{total}}',
			registrationRequestCountUnknown: 'Mostrando {{shown}}',
			registrationRequestSortedByReceivedLabel:
				'Ordenadas por fecha de recepción (más antiguas primero)',
			registrationRequestLoadMoreButton: 'Cargar Más',
			registrationRequestLoadingMore: 'Cargando más…',
			registrationRequestEndOfList: 'Fin de la lista',
			registrationRequestEmptyHeading: 'Ninguna solicitud coincide con estos filtros',
			registrationRequestEmptyBody: 'Prueba con un estado o fuente diferente.',
			registrationRequestEmptyHeadingNoFilters: 'Aún no hay solicitudes de registro',
			registrationRequestEmptyBodyNoFilters:
				'Las solicitudes enviadas por cualquier método de sincronización aparecerán aquí para revisión.',
			registrationRequestBulkImportSyncButton: 'Importación Masiva / Sincronizar',
			registrationRequestPreviouslyRejectedFlag: 'Rechazada anteriormente',
			registrationRequestReceivedAtLabel: 'Recibida',
			registrationRequestClaimedSubmittedAtLabel: 'Envío declarado',
			registrationRequestScopeReadOnlyBanner:
				'Solo visualización. Necesitas el permiso {{scope}} para revisar solicitudes de registro.',
			registrationRequestScopeReadOnlyNoOfficerBanner:
				'Solo visualización. No eres un funcionario registrado de esta autoridad, así que los cambios están desactivados.',
			registrationRequestStatusPending: 'Pendiente',
			registrationRequestStatusApproved: 'Aprobada',
			registrationRequestStatusRejected: 'Rechazada',
			// Phase 48 (D-06/D-07) — registrationRequestApproval* group; copy verbatim from 48-UI-SPEC.md § Copywriting Contract.
			registrationRequestApprovalScreenTitle: 'Detalle de la Solicitud',
			registrationRequestApprovalSummaryTitle: 'Solicitud',
			registrationRequestApprovalReceivedAtLabel: 'Recibida',
			registrationRequestApprovalSubmittedAtLabel: 'Envío declarado',
			registrationRequestApprovalRequesterKeyLabel: 'Clave del Solicitante',
			registrationRequestApprovalApproveButton: 'Aprobar Registro',
			registrationRequestApprovalRejectButton: 'Rechazar Solicitud',
			registrationRequestApprovalApprovedByLabel: 'Aprobada por {{officer}} el {{date}}',
			registrationRequestApprovalViewRegistrantButton: 'Ver Registrante',
			// Phase 48 (D-06) — registrationRequestReject* group; copy verbatim from 48-UI-SPEC.md § Copywriting Contract.
			registrationRequestRejectTitle: '¿Rechazar esta solicitud?',
			registrationRequestRejectBody:
				'Esto quedará registrado de forma permanente con tu nombre. Si {{name}} vuelve a enviar una solicitud, este rechazo y tu motivo se mostrarán a quien lo revise después.',
			registrationRequestRejectReasonPlaceholder: 'Motivo del rechazo',
			registrationRequestRejectConfirmButton: 'Confirmar Rechazo',
			registrationRequestRejectKeepReviewingButton: 'Seguir Revisando',
			// Phase 48 (D-03) — bridgeSource* group; copy verbatim from 48-UI-SPEC.md § Copywriting Contract.
			bridgeSourceBadgeLabel: 'Importación por Puente',
			bridgeSourceCalloutHeading: 'Enviada por un puente de importación',
			bridgeSourceCalloutBody:
				'Esta solicitud fue firmada por {{bridgeLabel}}, un puente de importación, en nombre del remitente. Es una afirmación del puente, no una firma del propio registrante. Verifica en consecuencia.',
			// Phase 48 (D-07) — verificationChecklist* group; copy verbatim from 48-UI-SPEC.md § Copywriting Contract.
			verificationChecklistSectionTitle: 'Verificación Fuera de Banda',
			verificationChecklistItemId: 'Verificó identificación oficial con fotografía',
			verificationChecklistItemRoll: 'Comprobó contra el padrón electoral existente',
			verificationChecklistItemEligibility:
				'Confirmó elegibilidad (edad, residencia, ciudadanía según la política)',
			verificationChecklistItemNone: 'No se realizó verificación adicional fuera de banda',
			verificationChecklistBindingNotice:
				'Esta lista se convierte en parte de tu aprobación firmada y no puede modificarse después.',
			verificationChecklistDecidedAtLabel: 'Registrado al decidir',
			// Phase 48 (D-06) — priorRejections* group; copy verbatim from 48-UI-SPEC.md § Copywriting Contract.
			priorRejectionsCalloutHeading: 'Este solicitante fue rechazado anteriormente',
			priorRejectionsCalloutRow: 'Rechazado el {{date}} por {{officer}} — {{reason}}',
			// Phase 48 (D-09) — transparencyStats* group; copy verbatim from 48-UI-SPEC.md § Copywriting Contract.
			transparencyStatsSectionTitle: 'Transparencia',
			transparencyStatsPendingLabel: 'Pendientes',
			transparencyStatsApprovedLabel: 'Aprobadas',
			transparencyStatsRejectedLabel: 'Rechazadas',
			transparencyStatsMedianTimeLabel: 'Tiempo medio de decisión',
			transparencyStatsMedianTimeUnknown: 'Aún no hay datos suficientes',
			// Phase 48 (D-01/D-11) — bulkImportSync* group; copy verbatim from 48-UI-SPEC.md § Copywriting Contract.
			bulkImportSyncScreenTitle: 'Importación Masiva / Sincronizar',
			bulkImportSyncFilesystemHeading: 'Sistema de Archivos',
			bulkImportSyncRestHeading: 'Webhook / REST',
			bulkImportSyncP2pHeading: 'Entre Pares (Experimental)',
			bulkImportSyncP2pBody:
				'Este método de sincronización aún está en desarrollo y no se ha verificado que funcione de forma confiable. Usa la sincronización por Sistema de Archivos o REST para resultados confiables.',
			bulkImportSyncNeverSyncedBody: 'Aún no sincronizado',
			bulkImportSyncSyncedBody: 'Sincronización completada.',
			bulkImportSyncErrorBody:
				'La sincronización falló. No hay ningún método de sincronización conectado, o no se pudo contactar con el que está conectado.',
			bulkImportSyncLastSyncedLabel: 'Última sincronización correcta {{date}}',
			bulkImportSyncImportedCountLabel: '{{count}} importadas',
			bulkImportSyncPendingCountLabel: '{{count}} pendientes de revisión',
			bulkImportSyncErrorCountLabel: '{{count}} errores',
			bulkImportSyncNowButton: 'Sincronizar Ahora',
			bulkImportSyncP2pTryButton: 'Probar Sincronización P2P (Experimental)',
			bulkImportSyncErrorsSectionTitle: 'Errores de Sincronización',
		},
	},
};

const deviceLanguage = getLocales()[0]?.languageCode ?? 'en';

i18n.use(initReactI18next).init({
	resources: resources,
	lng: deviceLanguage,
	fallbackLng: 'en',
	interpolation: {
		escapeValue: false,
	},
});

export { resources };
export default i18n;
