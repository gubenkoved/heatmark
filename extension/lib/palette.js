// Command palette (Ctrl+K / Ctrl+P in the manager, and the whole toolbar popup).
//
// Modes:
//   search  — empty query: shelves, then recently visited; typing: fuzzy over bookmarks
//             (title, URL, folder) ranked by match quality + usage; also folders and commands.
//             A leading ">" searches commands only.
//   folder  — pick a destination folder (move)
//   shelf   — pick a shelf (pin to…), or create one from the query

import { fuzzy, highlight } from './fuzzy.js';
import { usageBoost } from './model.js';
import { shortPath } from './bm.js';
import { esc, favHTML, ago, h } from './ui.js';
import { attachScrollbar } from './scrollbars.js';

export function searchBookmarks(m, q, limit = 50) {
  const toks = q.toLowerCase().split(/\s+/).filter(Boolean);
  const out = [];
  for (const e of m.idx.urls) {
    const title = e.node.title || '';
    let score = 0;
    const tpos = new Set(), upos = new Set();
    let ok = true;
    for (const t of toks) {
      const a = fuzzy(t, title, e.lt), b = fuzzy(t, e.durl, e.ldurl), c = fuzzy(t, e.pathStr, e.lpath);
      const sa = a ? a.score : -Infinity, sb = b ? b.score * 0.8 : -Infinity, sc = c ? c.score * 0.5 : -Infinity;
      const best = Math.max(sa, sb, sc);
      if (best === -Infinity) { ok = false; break; }
      score += best;
      if (best === sa) a.pos.forEach((p) => tpos.add(p));
      else if (best === sb) b.pos.forEach((p) => upos.add(p));
    }
    if (!ok) continue;
    out.push({ e, score: score + usageBoost(e, m), tpos, upos });
  }
  out.sort((x, y) => y.score - x.score);
  return out.slice(0, limit);
}

function searchFolders(m, q, limit) {
  const out = [];
  for (const f of m.idx.folders) {
    if (f.depth === 0) continue;
    const r = q ? fuzzy(q, f.pathStr) : { score: 0, pos: [] };
    if (!r) continue;
    out.push({ f, score: r.score + Math.log2(1 + f.agg.v30) * 3 - (f.inArchive ? 20 : 0), pos: r.pos });
  }
  if (q) out.sort((a, b) => b.score - a.score);
  else out.sort((a, b) => a.f.pathStr.localeCompare(b.f.pathStr));
  return out.slice(0, limit);
}

export function createPalette({ inline = false, actions }) {
  const input = h('input', { class: 'pal-in', type: 'text', spellcheck: 'false', autocomplete: 'off', placeholder: '' });
  const mode = h('span', { class: 'pal-mode' });
  const list = h('div', { class: 'pal-list', role: 'listbox', 'data-scroll': '' });
  const foot = h('div', { class: 'pal-foot' });
  const box = h('div', { class: 'pal-box' }, h('div', { class: 'pal-head' }, mode, input), h('div', { class: 'pal-list-host' }, list), foot);
  const el = h('div', { class: inline ? 'pal pal-inline' : 'pal pal-overlay', hidden: !inline }, box);
  attachScrollbar(list);

  const S = { mode: 'search', items: [], sel: 0, onPick: null, open: inline };

  function bmItem(e, m, tpos, upos) {
    const pins = m.pinnedIn.get(e.node.id);
    return {
      type: 'bm', e,
      html: `${favHTML(e.node.url)}<span class="pi-main"><span class="pi-t">${highlight(e.node.title || e.durl, e.node.title ? tpos : upos)}</span><span class="pi-u">${e.node.title ? highlight(e.durl, upos) : ''}</span></span>`
        + `<span class="pi-path" title="${esc(e.pathStr)}">${esc(shortPath(e.path))}</span>`
        + `<span class="pi-n" title="visits in 30 days">${e.v30 || ''}</span><span class="pi-ago">${ago(e.last, m.now)}</span>`
        + `<span class="pi-pin">${pins ? '<i class="pin-dot" title="' + esc(pins.map((s) => s.name).join(', ')) + '"></i>' : ''}</span>`,
    };
  }

  function folderItem(r) {
    return {
      type: 'folder', f: r.f,
      html: `<span class="ico-folder"></span><span class="pi-main"><span class="pi-t">${highlight(r.f.pathStr, r.pos)}</span></span><span class="pi-path"></span><span class="pi-n">${r.f.agg.count}</span><span class="pi-ago">${ago(r.f.agg.last)}</span><span class="pi-pin"></span>`,
    };
  }

  function cmdItem(c, pos) {
    return {
      type: 'cmd', c,
      html: `<span class="ico-cmd">›</span><span class="pi-main"><span class="pi-t">${highlight(c.name, pos)}</span></span><span class="pi-path">${esc(c.hint || '')}</span><span class="pi-n"></span><span class="pi-ago"></span><span class="pi-pin"></span>`,
    };
  }

  function compute() {
    const m = actions.getModel();
    if (!m) return [];
    const raw = input.value;
    const q = raw.trim();
    const sections = [];

    if (S.mode === 'folder') {
      sections.push({ title: q ? 'Folders' : 'All folders', items: searchFolders(m, q, 200).filter((r) => !r.f.isRoot || r.f.depth === 1).map(folderItem) });
    } else if (S.mode === 'shelf') {
      const items = m.shelves
        .map((s) => ({ s, r: q ? fuzzy(q, s.name) : { score: 0, pos: [] } }))
        .filter((x) => x.r)
        .map(({ s, r }) => ({
          type: 'shelf', s,
          html: `<span class="ico-shelf"></span><span class="pi-main"><span class="pi-t">${highlight(s.name, r.pos)}</span></span><span class="pi-path">${s.id === m.defaultShelf ? 'default' : ''}</span><span class="pi-n">${s.items.length}</span><span class="pi-ago"></span><span class="pi-pin"></span>`,
        }));
      if (q && !m.shelves.some((s) => s.name.toLowerCase() === q.toLowerCase())) {
        items.push({ type: 'shelf-new', name: q, html: `<span class="ico-cmd">+</span><span class="pi-main"><span class="pi-t">New shelf “${esc(q)}”</span></span><span class="pi-path"></span><span class="pi-n"></span><span class="pi-ago"></span><span class="pi-pin"></span>` });
      }
      sections.push({ title: 'Shelves', items });
    } else if (q.startsWith('>')) {
      const cq = q.slice(1).trim();
      sections.push({ title: 'Commands', items: matchCommands(cq, 50) });
    } else if (!q) {
      const shown = new Set();
      for (const s of m.shelves) {
        const es = s.items.map((id) => m.idx.entryById.get(id)).filter(Boolean);
        if (!es.length) continue;
        es.forEach((e) => shown.add(e.node.id));
        sections.push({ title: s.name, items: es.map((e) => bmItem(e, m)) });
      }
      const recent = m.idx.urls
        .filter((e) => e.last && !shown.has(e.node.id) && !e.inArchive)
        .sort((a, b) => b.last - a.last)
        .slice(0, 40);
      if (recent.length) sections.push({ title: 'Recent', items: recent.map((e) => bmItem(e, m)) });
      const cmds = (actions.commands?.() || []).filter((c) => c.showEmpty);
      if (cmds.length) sections.push({ title: 'Actions', items: cmds.map((c) => cmdItem(c)) });
    } else {
      const bms = searchBookmarks(m, q, 60);
      if (bms.length) sections.push({ title: 'Bookmarks', items: bms.map((r) => bmItem(r.e, m, r.tpos, r.upos)) });
      if (actions.reveal) {
        const fs = searchFolders(m, q, 5);
        if (fs.length) sections.push({ title: 'Folders', items: fs.map(folderItem) });
      }
      const cs = matchCommands(q, 4);
      if (cs.length) sections.push({ title: 'Commands', items: cs });
    }
    return sections;
  }

  function matchCommands(q, limit) {
    const cmds = actions.commands?.() || [];
    return cmds
      .map((c) => ({ c, r: q ? fuzzy(q, c.name) : { score: 0, pos: [] } }))
      .filter((x) => x.r)
      .sort((a, b) => b.r.score - a.r.score)
      .slice(0, limit)
      .map(({ c, r }) => cmdItem(c, r.pos));
  }

  function render() {
    const sections = compute();
    S.items = sections.flatMap((s) => s.items);
    S.sel = Math.min(S.sel, Math.max(0, S.items.length - 1));
    let i = 0, html = '';
    for (const s of sections) {
      html += `<div class="pal-sec">${esc(s.title)}<span>${s.items.length}</span></div>`;
      for (const it of s.items) {
        html += `<div class="pi${i === S.sel ? ' sel' : ''}" data-i="${i}" role="option">${it.html}</div>`;
        i++;
      }
    }
    if (!S.items.length) html = `<div class="pal-empty">${input.value.trim() ? 'No matches' : 'Nothing here yet'}</div>`;
    list.innerHTML = html;
    renderFoot();
  }

  function renderFoot() {
    const it = S.items[S.sel];
    const k = (key, label) => `<span><kbd>${key}</kbd>${label}</span>`;
    let parts;
    if (S.mode !== 'search') parts = [k('↵', 'choose'), k('esc', 'cancel')];
    else if (it?.type === 'bm') {
      parts = [k('↵', 'open'), k('Shift ↵', 'here'), k('Ctrl ↵', 'background'), k('Alt P', 'pin')];
      if (actions.reveal) parts.push(k('Alt ↵', 'reveal'));
    } else if (it?.type === 'folder') parts = [k('↵', 'go to folder')];
    else if (it?.type === 'cmd') parts = [k('↵', 'run')];
    else parts = [];
    parts.push(`<span class="pal-tip">${S.mode === 'search' ? 'type <kbd>></kbd> for commands' : ''}</span>`);
    if (actions.footerAction) parts.push(`<button class="pal-fa" type="button" data-fa>${esc(actions.footerAction.label)}<kbd>${esc(actions.footerAction.key)}</kbd></button>`);
    foot.innerHTML = parts.join('');
  }

  function markSel() {
    for (const n of list.querySelectorAll('.pi.sel')) n.classList.remove('sel');
    const n = list.querySelector(`.pi[data-i="${S.sel}"]`);
    if (n) { n.classList.add('sel'); n.scrollIntoView({ block: 'nearest' }); }
    renderFoot();
  }

  function move(d) {
    if (!S.items.length) return;
    S.sel = (S.sel + d + S.items.length) % S.items.length;
    markSel();
  }

  async function activate(it, ev = {}) {
    if (!it) return;
    if (S.mode === 'folder' && it.type === 'folder') { const cb = S.onPick; close(); return cb?.(it.f); }
    if (S.mode === 'shelf' && (it.type === 'shelf' || it.type === 'shelf-new')) {
      const cb = S.onPick; close(); return cb?.(it.type === 'shelf' ? it.s : { create: it.name });
    }
    if (it.type === 'bm') {
      if (ev.altKey && actions.reveal) { close(); return actions.reveal(it.e); }
      const how = ev.shiftKey ? 'here' : ev.ctrlKey || ev.metaKey ? 'background' : 'tab';
      if (how !== 'background' && !inline) close();
      return actions.open(it.e, how);
    }
    if (it.type === 'folder') { close(); return actions.reveal?.(it.f); }
    if (it.type === 'cmd') { if (!inline) close(); return it.c.run(); }
  }

  input.addEventListener('input', () => { S.sel = 0; render(); list.scrollTop = 0; });
  input.addEventListener('keydown', async (ev) => {
    const k = ev.key;
    if (k === 'ArrowDown' || (ev.ctrlKey && (k === 'n' || k === 'j'))) { ev.preventDefault(); move(1); }
    else if (k === 'ArrowUp' || (inline && ev.ctrlKey && k === 'p')) { ev.preventDefault(); move(-1); }
    else if (k === 'PageDown') { ev.preventDefault(); move(8); }
    else if (k === 'PageUp') { ev.preventDefault(); move(-8); }
    else if (k === 'Enter') { ev.preventDefault(); activate(S.items[S.sel], ev); }
    else if (actions.footerAction && ev.altKey && ev.code === actions.footerAction.code) { ev.preventDefault(); actions.footerAction.run(); }
    else if (ev.altKey && ev.code === 'KeyP') {
      ev.preventDefault();
      const it = S.items[S.sel];
      if (it?.type === 'bm') { await actions.togglePin(it.e); render(); }
    } else if (k === 'Escape') {
      ev.preventDefault();
      if (input.value) { input.value = ''; S.sel = 0; render(); }
      else if (inline) actions.onEscape?.();
      else close();
    } else if (!inline && ev.ctrlKey && (k === 'k' || k === 'p')) { ev.preventDefault(); close(); }
  });
  list.addEventListener('mousemove', (ev) => {
    const n = ev.target.closest('.pi');
    if (n && +n.dataset.i !== S.sel) { S.sel = +n.dataset.i; markSel(); }
  });
  list.addEventListener('mousedown', (ev) => { if (ev.button === 1) ev.preventDefault(); });
  list.addEventListener('click', (ev) => {
    const n = ev.target.closest('.pi');
    if (n) activate(S.items[+n.dataset.i], ev);
  });
  list.addEventListener('contextmenu', (ev) => {
    const n = ev.target.closest('.pi');
    if (!n || !actions.contextMenu) return;
    ev.preventDefault();
    S.sel = +n.dataset.i;
    markSel();
    actions.contextMenu(S.items[S.sel], ev);
  });
  list.addEventListener('auxclick', (ev) => {
    const n = ev.target.closest('.pi');
    if (n && ev.button === 1) activate(S.items[+n.dataset.i], { ctrlKey: true });
  });
  foot.addEventListener('click', (ev) => { if (ev.target.closest('[data-fa]')) actions.footerAction?.run(); });
  if (!inline) el.addEventListener('mousedown', (ev) => { if (ev.target === el) close(); });

  function open({ mode: md = 'search', title = '', placeholder, onPick, query = '' } = {}) {
    S.mode = md;
    S.onPick = onPick || null;
    S.sel = 0;
    mode.textContent = title;
    mode.hidden = !title;
    input.placeholder = placeholder || (md === 'folder' ? 'Folder…' : md === 'shelf' ? 'Shelf name…' : 'Search bookmarks, folders, commands…');
    input.value = query;
    el.hidden = false;
    S.open = true;
    render();
    list.scrollTop = 0;
    input.focus();
    input.select();
  }

  function close() {
    if (inline) { open(); return; }
    el.hidden = true;
    S.open = false;
    actions.onClose?.();
  }

  return { el, open, close, refresh: () => S.open && render(), isOpen: () => S.open, input };
}
