// Visit activity for bookmarked URLs.
//
// Source of truth is Chrome history (≈90 days retained). The background worker copies
// per-day visit counts for bookmarked URLs into storage (`act`) so the record keeps
// growing beyond Chrome's retention window:
//   act = { [normUrl]: { u: url, d: { 'YYYY-MM-DD': visits }, x?: { day: visits }, xl?: ms, last: ms } }
// `d` mirrors this profile's history; `x`/`xl` hold days and the last visit imported from another
// install, which history syncs leave alone. visitDays() combines the two.
// Syncing is idempotent: days inside Chrome's retention window are recomputed from history,
// so re-running never double counts and deletions made in Chrome are honored.

import { getRoot, normUrl } from './bm.js';

export const DAY = 864e5;

export function dayKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function dayStart(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d).getTime();
}

// Day keys for the last n days, oldest first (noon offsets avoid DST edge cases).
export function lastDays(n, now = Date.now()) {
  const t = new Date(now);
  t.setHours(12, 0, 0, 0);
  const out = [];
  for (let i = n - 1; i >= 0; i--) out.push(dayKey(t.getTime() - i * DAY));
  return out;
}

const SKIP = /reload|subframe/;

export async function bookmarkedNorms() {
  const root = await getRoot();
  const norms = new Map();
  (function walk(n) {
    if (n.url) norms.set(normUrl(n.url), n.url);
    for (const c of n.children || []) walk(c);
  })(root);
  return norms;
}

// Chrome keeps about 90 days of history. Inside that window history is the source of truth,
// so visits deleted in Chrome disappear here too; older days are kept from storage, which is
// what lets the record outlive Chrome's retention. Only currently bookmarked URLs are kept.
const WINDOW_DAYS = 89;

async function countVisits(urls) {
  const days = {};
  let last = 0;
  for (const u of urls) {
    for (const v of await chrome.history.getVisits({ url: u })) {
      if (SKIP.test(v.transition)) continue;
      const dk = dayKey(v.visitTime);
      days[dk] = (days[dk] || 0) + 1;
      last = Math.max(last, v.visitTime);
    }
  }
  return { days, last };
}

// Visits per day for one record: this profile's days, topped up with imported ones.
export function visitDays(a) {
  if (!a?.x) return a?.d || {};
  const out = { ...a.d };
  for (const [k, n] of Object.entries(a.x)) if (n > (out[k] || 0)) out[k] = n;
  return out;
}

// Rebuild the entries for `keys` (normUrl → [history URLs]) from history + stored old days.
async function merge(stored, keys, norms) {
  const now = Date.now();
  const cutoff = dayKey(now - WINDOW_DAYS * DAY);
  const cutoffMs = dayStart(cutoff);
  const out = {};
  const jobs = [...keys];
  for (let i = 0; i < jobs.length; i += 16) {
    await Promise.all(jobs.slice(i, i + 16).map(async ([k, urls]) => {
      const fresh = urls.length ? await countVisits(urls) : { days: {}, last: 0 };
      const old = stored[k];
      const d = {};
      if (old) for (const [dk, n] of Object.entries(old.d)) if (dk < cutoff) d[dk] = n;
      Object.assign(d, fresh.days);
      const imported = old?.x && Object.keys(old.x).length ? { x: old.x, xl: old.xl || 0 } : null;
      const dayList = Object.keys(d).sort();
      if (!dayList.length && !imported) return;
      // last visit: from history if any; else the stored one if it predates the window; else the newest kept day
      const ownLast = fresh.last
        || (old?.last && old.last < cutoffMs ? old.last : 0)
        || (dayList.length ? dayStart(dayList[dayList.length - 1]) + DAY / 2 : 0);
      out[k] = { u: norms.get(k) || old?.u, d, ...imported, last: Math.max(ownLast, imported?.xl || 0) };
    }));
  }
  return out;
}

// Full sync: every bookmarked URL. `eraseAll` drops stored and imported days too (all history was cleared).
export async function syncFromHistory({ eraseAll = false } = {}) {
  const norms = await bookmarkedNorms();
  const items = await chrome.history.search({ text: '', startTime: 0, maxResults: 1000000 });
  const keys = new Map([...norms.keys()].map((k) => [k, []]));
  for (const it of items) {
    const k = normUrl(it.url);
    if (keys.has(k)) keys.get(k).push(it.url);
  }
  const stored = eraseAll ? {} : (await chrome.storage.local.get('act')).act || {};
  const act = await merge(stored, keys, norms);
  await chrome.storage.local.set({ act, actSyncedAt: Date.now() });
  return { matched: [...keys.values()].filter((u) => u.length).length, bookmarked: norms.size };
}

// Partial sync for a few URLs (new bookmarks, an edited URL). Pass `norms` to reuse a cached set.
export async function syncUrls(urls, norms = null) {
  norms ??= await bookmarkedNorms();
  const keys = new Map();
  for (const url of urls) {
    const k = normUrl(url);
    if (!norms.has(k) || keys.has(k)) continue;
    let host = '';
    try { host = new URL(url).hostname; } catch { /* not a URL */ }
    const found = host ? await chrome.history.search({ text: host, startTime: 0, maxResults: 10000 }) : [];
    keys.set(k, [...new Set([url, ...found.map((it) => it.url).filter((u) => normUrl(u) === k)])]);
  }
  if (!keys.size) return;
  const { act = {} } = await chrome.storage.local.get('act');
  const fresh = await merge(act, keys, norms);
  for (const k of keys.keys()) {
    if (fresh[k]) act[k] = fresh[k];
    else delete act[k];
  }
  await chrome.storage.local.set({ act });
}

// Live visits (from history.onVisited): recount the visited bookmarked URLs from history rather
// than incrementing, so a visit can never be counted twice, whatever order syncs run in.
export async function recordVisits(items, norms) {
  const urls = [...new Set(items.map((it) => it.url).filter((u) => norms.has(normUrl(u))))];
  if (urls.length) await syncUrls(urls, norms);
}
