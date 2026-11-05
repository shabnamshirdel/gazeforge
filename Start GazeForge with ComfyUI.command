#!/bin/bash
# Double-click to start ComfyUI + GazeForge (ComfyUI mode). Close the window or press Ctrl+C to stop.
cd "$(dirname "$0")"
bash start_with_comfyui.sh 2>&1 | tee data/start.log
