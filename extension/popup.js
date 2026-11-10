// Toolbar popup = the palette, always open.
import { loadModel } from './lib/model.js';
import { createPalette } from './lib/palette.js';
import { getOtherRootId, normUrl } from './lib/bm.js';
import { togglePins } from './lib/store.js';
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

const currentEntry = () => {
  const k = tab?.url ? normUrl(tab.url) : null;
  return k ? model?.idx.urls.find((x) => x.norm === k) : null;
};

const pinCurrent = () => act(async () => {
  if (!tab?.url || !/^(https?|file|ftp):/.test(tab.url)) return;
  const e = currentEntry();
  const id = e ? e.node.id
    : (await chrome.bookmarks.create({ parentId: await getOtherRootId(), title: tab.title || tab.url, url: tab.url })).id;
  await togglePins([id]);
});

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
        { id: 'pin-current', showEmpty: true, hint: tab?.title ? tab.title.slice(0, 40) : '', name, run: pinCurrent },
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
        { label: 'Show in Heatmark', run: () => { chrome.tabs.create({ url: chrome.runtime.getURL(`manager.html#reveal:${node.id}`) }); window.close(); } },
      ], atPointer(ev));
    },
  },
});
document.body.append(pal.el);

[tab] = await chrome.tabs.query({ active: true, currentWindow: true });
model = await loadModel();
pal.open();
