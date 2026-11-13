// The manager page (manager.html). This entry creates the Ctrl+K palette, keeps the page in sync
// with bookmark and storage changes, and loads; the UI itself lives in manager/*.js.

import { atPointer, openMenu } from './lib/menu.js';
import { createPalette } from './lib/palette.js';
import { autoScrollbars } from './lib/scrollbars.js';
import { SHARED_PREFIX } from './lib/shared-shelves.js';
import { togglePins } from './lib/store.js';
import { installTooltips } from './lib/tooltip.js';
import { installFaviconFallback, openLink } from './lib/ui.js';
import { toggleHelp } from './manager/input.js'; // importing input.js also registers the page's event handlers
import { openSettings } from './manager/settings.js';
import { renderSync } from './manager/list.js';
import { entryMenu, folderMenu } from './manager/menus.js';
import {
  collapseAll, deleteAllStoredData, expandAll, exportJSON, importJSON, newFolder, newShelf, reveal,
} from './manager/ops.js';
import { E, S, VIEWS, go, load, reload, reloadActivity, syncNow, withBusy } from './manager/state.js';

installFaviconFallback();
installTooltips();
autoScrollbars();

export const pal = createPalette({
  actions: {
    getModel: () => S.m,
    open: (e, how) => openLink(e.node.url, how),
    reveal,
    togglePin: (e) => withBusy(() => togglePins([e.node.id])),
    commands: () => {
      const m = S.m;
      const goCmd = (name, nav, hint = '') => ({ name, hint, run: () => go(nav) });
      return [
        goCmd('Go to All bookmarks', `folder:${m.idx.root.id}`, 'G A'),
        goCmd('Go to Activity & log', 'activity', 'G L'),
        ...Object.entries(VIEWS).map(([id, v]) => goCmd(`Go to ${v.name}`, `view:${id}`, v.hint)),
        ...m.shelves.map((s, i) => goCmd(`Go to shelf: ${s.name}`, `shelf:${s.id}`, i < 9 ? String(i + 1) : '')),
        { name: 'New shelf…', run: () => newShelf() },
        { name: 'Sync history now', hint: 'pull visits from Chrome history', run: () => syncNow() },
        { name: 'New folder…', run: () => newFolder(S.route.kind === 'folder' ? S.route.id : null) },
        { name: 'Expand all folders', run: expandAll },
        { name: 'Collapse all folders', run: collapseAll },
        { name: 'Export JSON', hint: 'log, activity, shelves, bookmarks', run: exportJSON },
        { name: 'Import JSON…', hint: 'merge an export from another install', run: importJSON },
        { name: 'Settings', hint: 'Quick Access and default pin shelf', run: openSettings },
        { name: 'Delete local data…', hint: 'log, visit record, local shelves', run: deleteAllStoredData },
        { name: 'Keyboard shortcuts', hint: '?', run: () => toggleHelp(true) },
      ];
    },
    onClose: () => { if (S.route.kind !== 'activity') E.list.focus(); },
    contextMenu: (it, ev) => {
      const items = it.type === 'bm' ? entryMenu([it.e.node.id]) : it.type === 'folder' ? folderMenu(it.f.node.id, { fromSidebar: true }) : null;
      if (!items) return;
      // run each action after the palette closes, so pickers and dialogs open cleanly
      openMenu(items.map((x) => (x && x.run ? { ...x, run: () => { pal.close(); x.run(); } } : x)), atPointer(ev));
    },
  },
});
document.body.append(pal.el);
document.getElementById('settingsbtn').addEventListener('click', openSettings);

// Live updates. Hidden tabs don't reload on every change; they catch up when they become visible.
let staleWhileHidden = false;
const refresh = (fn) => () => { if (document.hidden) staleWhileHidden = true; else fn(); };
for (const ev of ['onCreated', 'onRemoved', 'onChanged', 'onMoved', 'onChildrenReordered']) chrome.bookmarks[ev]?.addListener(refresh(reload));
chrome.storage.onChanged.addListener((changes, area) => {
  const keys = Object.keys(changes);
  if (area === 'sync' && !keys.some((key) => key.startsWith(SHARED_PREFIX))) return;
  refresh(keys.every((k) => k === 'act' || k === 'actSyncedAt') ? reloadActivity : reload)();
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && staleWhileHidden) { staleWhileHidden = false; reload(); }
});
setInterval(() => { if (!document.hidden) renderSync(); }, 60e3);

load().then(() => E.list.focus());
