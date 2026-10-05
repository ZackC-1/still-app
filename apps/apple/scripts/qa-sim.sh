#!/usr/bin/env bash
#
# qa-sim.sh — the Apple simulator QA lane (L5). Builds a DEBUG app with the V3 web screens, puts it
# on a simulator the script itself created, seeds app states through the DEBUG-only QA hooks
# (Still/Shared (App)/QA/QAHooks.swift), sets appearance and text size, and captures screenshots
# and layout position dumps. Nothing here downloads a simulator runtime, signs, or touches a store.
#
# Usage: qa-sim.sh <command> [args]
#
#   doctor                         installed runtimes, QA devices, free disk
#   build [ios|macos]              DEBUG build (V3 web screens, unsigned) into $QA_DERIVED
#   verify-release                 build Release for the simulator and prove the QA hooks are absent
#                                  (and present in the Debug build: the positive control)
#   create <label> <device type> [runtime id]
#                                  create a run device, e.g. create se "iPhone SE (3rd generation)";
#                                  prints its UDID and records it for `cleanup`
#   clone <label> <golden udid>    clone a golden simulator on which Still is already enabled in
#                                  Safari (see "Golden simulator" below); recorded for `cleanup`
#   boot <udid>                    boot, wait until ready, pin a clean status bar
#   install <udid>                 install the DEBUG build from $QA_DERIVED
#   refresh-web <udid>             rebuild only the web bundle ($QA_WEB_SCREENS) and replace the
#                                  WebUI folder of the app installed on that simulator (no Xcode
#                                  build; simulator builds are unsigned, so nothing is re-signed)
#   appearance <udid> light|dark
#   text-size <udid> <category>    e.g. large (default), extra-extra-extra-large,
#                                  accessibility-extra-extra-extra-large
#   capture <udid> <state> <out dir> [extra KEY=VALUE ...]
#                                  relaunch in a named state, wait for the layout dump, then save
#                                  <out dir>/<state>.png and <state>.layout.json
#   probe-js                       print the layout probe (the same source the app injects) so the
#                                  WebKit bundle lane can produce comparable JSON: run it in the
#                                  page and read globalThis.__stillQALayout. QA_PROBE_CONFIG
#                                  overrides {"settleMs":0,"taps":[],"dump":true}
#   compare-layout <a.json> <b.json> [tolerance px]
#                                  compare two dumps: same elements in order, same text, boxes
#                                  within the tolerance (default 1 CSS px); exit 1 on any mismatch
#   mac-capture <state> <out dir> [extra KEY=VALUE ...]
#                                  run the DEBUG Mac app in a state and capture its window at 2x.
#                                  Refused unless QA_MAC_ALLOW_SHARED_STATE=1: on a Mac the DEBUG
#                                  app shares Still's App Group with any installed Still, so a
#                                  seeded state (for example a reset onboarding gate) changes that
#                                  Mac's real Still. Use a dedicated QA Mac account.
#   shutdown <udid>
#   cleanup                        shut down and delete every device this script created, and
#                                  delete $QA_DERIVED
#
# States (capture / mac-capture): each is a set of STILL_QA_* launch keys.
#   d12-step-1         web onboarding, first step              (D12-01/05)
#   d12-step-2         web onboarding, after one Continue      (D12-02/06/08)
#   d12-step-2-waiting web onboarding step 2, Safari reports Still off (Mac: D12-09)
#   d12-step-2-on      web onboarding step 2, Safari reports Still on  (Mac: D12-10)
#   d04-settings       onboarding complete, V3 settings screen (D04-01 family)
#   d04-safari-off     settings with Safari reporting Still off (Mac only shows the line)
#   settings           onboarding complete, whichever settings screen the build carries
#
# Pixel scale: iPhone SE, every iPad and the Mac render at 2x, so their screenshots go straight to
# the visual gate. iPhone 15/16 render at 3x: gate the same state on the WebKit bundle lane at 2x
# and compare this lane's layout dump against that lane's (compare-layout) instead of pixels.
#
# Golden simulator: simctl cannot switch a Safari extension on. Enable Still once by hand on a
# simulator (Settings > Apps > Safari > Extensions > Still > on, and allow it on every website),
# keep that device as the golden copy, and `clone` it per run. Prove it on every run with a real
# YouTube Shorts link opened by `xcrun simctl openurl` (the redirect is the positive control).
#
# Environment:
#   QA_DERIVED   DerivedData for these builds (default /private/tmp/still-qa-sim-derived)
#   QA_HEAVY     wrapper for heavy commands (default /private/tmp/claude-501/heavy.sh when present)
#   QA_MIN_FREE_GB  refuse to build below this much free disk (default 8)
#   QA_WEB_SCREENS  "v3" (default): the D04/D12 web screens; "shipped": today's shipped web screen
#
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
PROJECT_DIR="$HERE/../Still"
QA_SOURCE="$PROJECT_DIR/Shared (App)/QA/QAHooks.swift"
BUNDLE_ID="com.chartash.still"
QA_DERIVED="${QA_DERIVED:-/private/tmp/still-qa-sim-derived}"
QA_MIN_FREE_GB="${QA_MIN_FREE_GB:-8}"
QA_WEB_SCREENS="${QA_WEB_SCREENS:-v3}"
DEVICE_LEDGER="$QA_DERIVED/devices.txt"
if [[ -z "${QA_HEAVY+x}" ]]; then
  if [[ -x /private/tmp/claude-501/heavy.sh ]]; then QA_HEAVY=/private/tmp/claude-501/heavy.sh; else QA_HEAVY=""; fi
fi

die() { echo "qa-sim: $*" >&2; exit 1; }
[[ "$QA_WEB_SCREENS" == "v3" || "$QA_WEB_SCREENS" == "shipped" ]] || die "QA_WEB_SCREENS must be v3 or shipped"
heavy() { if [[ -n "$QA_HEAVY" ]]; then "$QA_HEAVY" "$@"; else "$@"; fi; }

free_gb() { df -g "$1" | awk 'NR==2 {print $4}'; }
require_disk() {
  local free; free="$(free_gb /private/tmp)"
  if (( free < QA_MIN_FREE_GB )); then
    die "only ${free} GB free (need ${QA_MIN_FREE_GB}); not building"
  fi
  echo "==> ${free} GB free"
}

# The V3 web screens (D04 settings + D12 onboarding) are an explicit developer opt-in that needs
# no Supabase configuration. The empty values override any local .env, so a configured developer
# checkout still builds the unconfigured QA bundle. No analytics key: nothing is ever sent.
build_web() {
  local atomic=true
  [[ "$QA_WEB_SCREENS" == "shipped" ]] && atomic=
  echo "==> Web bundle ($QA_WEB_SCREENS Apple screens, unconfigured)…"
  ( cd "$REPO" && VITE_APPLE_ATOMIC_SETTINGS=$atomic VITE_SUPABASE_URL= VITE_SUPABASE_ANON_KEY= \
      VITE_POSTHOG_KEY= VITE_POSTHOG_HOST= pnpm --filter @still/app-webview build )
  echo "==> Safari extension bundle…"
  ( cd "$REPO" && pnpm --filter @still/ext-safari build )
}

xcode() {
  ( cd "$PROJECT_DIR" && heavy xcodebuild -jobs 4 -derivedDataPath "$QA_DERIVED" "$@" )
}

app_path() {
  local configuration="$1" platform="$2"
  echo "$QA_DERIVED/Build/Products/${configuration}-${platform}/Still.app"
}

cmd_build() {
  local target="${1:-ios}"
  require_disk
  mkdir -p "$QA_DERIVED"
  build_web
  case "$target" in
    ios)
      xcode build -scheme "Still (iOS)" -configuration Debug -sdk iphonesimulator \
        -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO
      echo "==> $(app_path Debug iphonesimulator)" ;;
    macos)
      # The Mac app needs its App Group entitlement to run, so this one is signed for local runs
      # with the team's development identity (automatic signing), never for distribution.
      xcode build -scheme "Still (macOS)" -configuration Debug -destination 'platform=macOS' \
        -allowProvisioningUpdates
      echo "==> $QA_DERIVED/Build/Products/Debug/Still.app" ;;
    *) die "unknown build target '$target' (ios | macos)" ;;
  esac
}

# Strings the hooks compile into a binary. A Release build must contain none of them.
QA_MARKERS=(STILL_QA_STATE STILL_QA_LAYOUT_DUMP QA-LAYOUT-PROBE-BEGIN QAHooks QALayoutSink)
count_markers() {
  local binary="$1" total=0 n
  for marker in "${QA_MARKERS[@]}"; do
    n="$(strings -a "$binary" | grep -c -- "$marker" || true)"
    echo "    $marker: $n" >&2
    total=$((total + n))
  done
  echo "$total"
}

cmd_verify_release() {
  require_disk
  mkdir -p "$QA_DERIVED"
  build_web
  xcode build -scheme "Still (iOS)" -configuration Debug -sdk iphonesimulator \
    -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO
  require_disk
  xcode build -scheme "Still (iOS)" -configuration Release -sdk iphonesimulator \
    -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO
  local debug_bin release_bin
  # A Debug build may put the code in a debug dylib next to the stub executable; scan them all.
  debug_bin="$(app_path Debug iphonesimulator)"
  release_bin="$(app_path Release iphonesimulator)"
  echo "==> Debug build (positive control: the hooks must be present)"
  local debug_total=0 release_total=0 file
  while IFS= read -r file; do
    debug_total=$((debug_total + $(count_markers "$file")))
  done < <(find "$debug_bin" -maxdepth 1 -type f \( -name Still -o -name '*.debug.dylib' \))
  echo "==> Release build (the hooks must be absent)"
  while IFS= read -r file; do
    release_total=$((release_total + $(count_markers "$file")))
  done < <(find "$release_bin" -maxdepth 1 -type f \( -name Still -o -name '*.dylib' \))
  echo "==> Debug markers: $debug_total, Release markers: $release_total"
  (( debug_total > 0 )) || die "positive control failed: the Debug build carries no QA marker"
  (( release_total == 0 )) || die "the Release build carries QA hooks"
  echo "==> PASS: QA hooks are in Debug only"
}

record_device() { mkdir -p "$QA_DERIVED"; echo "$1" >> "$DEVICE_LEDGER"; }

cmd_create() {
  local label="$1" type="$2" runtime="${3:-}"
  if [[ -z "$runtime" ]]; then
    runtime="$(xcrun simctl list runtimes | awk '/^iOS / && !/unavailable/ {id=$NF} END {print id}')"
  fi
  [[ -n "$runtime" ]] || die "no installed iOS runtime (this script never downloads one)"
  xcrun simctl list runtimes | grep -q -- "$runtime" || die "runtime $runtime is not installed"
  local udid; udid="$(xcrun simctl create "still-qa-$label" "$type" "$runtime")"
  record_device "$udid"
  echo "$udid"
}

cmd_clone() {
  local label="$1" golden="$2" udid
  udid="$(xcrun simctl clone "$golden" "still-qa-$label")"
  record_device "$udid"
  echo "$udid"
}

cmd_boot() {
  local udid="$1"
  xcrun simctl boot "$udid" 2>/dev/null || true
  xcrun simctl bootstatus "$udid" -b >/dev/null
  xcrun simctl status_bar "$udid" override --time 9:41 --dataNetwork wifi --wifiMode active \
    --wifiBars 3 --cellularMode active --cellularBars 4 --batteryState charged --batteryLevel 100
}

cmd_install() {
  local udid="$1" app; app="$(app_path Debug iphonesimulator)"
  [[ -d "$app" ]] || die "no Debug build at $app (run: qa-sim.sh build ios)"
  xcrun simctl install "$udid" "$app"
}

cmd_refresh_web() {
  local udid="$1" app
  app="$(xcrun simctl get_app_container "$udid" "$BUNDLE_ID")"
  [[ -d "$app/WebUI" ]] || die "Still is not installed on $udid"
  ( cd "$REPO" && VITE_APPLE_ATOMIC_SETTINGS=$([[ "$QA_WEB_SCREENS" == "v3" ]] && echo true) \
      VITE_SUPABASE_URL= VITE_SUPABASE_ANON_KEY= VITE_POSTHOG_KEY= VITE_POSTHOG_HOST= \
      pnpm --filter @still/app-webview build >/dev/null )
  rm -rf "$app/WebUI"
  cp -R "$REPO/packages/app-webview/dist" "$app/WebUI"
  echo "==> $QA_WEB_SCREENS web screens installed on $udid"
}

cmd_appearance() { xcrun simctl ui "$1" appearance "$2"; }
cmd_text_size() { xcrun simctl ui "$1" content_size "$2"; }

state_keys() {
  case "$1" in
    d12-step-1) echo "STILL_QA_STATE=onboarding STILL_QA_PRESENTER=web" ;;
    d12-step-2) echo "STILL_QA_STATE=onboarding STILL_QA_PRESENTER=web STILL_QA_TAPS=Continue" ;;
    d12-step-2-waiting) echo "STILL_QA_STATE=onboarding STILL_QA_PRESENTER=web STILL_QA_SAFARI=disabled STILL_QA_TAPS=Continue" ;;
    d12-step-2-on) echo "STILL_QA_STATE=onboarding STILL_QA_PRESENTER=web STILL_QA_SAFARI=enabled STILL_QA_TAPS=Continue" ;;
    d04-settings) echo "STILL_QA_STATE=onboarded STILL_QA_PRESENTER=web" ;;
    settings) echo "STILL_QA_STATE=onboarded" ;;
    d04-safari-off) echo "STILL_QA_STATE=onboarded STILL_QA_PRESENTER=web STILL_QA_SAFARI=disabled" ;;
    *) die "unknown state '$1'" ;;
  esac
}

cmd_capture() {
  local udid="$1" state="$2" out="$3"; shift 3
  mkdir -p "$out"
  local container dump env_args=() pair
  for pair in $(state_keys "$state") STILL_QA_LAYOUT_DUMP=1 "$@"; do
    env_args+=("SIMCTL_CHILD_${pair}")
  done
  container="$(xcrun simctl get_app_container "$udid" "$BUNDLE_ID" data)"
  dump="$container/Documents/still-qa/layout.json"
  rm -f "$dump"
  xcrun simctl terminate "$udid" "$BUNDLE_ID" 2>/dev/null || true
  env "${env_args[@]}" xcrun simctl launch "$udid" "$BUNDLE_ID" >/dev/null
  local waited=0
  until [[ -s "$dump" ]]; do
    sleep 1; waited=$((waited + 1))
    (( waited < 60 )) || die "no layout dump after 60 s (state $state)"
  done
  sleep 1 # the dump is written after the last tap has settled; let the frame finish drawing
  xcrun simctl io "$udid" screenshot --type=png "$out/$state.png" >/dev/null
  cp "$dump" "$out/$state.layout.json"
  check_dump "$out/$state.layout.json" "$state"
  echo "==> $out/$state.png ($(sips -g pixelWidth -g pixelHeight "$out/$state.png" | awk '/pixel/ {printf "%s ", $2}'))"
  echo "==> $out/$state.layout.json"
}

# A blank or broken page must never pass as a captured state: the dump must have landmarks, no
# page errors, and every requested tap must have found its button.
check_dump() {
  node - "$1" "$2" <<'NODE'
const [file, state] = process.argv.slice(2);
const dump = JSON.parse(require("node:fs").readFileSync(file, "utf8"));
const problems = [];
if (!dump.boxes.length) problems.push("no visible landmark elements (blank page?)");
for (const error of dump.document.errors ?? []) problems.push(`page error: ${error}`);
for (const tap of dump.taps ?? []) if (!tap.found) problems.push(`button "${tap.label}" not found`);
if (problems.length) {
  console.error(`qa-sim: state ${state} did not render as expected:\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
NODE
}

cmd_probe_js() {
  # Outside the app the report lands in globalThis.__stillQALayout (a JSON string) once settled.
  local config="${QA_PROBE_CONFIG:-{\"settleMs\":0,\"taps\":[],\"dump\":true\}}"
  awk '/QA-LAYOUT-PROBE-BEGIN/ {on=1} on {print} /QA-LAYOUT-PROBE-END/ {on=0}' "$QA_SOURCE" |
    sed -e 's/^  //' -e "s|__STILL_QA_CONFIG__|$config|"
}

cmd_compare_layout() {
  local a="$1" b="$2" tolerance="${3:-1}"
  node - "$a" "$b" "$tolerance" <<'NODE'
const [a, b, tolerance] = process.argv.slice(2);
const fs = require("node:fs");
const left = JSON.parse(fs.readFileSync(a, "utf8"));
const right = JSON.parse(fs.readFileSync(b, "utf8"));
const problems = [];
if (left.viewport.width !== right.viewport.width)
  problems.push(`viewport width ${left.viewport.width} vs ${right.viewport.width}`);
const n = Math.max(left.boxes.length, right.boxes.length);
for (let i = 0; i < n; i++) {
  const l = left.boxes[i], r = right.boxes[i];
  if (!l || !r) { problems.push(`element ${i}: present in only one dump (${(l || r).tag} "${(l || r).name}")`); continue; }
  if (l.tag !== r.tag || l.role !== r.role || l.name !== r.name) {
    problems.push(`element ${i}: ${l.tag} "${l.name}" vs ${r.tag} "${r.name}"`);
    continue;
  }
  for (const key of ["x", "y", "width", "height"])
    if (Math.abs(l[key] - r[key]) > Number(tolerance))
      problems.push(`element ${i} ${l.tag} "${l.name}": ${key} ${l[key]} vs ${r[key]}`);
}
for (const p of problems) console.log(p);
console.log(problems.length ? `FAIL: ${problems.length} difference(s)` : `PASS: ${n} elements within ${tolerance} px`);
process.exit(problems.length ? 1 : 0);
NODE
}

cmd_mac_capture() {
  local state="$1" out="$2"; shift 2
  [[ "${QA_MAC_ALLOW_SHARED_STATE:-}" == "1" ]] ||
    die "mac-capture changes this Mac's real Still state (shared App Group); set QA_MAC_ALLOW_SHARED_STATE=1 on a dedicated QA account"
  local app="$QA_DERIVED/Build/Products/Debug/Still.app" pair env_args=()
  [[ -d "$app" ]] || die "no Debug Mac build at $app (run: qa-sim.sh build macos)"
  mkdir -p "$out"
  local dumpdir="$QA_DERIVED/mac-dump"
  mkdir -p "$dumpdir"
  for pair in $(state_keys "$state") STILL_QA_LAYOUT_DUMP=1 "STILL_QA_OUTPUT_DIR=$dumpdir" "$@"; do env_args+=("$pair"); done
  local dump="$dumpdir/layout.json"
  rm -f "$dump"
  env "${env_args[@]}" "$app/Contents/MacOS/Still" >/dev/null 2>&1 &
  local pid=$!
  local waited=0
  until [[ -s "$dump" ]]; do
    sleep 1; waited=$((waited + 1))
    if (( waited >= 60 )); then kill "$pid" 2>/dev/null || true; die "no layout dump after 60 s"; fi
  done
  sleep 1
  # The window id of this process's main window, from the window server.
  local window
  window="$(swift - "$pid" <<'SWIFT'
import CoreGraphics
let pid = Int32(CommandLine.arguments[1])!
let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] ?? []
let mine = windows.filter { ($0[kCGWindowOwnerPID as String] as? Int32) == pid && ($0[kCGWindowLayer as String] as? Int) == 0 }
print(mine.first?[kCGWindowNumber as String] as? Int ?? 0)
SWIFT
)"
  if [[ "$window" == "0" ]]; then kill "$pid" 2>/dev/null || true; die "Still's window was not found"; fi
  screencapture -x -o -l "$window" "$out/$state.mac.png"
  cp "$dump" "$out/$state.mac.layout.json"
  kill "$pid" 2>/dev/null || true
  echo "==> $out/$state.mac.png and $out/$state.mac.layout.json"
}

cmd_shutdown() { xcrun simctl shutdown "$1" 2>/dev/null || true; }

cmd_cleanup() {
  if [[ -f "$DEVICE_LEDGER" ]]; then
    while IFS= read -r udid; do
      [[ -n "$udid" ]] || continue
      xcrun simctl shutdown "$udid" 2>/dev/null || true
      xcrun simctl delete "$udid" 2>/dev/null && echo "==> deleted $udid" || true
    done < "$DEVICE_LEDGER"
  fi
  rm -rf "$QA_DERIVED"
  echo "==> removed $QA_DERIVED"
}

cmd_doctor() {
  echo "==> Free disk: $(free_gb /private/tmp) GB (builds need ${QA_MIN_FREE_GB})"
  echo "==> Installed iOS runtimes:"; xcrun simctl list runtimes | grep '^iOS' || echo "    none"
  echo "==> Devices created by this script:"
  [[ -f "$DEVICE_LEDGER" ]] && cat "$DEVICE_LEDGER" || echo "    none"
}

command="${1:-}"; shift || true
case "$command" in
  doctor) cmd_doctor ;;
  build) cmd_build "$@" ;;
  verify-release) cmd_verify_release ;;
  create) [[ $# -ge 2 ]] || die "usage: create <label> <device type> [runtime]"; cmd_create "$@" ;;
  clone) [[ $# -eq 2 ]] || die "usage: clone <label> <golden udid>"; cmd_clone "$@" ;;
  boot) cmd_boot "$1" ;;
  install) cmd_install "$1" ;;
  refresh-web) cmd_refresh_web "$1" ;;
  appearance) cmd_appearance "$1" "$2" ;;
  text-size) cmd_text_size "$1" "$2" ;;
  capture) [[ $# -ge 3 ]] || die "usage: capture <udid> <state> <out dir>"; cmd_capture "$@" ;;
  probe-js) cmd_probe_js ;;
  compare-layout) cmd_compare_layout "$@" ;;
  mac-capture) [[ $# -ge 2 ]] || die "usage: mac-capture <state> <out dir>"; cmd_mac_capture "$@" ;;
  shutdown) cmd_shutdown "$1" ;;
  cleanup) cmd_cleanup ;;
  *) sed -n '2,60p' "$0"; exit 2 ;;
esac
