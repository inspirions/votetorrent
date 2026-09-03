/**
 * packages/p2p-probe-host/drone.mjs — Phase 17 P2P-01 dial-proof host drone.
 *
 * Committed, repeatable dev tooling (Phase 22 reuse).  Ported from spike 009.
 *
 * A storage-profile CadreNode that listens on an ephemeral WebSocket address so
 * the Android emulator can dial it (emulator reaches the host at 10.0.2.2).
 * Boots, prints the control peerId + ws multiaddr, then stays alive.
 *
 * Prerequisites:
 *   This package is a normal yarn workspace — `yarn install` at the repo root installs its deps.
 *   The root `resolutions` pin uint8arrays only for ^5 ranges (Hermes/quereus compat), so
 *   @multiformats/multiaddr's ^6 requirement resolves to a real v6 and strict Node ESM works.
 *   The yarn-patched @serfab/cadre-core (connectionGater pass-through) is what resolves here.
 *
 * Usage:
 *   cd packages/p2p-probe-host
 *   nvm use 22
 *   node drone.mjs
 *
 *   Copy the printed ws multiaddr + peerId into CONTROL_ADDR in dial-probe.ts,
 *   then run ./scripts/run-dial-probe.sh.
 *
 * Exit: Ctrl-C (SIGINT) or `kill <pid>` (SIGTERM) — both gracefully stop the node.
 */
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { CadreNode } from '@serfab/cadre-core';
import { MemoryRawStorage } from '@optimystic/db-p2p';
import { webSockets } from '@libp2p/websockets';
import { generateKeyPair } from '@libp2p/crypto/keys';

const PARTY_ID = 'votetorrent'; // aligned with CadreNodeProvider.tsx line 55 (OQ1 conservative fix)
const L = (...a) => console.log('[drone]', ...a);

// P2P-06: the same votetorrent.qsql DDL the device peers apply via
// VOTETORRENT_SCHEMA_SQL (vote-engine re-export, generated from this file). The
// drone MUST host the identical schema so its strand is compatible with peers A/B.
const VOTETORRENT_QSQL_RAW = readFileSync(
  new URL('../vote-core/schema/votetorrent.qsql', import.meta.url),
  'utf8',
);

// cadre-core's StrandDatabase.executeSchema() wraps the sApp schema as
// `declare schema App { ${schema} } apply schema App;`. votetorrent.qsql is itself
// wrapped in `declare schema main { ... } apply schema main;`, so passing it verbatim
// nests invalidly and Quereus throws `got '}'`. Strip the outer wrapper so only the
// inner DDL is hosted — identical to the device peers' createStrandDbFactory, keeping
// the drone's strand schema-compatible. qsql has no `main.`-qualified refs (clean strip).
const VOTETORRENT_QSQL = VOTETORRENT_QSQL_RAW
  .replace(/^\s*declare\s+schema\s+\w+\s*\{/, '')
  .replace(/\}\s*apply\s+schema\s+\w+\s*;\s*$/, '')
  .trim();

// 38-05 (D-04 n=4 topology): cross-bootstrap parameterization so a SECOND drone
// process (drone-B) can bootstrap into drone-A's control network AND strand cohort,
// exactly as 38-02's two-drone-smoke.mjs proved (drone-B's controlNetwork.bootstrapNodes
// + network.strandBootstrapNodes pointed at drone-A's addrs). drone-A itself launches
// with these unset (empty defaults) — it remains the first bootstrap peer. Follows the
// existing `process.env.X ?? default` pattern used by STRAND_ID below.
const DRONE_BOOTSTRAP_CONTROL_ADDR = process.env.DRONE_BOOTSTRAP_CONTROL_ADDR ?? '';
const DRONE_BOOTSTRAP_STRAND_ADDR = process.env.DRONE_BOOTSTRAP_STRAND_ADDR ?? '';

const node = new CadreNode({
  // Supply the identity key explicitly instead of letting libp2p mint an ephemeral one:
  // `getIdentityOwnerKey()` — which owner genesis needs — THROWS on an ephemeral key
  // ("node identity not resolved"), because that key is internal to libp2p and never
  // exposed. Without this the drone cannot run genesis, cannot mint an invite, and every
  // joiner is refused as a non-member: the P2P-11 wall. Matches tools/multipeer-gate.
  //
  // Freshly generated per boot is correct here: the harness captures this drone's address
  // (which carries its peerId) from PROOF_WS_ADDR= on every run, so nothing pins it across
  // restarts. The DEVICE peerId must be stable (D-05); this host-side drone's need not be.
  privateKey: await generateKeyPair('Ed25519'),
  controlNetwork: {
    partyId: PARTY_ID,
    bootstrapNodes: DRONE_BOOTSTRAP_CONTROL_ADDR ? [DRONE_BOOTSTRAP_CONTROL_ADDR] : [],
  },
  profile: 'storage',
  // Published @serfab/cadre-core@0.8.1 enforces a fail-closed sApp-schema signature
  // policy (requireSignedSchemas defaults true): the unsigned org.votetorrent demo
  // schema this drone hosts is rejected at strand bring-up with
  // SchemaVerificationError('missing signature'). Relax the policy for this dev-harness
  // drone — the documented dev/test relaxation, at parity with the app's proof runners
  // (replication-proof-runner.ts / strand-persistence-proof-runner.ts).
  requireSignedSchemas: false,
  strandFilter: { mode: 'all' },
  network: {
    transports: [webSockets()],
    listenAddrs: ['/ip4/0.0.0.0/tcp/0/ws'], // ephemeral — avoids EADDRINUSE
    // The storage profile turns the circuit-relay-v2 relay server ON
    // (createControlNode/startStrand derive `relay: profile === 'storage'` in
    // the consumed vendored cadre-core, wiring circuitRelayServer() at
    // libp2p-node-base.js). The prior WR-19 note — that the options builder
    // forwarded only privateKey/transports/listenAddrs/connectionGater so an
    // `enableRelay` key was a silent no-op — is now stale: the builder forwards
    // `relayServerInit` too (T-38-12-01 transplant). Supply BOUNDED reservation
    // limits so the relay does not run on the unlimited @libp2p/circuit-relay-v2
    // defaults (dev-harness infra only, not shipped).
    relayServerInit: {
      reservations: {
        maxReservations: 32, // n=4 mesh + headroom (circuit-relay-v2 default is 15)
        defaultDurationLimit: 2 * 60 * 1000, // 2 min per reservation
        defaultDataLimit: BigInt(1 << 17), // 128 KiB per reservation
      },
      maxInboundHopStreams: 64,
      maxOutboundStopStreams: 64,
    },
    ...(DRONE_BOOTSTRAP_STRAND_ADDR && { strandBootstrapNodes: [DRONE_BOOTSTRAP_STRAND_ADDR] }),
  },
  // STRAND CLUSTER BREADTH (spike 062 re-run). cadre-core 0.10.0 exposes
  // `strandClusterSize`; it defaults to DEFAULT_STRAND_CLUSTER_SIZE = 4, described upstream
  // as "the smallest breadth whose 0.75 super-majority still commits with one holder
  // offline". That default is why the n=4 proof could form a cohort and still never
  // replicate: breadth 4 needs ceil(0.75 * 4) = 3 holders to commit, but each peer sees
  // `strandPeers=1` — a TWO-member cohort — so a commit can never reach quorum. Nothing
  // errors; the write just never becomes visible, which is exactly the observed signature
  // (clean logs, silent read-poll timeout).
  //
  // MIN_CLUSTER_SIZE is 2, and every node on one strand MUST agree on the value, so this is
  // set here AND in packages/p2p-probe-host/drone.mjs.
  //
  // Trade-off, stated upstream and accepted for a dev proof: at breadth 2 read repair cannot
  // converge, because a lone corroborator's stale answer is taken as the cluster's truth.
  // Commit correctness is unaffected — this is replication breadth, not safety.
  strandClusterSize: 2,
  hibernation: { enabled: false },
});

await node.start();
const addrs = node.getControlNode().getMultiaddrs().map(m => m.toString());
L('control peerId =', node.peerId?.toString());
L('control addrs  =', JSON.stringify(addrs));
// Machine-readable address line for the replication-proof harness (D-07 auto-injection).
// The human READY line below is a TEMPLATE with literal <PORT>/<PEER_ID> placeholders —
// scripts must parse THIS line, not that one. Prefer the loopback ws multiaddr; the harness
// rewrites 127.0.0.1 → 10.0.2.2 for the Android emulator host mapping.
const proofWsAddr = addrs.find(a => a.includes('/ip4/127.0.0.1/') && a.includes('/ws')) ?? addrs[0] ?? '';
L('PROOF_WS_ADDR=' + proofWsAddr);
L('READY — update CONTROL_ADDR in dial-probe.ts with the /ip4/10.0.2.2/tcp/<PORT>/ws/p2p/<PEER_ID> addr above, then run ./scripts/run-dial-probe.sh');

// ── CADRE MEMBERSHIP: owner genesis + the invite/accept ceremony ────────────────────────
//
// WHY THIS EXISTS (P2P-11 root cause, 2026-08-24, re-confirmed 2026-09-03). Every device
// n=4 run through 38-21/41-09 failed with the strand cohort never forming. The cause is not
// addressing, relays or db-p2p: the devices are simply NOT MEMBERS. drone-A refuses their
// strand-addr requests with
//     sereus:cadre:strand-addr Refusing strand-addr from non-member <device control peerId>
// because `isAuthorizedMember` needs a CadrePeer row carrying an anchored voucher, and this
// harness never ran a ceremony that creates one. Devices were addressable but unauthorized,
// so their strand nodes received no cohort addresses and replication could never start.
//
// cadre-core deliberately never runs owner genesis implicitly — the hosting app owns it — so
// a harness must do it explicitly or every owner-signed control write (createInvite included)
// fails. This mirrors tools/multipeer-gate, which is the green n=4 reference for this
// ceremony; keep the two in step.
//
// The ceremony is TWO-SIDED and there is no auto-accept hook in cadre-core 0.12.0: the joiner
// dials an invite, and the OWNER must then call `acceptPhone` with the joiner's peerId
// (`AddPhoneOptions.phonePeerId` is documented as "sent by phone when it connects" — the app
// layer is expected to carry it). Verified empirically against the gate: `dialInvite` alone
// never authorized a joiner in any observed run; `acceptPhone` fired every time. In-process
// that is a function call, but here the owner is this Node process and the joiners are RN
// apps on emulators, so the peerId has to cross a process boundary.
//
// It does NOT need a harness round-trip. Every joiner dials this drone's control node to
// bootstrap, so by the time it needs membership this node already HOLDS its peerId on an
// inbound connection — `getControlNode().getPeers()` is the channel. Routing peerIds back out
// through logcat and the host filesystem was the obvious design and the wrong one: the device
// emits `peerId=` and then issues its strand-addr request seconds later, so a
// grep-then-write round-trip races the very request it exists to authorize.
//
// So: while the enrollment window is open, accept every connected peer that is not yet a
// member. That is what an open enrollment window MEANS — the connection gater already admits
// these strangers for exactly this purpose — and it is bounded and dev-harness-only; this
// drone is throwaway proof infrastructure and is never shipped. DRONE_ENROL_DIR stays as an
// explicit out-of-band path (drop a file named for a peerId) for manual or scripted enrolment.
const IS_FOUNDER = !DRONE_BOOTSTRAP_CONTROL_ADDR;
const DRONE_ENROL_DIR = process.env.DRONE_ENROL_DIR ?? '';
// A joiner drone (drone-B) redeems the founder's invite; the harness passes it through from
// the founder's PROOF_INVITE= line. Unset on the founder, which mints its own.
const DRONE_INVITE = process.env.DRONE_INVITE ?? '';
// The invite is a bearer credential with no consumed-flag, so ONE invite serves every joiner.
// What actually expires is the inbound enrollment window `createInvite` opens
// (DEFAULT_ENROLLMENT_WINDOW_MS = 30 min upstream). Device n=4 runs have been observed at
// ~39 minutes, so the window must be REFRESHED for the life of the run or late joiners are
// gated out — `openEnrollmentWindow` exists for exactly that.
const ENROL_WINDOW_MS = Number(process.env.DRONE_ENROL_WINDOW_MS ?? 60 * 60 * 1000);
// Poll interval, overridable so a test can drive ticks FASTER than acceptPhone returns —
// which is the only way to reproduce the re-entrancy race on fast loopback, where the accept
// completes well inside the default interval. On-device, control-DB contention makes the
// accept slow enough that the default interval already overlaps.
const ENROL_POLL_MS = Number(process.env.DRONE_ENROL_POLL_MS ?? 2000);
// Grace before a newly-seen peer is treated as a phone, so a strand node's delegate grant
// can land first. Settle time after a successful accept, so the next accept in the same tick
// does not read through that write's convergence window. Bound on transient accept retries.
const DELEGATE_GRACE_MS = Number(process.env.DRONE_DELEGATE_GRACE_MS ?? 15000);
const ENROL_SETTLE_MS = Number(process.env.DRONE_ENROL_SETTLE_MS ?? 4000);
const ENROL_TRANSIENT_MAX_ATTEMPTS = Number(process.env.DRONE_ENROL_MAX_ATTEMPTS ?? 12);

let issuedInvite = null;

if (IS_FOUNDER) {
  // Owner genesis MUST run while this node is still SOLO. It writes owner-signed control
  // state; once the control DB is spread across a cohort, that write needs a quorum the
  // joiners cannot yet serve and it fails with
  //   Block default/Revocation is unavailable (peers-unreachable)
  // drone-A boots with empty bootstrapNodes, so "solo" holds here by construction — but this
  // block must stay ABOVE addStrand and above anything that admits a peer.
  const owner = node.getIdentityOwnerKey();
  await node.trustOwnerKeys([owner.publicKeyB64], 'operator');
  const controlDb = node.getControlDatabase();
  if (!controlDb) throw new Error('founder has no control database after start()');
  await controlDb.ensureOwnerKey(owner.publicKeyB64);
  node.initializeSeedBootstrap(owner.privateKeyB64);
  L(`owner genesis done (ownerKey=${owner.publicKeyB64.slice(0, 12)}…)`);

  const { invite } = await node.createInvite(undefined, ENROL_WINDOW_MS);
  issuedInvite = invite;
  // Machine-readable, like PROOF_WS_ADDR= above: the harness greps this line and injects the
  // encoded invite into the runner's PROOF_INVITE constant (D-07 injection pattern).
  L('PROOF_INVITE=' + node.encodeInvite(invite));

  // Keep the window open for the whole run, not just the first 30 minutes.
  setInterval(() => {
    try {
      node.openEnrollmentWindow(Date.now() + ENROL_WINDOW_MS);
    } catch (e) {
      L('WARN openEnrollmentWindow failed:', e?.message ?? e);
    }
  }, Math.max(60_000, Math.floor(ENROL_WINDOW_MS / 4))).unref?.();

  if (DRONE_ENROL_DIR) {
    mkdirSync(DRONE_ENROL_DIR, { recursive: true });
    L('ENROL_WATCH=' + DRONE_ENROL_DIR);
  }
  watchForJoiners();
  L('ENROL_ARMED — accepting connected non-members for the life of this run');
} else if (DRONE_INVITE) {
  // A NON-founder drone (drone-B) is a joiner like any device: the founder will accept it
  // once it connects, but acceptance is only the owner's half. Redeeming the invite is the
  // joiner's half — it anchors the founder's owner keys in this node's node-local trusted
  // set (`trustOwnerKeys` with source 'invite'), which is what lets this node VERIFY
  // owner-signed control state rather than merely being admitted. tools/multipeer-gate runs
  // both halves for its drone-B; do the same here so the two stay comparable.
  try {
    await node.dialInvite(node.decodeInvite(DRONE_INVITE));
    L('ENROL_DIALED — redeemed the founder invite');
  } catch (e) {
    // Not fatal: the founder's acceptPhone can still confer membership. Loud, then continue.
    L('WARN ENROL_DIAL_FAILED:', e?.message ?? e);
  }
}

/**
 * Accept joiners: every peer connected to the control node that is not yet a member, plus any
 * peerId dropped into DRONE_ENROL_DIR out-of-band.
 *
 * Polling rather than an event subscription: this runs for the whole ~40-minute proof, a
 * missed `peer:connect` would silently cost the run, and a re-read costs nothing.
 */
function watchForJoiners() {
  // Peers whose ceremony reached a DEFINITE outcome (accepted, or refused on the merits).
  const settled = new Set();
  // peerId -> epoch ms first observed, so a delegate grant has a tick to land before we
  // mistake a strand transport for a phone (see the delegate guard below).
  const firstSeenAt = new Map();
  // peerId -> count of transient (infrastructure) accept failures, to bound the retries.
  const transientFailures = new Map();
  // The tick body awaits (acceptPhone, the settle delay), so it outlives the ENROL_POLL_MS
  // interval and overlapping invocations would otherwise interleave. `settled` is only
  // written AFTER the awaited accept — so without these two guards, concurrent ticks all pass
  // the `settled.has` check before any of them records the outcome, and the same peer is
  // accepted many times over (observed: 12 accepts of one peerId). That is precisely the
  // concurrent-CadrePeer-write contention that tore a multi-tree commit. `tickRunning`
  // serialises the ticks; `inFlight` is the belt-and-braces per-peer claim.
  let tickRunning = false;
  const inFlight = new Set();
  const selfId = node.peerId?.toString();

  // A control-DB read/write that could not be SERVED is not a membership verdict — the same
  // distinction the multipeer gate's L3 draws. `acceptPhone` reads `Revocation`/`CadrePeer`
  // to evaluate the joiner, so it surfaces cluster unavailability as a throw that looks
  // exactly like a refusal. Retrying these is the whole point; retrying a real refusal spins.
  const isTransientControlFailure = (msg) =>
    /unavailable \((?:peers|cohort)-unreachable\)|could not determine whether it exists|exhausted \d+ retries|unresolved rival action|was not atomic/i.test(msg);

  setInterval(async () => {
    if (tickRunning) return; // a previous tick is still awaiting an accept/settle
    tickRunning = true;
    try {
    const candidates = new Set();

    // Primary: peers already connected to this control node.
    try {
      for (const p of node.getControlNode()?.getPeers?.() ?? []) candidates.add(p.toString());
    } catch (e) {
      L('WARN could not enumerate control peers:', e?.message ?? e);
    }

    // Secondary: explicit out-of-band drops.
    if (DRONE_ENROL_DIR) {
      try {
        for (const f of readdirSync(DRONE_ENROL_DIR)) {
          if (!f.startsWith('.')) candidates.add(f);
        }
      } catch {
        // dir not there yet, or transiently unreadable — next tick retries
      }
    }

    for (const peerId of candidates) {
      if (peerId === selfId || settled.has(peerId)) continue;

      const now = Date.now();
      if (!firstSeenAt.has(peerId)) {
        firstSeenAt.set(peerId, now);
        // Deliberately fall through to the delegate guard rather than accepting on sight.
      }

      // A member's strand node reserves a circuit here under its OWN derived transport
      // peerId (cadre-core 0.12.0 strand-transport-key). It is admitted natively by
      // delegate-admission.js via /sereus/strand-addr/1.0.0 — it is NOT a phone, and
      // running acceptPhone against it writes a spurious CadrePeer row. In the first n=4
      // device run that spurious write tore a multi-tree commit: `default/CadrePeer`
      // persisted while its `_uniq_7.stampid` index did not, unrollbackable.
      if (node.hasDelegateAdmission?.(peerId)) {
        settled.add(peerId);
        L('ENROL_SKIPPED_DELEGATE=' + peerId);
        continue;
      }
      // The grant lands a beat after the strand node first connects — measured at 11s in the
      // first n=4 device run (connection 09:59:02.392, grant 09:59:13.162) — so a peer seen
      // only moments ago may be a delegate whose grant has not arrived yet. The grace period
      // is set ABOVE that measured latency; a phone waiting an extra few seconds costs
      // nothing across a ~40-minute proof, whereas accepting early corrupts the control DB.
      if (now - firstSeenAt.get(peerId) < DELEGATE_GRACE_MS) continue;

      if (inFlight.has(peerId)) continue;
      inFlight.add(peerId); // claimed BEFORE the await — never check-then-act across it
      try {
        await node.acceptPhone({ phonePeerId: peerId }, issuedInvite ?? undefined);
        settled.add(peerId);
        inFlight.delete(peerId);
        L('ENROL_ACCEPTED=' + peerId);
      } catch (e) {
        const msg = e?.message ?? String(e);
        // A control write leaves the DB briefly unreadable until replication reaches a second
        // holder. Accepts run back-to-back in one tick, so joiner N+1's read lands inside the
        // window joiner N's write just opened — in the first n=4 device run Peer B failed 33ms
        // after Peer A was accepted, and never retried, which stranded it as a non-member and
        // failed the whole proof. Retry the outage; never retry a refusal on the merits.
        const attempts = (transientFailures.get(peerId) ?? 0) + 1;
        inFlight.delete(peerId); // released so a later tick may retry it
        if (isTransientControlFailure(msg) && attempts <= ENROL_TRANSIENT_MAX_ATTEMPTS) {
          transientFailures.set(peerId, attempts);
          L(`ENROL_RETRY=${peerId} attempt=${attempts}/${ENROL_TRANSIENT_MAX_ATTEMPTS} (control-DB unavailable, not a refusal) ${msg}`);
          continue;
        }
        settled.add(peerId);
        L('ENROL_FAILED=' + peerId + ' ' + msg);
        continue;
      }
      // Let this write converge before accepting the next candidate in THIS tick, so we stop
      // manufacturing the very read outage the retry above now has to absorb.
      await new Promise(r => setTimeout(r, ENROL_SETTLE_MS));
      // Verify separately, and never let a failed READ read as a failed ceremony. The
      // read-back races the control write: in gate runs `isAuthorizedMember` threw
      // `Block default/Revocation is unavailable (peers-unreachable)` on every attempt for a
      // joiner that was in fact enrolled, which is what made the gate's own enrolment step
      // look like it "did not settle" when it had. Confirmation is best-effort; ENROL_ACCEPTED
      // above is the ceremony's real outcome.
      void confirmMember(peerId);
    }
    } finally {
      tickRunning = false;
    }
  }, ENROL_POLL_MS).unref?.();
}

async function confirmMember(peerId) {
  for (let attempt = 1; attempt <= 10; attempt++) {
    try {
      if (await node.isAuthorizedMember(peerId)) {
        L('ENROLLED=' + peerId);
        return;
      }
    } catch (e) {
      L(`  · membership read for ${peerId} not yet serviceable (attempt ${attempt}): ${e?.message ?? e}`);
    }
    await new Promise(r => setTimeout(r, 2000 * attempt));
  }
  L('WARN ENROL_UNCONFIRMED=' + peerId + ' — acceptPhone succeeded but membership could not ' +
    'be read back; treat strandPeers as the authoritative signal');
}

// P2P-06 replication proof: host the VoteTorrent strand so transaction-profile
// peers A and B can replicate through this always-on storage cadre (D-01/D-02
// Option-B topology). strandId is the KNOWN test-network hash (== networkHash,
// D-05) exported by Peer A's created network and passed in via STRAND_ID.
// mode:'bootstrap' — the drone starts solo and transitions naturally as peers
// connect (T-22-14: 'networked' solo would hang). The storage profile +
// MemoryRawStorage are kept (dev/test tooling, D-02 — ephemeral store is fine).
const STRAND_ID = process.env.STRAND_ID ?? 'UPDATE_WITH_TEST_NETWORK_HASH';
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
L(`[replication-proof] strand started, strandId=${STRAND_ID}`);
// Advertise the drone's strand-node listen multiaddr so the harness can inject it
// into the runner's STRAND_BOOTSTRAP_ADDR and peers can dial the strand cohort.
// Mirrors the PROOF_WS_ADDR= control-node advertisement above (D-07 pattern, REPL-01).
const strand = node.getStrand(STRAND_ID);
const strandAddrs = strand?.libp2pNode?.getMultiaddrs?.().map(m => m.toString()) ?? [];
const strandWs = strandAddrs.find(a => a.includes('/ip4/127.0.0.1/') && a.includes('/ws')) ?? strandAddrs[0] ?? '';
if (!strandWs) {
  L('PROOF_STRAND_ADDR_MISSING — strand node has no listen multiaddr');
} else {
  L('PROOF_STRAND_ADDR=' + strandWs);
}

// IN-15 (17-REVIEW): handle SIGTERM (plain `kill <pid>`) as well as SIGINT
// (Ctrl-C) so both stop paths shut the node down gracefully.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    L(`${sig} — stopping...`);
    await node.stop();
    process.exit(0);
  });
}
setInterval(() => {}, 1 << 30); // stay alive
