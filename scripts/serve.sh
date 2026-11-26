#!/usr/bin/env bash
# Entry point of the t-cyber systemd user service (installed by scripts/service.sh). Do not run it by hand
# while the service is active: it would compete for the port.
#
# Runs the Next.js dev server so code changes show up without a rebuild. It listens on every interface,
# as `npm run dev` does, so the app is reachable on the LAN and the tailnet as well as on localhost.
set -uo pipefail
cd "$(dirname "$(readlink -f "$0")")/.."
PORT="${T_CYBER_PORT:-3000}"
export NEXT_TELEMETRY_DISABLED=1

# A dev server started by hand or by an agent would make this start fail. Say who holds the port; systemd
# tries again a few seconds later, so the service takes over as soon as that process stops.
holder="$(ss -ltnpH "sport = :$PORT" 2>/dev/null)"
if [ -n "$holder" ]; then
  echo "t-cyber: port $PORT is already in use: $holder" >&2
  echo "t-cyber: stop that process; this service starts as soon as the port is free." >&2
  exit 75
fi

# Bring the database schema up to date (does nothing when it already is). A failure is logged but does not
# keep the app down: pages that need a missing table will show their error state instead.
if ! node_modules/.bin/prisma migrate deploy; then
  echo "t-cyber: database migration failed; starting the app anyway (see the messages above)." >&2
fi

exec node_modules/.bin/next dev --port "$PORT"
