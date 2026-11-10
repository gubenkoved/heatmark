"""Build the Chrome Web Store upload: dist/heatmark-<version>.zip

    python3 dev/package.py

Validates the manifest, packs only the shipping files from extension/ (deterministic zip:
sorted entries, fixed timestamps) and fails on anything that must not ship: dev or hidden
files, personal paths or e-mail addresses, network or dynamic-code calls, external URLs
in markup.
"""
import hashlib
import json
import os
import re
import sys
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXT = os.path.join(ROOT, "extension")
DIST = os.path.join(ROOT, "dist")
SHIP = {".js", ".html", ".css", ".json", ".png"}
TEXT = {".js", ".html", ".css", ".json"}
FIXED_TIME = (2020, 1, 1, 0, 0, 0)

# (pattern, reason) — any hit in a shipping text file fails the build
FORBIDDEN = [
    (r"/home/|/Users/|[A-Za-z]:\\\\Users", "absolute local path"),
    (r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}", "e-mail address"),
    (r"\bfetch\s*\(|XMLHttpRequest|WebSocket|sendBeacon|EventSource", "network call"),
    (r"\beval\s*\(|new\s+Function\s*\(|setTimeout\s*\(\s*['\"`]", "dynamic code"),
    (r"<script[^>]+src=[\"']https?:|<link[^>]+href=[\"']https?:|@import\s+url\(\s*[\"']?https?:", "remote resource"),
    (r"localhost|127\.0\.0\.1|__dev|mock-chrome|__BK_FIXTURE", "dev-only reference"),
    (r"\bdebugger\b|console\.log\(", "debug leftover"),
]


def fail(msg):
    print(f"error: {msg}", file=sys.stderr)
    sys.exit(1)


def collect():
    files = []
    for dirpath, dirnames, filenames in os.walk(EXT):
        dirnames[:] = sorted(d for d in dirnames if not d.startswith("."))
        for name in sorted(filenames):
            rel = os.path.relpath(os.path.join(dirpath, name), EXT).replace(os.sep, "/")
            if name.startswith(".") or name.endswith("~"):
                fail(f"hidden or backup file in extension/: {rel}")
            if os.path.splitext(name)[1] not in SHIP:
                fail(f"unexpected file type in extension/: {rel}")
            files.append(rel)
    return files


def check_manifest(files):
    with open(os.path.join(EXT, "manifest.json"), encoding="utf-8") as f:
        m = json.load(f)
    if m.get("manifest_version") != 3:
        fail("manifest_version must be 3")
    for key in ("name", "version", "description", "icons"):
        if not m.get(key):
            fail(f"manifest is missing {key}")
    if len(m["description"]) > 132:
        fail(f"description is {len(m['description'])} chars; the store allows 132")
    if not re.fullmatch(r"\d+(\.\d+){0,3}", m["version"]):
        fail(f"invalid version {m['version']!r}")
    referenced = set(m["icons"].values()) | set(m.get("action", {}).get("default_icon", {}).values())
    referenced |= {m.get("action", {}).get("default_popup"), m.get("options_page"), m.get("background", {}).get("service_worker")}
    missing = sorted(r for r in referenced if r and r not in files)
    if missing:
        fail(f"manifest references missing files: {missing}")
    if "128" not in m["icons"]:
        fail("a 128px icon is required")
    return m


def check_imports(files):
    """Every relative import / script / stylesheet must resolve to a shipped file."""
    shipped = set(files)
    for rel in files:
        if os.path.splitext(rel)[1] not in (".js", ".html"):
            continue
        with open(os.path.join(EXT, rel), encoding="utf-8") as f:
            src = f.read()
        base = os.path.dirname(rel)
        for ref in re.findall(r"""(?:from\s+|import\s*\(\s*|src=|href=)["'](\.{0,2}/?[\w./-]+\.(?:js|css|png))["']""", src):
            target = os.path.normpath(os.path.join(base, ref)).replace(os.sep, "/")
            if target not in shipped:
                fail(f"{rel} references {ref}, which is not in the package")


def check_leaks(files):
    problems = []
    for rel in files:
        if os.path.splitext(rel)[1] not in TEXT:
            continue
        with open(os.path.join(EXT, rel), encoding="utf-8") as f:
            for n, line in enumerate(f, 1):
                for pat, why in FORBIDDEN:
                    if re.search(pat, line):
                        problems.append(f"{rel}:{n}: {why}: {line.strip()[:100]}")
    if problems:
        fail("found content that must not ship:\n  " + "\n  ".join(problems))


def build(files, version):
    os.makedirs(DIST, exist_ok=True)
    out = os.path.join(DIST, f"heatmark-{version}.zip")
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for rel in files:
            info = zipfile.ZipInfo(rel, FIXED_TIME)
            info.external_attr = 0o644 << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            with open(os.path.join(EXT, rel), "rb") as f:
                z.writestr(info, f.read())
    return out


def main():
    files = collect()
    m = check_manifest(files)
    check_imports(files)
    check_leaks(files)
    out = build(files, m["version"])
    with open(out, "rb") as f:
        digest = hashlib.sha256(f.read()).hexdigest()
    print(f"{m['name']} {m['version']}: {len(files)} files, {os.path.getsize(out) / 1024:.1f} KiB")
    print(f"  permissions: {', '.join(m.get('permissions', []))}")
    print(f"  {os.path.relpath(out, ROOT)}  sha256 {digest[:16]}…")
    for rel in files:
        print(f"    {rel}")


if __name__ == "__main__":
    main()
