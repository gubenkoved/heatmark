// Extension-owned state in chrome.storage.local:
//   shelves         [{id, name, items: [bookmarkId]}]  — lists of pinned bookmarks, in display order
//   defaultShelf    shelf id that "pin" (P / Alt+P) targets
//   act             {normUrl: {u, d: {'YYYY-MM-DD': visits}, x?, last}}  — see activity.js
//   actSyncedAt     ms of the last full history sync
//   log:<t>:<rand>  one key per log entry (append-only)
//   trackingSince   ms when live tracking started
//   archiveFolderId id of the Archive folder
// Legacy (v0.1): pins [{id,t}] — migrated into a "Pinned" shelf on first read.
//
// Writes that could race (shelves, the visit record, restores, imports) run inside the
// background worker's queues; pages ask for them with callWorker().

import { pathOf } from './bm.js';

export const LOG_PREFIX = 'log:';
export const LOG_KINDS = ['created', 'removed', 'moved', 'archived', 'unarchived', 'changed', 'pinned', 'unpinned'];

export function logKey(t) {
  return `${LOG_PREFIX}${String(Math.round(t)).padStart(15, '0')}:${Math.random().toString(36).slice(2, 8)}`;
}

export function logEntries(entries) {
  const obj = {};
  for (const e of [].concat(entries)) obj[logKey(e.t)] = e;
  return obj;
}

export async function appendLog(entries) {
  await chrome.storage.local.set(logEntries(entries));
}

export function logFrom(all) {
  return Object.entries(all)
    .filter(([k]) => k.startsWith(LOG_PREFIX))
    .map(([key, e]) => ({ key, ...e }))
    .sort((a, b) => b.t - a.t || (a.key < b.key ? 1 : -1));
}

// ---------- worker calls ----------

// Ask the background worker to do something; rejects with the worker's error message.
export async function callWorker(type, payload = {}) {
  const r = await chrome.runtime.sendMessage({ type, ...payload });
  if (r?.error) throw new Error(r.error);
  return r?.value;
}

// ---------- shelves ----------

export function normalizeShelves(st) {
  if (Array.isArray(st.shelves)) return st.shelves;
  return [{ id: 'pinned', name: 'Pinned', items: (st.pins || []).map((p) => p.id) }];
}

const newShelfId = () => 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);

async function loadShelves() {
  const st = await chrome.storage.local.get(['shelves', 'pins', 'defaultShelf']);
  const shelves = normalizeShelves(st);
  const defaultShelf = shelves.some((s) => s.id === st.defaultShelf) ? st.defaultShelf : shelves[0]?.id;
  return { shelves, defaultShelf };
}

// The requested shelf, else the default one; a "Pinned" shelf is created only when none exist.
function shelfFor(state, shelfId) {
  const shelf = state.shelves.find((s) => s.id === shelfId) || state.shelves.find((s) => s.id === state.defaultShelf) || state.shelves[0];
  if (shelf) return shelf;
  const created = { id: newShelfId(), name: 'Pinned', items: [] };
  state.shelves.push(created);
  return created;
}

async function pinLogEntry(kind, id, shelf, t) {
  let node = null;
  try { [node] = await chrome.bookmarks.get(id); } catch { /* gone */ }
  return { t, kind, id, shelf: shelf.name, title: node?.title, url: node?.url, path: node ? await pathOf(node.parentId) : [] };
}

// Run by the worker (inside its shelf queue). Pages use the wrappers below.
export const shelfOps = {
  // Pin all ids if any is missing from the shelf, otherwise unpin all.
  // Returns { kind: 'pinned' | 'unpinned', changed: [ids actually changed] } so Undo can reverse exactly that.
  async togglePins(ids, shelfId) {
    const state = await loadShelves();
    const shelf = shelfFor(state, shelfId);
    const unpinAll = ids.every((id) => shelf.items.includes(id));
    const kind = unpinAll ? 'unpinned' : 'pinned';
    const changed = [];
    for (const id of ids) {
      if (unpinAll) {
        shelf.items = shelf.items.filter((x) => x !== id);
        changed.push(id);
      } else if (!shelf.items.includes(id)) {
        const [node] = await chrome.bookmarks.get(id).catch(() => []);
        if (!node?.url) continue; // only links are pinnable
        shelf.items.push(id);
        changed.push(id);
      }
    }
    if (changed.length) {
      const t = Date.now();
      const entries = await Promise.all(changed.map((id) => pinLogEntry(kind, id, shelf, t)));
      await chrome.storage.local.set({ shelves: state.shelves, ...logEntries(entries) });
    }
    return { kind, changed, shelf: shelf.name };
  },

  async pin(id, shelfId) {
    const state = await loadShelves();
    if (shelfFor(state, shelfId).items.includes(id)) return;
    await shelfOps.togglePins([id], shelfId);
  },

  async createShelf(name) {
    const state = await loadShelves();
    const id = newShelfId();
    state.shelves.push({ id, name: name || 'New shelf', items: [] });
    await chrome.storage.local.set({ shelves: state.shelves });
    return id;
  },

  async renameShelf(id, name) {
    const state = await loadShelves();
    const s = state.shelves.find((x) => x.id === id);
    if (s && name) { s.name = name; await chrome.storage.local.set({ shelves: state.shelves }); }
  },

  async deleteShelf(id) {
    const state = await loadShelves();
    await chrome.storage.local.set({ shelves: state.shelves.filter((s) => s.id !== id) });
  },

  async setShelfItems(id, items) {
    const state = await loadShelves();
    const s = state.shelves.find((x) => x.id === id);
    if (s) { s.items = items; await chrome.storage.local.set({ shelves: state.shelves }); }
  },

  async moveShelf(id, delta) {
    const state = await loadShelves();
    const i = state.shelves.findIndex((s) => s.id === id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= state.shelves.length) return;
    const [s] = state.shelves.splice(i, 1);
    state.shelves.splice(j, 0, s);
    await chrome.storage.local.set({ shelves: state.shelves });
  },

  async setDefaultShelf(id) {
    await chrome.storage.local.set({ defaultShelf: id });
  },

  // Drop deleted bookmark ids from every shelf; returns [{shelf, id}] so a restore can re-pin.
  async removeIds(ids) {
    const gone = new Set(ids);
    const state = await loadShelves();
    const removed = [];
    for (const s of state.shelves) {
      for (const x of s.items) if (gone.has(x)) removed.push({ shelf: s.id, id: x });
      s.items = s.items.filter((x) => !gone.has(x));
    }
    if (removed.length) await chrome.storage.local.set({ shelves: state.shelves });
    return removed;
  },
};

const shelfCall = (op, ...args) => callWorker('shelf', { op, args });

export const togglePins = (ids, shelfId) => shelfCall('togglePins', ids, shelfId);
export const pin = (id, shelfId) => shelfCall('pin', id, shelfId);
export const createShelf = (name) => shelfCall('createShelf', name);
export const renameShelf = (id, name) => shelfCall('renameShelf', id, name);
export const deleteShelf = (id) => shelfCall('deleteShelf', id);
export const setShelfItems = (id, items) => shelfCall('setShelfItems', id, items);
export const moveShelf = (id, delta) => shelfCall('moveShelf', id, delta);
export const setDefaultShelf = (id) => shelfCall('setDefaultShelf', id);

// ---------- other worker requests ----------

export const syncHistory = () => callWorker('sync');
// Mark log entries for deleted bookmarks as restored (old id → new id), after their removal is logged.
export const markRestored = (idMap) => callWorker('markRestored', { pairs: [...idMap] });
// Restore a deleted item from its log entry (key); returns { title, parentOk } or { already: true }.
export const restoreFromLogEntry = (key) => callWorker('restore', { key });
export const importExport = (data) => callWorker('import', { data });
// Erase everything stored in chrome.storage.local; the worker then rebuilds the log and visit counts.
export const resetAll = () => callWorker('reset');
