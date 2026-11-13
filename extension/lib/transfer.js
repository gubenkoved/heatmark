// Export and import of everything Heatmark keeps.
//
// Import merges an "Export JSON" file (from this or another install) and is run by the worker.
// Nothing is replaced:
//   - log entries already present are skipped;
//   - visit days from the file are kept beside this profile's history (`x` in the visit record)
//     and the larger count wins per day;
//   - local shelves with the same name gain the missing bookmarks.
// Bookmark ids differ between profiles, so ids are kept only when they still point at the same
// URL here, and otherwise remapped by URL (or dropped). Every field is validated, so a malformed
// or hostile file can't break the pages that render it.

import { getRoot, normUrl } from './bm.js';
import { LOG_KINDS, logEntries, logFrom, shelfOps } from './store.js';

export const EXPORT_FORMAT = 'heatmark-export';

// Everything worth keeping, as a plain object (the manager saves it as a file).
export async function buildExport(m) {
  return {
    format: EXPORT_FORMAT,
    version: 1,
    exportedAt: new Date().toISOString(),
    trackingSince: m.meta.trackingSince ? new Date(m.meta.trackingSince).toISOString() : null,
    shelves: m.shelves.map(({ id, name, items, scope }) => ({ id, name, items, scope })),
    defaultShelf: m.defaultShelf,
    activity: m.act,
    log: m.log.map(({ key, norm, ...e }) => e),
    bookmarks: await getRoot(),
  };
}

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;
const KINDS = new Set(LOG_KINDS);
const str = (v, max = 4096) => (typeof v === 'string' ? v.slice(0, max) : undefined);
const strList = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string').map((x) => x.slice(0, 1024)) : undefined);

function cleanNode(n, depth = 0) {
  if (!n || typeof n !== 'object' || depth > 64) return null;
  const out = { id: str(n.id, 64) ?? '', title: str(n.title) ?? '' };
  if (typeof n.dateAdded === 'number') out.dateAdded = n.dateAdded;
  if (str(n.url)) out.url = str(n.url);
  if (Array.isArray(n.children)) out.children = n.children.map((c) => cleanNode(c, depth + 1)).filter(Boolean);
  return out;
}

// A validated copy of a log entry, with its bookmark id translated into this profile (`resolve`).
// Folder ids and positions can't be translated, so they are dropped; a later restore of an
// imported removal then lands in Other bookmarks.
function cleanEntry(e, resolve) {
  if (!e || typeof e !== 'object' || !Number.isFinite(e.t) || !KINDS.has(e.kind)) return null;
  const out = { t: e.t, kind: e.kind, imported: true };
  for (const k of ['title', 'url', 'shelf']) if (str(e[k])) out[k] = str(e[k]);
  for (const k of ['path', 'from']) if (strList(e[k])) out[k] = strList(e[k]);
  if (Number.isFinite(e.count)) out.count = e.count;
  if (Number.isFinite(e.restoredAt)) out.restoredAt = e.restoredAt;
  for (const k of ['folder', 'seeded']) if (typeof e[k] === 'boolean') out[k] = e[k];
  const id = str(e.id, 64) && resolve(e.id, out.url);
  if (id) out.id = id;
  if (e.node) out.node = cleanNode(e.node);
  return out;
}

const signature = (e) => `${e.t}|${e.kind}|${e.title ?? ''}|${e.url ?? ''}`;

export function summarize(data) {
  return {
    log: Array.isArray(data?.log) ? data.log.length : 0,
    shelves: Array.isArray(data?.shelves) ? data.shelves.length : 0,
    pages: data?.activity && typeof data.activity === 'object' ? Object.keys(data.activity).length : 0,
  };
}

export function looksLikeExport(data) {
  const s = summarize(data);
  return !!data && typeof data === 'object' && !!(s.log || s.shelves || s.pages);
}

// `shelfWork` runs a function inside the worker's shelf queue.
export async function importData(data, shelfWork) {
  if (!looksLikeExport(data)) throw new Error('This file is not a Heatmark export');
  const result = { log: 0, pages: 0, shelves: 0, pins: 0, unmatched: 0 };

  // Translate the file's bookmark ids into this profile's.
  const urlInFile = new Map(); // file id → url
  (function walk(n, depth = 0) {
    if (!n || typeof n !== 'object' || depth > 64) return;
    if (str(n.url) && str(n.id, 64)) urlInFile.set(n.id, n.url);
    for (const c of Array.isArray(n.children) ? n.children : []) walk(c, depth + 1);
  })(data.bookmarks);
  const urlHere = new Map(); // id → url
  const idByNorm = new Map(); // normUrl → id
  (function walk(n) {
    if (n.url) {
      urlHere.set(n.id, n.url);
      if (!idByNorm.has(normUrl(n.url))) idByNorm.set(normUrl(n.url), n.id);
    }
    for (const c of n.children || []) walk(c);
  })(await getRoot());
  const resolve = (fileId, knownUrl) => {
    const url = urlInFile.get(fileId) || knownUrl;
    if (!url) return undefined;
    if (urlHere.has(fileId) && normUrl(urlHere.get(fileId)) === normUrl(url)) return fileId;
    return idByNorm.get(normUrl(url));
  };

  const all = await chrome.storage.local.get(null);

  // change log
  const seen = new Set(logFrom(all).map(signature));
  const fresh = [];
  for (const raw of Array.isArray(data.log) ? data.log : []) {
    const e = cleanEntry(raw, resolve);
    if (e && !seen.has(signature(e))) { seen.add(signature(e)); fresh.push(e); }
  }
  result.log = fresh.length;

  // visit record: imported days go to `x`, which history syncs keep; only bookmarked pages count
  const act = all.act || {};
  for (const [k, a] of Object.entries(data.activity && typeof data.activity === 'object' ? data.activity : {})) {
    if (!a || typeof a !== 'object' || typeof k !== 'string' || !idByNorm.has(k)) continue;
    const days = { ...(a.d && typeof a.d === 'object' ? a.d : {}), ...(a.x && typeof a.x === 'object' ? a.x : {}) };
    const cur = act[k] || { u: urlHere.get(idByNorm.get(k)), d: {}, last: 0 };
    const x = { ...(cur.x || {}) };
    let touched = false;
    for (const [dk, n] of Object.entries(days)) {
      if (!DAY_KEY.test(dk) || !Number.isFinite(n) || n <= 0) continue;
      if (n > (x[dk] || 0)) { x[dk] = Math.round(n); touched = true; }
    }
    if (!touched) continue;
    const lastIn = Math.max(Number.isFinite(a.last) ? a.last : 0, Number.isFinite(a.xl) ? a.xl : 0);
    act[k] = { ...cur, x, xl: Math.max(cur.xl || 0, lastIn), last: Math.max(cur.last || 0, lastIn) };
    result.pages++;
  }

  const imported = Date.parse(data.trackingSince);
  const trackingSince = Math.min(all.trackingSince || Date.now(), Number.isFinite(imported) ? imported : Infinity);
  await chrome.storage.local.set({ ...logEntries(fresh), act, trackingSince });

  const shelves = [];
  for (const s of Array.isArray(data.shelves) ? data.shelves : []) {
    const name = str(s?.name, 200);
    if (!name || !Array.isArray(s.items)) continue;
    const items = [];
    for (const fileId of s.items) {
      const id = typeof fileId === 'string' ? resolve(fileId) : undefined;
      if (id) items.push(id);
      else result.unmatched++;
    }
    shelves.push({ name, items });
  }
  Object.assign(result, await shelfWork(() => shelfOps.mergeShelves(shelves)));
  return result;
}
