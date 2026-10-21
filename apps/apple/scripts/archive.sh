#!/usr/bin/env bash
#
# archive.sh — archive the iOS app and export a signed App Store .ipa (U20), using an App Store
# Connect API key so it runs unattended in CI once the key exists. Optionally uploads to App Store
# Connect.
#
# Prerequisites (HUMAN, one-time — see README.md and docs/CONNECTIONS.md Tier 2):
#   • Apple Developer Program active; the app's App ID has App Groups + Sign in with Apple + IAP.
#   • An App Store Connect API key (.p8) with App Manager role.
#
# Required env:
#   ASC_KEY_ID        the API key id (e.g. ABC123XYZ)
#   ASC_ISSUER_ID     the API key issuer id (UUID)
#   ASC_KEY_PATH      path to the AuthKey_*.p8
# Optional env:
#   DEVELOPMENT_TEAM  defaults to UM9HVDH3P3
#   UPLOAD=1          also upload the .ipa to App Store Connect via altool
#
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
PROJECT_DIR="$HERE/../Still"
BUILD_DIR="${STILL_BUILD_DIR:-$HERE/../build}"
TEAM="${DEVELOPMENT_TEAM:-UM9HVDH3P3}"

: "${ASC_KEY_ID:?set ASC_KEY_ID (App Store Connect API key id)}"
: "${ASC_ISSUER_ID:?set ASC_ISSUER_ID (App Store Connect API key issuer id)}"
: "${ASC_KEY_PATH:?set ASC_KEY_PATH (path to AuthKey_*.p8)}"

ARCHIVE="$BUILD_DIR/Still.xcarchive"
EXPORT_DIR="$BUILD_DIR/export"
mkdir -p "$BUILD_DIR"

# Refuse before building anything if the two web builds would disagree about cloud sync (U3-W4 P6).
# Presence and equality only; no value is ever printed. See release-env-guard.sh.
# shellcheck source=release-env-guard.sh
source "$HERE/release-env-guard.sh"
release_env_guard "$REPO/packages/app-webview" "$REPO/packages/ext-safari" "$HERE/modern-sync-shipped" \
  || exit 1

# Production access trust (V3 release enablement, G5). The PUBLIC Still Pro verification keys come
# only from scripts/release/production-access-keys.json: the web bundle gets them as
# VITE_ACCESS_ENVIRONMENT / VITE_ACCESS_PUBLIC_KEYS, and the four Info.plists get the same rows
# (StillAccessEnvironment, StillAccessTrustKeys) for this archive only. The plists are restored
# exactly on exit. The check refuses non-production rows, the TEST-ONLY fixture key, and an empty
# list once the release declares the paid tier. No private key is involved anywhere here.
TRUST="$REPO/scripts/release/access-trust.mjs"
TRUST_BACKUP="$(mktemp -d "${TMPDIR:-/tmp}/still-store-trust.XXXXXX")"
restore_store_trust() { node "$TRUST" apple-restore --backup "$TRUST_BACKUP" && rm -rf "$TRUST_BACKUP"; }
trap restore_store_trust EXIT
node "$TRUST" check
while IFS='=' read -r key value; do
  case "$key" in VITE_ACCESS_ENVIRONMENT|VITE_ACCESS_PUBLIC_KEYS) export "$key=$value" ;; *) echo "unexpected trust line" >&2; exit 1 ;; esac
done < <(node "$TRUST" env)

echo "==> Building the shared web bundle…"
( cd "$REPO" && pnpm --filter @still/app-webview build )
echo "==> Building the Safari extension bundle…"
# The app targets' "Copy Safari Web Extension Resources" phases hard-fail without
# packages/ext-safari/dist/safari-mv3/manifest.json — dist/ is gitignored, so a clean checkout
# archive dies at that phase unless the extension is built first.
( cd "$REPO" && pnpm --filter @still/ext-safari build )

echo "==> Writing production access trust into the Apple plists (restored on exit)…"
node "$TRUST" apple-apply --backup "$TRUST_BACKUP"

echo "==> Archiving Still (iOS)…"
cd "$PROJECT_DIR"
xcodebuild archive \
  -scheme "Still (iOS)" \
  -destination 'generic/platform=iOS' \
  -archivePath "$ARCHIVE" \
  -allowProvisioningUpdates \
  -authenticationKeyPath "$ASC_KEY_PATH" \
  -authenticationKeyID "$ASC_KEY_ID" \
  -authenticationKeyIssuerID "$ASC_ISSUER_ID" \
  DEVELOPMENT_TEAM="$TEAM"

echo "==> Exporting a signed App Store .ipa…"
xcodebuild -exportArchive \
  -archivePath "$ARCHIVE" \
  -exportPath "$EXPORT_DIR" \
  -exportOptionsPlist "$HERE/ExportOptions.plist" \
  -allowProvisioningUpdates \
  -authenticationKeyPath "$ASC_KEY_PATH" \
  -authenticationKeyID "$ASC_KEY_ID" \
  -authenticationKeyIssuerID "$ASC_ISSUER_ID"

IPA="$(/usr/bin/find "$EXPORT_DIR" -name '*.ipa' | head -1)"
echo "==> Exported: $IPA"

if [ "${UPLOAD:-0}" = "1" ]; then
  echo "==> Uploading to App Store Connect…"
  xcrun altool --upload-app -f "$IPA" -t ios \
    --apiKey "$ASC_KEY_ID" --apiIssuer "$ASC_ISSUER_ID"
  echo "==> Uploaded."
else
  echo "==> Skipping upload (set UPLOAD=1 to upload via altool, or drop the .ipa into Transporter)."
fi
echo "==> Done."
