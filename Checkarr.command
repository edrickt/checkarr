#!/bin/sh
# Double-click launcher for a Checkarr checkout (macOS Finder).
# Installs dependencies on first run, then starts the server, opens the
# dashboard, and installs the ~/Applications/Checkarr.app icon.
# No terminal commands required: just double-click this file in Finder.
set -u
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT" || exit 1

fail() {
  /usr/bin/osascript -e "display alert \"Checkarr\" message \"$1\" as critical" >/dev/null 2>&1
  echo "Checkarr: $1" >&2
  echo "Press Enter to close this window."
  read -r _
  exit 1
}

if ! command -v node >/dev/null 2>&1; then
  fail "Node.js was not found. Install Node 23.4 or newer, then double-click Checkarr.command again."
fi
if ! command -v pnpm >/dev/null 2>&1; then
  fail "pnpm was not found. Install pnpm 11 (npm install -g pnpm), then double-click Checkarr.command again."
fi
if [ ! -d "$ROOT/node_modules" ]; then
  echo "First launch: installing dependencies (one-time)..."
  if ! pnpm install; then
    fail "pnpm install failed. Open Terminal in this folder, run pnpm install, and read the error."
  fi
fi
exec pnpm start
