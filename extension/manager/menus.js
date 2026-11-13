// Context menus for bookmarks, selections, folders, shelves and empty space.

import { openMenu } from '../lib/menu.js';
import { moveShelf, setDefaultShelf } from '../lib/store.js';
import { openLink } from '../lib/ui.js';
import { targets } from './detail.js';
import { toggleFolder } from './list.js';
import {
  changeShelfStorage, collapseAll, copyText, editUrl, expandAll, linksUnder, markdownLink,
  newFolder, newShelf, opArchive, opDelete, opPin, opUnarchive,
  openEntries, openInWindow, pickFolder, pickShelf, removeShelf, renameItem,
  renameShelfInline, reveal, selectAll,
} from './ops.js';
import { E, S, go, withBusy } from './state.js';

// Bookmarks (one or many, possibly mixed with folders)
export function entryMenu(ids) {
  const m = S.m;
  ids = ids.filter((id) => m.idx.byId.has(id));
  if (ids.length === 1 && m.idx.folderById.has(ids[0])) return folderMenu(ids[0]);
  const es = ids.map((id) => m.idx.entryById.get(id)).filter(Boolean);
  const n = es.length;
  const one = ids.length === 1 ? es[0] : null;
  const shelf = m.defaultShelfName;
  const pinned = n && es.every((e) => m.isPinnedOnDefault(e.node.id));
  const archived = ids.every((id) => m.idx.entryById.get(id)?.inArchive || m.idx.folderById.get(id)?.inArchive);
  const urls = es.map((e) => e.node.url);
  const inTreeHere = one && S.mode === 'tree' && S.rowIndex.has(one.node.id);
  return [
    ids.length > 1 && { header: `${ids.length} selected` },
    n && { label: n > 1 ? `Open ${n} in new tabs` : 'Open in new tab', key: '↵', run: () => openEntries(es.map((e) => e.node.id)) },
    one && { label: 'Open in this tab', key: 'Shift ↵', run: () => openLink(one.node.url, 'here') },
    n && { label: n > 1 ? `Open ${n} in new window` : 'Open in new window', run: () => openInWindow(urls) },
    '-',
    n && { label: n > 1 ? `Copy ${n} links` : 'Copy link', run: () => copyText(urls.join('\n'), n > 1 ? `Copied ${n} links` : 'Link copied') },
    n && { label: 'Copy as Markdown', run: () => copyText(es.map(markdownLink).join('\n'), 'Copied as Markdown') },
    '-',
    n && { label: pinned ? `Unpin from ${shelf}` : `Pin to ${shelf}`, key: 'P', run: () => opPin(es.map((e) => e.node.id)) },
    n && { label: 'Pin to shelf…', key: 'Shift P', run: () => pickShelf(ids) },
    '-',
    one && { label: 'Rename…', key: 'E', run: () => renameItem(one.node.id) },
    one && { label: 'Edit URL…', run: () => editUrl(one.node.id) },
    { label: 'Move to…', key: 'M', run: () => pickFolder(ids) },
    one && !inTreeHere && { label: 'Show in folder', run: () => reveal(one.node.id, { inTree: true }) },
    one && m.dupKey.has(one.node.id) && { label: 'Show duplicates', run: () => showDuplicates(one) },
    '-',
    { label: archived ? 'Unarchive' : 'Archive', key: 'A', run: () => (archived ? opUnarchive(ids) : opArchive(ids)) },
    { label: ids.length > 1 ? `Delete ${ids.length}` : 'Delete', key: 'Del', danger: true, run: () => opDelete(ids) },
  ];
}

function showDuplicates(e) {
  go('view:dups');
  setTimeout(() => { E.filter.value = e.durl; E.filter.dispatchEvent(new Event('input')); }, 0);
}

export function folderMenu(id, { fromSidebar = false } = {}) {
  const m = S.m;
  const f = m.idx.folderById.get(id);
  if (!f) return [];
  const links = linksUnder(id);
  const editable = f.depth >= 2;
  const row = !fromSidebar && S.mode === 'tree' && S.rows[S.rowIndex.get(id)];
  return [
    links.length && { label: `Open all ${links.length}`, run: () => openEntries(links.map((e) => e.node.id)) },
    links.length && { label: 'Open all in new window', run: () => openInWindow(links.map((e) => e.node.url)) },
    '-',
    row && { label: row.open ? 'Collapse' : 'Expand', key: row.open ? '←' : '→', run: () => toggleFolder(id) },
    !(S.route.kind === 'folder' && S.route.id === id) && { label: 'Show folder', run: () => go(`folder:${id}`) },
    { label: 'New folder inside…', run: () => newFolder(id) },
    '-',
    editable && { label: 'Rename…', key: fromSidebar ? '' : 'E', run: () => renameItem(id) },
    editable && { label: 'Move to…', key: fromSidebar ? '' : 'M', run: () => pickFolder([id]) },
    '-',
    editable && { label: f.inArchive ? 'Unarchive' : 'Archive', key: fromSidebar ? '' : 'A', run: () => (f.inArchive ? opUnarchive([id]) : opArchive([id])) },
    editable && { label: 'Delete folder', key: fromSidebar ? '' : 'Del', danger: true, run: () => opDelete([id]) },
  ];
}

export function shelfMenu(id) {
  const m = S.m;
  const i = m.shelves.findIndex((s) => s.id === id);
  const s = m.shelves[i];
  if (!s) return [];
  const urls = s.items.map((x) => m.idx.entryById.get(x)?.node.url).filter(Boolean);
  return [
    !(S.route.kind === 'shelf' && S.route.id === id) && { label: 'Show shelf', key: i < 9 ? String(i + 1) : '', run: () => go(`shelf:${id}`) },
    urls.length && { label: `Open all ${urls.length}`, run: () => openEntries(s.items) },
    urls.length && { label: 'Open all in new window', run: () => openInWindow(urls) },
    '-',
    s.id !== m.defaultShelf && { label: 'Make default on this computer', run: () => withBusy(() => setDefaultShelf(id)) },
    { label: 'Rename…', run: () => renameShelfInline(id) },
    { label: s.scope === 'local' ? 'Share shelf…' : 'Make local copy…', run: () => changeShelfStorage(id) },
    m.shelves[i - 1]?.scope === s.scope && { label: 'Move up', run: () => withBusy(() => moveShelf(id, -1)) },
    m.shelves[i + 1]?.scope === s.scope && { label: 'Move down', run: () => withBusy(() => moveShelf(id, 1)) },
    '-',
    { label: 'New shelf…', run: () => newShelf() },
    { label: 'Delete shelf', danger: true, run: () => removeShelf(id) },
  ];
}

// Empty space in the list
export function listMenu() {
  const r = S.route;
  return [
    r.kind === 'folder' && { label: 'New folder…', run: () => newFolder(r.id) },
    r.kind === 'shelf' && { label: 'Rename shelf…', run: () => renameShelfInline(r.id) },
    S.rows.length && { label: 'Select all', key: 'Ctrl A', run: selectAll },
    '-',
    S.mode === 'tree' && { label: 'Expand all', run: expandAll },
    S.mode === 'tree' && { label: 'Collapse all', run: collapseAll },
  ];
}

export function showRowMenu(el, pos) {
  el?.classList.add('menu-open');
  openMenu(entryMenu(targets()), { ...pos, onClose: () => el?.classList.remove('menu-open') });
}
