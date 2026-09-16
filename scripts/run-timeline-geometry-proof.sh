#!/usr/bin/env bash
#
# run-timeline-geometry-proof.sh
#
# Purpose : Phase 61 D-02 Tier-2 on-device geometry proof for the Voter app's election
#           timeline. Measures REAL rendered pixel geometry pulled from a `uiautomator`
#           view-tree dump -- a class of defect (clipped text, duplicate action labels,
#           undersized touch targets) that no Jest `onLayout`-based assertion can see,
#           because `react-test-renderer` never runs a Yoga layout pass. Every rendering
#           claim in this phase has to cite a Tier-2 result, and this script is the
#           Tier-2 surface (D-02).
#
# Usage   : SERIAL=43a209ff0806 LOCALE=en ./scripts/run-timeline-geometry-proof.sh <leg>
#           <leg> one of: clipping | duplicates | touch-targets | all
#           --selftest              host-only, no device required: proves the parser
#                                    against four committed fixtures under
#                                    scripts/lib/__fixtures__/timeline-geometry/
#           --dump-records <xml>    host-only, no device required: prints the normalized
#                                    CARD/TEXT/CLICK/ORPHAN record stream for one XML file
#                                    and exits (debugging surface / --selftest internals)
#
# Prereqs : adb on PATH for the device legs (clipping|duplicates|touch-targets|all) --
#           NOT required for --selftest or --dump-records, which read only committed
#           fixtures / a given file. A booted, USB-debug-enabled device running the
#           debug build of org.votetorrent.voter is required for the device legs.
#
# Exit    : 0 -- every selected leg printed LEG <name>: PASS (or --selftest /
#               --dump-records completed successfully)
#           1 -- a preflight failed, any selected leg printed LEG <name>: FAIL, or
#               --selftest / --dump-records failed
#
# Note    : this script emits no ANSI colour codes in its own output. A future CI-style
#           consumer piping `LEG ` lines through a line-anchored parser must not assume a
#           colour-stripping step exists upstream -- this project has hit the
#           FORCE_COLOR=3 trap before on OTHER scripts' jest/tsc output (agent shells set
#           it, defeating naive `^...$` parsers); this script simply never emits ANSI in
#           the first place, so there is nothing to strip.
#
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

PACKAGE="org.votetorrent.voter"
SERIAL="${SERIAL:-43a209ff0806}"   # D-05: the Redmi 8 this phase's device legs are bound to.
ADBD="-s ${SERIAL}"
LOCALE="${LOCALE:-en}"
FIXTURES_DIR="scripts/lib/__fixtures__/timeline-geometry"

# ROW_DISPLAY's ten stage ids (apps/VoteTorrentVoter/src/components/TimelineRow.tsx:48-59),
# in the same order. The preflight must positively locate a card anchor for every one.
EXPECTED_STAGES=(registrationEnds ballotsFinal votingStarts accruingVotes hashingVotes releasingKeys tallyingStarts validation certificationStarts closed)

# D-06: env overrides read from the device when unset; --selftest sets these explicitly so
# fixtures are density- and viewport-deterministic. Declared empty up front so `set -u`
# never trips on a reference before resolve_device_metrics()/--selftest assigns them.
DENSITY_DPI="${DENSITY_DPI:-}"
SCREEN_W="${SCREEN_W:-}"
SCREEN_H="${SCREEN_H:-}"

# D-05: set by preflight() when SERIAL is not the mandated device -- appended to every
# leg's evidence field so a substitution is never silently lost from the transcript.
SERIAL_NOTE=""

TMPDIR_TG="$(mktemp -d)"
cleanup() { rm -rf "${TMPDIR_TG}"; }
trap cleanup EXIT

TAB="$(printf '\t')"

# ---------------------------------------------------------------------------------------
# House-style verdict emitter + failure tracker, lifted verbatim from
# run-authority-signing-ceremony.sh:112-125 -- the exact three-field shape every
# downstream grep in this repo (incl. 61-07) expects.
# ---------------------------------------------------------------------------------------
RESULTS=()
record_leg() {
  local name="$1" verdict="$2" evidence="$3"
  RESULTS+=("${name}|${verdict}|${evidence}")
  echo "LEG ${name}: ${verdict} (${evidence})"
}

any_failed() {
  local r
  for r in "${RESULTS[@]}"; do
    [[ "${r}" == *"|FAIL|"* ]] && return 0
  done
  return 1
}

# ---------------------------------------------------------------------------------------
# _find_nondegenerate_bounds ATTR LABEL DUMP_FILE -- case-insensitive substring match
# against the given XML attribute (`text` or `content-desc`), returning the FIRST bounds
# value among all matching nodes that is NOT the degenerate "[0,0][0,0]" sentinel.
#
# Lifted verbatim from run-authority-signing-ceremony.sh:416-450, comment included, per
# this plan's Task 1 -- this is a documented, hard-won bug fix (49-13 Task 2 / commit
# 6f1aff2's bug class), not stylistic preference. Do NOT "clean up" this regex.
#
# Bracket-expression note (real bug, found and fixed during 49-13 Task 2):
# POSIX bracket expressions (`[...]`) do NOT support backslash-escaping -- `\[`/`\]`
# INSIDE a `[...]` class are literal backslash-then-bracket, not an escaped bracket.
# The earlier, broken bracket ordering (escaped brackets placed immediately after the
# comma, inside the class) under BSD/POSIX grep (the actual interpreter this script runs
# under, confirmed via `grep --version` -> "BSD grep, GNU compatible" -- NOT the same
# grep some interactive dev shells alias) therefore closes the class early at the first
# literal `]` and silently fails to match every real `bounds="[x1,y1][x2,y2]"` value,
# making every match fail 100% of the time despite the target text being genuinely
# present (observed: 12/12 identical false failures against a real, static,
# already-rendered dump -- not a timing issue). `[][0-9,]` is the POSIX-safe form:
# placing `]` immediately after the opening `[` makes it a literal member of the class
# instead of closing it.
# ---------------------------------------------------------------------------------------
_find_nondegenerate_bounds() {
  local attr="$1" label="$2" dump="$3"
  local candidates b
  # 49-14 pipefail note (same bug class as commit 6f1aff2): under this script's
  # `set -euo pipefail`, an EMPTY match at either grep stage makes the whole pipeline
  # exit non-zero (pipefail propagates ANY stage's failure, not only the trailing
  # command's) even though `sed` itself would happily process zero lines -- guard with
  # `|| true` so "no match" degrades to an empty `candidates`, handled below, instead
  # of aborting the script.
  candidates=$(grep -io "${attr}=\"[^\"]*${label}[^\"]*\"[^>]*bounds=\"[][0-9,]*\"" "${dump}" \
    | grep -o 'bounds="[][0-9,]*"' | sed 's/bounds="//;s/"//' || true)
  while IFS= read -r b; do
    [ -z "${b}" ] && continue
    if [ "${b}" != "[0,0][0,0]" ]; then
      printf '%s\n' "${b}"
      return 0
    fi
  done <<< "${candidates}"
  return 1
}

# ---------------------------------------------------------------------------------------
# _parse_bounds BOUNDS-STRING -- the bash-level companion to _find_nondegenerate_bounds:
# that function only answers "does a non-degenerate bounds exist"; the clipping/
# touch-target math needs all four numbers. Echoes "x1 y1 x2 y2" space-separated on
# success; returns non-zero on an unparseable value. The record-stream parser itself
# (walk_dump, below) uses an awk-native equivalent for whole-file throughput; this
# bash-level primitive is provided for any bash-side (non-awk) consumer of a single
# bounds string.
# ---------------------------------------------------------------------------------------
_parse_bounds() {
  local bounds="$1"
  local parsed
  parsed=$(printf '%s' "${bounds}" | sed -n 's/^\[\([0-9]*\),\([0-9]*\)\]\[\([0-9]*\),\([0-9]*\)\]$/\1 \2 \3 \4/p')
  [ -z "${parsed}" ] && return 1
  printf '%s\n' "${parsed}"
}

# ---------------------------------------------------------------------------------------
# The awk program driving walk_dump(). Written once to a tmp file at startup rather than
# inlined per-call. Consumes a normalized (one-node-per-line) uiautomator XML dump and
# emits the CARD/TEXT/CLICK/ORPHAN record stream defined in the plan's interface_contract.
# See the design_notes in 61-03-PLAN.md items 1 and 6 for the card/notch resolution and
# MIUI content-desc fallback this implements.
# ---------------------------------------------------------------------------------------
AWK_WALK_SCRIPT="${TMPDIR_TG}/walk_dump.awk"
cat > "${AWK_WALK_SCRIPT}" <<'AWK_PROGRAM'
function attrval(line, name,    re, s, val) {
  re = " " name "=\"[^\"]*\""
  if (!match(line, re)) return ""
  s = substr(line, RSTART + 1, RLENGTH - 1)
  val = substr(s, length(name) + 3, length(s) - length(name) - 3)
  return val
}

function parse_bounds(b, arr,    s, n) {
  if (b !~ /^\[[0-9]+,[0-9]+\]\[[0-9]+,[0-9]+\]$/) return 0
  s = b
  gsub(/\[/, " ", s)
  gsub(/\]/, " ", s)
  gsub(/,/, " ", s)
  n = split(s, arr, " ")
  return (n == 4)
}

function xml_unescape(s) {
  gsub(/&quot;/, "\"", s)
  gsub(/&apos;/, "'", s)
  gsub(/&lt;/, "<", s)
  gsub(/&gt;/, ">", s)
  gsub(/&#10;/, "\n", s)
  gsub(/&amp;/, "\\&", s)
  return s
}

BEGIN {
  n_stages = split(stage_list, stages_arr, " ")
  for (i = 1; i <= n_stages; i++) stage_set[stages_arr[i]] = 1
  depth = 0
  card_stage = ""
  card_depth = -1
}

/^[ \t]*<\?/ { next }
/^[ \t]*<!--/ { next }

/^[ \t]*<\// {
  depth--
  if (card_stage != "" && depth <= card_depth) {
    card_stage = ""
    card_depth = -1
  }
  next
}

/^[ \t]*</ {
  line = $0
  is_leaf = (line ~ /\/>[ \t]*$/) ? 1 : 0
  cur_depth = depth

  resid = attrval(line, "resource-id")
  cdesc = attrval(line, "content-desc")
  txt = attrval(line, "text")
  bounds = attrval(line, "bounds")
  clickable = attrval(line, "clickable")

  bounds_at_depth[cur_depth] = bounds
  desc_at_depth[cur_depth] = cdesc

  anchor_id = (resid != "") ? resid : cdesc

  if (anchor_id != "" && index(anchor_id, "timeline-row-") > 0) {
    pos = index(anchor_id, "timeline-row-")
    rest = substr(anchor_id, pos + length("timeline-row-"))
    role_n = split(rest, role_parts, "-")
    role = role_parts[1]
    cand_stage = role_parts[role_n]

    if (role == "notch" && (cand_stage in stage_set)) {
      parent_depth = cur_depth - 1
      if (parse_bounds(bounds_at_depth[parent_depth], cb)) {
        printf "CARD\t%s\t%s\t%s\t%s\t%s\n", cand_stage, cb[1], cb[2], cb[3], cb[4]
      } else {
        printf "CARD\t%s\t0\t0\t0\t0\n", cand_stage
      }
      card_stage = cand_stage
      card_depth = parent_depth
    } else if (role != "notch" && (cand_stage in stage_set)) {
      inside_own_card = (card_stage == cand_stage && cur_depth > card_depth)
      if (!inside_own_card && !(cand_stage in orphan_emitted)) {
        printf "ORPHAN\t%s\n", cand_stage
        orphan_emitted[cand_stage] = 1
      }
    }
  }

  if (card_stage != "" && cur_depth > card_depth) {
    if (parse_bounds(bounds, ownb)) {
      ox1 = ownb[1]; oy1 = ownb[2]; ox2 = ownb[3]; oy2 = ownb[4]
      own_parsed = 1
    } else {
      ox1 = 0; oy1 = 0; ox2 = 0; oy2 = 0
      own_parsed = 0
    }

    if (txt != "") {
      source = "text"
      tx1 = ox1; ty1 = oy1; tx2 = ox2; ty2 = oy2
      is_degenerate = (bounds == "[0,0][0,0]" || !own_parsed)
      if (is_degenerate) {
        found = 0
        for (d = cur_depth - 1; d > card_depth; d--) {
          if (desc_at_depth[d] == txt && bounds_at_depth[d] != "" && bounds_at_depth[d] != "[0,0][0,0]") {
            if (parse_bounds(bounds_at_depth[d], fb)) {
              tx1 = fb[1]; ty1 = fb[2]; tx2 = fb[3]; ty2 = fb[4]
              source = "content-desc-fallback"
              found = 1
              break
            }
          }
        }
        if (!found) {
          source = "degenerate"
          tx1 = 0; ty1 = 0; tx2 = 0; ty2 = 0
        }
      }
      clk = (clickable == "true") ? "yes" : "no"
      utext = xml_unescape(txt)
      printf "TEXT\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n", card_stage, tx1, ty1, tx2, ty2, source, clk, utext
    }

    if (clickable == "true") {
      printf "CLICK\t%s\t%s\t%s\t%s\t%s\t%s\n", card_stage, ox1, oy1, ox2, oy2, resid
    }
  }

  if (!is_leaf) depth++
  next
}
AWK_PROGRAM

# walk_dump XML-PATH -- normalizes the dump to one XML element per line and runs it
# through AWK_WALK_SCRIPT, printing the CARD/TEXT/CLICK/ORPHAN stream on stdout.
walk_dump() {
  local xml="$1"
  if [ ! -f "${xml}" ]; then
    echo "walk_dump: no such file: ${xml}" >&2
    return 1
  fi
  local normalized="${TMPDIR_TG}/normalized-$$-${RANDOM}.xml"
  sed 's/></>\n</g' "${xml}" > "${normalized}"
  awk -v stage_list="${EXPECTED_STAGES[*]}" -f "${AWK_WALK_SCRIPT}" "${normalized}"
}

# ---------------------------------------------------------------------------------------
# Host-only --dump-records dispatch (D-02 debugging surface / --selftest internals).
# Leg execution (--selftest, clipping|duplicates|touch-targets|all) lands in later tasks
# of this plan (Task 2: legs + --selftest; Task 3: preflight + device dispatch).
# ---------------------------------------------------------------------------------------
if [ "${1:-}" = "--dump-records" ]; then
  DUMP_PATH="${2:-}"
  if [ -z "${DUMP_PATH}" ]; then
    echo "Usage: $0 --dump-records <xml-path>" >&2
    exit 1
  fi
  if [ ! -f "${DUMP_PATH}" ]; then
    echo "--dump-records: no such file: ${DUMP_PATH}" >&2
    exit 1
  fi
  walk_dump "${DUMP_PATH}"
  exit 0
fi

echo "run-timeline-geometry-proof.sh: only --dump-records is wired up so far; --selftest and the device legs land in later tasks of this plan (61-03)." >&2
exit 1
