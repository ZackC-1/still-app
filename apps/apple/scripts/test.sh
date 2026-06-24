#!/usr/bin/env bash
#
# test.sh — run Still's automated tests (U20): the StillKit Swift logic and the JS/TS workspace gate
# (the same checks CI runs). The Apple app's UI + purchase/SIWA paths are validated on-device by a
# human (see README.md) — they need signing, a deployed backend, and sandbox StoreKit.
#
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"

echo "==> StillKit (swift test)…"
( cd "$HERE/../StillKit" && swift test )

echo "==> Workspace gate (lint · typecheck · unit · build)…"
cd "$REPO"
pnpm -r --if-present lint
pnpm -r --if-present typecheck
pnpm -r --if-present test
pnpm -r --if-present build

echo "==> All automated tests passed."
