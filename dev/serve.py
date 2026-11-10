"""Dev server: serves extension/ with a mocked chrome.* API injected into every page,
plus background.js running in-page, so the UI can be exercised in any browser.

    python3 dev/serve.py [--port 8765]          demo bookmarks + history (dev/demo-data.js)
    python3 dev/serve.py --real [PROFILE_DIR]   read-only snapshot of a real Chrome profile
                                                (default ~/.config/google-chrome/Default)

then open http://localhost:<port>/manager.html (or /popup.html).
Mock state lives in the page's localStorage (prefix mock: or real:); /__dev/reset starts over.
Changes made in the preview never touch Chrome. The real snapshot is re-read on /__dev/reset.
"""
import argparse
import http.server
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

HERE = os.path.dirname(os.path.abspath(__file__))
EXT = os.path.join(HERE, "..", "extension")
INJECT = (
    b'<script src="/__dev/fixture.js"></script>'
    b'<script src="/__dev/mock-chrome.js"></script>'
    b'<script type="module" src="/background.js"></script>'
)
RESET = (
    b"<!doctype html><meta charset=utf-8><script>"
    b"Object.keys(localStorage).filter(k=>/^(mock|real):/.test(k)).forEach(k=>localStorage.removeItem(k));"
    b"location.replace('/manager.html')</script>"
)
REAL_PROFILE = None
_fixture_js = None


def fixture_js(refresh=False):
    global _fixture_js
    if _fixture_js is None or refresh:
        import real_data
        snap = real_data.snapshot(REAL_PROFILE)
        snap["real"] = True
        _fixture_js = ("window.__BK_FIXTURE = " + json.dumps(snap, ensure_ascii=False) + ";").encode()
    return _fixture_js


def letter_icon(request_path):
    """Stand-in for Chrome's favicon service: a colored tile with the site's first letter."""
    from urllib.parse import parse_qs, urlsplit
    page = parse_qs(urlsplit(request_path).query).get("pageUrl", [""])[0]
    host = urlsplit(page).hostname or "?"
    host = host[4:] if host.startswith("www.") else host
    hue = sum(map(ord, host)) * 47 % 360
    letter = (host[:1] or "?").upper()
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">'
        f'<rect width="32" height="32" rx="7" fill="hsl({hue},58%,46%)"/>'
        '<text x="16" y="22" text-anchor="middle" font-family="system-ui,sans-serif" font-size="18" '
        f'font-weight="600" fill="#fff">{letter}</text></svg>'
    ).encode()


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=EXT, **kw)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def _send(self, body, ctype):
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = self.path.split("?")[0].split("#")[0]
        if path == "/":
            path = "/manager.html"
        # The dev routes (with --real: your actual bookmarks and history) are for this preview only.
        # Browsers mark requests from other websites as cross-site; refuse those, so a page you
        # happen to have open can't load the snapshot with a <script> tag.
        if path.startswith("/__dev/") and self.headers.get("Sec-Fetch-Site", "same-origin") not in ("same-origin", "none"):
            self.send_error(403, "dev routes are same-origin only")
            return
        if path == "/__dev/reset":
            if REAL_PROFILE:
                fixture_js(refresh=True)
            return self._send(RESET, "text/html; charset=utf-8")
        if path == "/__dev/fixture.js":
            if REAL_PROFILE:
                return self._send(fixture_js(), "text/javascript; charset=utf-8")
            with open(os.path.join(HERE, "demo-data.js"), "rb") as f:
                return self._send(f.read(), "text/javascript; charset=utf-8")
        if path == "/_favicon/":
            return self._send(letter_icon(self.path), "image/svg+xml")
        if path.startswith("/__dev/"):
            with open(os.path.join(HERE, os.path.basename(path)), "rb") as f:
                return self._send(f.read(), "text/javascript; charset=utf-8")
        if path.endswith(".html"):
            fp = os.path.join(EXT, path.lstrip("/"))
            if os.path.isfile(fp):
                with open(fp, "rb") as f:
                    html = f.read().replace(b"<head>", b"<head>" + INJECT, 1)
                return self._send(html, "text/html; charset=utf-8")
        return super().do_GET()


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=None)
    ap.add_argument("--real", nargs="?", const="~/.config/google-chrome/Default", default=None,
                    help="serve a read-only snapshot of this Chrome profile instead of the fixture")
    a = ap.parse_args()
    port = a.port or (8778 if a.real else 8765)
    if a.real:
        REAL_PROFILE = os.path.expanduser(a.real)
        fixture_js()  # fail fast if the profile can't be read
    print(f"http://localhost:{port}/manager.html" + (f"  (real profile: {REAL_PROFILE})" if REAL_PROFILE else ""))
    http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
