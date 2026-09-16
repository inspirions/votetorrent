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
# The three measuring legs (D-03). Each consumes a records FILE (the accumulated
# walk_dump stream), never re-derives geometry itself, and returns its result as a single
# "VERDICT<TAB>EVIDENCE" line on stdout for run_leg() to record. Every evidence string
# ends with " locale=${LOCALE} serial=${SERIAL}" (+ " serial_note=substituted" if D-05
# fired) so the locale and any device substitution are visible in every leg's evidence.
# ---------------------------------------------------------------------------------------

leg_clipping() {
  local records_file="$1"
  awk -v FS="${TAB}" -v locale="${LOCALE}" -v serial="${SERIAL}" -v serial_note="${SERIAL_NOTE}" '
    $1=="CARD" { card_x2[$2] = $5 }
    $1=="ORPHAN" { orphan_list = (orphan_list=="") ? $2 : orphan_list","$2 }
    $1=="TEXT" {
      count_text++
      stage=$2; x2=$5; source=$7; text=$9
      if (source=="degenerate" && deg_stage=="") { deg_stage=stage; deg_text=text }
      if (clip_stage=="" && (stage in card_x2) && x2+0 > card_x2[stage]+0) {
        clip_stage=stage; clip_text=text; clip_tx2=x2; clip_cx2=card_x2[stage]
      }
    }
    END {
      note = (serial_note=="substituted") ? " serial_note=substituted" : ""
      if (orphan_list != "") {
        printf "FAIL\tanchor-missing: %s locale=%s serial=%s%s\n", orphan_list, locale, serial, note
      } else if (deg_stage != "") {
        printf "FAIL\tdegenerate-bounds: stage=%s text=\"%s\" locale=%s serial=%s%s\n", deg_stage, deg_text, locale, serial, note
      } else if (clip_stage != "") {
        printf "FAIL\tclipped-text: stage=%s text=\"%s\" text.x2=%s card.x2=%s locale=%s serial=%s%s\n", clip_stage, clip_text, clip_tx2, clip_cx2, locale, serial, note
      } else {
        printf "PASS\tclean: %d text node(s) measured locale=%s serial=%s%s\n", count_text, locale, serial, note
      }
    }
  ' "${records_file}"
}

leg_duplicates() {
  local records_file="$1"
  awk -v FS="${TAB}" -v locale="${LOCALE}" -v serial="${SERIAL}" -v serial_note="${SERIAL_NOTE}" '
    $1=="ORPHAN" { orphan_list = (orphan_list=="") ? $2 : orphan_list","$2 }
    $1=="TEXT" {
      n++; t_stage[n]=$2; t_x1[n]=$3; t_y1[n]=$4; t_x2[n]=$5; t_y2[n]=$6; t_source[n]=$7; t_click[n]=$8; t_text[n]=$9
      if ($7=="degenerate" && deg_stage=="") { deg_stage=$2; deg_text=$9 }
    }
    $1=="CLICK" {
      m++; c_stage[m]=$2; c_x1[m]=$3; c_y1[m]=$4; c_x2[m]=$5; c_y2[m]=$6
    }
    END {
      note = (serial_note=="substituted") ? " serial_note=substituted" : ""
      if (orphan_list != "") {
        printf "FAIL\tanchor-missing: %s locale=%s serial=%s%s\n", orphan_list, locale, serial, note
        exit
      }
      if (deg_stage != "") {
        printf "FAIL\tdegenerate-bounds: stage=%s text=\"%s\" locale=%s serial=%s%s\n", deg_stage, deg_text, locale, serial, note
        exit
      }
      for (i = 1; i <= n; i++) {
        eligible = (t_click[i] == "yes")
        if (!eligible) {
          for (j = 1; j <= m; j++) {
            if (c_stage[j] == t_stage[i] && t_x1[i]+0 >= c_x1[j]+0 && t_y1[i]+0 >= c_y1[j]+0 && t_x2[i]+0 <= c_x2[j]+0 && t_y2[i]+0 <= c_y2[j]+0) {
              eligible = 1
              break
            }
          }
        }
        if (!eligible) continue
        key = t_stage[i] SUBSEP t_text[i]
        seen_count[key]++
        seen_stage[key] = t_stage[i]
        seen_text[key] = t_text[i]
      }
      for (key in seen_count) {
        if (seen_count[key] > 1 && dup_stage == "") { dup_stage = seen_stage[key]; dup_text = seen_text[key] }
      }
      if (dup_stage != "") {
        printf "FAIL\tduplicate-label: stage=%s text=\"%s\" locale=%s serial=%s%s\n", dup_stage, dup_text, locale, serial, note
      } else {
        printf "PASS\tno duplicate action labels locale=%s serial=%s%s\n", locale, serial, note
      }
    }
  ' "${records_file}"
}

leg_touch_targets() {
  local records_file="$1"
  local threshold_px=$((44 * DENSITY_DPI / 160))
  awk -v FS="${TAB}" -v locale="${LOCALE}" -v serial="${SERIAL}" -v serial_note="${SERIAL_NOTE}" -v thr="${threshold_px}" -v density="${DENSITY_DPI}" '
    $1=="ORPHAN" { orphan_list = (orphan_list=="") ? $2 : orphan_list","$2 }
    $1=="TEXT" && $7=="degenerate" && deg_stage=="" { deg_stage=$2; deg_text=$9 }
    $1=="CLICK" {
      count++
      stage=$2; x1=$3; y1=$4; x2=$5; y2=$6; rid=$7
      w = x2 - x1; h = y2 - y1
      if ((w < thr || h < thr) && bad_stage == "") { bad_stage=stage; bad_rid=rid; bad_w=w; bad_h=h }
    }
    END {
      note = (serial_note=="substituted") ? " serial_note=substituted" : ""
      if (orphan_list != "") {
        printf "FAIL\tanchor-missing: %s locale=%s serial=%s%s\n", orphan_list, locale, serial, note
        exit
      }
      if (deg_stage != "") {
        printf "FAIL\tdegenerate-bounds: stage=%s text=\"%s\" locale=%s serial=%s%s\n", deg_stage, deg_text, locale, serial, note
        exit
      }
      if (bad_stage != "") {
        printf "FAIL\tundersized-target: stage=%s resource-id=%s measured=%dx%dpx threshold=%dpx(44dp@%ddpi) locale=%s serial=%s%s\n", bad_stage, bad_rid, bad_w, bad_h, thr, density, locale, serial, note
      } else {
        printf "PASS\t%d touch target(s) measured, all >= %dpx (44dp@%ddpi) locale=%s serial=%s%s\n", count+0, thr, density, locale, serial, note
      }
    }
  ' "${records_file}"
}

# run_leg NAME RECORDS-FILE -- dispatches to the named leg function, records the result
# via record_leg() (prints "LEG name: VERDICT (evidence)"), and exposes LAST_VERDICT /
# LAST_EVIDENCE for callers (run_selftest) that need to inspect the outcome.
LAST_VERDICT=""
LAST_EVIDENCE=""
run_leg() {
  local name="$1" records_file="$2"
  local out
  case "${name}" in
    clipping) out=$(leg_clipping "${records_file}") ;;
    duplicates) out=$(leg_duplicates "${records_file}") ;;
    touch-targets) out=$(leg_touch_targets "${records_file}") ;;
    *)
      echo "run_leg: unknown leg '${name}'" >&2
      return 1
      ;;
  esac
  LAST_VERDICT="${out%%${TAB}*}"
  LAST_EVIDENCE="${out#*${TAB}}"
  record_leg "${name}" "${LAST_VERDICT}" "${LAST_EVIDENCE}"
}

# ---------------------------------------------------------------------------------------
# run_selftest -- D-04(3). Host-only, no device. Sets DENSITY_DPI/SCREEN_W/SCREEN_H so the
# four committed fixtures are deterministic, runs all three legs against each, and asserts
# each rejection fixture is rejected FOR ITS OWN NAMED REASON (and that the other two
# reasons are NOT named), plus leg isolation (a single-defect fixture trips exactly one
# leg). Adapted from assert-voter-gates.mjs's --selftest idiom (lines 503-653), not ported.
# ---------------------------------------------------------------------------------------
run_selftest() {
  echo "[timeline-geometry] ========== --selftest =========="
  DENSITY_DPI=320
  SCREEN_W=720
  SCREEN_H=1520

  local mismatches=0
  local f
  for f in clean clipped degenerate missing-node; do
    local xml="${FIXTURES_DIR}/${f}.xml"
    if [ ! -f "${xml}" ]; then
      echo "SELFTEST MISMATCH: ${f} -- fixture file missing: ${xml}"
      mismatches=$((mismatches + 1))
      continue
    fi

    local records="${TMPDIR_TG}/selftest-${f}.records"
    if ! walk_dump "${xml}" > "${records}" 2>"${TMPDIR_TG}/selftest-${f}.err"; then
      echo "SELFTEST MISMATCH: ${f} -- walk_dump failed: $(cat "${TMPDIR_TG}/selftest-${f}.err")"
      mismatches=$((mismatches + 1))
      continue
    fi

    echo "[timeline-geometry] -- fixture: ${f} --"
    run_leg "clipping" "${records}"
    local clip_verdict="${LAST_VERDICT}" clip_evidence="${LAST_EVIDENCE}"
    run_leg "duplicates" "${records}"
    local dup_verdict="${LAST_VERDICT}" dup_evidence="${LAST_EVIDENCE}"
    run_leg "touch-targets" "${records}"
    local tt_verdict="${LAST_VERDICT}" tt_evidence="${LAST_EVIDENCE}"

    local ok=1
    case "${f}" in
      clean)
        if [ "${clip_verdict}" != "PASS" ]; then
          echo "SELFTEST MISMATCH: clean -- expected clipping PASS, got ${clip_verdict} (${clip_evidence})"
          ok=0
        fi
        if [ "${dup_verdict}" != "PASS" ]; then
          echo "SELFTEST MISMATCH: clean -- expected duplicates PASS, got ${dup_verdict} (${dup_evidence})"
          ok=0
        fi
        if [ "${tt_verdict}" != "PASS" ]; then
          echo "SELFTEST MISMATCH: clean -- expected touch-targets PASS, got ${tt_verdict} (${tt_evidence})"
          ok=0
        fi
        ;;
      clipped)
        if [ "${clip_verdict}" != "FAIL" ] || [[ "${clip_evidence}" != *"clipped-text"* ]]; then
          echo "SELFTEST MISMATCH: clipped -- expected clipping FAIL naming clipped-text, got ${clip_verdict} (${clip_evidence})"
          ok=0
        fi
        if [[ "${clip_evidence}" == *"degenerate-bounds"* || "${clip_evidence}" == *"anchor-missing"* ]]; then
          echo "SELFTEST MISMATCH: clipped -- clipping evidence named a reason other than its own: ${clip_evidence}"
          ok=0
        fi
        if [ "${dup_verdict}" != "PASS" ]; then
          echo "SELFTEST MISMATCH: clipped -- expected duplicates PASS (leg isolation), got ${dup_verdict} (${dup_evidence})"
          ok=0
        fi
        if [ "${tt_verdict}" != "PASS" ]; then
          echo "SELFTEST MISMATCH: clipped -- expected touch-targets PASS (leg isolation), got ${tt_verdict} (${tt_evidence})"
          ok=0
        fi
        ;;
      degenerate)
        if [ "${clip_verdict}" != "FAIL" ] || [[ "${clip_evidence}" != *"degenerate-bounds"* ]]; then
          echo "SELFTEST MISMATCH: degenerate -- expected clipping FAIL naming degenerate-bounds, got ${clip_verdict} (${clip_evidence})"
          ok=0
        fi
        if [[ "${clip_evidence}" == *"clipped-text"* || "${clip_evidence}" == *"anchor-missing"* ]]; then
          echo "SELFTEST MISMATCH: degenerate -- clipping evidence named a reason other than its own: ${clip_evidence}"
          ok=0
        fi
        ;;
      missing-node)
        if [ "${clip_verdict}" != "FAIL" ] || [[ "${clip_evidence}" != *"anchor-missing"* ]]; then
          echo "SELFTEST MISMATCH: missing-node -- expected clipping FAIL naming anchor-missing, got ${clip_verdict} (${clip_evidence})"
          ok=0
        fi
        if [[ "${clip_evidence}" == *"clipped-text"* || "${clip_evidence}" == *"degenerate-bounds"* ]]; then
          echo "SELFTEST MISMATCH: missing-node -- clipping evidence named a reason other than its own: ${clip_evidence}"
          ok=0
        fi
        ;;
    esac

    [ "${ok}" -eq 0 ] && mismatches=$((mismatches + 1))
  done

  if [ "${mismatches}" -eq 0 ]; then
    echo "SELFTEST: PASS (4/4 fixtures behaved as specified)"
    exit 0
  else
    echo "SELFTEST: FAIL ($((4 - mismatches))/4 fixtures behaved as specified)"
    exit 1
  fi
}

# ---------------------------------------------------------------------------------------
# Early, device-free dispatch (design_notes item 8): --selftest and --dump-records must be
# recognized BEFORE leg-name validation and BEFORE preflight() -- both read only committed
# fixtures / a given file and must work with no device attached at all.
# ---------------------------------------------------------------------------------------
for _arg in "$@"; do
  if [ "${_arg}" = "--selftest" ]; then
    run_selftest
  fi
done

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

# ---------------------------------------------------------------------------------------
# Leg dispatch, preflight and device-facing collection land in Task 3 of this plan.
# For now: --selftest and --dump-records are wired; anything else errors loudly.
# ---------------------------------------------------------------------------------------
echo "run-timeline-geometry-proof.sh: preflight()/device legs are not wired up yet; this task adds --selftest only (Task 3 of 61-03 adds device execution)." >&2
exit 1
