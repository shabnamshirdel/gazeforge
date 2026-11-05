#!/bin/bash
# Double-click to install ComfyUI + SDXL-Turbo for GazeForge. Output is also saved to data/setup.log
cd "$(dirname "$0")"
bash setup_comfyui.sh 2>&1 | tee data/setup.log
echo; read -p "Press Enter to close this window…"
