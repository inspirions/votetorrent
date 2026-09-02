#!/usr/bin/env node
/**
 * run-gate.mjs — the public app's declared browser-gate entry point.
 *
 * This file exists NOW, before any real browser gate is wired, so the app
 * satisfies "every @votetorrent/ui-web consumer declares a browser gate"
 * from its first commit. It is deliberately a STUB that can never report
 * success.
 *
 * 53-09 replaces this body with an invocation of the shared runner (created
 * in 53-08) against this app's own `dist/`, at whichever location 53-08
 * confirms for the runner.
 *
 * This must never be made to exit 0 as a shortcut — a browser gate that
 * passes without running a browser is worse than an absent one; it is the
 * "green with the whole token layer removed" shape this phase exists to
 * eliminate.
 *
 * NOT added to this app's `test` script — the dashboard keeps the two
 * separate and CI invokes the browser leg explicitly, so this loudly-red
 * stub does not turn the root `yarn test` red.
 */
process.stderr.write(
	'[run-gate] the shared UI browser-gate runner is not yet wired into apps/VoteTorrentPublic ' +
		'(53-09 replaces this stub). This is expected until then.\n',
);
process.exitCode = 1;
