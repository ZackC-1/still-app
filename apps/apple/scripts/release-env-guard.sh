#!/usr/bin/env bash
#
# release-env-guard.sh — sourced by archive.sh before it builds anything (U3-W4 P6).
#
# The Apple app's web bundle (@still/app-webview) and the Safari extension bundle (@still/ext-safari)
# are built separately and each reads its own build environment, so one could be built configured
# for cloud sync and the other not, or one with the modern settings-sync flag and the other without.
# Shipping that mix leaves a popup and an app that disagree about who owns the saved settings.
#
# This guard answers with PRESENCE AND EQUALITY ONLY:
#   • configured state: are VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY both set (configured), both
#     empty (unconfigured), or only one set (partial, always refused)?
#   • modern flag: is VITE_MODERN_SETTINGS_SYNC_ENABLED exactly "true" (on) or anything else (off)?
# It never prints, logs or echoes a value: messages name only the package and the variable. Values are
# read into shell variables that are never expanded into output (no `set -x`, no `echo "$value"`).
#
# Where a package's build gets each variable (Vite, production mode, package root): the process
# environment wins, then .env.production.local, .env.production, .env.local, .env. Both builds
# inherit the same process environment, so a difference can only come from the package .env files.
#
# One-way guard: once a release has shipped with the modern flag, conversion of saved settings is
# one-way, so every later release archive must keep it. The committed marker file records that. It
# says "not-shipped" today. Flipping it to "shipped" is a separate, owner-approved change made in the
# commit that ships the flag.

# env_state_of <package-dir> <KEY>  -> prints nothing; sets ENV_STATE_VALUE (never echoed).
_guard_read() {
  local dir="$1" key="$2" file line value found=""
  if [ -n "${!key-}" ]; then
    ENV_STATE_VALUE="${!key}"
    return 0
  fi
  for file in ".env" ".env.local" ".env.production" ".env.production.local"; do
    [ -f "$dir/$file" ] || continue
    while IFS= read -r line || [ -n "$line" ]; do
      line="${line%$'\r'}"
      line="${line#"${line%%[![:space:]]*}"}"
      line="${line#export }"
      case "$line" in
        "$key="*)
          value="${line#"$key="}"
          case "$value" in
            \"*\") value="${value#\"}"; value="${value%\"}" ;;
            \'*\') value="${value#\'}"; value="${value%\'}" ;;
            *) value="${value%%[[:space:]]#*}" ;;
          esac
          value="${value#"${value%%[![:space:]]*}"}"
          value="${value%"${value##*[![:space:]]}"}"
          found="$value"
          ;;
      esac
    done < "$dir/$file"
  done
  ENV_STATE_VALUE="$found"
}

# _guard_configured <dir> -> echoes configured|unconfigured|partial (never a value)
_guard_configured() {
  local url key
  _guard_read "$1" VITE_SUPABASE_URL; url="$ENV_STATE_VALUE"
  _guard_read "$1" VITE_SUPABASE_ANON_KEY; key="$ENV_STATE_VALUE"
  if [ -n "$url" ] && [ -n "$key" ]; then echo configured
  elif [ -z "$url" ] && [ -z "$key" ]; then echo unconfigured
  else echo partial
  fi
  url=""; key=""
}

# _guard_modern <dir> -> echoes on|off (on only for the exact value "true")
_guard_modern() {
  _guard_read "$1" VITE_MODERN_SETTINGS_SYNC_ENABLED
  if [ "$ENV_STATE_VALUE" = "true" ]; then echo on; else echo off; fi
  ENV_STATE_VALUE=""
}

# release_env_guard <app-webview-dir> <ext-safari-dir> <shipped-marker-file>
# Returns 0 when the two builds agree (and, once shipped, carry the modern flag); otherwise prints
# a reason that names packages and variables only, and returns 1.
release_env_guard() {
  local web="$1" ext="$2" marker="$3"
  local web_cfg ext_cfg web_mod ext_mod shipped
  web_cfg="$(_guard_configured "$web")"
  ext_cfg="$(_guard_configured "$ext")"
  web_mod="$(_guard_modern "$web")"
  ext_mod="$(_guard_modern "$ext")"

  local failed=0
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

  shipped="not-shipped"
  if [ -f "$marker" ]; then shipped="$(tr -d '[:space:]' < "$marker")"; fi
  case "$shipped" in
    not-shipped) ;;
    shipped)
      if [ "$web_mod" != on ] || [ "$ext_mod" != on ]; then
        echo "release env guard: refusing to archive. The modern settings-sync flag has already shipped (see $(basename "$marker")), so every release archive must keep VITE_MODERN_SETTINGS_SYNC_ENABLED=true in both builds (app-webview: $web_mod, ext-safari: $ext_mod)." >&2
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
