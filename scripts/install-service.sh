#!/usr/bin/env bash
# Install a systemd *user* service so the local SenseVoice server starts
# automatically with your session (and restarts if it crashes), instead of you
# having to run ./scripts/serve-sensevoice.sh in a terminal every time.
#
#   ./scripts/install-service.sh                    # install + enable + start
#   FUNASR_DEVICE=cuda ./scripts/install-service.sh # same, on GPU
#   ./scripts/install-service.sh --uninstall        # stop + remove the unit
#
# The generated unit points at this checkout, so don't move/delete the
# directory afterwards (re-run this script if you do).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT="$UNIT_DIR/sensevoice.service"
HOST="${FUNASR_HOST:-127.0.0.1}"
PORT="${FUNASR_PORT:-8000}"
DEVICE="${FUNASR_DEVICE:-cpu}"

command -v systemctl >/dev/null 2>&1 || { echo "error: systemd is not available" >&2; exit 1; }
systemctl --user show-environment >/dev/null 2>&1 || {
  echo "error: no systemd user session. Log in normally (not via su/sudo) and retry." >&2
  exit 1
}

if [ "${1:-}" = "--uninstall" ]; then
  systemctl --user disable --now sensevoice.service 2>/dev/null || true
  rm -f "$UNIT"
  systemctl --user daemon-reload
  echo "==> stopped and removed $UNIT"
  exit 0
fi

# systemd splits ExecStart on whitespace; quote paths that contain spaces.
quote() {
  case "$1" in
    *[[:space:]]*) printf '"%s"' "$1" ;;
    *) printf '%s' "$1" ;;
  esac
}

if ss -ltn 2>/dev/null | grep -q ":$PORT "; then
  if ! systemctl --user is-active --quiet sensevoice.service 2>/dev/null; then
    echo "warning: $HOST:$PORT is already in use by another process." >&2
    echo "         Stop it first (e.g. a manual ./scripts/serve-sensevoice.sh)," >&2
    echo "         otherwise the service will keep failing to bind." >&2
  fi
fi

mkdir -p "$UNIT_DIR"
cat > "$UNIT" <<EOF
[Unit]
Description=Local SenseVoice (FunASR) OpenAI-compatible transcription server for opencode-voice
Documentation=https://github.com/worldcupfantasy/opencode-voice
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$(quote "$ROOT")
ExecStart=$(quote "$ROOT/scripts/serve-sensevoice.sh")
Environment=FUNASR_HOST=$HOST
Environment=FUNASR_PORT=$PORT
Environment=FUNASR_DEVICE=$DEVICE
Restart=on-failure
RestartSec=5
# Loading the model on CPU can take a while; don't time the start out.
TimeoutStartSec=0

[Install]
WantedBy=default.target
EOF

echo "==> wrote $UNIT"
systemctl --user daemon-reload
systemctl --user enable --now sensevoice.service

echo "==> waiting for ${HOST}:${PORT} ..."
for _ in $(seq 1 120); do
  if curl -s -m 2 "http://${HOST}:${PORT}/health" >/dev/null 2>&1; then
    echo "==> up: $(curl -s -m 5 "http://${HOST}:${PORT}/health")"
    echo "==> it now starts automatically with your session."
    exit 0
  fi
  if ! systemctl --user is-active --quiet sensevoice.service; then
    echo "error: service died during startup:" >&2
    journalctl --user -u sensevoice.service --no-pager -n 20 >&2
    exit 1
  fi
  sleep 1
done

echo "error: still not up after 120s; check: journalctl --user -u sensevoice.service" >&2
exit 1
