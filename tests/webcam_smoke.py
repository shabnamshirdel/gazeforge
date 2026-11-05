import pathlib
from playwright.sync_api import sync_playwright
PKG = pathlib.Path("/tmp/mp/package")  # extract: npm pack @mediapipe/tasks-vision@0.10.14
def serve(route):
    rel = route.request.url.split("tasks-vision@0.10.14/")[1]
    f = PKG / rel
    ct = "application/wasm" if rel.endswith(".wasm") else "text/javascript"
    route.fulfill(status=200, body=f.read_bytes(), headers={"content-type": ct, "access-control-allow-origin": "*"}) if f.exists() else route.fulfill(status=404)
with sync_playwright() as p:
    b = p.chromium.launch(executable_path="/usr/bin/google-chrome", args=["--no-sandbox","--use-fake-device-for-media-stream","--use-fake-ui-for-media-stream"])
    pg = b.new_page()
    pg.route("https://cdn.jsdelivr.net/**", serve)
    pg.goto("http://localhost:8000")
    pg.select_option('select[name="gazeSource"]', "webcam")
    pg.click('button[type="submit"]')
    pg.wait_for_function("!document.querySelector('#calib-start').disabled || /Could not/.test(document.querySelector('#calib-status').textContent)", timeout=60000)
    print("status:", pg.inner_text('#calib-status'))
    b.close()
