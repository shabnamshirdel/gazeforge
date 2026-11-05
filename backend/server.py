"""
GazeForge backend — serves the web app, bridges to ComfyUI, and stores session logs.

Run:
    pip install -r requirements.txt
    GF_MODE=mock  python server.py          # no GPU needed: returns placeholder images
    GF_MODE=comfy python server.py          # forwards prompts to a running ComfyUI

Environment variables:
    GF_MODE        mock | comfy                       (default: mock)
    COMFY_URL      ComfyUI address                    (default: http://127.0.0.1:8188)
    GF_WORKFLOW    path to an API-format workflow     (default: workflows/txt2img_sdxl_turbo.json)
    GF_CKPT        checkpoint filename to inject      (default: keep what the workflow says)
    GF_PORT        port for this server               (default: 8000)
"""
from __future__ import annotations

import asyncio
import base64
import copy
import hashlib
import io
import json
import os
import re
import uuid
from datetime import datetime
from pathlib import Path

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

ROOT = Path(__file__).resolve().parent
WEB_DIR = ROOT.parent / "web"
DATA_DIR = ROOT.parent / "data"
DATA_DIR.mkdir(exist_ok=True)

MODE = os.getenv("GF_MODE", "mock").lower()
COMFY_URL = os.getenv("COMFY_URL", "http://127.0.0.1:8188").rstrip("/")
WORKFLOW_PATH = Path(os.getenv("GF_WORKFLOW", ROOT / "workflows" / "txt2img_sdxl_turbo.json"))
CKPT = os.getenv("GF_CKPT")
TIMEOUT_S = 180

app = FastAPI(title="GazeForge backend")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


class Item(BaseModel):
    prompt: str
    negative: str = ""
    seed: int = 0


class GenerateRequest(BaseModel):
    items: list[Item] = Field(..., min_length=1, max_length=8)
    width: int = Field(512, ge=256, le=1536)
    height: int = Field(512, ge=256, le=1536)


# ---------------------------------------------------------------------------
# Workflow handling
#
# The workflow is ComfyUI's "API format" JSON (in ComfyUI: Settings → enable Dev mode →
# "Save (API Format)"). Nodes are found by class_type / _meta.title, so you can swap in your
# own workflow (Flux, ControlNet, IP-Adapter …) as long as it has:
#   - a KSampler (or any node with a "seed"/"noise_seed" input)
#   - CLIPTextEncode nodes titled "positive" and "negative" (or the first two encoders)
#   - an EmptyLatentImage (for width/height), optional
#   - a SaveImage node
# ---------------------------------------------------------------------------
def load_workflow() -> dict:
    with open(WORKFLOW_PATH) as f:
        return json.load(f)


def _find(wf: dict, pred) -> list[str]:
    return [nid for nid, node in wf.items() if pred(node)]


def fill_workflow(template: dict, item: Item, width: int, height: int) -> dict:
    wf = copy.deepcopy(template)
    encoders = _find(wf, lambda n: n.get("class_type") == "CLIPTextEncode")
    titled = {wf[n].get("_meta", {}).get("title", "").lower(): n for n in encoders}
    pos = titled.get("positive", encoders[0] if encoders else None)
    neg = titled.get("negative", encoders[1] if len(encoders) > 1 else None)
    if pos is None:
        raise HTTPException(500, "Workflow has no CLIPTextEncode node for the prompt")
    wf[pos]["inputs"]["text"] = item.prompt
    if neg is not None:
        wf[neg]["inputs"]["text"] = item.negative

    for nid, node in wf.items():
        ins = node.get("inputs", {})
        for key in ("seed", "noise_seed"):
            if key in ins and not isinstance(ins[key], list):
                ins[key] = item.seed
        if node.get("class_type") == "EmptyLatentImage" or node.get("class_type") == "EmptySD3LatentImage":
            ins["width"], ins["height"] = width, height
        if CKPT and node.get("class_type") == "CheckpointLoaderSimple":
            ins["ckpt_name"] = CKPT
    return wf


async def comfy_generate_one(client: httpx.AsyncClient, template: dict, item: Item, w: int, h: int) -> str:
    client_id = str(uuid.uuid4())
    wf = fill_workflow(template, item, w, h)
    r = await client.post(f"{COMFY_URL}/prompt", json={"prompt": wf, "client_id": client_id})
    if r.status_code != 200:
        raise HTTPException(502, f"ComfyUI rejected the workflow: {r.text[:500]}")
    prompt_id = r.json()["prompt_id"]

    # Poll history until the job has outputs
    deadline = asyncio.get_event_loop().time() + TIMEOUT_S
    while True:
        hr = await client.get(f"{COMFY_URL}/history/{prompt_id}")
        hist = hr.json().get(prompt_id)
        if hist:
            status = hist.get("status", {})
            if status.get("status_str") == "error":
                raise HTTPException(502, f"ComfyUI error: {json.dumps(status)[:500]}")
            for node_out in hist.get("outputs", {}).values():
                for img in node_out.get("images", []):
                    vr = await client.get(f"{COMFY_URL}/view", params={
                        "filename": img["filename"], "subfolder": img.get("subfolder", ""), "type": img.get("type", "output"),
                    })
                    mime = "image/png" if img["filename"].lower().endswith(".png") else "image/jpeg"
                    return f"data:{mime};base64,{base64.b64encode(vr.content).decode()}"
        if asyncio.get_event_loop().time() > deadline:
            raise HTTPException(504, "ComfyUI timed out")
        await asyncio.sleep(0.4)


# ---------------------------------------------------------------------------
# Mock generator — deterministic placeholder images so the full pipeline can be tested without a GPU
def mock_image(item: Item, w: int, h: int) -> str:
    from PIL import Image, ImageDraw

    digest = hashlib.sha256(f"{item.prompt}|{item.seed}".encode()).digest()
    hue_rgb = tuple(80 + b % 150 for b in digest[:3])
    img = Image.new("RGB", (w, h), (238, 235, 229))
    d = ImageDraw.Draw(img)
    cx = w // 2
    d.ellipse([cx - 70, h - 60, cx + 70, h - 35], fill=(70, 70, 70))
    d.line([cx, h - 50, cx + (digest[4] % 60) - 30, h // 3], fill=(60, 60, 60), width=8)
    top = h // 3
    d.polygon([(cx - 50, top - 70), (cx + 50, top - 70), (cx + 85, top + 10), (cx - 85, top + 10)], fill=hue_rgb)
    words = re.sub(r"\s+", " ", item.prompt)[:140]
    lines = [words[i:i + 46] for i in range(0, len(words), 46)]
    for i, line in enumerate(lines):
        d.text((14, 12 + i * 14), line, fill=(90, 90, 90))
    d.text((14, h - 22), f"MOCK · seed {item.seed}", fill=(150, 150, 150))
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()


# ---------------------------------------------------------------------------
@app.get("/api/health")
async def health():
    reachable = None
    if MODE == "comfy":
        try:
            async with httpx.AsyncClient(timeout=2) as c:
                reachable = (await c.get(f"{COMFY_URL}/system_stats")).status_code == 200
        except httpx.HTTPError:
            reachable = False
    return {"mode": MODE, "comfy_url": COMFY_URL if MODE == "comfy" else None, "comfy_reachable": reachable,
            "workflow": WORKFLOW_PATH.name}


@app.post("/api/generate")
async def generate(req: GenerateRequest):
    if MODE == "mock":
        await asyncio.sleep(0.3)  # feel a bit like real generation
        return {"images": [mock_image(it, req.width, req.height) for it in req.items], "mode": "mock"}

    template = load_workflow()
    async with httpx.AsyncClient(timeout=30) as client:
        # ComfyUI queues jobs internally; submitting them together keeps the GPU busy.
        images = await asyncio.gather(*[comfy_generate_one(client, template, it, req.width, req.height) for it in req.items])
    return {"images": images, "mode": "comfy"}


@app.post("/api/log")
async def save_log(session: dict):
    sid = re.sub(r"[^A-Za-z0-9_.-]", "_", str(session.get("sessionId", f"session_{datetime.now():%Y%m%d_%H%M%S}")))
    path = DATA_DIR / f"{sid}.json"
    path.write_text(json.dumps(session))
    return {"saved": str(path.relative_to(ROOT.parent))}


# The web app (mounted last so /api routes take precedence)
app.mount("/", StaticFiles(directory=WEB_DIR, html=True), name="web")


if __name__ == "__main__":
    import uvicorn

    port = int(os.getenv("GF_PORT", "8000"))
    print(f"GazeForge backend — mode={MODE}  →  open http://localhost:{port}")
    uvicorn.run(app, host="0.0.0.0", port=port)
