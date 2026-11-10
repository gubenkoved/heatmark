// Filter language for the manager's list. Free words must all appear in title/URL/folder.
//
//   in:work             folder path contains "work"
//   host:github         host contains "github"          (site: is an alias)
//   added:<2020         added before 2020                added:2024-03  added in March 2024
//   added:<30d          added within the last 30 days    added:>1y      added more than a year ago
//   visited:never       no recorded visit                visited:>6mo   not visited for 6 months (or never)
//   visits:>5           more than 5 recorded visits      visits:0
//   is:pinned is:dup is:archived is:unvisited is:new
//   -host:x             any term can be negated with a leading "-"

const DUR = { h: 36e5, d: 864e5, w: 6048e5, mo: 2630016e3, m: 2630016e3, y: 31557600e3 };

export const QUERY_HELP = [
  ['in:work', 'folder path contains'],
  ['host:github', 'domain contains'],
  ['added:<2020', 'added before 2020'],
  ['added:<30d', 'added in the last 30 days'],
  ['visited:never', 'no recorded visit'],
  ['visited:>6mo', 'no visit in 6 months'],
  ['visits:>5', 'recorded visits'],
  ['is:pinned', 'also dup, archived, unvisited, new'],
  ['-host:x', 'negate any term'],
];

export function parseQuery(q) {
  const terms = [];
  const words = [];
  for (const raw of String(q).match(/(?:[^\s"]+|"[^"]*")+/g) || []) {
    let t = raw, neg = false;
    if (t.length > 1 && t[0] === '-') { neg = true; t = t.slice(1); }
    const m = t.match(/^(in|host|site|url|title|added|visited|visits|is):(.*)$/i);
    const val = (s) => s.replace(/"/g, '').toLowerCase();
    if (m && m[2]) terms.push({ key: m[1].toLowerCase(), val: val(m[2]), neg });
    else words.push({ val: val(t), neg });
  }
  return { terms, words, empty: !terms.length && !words.length };
}

function parseWhen(v) {
  let m = v.match(/^(\d+(?:\.\d+)?)(h|d|w|mo|m|y)$/);
  if (m) return { rel: true, ms: parseFloat(m[1]) * DUR[m[2]] };
  m = v.match(/^(\d{4})(?:-(\d{1,2}))?(?:-(\d{1,2}))?$/);
  if (m) {
    const y = +m[1], mo = m[2] ? +m[2] - 1 : null, d = m[3] ? +m[3] : null;
    const start = new Date(y, mo ?? 0, d ?? 1).getTime();
    const end = d != null ? new Date(y, mo, d + 1).getTime() : mo != null ? new Date(y, mo + 1, 1).getTime() : new Date(y + 1, 0, 1).getTime();
    return { rel: false, start, end };
  }
  return null;
}

function matchTime(t, spec, now) {
  const op = spec[0] === '<' || spec[0] === '>' ? spec[0] : '=';
  const v = op === '=' ? spec : spec.slice(1);
  if (v === 'never') return !t;
  const w = parseWhen(v);
  if (!w) return true; // incomplete while typing: don't filter
  if (w.rel) {
    if (!t) return op === '>';
    const age = now - t;
    return op === '>' ? age > w.ms : age <= w.ms;
  }
  if (!t) return false;
  if (op === '<') return t < w.start;
  if (op === '>') return t >= w.start;
  return t >= w.start && t < w.end;
}

function matchNum(n, spec) {
  const m = spec.match(/^(<=|>=|<|>|=)?(\d+)$/);
  if (!m) return true;
  const v = +m[2];
  switch (m[1]) {
    case '<': return n < v;
    case '>': return n > v;
    case '<=': return n <= v;
    case '>=': return n >= v;
    default: return n === v;
  }
}

// ctx: { now, isPinned(id), isDup(id) }
export function matchEntry(e, q, ctx) {
  const n = e.node;
  for (const w of q.words) {
    const hit = `${n.title} ${e.durl} ${e.pathStr}`.toLowerCase().includes(w.val);
    if (hit === w.neg) return false;
  }
  for (const t of q.terms) {
    let ok = true;
    switch (t.key) {
      case 'in': ok = e.pathStr.toLowerCase().includes(t.val); break;
      case 'host': case 'site': ok = e.host.includes(t.val); break;
      case 'url': ok = n.url.toLowerCase().includes(t.val); break;
      case 'title': ok = (n.title || '').toLowerCase().includes(t.val); break;
      case 'added': ok = matchTime(e.added, t.val, ctx.now); break;
      case 'visited': ok = matchTime(e.last, t.val, ctx.now); break;
      case 'visits': ok = matchNum(e.total, t.val); break;
      case 'is':
        ok = {
          pinned: () => ctx.isPinned(n.id),
          dup: () => ctx.isDup(n.id), duplicate: () => ctx.isDup(n.id),
          archived: () => e.inArchive,
          unvisited: () => !e.last, never: () => !e.last,
          new: () => ctx.now - e.added < 30 * 864e5,
        }[t.val]?.() ?? true;
        break;
    }
    if (ok === t.neg) return false;
  }
  return true;
}

export function mentionsArchive(q) {
  return q.terms.some((t) => (t.key === 'is' && t.val === 'archived' && !t.neg) || (t.key === 'in' && 'archive'.startsWith(t.val) && !t.neg));
}
