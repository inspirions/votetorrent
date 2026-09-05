#!/usr/bin/env node
/**
 * mesh-read-origin.mjs — the mesh-read gate's origin process. Spawned by
 * `run-mesh-read-gate.mjs` (Task 3); boots `56-08`'s REAL gateway in-process
 * via its `startGateway` export, re-asserts every precondition that would
 * otherwise let the gate certify a cold-start or unpatched node, seeds a
 * production-length election into the strand, and mutates it on command over
 * a pipe the driver already owns.
 *
 * CadreNode boot is CPU-heavy, and a busy host has previously manufactured
 * false failures (`project_voter_emulator_boot_needs_quiet_host`) — do not
 * run this alongside `nx run-many` or any other CPU-heavy concurrent task.
 *
 * ALL GATE-ONLY CODE LIVES HERE, NEVER IN THE GATEWAY. `gateway.mjs` gained
 * exactly one named export and a CLI guard; no seeding, no fixture import
 * and no write path was added to it. This file is where the phase's own
 * D-19(a) production-length seed (`seedFoundingAuthority`/
 * `seedElectionSurface`) and the one `Keyholder` mutation live instead.
 *
 * PER-RUN STRAND ID, WITHOUT A NEW GATEWAY FLAG OR CONFIG KEY. The driver
 * passes a fresh strandId every run (`/^[A-Za-z0-9-_]{1,128}$/`), but
 * `startGateway` takes only `{ config: <path> }` — no strand-id override
 * parameter, by the plan's own "no new flag, no new config key" prohibition.
 * This file resolves that by reading the OPERATOR'S config file for every
 * key EXCEPT `publicObserverStrandIds` (which it overrides to exactly this
 * run's strand id), resolving `tls.certPath`/`tls.keyPath` to ABSOLUTE paths
 * (so the temp file's own directory never matters), and writing the result
 * to a throwaway temp file that `startGateway` loads like any other config.
 * `gateway.mjs` itself changes NOTHING to support this — the override lives
 * entirely on this side of the `startGateway` boundary.
 *
 * PRECONDITIONS RE-ASSERTED, NOT ASSUMED. `56-08`'s own boot sequence
 * already refuses a cold-start/plaintext/open-enrollment gateway, but
 * `project_device_proof_bundle_provenance` cost three runs to a stale server
 * and `feedback_read_back_preconditions_dont_infer` is the discipline D-07
 * exists to enforce — so this file re-checks the same four facts at ITS OWN
 * consumer boundary, each fatal with its own name, before ever touching the
 * strand.
 *
 * NO SOCKET, NO HTTP ENDPOINT. This process is driven exclusively over the
 * stdin pipe the driver already owns (newline-delimited commands, a CLOSED
 * vocabulary of exactly two: `mutate`, `stop`). Error NAMES only ever reach
 * stdout — a Quereus constraint message can carry row values, and this
 * process must never let one reach the pipe.
 */
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve as resolvePath, dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { startGateway } from '../../../../packages/p2p-probe-host/gateway.mjs';

/**
 * Print an `ORIGIN_FATAL:<name>` line naming the offending precondition and
 * exit non-zero. Never optional — every precondition below is asserted,
 * never assumed.
 * @param {string} name
 * @param {string} reason
 * @returns {never}
 */
function fatal(name, reason) {
	console.error(`ORIGIN_FATAL:${name}: ${reason}`);
	process.exit(1);
}

/**
 * @param {string[]} argv
 * @returns {{ config: string, strandId: string }}
 */
function parseArgs(argv) {
	/** @type {{ config?: string, strandId?: string }} */
	const args = {};
	for (let i = 0; i < argv.length; i += 1) {
		if (argv[i] === '--config') args.config = argv[i + 1];
		else if (argv[i] === '--strand-id') args.strandId = argv[i + 1];
	}
	if (!args.config) fatal('config', '--config is required');
	if (!args.strandId || !/^[A-Za-z0-9_-]{1,128}$/.test(args.strandId)) {
		fatal('strand-id', '--strand-id is required and must match /^[A-Za-z0-9_-]{1,128}$/');
	}
	return /** @type {{ config: string, strandId: string }} */ (args);
}

async function main() {
	const args = parseArgs(process.argv.slice(2));

	const originalConfigPath = resolvePath(process.cwd(), args.config);
	if (!existsSync(originalConfigPath)) {
		fatal('config', `--config file not found at ${originalConfigPath}`);
	}
	const originalConfigDir = dirname(originalConfigPath);
	/** @type {any} */
	let baseConfig;
	try {
		baseConfig = JSON.parse(readFileSync(originalConfigPath, 'utf8'));
	} catch (err) {
		fatal('config', `--config file is not valid JSON (${err && /** @type {any} */ (err).name})`);
	}

	// Every key EXCEPT publicObserverStrandIds is transcribed unchanged; tls
	// paths are made absolute so this run's temp config file can live
	// anywhere. See this file's header for why this is done here, never in
	// gateway.mjs.
	const overrideConfig = {
		...baseConfig,
		publicObserverStrandIds: [args.strandId],
		tls: {
			certPath: resolvePath(originalConfigDir, baseConfig.tls.certPath),
			keyPath: resolvePath(originalConfigDir, baseConfig.tls.keyPath),
		},
	};
	const tempDir = mkdtempSync(join(tmpdir(), 'mesh-read-origin-'));
	const tempConfigPath = join(tempDir, 'gateway.config.json');
	writeFileSync(tempConfigPath, JSON.stringify(overrideConfig, null, 2));

	const handle = await startGateway({ config: tempConfigPath });

	// -- Re-assert every precondition, fatally, each with its own name. ------
	if (handle.provenance.verdict !== 'PASS') {
		fatal('origin-provenance', `provenance.verdict is "${handle.provenance.verdict}", expected "PASS"`);
	}
	if (!(handle.authorizedMemberCount >= 1)) {
		fatal('origin-cold-start', `authorizedMemberCount is ${handle.authorizedMemberCount}, expected >= 1`);
	}
	if (handle.enrollmentWindowUntil !== 0) {
		fatal('origin-enrollment-window-open', `enrollmentWindowUntil is ${handle.enrollmentWindowUntil}, expected 0`);
	}
	for (const addr of handle.controlAddrs) {
		if (!addr.includes('/tls/ws')) {
			fatal('origin-plaintext-addr', `control address does not carry /tls/ws`);
		}
	}
	if (!handle.tls.spkiSha256Base64) {
		fatal('tls-pin-absent', 'the gateway reported no SPKI pin');
	}

	console.log('ORIGIN_PROVENANCE=' + handle.provenance.verdict);
	console.log('ORIGIN_AUTHORIZED_MEMBERS=' + handle.authorizedMemberCount);
	console.log('ORIGIN_ENROLLMENT_WINDOW_UNTIL=' + handle.enrollmentWindowUntil);
	console.log('ORIGIN_RELAY=' + (handle.enableRelay ? 'on' : 'off'));
	console.log('ORIGIN_STRAND_ID=' + args.strandId);
	for (const addr of handle.controlAddrs) {
		console.log('ORIGIN_CONTROL_ADDR=' + addr);
	}
	console.log('ORIGIN_TLS_SPKI=' + handle.tls.spkiSha256Base64);
	console.log('ORIGIN_TLS_CAROOT=' + (handle.tls.caRoot ?? ''));

	// -- Reach the hosted strand's Quereus Database. -------------------------
	const strand = handle.node.getStrand(args.strandId);
	if (!strand || !strand.database) {
		fatal('strand', `getStrand("${args.strandId}") returned no hosted strand database`);
	}
	const db = strand.database.getDatabase();
	// D-14 transparency (rn-db-factory.ts:146-148), the same call
	// strand-read.js's reader makes: bare engine SQL table names resolve to
	// App.<Table> first, with main as the fallback. Every INSERT below
	// breaks without this call.
	db.setSchemaPath(['App', 'main']);
	// registerDbPlugins is "per-Database-instance state (not persisted) --
	// must run on EVERY database" (vote-engine/initialize.ts's own doc
	// comment). The strand's Database is a SEPARATE instance from the local
	// UI store attachNetworkDb/createNetworkDb already register it on, and
	// this origin is the first writer this phase ever drives against a
	// strand-connected Database -- without this call, the signing ceremony's
	// SignatureValid/SignatureValidP256 UDFs are unresolved at query-build
	// time (the planner must resolve every function name referenced in a
	// CHECK expression even on a short-circuited OR branch), and Quereus
	// throws "Function not found" before any row is ever touched.
	const { registerDbPlugins } = await import('@votetorrent/vote-engine/browser');
	await registerDbPlugins(db);

	// -- Dynamic-import both fixtures INSIDE this file only -- they must
	// never enter the gateway's import graph. --------------------------------
	const { seedFoundingAuthority } = await import('../../../../packages/web-data/test/fixtures/seed-founding-authority.js');
	const { seedElectionSurface, SEED_ELECTION, SEED_PHASE_INSTANTS } = await import(
		'../../../../packages/web-data/test/fixtures/seed-election-surface.js'
	);
	// Not exported by seed-election-surface.js -- its own founding
	// ElectionRevision is created with `revision: 0` internally
	// (`seedElectionSurface`'s `R.revision`), the same local constant
	// `live-read-gate.js:123` declares for the identical reason.
	const SEED_REVISION = 0;

	/** @returns {Promise<number>} */
	async function countKeyholders() {
		const row = await db.prepare('select count(*) as c from Keyholder').get({});
		return Number(/** @type {any} */ (row)?.c ?? 0);
	}

	try {
		await seedFoundingAuthority(db);
		await seedElectionSurface(db);
	} catch (err) {
		fatal('origin-seed', `${err && /** @type {any} */ (err).name}`);
	}

	const keyholdersBefore = await countKeyholders();

	console.log('ORIGIN_ELECTION_ID=' + SEED_ELECTION.id);
	console.log('ORIGIN_ELECTION_TITLE=' + SEED_ELECTION.title);
	// The `settling` phase, not `pre` -- the phase whose fact set actually
	// carries the key-release card. `pre` renders no card, which would make
	// the gate go red naming a missing sentence rather than proving liveness.
	console.log('ORIGIN_AT_INSTANT=' + SEED_PHASE_INSTANTS.settling);
	console.log('ORIGIN_KEYHOLDERS_BEFORE=' + keyholdersBefore);
	console.log('ORIGIN_SEEDED=ok');
	console.log('ORIGIN_READY');

	let stopped = false;
	/** @returns {Promise<void>} */
	async function shutdown() {
		if (stopped) return;
		stopped = true;
		// drone.mjs:427-436's shape: no extra cleanup beyond stopping the node.
		try {
			await handle.stop();
		} catch {
			// Swallowed -- an aborted gate must not hang on its own teardown.
		}
	}

	for (const sig of ['SIGINT', 'SIGTERM']) {
		process.on(sig, async () => {
			await shutdown();
			process.exit(0);
		});
	}

	// -- Closed-vocabulary command loop over stdin. Exactly two commands; any
	// other line is refused with no state change. --------------------------
	const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
	rl.on('line', async (rawLine) => {
		const line = rawLine.trim();
		if (line === 'mutate') {
			try {
				// The one insert on a seeded election surface that needs no
				// signing ceremony: its insert-time constraint requires exactly
				// that the three signing-context values be null, which are
				// simply not supplied. Bound parameters only.
				await db.exec(
					`insert into Keyholder (ElectionId, ElectionRevision, UserId) with context Tid = :tid values (:electionId, :revision, :userId)`,
					{ tid: 900, electionId: SEED_ELECTION.id, revision: SEED_REVISION, userId: 'u1' },
				);
				const keyholdersAfter = await countKeyholders();
				console.log('ORIGIN_KEYHOLDERS_AFTER=' + keyholdersAfter);
				console.log('ORIGIN_MUTATED=ok');
			} catch (err) {
				const name = err && typeof (/** @type {any} */ (err).name) === 'string' ? /** @type {any} */ (err).name : 'Error';
				console.log('ORIGIN_MUTATED=fail:' + name);
			}
		} else if (line === 'stop') {
			await shutdown();
			process.exit(0);
		} else if (line.length > 0) {
			console.log('ORIGIN_REFUSED=unknown-command');
		}
	});
}

main().catch((err) => {
	console.error('ORIGIN_FATAL:unhandled: ' + (err && /** @type {any} */ (err).stack ? /** @type {any} */ (err).stack : err));
	process.exit(1);
});
