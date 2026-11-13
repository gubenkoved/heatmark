// In-page mock of the chrome.* APIs Heatmark uses, backed by localStorage.
// Loaded only by dev/serve.py; never shipped in the extension.
(() => {
  // dev/serve.py injects window.__BK_FIXTURE = { tree, visits } before this script: the demo
  // collection (dev/demo-data.js) or, with --real, a read-only snapshot of a Chrome profile.
  // Each kind keeps its state under its own localStorage prefix.
  const FX = window.__BK_FIXTURE;
  if (!FX) throw new Error('mock-chrome: no fixture injected');
  const P = FX.real ? 'real:' : 'mock:';
  const LS_TREE = P + 'tree', LS_STORE = P + 'storage', LS_NEXT = P + 'next', LS_INST = P + 'installed';
  const clone = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));

  function event() {
    const ls = new Set();
    return {
      addListener: (f) => ls.add(f), removeListener: (f) => ls.delete(f), hasListener: (f) => ls.has(f), _all: () => [...ls],
      _fire: (...a) => ls.forEach((f) => setTimeout(() => f(...clone(a)))),
    };
  }

  let tree = JSON.parse(localStorage.getItem(LS_TREE) || 'null');
  if (!tree) {
    tree = FX.tree;
    let max = 0;
    (function w(n) { max = Math.max(max, +n.id || 0); (n.children || []).forEach(w); })(tree);
    localStorage.setItem(LS_NEXT, String(max + 1));
    localStorage.setItem(LS_TREE, JSON.stringify(tree));
  }
  const saveTree = () => localStorage.setItem(LS_TREE, JSON.stringify(tree));
  const nextId = () => { const n = Number(localStorage.getItem(LS_NEXT) || 100000); localStorage.setItem(LS_NEXT, String(n + 1)); return String(n); };
  const map = () => { const m = new Map(); (function w(n) { m.set(n.id, n); (n.children || []).forEach(w); })(tree); return m; };
  const strip = (n) => { const c = clone(n); delete c.children; return c; };
  const reindex = (p) => p.children.forEach((c, i) => { c.index = i; c.parentId = p.id; });
  const need = (m, id) => { const n = m.get(id); if (!n) throw new Error("Can't find bookmark for id."); return n; };

  const bookmarks = {
    onCreated: event(), onRemoved: event(), onChanged: event(), onMoved: event(),
    onChildrenReordered: event(), onImportBegan: event(), onImportEnded: event(),
    async getTree() { return [clone(tree)]; },
    async get(ids) { const m = map(); return [].concat(ids).map((id) => strip(need(m, id))); },
    async getChildren(id) { return (need(map(), id).children || []).map(strip); },
    async search(q) {
      const out = [];
      for (const n of map().values()) {
        if (!n.url) continue;
        if (typeof q === 'object' && q.url) { if (n.url === q.url) out.push(strip(n)); continue; }
        const s = (typeof q === 'string' ? q : q.query || '').toLowerCase();
        if ((n.title + ' ' + n.url).toLowerCase().includes(s)) out.push(strip(n));
      }
      return out;
    },
    async create({ parentId = '2', title = '', url, index }) {
      const p = need(map(), parentId);
      const n = { id: nextId(), title, dateAdded: Date.now() };
      if (url) n.url = url; else n.children = [];
      const i = index ?? p.children.length;
      if (i > p.children.length) throw new Error('Index out of bounds.');
      p.children.splice(i, 0, n); reindex(p); saveTree();
      bookmarks.onCreated._fire(n.id, strip(n));
      return strip(n);
    },
    async move(id, { parentId, index }) {
      const m = map(); const n = need(m, id); const old = need(m, n.parentId); const p = need(m, parentId ?? n.parentId);
      const oldIndex = old.children.indexOf(n);
      old.children.splice(oldIndex, 1); reindex(old);
      const i = Math.min(index ?? p.children.length, p.children.length);
      p.children.splice(i, 0, n); reindex(p); saveTree();
      bookmarks.onMoved._fire(id, { parentId: p.id, index: i, oldParentId: old.id, oldIndex });
      return strip(n);
    },
    async update(id, changes) {
      const n = need(map(), id); const info = {};
      if (changes.title != null) n.title = info.title = changes.title;
      if (changes.url != null && n.url) n.url = info.url = changes.url;
      saveTree(); bookmarks.onChanged._fire(id, info);
      return strip(n);
    },
    async remove(id) {
      const n = need(map(), id);
      if (n.children?.length) throw new Error("Can't remove non-empty folder (use recursive to force).");
      return bookmarks.removeTree(id);
    },
    async removeTree(id) {
      const m = map(); const n = need(m, id); const p = need(m, n.parentId);
      const index = p.children.indexOf(n);
      p.children.splice(index, 1); reindex(p); saveTree();
      bookmarks.onRemoved._fire(id, { parentId: p.id, index, node: clone(n) });
    },
  };

  const onStorageChanged = event();
  function storageArea(area, key) {
    let store = JSON.parse(localStorage.getItem(key) || '{}');
    const persist = () => localStorage.setItem(key, JSON.stringify(store));
    return {
      async get(keys) {
        if (keys == null) return clone(store);
        if (typeof keys === 'string') keys = [keys];
        const out = {};
        if (Array.isArray(keys)) { for (const k of keys) if (k in store) out[k] = clone(store[k]); }
        else for (const [k, d] of Object.entries(keys)) out[k] = k in store ? clone(store[k]) : d;
        return out;
      },
      async set(obj) {
        const changes = {};
        for (const [k, v] of Object.entries(obj)) { changes[k] = { oldValue: store[k], newValue: v }; store[k] = clone(v); }
        persist(); onStorageChanged._fire(changes, area);
      },
      async remove(keys) {
        const changes = {};
        for (const k of [].concat(keys)) { changes[k] = { oldValue: store[k] }; delete store[k]; }
        persist(); onStorageChanged._fire(changes, area);
      },
      async clear() {
        const changes = Object.fromEntries(Object.keys(store).map((k) => [k, { oldValue: store[k] }]));
        store = {};
        persist(); onStorageChanged._fire(changes, area);
      },
    };
  }

  const opened = (window.__opened = []);
  const tabs = {
    async query() { return [{ id: 1, url: 'https://example.com/current-page', title: 'Example current page', active: true }]; },
    async getCurrent() { return { id: 1 }; },
    async create({ url }) { opened.push(url); console.log('[mock] tabs.create', url); return { id: 2, url }; },
    async update(id, { url }) { opened.push(url); console.log('[mock] tabs.update', url); return { id, url }; },
  };

  // history = the fixture's visits for bookmarked URLs
  const visitsByUrl = new Map(Object.entries(FX.visits));
  const history = {
    onVisited: event(), onVisitRemoved: event(),
    async search({ maxResults = 100 } = {}) {
      return [...visitsByUrl].slice(0, maxResults).map(([url, v]) => ({ url, title: url, visitCount: v.length, lastVisitTime: v[v.length - 1].visitTime }));
    },
    async getVisits({ url }) { return clone(visitsByUrl.get(url) || []); },
  };

  const onMessage = event();
  const runtime = {
    id: 'mock-extension',
    getURL: (p) => new URL(p.replace(/^\//, ''), location.origin + '/').href,
    onInstalled: event(), onStartup: event(), onMessage,
    sendMessage(msg) {
      return new Promise((resolve) => {
        let async = false;
        for (const f of onMessage._all()) if (f(clone(msg), {}, resolve) === true) async = true;
        if (!async) setTimeout(() => resolve(undefined));
      });
    },
  };

  const windows = {
    async create({ url }) { opened.push(...[].concat(url || [])); console.log('[mock] windows.create', url); return { id: 3 }; },
  };

  window.chrome = Object.assign(window.chrome || {}, {
    bookmarks, tabs, windows, runtime, history, storage: { local: storageArea('local', LS_STORE), sync: storageArea('sync', LS_STORE + ':sync'), onChanged: onStorageChanged },
  });

  window.addEventListener('load', () => {
    if (!localStorage.getItem(LS_INST)) { localStorage.setItem(LS_INST, '1'); runtime.onInstalled._fire({ reason: 'install' }); }
    else runtime.onStartup._fire();
  });
})();
