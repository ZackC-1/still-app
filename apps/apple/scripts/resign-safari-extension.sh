#!/usr/bin/env bash
#
# Re-seal a Safari Web Extension app extension after copying generated WebExtension resources.
# Xcode can run the resource-copy script late enough that the copied JS/CSS invalidates the appex
# seal. This script is intended to run from the extension target's copy phase, where Xcode exposes
# CODESIGNING_FOLDER_PATH, EXPANDED_CODE_SIGN_IDENTITY, TARGET_TEMP_DIR, and FULL_PRODUCT_NAME.
set -euo pipefail

if [ "${CODE_SIGNING_ALLOWED:-YES}" = "NO" ]; then
  exit 0
fi

if [ -z "${EXPANDED_CODE_SIGN_IDENTITY:-}" ] || [ "${EXPANDED_CODE_SIGN_IDENTITY:-}" = "-" ]; then
  exit 0
fi

if [ -z "${CODESIGNING_FOLDER_PATH:-}" ] || [ ! -d "${CODESIGNING_FOLDER_PATH}" ]; then
  echo "error: CODESIGNING_FOLDER_PATH is not an app extension directory" >&2
  exit 1
fi

entitlements="${TARGET_TEMP_DIR:-}/${FULL_PRODUCT_NAME:-}.xcent"
if [ ! -f "${entitlements}" ]; then
  echo "error: generated entitlements missing at ${entitlements}" >&2
  exit 1
fi

# Preview/debug dylibs are nested code in Debug builds; re-sign them before sealing the appex.
if [ -f "${CODESIGNING_FOLDER_PATH}/Contents/MacOS/__preview.dylib" ]; then
  codesign --force --sign "${EXPANDED_CODE_SIGN_IDENTITY}" --timestamp=none \
    "${CODESIGNING_FOLDER_PATH}/Contents/MacOS/__preview.dylib"
fi

if [ -f "${CODESIGNING_FOLDER_PATH}/Contents/MacOS/Still Extension.debug.dylib" ]; then
  codesign --force --sign "${EXPANDED_CODE_SIGN_IDENTITY}" --timestamp=none \
    "${CODESIGNING_FOLDER_PATH}/Contents/MacOS/Still Extension.debug.dylib"
fi

codesign --force --sign "${EXPANDED_CODE_SIGN_IDENTITY}" --timestamp=none \
  --entitlements "${entitlements}" \
  "${CODESIGNING_FOLDER_PATH}"
