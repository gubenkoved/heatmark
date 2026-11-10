// The detail pane: one bookmark, one folder, a selection, or a summary.

import { DAY } from '../lib/activity.js';
import { SPAN } from '../lib/model.js';
import { ago, barsSVG, esc, favHTML, fullDate, h, plural, shortDate, sparkSVG } from '../lib/ui.js';
import { E, KINDS, S, inFolder } from './state.js';

export const curRow = () => S.rows[S.rowIndex.get(S.cursor)];

export function targets() {
  if (S.selected.size) return [...S.selected].filter((id) => S.m.idx.byId.has(id));
  return S.cursor ? [S.cursor] : [];
}

export function renderDetail() {
  const m = S.m;
  // never replace the pane under the user's fingers while they edit a title or URL
  if (document.activeElement?.matches?.('.detail [data-edit]')) return;
  if (S.selected.size > 1) return (E.detail.innerHTML = multiDetail([...S.selected]));
  if (S.route.kind === 'activity') {
    const e = S.cursor && m.idx.entryById.get(S.cursor);
    E.detail.innerHTML = e ? entryDetail(e) : topDetail();
    return;
  }
  const r = curRow();
  if (r?.e) E.detail.innerHTML = entryDetail(r.e);
  else if (r?.f) E.detail.innerHTML = folderDetail(r.f);
  else if (S.route.kind === 'folder') E.detail.innerHTML = folderDetail(m.idx.folderById.get(S.route.id) || m.idx.folderById.get(m.idx.root.id), true);
  else E.detail.innerHTML = summaryDetail();
}

// The 90-day bar chart, or a plain line when there is nothing to draw.
const visitsChart = (days) => (days.some(Boolean) ? barsSVG(days, S.m.keys) : '<p class="d-none">No visits in the last 90 days.</p>');

const stat = (label, value, title = '') => `<div><dt>${label}</dt><dd title="${esc(title)}">${value}</dd></div>`;

function pathLinks(ancestors, includeSelf) {
  const m = S.m;
  const ids = ancestors.filter((id) => id !== m.idx.root.id);
  if (includeSelf) ids.push(includeSelf);
  return ids.map((id) => `<a href="#folder:${id}">${esc(m.idx.byId.get(id)?.title || '(untitled)')}</a>`).join('<span class="sep">/</span>');
}

function historyFor(id, norm) {
  return S.m.log.filter((l) => l.id === id || (norm && l.norm === norm)).slice(0, 40);
}

function histHTML(items) {
  if (!items.length) return '<p class="d-none">No changes recorded.</p>';
  return `<ul class="d-hist">${items.map((l) => {
    const [label, cls] = KINDS[l.kind] || [l.kind, ''];
    let what = '';
    if (l.from) what = `${esc((l.from || []).join(' / '))} → ${esc((l.path || []).join(' / '))}`;
    else if (l.kind === 'changed') what = esc(l.title || '');
    else if (l.shelf) what = esc(l.shelf);
    else what = esc((l.path || []).join(' / '));
    return `<li><span class="k k-${cls}">${label}</span><span class="d-hw">${what}${l.seeded ? ' <i title="Estimated from the date added, when Heatmark was installed">(estimated)</i>' : ''}</span><span class="d-ht" title="${esc(fullDate(l.t))}">${shortDate(l.t)}</span></li>`;
  }).join('')}</ul>`;
}

// Detail-pane buttons. Delete is a compact icon button, so a row of actions fits the pane.
function actionBar(items) {
  return `<div class="d-acts">${items.map(([act, label, key, cls = '']) => (act === 'delete'
    ? `<button class="btn danger icon-btn-d" data-act="delete" type="button" data-tip="${esc(label)} · ${key}" aria-label="${esc(label)}"><i class="ico-trash"></i></button>`
    : `<button class="btn ${cls}" data-act="${act}" type="button"${key ? ` data-tip="${esc(label)} · ${esc(key)}"` : ''}>${label}</button>`)).join('')}</div>`;
}

function entryDetail(e) {
  const m = S.m, n = e.node;
  const pins = new Set((m.pinnedIn.get(n.id) || []).map((s) => s.id));
  const dups = m.dupKey.has(n.id) ? m.idx.urls.filter((x) => x !== e && x.norm === e.norm) : [];
  return `<div class="d-head">${favHTML(n.url, 20)}<div class="d-hm">`
    + `<input class="d-title" data-edit="title" value="${esc(n.title)}" placeholder="(untitled)" spellcheck="false">`
    + `<input class="d-url" data-edit="url" value="${esc(n.url)}" spellcheck="false"></div></div>`
    + `<div class="d-path">${pathLinks(e.ancestors.slice(1)) || '—'}</div>`
    + actionBar([
      ['open', 'Open', '↵', 'primary'],
      ['pin', pins.has(m.defaultShelf) ? 'Unpin' : 'Pin', 'P'],
      ['move', 'Move', 'M'],
      [e.inArchive ? 'unarchive' : 'archive', e.inArchive ? 'Unarchive' : 'Archive', 'A'],
      ['delete', 'Delete', 'Del'],
    ])
    + `<dl class="d-stats">`
    + stat('Visits · 30d', e.v30)
    + stat('Visits · 90d', e.v90)
    + stat('All-time visits', e.total, 'Every visit recorded: Chrome history plus what Heatmark has kept')
    + stat('Last visit', e.last ? ago(e.last, m.now) : '—', e.last ? fullDate(e.last) : 'No recorded visit')
    + stat('Added', shortDate(e.added), fullDate(e.added))
    + `</dl>`
    + `<div class="d-sec">Visits <span>last 90 days</span></div>${visitsChart(e.days)}`
    + `<div class="d-sec">Shelves <span>click to toggle</span></div><div class="d-shelves">`
    + m.shelves.map((s) => `<button class="shelf-tog${pins.has(s.id) ? ' on' : ''}" data-shelf-tog="${s.id}" type="button">${esc(s.name)}</button>`).join('')
    + `<button class="shelf-tog add" data-act="new-shelf-pin" type="button">+ new</button></div>`
    + (dups.length ? `<div class="d-sec">Duplicates <span>${dups.length}</span></div><ul class="d-list">${dups.map((x) =>
      `<li data-reveal="${x.node.id}">${favHTML(x.node.url)}<span class="t">${esc(x.node.title || x.durl)}</span><span class="d-lm">${esc(x.pathStr)}</span></li>`).join('')}</ul>` : '')
    + `<div class="d-sec">History</div>${histHTML(historyFor(n.id, e.norm))}`;
}

// Duplicates share one visit record; list each URL once (first occurrence wins).
function uniqueByUrl(entries) {
  const seen = new Set();
  return entries.filter((e) => !seen.has(e.norm) && seen.add(e.norm));
}

function topList(entries, metric) {
  const m = S.m;
  return `<ul class="d-list">${entries.map((e) =>
    `<li data-reveal="${e.node.id}">${favHTML(e.node.url)}<span class="t">${esc(e.node.title || e.durl)}</span>${e.v90 ? sparkSVG(e.days, { w: 40, h: 12, bins: 20 }) : '<span class="d-nospark"></span>'}<span class="d-lm">${metric(e, m)}</span></li>`).join('')}</ul>`;
}

function folderDetail(f, isView = false) {
  const m = S.m, a = f.agg;
  const inside = m.idx.urls.filter((e) => inFolder(e, f));
  const top = uniqueByUrl(inside.filter((e) => e.v30).sort((x, y) => y.v30 - x.v30)).slice(0, 8);
  const stale = inside.filter((e) => !e.inArchive && (!e.last || m.now - e.last > 182 * DAY)).length;
  const subs = m.idx.folders.filter((x) => x.ancestors.includes(f.node.id)).length;
  const editable = f.depth >= 2;
  return `<div class="d-head"><span class="ico-folder big"></span><div class="d-hm">`
    + (editable ? `<input class="d-title" data-edit="title" value="${esc(f.node.title)}" spellcheck="false">` : `<div class="d-title ro">${esc(f.node.title || 'All bookmarks')}</div>`)
    + `<div class="d-path">${pathLinks(f.ancestors.slice(1)) || '&nbsp;'}</div></div></div>`
    + (editable ? actionBar([
      ...(isView ? [] : [['go', 'Open folder', '↵', 'primary']]),
      ['move', 'Move', 'M'], [f.inArchive ? 'unarchive' : 'archive', f.inArchive ? 'Unarchive' : 'Archive', 'A'], ['delete', 'Delete', 'Del'],
    ]) : '')
    + `<dl class="d-stats">`
    + stat('Bookmarks', a.count) + stat('Folders', subs) + stat('Visits · 30d', a.v30) + stat('Visits · 90d', a.v90)
    + stat('Last visit', a.last ? ago(a.last, m.now) : '—', fullDate(a.last))
    + `</dl>`
    + `<div class="d-sec">Visits <span>last 90 days</span></div>${visitsChart(a.days)}`
    + (top.length ? `<div class="d-sec">Most visited <span>30 days</span></div>${topList(top, (e) => e.v30)}` : '')
    + (stale ? `<div class="d-sec">Cleanup</div><p class="d-p"><a href="#" data-filter="visited:>6mo">${plural(stale, 'bookmark')} not visited in 6 months</a></p>` : '');
}

function multiDetail(ids) {
  const m = S.m;
  const es = ids.map((id) => m.idx.entryById.get(id)).filter(Boolean);
  const fs = ids.filter((id) => m.idx.folderById.has(id));
  const days = new Array(SPAN).fill(0);
  for (const e of es) for (let i = 0; i < SPAN; i++) days[i] += e.days[i];
  const allArch = es.length && es.every((e) => e.inArchive);
  return `<div class="d-head"><div class="d-hm"><div class="d-title ro">${ids.length} selected</div>`
    + `<div class="d-path">${plural(es.length, 'bookmark')}${fs.length ? ` · ${plural(fs.length, 'folder')}` : ''}</div></div></div>`
    + actionBar([
      ...(es.length ? [['open', `Open ${es.length}`, '↵', 'primary'], ['pin', 'Pin', 'P']] : []),
      ['move', 'Move', 'M'], [allArch ? 'unarchive' : 'archive', allArch ? 'Unarchive' : 'Archive', 'A'], ['delete', 'Delete', 'Del'],
    ])
    + `<dl class="d-stats">${stat('Visits · 30d', es.reduce((s, e) => s + e.v30, 0))}${stat('Visits · 90d', es.reduce((s, e) => s + e.v90, 0))}${stat('Never visited', es.filter((e) => !e.last).length)}</dl>`
    + `<div class="d-sec">Visits <span>last 90 days</span></div>${visitsChart(days)}`
    + `<div class="d-sec">Selection</div>${topList(es.slice(0, 30), (e) => ago(e.last, m.now) || '—')}`;
}

function topDetail() {
  const m = S.m;
  const top = uniqueByUrl(m.idx.urls.filter((e) => e.v30 && !e.inArchive).sort((a, b) => b.v30 - a.v30)).slice(0, 20);
  const neglected = m.shelves.flatMap((s) => s.items).map((id) => m.idx.entryById.get(id))
    .filter((e) => e && (!e.last || m.now - e.last > 30 * DAY));
  return `<div class="d-head"><div class="d-hm"><div class="d-title ro">Most visited</div><div class="d-path">last 30 days</div></div></div>`
    + (top.length ? topList(top, (e) => e.v30) : '<p class="d-none">No visits recorded yet.</p>')
    + (neglected.length ? `<div class="d-sec">Pinned but unused <span>30 days</span></div>${topList(neglected, (e) => ago(e.last, m.now) || '—')}` : '');
}

function summaryDetail() {
  const links = S.rows.filter((r) => r.e).map((r) => r.e);
  if (!links.length) return '<p class="d-none">Select a row to see details.</p>';
  const days = new Array(SPAN).fill(0);
  for (const e of links) for (let i = 0; i < SPAN; i++) days[i] += e.days[i];
  return `<div class="d-head"><div class="d-hm"><div class="d-title ro">${plural(links.length, 'bookmark')}</div><div class="d-path">in this view</div></div></div>`
    + `<div class="d-sec">Visits <span>last 90 days</span></div>${visitsChart(days)}`
    + `<p class="d-p">Select a row with <kbd>↑</kbd><kbd>↓</kbd> or click.</p>`;
}
