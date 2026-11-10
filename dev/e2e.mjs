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
