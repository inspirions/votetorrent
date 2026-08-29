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
 * The "no later plan adds a key" rule above is a rule about PLANS, and it held:
 * the table was complete for every screen this phase built. It is not a rule
 * that a defect may not be fixed. Code review found user-facing text rendered
 * OUTSIDE this table in two places -- the raw machine phase codes in
 * `screens/Bootstrap.tsx` and the `tier`/`site(s)` pills in
 * `screens/panels/PanelFrame.tsx` -- and the fix for each is a key here, which
 * is exactly what contract C2 demands. Every such addition is recorded in a
 * comment beside the keys it adds.
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
	// The FIELD label, deliberately not the page heading. Both were
	// `bootstrap.heading` until live UAT, so the officer read "Enter your
	// sign-in code" twice on one screen -- once as the title and again as the
	// label under it. A label still has to exist and stay associated with the
	// input for screen readers; it just must not restate the title.
	'bootstrap.codeFieldLabel': 'Sign-in code',
	'bootstrap.cta': 'Redeem Code',
	'bootstrap.emptyNetworksHeading': 'No networks yet',
	'bootstrap.emptyNetworksBody':
		"Redeem a sign-in code from the authority app to bring this browser's copy of a network's data up to date.",
	'bootstrap.errorInvalidCodeHeading': "That code isn't valid.",
	// NARROWED to the case it now actually covers: a pasted string that failed
	// the local shape check and NEVER LEFT THIS BROWSER. Its old value hedged
	// across staleness and prior redemption, so it answered three service
	// refusals as well -- and was a wrong answer for all four; see the
	// refusal-family comment below. A code that was never sent to anything
	// cannot have been spent or gone stale, so the only honest next action here
	// is a local one.
	'bootstrap.errorInvalidCodeBody':
		'A sign-in code is two parts joined by a dot. Copy the whole code from the authority app and paste it again.',
	'bootstrap.errorInvalidCodeCta': 'Try another code',
	// --- The three refusal families ---------------------------------------
	//
	// WHAT DEFECT THIS CLOSES: one hedging sentence was the dashboard's answer
	// to three different service refusals AND to a locally malformed paste. An
	// officer reading it could not tell a typo from a code whose single use was
	// already spent from one that simply sat too long, and the single action it
	// offered -- ask for a new code -- is the wrong instruction for the first
	// of those.
	//
	// WHY THIS PRECISION IS AVAILABLE AT ALL -- READ THIS BEFORE SHORTENING THE
	// SERVICE'S RETENTION WINDOW: the rendezvous service erases a code's
	// ciphertext as soon as it is served, but deliberately KEEPS the
	// payload-free record for a grace window past the code's expiry. That
	// retention is the only reason a late redemption is still answered
	// precisely ("already redeemed" / "timed out") instead of collapsing to the
	// weakest answer, "no record here". These three keys are what that
	// retention buys. Shorten the window and this file quietly regresses to one
	// hedge for every refusal -- the exact defect above -- with no test to
	// notice, because each key would still resolve.
	//
	// WHY THE WORDS ARE WHAT THEY ARE: the refusal copy is walked by a test
	// (`test/node/copy.test.mjs`) that forbids any machine identifier -- every
	// outcome code, plus the literal status values a service can answer -- from
	// appearing in a string an officer reads. That is why this says "not
	// recognized", "timed out" and "already been redeemed" rather than echoing
	// the wire vocabulary. "Redeemed" also matches `bootstrap.cta`.
	//
	// All three families reuse `bootstrap.errorInvalidCodeCta` as their action
	// button; a fourth key with an identical value would buy no locale
	// flexibility and add a drift surface.
	'bootstrap.errorCodeNotRecognizedHeading': "That code isn't recognized.",
	'bootstrap.errorCodeNotRecognizedBody':
		'Check what you pasted for a typo first — a mistyped code looks exactly like this. If it matches the authority app character for character, ask the officer to generate a new code.',
	'bootstrap.errorCodeAlreadyUsedHeading': 'That code has already been redeemed.',
	'bootstrap.errorCodeAlreadyUsedBody':
		'Each sign-in code works only once, so retrying this one will never succeed. Ask the officer to generate a fresh code in the authority app.',
	'bootstrap.errorCodeTimedOutHeading': 'That code timed out.',
	'bootstrap.errorCodeTimedOutBody':
		'Sign-in codes stop working a few minutes after they are made. Ask the officer for a fresh code and paste it right away, or this will happen again.',
	'bootstrap.errorTransportHeading': "Couldn't reach the authority app.",
	'bootstrap.errorTransportBody': 'Check that the code was generated recently and try again.',
	'bootstrap.errorTransportCta': 'Retry',
	// One key per BOOTSTRAP_PHASES member, named `bootstrap.phase.<value>` --
	// keyed by the EXACT machine value (`bootstrap.phase.applying-schema` and
	// so on), so the screen looks a phase up with a mechanical template
	// (`` `bootstrap.phase.${state.phase}` ``) rather than through a
	// hand-maintained mapping table that could drift out of step with
	// BOOTSTRAP_PHASES. `t()` throws on an unknown key, so a phase added
	// without a key here is a loud error, never a machine identifier on
	// screen.
	'bootstrap.phase.submitting': 'Sending your code…',
	'bootstrap.phase.verifying': 'Checking the data against your code…',
	'bootstrap.phase.applying-schema': 'Preparing this browser…',
	'bootstrap.phase.seeding': 'Copying the data into this browser…',
	'bootstrap.phase.success': 'Done.',

	// Snapshot freshness, refresh and verification
	'snapshot.refreshCta': 'Refresh snapshot',
	'snapshot.asOf': 'as of {{relativeTime}}',
	'snapshot.verifiedToast': 'Snapshot verified and swapped.',
	'snapshot.staleBanner':
		'This copy of the data is more than {{threshold}} old. Refresh to bring it up to date.',
	'snapshot.errorVerificationHeading': "Couldn't verify the new snapshot.",
	'snapshot.errorVerificationBody':
		"The transferred data didn't match its checksum, so nothing was replaced — your existing data is unchanged. Try refreshing again.",
	// The banner for an attach failure this shell does NOT recognise as an
	// integrity problem -- a corrupt row-count record, a DDL reconcile error, a
	// storage quota refusal, a plugin registration failure. Distinct wording
	// from the verification family on purpose: telling an officer their data
	// failed its checksum when the database simply would not open is a
	// different, wrong answer.
	'snapshot.errorAttachHeading': "Couldn't open this browser's copy of the data.",
	'snapshot.errorAttachBody':
		'Nothing was changed. Refresh the snapshot to rebuild this browser’s copy from the authority app.',
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
	// The surfaced swap-failure banner (CR-03, 50-22): renders in the main
	// region -- not the swap dialog -- when classifying an incoming code
	// fails before (or without) ever opening the confirm dialog, so the
	// panel grid can never stand in for a failed replacement. Deliberately
	// distinct from `snapshot.errorAttachHeading`/`Body`: "couldn't open
	// this browser's copy of the data" is a wrong answer for a code that
	// was refused.
	'network.swapErrorHeading': "This browser's data couldn't be replaced.",
	'network.swapErrorBody':
		"The sign-in code couldn't be used to replace this browser's data. Ask the authority app for a new code and try again.",
	'chrome.moreOptionsAriaLabel': 'More options',

	// Authorization gate and preview control
	'gate.advisoryDisclosure':
		"What's shown here follows the officer's permissions, but this dashboard makes no changes and enforces nothing on its own — anyone with this browser's data has the whole database regardless of what's visible.",
	'gate.badgeReal': 'answered by the database',
	'gate.badgeSimulated': 'simulated scope set',
	'gate.resetScopesCta': 'Reset to my scopes',
	'gate.revealDeniedCta': 'Reveal denied panels',
	'preview.title': 'Preview as',
	// Panel-frame pills. `tier`, `site` and the English pluralisation rule were
	// authored user-facing prose living outside this table -- and lint-copy.mjs
	// could not see them, because it scans for a fixed sentinel list rather
	// than for arbitrary literals. The singular and plural are SEPARATE keys,
	// not a suffix computed in the component, so a locale whose plural is not
	// formed by adding a letter has somewhere to put its own answer.
	'panelFrame.tierPill': 'tier {{tier}}',
	'panelFrame.sitePill': '{{count}} site',
	'panelFrame.sitesPill': '{{count}} sites',

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
