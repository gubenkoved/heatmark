// Service worker:
//  - logs every bookmark change (Chrome UI, sync from other devices, this extension)
//  - records visits to bookmarked URLs from Chrome history, long-term, and honors history deletions
//  - owns every shelf write, so pages and the worker never overwrite each other

import { getRoot, getOtherRootId, pathOf, slim, countUrls, collectIds, restoreNode } from './lib/bm.js';
import { appendLog, logEntries, logFrom, shelfOps } from './lib/store.js';
import { syncFromHistory, syncUrls, recordVisits, bookmarkedNorms } from './lib/activity.js';
import { importData } from './lib/transfer.js';

// Two serial queues: `work` for the log and visit record (may run long history syncs),
// `shelfWork` for shelf edits, so pinning from the UI never waits behind a sync.
function queue() {
  let chain = Promise.resolve();
  return (fn) => {
    const run = chain.then(fn);
    chain = run.catch((e) => console.error('[heatmark]', e));
    return run;
  };
}
const work = queue();
const shelfWork = queue();

const nodeOf = async (id) => {
  try { return (await chrome.bookmarks.get(id))[0]; } catch { return null; }
};

// Bookmarked-URL cache for the visit listener; invalidated on any bookmark change.
let normsCache = null;
const norms = async () => (normsCache ??= await bookmarkedNorms());
const invalidate = () => { normsCache = null; };

// First run: reconstruct "added" history from each bookmark's dateAdded. Written together with
// `trackingSince` in one set, so an interrupted first run can't seed twice.
async function seedIfNeeded() {
  const { trackingSince } = await chrome.storage.local.get('trackingSince');
  if (trackingSince) return;
  const root = await getRoot();
  const entries = [];
  (function walk(n, path, depth) {
    if (depth >= 2 && n.dateAdded) {
      entries.push({ t: n.dateAdded, kind: 'created', id: n.id, title: n.title, url: n.url, folder: !n.url, path, seeded: true });
    }
    const here = depth === 0 ? [] : [...path, n.title];
    for (const c of n.children || []) walk(c, here, depth + 1);
  })(root, [], 0);
  await chrome.storage.local.set({ ...logEntries(entries), trackingSince: Date.now() });
}

async function startup() {
  await seedIfNeeded();
  await syncFromHistory();
}

chrome.runtime.onInstalled.addListener(() => work(startup));
chrome.runtime.onStartup.addListener(() => work(startup));

// Messages from the extension's own pages (there is no externally_connectable or content script).
const handlers = {
  sync: () => work(() => syncFromHistory()),
  shelf: ({ op, args }) => {
    if (!Object.hasOwn(shelfOps, op) || op === 'removeIds') throw new Error(`unknown shelf op ${op}`);
    return shelfWork(() => shelfOps[op](...args));
  },
  // Queued behind the removals it refers to, so their log entries exist by the time it runs.
  markRestored: ({ pairs }) => work(async () => {
    const idMap = new Map(pairs);
    const patch = {};
    for (const l of logFrom(await chrome.storage.local.get(null))) {
      if (l.kind === 'removed' && !l.restoredAt && !l.imported && idMap.has(l.id)) {
        const { key, ...entry } = l;
        patch[key] = { ...entry, restoredAt: Date.now(), restoredId: idMap.get(l.id) };
      }
    }
    if (Object.keys(patch).length) await chrome.storage.local.set(patch);
  }),
  // Restore a deleted item from its log entry; checking and marking happen in one queued step.
  restore: ({ key }) => work(async () => {
    const { [key]: entry } = await chrome.storage.local.get(key);
    if (!entry?.node) throw new Error('This log entry has nothing to restore');
    if (entry.restoredAt) return { already: true, title: entry.title };
    const parent = entry.parentId && (await nodeOf(entry.parentId));
    const parentOk = !!parent && !parent.url;
    const idMap = new Map();
    const created = await restoreNode(entry.node, parentOk ? entry.parentId : await getOtherRootId(), parentOk ? entry.index : undefined, idMap);
    for (const p of entry.wasPinned || []) {
      const old = typeof p === 'string' ? p : p.id;
      if (idMap.has(old)) await shelfWork(() => shelfOps.pin(idMap.get(old), typeof p === 'string' ? undefined : p.shelf));
    }
    await chrome.storage.local.set({ [key]: { ...entry, restoredAt: Date.now(), restoredId: created.id } });
    return { title: entry.title, parentOk };
  }),
  import: ({ data }) => work(async () => {
    const result = await importData(data, shelfWork);
    invalidate();
    await syncFromHistory(); // reconcile imported visits with this profile's history
    return result;
  }),
  reset: () => work(async () => {
    await chrome.storage.local.clear();
    invalidate();
    await startup();
  }),
};

chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  const handler = handlers[msg?.type];
  if (!handler) return false;
  Promise.resolve()
    .then(() => handler(msg))
    .then((value) => respond({ value }), (err) => respond({ error: String(err?.message || err) }));
  return true; // async response
});

// Live visits: batched, so a burst of navigation costs one storage write.
const pendingVisits = [];
let flushTimer = 0;
chrome.history.onVisited.addListener((item) => {
  pendingVisits.push(item);
  clearTimeout(flushTimer);
  flushTimer = setTimeout(() => work(async () => recordVisits(pendingVisits.splice(0), await norms())), 1500);
});

// History deleted in Chrome: clearing everything erases the record; otherwise re-sync, which
// recomputes every day still inside Chrome's retention window.
chrome.history.onVisitRemoved.addListener(({ allHistory }) => work(() => syncFromHistory({ eraseAll: allHistory })));

// New bookmarks may already have history. Their URLs are checked in batches; a big batch (sync
// filling a new device) or a bookmark import gets one full sync instead.
const pendingUrls = new Set();
let urlTimer = 0;
let importing = false;
function checkNewUrls() {
  const urls = [...pendingUrls];
  pendingUrls.clear();
  if (!urls.length || importing) return;
  work(async () => (urls.length > 50 ? syncFromHistory() : syncUrls(urls, await norms())));
}

chrome.bookmarks.onImportBegan.addListener(() => { importing = true; });
chrome.bookmarks.onImportEnded.addListener(() => {
  importing = false;
  pendingUrls.clear();
  work(async () => { invalidate(); await syncFromHistory(); });
});

chrome.bookmarks.onCreated.addListener((id, node) => {
  if (node.url) {
    pendingUrls.add(node.url);
    clearTimeout(urlTimer);
    urlTimer = setTimeout(checkNewUrls, 1500);
  }
  work(async () => {
    invalidate();
    await appendLog({
      t: node.dateAdded || Date.now(), kind: 'created', id, title: node.title, url: node.url, folder: !node.url,
      path: await pathOf(node.parentId),
    });
  });
});

chrome.bookmarks.onRemoved.addListener((id, info) =>
  work(async () => {
    invalidate();
    const node = info.node || { id, title: '' };
    const wasPinned = await shelfWork(() => shelfOps.removeIds([...collectIds(node)]));
    await appendLog({
      t: Date.now(), kind: 'removed', id, title: node.title, url: node.url, folder: !node.url,
      count: countUrls(node), path: await pathOf(info.parentId),
      parentId: info.parentId, index: info.index, node: slim(node), wasPinned,
    });
  }),
);

chrome.bookmarks.onChanged.addListener((id, info) =>
  work(async () => {
    invalidate();
    const node = await nodeOf(id);
    await appendLog({
      t: Date.now(), kind: 'changed', id, title: info.title ?? node?.title, url: info.url ?? node?.url,
      folder: node ? !node.url : false, path: node ? await pathOf(node.parentId) : [],
    });
    if (info.url) await syncUrls([info.url], await norms()); // the new URL may already have history
  }),
);

chrome.bookmarks.onMoved.addListener((id, info) =>
  work(async () => {
    if (info.parentId === info.oldParentId) return; // reorder within a folder: not worth logging
    const node = await nodeOf(id);
    const { archiveFolderId } = await chrome.storage.local.get('archiveFolderId');
    const kind =
      info.parentId === archiveFolderId ? 'archived' : info.oldParentId === archiveFolderId ? 'unarchived' : 'moved';
    await appendLog({
      t: Date.now(), kind, id, title: node?.title, url: node?.url, folder: node ? !node.url : false,
      from: await pathOf(info.oldParentId), path: await pathOf(info.parentId),
      oldParentId: info.oldParentId, oldIndex: info.oldIndex,
    });
  }),
);
