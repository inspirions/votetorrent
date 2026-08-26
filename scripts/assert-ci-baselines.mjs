#!/usr/bin/env node
/**
 * assert-ci-baselines.mjs
 *
 * Verdict authority for the dashboard CI workflow's measured baselines and
 * its anti-silent-green receipt mechanism.
 *
 * Why this exists: a test runner's own process exit code is NOT a trustworthy
 * CI verdict in this repo. `yarn workspace @votetorrent/vote-engine test`
 * exits non-zero by design (it carries 8 pre-existing failures); `tsc --noEmit`
 * on apps/VoteTorrentAuthority exits non-zero by design (51 pre-existing
 * errors). Both need a checker that reads the actual counts and titles out of
 * a captured log and decides pass/fail against a committed, reviewed contract
 * (scripts/ci-baselines.json) -- not the raw process exit code, which this
 * script's callers deliberately do not trust either (see .github/workflows/
 * dashboard.yml's `if ! ...; then echo "... the checker decides"; fi` guards).
 *
 * Five subcommands:
 *   vote-engine <logfile> [--ci]       -- exact failure count + title match, passing floor.
 *                                          `--ci` selects ciBaselines.voteEngine.ciMinPassing
 *                                          over minPassing: a fresh CI checkout has no
 *                                          .planning/ (nested, gitignored repo), so one test
 *                                          skips there instead of passing -- see ci-baselines
 *                                          .json's voteEngine.note for the full explanation.
 *   tier1 <logfile> <elapsedSeconds>   -- dashboard test:node floor + time budget
 *   authority-typecheck <logfile>      -- tsc error-count ceiling
 *   receipts <receiptfile> <marker...> -- anti-silent-green marker presence check
 *   selftest                           -- the checker's own inertness control
 *
 * Two rules this file obeys and states here: it NEVER mutates ci-baselines.json,
 * and it has NO "update the baseline" mode. Updating a baseline is a human,
 * reviewed commit -- see ci-baselines.json's own _readme.
 *
 * Update / removal trigger: when a workflow step's log format changes (a new
 * mocha version, a new Node --test reporter default, a new tsc diagnostic
 * format), update the relevant parse* function in the SAME commit as whatever
 * changed the format, and re-run `selftest` before trusting the new parser.
 */

import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASELINES_PATH = path.join(__dirname, 'ci-baselines.json');

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

function loadBaselines() {
  // Resolved relative to this file's own URL, never process.cwd() -- jobs in
  // dashboard.yml invoke this script from the repo root AND from
  // apps/VoteTorrentDashboard alike.
  return JSON.parse(readFileSync(BASELINES_PATH, 'utf8'));
}

function readLogSafe(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function emitReceipt(line) {
  process.stdout.write(line + '\n');
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    try {
      writeFileSync(summaryPath, line + '\n', { flag: 'a' });
    } catch {
      // best-effort only -- never fail the check because the run-summary file
      // happens to be unwritable
    }
  }
}

function printNotices(notices) {
  for (const n of notices ?? []) {
    process.stdout.write(`::notice::${n}\n`);
  }
}

function fail(msg) {
  process.stderr.write(`[assert-ci-baselines] ${msg}\n`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// mocha summary + failing-title parsing (vote-engine)
// ---------------------------------------------------------------------------

function parseMochaSummary(log) {
  const passingMatch = log.match(/^\s*(\d+)\s+passing\b/m);
  const failingMatch = log.match(/^\s*(\d+)\s+failing\b/m);
  if (!passingMatch && !failingMatch) return null; // the vacuous-pass guard
  return {
    passing: passingMatch ? Number(passingMatch[1]) : 0,
    failing: failingMatch ? Number(failingMatch[1]) : 0,
  };
}

/**
 * Mocha's spec reporter prints a bare "N) title" marker INLINE at the point
 * a test fails during the live run (no trailing colon, and it is never
 * followed by one until some unrelated later line happens to end with ':') --
 * that inline marker must NOT be parsed as a title source. The real,
 * parseable failure detail list is the one final block after the "M failing"
 * summary line, so failure-title parsing is scoped to start there.
 */
function extractFailureSection(log) {
  const re = /^\s*\d+\s+failing\b.*$/m;
  const m = re.exec(log);
  if (!m) return '';
  return log.slice(m.index + m[0].length);
}

/**
 * Within the failure detail section, a test's full title is nested across
 * multiple indented lines (one per enclosing `describe`), terminating in the
 * `it` title, which is the only line in the chain that ends with ':'. A
 * non-nested test's own opening "N) title:" line may already end with ':'.
 * This walks each failure block from its "N) " line until it hits the line
 * ending in ':', joining the lines with a single space to reconstruct the
 * full nested title.
 */
function parseMochaFailureTitles(log) {
  const lines = extractFailureSection(log).split('\n');
  const titles = [];
  let i = 0;
  while (i < lines.length) {
    const m = lines[i].match(/^\s*\d+\)\s+(.*)$/);
    if (!m) {
      i++;
      continue;
    }
    const parts = [m[1].trim()];
    let j = i + 1;
    let done = parts[0].endsWith(':');
    while (!done && j < lines.length) {
      const trimmed = lines[j].trim();
      if (trimmed === '') break; // malformed block -- stop rather than run away
      parts.push(trimmed);
      done = trimmed.endsWith(':');
      j++;
    }
    let title = parts.join(' ');
    if (title.endsWith(':')) title = title.slice(0, -1);
    titles.push(title);
    i = done ? j : j; // advance past whatever we consumed either way
  }
  return titles;
}

function multisetDiff(observed, known) {
  const obsCount = new Map();
  for (const t of observed) obsCount.set(t, (obsCount.get(t) ?? 0) + 1);
  const knownCount = new Map();
  for (const t of known) knownCount.set(t, (knownCount.get(t) ?? 0) + 1);

  const unexpected = [];
  for (const [t, c] of obsCount) {
    const kc = knownCount.get(t) ?? 0;
    for (let k = 0; k < c - kc; k++) unexpected.push(t);
  }
  const missing = [];
  for (const [t, c] of knownCount) {
    const oc = obsCount.get(t) ?? 0;
    for (let k = 0; k < c - oc; k++) missing.push(t);
  }
  return { unexpected, missing };
}

function evaluateVoteEngine(log, baselines, opts = {}) {
  const cfg = baselines.voteEngine;
  const ci = Boolean(opts.ci);
  // CI never has `.planning/` (a nested, gitignored git repo with zero tracked files in the
  // outer tree), so one test (strand-cohort-routing-coverage.spec.ts's diagnosis-doc check)
  // guards on existsSync and calls this.skip() there instead of hard-failing an environment
  // that could never have the file. That moves it from passing into pending on CI only -- the
  // failing count and title set are unaffected in both environments, which is why only the
  // floor picks between two committed numbers instead of the whole check branching.
  const floor = ci ? cfg.ciMinPassing : cfg.minPassing;
  const floorName = ci ? 'ciMinPassing' : 'minPassing';
  const summary = parseMochaSummary(log);
  if (!summary) {
    return { ok: false, problems: ['no mocha summary found'] };
  }
  const titles = parseMochaFailureTitles(log);
  const { unexpected, missing } = multisetDiff(titles, cfg.knownFailureTitles);

  const problems = [];
  if (summary.failing !== cfg.expectedFailing) {
    if (summary.failing < cfg.expectedFailing) {
      problems.push(
        `failing count DROPPED to ${summary.failing} (expected exactly ${cfg.expectedFailing}) -- ` +
          `a drop is a signal to investigate, not a number to absorb: a failure that disappeared ` +
          `without a commit that fixed it needs explanation before the baseline is lowered`,
      );
    } else {
      problems.push(
        `failing count ROSE to ${summary.failing} (expected exactly ${cfg.expectedFailing}) -- ` +
          `a newly-introduced failure`,
      );
    }
  }
  if (unexpected.length > 0) {
    problems.push(`unexpected failing title(s): ${unexpected.map((t) => JSON.stringify(t)).join(', ')}`);
  }
  if (missing.length > 0) {
    problems.push(
      `known failing title(s) not observed (disappeared): ${missing.map((t) => JSON.stringify(t)).join(', ')}`,
    );
  }
  if (summary.passing < floor) {
    problems.push(`passing=${summary.passing} is below the floor ${floorName}=${floor}`);
  }

  return {
    ok: problems.length === 0,
    problems,
    receipt: `RECEIPT vote-engine-baseline passing=${summary.passing} failing=${summary.failing} ci=${ci}`,
  };
}

// ---------------------------------------------------------------------------
// tier1 (dashboard test:node) parsing
// ---------------------------------------------------------------------------

function parseTier1Summary(log) {
  let passMatch = log.match(/^#\s*pass\s+(\d+)/m);
  let failMatch = log.match(/^#\s*fail\s+(\d+)/m);
  if (!passMatch && !failMatch) {
    // Fallback: bare `pass N` / `fail N`, in case a future Node changes the
    // default `node --test` reporter away from TAP's `# pass N` form.
    passMatch = log.match(/^pass\s+(\d+)/m);
    failMatch = log.match(/^fail\s+(\d+)/m);
  }
  if (!passMatch && !failMatch) return null; // the vacuous-pass guard
  return {
    passing: passMatch ? Number(passMatch[1]) : 0,
    failing: failMatch ? Number(failMatch[1]) : 0,
  };
}

function evaluateTier1(log, elapsedSecondsArg, baselines) {
  const cfg = baselines.dashboardTier1;
  const summary = parseTier1Summary(log);
  if (!summary) {
    return {
      ok: false,
      problems: ['no tier1 summary found (expected "# pass N" / "# fail N" or the bare spec-reporter fallback)'],
    };
  }
  const elapsed = Number(elapsedSecondsArg);
  const problems = [];
  if (summary.failing > cfg.maxFailing) {
    problems.push(`fail=${summary.failing} exceeds maxFailing=${cfg.maxFailing}`);
  }
  if (summary.passing < cfg.minPassing) {
    problems.push(`pass=${summary.passing} is below the floor minPassing=${cfg.minPassing}`);
  }
  if (Number.isFinite(elapsed) && elapsed > cfg.maxSeconds) {
    problems.push(`elapsed=${elapsed}s exceeds maxSeconds=${cfg.maxSeconds}`);
  }
  const notices = [];
  if (summary.passing > cfg.minPassing) {
    notices.push(
      `tier1 passing count ${summary.passing} exceeds the committed floor ${cfg.minPassing} -- ` +
        `raise dashboardTier1.minPassing deliberately in ci-baselines.json`,
    );
  }
  return {
    ok: problems.length === 0,
    problems,
    notices,
    receipt: `RECEIPT tier1-logic pass=${summary.passing} fail=${summary.failing} seconds=${elapsed}`,
  };
}

// ---------------------------------------------------------------------------
// authority typecheck ceiling
// ---------------------------------------------------------------------------

function evaluateAuthorityTypecheck(log, baselines) {
  const cfg = baselines.authorityTypecheck;
  const count = (log.match(/error TS\d+/g) || []).length;
  const problems = [];
  if (count > cfg.maxErrors) {
    problems.push(
      `errors=${count} exceeds ceiling maxErrors=${cfg.maxErrors} (delta +${count - cfg.maxErrors}) -- ` +
        `the producer half added to apps/VoteTorrentAuthority must introduce none`,
    );
  }
  const notices = [];
  if (count < cfg.maxErrors) {
    notices.push(
      `authority typecheck errors=${count} is below the ceiling maxErrors=${cfg.maxErrors} -- ` +
        `someone fixed something; lower authorityTypecheck.maxErrors deliberately in that same commit`,
    );
  }
  return {
    ok: problems.length === 0,
    problems,
    notices,
    receipt: `RECEIPT authority-typecheck-baseline errors=${count} ceiling=${cfg.maxErrors}`,
  };
}

// ---------------------------------------------------------------------------
// receipts (anti-silent-green)
// ---------------------------------------------------------------------------

function evaluateReceipts(receiptFile, markers) {
  const content = readLogSafe(receiptFile);
  const missing = [];
  for (const marker of markers) {
    const re = new RegExp('(^|\\s)RECEIPT\\s+' + escapeRegExp(marker) + '(\\s|$)', 'm');
    if (!re.test(content)) missing.push(marker);
  }
  return {
    ok: missing.length === 0,
    problems: missing.length > 0 ? [`missing receipt marker(s): ${missing.join(', ')}`] : [],
  };
}

// ---------------------------------------------------------------------------
// synthetic fixture builders (selftest only)
// ---------------------------------------------------------------------------

function buildMochaLog(passing, failing, titles) {
  let s = `  ${passing} passing (12ms)\n  ${failing} failing\n\n`;
  titles.forEach((t, idx) => {
    s += `  ${idx + 1}) ${t}:\n     Error: synthetic failure for selftest\n\n`;
  });
  return s;
}

function buildTier1LogHash(pass, fail) {
  return `TAP version 13\n1..${pass + fail}\n# tests ${pass + fail}\n# pass ${pass}\n# fail ${fail}\n`;
}

function buildTier1LogBare(pass, fail) {
  return `pass ${pass}\nfail ${fail}\n`;
}

function buildTscLog(n) {
  let s = '';
  for (let i = 0; i < n; i++) {
    s += `src/synthetic${i}.ts(1,1): error TS${1000 + i}: synthetic error for selftest\n`;
  }
  return s;
}

function buildReceiptFile(markers) {
  return markers.map((m) => `RECEIPT ${m} extra=data`).join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// selftest -- the checker's own inertness control
// ---------------------------------------------------------------------------

function runSelftest() {
  const baselines = loadBaselines();
  const tmp = mkdtempSync(path.join(tmpdir(), 'ci-baselines-selftest-'));

  let total = 0;
  let negativeTotal = 0;
  let negativeRejected = 0;
  const failures = [];

  function check(name, expectOk, result) {
    total++;
    const isNegative = !expectOk;
    if (isNegative) negativeTotal++;
    const correct = result.ok === expectOk;
    if (isNegative && correct) negativeRejected++;
    if (!correct) {
      const detail = result.problems && result.problems.length ? ` (${result.problems.join('; ')})` : '';
      failures.push(
        `${name}: expected ${expectOk ? 'PASS' : 'REJECT'} but got ${result.ok ? 'PASS' : 'REJECT'}${detail}`,
      );
    }
  }

  try {
    const knownTitles = baselines.voteEngine.knownFailureTitles;
    const veFloor = baselines.voteEngine.minPassing;
    const veExpectedFailing = baselines.voteEngine.expectedFailing;

    // 1. vote-engine, healthy
    check(
      'vote-engine healthy',
      true,
      evaluateVoteEngine(buildMochaLog(veFloor + 9, veExpectedFailing, knownTitles), baselines),
    );

    // 2. vote-engine, new failure (a 9th title, count rises)
    check(
      'vote-engine new failure',
      false,
      evaluateVoteEngine(
        buildMochaLog(veFloor + 9, veExpectedFailing + 1, [...knownTitles, 'a brand new failure title']),
        baselines,
      ),
    );

    // 3. vote-engine, substituted failure (same count, one title swapped)
    check(
      'vote-engine substituted failure',
      false,
      evaluateVoteEngine(
        buildMochaLog(veFloor + 9, veExpectedFailing, [...knownTitles.slice(1), 'a substituted failure title']),
        baselines,
      ),
    );

    // 4. vote-engine, drop (one fewer failure than expected)
    check(
      'vote-engine drop',
      false,
      evaluateVoteEngine(buildMochaLog(veFloor + 9, veExpectedFailing - 1, knownTitles.slice(1)), baselines),
    );

    // 5. vote-engine, below floor
    check(
      'vote-engine below floor',
      false,
      evaluateVoteEngine(buildMochaLog(Math.max(0, veFloor - 200), veExpectedFailing, knownTitles), baselines),
    );

    // 6. vote-engine, vacuous (empty log) -- the case that matters most
    check('vote-engine vacuous (empty log)', false, evaluateVoteEngine('', baselines));

    // 7. vote-engine, vacuous (no passing/failing summary line at all)
    check(
      'vote-engine vacuous (no summary line)',
      false,
      evaluateVoteEngine('mocha crashed before running anything\nsegmentation fault\n', baselines),
    );

    const veCiFloor = baselines.voteEngine.ciMinPassing;

    // 7a. vote-engine, --ci mode healthy at the LOWER ci floor (one fewer passing than local,
    //     because the .planning-guarded test reports pending instead of passing on CI)
    check(
      'vote-engine ci-mode healthy at ciMinPassing',
      true,
      evaluateVoteEngine(buildMochaLog(veCiFloor, veExpectedFailing, knownTitles), baselines, { ci: true }),
    );

    // 7b. vote-engine, --ci mode still enforces its own floor, not the local (higher) one
    check(
      'vote-engine ci-mode below ciMinPassing',
      false,
      evaluateVoteEngine(
        buildMochaLog(Math.max(0, veCiFloor - 50), veExpectedFailing, knownTitles),
        baselines,
        { ci: true },
      ),
    );

    // 7c. vote-engine, non-ci mode at exactly ciMinPassing must FAIL against the higher local
    //     floor -- proves the two floors are not silently interchangeable
    check(
      'vote-engine non-ci mode rejects the ci floor',
      false,
      evaluateVoteEngine(buildMochaLog(veCiFloor, veExpectedFailing, knownTitles), baselines, { ci: false }),
    );

    const t1Floor = baselines.dashboardTier1.minPassing;
    const t1MaxSeconds = baselines.dashboardTier1.maxSeconds;

    // 8. tier1, healthy
    check(
      'tier1 healthy',
      true,
      evaluateTier1(buildTier1LogHash(t1Floor, 0), Math.max(1, t1MaxSeconds - 1), baselines),
    );

    // 9. tier1, failing
    check('tier1 failing', false, evaluateTier1(buildTier1LogHash(t1Floor, 1), 1, baselines));

    // 10. tier1, below floor
    check(
      'tier1 below floor',
      false,
      evaluateTier1(buildTier1LogHash(Math.max(0, t1Floor - 50), 0), 1, baselines),
    );

    // 11. tier1, over budget
    check(
      'tier1 over budget',
      false,
      evaluateTier1(buildTier1LogHash(t1Floor, 0), t1MaxSeconds + 100, baselines),
    );

    // 12. tier1, spec-reporter fallback form (no leading '#')
    check('tier1 spec-reporter fallback form', true, evaluateTier1(buildTier1LogBare(t1Floor, 0), 1, baselines));

    // 13. tier1, vacuous
    check('tier1 vacuous', false, evaluateTier1('nothing resembling a summary here\n', 1, baselines));

    const tcCeiling = baselines.authorityTypecheck.maxErrors;

    // 14. authority-typecheck, exactly at the ceiling
    check(
      'authority-typecheck at ceiling',
      true,
      evaluateAuthorityTypecheck(buildTscLog(tcCeiling), baselines),
    );

    // 15. authority-typecheck, one over the ceiling
    check(
      'authority-typecheck over ceiling',
      false,
      evaluateAuthorityTypecheck(buildTscLog(tcCeiling + 1), baselines),
    );

    // 16. authority-typecheck, under the ceiling (notice, still passes)
    check(
      'authority-typecheck under ceiling (notice)',
      true,
      evaluateAuthorityTypecheck(buildTscLog(Math.max(0, tcCeiling - 2)), baselines),
    );

    // 17. receipts, complete set
    {
      const markers = ['toolchain', 'peers-clean', 'tier1-logic'];
      const file = path.join(tmp, 'receipts-complete.txt');
      writeFileSync(file, buildReceiptFile(markers));
      check('receipts complete set', true, evaluateReceipts(file, markers));
    }

    // 18. receipts, one marker missing
    {
      const markers = ['toolchain', 'peers-clean', 'tier1-logic'];
      const file = path.join(tmp, 'receipts-missing.txt');
      writeFileSync(file, buildReceiptFile(markers.slice(0, 2)));
      check('receipts one missing', false, evaluateReceipts(file, markers));
    }

    // 19. receipts, empty file
    {
      const file = path.join(tmp, 'receipts-empty.txt');
      writeFileSync(file, '');
      check('receipts empty file', false, evaluateReceipts(file, ['toolchain']));
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  if (failures.length > 0) {
    process.stderr.write(
      `[assert-ci-baselines] checker is inert: ${failures[0]}\n` +
        failures
          .slice(1)
          .map((f) => `  also: ${f}\n`)
          .join(''),
    );
    process.exit(1);
  }

  process.stdout.write(
    `selftest: ${total}/${total} cases, ${negativeRejected}/${negativeTotal} negative cases correctly rejected\n`,
  );
  process.exit(0);
}

// ---------------------------------------------------------------------------
// CLI dispatch
// ---------------------------------------------------------------------------

function main() {
  const [, , cmd, ...args] = process.argv;

  switch (cmd) {
    case 'vote-engine': {
      const [logfile, ...rest] = args;
      const ci = rest.includes('--ci');
      if (!logfile) fail('usage: assert-ci-baselines.mjs vote-engine <logfile> [--ci]');
      const result = evaluateVoteEngine(readLogSafe(logfile), loadBaselines(), { ci });
      if (!result.ok) fail(`vote-engine baseline check FAILED:\n  - ${result.problems.join('\n  - ')}`);
      printNotices(result.notices);
      emitReceipt(result.receipt);
      break;
    }
    case 'tier1': {
      const [logfile, elapsed] = args;
      if (!logfile || elapsed === undefined) {
        fail('usage: assert-ci-baselines.mjs tier1 <logfile> <elapsedSeconds>');
      }
      const result = evaluateTier1(readLogSafe(logfile), elapsed, loadBaselines());
      if (!result.ok) fail(`tier1 baseline check FAILED:\n  - ${result.problems.join('\n  - ')}`);
      printNotices(result.notices);
      emitReceipt(result.receipt);
      break;
    }
    case 'authority-typecheck': {
      const [logfile] = args;
      if (!logfile) fail('usage: assert-ci-baselines.mjs authority-typecheck <logfile>');
      const result = evaluateAuthorityTypecheck(readLogSafe(logfile), loadBaselines());
      if (!result.ok) fail(`authority-typecheck baseline check FAILED:\n  - ${result.problems.join('\n  - ')}`);
      printNotices(result.notices);
      emitReceipt(result.receipt);
      break;
    }
    case 'receipts': {
      const [receiptfile, ...markers] = args;
      if (!receiptfile || markers.length === 0) {
        fail('usage: assert-ci-baselines.mjs receipts <receiptfile> <marker...>');
      }
      const result = evaluateReceipts(receiptfile, markers);
      if (!result.ok) fail(result.problems.join('\n  - '));
      process.stdout.write(`RECEIPT-CHECK-OK all ${markers.length} marker(s) present\n`);
      break;
    }
    case 'selftest':
      runSelftest();
      break;
    default:
      fail(
        `unknown subcommand: ${cmd ?? '(none)'}\n` +
          'usage: assert-ci-baselines.mjs <vote-engine|tier1|authority-typecheck|receipts|selftest> ...',
      );
  }
}

main();
