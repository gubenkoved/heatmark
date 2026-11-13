// Toolbar popup = the palette, always open.
import { loadModel } from './lib/model.js';
import { createPalette } from './lib/palette.js';
import { normUrl } from './lib/bm.js';
import { pinPage, setPins, SHELF_KEYS, togglePins } from './lib/store.js';
import { SHARED_PREFIX } from './lib/shared-shelves.js';
import { openMenu, atPointer } from './lib/menu.js';
import { installFaviconFallback, openLink, toast } from './lib/ui.js';
import { installTooltips } from './lib/tooltip.js';

installFaviconFallback();
installTooltips();
let model = null;
let tab = null;

async function refresh() {
  model = await loadModel();
  pal.refresh();
}

// Run a change, report a failure in the popup, then reload the model.
async function act(fn) {
  try {
    await fn();
  } catch (err) {
    toast(String(err?.message || err));
  }
  await refresh();
}

const canPin = () => /^(https?|file|ftp):/.test(tab?.url || '');
// The same match pinPage makes in the worker, so the command names what will happen.
const currentEntry = () => {
  const norm = canPin() ? normUrl(tab.url) : null;
  const matches = norm ? model?.idx.urls.filter((entry) => entry.norm === norm) || [] : [];
  return matches.find((entry) => model.isPinnedOnDefault(entry.node.id)) || matches[0];
};
const pinCurrent = (shelfId) => act(() => pinPage({ url: tab.url, title: tab.title }, shelfId));

function pickShelf(onPick) {
  pal.open({ mode: 'shelf', title: 'Pin to shelf', allowNew: false, onPick: (shelf) => onPick(shelf.id) });
}

function openManager() {
  chrome.tabs.create({ url: chrome.runtime.getURL('manager.html') });
  window.close();
}

async function openEntry(e, how) {
  if ((await openLink(e.node.url, how, tab?.id)) && how !== 'background') window.close();
}

const pal = createPalette({
  inline: true,
  actions: {
    footerAction: { label: 'Full view ↗', key: 'Alt O', code: 'KeyO', run: openManager },
    getModel: () => model,
    open: openEntry,
    togglePin: (e) => act(() => togglePins([e.node.id])),
    commands: () => {
      const cur = currentEntry();
      const shelf = model?.defaultShelfName || 'Pinned';
      const name = cur && model.isPinnedOnDefault(cur.node.id) ? `Unpin this page from ${shelf}`
        : cur ? `Pin this page to ${shelf}` : `Bookmark and pin this page to ${shelf}`;
      return [
        ...(canPin() ? [
          { id: 'pin-current', showEmpty: true, hint: tab.title ? tab.title.slice(0, 40) : '', name, run: () => pinCurrent() },
          // Named without "pin", so ">pin" + Enter still runs the command above.
          { id: 'pick-shelf', showEmpty: true, name: 'Choose a shelf for this page…', run: () => pickShelf(pinCurrent) },
        ] : []),
        { id: 'manager', showEmpty: true, name: 'Open Heatmark', hint: 'tree, activity, log', run: openManager },
      ];
    },
    onEscape: () => window.close(),
    contextMenu: (it, ev) => {
      if (it.type !== 'bm') return;
      const { node } = it.e;
      const run = (how) => () => openEntry(it.e, how);
      openMenu([
        { label: 'Open in new tab', key: '↵', run: run('tab') },
        { label: 'Open in this tab', key: 'Shift ↵', run: run('here') },
        { label: 'Open in background tab', key: 'Ctrl ↵', run: run('background') },
        { label: 'Open in new window', run: run('window') },
        '-',
        { label: 'Copy link', run: () => navigator.clipboard.writeText(node.url).then(() => toast('Link copied'), () => toast('Could not copy')) },
        '-',
        {
          label: model.isPinnedOnDefault(node.id) ? `Unpin from ${model.defaultShelfName}` : `Pin to ${model.defaultShelfName}`,
          key: 'Alt P', run: () => act(() => togglePins([node.id])),
        },
        { label: 'Pin to shelf…', run: () => pickShelf((id) => act(() => setPins([node.id], id, true))) },
        { label: 'Show in Heatmark', run: () => { chrome.tabs.create({ url: chrome.runtime.getURL(`manager.html#reveal:${node.id}`) }); window.close(); } },
      ], atPointer(ev));
    },
  },
});
document.body.append(pal.el);

[tab] = await chrome.tabs.query({ active: true, currentWindow: true });
model = await loadModel();
pal.open();

chrome.storage.onChanged.addListener((changes, area) => {
  const keys = Object.keys(changes);
  const shelfChanged = area === 'local' && keys.some((key) => SHELF_KEYS.includes(key));
  const sharedChanged = area === 'sync' && keys.some((key) => key.startsWith(SHARED_PREFIX));
  if (shelfChanged || sharedChanged) refresh();
});
for (const event of ['onCreated', 'onRemoved', 'onChanged', 'onMoved']) chrome.bookmarks[event].addListener(refresh);
