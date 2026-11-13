// Shared state of the manager page: DOM handles, routing, loading the model, busy/sync helpers.

import { DAY, dayKey, visitDays } from '../lib/activity.js';
import { displayUrl, normUrl } from '../lib/bm.js';
import { loadModel } from '../lib/model.js';
import { parseQuery } from '../lib/query.js';
import { syncHistory } from '../lib/store.js';
import { debounce, lsGet, toast } from '../lib/ui.js';
import { render } from './list.js';
import { reveal } from './ops.js';
import { renderSettings } from './settings.js';

export const $ = (id) => document.getElementById(id);

export const E = {
  side: $('side'), crumbs: $('crumbs'), filter: $('filter'), colhead: $('colhead'),
  list: $('list'), activity: $('activity'), detail: $('detail'), status: $('status'), sync: $('sync'), help: $('help'),
};

export const VIEWS = {
  recent: { name: 'Recent', hint: 'by last visit', pred: (e) => e.last, sort: { key: 'last', dir: -1 } },
  frequent: { name: 'Frequent', hint: 'most visits in 30 days', pred: (e) => e.v30 > 0, sort: { key: 'v30', dir: -1 } },
  new: { name: 'New', hint: 'added in the last 30 days', pred: (e, m) => m.now - e.added < 30 * DAY, sort: { key: 'added', dir: -1 } },
  unvisited: { name: 'Not visited', hint: 'no recorded visit', pred: (e) => !e.last, sort: { key: 'added', dir: 1 } },
  stale: { name: 'Stale', hint: 'no visit in 6 months', pred: (e, m) => !e.last || m.now - e.last > 182 * DAY, sort: { key: 'last', dir: 1 } },
  dups: { name: 'Duplicates', hint: 'same URL more than once', pred: (e, m) => m.dupKey.has(e.node.id), sort: { key: 'dup', dir: 1 } },
  empty: { name: 'Empty folders', hint: 'no bookmarks inside', folders: true },
  archive: { name: 'Archive', hint: 'archived bookmarks', pred: (e) => e.inArchive, sort: { key: 'added', dir: -1 }, archive: true },
};

export const KINDS = {
  visit: ['Visits', 'visit'],
  created: ['Added', 'add'],
  removed: ['Removed', 'del'],
  moved: ['Moved', 'move'],
  archived: ['Archived', 'arch'],
  unarchived: ['Unarchived', 'move'],
  changed: ['Edited', 'edit'],
  pinned: ['Pinned', 'pin'],
  unpinned: ['Unpinned', 'pin'],
};

export const S = {
  m: null,
  normToEntry: new Map(),
  route: parseRoute(),
  q: '',
  pq: parseQuery(''),
  expanded: new Set(lsGet('expanded', [])),
  sideOpen: new Set(lsGet('sideOpen', [])),
  sideClosed: new Set(lsGet('sideClosed', [])),
  sort: { key: 'manual', dir: -1 },
  mode: 'tree',
  rows: [],
  rowIndex: new Map(),
  cursor: null,
  anchor: null,
  selected: new Set(),
  busy: false,
  firstLoad: true,
  actv: {
    kinds: new Set(lsGet('actKinds', Object.keys(KINDS))),
    q: '', seeded: false, day: null, limit: 40, openDays: new Set(),
  },
};

export function parseRoute() {
  let hsh = '';
  try { hsh = decodeURIComponent(location.hash.slice(1)); } catch { /* malformed: fall back to the default view */ }
  const [kind, id] = hsh.split(':');
  if (kind === 'folder' && id) return { kind, id };
  if (kind === 'view' && VIEWS[id]) return { kind, id };
  if (kind === 'shelf' && id) return { kind, id };
  if (kind === 'activity') return { kind };
  if (kind === 'reveal' && id) return { kind: 'folder', id: null, reveal: id };
  return { kind: 'folder', id: null };
}

export function routeKey(r) {
  return r.kind === 'activity' ? 'activity' : `${r.kind}:${r.id ?? ''}`;
}

export function go(nav) {
  if (location.hash.slice(1) === nav) return;
  location.hash = nav;
}

export async function load() {
  S.m = await loadModel({ withLog: true });
  const m = S.m;
  S.normToEntry = new Map();
  for (const e of m.idx.urls) {
    const cur = S.normToEntry.get(e.norm);
    if (!cur || (cur.inArchive && !e.inArchive)) S.normToEntry.set(e.norm, e);
  }
  if (S.firstLoad) {
    S.firstLoad = false;
    if (!lsGet('expanded', null)) for (const c of m.idx.root.children) S.expanded.add(c.id);
    if (S.route.kind === 'folder' && !S.route.id) S.route.id = m.idx.root.id;
    const age = Date.now() - (m.meta.actSyncedAt || 0);
    if (age > 10 * 60e3) syncNow(true);
  }
  // indexes for the activity timeline and the detail pane's history
  S.logByDay = new Map();
  for (const l of m.log) {
    l.norm = l.url ? normUrl(l.url) : null;
    l.hay = [l.title, l.url, (l.path || []).join(' '), (l.from || []).join(' ')].filter(Boolean).join(' ').toLowerCase();
    const k = dayKey(l.t);
    if (!S.logByDay.has(k)) S.logByDay.set(k, []);
    S.logByDay.get(k).push(l);
  }
  S.visitsByDay = new Map();
  for (const [norm, a] of Object.entries(m.act)) {
    const e = S.normToEntry.get(norm);
    const title = e?.node.title || displayUrl(a.u || norm);
    const rec = { e, title, url: a.u, hay: `${title} ${a.u || ''} ${e?.pathStr || ''}`.toLowerCase() };
    for (const [k, n] of Object.entries(visitDays(a))) {
      if (!S.visitsByDay.has(k)) S.visitsByDay.set(k, []);
      S.visitsByDay.get(k).push({ rec, n });
    }
  }
  for (const id of [...S.selected]) if (!m.idx.byId.has(id)) S.selected.delete(id);
  const pendingReveal = S.route.reveal;
  if (pendingReveal) {
    delete S.route.reveal;
    history.replaceState(null, '', `#folder:${m.idx.root.id}`);
  }
  render();
  renderSettings();
  if (pendingReveal) reveal(pendingReveal, { inTree: true });
}

export const reload = debounce(() => { if (!S.busy) load(); }, 150);

// Visit counts change on every page visit in any tab; refresh those lazily.
export const reloadActivity = debounce(() => { if (!S.busy) load(); }, 2500);

export async function withBusy(fn) {
  S.busy = true;
  try { return await fn(); } catch (err) { console.error(err); toast(String(err.message || err)); } finally { S.busy = false; await load(); }
}

export async function syncNow(silent = false) {
  E.sync.textContent = 'Syncing history…';
  E.sync.classList.add('busy');
  try {
    const r = await syncHistory();
    if (!silent && r) toast(`History synced: ${r.matched} of ${r.bookmarked} bookmarked URLs have visits`);
  } catch (err) {
    console.error(err);
    if (!silent) toast('Could not sync history');
  } finally {
    E.sync.classList.remove('busy');
    reload();
  }
}

// A bookmark entry anywhere under folder f (the invisible root holds everything).
export const inFolder = (e, f) => f.depth === 0 || e.ancestors.includes(f.node.id);

// A user folder with no bookmarks anywhere inside it.
export const isEmptyFolder = (f) => !f.isRoot && !f.isArchive && f.agg.count === 0;
