#!/usr/bin/env bash
#
# build.sh — build a Still app target (U20). The recurring, scriptable loop; first-run signing/
# provisioning is the one GUI step (see README.md).
#
# Usage:  ./build.sh [ios-sim | ios-device | macos]   (default: ios-sim)
#
#   ios-sim     unsigned build for the iPhone 17 Pro simulator (CI-style smoke; no signing)
#   ios-device  signed build for the registered iPhone (UDID below); -allowProvisioningUpdates
#   macos       signed build of the macOS app
#
# Always rebuilds the shared web bundle first — the app's Copy-Web-UI phase errors without it.
#
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
PROJECT_DIR="$HERE/../Still"
TARGET="${1:-ios-sim}"

DEVICE_UDID="${STILL_DEVICE_UDID:-00008150-0012445222F2401C}"  # "Zack's iPhone"
SIM_NAME="${STILL_SIM_NAME:-iPhone 17 Pro}"

echo "==> Building the shared web bundle (packages/app-webview)…"
( cd "$REPO" && pnpm --filter @still/app-webview build )

cd "$PROJECT_DIR"
case "$TARGET" in
  ios-sim)
    echo "==> Building Still (iOS) for the $SIM_NAME simulator (unsigned)…"
    xcodebuild build -scheme "Still (iOS)" -sdk iphonesimulator \
      -destination "platform=iOS Simulator,name=$SIM_NAME" \
      CODE_SIGNING_ALLOWED=NO
    ;;
  ios-device)
    echo "==> Building + signing Still (iOS) for device $DEVICE_UDID…"
    xcodebuild build -scheme "Still (iOS)" \
      -destination "id=$DEVICE_UDID" -allowProvisioningUpdates
    ;;
  macos)
    echo "==> Building Still (macOS)…"
    xcodebuild build -scheme "Still (macOS)" -destination 'platform=macOS' \
      -allowProvisioningUpdates
    ;;
  *)
    echo "error: unknown target '$TARGET' (use ios-sim | ios-device | macos)" >&2
    exit 2
    ;;
esac
echo "==> Done."
