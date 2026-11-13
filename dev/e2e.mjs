// End-to-end test: loads the unpacked extension into a throwaway Chromium profile and drives the
// real chrome.* APIs over the DevTools protocol. Never touches your real profile.
//
//   node dev/e2e.mjs <path-to-chromium> [extension-dir]      (or set CHROME=<path-to-chromium>)
//
// Branded Google Chrome ignores --load-extension; use Chromium or Chrome for Testing (e.g. the
// build Playwright installs under ~/.cache/ms-playwright/chromium-*/chrome-linux64/chrome).

import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, openPage, evaluate, sleep } from './cdp.mjs';

const CHROME = process.argv[2] || process.env.CHROME;
if (!CHROME) {
  console.error('usage: node dev/e2e.mjs <path-to-chromium> [extension-dir]');
  process.exit(2);
}
const EXT = resolve(process.argv[3] || fileURLToPath(new URL('../extension', import.meta.url)));
// An unpacked extension's id is derived from its path: sha256, first 32 hex digits mapped 0-f → a-p.
const EXT_ID = [...createHash('sha256').update(EXT).digest('hex').slice(0, 32)]
  .map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail });

// A local site to visit, so history-based activity is tested end to end.
const site = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(`<title>Page ${req.url}</title>ok`);
});

let cdp = null;
try {
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${site.address().port}`;
  const host = base.replace('http://', '');
  cdp = await launch(CHROME, [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`]);

  let worker = null;
  for (let i = 0; i < 50 && !worker; i++) {
    worker = (await cdp.targets()).find((t) => t.type === 'service_worker' && t.url === `chrome-extension://${EXT_ID}/background.js`);
    if (!worker) await sleep(200);
  }
  if (!worker) throw new Error(`the extension's service worker never started\n${cdp.stderr.slice(-2000)}`);

  const mgr = await openPage(cdp, `chrome-extension://${EXT_ID}/manager.html`);
  await sleep(1500);

  const ids = await evaluate(cdp, mgr, `
    const [root] = await chrome.bookmarks.getTree();
    const other = root.children.find((c) => c.folderType === 'other' || c.id === '2');
    const f = await chrome.bookmarks.create({ parentId: other.id, title: 'E2E folder' });
    await chrome.bookmarks.create({ parentId: f.id, title: 'Example A', url: '${base}/a' });
    await chrome.bookmarks.create({ parentId: f.id, title: 'Example B', url: '${base}/b' });
    await chrome.bookmarks.create({ parentId: f.id, title: 'Example C', url: 'https://example.com/c' });
    const order = await chrome.bookmarks.create({ parentId: other.id, title: 'Order' });
    for (const n of [1, 2, 3, 4, 5]) await chrome.bookmarks.create({ parentId: order.id, title: 'O' + n, url: 'https://example.com/o' + n });
    return { folder: f.id, order: order.id };
  `);

  // visit A twice and B once in a real tab
  const tab = await openPage(cdp, `${base}/a`);
  await sleep(700);
  await cdp.send('Page.navigate', { url: `${base}/b` }, tab);
  await sleep(700);
  await cdp.send('Page.navigate', { url: `${base}/a` }, tab);
  await sleep(3500); // live visits are recounted in a batch ~1.5 s after the last one

  const HELPERS = `
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const list = document.getElementById('list');
    const key = (k, o = {}, el = list) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, ...o }));
    const rowOf = (t) => [...document.querySelectorAll('.row')].find((r) => r.querySelector('.t')?.textContent === t);
    const visits = (suffix, act) => {
      const a = Object.entries(act || {}).find(([k]) => k.endsWith(suffix))?.[1];
      return a && Object.values(a.d).reduce((s, n) => s + n, 0);
    };
  `;

  const r = await evaluate(cdp, mgr, `${HELPERS}
    const before = (await chrome.storage.local.get('act')).act;
    const sync = (await chrome.runtime.sendMessage({ type: 'sync' }))?.value;
    const after = (await chrome.storage.local.get('act')).act;

    // deleting a page from Chrome history removes its stored visits
    await chrome.history.deleteUrl({ url: '${base}/b' });
    await sleep(1500);
    const afterDelete = (await chrome.storage.local.get('act')).act;

    key('k', { ctrlKey: true });
    const input = document.querySelector('.pal-in');
    input.value = 'exa a';
    input.dispatchEvent(new Event('input'));
    await sleep(50);
    const paletteTop = document.querySelector('.pi.sel .pi-t')?.textContent;
    key('Enter', { altKey: true }, input);
    await sleep(300);
    const revealed = document.querySelector('.row.cur .t')?.textContent;
    key('p');
    await sleep(900);
    const { shelves } = await chrome.storage.local.get('shelves');

    rowOf('Example B').click();
    key('a');
    await sleep(900);
    const archived = document.querySelector('a[href="#view:archive"] .sb-n').textContent;

    // right-click opens the app's context menu for the row
    const rowA = rowOf('Example A');
    const rect = rowA.getBoundingClientRect();
    const nativeMenu = rowA.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: rect.left + 30, clientY: rect.top + 5 }));
    const menuItems = [...document.querySelectorAll('.menu .menu-l')].map((x) => x.textContent);
    document.querySelector('.menu')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    // delete C, then Undo: restored, and its log entry marked restored
    rowOf('Example C').click();
    key('Delete');
    await sleep(900);
    document.querySelector('.toast-act').click();
    await sleep(1500);
    const undone = !!rowOf('Example C');
    const logC = Object.values(await chrome.storage.local.get(null)).find((e) => e?.kind === 'removed' && e.title === 'Example C');

    return {
      liveA: visits('/a', before), liveB: visits('/b', before), syncedA: visits('/a', after), sync,
      deletedB: visits('/b', afterDelete), keptA: visits('/a', afterDelete),
      paletteTop, revealed, pinned: shelves?.[0]?.items.length, archived, menuItems, nativeMenu,
      undone, undoMarked: !!logC?.restoredAt,
    };
  `);

  check('first run sets up tracking', await evaluate(cdp, mgr, `return !!(await chrome.storage.local.get('trackingSince')).trackingSince;`));
  check('live visits recorded from history', r.liveA === 2 && r.liveB === 1, `A=${r.liveA} B=${r.liveB}`);
  check('history re-sync is idempotent', r.syncedA === 2 && r.sync?.matched === 2, `A=${r.syncedA} matched=${r.sync?.matched}`);
  check('history deletion in Chrome is honored', r.deletedB === undefined && r.keptA === 2, `B=${r.deletedB} A=${r.keptA}`);
  check('palette fuzzy search ranks the match first', r.paletteTop === 'Example A', r.paletteTop);
  check('Alt+Enter reveals the item in the tree', r.revealed === 'Example A', r.revealed);
  check('P pins to the default shelf', r.pinned === 1, `items=${r.pinned}`);
  check('A archives', r.archived === '1', `archive count=${r.archived}`);
  check('right-click shows the app context menu', !r.nativeMenu && ['Open in new tab', 'Copy link', 'Move to…', 'Delete'].every((x) => r.menuItems.includes(x)), r.menuItems.join(', '));
  check('undo restores a deleted bookmark and marks the log entry', r.undone && r.undoMarked, `undone=${r.undone} marked=${r.undoMarked}`);

  // multi-item undo keeps the order; undoing a mixed pin only reverses what changed
  await evaluate(cdp, mgr, `location.hash = '#folder:${ids.order}'; return 1;`);
  await sleep(500);
  const o = await evaluate(cdp, mgr, `${HELPERS}
    const titles = async () => (await chrome.bookmarks.getChildren('${ids.order}')).map((n) => n.title).join(',');
    rowOf('O2').click();
    rowOf('O3').dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
    key('Delete'); await sleep(800);
    const afterDelete = await titles();
    document.querySelector('.toast-act').click(); await sleep(1200);
    const afterUndo = await titles();

    rowOf('O1').click(); key('p'); await sleep(700);              // O1 pinned
    rowOf('O4').dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
    key('p'); await sleep(700);                                    // O1 + O4 selected: only O4 changes
    document.querySelector('.toast-act').click(); await sleep(900); // undo that
    const { shelves } = await chrome.storage.local.get('shelves');
    const byTitle = Object.fromEntries((await chrome.bookmarks.getChildren('${ids.order}')).map((n) => [n.title, n.id]));
    const pinnedNow = shelves[0].items;
    return { afterDelete, afterUndo, o1Pinned: pinnedNow.includes(byTitle.O1), o4Pinned: pinnedNow.includes(byTitle.O4) };
  `);
  check('undo after deleting several items restores their order', o.afterDelete === 'O1,O4,O5' && o.afterUndo === 'O1,O2,O3,O4,O5', `${o.afterDelete} → ${o.afterUndo}`);
  check('undoing a mixed pin keeps items that were already pinned', o.o1Pinned && !o.o4Pinned, `O1=${o.o1Pinned} O4=${o.o4Pinned}`);

  // import a file "from another computer": different ids, matched by URL; twice = no duplicates
  const imp = await evaluate(cdp, mgr, `${HELPERS}
    const today = new Date(); const day = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-' + String(today.getDate()).padStart(2, '0');
    const [bmA] = await chrome.bookmarks.search({ url: '${base}/a' });
    const exportFile = {
      format: 'heatmark-export', version: 1, trackingSince: '2020-01-01T00:00:00.000Z',
      bookmarks: { id: '0', children: [{ id: '9001', title: 'A elsewhere', url: '${base}/a' }] },
      shelves: [{ id: 'x', name: 'Imported shelf', items: ['9001', '9999'] }],
      log: [{ t: 1600000000000, kind: 'created', id: '9001', title: 'Imported entry', url: '${base}/a', path: ['Old', 'Folder'] },
            { t: 'bad', kind: 'created' }, { t: 1, kind: '<script>' }],
      activity: {
        '${host}/a': { u: '${base}/a', d: { [day]: 7, 'not-a-day': 5 }, last: Date.now() },
        'example.org/not-bookmarked': { u: 'https://example.org/not-bookmarked', d: { [day]: 3 } },
      },
    };
    const imp1 = (await chrome.runtime.sendMessage({ type: 'import', data: exportFile }))?.value;
    const imp2 = (await chrome.runtime.sendMessage({ type: 'import', data: exportFile }))?.value;
    await chrome.runtime.sendMessage({ type: 'sync' }); // imported days must survive a history sync
    const all = await chrome.storage.local.get(null);
    const aRec = Object.entries(all.act).find(([k]) => k.endsWith('/a'))?.[1];
    const importedEntry = Object.values(all).find((e) => e?.title === 'Imported entry');
    return {
      imp1, imp2, bmA: bmA.id, shelf: all.shelves.find((x) => x.name === 'Imported shelf')?.items,
      importedDay: aRec?.x?.[day], notBookmarked: Object.keys(all.act).some((k) => k.includes('not-bookmarked')),
      trackingKept: all.trackingSince === Date.parse('2020-01-01T00:00:00.000Z'),
      entryId: importedEntry?.id, entryImported: importedEntry?.imported,
    };
  `);
  check('import merges by URL, validates, and is idempotent',
    imp.imp1?.log === 1 && imp.imp1?.pins === 1 && imp.imp1?.unmatched === 1 && imp.imp2?.log === 0 && imp.imp2?.pins === 0
      && imp.shelf?.length === 1 && imp.shelf[0] === imp.bmA && imp.trackingKept && imp.entryId === imp.bmA && imp.entryImported,
    JSON.stringify(imp));
  check('imported visits survive a history sync; other pages are not imported', imp.importedDay === 7 && !imp.notBookmarked && imp.imp1?.pages === 1,
    `day=${imp.importedDay} notBookmarked=${imp.notBookmarked} pages=${imp.imp1?.pages}`);

  const z = await evaluate(cdp, mgr, `${HELPERS}
    await chrome.bookmarks.removeTree('${ids.folder}');
    await sleep(900);
    const all = await chrome.storage.local.get(null);
    const log = Object.entries(all).filter(([k]) => k.startsWith('log:')).map(([, e]) => e);
    const removed = log.find((e) => e.kind === 'removed' && e.title === 'E2E folder');
    location.hash = '#activity';
    await sleep(400);
    const img = new Image();
    img.src = 'chrome-extension://' + chrome.runtime.id + '/_favicon/?pageUrl=https%3A%2F%2Fexample.com&size=32';
    const favicon = await new Promise((r) => { img.onload = () => r(img.naturalWidth); img.onerror = () => r(0); });
    return {
      kinds: log.filter((e) => !e.seeded).map((e) => e.kind),
      removedKeepsTree: removed?.node?.children?.length, removedWasPinned: removed?.wasPinned?.length,
      chips: document.querySelectorAll('.vchip').length, nativeBar: list.offsetWidth - list.clientWidth, favicon,
    };
  `);
  check('every change is logged', ['created', 'pinned', 'archived', 'removed'].every((k) => z.kinds.includes(k)), z.kinds.join(','));
  check('removal keeps the subtree and its pins for restore', z.removedKeepsTree === 2 && z.removedWasPinned >= 1,
    `children=${z.removedKeepsTree} wasPinned=${z.removedWasPinned}`);
  check('activity timeline shows visits', z.chips >= 1, `chips=${z.chips}`);
  check('native scrollbar hidden', z.nativeBar === 0, `width=${z.nativeBar}`);
  check('favicon endpoint works', z.favicon > 0, `${z.favicon}px`);

  await cdp.send('Page.bringToFront', {}, mgr);
  const shared = await evaluate(cdp, mgr, `${HELPERS}
    const store = await import('./lib/store.js');
    const { loadModel } = await import('./lib/model.js');
    const { readSharedShelves, SHARED_PREFIX } = await import('./lib/shared-shelves.js');
    const model = () => loadModel();
    const sync = chrome.storage.sync;
    const find = async (n) => (await chrome.bookmarks.search({ title: n }))[0];
    const a = await find('O1'), b = await find('O4'), c = await find('O5');
    const localOnly = (await model()).shelves.every((shelf) => shelf.scope === 'local')
      && !Object.keys(await sync.get(null)).length;
    const localDefault = (await model()).defaultShelf;
    await store.setQuickAccess([localDefault]);
    const work = await store.createShelf('Work');
    const createdShown = (await model()).quickShelves.join() === [localDefault, work].join();
    await store.togglePins([c.id], work);
    const localStillPrivate = !Object.keys(await sync.get(null)).length;
    const start = await store.createShelf('Personal');
    await store.togglePins([a.id], start);
    const shelf = await store.shareShelf(start);
    const rawId = shelf.slice('shared~'.length);
    const converted = (await model()).shelves.some((s) => s.id === shelf && s.scope === 'shared')
      && !(await model()).shelves.some((s) => s.id === start);
    const copy = await store.copyShelfLocally(shelf);
    const localCopy = (await model()).shelves.some((s) => s.id === copy && s.scope === 'local' && s.items.includes(a.id));
    const syncBeforePrefs = JSON.stringify(await sync.get(null));
    await store.setDefaultShelf(work);
    await store.setQuickAccess([shelf, work]);
    const localPrefs = JSON.stringify(await sync.get(null)) === syncBeforePrefs
      && (await model()).defaultShelf === work && (await model()).quickShelves.join() === [shelf, work].join();
    const profile = await chrome.storage.local.get('shelfPreferences');
    const legacyId = 'pinned';
    await sync.set({ [SHARED_PREFIX + 's:pinned']: { name: 'Pinned', at: Date.now() }, [SHARED_PREFIX + 'default']: legacyId });
    await chrome.storage.local.remove('shelfPreferences');
    await chrome.storage.local.set({ shelfMode: 'shared' });
    const legacy = await model();
    const migrated = legacy.shelves.filter((s) => s.name === 'Pinned').length === 2
      && legacy.defaultShelf === 'shared~pinned' && legacy.quickShelves.every((id) => id.startsWith('shared~'));
    await chrome.storage.local.set({ ...profile, shelfMode: 'local',
      sharedPending: { [SHARED_PREFIX + 's:pinned']: { name: 'Paused edit', at: Date.now() } } });
    await store.flushSharedShelves();
    const paused = (await sync.get(SHARED_PREFIX + 's:pinned'))[SHARED_PREFIX + 's:pinned'].name === 'Pinned';
    await store.retrySharedShelves();
    const unpaused = (await sync.get(SHARED_PREFIX + 's:pinned'))[SHARED_PREFIX + 's:pinned'].name === 'Paused edit';
    const migratedPausedWrite = paused && unpaused && !(await model()).sharedPending;
    await sync.remove(SHARED_PREFIX + 's:pinned');
    await sync.set({ [SHARED_PREFIX + 'default']: rawId });
    const remoteDefaultIgnored = (await model()).defaultShelf === work;
    const oldPrefs = await chrome.storage.local.get('shelfPreferences');
    await store.setDefaultShelf(shelf);
    const shelfKey = SHARED_PREFIX + 's:' + rawId;
    const savedShelf = await sync.get(shelfKey);
    await sync.remove(shelfKey);
    const fallback = await model();
    const missingFallsBackLocal = fallback.shelves.find((s) => s.id === fallback.defaultShelf)?.scope === 'local';
    await sync.set(savedShelf);
    await chrome.storage.local.set(oldPrefs);

    await sleep(350);
    document.getElementById('settingsbtn').click();
    const settingsUsesProfile = document.getElementById('default-shelf').value === work
      && document.querySelectorAll('#quick-shelves input:checked').length === 2;
    const workChoice = document.querySelector('#quick-shelves input[data-quick-focus="' + work + '"]');
    workChoice?.click();
    for (let i = 0; i < 25 && (await model()).quickShelves.includes(work); i++) await sleep(80);
    document.getElementById('close-settings').click();
    key('k', { ctrlKey: true });
    const groups = [...document.querySelectorAll('.pal-overlay .pal-sec')].map((node) => node.firstChild.textContent);
    const quickFilters = Boolean(workChoice) && groups.includes('Personal') && !groups.includes('Work')
      && (await model()).shelves.some((s) => s.id === work);
    document.querySelector('.pal-in').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    const localPage = { url: 'https://example.com/work-local-page', title: 'Work local page' };
    await store.pinPage(localPage);
    const page = (await chrome.bookmarks.search({ url: localPage.url }))[0];
    const localNewPage = page.syncing === false && (await model()).shelves.find((s) => s.id === work).items.includes(page.id);
    await store.pinPage(localPage, copy);
    await store.pinPage({ ...localPage, url: 'https://www.example.com/work-local-page/' }, copy); // the same page to normUrl
    const explicitPinOnly = (await model()).shelves.find((s) => s.id === copy).items.includes(page.id) && (await model()).defaultShelf === work
      && (await model()).idx.urls.filter((e) => e.node.url.includes('work-local-page')).length === 1;
    // A signed-in profile can have account and device-only folders; one with Chrome Sync on
    // has only synced folders, and Local shelves bookmark into its Other bookmarks.
    const { getOtherRootId } = await import('./lib/bm.js');
    const roots = (device) => async () => [{ id: '0', children: [
      { id: 'bar', folderType: 'bookmarks-bar', syncing: true },
      { id: 'account', folderType: 'other', syncing: true },
      ...(device ? [{ id: 'device', folderType: 'other', syncing: false }] : []),
    ] }];
    await sleep(400); // let the page finish reloading before its tree is replaced
    const getTree = chrome.bookmarks.getTree;
    chrome.bookmarks.getTree = roots(true);
    const twoTrees = await getOtherRootId(true) === 'device' && await getOtherRootId() === 'account';
    chrome.bookmarks.getTree = roots(false);
    const syncedProfile = twoTrees && await getOtherRootId(true) === 'account';
    chrome.bookmarks.getTree = getTree;
    let data = await sync.get(null);
    const prefix = SHARED_PREFIX + 'p:' + rawId + ':';
    const aKey = Object.keys(data).find((key) => key.startsWith(prefix));
    const portable = typeof data[aKey].url === 'string' && data[aKey].url !== a.url && !('id' in data[aKey]);
    const elsewhere = { ...a, id: '123456' };
    const pendingBookmark = await readSharedShelves([]);
    const arrivedBookmark = await readSharedShelves([elsewhere, { ...elsewhere, id: '123457', title: 'Duplicate' }]);
    const ambiguousBookmark = await readSharedShelves([elsewhere, { ...elsewhere, id: '123457' }]);
    const matchedOtherProfile = pendingBookmark.unavailable > 0
      && arrivedBookmark.shelves.find((s) => s.id === rawId).items[0] === elsewhere.id
      && ambiguousBookmark.shelves.find((s) => s.id === rawId).items.length === 0;

    // Use real Chrome Sync storage events to stand in for the other computer's updates.
    // Move one key from a temporary shelf to emulate an independently added pin.
    const tempLocal = await store.createShelf('Temporary');
    await store.togglePins([b.id, c.id], tempLocal);
    const temporary = await store.shareShelf(tempLocal);
    data = await sync.get(null);
    const remotePins = Object.entries(data).filter(([key]) => key.startsWith(SHARED_PREFIX + 'p:' + temporary.slice('shared~'.length) + ':'));
    const incoming = Object.fromEntries(remotePins.map(([key, value]) => [prefix + key.split(':').at(-1), value]));
    await store.deleteShelf(temporary);
    location.hash = '#shelf:' + shelf;
    await sleep(400);
    await sync.set(incoming);
    await sleep(450);
    const received = !!rowOf('O4') && !!rowOf('O5') && !!rowOf('O1');
    await store.setShelfItems(shelf, [c.id, a.id]); // stale list did not see O4
    let pins = (await model()).shelves.find((s) => s.id === shelf).items;
    const staleReorderKeptNewPin = pins.includes(b.id) && pins.indexOf(c.id) < pins.indexOf(a.id);
    await sync.remove(aKey);
    await sleep(400);
    const remoteUnpin = !rowOf('O1') && !!rowOf('O4');
    await store.renameShelf(shelf, 'Shared projects');
    const settingsSynced = (await sync.get(shelfKey))[shelfKey].name === 'Shared projects'
      && (await model()).defaultShelf === work;

    const longName = 'a'.repeat(9000);
    const large = await store.shareShelf(await store.createShelf(longName));
    const beforeRetry = await model();
    const pendingOnQuota = beforeRetry.sharedPending && beforeRetry.sharedError.includes('limit')
      && beforeRetry.shelves.some((s) => s.id === large);
    const whilePending = await store.createShelf('Available while sync is full');
    const localWhilePending = (await model()).shelves.some((s) => s.id === whilePending && s.scope === 'local');
    await store.renameShelf(large, 'Short enough');
    const retried = !(await model()).sharedPending && (await model()).shelves.some((s) => s.name === 'Short enough');

    await chrome.bookmarks.update(b.id, { url: 'https://example.com/revised' });
    const urlEdit = (await model()).isPinned(b.id);
    await chrome.bookmarks.remove(b.id);
    await sleep(450);
    const removed = Object.entries(await chrome.storage.local.get(null))
      .find(([key, value]) => key.startsWith('log:') && value.kind === 'removed' && value.id === b.id);
    const deleted = removed?.[1].wasPinned?.some((pin) => pin.shelf === shelf);
    await store.restoreFromLogEntry(removed[0]);
    const restored = await find('O4');
    const restoredPin = (await model()).isPinned(restored.id);

    await store.resetAll();
    const reset = await model();
    const resetStayedLocal = reset.defaultShelf === 'pinned' && reset.quickAccess == null
      && reset.shelves.some((s) => s.id === shelf) && !reset.shelves.some((s) => s.id === work);
    return { localOnly, localStillPrivate, converted, localCopy, localPrefs, createdShown, migrated, migratedPausedWrite, remoteDefaultIgnored, missingFallsBackLocal,
      settingsUsesProfile, quickFilters, localNewPage, explicitPinOnly, syncedProfile, portable, matchedOtherProfile, received, staleReorderKeptNewPin, remoteUnpin,
      settingsSynced, pendingOnQuota, localWhilePending, retried, urlEdit, deleted, restoredPin, resetStayedLocal };
  `);
  check('Local shelves coexist with Shared and publish only on explicit sharing', shared.localOnly && shared.localStillPrivate && shared.converted && shared.localCopy, JSON.stringify(shared));
  check('Quick Access and the pin target are independent per-profile preferences', shared.localPrefs && shared.createdShown && shared.remoteDefaultIgnored && shared.missingFallsBackLocal && shared.settingsUsesProfile && shared.quickFilters, JSON.stringify(shared));
  check('v1.1 shelves with overlapping IDs and the active default survive migration', shared.migrated && shared.migratedPausedWrite);
  check('bookmarking on a Local shelf prefers a device-only folder and explicit pins keep the default', shared.localNewPage && shared.explicitPinOnly && shared.syncedProfile, JSON.stringify(shared));
  check('shared records use portable references and update the open manager', shared.portable && shared.matchedOtherProfile && shared.received && shared.remoteUnpin, JSON.stringify(shared));
  check('reordering a stale view preserves incoming pins', shared.staleReorderKeptNewPin && shared.settingsSynced);
  check('quota rejection preserves shared edits while Local shelves remain writable', shared.pendingOnQuota && shared.localWhilePending && shared.retried);
  check('shared pins follow URL edits and survive delete with restore', shared.urlEdit && shared.deleted && shared.restoredPin);
  check('local reset clears profile preferences and preserves shared shelves', shared.resetStayedLocal);

  await openPage(cdp, `chrome-extension://${EXT_ID}/popup.html`);
  await sleep(800);
  check('no page errors', cdp.pageErrors.length === 0, cdp.pageErrors.join(' | '));
} catch (err) {
  check('run', false, err.stack || String(err));
} finally {
  site.close();
  await cdp?.close();
}

for (const t of results) console.log(`${t.ok ? 'ok  ' : 'FAIL'}  ${t.name}${t.detail && !t.ok ? `\n      ${t.detail}` : ''}`);
const failed = results.filter((t) => !t.ok).length;
console.log(failed ? `\n${failed} of ${results.length} checks failed` : `\nall ${results.length} checks passed`);
process.exit(failed ? 1 : 0);
