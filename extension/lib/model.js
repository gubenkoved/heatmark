// Loads bookmarks + activity + shelves into one derived model shared by popup and manager.

import { getRoot, indexTree, normUrl, host, displayUrl } from './bm.js';
import { normalizeShelves, logFrom } from './store.js';
import { lastDays, visitDays, DAY } from './activity.js';

export const SPAN = 90; // days of per-day activity kept on each entry

export async function loadModel({ withLog = false } = {}) {
  const st = withLog
    ? await chrome.storage.local.get(null)
    : await chrome.storage.local.get(['act', 'shelves', 'pins', 'defaultShelf', 'trackingSince', 'archiveFolderId', 'actSyncedAt']);
  const idx = indexTree(await getRoot(), st.archiveFolderId);
  const act = st.act || {};
  const now = Date.now();
  const keys = lastDays(SPAN, now);

  for (const e of idx.urls) {
    const n = e.node;
    e.norm = normUrl(n.url);
    e.host = host(n.url);
    e.durl = displayUrl(n.url);
    e.lt = (n.title || e.durl).toLowerCase(); // lowercase copies for sorting and search
    e.ldurl = e.durl.toLowerCase();
    e.lpath = e.pathStr.toLowerCase();
    e.added = n.dateAdded || 0;
    const a = act[e.norm];
    e.last = Math.max(n.dateLastUsed || 0, a?.last || 0);
    e.days = new Array(SPAN).fill(0);
    e.v30 = e.v90 = e.total = 0;
    if (a) {
      const days = visitDays(a);
      for (const c of Object.values(days)) e.total += c;
      keys.forEach((k, i) => {
        const c = days[k] || 0;
        e.days[i] = c;
        e.v90 += c;
        if (i >= SPAN - 30) e.v30 += c;
      });
    }
  }

  // folder aggregates
  for (const f of idx.folders) {
    f.agg = { count: 0, v30: 0, v90: 0, total: 0, last: 0, days: new Array(SPAN).fill(0) };
  }
  for (const e of idx.urls) {
    for (const fid of e.ancestors) {
      const a = idx.folderById.get(fid)?.agg;
      if (!a) continue;
      a.count++;
      a.v30 += e.v30;
      a.v90 += e.v90;
      a.total += e.total;
      a.last = Math.max(a.last, e.last);
      if (e.v90) for (let i = 0; i < SPAN; i++) a.days[i] += e.days[i];
    }
  }

  // duplicates
  const groups = new Map();
  for (const e of idx.urls) {
    if (!groups.has(e.norm)) groups.set(e.norm, []);
    groups.get(e.norm).push(e);
  }
  const dupKey = new Map();
  for (const [k, arr] of groups) if (arr.length > 1) for (const e of arr) dupKey.set(e.node.id, k);

  // shelves (drop ids whose bookmark no longer exists, for display)
  const shelves = normalizeShelves(st).map((s) => ({ ...s, items: s.items.filter((id) => idx.entryById.has(id)) }));
  const defaultShelf = shelves.some((s) => s.id === st.defaultShelf) ? st.defaultShelf : shelves[0]?.id;
  const pinnedIn = new Map();
  for (const s of shelves) for (const id of s.items) {
    if (!pinnedIn.has(id)) pinnedIn.set(id, []);
    pinnedIn.get(id).push(s);
  }

  const firstUse = idx.urls.reduce((m, e) => (e.node.dateLastUsed ? Math.min(m, e.node.dateLastUsed) : m), Infinity);
  const firstVisitDay = Object.values(act).reduce((m, a) => {
    for (const k of Object.keys(visitDays(a))) if (k < m) m = k;
    return m;
  }, '9999');

  return {
    now, keys, idx, act, dupKey, shelves, defaultShelf, pinnedIn,
    defaultShelfName: shelves.find((s) => s.id === defaultShelf)?.name || 'Pinned',
    meta: {
      trackingSince: st.trackingSince, archiveFolderId: st.archiveFolderId, actSyncedAt: st.actSyncedAt,
      firstUse: Number.isFinite(firstUse) ? firstUse : null,
      firstVisitDay: firstVisitDay === '9999' ? null : firstVisitDay,
    },
    log: withLog ? logFrom(st) : null,
    isPinned: (id) => pinnedIn.has(id),
    isPinnedOnDefault: (id) => !!pinnedIn.get(id)?.some((s) => s.id === defaultShelf),
    isDup: (id) => dupKey.has(id),
  };
}

// Ranking boost from usage: frequent, recent, pinned up; archived down.
export function usageBoost(e, m) {
  let b = 9 * Math.log2(1 + e.v30) + 3 * Math.log2(1 + e.total);
  if (e.last) b += 14 * Math.exp(-(m.now - e.last) / (14 * DAY));
  if (m.pinnedIn.has(e.node.id)) b += 10;
  if (e.inArchive) b -= 25;
  return b;
}
