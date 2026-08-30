#!/usr/bin/env bash
# (Re)start the Checkarr server in the background and wait until it answers.
# Stops any instance first: the pid file if present, otherwise whatever is
# listening on the port (e.g. a server started outside these scripts).
# Logs land in data/server.log, truncated on every start.
#
#   bash scripts/start.sh              build + (re)start
#   NO_BUILD=1 bash scripts/start.sh   (re)start without rebuilding
set -u
cd "$(dirname "$0")/.."

PORT="${CHECKARR_PORT:-${PORT:-6767}}"
PID_FILE="data/checkarr.pid"
LOG_FILE="data/server.log"

# stop a previous instance we know about
if [ -f "$PID_FILE" ]; then
  PID="$(cat "$PID_FILE")"
  if kill -0 "$PID" 2>/dev/null; then
    echo "stopping previous instance (pid $PID)"
    kill "$PID" 2>/dev/null
    for _ in $(seq 1 20); do
      kill -0 "$PID" 2>/dev/null || break
      sleep 0.5
    done
    kill -0 "$PID" 2>/dev/null && kill -9 "$PID" 2>/dev/null
  fi
  rm -f "$PID_FILE"
fi

# anything else squatting on the port
STRAY="$(lsof -ti tcp:"$PORT" 2>/dev/null || true)"
if [ -n "$STRAY" ]; then
  echo "killing process(es) on port $PORT: $STRAY"
  kill $STRAY 2>/dev/null
  sleep 1
  STRAY="$(lsof -ti tcp:"$PORT" 2>/dev/null || true)"
  [ -n "$STRAY" ] && kill -9 $STRAY 2>/dev/null
fi

# fresh build so the running code matches the source
if [ "${NO_BUILD:-0}" != "1" ]; then
  echo "building..."
  pnpm build || { echo "build failed - not starting"; exit 1; }
fi

nohup node apps/server/dist/index.js >"$LOG_FILE" 2>&1 &
echo $! > "$PID_FILE"
echo "started pid $(cat "$PID_FILE"), logs: $LOG_FILE"

for _ in $(seq 1 30); do
  if curl -sf -o /dev/null "http://127.0.0.1:${PORT}/api/stats"; then
    echo "up: http://127.0.0.1:${PORT}"
    exit 0
  fi
  sleep 0.5
done

echo "server did not become ready within 15s - last log lines:"
tail -n 20 "$LOG_FILE"
exit 1
