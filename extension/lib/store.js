// Extension-owned state in chrome.storage.local:
//   shelves          [{id, name, items: [bookmarkId]}]  — Local shelves of pinned bookmarks, in display order
//   shelfPreferences {defaultShelf, quickAccess}  — this profile's choices: the shelf that "pin"
//                    (P / Alt+P) targets, and the shelves shown in Quick Access (null: all)
//   sharedPending    Shared shelf records waiting to reach chrome.storage.sync — see shared-shelves.js
//   sharedError      why the last write to chrome.storage.sync failed
//   act              {normUrl: {u, d: {'YYYY-MM-DD': visits}, x?, last}}  — see activity.js
//   actSyncedAt      ms of the last full history sync
//   log:<t>:<rand>   one key per log entry (append-only)
//   trackingSince    ms when live tracking started
//   archiveFolderId  id of the Archive folder
// Legacy: pins [{id,t}] (v0.1) becomes a "Pinned" shelf on first read; defaultShelf and
// shelfMode (up to 1.1) seed shelfPreferences.
//
// Writes that could race (shelves, the visit record, restores, imports) run inside the
// background worker's queues; pages ask for them with callWorker().

import { getOtherRootId, getRoot, indexTree, normUrl, pathOf } from './bm.js';
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
// Use distinct UI IDs for old Local and Shared shelves that both used "pinned".
const sharedPrefix = 'shared~';
const sharedId = (id) => sharedPrefix + id;
const inScope = (shelves, scope) => shelves.filter((shelf) => shelf.scope === scope);
const fallbackShelf = { id: 'pinned', name: 'Pinned', items: [], scope: 'local' };
export const SHELF_KEYS = ['shelves', 'pins', 'defaultShelf', 'shelfMode', 'shelfPreferences', 'sharedPending', 'sharedError'];

export async function shelfState(st, nodes) {
  const remote = await readSharedShelves(nodes, st.sharedPending);
  const local = normalizeShelves(st).map((shelf) => ({ ...shelf, scope: 'local' }));
  const shared = remote.shelves.map((shelf) => ({ ...shelf, id: sharedId(shelf.id), scope: 'shared' }));
  const shelves = [...local, ...shared];

  // Seed preferences from the collection this profile used in 1.1.0. Keep reading
  // the legacy preference until its shared shelves have arrived.
  const prefs = st.shelfPreferences || {};
  const legacyCollection = st.shelfMode === 'shared' ? shared : local;
  const legacyDefault = st.shelfMode === 'shared' && typeof remote.defaultShelf === 'string'
    ? sharedId(remote.defaultShelf)
    : st.defaultShelf;
  // Preserve an explicit shared preference even when its shelf has yet to arrive.
  const initialDefault = st.shelfMode === 'shared' && legacyDefault?.startsWith(sharedPrefix)
    ? legacyDefault
    : legacyCollection.find((shelf) => shelf.id === legacyDefault)?.id ?? legacyCollection[0]?.id;
  const initialQuickAccess = st.shelfMode && legacyCollection.length ? legacyCollection.map((shelf) => shelf.id) : null;
  const preferred = Object.hasOwn(prefs, 'defaultShelf') ? prefs.defaultShelf : initialDefault;
  const defaultShelf = shelves.find((shelf) => shelf.id === preferred)?.id ?? local[0]?.id ?? fallbackShelf.id;
  const ids = new Set(shelves.map((shelf) => shelf.id));
  const quickAccess = Object.hasOwn(prefs, 'quickAccess') ? prefs.quickAccess : initialQuickAccess;
  return {
    shelves, defaultShelf, quickAccess, quickShelves: quickAccess == null
      ? shelves.map((shelf) => shelf.id) : quickAccess.filter((id) => ids.has(id)),
    prefs, pending: st.sharedPending, legacyMode: st.shelfMode,
    initial: { defaultShelf: initialDefault, quickAccess: initialQuickAccess },
    unavailable: remote.unavailable, shared: remote.shared,
    rawShared: remote.shelves,
    nodes: new Map(nodes.map((node) => [node.id, node])),
  };
}

async function loadShelves(extraNodes = []) {
  const [st, root] = await Promise.all([chrome.storage.local.get(SHELF_KEYS), getRoot()]);
  const nodes = [...indexTree(root).byId.values(), ...extraNodes];
  return shelfState(st, nodes);
}

function migratePreferences(state) {
  const { initial, prefs } = state;
  if (!Object.hasOwn(prefs, 'defaultShelf') && initial.defaultShelf) prefs.defaultShelf = initial.defaultShelf;
  if (!Object.hasOwn(prefs, 'quickAccess') && initial.quickAccess) prefs.quickAccess = initial.quickAccess;
}

export async function migrateShelfPreferences() {
  const { shelfMode, shelfPreferences, sharedPending } = await chrome.storage.local.get(['shelfMode', 'shelfPreferences', 'sharedPending']);
  if (!shelfMode) return;
  if (!shelfPreferences || !Object.hasOwn(shelfPreferences, 'defaultShelf') || !Object.hasOwn(shelfPreferences, 'quickAccess')) {
    const state = await loadShelves();
    migratePreferences(state);
    await chrome.storage.local.set({ shelfPreferences: state.prefs });
    if (!Object.hasOwn(state.prefs, 'defaultShelf') || !Object.hasOwn(state.prefs, 'quickAccess')) return;
  }
  if (shelfMode !== 'local' || !Object.keys(sharedPending || {}).length) await chrome.storage.local.remove('shelfMode');
}

export async function flushSharedShelves(retry = false) {
  const { shelfMode, sharedPending, sharedError } = await chrome.storage.local.get(['shelfMode', 'sharedPending', 'sharedError']);
  if (!Object.keys(sharedPending || {}).length) return;
  // 1.1.0 Local mode paused shared writes. Require Retry before sending those edits.
  if (shelfMode === 'local' && !retry) return;
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
  const clear = ['sharedPending', 'sharedError'];
  if (retry && shelfMode === 'local') clear.push('shelfMode');
  await chrome.storage.local.remove(clear);
}

// The shelf queue owns changes to both collections and this profile's preferences.
async function editShelves(edit, extraNodes) {
  const state = await loadShelves(extraNodes);
  const beforeLocal = JSON.stringify(inScope(state.shelves, 'local'));
  const beforePrefs = JSON.stringify(state.prefs);
  migratePreferences(state);
  const patch = {};
  const result = await edit(state, patch);

  const local = inScope(state.shelves, 'local');
  if (JSON.stringify(local) !== beforeLocal) patch.shelves = local.map(({ id, name, items }) => ({ id, name, items }));
  const remote = inScope(state.shelves, 'shared').map(({ id, name, items, unavailable }) => ({
    id: id.slice(sharedPrefix.length), name, items, unavailable: unavailable || 0,
  }));
  const changes = await sharedChanges(state.rawShared, remote, state.shared, state.nodes);
  if (Object.keys(changes).length) {
    patch.sharedPending = { ...state.pending, ...changes };
  }
  if (JSON.stringify(state.prefs) !== beforePrefs) patch.shelfPreferences = state.prefs;
  if (Object.keys(patch).length) await chrome.storage.local.set(patch);
  if (state.legacyMode === 'local' && !Object.keys(state.pending || {}).length) await chrome.storage.local.remove('shelfMode');
  if (patch.sharedPending) await flushSharedShelves();
  return result;
}

// A shelf made on this computer joins its Quick Access; one arriving through sync waits to be chosen.
function showInQuickAccess(state, id) {
  const shown = state.prefs.quickAccess;
  if (shown && !shown.includes(id)) shown.push(id);
}

function shelfFor(state, shelfId) {
  const shelf = state.shelves.find((s) => s.id === (shelfId ?? state.defaultShelf));
  if (shelf) return shelf;
  if (shelfId != null) throw new Error('This shelf is no longer available.');
  const created = structuredClone(fallbackShelf);
  state.shelves.unshift(created);
  showInQuickAccess(state, created.id);
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
  togglePins(ids, shelfId, onlyPin) {
    return editShelves(async (state, patch) => {
      const shelf = shelfFor(state, shelfId);
      const removing = !onlyPin && ids.every((id) => shelf.items.includes(id));
      const changed = await changePins(shelf, ids, !removing, patch);
      return { kind: removing ? 'unpinned' : 'pinned', changed, shelf: shelf.name, shelfId: shelf.id };
    });
  },

  setPins(ids, shelfId, pinned) {
    return editShelves(async (state, patch) => {
      const shelf = state.shelves.find((s) => s.id === shelfId);
      if (shelf) await changePins(shelf, ids, pinned, patch);
    });
  },

  createShelf(name) {
    return editShelves((state) => {
      const id = newShelfId();
      state.shelves.push({ id, name: name || 'New shelf', items: [], scope: 'local' });
      showInQuickAccess(state, id);
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
      if (state.prefs.defaultShelf === id) state.prefs.defaultShelf = null;
      if (state.prefs.quickAccess) state.prefs.quickAccess = state.prefs.quickAccess.filter((shelfId) => shelfId !== id);
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
      if (i < 0 || state.shelves[i]?.scope !== state.shelves[j]?.scope) return;
      const [shelf] = state.shelves.splice(i, 1);
      state.shelves.splice(j, 0, shelf);
    });
  },

  setDefaultShelf(id) {
    return editShelves((state) => {
      state.prefs.defaultShelf = shelfFor(state, id).id;
    });
  },

  setQuickAccess(ids) {
    return editShelves((state) => {
      // Keep IDs selected earlier even if sync has temporarily removed their shelves.
      state.prefs.quickAccess = ids === null ? null : [...new Set(ids)];
    });
  },

  shareShelf(id) {
    return editShelves((state) => {
      const shelf = shelfFor(state, id);
      if (shelf.scope !== 'local') throw new Error('This shelf is already Shared.');
      if (state.legacyMode === 'local' && Object.keys(state.pending || {}).length) {
        throw new Error('Use Retry in Settings to finish the paused shared edits before sharing a shelf.');
      }
      const nextId = sharedId(newShelfId());
      if ((state.prefs.defaultShelf ?? state.defaultShelf) === id) state.prefs.defaultShelf = nextId;
      if (state.prefs.quickAccess) state.prefs.quickAccess = state.prefs.quickAccess.map((value) => value === id ? nextId : value);
      shelf.id = nextId;
      shelf.scope = 'shared';
      shelf.items = shelf.items.filter((bookmarkId) => state.nodes.get(bookmarkId)?.url);
      return nextId;
    });
  },

  copyShelfLocally(id) {
    return editShelves((state) => {
      const shelf = shelfFor(state, id);
      if (shelf.scope !== 'shared') throw new Error('Choose a Shared shelf to copy.');
      const localId = newShelfId();
      state.shelves.push({ id: localId, name: shelf.name, items: [...shelf.items], scope: 'local' });
      showInQuickAccess(state, localId);
      return localId;
    });
  },

  pinPage({ url, title }, shelfId) {
    return editShelves(async (state, patch) => {
      if (!/^(https?|file|ftp):/.test(url)) throw new Error('This page cannot be bookmarked.');
      const shelf = shelfFor(state, shelfId);
      const norm = normUrl(url);
      const matches = [...state.nodes.values()].filter((bookmark) => bookmark.url && normUrl(bookmark.url) === norm);
      let node = matches.find((bookmark) => shelf.items.includes(bookmark.id))
        || matches.find((bookmark) => bookmark.syncing === (shelf.scope === 'shared')) || matches[0];
      if (!node) {
        node = await chrome.bookmarks.create({
          parentId: await getOtherRootId(shelf.scope === 'local'), title: title || url, url,
        });
        state.nodes.set(node.id, node);
      }
      await changePins(shelf, [node.id], shelfId != null || !shelf.items.includes(node.id), patch);
    });
  },

  mergeShelves(source) {
    return editShelves((state) => {
      const result = { shelves: 0, pins: 0 };
      for (const shelf of source) {
        let target = inScope(state.shelves, 'local').find((s) => s.name === shelf.name);
        if (!target) {
          target = { id: newShelfId(), name: shelf.name, items: [], scope: 'local' };
          state.shelves.push(target);
          showInQuickAccess(state, target.id);
          result.shelves++;
        }
        const items = new Set(target.items);
        for (const id of shelf.items) if (!items.has(id)) { items.add(id); result.pins++; }
        target.items = [...items];
      }
      return result;
    });
  },

  restorePins(entries) {
    return editShelves(async (state, patch) => {
      for (const { id, pin } of entries) {
        const shelfId = pin.mode === 'shared' ? sharedId(pin.shelf) : pin.shelf;
        const shelf = typeof pin === 'string' ? shelfFor(state) : state.shelves.find((s) => s.id === shelfId);
        if (shelf) await changePins(shelf, [id], true, patch);
      }
    });
  },

  removeNodes(nodes) {
    const gone = new Set(nodes.map((node) => node.id));
    return editShelves((state) => {
      const removed = [];
      for (const shelf of state.shelves) {
        for (const id of shelf.items) if (gone.has(id)) removed.push({ shelf: shelf.id, id });
        shelf.items = shelf.items.filter((id) => !gone.has(id));
      }
      return removed;
    }, nodes);
  },
};

const shelfCall = (op, ...args) => callWorker('shelf', { op, args });

export const togglePins = (ids, shelfId, onlyPin) => shelfCall('togglePins', ids, shelfId, onlyPin);
export const setPins = (ids, shelfId, pinned) => shelfCall('setPins', ids, shelfId, pinned);
export const createShelf = (name) => shelfCall('createShelf', name);
export const renameShelf = (id, name) => shelfCall('renameShelf', id, name);
export const deleteShelf = (id) => shelfCall('deleteShelf', id);
export const setShelfItems = (id, items) => shelfCall('setShelfItems', id, items);
export const moveShelf = (id, delta) => shelfCall('moveShelf', id, delta);
export const setDefaultShelf = (id) => shelfCall('setDefaultShelf', id);
export const setQuickAccess = (ids) => shelfCall('setQuickAccess', ids);
export const shareShelf = (id) => shelfCall('shareShelf', id);
export const copyShelfLocally = (id) => shelfCall('copyShelfLocally', id);
export const pinPage = (page, shelfId) => shelfCall('pinPage', page, shelfId);

// ---------- other worker requests ----------

export const syncHistory = () => callWorker('sync');
// Mark log entries for deleted bookmarks as restored (old id → new id), after their removal is logged.
export const markRestored = (idMap) => callWorker('markRestored', { pairs: [...idMap] });
// Restore a deleted item from its log entry (key); returns { title, parentOk } or { already: true }.
export const restoreFromLogEntry = (key) => callWorker('restore', { key });
export const importExport = (data) => callWorker('import', { data });
// Erase everything stored in chrome.storage.local; the worker then rebuilds the log and visit counts.
export const resetAll = () => callWorker('reset');
export const retrySharedShelves = () => callWorker('retrySharedShelves');
