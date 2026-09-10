#!/usr/bin/env bash
#
# filter-device-logcat.sh
#
# Purpose : T-58-07-06 — reduce a raw device logcat to only the lines produced by
#           the app under test (and the system lines that name its package) before
#           the capture is committed to .planning/.
#
# Why this exists:
#   A device-wide `adb logcat` from a developer's personal handset carries every
#   other running app's telemetry. 58-08 committed one such capture: 43,187 lines
#   naming 412 distinct dotted identifiers, including social and messaging apps
#   unrelated to VoteTorrent. That is a confidentiality problem in the phase record
#   even when it carries no key material.
#
# Why it filters by PID rather than by grepping the package name:
#   The app's own log lines are tagged with a TRUNCATED process name
#   ("rrent.authorit"), not the package, so a package grep silently drops almost
#   all of them. The process ids are the only reliable handle, and they are
#   recoverable from the capture itself via the "Start proc" lines.
#
# What is KEPT:
#   1. every line whose pid field is one of --pid
#   2. every line naming --package (system-side lifecycle: Start proc / Killing /
#      Force stopping — these carry the cold-start proof)
#   3. the "--------- beginning of <buffer>" section markers
#
# Both logcat layouts are handled: "brief" (L/tag( pid): msg) and "threadtime"
# (date time pid tid L tag: msg).
#
# Usage:
#   scripts/filter-device-logcat.sh --in RAW --out FILTERED \
#     --package org.votetorrent.authority --pid 20132 --pid 422 --pid 1484
#
#   Omit --pid to auto-discover them from the capture's own "Start proc" lines.
#
# Exits non-zero if the filter would keep zero app lines — a filter that empties
# the capture is a broken filter, not a clean one.

set -euo pipefail

IN=""; OUT=""; PKG=""; PIDS=""
while [ $# -gt 0 ]; do
  case "$1" in
    --in)      IN="$2"; shift 2 ;;
    --out)     OUT="$2"; shift 2 ;;
    --package) PKG="$2"; shift 2 ;;
    --pid)     PIDS="$PIDS $2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

[ -n "$IN" ]  || { echo "--in is required" >&2; exit 2; }
[ -n "$OUT" ] || { echo "--out is required" >&2; exit 2; }
[ -n "$PKG" ] || { echo "--package is required" >&2; exit 2; }
[ -f "$IN" ]  || { echo "no such capture: $IN" >&2; exit 2; }

# Auto-discover the app's pids from the capture when none were named.
if [ -z "${PIDS// /}" ]; then
  PIDS=$(LC_ALL=C grep -oE "Start proc [0-9]+:${PKG}[/ ]" "$IN" \
         | sed -E 's/Start proc ([0-9]+):.*/\1/' | sort -u | tr '\n' ' ')
  echo "auto-discovered pids:${PIDS:- none}"
fi
[ -n "${PIDS// /}" ] || { echo "no pids for $PKG in $IN" >&2; exit 1; }

LC_ALL=C awk -v pidlist="$PIDS" -v pkg="$PKG" '
BEGIN { n = split(pidlist, a, /[ ]+/); for (i = 1; i <= n; i++) if (a[i] != "") want[a[i]] = 1 }

# Section markers carry no app data but preserve the capture structure.
/^-----+ beginning of/ { print; next }

{
  pid = ""

  # threadtime: "09-09 21:19:37.260  4010  4063 I Tag: msg"
  if ($0 ~ /^[0-9][0-9]-[0-9][0-9] [0-9][0-9]:[0-9][0-9]:[0-9][0-9]\.[0-9][0-9][0-9] +[0-9]+ +[0-9]+ [VDIWEF] /) {
    pid = $3
  }
  # brief: "09-09 21:19:37.260 D/Tag  (  872): msg" — the pid is the parenthesised
  # field immediately before the FIRST "): ", located exactly rather than by a
  # greedy regex that could match a "(123): " inside the message body.
  else if ($0 ~ /^[0-9][0-9]-[0-9][0-9] [0-9][0-9]:[0-9][0-9]:[0-9][0-9]\.[0-9][0-9][0-9] [VDIWEF]\//) {
    p = index($0, "): ")
    if (p > 0) {
      pre = substr($0, 1, p - 1)
      for (i = length(pre); i > 0; i--) if (substr(pre, i, 1) == "(") break
      if (i > 0) { cand = substr(pre, i + 1); gsub(/ /, "", cand); if (cand ~ /^[0-9]+$/) pid = cand }
    }
  }

  if (pid != "" && (pid in want)) { kept++; print; next }
  if (index($0, pkg) > 0)         { kept++; print; next }
}

END { if (kept + 0 == 0) { print "filter kept zero app lines" > "/dev/stderr"; exit 1 } }
' "$IN" > "$OUT"

in_lines=$(LC_ALL=C wc -l < "$IN"); out_lines=$(LC_ALL=C wc -l < "$OUT")
in_bytes=$(LC_ALL=C wc -c < "$IN"); out_bytes=$(LC_ALL=C wc -c < "$OUT")
ident() { LC_ALL=C grep -oE '\b[a-z][a-z0-9_]*(\.[a-z0-9_]+){2,}\b' "$1" 2>/dev/null | sort -u | wc -l | tr -d ' '; }

echo "package : $PKG"
echo "pids    :${PIDS}"
echo "lines   : ${in_lines} -> ${out_lines}"
echo "bytes   : ${in_bytes} -> ${out_bytes}"
echo "idents  : $(ident "$IN") -> $(ident "$OUT")   (distinct dotted identifiers)"
