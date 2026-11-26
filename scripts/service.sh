#!/usr/bin/env bash
# Keeps T-CYBER running as a systemd user service: it starts at boot (no login needed), survives closed
# SSH and VS Code sessions and ended Claude sessions, restarts within seconds if the process exits or is
# killed, and is restarted by a health check if it stops answering. It stops only when you stop it here.
#
#   scripts/service.sh install        install (or update) and start the service and its health check
#   scripts/service.sh status         state, addresses and the last log lines
#   scripts/service.sh logs           follow the log (Ctrl+C stops following, not the app)
#   scripts/service.sh restart        restart the app
#   scripts/service.sh clean-restart  restart with an empty dev-server cache (stale-page problems)
#   scripts/service.sh stop           stop the app; it stays stopped until start (or the next boot)
#   scripts/service.sh start          start it again
#   scripts/service.sh disable        stop it and do not start it at boot
#   scripts/service.sh uninstall      stop it and remove the service files
set -euo pipefail
ROOT="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
APP=t-cyber.service
HEALTH=t-cyber-health
PORT="${T_CYBER_PORT:-3000}"
sc() { systemctl --user "$@"; }

addresses() {
  echo "Open the app at:"
  echo "  http://localhost:$PORT"
  local ip
  for ip in $(ip -4 -o addr show scope global 2>/dev/null | awk '$2 !~ /^(docker|br-|veth)/ {split($4, a, "/"); print a[1]}'); do
    echo "  http://$ip:$PORT"
  done
}

install_units() {
  local node_dir
  node_dir="$(dirname "$(command -v node)")"
  mkdir -p "$UNIT_DIR"
  cat >"$UNIT_DIR/$APP" <<EOF
[Unit]
Description=T-CYBER web app (Next.js dev server on port $PORT)
Documentation=file://$ROOT/README.md
# Never give up restarting, however often it fails.
StartLimitIntervalSec=0

[Service]
Type=simple
WorkingDirectory=$ROOT
Environment=PATH=$node_dir:/usr/local/bin:/usr/bin:/bin
Environment=T_CYBER_PORT=$PORT
ExecStart=$ROOT/scripts/serve.sh
Restart=always
RestartSec=5
TimeoutStopSec=20
SyslogIdentifier=t-cyber

[Install]
WantedBy=default.target
EOF
  cat >"$UNIT_DIR/$HEALTH.service" <<EOF
[Unit]
Description=T-CYBER health check (restarts the app if it stops answering)

[Service]
Type=oneshot
Environment=T_CYBER_PORT=$PORT
ExecStart=$ROOT/scripts/health-check.sh
SyslogIdentifier=t-cyber-health
EOF
  cat >"$UNIT_DIR/$HEALTH.timer" <<EOF
[Unit]
Description=Check every minute that T-CYBER answers

[Timer]
OnBootSec=3min
OnUnitActiveSec=1min
AccuracySec=10s

[Install]
WantedBy=timers.target
EOF
}

case "${1:-status}" in
  install)
    install_units
    sc daemon-reload
    sc enable "$APP" "$HEALTH.timer" >/dev/null
    sc restart "$APP"
    sc start "$HEALTH.timer"
    if [ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null)" != yes ]; then
      echo "Note: lingering is off, so the app starts only when $USER logs in. To start it at boot, run:"
      echo "  sudo loginctl enable-linger $USER"
    fi
    echo "Installed and started $APP; the health check runs every minute."
    addresses
    ;;
  status)
    sc --no-pager status "$APP" "$HEALTH.timer" || true
    addresses
    ;;
  logs) journalctl --user -u "$APP" -u "$HEALTH.service" -n 50 -f ;;
  start | stop | restart) sc "$1" "$APP" ;;
  clean-restart)
    sc stop "$APP"
    rm -rf "$ROOT/.next/dev"
    sc start "$APP"
    ;;
  disable) sc disable --now "$APP" "$HEALTH.timer" ;;
  uninstall)
    sc disable --now "$APP" "$HEALTH.timer" 2>/dev/null || true
    rm -f "$UNIT_DIR/$APP" "$UNIT_DIR/$HEALTH.service" "$UNIT_DIR/$HEALTH.timer"
    sc daemon-reload
    echo "Removed. Start the app by hand with: npm run dev"
    ;;
  *)
    sed -n '2,15p' "$0"
    exit 2
    ;;
esac
