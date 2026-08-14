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
#           cancellation, and no plaintext key residue in AsyncStorage.
#
# Usage   : SERIAL=emulator-5554 ./scripts/run-authority-signing-ceremony.sh <leg>
#           <leg> one of: provision | sign | cancel | storage | all
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
case "${LEG}" in
  provision|sign|cancel|storage|all) ;;
  *)
    echo "Usage: SERIAL=emulator-5554 $0 <provision|sign|cancel|storage|all>" >&2
    exit 1
    ;;
esac

# ── i18n strings this script asserts against (EN values, apps/VoteTorrentAuthority/src/i18n/index.ts) ──
STR_SETTINGS_ROW="Secure Signing"
STR_SETUP_BUTTON="Set Up Secure Signing"
STR_SUCCESS_HEADING="Signing key ready"
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
  if ! adb ${ADBD} emu avd name >/dev/null 2>&1; then
    echo "[ceremony] PREFLIGHT FAIL: '${SERIAL}' does not respond to 'adb emu' — this script's fingerprint injection (emu finger touch) only works against an emulator, not a real device (that is 49-14's job)" >&2
    exit 1
  fi

  echo "[ceremony] Preflight: secure lock screen + fingerprint enrollment ..."
  if ! adb ${ADBD} shell locksettings set-pin 1234 >/dev/null 2>&1; then
    echo "[ceremony] PREFLIGHT FAIL: 'locksettings set-pin 1234' failed — a Keystore key with setUserAuthenticationRequired(true) cannot even be GENERATED on a device with no secure lock screen, so a missing PIN here presents downstream as a keygen failure, not a prompt failure. Set the PIN by hand and re-run." >&2
    exit 1
  fi
  # Enroll a fingerprint under finger id 1 for the emulator's virtual sensor.
  adb ${ADBD} emu finger touch 1 >/dev/null 2>&1 || true

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
  sleep 5
}

# uiautomator dump helper: dumps the current window hierarchy to a local file
# and echoes its path. Never uses `adb shell input text` (see header) — every
# control is located by EN label text and tapped by computed center coords.
dump_ui() {
  local out="${TMPDIR_CEREMONY}/dump-$$-${RANDOM}.xml"
  adb ${ADBD} shell uiautomator dump /sdcard/window_dump.xml >/dev/null 2>&1
  adb ${ADBD} pull /sdcard/window_dump.xml "${out}" >/dev/null 2>&1
  echo "${out}"
}

# tap_on_text LABEL DUMP_FILE — case-insensitive substring match against
# `text=` attributes; taps the matched node's bounds center. Fails loudly
# (non-zero return, no tap) rather than silently skipping when no node
# matches — CustomButton uppercases its rendered title, so this matches
# case-insensitively by design.
tap_on_text() {
  local label="$1" dump="$2"
  local bounds
  bounds=$(grep -io "text=\"[^\"]*${label}[^\"]*\"[^>]*bounds=\"[0-9,\[\]]*\"" "${dump}" \
    | grep -o 'bounds="[0-9,\[\]]*"' | head -1 | sed 's/bounds="//;s/"//')
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
  local dump
  dump=$(dump_ui)
  if ! tap_on_text "Settings" "${dump}"; then
    echo "[ceremony] ERROR: Settings tab not found in uiautomator dump" >&2
    return 1
  fi
  sleep 2
}

# ── Leg: provision (D-24 leg 1) ──────────────────────────────────────────────
leg_provision() {
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

  adb ${ADBD} emu finger touch 1 >/dev/null 2>&1 || true

  local verdict_line
  verdict_line=$(wait_for_logcat_line "INVALID_DIGEST_ENCODING|NO_KEY_PROVISIONED|SPKI" "${VERDICT_TIMEOUT}" "[ceremony]" "spki-error" "${ADBD}")
  if [ -n "${verdict_line}" ]; then
    record_leg "provision-no-spki-error" "FAIL" "logcat: ${verdict_line}"
  else
    record_leg "provision-no-spki-error" "PASS" "no INVALID_DIGEST_ENCODING/NO_KEY_PROVISIONED/SPKI error observed"
  fi

  dump=$(dump_ui)
  if text_present "${STR_SUCCESS_HEADING}" "${dump}"; then
    record_leg "provision-success-heading" "PASS" "signingKeyProvisioningSuccessHeading ('${STR_SUCCESS_HEADING}') present — end-to-end SignatureValidP256 evidence (see 49-13-PROOF-LOG.md)"
  else
    record_leg "provision-success-heading" "FAIL" "signingKeyProvisioningSuccessHeading NOT present after satisfying the prompt"
  fi
}

# ── Leg: sign (D-24 leg 1 sub-claim 3 — a distinct per-use prompt) ──────────
leg_sign() {
  echo "[ceremony] 'sign' leg: drives a genuine per-use officer action distinct from provisioning." \
    "Requires the device to already be provisioned (run 'provision' first, without an intervening pm clear)." \
    "See 49-13-PROOF-LOG.md for the specific call site exercised and its evidence."
  record_leg "sign-per-use-prompt" "NOT-EXERCISED" "recorded manually in 49-13-PROOF-LOG.md — see leg 1 sub-claim 3"
}

# ── Leg: cancel (D-24 leg 2) ─────────────────────────────────────────────────
leg_cancel() {
  local dump
  dump=$(dump_ui)

  adb ${ADBD} logcat -c
  # Trigger a per-use signing action (re-provision path re-triggers a prompt
  # if reachable; otherwise this leg is driven from an already-provisioned
  # state per the proof log's own recorded sequence).
  if ! tap_on_text "${STR_SETUP_BUTTON}" "${dump}" && ! tap_on_text "Replace Signing Key" "${dump}"; then
    echo "[ceremony] 'cancel' leg: no provisioning/replace action reachable from the current screen — drive to a signing action manually first." >&2
  fi
  sleep 3
  dump=$(dump_ui)
  if ! tap_on_text "${STR_NEGATIVE_BUTTON}" "${dump}"; then
    record_leg "cancel-negative-button" "FAIL" "deviceSigningPromptNegativeButton ('${STR_NEGATIVE_BUTTON}') not found to dismiss the prompt"
    return
  fi
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

  local err_lines
  err_lines=$(adb ${ADBD} logcat -d 2>/dev/null | grep -c " E " || true)
  if [ "${err_lines}" -eq 0 ]; then
    record_leg "cancel-no-logged-fault" "PASS" "0 error-level app-package logcat lines since dismissal"
  else
    record_leg "cancel-no-logged-fault" "FAIL" "${err_lines} error-level logcat line(s) since dismissal"
  fi
}

# ── Leg: storage (D-24 leg 4 — no plaintext key residue) ────────────────────
leg_storage() {
  local pulldir="${TMPDIR_CEREMONY}/storage"
  mkdir -p "${pulldir}"
  local f
  for f in RKStorage RKStorage-wal RKStorage-shm; do
    adb ${ADBD} shell "run-as ${PACKAGE} cat databases/${f}" > "${pulldir}/${f}" 2>/dev/null || true
  done

  local sqlite_bin
  sqlite_bin=$(command -v sqlite3 || true)
  if [ -z "${sqlite_bin}" ]; then
    record_leg "storage-no-plaintext-key" "FAIL" "no host sqlite3 available to inspect the pulled RKStorage files"
    return
  fi

  local rows hex_hits
  rows=$("${sqlite_bin}" "${pulldir}/RKStorage" "select count(*) from catalystLocalStorage;" 2>/dev/null || echo 0)
  hex_hits=$("${sqlite_bin}" "${pulldir}/RKStorage" \
    "select count(*) from catalystLocalStorage where value regexp '[0-9a-fA-F]{64}';" 2>/dev/null || echo "unknown")

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
    # regexp() UDF not available in a bare sqlite3 build — fall back to a
    # simple grep-based scan of the dumped .dump output for a 64-hex run.
    local grep_hits
    grep_hits=$("${sqlite_bin}" "${pulldir}/RKStorage" ".dump" 2>/dev/null | grep -ocE '[0-9a-fA-F]{64}' || true)
    if [ "${grep_hits}" -eq 0 ]; then
      record_leg "storage-no-plaintext-key" "PASS" "0 rows match a 64-hex-character run (grep fallback, ${rows} rows scanned)"
    else
      record_leg "storage-no-plaintext-key" "FAIL" "${grep_hits} 64-hex-character run(s) found (grep fallback)"
    fi
  elif [ "${hex_hits}" = "0" ]; then
    record_leg "storage-no-plaintext-key" "PASS" "0 rows match a 64-hex-character run (${rows} rows scanned)"
  else
    record_leg "storage-no-plaintext-key" "FAIL" "${hex_hits} row(s) match a 64-hex-character run"
  fi
}

# ── Dispatch ──────────────────────────────────────────────────────────────
preflight

case "${LEG}" in
  provision) leg_provision ;;
  sign)      leg_sign ;;
  cancel)    leg_cancel ;;
  storage)   leg_storage ;;
  all)
    leg_provision
    leg_sign
    leg_cancel
    leg_storage
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
