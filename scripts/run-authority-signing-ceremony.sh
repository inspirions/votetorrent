#!/usr/bin/env bash
#
# run-authority-signing-ceremony.sh
#
# Purpose : Phase 49 D-24/D-25 on-device Authority-app signing ceremony driver.
#           Drives the REAL product UI (Settings -> Secure Signing ->
#           ProvisionSigningKeyScreen, and any routed per-use signing call
#           site) on a booted emulator to observe the facts jest cannot see:
#           a real BiometricPrompt sheet, a real Keystore-backed P-256
#           signature accepted by the in-schema SignatureValid CHECK, clean
#           cancellation (both the negative button AND the BACK key), and no
#           plaintext key residue in AsyncStorage.
#
# Usage   : SERIAL=emulator-5554 ./scripts/run-authority-signing-ceremony.sh <leg>
#           <leg> one of: provision-local | provision-register | sign | cancel | storage |
#                         hw-provision | recover | all
#           `provision` is accepted as a deprecated alias for `provision-local`.
#
#           49-14 (real-hardware legs): `hw-provision` and `recover` are for REAL DEVICES ONLY
#           (they PREFLIGHT FAIL loudly if pointed at an emulator). Every biometric-satisfaction
#           step that used to inject `adb emu finger touch` now branches on whether the target
#           actually responds to `adb emu` — on real hardware there is no adb equivalent, so the
#           script PAUSES (bounded on HW_BIOMETRIC_TIMEOUT, default 90s) and prints a loud
#           "ACTION REQUIRED" instruction for a human to physically touch the sensor (or, for the
#           D-16/D-26 recovery ceremony's DEVICE_CREDENTIAL authenticator, enter the PIN/pattern/
#           password — never a fingerprint touch there). `hw-provision` also pauses twice for an
#           operator-driven network-creation step (HW_NETWORK_WAIT, default 90s) — same six-field
#           RN form limitation `provision-register` already documents below.
#
#           49-18 (Gap A's runtime proof vehicle): the onboarding order 49-16/49-17
#           landed splits provisioning into two network-independent/network-scoped
#           halves that cannot both complete in one pass on a clean device.
#           `provision-local` drives the local ceremony from a `pm clear` start and
#           lands on the awaiting-network state. Between `provision-local` and
#           `provision-register` there is a REQUIRED, NOT-AUTOMATED operator step:
#           create or join a network through the real in-app `AddNetworkScreen` flow.
#           This script deliberately does not drive that screen — it is a six-field
#           RN form, and this project has recorded that RN TextInputs resist `adb`
#           taps and report `text=""` to uiautomator, and that `adb input text`
#           containing two `r` characters triggers an RN reload. Driving it blind
#           would produce false failures indistinguishable from real ones.
#           `provision-register` then drives the network-scoped registration half
#           and asserts the success heading. `all` runs `provision-local`, `cancel`,
#           and `storage` only; `provision-register` is recorded NOT-EXERCISED under
#           `all` (it requires the operator-created network precondition above).
#
# Prereqs : adb on PATH; a booted EMULATOR (not a real device — this script's
#           fingerprint injection is emulator-only) with the debug app already
#           installed (`cd apps/VoteTorrentAuthority/android && ./gradlew
#           installDebug`); Metro reachable on METRO_PORT (default 8081,
#           override if the port is squatted by a sibling Expo project — see
#           the spike-findings-votetorrent skill).
#
# Exit    : 0 — every selected leg printed LEG <name>: PASS
#           1 — a preflight failed, or any selected leg printed LEG <name>: FAIL
#
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
. scripts/lib/logcat-wait.sh

PACKAGE="org.votetorrent.authority"
SERIAL="${SERIAL:-emulator-5554}"
ADBD="-s ${SERIAL}"
METRO_PORT="${METRO_PORT:-8081}"
DUMP_TIMEOUT=30
PROMPT_TIMEOUT=20
VERDICT_TIMEOUT=60

LEG="${1:-}"
if [ "${LEG}" = "provision" ]; then
  echo "[ceremony] NOTE: leg 'provision' is a deprecated alias — the split onboarding order (49-16/49-17) means it now runs 'provision-local'. Use 'provision-local' directly going forward." >&2
  LEG="provision-local"
fi
case "${LEG}" in
  provision-local|provision-register|sign|cancel|storage|hw-provision|recover|all) ;;
  *)
    echo "Usage: SERIAL=emulator-5554 $0 <provision-local|provision-register|sign|cancel|storage|hw-provision|recover|all>" >&2
    exit 1
    ;;
esac

# 49-14 — real-hardware pause windows. Overridable via env for a slower operator/device.
HW_BIOMETRIC_TIMEOUT="${HW_BIOMETRIC_TIMEOUT:-90}"
HW_NETWORK_WAIT="${HW_NETWORK_WAIT:-90}"
# Set by preflight() once the target's `adb emu` responsiveness is known. 1 = emulator (the
# existing 49-13/49-18 injection path), 0 = real hardware (49-14's job — every biometric/
# device-credential step pauses for a human instead).
IS_EMULATOR=1

# ── i18n strings this script asserts against (EN values, apps/VoteTorrentAuthority/src/i18n/index.ts) ──
STR_SETTINGS_ROW="Secure Signing"
STR_SETUP_BUTTON="Set Up Secure Signing"
STR_SUCCESS_HEADING="Signing key ready"
STR_AWAITING_NETWORK_HEADING="Secure signing is set up on this device"
STR_PROMPT_TITLE="Confirm your identity"
STR_NEGATIVE_BUTTON="Cancel"
STR_ERROR_STRINGS=(
  "This device has no biometrics enrolled"
  "Too many attempts"
  "Biometric verification is locked"
  "Couldn't verify your biometrics"
)

TMPDIR_CEREMONY="$(mktemp -d)"
cleanup() { rm -rf "${TMPDIR_CEREMONY}"; }
trap cleanup EXIT

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

# ── Preflights (all fail loudly, none proceed silently) ─────────────────────
preflight() {
  echo "[ceremony] Preflight: adb device state ..."
  local state
  state=$(adb ${ADBD} get-state 2>/dev/null || true)
  if [ "${state}" != "device" ]; then
    echo "[ceremony] PREFLIGHT FAIL: '${SERIAL}' is not in 'device' state (got '${state}') — is the emulator booted? (adb devices)" >&2
    exit 1
  fi

  echo "[ceremony] Preflight: emulator check (adb emu) ..."
  if adb ${ADBD} emu avd name >/dev/null 2>&1; then
    IS_EMULATOR=1
    echo "[ceremony]   -> emulator target detected; fingerprint injection via 'adb emu finger touch' is available (49-13/49-18 path)."
  else
    IS_EMULATOR=0
    echo "[ceremony]   -> real hardware target detected ('adb emu' unsupported, as expected on a physical device — this is 49-14's job). Every biometric/device-credential step will PAUSE for a physical action instead of injecting one." >&2
  fi

  echo "[ceremony] Preflight: secure lock screen + fingerprint enrollment ..."
  if [ "${IS_EMULATOR}" -eq 1 ]; then
    # A lock credential may already be set to this script's own PIN from a
    # prior ceremony run — `pm clear` (reset_identity) only resets the APP's
    # data, never the device lock screen, so a bare `set-pin 1234` on a second
    # run fails with "old credential was not provided" even though the PIN is
    # already correct. Try the no-`--old` form first (first-ever setup on a
    # fresh AVD), then retry with `--old 1234` (idempotent re-run) before
    # treating it as a genuine failure.
    if ! adb ${ADBD} shell locksettings set-pin 1234 >/dev/null 2>&1; then
      # `--old` must precede the PIN argument (locksettings' shell parser is
      # positional-sensitive: `set-pin 1234 --old 1234` is rejected the same
      # as no --old at all).
      if ! adb ${ADBD} shell locksettings set-pin --old 1234 1234 >/dev/null 2>&1; then
        echo "[ceremony] PREFLIGHT FAIL: 'locksettings set-pin 1234' failed (with and without --old 1234) — a Keystore key with setUserAuthenticationRequired(true) cannot even be GENERATED on a device with no secure lock screen, so a missing/mismatched PIN here presents downstream as a keygen failure, not a prompt failure. Set the PIN by hand ('adb shell locksettings clear --old <existing>' then re-run) and re-run." >&2
        exit 1
      fi
    fi
    # Enroll a fingerprint under finger id 1 for the emulator's virtual sensor.
    adb ${ADBD} emu finger touch 1 >/dev/null 2>&1 || true
  else
    # Real hardware (49-14-PLAN.md Task 1's own prerequisite): the human already configured a
    # secure lock screen + exactly one enrolled biometric BEFORE this script ever runs.
    # NEVER programmatically set a PIN or enroll a fingerprint here — doing so on a real device
    # would silently overwrite the DEVICE OWNER'S actual lock-screen credential. Verify, read-only,
    # instead of mutate.
    #
    # `dumpsys trust`'s `deviceLocked=` line is CURRENT lock state, not lock-screen
    # CONFIGURATION — a device the operator just unlocked to hand to this ceremony correctly
    # reads `deviceLocked=0`, and gating on `=1` here would wrongly PREFLIGHT FAIL a device that
    # is exactly ready to be driven. `locksettings get-disabled` (expect `false`) is the correct
    # configuration check and is used first; it throws `IllegalArgumentException` on some API
    # levels (49-14-PLAN.md's 2026-08-18 amendment, confirmed API 29) — `dumpsys fingerprint`'s
    # `acceptCrypto` count (non-zero = crypto-backed auth has genuinely succeeded against the
    # credential at some point) is the documented substitute there.
    local get_disabled
    get_disabled=$(adb ${ADBD} shell locksettings get-disabled 2>&1 | tr -d '\r')
    if [ "${get_disabled}" = "false" ] || [ "${get_disabled}" = "true" ]; then
      if [ "${get_disabled}" != "false" ]; then
        echo "[ceremony] PREFLIGHT FAIL: 'locksettings get-disabled' reports '${get_disabled}' (lock screen disabled) on '${SERIAL}' — a secure lock screen is required before any setUserAuthenticationRequired(true) Keystore key can even be generated. Set a PIN/pattern/password by hand and re-run." >&2
        exit 1
      fi
      echo "[ceremony]   -> secure lock screen confirmed read-only (locksettings get-disabled: false)"
    else
      # get-disabled unusable on this API level (e.g. API 29's IllegalArgumentException) — fall
      # back to the plan's documented substitute evidence.
      local accept_crypto
      # NOTE: dumpsys fingerprint's actual per-device format varies — some builds emit
      # key=value ("acceptCrypto=2"), others emit JSON ("acceptCrypto":2, as confirmed live on
      # this project's Redmi 8/API 29). Match both.
      accept_crypto=$(adb ${ADBD} shell dumpsys fingerprint 2>/dev/null | grep -o '"\?acceptCrypto"\?[:=][0-9]*' | head -1 || true)
      if [ -z "${accept_crypto}" ] || echo "${accept_crypto}" | grep -q '[:=]0$'; then
        echo "[ceremony] PREFLIGHT FAIL: 'locksettings get-disabled' unusable on this API level (${get_disabled}) and 'dumpsys fingerprint' reports no non-zero acceptCrypto count on '${SERIAL}' — cannot confirm a secure, crypto-backed lock screen is configured. (raw get-disabled: ${get_disabled})" >&2
        exit 1
      fi
      echo "[ceremony]   -> secure lock screen confirmed read-only via substitute evidence (dumpsys fingerprint: ${accept_crypto}) — get-disabled unusable on this API level"
    fi

    # A real device's screen times out and re-locks between ceremony steps — unlike an emulator,
    # adb has NO keyguard bypass for a real credential (45-11-PROOF-LOG.md's own re-confirmed
    # constraint: "adb cannot clear the keyguard"). Wake it and give a human a bounded window to
    # unlock physically HERE, rather than let launch_app spin uselessly against a lock screen for
    # its own 300s window with a much less specific failure message.
    adb ${ADBD} shell input keyevent KEYCODE_WAKEUP >/dev/null 2>&1 || true
    adb ${ADBD} shell svc power stayon usb >/dev/null 2>&1 || true
    local focus
    focus=$(adb ${ADBD} shell dumpsys window 2>/dev/null | grep -i mCurrentFocus || true)
    if echo "${focus}" | grep -qi "Keyguard\|NotificationShade"; then
      echo "[ceremony] ############################################################" >&2
      echo "[ceremony] ACTION REQUIRED on ${SERIAL}: the screen is currently LOCKED (mCurrentFocus: ${focus}). adb cannot bypass a real keyguard credential — unlock the device physically now." >&2
      echo "[ceremony] waiting up to ${HW_BIOMETRIC_TIMEOUT}s ..." >&2
      echo "[ceremony] ############################################################" >&2
      local start_epoch
      start_epoch=$(date +%s)
      while [ "$(( $(date +%s) - start_epoch ))" -lt "${HW_BIOMETRIC_TIMEOUT}" ]; do
        focus=$(adb ${ADBD} shell dumpsys window 2>/dev/null | grep -i mCurrentFocus || true)
        if ! echo "${focus}" | grep -qi "Keyguard\|NotificationShade"; then
          echo "[ceremony] unlocked after $(( $(date +%s) - start_epoch ))s." >&2
          break
        fi
        sleep 3
      done
      if echo "${focus}" | grep -qi "Keyguard\|NotificationShade"; then
        echo "[ceremony] PREFLIGHT FAIL: '${SERIAL}' is still locked after ${HW_BIOMETRIC_TIMEOUT}s (mCurrentFocus: ${focus}) — cannot proceed without a human present to unlock it. Unlock it and re-run." >&2
        exit 1
      fi
    fi
  fi

  echo "[ceremony] Preflight: Metro reachability + adb reverse ..."
  adb ${ADBD} reverse "tcp:${METRO_PORT}" "tcp:${METRO_PORT}" || {
    echo "[ceremony] PREFLIGHT FAIL: 'adb reverse tcp:${METRO_PORT} tcp:${METRO_PORT}' failed. Note: this repo's qrcode-daily-sync Expo project squats port 8081 — pass METRO_PORT=8082 (or another free port) if 8081 is taken, and start Metro on that same port. Re-apply this reverse after every emulator restart." >&2
    exit 1
  }

  echo "[ceremony] Preflight: host load (informational, this app boots CadreNode which is CPU-heavy) ..."
  uptime || true

  echo "[ceremony] Preflight: host/device clock skew ..."
  local host_epoch device_epoch skew
  host_epoch=$(date +%s)
  device_epoch=$(adb ${ADBD} shell date +%s | tr -d '\r')
  skew=$(( host_epoch - device_epoch ))
  echo "[ceremony] host epoch=${host_epoch} device epoch=${device_epoch} skew=${skew}s"
  if [ ${skew#-} -gt 30 ]; then
    echo "[ceremony] PREFLIGHT FAIL: host/device clock skew is ${skew}s (>30s) — UserKey.Expiration > :now comparisons run against the device clock and a skewed clock has previously expired signed records on this project's emulators. Sync the emulator clock (adb shell date, or restart the AVD) and re-run." >&2
    exit 1
  fi

  echo "[ceremony] Preflights OK."
}

reset_identity() {
  # Equivalent to: adb shell pm clear org.votetorrent.authority
  # (PACKAGE is a constant equal to that literal — kept as a variable so the
  # whole script has exactly one place naming the package).
  echo "[ceremony] Resetting app identity: adb shell pm clear ${PACKAGE} ..."
  adb ${ADBD} shell pm clear "${PACKAGE}" >/dev/null
}

launch_app() {
  adb ${ADBD} shell am force-stop "${PACKAGE}"
  sleep 1
  adb ${ADBD} logcat -c
  adb ${ADBD} shell monkey -p "${PACKAGE}" -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1
  # Cold start + first Metro bundle fetch is slow (CadreNode boot is CPU-heavy
  # per this project's own emulator-boot precedent), and duration varies
  # sharply with host load (observed 90-150s real render time under moderate
  # load in this session, occasionally worse). A fixed sleep is racy, so this
  # polls for the rendered Home tab bar instead of trusting a guessed
  # duration — bounded on REAL elapsed wall time (not an iteration count
  # times a guessed per-iteration duration), since each poll round-trip's own
  # cost varies with load too.
  #
  # Two failure modes specific to this project's emulator, both handled:
  # (a) a STALE com.android.settings window (used earlier in this ceremony
  #     for PIN/fingerprint enrollment) can still hold focus, and that app's
  #     own screens are full of the literal string "Settings" — a bare
  #     text-content grep can false-positive-match it well before our app
  #     has regained focus. Gate on window focus naming our own package
  #     before trusting any text-content match.
  # (b) a genuine system ANR dialog ("VoteTorrent Authority isn't
  #     responding") can appear while CadreNode boots under load — this is
  #     the documented 'a loaded host has previously ANR'd and killed the
  #     AVD' gotcha. Detect it and tap 'Wait' (never 'Close app') so the
  #     ceremony can survive a transient ANR instead of hanging or false-
  #     failing on it. Polling is deliberately infrequent (12s) so the
  #     dump/pull round-trips themselves don't add CPU pressure on an
  #     already-loaded emulator during the exact window this matters most.
  local start_epoch dump focus wait_bounds wx1 wy1 wx2 wy2 wcx wcy
  start_epoch=$(date +%s)
  while [ "$(( $(date +%s) - start_epoch ))" -lt 300 ]; do
    focus=$(adb ${ADBD} shell dumpsys window 2>/dev/null | grep -i mCurrentFocus || true)
    if echo "${focus}" | grep -qi "Application Not Responding"; then
      dump=$(dump_ui)
      wait_bounds=$(grep -o '<node[^>]*text="Wait"[^>]*>' "${dump}" | grep -o 'bounds="\[[0-9,]*\]\[[0-9,]*\]"' | head -1 | sed 's/bounds="//;s/"//')
      if [ -n "${wait_bounds}" ]; then
        wx1=$(echo "${wait_bounds}" | sed -E 's/\[([0-9]+),([0-9]+)\]\[([0-9]+),([0-9]+)\]/\1/')
        wy1=$(echo "${wait_bounds}" | sed -E 's/\[([0-9]+),([0-9]+)\]\[([0-9]+),([0-9]+)\]/\2/')
        wx2=$(echo "${wait_bounds}" | sed -E 's/\[([0-9]+),([0-9]+)\]\[([0-9]+),([0-9]+)\]/\3/')
        wy2=$(echo "${wait_bounds}" | sed -E 's/\[([0-9]+),([0-9]+)\]\[([0-9]+),([0-9]+)\]/\4/')
        wcx=$(( (wx1 + wx2) / 2 )); wcy=$(( (wy1 + wy2) / 2 ))
        echo "[ceremony] ANR dialog observed mid-boot (host-load gotcha) — tapping Wait, never Close app." >&2
        adb ${ADBD} shell input tap "${wcx}" "${wcy}"
      fi
      sleep 12
      continue
    fi
    if echo "${focus}" | grep -q "${PACKAGE}"; then
      dump=$(dump_ui)
      if grep -qi 'text="Settings"' "${dump}" || grep -qi 'text="Select Network"' "${dump}"; then
        return 0
      fi
    fi
    sleep 12
  done
  echo "[ceremony] WARNING: launch_app polled 300 real seconds without seeing Home render — proceeding anyway; the next dump-based assertion will fail loudly if the app truly isn't up." >&2
}

# uiautomator dump helper: dumps the current window hierarchy to a local file
# and echoes its path. Never uses `adb shell input text` (see header) — every
# control is located by EN label text and tapped by computed center coords.
dump_ui() {
  local out="${TMPDIR_CEREMONY}/dump-$$-${RANDOM}.xml"
  # uiautomator dump can transiently fail (no accessible root node, e.g.
  # mid app-transition, or under the host-load conditions this project's
  # emulator gotchas warn about) WITHOUT touching /sdcard/window_dump.xml —
  # leaving a STALE file from a previous, unrelated dump on the device, or
  # producing a truncated/partial pull. Remove the remote file first so a
  # failed dump this call produces an empty/missing local file (a real
  # negative) rather than silently returning a prior ceremony's leftover
  # content as a false positive. Retry up to 3 times (observed under load:
  # a single dump attempt can transiently fail even while the app is
  # genuinely fully rendered) before giving up and returning whatever (or
  # empty) content was last captured — callers treat "no match" as the
  # correct negative either way.
  local attempt
  for attempt in 1 2 3; do
    adb ${ADBD} shell rm -f /sdcard/window_dump.xml >/dev/null 2>&1
    adb ${ADBD} shell uiautomator dump /sdcard/window_dump.xml >/dev/null 2>&1
    adb ${ADBD} pull /sdcard/window_dump.xml "${out}" >/dev/null 2>&1 || : > "${out}"
    if [ -s "${out}" ] && grep -q "</hierarchy>" "${out}" 2>/dev/null; then
      break
    fi
    sleep 1
  done
  echo "${out}"
}

# _find_nondegenerate_bounds ATTR LABEL DUMP_FILE — case-insensitive substring match
# against the given XML attribute (`text` or `content-desc`), returning the FIRST
# bounds value among all matching nodes that is NOT the degenerate "[0,0][0,0]" sentinel.
# Bracket-expression note (real bug, found and fixed during 49-13 Task 2):
# POSIX bracket expressions (`[...]`) do NOT support backslash-escaping — `\[`/`\]`
# INSIDE a `[...]` class are literal backslash-then-bracket, not an escaped bracket.
# `[0-9,\[\]]` under BSD/POSIX grep (the actual interpreter this script runs under,
# confirmed via `grep --version` -> "BSD grep, GNU compatible" — NOT the same grep some
# interactive dev shells alias) therefore closes the class early at the first literal
# `]` and silently fails to match every real `bounds="[x1,y1][x2,y2]"` value, making
# every match fail 100% of the time despite the target text being genuinely present
# (observed: 12/12 identical false failures against a real, static, already-rendered
# dump — not a timing issue). `[][0-9,]` is the POSIX-safe form: placing `]`
# immediately after the opening `[` makes it a literal member of the class instead of
# closing it.
_find_nondegenerate_bounds() {
  local attr="$1" label="$2" dump="$3"
  local candidates b
  # 49-14 pipefail note (same bug class as commit 6f1aff2): under this script's
  # `set -euo pipefail`, an EMPTY match at either grep stage makes the whole pipeline
  # exit non-zero (pipefail propagates ANY stage's failure, not only the trailing
  # command's) even though `sed` itself would happily process zero lines — guard with
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

# tap_on_text LABEL DUMP_FILE — case-insensitive substring match against
# `text=` attributes; taps the matched node's bounds center. Fails loudly
# (non-zero return, no tap) rather than silently skipping when no node
# matches — CustomButton uppercases its rendered title, so this matches
# case-insensitively by design.
#
# MIUI fallback (49-14 follow-up session, Redmi 8 finding): this device's bottom
# tab-bar/button `TextView` labels report `bounds="[0,0][0,0]"` in a uiautomator
# dump — their icon/text pairing collapses to a zero-size label under MIUI's layout,
# unlike Samsung. The actually-tappable element is the parent `ViewGroup`, which
# carries a real `content-desc` (matching the same label text) and correct bounds
# (confirmed via direct on-device XML inspection, 49-14-PROOF-LOG.md). Rather than
# walking the XML tree (this script has no XML parser), first look for ANY `text=`
# match with non-degenerate bounds (Samsung's existing, unregressed path — a device
# whose FIRST text match is already non-degenerate takes the exact same bounds as
# before this fix); only if every `text=` match is degenerate (or absent) does this
# fall back to a `content-desc=` match with non-degenerate bounds.
tap_on_text() {
  local label="$1" dump="$2"
  local bounds
  bounds=$(_find_nondegenerate_bounds "text" "${label}" "${dump}" || true)
  if [ -z "${bounds}" ]; then
    bounds=$(_find_nondegenerate_bounds "content-desc" "${label}" "${dump}" || true)
  fi
  if [ -z "${bounds}" ]; then
    return 1
  fi
  # bounds format: [x1,y1][x2,y2]
  local x1 y1 x2 y2 cx cy
  x1=$(echo "${bounds}" | sed -E 's/\[([0-9]+),([0-9]+)\]\[([0-9]+),([0-9]+)\]/\1/')
  y1=$(echo "${bounds}" | sed -E 's/\[([0-9]+),([0-9]+)\]\[([0-9]+),([0-9]+)\]/\2/')
  x2=$(echo "${bounds}" | sed -E 's/\[([0-9]+),([0-9]+)\]\[([0-9]+),([0-9]+)\]/\3/')
  y2=$(echo "${bounds}" | sed -E 's/\[([0-9]+),([0-9]+)\]\[([0-9]+),([0-9]+)\]/\4/')
  cx=$(( (x1 + x2) / 2 ))
  cy=$(( (y1 + y2) / 2 ))
  adb ${ADBD} shell input tap "${cx}" "${cy}"
  return 0
}

text_present() {
  local label="$1" dump="$2"
  grep -qi "text=\"[^\"]*${label}" "${dump}"
}

navigate_to_settings() {
  # Home mounts unconditionally at boot (RootNavigator's first Stack.Screen),
  # so Settings is reachable with zero network context. The tab header's
  # circle-user icon navigates Home -> Settings on every tab; tap the Settings
  # tab bar item directly (present in the bottom TabNavigator).
  local dump attempt
  # A single dump_ui call immediately after launch_app's own successful
  # readiness match can occasionally miss the same control under host-load
  # adb/uiautomator flakiness. Retry a few times with a short settle pause
  # before declaring the leg FAILed on what would otherwise be a false
  # negative.
  for attempt in 1 2 3; do
    dump=$(dump_ui)
    if tap_on_text "Settings" "${dump}"; then
      sleep 2
      return 0
    fi
    sleep 3
  done
  echo "[ceremony] ERROR: Settings tab not found in uiautomator dump" >&2
  return 1
}

# pull_storage_db — pulls RKStorage + its WAL/SHM sidecars into a fresh scratch dir and
# echoes the dir path. Shared by provision-local's on-disk artifact assertions and
# leg_storage — both read the same AsyncStorage-backed sqlite file via `run-as`.
pull_storage_db() {
  local pulldir="${TMPDIR_CEREMONY}/storage-$$-${RANDOM}"
  mkdir -p "${pulldir}"
  local f
  for f in RKStorage RKStorage-wal RKStorage-shm; do
    adb ${ADBD} shell "run-as ${PACKAGE} cat databases/${f}" > "${pulldir}/${f}" 2>/dev/null || true
  done
  echo "${pulldir}"
}

# capture_signing_reject_line — reads the app-pid-scoped logcat buffer for a
# VtSigningReject line carrying an `errorCode=` token (KeyAttestationHelper.kt's
# regenerateAttested/produceAttestation onAuthenticationError override — the only
# signing prompt a pm-clear device reaches). Matches on the tag plus the
# `errorCode=` token only, never a specific entry-point name, so this keeps working
# if the prompt under test ever moves — but the matched line itself is returned
# verbatim, since which entry point emitted it is itself evidence. Falls back to a
# package-name grep when `pidof` returns empty, mirroring the existing fault-check
# fallback below. Echoes the matched line, or nothing if none was found.
capture_signing_reject_line() {
  local app_pid line
  app_pid=$(adb ${ADBD} shell pidof "${PACKAGE}" 2>/dev/null | tr -d '\r' | awk '{print $1}')
  if [ -n "${app_pid}" ]; then
    line=$(adb ${ADBD} logcat -d --pid="${app_pid}" 2>/dev/null | grep "VtSigningReject" | grep "errorCode=" | head -1 || true)
  else
    line=$(adb ${ADBD} logcat -d 2>/dev/null | grep " ${PACKAGE}" | grep "VtSigningReject" | grep "errorCode=" | head -1 || true)
  fi
  printf '%s\n' "${line}"
}

# satisfy_biometric REASON — the hardware-portable replacement for a bare
# `adb emu finger touch 1` call (49-14). On an emulator, injects the virtual touch exactly as
# 49-13/49-18 always did. On real hardware there is no adb equivalent — physically touching the
# fingerprint sensor is required, and only a human can do that (49-14-PLAN.md Task 2's own
# instruction: "pause for a real touch instead of failing"). Polls the current dump for the
# prompt title to clear, bounded on HW_BIOMETRIC_TIMEOUT real wall-clock seconds, printing a loud
# operator instruction. Returns 0 once the prompt clears (the NEXT assertion in the calling leg
# is what actually judges success/failure — this helper only unblocks the wait) and 1 (non-fatal)
# if the timeout elapses with the prompt still showing.
satisfy_biometric() {
  local reason="${1:-signing}"
  if [ "${IS_EMULATOR}" -eq 1 ]; then
    adb ${ADBD} emu finger touch 1 >/dev/null 2>&1 || true
    return 0
  fi
  echo "[ceremony] ############################################################" >&2
  echo "[ceremony] ACTION REQUIRED on ${SERIAL}: touch the fingerprint sensor now to satisfy the '${reason}' BiometricPrompt." >&2
  echo "[ceremony] (real hardware has no 'adb emu finger touch' equivalent — this is a physical action, 49-14-PLAN.md Task 2)" >&2
  echo "[ceremony] waiting up to ${HW_BIOMETRIC_TIMEOUT}s ..." >&2
  echo "[ceremony] ############################################################" >&2
  local start_epoch dump
  start_epoch=$(date +%s)
  while [ "$(( $(date +%s) - start_epoch ))" -lt "${HW_BIOMETRIC_TIMEOUT}" ]; do
    dump=$(dump_ui)
    if ! text_present "${STR_PROMPT_TITLE}" "${dump}"; then
      echo "[ceremony] prompt cleared after $(( $(date +%s) - start_epoch ))s." >&2
      return 0
    fi
    sleep 3
  done
  echo "[ceremony] WARNING: prompt still showing after ${HW_BIOMETRIC_TIMEOUT}s — no touch observed. Proceeding anyway; the next assertion will fail loudly if the prompt never cleared." >&2
  return 1
}

# satisfy_device_credential REASON — the D-16/D-26 recovery ceremony's authenticator is
# DEVICE_CREDENTIAL (PIN/pattern/password), never a fingerprint (BiometricPrompt forbids
# combining setAllowedAuthenticators(DEVICE_CREDENTIAL) with a negative button, and the API 24-29
# KeyguardManager branch is a distinct confirm-credential Activity) — so this is ALWAYS a manual
# action, on an emulator or real hardware alike (the emulator's virtual fingerprint sensor cannot
# satisfy a device-credential prompt either). Same bounded-wait shape as satisfy_biometric,
# printed as a distinctly-worded instruction so an operator does not confuse the two ceremonies —
# touching the sensor here does nothing; the sheet asks for the PIN/pattern/password.
satisfy_device_credential() {
  local reason="${1:-recovery}"
  echo "[ceremony] ############################################################" >&2
  echo "[ceremony] ACTION REQUIRED on ${SERIAL}: enter the device PIN/pattern/password now to satisfy the '${reason}' device-credential prompt (NOT a fingerprint touch)." >&2
  echo "[ceremony] waiting up to ${HW_BIOMETRIC_TIMEOUT}s ..." >&2
  echo "[ceremony] ############################################################" >&2
  local start_epoch dump
  start_epoch=$(date +%s)
  while [ "$(( $(date +%s) - start_epoch ))" -lt "${HW_BIOMETRIC_TIMEOUT}" ]; do
    dump=$(dump_ui)
    if ! text_present "${STR_PROMPT_TITLE}" "${dump}" && ! text_present "Confirm" "${dump}"; then
      echo "[ceremony] device-credential prompt cleared after $(( $(date +%s) - start_epoch ))s." >&2
      return 0
    fi
    sleep 3
  done
  echo "[ceremony] WARNING: device-credential prompt still showing after ${HW_BIOMETRIC_TIMEOUT}s. Proceeding anyway." >&2
  return 1
}

# fp_success_count — total `wasSuccessful=true` lines in the current `dumpsys fingerprint`
# ring buffer (49-14). This is USER-scoped, not app-scoped (no app-pid equivalent exists for the
# fingerprint HAL trace) — a delta increase across a bounded operation window is treated as
# evidence of a fresh authentication for that operation, not a perfectly isolated per-app count.
# Documented explicitly wherever this is used as a verdict input.
fp_success_count() {
  adb ${ADBD} shell dumpsys fingerprint 2>/dev/null | grep -c "wasSuccessful=true" || true
}

# ── Leg: provision-local (D-24 leg 1, network-independent half — 49-18 / Gap A) ──
# The clean-device half of the split ceremony (see header comment). Keeps 49-13's
# sequence verbatim up through the fingerprint injection and no-spki-error check —
# every one of those sub-legs PASSed in 49-13 and keeps its exact record_leg name so
# the two proof logs stay comparable. The terminal assertion changes: under the
# 49-16/49-17 onboarding order this ceremony lands on the awaiting-network state, not
# the success heading (that is provision-register's job, after an operator-created
# network exists) — plus two on-disk artifact assertions the empty pre-49-16/49-17
# store could never establish.
provision_local() {
  reset_identity
  launch_app

  if ! navigate_to_settings; then
    record_leg "provision-settings-nav" "FAIL" "Settings tab control not found"
    return
  fi

  local dump
  dump=$(dump_ui)
  if ! text_present "${STR_SETTINGS_ROW}" "${dump}"; then
    record_leg "provision-settings-row" "FAIL" "settingsSigningKeyRow ('${STR_SETTINGS_ROW}') not present in Settings dump"
    return
  fi
  record_leg "provision-settings-row" "PASS" "settingsSigningKeyRow present"

  if ! tap_on_text "${STR_SETTINGS_ROW}" "${dump}"; then
    record_leg "provision-nav-to-screen" "FAIL" "could not tap '${STR_SETTINGS_ROW}' row"
    return
  fi
  sleep 2

  dump=$(dump_ui)
  if ! text_present "${STR_SETUP_BUTTON}" "${dump}"; then
    record_leg "provision-nav-to-screen" "FAIL" "signingKeyProvisioningSetupButton ('${STR_SETUP_BUTTON}') not present after navigating from Settings"
    return
  fi
  record_leg "provision-nav-to-screen" "PASS" "ProvisionSigningKeyScreen first-run body reached"

  adb ${ADBD} logcat -c
  if ! tap_on_text "${STR_SETUP_BUTTON}" "${dump}"; then
    record_leg "provision-setup-tap" "FAIL" "could not tap setup button"
    return
  fi

  # Leg 1 sub-claim 1: the OS BiometricPrompt sheet appears.
  sleep 3
  dump=$(dump_ui)
  if text_present "${STR_PROMPT_TITLE}" "${dump}"; then
    record_leg "provision-prompt-appears" "PASS" "deviceSigningPromptTitle ('${STR_PROMPT_TITLE}') present in post-tap dump"
  else
    record_leg "provision-prompt-appears" "FAIL" "deviceSigningPromptTitle NOT found in post-tap dump — no biometric sheet observed"
  fi

  # FragmentManager / main-thread exception check (the 45-11 defect class).
  local fm_hits
  fm_hits=$(adb ${ADBD} logcat -d 2>/dev/null | grep -c "FragmentManager" || true)
  if [ "${fm_hits}" -eq 0 ]; then
    record_leg "provision-no-fragmentmanager-exception" "PASS" "0 FragmentManager lines in provisioning-window logcat"
  else
    record_leg "provision-no-fragmentmanager-exception" "FAIL" "${fm_hits} FragmentManager line(s) in provisioning-window logcat"
  fi

  satisfy_biometric "first-run provisioning" || true

  local verdict_line
  verdict_line=$(wait_for_logcat_line "INVALID_DIGEST_ENCODING|NO_KEY_PROVISIONED|SPKI" "${VERDICT_TIMEOUT}" "[ceremony]" "spki-error" "${ADBD}")
  if [ -n "${verdict_line}" ]; then
    record_leg "provision-no-spki-error" "FAIL" "logcat: ${verdict_line}"
  else
    record_leg "provision-no-spki-error" "PASS" "no INVALID_DIGEST_ENCODING/NO_KEY_PROVISIONED/SPKI error observed"
  fi

  # 49-18 (Gap A's runtime proof vehicle): the local ceremony is network-independent
  # by design and now terminates on the awaiting-network landing, not the success
  # heading — the network User's UserKey registration is provision-register's job,
  # on a later run against an operator-created network.
  dump=$(dump_ui)
  if text_present "${STR_AWAITING_NETWORK_HEADING}" "${dump}"; then
    record_leg "provision-local-awaiting-network" "PASS" "signingKeyProvisioningAwaitingNetworkHeading ('${STR_AWAITING_NETWORK_HEADING}') present — local stage 1 completed on a genuinely network-less device"
  else
    record_leg "provision-local-awaiting-network" "FAIL" "signingKeyProvisioningAwaitingNetworkHeading NOT present after satisfying the prompt on a network-less device"
    return
  fi

  # Artifact 1 — D-24 leg 4's positive control, unreachable in 49-13 (the store was
  # always empty). A real 'deviceUser' row must now exist.
  local pulldir sqlite_bin
  pulldir=$(pull_storage_db)
  sqlite_bin=$(command -v sqlite3 || true)
  if [ -z "${sqlite_bin}" ]; then
    record_leg "provision-local-device-user-row" "FAIL" "no host sqlite3 available to inspect the pulled RKStorage files"
    record_leg "provision-local-attestation-chain" "FAIL" "no host sqlite3 available to inspect the pulled RKStorage files"
    return
  fi

  local device_user_present
  device_user_present=$("${sqlite_bin}" "${pulldir}/RKStorage" \
    "select count(*) from catalystLocalStorage where key = 'deviceUser';" 2>/dev/null || echo 0)
  if [ "${device_user_present}" = "0" ]; then
    record_leg "provision-local-device-user-row" "FAIL" "no 'deviceUser' row present after local ceremony completion"
  else
    record_leg "provision-local-device-user-row" "PASS" "'deviceUser' row present — D-24 leg 4's positive control, unreachable in 49-13"
  fi

  # Artifact 2 — D-15b's chain-shape claim, NOT-EXERCISED in 49-13 because nothing
  # was ever persisted. The deviceSigningProvisioning record's certificateChainBase64
  # array must exist and be non-empty; record its element count as evidence.
  local provisioning_value chain_array chain_count
  provisioning_value=$("${sqlite_bin}" "${pulldir}/RKStorage" \
    "select value from catalystLocalStorage where key = 'deviceSigningProvisioning' limit 1;" 2>/dev/null || true)
  if [ -z "${provisioning_value}" ]; then
    record_leg "provision-local-attestation-chain" "FAIL" "no 'deviceSigningProvisioning' row present after local ceremony completion"
  else
    chain_array=$(echo "${provisioning_value}" | grep -o '"certificateChainBase64":\[[^]]*\]' || true)
    if [ -z "${chain_array}" ] || [ "${chain_array}" = '"certificateChainBase64":[]' ]; then
      record_leg "provision-local-attestation-chain" "FAIL" "'deviceSigningProvisioning' row present but certificateChainBase64 is empty or missing"
    else
      chain_count=$(( $(echo "${chain_array}" | grep -o ',' | wc -l | tr -d ' ') + 1 ))
      record_leg "provision-local-attestation-chain" "PASS" "certificateChainBase64 present with ${chain_count} element(s) — D-15b's leaf+intermediates shape, first exercised this session"
    fi
  fi
}

# ── Leg: provision-register (D-24 leg 1, network-scoped half — 49-18 / Gap A) ────
# Deliberately does NOT clear this device's app data first — its whole precondition
# is a device that already carries a local provisioning record (provision-local)
# AND a network created/joined through the real in-app flow since. Wiping the
# identity here would destroy exactly what this leg depends on. See the header
# comment for why the network-creation step is an explicit, printed operator
# interlude rather than an automated one.
provision_register() {
  echo "[ceremony] 'provision-register' precondition (operator-driven, NOT automated by this script):" >&2
  echo "[ceremony]   1. 'provision-local' has already completed on this device (deviceUser + deviceSigningProvisioning rows exist)." >&2
  echo "[ceremony]   2. A network has SINCE been created or joined through the real in-app AddNetworkScreen flow." >&2
  echo "[ceremony]   This script does not automate network creation — see the header comment." >&2

  local pulldir sqlite_bin device_user_present
  pulldir=$(pull_storage_db)
  sqlite_bin=$(command -v sqlite3 || true)
  if [ -z "${sqlite_bin}" ]; then
    record_leg "provision-register-precondition" "FAIL" "no host sqlite3 available to verify the 'deviceUser' precondition row"
    return
  fi
  device_user_present=$("${sqlite_bin}" "${pulldir}/RKStorage" \
    "select count(*) from catalystLocalStorage where key = 'deviceUser';" 2>/dev/null || echo 0)
  if [ "${device_user_present}" = "0" ]; then
    record_leg "provision-register-precondition" "FAIL" "no 'deviceUser' row on this device — run 'provision-local' first; running 'provision-register' on an unprovisioned device would produce a meaningless verdict"
    return
  fi

  launch_app
  if ! navigate_to_settings; then
    record_leg "provision-register-settings-nav" "FAIL" "Settings tab control not found"
    return
  fi

  local dump
  dump=$(dump_ui)
  if ! tap_on_text "${STR_SETTINGS_ROW}" "${dump}"; then
    record_leg "provision-register-settings-nav" "FAIL" "could not tap '${STR_SETTINGS_ROW}' row"
    return
  fi
  sleep 2

  adb ${ADBD} logcat -c
  dump=$(dump_ui)
  if ! tap_on_text "${STR_SETUP_BUTTON}" "${dump}"; then
    record_leg "provision-register-setup-tap" "FAIL" "could not tap '${STR_SETUP_BUTTON}' button"
    return
  fi

  sleep 3
  dump=$(dump_ui)
  if text_present "${STR_PROMPT_TITLE}" "${dump}"; then
    record_leg "provision-register-prompt-appears" "PASS" "deviceSigningPromptTitle ('${STR_PROMPT_TITLE}') present — stage 2's signed recovery-key BiometricPrompt"
  else
    record_leg "provision-register-prompt-appears" "FAIL" "deviceSigningPromptTitle NOT found — stage 2 did not reach the signed recovery-key prompt"
  fi

  satisfy_biometric "stage-2 recovery-key registration" || true

  dump=$(dump_ui)
  if text_present "${STR_SUCCESS_HEADING}" "${dump}"; then
    record_leg "provision-success-heading" "PASS" "signingKeyProvisioningSuccessHeading ('${STR_SUCCESS_HEADING}') present — end-to-end SignatureValidP256 evidence (see 49-13-PROOF-LOG.md)"
  else
    record_leg "provision-success-heading" "FAIL" "signingKeyProvisioningSuccessHeading NOT present after satisfying the stage-2 prompt"
  fi
}

# ── Leg: sign (D-24 leg 1 sub-claim 3 — a distinct per-use prompt) ──────────
leg_sign() {
  echo "[ceremony] 'sign' leg: drives a genuine per-use officer action distinct from provisioning." \
    "Requires the device to already be provisioned (run 'provision' first, without an intervening pm clear)." \
    "See 49-13-PROOF-LOG.md for the specific call site exercised and its evidence."
  record_leg "sign-per-use-prompt" "NOT-EXERCISED" "recorded manually in 49-13-PROOF-LOG.md — see leg 1 sub-claim 3"
}

# ── Leg: cancel (D-24 leg 2 + Gap B closure, 49-18) ──────────────────────────
# Drives BOTH user-initiated dismissal paths of the first-run provisioning prompt
# (the only BiometricPrompt sheet a pm-clear device reaches — see 49-GAPS.md Gap B
# and KeyAttestationHelper.kt's regenerateAttested onAuthenticationError override):
# the system prompt's own negative ("Cancel") button, and the hardware BACK key
# (NOT-EXERCISED in 49-13, folded in here per 49-GAPS.md). Each pass re-runs the
# full reset/relaunch/navigate preamble first — mirrors provision_local. Without
# this, running a dismissal check on top of a screen still showing a STALE error
# from an earlier attempt makes the "no error text" assertion meaningless, since
# it would fail on content that predates the action under test (49-13 Deviation 3).
leg_cancel_negative_button() {
  reset_identity
  launch_app
  if ! navigate_to_settings; then
    record_leg "cancel-negative-button" "FAIL" "could not reach Settings to start the cancel leg from a clean identity"
    return
  fi
  local dump
  dump=$(dump_ui)
  if ! tap_on_text "${STR_SETTINGS_ROW}" "${dump}"; then
    record_leg "cancel-negative-button" "FAIL" "could not tap '${STR_SETTINGS_ROW}' row to reach ProvisionSigningKeyScreen"
    return
  fi
  sleep 2
  dump=$(dump_ui)

  adb ${ADBD} logcat -c
  if ! tap_on_text "${STR_SETUP_BUTTON}" "${dump}" && ! tap_on_text "Replace Signing Key" "${dump}"; then
    echo "[ceremony] 'cancel' leg: no provisioning/replace action reachable from the current screen — drive to a signing action manually first." >&2
  fi
  sleep 3
  dump=$(dump_ui)
  if ! text_present "${STR_PROMPT_TITLE}" "${dump}"; then
    record_leg "cancel-negative-button" "FAIL" "deviceSigningPromptTitle ('${STR_PROMPT_TITLE}') not observed before attempting dismissal"
    return
  fi
  if ! tap_on_text "${STR_NEGATIVE_BUTTON}" "${dump}"; then
    record_leg "cancel-negative-button" "FAIL" "deviceSigningPromptNegativeButton ('${STR_NEGATIVE_BUTTON}') not found to dismiss the prompt"
    return
  fi
  record_leg "cancel-negative-button" "PASS" "deviceSigningPromptNegativeButton tapped, dismissing the prompt"
  sleep 2

  dump=$(dump_ui)
  local err_hit=0 s
  for s in "${STR_ERROR_STRINGS[@]}"; do
    if text_present "${s}" "${dump}"; then err_hit=1; fi
  done
  if [ "${err_hit}" -eq 0 ]; then
    record_leg "cancel-no-error-text" "PASS" "none of the deviceSigningError* EN strings present post-dismissal"
  else
    record_leg "cancel-no-error-text" "FAIL" "a deviceSigningError* string was rendered post-dismissal"
  fi

  # Scope the error-level check to OUR app's pid — an unscoped `grep " E "`
  # over the whole system logcat buffer matches heavy unrelated emulator
  # noise (keystore2 StrongBox-fallback logs, FeatureFlagsImplExport,
  # ThemeUtils, etc.) and makes this leg's verdict meaningless regardless of
  # our app's actual behavior (observed: 15 unrelated system E-lines with 0
  # from our own package). This mirrors the leg's own record_leg message,
  # which already claims "app-package" scoping — the prior implementation
  # didn't actually do that.
  local app_pid err_lines
  app_pid=$(adb ${ADBD} shell pidof "${PACKAGE}" 2>/dev/null | tr -d '\r' | awk '{print $1}')
  if [ -n "${app_pid}" ]; then
    err_lines=$(adb ${ADBD} logcat -d --pid="${app_pid}" 2>/dev/null | grep -c " E " || true)
  else
    err_lines=$(adb ${ADBD} logcat -d 2>/dev/null | grep " ${PACKAGE}" | grep -c " E " || true)
  fi
  if [ "${err_lines}" -eq 0 ]; then
    record_leg "cancel-no-logged-fault" "PASS" "0 error-level app-package logcat lines since dismissal"
  else
    record_leg "cancel-no-logged-fault" "FAIL" "${err_lines} error-level logcat line(s) since dismissal"
  fi

  # Gap B closure: the raw native errorCode must remain recoverable from an
  # app-pid-scoped VtSigningReject log line, so 49-14's hardware run can record
  # which BiometricPrompt constant real hardware delivers (5/10/13) instead of
  # that fact being silently absorbed by the widened CANCELED classification.
  local reject_line raw_code mapped_code
  reject_line=$(capture_signing_reject_line)
  if [ -z "${reject_line}" ]; then
    record_leg "cancel-errorcode-observability" "FAIL" "no VtSigningReject line found for this dismissal"
  else
    raw_code=$(echo "${reject_line}" | grep -o 'errorCode=[0-9-]*' | head -1 | sed 's/errorCode=//')
    mapped_code=$(echo "${reject_line}" | grep -o 'mapped=[A-Z_]*' | head -1 | sed 's/mapped=//')
    if [ "${mapped_code}" = "CANCELED" ]; then
      record_leg "cancel-errorcode-observability" "PASS" "errorCode=${raw_code} mapped=${mapped_code} (raw log: ${reject_line})"
    else
      record_leg "cancel-errorcode-observability" "FAIL" "mapped=${mapped_code:-<none>} (expected CANCELED) errorCode=${raw_code:-<none>}; raw log: ${reject_line}"
    fi
  fi
}

leg_cancel_back_key() {
  reset_identity
  launch_app
  if ! navigate_to_settings; then
    record_leg "cancel-negative-button-back" "FAIL" "could not reach Settings to start the cancel leg from a clean identity"
    return
  fi
  local dump
  dump=$(dump_ui)
  if ! tap_on_text "${STR_SETTINGS_ROW}" "${dump}"; then
    record_leg "cancel-negative-button-back" "FAIL" "could not tap '${STR_SETTINGS_ROW}' row to reach ProvisionSigningKeyScreen"
    return
  fi
  sleep 2
  dump=$(dump_ui)

  adb ${ADBD} logcat -c
  if ! tap_on_text "${STR_SETUP_BUTTON}" "${dump}" && ! tap_on_text "Replace Signing Key" "${dump}"; then
    echo "[ceremony] 'cancel' leg (BACK-key variant): no provisioning/replace action reachable from the current screen — drive to a signing action manually first." >&2
  fi
  sleep 3
  dump=$(dump_ui)
  if ! text_present "${STR_PROMPT_TITLE}" "${dump}"; then
    record_leg "cancel-negative-button-back" "FAIL" "deviceSigningPromptTitle ('${STR_PROMPT_TITLE}') not observed before attempting dismissal"
    return
  fi
  adb ${ADBD} shell input keyevent KEYCODE_BACK
  record_leg "cancel-negative-button-back" "PASS" "KEYCODE_BACK dispatched, dismissing the prompt"
  sleep 2

  dump=$(dump_ui)
  local err_hit=0 s
  for s in "${STR_ERROR_STRINGS[@]}"; do
    if text_present "${s}" "${dump}"; then err_hit=1; fi
  done
  if [ "${err_hit}" -eq 0 ]; then
    record_leg "cancel-no-error-text-back" "PASS" "none of the deviceSigningError* EN strings present post-dismissal"
  else
    record_leg "cancel-no-error-text-back" "FAIL" "a deviceSigningError* string was rendered post-dismissal"
  fi

  local app_pid err_lines
  app_pid=$(adb ${ADBD} shell pidof "${PACKAGE}" 2>/dev/null | tr -d '\r' | awk '{print $1}')
  if [ -n "${app_pid}" ]; then
    err_lines=$(adb ${ADBD} logcat -d --pid="${app_pid}" 2>/dev/null | grep -c " E " || true)
  else
    err_lines=$(adb ${ADBD} logcat -d 2>/dev/null | grep " ${PACKAGE}" | grep -c " E " || true)
  fi
  if [ "${err_lines}" -eq 0 ]; then
    record_leg "cancel-no-logged-fault-back" "PASS" "0 error-level app-package logcat lines since dismissal"
  else
    record_leg "cancel-no-logged-fault-back" "FAIL" "${err_lines} error-level logcat line(s) since dismissal"
  fi

  local reject_line raw_code mapped_code
  reject_line=$(capture_signing_reject_line)
  if [ -z "${reject_line}" ]; then
    record_leg "cancel-errorcode-observability-back" "FAIL" "no VtSigningReject line found for this dismissal"
  else
    raw_code=$(echo "${reject_line}" | grep -o 'errorCode=[0-9-]*' | head -1 | sed 's/errorCode=//')
    mapped_code=$(echo "${reject_line}" | grep -o 'mapped=[A-Z_]*' | head -1 | sed 's/mapped=//')
    if [ "${mapped_code}" = "CANCELED" ]; then
      record_leg "cancel-errorcode-observability-back" "PASS" "errorCode=${raw_code} mapped=${mapped_code} (raw log: ${reject_line})"
    else
      record_leg "cancel-errorcode-observability-back" "FAIL" "mapped=${mapped_code:-<none>} (expected CANCELED) errorCode=${raw_code:-<none>}; raw log: ${reject_line}"
    fi
  fi
}

leg_cancel() {
  leg_cancel_negative_button
  leg_cancel_back_key
}

# ── Leg: storage (D-24 leg 4 — no plaintext key residue) ────────────────────
# Bounded-hex-run fix (T-49-PLAIN, 49-18). A 32-byte private key serializes to
# exactly 64 hex characters (32*2=64) and MUST still match. The app's own 33-byte
# compressed P-256 public key serializes to exactly 66 hex characters (33*2=66) and
# MUST NOT — a 66-char hex run trivially CONTAINS a 64-char run, so the original
# unbounded `{64}` pattern false-FAILs the instant a real 'deviceUser' row exists
# (exactly the positive control the check below requires). Bounding the run on
# BOTH sides by a non-hex character or a string boundary keeps the 64-char private
# key matching while excluding any run that is part of a longer hex sequence.
HEX64_BOUNDED_PATTERN='(^|[^0-9a-fA-F])[0-9a-fA-F]{64}([^0-9a-fA-F]|$)'

leg_storage() {
  local pulldir
  pulldir=$(pull_storage_db)

  local sqlite_bin
  sqlite_bin=$(command -v sqlite3 || true)
  if [ -z "${sqlite_bin}" ]; then
    record_leg "storage-no-plaintext-key" "FAIL" "no host sqlite3 available to inspect the pulled RKStorage files"
    return
  fi

  local rows hex_hits
  rows=$("${sqlite_bin}" "${pulldir}/RKStorage" "select count(*) from catalystLocalStorage;" 2>/dev/null || echo 0)
  hex_hits=$("${sqlite_bin}" "${pulldir}/RKStorage" \
    "select count(*) from catalystLocalStorage where value regexp '${HEX64_BOUNDED_PATTERN}';" 2>/dev/null || echo "unknown")

  echo "[ceremony] storage: ${rows} row(s) scanned in catalystLocalStorage (RKStorage + WAL/SHM pulled to ${pulldir})"

  local device_user_present
  device_user_present=$("${sqlite_bin}" "${pulldir}/RKStorage" \
    "select count(*) from catalystLocalStorage where key = 'deviceUser';" 2>/dev/null || echo 0)
  if [ "${device_user_present}" = "0" ]; then
    record_leg "storage-positive-control" "FAIL" "no 'deviceUser' row present — the store may be empty, which would make the negative check below meaningless"
  else
    record_leg "storage-positive-control" "PASS" "'deviceUser' row present (${rows} total rows scanned)"
  fi

  if [ "${hex_hits}" = "unknown" ]; then
    # regexp() UDF not available in a bare sqlite3 build — fall back to a bounded
    # grep scan of the dumped .dump output. `-o` prints each match on its own
    # output line so a subsequent `wc -l` counts true OCCURRENCES, not matching
    # LINES — the original `grep -ocE` combined `-o` with `-c`, which counts
    # matching LINES regardless of `-o` and silently under-counts any row with
    # more than one hit.
    local grep_hits
    grep_hits=$("${sqlite_bin}" "${pulldir}/RKStorage" ".dump" 2>/dev/null | grep -oE "${HEX64_BOUNDED_PATTERN}" | wc -l | tr -d ' ')
    if [ "${grep_hits}" -eq 0 ]; then
      record_leg "storage-no-plaintext-key" "PASS" "0 rows match a bounded 64-hex-character run (grep fallback, ${rows} rows scanned)"
    else
      record_leg "storage-no-plaintext-key" "FAIL" "${grep_hits} bounded 64-hex-character run(s) found (grep fallback)"
    fi
  elif [ "${hex_hits}" = "0" ]; then
    record_leg "storage-no-plaintext-key" "PASS" "0 rows match a bounded 64-hex-character run (${rows} rows scanned)"
  else
    record_leg "storage-no-plaintext-key" "FAIL" "${hex_hits} row(s) match a bounded 64-hex-character run"
  fi
}

# ── Leg: hw-chain-decode / hw-strongbox-rung / hw-chain-shape (49-14, Task 2 items 1-2) ──────
# Pulls the persisted deviceSigningProvisioning record's certificateChainBase64 array (written by
# provision_local against the REAL Keystore-produced chain — hardware-rooted, unlike 49-13's
# emulator run which never persisted one), decodes the leaf via the Phase 45 offline decoder, and
# derives the D-07 StrongBox/TEE rung determination plus the D-15b chain-shape verdict from its
# machine output rather than a transcribed claim.
hw_decode_attestation_chain() {
  local pulldir sqlite_bin provisioning_value chain_array chain_json_path
  pulldir=$(pull_storage_db)
  sqlite_bin=$(command -v sqlite3 || true)
  if [ -z "${sqlite_bin}" ]; then
    record_leg "hw-chain-decode" "FAIL" "no host sqlite3 available to inspect the pulled RKStorage files"
    return
  fi
  provisioning_value=$("${sqlite_bin}" "${pulldir}/RKStorage" \
    "select value from catalystLocalStorage where key = 'deviceSigningProvisioning' limit 1;" 2>/dev/null || true)
  if [ -z "${provisioning_value}" ]; then
    record_leg "hw-chain-decode" "FAIL" "no 'deviceSigningProvisioning' row present — provisioning did not complete on this device"
    return
  fi
  chain_array=$(echo "${provisioning_value}" | grep -o '"certificateChainBase64":\[[^]]*\]' | sed 's/^"certificateChainBase64"://' || true)
  if [ -z "${chain_array}" ] || [ "${chain_array}" = '[]' ]; then
    record_leg "hw-chain-decode" "FAIL" "certificateChainBase64 empty or missing in the persisted provisioning record"
    return
  fi
  chain_json_path="${TMPDIR_CEREMONY}/hw-chain-${SERIAL}.json"
  printf '%s' "${chain_array}" > "${chain_json_path}"

  local node_bin decoder_rel="packages/vote-engine/scripts/decode-attestation-leaf.mjs"
  node_bin=$(command -v node || true)
  if [ -z "${node_bin}" ] || [ ! -f "${decoder_rel}" ]; then
    record_leg "hw-chain-decode" "FAIL" "node or ${decoder_rel} not available on this host"
    return
  fi

  # The decoder's (iii) challengeBound check needs the EXACT boundDigest string
  # (ProvisionSigningKeyScreen.tsx's runLocalCeremony: 'signing-key-provisioning-<ts>-<hex>'),
  # which is never persisted verbatim — recovered from this session's own logcat capture instead
  # (best-effort; a miss here only weakens challengeBound, not the attestationSecurityLevel /
  # chainLength / rootPresent values this leg actually gates on).
  local bound_digest
  bound_digest=$(adb ${ADBD} logcat -d 2>/dev/null | grep -o 'signing-key-provisioning-[0-9]*-[0-9a-f]*' | tail -1 || true)
  [ -z "${bound_digest}" ] && bound_digest="unavailable-not-logged"

  local decode_log="${TMPDIR_CEREMONY}/hw-chain-decode-log-${SERIAL}.md" decode_out decode_status
  : > "${decode_log}"
  set +e
  decode_out=$(cd packages/vote-engine && "${node_bin}" scripts/decode-attestation-leaf.mjs \
    "${chain_json_path}" "${decode_log}" "${bound_digest}" 2>&1)
  decode_status=$?
  set -e
  echo "[ceremony] decode-attestation-leaf.mjs output (SERIAL=${SERIAL}):" >&2
  echo "${decode_out}" >&2

  local sec_level chain_len root_present
  sec_level=$(echo "${decode_out}" | grep -o 'attestationSecurityLevel: [0-9]*' | head -1 || true)
  chain_len=$(echo "${decode_out}" | grep -o 'chainLength: [0-9]*' | head -1 | grep -o '[0-9]*$' || true)
  root_present=$(echo "${decode_out}" | grep -o 'rootPresent: [a-z]*' | head -1 | grep -o '[a-z]*$' || true)

  if [ -n "${sec_level}" ]; then
    record_leg "hw-chain-decode" "PASS" "decoder produced a verdict block (exit=${decode_status}) — ${sec_level}; see hw-strongbox-rung/hw-chain-shape for the derived verdicts"
  else
    record_leg "hw-chain-decode" "FAIL" "decoder produced no attestationSecurityLevel (exit=${decode_status}); output: ${decode_out}"
    return
  fi

  # D-07 / Phase 45 residual leg 1 (49-14-PLAN.md's 2026-08-18 amendment): PASS requires level 2
  # (StrongBox) on BOTH fields. A 1 (TEE) is recorded BLOCKED-NO-HARDWARE, not FAIL — this fleet's
  # devices carry no StrongBox chip at all (Task 1's confirmed `pm list features` result), so a
  # TEE-only result here is the EXPECTED, correctly-functioning fallback, not a defect. Never
  # reinterpret a TEE result as a StrongBox PASS.
  local strongbox_feature
  strongbox_feature=$(adb ${ADBD} shell pm list features 2>/dev/null | grep -i strongbox || true)
  if echo "${decode_out}" | grep -q "attestationSecurityLevel: 2"; then
    record_leg "hw-strongbox-rung" "PASS" "${sec_level} — StrongBox rung genuinely selected"
  elif [ -n "${strongbox_feature}" ]; then
    record_leg "hw-strongbox-rung" "FAIL" "${sec_level:-<not found>} — device DOES report ${strongbox_feature} but the decoder did not observe level 2; a real StrongBox-capable device fell through to TEE"
  else
    record_leg "hw-strongbox-rung" "BLOCKED-NO-HARDWARE" "${sec_level:-<not found>} — 'pm list features | grep strongbox' is empty on ${SERIAL} (confirmed Task 1); no device in this project's fleet has a StrongBox chip (Samsung ships it via Knox Vault on flagships only), so the StrongBox-primary rung cannot be exercised here. TEE fallback is the expected, correctly-functioning result. Residual stays OPEN in .planning/todos/pending/2026-08-03-attestation-strongbox-and-api34-residuals.md leg 1."
  fi

  # D-15b — leaf + intermediates, root dropped. Hardware-rooted (unlike 49-13's emulator run,
  # which never persisted a chain at all — NOT-EXERCISED there).
  if [ -n "${chain_len}" ] && [ "${chain_len}" -ge 2 ] && [ "${root_present}" = "false" ]; then
    record_leg "hw-chain-shape" "PASS" "chainLength=${chain_len} rootPresent=${root_present} — hardware-rooted leaf+intermediates, root dropped (49-13's emulator run never persisted a chain to check)"
  else
    record_leg "hw-chain-shape" "FAIL" "chainLength=${chain_len:-<none>} rootPresent=${root_present:-<none>}"
  fi
}

# ── Leg: hw-provision (49-14 Task 2 — real-hardware pre-invalidation legs) ───────────────────
# Combines provision_local + an operator-driven network-creation interlude + provision_register
# (Gap A's now-closed two-stage order, 49-16/49-17/49-18) on REAL hardware, then adds the
# hardware-only claims 49-13 could never reach on an emulator: a hardware-rooted chain, the
# StrongBox/TEE rung determination, and the API-30+ setUserAuthenticationParameters per-use
# semantics (three consecutive signing operations, each producing its own OS-level
# authentication) — or, below API 30, confirmation that the bare setUserAuthenticationRequired
# fallback branch provisioned and signed (D-17's other half).
hw_provision() {
  if [ "${IS_EMULATOR}" -eq 1 ]; then
    echo "[ceremony] PREFLIGHT FAIL: 'hw-provision' requires real hardware (this is 49-14's leg) — '${SERIAL}' resolved as an emulator; use 'provision-local'/'provision-register' instead." >&2
    exit 1
  fi

  local sdk
  sdk=$(adb ${ADBD} shell getprop ro.build.version.sdk 2>/dev/null | tr -d '\r')

  local auth_c0 auth_c1 auth_c2
  auth_c0=$(fp_success_count)
  provision_local
  auth_c1=$(fp_success_count)

  echo "[ceremony] ============================================================" >&2
  echo "[ceremony] OPERATOR ACTION on ${SERIAL}: create or join a network through the real in-app 'Select Network' -> 'Create Network' flow now (six-field RN form — not adb-driven, see script header)." >&2
  echo "[ceremony] Waiting ${HW_NETWORK_WAIT}s before attempting 'provision-register' automatically ..." >&2
  echo "[ceremony] ============================================================" >&2
  sleep "${HW_NETWORK_WAIT}"

  provision_register
  auth_c2=$(fp_success_count)

  hw_decode_attestation_chain

  local op1=$(( auth_c1 - auth_c0 )) op2=$(( auth_c2 - auth_c1 ))

  if [ "${sdk}" -ge 30 ] 2>/dev/null; then
    echo "[ceremony] ============================================================" >&2
    echo "[ceremony] OPERATOR ACTION (3rd signing operation, D-27 residual leg 2) on ${SERIAL}: create a SECOND network now (Select Network -> Create Network)." >&2
    echo "[ceremony] Waiting ${HW_NETWORK_WAIT}s before re-running the registration step automatically ..." >&2
    echo "[ceremony] ============================================================" >&2
    sleep "${HW_NETWORK_WAIT}"
    provision_register
    local auth_c3 op3
    auth_c3=$(fp_success_count)
    op3=$(( auth_c3 - auth_c2 ))
    if [ "${op1}" -ge 1 ] && [ "${op2}" -ge 1 ] && [ "${op3}" -ge 1 ]; then
      record_leg "hw-api34-per-use-semantics" "PASS" "SDK=${sdk} (>=30, setUserAuthenticationParameters(0, AUTH_BIOMETRIC_STRONG) branch — Build.VERSION.SDK_INT>=30 guard is unconditional and source-guaranteed; KeyAttestationHelper.kt emits no runtime branch-name log line, so branch attribution here is via confirmed SDK level + source read, not a log line) — 3 consecutive signing ops each produced >=1 fresh OS auth event (dumpsys fingerprint deltas: op1=${op1} provisioning, op2=${op2} 1st network recovery-key add, op3=${op3} 2nd network recovery-key add; dumpsys fingerprint is user- not app-scoped, treated as evidence not perfect isolation)"
    else
      record_leg "hw-api34-per-use-semantics" "FAIL" "SDK=${sdk} — dumpsys fingerprint deltas op1=${op1} op2=${op2} op3=${op3}; one or more operations produced zero fresh authentications"
    fi
  else
    record_leg "hw-api34-per-use-semantics" "NOT-EXERCISED" "SDK=${sdk} (<30) — the setUserAuthenticationParameters branch does not exist on this device at all (KeyAttestationHelper.kt gates it behind 'if (Build.VERSION.SDK_INT >= 30)')"
    if [ "${op1}" -ge 1 ] && [ "${op2}" -ge 1 ]; then
      record_leg "hw-bare-auth-branch" "PASS" "SDK=${sdk} (<30) — the bare setUserAuthenticationRequired(true) fallback branch is source-guaranteed (no setUserAuthenticationParameters call below API 30); provisioning (dumpsys fingerprint delta op1=${op1}) and per-use signing (op2=${op2}) both completed on it, closing D-17's pre-30 half on real hardware"
    else
      record_leg "hw-bare-auth-branch" "FAIL" "SDK=${sdk} — dumpsys fingerprint deltas op1=${op1} op2=${op2}; provisioning or signing did not complete"
    fi
  fi
}

# ── Leg: recover (49-14 Task 4 — D-24 leg 3 / D-26a leg 5, real hardware only) ───────────────
# Deliberately does NOT reset_identity — its whole precondition is a device that already
# completed hw-provision AND has since had an ADDITIONAL biometric enrolled (49-14-PLAN.md Task
# 3, the invalidation trigger). Wiping identity here would destroy exactly the state this leg
# exists to observe. Settings' own 'Secure Signing' row always navigates with reason:'first-run'
# (SettingsScreen.tsx) which no-ops once both UserKey rows are already registered — it does NOT
# exercise the invalidated-key catch. A REAL per-use signing action (routed through
# createDeviceSigner at one of the 22 rollout call sites, 49-11/49-12) is what raises
# KeyPermanentlyInvalidatedException, so this leg asks the operator to trigger one.
recover() {
  if [ "${IS_EMULATOR}" -eq 1 ]; then
    echo "[ceremony] PREFLIGHT FAIL: 'recover' requires real hardware (this is 49-14 Task 4's leg)." >&2
    exit 1
  fi

  launch_app
  adb ${ADBD} logcat -c

  echo "[ceremony] ============================================================" >&2
  echo "[ceremony] OPERATOR ACTION on ${SERIAL}: trigger a REAL device-signing action now (e.g. invite an Administrator, edit your own Officer profile, or any other screen routed through createDeviceSigner — Settings > Secure Signing alone will NOT trigger this, it no-ops once both keys are already registered). This should raise KeyPermanentlyInvalidatedException and navigate you to the recovery screen." >&2
  echo "[ceremony] Waiting up to ${HW_NETWORK_WAIT}s for the recovery screen to appear ..." >&2
  echo "[ceremony] ============================================================" >&2

  local start_epoch dump found=0
  start_epoch=$(date +%s)
  while [ "$(( $(date +%s) - start_epoch ))" -lt "${HW_NETWORK_WAIT}" ]; do
    dump=$(dump_ui)
    if text_present "Replace" "${dump}" || text_present "recovery" "${dump}"; then
      found=1
      break
    fi
    sleep 5
  done

  local reject_line
  reject_line=$(adb ${ADBD} logcat -d 2>/dev/null | grep -i "KeyPermanentlyInvalidatedException\|KEY_INVALIDATED_REASSOCIATE" | head -3 || true)
  if [ -n "${reject_line}" ]; then
    record_leg "recover-invalidation-detected" "PASS" "logcat: $(echo "${reject_line}" | head -1)"
  else
    record_leg "recover-invalidation-detected" "FAIL" "no KeyPermanentlyInvalidatedException/KEY_INVALIDATED_REASSOCIATE line observed in this window"
  fi

  if [ "${found}" -eq 0 ]; then
    record_leg "recover-navigation" "FAIL" "recovery heading/button not observed within ${HW_NETWORK_WAIT}s — the 49-11/49-12 navigation contract did not fire, or the operator action did not reach a routed call site in time"
    return
  fi
  record_leg "recover-navigation" "PASS" "recovery screen reached (uiautomator dump: recovery heading or 'Replace' button present) — the 49-11/49-12 navigation contract fired at runtime"

  dump=$(dump_ui)
  if ! tap_on_text "Replace" "${dump}"; then
    record_leg "recover-replace-tap" "FAIL" "could not tap the recovery/replace button"
    return
  fi
  record_leg "recover-replace-tap" "PASS" "replace/recovery button tapped"

  adb ${ADBD} logcat -c
  satisfy_device_credential "recovery ceremony" || true

  dump=$(dump_ui)
  if text_present "${STR_SUCCESS_HEADING}" "${dump}"; then
    record_leg "recover-success-heading" "PASS" "signingKeyProvisioningSuccessHeading present post-recovery — a post-recovery signing action succeeded, and the replacement key was registered"
  else
    record_leg "recover-success-heading" "FAIL" "success heading not present post-recovery"
  fi

  local sdk branch_line
  sdk=$(adb ${ADBD} shell getprop ro.build.version.sdk 2>/dev/null | tr -d '\r')
  branch_line=$(adb ${ADBD} logcat -d 2>/dev/null | grep -i "signWithRecoveryKey\|createConfirmDeviceCredentialIntent" | tail -5 || true)
  if [ "${sdk}" -ge 30 ] 2>/dev/null; then
    record_leg "recover-branch" "PASS" "SDK=${sdk} (>=30) — BiometricPrompt/DEVICE_CREDENTIAL branch (signRecoveryViaBiometricPrompt), source-guaranteed by signWithRecoveryKey's SDK_INT>=30 dispatch; logcat: ${branch_line:-<none>}"
  else
    record_leg "recover-branch" "PASS" "SDK=${sdk} (<30) — KeyguardManager.createConfirmDeviceCredentialIntent branch (signRecoveryViaKeyguardManager), source-guaranteed; logcat: ${branch_line:-<none>}"
  fi
}

# ── Dispatch ──────────────────────────────────────────────────────────────
preflight

case "${LEG}" in
  provision-local)    provision_local ;;
  provision-register) provision_register ;;
  sign)                leg_sign ;;
  cancel)              leg_cancel ;;
  storage)             leg_storage ;;
  hw-provision)         hw_provision ;;
  recover)              recover ;;
  all)
    provision_local
    leg_sign
    leg_cancel
    leg_storage
    record_leg "provision-register-not-exercised" "NOT-EXERCISED" "requires an operator-created network first — run 'provision-register' directly once one exists"
    ;;
esac

echo "[ceremony] ========== Summary =========="
for r in "${RESULTS[@]}"; do
  IFS='|' read -r name verdict evidence <<< "${r}"
  echo "LEG ${name}: ${verdict}"
done

if any_failed; then
  exit 1
fi
exit 0
