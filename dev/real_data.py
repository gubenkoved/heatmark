"""Read-only snapshot of a real Chrome profile for the dev preview.

Reads the profile's bookmarks JSON (AccountBookmarks and/or Bookmarks) and a *copy* of its
History SQLite DB, and returns the mock's fixture shape:

    {"tree": <root node like chrome.bookmarks.getTree()[0]>,
     "visits": {url: [{"visitTime": ms, "transition": str}, ...]}}   # bookmarked URLs only

Nothing is written anywhere except a temporary copy of History, deleted right away.
"""
import json
import os
import shutil
import sqlite3
import tempfile
from urllib.parse import urlsplit

WEBKIT_EPOCH_MS = 11644473600000
TRANSITIONS = ["link", "typed", "auto_bookmark", "auto_subframe", "manual_subframe", "generated",
               "auto_toplevel", "form_submit", "reload", "keyword", "keyword_generated"]
ROOTS = [("bookmark_bar", "bookmarks-bar"), ("other", "other"), ("synced", "mobile")]


def webkit_ms(v):
    v = int(v or 0)
    return round(v / 1000 - WEBKIT_EPOCH_MS) if v else None


def norm_url(u):
    """Mirror of normUrl() in extension/lib/bm.js."""
    try:
        x = urlsplit(u)
    except ValueError:
        return u
    if x.scheme not in ("http", "https"):
        return u
    host = x.netloc.split("@")[-1].lower()
    if host.startswith("www."):
        host = host[4:]
    out = host + x.path.rstrip("/")
    if x.query:
        out += "?" + x.query
    if x.fragment:
        out += "#" + x.fragment
    return out


def convert(node, parent_id, index, syncing):
    out = {"id": str(node["id"]), "parentId": parent_id, "index": index, "title": node.get("name", "")}
    added = webkit_ms(node.get("date_added"))
    if added:
        out["dateAdded"] = added
    if node.get("type") == "url":
        out["url"] = node["url"]
        used = webkit_ms(node.get("date_last_used"))
        if used:
            out["dateLastUsed"] = used
    else:
        out["children"] = [convert(c, out["id"], i, syncing) for i, c in enumerate(node.get("children", []))]
    return out


def load_tree(profile):
    root = {"id": "0", "title": "", "children": []}
    for fname, syncing in (("AccountBookmarks", True), ("Bookmarks", False)):
        path = os.path.join(profile, fname)
        if not os.path.isfile(path):
            continue
        with open(path, encoding="utf-8") as f:
            data = json.load(f)["roots"]
        for key, folder_type in ROOTS:
            if key not in data:
                continue
            node = convert(data[key], "0", len(root["children"]), syncing)
            node["folderType"] = folder_type
            node["syncing"] = syncing
            root["children"].append(node)
    return root


def bookmarked_norms(tree):
    norms = set()
    stack = [tree]
    while stack:
        n = stack.pop()
        if "url" in n:
            norms.add(norm_url(n["url"]))
        stack.extend(n.get("children", []))
    return norms


def load_visits(profile, norms):
    src = os.path.join(profile, "History")
    if not os.path.isfile(src):
        return {}
    tmp = tempfile.mkdtemp(prefix="bk-history-")
    try:
        dst = os.path.join(tmp, "History")
        shutil.copyfile(src, dst)
        con = sqlite3.connect(f"file:{dst}?mode=ro", uri=True)
        visits = {}
        for url, vt, tr in con.execute(
            "SELECT u.url, v.visit_time, v.transition FROM visits v JOIN urls u ON u.id = v.url ORDER BY v.visit_time"
        ):
            if norm_url(url) not in norms:
                continue
            core = tr & 0xFF
            visits.setdefault(url, []).append({
                "visitTime": webkit_ms(vt),
                "transition": TRANSITIONS[core] if core < len(TRANSITIONS) else "link",
            })
        con.close()
        return visits
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def snapshot(profile):
    tree = load_tree(profile)
    return {"tree": tree, "visits": load_visits(profile, bookmarked_norms(tree))}


if __name__ == "__main__":
    import sys
    snap = snapshot(os.path.expanduser(sys.argv[1] if len(sys.argv) > 1 else "~/.config/google-chrome/Default"))
    urls = sum(1 for _ in json.dumps(snap["tree"]).split('"url"')) - 1
    print(f"roots: {[c['title'] for c in snap['tree']['children']]}, urls: {urls}, "
          f"visited bookmarked urls: {len(snap['visits'])}, visits: {sum(len(v) for v in snap['visits'].values())}")
