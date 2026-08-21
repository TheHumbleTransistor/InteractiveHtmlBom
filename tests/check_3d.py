#!/usr/bin/env python3
"""Drive a generated BOM in a headless browser and screenshot it.

    python3 tests/check_3d.py /path/to/ibom.html [outprefix]

Exists because nothing else in this repo can tell you whether the 3D view actually renders.
The Python side can be unit tested; WebGL in a browser cannot, and a silent failure there looks
exactly like a blank pane. Chromium's software rasteriser is enough -- no GPU required.

    python3 -m pip install --user playwright && python3 -m playwright install chromium
"""

import sys
import time

from playwright.sync_api import sync_playwright

ARGS = ['--enable-unsafe-swiftshader', '--use-gl=swiftshader', '--ignore-gpu-blocklist']


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    url = sys.argv[1]
    if '://' not in url:
        import pathlib
        url = pathlib.Path(url).absolute().as_uri()
    out = sys.argv[2] if len(sys.argv) > 2 else '/tmp/ibom3d'

    with sync_playwright() as p:
        browser = p.chromium.launch(args=ARGS)
        page = browser.new_page(viewport={'width': 1500, 'height': 950})
        errors = []
        page.on('console', lambda m: errors.append(m.text[:200]) if m.type == 'error' else None)
        page.on('pageerror', lambda e: errors.append('pageerror: ' + str(e)[:200]))

        t0 = time.time()
        page.goto(url)
        page.wait_for_load_state('load')
        has3d = page.evaluate('window.has3D === true')
        print('load        : %.1f s' % (time.time() - t0))
        print('3D embedded : %s' % has3d)
        print('bom rows    : %d' % len(page.query_selector_all('#bombody tr')))

        if has3d:
            page.click('#view3d-btn')
            page.wait_for_function('window.__ibom3dReady === true', timeout=120000)
            print('bom rows 3D : %d  <- must not drop to 0' %
                  len(page.query_selector_all('#bombody tr')))
            page.screenshot(path=out + '_board.png')

            rows = page.query_selector_all('#bombody tr')
            if rows:
                rows[0].click()
                page.wait_for_timeout(2000)
                page.screenshot(path=out + '_selected.png')
                print('note        : %r' %
                      page.evaluate('document.getElementById("board3d-missing").textContent'))
            print('screenshots : %s_board.png %s_selected.png' % (out, out))

        print('errors      : %s' % (errors[:5] or 'none'))
        browser.close()
        return 1 if errors else 0


if __name__ == '__main__':
    sys.exit(main())
