#!/usr/bin/env bash
# Start a local SenseVoiceSmall HTTP server (OpenAI-compatible transcription)
# for the opencode-sensevoice-voice TUI plugin.
#
#   ./scripts/serve-sensevoice.sh
#   FUNASR_DEVICE=cuda ./scripts/serve-sensevoice.sh
#
# It creates a Python 3.11 virtualenv (via uv), installs FunASR + a CPU build
# of torch, then serves http://127.0.0.1:8000/v1/audio/transcriptions
# with the model alias `sensevoice` (SenseVoiceSmall + FSMN-VAD).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV="${VENV:-$ROOT/.venv}"
PYTHON="${PYTHON:-3.11}"
HOST="${FUNASR_HOST:-127.0.0.1}"
PORT="${FUNASR_PORT:-8000}"
DEVICE="${FUNASR_DEVICE:-cpu}"
MODEL="${FUNASR_MODEL:-sensevoice}"

command -v uv >/dev/null 2>&1 || {
  echo "error: 'uv' is required (https://docs.astral.sh/uv/). Install it and retry." >&2
  exit 1
}

if [ ! -x "$VENV/bin/python" ]; then
  echo "==> creating venv ($PYTHON) at $VENV"
  uv venv --python "$PYTHON" "$VENV"
fi

if ! "$VENV/bin/python" -c "import funasr" >/dev/null 2>&1; then
  echo "==> installing torch (CPU build) + funasr"
  if ! uv pip install --python "$VENV" torch torchaudio \
    --index-url https://download.pytorch.org/whl/cpu; then
    echo "warning: CPU torch index failed; falling back to PyPI" >&2
    uv pip install --python "$VENV" torch torchaudio
  fi
  uv pip install --python "$VENV" funasr fastapi uvicorn python-multipart
fi

echo "==> serving SenseVoiceSmall on http://$HOST:$PORT (device=$DEVICE, model=$MODEL)"
exec "$VENV/bin/funasr-server" \
  --host "$HOST" --port "$PORT" --device "$DEVICE" --model "$MODEL" "$@"
