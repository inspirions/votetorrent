#!/usr/bin/env bash
#
# typecheck-ios.sh — compile-gate the iOS TurboModule without an Xcode project.
#
# The Swift here cannot be exercised at runtime without an Apple Developer Team ID and a physical
# iPhone (DCAppAttestService.isSupported is false on the Simulator, always). A typecheck is
# therefore the ONLY automated signal available, and it is worth having: it catches API drift when
# the iOS SDK moves, which is otherwise invisible until someone finally builds the app.
#
# It typechecks against the real iOS SDK, not macOS — availability annotations differ
# (DCAppAttestService is iOS 14+), so a macOS-SDK pass would prove less than it appears to.
#
# Skips cleanly (exit 0) where no Xcode is installed, so it can live in CI on Linux runners.
#
# KNOWN BLIND SPOT — MEASURED 2026-08-25. The SHIM below defines RCTPromiseResolveBlock and
# RCTPromiseRejectBlock so the module can typecheck without RN headers. That means this gate
# CANNOT detect a MISSING `import React` in the module: the shim silently supplies exactly the
# types the real build would demand from React, so the file passes here and fails under
# `xcodebuild` with "cannot find type 'RCTPromiseResolveBlock' in scope". That is not a
# hypothetical — it is precisely what happened the first time this package was actually podded
# into the voter app, after this gate had been reporting PASS for the entire phase.
#
# Treat a PASS here as "the Apple SDK APIs still line up", NOT as "this compiles in an app".
# The only authoritative gate is an `xcodebuild` of an app that pods this package.
set -uo pipefail
cd "$(dirname "$0")/.."

if [ -z "${DEVELOPER_DIR:-}" ]; then
  for candidate in /Applications/Xcode*.app; do
    [ -d "$candidate/Contents/Developer" ] && export DEVELOPER_DIR="$candidate/Contents/Developer" && break
  done
fi

if ! xcrun --sdk iphoneos --show-sdk-path >/dev/null 2>&1; then
  echo "typecheck-ios: no iOS SDK available — SKIPPED (this is not a failure)"
  exit 0
fi

SDK=$(xcrun --sdk iphoneos --show-sdk-path)
SHIM=$(mktemp -t rnshim.XXXXXX).swift
cat > "$SHIM" <<'SWIFT'
// React Native supplies these two at build time; stand-ins so the module can be typechecked
// standalone, without the RN headers or an Xcode project.
import Foundation
public typealias RCTPromiseResolveBlock = (Any?) -> Void
public typealias RCTPromiseRejectBlock = (String?, String?, Error?) -> Void
SWIFT

xcrun --sdk iphoneos swiftc -typecheck \
  -target arm64-apple-ios15.1 -sdk "$SDK" \
  ios/AttestationNativeModule.swift ios/SignatureEncoding.swift "$SHIM"
STATUS=$?
rm -f "$SHIM"

if [ $STATUS -eq 0 ]; then
  echo "typecheck-ios: PASS against $(basename "$SDK")"
else
  echo "typecheck-ios: FAIL"
fi
exit $STATUS
