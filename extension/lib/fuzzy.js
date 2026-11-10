// Small fzf-style matcher: substring hits score highest, otherwise a tight subsequence
// with bonuses for consecutive characters and word starts. Returns {score, pos} or null.

import { esc } from './ui.js';

const BOUNDARY = /[\s/\-_.:?=&#(),|]/;
const isBoundary = (h, i) => i === 0 || BOUNDARY.test(h[i - 1]);

// `lower` may pass a precomputed hay.toLowerCase() (the model keeps lowercase copies).
export function fuzzy(needle, hay, lower = null) {
  if (!needle) return { score: 0, pos: [] };
  if (!hay) return null;
  const n = needle.toLowerCase();
  const h = lower ?? hay.toLowerCase();

  const idx = h.indexOf(n);
  if (idx >= 0) {
    // prefer an occurrence at a word boundary
    let at = idx;
    for (let i = idx; i >= 0 && i < h.length; i = h.indexOf(n, i + 1)) {
      if (isBoundary(h, i)) { at = i; break; }
    }
    const pos = Array.from({ length: n.length }, (_, k) => at + k);
    const score = 60 + n.length * 10 + (at === 0 ? 30 : isBoundary(h, at) ? 18 : 0) - Math.min(at, 40) * 0.3 - h.length * 0.02;
    return { score, pos };
  }

  // forward greedy pass establishes the end, backward pass tightens the window
  let j = 0, end = -1;
  for (let i = 0; i < h.length && j < n.length; i++) if (h[i] === n[j]) { j++; end = i; }
  if (j < n.length) return null;
  const pos = [];
  j = n.length - 1;
  for (let i = end; i >= 0 && j >= 0; i--) if (h[i] === n[j]) { pos.unshift(i); j--; }

  const span = pos[pos.length - 1] - pos[0] + 1;
  if (span > n.length * 4 + 6) return null; // too scattered to be meaningful

  let score = 0, prev = -2;
  for (const p of pos) {
    score += 4;
    if (p === prev + 1) score += 7;
    if (isBoundary(h, p)) score += 9;
    if (prev >= 0 && p > prev + 1) score -= Math.min(p - prev - 1, 5);
    prev = p;
  }
  score -= (span - n.length) * 0.5 + h.length * 0.02;
  return { score, pos };
}

// HTML with matched characters wrapped in <mark>.
export function highlight(text, pos) {
  text = String(text ?? '');
  if (!pos || !pos.size && !pos.length) return esc(text);
  const set = pos instanceof Set ? pos : new Set(pos);
  let out = '', open = false;
  for (let i = 0; i < text.length; i++) {
    const m = set.has(i);
    if (m && !open) { out += '<mark>'; open = true; }
    if (!m && open) { out += '</mark>'; open = false; }
    out += esc(text[i]);
  }
  return open ? out + '</mark>' : out;
}
