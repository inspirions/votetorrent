#!/usr/bin/env bash
# run-reattach-proof.sh — drives reattach-proof.mjs end to end. Originally Phase 51 Plan 05
# Task 3; generalized by 62-03 (D-22) into a scripted re-attach proof usable against ANY
# baseline, not just the hardcoded Phase 51 AttestationChallenge shape.
#
# Sequence:
#   1. Extract the PRE-change schema-sql.ts from git at the baseline ref.
#   2. --seed a fresh on-disk DB under that old schema (real Network/Authority/
#      Registrant/AttestationChallenge ceremony, via the real vote-engine classes). The
#      challenge SHAPE (legacy 7-arg vs current 6-arg) is detected from the baseline
#      schema text itself (reattach-proof.mjs), not hardcoded.
#   3. --reopen the SAME on-disk path under the CURRENT (post-change) schema and
#      assert: no throw, no ALTER COLUMN, rows still readable at the seeded counts
#      (Authority/Registrant/AttestationChallenge/Admin/Officer/UserKey), the
#      Expiration column is genuinely gone, and every table the current schema added
#      since the baseline is queryable (--baseline-schema).
#   4. NEGATIVE CONTROL: repeat --seed/--reopen against a tiny one-table schema
#      exercising a KNOWN Quereus re-attach defect class (boolean-default column
#      type change) and confirm the harness correctly reports it as a FAILURE —
#      a harness that has only ever printed PASS proves nothing.
#
# Usage:
#   bash scripts/run-reattach-proof.sh <baseline-ref>
#
# baseline-ref is REQUIRED — there is no default. (Historical Phase 51 ref: b0de604 —
# named here for context only; it predates every phase-62 table and is not a valid
# baseline for a phase-62 gate.)
#
# Safe to re-run: every invocation uses a fresh mktemp directory.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_ROOT="$(dirname "$SCRIPT_DIR")"
cd "$PACKAGE_ROOT"

if [ $# -lt 1 ]; then
	echo "usage: bash scripts/run-reattach-proof.sh <baseline-ref>" >&2
	echo "  baseline-ref is REQUIRED (no default) — e.g. the D-22 baseline ref recorded" >&2
	echo "  in the current phase's wave-1 schema plan SUMMARY." >&2
	exit 2
fi

BASELINE_REF="$1"
RESOLVED_BASELINE="$(git rev-parse --short "$BASELINE_REF")"

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

# .mjs (not .ts): reattach-proof.mjs dynamic-`import()`s this file directly, and mixing a
# ts-node/esm-transpiled .ts import into a plain Node ESM process trips a require(esm) cycle
# ("Cannot require() ES Module ... in a cycle"). The extracted schema-sql.ts has exactly one
# TS-only construct (the `: string` type annotation) and no imports of its own, so stripping
# that one annotation yields plain, dependency-free ESM — safe to import without any loader.
OLD_SCHEMA_FILE="$WORKDIR/schema-sql.old.mjs"
git show "${RESOLVED_BASELINE}:packages/vote-engine/src/database/schema-sql.ts" \
	| sed 's/^export const VOTETORRENT_SCHEMA_SQL: string = /export const VOTETORRENT_SCHEMA_SQL = /' \
	> "$OLD_SCHEMA_FILE"

DB_PATH="$WORKDIR/reattach-proof-db"
COUNTS_FILE="$WORKDIR/seed-counts.json"

echo "=== scripted re-attach proof (baseline=$RESOLVED_BASELINE) ==="
echo "Baseline ref (pre-change schema): $RESOLVED_BASELINE"
echo "Extracted schema file:            $OLD_SCHEMA_FILE"
echo "On-disk DB path:                  $DB_PATH"
echo

run_node () {
	TS_NODE_PROJECT=./tsconfig.test.json \
		node --import=./register-ts-node.mjs --experimental-specifier-resolution=node \
		scripts/reattach-proof.mjs "$@"
}

echo "--- [1/3] seed: pre-change schema, real ceremony ---"
SEED_OUT="$(run_node --seed "$DB_PATH" --schema "$OLD_SCHEMA_FILE")"
echo "$SEED_OUT"
echo "$SEED_OUT" | node -e '
	let s=""; process.stdin.on("data", d => s += d);
	process.stdin.on("end", () => {
		const parsed = JSON.parse(s);
		process.stdout.write(JSON.stringify(parsed.counts));
	});
' > "$COUNTS_FILE"
echo

echo "--- [2/3] reopen: current (post-change) schema, on the SAME on-disk store ---"
set +e
REOPEN_OUT="$(run_node --reopen "$DB_PATH" --expected-counts "$COUNTS_FILE" --baseline-schema "$OLD_SCHEMA_FILE")"
MAIN_EXIT=$?
set -e
echo "$REOPEN_OUT"
echo

echo "--- [3/3] NEGATIVE CONTROL: a genuinely incompatible schema must FAIL re-attach ---"
# Exit code contract (reattach-proof.mjs --negative-control --reopen):
#   1 = EXPECTED — the incompatible schema was correctly rejected (the harness can fail).
#   3 = MALFUNCTION — the harness did NOT detect a genuinely incompatible schema.
#   0 = never valid for this mode.
NEG_DB_PATH="$WORKDIR/reattach-proof-negative-db"
run_node --seed "$NEG_DB_PATH" --negative-control
set +e
NEG_OUT="$(run_node --reopen "$NEG_DB_PATH" --negative-control)"
NEG_EXIT=$?
set -e
echo "$NEG_OUT"
echo

if [ "$MAIN_EXIT" -eq 0 ] && [ "$NEG_EXIT" -eq 1 ]; then
	# WR-11 (51-REVIEW): the verdict names what WAS and what was NOT established.
	# "PASS" alone was read downstream as "the D-10 schema change was PROVEN safe on a real
	# on-disk store". It was not. What is established is narrower, and the negative control is
	# narrower still: every genuinely STRUCTURAL incompatibility probed against this pinned
	# Quereus (PK column type change, adding a NOT NULL column with no default to a populated
	# table, boolean -> text) reconciled SILENTLY, so the control had to fall back to a
	# syntactically invalid DDL string. That proves the harness can report a PARSE failure. It
	# does NOT prove the harness can detect a RECONCILE incompatibility — the only class D-10's
	# column removal could plausibly hit.
	echo "FINAL VERDICT: NO-REGRESSION (baseline=$RESOLVED_BASELINE db=$DB_PATH schema=$OLD_SCHEMA_FILE)"
	echo "  ESTABLISHED: re-attach did not throw; the pre-existing rows (Authority/Registrant/AttestationChallenge/Admin/Officer/UserKey, plus RegistrationDecision/AssociationDecision when the baseline declares them) are still readable at the exact seeded counts; no 'ALTER COLUMN' appeared in any error; the legacy non-conforming decision rows (astral cursors, legal under the old length-only check) re-attached under the new CursorWellFormed check and read back byte-identical; the Expiration column is absent; every table the current schema added since the baseline is queryable and empty (new-table queryability, --baseline-schema)."
	echo "  NOT ESTABLISHED: that a SILENT reconcile incompatibility would have been detected. The negative control (exit=1, as required) exercises only the PARSE-failure path."
	exit 0
else
	echo "FINAL VERDICT: FAIL (baseline=$RESOLVED_BASELINE db=$DB_PATH schema=$OLD_SCHEMA_FILE; main_exit=$MAIN_EXIT neg_exit=$NEG_EXIT — neg_exit must be exactly 1)"
	exit 1
fi
