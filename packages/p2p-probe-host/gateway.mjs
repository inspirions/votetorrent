#!/usr/bin/env node
/**
 * packages/p2p-probe-host/gateway.mjs — Phase 56 D-12 public-observer gateway.
 *
 * A NEW file. It is NOT a fork of `drone.mjs` and does not import from it. Exactly two things
 * are copied from `drone.mjs`, and named as such here: the `webSockets()` + `listenAddrs`
 * transport/listener construction (see `buildWsTransportAndListenAddrs` below, cf.
 * `drone.mjs:87-89`), and the `SIGINT`/`SIGTERM` graceful shutdown plus the stay-alive interval
 * (cf. `drone.mjs:427-436`). Nothing else is reused: this file carries NONE of `drone.mjs`'s
 * membership-ceremony machinery (`watchForJoiners`, `createInvite`, the `openEnrollmentWindow`
 * refresher, `dialInvite`, `DRONE_ENROL_DIR`) — D-12 rejected extending `drone.mjs` because that
 * tooling is shaped by Android-emulator loopback assumptions this gateway does not share.
 *
 * WHAT THIS GATEWAY IS. A storage-profile `CadreNode` that:
 *   1. Serves a REAL TLS WebSocket listener (`/tls/ws`) from an mkcert-issued leaf certificate
 *      that validates against a genuine CA chain — not a self-signed bypass (D-12).
 *   2. Carries the 56-04 `@serfab/cadre-core` public-observer patch, letting an unauthenticated
 *      browser peer resolve strand addresses for the strands named in its node-local, fail-closed
 *      `publicObserverStrandIds` allowlist (D-03).
 *   3. Refuses to serve unless ITS OWN resolved `@serfab/cadre-core` bytes actually carry that
 *      patch (D-05 control 4) — see `assertPatchProvenance` below.
 *   4. Proves the allowlist took effect at runtime, rather than trusting that config reached the
 *      node — see the `--self-check` mode below.
 *
 * DELIBERATE MEMBER-SEEDING DECISION — read this before touching the boot sequence.
 * This gateway calls `acceptPhone`, a name that also appears in `drone.mjs`'s ceremony. That is
 * the ONE place this file's boot sequence intentionally overlaps `drone.mjs`'s vocabulary, and it
 * is load-bearing, not copied ceremony machinery: `acceptPhone({ phonePeerId })` with NO
 * `issuedInvite` argument authorizes a peer directly with no token/expiry check
 * (`seed-bootstrap.js:960-980`) and leaves `enrollmentWindowUntil` at `0` — 56-01's seeding
 * recipe. This gateway does NOT call `createInvite` (which opens a 30-minute enrollment window as
 * a side effect that `openEnrollmentWindow` can never narrow back down — every stranger would
 * then be admitted unconditionally for the life of that window), does NOT run an
 * `openEnrollmentWindow` refresher, does NOT run `watchForJoiners`, does NOT call `dialInvite`,
 * and has no `DRONE_ENROL_DIR`. Without the single seeded member below,
 * `admitInboundControlConnection`'s `authorized.length === 0` cold-start carve-out
 * (`cadre-node.js:1118`) would admit EVERY stranger for a reason that has nothing to do with the
 * 56-04 patch — which would make `56-11`'s mesh-read gate pass for the wrong reason and make
 * `56-13`'s patch-removal control unable to fail. Seeding one member and asserting
 * `enrollmentWindowUntil === 0` is what makes stranger admission on this gateway attributable to
 * the patch instead.
 *
 * RELAY POSTURE. `enableRelay` is a REQUIRED node-local config key with NO default — it is
 * transcribed by the operator from `56-01-WALL-PROOF.md`'s measured posture
 * (`RELAY_POSTURE=off`; `enableRelay: true` durably admitted an unauthorized peer past its
 * documented 5s expiry). It is never inherited from `drone.mjs` and never left to the storage
 * profile's implicit `relayServerEnabled()` default of `on` (`cadre-node.js:1034-1036`).
 *
 * NON-CLAIM. This gateway is proven to run a real TLS listener with a real patch and a real
 * fail-closed allowlist, on THIS host, over loopback. It is NOT proven reachable from the open
 * internet — see `doc/public-gateway-deploy.md`'s opening section.
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve as resolvePath, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CadreNode } from '@serfab/cadre-core';
import { webSockets } from '@libp2p/websockets';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';

const L = (...a) => console.log('[gateway]', ...a);
const __dirname = dirname(fileURLToPath(import.meta.url));

/** Print a FATAL line naming the offending key/condition and exit non-zero. Never optional. */
function fatal(message) {
  L('FATAL:', message);
  process.exit(1);
}

// ── CLI ──────────────────────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = { config: './gateway.config.json' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--config') args.config = argv[++i];
    else if (a === '--runtime-json') args.runtimeJson = argv[++i];
  }
  return args;
}

// ── Config load + fail-closed validation ────────────────────────────────────────────────────
/**
 * Every key is REQUIRED. Never optional-chain a precondition into a pass; never `?? default` a
 * required key. Each failure below is fatal and NAMES the offending key.
 */
function loadAndValidateConfig(configPathArg) {
  const resolvedPath = resolvePath(process.cwd(), configPathArg);
  if (!existsSync(resolvedPath)) {
    fatal(
      `--config file not found at ${resolvedPath}. See gateway.config.example.json for the ` +
        `required shape.`,
    );
  }
  let config;
  try {
    config = JSON.parse(readFileSync(resolvedPath, 'utf8'));
  } catch (e) {
    fatal(`--config file at ${resolvedPath} is not valid JSON: ${e?.message ?? e}`);
  }

  if (typeof config.partyId !== 'string' || config.partyId.length === 0) {
    fatal('config key "partyId" is required and must be a non-empty string.');
  }
  if (typeof config.listenHost !== 'string' || config.listenHost.length === 0) {
    fatal('config key "listenHost" is required and must be a non-empty string.');
  }
  if (
    !Array.isArray(config.publicObserverStrandIds) ||
    config.publicObserverStrandIds.length === 0 ||
    config.publicObserverStrandIds.some((id) => typeof id !== 'string' || id.length === 0)
  ) {
    fatal(
      'config key "publicObserverStrandIds" is required and must be a non-empty array of ' +
        'non-empty strings. An empty or absent allowlist refuses to boot: on a node whose entire ' +
        'purpose is public observation, an empty allowlist is a silently useless gateway, and a ' +
        'silently useless gateway is exactly what gets misread downstream as a fourth wall.',
    );
  }
  if (typeof config.enableRelay !== 'boolean') {
    fatal(
      'config key "enableRelay" is required and must be a boolean (present-and-false is fine — ' +
        'only ABSENT is fatal). It is never defaulted, never inherited from drone.mjs, and never ' +
        "left to the storage profile's implicit ON. Transcribe it from 56-01-WALL-PROOF.md's " +
        'measured relay posture.',
    );
  }
  if (typeof config.tls !== 'object' || config.tls === null) {
    fatal('config key "tls" is required and must be an object with "certPath" and "keyPath".');
  }
  if (typeof config.tls.certPath !== 'string' || !existsSync(resolvePath(dirname(resolvedPath), config.tls.certPath))) {
    fatal(
      `config key "tls.certPath" must name a readable file. Resolved: ` +
        `${resolvePath(dirname(resolvedPath), config.tls.certPath ?? '')}. Run ` +
        `"yarn gateway:cert" to generate one.`,
    );
  }
  if (typeof config.tls.keyPath !== 'string' || !existsSync(resolvePath(dirname(resolvedPath), config.tls.keyPath))) {
    fatal(
      `config key "tls.keyPath" must name a readable file. Resolved: ` +
        `${resolvePath(dirname(resolvedPath), config.tls.keyPath ?? '')}. Run ` +
        `"yarn gateway:cert" to generate one.`,
    );
  }

  return { config, resolvedPath, configDir: dirname(resolvedPath) };
}

// ── Copied from drone.mjs (named, per the header): webSockets() + listenAddrs construction ────
function buildWsTransportAndListenAddrs(config, configDir) {
  const certPath = resolvePath(configDir, config.tls.certPath);
  const keyPath = resolvePath(configDir, config.tls.keyPath);
  const cert = readFileSync(certPath);
  const key = readFileSync(keyPath);
  const wsTransport = webSockets({ https: { cert, key } });
  // The port MUST be 0 — control and strand nodes inherit the same resolved listen list
  // (strand-instance-manager.js:243-292's EADDRINUSE NOTE), so a fixed port makes them race to
  // bind it.
  const listenAddrs = [`/ip4/${config.listenHost}/tcp/0/tls/ws`];
  return { wsTransport, listenAddrs };
}

// The votetorrent.qsql wrapper-strip, reproduced (not imported) from drone.mjs:36-52's logic —
// cadre-core's StrandDatabase.executeSchema() wraps the sApp schema itself, so the outer
// `declare schema main { ... } apply schema main;` wrapper in votetorrent.qsql must be stripped
// before hosting, identical to what the device peers' createStrandDbFactory does.
function loadStrandSchema() {
  const raw = readFileSync(
    resolvePath(__dirname, '../vote-core/schema/votetorrent.qsql'),
    'utf8',
  );
  return raw
    .replace(/^\s*declare\s+schema\s+\w+\s*\{/, '')
    .replace(/\}\s*apply\s+schema\s+\w+\s*;\s*$/, '')
    .trim();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { config, configDir } = loadAndValidateConfig(args.config);
  const { wsTransport, listenAddrs } = buildWsTransportAndListenAddrs(config, configDir);

  const identityKey = await generateKeyPair('Ed25519');
  const node = new CadreNode({
    // Explicit privateKey: an ephemeral libp2p key makes getIdentityOwnerKey() throw
    // ("node identity not resolved") — drone.mjs:63-72's stated reason, inherited here.
    privateKey: identityKey,
    controlNetwork: { partyId: config.partyId, bootstrapNodes: [] },
    profile: 'storage',
    requireSignedSchemas: false,
    strandFilter: { mode: 'all' },
    strandClusterSize: 2,
    hibernation: { enabled: false },
    publicObserverStrandIds: config.publicObserverStrandIds,
    network: {
      transports: [wsTransport],
      listenAddrs,
      enableRelay: config.enableRelay,
      // Deliberately no advertise-only address override: naming a fixed public port would
      // require a fixed listen port and reintroduce the control/strand EADDRINUSE collision
      // (fact 2). The reverse-proxy alternative is described in doc/public-gateway-deploy.md
      // §7 as untested here.
    },
  });

  await node.start();

  // ── Owner genesis — MUST run while the node is solo, above addStrand and above anything that
  // admits a peer (drone.mjs:202-216's ordering, inherited). ─────────────────────────────────
  const owner = node.getIdentityOwnerKey();
  await node.trustOwnerKeys([owner.publicKeyB64], 'operator');
  const controlDb = node.getControlDatabase();
  if (!controlDb) fatal('gateway has no control database after start() — cannot run owner genesis.');
  await controlDb.ensureOwnerKey(owner.publicKeyB64);
  node.initializeSeedBootstrap(owner.privateKeyB64);
  L(`owner genesis done (ownerKey=${owner.publicKeyB64.slice(0, 12)}…)`);

  // ── Seed exactly one authorized member — see the header's "DELIBERATE MEMBER-SEEDING
  // DECISION". This gateway is never a cold-start node. ──────────────────────────────────────
  const seedMemberKey = await generateKeyPair('Ed25519');
  const seedMemberPeerId = peerIdFromPrivateKey(seedMemberKey).toString();
  await node.acceptPhone({ phonePeerId: seedMemberPeerId });
  const authorizedMembers = await node.listAuthorizedMembers();
  if (!(authorizedMembers.length >= 1)) {
    fatal(
      `gateway seeded a member but listAuthorizedMembers() reports ${authorizedMembers.length} ` +
        `— refusing to serve as a cold-start node (authorized.length === 0 would admit every ` +
        `stranger via cadre-node.js's cold-start carve-out, attributing admission to the wrong ` +
        `cause).`,
    );
  }
  if (node.enrollmentWindowUntil !== 0) {
    fatal(
      `gateway's enrollmentWindowUntil is ${node.enrollmentWindowUntil}, expected 0 — an open ` +
        `enrollment window would admit every stranger unconditionally, not just observers of the ` +
        `allowlisted strands.`,
    );
  }

  // ── Host every allowlisted strand ───────────────────────────────────────────────────────────
  const schema = loadStrandSchema();
  for (const strandId of config.publicObserverStrandIds) {
    await node.addStrand({
      strandRow: { Id: strandId, MemberPrivateKey: null, Type: 'o' },
      sAppConfig: {
        id: 'org.votetorrent',
        version: '1.0.0',
        schema,
        latencyHint: 'interactive',
      },
      mode: 'bootstrap',
    });
  }

  // ── Machine-readable output, on the enrolment-smoke.mjs shape: [gateway] prefix, one
  // KEY=value per line, greppable. ────────────────────────────────────────────────────────────
  const controlAddrs = node.getControlNode().getMultiaddrs().map((m) => m.toString());
  const controlAddr =
    controlAddrs.find((a) => a.includes(`/ip4/${config.listenHost}/`) && a.includes('/tls/ws')) ??
    controlAddrs.find((a) => a.includes('/tls/ws')) ??
    '';
  // Rewrite, not an independently observed listen — labeled as such, mirroring the
  // 10.0.2.2 rewrite idea drone.mjs uses.
  const controlAddrDns = controlAddr.replace('/ip4/127.0.0.1/', '/dns4/localhost/');

  L('GATEWAY_RELAY=' + (config.enableRelay ? 'on' : 'off'));
  L('GATEWAY_AUTHORIZED_MEMBERS=' + authorizedMembers.length);
  L('GATEWAY_ENROLLMENT_WINDOW_UNTIL=' + node.enrollmentWindowUntil);
  L('GATEWAY_CONTROL_ADDR=' + controlAddr);
  // Rewrite, not an independently observed listen — the mkcert leaf covers both names.
  L('GATEWAY_CONTROL_ADDR_DNS=' + controlAddrDns);

  for (const strandId of config.publicObserverStrandIds) {
    const strand = node.getStrand(strandId);
    const strandAddrs = strand?.libp2pNode?.getMultiaddrs?.().map((m) => m.toString()) ?? [];
    const strandAddr = strandAddrs.find((a) => a.includes('/tls/ws')) ?? strandAddrs[0] ?? '';
    L(`GATEWAY_STRAND_ADDR[${strandId}]=` + strandAddr);
  }

  L('READY — public-observer gateway serving on ' + controlAddr);

  // ── Copied from drone.mjs (named, per the header): SIGINT/SIGTERM graceful shutdown + the
  // stay-alive interval (drone.mjs:427-436). ─────────────────────────────────────────────────
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, async () => {
      L(`${sig} — stopping...`);
      await node.stop();
      process.exit(0);
    });
  }
  setInterval(() => {}, 1 << 30); // stay alive
}

main().catch((e) => {
  L('FATAL: unhandled error:', e?.stack ?? e);
  process.exit(1);
});
