import sys, pathlib
from playwright.sync_api import sync_playwright
root = pathlib.Path(__file__).resolve().parents[2] / 'src' / 'renderer'
mock = (pathlib.Path(__file__).parent / 'mock.js').read_text()
out = pathlib.Path(sys.argv[1])
with sync_playwright() as p:
    b = p.chromium.launch()
    for scheme in ['dark']:
        pg = b.new_page(viewport={'width': 1320, 'height': 840}, color_scheme=scheme)
        errs = []
        pg.on('console', lambda m: errs.append(m.text) if m.type == 'error' else None)
        pg.on('pageerror', lambda e: errs.append(str(e)))
        pg.add_init_script(mock)
        pg.goto((root / 'index.html').as_uri()); pg.wait_for_timeout(1500)
        pg.screenshot(path=str(out / f'library-{scheme}.png'))
        if scheme == 'dark':
            for v in ['performance', 'looks', 'settings']:
                pg.click(f'.dock-items [data-view="{v}"]'); pg.wait_for_timeout(1400)
                pg.screenshot(path=str(out / f'{v}-{scheme}.png'))
        print(scheme, 'errors:', [e for e in errs if 'net::ERR_FILE_NOT_FOUND' not in e and 'Failed to load resource' not in e])
    pg = b.new_page(viewport={'width': 396, 'height': 600}, color_scheme='dark')
    pg.add_init_script(mock)
    pg.goto((root / 'overlay.html').as_uri()); pg.wait_for_timeout(700)
    # simulate a game frame behind the transparent overlay
    pg.evaluate("document.documentElement.style.background='linear-gradient(160deg,#c9d8e6,#e8b47a 55%,#2d3a2c 56%,#10150f)'")
    pg.wait_for_timeout(200)
    pg.screenshot(path=str(out / 'overlay.png'))
    b.close()
