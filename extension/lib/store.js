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

import { getRoot, indexTree, pathOf } from './bm.js';
import { readSharedShelves, sharedChanges } from './shared-shelves.js';

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

const newShelfId = () => crypto.randomUUID();
export const SHELF_KEYS = ['shelves', 'pins', 'defaultShelf', 'shelfMode', 'sharedPending', 'sharedError'];

export async function shelfState(st, nodes) {
  const mode = st.shelfMode === 'shared' ? 'shared' : 'local';
  const state = mode === 'shared'
    ? await readSharedShelves(nodes, st.sharedPending)
    : { shelves: normalizeShelves(st), defaultShelf: st.defaultShelf };
  if (!state.shelves.some((s) => s.id === state.defaultShelf)) state.defaultShelf = state.shelves[0]?.id;
  return { ...state, mode };
}

async function loadShelves(extraNodes = []) {
  const st = await chrome.storage.local.get(SHELF_KEYS);
  const nodes = st.shelfMode === 'shared' ? [...indexTree(await getRoot()).byId.values(), ...extraNodes] : [];
  return shelfState(st, nodes);
}

export async function flushSharedShelves() {
  const { shelfMode, sharedPending, sharedError } = await chrome.storage.local.get(['shelfMode', 'sharedPending', 'sharedError']);
  if (shelfMode !== 'shared' || !Object.keys(sharedPending || {}).length) return;
  const deletes = [], writes = {};
  for (const [key, value] of Object.entries(sharedPending)) {
    if (value === null) deletes.push(key);
    else writes[key] = value;
  }
  try {
    if (deletes.length) {
      await chrome.storage.sync.remove(deletes);
      // If the write hits quota, retry only the writes that still need to be sent.
      if (Object.keys(writes).length) await chrome.storage.local.set({ sharedPending: writes });
    }
    if (Object.keys(writes).length) await chrome.storage.sync.set(writes);
  } catch (err) {
    const message = /quota/i.test(err.message) ? 'Chrome Sync storage or write limit reached.' : 'Chrome Sync could not save your changes.';
    if (message !== sharedError) await chrome.storage.local.set({ sharedError: message });
    return;
  }
  await chrome.storage.local.remove(['sharedPending', 'sharedError']);
}

// The shelf queue owns the local edit and its handoff to Chrome Sync.
async function editShelves(edit, extraNodes) {
  const state = await loadShelves(extraNodes);
  const before = { shelves: structuredClone(state.shelves), defaultShelf: state.defaultShelf };
  const patch = {};
  const result = await edit(state, patch);
  const shelvesChanged = JSON.stringify(before.shelves) !== JSON.stringify(state.shelves);
  const defaultChanged = before.defaultShelf !== state.defaultShelf;
  if (state.mode === 'shared' && (shelvesChanged || defaultChanged)) {
    const changes = await sharedChanges(before, state);
    if (Object.keys(changes).length) {
      const { sharedPending } = await chrome.storage.local.get('sharedPending');
      patch.sharedPending = { ...sharedPending, ...changes };
    }
  } else if (state.mode === 'local') {
    if (shelvesChanged) patch.shelves = state.shelves;
    if (defaultChanged) patch.defaultShelf = state.defaultShelf;
  }
  if (Object.keys(patch).length) await chrome.storage.local.set(patch);
  if (state.mode === 'shared') await flushSharedShelves();
  return result;
}

async function mergeShelves(source, sourceDefault, copy = false) {
  return editShelves((state) => {
    if (copy && state.mode !== 'shared') throw new Error('Select Shared before copying local shelves.');
    const result = { shelves: 0, pins: 0 };
    const freshShared = copy && !state.shared.shelves.size;
    const copied = new Set();
    for (const s of source) {
      let target = state.shelves.find((x) => x.name === s.name);
      if (!target) {
        target = { id: newShelfId(), name: s.name, items: [] };
        state.shelves.push(target);
        result.shelves++;
      }
      for (const id of s.items) {
        if (target.items.includes(id) || (copy && !state.shared.nodes.get(id)?.url)) continue;
        target.items.push(id);
        result.pins++;
      }
      if (freshShared && s.id === sourceDefault) state.defaultShelf = target.id;
      copied.add(target);
    }
    if (freshShared && copied.size) state.shelves = [...copied];
    return result;
  });
}

export async function setShelfMode(mode) {
  if (!['local', 'shared'].includes(mode)) throw new Error('Choose Local or Shared shelves.');
  await chrome.storage.local.set({ shelfMode: mode });
  if (mode === 'shared') await flushSharedShelves();
}

export async function copyLocalShelves() {
  const local = await chrome.storage.local.get(['shelves', 'pins', 'defaultShelf']);
  const shelves = normalizeShelves(local);
  return mergeShelves(shelves, local.defaultShelf || shelves[0]?.id, true);
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

async function changePins(shelf, ids, pinned, patch) {
  const items = new Set(shelf.items);
  const changed = [];
  for (const id of ids) {
    if (pinned && !items.has(id)) {
      const [node] = await chrome.bookmarks.get(id).catch(() => []);
      if (!node?.url) continue;
      items.add(id);
      changed.push(id);
    } else if (!pinned && items.delete(id)) changed.push(id);
  }
  shelf.items = [...items];
  const at = Date.now(), kind = pinned ? 'pinned' : 'unpinned';
  if (changed.length) Object.assign(patch, logEntries(await Promise.all(changed.map((id) => pinLogEntry(kind, id, shelf, at)))));
  return changed;
}

// Run by the worker (inside its shelf queue). Pages use the wrappers below.
export const shelfOps = {
  // Pin all ids if any is missing from the shelf, otherwise unpin all.
  // Returns { kind: 'pinned' | 'unpinned', changed: [ids actually changed] } so Undo can reverse exactly that.
  togglePins(ids, shelfId) {
    return editShelves(async (state, patch) => {
      const shelf = shelfFor(state, shelfId);
      const removing = ids.every((id) => shelf.items.includes(id));
      const changed = await changePins(shelf, ids, !removing, patch);
      return { kind: removing ? 'unpinned' : 'pinned', changed, shelf: shelf.name, shelfId: shelf.id, mode: state.mode };
    });
  },

  setPins(ids, shelfId, pinned, mode) {
    return editShelves(async (state, patch) => {
      if (mode && state.mode !== mode) throw new Error('Switch shelf storage back before undoing this change.');
      const shelf = state.shelves.find((s) => s.id === shelfId);
      if (shelf) await changePins(shelf, ids, pinned, patch);
    });
  },

  createShelf(name) {
    return editShelves((state) => {
      const id = newShelfId();
      state.shelves.push({ id, name: name || 'New shelf', items: [] });
      return id;
    });
  },

  renameShelf(id, name) {
    return editShelves((state) => {
      const shelf = state.shelves.find((s) => s.id === id);
      if (shelf && name) shelf.name = name;
    });
  },

  deleteShelf(id) {
    return editShelves((state) => {
      state.shelves = state.shelves.filter((s) => s.id !== id);
    });
  },

  setShelfItems(id, items) {
    return editShelves((state) => {
      const shelf = state.shelves.find((s) => s.id === id);
      if (!shelf) return;
      const existing = new Set(shelf.items);
      const ordered = [...new Set(items)].filter((id) => existing.has(id));
      const included = new Set(ordered);
      shelf.items = shelf.items.map((id) => included.has(id) ? ordered.shift() : id);
    });
  },

  moveShelf(id, delta) {
    return editShelves((state) => {
      const i = state.shelves.findIndex((s) => s.id === id);
      const j = i + delta;
      if (i < 0 || j < 0 || j >= state.shelves.length) return;
      const [shelf] = state.shelves.splice(i, 1);
      state.shelves.splice(j, 0, shelf);
    });
  },

  setDefaultShelf(id) {
    return editShelves((state) => {
      if (state.shelves.some((s) => s.id === id)) state.defaultShelf = id;
    });
  },

  mergeShelves,

  restorePins(entries) {
    return editShelves(async (state, patch) => {
      for (const { id, pin } of entries) {
        if ((pin.mode || 'local') !== state.mode) continue;
        const shelf = typeof pin === 'string' ? shelfFor(state) : state.shelves.find((s) => s.id === pin.shelf);
        if (shelf) await changePins(shelf, [id], true, patch);
      }
    });
  },

  // Always clean the local collection. Only an enabled Shared collection can publish unpins.
  async removeNodes(nodes) {
    const gone = new Set(nodes.map((node) => node.id));
    const prune = (shelves) => {
      const removed = [];
      for (const shelf of shelves) {
        for (const id of shelf.items) if (gone.has(id)) removed.push({ shelf: shelf.id, id });
        shelf.items = shelf.items.filter((id) => !gone.has(id));
      }
      return removed;
    };
    const local = await chrome.storage.local.get(['shelfMode', 'shelves', 'pins']);
    if (local.shelfMode === 'shared') {
      const shelves = normalizeShelves(local);
      if (prune(shelves).length) await chrome.storage.local.set({ shelves });
    }
    return editShelves((state) => prune(state.shelves).map((pin) => ({ ...pin, mode: state.mode })), nodes);
  },
};

const shelfCall = (op, ...args) => callWorker('shelf', { op, args });

export const togglePins = (ids, shelfId) => shelfCall('togglePins', ids, shelfId);
export const setPins = (ids, shelfId, pinned, mode) => shelfCall('setPins', ids, shelfId, pinned, mode);
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
export const changeShelfMode = (mode) => callWorker('shelfMode', { mode });
export const copyShelvesToShared = () => callWorker('copyShelvesToShared');
export const retrySharedShelves = () => callWorker('retrySharedShelves');
