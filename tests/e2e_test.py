"""End-to-end browser test (mouse-as-gaze). Usage: python e2e_test.py http://localhost:8000"""
import json
import sys

from playwright.sync_api import sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8000"
CHROME = "/usr/bin/google-chrome"


def card_center(page, slot):
    b = page.locator(f'.card[data-slot="{slot}"]').bounding_box()
    return b["x"] + b["width"] / 2, b["y"] + b["height"] / 2


def look(page, slot, ms):
    x, y = card_center(page, slot)
    page.mouse.move(x, y, steps=4)
    page.wait_for_timeout(ms)


def run(condition, generator, shots=False):
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=CHROME, args=["--no-sandbox"])
        page = browser.new_page(viewport={"width": 1400, "height": 860}, accept_downloads=True)
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("console", lambda m: m.type == "error" and errors.append(m.text))
        page.goto(BASE)
        page.select_option('select[name="condition"]', condition)
        page.select_option('select[name="gazeSource"]', "mouse")
        page.select_option('select[name="generator"]', generator)
        page.fill('input[name="roundSec"]', "0")
        page.fill('input[name="maxRounds"]', "4")
        page.check('input[name="showHeat"]')
        page.check('input[name="showGaze"]')
        if shots:
            page.screenshot(path=f"shot_setup.png")
        page.click('button[type="submit"]')
        page.wait_for_function("window.__gazeforge.phase === 'round'")

        for r in range(3):
            # Look mostly at slot 2, glance at 0 and come back (revisit)
            look(page, 2, 700); look(page, 0, 250); look(page, 2, 500)
            if shots and r == 1:
                page.screenshot(path=f"shot_round_{condition}.png")
            if condition == "explicit":
                page.click('.card[data-slot="2"]')
            elif condition == "hybrid" and r == 0:
                page.click('.card[data-slot="2"]')
            else:
                page.keyboard.press("Space")
            if shots and r == 0:
                page.wait_for_timeout(500)
                page.screenshot(path=f"shot_steer_{condition}.png")
            page.wait_for_function(f"window.__gazeforge.phase === 'round' && window.__gazeforge.round === {r + 1}", timeout=15000)

        look(page, 1, 600)
        page.keyboard.press("Enter")
        page.wait_for_function("window.__gazeforge.phase === 'pick'")
        page.click('.card[data-slot="1"]')
        page.wait_for_selector("#screen-quest.active")
        for i in range(10):
            page.check(f'input[name="sus_{i}"][value="{4 if i % 2 == 0 else 2}"]')
        page.click('#quest-form button[type="submit"]')
        page.wait_for_selector("#screen-summary.active")
        page.wait_for_function("document.querySelector('#upload-status').textContent.length > 0", timeout=5000)
        if shots:
            page.screenshot(path=f"shot_summary_{condition}.png")
        with page.expect_download() as dl:
            page.click("#dl-csv")
        csv_path = dl.value.path()
        csv = open(csv_path).read().splitlines()
        session = page.evaluate("window.__gazeforge.session")
        upload = page.inner_text("#upload-status")
        browser.close()

    rounds = session["rounds"]
    r0 = rounds[0]
    dwell = [o["dwellMs"] for o in r0["options"]]
    print(f"[{condition}/{generator}] rounds={len(rounds)} csv_rows={len(csv) - 1} gaze_samples={len(session['gaze'])} "
          f"r0 dwell={[round(d) for d in dwell]} entries={[o['entries'] for o in r0['options']]} "
          f"weights={[round(w, 2) for w in r0['weights']] if r0['weights'] else None} render={r0['render']} "
          f"summary={json.dumps(session['summary'])} | {upload}")
    assert not errors, errors
    assert len(rounds) == 4 and len(csv) - 1 == 16
    assert max(range(4), key=lambda i: dwell[i]) == 2, "slot 2 should have the most dwell"
    assert r0["options"][2]["entries"] >= 2, "revisit should be counted"
    assert session["final"]["slot"] == 1


if __name__ == "__main__":
    run("gaze", "mock", shots=True)
    run("explicit", "mock", shots=True)
    run("hybrid", "mock")
    if len(sys.argv) > 2:
        BASE = sys.argv[2]
        run("gaze", "comfy", shots=False)
    print("ALL PASSED")
