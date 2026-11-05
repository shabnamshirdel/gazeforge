"""Minimal fake ComfyUI (/prompt, /history, /view, /system_stats) for testing the bridge without a GPU."""
import io
import uuid

from fastapi import FastAPI
from fastapi.responses import Response
from PIL import Image

app = FastAPI()
JOBS: dict = {}


@app.get("/system_stats")
def stats():
    return {"system": {"os": "fake"}}


@app.post("/prompt")
def prompt(body: dict):
    wf = body["prompt"]
    pid = str(uuid.uuid4())
    text = next(n["inputs"]["text"] for n in wf.values() if n["class_type"] == "CLIPTextEncode")
    seed = next(n["inputs"]["seed"] for n in wf.values() if n["class_type"] == "KSampler")
    JOBS[pid] = {"text": text, "seed": seed, "polls": 0}
    return {"prompt_id": pid, "number": len(JOBS)}


@app.get("/history/{pid}")
def history(pid: str):
    job = JOBS[pid]
    job["polls"] += 1
    if job["polls"] < 2:  # pretend it takes a moment
        return {}
    return {pid: {"status": {"status_str": "success"},
                  "outputs": {"9": {"images": [{"filename": f"{pid}.png", "subfolder": "", "type": "output"}]}}}}


@app.get("/view")
def view(filename: str, subfolder: str = "", type: str = "output"):
    img = Image.new("RGB", (64, 64), (200, 120, 40))
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return Response(buf.getvalue(), media_type="image/png")
