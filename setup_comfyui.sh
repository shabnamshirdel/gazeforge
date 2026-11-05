#!/bin/bash
# One-time setup of ComfyUI + SDXL-Turbo on an Apple Silicon Mac, for GazeForge.
#   Run:  bash ~/Downloads/gazeforge/setup_comfyui.sh
# Safe to re-run: finished steps are skipped and the model download resumes where it stopped.
set -e

COMFY_DIR="$HOME/ComfyUI"
MODEL_DIR="$COMFY_DIR/models/checkpoints"
MODEL="$MODEL_DIR/sd_xl_turbo_1.0_fp16.safetensors"
MODEL_URL="https://huggingface.co/stabilityai/sdxl-turbo/resolve/main/sd_xl_turbo_1.0_fp16.safetensors"
ENV_NAME="comfyui-arm64"

# Find conda (Anaconda is in /opt/anaconda3 on this Mac)
CONDA_BASE="$(conda info --base 2>/dev/null || true)"
for c in "$CONDA_BASE" /opt/anaconda3 "$HOME/anaconda3" "$HOME/miniconda3" /opt/miniconda3; do
  if [ -n "$c" ] && [ -x "$c/bin/conda" ]; then CONDA_BASE="$c"; break; fi
done
[ -x "$CONDA_BASE/bin/conda" ] || { echo "Could not find conda. Install Anaconda/Miniconda first."; exit 1; }
CONDA="$CONDA_BASE/bin/conda"
PY="$CONDA_BASE/envs/$ENV_NAME/bin/python"

echo ""
echo "==> 1/4  ComfyUI code → $COMFY_DIR"
if [ -f "$COMFY_DIR/main.py" ]; then
  echo "     already installed"
elif xcode-select -p >/dev/null 2>&1; then
  git clone --depth 1 https://github.com/comfyanonymous/ComfyUI.git "$COMFY_DIR"
else
  curl -L --fail -o /tmp/comfyui.zip https://github.com/comfyanonymous/ComfyUI/archive/refs/heads/master.zip
  unzip -q -o /tmp/comfyui.zip -d /tmp && mv /tmp/ComfyUI-master "$COMFY_DIR"
fi

echo ""
echo "==> 2/4  Native Apple Silicon Python 3.12 environment '$ENV_NAME' (separate from your base Anaconda)"
if [ -x "$PY" ]; then
  echo "     already exists"
else
  # Your Anaconda may be the Intel (x86_64) build; CONDA_SUBDIR forces a native arm64 env so PyTorch can use the GPU
  CONDA_SUBDIR=osx-arm64 "$CONDA" create -y -n "$ENV_NAME" --override-channels -c conda-forge python=3.12
fi

echo ""
echo "==> 3/4  PyTorch (Apple GPU / MPS) + ComfyUI requirements — a few minutes"
ARCH="$("$PY" -c 'import platform; print(platform.machine())')"
echo "     Python architecture: $ARCH"
[ "$ARCH" = "arm64" ] || { echo "Python is $ARCH, not arm64: PyTorch could not use the Apple GPU. Stopping."; exit 1; }
"$PY" -m pip install --upgrade pip -q
"$PY" -m pip install torch torchvision torchaudio
"$PY" -m pip install -r "$COMFY_DIR/requirements.txt"
"$PY" -c "import torch; print('     PyTorch', torch.__version__, '| Apple GPU (MPS) available:', torch.backends.mps.is_available())"

echo ""
echo "==> 4/4  SDXL-Turbo model (6.9 GB) → $MODEL_DIR"
mkdir -p "$MODEL_DIR"
if [ -f "$MODEL" ] && [ "$(stat -f%z "$MODEL")" -gt 6900000000 ]; then
  echo "     already downloaded"
else
  curl -L --fail -C - -o "$MODEL" "$MODEL_URL"
fi

echo ""
echo "✅ Done. Start everything with:"
echo "     bash ~/Downloads/gazeforge/start_with_comfyui.sh"
echo "   then open http://localhost:8000 and choose Generator → 'ComfyUI via backend'."
