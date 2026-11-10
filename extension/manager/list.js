// The sidebar, the header, the bookmark table (tree and flat views) and the status bar.

import { dayKey } from '../lib/activity.js';
import { shortPath } from '../lib/bm.js';
import { matchEntry, mentionsArchive } from '../lib/query.js';
import { ago, esc, favHTML, fullDate, lsSet, plural, shortDate, sparkSVG } from '../lib/ui.js';
import { renderActivity } from './activity.js';
import { renderDetail } from './detail.js';
import { E, S, VIEWS, inFolder, isEmptyFolder, routeKey } from './state.js';

const METRIC = {
  name: (r) => (r.e ? r.e.lt : (r.f.node.title || '').toLowerCase()),
  path: (r) => (r.e ? r.e.lpath : r.f.parentPathStr.toLowerCase()),
  v30: (r) => (r.e ? r.e.v30 : r.f.agg.v30),
  last: (r) => (r.e ? r.e.last : r.f.agg.last),
  added: (r) => (r.e ? r.e.added : r.f.node.dateAdded) || 0,
};

function cmpRows(sort) {
  if (sort.key === 'dup') {
    return (a, b) => (S.m.dupKey.get(a.id) || '').localeCompare(S.m.dupKey.get(b.id) || '') || METRIC.added(a) - METRIC.added(b);
  }
  const f = METRIC[sort.key];
  return (a, b) => {
    const x = f(a), y = f(b);
    const c = x < y ? -1 : x > y ? 1 : 0;
    return c * sort.dir || METRIC.name(a).localeCompare(METRIC.name(b));
  };
}

const entryRow = (e, depth = 0) => ({ id: e.node.id, e, depth });

const folderRow = (f, depth = 0, open = false) => ({ id: f.node.id, f, folder: true, depth, open });

function treeRows(node) {
  const m = S.m;
  const out = [];
  const cmp = S.sort.key === 'manual' ? null : cmpRows(S.sort);
  (function walk(n, depth) {
    let folders = [], links = [];
    for (const c of n.children || []) {
      if (c.url) links.push(entryRow(m.idx.entryById.get(c.id), depth));
      else {
        const f = m.idx.folderById.get(c.id);
        if (f.depth === 1 && f.childCount === 0) continue; // hide empty permanent roots
        folders.push(folderRow(f, depth, S.expanded.has(c.id)));
      }
    }
    let kids;
    if (cmp) kids = [...folders.sort(cmp), ...links.sort(cmp)];
    else {
      const order = new Map((n.children || []).map((c, i) => [c.id, i]));
      kids = [...folders, ...links].sort((a, b) => order.get(a.id) - order.get(b.id));
    }
    for (const r of kids) {
      out.push(r);
      if (r.folder && r.open) walk(r.f.node, depth + 1);
    }
  })(node, 0);
  return out;
}

function buildRows() {
  const m = S.m, r = S.route, pq = S.pq;
  const ctx = { now: m.now, isPinned: m.isPinned, isDup: m.isDup };
  const showArch = mentionsArchive(pq);
  const keep = (e) => matchEntry(e, pq, ctx);
  const sortOr = (rows, def) => rows.sort(cmpRows(S.sort.key === 'manual' ? def : S.sort));

  if (r.kind === 'folder') {
    const f = m.idx.folderById.get(r.id) || m.idx.folderById.get(m.idx.root.id);
    if (pq.empty) return { mode: 'tree', rows: treeRows(f.node), folder: f };
    const rows = m.idx.urls
      .filter((e) => inFolder(e, f) && (showArch || f.inArchive || !e.inArchive) && keep(e))
      .map((e) => entryRow(e));
    return { mode: 'flat', rows: sortOr(rows, { key: 'last', dir: -1 }), folder: f };
  }
  if (r.kind === 'shelf') {
    const shelf = m.shelves.find((s) => s.id === r.id);
    if (!shelf) return { mode: 'flat', rows: [] };
    const rows = shelf.items.map((id) => m.idx.entryById.get(id)).filter((e) => e && keep(e)).map((e) => entryRow(e));
    if (S.sort.key !== 'manual') rows.sort(cmpRows(S.sort));
    return { mode: 'flat', rows, shelf };
  }
  if (r.kind === 'view') {
    const v = VIEWS[r.id];
    if (v.folders) {
      const words = pq.words.map((w) => w.val);
      const rows = m.idx.folders
        .filter(isEmptyFolder)
        .filter((f) => words.every((w) => f.pathStr.toLowerCase().includes(w)))
        .map((f) => folderRow(f));
      return { mode: 'flat', rows: sortOr(rows, { key: 'path', dir: 1 }) };
    }
    const rows = m.idx.urls
      .filter((e) => (v.archive || showArch || !e.inArchive) && v.pred(e, m) && keep(e))
      .map((e) => entryRow(e));
    return { mode: 'flat', rows: sortOr(rows, v.sort) };
  }
  return { mode: 'flat', rows: [] };
}

export function render() {
  if (!S.m) return;
  renderSide();
  if (S.route.kind === 'activity') {
    E.list.parentElement.hidden = true;
    E.colhead.hidden = true;
    E.activity.parentElement.hidden = false;
    S.rows = [];
    S.rowIndex = new Map();
    renderActivity();
  } else {
    E.list.parentElement.hidden = false;
    E.colhead.hidden = false;
    E.activity.parentElement.hidden = true;
    renderList();
  }
  renderHead();
  renderDetail();
  renderStatus();
  renderSync();
}

export function renderSync() {
  if (E.sync.classList.contains('busy')) return;
  const t = S.m.meta.actSyncedAt;
  E.sync.textContent = t ? `History synced ${ago(t) === 'now' ? 'just now' : ago(t) + ' ago'}` : 'Sync history';
}

function count(pred) {
  let n = 0;
  for (const e of S.m.idx.urls) if (pred(e)) n++;
  return n;
}

export function renderSide() {
  const m = S.m, rk = routeKey(S.route);
  const on = (k) => (k === rk ? ' on' : '');
  const sec = (key, title, extra = '') =>
    `<div class="sb-sec"><button class="sb-h${S.sideClosed.has(key) ? ' closed' : ''}" data-sec="${key}" type="button">${title}</button>${extra}</div>`;
  let html = '';

  html += sec('shelves', 'Shelves', '<button class="sb-add" data-act="new-shelf" type="button" title="New shelf">+</button>');
  if (!S.sideClosed.has('shelves')) {
    m.shelves.forEach((s, i) => {
      const k = `shelf:${s.id}`;
      html += `<a class="sb-i${on(k)}" href="#${k}" data-drop="${k}" data-shelf="${s.id}"><span class="ico-shelf"></span><span class="sb-t">${esc(s.name)}</span>`
        + `${s.id === m.defaultShelf ? '<span class="sb-def" title="Default shelf: P pins here">P</span>' : ''}`
        + `${i < 9 ? `<span class="sb-key">${i + 1}</span>` : ''}<span class="sb-n">${s.items.length || ''}</span></a>`;
    });
  }

  html += sec('views', 'Views');
  if (!S.sideClosed.has('views')) {
    const live = (e) => !e.inArchive;
    const rootK = `folder:${m.idx.root.id}`;
    html += `<a class="sb-i${on(rootK)}" href="#${rootK}"><span class="ico-all"></span><span class="sb-t">All bookmarks</span><span class="sb-n">${count(live)}</span></a>`;
    html += `<a class="sb-i${on('activity')}" href="#activity"><span class="ico-act"></span><span class="sb-t">Activity &amp; log</span></a>`;
    for (const [id, v] of Object.entries(VIEWS)) {
      const k = `view:${id}`;
      const n = v.folders
        ? m.idx.folders.filter(isEmptyFolder).length
        : count((e) => (v.archive || live(e)) && v.pred(e, m));
      html += `<a class="sb-i${on(k)}" href="#${k}" title="${esc(v.hint)}"><span class="ico-view ico-${id}"></span><span class="sb-t">${v.name}</span><span class="sb-n">${n || ''}</span></a>`;
    }
  }

  html += sec('folders', 'Folders');
  if (!S.sideClosed.has('folders')) {
    const walk = (node, depth) => {
      for (const c of node.children || []) {
        if (c.url) continue;
        const f = m.idx.folderById.get(c.id);
        if (f.depth === 1 && f.childCount === 0) continue;
        const subs = (c.children || []).some((x) => !x.url);
        const open = depth === 0 ? !S.sideClosed.has(c.id) : S.sideOpen.has(c.id);
        const k = `folder:${c.id}`;
        html += `<a class="sb-i sb-f${on(k)}" href="#${k}" data-drop="${k}" style="--d:${depth}">`
          + `<span class="chev${subs ? (open ? ' open' : '') : ' none'}" data-stog="${c.id}"></span>`
          + `<span class="sb-t">${esc(c.title || '(untitled)')}</span>`
          + `${f.agg.v30 ? `<span class="sb-heat" style="--h:${Math.min(1, Math.log2(1 + f.agg.v30) / 7).toFixed(2)}" data-tip="${plural(f.agg.v30, 'visit')} in 30 days"></span>` : ''}`
          + `<span class="sb-n">${f.agg.count || ''}</span></a>`;
        if (subs && open) walk(c, depth + 1);
      }
    };
    walk(m.idx.root, 0);
  }
  const top = E.side.scrollTop;
  E.side.innerHTML = html;
  E.side.scrollTop = top;
}

export function renderHead() {
  const m = S.m, r = S.route;
  let crumbs = '', actions = '';
  if (r.kind === 'folder') {
    const f = m.idx.folderById.get(r.id) || m.idx.folderById.get(m.idx.root.id);
    const parts = [`<a href="#folder:${m.idx.root.id}">All bookmarks</a>`];
    for (const id of [...f.ancestors.slice(1), f.node.id]) {
      if (id === m.idx.root.id) continue;
      const n = m.idx.byId.get(id);
      parts.push(`<a href="#folder:${id}">${esc(n.title || '(untitled)')}</a>`);
    }
    crumbs = parts.join('<span class="sep">/</span>');
  } else if (r.kind === 'shelf') {
    const s = m.shelves.find((x) => x.id === r.id);
    crumbs = s ? `<span class="cr-t">${esc(s.name)}</span>` : 'Shelf not found';
    if (s) {
      actions = `<span class="cr-acts">`
        + (s.id === m.defaultShelf ? '<span class="cr-tag">default for P</span>' : `<button class="ghost sm" data-act="shelf-default" type="button">Make default</button>`)
        + `<button class="ghost sm" data-act="shelf-rename" type="button">Rename</button>`
        + `<button class="ghost sm" data-act="shelf-up" type="button" title="Move shelf up">↑</button>`
        + `<button class="ghost sm" data-act="shelf-down" type="button" title="Move shelf down">↓</button>`
        + `<button class="ghost sm danger" data-act="shelf-delete" type="button">Delete</button></span>`
        + `<span class="cr-hint">drag rows or Alt ↑↓ to reorder</span>`;
    }
  } else if (r.kind === 'view') {
    const v = VIEWS[r.id];
    crumbs = `<span class="cr-t">${v.name}</span><span class="cr-hint">${esc(v.hint)}</span>`;
  } else {
    crumbs = `<span class="cr-t">Activity &amp; log</span><span class="cr-hint">visits from Chrome history, every bookmark change</span>`;
  }
  E.crumbs.innerHTML = crumbs + actions;

  E.filter.parentElement.hidden = r.kind === 'activity';
}

// Views where every bookmark is unvisited by definition: the activity column would always be empty.
const noSpark = () => S.route.kind === 'view' && (S.route.id === 'unvisited' || S.route.id === 'stale' || S.route.id === 'empty');

function colheadHTML(mode) {
  const s = S.sort;
  const col = (key, label, cls) => {
    const isOn = s.key === key;
    return `<button class="ch ${cls}${isOn ? ' on' : ''}" data-sort="${key}" type="button">${label}${isOn ? (s.dir > 0 ? ' ↑' : ' ↓') : ''}</button>`;
  };
  return col('name', 'Name', 'c-name')
    + (mode === 'flat' ? col('path', 'Folder', 'c-path') : '')
    + (noSpark() ? '' : `<span class="ch c-spark" title="Daily visits, last 90 days">90 days</span>`)
    + col('v30', '30d', 'c-num')
    + col('last', 'Visited', 'c-date')
    + col('added', 'Added', 'c-date');
}

const RA_OPEN = '<button class="ra" data-ra="open" type="button" data-tip="Open in new tab"><i class="ico-open"></i></button>';

const RA_MENU = '<button class="ra" data-ra="menu" type="button" data-tip="More actions · Shift F10"><i class="ico-more"></i></button>';

const ROW_ACTS_LINK = `<span class="row-acts">${RA_OPEN}${RA_MENU}</span>`;

const ROW_ACTS_FOLDER = `<span class="row-acts">${RA_MENU}</span>`;

function rowHTML(r, i, mode) {
  const m = S.m;
  const cls = ['row'];
  if (r.folder) cls.push('is-folder');
  if (S.selected.has(r.id)) cls.push('sel');
  if (S.cursor === r.id) cls.push('cur');
  const parts = r.e ? r.e.path : r.f.path.slice(0, -1);
  const path = mode === 'flat' ? `<span class="c-path" title="${esc(parts.join(' / '))}">${esc(shortPath(parts))}</span>` : '';
  const spark = (days, any) => (noSpark() ? '' : `<span class="c-spark">${any ? sparkSVG(days) : ''}</span>`);
  if (r.folder) {
    const a = r.f.agg;
    return `<div class="${cls.join(' ')}" data-i="${i}" draggable="true" style="--d:${r.depth}">`
      + `<span class="c-name">${mode === 'tree' ? `<span class="chev${r.open ? ' open' : ''}" data-chev></span>` : ''}<span class="ico-folder"></span>`
      + `<span class="t">${esc(r.f.node.title || '(untitled)')}</span><span class="cnt">${a.count}</span>${ROW_ACTS_FOLDER}</span>${path}`
      + `${spark(a.days, a.v90)}<span class="c-num">${a.v30 || ''}</span>`
      + `<span class="c-date" title="${esc(fullDate(a.last))}">${ago(a.last, m.now)}</span>`
      + `<span class="c-date" title="${esc(fullDate(r.f.node.dateAdded))}">${ago(r.f.node.dateAdded, m.now)}</span></div>`;
  }
  const e = r.e, n = e.node;
  if (e.inArchive && !(S.route.kind === 'view' && S.route.id === 'archive') && !m.idx.folderById.get(S.route.id)?.inArchive) cls.push('dim');
  const pins = m.pinnedIn.get(n.id);
  return `<div class="${cls.join(' ')}" data-i="${i}" draggable="true" style="--d:${r.depth}">`
    + `<span class="c-name">${mode === 'tree' ? '<span class="chev none"></span>' : ''}${favHTML(n.url)}`
    + `<span class="t">${esc(n.title || e.durl)}</span><span class="u">${n.title ? esc(e.durl) : ''}</span>`
    + `${m.dupKey.has(n.id) ? '<span class="tag">dup</span>' : ''}`
    + `${pins ? `<i class="pin-dot" title="${esc(pins.map((s) => s.name).join(', '))}"></i>` : ''}${ROW_ACTS_LINK}</span>${path}`
    + `${spark(e.days, true)}<span class="c-num">${e.v30 || ''}</span>`
    + `<span class="c-date" title="${esc(e.last ? fullDate(e.last) : 'No recorded visit')}">${ago(e.last, m.now) || '<i class="never">—</i>'}</span>`
    + `<span class="c-date" title="${esc(fullDate(e.added))}">${ago(e.added, m.now)}</span></div>`;
}

export function renderList() {
  const { mode, rows } = buildRows();
  S.mode = mode;
  S.rows = rows;
  S.rowIndex = new Map(rows.map((r, i) => [r.id, i]));
  if (S.cursor && !S.rowIndex.has(S.cursor)) S.cursor = null;
  for (const el of [E.list, E.colhead]) {
    el.classList.toggle('flat', mode === 'flat');
    el.classList.toggle('nospark', noSpark());
  }
  E.colhead.innerHTML = colheadHTML(mode);
  if (!rows.length) {
    E.list.innerHTML = `<div class="empty">${S.q ? 'Nothing matches this filter.' : emptyText()}</div>`;
    return;
  }
  E.list.innerHTML = rows.map((r, i) => rowHTML(r, i, mode)).join('');
}

function emptyText() {
  const r = S.route;
  if (r.kind === 'shelf') return 'This shelf is empty. Select bookmarks and press <kbd>P</kbd>, or drag them onto the shelf in the sidebar.';
  if (r.kind === 'view' && r.id === 'archive') return 'Nothing archived yet. Select bookmarks and press <kbd>A</kbd>.';
  if (r.kind === 'view' && r.id === 'empty') return 'No empty folders.';
  return 'Nothing here.';
}

export function syncRowClasses() {
  for (const el of E.list.children) {
    const i = el.dataset.i;
    if (i == null) continue;
    const r = S.rows[+i];
    el.classList.toggle('cur', r.id === S.cursor);
    el.classList.toggle('sel', S.selected.has(r.id));
  }
}

export function rowEl(id) {
  const i = S.rowIndex.get(id);
  return i == null ? null : E.list.querySelector(`.row[data-i="${i}"]`);
}

export function setCursor(id, { extend = false, toggle = false, scroll = true } = {}) {
  if (id == null) return;
  // A plain move with nothing selected only touches two rows; skip the full pass over the list.
  if (!extend && !toggle && !S.selected.size) {
    const prev = S.cursor;
    S.cursor = id;
    S.anchor = id;
    rowEl(prev)?.classList.remove('cur');
    rowEl(id)?.classList.add('cur');
    if (scroll) rowEl(id)?.scrollIntoView({ block: 'nearest' });
    renderDetail();
    renderStatus();
    return;
  }
  if (extend && S.anchor != null && S.rowIndex.has(S.anchor)) {
    const a = S.rowIndex.get(S.anchor), b = S.rowIndex.get(id);
    S.selected = new Set(S.rows.slice(Math.min(a, b), Math.max(a, b) + 1).map((r) => r.id));
  } else if (toggle) {
    S.selected.has(id) ? S.selected.delete(id) : S.selected.add(id);
    S.anchor = id;
  } else {
    S.selected.clear();
    S.anchor = id;
  }
  S.cursor = id;
  syncRowClasses();
  if (scroll) rowEl(id)?.scrollIntoView({ block: 'nearest' });
  renderDetail();
  renderStatus();
}

const sinceText = (ms) => (!ms ? 'install' : dayKey(ms) === dayKey(Date.now()) ? 'today' : shortDate(ms));

export function renderStatus() {
  const k = (key, label) => `<span><kbd>${key}</kbd>${label}</span>`;
  let left;
  if (S.route.kind === 'activity') {
    left = `<span>${plural(S.m.log.filter((l) => !l.seeded).length, 'change')} logged since ${sinceText(S.m.meta.trackingSince)}</span>`;
  } else {
    const links = S.rows.filter((x) => x.e).map((x) => x.e);
    left = `<span>${plural(S.rows.length, S.rows.length && S.rows.every((x) => x.folder) ? 'folder' : 'row')}</span>`;
    if (S.mode === 'flat' && links.length) {
      left += `<span>${links.reduce((sum, e) => sum + e.v30, 0)} visits · 30d</span><span>${links.filter((e) => !e.last).length} never visited</span>`;
    }
    if (S.selected.size) left += `<span class="st-sel">${S.selected.size} selected</span>`;
  }
  E.status.innerHTML = `<div class="st-l">${left}</div><div class="st-r">`
    + k('↑↓', 'move') + k('Enter', 'open') + k('X', 'select') + k('P', 'pin') + k('M', 'move') + k('A', 'archive')
    + k('Del', 'delete') + k('Shift F10', 'actions') + k('/', 'filter') + k('Ctrl K', 'search') + k('?', 'all keys') + `</div>`;
}

export function toggleFolder(id, open) {
  const want = open ?? !S.expanded.has(id);
  want ? S.expanded.add(id) : S.expanded.delete(id);
  lsSet('expanded', [...S.expanded]);
  renderList();
  syncRowClasses();
}
