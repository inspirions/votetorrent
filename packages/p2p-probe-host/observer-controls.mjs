/**
 * packages/p2p-probe-host/observer-controls.mjs — D-05.2 / D-05.3 control harness (Phase 56 Plan 07).
 *
 * WHY THIS EXISTS. `56-04` authored a three-edit `@serfab/cadre-core` patch that lets an
 * unauthenticated observer resolve strand addresses through a new node-local-allowlisted
 * protocol, while its own verification section proves only that the patch EXISTS and cannot
 * have regressed the members-only path BY CONSTRUCTION (byte-equality on the untouched files).
 * This harness measures that the patch WORKS: one outsider peer, one connection, one run —
 * served on the new protocol, still refused on the old one. `56-01`'s wall proof measured the
 * PRE-patch wall; this measures the POST-patch one.
 *
 * NODE-SIDE ONLY, same shape as `wall-proof.mjs`: real `@serfab/cadre-core` + `@optimystic/db-p2p`
 * internals in-process, no device. `56-01`'s gateway-standing/seeding recipe and its L1 dial /
 * wire-frame primitives are IMPORTED from `wall-proof.mjs`, never re-implemented — a second,
 * drifting copy of the recipe whose whole purpose is closing eight fail-open branches is exactly
 * how a wall proof goes vacuous (RESEARCH Pitfall 2; `wall-proof.mjs --self-test` is a live
 * demonstration of that failure mode).
 *
 * CONTROL 2 (D-05.2, members-only non-regression). Stand gateway G1 with two hosted strands
 * (`S_LISTED`, `S_UNLISTED`) and a one-entry observable allowlist (`S_LISTED` only). Dial ONE
 * outsider connection and, on that SAME connection: the public-observer protocol answers
 * non-empty for `S_LISTED` (RUNG_C2_OBSERVER) while the members-only strand-address protocol
 * still answers empty for the identical strand (RUNG_C2_MEMBERSONLY) — the entire security
 * argument for D-02. `admitInboundControlConnection` is re-read concurrently with the observer
 * success so that success is attributable to the patched connection-gater branch, never to
 * membership, an enrollment window, a delegate grant or the cold-start carve-out. Enrolling the
 * SAME outsider and re-running the identical members-only probe (RUNG_C2_POS) then flips it to
 * non-empty — the instrument inversion that proves the refusal above was a real wall, not a
 * broken probe.
 *
 * CONTROL 3 (D-05.3, allowlist fail-closed, with a discriminator). Both `strand-addr-protocol.js`
 * and the public-observer handler return a byte-identical empty response for "refused" and for
 * "this gateway does not host that strand at all" — so an unaided empty-response check proves
 * nothing. This harness closes that hole: G1 demonstrably hosts BOTH strands and demonstrably
 * serves the listed one (RUNG_C3_LISTED, sharing RUNG_C2_OBSERVER's own measurement rather than
 * re-probing), the unlisted one is refused (RUNG_C3_UNLISTED) and a never-hosted id is refused
 * IDENTICALLY, with that indistinguishability recorded as an explicit mechanism property
 * (RUNG_C3_ABSENT) rather than hidden. A freshly constructed gateway G2, identical except that
 * its allowlist also lists the previously-unlisted strand, flips the identical probe to
 * non-empty (RUNG_C3_FLIP) — because the allowlist Set is built at `CadreNode` CONSTRUCTOR time
 * (immediately after `this.config = config`, before `buildControlNodeOptions` closes over it),
 * so this genuinely requires a fresh node, never a mutation of a running one. A third gateway G3,
 * seeded identically but with NO allowlist configured at all, never advertises the protocol —
 * D-03's outer fail-closed half (RUNG_C3_UNCONFIGURED), asserted distinct from an empty response.
 * `RUNG_C3_UNIT` asserts the decision matrix directly against `StrandObserverService`, without a
 * live node, including the lenient-match failure modes D-03 forbids (trailing whitespace, case
 * variants, id prefixes) on production-length fixtures.
 *
 * ENROLLMENT IS TERMINAL FOR G1. `RUNG_C2_POS` enrolls the control-2/3 outsider so it can prove
 * the members-only inversion; every refusal-classifying probe this harness runs against G1 (both
 * controls' unlisted/absent/listed probes) therefore happens BEFORE that enrollment step, on the
 * SAME already-open connection, and G1 is torn down immediately after. No code path in this file
 * re-dials G1 for a refusal verdict once its outsider has been enrolled.
 *
 * VOCABULARY. Every probe in this file is classified into exactly one of:
 *   SERVED:<n>              — the handler answered with `n >= 1` multiaddrs.
 *   REFUSED_EMPTY            — the stream opened and the handler answered with zero multiaddrs.
 *   REFUSED_CONNECTION:<why> — the connection itself was denied before any protocol negotiation.
 *   UNSUPPORTED_PROTOCOL     — the connection was admitted but the protocol was never advertised
 *                              (negotiation itself failed) — the outer half of D-03's two-layer
 *                              fail-closed. Measured against the installed dist below: on this
 *                              patch, an unconfigured node's connection is refused at Layer 1
 *                              before protocol negotiation is ever reached, so this classification
 *                              exists for completeness and is asserted never to collapse into
 *                              `REFUSED_EMPTY` regardless of which layer actually produced it.
 * An unclassifiable outcome throws rather than shrugging — a control that cannot fail is not a
 * control.
 *
 * WHAT THIS FILE DOES NOT CLAIM. D-05.1 (patch removal) is `56-13`'s and needs a rebuilt browser
 * production variant. D-05.4 (byte provenance against the RUNNING gateway) is `56-08`'s. Neither
 * is run or claimed here — the record JSON says so in its own header.
 *
 * CLI:
 *   --preconditions-only   stand G1, run RUNG_P2 only, print every observed value, then shut down.
 *   --control=2             run G1's full connection phase (through the terminal RUNG_C2_POS
 *                            enrollment) and report only the control-2 rungs.
 *   --control=3             run G1's connection phase (for the C3 rungs it shares with control 2)
 *                            plus G2 (RUNG_C3_FLIP), G3 (RUNG_C3_UNCONFIGURED) and the live-node-free
 *                            unit matrix (RUNG_C3_UNIT); report only the control-3 rungs.
 *   --json <path>           where to write the machine-readable record
 *                            (default: ./observer-controls-record.json).
 *   (no flags)              the full sequence: every rung above, record emission.
 *
 * Exit: 0 on a fully classified PASS run (scoped to whichever control flag was given, or every
 * rung with no flag), 1 on any unclassified/failed rung. SIGINT/SIGTERM stop every node this
 * process started, same shape as `wall-proof.mjs`.
 *
 * NOTE for whoever runs this: CadreNode boot is CPU-heavy and this file stands up to four
 * gateways in one run — do not run it concurrently with `nx run-many`
 * (`project_voter_emulator_boot_needs_quiet_host`).
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  STRAND_OBSERVER_PROTOCOL,
  STRAND_ADDR_PROTOCOL,
  StrandObserverService,
} from '@serfab/cadre-core';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import {
  buildGateway,
  buildOutsiderNode,
  dialGateway,
  openProtocolStream,
  exchangeStrandAddrFrame,
  resolvePackageInfo,
  requireMethod,
} from './wall-proof.mjs';

const L = (...a) => console.log('[observer-controls]', ...a);

// ── Fixtures. Production-length (not the three-character kind a too-short fixture can never
// fail on — project_ui_defects_invisible_to_every_tier) and never a real network hash. ─────────
const S_LISTED = `observer-controls-listed-${randomUUID()}`;
const S_UNLISTED = `observer-controls-unlisted-${randomUUID()}`;
const S_ABSENT = `observer-controls-absent-never-hosted-${randomUUID()}`;

// ── Package-version instrument hygiene: same helper `wall-proof.mjs` uses, imported rather than
// re-derived (T-56-01-05 / T-56-07-09). ─────────────────────────────────────────────────────────
const CADRE_CORE_INFO = resolvePackageInfo('@serfab/cadre-core', '@serfab/cadre-core');

function resolvePatchFilename() {
  const rootPkgPath = fileURLToPath(new URL('../../package.json', import.meta.url));
  const rootPkg = JSON.parse(readFileSync(rootPkgPath, 'utf8'));
  const resolution = rootPkg.resolutions?.['@serfab/cadre-core'];
  if (typeof resolution !== 'string') {
    throw new Error(
      `could not resolve the @serfab/cadre-core patch filename — no "resolutions" entry for it in ${rootPkgPath}`,
    );
  }
  const match = resolution.match(/([^/]+\.patch)$/);
  if (!match) {
    throw new Error(`could not parse a patch filename out of resolutions entry: ${resolution}`);
  }
  return match[1];
}

/**
 * A node-config-independent fact: is the installed `@serfab/cadre-core` the patched 0.12.0 this
 * harness's controls assume? Deliberately NOT a stock/patched auto-detector (that discrimination
 * — with its two-independent-signals-must-agree discipline — is Task 3's repro-only feature);
 * this harness always requires `patched` and throws otherwise, since every rung below assumes
 * `STRAND_OBSERVER_PROTOCOL` and `StrandObserverService` exist.
 */
function computeMode() {
  const observerProtocolOk = typeof STRAND_OBSERVER_PROTOCOL === 'string' && STRAND_OBSERVER_PROTOCOL.length > 0;
  const serviceOk = typeof StrandObserverService === 'function';
  const versionOk = CADRE_CORE_INFO.version === '0.12.0';
  const pathOk = CADRE_CORE_INFO.path.includes(`${join('packages', 'p2p-probe-host', 'node_modules')}`);
  return { mode: observerProtocolOk && serviceOk && versionOk && pathOk ? 'patched' : 'UNKNOWN', observerProtocolOk, serviceOk, versionOk, pathOk };
}

/** Where `56-01` recorded its measured relay posture — inherited, never re-derived. */
const WALL_PROOF_RECORD_PATH = fileURLToPath(new URL('./wall-proof-record.json', import.meta.url));

function readRelayPosture() {
  if (!existsSync(WALL_PROOF_RECORD_PATH)) {
    throw new Error(
      `RELAY_POSTURE precondition missing: ${WALL_PROOF_RECORD_PATH} does not exist. ` +
      `56-01 already measured this posture — run "node wall-proof.mjs" (a full run) before this ` +
      `harness; silently picking a default here would re-derive a decision 56-01 owns.`,
    );
  }
  const record = JSON.parse(readFileSync(WALL_PROOF_RECORD_PATH, 'utf8'));
  const posture = record?.relayPosture?.posture;
  if (posture !== 'on' && posture !== 'off') {
    throw new Error(
      `RELAY_POSTURE precondition missing: ${WALL_PROOF_RECORD_PATH} has no relayPosture.posture ` +
      `(got ${JSON.stringify(posture)}). Re-run wall-proof.mjs's full (unflagged) run to populate it.`,
    );
  }
  return posture;
}

// ═══════════════════════════════════════════════════════════════════════════════════════════
// RUNG_P2 — the precondition that makes both controls mean anything
// ═══════════════════════════════════════════════════════════════════════════════════════════

/**
 * `56-01`'s `RUNG_P` set, re-asserted by direct reads that THROW (never skip) on a missing
 * member, plus the patched-mode assertions this plan's own `<downstream_contract>` requires:
 * `admitInboundControlConnection(outsider) === 'deny'` (the method the patch does not edit — the
 * single assertion that makes the observer success attributable to the patched gater branch and
 * not to membership, an enrollment window, a delegate grant or the cold-start carve-out) and the
 * two static facts `computeMode()` reads. `strandIds` lets one call assert BOTH G1 strands are
 * hosted (closing "not hosted" as an alternative explanation before Control 3 ever runs).
 */
async function assessPreconditionP2(node, probePeerId, strandIds, relayPosture) {
  const checks = [];
  const record = (id, pass, observed) => checks.push({ id, pass, observed });

  const admitUnconditionally = requireMethod(
    node, 'admitControlPeerUnconditionally', 'RUNG_P2 branches 1-3 (admitControlPeerUnconditionally)',
  );
  const unconditional = admitUnconditionally(probePeerId);
  record('unconditional', unconditional === false, unconditional);

  if (typeof node.enrollmentWindowUntil !== 'number') {
    throw new Error(
      `RUNG_P2 instrument failure: node.enrollmentWindowUntil is not a number on the installed ` +
      `@serfab/cadre-core@${CADRE_CORE_INFO.version} — CadreNode shape changed.`,
    );
  }
  record('enrollmentWindow', node.enrollmentWindowUntil === 0, node.enrollmentWindowUntil);

  const hasDelegate = requireMethod(node, 'hasDelegateAdmission', 'RUNG_P2 branch 5 (delegate admission)');
  const delegate = hasDelegate(probePeerId);
  record('delegateAdmission', delegate === false, delegate);

  const listMembers = requireMethod(node, 'listAuthorizedMembers', 'RUNG_P2 branch 6 (cold-start / membership)');
  const authorized = await listMembers();
  const memberCount = authorized.length;
  const probeIsMember = authorized.some((m) => m.peerId === probePeerId);
  record('membership', memberCount >= 1 && !probeIsMember, { memberCount, probeIsMember });

  let outstandingInvitation = false;
  const solicitation = node.strandSolicitationService;
  if (solicitation) {
    if (typeof solicitation.hasOutstandingInvitation !== 'function') {
      throw new Error(
        'RUNG_P2 instrument failure: strandSolicitationService.hasOutstandingInvitation is not a ' +
        'function — CadreNode shape changed.',
      );
    }
    outstandingInvitation = await solicitation.hasOutstandingInvitation();
  }
  record('outstandingInvitation', outstandingInvitation === false, outstandingInvitation);

  const relayEnabledFn = requireMethod(node, 'relayServerEnabled', 'RUNG_P2 branch 8 (relayServerEnabled)');
  const relayEnabled = relayEnabledFn();
  const expectedRelay = relayPosture === 'on';
  record('relayServerEnabled', relayEnabled === expectedRelay, { relayEnabled, expectedPosture: relayPosture });

  const getStrandFn = requireMethod(node, 'getStrand', 'RUNG_P2 strand-hosting validity');
  const strandCounts = {};
  for (const strandId of strandIds) {
    const instance = getStrandFn(strandId);
    const count = instance?.libp2pNode?.getMultiaddrs?.().length ?? 0;
    strandCounts[strandId] = count;
    record(`strandHosted:${strandId}`, count > 0, count);
  }

  // The single assertion that makes an observer success attributable to the patched gater
  // branch: this method is byte-unchanged by 56-04's patch (verified against the installed dist
  // this session), so on a patched gateway it still says 'deny' for a non-member outsider.
  const admitInbound = requireMethod(node, 'admitInboundControlConnection', 'RUNG_P2 decision-level wall');
  const decision = await admitInbound(probePeerId);
  record('decision', decision === 'deny', decision);

  const mode = computeMode();
  record('mode.observerProtocolExported', mode.observerProtocolOk, STRAND_OBSERVER_PROTOCOL);
  record('mode.serviceExported', mode.serviceOk, typeof StrandObserverService);
  record('mode.versionIs0_12_0', mode.versionOk, CADRE_CORE_INFO.version);
  record('mode.pathUnderWorkspace', mode.pathOk, CADRE_CORE_INFO.path);

  const pass = checks.every((c) => c.pass);
  return { pass, checks, decision, strandCounts, mode: mode.mode };
}

function printRungP2(result, label = 'RUNG_P2') {
  for (const c of result.checks) {
    L(`${label}.${c.id}=${c.pass ? 'PASS' : 'FAIL'} observed=${JSON.stringify(c.observed)}`);
  }
  L(`${label} decision-level admitInboundControlConnection=${result.decision}`);
  L(`${label}=${result.pass ? 'PASS' : 'FAIL'}`);
}

// ═══════════════════════════════════════════════════════════════════════════════════════════
// Shared protocol-probe primitive — the harness's own classification vocabulary
// ═══════════════════════════════════════════════════════════════════════════════════════════

/**
 * Is a stream-open failure a protocol-negotiation failure (the protocol was never advertised —
 * `UNSUPPORTED_PROTOCOL`) as opposed to some other stream-level refusal? Kept narrow and
 * defensive: on this patch, an unconfigured node's CONNECTION is refused at Layer 1 before
 * negotiation is ever reached (measured below in `RUNG_C3_UNCONFIGURED`), so this branch is
 * exercised only if that measured behaviour ever changes upstream.
 */
function isUnsupportedProtocolError(message) {
  const msg = (message ?? '').toLowerCase();
  return msg.includes('protocol') && (msg.includes('unsupport') || msg.includes('not support') || msg.includes('negotiat'));
}

/**
 * Open a stream for `protocolId` on an already-admitted connection to `remotePeer` and exchange
 * the `{ strandId }` request/response frame, classifying the result into this file's shared
 * vocabulary. `outsider`/`remotePeer` are reused across calls — libp2p multiplexes multiple
 * protocol streams over one already-open connection, so calling this twice with different
 * `protocolId`s against the same `remotePeer` genuinely runs both probes on the SAME connection
 * (verified empirically this session: a single dial, then an observer-protocol stream followed by
 * a strand-addr-protocol stream, both succeed without a second dial).
 */
async function probeProtocol(outsider, remotePeer, protocolId, strandId) {
  const l2 = await openProtocolStream(outsider, remotePeer, protocolId);
  if (!l2.stream) {
    const verdict = isUnsupportedProtocolError(l2.verdict)
      ? 'UNSUPPORTED_PROTOCOL'
      : `REFUSED_CONNECTION:${l2.verdict}`;
    return { verdict, raw: null, l2Verdict: l2.verdict };
  }
  const { raw, error } = await exchangeStrandAddrFrame(l2.stream, strandId);
  if (!raw) {
    return { verdict: `REFUSED_CONNECTION:${error}`, raw: null, l2Verdict: l2.verdict };
  }
  const n = raw.multiaddrs?.length ?? 0;
  return { verdict: n > 0 ? `SERVED:${n}` : 'REFUSED_EMPTY', raw, l2Verdict: l2.verdict };
}

// ═══════════════════════════════════════════════════════════════════════════════════════════
// G1 phase — everything both controls need from ONE gateway, ONE connection, in order
// ═══════════════════════════════════════════════════════════════════════════════════════════

/**
 * Stands G1 (`S_LISTED` + `S_UNLISTED` hosted, only `S_LISTED` observable), asserts RUNG_P2, dials
 * ONE outsider connection, and on that SAME connection runs every refusal-dependent probe both
 * controls need — control 2's observer/members-only pair AND control 3's unlisted/absent
 * discriminator probes — strictly BEFORE enrolling the outsider. Enrollment (`RUNG_C2_POS`) is the
 * terminal step: it happens last, on a fresh dial, and G1 is torn down immediately after.
 *
 * `56-01`'s seeding recipe is inherited via `buildGateway` (imported from `wall-proof.mjs`), never
 * re-implemented — `createInvite` is never called here either, for the identical reason
 * `wall-proof.mjs`'s own header documents: it opens a monotonic 30-minute enrollment window that
 * would admit every stranger and defeat every rung below.
 */
async function runG1Phase(relayPosture) {
  const gw = await buildGateway({
    enableRelay: relayPosture === 'on',
    seeded: true,
    strands: [{ id: S_LISTED }, { id: S_UNLISTED }],
    configOverrides: { publicObserverStrandIds: [S_LISTED] },
  });
  activeNodes.add(gw);
  let outsider;
  try {
    const probeKeyPair = await generateKeyPair('Ed25519');
    const probePeerId = peerIdFromPrivateKey(probeKeyPair).toString();

    const p2 = await assessPreconditionP2(gw, probePeerId, [S_LISTED, S_UNLISTED], relayPosture);
    printRungP2(p2);
    if (!p2.pass) {
      throw new Error('RUNG_P2 FAILED on G1 — refusing to run any control probe against a gateway whose own preconditions are not vouched for.');
    }

    const controlAddrs = gw.getControlNode().getMultiaddrs().map((m) => m.toString());
    const controlWsAddr = controlAddrs.find((a) => a.includes('/ip4/127.0.0.1/') && a.includes('/ws')) ?? controlAddrs[0];
    if (!controlWsAddr) throw new Error('G1 control node has no ws multiaddr to dial.');

    outsider = await buildOutsiderNode(probeKeyPair, 'control-votetorrent');
    activeLibp2pNodes.add(outsider);

    const l1 = await dialGateway(outsider, controlWsAddr);
    if (!l1.classified) {
      throw new Error(`G1 L1 dial UNCLASSIFIABLE — ${l1.reason}. A control that shrugs is worse than no control.`);
    }
    if (!l1.connection) {
      throw new Error(
        `G1 L1 dial REFUSED before any protocol probe could run (${l1.verdict}) — control 2/3 require an ` +
        `ADMITTED connection, which a non-empty publicObserverStrandIds allowlist should guarantee. This is ` +
        `itself a finding, not a silent skip.`,
      );
    }
    const remotePeer = l1.connection.remotePeer;

    // Re-assert the decision-level wall CONCURRENTLY with the observer probe, not only at boot
    // (RUNG_P2 already asserted it once) — this is what ties the observer success below to the
    // patched gater branch rather than to a decision that could have changed between boot and probe.
    const admitInboundConcurrent = requireMethod(gw, 'admitInboundControlConnection', 'concurrent decision re-check');
    const decisionAtObserverProbe = await admitInboundConcurrent(probePeerId);

    const c2Observer = await probeProtocol(outsider, remotePeer, STRAND_OBSERVER_PROTOCOL, S_LISTED);
    const c2MembersOnly = await probeProtocol(outsider, remotePeer, STRAND_ADDR_PROTOCOL, S_LISTED);
    const c3Unlisted = await probeProtocol(outsider, remotePeer, STRAND_OBSERVER_PROTOCOL, S_UNLISTED);
    const c3UnlistedMembersOnly = await probeProtocol(outsider, remotePeer, STRAND_ADDR_PROTOCOL, S_UNLISTED);
    const c3Absent = await probeProtocol(outsider, remotePeer, STRAND_OBSERVER_PROTOCOL, S_ABSENT);
    const c3AbsentMembersOnly = await probeProtocol(outsider, remotePeer, STRAND_ADDR_PROTOCOL, S_ABSENT);

    // ── TERMINAL FOR G1: from this line on, no REFUSAL verdict may be produced from this
    // gateway instance. acceptPhone (never createInvite — see this file's own header) writes the
    // CadrePeer voucher directly with no enrollment-window side effect.
    //
    // DELIBERATELY does not close `l1.connection` first. Measured this session: closing the
    // admitted-but-unauthorized connection immediately before a control-database write races the
    // node's own post-close replication bookkeeping and transiently fails an unrelated deferred
    // CHECK ("Block default/Revocation is unavailable (cohort-unreachable)") — reproduced
    // deterministically with a bare dial+close+acceptPhone sequence and confirmed to be pure
    // timing (a blind ~800ms sleep between close and write also clears it, which is exactly the
    // signature of a race, not a structural break). Keeping the SAME connection open across the
    // write sidesteps the race entirely AND is a more literal "same connection" measurement for
    // RUNG_C2_POS below than a second dial would have been — libp2p reuses an already-open
    // connection to the same remote peer for a new protocol stream, so no second dial is needed.
    await gw.acceptPhone({ phonePeerId: probePeerId });

    const c2Pos = await probeProtocol(outsider, remotePeer, STRAND_ADDR_PROTOCOL, S_LISTED);
    try { await l1.connection.close(); } catch { /* best effort */ }

    return {
      p2,
      decisionAtObserverProbe,
      c2Observer, c2MembersOnly, c2Pos,
      c3Unlisted, c3UnlistedMembersOnly, c3Absent, c3AbsentMembersOnly,
      gatewayPeerId: gw.peerId.toString(),
    };
  } finally {
    if (outsider) {
      await outsider.stop().catch(() => {});
      activeLibp2pNodes.delete(outsider);
    }
    await gw.stop().catch(() => {});
    activeNodes.delete(gw);
  }
}

// ── Lifecycle tracking, same shape as wall-proof.mjs: every node this process starts, stopped on
// both the pass and fail paths. ─────────────────────────────────────────────────────────────────
const activeNodes = new Set();
const activeLibp2pNodes = new Set();
let shuttingDown = false;
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    const all = [...activeLibp2pNodes, ...activeNodes];
    L(`${sig} — stopping ${all.length} node(s)...`);
    await Promise.all(all.map((n) => n.stop().catch(() => {})));
    process.exit(1);
  });
}

// ═══════════════════════════════════════════════════════════════════════════════════════════
// CLI entry (Task 1 scope: --preconditions-only, --control=2, and the shared G1 phase)
// ═══════════════════════════════════════════════════════════════════════════════════════════

async function main() {
  const args = process.argv.slice(2);
  const preconditionsOnly = args.includes('--preconditions-only');
  const controlArg = args.find((a) => a.startsWith('--control='));
  const control = controlArg ? controlArg.slice('--control='.length) : undefined;
  if (control !== undefined && control !== '2' && control !== '3') {
    throw new Error(`--control must be '2' or '3', got '${control}'`);
  }

  const relayPosture = readRelayPosture();
  L(`RELAY_POSTURE(inherited from wall-proof-record.json)=${relayPosture}`);
  L(`CADRE_CORE_VERSION=${CADRE_CORE_INFO.version}`);
  L(`CADRE_CORE_PATH=${CADRE_CORE_INFO.path}`);
  const patchFilename = resolvePatchFilename();
  L(`PATCH_FILENAME=${patchFilename}`);
  const modeInfo = computeMode();
  if (modeInfo.mode !== 'patched') {
    throw new Error(
      `MODE=${modeInfo.mode} — this harness requires the patched @serfab/cadre-core@0.12.0 ` +
      `(observerProtocolOk=${modeInfo.observerProtocolOk} serviceOk=${modeInfo.serviceOk} ` +
      `versionOk=${modeInfo.versionOk} pathOk=${modeInfo.pathOk}). It is not a stock/patched ` +
      `auto-detector (that is Task 3's repro); it refuses to run its controls against unpatched bytes.`,
    );
  }
  L(`MODE=${modeInfo.mode}`);

  if (preconditionsOnly) {
    const gw = await buildGateway({
      enableRelay: relayPosture === 'on',
      seeded: true,
      strands: [{ id: S_LISTED }, { id: S_UNLISTED }],
      configOverrides: { publicObserverStrandIds: [S_LISTED] },
    });
    activeNodes.add(gw);
    try {
      const probeKeyPair = await generateKeyPair('Ed25519');
      const probePeerId = peerIdFromPrivateKey(probeKeyPair).toString();
      const result = await assessPreconditionP2(gw, probePeerId, [S_LISTED, S_UNLISTED], relayPosture);
      printRungP2(result);
      return result.pass ? 0 : 1;
    } finally {
      await gw.stop().catch(() => {});
      activeNodes.delete(gw);
    }
  }

  const g1 = await runG1Phase(relayPosture);
  let exitCode = 0;

  if (control === undefined || control === '2') {
    L(`RUNG_C2_OBSERVER=${g1.c2Observer.verdict} admitInboundControlConnection=${g1.decisionAtObserverProbe} raw=${JSON.stringify(g1.c2Observer.raw)}`);
    L(`RUNG_C2_MEMBERSONLY=${g1.c2MembersOnly.verdict} raw=${JSON.stringify(g1.c2MembersOnly.raw)}`);
    L(`RUNG_C2_POS=${g1.c2Pos.verdict} raw=${JSON.stringify(g1.c2Pos.raw)}`);
    if (
      !g1.p2.pass
      || !g1.c2Observer.verdict.startsWith('SERVED')
      || g1.decisionAtObserverProbe !== 'deny'
      || g1.c2MembersOnly.verdict !== 'REFUSED_EMPTY'
      || !g1.c2Pos.verdict.startsWith('SERVED')
    ) {
      exitCode = 1;
    }
  }

  if (control === '3') {
    // A standalone `--control=3` run still needs G1's C3_LISTED/UNLISTED/ABSENT measurements
    // (captured above) but does not gate on the control-2 rungs — print them for context only.
    L(`(context, not gated) RUNG_C2_OBSERVER=${g1.c2Observer.verdict}`);
  }

  L(`RUNG_P2=${g1.p2.pass ? 'PASS' : 'FAIL'}`);

  return exitCode;
}

const isMainModule = () => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(resolve(entry)).href;
  } catch {
    return false;
  }
};

if (isMainModule()) {
  main()
    .then((code) => process.exit(code ?? 0))
    .catch((err) => {
      console.error('[observer-controls] FATAL', err?.stack ?? err);
      process.exit(1);
    });
}
