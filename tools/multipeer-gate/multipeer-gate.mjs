/**
 * multipeer-gate.mjs — a standalone Node gate for the n=4 Sereus/Optimystic
 * multi-peer topology.
 *
 * WHY THIS EXISTS
 * ---------------
 * The n=4 topology (two always-on relay/storage nodes plus two relay-only peers that
 * cannot be dialled directly) has repeatedly failed for reasons that are invisible in
 * an end-to-end pass/fail: a healthy control network sitting on top of a strand overlay
 * that never seeded, a clean dial surface that was clean only because nothing was ever
 * handed a peer to dial, and diagnostics living in a debug namespace nobody had armed.
 *
 * This gate replaces "it still fails" with "leg N fails, here is the number". It runs
 * five ORDERED legs and stops at the first failure, so the output names the earliest
 * broken link rather than its downstream symptoms.
 *
 * It depends only on PUBLISHED packages — no VoteTorrent code, no app, no Android, no
 * emulator. Upstream maintainers can run it against a candidate build to check whether a
 * multi-peer fix actually unblocks the topology, and it doubles as a regression test.
 *
 * TOPOLOGY
 * --------
 *     drone-A   profile 'storage'      relay server ON, direct ws listen. Founder.
 *     drone-B   profile 'storage'      relay server ON, direct ws listen. Joins A.
 *     peer-A    profile 'transaction'  RELAY-ONLY: listens on <relay>/p2p-circuit only.
 *     peer-B    profile 'transaction'  RELAY-ONLY: listens on <relay>/p2p-circuit only.
 *
 * The peers get NO direct listen address. That is the whole point: a sibling cannot
 * reach them except through a relay, which is the constraint every multi-peer bug in
 * this topology has turned on.
 *
 * THE LEGS
 * --------
 *   L1  control-reachability  every node holds >= 1 control connection; founder sees all
 *   L2  relay-reservation each relay-only peer holds a reservation (counted by distinct relay
 *                        IDENTITY, not address), and every cohort member can dial it
 *   L3  cadre-authorization  the relay-only peers are AUTHORIZED members of the cadre
 *   L4  strand-cohort     each strand node assembles a cohort larger than itself
 *   L5  replication       peer-A writes a row; peer-B reads it back
 *
 * L3 is the one people skip. Control-network membership is the v1 authorization for the
 * strand-address RPC (`strand-addr-protocol.js`: "only this party's cadre peers may ask
 * us for a strand address"). A peer that is merely CONNECTED is addressable but not
 * authorized: its strand-addr request is refused as `non-member`, it receives no cohort
 * addresses, and its strand node then sits at a cohort of one with zero dial attempts.
 * Every layer below looks healthy while replication silently never happens. L3 makes
 * that gate explicit instead of letting it masquerade as an L4 or L5 failure.
 *
 * WHAT THIS DOES AND DOES NOT PROVE
 * ---------------------------------
 * DOES: that the topology's addressing, authorization, cohort-assembly and replication
 * path work when the peers are reachable ONLY through a relay. That is a real constraint
 * and it is where these bugs live.
 *
 * DOES NOT: prove device behaviour. Everything here is one process on loopback. A real
 * NAT adds address translation, mobile schedulers add main-thread starvation, and both
 * have produced device-only failures that a loopback gate passed straight through. A
 * PASS here is a necessary condition for the device proof, never a substitute for it.
 * Treat a PASS as "the blocker is not in this layer", not as "the topology works".
 *
 * USAGE
 * -----
 *   cd tools/multipeer-gate
 *   npm install
 *   node multipeer-gate.mjs
 *
 * Requires Node >= 22 (Promise.withResolvers, used by the dependency graph).
 *
 * Exit 0 when every leg passes; exit 1 on the first failure, naming the leg.
 *
 * ENV KNOBS (all optional)
 *   DRONES=N          how many always-on storage nodes (default 2 — the topology under
 *                     test). ONLY storage-profile nodes serve blocks (`enableRingZulu` and
 *                     `storageRing` are gated on `profile === 'storage'`), so this is the
 *                     discriminator for a control-DB block read that fails with
 *                     `peers-unreachable`: if DRONES=3 passes a leg that DRONES=2 fails,
 *                     the cause is block-cluster breadth, not relay-only reachability.
 *   RELAYS=1|2        how many relays each peer reserves on (default 1). 2 exercises the
 *                     multi-relay posture, which has regressed before — see README.
 *   CLUSTER_SIZE=N    strandClusterSize, must be identical on every node (default 2).
 *   ENROLL=1|0        run the invite/enrolment ceremony before L3 (default 1). Set 0 to
 *                     observe the un-enrolled failure mode deliberately.
 *   TIMEOUT_SCALE=N   multiply every timeout by N on a slow machine (default 1).
 *   VERBOSE=1         print per-poll progress.
 *
 * To see the underlying diagnostics, arm BOTH namespace roots — the optimystic ones
 * alone have zero coverage of strand seeding, which is what made this class of bug so
 * hard to localize:
 *
 *   DEBUG='optimystic:db-p2p:*,db-p2p:*,sereus:*' node multipeer-gate.mjs
 */
import { CadreNode } from '@serfab/cadre-core';
import { MemoryRawStorage } from '@optimystic/db-p2p';
import { webSockets } from '@libp2p/websockets';
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2';
import { generateKeyPair } from '@libp2p/crypto/keys';

// ── configuration ────────────────────────────────────────────────────────────────────
const PARTY_ID = 'multipeer-gate';
const STRAND_ID = 'multipeer-gate-strand';
const SAPP_ID = 'org.sereus.multipeer-gate';

const DRONES = Number(process.env.DRONES ?? 2);
const RELAYS = Number(process.env.RELAYS ?? 1);
const CLUSTER_SIZE = Number(process.env.CLUSTER_SIZE ?? 2);
const ENROLL = (process.env.ENROLL ?? '1') !== '0';
const SCALE = Number(process.env.TIMEOUT_SCALE ?? 1);
const VERBOSE = process.env.VERBOSE === '1';

const T = (ms) => Math.round(ms * SCALE);
const START_TIMEOUT_MS = T(45_000);
const ADD_STRAND_TIMEOUT_MS = T(60_000);
const MESH_TIMEOUT_MS = T(30_000);
const RESERVATION_TIMEOUT_MS = T(20_000);
const ENROLL_TIMEOUT_MS = T(30_000);
// L3's own window, deliberately NOT shared with ENROLL_TIMEOUT_MS (the ceremony's per-dial
// timeout). They are different waits: one bounds a single dial, the other bounds how long the
// control database may take to become READABLE after the enrolment write.
//
// 120s, not 30s. Measured 2026-09-03 at RELAYS=2: at 30s the gate failed 2 of 5 runs, always at
// L3, always `Block default/Revocation is unavailable (peers-unreachable)` — a read that cannot
// be served, not a membership verdict. A 4x window passed 4 of 4. The enrolment write leaves the
// control DB briefly unreadable while replication spreads the new revision to a second holder,
// and that convergence sometimes takes over 30 seconds on loopback.
//
// This is a longer WAIT, not a retry that hides a failure: a peer that never becomes a member
// still fails L3, and `ENROLL=0` still fails it immediately. Overridable so the two waits can be
// varied independently when diagnosing.
const AUTH_TIMEOUT_MS = T(Number(process.env.AUTH_TIMEOUT_MS ?? 120_000));
const COHORT_TIMEOUT_MS = T(30_000);
const REPLICATION_TIMEOUT_MS = T(60_000);
const POLL_MS = T(500);
const ENROLL_ATTEMPTS = Number(process.env.ENROLL_ATTEMPTS ?? 5);
const ENROLL_RETRY_MS = T(2_000);
// 0.12.0 reserves relays AFTER control bring-up, so the enrolment preconditions land late.
const SETTLE_TIMEOUT_MS = T(60_000);
const SETTLE_GRACE_MS = T(3_000);

// A single-table schema. StrandDatabase.executeSchema() supplies the
// `declare schema App { ... } apply schema App;` wrapper itself, so this is raw DDL.
const SCHEMA = `
create table GateRow (
  Id text primary key,
  Value text
);
`;

// ── output ───────────────────────────────────────────────────────────────────────────
const L = (...a) => console.log('[multipeer-gate]', ...a);
const V = (...a) => { if (VERBOSE) console.log('[multipeer-gate]  ·', ...a); };

const nodes = [];          // { name, node } in shutdown order (reverse of creation)
const results = [];        // { id, title, status, detail }

function record(id, title, status, detail) {
  results.push({ id, title, status, detail });
  const badge = status === 'PASS' ? 'PASS' : status === 'SKIP' ? 'SKIP' : 'FAIL';
  L(`${badge}  ${id}  ${title}${detail ? ` — ${detail}` : ''}`);
}

// ── helpers ──────────────────────────────────────────────────────────────────────────
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Poll `probe` until it returns a truthy value or the deadline passes. */
async function poll(probe, ms, label) {
  const deadline = Date.now() + ms;
  let last;
  for (;;) {
    last = await probe();
    if (last) return last;
    if (Date.now() >= deadline) return null;
    V(`${label}: not yet (${Math.round((deadline - Date.now()) / 1000)}s left)`);
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

function loopbackWs(addrs) {
  return addrs.find((a) => a.includes('/ip4/127.0.0.1/') && a.includes('/ws')) ?? addrs[0] ?? '';
}

function controlAddrs(node) {
  return node.getControlNode().getMultiaddrs().map((m) => m.toString());
}

/**
 * Shared CadreNode options. Every node on one strand MUST agree on strandClusterSize.
 *
 * `privateKey` is supplied explicitly rather than letting libp2p mint an ephemeral one:
 * `getIdentityOwnerKey()` — which owner genesis needs — throws on an ephemeral key,
 * because that key is internal to libp2p and never exposed.
 */
function baseConfig(bootstrapNodes, privateKey) {
  return {
    privateKey,
    controlNetwork: { partyId: PARTY_ID, bootstrapNodes },
    // The gate hosts an unsigned demo schema, so relax the fail-closed signature policy
    // exactly as the reference drone harness does. Not a production posture.
    requireSignedSchemas: false,
    strandFilter: { mode: 'all' },
    storage: { provider: () => new MemoryRawStorage() },
    strandClusterSize: CLUSTER_SIZE,
    hibernation: { enabled: false },
  };
}

async function startDrone(name, bootstrapNodes) {
  const node = new CadreNode({
    ...baseConfig(bootstrapNodes, await generateKeyPair('Ed25519')),
    profile: 'storage', // turns the circuit-relay-v2 relay server ON
    network: {
      transports: [webSockets()],
      listenAddrs: ['/ip4/0.0.0.0/tcp/0/ws'], // ephemeral — avoids EADDRINUSE
      relayServerInit: {
        reservations: {
          maxReservations: 32,             // n=4 plus headroom (library default is 15)
          defaultDurationLimit: 10 * 60 * 1000,
          defaultDataLimit: BigInt(1 << 20),
        },
        maxInboundHopStreams: 64,
        maxOutboundStopStreams: 64,
      },
    },
  });
  await withTimeout(node.start(), START_TIMEOUT_MS, `${name} start`);
  nodes.unshift({ name, node });
  L(`${name} up   peerId=${node.peerId?.toString()}`);
  return node;
}

/**
 * A relay-only peer: NO direct listen address, only relays. This is what makes the peer
 * undialable except through a relay — the constraint the whole gate exists to exercise.
 *
 * cadre-core 0.12.0 moved this from `network.listenAddrs` to `network.relayAddrs` and now
 * REJECTS the old shape on a control node: a `<relay>/p2p-circuit` listen entry makes
 * libp2p dial the relay from inside `libp2p.start()`, during the bring-up quiet period
 * that denies exactly that dial. `relayAddrs` takes the 'search' route instead (one bare
 * `/p2p-circuit` listener) and drives the reservation explicitly AFTER the control
 * database is up. `listenAddrs` is deliberately left unset so the peer keeps no direct
 * listener — naming a relay alone does not add one back.
 */
async function startRelayOnlyPeer(name, relayAddrs, bootstrapNodes) {
  const node = new CadreNode({
    ...baseConfig(bootstrapNodes, await generateKeyPair('Ed25519')),
    profile: 'transaction',
    network: {
      transports: [
        webSockets(),
        // Required for a `/p2p-circuit` LISTEN address to be honoured at all — without
        // it libp2p rejects the address with UnsupportedListenAddressError and the peer
        // never starts.
        //
        // reservationConcurrency defaults to 1, which serialises and then DROPS the
        // surplus. Kept sized to the relay count: L2 asserts a reservation per relay.
        circuitRelayTransport({ reservationConcurrency: Math.max(1, relayAddrs.length) }),
      ],
      relayAddrs,
    },
  });
  await withTimeout(node.start(), START_TIMEOUT_MS, `${name} start`);
  nodes.unshift({ name, node });
  L(`${name} up   peerId=${node.peerId?.toString()} (relay-only, ${relayAddrs.length} relay(s))`);
  return node;
}

async function addStrand(node, name, mode) {
  await withTimeout(
    node.addStrand({
      strandRow: { Id: STRAND_ID, MemberPrivateKey: null, Type: 'o' },
      sAppConfig: { id: SAPP_ID, version: '1.0.0', schema: SCHEMA, latencyHint: 'interactive' },
      mode,
    }),
    ADD_STRAND_TIMEOUT_MS,
    `${name} addStrand`,
  );
  V(`${name} strand up`);
}

/** The Quereus handle for a node's strand, or null if the strand is not active. */
function strandDb(node) {
  return node.getStrand(STRAND_ID)?.database?.getDatabase() ?? null;
}

/** Cohort size this node's strand assembles for `key`, via the same path the coordinator uses. */
async function cohortSize(node, key) {
  const strandNode = node.getStrand(STRAND_ID)?.libp2pNode;
  if (!strandNode) return { count: 0, ids: [] };
  const peers = await strandNode.keyNetwork.findCluster(new TextEncoder().encode(key));
  const ids = Object.keys(peers ?? {});
  return { count: ids.length, ids };
}

// ── the legs ─────────────────────────────────────────────────────────────────────────

/**
 * L1 — control-plane reachability.
 *
 * Deliberately NOT a full-mesh assertion. On bring-up the control network is a star:
 * every joiner dials the founder, and the mesh only widens once `reconcileControlCohort`
 * runs — which is itself gated on the membership L3 tests. Asserting a full mesh here
 * would fail for a reason that belongs to L3 and would mislabel the blocker.
 *
 * What must hold: every node has at least one control connection, and the founder can
 * see all of them. A relay-only peer that cannot reach the founder fails right here.
 */
async function legControlMesh(founder, all) {
  const wantFounder = all.length - 1;
  const got = await poll(async () => {
    const counts = all.map(({ name, node }) => ({
      name,
      n: node.getControlNode().getConnections().length,
    }));
    V(`control ${counts.map((c) => `${c.name}=${c.n}`).join(' ')}`);
    const founderCount = founder.getControlNode().getConnections().length;
    return counts.every((c) => c.n >= 1) && founderCount >= wantFounder ? counts : null;
  }, MESH_TIMEOUT_MS, 'control reachability');

  if (!got) {
    const counts = all.map(({ name, node }) => `${name}=${node.getControlNode().getConnections().length}`);
    record('L1', 'control-reachability', 'FAIL',
      `expected every node >= 1 control connection and the founder >= ${wantFounder}, ` +
      `got ${counts.join(' ')}`);
    return false;
  }
  record('L1', 'control-reachability', 'PASS',
    `${got.map((c) => `${c.name}=${c.n}`).join(' ')} (founder >= ${wantFounder}, each >= 1)`);
  return true;
}

/**
 * The distinct RELAY IDENTITIES a peer holds circuit addresses through.
 *
 * Identity, never address count. One relay listening on several interfaces yields several
 * `/p2p-circuit` addresses, so counting addresses reads one relay as breadth.
 */
function relayIdsOf(node) {
  const circuits = controlAddrs(node).filter((a) => a.includes('/p2p-circuit'));
  return {
    circuits,
    ids: new Set(circuits.map((c) => c.split('/p2p-circuit')[0].split('/p2p/').pop())),
  };
}

/**
 * L2 — every relay-only peer is REACHABLE BY EVERY COHORT MEMBER.
 *
 * Two distinct things, and the leg used to check neither properly.
 *
 * 1. A reservation exists. This asserted `circuits.length >= RELAYS`, which counts
 *    ADDRESSES: drone-A listens on two interfaces, so at RELAYS=2 its two `/p2p-circuit`
 *    addresses satisfied the count on their own and the leg passed reporting `2 addr/1
 *    relay` — printing the shortfall inside its own PASS line. Identities are counted now.
 *
 *    But the bar is ONE, not RELAYS — on THIS version. cadre-core 0.12.0's
 *    `driveRelayReservation` dials every configured relay and asks *the first one that answers*
 *    for a slot, returning as soon as a single `/p2p-circuit` address appears
 *    (`requestReservation` returns on first success). Verified against the installed dist.
 *
 *    This is a CHANGE, not a constant: on 0.11.0 relays were named by a `<relay>/p2p-circuit`
 *    `listenAddrs` entry (libp2p's 'configured' route, which reserves with EACH named relay),
 *    and this gate's README records `peer-A=4 addr/2 relay` from that era. 0.12.0's 'search'
 *    route yields `2 addr/1 relay` for the same config. So `RELAYS` is how many relays are
 *    OFFERED, and demanding one reservation per relay would fail a healthy 0.12.0 stack. If a
 *    later version restores per-relay reservations, raise this bar with it.
 *
 * 2. Every other cohort member can actually dial the peer. THIS is wall #8 (38-21: drone-B
 *    raised `NoValidAddressesError` against Peer A 1312x while drone-A raised none, because
 *    the peer's reservation had landed with drone-A alone). Given (1), a single reservation
 *    is expected and fine — but only if the non-reserving drones learn a circuit address for
 *    the peer and can route through the relay that holds it. A reservation count can never
 *    show that; the other members' peer stores can. Unchecked, a device run fails here and
 *    reads as an addressing or consensus fault.
 */
async function legRelayReservation(peers, drones) {
  const got = await poll(async () => {
    const seen = peers.map(({ name, node }) => ({ name, ...relayIdsOf(node) }));
    V(`reservations ${seen.map((s) => `${s.name}=${s.circuits.length}addr/${s.ids.size}relay`).join(' ')}`);
    return seen.every((s) => s.ids.size >= 1) ? seen : null;
  }, RESERVATION_TIMEOUT_MS, 'relay reservation');

  if (!got) {
    const seen = peers.map(({ name, node }) => {
      const { circuits, ids } = relayIdsOf(node);
      return `${name}=${circuits.length} addr/${ids.size} relay`;
    });
    record('L2', 'relay-reservation', 'FAIL',
      `every relay-only peer needs at least one circuit reservation, got ${seen.join(' ')}. ` +
      'Distinct relay IDENTITIES are counted, not addresses — several addresses of ONE relay ' +
      'are not breadth.');
    return false;
  }

  // Phase 2 — the reachability half.
  const reachable = await poll(async () => {
    const missing = [];
    for (const d of drones) {
      for (const p of peers) {
        if (!(await holdsCircuitAddrFor(d.node, p.node))) missing.push(`${d.name}->${p.name}`);
      }
    }
    V(`reachability missing=${missing.length ? missing.join(',') : 'none'}`);
    return missing.length === 0 ? true : null;
  }, RESERVATION_TIMEOUT_MS, 'cohort reachability');

  if (!reachable) {
    const missing = [];
    for (const d of drones) {
      for (const p of peers) {
        if (!(await holdsCircuitAddrFor(d.node, p.node))) missing.push(`${d.name}->${p.name}`);
      }
    }
    record('L2', 'relay-reservation', 'FAIL',
      `reservations landed, but these cohort members hold NO circuit address for a relay-only ` +
      `peer: ${missing.join(' ')}. Such a member cannot dial that peer at all, so its consensus ` +
      'votes are silently undeliverable — the 38-21 wall, which a reservation count cannot see.');
    return false;
  }

  record('L2', 'relay-reservation', 'PASS',
    `${got.map((s) => `${s.name}=${s.circuits.length} addr/${s.ids.size} relay`).join(' ')} ` +
    `· all ${drones.length} cohort member(s) hold a circuit path to each peer`);
  return true;
}

/**
 * Does `from` hold at least one `/p2p-circuit` address for `target` — i.e. can it dial it?
 *
 * The peer store is the same source `connect()` consults, so this asks the question the
 * dial layer will ask. A peer absent from the store simply has no addresses: not an error.
 */
async function holdsCircuitAddrFor(from, target) {
  const targetId = target.peerId;
  if (!targetId) return false;
  // A relay reaching itself is trivially fine and not what this leg is about.
  if (from.peerId?.toString() === targetId.toString()) return true;
  try {
    const peer = await from.getControlNode()?.peerStore?.get(targetId);
    return (peer?.addresses ?? []).some((a) => a.multiaddr?.toString().includes('/p2p-circuit'));
  } catch {
    return false; // not in the store yet
  }
}

/**
 * L3 — the relay-only peers are AUTHORIZED cadre members.
 *
 * `isAuthorizedMember` is the exact predicate the strand-address responder consults, so
 * this asserts the real gate rather than a proxy for it. Authorization needs a CadrePeer
 * row carrying an anchored voucher; merely being connected is not enough.
 */
async function legCadreAuthorization(owner, peers) {
  // The probe itself can THROW rather than answer — `isAuthorizedMember` reads the
  // control DB, and if that read cannot be served the query raises instead of returning
  // false. That is a distinct, and more interesting, failure than "not a member", so
  // capture it rather than letting it abort the run.
  let probeError = null;
  const check = async () => {
    try {
      const out = [];
      for (const { name, node } of peers) {
        out.push({ name, ok: await owner.isAuthorizedMember(node.peerId.toString()) });
      }
      probeError = null;
      V(`authorization ${out.map((o) => `${o.name}=${o.ok}`).join(' ')}`);
      return out.every((o) => o.ok) ? out : null;
    } catch (e) {
      probeError = e;
      V(`authorization probe threw: ${e?.message ?? e}`);
      return null;
    }
  };

  // With ENROLL=0 no ceremony ran, so membership can never BECOME true — waiting the full
  // convergence window would only make the documented negative control four times slower.
  const window = ENROLL ? AUTH_TIMEOUT_MS : Math.min(AUTH_TIMEOUT_MS, T(15_000));
  const got = await poll(check, window, 'cadre authorization');
  if (got) {
    record('L3', 'cadre-authorization', 'PASS', `${got.map((o) => o.name).join(', ')} authorized`);
    return true;
  }

  if (probeError) {
    record('L3', 'cadre-authorization', 'FAIL',
      `the membership probe could not be answered: ${probeError?.message ?? probeError}. ` +
      'This is NOT "peer is not a member" — the control-database read itself failed, so ' +
      'the cadre cannot evaluate its own membership. Suspect control-DB cluster health ' +
      '(a `peers-unreachable` block read usually means the cluster cannot serve a quorum).');
    return false;
  }

  const finalState = [];
  for (const { name, node } of peers) {
    const ok = await owner.isAuthorizedMember(node.peerId.toString()).catch((e) => `error(${e?.message ?? e})`);
    finalState.push(`${name}=${ok}`);
  }
  const members = await owner.listAuthorizedMembers().catch(() => []);
  record('L3', 'cadre-authorization', 'FAIL',
    `${finalState.join(' ')}; owner lists ${members.length} authorized member(s). ` +
    (ENROLL
      ? 'The enrolment ceremony ran but did not produce authorized membership.'
      : 'ENROLL=0 — no ceremony was attempted.') +
    ' Un-authorized peers are refused the strand-address RPC as `non-member`, so their ' +
    'strand nodes never receive cohort addresses and L4/L5 cannot pass.');
  return false;
}

/** L4 — each strand node assembles a cohort bigger than itself. */
async function legStrandCohort(all) {
  const key = 'multipeer-gate-probe-block';
  const got = await poll(async () => {
    const sizes = [];
    for (const { name, node } of all) {
      sizes.push({ name, ...(await cohortSize(node, key)) });
    }
    V(`cohort ${sizes.map((s) => `${s.name}=${s.count}`).join(' ')}`);
    return sizes.every((s) => s.count >= 2) ? sizes : null;
  }, COHORT_TIMEOUT_MS, 'strand cohort');

  if (!got) {
    const sizes = [];
    for (const { name, node } of all) sizes.push(`${name}=${(await cohortSize(node, key)).count}`);
    record('L4', 'strand-cohort', 'FAIL',
      `expected every strand node to assemble >= 2 cohort members, got ${sizes.join(' ')}. ` +
      'A node stuck at 1 has only itself: it was never given a peer to dial, which points ' +
      'upstream at strand-address seeding (L3), not at the dial layer.');
    return false;
  }
  record('L4', 'strand-cohort', 'PASS', got.map((s) => `${s.name}=${s.count}`).join(' '));
  return true;
}

/** L5 — the actual point: a row written by one relay-only peer is readable by the other. */
async function legReplication(peerA, peerB) {
  const dbA = strandDb(peerA.node);
  const dbB = strandDb(peerB.node);
  if (!dbA || !dbB) {
    record('L5', 'replication', 'FAIL', 'a relay-only peer has no active strand database');
    return false;
  }

  // StrandDatabase.executeSchema() wraps the DDL as `declare schema App { ... }`, so the
  // table lands in the `App` schema while the default schema path is `main`. Unqualified
  // it resolves to nothing: "Table 'GateRow' not found in schema path: main".
  const TABLE = 'App.GateRow';
  const id = `gate-row-${peerA.node.peerId.toString().slice(-8)}`;
  try {
    await dbA.exec(`insert into ${TABLE} (Id, Value) values ('${id}', 'written-by-peer-A');`);
  } catch (e) {
    record('L5', 'replication', 'FAIL', `peer-A write failed: ${e?.message ?? e}`);
    return false;
  }
  V(`peer-A wrote ${id}`);

  const seen = await poll(async () => {
    try {
      for await (const row of dbB.eval(`select Id from ${TABLE} where Id = '${id}';`)) {
        if (row?.Id === id) return true;
      }
    } catch (e) {
      V(`peer-B read retry: ${e?.message ?? e}`);
    }
    return false;
  }, REPLICATION_TIMEOUT_MS, 'replication');

  if (!seen) {
    record('L5', 'replication', 'FAIL',
      `peer-B never observed row '${id}' within ${REPLICATION_TIMEOUT_MS}ms`);
    return false;
  }
  record('L5', 'replication', 'PASS', `peer-B observed '${id}'`);
  return true;
}


/**
 * Owner genesis on the founder. cadre-core deliberately never runs this implicitly —
 * the hosting app owns it — so a harness must do it explicitly or every owner-signed
 * control write (including `createInvite`) fails.
 *
 *   trustOwnerKeys   anchor the owner pubkey in this node's node-local trusted set
 *   ensureOwnerKey   enroll it in the replicated OwnerKey table
 *   initializeSeedBootstrap  hand the private half to the seed/invite signer
 */
async function ownerGenesis(founder) {
  const owner = founder.getIdentityOwnerKey();
  await founder.trustOwnerKeys([owner.publicKeyB64], 'operator');
  const db = founder.getControlDatabase();
  if (!db) throw new Error('founder has no control database after start()');
  await db.ensureOwnerKey(owner.publicKeyB64);
  founder.initializeSeedBootstrap(owner.privateKeyB64);
  V(`owner genesis done (ownerKey=${owner.publicKeyB64.slice(0, 12)}…)`);
  return owner;
}

// ── enrolment ────────────────────────────────────────────────────────────────────────
/**
 * Run the public invite ceremony so the joiners become authorized members:
 * `createInvite` on the owner (which also opens the inbound enrolment window),
 * then `dialInvite` on the joiner. `acceptPhone` is tried as a fallback for builds
 * where the owner must accept explicitly.
 */
/**
 * `true` / `false` / `'unknown'` — never throws.
 *
 * `isAuthorizedMember` reads the control database, and that read can fail outright
 * (`Block default/Revocation is unavailable (peers-unreachable)`) rather than answering. That
 * is NOT a membership verdict, and treating it as one is what made this ceremony look broken:
 * the check was the FIRST statement in the attempt, so once reads started failing every
 * remaining attempt died before reaching `createInvite`, and the ceremony that would have
 * fixed things never ran. Worse, the failure was then reported as "membership did not take"
 * on a joiner that had in fact been accepted.
 */
async function isMemberOrUnknown(owner, peerId) {
  try {
    return await owner.isAuthorizedMember(peerId);
  } catch (e) {
    V(`membership read for ${peerId} could not be answered: ${e?.message ?? e}`);
    return 'unknown';
  }
}

async function enrol(owner, joiners) {
  for (const { name, node } of joiners) {
    const peerId = node.peerId.toString();
    let lastErr = null;

    for (let attempt = 1; attempt <= ENROLL_ATTEMPTS; attempt++) {
      const before = await isMemberOrUnknown(owner, peerId);
      if (before === true) { lastErr = null; break; }

      // Re-run the ceremony only when the control database DEFINITELY says this peer is not
      // a member, or on the first pass. An `unknown` on a later attempt means the ceremony
      // has already run and its result merely cannot be read yet — waiting is the right move,
      // and re-running would storm createInvite/acceptPhone through a read outage for no gain
      // (measured: three joiners x five full ceremonies, minutes of work, no effect).
      if (before === false || attempt === 1) {
        try {
          // Bounded like dialInvite below. createInvite is a control WRITE, and this call sits
          // on the same path whose reads are known to stall; an unbounded write here would
          // hang the whole gate rather than fail it.
          const { invite } = await withTimeout(
            owner.createInvite(), ENROLL_TIMEOUT_MS, `${name} createInvite`);
          await withTimeout(node.dialInvite(invite), ENROLL_TIMEOUT_MS, `${name} dialInvite`);
          try {
            await owner.acceptPhone({ phonePeerId: peerId }, invite);
          } catch (e) {
            V(`${name} acceptPhone unavailable: ${e?.message ?? e}`);
          }
          V(`${name} ceremony ran (attempt ${attempt})`);
        } catch (e) {
          lastErr = e;
          V(`${name} ceremony attempt ${attempt}/${ENROLL_ATTEMPTS} failed: ${e?.message ?? e}`);
        }
      }

      const settled = await isMemberOrUnknown(owner, peerId);
      if (settled === true) { lastErr = null; break; }
      lastErr = settled === 'unknown'
        ? new Error('ceremony ran, but the control database could not be read to confirm it')
        : new Error('ceremony completed but membership did not take');

      await new Promise((r) => setTimeout(r, ENROLL_RETRY_MS * attempt)); // linear backoff
    }

    if (lastErr) L(`WARN enrolment for ${name} did not settle after ${ENROLL_ATTEMPTS} attempt(s): ${lastErr?.message ?? lastErr}`);
    else V(`${name} enrolled`);
  }
}

/**
 * Wait for the topology to settle before the enrolment ceremony.
 *
 * cadre-core 0.12.0 changed WHEN a relay reservation lands: `network.relayAddrs` takes
 * libp2p's 'search' route and `CadreNode.start()` drives the reservation explicitly AFTER
 * the control database is up, where 0.11.0's relay-qualified listen entry reserved from
 * inside `libp2p.start()`. So `start()` can now return before a relay-only peer has a
 * circuit address, and enrolment issued in that window reads owner-signed control state
 * that no one can serve yet — it fails with
 *   Block default/Revocation is unavailable (peers-unreachable)
 * which is a TIMING artifact, not a membership verdict.
 *
 * `enrol()`'s bounded retry alone is not enough: on 0.12.0 the whole retry budget can
 * elapse before the reservation lands, so the gate went from deterministic to flaky (it
 * passed one run and failed the next on an unchanged tree). Gate on the observable
 * preconditions instead — the founder sees everyone, and every relay-only peer holds a
 * `/p2p-circuit` address — then let the existing retry cover the residual jitter.
 *
 * Returns false on timeout rather than throwing: enrolment still runs, and L3 still
 * reports the real failure if membership genuinely cannot be established.
 */
async function settleTopology(founder, all, relayOnly, ms = SETTLE_TIMEOUT_MS) {
  const deadline = Date.now() + ms;
  for (;;) {
    const founderPeers = founder.getControlNode().getPeers?.().length ?? 0;
    const meshed = founderPeers >= all.length - 1
      && all.every((n) => (n.node.getControlNode().getPeers?.().length ?? 0) >= 1);
    const reserved = relayOnly.every(({ node }) =>
      node.getControlNode().getMultiaddrs().map(String).some((a) => a.includes('/p2p-circuit')));
    if (meshed && reserved) {
      await new Promise((r) => setTimeout(r, SETTLE_GRACE_MS));  // let the control writes land
      V(`topology settled (founder sees ${founderPeers}, ${relayOnly.length} reservation(s))`);
      return true;
    }
    if (Date.now() >= deadline) {
      L(`WARN topology did not settle in ${ms}ms (meshed=${meshed} reserved=${reserved}) — enrolling anyway`);
      return false;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

// ── main ─────────────────────────────────────────────────────────────────────────────
async function main() {
  L(`config DRONES=${DRONES} RELAYS=${RELAYS} CLUSTER_SIZE=${CLUSTER_SIZE} ` +
    `ENROLL=${ENROLL ? 1 : 0} TIMEOUT_SCALE=${SCALE}`);
  L('bringing up the n=4 topology ...');

  const droneA = await startDrone('drone-A', []);

  // Owner genesis runs while the founder is STILL SOLO, before anyone else joins.
  // It writes owner-signed control state, and once the control DB is spread across a
  // cohort that write needs a quorum the joiners cannot yet serve — attempting it after
  // bring-up fails with `Block default/Revocation is unavailable (peers-unreachable)`,
  // which reads like a network fault but is really a founding-order mistake.
  if (ENROLL) {
    L('running owner genesis on the founder (solo) ...');
    await ownerGenesis(droneA);
  } else {
    L('ENROLL=0 — skipping owner genesis and enrolment deliberately');
  }

  const droneAAddr = loopbackWs(controlAddrs(droneA));
  const drones = [{ name: 'drone-A', node: droneA }];
  for (let i = 1; i < DRONES; i++) {
    const name = `drone-${String.fromCharCode(65 + i)}`;
    drones.push({ name, node: await startDrone(name, [droneAAddr]) });
  }
  const droneAddrs = drones.map((d) => loopbackWs(controlAddrs(d.node)));

  const relayAddrs = droneAddrs.slice(0, Math.max(1, Math.min(RELAYS, droneAddrs.length)));
  const peerA = await startRelayOnlyPeer('peer-A', relayAddrs, [droneAAddr]);
  const peerB = await startRelayOnlyPeer('peer-B', relayAddrs, [droneAAddr]);

  const peers = [{ name: 'peer-A', node: peerA }, { name: 'peer-B', node: peerB }];
  const all = [...drones, ...peers];

  // L1 before any strand work: a broken mesh makes every later leg meaningless.
  if (!(await legControlMesh(droneA, all))) return false;
  if (!(await legRelayReservation(peers, drones))) return false;

  if (ENROLL) {
    // Gate on the reservation actually landing — see settleTopology(). Without this the
    // ceremony races cadre-core 0.12.0's post-bring-up reservation drive and L3 fails
    // intermittently with `peers-unreachable`, which reads like a membership failure.
    await settleTopology(droneA, all, peers);
    L('running the invite/enrolment ceremony ...');
    await enrol(droneA, [...drones.slice(1), ...peers]);
  }
  if (!(await legCadreAuthorization(droneA, peers))) return false;

  L('bringing up strands ...');
  for (const { name, node } of drones) await addStrand(node, name, 'bootstrap');
  await addStrand(peerA, 'peer-A', 'networked');
  await addStrand(peerB, 'peer-B', 'networked');

  if (!(await legStrandCohort(all))) return false;
  if (!(await legReplication(peers[0], peers[1]))) return false;

  return true;
}

async function shutdown() {
  for (const { name, node } of nodes) {
    try {
      await node.stop();
    } catch (e) {
      V(`${name} stop error: ${e?.message ?? e}`);
    }
  }
}

function summarize(passed) {
  L('');
  L('──────────────────────────── SUMMARY ────────────────────────────');
  for (const r of results) {
    L(` ${r.status.padEnd(4)}  ${r.id}  ${r.title}`);
  }
  const ran = results.length;
  L('─────────────────────────────────────────────────────────────────');
  if (passed) {
    L('MULTIPEER GATE: PASS — all 5 legs green.');
    L('Necessary, not sufficient: this is loopback, so it says the blocker is not in');
    L('this layer. It does not stand in for a device run.');
  } else {
    const failed = results.find((r) => r.status === 'FAIL');
    L(`MULTIPEER GATE: FAIL at ${failed?.id ?? '?'} (${failed?.title ?? 'startup'}) — ${ran} leg(s) ran.`);
    L('Legs are ordered, so this is the EARLIEST broken link, not a downstream symptom.');
    L("Re-run with DEBUG='optimystic:db-p2p:*,db-p2p:*,sereus:*' for the underlying trace.");
  }
  return passed ? 0 : 1;
}

let exitCode = 1;
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    L(`${sig} — stopping ...`);
    await shutdown();
    process.exit(1);
  });
}

main()
  .then((passed) => { exitCode = summarize(passed); })
  .catch((err) => {
    L('MULTIPEER GATE: FAIL (harness error)', err?.stack ?? err);
    exitCode = summarize(false);
  })
  .finally(async () => {
    await shutdown();
    process.exit(exitCode);
  });
