/**
 * packages/p2p-probe-host/wall-proof.mjs — the D-07 wall proof (Phase 56 Plan 01).
 *
 * WHY THIS EXISTS. 56-04 (Wave 2) patches the strand-mesh gap
 * (`strand-addr-protocol.js:179` in `@serfab/cadre-core`, not optimystic, not P2P-11) that lets an
 * unauthorized peer reach the public election view. Before that patch is SCOPED, this harness
 * proves what the wall currently does — against a gateway whose every unconditional-admit branch
 * is verified CLOSED, so the result cannot be the cold-start `authorized.length === 0` carve-out
 * masquerading as a real refusal (`feedback_read_back_preconditions_dont_infer`).
 *
 * NODE-SIDE ONLY. This is a `@serfab/cadre-core` + `@optimystic/db-p2p` integration harness, not a
 * device proof — it runs the REAL admission internals in-process against a REAL outsider libp2p
 * node built from the same factory (`createLibp2pNode` from `@optimystic/db-p2p/rn`) the browser
 * Edge node (56-05) will use.
 *
 * RUNGS (each ends in a definite classified verdict — an unclassified timeout or "could not tell"
 * exits 1, because a wall proof that shrugs is worse than no proof):
 *   RUNG_P     — precondition control: every unconditional-admit branch is verified closed by
 *                direct reads that THROW (never skip) on a missing member. An assertion, not a
 *                measurement — see `assessPrecondition`.
 *   RUNG_L1    — Layer 1, protocol-blind connection admission. (Task 2)
 *   RUNG_L2    — Layer 2, `authorizeInboundControlStream`, behavioural + source-scan. (Task 2)
 *   RUNG_L3    — Layer 3, the strand-addr protocol handler's own `isMember`. (Task 2)
 *   RUNG_POS   — positive control: an authorized peer succeeds on the same probe code path, so
 *                every refusal above is attributable to the gate, not to a broken probe. (Task 2)
 *   RUNG_RELAY — the gateway's relay posture, decided on measured behaviour. (Task 2)
 *   RUNG_F4    — CONTEXT Finding 4: can a peer already holding valid strand addresses complete a
 *                strand-mesh read? (Task 3)
 *
 * CLI:
 *   --preconditions-only   boot a SEEDED gateway, run RUNG_P only, then shut down.
 *   --self-test            RUNG_P's inversion: boot an UNSEEDED gateway and require RUNG_P to FAIL
 *                           and `admitInboundControlConnection` to return 'admit' — proves the
 *                           precondition rung CAN fail (a rung that cannot fail is not a control).
 *   --relay=on|off          force the RUNG_RELAY posture under test (default: measure both).
 *   --json <path>           where to write the machine-readable record (default: ./wall-proof-record.json).
 *   (no flags)              the full sequence: RUNG_P, RUNG_L1..RUNG_RELAY, RUNG_F4, record emission.
 *
 * Exit: 0 on a fully classified PASS run, 1 on any unclassified/failed rung. SIGINT/SIGTERM stop
 * every node this process started (enrolment-smoke.mjs's shape).
 *
 * NOTE for whoever runs this: CadreNode boot is CPU-heavy and a busy host has previously
 * manufactured false failures (`project_voter_emulator_boot_needs_quiet_host`) — do not run this
 * concurrently with `nx run-many`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { CadreNode } from '@serfab/cadre-core';
import { webSockets } from '@libp2p/websockets';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';

const L = (...a) => console.log('[wall-proof]', ...a);

const PARTY_ID = 'votetorrent'; // aligned with drone.mjs / CadreNodeProvider.tsx
// A harness-local id — never a real network hash. Distinct from drone.mjs's STRAND_ID env var so
// the two proof runners never collide if ever run side by side.
const STRAND_ID = 'wall-proof-strand';

// ── Schema: the same votetorrent.qsql wrapper-strip drone.mjs uses (`:36-52`) ──────────────────
const VOTETORRENT_QSQL_RAW = readFileSync(
  new URL('../vote-core/schema/votetorrent.qsql', import.meta.url),
  'utf8',
);
const VOTETORRENT_QSQL = VOTETORRENT_QSQL_RAW
  .replace(/^\s*declare\s+schema\s+\w+\s*\{/, '')
  .replace(/\}\s*apply\s+schema\s+\w+\s*;\s*$/, '')
  .trim();

// ── Package-version instrument hygiene (T-56-01-05) ─────────────────────────────────────────────
// `import.meta.resolve` (ESM resolution, respects the "import" condition) rather than
// `createRequire(...).resolve`: both @serfab/cadre-core and @optimystic/db-p2p ship ESM-only
// `exports` maps with no "require" condition, so CJS resolution throws ERR_PACKAGE_PATH_NOT_EXPORTED.
// Neither package exposes a `./package.json` export subpath, so walk up from the resolved entry
// file to find the nearest package.json whose "name" matches.
function resolvePackageInfo(specifier, expectedName) {
  const entryPath = fileURLToPath(import.meta.resolve(specifier));
  let dir = dirname(entryPath);
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, 'package.json');
    if (existsSync(candidate)) {
      const pkg = JSON.parse(readFileSync(candidate, 'utf8'));
      if (pkg.name === expectedName) {
        return { version: pkg.version, path: candidate };
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`could not resolve an installed package.json for ${expectedName} from ${specifier}`);
}

const CADRE_CORE_INFO = resolvePackageInfo('@serfab/cadre-core', '@serfab/cadre-core');

// ── Instrument hygiene: throw, never skip, on a missing member ─────────────────────────────────
// A future @serfab/* bump could rename/remove one of these TS-`private`-but-real-JS-prototype
// methods. Reading it optionally (`?.`) or behind a try/catch would silently fold that into a
// PASS — exactly the vacuous-pass failure mode T-56-01-01 exists to prevent. requireMethod throws
// naming the missing member instead.
function requireMethod(obj, name, label) {
  const fn = obj?.[name];
  if (typeof fn !== 'function') {
    throw new Error(
      `RUNG_P instrument failure: ${label} — CadreNode.${name} is not a function on the installed ` +
      `@serfab/cadre-core@${CADRE_CORE_INFO.version} (${CADRE_CORE_INFO.path}). Refusing to silently ` +
      `skip this precondition; a missing member here means the rung cannot vouch for the branch.`,
    );
  }
  return fn.bind(obj);
}

/**
 * Build one gateway `CadreNode`. Modeled on `drone.mjs:63-127`, with the differences the
 * interface_context calls out: an explicit `network.enableRelay` (never inherited from the
 * storage-profile default), a loopback-only listen addr (this harness never needs an emulator
 * reachability address), and no `relayServerInit` (dev-proof scale; the default reservation store
 * is more than this harness's few probe connections need).
 *
 * `seeded`: when true, runs owner genesis + seeds exactly one authorized member (never itself
 * connected — a `CadrePeer` row is all `listAuthorizedMembers` needs to read) WITHOUT ever calling
 * `createInvite`. `createInvite` opens a 30-minute enrollment window as a side effect
 * (`DEFAULT_ENROLLMENT_WINDOW_MS`, `membership-connection-gater.js:174`), and `openEnrollmentWindow`
 * is monotonic (`cadre-node.js:1203`, `Math.max` — can never be narrowed once opened), so calling it
 * even once would admit every stranger unconditionally for the rest of this process's life and
 * defeat every rung this plan exists to run. `seed-bootstrap.js:964-979` shows `acceptPhone({
 * phonePeerId })` with NO `issuedInvite` argument writes the `CadrePeer` voucher directly via
 * `authorizePeer` and never touches the enrollment window — that is the seeding path used here.
 */
async function buildGateway({ enableRelay = false, seeded = true } = {}) {
  const privateKey = await generateKeyPair('Ed25519');
  const node = new CadreNode({
    privateKey,
    controlNetwork: { partyId: PARTY_ID, bootstrapNodes: [] },
    profile: 'storage',
    requireSignedSchemas: false,
    strandFilter: { mode: 'all' },
    network: {
      transports: [webSockets()],
      listenAddrs: ['/ip4/127.0.0.1/tcp/0/ws'],
      enableRelay, // the explicit knob (cadre-node.js:1034) — never left to the storage-profile default
    },
    strandClusterSize: 2,
    hibernation: { enabled: false },
  });

  await node.start();

  await node.addStrand({
    strandRow: { Id: STRAND_ID, MemberPrivateKey: null, Type: 'o' },
    sAppConfig: {
      id: 'org.votetorrent',
      version: '1.0.0',
      schema: VOTETORRENT_QSQL,
      latencyHint: 'interactive',
    },
    mode: 'bootstrap',
  });

  if (seeded) {
    // Owner genesis MUST run while the node is solo — see drone.mjs:202-216 for the same
    // ordering constraint. This node boots with empty bootstrapNodes so "solo" holds by
    // construction.
    const owner = node.getIdentityOwnerKey();
    await node.trustOwnerKeys([owner.publicKeyB64], 'operator');
    const controlDb = node.getControlDatabase();
    if (!controlDb) throw new Error('gateway has no control database after start()');
    await controlDb.ensureOwnerKey(owner.publicKeyB64);
    node.initializeSeedBootstrap(owner.privateKeyB64);

    // A throwaway member, never connected — a row is all listAuthorizedMembers needs.
    // Deliberately NOT node.createInvite() — see the header comment above.
    const seedMemberKeyPair = await generateKeyPair('Ed25519');
    const seedMemberPeerId = peerIdFromPrivateKey(seedMemberKeyPair).toString();
    await node.acceptPhone({ phonePeerId: seedMemberPeerId });
  }

  return node;
}

/**
 * RUNG_P: the precondition control. Asserts all eight unconditional-admit branches
 * (interface_context numbered list) are closed against `probePeerId`, using direct reads that
 * throw rather than skip on a missing member (T-56-01-01).
 *
 * Returns `{ pass, checks, decision }` — `checks` carries per-assertion observed values so both
 * the full run and `--self-test` can report exactly which branch(es) are open.
 */
async function assessPrecondition(node, probePeerId) {
  const checks = [];
  const record = (id, branch, pass, observed) => checks.push({ id, branch, pass, observed });

  // Branches 1-3: not running/no DB, empty trusted-owner anchor, configured bootstrap/relay peer.
  const admitUnconditionally = requireMethod(
    node, 'admitControlPeerUnconditionally', 'branches 1-3 (admitControlPeerUnconditionally)',
  );
  const unconditional = admitUnconditionally(probePeerId);
  record(
    'unconditional', 'branches 1-3 (not-running/no-DB, empty trust anchor, bootstrap/relay peer)',
    unconditional === false, unconditional,
  );

  // Branch 4: enrollment window.
  if (typeof node.enrollmentWindowUntil !== 'number') {
    throw new Error(
      `RUNG_P instrument failure: node.enrollmentWindowUntil is not a number on the installed ` +
      `@serfab/cadre-core@${CADRE_CORE_INFO.version} — CadreNode shape changed.`,
    );
  }
  record('enrollmentWindow', 'branch 4 (enrollment window)', node.enrollmentWindowUntil === 0, node.enrollmentWindowUntil);

  // Branch 5: delegate admission grant.
  const hasDelegate = requireMethod(node, 'hasDelegateAdmission', 'branch 5 (delegate admission)');
  const delegate = hasDelegate(probePeerId);
  record('delegateAdmission', 'branch 5 (delegate admission)', delegate === false, delegate);

  // Branch 6: cold-start carve-out (authorized.length === 0), plus the membership fact RUNG_L1-L3
  // depend on (probePeerId must NOT be a member for the outsider probes to mean anything).
  const listMembers = requireMethod(node, 'listAuthorizedMembers', 'branch 6 (cold-start / membership)');
  const authorized = await listMembers();
  const memberCount = authorized.length;
  const probeIsMember = authorized.some((m) => m.peerId === probePeerId);
  record(
    'membership', 'branch 6 (authorized.length===0 cold-start carve-out) + probe is not a member',
    memberCount >= 1 && !probeIsMember, { memberCount, probeIsMember },
  );

  // Branch 7: outstanding strand-formation invitation. `strandSolicitationService` is a plain
  // instance field that starts `null` and is only constructed by a formation call this harness
  // never makes (cadre-node.js:111,4981) — that is a legitimate absence, not a missing member, so
  // it reads as "no outstanding invitation" without throwing. If the service EXISTS but lacks the
  // method, that IS a shape change and must throw.
  let outstandingInvitation = false;
  const solicitation = node.strandSolicitationService;
  if (solicitation) {
    if (typeof solicitation.hasOutstandingInvitation !== 'function') {
      throw new Error(
        'RUNG_P instrument failure: strandSolicitationService.hasOutstandingInvitation is not a ' +
        'function — CadreNode shape changed.',
      );
    }
    outstandingInvitation = await solicitation.hasOutstandingInvitation();
  }
  record('outstandingInvitation', 'branch 7 (outstanding invitation)', outstandingInvitation === false, outstandingInvitation);

  // Branch 8: relay posture (this gateway's default posture under test — RUNG_RELAY re-measures
  // the "on" posture separately in Task 2).
  const relayEnabledFn = requireMethod(node, 'relayServerEnabled', 'branch 8 (relayServerEnabled)');
  const relayEnabled = relayEnabledFn();
  record('relayServerEnabled', 'branch 8 (relayServerEnabled posture)', relayEnabled === false, relayEnabled);

  // Validity precondition (not an admit branch): without this, Layer 3's empty response is
  // indistinguishable from "this gateway does not host the strand at all".
  const getStrandFn = requireMethod(node, 'getStrand', 'strand-hosting validity check');
  const strandInstance = getStrandFn(STRAND_ID);
  const strandAddrCount = strandInstance?.libp2pNode?.getMultiaddrs?.().length ?? 0;
  record('strandHosted', 'validity (strand actually running locally)', strandAddrCount > 0, strandAddrCount);

  // Aggregate decision-level wall: the sum of every branch above, read through the real
  // decision function rather than re-derived from the individual checks.
  const admitInbound = requireMethod(node, 'admitInboundControlConnection', 'decision-level wall (admitInboundControlConnection)');
  const decision = await admitInbound(probePeerId);
  record('decision', 'aggregate decision (admitInboundControlConnection)', decision === 'deny', decision);

  const pass = checks.every((c) => c.pass);
  return { pass, checks, decision };
}

function printRungP(result) {
  for (const c of result.checks) {
    L(`RUNG_P.${c.id}=${c.pass ? 'PASS' : 'FAIL'} branch="${c.branch}" observed=${JSON.stringify(c.observed)}`);
  }
  L(`RUNG_P decision-level admitInboundControlConnection=${result.decision}`);
  L(`RUNG_P=${result.pass ? 'PASS' : 'FAIL'}`);
}

/**
 * `--self-test`: RUNG_P's inversion. Boots the SAME gateway shape with the owner-genesis/seeding
 * block skipped entirely and requires RUNG_P to FAIL and `admitInboundControlConnection` to
 * return `'admit'`. A precondition rung that cannot fail is not a control — this is the plan's
 * key instrument inversion (see `<verification>` item 2).
 */
async function runSelfTest(probePeerId) {
  L('SELF-TEST: booting an UNSEEDED gateway — RUNG_P must FAIL against it, or it is not a control.');
  const node = await buildGateway({ enableRelay: false, seeded: false });
  activeNodes.add(node);
  try {
    const result = await assessPrecondition(node, probePeerId);
    printRungP(result);
    const openBranches = result.checks.filter((c) => !c.pass).map((c) => c.branch);
    L('SELF_TEST_OPEN_BRANCHES=' + JSON.stringify(openBranches));

    if (result.pass) {
      L('SELF-TEST FAILED: RUNG_P passed on an UNSEEDED gateway — the rung cannot fail and is not a control.');
      return 1;
    }
    if (result.decision !== 'admit') {
      L(`SELF-TEST FAILED: expected admitInboundControlConnection === 'admit' on the unseeded gateway, got '${result.decision}'.`);
      return 1;
    }
    L('SELF-TEST PASSED: RUNG_P=FAIL as required, and the probe peer was admitted via the branch(es) above.');
    return 0;
  } finally {
    await node.stop();
    activeNodes.delete(node);
  }
}

// ── Lifecycle: track every node this process starts so SIGINT/SIGTERM and the outer finally can
// stop all of them, on the pass and fail paths both (enrolment-smoke.mjs's shape). ────────────
const activeNodes = new Set();
let shuttingDown = false;
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    L(`${sig} — stopping ${activeNodes.size} node(s)...`);
    await Promise.all([...activeNodes].map((n) => n.stop().catch(() => {})));
    process.exit(1);
  });
}

async function main() {
  const args = process.argv.slice(2);
  const preconditionsOnly = args.includes('--preconditions-only');
  const selfTest = args.includes('--self-test');

  L(`CADRE_CORE_VERSION=${CADRE_CORE_INFO.version}`);
  L(`CADRE_CORE_PATH=${CADRE_CORE_INFO.path}`);

  // Generated once and reused for the life of the run: RUNG_P vets this peerId at precondition
  // time, and the same identity becomes the outsider libp2p node's peerId once Task 2's probes
  // exist, so the whole run measures ONE identity throughout.
  const probeKeyPair = await generateKeyPair('Ed25519');
  const probePeerId = peerIdFromPrivateKey(probeKeyPair).toString();
  L(`PROBE_PEER_ID=${probePeerId}`);

  if (selfTest) {
    return await runSelfTest(probePeerId);
  }

  const node = await buildGateway({ enableRelay: false, seeded: true });
  activeNodes.add(node);
  try {
    const result = await assessPrecondition(node, probePeerId);
    printRungP(result);

    if (preconditionsOnly) {
      return result.pass ? 0 : 1;
    }

    if (!result.pass) {
      L('RUNG_P FAILED on a SEEDED gateway — the seeding recipe is broken; refusing to run the ' +
        'outsider probes against a gateway whose own preconditions are not vouched for.');
      return 1;
    }

    // Task 2 (RUNG_L1/L2/L3/POS/RELAY) and Task 3 (RUNG_F4, record emission) extend here.
    L('Full-run rungs beyond RUNG_P are not yet implemented in this file (Task 1 scope).');
    return 0;
  } finally {
    await node.stop();
    activeNodes.delete(node);
  }
}

main()
  .then((code) => process.exit(code ?? 0))
  .catch((err) => {
    console.error('[wall-proof] FATAL', err?.stack ?? err);
    process.exit(1);
  });
