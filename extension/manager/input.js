// Wiring: keyboard, mouse, drag and drop, help overlay and narrow-window panels.

import { atPointer, below, openMenu } from '../lib/menu.js';
import { QUERY_HELP, parseQuery } from '../lib/query.js';
import { attachScrollbar } from '../lib/scrollbars.js';
import { moveShelf, setDefaultShelf, setShelfItems } from '../lib/store.js';
import { debounce, esc, lsSet, openLink, toast } from '../lib/ui.js';
import { pal } from '../manager.js';
import { renderActivity, renderTimeline } from './activity.js';
import { curRow, renderDetail, targets } from './detail.js';
import {
  render, renderHead, renderList, renderSide, renderStatus, rowEl,
  setCursor, syncRowClasses, toggleFolder,
} from './list.js';
import { entryMenu, folderMenu, listMenu, shelfMenu, showRowMenu } from './menus.js';
import {
  newShelf, opArchive, opDelete, opMove, opPin, opUnarchive,
  openEntries, pickFolder, pickShelf, removeShelf, renameShelfInline, restoreFromLog,
  reveal,
} from './ops.js';
import { $, E, S, go, parseRoute, routeKey, syncNow, withBusy } from './state.js';

window.addEventListener('hashchange', () => {
  const r = parseRoute();
  if (routeKey(r) === routeKey(S.route)) return;
  S.route = r;
  S.sort = { key: 'manual', dir: -1 };
  S.selected.clear();
  S.cursor = null;
  S.anchor = null;
  if (S.q) { S.q = ''; S.pq = parseQuery(''); E.filter.value = ''; }
  render();
});

function renderHelp() {
  const keys = [
    ['Ctrl K · Ctrl P', 'Search everything (palette)'],
    ['Right-click · Shift F10', 'Actions for the row or the selection'],
    ['I', 'Show or hide the detail pane (narrow windows)'],
    ['↑ ↓ · j k', 'Move; Shift extends the selection'],
    ['← → · h l', 'Collapse / expand folder'],
    ['↵', 'Open (Shift: this tab, Ctrl: background); folder: expand'],
    ['x · Space', 'Select / deselect row'],
    ['Ctrl A', 'Select all rows'],
    ['P', 'Pin / unpin on the default shelf'],
    ['Shift P', 'Pin to a shelf… (or create one)'],
    ['M', 'Move to folder…'],
    ['A', 'Archive / unarchive'],
    ['Del · Backspace', 'Delete (undo in the toast)'],
    ['E · F2', 'Rename'],
    ['Alt ↑ ↓', 'Reorder inside a shelf'],
    ['1 – 9', 'Go to shelf'],
    ['G A · G L', 'Go to All bookmarks / Activity & log'],
    ['/', 'Filter the list'],
    ['Esc', 'Clear selection, then the filter'],
  ];
  E.help.innerHTML = `<div class="help-box"><div class="help-scroll" data-scroll><div class="help-cols"><div><h3>Keyboard</h3><dl>${keys.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl></div>`
    + `<div><h3>Filter syntax</h3><dl>${QUERY_HELP.map(([k, v]) => `<dt><code>${esc(k)}</code></dt><dd>${esc(v)}</dd>`).join('')}</dl>`
    + `<p class="help-p">Words match title, URL and folder. Combine freely: <code>in:work visited:&gt;6mo -is:pinned</code></p>`
    + `<h3>Drag &amp; drop</h3><p class="help-p">Drag rows onto a shelf to pin, onto a folder to move, or within a shelf to reorder. Dragging a link out to the tab strip opens it.</p></div></div>`
    + `<p class="help-close"><kbd>Esc</kbd> to close</p></div></div>`;
  attachScrollbar(E.help.querySelector('.help-scroll'));
}

export function toggleHelp(show = E.help.hidden) {
  if (show) renderHelp();
  E.help.hidden = !show;
}

$('kbtn').addEventListener('click', () => pal.open());

$('helpbtn').addEventListener('click', () => toggleHelp());

// Narrow windows: the sidebar and the detail pane become panels that slide over the list.
const togglePanel = (cls, on) => document.body.classList.toggle(cls, on);

$('sidebtn').addEventListener('click', () => togglePanel('show-side'));

$('detailbtn').addEventListener('click', () => togglePanel('show-detail'));

window.addEventListener('hashchange', () => togglePanel('show-side', false));

E.sync.addEventListener('click', () => syncNow());

E.help.addEventListener('mousedown', (ev) => { if (ev.target === E.help) toggleHelp(false); });

E.filter.addEventListener('input', debounce(() => {
  S.q = E.filter.value;
  S.pq = parseQuery(S.q);
  S.selected.clear();
  renderList();
  renderHead();
  renderDetail();
  renderStatus();
}, 100));

E.colhead.addEventListener('click', (ev) => {
  const b = ev.target.closest('[data-sort]');
  if (!b) return;
  const key = b.dataset.sort;
  const def = key === 'name' || key === 'path' ? 1 : -1;
  if (S.sort.key !== key) S.sort = { key, dir: def };
  else if (S.sort.dir === def) S.sort = { key, dir: -def };
  else S.sort = { key: 'manual', dir: -1 };
  render();
});

E.list.addEventListener('mousedown', (ev) => { if (ev.button === 1) ev.preventDefault(); });

E.list.addEventListener('click', (ev) => {
  const el = ev.target.closest('.row');
  if (!el) return;
  const r = S.rows[+el.dataset.i];
  if (ev.target.closest('[data-chev]')) { toggleFolder(r.id); return; }
  const ra = ev.target.closest('[data-ra]');
  if (ra) {
    if (ra.dataset.ra === 'open') openLink(r.e.node.url, ev.shiftKey ? 'here' : ev.ctrlKey || ev.metaKey ? 'background' : 'tab');
    else {
      if (!S.selected.has(r.id)) setCursor(r.id, { scroll: false });
      showRowMenu(el, below(ra));
    }
    return;
  }
  setCursor(r.id, { extend: ev.shiftKey, toggle: ev.ctrlKey || ev.metaKey, scroll: false });
  E.list.focus({ preventScroll: true });
});

E.list.addEventListener('dblclick', (ev) => {
  const el = ev.target.closest('.row');
  if (!el || ev.target.closest('[data-chev], [data-ra]')) return;
  const r = S.rows[+el.dataset.i];
  if (r.e) openLink(r.e.node.url, 'tab');
  else if (S.mode === 'tree') toggleFolder(r.id);
  else go(`folder:${r.id}`);
});

E.list.addEventListener('auxclick', (ev) => {
  const el = ev.target.closest('.row');
  if (el && ev.button === 1) { const r = S.rows[+el.dataset.i]; if (r.e) openLink(r.e.node.url, 'background'); }
});

E.side.addEventListener('click', async (ev) => {
  const st = ev.target.closest('[data-stog]');
  if (st && !st.classList.contains('none')) {
    ev.preventDefault();
    const id = st.dataset.stog;
    const isRoot = S.m.idx.folderById.get(id)?.depth === 1;
    if (isRoot) { S.sideClosed.has(id) ? S.sideClosed.delete(id) : S.sideClosed.add(id); lsSet('sideClosed', [...S.sideClosed]); }
    else { S.sideOpen.has(id) ? S.sideOpen.delete(id) : S.sideOpen.add(id); lsSet('sideOpen', [...S.sideOpen]); }
    renderSide();
    return;
  }
  const sec = ev.target.closest('[data-sec]');
  if (sec) {
    const k = sec.dataset.sec;
    S.sideClosed.has(k) ? S.sideClosed.delete(k) : S.sideClosed.add(k);
    lsSet('sideClosed', [...S.sideClosed]);
    renderSide();
    return;
  }
  if (ev.target.closest('[data-act="new-shelf"]')) newShelf();
});

E.side.addEventListener('dblclick', (ev) => {
  const a = ev.target.closest('[data-shelf]');
  if (a) { ev.preventDefault(); renameShelfInline(a.dataset.shelf); }
});

E.crumbs.addEventListener('click', (ev) => {
  const b = ev.target.closest('[data-act]');
  if (!b) return;
  const id = S.route.id;
  const s = S.m.shelves.find((x) => x.id === id);
  switch (b.dataset.act) {
    case 'shelf-default': withBusy(() => setDefaultShelf(id)); break;
    case 'shelf-rename': renameShelfInline(id); break;
    case 'shelf-up': withBusy(() => moveShelf(id, -1)); break;
    case 'shelf-down': withBusy(() => moveShelf(id, 1)); break;
    case 'shelf-delete': if (s) removeShelf(id); break;
  }
});

E.detail.addEventListener('click', (ev) => {
  const rv = ev.target.closest('[data-reveal]');
  if (rv) {
    if (S.route.kind === 'activity') { S.cursor = rv.dataset.reveal; renderDetail(); } else reveal(rv.dataset.reveal);
    return;
  }
  const fl = ev.target.closest('[data-filter]');
  if (fl) {
    ev.preventDefault();
    const r = curRow();
    if (r?.f && S.route.id !== r.f.node.id) go(`folder:${r.f.node.id}`);
    setTimeout(() => { E.filter.value = fl.dataset.filter; E.filter.dispatchEvent(new Event('input')); }, 0);
    return;
  }
  const tog = ev.target.closest('[data-shelf-tog]');
  if (tog) { opPin(S.cursor ? [S.cursor] : [], tog.dataset.shelfTog); return; }
  const b = ev.target.closest('[data-act]');
  if (b) runAction(b.dataset.act, ev);
});

E.detail.addEventListener('change', (ev) => {
  const inp = ev.target.closest('[data-edit]');
  if (!inp) return;
  const id = S.selected.size > 1 ? null : (S.cursor || (S.route.kind === 'folder' ? S.route.id : null));
  if (!id) return;
  const field = inp.dataset.edit;
  const value = inp.value.trim();
  if (field === 'url' && !/^[a-z][\w+.-]*:/i.test(value)) { toast('That does not look like a URL'); return; }
  withBusy(() => chrome.bookmarks.update(id, { [field]: value }));
});

E.detail.addEventListener('keydown', (ev) => {
  if (ev.target.matches('[data-edit]') && ev.key === 'Enter') { ev.target.blur(); E.list.focus(); }
});

E.activity.addEventListener('click', (ev) => {
  const kind = ev.target.closest('[data-kind]');
  if (kind) {
    const k = kind.dataset.kind;
    const V = S.actv;
    const group = k === 'archived' ? ['archived', 'unarchived'] : k === 'pinned' ? ['pinned', 'unpinned'] : [k];
    if (ev.altKey || ev.ctrlKey) { V.kinds = new Set(group); } else group.forEach((g) => (V.kinds.has(g) ? V.kinds.delete(g) : V.kinds.add(g)));
    lsSet('actKinds', [...V.kinds]);
    renderActivity();
    return;
  }
  const cell = ev.target.closest('[data-day]');
  if (cell) { S.actv.day = S.actv.day === cell.dataset.day ? null : cell.dataset.day; renderActivity(); return; }
  const od = ev.target.closest('[data-openday]');
  if (od) { S.actv.openDays.add(od.dataset.openday); renderTimeline(); return; }
  const rs = ev.target.closest('[data-restore]');
  if (rs) { restoreFromLog(rs.dataset.restore); return; }
  const b = ev.target.closest('[data-act]');
  if (b?.dataset.act === 'clear-day') { S.actv.day = null; renderActivity(); return; }
  if (b?.dataset.act === 'more-days') { S.actv.limit += 60; renderTimeline(); return; }
  const rv = ev.target.closest('[data-reveal]');
  if (rv) { S.cursor = rv.dataset.reveal; S.selected.clear(); renderDetail(); }
});

E.activity.addEventListener('dblclick', (ev) => {
  const rv = ev.target.closest('[data-reveal]');
  const e = rv && S.m.idx.entryById.get(rv.dataset.reveal);
  if (e) openLink(e.node.url, 'tab');
});

function runAction(act, ev = {}) {
  const ids = targets();
  const m = S.m;
  switch (act) {
    case 'open': {
      if (ids.length) openEntries(ids, ev.shiftKey ? 'here' : ev.ctrlKey ? 'background' : 'tab');
      break;
    }
    case 'go': if (S.cursor) go(`folder:${S.cursor}`); break;
    case 'pin': opPin(ids); break;
    case 'pin-to': pickShelf(ids); break;
    case 'new-shelf-pin': newShelf(ids.filter((id) => m.idx.entryById.has(id))); break;
    case 'move': pickFolder(ids.length ? ids : S.route.kind === 'folder' ? [S.route.id] : []); break;
    case 'archive': opArchive(ids.length ? ids : [S.route.id]); break;
    case 'unarchive': opUnarchive(ids.length ? ids : [S.route.id]); break;
    case 'delete': opDelete(ids.length ? ids : S.route.kind === 'folder' && m.idx.folderById.get(S.route.id)?.depth >= 2 ? [S.route.id] : []); break;
  }
}

// keyboard
let gPending = 0;

document.addEventListener('keydown', (ev) => {
  if (pal.isOpen()) return;
  const k = ev.key;
  const mod = ev.ctrlKey || ev.metaKey;
  if (mod && (k === 'k' || k === 'p')) { ev.preventDefault(); pal.open(); return; }
  if (!E.help.hidden) { if (k === 'Escape' || k === '?') { ev.preventDefault(); toggleHelp(false); } return; }
  const t = ev.target;
  if (t.matches('input, textarea, select')) {
    if (k === 'Escape') {
      if (t.matches('[data-edit]')) t.value = t.defaultValue; // Esc cancels the edit instead of saving it
      t.blur();
      E.list.focus();
    }
    if (t === E.filter && (k === 'ArrowDown' || k === 'Enter')) {
      ev.preventDefault();
      E.list.focus();
      if (!S.cursor && S.rows.length) setCursor(S.rows[0].id);
    }
    return;
  }
  if (k === '?') { ev.preventDefault(); toggleHelp(true); return; }
  if ((k === 'i' || k === 'I') && !mod) { ev.preventDefault(); togglePanel('show-detail'); return; }
  if (k === '/') { ev.preventDefault(); E.filter.focus(); E.filter.select(); return; }

  if (Date.now() - gPending < 800) {
    gPending = 0;
    if (k === 'a') { go(`folder:${S.m.idx.root.id}`); return; }
    if (k === 'l') { go('activity'); return; }
  }
  if (k === 'g' && !mod) { gPending = Date.now(); return; }
  if (/^[1-9]$/.test(k) && !mod && !ev.altKey) {
    const s = S.m.shelves[+k - 1];
    if (s) go(`shelf:${s.id}`);
    return;
  }
  if (S.route.kind === 'activity') return;

  const i = S.rowIndex.get(S.cursor) ?? -1;
  const r = S.rows[i];
  const moveTo = (j) => {
    if (!S.rows.length) return;
    j = Math.max(0, Math.min(S.rows.length - 1, j));
    setCursor(S.rows[j].id, { extend: ev.shiftKey });
  };

  if (ev.altKey && (k === 'ArrowUp' || k === 'ArrowDown') && S.route.kind === 'shelf' && S.sort.key === 'manual' && r) {
    ev.preventDefault();
    const shelf = S.m.shelves.find((s) => s.id === S.route.id);
    const items = [...shelf.items];
    const a = items.indexOf(r.id), b = a + (k === 'ArrowUp' ? -1 : 1);
    if (a < 0 || b < 0 || b >= items.length) return;
    [items[a], items[b]] = [items[b], items[a]];
    withBusy(() => setShelfItems(shelf.id, items));
    return;
  }

  switch (k) {
    case 'ArrowDown': case 'j': ev.preventDefault(); moveTo(i + 1); break;
    case 'ArrowUp': case 'k': ev.preventDefault(); moveTo(i < 0 ? 0 : i - 1); break;
    case 'PageDown': ev.preventDefault(); moveTo(i + 20); break;
    case 'PageUp': ev.preventDefault(); moveTo(i - 20); break;
    case 'Home': ev.preventDefault(); moveTo(0); break;
    case 'End': ev.preventDefault(); moveTo(S.rows.length - 1); break;
    case 'ArrowRight': case 'l':
      if (r?.folder && S.mode === 'tree') {
        ev.preventDefault();
        if (!r.open) toggleFolder(r.id, true);
        else if (S.rows[i + 1]?.depth > r.depth) moveTo(i + 1);
      }
      break;
    case 'ArrowLeft': case 'h':
      if (!r || S.mode !== 'tree') break;
      ev.preventDefault();
      if (r.folder && r.open) toggleFolder(r.id, false);
      else {
        for (let j = i - 1; j >= 0; j--) if (S.rows[j].depth < r.depth) { moveTo(j); break; }
      }
      break;
    case 'Enter':
      ev.preventDefault();
      if (S.selected.size > 1) { runAction('open', ev); break; }
      if (!r) break;
      if (r.e) openLink(r.e.node.url, ev.shiftKey ? 'here' : mod ? 'background' : 'tab');
      else if (S.mode === 'tree') toggleFolder(r.id);
      else go(`folder:${r.id}`);
      break;
    case ' ': case 'x':
      if (r) { ev.preventDefault(); setCursor(r.id, { toggle: true }); }
      break;
    case 'a':
      if (mod) { ev.preventDefault(); S.selected = new Set(S.rows.map((x) => x.id)); syncRowClasses(); renderDetail(); renderStatus(); break; }
      if (!targets().length) break;
      ev.preventDefault();
      {
        const ids = targets();
        const arch = ids.every((id) => S.m.idx.entryById.get(id)?.inArchive || S.m.idx.folderById.get(id)?.inArchive);
        arch ? opUnarchive(ids) : opArchive(ids);
      }
      break;
    case 'p': if (!mod) { ev.preventDefault(); opPin(targets()); } break;
    case 'P': ev.preventDefault(); pickShelf(targets()); break;
    case 'm': ev.preventDefault(); pickFolder(targets()); break;
    case 'Delete': case 'Backspace': ev.preventDefault(); opDelete(targets()); break;
    case 'e': case 'F2': {
      const inp = E.detail.querySelector('.d-title[data-edit]');
      if (inp) { ev.preventDefault(); inp.focus(); inp.select(); }
      break;
    }
    case 'ContextMenu': case 'F10': {
      if (k === 'F10' && !ev.shiftKey) break;
      ev.preventDefault();
      const el = rowEl(S.cursor);
      if (el) showRowMenu(el, below(el.querySelector('.t') || el));
      else openMenu(listMenu(), below(E.colhead));
      break;
    }
    case 'Escape':
      if (document.body.matches('.show-side, .show-detail')) { togglePanel('show-side', false); togglePanel('show-detail', false); }
      else if (S.selected.size) { S.selected.clear(); syncRowClasses(); renderDetail(); renderStatus(); }
      else if (S.q) { E.filter.value = ''; E.filter.dispatchEvent(new Event('input')); }
      break;
  }
});

// drag & drop: rows → shelves (pin), folders (move), shelf rows (reorder); links → tab strip
let dragIds = null;

E.list.addEventListener('dragstart', (ev) => {
  const el = ev.target.closest('.row');
  if (!el) return;
  const r = S.rows[+el.dataset.i];
  dragIds = S.selected.has(r.id) ? [...S.selected] : [r.id];
  ev.dataTransfer.effectAllowed = 'copyMove';
  if (r.e) {
    ev.dataTransfer.setData('text/uri-list', r.e.node.url);
    ev.dataTransfer.setData('text/plain', r.e.node.url);
  } else ev.dataTransfer.setData('text/plain', r.f.node.title);
  el.classList.add('dragging');
});

document.addEventListener('dragend', () => {
  dragIds = null;
  document.querySelectorAll('.dragging, .drop-into, .drop-before, .drop-after').forEach((n) => n.classList.remove('dragging', 'drop-into', 'drop-before', 'drop-after'));
});

function dropTarget(ev) {
  const sb = ev.target.closest('[data-drop]');
  if (sb) return { el: sb, kind: sb.dataset.drop.split(':')[0], id: sb.dataset.drop.split(':')[1] };
  const row = ev.target.closest('.row');
  if (!row) return null;
  const r = S.rows[+row.dataset.i];
  if (S.route.kind === 'shelf' && S.sort.key === 'manual' && r.e) return { el: row, kind: 'reorder', id: r.id };
  if (r.folder) return { el: row, kind: 'folder', id: r.id };
  return null;
}

for (const zone of [E.side, E.list]) {
  zone.addEventListener('dragover', (ev) => {
    if (!dragIds) return;
    const t = dropTarget(ev);
    document.querySelectorAll('.drop-into, .drop-before, .drop-after').forEach((n) => n.classList.remove('drop-into', 'drop-before', 'drop-after'));
    if (!t || dragIds.includes(t.id)) return;
    ev.preventDefault();
    if (t.kind === 'reorder') {
      const rc = t.el.getBoundingClientRect();
      t.el.classList.add(ev.clientY > rc.top + rc.height / 2 ? 'drop-after' : 'drop-before');
    } else t.el.classList.add('drop-into');
  });
  zone.addEventListener('drop', (ev) => {
    if (!dragIds) return;
    const t = dropTarget(ev);
    if (!t) return;
    ev.preventDefault();
    const ids = dragIds;
    const after = t.el.classList.contains('drop-after');
    if (t.kind === 'shelf') {
      const links = ids.filter((id) => S.m.idx.entryById.has(id));
      const shelf = S.m.shelves.find((s) => s.id === t.id);
      const missing = links.filter((id) => !shelf.items.includes(id));
      if (missing.length) opPin(missing, t.id);
    } else if (t.kind === 'folder') opMove(ids, t.id);
    else if (t.kind === 'reorder') {
      const shelf = S.m.shelves.find((s) => s.id === S.route.id);
      const moving = shelf.items.filter((id) => ids.includes(id));
      const rest = shelf.items.filter((id) => !ids.includes(id));
      let at = rest.indexOf(t.id);
      if (after) at++;
      rest.splice(at, 0, ...moving);
      withBusy(() => setShelfItems(shelf.id, rest));
    }
  });
}

// context menus everywhere; the browser's own menu only inside text fields
document.addEventListener('contextmenu', (ev) => {
  if (!ev.target.closest('input, textarea')) ev.preventDefault();
});

E.list.addEventListener('contextmenu', (ev) => {
  ev.preventDefault();
  const el = ev.target.closest('.row');
  if (!el) { openMenu(listMenu(), atPointer(ev)); return; }
  const r = S.rows[+el.dataset.i];
  if (!S.selected.has(r.id)) setCursor(r.id, { scroll: false });
  E.list.focus({ preventScroll: true });
  showRowMenu(el, atPointer(ev));
});

E.side.addEventListener('contextmenu', (ev) => {
  const shelf = ev.target.closest('[data-shelf]');
  const folder = ev.target.closest('.sb-f');
  if (shelf) openMenu(shelfMenu(shelf.dataset.shelf), atPointer(ev));
  else if (folder) openMenu(folderMenu(folder.dataset.drop.split(':')[1], { fromSidebar: true }), atPointer(ev));
  else if (ev.target.closest('[data-sec="shelves"]')) openMenu([{ label: 'New shelf…', run: () => newShelf() }], atPointer(ev));
});

for (const zone of [E.detail, E.activity]) {
  zone.addEventListener('contextmenu', (ev) => {
    const rv = ev.target.closest('[data-reveal]');
    if (rv && S.m.idx.byId.has(rv.dataset.reveal)) openMenu(entryMenu([rv.dataset.reveal]), atPointer(ev));
  });
}
