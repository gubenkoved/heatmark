"""Render the extension icons: a bookmark ribbon made of heatmap cells on a dark rounded square.

    python3 dev/make_icons.py        → extension/icons/{16,32,48,128}.png, store/icon-128.png

No dependencies: a small supersampled rasterizer writes the PNGs directly. At 16 px the cells
would turn to mush, so the ribbon becomes a simple two-step ramp there.
"""
import os
import struct
import zlib

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
OUT = os.path.join(ROOT, "extension", "icons")
STORE = os.path.join(ROOT, "store")
SS = 6  # supersamples per axis

BG = (18, 21, 28)
RAMP = [(56, 96, 178), (70, 122, 228), (104, 154, 250), (182, 210, 255)]  # cool → hot
# heat level per cell, rows top → bottom, two columns; hottest at the ribbon's tip
CELLS = [[0, 1], [1, 0], [2, 1], [3, 2]]

RIB_X0, RIB_X1, RIB_Y0, RIB_Y1 = 0.3, 0.7, 0.14, 0.87
NOTCH = 0.17  # depth of the V cut at the bottom


def in_rounded(x, y, x0, y0, x1, y1, r):
    if not (x0 <= x <= x1 and y0 <= y <= y1):
        return False
    cx = min(max(x, x0 + r), x1 - r)
    cy = min(max(y, y0 + r), y1 - r)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r


def in_ribbon(x, y):
    if not (RIB_X0 <= x <= RIB_X1 and RIB_Y0 <= y <= RIB_Y1):
        return False
    half = (RIB_X1 - RIB_X0) / 2
    mid = RIB_X0 + half
    return y <= RIB_Y1 - NOTCH * (1 - abs(x - mid) / half)


def color_at(x, y, size):
    if not in_rounded(x, y, 0, 0, 1, 1, 0.23):
        return None
    if not in_ribbon(x, y):
        return BG
    if size <= 16:  # two-step ramp
        return RAMP[2] if y < (RIB_Y0 + RIB_Y1) / 2 else RAMP[3]
    gap = 0.03
    cols, rows = 2, len(CELLS)
    cw = (RIB_X1 - RIB_X0 - gap * (cols - 1)) / cols
    ch = (RIB_Y1 - RIB_Y0 - gap * (rows - 1)) / rows
    c = int((x - RIB_X0) // (cw + gap))
    r = int((y - RIB_Y0) // (ch + gap))
    if c >= cols or r >= rows:
        return BG
    cx0 = RIB_X0 + c * (cw + gap)
    cy0 = RIB_Y0 + r * (ch + gap)
    if not in_rounded(x, y, cx0, cy0, cx0 + cw, cy0 + ch, 0.025):
        return BG
    return RAMP[CELLS[r][c]]


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
                    col = color_at(u, v, art) if 0 <= u < 1 and 0 <= v < 1 else None
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
    for s in (16, 32, 48, 128):
        with open(os.path.join(OUT, f"{s}.png"), "wb") as f:
            f.write(render(s))
    with open(os.path.join(STORE, "icon-128.png"), "wb") as f:
        f.write(render(128, pad=16))  # Web Store: 96×96 artwork centred in 128×128
    print("icons written to", os.path.abspath(OUT), "and", os.path.abspath(STORE))
