"""Render the extension icons: a blue bookmark with heatmap cells on transparency.

    python3 dev/make_icons.py        → extension/icons/{16,32,48,128}.png, store/icon-128.png

No dependencies: a small supersampled rasterizer writes the PNGs directly.
"""
import os
import struct
import zlib

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
OUT = os.path.join(ROOT, "extension", "icons")
STORE = os.path.join(ROOT, "store")
SS = 6  # supersamples per axis

TOP, BOTTOM = (61, 121, 231), (35, 87, 194)
CELLS = [[(116, 170, 255), (161, 203, 255)], [(150, 193, 255), (217, 236, 255)]]
RIB_X0, RIB_X1 = 0.14, 0.86
NOTCH = 0.24


def in_rounded(x, y, x0, y0, x1, y1, r):
    if not (x0 <= x <= x1 and y0 <= y <= y1):
        return False
    cx = min(max(x, x0 + r), x1 - r)
    cy = min(max(y, y0 + r), y1 - r)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r


def color_at(x, y):
    if not in_rounded(x, y, RIB_X0, 0, RIB_X1, 1, 0.105):
        return None
    half = (RIB_X1 - RIB_X0) / 2
    if y > 1 - NOTCH * (1 - abs(x - 0.5) / half):
        return None

    cell, gap = 0.19, 0.065
    first_x = 0.5 - cell - gap / 2
    for r, row in enumerate(CELLS):
        y0 = 0.135 + r * (cell + gap)
        for c, color in enumerate(row):
            x0 = first_x + c * (cell + gap)
            if in_rounded(x, y, x0, y0, x0 + cell, y0 + cell, 0.035):
                return color
    return tuple(round(top + (bottom - top) * y) for top, bottom in zip(TOP, BOTTOM))


def render(size, pad=0):
    """PNG of the icon at size×size; pad leaves a transparent margin (the store icon wants 16px)."""
    art = size - 2 * pad
    rows = []
    for py in range(size):
        row = bytearray([0])
        for px in range(size):
            acc = [0, 0, 0]
            hits = 0
            for sy in range(SS):
                for sx in range(SS):
                    u = (px - pad + (sx + 0.5) / SS) / art
                    v = (py - pad + (sy + 0.5) / SS) / art
                    col = color_at(u, v)
                    if col:
                        hits += 1
                        for i in range(3):
                            acc[i] += col[i]
            if hits:
                row += bytes([acc[0] // hits, acc[1] // hits, acc[2] // hits, 255 * hits // (SS * SS)])
            else:
                row += bytes(4)
        rows.append(bytes(row))

    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(b"".join(rows), 9)) + chunk(b"IEND", b"")


if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    for size in (16, 32, 48):
        with open(os.path.join(OUT, f"{size}.png"), "wb") as f:
            f.write(render(size, pad=size // 16))
    # Chrome uses the packaged 128px PNG as the Web Store icon.
    large = render(128, pad=16)
    for path in (os.path.join(OUT, "128.png"), os.path.join(STORE, "icon-128.png")):
        with open(path, "wb") as f:
            f.write(large)
    print("icons written to", os.path.abspath(OUT), "and", os.path.abspath(STORE))
