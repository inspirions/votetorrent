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
# fix(61-03): preserve the real exit code across cleanup -- a bare `rm -rf` here used to
# become the script's final exit status (rm succeeds, so ANY fatal abort earlier in the
# script -- e.g. a `set -u` trip -- silently reported exit 0). The obvious fix
# (`cleanup(){ local rc=$?; rm -rf ...; exit "$rc"; }`) was tried first and empirically
# does NOT work on this repo's bash (3.2, macOS stock): verified live that `$?` as read
# from *inside* an EXIT trap is already 0 by the time the trap body runs when the trap was
# entered via a `set -u` unbound-variable abort specifically (as opposed to an explicit
# `exit N` call, which correctly threads through even without this fix) -- there is no
#"real" nonzero status left to capture at that point on this bash version. Used a
# fail-closed flag instead: default SCRIPT_EXIT_CODE to 1 (failure) up front, and only the
# three genuinely-successful exit points in this file (the two host-only --selftest /
# --dump-records completions and the final all-legs-passed line) flip it to 0 immediately
# before exiting. Any OTHER termination path -- including one this file's author never
# anticipated -- now exits nonzero by construction, which is the correct default for an
# instrument whose whole job is to report failure honestly.
# Found and authorized-fixed under 61-07 (see todos/pending/2026-09-16-timeline-geometry-
# proof-dump-ui-status-unbound-and-exit-masked.md); disclosed separately, not folded into
# 61-07's evidence.
SCRIPT_EXIT_CODE=1
cleanup() { rm -rf "${TMPDIR_TG}"; exit "${SCRIPT_EXIT_CODE}"; }
trap cleanup EXIT

# fix(61-03): DUMP_UI_STATUS ("unobservable" | "ok") is set by dump_ui() below, but every
# call site invokes it as `dump_path=$(dump_ui)` -- a command substitution, i.e. a
# SUBSHELL. Any assignment dump_ui() makes to a plain variable is local to that subshell
# and is discarded the instant the subshell exits; it never reaches the caller's scope.
# Declaring it here does not fix that (each call site must re-read the status explicitly,
# see dump_ui()'s trailing comment and its two call sites), but it does mean an accidental
# early reference fails predictably instead of crashing the whole script under `set -u`.
DUMP_UI_STATUS=""

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

# WR-06 -- FAIL-CLOSED. A leg counts as passing only if its verdict is EXACTLY "PASS".
# Anything else fails the run: "FAIL", "ERROR", an unrecognised token, or an EMPTY verdict
# (what a leg whose awk silently matched nothing produces). The previous form tested for the
# literal "|FAIL|" substring, so every one of those cases exited 0 -- a harness that cannot
# report the failure of its own instrument. An empty RESULTS set (no leg ran at all) is also
# a failure, never a silent success.
any_failed() {
  local r name verdict rest
  if [ "${#RESULTS[@]}" -eq 0 ]; then
    echo "LEG (none): ERROR (no leg produced a verdict -- refusing to report success)" >&2
    return 0
  fi
  for r in "${RESULTS[@]}"; do
    IFS='|' read -r name verdict rest <<< "${r}"
    if [ "${verdict}" != "PASS" ]; then
      return 0
    fi
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
# dump_ui -- lifted verbatim from run-authority-signing-ceremony.sh:377-414 (renamed
# TMPDIR_CEREMONY -> TMPDIR_TG). The three-attempt retry loop, the well-formedness check,
# and DUMP_UI_STATUS ("unobservable" | "ok") are D-04(1)'s primitive: an unobservable
# dump is a DIFFERENT failure from an observed [0,0][0,0] node and the two must never be
# conflated.
# ---------------------------------------------------------------------------------------
dump_ui() {
  local out="${TMPDIR_TG}/dump-$$-${RANDOM}.xml"
  local attempt
  local status="unobservable"
  for attempt in 1 2 3; do
    adb ${ADBD} shell rm -f /sdcard/window_dump.xml >/dev/null 2>&1
    adb ${ADBD} shell uiautomator dump /sdcard/window_dump.xml >/dev/null 2>&1
    adb ${ADBD} pull /sdcard/window_dump.xml "${out}" >/dev/null 2>&1 || : > "${out}"
    if [ -s "${out}" ] && grep -q "</hierarchy>" "${out}" 2>/dev/null; then
      status="ok"
      break
    fi
    sleep 1
  done
  # fix(61-03): dump_ui() is always invoked via `dump_path=$(dump_ui)` (a subshell), so a
  # plain `DUMP_UI_STATUS=...` assignment here can never be observed by the caller -- write
  # the status to a file in TMPDIR_TG instead; every call site reads it back explicitly
  # immediately after the substitution (see preflight() and collect_records()).
  echo "${status}" > "${TMPDIR_TG}/dump_ui_status"
  if [ "${status}" = "unobservable" ]; then
    echo "[timeline-geometry] WARNING: dump_ui could not obtain a well-formed uiautomator hierarchy after 3 attempts." >&2
  fi
  echo "${out}"
}

# resolve_device_metrics -- reads DENSITY_DPI / SCREEN_W / SCREEN_H from the device,
# preferring an Override value over the Physical one, honoring any already-set env value
# so --selftest and manual re-analysis stay deterministic (D-06 / design_notes item 4).
resolve_device_metrics() {
  if [ -z "${DENSITY_DPI}" ]; then
    local density_out
    density_out=$(adb ${ADBD} shell wm density 2>/dev/null || true)
    DENSITY_DPI=$(printf '%s\n' "${density_out}" | grep -i "Override density:" | grep -o '[0-9]\+' | tail -1 || true)
    if [ -z "${DENSITY_DPI}" ]; then
      DENSITY_DPI=$(printf '%s\n' "${density_out}" | grep -i "Physical density:" | grep -o '[0-9]\+' | tail -1 || true)
    fi
    if [ -z "${DENSITY_DPI}" ]; then
      echo "PREFLIGHT FAIL: could not parse a density value from 'adb ${ADBD} shell wm density' (got: ${density_out})" >&2
      exit 1
    fi
  fi
  if [ -z "${SCREEN_W}" ] || [ -z "${SCREEN_H}" ]; then
    local size_out line wxh
    size_out=$(adb ${ADBD} shell wm size 2>/dev/null || true)
    line=$(printf '%s\n' "${size_out}" | grep -i "Override size:" | tail -1 || true)
    if [ -z "${line}" ]; then
      line=$(printf '%s\n' "${size_out}" | grep -i "Physical size:" | tail -1 || true)
    fi
    wxh=$(printf '%s' "${line}" | grep -o '[0-9]\+x[0-9]\+' || true)
    if [ -z "${wxh}" ]; then
      echo "PREFLIGHT FAIL: could not parse a screen size from 'adb ${ADBD} shell wm size' (got: ${size_out})" >&2
      exit 1
    fi
    SCREEN_W="${wxh%x*}"
    SCREEN_H="${wxh#*x}"
  fi
}

# ---------------------------------------------------------------------------------------
# preflight -- fails loudly, never proceeds silently (shape from
# run-authority-signing-ceremony.sh:143-150), extended per D-04(1)/D-05/D-06.
#
# Deviation from the plan's narrated step order: the plain LOCALE-format check (originally
# listed as step 4, after the adb device-state check) is run FIRST, before any adb call.
# The plan's own <verification> section requires `LOCALE=fr ... all` to exit 1 naming
# `en`/`es` as a host-verifiable-without-hardware check, which is only possible if this
# check precedes the (necessarily device-dependent) `adb get-state` check -- with no
# device attached, get-state would otherwise fail first and the LOCALE message would
# never be reached. The LOCALE CROSS-CHECK against the live dump (D-06, which does need a
# device) stays in its originally documented position, after device-state/package checks.
# ---------------------------------------------------------------------------------------
preflight() {
  echo "[timeline-geometry] Preflight: LOCALE format ..."
  case "${LOCALE}" in
    en|es) ;;
    *)
      echo "PREFLIGHT FAIL: LOCALE='${LOCALE}' is not accepted -- must be 'en' or 'es'" >&2
      exit 1
      ;;
  esac

  echo "[timeline-geometry] Preflight: adb device state ..."
  local state
  state=$(adb ${ADBD} get-state 2>/dev/null || true)
  if [ "${state}" != "device" ]; then
    echo "PREFLIGHT FAIL: '${SERIAL}' is not in 'device' state (got '${state}') -- is the device connected and authorized? (adb devices)" >&2
    exit 1
  fi

  if [ "${SERIAL}" != "43a209ff0806" ]; then
    echo "PREFLIGHT WARN: SUBSTITUTED DEVICE -- SERIAL=${SERIAL} is not the D-05-mandated Redmi 8 43a209ff0806" >&2
    SERIAL_NOTE="substituted"
  fi

  echo "[timeline-geometry] Preflight: package installed and debuggable ..."
  local pkg_list
  pkg_list=$(adb ${ADBD} shell pm list packages "${PACKAGE}" 2>/dev/null || true)
  if ! printf '%s' "${pkg_list}" | grep -q "${PACKAGE}"; then
    echo "PREFLIGHT FAIL: package ${PACKAGE} is not installed on ${SERIAL}" >&2
    exit 1
  fi
  local debuggable
  debuggable=$(adb ${ADBD} shell dumpsys package "${PACKAGE}" 2>/dev/null | grep -i "flags" | grep -i "DEBUGGABLE" || true)
  if [ -z "${debuggable}" ]; then
    echo "PREFLIGHT FAIL: ${PACKAGE} is not a debuggable build on ${SERIAL} -- a release APK ignores Metro and would measure the wrong tree" >&2
    exit 1
  fi

  echo "[timeline-geometry] Preflight: device metrics ..."
  resolve_device_metrics

  echo "[timeline-geometry] Preflight: locale cross-check ..."
  local dump_path
  dump_path=$(dump_ui)
  # fix(61-03): read the status dump_ui() wrote to TMPDIR_TG -- it cannot be read via a
  # subshell-local DUMP_UI_STATUS assignment (see dump_ui()'s comment).
  DUMP_UI_STATUS="$(cat "${TMPDIR_TG}/dump_ui_status" 2>/dev/null || echo unobservable)"
  if [ "${DUMP_UI_STATUS}" != "ok" ]; then
    echo "PREFLIGHT FAIL: dump-unobservable -- could not obtain a well-formed uiautomator hierarchy for the locale cross-check" >&2
    exit 1
  fi
  local has_en has_es
  has_en=$(grep -c "Voting Period" "${dump_path}" || true)
  has_es=$(grep -c "Período de Votación" "${dump_path}" || true)
  if [ "${LOCALE}" = "en" ] && [ "${has_en}" -eq 0 ]; then
    if [ "${has_es}" -gt 0 ]; then
      echo "PREFLIGHT FAIL: LOCALE=en requested but the dump contains the es marker 'Período de Votación' and not the en marker 'Voting Period' -- the app is rendering es" >&2
    else
      echo "PREFLIGHT FAIL: LOCALE=en requested but neither the en marker 'Voting Period' nor the es marker 'Período de Votación' was found in the dump" >&2
    fi
    exit 1
  fi
  if [ "${LOCALE}" = "es" ] && [ "${has_es}" -eq 0 ]; then
    if [ "${has_en}" -gt 0 ]; then
      echo "PREFLIGHT FAIL: LOCALE=es requested but the dump contains the en marker 'Voting Period' and not the es marker 'Período de Votación' -- the app is rendering en" >&2
    else
      echo "PREFLIGHT FAIL: LOCALE=es requested but neither the es marker 'Período de Votación' nor the en marker 'Voting Period' was found in the dump" >&2
    fi
    exit 1
  fi

  echo "[timeline-geometry] Preflight: node locatability for all ${#EXPECTED_STAGES[@]} stage ids ..."
  ACCUMULATED_RECORDS="${TMPDIR_TG}/accumulated.records"
  : > "${ACCUMULATED_RECORDS}"
  collect_records

  # fix(61-03): reconcile ORPHAN against the accumulated CARD set (authorized third fix,
  # same disclosure/scope discipline as the first two -- 61-07 discovered this against real
  # device output; see todos/pending/2026-09-16-timeline-geometry-proof-dump-ui-status-
  # unbound-and-exit-masked.md). collect_records() appends one ORPHAN record for a stage the
  # FIRST time any single pass observes that stage's title/subtitle/action content without
  # its notch co-resolving IN THAT SAME PASS (e.g. only two cards fit the viewport at once,
  # so a card's tail can be visible a pass before/after its own notch scrolls into frame).
  # That ORPHAN record was never retired even when a DIFFERENT pass in the very same
  # 8-iteration loop captured the stage's CARD (notch + bounds) correctly -- a real, valid
  # observation sitting in the same ACCUMULATED_RECORDS file. A stage with a CARD record
  # from ANY pass has, by definition, had its notch anchor positively resolved at least
  # once; an ORPHAN record for that same stage is then a stale artifact of a different
  # pass's transitional/boundary state, not evidence the anchor never resolves. Drop such
  # stale ORPHAN lines before anything downstream (this preflight check, or any leg) reads
  # the file. This can only ever REMOVE an ORPHAN line for a stage independently proven
  # present via its own CARD record -- it cannot manufacture a CARD record, and a stage
  # that truly has no CARD record in any pass is untouched by this filter and continues to
  # fail (via the "could not locate card anchor" check immediately below, which reads
  # CARD records only and was never affected by this bug) -- exactly the genuine
  # scroll-boundary case that must stay a real, reported failure.
  local reconciled="${TMPDIR_TG}/accumulated.reconciled"
  awk -v FS="${TAB}" -v OFS="${TAB}" '
    NR==FNR { if ($1=="CARD") has_card[$2]=1; next }
    $1=="ORPHAN" && ($2 in has_card) { next }
    { print }
  ' "${ACCUMULATED_RECORDS}" "${ACCUMULATED_RECORDS}" > "${reconciled}"
  mv "${reconciled}" "${ACCUMULATED_RECORDS}"

  local missing="" s found_count
  for s in "${EXPECTED_STAGES[@]}"; do
    found_count=$(grep -c "^CARD${TAB}${s}${TAB}" "${ACCUMULATED_RECORDS}" || true)
    if [ "${found_count}" -eq 0 ]; then
      missing="${missing:+${missing},}${s}"
    fi
  done
  if [ -n "${missing}" ]; then
    echo "PREFLIGHT FAIL: could not locate card anchor for stage(s): ${missing}" >&2
    exit 1
  fi

  local orphan_stages
  orphan_stages=$(awk -v FS="${TAB}" '$1=="ORPHAN"{print $2}' "${ACCUMULATED_RECORDS}" | sort -u | paste -sd, - || true)
  if [ -n "${orphan_stages}" ]; then
    echo "PREFLIGHT FAIL: notch anchor did not surface as a resource-id/content-desc for stage(s): ${orphan_stages}" >&2
    exit 1
  fi

  echo "[timeline-geometry] Preflight: PASS (density=${DENSITY_DPI}dpi screen=${SCREEN_W}x${SCREEN_H} locale=${LOCALE} serial=${SERIAL}${SERIAL_NOTE:+ serial_note=${SERIAL_NOTE}})"
}

# ---------------------------------------------------------------------------------------
# collect_records -- the scroll accumulator (design_notes item 5). Loops at most 8
# iterations: dump, walk, and for each CARD record whose rectangle is FULLY inside the
# viewport and whose stage has not yet been recorded, append that stage's full record set
# to ACCUMULATED_RECORDS. Stops early once all ten stages have a fully-visible
# observation, or when two consecutive iterations add no new stage. Keeping only
# fully-visible observations is load-bearing, not an optimization: a partially-scrolled
# card reports vertically truncated bounds and would manufacture a false touch-targets
# FAIL that reads exactly like a real one.
# ---------------------------------------------------------------------------------------
collect_records() {
  local iter=0 max_iter=8 added_any same_count=0 stage_list_seen=""
  while [ "${iter}" -lt "${max_iter}" ]; do
    iter=$((iter + 1))
    local dump_path
    dump_path=$(dump_ui)
    # fix(61-03): see preflight()'s identical comment -- read the status back from the file
    # dump_ui() wrote, not from a subshell-local assignment.
    DUMP_UI_STATUS="$(cat "${TMPDIR_TG}/dump_ui_status" 2>/dev/null || echo unobservable)"
    if [ "${DUMP_UI_STATUS}" != "ok" ]; then
      echo "[timeline-geometry] WARNING: collect_records iteration ${iter}: dump-unobservable, skipping this pass." >&2
      continue
    fi
    local iter_records="${TMPDIR_TG}/iter-${iter}.records"
    walk_dump "${dump_path}" > "${iter_records}"

    added_any=0
    local rtype rstage rx1 ry1 rx2 ry2 rest
    while IFS="${TAB}" read -r rtype rstage rx1 ry1 rx2 ry2 rest; do
      [ "${rtype}" != "CARD" ] && continue
      case ",${stage_list_seen}," in
        *",${rstage},"*) continue ;;
      esac
      if [ "${ry1}" -ge 0 ] && [ "${ry2}" -le "${SCREEN_H}" ]; then
        awk -v FS="${TAB}" -v st="${rstage}" '$2==st' "${iter_records}" >> "${ACCUMULATED_RECORDS}"
        stage_list_seen="${stage_list_seen:+${stage_list_seen},}${rstage}"
        added_any=1
      fi
    done < "${iter_records}"

    local ostage
    for ostage in $(awk -v FS="${TAB}" '$1=="ORPHAN"{print $2}' "${iter_records}" | sort -u); do
      if ! grep -q "^ORPHAN${TAB}${ostage}\$" "${ACCUMULATED_RECORDS}" 2>/dev/null; then
        printf 'ORPHAN%s%s\n' "${TAB}" "${ostage}" >> "${ACCUMULATED_RECORDS}"
      fi
    done

    local seen_count
    seen_count=$(printf '%s' "${stage_list_seen}" | tr ',' '\n' | grep -c . || true)
    if [ "${seen_count}" -ge "${#EXPECTED_STAGES[@]}" ]; then
      break
    fi
    if [ "${added_any}" -eq 0 ]; then
      same_count=$((same_count + 1))
      [ "${same_count}" -ge 2 ] && break
    else
      same_count=0
    fi

    adb ${ADBD} shell input swipe $((SCREEN_W / 2)) $((SCREEN_H * 3 / 4)) $((SCREEN_W / 2)) $((SCREEN_H / 4)) 400 >/dev/null 2>&1 || true
    sleep 1
  done
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
    $1=="CARD" { card_x2[$2] = $5; n_cards++ }
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
      } else if (count_text+0 == 0) {
        # WR-06: zero measured nodes is NOT a pass. The cards resolved but nothing inside them
        # did -- the shape a parser regression takes. Reporting PASS here is a gate certifying
        # its own blindness.
        printf "FAIL\tno-measurement: 0 text node(s) measured inside %d resolved card(s) locale=%s serial=%s%s\n", n_cards+0, locale, serial, note
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
      } else if (n+0 == 0) {
        # WR-06: "no duplicates found" among ZERO candidates is vacuous, not a pass.
        printf "FAIL\tno-measurement: 0 text node(s) available to compare locale=%s serial=%s%s\n", locale, serial, note
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
      } else if (count+0 == 0) {
        # WR-06: "all targets are large enough" across ZERO targets is vacuous, not a pass.
        printf "FAIL\tno-measurement: 0 touch target(s) measured locale=%s serial=%s%s\n", locale, serial, note
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
  local out="" rc=0
  case "${name}" in
    clipping) out=$(leg_clipping "${records_file}") || rc=$? ;;
    duplicates) out=$(leg_duplicates "${records_file}") || rc=$? ;;
    touch-targets) out=$(leg_touch_targets "${records_file}") || rc=$? ;;
    *)
      echo "run_leg: unknown leg '${name}'" >&2
      return 1
      ;;
  esac

  # WR-06: a leg whose awk died, or that printed nothing at all, has NOT passed -- it failed to
  # measure. Record it as ERROR so the fail-closed any_failed() below trips on it.
  if [ "${rc}" -ne 0 ] || [ -z "${out}" ]; then
    LAST_VERDICT="ERROR"
    LAST_EVIDENCE="leg produced no verdict line (exit=${rc}) locale=${LOCALE} serial=${SERIAL}"
    record_leg "${name}" "${LAST_VERDICT}" "${LAST_EVIDENCE}"
    return 0
  fi

  LAST_VERDICT="${out%%${TAB}*}"
  LAST_EVIDENCE="${out#*${TAB}}"

  # WR-06: only PASS and FAIL are legal verdict tokens. Anything else means the leg's own
  # printf drifted from this contract; treat it as ERROR rather than letting it read as a pass.
  case "${LAST_VERDICT}" in
    PASS|FAIL) ;;
    *)
      LAST_EVIDENCE="unrecognised verdict token '"'"'${LAST_VERDICT}'"'"' in leg output: ${out}"
      LAST_VERDICT="ERROR"
      ;;
  esac

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
  # WR-06/W-1: fixture list is an array so the summary count below cannot drift from it.
  local fixtures=(clean clipped degenerate missing-node no-measurement)
  local total="${#fixtures[@]}"
  for f in "${fixtures[@]}"; do
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
      no-measurement)
        # WR-06: the cards resolve but nothing inside them does. A gate that measured zero
        # nodes must never report success -- ALL THREE legs must FAIL for their own
        # `no-measurement` reason, not fall through to a PASS on an empty count.
        if [ "${clip_verdict}" != "FAIL" ] || [[ "${clip_evidence}" != *"no-measurement"* ]]; then
          echo "SELFTEST MISMATCH: no-measurement -- expected clipping FAIL naming no-measurement, got ${clip_verdict} (${clip_evidence})"
          ok=0
        fi
        if [ "${dup_verdict}" != "FAIL" ] || [[ "${dup_evidence}" != *"no-measurement"* ]]; then
          echo "SELFTEST MISMATCH: no-measurement -- expected duplicates FAIL naming no-measurement, got ${dup_verdict} (${dup_evidence})"
          ok=0
        fi
        if [ "${tt_verdict}" != "FAIL" ] || [[ "${tt_evidence}" != *"no-measurement"* ]]; then
          echo "SELFTEST MISMATCH: no-measurement -- expected touch-targets FAIL naming no-measurement, got ${tt_verdict} (${tt_evidence})"
          ok=0
        fi
        if [[ "${clip_evidence}" == *"clipped-text"* || "${clip_evidence}" == *"anchor-missing"* || "${clip_evidence}" == *"degenerate-bounds"* ]]; then
          echo "SELFTEST MISMATCH: no-measurement -- clipping evidence named a reason other than its own: ${clip_evidence}"
          ok=0
        fi
        ;;
    esac

    [ "${ok}" -eq 0 ] && mismatches=$((mismatches + 1))
  done

  if [ "${mismatches}" -eq 0 ]; then
    echo "SELFTEST: PASS (${total}/${total} fixtures behaved as specified)"
    SCRIPT_EXIT_CODE=0
    exit 0
  else
    echo "SELFTEST: FAIL ($((total - mismatches))/${total} fixtures behaved as specified)"
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
  SCRIPT_EXIT_CODE=0
  exit 0
fi
# ---------------------------------------------------------------------------------------
# Leg dispatch and usage (shape from run-authority-signing-ceremony.sh:73-84).
# ---------------------------------------------------------------------------------------
LEG="${1:-}"
case "${LEG}" in
  clipping|duplicates|touch-targets|all) ;;
  *)
    echo "Usage: SERIAL=43a209ff0806 LOCALE=en ./scripts/run-timeline-geometry-proof.sh <clipping|duplicates|touch-targets|all>" >&2
    exit 1
    ;;
esac

preflight

case "${LEG}" in
  clipping) run_leg "clipping" "${ACCUMULATED_RECORDS}" ;;
  duplicates) run_leg "duplicates" "${ACCUMULATED_RECORDS}" ;;
  touch-targets) run_leg "touch-targets" "${ACCUMULATED_RECORDS}" ;;
  all)
    run_leg "clipping" "${ACCUMULATED_RECORDS}"
    run_leg "duplicates" "${ACCUMULATED_RECORDS}"
    run_leg "touch-targets" "${ACCUMULATED_RECORDS}"
    ;;
esac

echo "[timeline-geometry] ========== Summary =========="
for r in "${RESULTS[@]}"; do
  IFS='|' read -r name verdict evidence <<< "${r}"
  echo "LEG ${name}: ${verdict}"
done

if any_failed; then
  exit 1
fi
SCRIPT_EXIT_CODE=0
exit 0
