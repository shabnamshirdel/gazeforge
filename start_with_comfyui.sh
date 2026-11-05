#!/bin/bash
# Starts ComfyUI (port 8188, Apple GPU) and the GazeForge backend in ComfyUI mode (port 8000).
#   Run:  bash ~/Downloads/gazeforge/start_with_comfyui.sh
# Press Ctrl+C to stop both. ComfyUI's log goes to data/comfyui.log.

HERE="$(cd "$(dirname "$0")" && pwd)"
COMFY_DIR="$HOME/ComfyUI"

CONDA_BASE="$(conda info --base 2>/dev/null || true)"
for c in "$CONDA_BASE" /opt/anaconda3 "$HOME/anaconda3" "$HOME/miniconda3" /opt/miniconda3; do
  if [ -n "$c" ] && [ -x "$c/bin/python" ]; then CONDA_BASE="$c"; break; fi
done
COMFY_PY="$CONDA_BASE/envs/comfyui-arm64/bin/python"
GF_PY="$CONDA_BASE/bin/python"
[ -x "$COMFY_PY" ] || { echo "ComfyUI isn't set up yet — run: bash $HERE/setup_comfyui.sh"; exit 1; }

if curl -s -o /dev/null http://127.0.0.1:8188/system_stats; then
  echo "ComfyUI is already running on port 8188 — reusing it."
else
  echo "Starting ComfyUI (log: data/comfyui.log)…"
  (cd "$COMFY_DIR" && "$COMFY_PY" main.py --listen 127.0.0.1 --port 8188 --cache-classic > "$HERE/data/comfyui.log" 2>&1) &
  COMFY_PID=$!
  trap 'echo; echo "Stopping ComfyUI…"; kill $COMFY_PID 2>/dev/null; pkill -P $COMFY_PID 2>/dev/null' EXIT
  for i in $(seq 1 120); do
    curl -s -o /dev/null http://127.0.0.1:8188/system_stats && break
    kill -0 $COMFY_PID 2>/dev/null || { echo "ComfyUI failed to start — see data/comfyui.log"; tail -20 "$HERE/data/comfyui.log"; exit 1; }
    sleep 1
  done
  echo "ComfyUI is up."
fi

GF_PORT=8000
if curl -s -o /dev/null http://127.0.0.1:8000/api/health; then
  GF_PORT=8001
  echo "(Port 8000 is taken by an older GazeForge server — using 8001 instead.)"
fi
echo "Starting GazeForge in ComfyUI mode → open http://localhost:$GF_PORT and choose Generator → 'ComfyUI via backend'"
echo "(the first round takes ~20–40 s while the model loads; after that a few seconds per round)"
cd "$HERE/backend" && GF_MODE=comfy GF_PORT=$GF_PORT COMFY_URL=http://127.0.0.1:8188 "$GF_PY" server.py
