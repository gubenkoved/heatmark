// The Activity & log view: year heatmap, totals and the day-by-day timeline.

import { DAY, dayStart, lastDays } from '../lib/activity.js';
import { attachScrollbar } from '../lib/scrollbars.js';
import { debounce, esc, favHTML, fmtDay, fmtTime, h, shortDate } from '../lib/ui.js';
import { exportJSON, importJSON } from './ops.js';
import { E, KINDS, S } from './state.js';

let actBuilt = false;

const A = {};

function buildActivity() {
  actBuilt = true;
  A.heat = h('div', { class: 'heat', 'data-scroll': 'x' });
  A.heatNote = h('div', { class: 'heat-note' });
  A.kpis = h('div', { class: 'kpis' });
  A.kinds = h('div', { class: 'kinds' });
  A.q = h('input', {
    class: 'filter sm', type: 'text', placeholder: 'Search activity…', spellcheck: 'false',
    oninput: debounce((ev) => { S.actv.q = ev.target.value; S.actv.limit = 40; renderTimeline(); }, 150),
  });
  A.seeded = h('label', { class: 'chk' },
    h('input', { type: 'checkbox', checked: S.actv.seeded, onchange: (ev) => { S.actv.seeded = ev.target.checked; renderTimeline(); } }),
    'reconstructed adds');
  A.dayTag = h('div', { class: 'daytag' });
  A.tl = h('div', { class: 'tl' });
  E.activity.append(
    h('div', { class: 'act-top' }, h('div', { class: 'heat-wrap' }, A.heat, A.heatNote), A.kpis),
    h('div', { class: 'act-bar' }, A.kinds, A.q, A.seeded, h('span', { class: 'grow' }),
      h('span', { class: 'act-io' },
        h('button', { class: 'ghost sm', type: 'button', onclick: importJSON, 'data-tip': 'Merge an export from another install' }, 'Import JSON'),
        h('button', { class: 'ghost sm', type: 'button', onclick: exportJSON, 'data-tip': 'Save log, visit record and shelves to a file' }, 'Export JSON'))),
    A.dayTag, A.tl);
  attachScrollbar(A.heat, 'x');
}

function dayTotals() {
  const tot = new Map();
  for (const [k, list] of S.visitsByDay) tot.set(k, list.reduce((sum, v) => sum + v.n, 0));
  return tot;
}

function heatSVG(tot) {
  const m = S.m;
  const days = lastDays(371, m.now);
  const firstDow = (new Date(dayStart(days[0])).getDay() + 6) % 7; // Monday = 0
  const vals = [...tot.values()].filter(Boolean).sort((a, b) => a - b);
  const q = (p) => vals[Math.floor((vals.length - 1) * p)] || 1;
  const th = [q(0.25), q(0.5), q(0.75), q(0.92)];
  const level = (n) => (!n ? 0 : n <= th[0] ? 1 : n <= th[1] ? 2 : n <= th[2] ? 3 : 4);
  const c = 11, g = 2, top = 14, left = 26;
  let cells = '', months = '';
  const weekdays = [[0, 'Mon'], [2, 'Wed'], [4, 'Fri']]
    .map(([row, name]) => `<text x="0" y="${top + row * (c + g) + 9}" class="hm">${name}</text>`).join('');
  let lastMonth = -1;
  const firstData = m.meta.firstVisitDay;
  days.forEach((k, i) => {
    const p = i + firstDow;
    const col = Math.floor(p / 7), row = p % 7;
    const x = left + col * (c + g), y = top + row * (c + g);
    const n = tot.get(k) || 0;
    const na = !firstData || k < firstData;
    const sel = S.actv.day === k ? ' sel' : '';
    cells += `<rect class="hc l${na && !n ? 'na' : level(n)}${sel}" x="${x}" y="${y}" width="${c}" height="${c}" rx="2" data-day="${k}" data-tip="${fmtDay(dayStart(k))}\n${n ? `${n} visit${n === 1 ? '' : 's'}` : na ? 'before history starts' : 'no visits'}"></rect>`;
    const mo = +k.slice(5, 7);
    if (mo !== lastMonth && row === 0) {
      lastMonth = mo;
      months += `<text x="${x}" y="9" class="hm">${new Date(dayStart(k)).toLocaleDateString(undefined, { month: 'short' })}</text>`;
    }
  });
  const cols = Math.ceil((days.length + firstDow) / 7);
  const w = left + cols * (c + g);
  return `<svg class="heat-svg" width="${w}" height="${top + 7 * (c + g)}" viewBox="0 0 ${w} ${top + 7 * (c + g)}">${weekdays}${months}${cells}</svg>`;
}

export function renderActivity() {
  if (!actBuilt) buildActivity();
  const m = S.m;
  const tot = dayTotals();
  A.heat.innerHTML = heatSVG(tot);
  const note = m.meta.firstVisitDay
    ? `Visits to bookmarked pages per day. Records start ${shortDate(dayStart(m.meta.firstVisitDay))}; from now on every visit is kept.`
    : 'No visits found in Chrome history yet.';
  A.heatNote.innerHTML = `<span>${esc(note)}</span><span class="heat-legend" aria-hidden="true">Less`
    + [0, 1, 2, 3, 4].map((l) => `<i class="hl l${l}"></i>`).join('') + 'More</span>';
  if (!A.scrolled) { A.scrolled = true; A.heat.scrollLeft = A.heat.scrollWidth; } // newest weeks first, once
  const sumDays = (n) => lastDays(n, m.now).reduce((s, k) => s + (tot.get(k) || 0), 0);
  const since = m.now - 30 * DAY;
  const live = m.log.filter((l) => !l.seeded && l.t >= since);
  const kpi = (v, l) => `<div class="kpi"><b>${v}</b><span>${l}</span></div>`;
  A.kpis.innerHTML = kpi(sumDays(7), 'visits · 7d') + kpi(sumDays(30), 'visits · 30d')
    + kpi(m.idx.urls.filter((e) => e.v30).length, 'links used · 30d')
    + kpi(live.filter((l) => l.kind === 'created').length, 'added · 30d')
    + kpi(live.filter((l) => l.kind === 'removed').length, 'removed · 30d')
    + kpi(live.filter((l) => l.kind === 'archived').length, 'archived · 30d');
  A.kinds.innerHTML = '<span class="kinds-l">Show</span>' + Object.entries(KINDS).filter(([k]) => k !== 'unarchived' && k !== 'unpinned').map(([k, [label, cls]]) =>
    `<button class="kind k-${cls}${S.actv.kinds.has(k) ? ' on' : ''}" data-kind="${k}" type="button">${label}</button>`).join('');
  renderTimeline();
}

export function renderTimeline() {
  const m = S.m, V = S.actv;
  const tq = V.q.trim().toLowerCase();
  const hit = (hay) => !tq || hay.includes(tq);
  const kindOn = (l) => V.kinds.has(l.kind === 'unarchived' ? 'archived' : l.kind === 'unpinned' ? 'pinned' : l.kind);
  // filter the per-day index built in load(); only matching items are copied
  const days = new Map();
  for (const [k, list] of V.kinds.has('visit') ? S.visitsByDay : []) {
    const visits = list.filter((v) => hit(v.rec.hay)).map((v) => ({ e: v.rec.e, n: v.n, title: v.rec.title, url: v.rec.url }));
    if (visits.length) days.set(k, { visits, changes: [] });
  }
  for (const [k, list] of S.logByDay) {
    const changes = list.filter((l) => kindOn(l) && (!l.seeded || V.seeded) && hit(l.hay));
    if (!changes.length) continue;
    if (days.has(k)) days.get(k).changes = changes;
    else days.set(k, { visits: [], changes });
  }

  let keys = [...days.keys()].sort().reverse();
  if (V.day) keys = keys.filter((k) => k === V.day);
  A.dayTag.innerHTML = V.day ? `Showing ${fmtDay(dayStart(V.day))} <button class="ghost sm" data-act="clear-day" type="button">Show all days</button>` : '';
  const shown = keys.slice(0, V.limit);

  let html = '';
  for (const k of shown) {
    const d = days.get(k);
    d.visits.sort((a, b) => b.n - a.n);
    const nv = d.visits.reduce((s, v) => s + v.n, 0);
    const add = d.changes.filter((l) => l.kind === 'created').length;
    const del = d.changes.filter((l) => l.kind === 'removed').length;
    const open = V.openDays.has(k);
    const vis = open ? d.visits : d.visits.slice(0, 24);
    html += `<section class="day"><header><span class="dn">${fmtDay(dayStart(k))}</span><span class="ds">`
      + (nv ? `<span>${nv} visit${nv === 1 ? '' : 's'} · ${d.visits.length} link${d.visits.length === 1 ? '' : 's'}</span>` : '')
      + (add ? `<span class="k-add">+${add}</span>` : '') + (del ? `<span class="k-del">−${del}</span>` : '')
      + `</span></header>`;
    if (vis.length) {
      html += `<div class="vis">${vis.map((v) =>
        `<button class="vchip${v.e ? '' : ' gone'}" type="button" ${v.e ? `data-reveal="${v.e.node.id}"` : ''} title="${esc(v.url || '')}">${favHTML(v.url || '')}<span>${esc(v.title)}</span><b>${v.n}</b></button>`).join('')}`
        + (d.visits.length > vis.length ? `<button class="vchip more" data-openday="${k}" type="button">+${d.visits.length - vis.length} more</button>` : '')
        + `</div>`;
    }
    if (d.changes.length) {
      html += `<ul class="chg">${d.changes.map((l) => {
        const [label, cls] = KINDS[l.kind] || [l.kind, ''];
        const detail = l.from ? `${esc((l.from || []).join(' / ') || '—')} → ${esc((l.path || []).join(' / ') || '—')}`
          : `${esc((l.path || []).join(' / '))}${l.shelf ? ` · ${esc(l.shelf)}` : ''}${l.seeded ? ' · estimated from date added' : ''}`;
        const exists = l.id && m.idx.byId.has(l.id);
        const act = l.kind === 'removed' && l.node
          ? (l.restoredAt ? `<span class="ev-done">restored</span>` : `<button class="ghost sm" data-restore="${esc(l.key)}" type="button">Restore</button>`)
          : '';
        return `<li class="ev" ${exists ? `data-reveal="${l.id}"` : ''}><span class="ev-t">${fmtTime(l.t)}</span><span class="k k-${cls}">${label}</span>`
          + `<span class="ev-m">${l.url ? favHTML(l.url) : '<span class="ico-folder"></span>'}<span class="ev-title">${esc(l.title || l.url || '(untitled)')}</span>`
          + `${l.folder && l.count ? `<span class="tag">${l.count}</span>` : ''}<span class="ev-sub">${detail}</span></span>${act}</li>`;
      }).join('')}</ul>`;
    }
    html += `</section>`;
  }
  if (!shown.length) html = '<div class="empty">No activity matches.</div>';
  if (keys.length > shown.length) html += `<button class="ghost more" data-act="more-days" type="button">Show older (${keys.length - shown.length} more days)</button>`;
  A.tl.innerHTML = html;
}

// Move, archive, delete and pin show a toast with Undo; rename, URL edits and shelf deletion don't.
