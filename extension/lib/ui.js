const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

const PROPS = new Set(['checked', 'value', 'indeterminate', 'disabled', 'selected']);

export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (PROPS.has(k)) el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat(Infinity)) {
    if (k == null || k === false) continue;
    el.append(k instanceof Node ? k : String(k));
  }
  return el;
}

export function faviconSrc(url, size = 16) {
  try {
    const x = new URL(chrome.runtime.getURL('/_favicon/'));
    x.searchParams.set('pageUrl', url);
    x.searchParams.set('size', String(size * 2));
    return x.href;
  } catch {
    return '';
  }
}

export const favHTML = (url, size = 16) =>
  `<img class="fav" width="${size}" height="${size}" alt="" loading="lazy" src="${esc(faviconSrc(url, size))}">`;

// Extension CSP forbids inline onerror — hide broken favicons via one capturing listener.
export function installFaviconFallback(root = document) {
  root.addEventListener('error', (ev) => {
    if (ev.target?.classList?.contains('fav')) ev.target.classList.add('x');
  }, true);
}

// Compact relative time: now, 5h, 3d, 6w, 8mo, 4y.
export function ago(ms, now = Date.now()) {
  if (!ms) return '';
  const s = (now - ms) / 1000;
  if (s < 3600) return 'now';
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  const d = s / 86400;
  if (d < 14) return `${Math.floor(d)}d`;
  if (d < 70) return `${Math.floor(d / 7)}w`;
  if (d < 730) return `${Math.floor(d / 30.44)}mo`;
  return `${Math.floor(d / 365.25)}y`;
}

export const fullDate = (ms) =>
  ms ? new Date(ms).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
export const shortDate = (ms) =>
  ms ? new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—';
export const fmtTime = (ms) => new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
export const fmtDay = (ms) =>
  new Date(ms).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });

export function debounce(fn, ms) {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

// Sparkline: daily counts binned into bars. Shape is per-row; magnitude lives in the numbers.
export function sparkSVG(days, { w = 60, h = 14, bins = 30 } = {}) {
  const per = days.length / bins;
  const b = new Array(bins).fill(0);
  let max = 0;
  for (let i = 0; i < days.length; i++) {
    const j = Math.min(bins - 1, Math.floor(i / per));
    b[j] += days[i];
    if (b[j] > max) max = b[j];
  }
  const base = `<path class="sp-base" d="M0 ${h - 0.5}H${w}"/>`;
  if (!max) return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${base}</svg>`;
  const bw = w / bins;
  let d = '';
  for (let i = 0; i < bins; i++) {
    if (!b[i]) continue;
    const bh = Math.max(2, (Math.sqrt(b[i]) / Math.sqrt(max)) * h);
    d += `M${(i * bw).toFixed(1)} ${h}h${Math.max(1, bw - 0.8).toFixed(1)}v${(-bh).toFixed(1)}h${(-Math.max(1, bw - 0.8)).toFixed(1)}z`;
  }
  return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${base}<path class="sp-bar" d="${d}"/></svg>`;
}

// Larger daily bar chart for the detail pane, with a tick per month start.
export function barsSVG(days, keys, { w = 288, h = 48 } = {}) {
  const n = days.length;
  const max = Math.max(1, ...days);
  const bw = w / n;
  let d = '', ticks = '';
  for (let i = 0; i < n; i++) {
    if (keys[i].endsWith('-01')) ticks += `<path class="ch-tick" d="M${(i * bw).toFixed(1)} 0V${h}"/>`;
    if (!days[i]) continue;
    const bh = Math.max(2, (days[i] / max) * (h - 4));
    d += `M${(i * bw).toFixed(1)} ${h}h${Math.max(1, bw - 1).toFixed(1)}v${(-bh).toFixed(1)}h${(-Math.max(1, bw - 1)).toFixed(1)}z`;
  }
  return `<svg class="chart" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${ticks}<path class="ch-base" d="M0 ${h - 0.5}H${w}"/><path class="ch-bar" d="${d}"/></svg>`;
}

// Open a bookmark URL: how = 'tab' | 'background' | 'here' | 'window'. 'here' replaces the tab
// `hereTabId` (or the calling page's own tab). Bookmarklets can't run from an extension page.
export async function openLink(url, how = 'tab', hereTabId = null) {
  if (/^javascript:/i.test(url)) {
    toast('Bookmarklets can only run from the bookmarks bar or the address bar');
    return false;
  }
  try {
    if (how === 'window') await chrome.windows.create({ url });
    else if (how === 'here') await chrome.tabs.update(hereTabId ?? (await chrome.tabs.getCurrent()).id, { url });
    else await chrome.tabs.create({ url, active: how !== 'background' });
    return true;
  } catch (err) {
    toast(`Chrome can't open this URL: ${err.message || err}`);
    return false;
  }
}

let toastTimer;
export function toast(msg, { action, run, ms = 6000 } = {}) {
  let box = document.querySelector('.toast');
  if (!box) document.body.append((box = h('div', { class: 'toast', role: 'status' })));
  box.replaceChildren(h('span', {}, msg));
  if (action && run) {
    box.append(h('button', {
      type: 'button', class: 'toast-act',
      onclick: async () => { box.classList.remove('on'); await run(); },
    }, action));
  }
  box.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => box.classList.remove('on'), ms);
}

export function lsGet(key, fallback) {
  try {
    const v = localStorage.getItem('bk:' + key);
    return v == null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
}

export function lsSet(key, value) {
  try { localStorage.setItem('bk:' + key, JSON.stringify(value)); } catch { /* storage unavailable */ }
}

// Forget every view setting this extension saved (keys under 'bk:').
export function lsClear() {
  try {
    for (const k of Object.keys(localStorage)) if (k.startsWith('bk:')) localStorage.removeItem(k);
  } catch { /* storage unavailable */ }
}

export function plural(n, word, pluralWord = word + 's') {
  return `${n} ${n === 1 ? word : pluralWord}`;
}
