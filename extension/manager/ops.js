// Operations on bookmarks and shelves (move, archive, delete, pin, restore, import/export), with Undo where it applies.

import { ensureArchiveFolder, getOtherRootId, restoreNode, slim } from '../lib/bm.js';
import { confirmDialog, promptDialog } from '../lib/dialog.js';
import { parseQuery } from '../lib/query.js';
import {
  createShelf, deleteShelf, importExport, markRestored, setPins, renameShelf,
  resetAll, restoreFromLogEntry, togglePins, shareShelf, copyShelfLocally,
} from '../lib/store.js';
import { buildExport, looksLikeExport, summarize as summarizeExport } from '../lib/transfer.js';
import { h, lsClear, lsSet, openLink, plural, toast } from '../lib/ui.js';
import { pal } from '../manager.js';
import { renderDetail } from './detail.js';
import { render, renderStatus, setCursor, syncRowClasses } from './list.js';
import { E, KINDS, S, go, inFolder, withBusy } from './state.js';

// Existing, movable items whose ancestor isn't also in the list (it travels with the parent).
function topLevel(ids) {
  const byId = S.m.idx.byId;
  ids = ids.filter((id) => byId.has(id) && !(S.m.idx.folderById.get(id)?.depth <= 1));
  const set = new Set(ids);
  return ids.filter((id) => {
    for (let p = byId.get(id)?.parentId; p; p = byId.get(p)?.parentId) if (set.has(p)) return false;
    return true;
  });
}

async function each(ids, fn) {
  let failed = 0;
  for (const id of ids) {
    try { await fn(id); } catch (err) { failed++; console.error(err); }
  }
  return failed;
}

const done = (verb, n, failed) => `${verb} ${plural(n - failed, 'item')}${failed ? ` · ${failed} failed` : ''}`;

// Where items are now, ordered by folder and position: putting them back in this order, each at
// its old index, reproduces the original order.
function snapshot(ids) {
  return ids
    .map((id) => {
      const n = S.m.idx.byId.get(id);
      return { id, node: n, parentId: n.parentId, index: n.index ?? 0 };
    })
    .sort((a, b) => (a.parentId === b.parentId ? a.index - b.index : a.parentId < b.parentId ? -1 : 1));
}

async function moveBack(snaps) {
  for (const sn of snaps) {
    try {
      const siblings = await chrome.bookmarks.getChildren(sn.parentId);
      await chrome.bookmarks.move(sn.id, { parentId: sn.parentId, index: Math.min(sn.index, siblings.length) });
    } catch (err) { console.error(err); }
  }
}

async function moveItems(ids, parentId, verb) {
  ids = topLevel(ids).filter((id) => S.m.idx.byId.get(id)?.parentId !== parentId);
  if (!ids.length) return;
  const snaps = snapshot(ids);
  const failed = await each(ids, (id) => chrome.bookmarks.move(id, { parentId }));
  toast(done(verb, ids.length, failed), { action: 'Undo', run: () => withBusy(() => moveBack(snaps)) });
}

export const opMove = (ids, parentId) => withBusy(() => moveItems(ids, parentId, 'Moved'));

export const opArchive = (ids) => withBusy(async () => moveItems(ids, await ensureArchiveFolder(), 'Archived'));

export function opUnarchive(ids) {
  ids = topLevel(ids);
  const snaps = snapshot(ids);
  return withBusy(async () => {
    const fallback = await getOtherRootId();
    const failed = await each(ids, (id) => {
      const entry = S.m.log.find((l) => l.kind === 'archived' && l.id === id && !l.imported);
      const target = entry && S.m.idx.byId.has(entry.oldParentId) ? entry.oldParentId : fallback;
      return chrome.bookmarks.move(id, { parentId: target });
    });
    toast(done('Moved back', ids.length, failed), { action: 'Undo', run: () => withBusy(() => moveBack(snaps)) });
  });
}

export async function opDelete(ids) {
  const m = S.m;
  ids = topLevel(ids);
  if (!ids.length) return;
  const snaps = snapshot(ids);
  const links = snaps.reduce((s, sn) => s + (sn.node.url ? 1 : (m.idx.folderById.get(sn.id)?.agg.count || 0)), 0);
  if (links > 25 && !(await confirmDialog({
    title: `Delete ${plural(links, 'bookmark')}?`,
    message: `${snaps.some((sn) => !sn.node.url) ? 'This includes the contents of the selected folders. ' : ''}They are also removed from Chrome sync. You can undo right after, and every deletion stays restorable from the log.`,
    ok: 'Delete', danger: true,
  }))) return;
  const trees = snaps.map((sn) => ({ ...sn, node: slim(sn.node) }));
  const pinsBefore = m.shelves.flatMap((s) => s.items.map((id) => ({ shelf: s.id, id })));
  return withBusy(async () => {
    const failed = await each(ids, (id) => (m.idx.byId.get(id).url ? chrome.bookmarks.remove(id) : chrome.bookmarks.removeTree(id)));
    toast(done('Deleted', ids.length, failed), {
      action: 'Undo',
      run: () => withBusy(async () => {
        const idMap = new Map();
        for (const { node, parentId, index } of trees) {
          const [parent] = await chrome.bookmarks.get(parentId).catch(() => []);
          const localOnly = node.syncing === false;
          const sameParent = parent && !parent.url && (!localOnly || parent.syncing === false);
          await restoreNode(node, sameParent ? parentId : await getOtherRootId(localOnly), sameParent ? index : undefined, idMap);
        }
        for (const p of pinsBefore) if (idMap.has(p.id)) await setPins([idMap.get(p.id)], p.shelf, true);
        await markRestored(idMap);
      }),
    });
  });
}

export function opPin(ids, shelfId, onlyPin = false) {
  const links = ids.filter((id) => S.m.idx.entryById.has(id));
  if (!links.length) return;
  return withBusy(async () => {
    const r = await togglePins(links, shelfId, onlyPin);
    if (!r.changed.length) { toast(`Already pinned to ${r.shelf}`); return; }
    const pinned = r.kind === 'pinned';
    toast(`${pinned ? 'Pinned' : 'Unpinned'} ${plural(r.changed.length, 'bookmark')} ${pinned ? 'to' : 'from'} ${r.shelf}`,
      { action: 'Undo', run: () => withBusy(() => setPins(r.changed, r.shelfId, !pinned)) });
  });
}

export function restoreFromLog(key) {
  return withBusy(async () => {
    const r = await restoreFromLogEntry(key);
    if (r.already) toast(`“${r.title}” was already restored`);
    else toast(r.parentOk ? `Restored “${r.title}”` : `Restored “${r.title}” into Other bookmarks (its folder is gone)`);
  });
}

export async function openEntries(ids, how = 'tab') {
  const es = ids.map((id) => S.m.idx.entryById.get(id)).filter(Boolean);
  if (es.length > 15 && !(await confirmDialog({ title: `Open ${es.length} tabs?`, ok: 'Open all' }))) return;
  es.forEach((e, i) => openLink(e.node.url, es.length > 1 ? (i === 0 && how === 'tab' ? 'tab' : 'background') : how));
}

export function newShelf(pinIds = []) {
  pal.open({
    mode: 'shelf', title: pinIds.length ? 'Pin to' : 'New shelf', placeholder: 'Name the new shelf…',
    onPick: (s) => withBusy(async () => {
      const id = s.create ? await createShelf(s.create) : s.id;
      if (pinIds.length) await togglePins(pinIds, id);
      else go(`shelf:${id}`);
    }),
  });
}

export function pickShelf(ids) {
  const links = ids.filter((id) => S.m.idx.entryById.has(id));
  if (!links.length) return;
  pal.open({
    mode: 'shelf', title: `Pin ${plural(links.length, 'bookmark')} to`,
    onPick: async (s) => {
      let id = s.id;
      if (s.create) {
        try { id = await createShelf(s.create); } catch (err) { toast(String(err.message || err)); return; }
      }
      await opPin(links, id, true);
    },
  });
}

export function pickFolder(ids) {
  ids = ids.filter((id) => S.m.idx.byId.has(id));
  if (!ids.length) return;
  pal.open({ mode: 'folder', title: `Move ${plural(ids.length, 'item')} to`, onPick: (f) => opMove(ids, f.node.id) });
}

// Select a bookmark in the list; with inTree, always show it in its place in the folder tree.
export function reveal(target, { inTree = false } = {}) {
  const m = S.m;
  const node = target.node || m.idx.byId.get(target);
  if (!node) return;
  if (!node.url) return go(`folder:${node.id}`);
  for (const id of m.idx.entryById.get(node.id).ancestors) S.expanded.add(id);
  lsSet('expanded', [...S.expanded]);
  const rootK = `folder:${m.idx.root.id}`;
  const visible = S.route.kind !== 'activity' && S.rowIndex.has(node.id) && (!inTree || S.mode === 'tree');
  if (!visible || inTree) {
    if (location.hash.slice(1) !== rootK) { location.hash = rootK; S.route = { kind: 'folder', id: m.idx.root.id }; }
    S.q = ''; S.pq = parseQuery(''); E.filter.value = '';
    render();
  }
  setCursor(node.id);
  E.list.focus();
}

export async function exportJSON() {
  const data = await buildExport(S.m);
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const a = h('a', { href: url, download: `heatmark-${new Date().toISOString().slice(0, 10)}.json` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export async function copyText(text, message) {
  try {
    await navigator.clipboard.writeText(text);
    toast(message);
  } catch {
    toast('Could not copy to the clipboard');
  }
}

export const markdownLink = (e) => `[${(e.node.title || e.durl).replace(/([[\]])/g, '\\$1')}](${e.node.url})`;

export async function openInWindow(urls) {
  urls = urls.filter((u) => !/^javascript:/i.test(u));
  if (!urls.length) return;
  if (urls.length > 15 && !(await confirmDialog({ title: `Open ${urls.length} tabs in a new window?`, ok: 'Open all' }))) return;
  try { await chrome.windows.create({ url: urls }); } catch (err) { toast(`Chrome can't open these URLs: ${err.message || err}`); }
}

export function linksUnder(folderId) {
  const f = S.m.idx.folderById.get(folderId);
  return S.m.idx.urls.filter((e) => inFolder(e, f) && (f.inArchive || !e.inArchive));
}

export function expandAll() {
  for (const f of S.m.idx.folders) S.expanded.add(f.node.id);
  lsSet('expanded', [...S.expanded]);
  render();
}

export function collapseAll() {
  S.expanded.clear();
  lsSet('expanded', []);
  render();
}

export function selectAll() {
  S.selected = new Set(S.rows.map((x) => x.id));
  syncRowClasses();
  renderDetail();
  renderStatus();
}

export async function renameItem(id) {
  const n = S.m.idx.byId.get(id);
  if (!n) return;
  const title = await promptDialog({ title: n.url ? 'Rename bookmark' : 'Rename folder', value: n.title, ok: 'Rename' });
  if (title != null && title !== n.title) withBusy(() => chrome.bookmarks.update(id, { title }));
}

export async function editUrl(id) {
  const n = S.m.idx.byId.get(id);
  if (!n?.url) return;
  const url = await promptDialog({
    title: 'Edit URL', value: n.url, ok: 'Save',
    validate: (v) => (/^[a-z][\w+.-]*:/i.test(v) ? null : 'Enter a full URL, including https://'),
  });
  if (url != null && url !== n.url) withBusy(() => chrome.bookmarks.update(id, { url }));
}

export async function newFolder(parentId) {
  const m = S.m;
  const parent = parentId && m.idx.folderById.get(parentId);
  if (!parent || parent.depth === 0) parentId = await getOtherRootId();
  const where = m.idx.folderById.get(parentId)?.pathStr || 'Other bookmarks';
  const title = await promptDialog({ title: 'New folder', message: `Inside ${where}`, placeholder: 'Folder name', ok: 'Create' });
  if (title == null) return;
  let created = null;
  await withBusy(async () => {
    created = await chrome.bookmarks.create({ parentId, title });
    for (const id of [...(m.idx.folderById.get(parentId)?.ancestors || []), parentId]) S.expanded.add(id);
    lsSet('expanded', [...S.expanded]);
  });
  if (created && S.rowIndex.has(created.id)) setCursor(created.id);
}

// Merge an export (from this or another install) into this one. The worker does the work.
export function importJSON() {
  const input = h('input', { type: 'file', accept: 'application/json,.json' });
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (!file) return;
    let data;
    try { data = JSON.parse(await file.text()); } catch { toast('That file is not valid JSON'); return; }
    if (!looksLikeExport(data)) { toast('That file is not a Heatmark export'); return; }
    const s = summarizeExport(data);
    const ok = await confirmDialog({
      title: 'Import Heatmark data?',
      message: `${plural(s.shelves, 'shelf', 'shelves')}, ${plural(s.log, 'log entry', 'log entries')} and visit counts for ${plural(s.pages, 'page')}.\n\nThis adds pins to Local shelves by name and URL. Heatmark skips log entries you already have.`,
      ok: 'Import',
    });
    if (!ok) return;
    await withBusy(async () => {
      const v = await importExport(data);
      toast(`Imported ${plural(v.log, 'log entry', 'log entries')}, ${plural(v.pins, 'pin')}${v.shelves ? ` (${plural(v.shelves, 'new shelf', 'new shelves')})` : ''}, visits for ${plural(v.pages, 'page')}`
        + (v.unmatched ? ` · ${v.unmatched} pinned bookmarks not found here` : ''), { ms: 9000 });
    });
  });
  input.click();
}

export async function renameShelfInline(id) {
  const s = S.m.shelves.find((x) => x.id === id);
  if (!s) return;
  const name = await promptDialog({ title: 'Rename shelf', value: s.name, ok: 'Rename' });
  if (name && name !== s.name) withBusy(() => renameShelf(id, name));
}

export async function changeShelfStorage(id) {
  const shelf = S.m.shelves.find((s) => s.id === id);
  if (!shelf) return;
  const share = shelf.scope === 'local';
  const ok = await confirmDialog({
    title: share ? `Share “${shelf.name}”?` : `Make a local copy of “${shelf.name}”?`,
    message: share
      ? 'Chrome Sync will share this shelf and its pin references with your other computers. A pin appears when its Chrome bookmark is available there.'
      : 'Copy the pins available on this computer. The shared shelf stays available to other computers.',
    ok: share ? 'Share shelf' : 'Make local copy',
  });
  if (!ok) return;
  await withBusy(async () => go(`shelf:${await (share ? shareShelf(id) : copyShelfLocally(id))}`));
}

export async function removeShelf(id) {
  const s = S.m.shelves.find((x) => x.id === id);
  if (!s) return;
  if ((s.items.length || s.scope === 'shared') && !(await confirmDialog({
    title: `Delete shelf “${s.name}”?`,
    message: s.scope === 'shared'
      ? 'Chrome Sync will remove this shelf from your other computers. Its Chrome bookmarks stay in place.'
      : 'The bookmarks on this shelf stay in their Chrome folders.',
    ok: 'Delete shelf', danger: true,
  }))) return;
  withBusy(async () => {
    await deleteShelf(id);
    if (S.route.kind === 'shelf' && S.route.id === id) go(`folder:${S.m.idx.root.id}`);
  });
}

// Clear the data on this Chrome profile.
export async function deleteAllStoredData() {
  const ok = await confirmDialog({
    title: 'Delete local Heatmark data?',
    message: 'This clears the change log, visit record, local shelves, view settings, and shared edits waiting to be saved from this profile. Your Chrome bookmarks and shelves already saved to Chrome Sync stay available.',
    ok: 'Delete local data', danger: true,
  });
  if (!ok) return;
  await withBusy(async () => {
    await resetAll();
    lsClear();
    S.expanded = new Set(S.m.idx.root.children.map((c) => c.id));
    S.sideOpen.clear();
    S.sideClosed.clear();
    S.actv.kinds = new Set(Object.keys(KINDS));
    toast('Stored data deleted');
  });
}
