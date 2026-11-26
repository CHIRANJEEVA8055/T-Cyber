#!/usr/bin/env bash
# Run every minute by t-cyber-health.timer (installed by scripts/service.sh).
#
# systemd already restarts the app when its process exits. This covers the cases it cannot see:
#   - a process that is still running but no longer answers: restarted after three failed checks in a row;
#   - a reload storm: right after a cold start, the Next.js 16.4 dev server can tell every open tab to reload
#     ("HMR hash mismatch") on each reload, forever. Pages still answer 200, so only the log shows it: one
#     "Compiled in" line per reload, dozens a minute, where normal editing logs at most a few. Restarted at once.
# It never starts a service that someone stopped on purpose.
set -uo pipefail
PORT="${T_CYBER_PORT:-3000}"
UNIT=t-cyber.service
STATE="${XDG_RUNTIME_DIR:-/tmp}/t-cyber-health.failures"
GRACE_SECONDS=180 # after a (re)start: the first dev-server compile of a page is slow. Keep above the storm window.
LIMIT=3
STORM_WINDOW=2min
STORM_LIMIT=30 # recompiles in the window; editing peaked at 8, storms ran 50 to over 170

if [ "$(systemctl --user is-active "$UNIT")" != active ]; then
  rm -f "$STATE"
  exit 0
fi

started="$(systemctl --user show "$UNIT" -p ActiveEnterTimestamp --value --timestamp=unix)"
started="${started#@}"
if [[ "$started" =~ ^[0-9]+$ ]] && [ $(($(date +%s) - started)) -lt "$GRACE_SECONDS" ]; then
  exit 0
fi

compiles="$(journalctl --user -u "$UNIT" --since "-$STORM_WINDOW" -o cat --no-pager 2>/dev/null | grep -c "Compiled in")"
if [ "${compiles:-0}" -ge "$STORM_LIMIT" ]; then
  echo "t-cyber health: $compiles recompiles in $STORM_WINDOW, so open tabs are stuck reloading; restarting $UNIT"
  rm -f "$STATE"
  systemctl --user restart "$UNIT"
  exit 0
fi

code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 60 "http://127.0.0.1:$PORT/login" || true)"
if [ "$code" = 200 ]; then
  rm -f "$STATE"
  exit 0
fi

failures=$(($(cat "$STATE" 2>/dev/null || echo 0) + 1))
echo "$failures" >"$STATE"
echo "t-cyber health: the sign-in page answered '${code:-nothing}' ($failures of $LIMIT failed checks in a row)"
if [ "$failures" -ge "$LIMIT" ]; then
  rm -f "$STATE"
  echo "t-cyber health: restarting $UNIT"
  systemctl --user restart "$UNIT"
fi
