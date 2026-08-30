#!/usr/bin/env bash
# Stop the Checkarr server: pid file first, then anything left on the port.
# Exits 0 either way; prints what it did.
set -u
cd "$(dirname "$0")/.."

PORT="${CHECKARR_PORT:-${PORT:-6767}}"
PID_FILE="data/checkarr.pid"

stopped=0
if [ -f "$PID_FILE" ]; then
  PID="$(cat "$PID_FILE")"
  if kill -0 "$PID" 2>/dev/null; then
    echo "stopping pid $PID"
    kill "$PID" 2>/dev/null
    for _ in $(seq 1 20); do
      kill -0 "$PID" 2>/dev/null || break
      sleep 0.5
    done
    if kill -0 "$PID" 2>/dev/null; then
      echo "still alive after 10s, sending SIGKILL"
      kill -9 "$PID" 2>/dev/null
    fi
    stopped=1
  else
    echo "stale pid file (pid $PID not running)"
  fi
  rm -f "$PID_FILE"
fi

STRAY="$(lsof -ti tcp:"$PORT" 2>/dev/null || true)"
if [ -n "$STRAY" ]; then
  echo "killing process(es) on port $PORT: $STRAY"
  kill $STRAY 2>/dev/null
  sleep 1
  STRAY="$(lsof -ti tcp:"$PORT" 2>/dev/null || true)"
  if [ -n "$STRAY" ]; then
    echo "still listening, sending SIGKILL"
    kill -9 $STRAY 2>/dev/null
  fi
  stopped=1
fi

if [ "$stopped" = "1" ]; then
  echo "stopped"
else
  echo "nothing running on port $PORT"
fi
