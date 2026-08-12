#!/usr/bin/env bash
#
# One command to get a fresh session working. Run at the start of every session.
#
# Host deps -> container-runner deps -> typecheck both trees -> host tests.
# Deliberately does NOT start the service: on this machine nanoclaw runs under
# launchd (com.nanoclaw-v2-fc2314cf) and a second host process would contend for
# the same session DBs. Use `launchctl kickstart -k gui/$(id -u)/com.nanoclaw-v2-fc2314cf`
# to restart the real one.
set -euo pipefail

cd "$(dirname "$0")"

echo "==> host deps (pnpm)"
pnpm install --frozen-lockfile

echo "==> agent-runner deps (bun)"
if command -v bun >/dev/null 2>&1; then
  (cd container/agent-runner && bun install --frozen-lockfile)
else
  echo "    bun not found — skipping agent-runner deps."
  echo "    Only matters if you are editing container/agent-runner/src/."
fi

echo "==> typecheck (host)"
pnpm run typecheck

echo "==> typecheck (agent-runner)"
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit

echo "==> smoke test (host suite)"
pnpm test

echo
echo "OK. Service status:"
launchctl list 2>/dev/null | grep -i nanoclaw || echo "  (not loaded — this is fine if you are not running the service)"
