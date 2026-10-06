#!/usr/bin/env bash
#
# release-env-guard.sh — the release-build env guard (U3-W4 P6). Sourced by archive.sh before it
# builds anything, and run directly (`bash release-env-guard.sh <web> <ext> <marker>`) by the Xcode
# "Copy Safari Web Extension Resources" phase on Release builds, so a raw `xcodebuild archive` is
# guarded too.
#
# The Apple app's web bundle (@still/app-webview) and the Safari extension bundle (@still/ext-safari)
# are built separately and each reads its own build environment, so one could be built configured for
# cloud sync and the other not, or with different modern-sync flags. This guard refuses that mix.
#
# It answers with STATE TOKENS ONLY. release-env-state.mjs resolves each package's production env
# with the real Vite and WXT loaders and prints tokens (configured|unconfigured|partial, modern and
# atomic on|off); this file compares them. No value is ever printed, logged or echoed, and xtrace is
# switched off for the duration so `bash -x` cannot leak one either.
#
# One-way guard: once a release has shipped with the modern flag, conversion of saved settings is
# one-way, so every later release archive must keep it (and be configured). The committed marker file
# records that: "not-shipped" today. Flipping it to "shipped" is a separate, owner-approved change
# made in the commit that ships the flag. A missing or unreadable marker refuses (fail closed).

_GUARD_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# A raw Xcode Release build copies a PREBUILT app-webview/dist, so the env the web bundle would use
# now is not what it was built with. When a 4th argument names the build stamp (dist/.env-state,
# written after `vite build` by the app-webview build script: state tokens only), the web side is
# read from that stamp instead of re-resolved; a missing, malformed or differing stamp refuses.
#
# release_env_guard <app-webview-dir> <ext-safari-dir> <shipped-marker-file> [<web-build-stamp>]
# Returns 0 when the two builds agree (and, once shipped, are configured with the modern flag);
# otherwise prints a reason naming packages and variables only, and returns 1.
release_env_guard() {
  local traced=0
  case "$-" in *x*) traced=1 ;; esac
  { set +x; } 2>/dev/null
  _release_env_guard_checked "$@"
  local status=$?
  if [ "$traced" = 1 ]; then set -x; fi
  return "$status"
}

_release_env_guard_checked() {
  local web="$1" ext="$2" marker="$3" stamp="${4-}"
  local failed=0 dir

  for dir in "$web" "$ext"; do
    if [ ! -d "$dir" ] || [ ! -f "$dir/package.json" ]; then
      echo "release env guard: refusing to archive. $(basename "$dir") is not a package directory (no package.json)." >&2
      return 1
    fi
  done

  local state
  if [ -n "$stamp" ]; then
    if [ ! -f "$stamp" ]; then
      echo "release env guard: refusing to archive. The web bundle has no build stamp ($(basename "$stamp")). Rebuild it with: pnpm --filter @still/app-webview build" >&2
      return 1
    fi
    local stamped extstate stamp_line
    stamped=""
    while IFS= read -r stamp_line || [ -n "$stamp_line" ]; do
      # Only exact state tokens are accepted: anything else (a stray value, a blank) refuses.
      case "$stamp_line" in
        app-webview.configured=configured|app-webview.configured=unconfigured|app-webview.configured=partial| \
        app-webview.modern=on|app-webview.modern=off|app-webview.atomic=on|app-webview.atomic=off)
          stamped="$stamped$stamp_line
" ;;
        *)
          echo "release env guard: refusing to archive. The web build stamp ($(basename "$stamp")) is not a plain state stamp. Rebuild the web bundle." >&2
          return 1
          ;;
      esac
    done < "$stamp"
    if ! extstate="$(node "$_GUARD_DIR/release-env-state.mjs" --ext-only "$ext" 2>/dev/null)"; then
      echo "release env guard: refusing to archive. Could not work out the extension build's environment (is node on PATH and pnpm install done?)." >&2
      return 1
    fi
    state="$stamped$(printf '%s\n' "$extstate" | grep '^ext-safari\.')"
  elif ! state="$(node "$_GUARD_DIR/release-env-state.mjs" "$web" "$ext" 2>/dev/null)"; then
    echo "release env guard: refusing to archive. Could not work out each build's environment (is node on PATH and pnpm install done?)." >&2
    return 1
  fi

  local web_cfg="" ext_cfg="" web_mod="" ext_mod="" web_atom="" ext_atom="" line
  while IFS= read -r line; do
    case "$line" in
      app-webview.configured=*) web_cfg="${line#*=}" ;;
      ext-safari.configured=*) ext_cfg="${line#*=}" ;;
      app-webview.modern=*) web_mod="${line#*=}" ;;
      ext-safari.modern=*) ext_mod="${line#*=}" ;;
      app-webview.atomic=*) web_atom="${line#*=}" ;;
      ext-safari.atomic=*) ext_atom="${line#*=}" ;;
    esac
  done <<EOF_STATE
$state
EOF_STATE
  if [ -z "$web_cfg" ] || [ -z "$ext_cfg" ] || [ -z "$web_mod" ] || [ -z "$ext_mod" ] || [ -z "$web_atom" ] || [ -z "$ext_atom" ]; then
    echo "release env guard: refusing to archive. The environment check gave an incomplete answer." >&2
    return 1
  fi

  if [ "$web_cfg" = partial ] || [ "$ext_cfg" = partial ]; then
    echo "release env guard: refusing to archive. VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY must be set together in each build (app-webview: $web_cfg, ext-safari: $ext_cfg)." >&2
    failed=1
  elif [ "$web_cfg" != "$ext_cfg" ]; then
    echo "release env guard: refusing to archive. app-webview is $web_cfg but ext-safari is $ext_cfg for VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY. Build both the same way." >&2
    failed=1
  fi
  if [ "$web_mod" != "$ext_mod" ]; then
    echo "release env guard: refusing to archive. VITE_MODERN_SETTINGS_SYNC_ENABLED is $web_mod for app-webview but $ext_mod for ext-safari. Build both the same way." >&2
    failed=1
  fi
  if [ "$web_atom" != "$ext_atom" ]; then
    echo "release env guard: refusing to archive. VITE_APPLE_ATOMIC_SETTINGS is $web_atom for app-webview but $ext_atom for ext-safari. Build both the same way." >&2
    failed=1
  fi

  if [ ! -f "$marker" ]; then
    echo "release env guard: refusing to archive. The shipped-flag marker $(basename "$marker") is missing or not a regular file." >&2
    return 1
  fi
  local shipped
  shipped="$(tr -d '[:space:]' < "$marker" 2>/dev/null)" || shipped="unreadable"
  case "$shipped" in
    not-shipped) ;;
    shipped)
      if [ "$web_mod" != on ] || [ "$ext_mod" != on ]; then
        echo "release env guard: refusing to archive. The modern settings-sync flag has already shipped (see $(basename "$marker")), so every release archive must keep VITE_MODERN_SETTINGS_SYNC_ENABLED=true in both builds (app-webview: $web_mod, ext-safari: $ext_mod)." >&2
        failed=1
      fi
      if [ "$web_cfg" != configured ] || [ "$ext_cfg" != configured ]; then
        echo "release env guard: refusing to archive. The modern settings-sync flag has already shipped, so both builds must be configured for cloud sync (app-webview: $web_cfg, ext-safari: $ext_cfg)." >&2
        failed=1
      fi
      ;;
    *)
      echo "release env guard: refusing to archive. $(basename "$marker") must say exactly 'shipped' or 'not-shipped'." >&2
      failed=1
      ;;
  esac
  return "$failed"
}

# Run directly (the Xcode phase): release_env_guard <web> <ext> <marker>; the exit code is the verdict.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  release_env_guard "$@"
  exit $?
fi
