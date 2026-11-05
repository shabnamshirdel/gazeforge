"""Build the static demo's image bank from bank_part_*.json files saved by the bank-rendering run.
Usage: python tools/build_bank.py data/bank_part_*.json  ->  writes web/bank/*.webp + web/bank/manifest.json"""
import base64, io, json, sys
from pathlib import Path
from PIL import Image

out = Path(__file__).resolve().parent.parent / 'web' / 'bank'
out.mkdir(parents=True, exist_ok=True)
entries, brief = [], None
for f in sorted(sys.argv[1:]):
    d = json.load(open(f)); brief = d.get('brief', brief)
    for e in d['entries']:
        im = Image.open(io.BytesIO(base64.b64decode(e['image'].split(',', 1)[1]))).convert('RGB').resize((384, 384), Image.LANCZOS)
        name = f"lamp_{e['idx']:03d}.webp"
        im.save(out / name, 'WEBP', quality=78, method=6)
        entries.append({'idx': e['idx'], 'file': name, 'seed': e['seed'], 'genes': e['genes'], 'prompt': e['prompt']})
entries.sort(key=lambda e: e['idx'])
(out / 'manifest.json').write_text(json.dumps({'brief': brief, 'model': 'SDXL-Turbo (4 steps, 512px)', 'entries': entries}))
size = sum(p.stat().st_size for p in out.glob('*.webp'))
print(f'{len(entries)} images, {size / 1e6:.1f} MB -> {out}')
