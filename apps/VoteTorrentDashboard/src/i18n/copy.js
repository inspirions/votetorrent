/**
 * The single copy table for VoteTorrent Authority Dashboard.
 *
 * Contract C2 (binding, frozen by 50-04-PLAN.md): one flat frozen record `COPY` with
 * dotted string keys, plus `t(key, params)`. This is the ONLY place any user-facing
 * string in this app may live -- `scripts/lint-copy.mjs` fails the build if a binding
 * sentinel string appears anywhere else under `src/`. No later plan adds, edits or
 * removes a key here; the table is complete as of this plan (D-21).
 *
 * Transcribed verbatim from 50-UI-SPEC.md's Copywriting Contract.
 *
 * Contract C3 (D-17): there is deliberately NO `read-only` / `◐` panel-state string in
 * this table. Nothing in this phase is writable -- every panel in this phase is either
 * fully visible (granted scope) or fully hidden (withheld scope) -- so a read-only
 * badge would describe a state that cannot occur. `scripts/lint-copy.mjs` fails if a
 * `/read-only/i` match ever appears in any value.
 *
 * Contract C4: the four `50-UI-SPEC.md` "Producer screen (RN app)" copy rows are NOT
 * transcribed here. They belong to `apps/VoteTorrentAuthority`'s own
 * `src/i18n/index.ts` and are owned by plan 50-07. A web bundle must not ship a React
 * Native screen's strings.
 */

/** @type {Record<string, string>} */
export const COPY = Object.freeze({
	// Bootstrap and networks
	'bootstrap.heading': 'Enter your sign-in code',
	'bootstrap.cta': 'Redeem Code',
	'bootstrap.emptyNetworksHeading': 'No networks yet',
	'bootstrap.emptyNetworksBody':
		"Redeem a sign-in code from the authority app to bring this browser's copy of a network's data up to date.",
	'bootstrap.errorInvalidCodeHeading': "That code isn't valid.",
	'bootstrap.errorInvalidCodeBody':
		'It may have expired or already been used. Ask the officer for a new one.',
	'bootstrap.errorInvalidCodeCta': 'Try another code',
	'bootstrap.errorTransportHeading': "Couldn't reach the authority app.",
	'bootstrap.errorTransportBody': 'Check that the code was generated recently and try again.',
	'bootstrap.errorTransportCta': 'Retry',

	// Snapshot freshness, refresh and verification
	'snapshot.refreshCta': 'Refresh snapshot',
	'snapshot.asOf': 'as of {{relativeTime}}',
	'snapshot.verifiedToast': 'Snapshot verified and swapped.',
	'snapshot.staleBanner':
		'This copy of the data is more than {{threshold}} old. Refresh to bring it up to date.',
	'snapshot.errorVerificationHeading': "Couldn't verify the new snapshot.",
	'snapshot.errorVerificationBody':
		"The transferred data didn't match its checksum, so nothing was replaced — your existing data is unchanged. Try refreshing again.",
	'snapshot.errorSchemaMismatchHeading': 'This authority app is running a different version.',
	'snapshot.errorSchemaMismatchBody':
		'Update the authority app or this dashboard so both match, then try again.',

	// Network lifecycle and chrome
	'network.redeemAnotherCta': '+ Redeem another code',
	'network.forgetCta': 'Forget this network',
	'network.forgetConfirmBody':
		"This deletes this browser's locally stored copy of {{authorityName}}'s data, including registrant information. There's no undo. Type {{authorityName}} to confirm.",
	'network.swapConfirmHeading': "Replace this browser's data?",
	'network.swapConfirmBody':
		"A different officer's code was just redeemed for {{authorityName}}. Continuing replaces this browser's existing copy and signs you in as the new officer.",
	'network.swapConfirmCta': 'Replace and continue',
	'chrome.moreOptionsAriaLabel': 'More options',

	// Authorization gate and preview control
	'gate.advisoryDisclosure':
		"What's shown here follows the officer's permissions, but this dashboard makes no changes and enforces nothing on its own — anyone with this browser's data has the whole database regardless of what's visible.",
	'gate.badgeReal': 'answered by the database',
	'gate.badgeSimulated': 'simulated scope set',
	'gate.resetScopesCta': 'Reset to my scopes',
	'gate.revealDeniedCta': 'Reveal denied panels',
	'preview.title': 'Preview as',

	// Navigation groups and lifecycle pill
	'nav.groupElectionOperations': 'Election Operations',
	'nav.groupAuthorityAdministration': 'Authority Administration',
	'lifecycle.organizing': 'Being organized',
	'lifecycle.running': 'Running',
	'lifecycle.released': 'Results released',

	// Panel titles and empty states, in the UI-SPEC's fixed order (registrations
	// first, always -- 'vrg' is 39% of the authorization surface)
	'panels.registrations.title': 'Registrations',
	'panels.registrations.empty': 'No registrants yet.',
	'panels.elections.title': 'Elections',
	'panels.elections.empty': 'No elections yet.',
	'panels.ballotsQuestions.title': 'Ballots & Questions',
	'panels.ballotsQuestions.empty': 'No ballots yet.',
	'panels.networkSettings.title': 'Network Settings',
	'panels.networkSettings.empty': 'No network settings recorded yet.',
	'panels.authorityProfile.title': 'Authority Profile',
	'panels.authorityProfile.empty': 'No authority profile yet.',
	'panels.authorityPeers.title': 'Authority Peers',
	'panels.authorityPeers.empty': 'No peer authorities yet.',
	'panels.administrationOfficers.title': 'Administration & Officers',
	'panels.administrationOfficers.empty': 'No officers yet.',
	'panels.keyholders.title': 'Keyholders',
	'panels.keyholders.empty': 'No keyholders yet.',
	'panels.inviteAuthorities.title': 'Invite Authorities',
	'panels.inviteAuthorities.empty': 'No invitations yet.',
});

/**
 * Look up `key` in `COPY` and interpolate `{{name}}` placeholders from `params`.
 *
 * Throws if `key` is unknown (naming the key) or if any `{{placeholder}}` survives
 * interpolation (naming the first unresolved placeholder) -- this project's rule is
 * that a rejection names the reason.
 *
 * @param {string} key
 * @param {Record<string, unknown>} [params]
 * @returns {string}
 */
export function t(key, params = {}) {
	const template = COPY[key];
	if (typeof template !== 'string') {
		throw new Error(`t(): unknown copy key "${key}"`);
	}

	const interpolated = template.replace(/\{\{(\w+)\}\}/g, (match, name) => {
		// Leave the placeholder untouched when the param is missing, so the
		// unresolved-placeholder check below can name it. Replacing a missing
		// param with the literal string "undefined" would silently swallow the
		// gap that check exists to catch.
		return name in params ? String(params[name]) : match;
	});

	const unresolved = interpolated.match(/\{\{(\w+)\}\}/);
	if (unresolved) {
		throw new Error(
			`t(): unresolved placeholder "{{${unresolved[1]}}}" in copy key "${key}" -- missing param "${unresolved[1]}"`,
		);
	}

	return interpolated;
}
