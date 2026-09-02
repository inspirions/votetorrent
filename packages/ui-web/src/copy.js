/**
 * The shared copy table for VoteTorrent's web apps.
 *
 * Two web consumers read this table: `apps/VoteTorrentDashboard` (the authority
 * officer's dashboard) and `apps/VoteTorrentPublic` (the no-login public election
 * view). The two React Native apps -- `apps/VoteTorrentAuthority` and
 * `apps/VoteTorrentVoter` -- are NOT consumers of this table and keep their own
 * `src/i18n/` tables.
 *
 * Contract C2 (binding, frozen by 50-04-PLAN.md): one flat frozen record `COPY` with
 * dotted string keys, plus `t(key, params)`. This is still the ONLY place any
 * user-facing string in either web app may live -- `scripts/lint-copy.mjs` fails the
 * build if a binding sentinel string appears anywhere else under `src/`.
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
 * D-08: this table is no longer complete-and-frozen for all time. `public.*`
 * keys arrive under that prefix as `apps/VoteTorrentPublic` actually mounts each
 * screen that needs one -- never speculatively -- and each addition is recorded,
 * per the existing convention above, in a comment beside the keys it adds.
 *
 * D-07 (variant-prop contract): a component SHARED between the two web apps must
 * not hard-code one consumer's copy key. It takes an explicit `variant` prop and
 * resolves its own key at render time, so `t()`'s throw-on-unknown-key turns a
 * missing public voice into a loud render failure instead of a silent wrong
 * answer. This closes a real defect: a shared `AdvisoryDisclosure` component
 * rendered "What's shown here follows the officer's permissions…" on a no-login
 * public page with no officer and no permission model to speak of -- with clean
 * imports, a green typecheck and every other gate green, caught only by looking
 * at a screenshot. A `public.*` value must be authored FRESH for a no-login
 * audience and must never be derived by find-and-replace from a `gate.*` or
 * `bootstrap.*` string. The residual control is a manual per-consumer copy
 * review, because every automated gate in this repo is provably blind to a
 * false-but-well-formed word.
 *
 * D-10: `50-UI-SPEC.md` remains the design authority for the dashboard's half of
 * this table, but it is no longer the sole authority -- the table now also
 * serves an app that spec never described.
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
 *
 * 53-05's key-naming resolution (D-07 vs D-09, this plan's own open question,
 * resolved in favor of D-07 for this one shared component): (1) the D-07
 * `variant` prop resolves `advisory.<variant>.body` by TEMPLATE LITERAL, not
 * a lookup map; (2) `gate.advisoryDisclosure` was RENAMED to
 * `advisory.authority.body`, its value carried across byte-identical; (3)
 * this is the ONLY key renamed by this plan -- the other 72 keep D-09's
 * byte-identical guarantee untouched; (4) the template form is chosen over a
 * lookup map because a map admits a one-token `?? 'advisory.authority.body'`
 * fallback that would silently restore the authority voice on the public
 * app, and no test in this repo could see it -- a template literal has
 * nowhere to put that token; (5) `advisory.*` is a variant-paired namespace
 * owned by ONE shared component, whose two members are the two voices of
 * one sentence and neither exists without the other -- `public.*` remains
 * the public app's own namespace for keys with NO authority sibling; (6) the
 * deferred `authority.*`/`public.*`/`shared.*` re-prefixing declined at D-09
 * remains declined -- this is a scoped exception for one paired variant, not
 * the first stone of that rewrite. `50-UI-SPEC.md` is NOT the authority for
 * the `advisory.*` pair; this file's own header is.
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
	//
	// `advisory.authority.body` was `gate.advisoryDisclosure` before 53-05 --
	// renamed, value byte-identical, under D-07 (see the header note below).
	// Its sibling `advisory.public.body` arrives fresh, authored for a
	// no-login audience, when 53-07 mounts the public shell (D-08) -- it is
	// deliberately absent until then.
	'advisory.authority.body':
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
	// TEMPORARY (54-02 Task 1 -> Task 2, Rule 3 deviation): the four new
	// Phase-54 lifecycle.* keys are added early, additively, so
	// test/election-phase.test.mjs's phaseCopyKey-resolves-via-t() assertion
	// (Task 1) has real keys to resolve before Task 2 lands. Task 2 replaces
	// this whole block (these four plus the three above) with the final
	// five-key set (adds lifecycle.indeterminate, removes the three above).
	'lifecycle.pre': 'Being organized',
	'lifecycle.voting': 'Voting',
	'lifecycle.settling': 'Settling',
	'lifecycle.closed': 'Closed',

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

	// --- Public election view (53-07, D-08) -------------------------------
	//
	// Exactly ten keys, added because apps/VoteTorrentPublic's ElectionShell
	// actually mounts every one of them -- never speculatively (D-08). Every
	// value below was authored FRESH for a no-login audience and was NEVER
	// produced by find-and-replacing `advisory.authority.body` or any
	// `gate.*`/`bootstrap.*` string (D-07); `packages/ui-web/test/public-voice.test.mjs`
	// lints this block for banned lexemes (officer/permission/scope/login
	// words/account/dashboard/snapshot/simulated) and for any shared 6-word
	// run with the authority-voiced corpus.
	//
	// `advisory.public.body` is the sibling `AdvisoryDisclosure`'s
	// `advisory.${variant}.body` template resolves for `variant="public"` --
	// deliberately absent since 53-05 (it threw by name until this key
	// landed, which was the mechanism, not a gap). It must read true on BOTH
	// the shipped election-less page and 53-07's harness page, so it makes
	// no claim tied to any one election.
	'advisory.public.body':
		"Anyone can open this page and see the same election record — nothing here is shown differently for different visitors, and nothing you do on this page changes what the record says.",
	'public.chrome.appName': 'VoteTorrent Public Election View',
	'public.election.addressLabel': 'Election address',
	// unreadableAddress.*: this app holds no election data at all, so it
	// cannot say an election does not exist -- only that the ADDRESS in the
	// link could not be read. It must not tell the reader to sign in, and
	// must not ask them to contact anyone by role name -- it names the link
	// itself as the thing to check.
	'public.election.unreadableAddress.title': "This link's election address isn't readable.",
	'public.election.unreadableAddress.body':
		"The part of this link that names an election doesn't match the expected form, so this page can't tell which election it points to. Check the link for a typo, or ask whoever shared it to send it again.",
	// slot.* are SLOT LABELS -- the name of the thing whose place is held --
	// never a status message. None may say "loading"/"fetching"/"please
	// wait"/"updating": a placeholder here is not evidence of an in-flight
	// request, because none exists (D-18).
	'public.election.slot.title': 'Election title',
	'public.election.slot.lifecycle': 'Lifecycle phase',
	'public.election.slot.timeline': 'Election timeline',
	'public.details.summary': 'About this view',
	// The one structural fact this page can honestly state with no election
	// loaded: a lifecycle phase, when shown, is computed from an election's
	// own published timeline, never picked by anyone -- it makes no claim
	// about where that timeline comes from, because in this phase it comes
	// from nowhere.
	'public.details.body':
		'When an election is shown here, its lifecycle — being organized, running, or results released — is computed from that election’s own published timeline. Nobody picks it by hand; it follows from the dates the election itself publishes.',
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
