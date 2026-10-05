#!/usr/bin/env bash
# Runs inside reactivecircus/android-emulator-runner (one script call, because that action runs a
# multi-line `script:` one line at a time). Installs the pinned Firefox for Android, asks it to open
# its WebDriver BiDi port through a GeckoView config file, forwards that port over adb, then runs the
# spike spec. Every stage logs to steps.log, so a run that stops early still says where.
#
# Inputs (environment): FENIX_APK (verified path), FENIX_VERSION, STILL_ANDROID_XPI (zip of the
# unconfigured Firefox build), STILL_ANDROID_ARTIFACTS (output directory).
set -uo pipefail

PACKAGE=org.mozilla.firefox
PORT=9222
ART="${STILL_ANDROID_ARTIFACTS:-test-results/firefox-android}"
mkdir -p "$ART"
log() { echo "[spike] $*" | tee -a "$ART/steps.log"; }

collect() {
  # Always leave evidence: logcat (Gecko lines first), sockets, the final screen.
  adb logcat -d -v time -s Gecko:V GeckoConsole:V GeckoView:V GeckoRuntime:V 2>/dev/null | tail -n 4000 > "$ART/logcat-gecko.txt" || true
  adb logcat -d -v time 2>/dev/null | tail -n 4000 > "$ART/logcat.txt" || true
  adb shell "cat /proc/net/tcp /proc/net/tcp6 2>/dev/null" > "$ART/remote-sockets.txt" 2>&1 || true
  adb shell "cat /proc/net/unix 2>/dev/null | grep -i firefox" >> "$ART/remote-sockets.txt" 2>&1 || true
  adb exec-out screencap -p > "$ART/final-screen.png" 2>/dev/null || true
  adb shell dumpsys package "$PACKAGE" 2>/dev/null | grep -E "versionName|versionCode|debuggable|flags=" > "$ART/firefox-package.txt" || true
}
stop() { log "STOPPED: $*"; collect; exit 1; }
trap collect EXIT

log "device: $(adb shell getprop ro.product.model | tr -d '\r'), API $(adb shell getprop ro.build.version.sdk | tr -d '\r'), ro.debuggable=$(adb shell getprop ro.debuggable | tr -d '\r')"
adb logcat -c || true

log "install Firefox for Android $FENIX_VERSION"
adb install -r -g "$FENIX_APK" > "$ART/adb-install.txt" 2>&1 || stop "adb install of Firefox failed (see adb-install.txt)"

# System access lets BiDi evaluate script in Still's own moz-extension pages (first-run, popup),
# as the desktop Firefox lane does; the environment variable and the flag cover older and newer
# releases. GeckoView reads /data/local/tmp/<package>-geckoview-config.yaml when the package is the Android
# "debug app". A release Firefox is not debuggable, so this relies on the emulator image being
# debuggable (google_apis images are). This is the step most likely to need a manual fallback.
log "mark $PACKAGE as the debug app so GeckoView reads its config file"
adb shell am set-debug-app --persistent "$PACKAGE" > "$ART/set-debug-app.txt" 2>&1 || stop "am set-debug-app refused (see set-debug-app.txt)"

CONFIG="$ART/geckoview-config.yaml"
cat > "$CONFIG" <<'YAML'
env:
  MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: "1"
args:
  - --remote-debugging-port
  - "9222"
  - --remote-allow-hosts
  - localhost,127.0.0.1
  - --remote-allow-system-access
prefs:
  extensions.webextensions.uuids: '{"still@chartash.com":"5a1c0de0-0000-4000-8000-000000000001"}'
  datareporting.healthreport.uploadEnabled: false
  toolkit.telemetry.enabled: false
  app.update.enabled: false
  remote.log.level: Debug
  browser.dom.window.dump.enabled: true
YAML
adb push "$CONFIG" "/data/local/tmp/$PACKAGE-geckoview-config.yaml" > /dev/null || stop "could not push the GeckoView config file"
adb shell chmod 644 "/data/local/tmp/$PACKAGE-geckoview-config.yaml" || true

# The google_apis image ships the YouTube app; Firefox then offers "Open this link in YouTube app?"
# over the page, which covers the first-run page. Remove it for this throwaway emulator user.
adb shell pm uninstall --user 0 com.google.android.youtube > /dev/null 2>&1 || true
# Fix the density before Firefox starts: Firefox reads it once at launch, so the popup checks can
# then change only the width and get exact dp widths.
adb shell wm density 320 > /dev/null 2>&1 || true

log "launch Firefox"
adb shell am force-stop "$PACKAGE" || true
adb shell monkey -p "$PACKAGE" -c android.intent.category.LAUNCHER 1 > /dev/null 2>&1 || stop "could not launch Firefox"
sleep 5
# Also open a blank tab, as geckodriver does (explicit component: about:blank has no intent filter).
# The BiDi session needs a browsing context, and a first launch sits on the welcome screen with none.
# `am start` exits 0 even when it fails, so its output is checked and recorded instead.
adb shell am start -W -n "$PACKAGE/org.mozilla.fenix.IntentReceiverActivity" -a android.intent.action.VIEW -d about:blank > "$ART/am-start.txt" 2>&1 || true
if grep -q "^Error" "$ART/am-start.txt"; then
  log "blank-tab intent refused (see am-start.txt); continuing with the launcher start only"
else
  log "blank-tab intent accepted"
fi

log "wait for Firefox to report its BiDi port"
listening=""
for _ in $(seq 1 60); do
  if adb logcat -d 2>/dev/null | grep -q "WebDriver BiDi listening"; then listening=yes; break; fi
  sleep 2
done
if [ -n "$listening" ]; then
  log "Firefox reports: $(adb logcat -d 2>/dev/null | grep -m1 'WebDriver BiDi listening' | tr -d '\r')"
else
  log "Firefox did not log a BiDi endpoint within 120s; trying the forward anyway"
fi
adb forward "tcp:$PORT" "tcp:$PORT" || stop "adb forward failed"

# Still is installed from a copy on the device by path. Installing from base64 data would make
# Firefox for Android up to at least 142 write the package to a temporary file and delete it right
# after the install, so every content script then fails with "Unable to load script" (newer
# Firefox keeps that file). /data/local/tmp is readable by Firefox, as the config file above shows.
DEVICE_XPI=/data/local/tmp/still-firefox.xpi
adb push "$STILL_ANDROID_XPI" "$DEVICE_XPI" > /dev/null || stop "could not push the extension package"
adb shell chmod 644 "$DEVICE_XPI" || true

log "run the spike spec"
STILL_ANDROID_BIDI="ws://127.0.0.1:$PORT" STILL_ANDROID_DEVICE_XPI="$DEVICE_XPI" \
  pnpm exec playwright test -c tests/firefox-android/playwright.config.ts
status=$?
log "spike spec exit status: $status"
exit "$status"
