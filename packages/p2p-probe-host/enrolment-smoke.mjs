/**
 * packages/p2p-probe-host/enrolment-smoke.mjs — the cadre-membership ceremony, cross-process.
 *
 *   cd packages/p2p-probe-host && node enrolment-smoke.mjs
 *
 * WHY. P2P-11's root cause is that the device harness never enrolled its peers: drone-A
 * refused every device with `Refusing strand-addr from non-member <peerId>`, so the strand
 * cohort could not form and replication never started. `drone.mjs` now runs owner genesis and
 * accepts joiners; this proves that it does, against the REAL drone process and a REAL
 * CadreNode joiner, with no emulator and no Android in the loop.
 *
 * It is deliberately NOT the multipeer gate. The gate runs every node in ONE process, where
 * the owner can call `acceptPhone(joiner.peerId)` directly. The whole difficulty on device is
 * that the owner and the joiner are different processes, and that is exactly the seam this
 * exercises: the drone advertises `PROOF_INVITE=` on stdout, a separate node redeems it, and
 * the drone must discover and accept that node on its own.
 *
 * Exit 0 on PASS, 1 on FAIL.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CadreNode } from '@serfab/cadre-core';
import { webSockets } from '@libp2p/websockets';

const L = (...a) => console.log('[enrolment-smoke]', ...a);
const PARTY_ID = 'votetorrent';           // must match drone.mjs
const STRAND_ID = 'enrolment-smoke-strand';
const BOOT_TIMEOUT_MS = 90_000;
const ENROL_TIMEOUT_MS = 90_000;

let drone = null;
let droneB = null;
let joiner = null;
let droneOut = '';
let droneBOut = '';

/**
 * Wait until a spawned process's captured output matches `re`, or time out.
 * Read through getters, not values: the buffers grow after this is called.
 */
function waitForLine(getOut, getProc, re, ms, what) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + ms;
    const tick = setInterval(() => {
      const m = getOut().match(re);
      if (m) { clearInterval(tick); resolve(m); return; }
      const code = getProc()?.exitCode;
      if (code !== null && code !== undefined) {
        clearInterval(tick);
        reject(new Error(`process exited (code ${code}) before ${what}\n${getOut().slice(-2000)}`));
        return;
      }
      if (Date.now() >= deadline) {
        clearInterval(tick);
        reject(new Error(`timed out after ${ms}ms waiting for ${what}\n--- output ---\n${getOut().slice(-2000)}`));
      }
    }, 250);
  });
}

const waitForDroneLine = (re, ms, what) =>
  waitForLine(() => droneOut, () => drone, re, ms, what);

async function cleanup() {
  try { await joiner?.stop(); } catch { /* best effort */ }
  for (const p of [droneB, drone]) {
    try { p?.kill('SIGTERM'); } catch { /* best effort */ }
  }
}

async function main() {
  const enrolDir = mkdtempSync(join(tmpdir(), 'enrolment-smoke-'));

  // ── 1. Boot the REAL drone as founder (no DRONE_BOOTSTRAP_CONTROL_ADDR) ─────────────────
  L('starting drone.mjs as founder ...');
  drone = spawn(process.execPath, ['drone.mjs'], {
    cwd: import.meta.dirname,
    env: { ...process.env, STRAND_ID, DRONE_ENROL_DIR: enrolDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  drone.stdout.on('data', (d) => { droneOut += d.toString(); });
  drone.stderr.on('data', (d) => { droneOut += d.toString(); });

  const [, droneAddr] = await waitForDroneLine(/PROOF_WS_ADDR=(\S+)/, BOOT_TIMEOUT_MS, 'PROOF_WS_ADDR');
  L('drone control addr =', droneAddr);

  // The invite is minted only by a FOUNDER, and only after owner genesis — so this line
  // appearing at all is already evidence that genesis ran on a solo node.
  const [, encodedInvite] = await waitForDroneLine(/PROOF_INVITE=(\S+)/, BOOT_TIMEOUT_MS, 'PROOF_INVITE');
  L('drone advertised an invite (', encodedInvite.length, 'chars )');
  await waitForDroneLine(/ENROL_ARMED/, BOOT_TIMEOUT_MS, 'ENROL_ARMED');

  // ── 2. Boot a joiner in a separate node, bootstrapped to the drone ──────────────────────
  // 'transaction' profile: the device peers' profile, and the one with no relay server of its
  // own — the shape that actually needs to be admitted.
  joiner = new CadreNode({
    controlNetwork: { partyId: PARTY_ID, bootstrapNodes: [droneAddr] },
    profile: 'transaction',
    requireSignedSchemas: false,
    strandFilter: { mode: 'all' },
    network: { transports: [webSockets()], listenAddrs: [] },
    strandClusterSize: 2,
    hibernation: { enabled: false },
  });
  await joiner.start();
  const joinerId = joiner.peerId?.toString();
  L('joiner peerId =', joinerId);

  // ── 3. Redeem the invite — the joiner's half of the ceremony ────────────────────────────
  await joiner.dialInvite(joiner.decodeInvite(encodedInvite));
  L('joiner dialInvite ok');

  // ── 4. The drone must now accept this joiner ON ITS OWN ─────────────────────────────────
  // No peerId is handed to the drone by this script — that is the point. It has to notice the
  // joiner on its control node and accept it while its enrollment window is open.
  const accepted = new RegExp(`ENROL_ACCEPTED=${joinerId}`);
  await waitForDroneLine(accepted, ENROL_TIMEOUT_MS, `ENROL_ACCEPTED for ${joinerId}`);
  L('drone accepted the joiner');

  // Membership read-back is best-effort by design (it races the control write), so a missing
  // ENROLLED= is reported, never failed on. ENROL_ACCEPTED above is the ceremony's outcome.
  try {
    await waitForDroneLine(new RegExp(`ENROLLED=${joinerId}`), 20_000, 'ENROLLED');
    L('drone confirmed membership read-back');
  } catch {
    L('NOTE membership read-back not confirmed within 20s — expected under load; ' +
      'ENROL_ACCEPTED is the authoritative signal');
  }

  // ── 5. A JOINER DRONE (drone-B) — the harness's other half ─────────────────────────────
  // drone-B is a second host-side process, cross-bootstrapped to drone-A. It runs both halves
  // of the ceremony: it redeems the invite (anchoring drone-A's owner keys) and drone-A
  // accepts it. Its ownerAddrs need no emulator rewrite — it is a host process, so it dials
  // the drone's loopback addresses exactly as advertised.
  L('starting a joiner drone (drone-B) ...');
  droneB = spawn(process.execPath, ['drone.mjs'], {
    cwd: import.meta.dirname,
    env: {
      ...process.env,
      STRAND_ID,
      DRONE_BOOTSTRAP_CONTROL_ADDR: droneAddr,
      DRONE_INVITE: encodedInvite,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  droneB.stdout.on('data', (d) => { droneBOut += d.toString(); });
  droneB.stderr.on('data', (d) => { droneBOut += d.toString(); });

  await waitForLine(() => droneBOut, () => droneB, /ENROL_DIALED/, BOOT_TIMEOUT_MS,
    'drone-B ENROL_DIALED');
  L('drone-B redeemed the invite');

  const [, droneBId] = droneBOut.match(/control peerId = (\S+)/) ?? [];
  if (!droneBId) throw new Error('could not read drone-B peerId from its output');
  await waitForDroneLine(new RegExp(`ENROL_ACCEPTED=${droneBId}`), ENROL_TIMEOUT_MS,
    `ENROL_ACCEPTED for drone-B ${droneBId}`);
  L('drone-A accepted drone-B');

  if (/ENROL_FAILED=/.test(droneOut)) {
    throw new Error(`drone reported ENROL_FAILED:\n${droneOut.match(/ENROL_FAILED=.*/g)?.join('\n')}`);
  }

  // Exactly-once: the watcher's tick body awaits acceptPhone and a settle delay, so it runs
  // LONGER than its own poll interval. Without a re-entrancy guard, overlapping ticks each
  // pass the `settled.has` check before any records the outcome and the SAME peer is accepted
  // repeatedly (observed on-device: 12 accepts of one peerId) — concurrent writes to
  // default/CadrePeer, which is what tore a multi-tree commit in the first n=4 device run.
  // Waiting for the first ENROL_ACCEPTED cannot see this; only the count can.
  const acceptCounts = new Map();
  for (const m of droneOut.match(/ENROL_ACCEPTED=\S+/g) ?? []) {
    acceptCounts.set(m, (acceptCounts.get(m) ?? 0) + 1);
  }
  const repeated = [...acceptCounts.entries()].filter(([, n]) => n > 1);
  if (repeated.length > 0) {
    throw new Error(
      'the same peer was accepted more than once — the joiner watcher is re-entrant:\n' +
        repeated.map(([id, n]) => `  ${n}x ${id}`).join('\n'),
    );
  }
  L(`exactly-once accept verified for ${acceptCounts.size} peer(s)`);
}

main()
  .then(async () => {
    await cleanup();
    L('ENROLMENT SMOKE: PASS');
    process.exit(0);
  })
  .catch(async (e) => {
    await cleanup();
    L('ENROLMENT SMOKE: FAIL —', e?.message ?? e);
    process.exit(1);
  });
