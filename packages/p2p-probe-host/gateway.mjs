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
import { readFileSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve as resolvePath, dirname, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { X509Certificate, createHash } from 'node:crypto';
import { CadreNode, RELAY_ADMISSION_RESERVE_DEADLINE_MS } from '@serfab/cadre-core';
import { webSockets } from '@libp2p/websockets';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { multiaddr } from '@multiformats/multiaddr';
import { createLibp2pNode } from '@optimystic/db-p2p/rn';

const L = (...a) => console.log('[gateway]', ...a);
const __dirname = dirname(fileURLToPath(import.meta.url));

/** Print a FATAL line naming the offending key/condition and exit non-zero. Never optional. */
function fatal(message) {
  L('FATAL:', message);
  process.exit(1);
}

// ── CLI ──────────────────────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = { config: './gateway.config.json', runtimeJson: './gateway-runtime.json' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--config') args.config = argv[++i];
    else if (a === '--runtime-json') args.runtimeJson = argv[++i];
    else if (a === '--check-dist') args.checkDist = argv[++i];
    else if (a === '--self-check') args.selfCheck = true;
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

// ── D-05 control 4: boot-time provenance gate ──────────────────────────────────────────────────
//
// The token this gate checks is IMPORTED from the package under test — never copied as a
// literal — and its EXPECTED value is assembled at runtime from separate fragments, so the
// protocol literal never appears as one contiguous string anywhere in this file's own source and
// a comment-stripped grep of this file for it can never be self-satisfied
// (project_self_tripping_checker_headers — three recurrences in Phase 53; this is the fourth
// place that lesson gets applied).
const PROTOCOL_TOKEN_FRAGMENTS = ['/sereus', 'public-observer', '1.0.0'];
const EXPECTED_OBSERVER_PROTOCOL = PROTOCOL_TOKEN_FRAGMENTS.join('/');
const OBSERVER_MODULE_BASENAME = 'strand-observer-protocol.js';
const CADRE_NODE_BASENAME = 'cadre-node.js';
const GATER_BASENAME = 'membership-connection-gater.js';
// The gater-registration half of the 56-04 patch. Not fragment-split — only the protocol
// literal is required (by acceptance) to be absent from this file's contiguous source.
const GATER_POLICY_TOKEN = 'admitPublicObservers';

/** Recursively list every `*.js` file under `dir` (excludes `*.js.map` — `.js.map` never matches `.endsWith('.js')`). */
function walkJsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolvePath(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkJsFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

/** Strip `/* *‍/` block comments and `//` line comments before counting occurrences. */
function stripJsComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => {
      const idx = line.indexOf('//');
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join('\n');
}

function countOccurrences(haystack, needle) {
  if (needle.length === 0) return 0;
  return haystack.split(needle).length - 1;
}

/**
 * Walk up from `fromFile` until a `package.json` named `@serfab/cadre-core` is found.
 * Provenance is a per-workspace property (56-04 fact 5: three per-workspace copies, no root
 * copy) — this walk finds the root of the SPECIFIC copy `fromFile` was resolved from.
 */
function findPackageRoot(fromFile) {
  let dir = dirname(fromFile);
  for (let i = 0; i < 12; i++) {
    const pkgJsonPath = resolvePath(dir, 'package.json');
    if (existsSync(pkgJsonPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
        if (pkg.name === '@serfab/cadre-core') return dir;
      } catch {
        // keep walking — a malformed intermediate package.json is not this package's root
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`could not find a @serfab/cadre-core package root walking up from ${fromFile}`);
}

/**
 * Run the full provenance decision matrix against an arbitrary resolved `@serfab/cadre-core`
 * package root. This is the inversion handle: `--check-dist <packageRoot>` calls this directly
 * against ANY root, including a pristine `npm pack`ed tarball — proving the check can FAIL.
 */
async function checkProvenance(packageRootAbsPath) {
  const pkgJsonPath = resolvePath(packageRootAbsPath, 'package.json');
  if (!existsSync(pkgJsonPath)) {
    return { verdict: 'FAIL', reason: 'package-json-unreadable', packageRootAbsPath };
  }
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
  } catch (e) {
    return {
      verdict: 'FAIL',
      reason: 'package-json-unreadable',
      packageRootAbsPath,
      error: e?.message ?? String(e),
    };
  }

  // The token is IMPORTED from the resolved package's own dist bytes — never a copied literal.
  // A pristine, unpatched 0.12.0 has no such export: this import either throws or resolves to
  // `undefined`, and EITHER outcome is `token-unavailable` — it must never degrade into a
  // zero-count that reads as clean.
  const indexPath = resolvePath(packageRootAbsPath, 'dist/index.js');
  let token;
  try {
    const mod = await import(pathToFileURL(indexPath).href);
    token = mod.STRAND_OBSERVER_PROTOCOL;
  } catch {
    token = undefined;
  }
  if (typeof token !== 'string' || token.length === 0) {
    return { verdict: 'FAIL', reason: 'token-unavailable', packageRootAbsPath, version: pkg.version };
  }
  if (token !== EXPECTED_OBSERVER_PROTOCOL) {
    return {
      verdict: 'FAIL',
      reason: 'token-mismatch',
      packageRootAbsPath,
      version: pkg.version,
      observedToken: token,
    };
  }

  const distDir = resolvePath(packageRootAbsPath, 'dist');
  const jsFiles = existsSync(distDir) ? walkJsFiles(distDir) : [];
  const hits = [];
  for (const file of jsFiles) {
    const stripped = stripJsComments(readFileSync(file, 'utf8'));
    const n = countOccurrences(stripped, EXPECTED_OBSERVER_PROTOCOL);
    if (n > 0) hits.push({ file, count: n });
  }
  const singleFileBasename = hits.length === 1 ? basename(hits[0].file) : undefined;
  if (hits.length !== 1 || hits[0].count !== 1 || singleFileBasename !== OBSERVER_MODULE_BASENAME) {
    return {
      verdict: 'FAIL',
      reason: 'occurrence-count',
      packageRootAbsPath,
      version: pkg.version,
      hits: hits.map((h) => ({ file: h.file, count: h.count })),
    };
  }

  const cadreNodePath = resolvePath(distDir, CADRE_NODE_BASENAME);
  const gaterPath = resolvePath(distDir, GATER_BASENAME);
  const cadreNodeSrc = existsSync(cadreNodePath) ? readFileSync(cadreNodePath, 'utf8') : '';
  const gaterSrc = existsSync(gaterPath) ? readFileSync(gaterPath, 'utf8') : '';
  if (!cadreNodeSrc.includes(GATER_POLICY_TOKEN) || !gaterSrc.includes(GATER_POLICY_TOKEN)) {
    return { verdict: 'FAIL', reason: 'gater-missing', packageRootAbsPath, version: pkg.version };
  }

  return {
    verdict: 'PASS',
    packageRootAbsPath,
    version: pkg.version,
    occurrenceCount: hits[0].count,
    occurrenceFile: hits[0].file,
    // The token AS OBSERVED from the resolved package's own export — threaded through to
    // EFFECT_REGISTERED so that rung also checks a value obtained from the package, not a
    // literal declared in this file.
    observedToken: token,
  };
}

function formatProvenanceLine(result) {
  if (result.verdict === 'PASS') {
    return (
      `PROVENANCE=PASS path=${result.packageRootAbsPath} version=${result.version} ` +
      `occurrences=${result.occurrenceCount}`
    );
  }
  return (
    `PROVENANCE=FAIL:${result.reason} path=${result.packageRootAbsPath}` +
    (result.version ? ` version=${result.version}` : '')
  );
}

/**
 * The boot-time gate. Resolves the package the RUNNING process actually loaded — never a
 * hand-picked path — walks it to its package root, asserts that root is the
 * `packages/p2p-probe-host` workspace copy (per-workspace property, 56-04 fact 5: three copies,
 * no root copy — a check against another workspace's copy proves nothing about THIS process),
 * then runs the full decision matrix. Fatal, unconditional: no result from this gateway may be
 * reported without a PROVENANCE=PASS line from the SAME process.
 */
async function assertPatchProvenanceForBoot() {
  // @serfab/cadre-core's package.json exposes only an ESM "import" export condition (no
  // "require"), so a CJS createRequire().resolve() throws "No \"exports\" main defined" —
  // import.meta.resolve is the module-system-correct way to ask "what would THIS process's own
  // import actually load" for an ESM-exports-only package (Node >=20.6, unflagged in this repo's
  // pinned Node 22 line).
  let resolvedIndexUrl;
  try {
    resolvedIndexUrl = import.meta.resolve('@serfab/cadre-core');
  } catch (e) {
    fatal(`PROVENANCE=FAIL:unresolvable — could not resolve @serfab/cadre-core from the running process: ${e?.message ?? e}`);
  }
  const resolvedIndexPath = fileURLToPath(resolvedIndexUrl);
  const packageRoot = findPackageRoot(resolvedIndexPath);
  if (!packageRoot.includes('packages/p2p-probe-host/node_modules')) {
    fatal(
      `PROVENANCE=FAIL:wrong-workspace path=${packageRoot} — resolved @serfab/cadre-core is not ` +
        `the packages/p2p-probe-host workspace copy. Provenance is a per-workspace property ` +
        `(three copies, no root copy) — a check against another workspace's copy proves nothing ` +
        `about this process.`,
    );
  }
  const result = await checkProvenance(packageRoot);
  if (result.verdict !== 'PASS') {
    fatal(formatProvenanceLine(result));
  }
  L(formatProvenanceLine(result));
  return result;
}

// ── --self-check: prove the D-03 allowlist actually took effect at runtime ─────────────────────

/** EFFECT_ALLOWLIST — the live Set off the started node, never the config object. */
function checkAllowlistRung(node, configuredIds) {
  const live = node.publicObserverStrandIds;
  if (!(live instanceof Set)) {
    throw new Error(
      'node.publicObserverStrandIds is not a Set (a plausible outcome of a future @serfab/* ' +
        'bump) — refusing to report a silently-skipped precondition as green.',
    );
  }
  if (live.size !== configuredIds.length || !configuredIds.every((id) => live.has(id))) {
    throw new Error(
      `live Set size=${live.size} members=[${[...live].join(',')}] does not match configured=` +
        `[${configuredIds.join(',')}]`,
    );
  }
  return { size: live.size, members: [...live] };
}

/**
 * EFFECT_HOSTED — for each `strandId`, `node.getStrand(id)` must be defined with a non-empty,
 * all-`/tls/ws` multiaddr list. Exported as a standalone function (mirroring
 * `processObserverRequest`'s own "exposed, not private" rationale) so it is unit-testable
 * against an arbitrary `strandIds` list, independent of what this process's own boot sequence
 * happened to pass to `addStrand` — see 56-08-SUMMARY.md's falsifiability-handle note.
 */
function checkHostedRung(node, strandIds) {
  for (const strandId of strandIds) {
    const strand = node.getStrand(strandId);
    if (!strand) {
      throw new Error(`getStrand(${strandId}) is undefined — this gateway does not host it`);
    }
    const addrs = strand.libp2pNode?.getMultiaddrs?.().map((m) => m.toString()) ?? [];
    if (addrs.length === 0) {
      throw new Error(`strand ${strandId} is hosted but has no listen multiaddrs`);
    }
    if (!addrs.every((a) => a.includes('/tls/ws'))) {
      throw new Error(`strand ${strandId} advertises a non-/tls/ws address: ${addrs.join(',')}`);
    }
  }
  return { strandIds };
}

/**
 * EFFECT_REGISTERED — the control node's own libp2p registrar lists the observer token.
 * `expectedToken` is threaded in from the provenance result's `observedToken` — obtained from
 * the resolved package's own export, not a literal declared in this file — so this rung checks
 * a value the process actually observed, not one it assumed.
 */
function checkRegisteredRung(node, expectedToken) {
  const protocols = node.getControlNode().getProtocols();
  if (!protocols.includes(expectedToken)) {
    throw new Error(
      `control node protocols do not include the observer token; registered=[${protocols.join(',')}]`,
    );
  }
  return { token: expectedToken };
}

/**
 * EFFECT_GATER — the ordering hazard's only honest observable (56-04: the gater closure is
 * built before the observer service registers, so an allowlist wired at the wrong site leaves
 * the gater reading an empty Set even though the handler is live). Stands an ephemeral,
 * anonymous outsider libp2p node and dials the gateway's own control address, holding past the
 * relay branch's partial-admission deadline. Connection-level admission ONLY — this rung
 * deliberately does not dial the observer protocol, does not probe strand-addr, and does not
 * exercise an unlisted strandId; those are 56-07's controls 2/3, not this gateway's.
 */
async function checkGaterRung(node, config) {
  const controlAddrs = node.getControlNode().getMultiaddrs().map((m) => m.toString());
  const dialAddr = controlAddrs.find((a) => a.includes('/tls/ws'));
  if (!dialAddr) throw new Error('no /tls/ws control address to dial');

  const holdMs = RELAY_ADMISSION_RESERVE_DEADLINE_MS + 3000; // comfortably past the deadline
  let outsider;
  try {
    outsider = await createLibp2pNode({
      transports: [webSockets()],
      listenAddrs: [],
      bootstrapNodes: [],
      networkName: `control-${config.partyId}`,
      fretProfile: 'edge',
    });
    const t0 = Date.now();
    let conn;
    try {
      conn = await outsider.dial(multiaddr(dialAddr));
    } catch (e) {
      throw new Error(
        `dial to ${dialAddr} failed: ${e?.message ?? e} — if this looks like a TLS error, ` +
          `confirm NODE_EXTRA_CA_CERTS names the mkcert root; a TLS failure here is NOT an ` +
          `admission refusal and must not be misattributed as one.`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, holdMs));
    const survivedMs = Date.now() - t0;
    const stillOpen =
      conn.status === 'open' || outsider.getConnections(conn.remotePeer).length > 0;
    if (!stillOpen) {
      throw new Error(
        `connection did not survive ${holdMs}ms past dial (relay deadline is ` +
          `${RELAY_ADMISSION_RESERVE_DEADLINE_MS}ms; status=${conn.status}) — classify as DENIED, ` +
          `not as an unclassifiable timeout.`,
      );
    }
    if (survivedMs < RELAY_ADMISSION_RESERVE_DEADLINE_MS) {
      throw new Error(
        `unclassifiable: survived only ${survivedMs}ms, less than the relay deadline ` +
          `${RELAY_ADMISSION_RESERVE_DEADLINE_MS}ms — refusing to report a verdict rather than ` +
          `guess.`,
      );
    }
    return { survivedMs, relayDeadlineMs: RELAY_ADMISSION_RESERVE_DEADLINE_MS, relayEnabled: config.enableRelay };
  } finally {
    try {
      await outsider?.stop();
    } catch {
      // best effort
    }
  }
}

function resolveCaRootPath() {
  if (process.env.NODE_EXTRA_CA_CERTS) return process.env.NODE_EXTRA_CA_CERTS;
  try {
    const out = execFileSync('mkcert', ['-CAROOT'], { encoding: 'utf8' }).trim();
    return resolvePath(out, 'rootCA.pem');
  } catch {
    return null;
  }
}

function computeSpkiSha256Base64(certPath) {
  try {
    const cert = new X509Certificate(readFileSync(certPath));
    const spkiDer = cert.publicKey.export({ type: 'spki', format: 'der' });
    return createHash('sha256').update(spkiDer).digest('base64');
  } catch {
    return null;
  }
}

/**
 * Write the 56-11/56-13 handoff. On a provenance failure this is called with `status: 'refused'`
 * and no addresses, so a failed run leaves evidence that cannot be mistaken for a usable handoff.
 */
function writeHandoff(path, payload) {
  writeFileSync(path, JSON.stringify(payload, null, 2) + '\n');
  L('wrote handoff to ' + path);
}

const NON_CLAIMS = [
  'This gateway is NOT proven reachable from the open internet.',
  'This certificate is trusted only on hosts where the mkcert local CA is installed.',
];
const CONSUMER_NOTES = [
  "libp2p's browser/RN default connection gater denies loopback and private dials (spike 009's " +
    "'connection gater denied all addresses' blocker) — a browser Edge node must supply its own " +
    "denyDialMultiaddr override or it will refuse this gateway's own address.",
  'Ports are ephemeral and change every boot. Consumers MUST confirm `pid` names a live process ' +
    'before trusting `controlAddrs`/`strandAddrs` — a stale handoff pointing at a dead port is ' +
    'the same failure class as project_device_proof_bundle_provenance.',
];

async function runSelfCheck({ node, config, provenanceResult, runtimeJsonPath, controlAddr, controlAddrDns, strandAddrsByStrandId, certPath }) {
  let ok = true;
  const effects = {};

  try {
    effects.allowlist = { pass: true, ...checkAllowlistRung(node, config.publicObserverStrandIds) };
    L(`EFFECT_ALLOWLIST=PASS size=${effects.allowlist.size} members=${effects.allowlist.members.join(',')}`);
  } catch (e) {
    ok = false;
    effects.allowlist = { pass: false, error: e?.message ?? String(e) };
    L('EFFECT_ALLOWLIST=FAIL ' + effects.allowlist.error);
  }

  try {
    checkHostedRung(node, config.publicObserverStrandIds);
    effects.hosted = { pass: true, strandIds: config.publicObserverStrandIds };
    L('EFFECT_HOSTED=PASS strands=' + config.publicObserverStrandIds.join(','));
  } catch (e) {
    ok = false;
    effects.hosted = { pass: false, error: e?.message ?? String(e) };
    L('EFFECT_HOSTED=FAIL ' + effects.hosted.error);
  }

  try {
    effects.registered = { pass: true, ...checkRegisteredRung(node, provenanceResult.observedToken) };
    L('EFFECT_REGISTERED=PASS token=' + effects.registered.token);
  } catch (e) {
    ok = false;
    effects.registered = { pass: false, error: e?.message ?? String(e) };
    L('EFFECT_REGISTERED=FAIL ' + effects.registered.error);
  }

  try {
    effects.gater = { pass: true, ...(await checkGaterRung(node, config)) };
    L(
      `EFFECT_GATER=PASS survivedMs=${effects.gater.survivedMs} ` +
        `relayDeadlineMs=${effects.gater.relayDeadlineMs} relayEnabled=${effects.gater.relayEnabled}`,
    );
  } catch (e) {
    ok = false;
    effects.gater = { pass: false, error: e?.message ?? String(e) };
    L('EFFECT_GATER=FAIL ' + effects.gater.error);
  }

  const payload = {
    schemaVersion: 1,
    status: ok ? 'ok' : 'refused',
    cadreCoreVersion: provenanceResult.version,
    cadreCoreResolvedPath: provenanceResult.packageRootAbsPath,
    provenance: {
      verdict: provenanceResult.verdict,
      tokenOccurrences: provenanceResult.occurrenceCount,
      checkedPath: provenanceResult.packageRootAbsPath,
    },
    controlAddrs: ok ? [controlAddr] : [],
    controlAddrsDns: ok ? [controlAddrDns] : [],
    strandAddrs: ok ? strandAddrsByStrandId : {},
    publicObserverStrandIds: config.publicObserverStrandIds,
    enableRelay: config.enableRelay,
    tls: {
      certPath,
      caRoot: resolveCaRootPath(),
      spkiSha256Base64: computeSpkiSha256Base64(certPath),
    },
    bootedAt: new Date().toISOString(),
    pid: process.pid,
    effects,
    nonClaims: NON_CLAIMS,
    consumerNotes: CONSUMER_NOTES,
  };
  writeHandoff(runtimeJsonPath, payload);
  return { ok, payload };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // ── --check-dist: the inversion handle. Runs the SAME decision matrix against an arbitrary
  // package root and exits on its verdict without booting a node. ────────────────────────────
  if (args.checkDist) {
    const packageRoot = resolvePath(process.cwd(), args.checkDist);
    const result = await checkProvenance(packageRoot);
    L(formatProvenanceLine(result));
    process.exit(result.verdict === 'PASS' ? 0 : 1);
  }

  const { config, configDir } = loadAndValidateConfig(args.config);

  // ── D-05 control 4, unconditional: no result from this gateway may be reported without a
  // PROVENANCE=PASS line from THIS process, printed before the first GATEWAY_* line. ─────────
  const provenanceResult = await assertPatchProvenanceForBoot();

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

  L('GATEWAY_CADRE_CORE_PATH=' + provenanceResult.packageRootAbsPath);
  L('GATEWAY_RELAY=' + (config.enableRelay ? 'on' : 'off'));
  L('GATEWAY_AUTHORIZED_MEMBERS=' + authorizedMembers.length);
  L('GATEWAY_ENROLLMENT_WINDOW_UNTIL=' + node.enrollmentWindowUntil);
  L('GATEWAY_CONTROL_ADDR=' + controlAddr);
  // Rewrite, not an independently observed listen — the mkcert leaf covers both names.
  L('GATEWAY_CONTROL_ADDR_DNS=' + controlAddrDns);

  const strandAddrsByStrandId = {};
  for (const strandId of config.publicObserverStrandIds) {
    const strand = node.getStrand(strandId);
    const strandAddrs = strand?.libp2pNode?.getMultiaddrs?.().map((m) => m.toString()) ?? [];
    const strandAddr = strandAddrs.find((a) => a.includes('/tls/ws')) ?? strandAddrs[0] ?? '';
    strandAddrsByStrandId[strandId] = strandAddrs;
    L(`GATEWAY_STRAND_ADDR[${strandId}]=` + strandAddr);
  }

  L('READY — public-observer gateway serving on ' + controlAddr);

  // ── --self-check: prove the runtime configuration took effect, then write the handoff and
  // exit (one-shot verification run, not the long-running service). ─────────────────────────
  if (args.selfCheck) {
    const certPath = resolvePath(configDir, config.tls.certPath);
    const runtimeJsonPath = resolvePath(process.cwd(), args.runtimeJson);
    const { ok } = await runSelfCheck({
      node,
      config,
      provenanceResult,
      runtimeJsonPath,
      controlAddr,
      controlAddrDns,
      strandAddrsByStrandId,
      certPath,
    });
    await node.stop();
    process.exit(ok ? 0 : 1);
  }

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
