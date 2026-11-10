// Store screenshots (1280×800, with a caption band) and the small promo tile (440×280), rendered
// from the demo data (dev/demo-data.js) through the dev server, so no real bookmarks or history
// can appear in them.
//
//   node dev/screenshots.mjs <path-to-chromium>      (or set CHROME=<path-to-chromium>)
//
// Writes store/screenshot-{1-tree,2-activity,3-palette,4-cleanup,5-dark}.png and
// store/promo-small-440x280.png.

import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, openPage, evaluate, freePort, waitForHttp, sleep } from './cdp.mjs';

const CHROME = process.argv[2] || process.env.CHROME;
if (!CHROME) {
  console.error('usage: node dev/screenshots.mjs <path-to-chromium>');
  process.exit(2);
}
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(ROOT, 'store');

// The UI is rendered at 110% so its text survives the store's downscaling, on a 1164-px-wide layout
// (wide enough to keep the detail pane), into the 1280×728 area under a 72-px caption band.
const ZOOM = 1.1;
const W = 1280, H = 800, BAND = 72;
const VIEW = { width: Math.round(W / ZOOM), height: Math.ceil((H - BAND) / ZOOM) };

const SCENES = [
  { file: 'screenshot-1-tree.png', caption: 'Understand your bookmarks', sub: 'Which ones you open, how often, and which you have forgotten' },
  { file: 'screenshot-2-activity.png', caption: 'A year of visits at a glance', sub: 'The heatmap and a day-by-day log of visits and every change' },
  { file: 'screenshot-3-palette.png', caption: 'Ctrl+K finds anything', sub: 'Fuzzy search ranked by how often and how recently you use each link' },
  { file: 'screenshot-4-cleanup.png', caption: 'Clear out what you never open', sub: 'Filter, select, archive or delete in bulk, with Undo' },
  { file: 'screenshot-5-dark.png', caption: 'Right-click anything', sub: 'Context menus and keyboard shortcuts everywhere, in light and dark' },
];

const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const iconData = `data:image/png;base64,${readFileSync(join(ROOT, 'extension/icons/48.png')).toString('base64')}`;

const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const server = spawn('python3', [join(ROOT, 'dev/serve.py'), '--port', String(port)], { stdio: 'ignore' });
let cdp = null;

// Helpers injected into the manager page for scripted interaction.
const HELPERS = `
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const list = document.getElementById('list');
  const filter = document.getElementById('filter');
  const key = (k, o = {}, el = list) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, ...o }));
  const setFilter = async (q) => { filter.value = q; filter.dispatchEvent(new Event('input')); await sleep(250); };
  const row = (title) => [...document.querySelectorAll('.row')].find((r) => r.querySelector('.t')?.textContent === title);
  const select = (title) => row(title).click();
  const palette = async (text) => { const i = document.querySelector('.pal-in'); i.value = text; i.dispatchEvent(new Event('input')); await sleep(80); return i; };
  const contextMenu = async (title, dx = 220) => {
    const el = row(title); const r = el.getBoundingClientRect();
    el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + dx, clientY: r.top + r.height / 2 }));
    await sleep(150);
  };
`;

async function go(s, url, scheme = 'light') {
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] }, s);
  const [path, hash = ''] = url.split('#'); // a fresh query string forces a real load even if only the #hash differs
  await cdp.send('Page.navigate', { url: `${path}?v=${Date.now()}${hash ? '#' + hash : ''}` }, s);
  await sleep(1400);
}

// Capture the UI and compose it under a caption band.
async function shot(s, scene, dark = false) {
  await sleep(400);
  const { result } = await cdp.send('Page.captureScreenshot', {
    format: 'png', clip: { x: 0, y: 0, width: W / ZOOM, height: (H - BAND) / ZOOM, scale: 1 },
  }, s);
  const frame = await openPage(cdp, 'about:blank', { width: W, height: H });
  const { result: { frameTree } } = await cdp.send('Page.getFrameTree', {}, frame);
  await cdp.send('Page.setDocumentContent', {
    frameId: frameTree.frame.id,
    html: `<!doctype html><html><head><style>
      html,body{margin:0;width:${W}px;height:${H}px;overflow:hidden;background:#12151c}
      .band{height:${BAND}px;display:flex;align-items:center;gap:16px;padding:0 28px;box-sizing:border-box;
        font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#f2f3f5}
      .band img{width:30px;height:30px}
      .t{font-size:25px;font-weight:650;letter-spacing:-.01em}
      .s{font-size:16px;color:#9aa3b2;margin-left:auto}
      .ui{display:block;width:${W}px;height:${H - BAND}px}
    </style></head><body>
      <div class="band"><img src="${iconData}" alt=""><span class="t">${esc(scene.caption)}</span><span class="s">${esc(scene.sub)}</span></div>
      <img class="ui" src="data:image/png;base64,${result.data}" alt="">
    </body></html>`,
  }, frame);
  await sleep(300);
  const out = await cdp.send('Page.captureScreenshot', { format: 'png' }, frame);
  writeFileSync(join(OUT, scene.file), Buffer.from(out.result.data, 'base64'));
  await cdp.send('Target.closeTarget', { targetId: frameTree.frame.id }).catch(() => {});
  console.log(`  store/${scene.file}${dark ? ' (dark)' : ''}`);
}

try {
  await waitForHttp(`${base}/manager.html`);
  cdp = await launch(CHROME, ['--hide-scrollbars', '--font-render-hinting=none']);
  const s = await openPage(cdp, 'about:blank', { ...VIEW, deviceScaleFactor: ZOOM });
  await go(s, `${base}/manager.html`);

  // A lived-in state: pins, a project shelf, some cleanup in the log.
  await evaluate(cdp, s, `${HELPERS}
    for (const t of ['GitHub', 'Calendar', 'Grafana — Production overview', 'Linear — Sprint board', 'Excalidraw', 'Search relevance — design doc']) {
      await setFilter('"' + t + '"'); select(t); key('p'); await sleep(500);
    }
    await setFilter('in:lisbon'); key('a', { ctrlKey: true });
    key('P', { shiftKey: true }); await sleep(100);
    key('Enter', {}, await palette('Lisbon trip')); await sleep(800);
    await setFilter('in:"old stuff"'); key('Home'); key('ArrowDown', { shiftKey: true }); key('ArrowDown', { shiftKey: true }); key('a'); await sleep(800);
    await setFilter('"Speedtest"'); select('Speedtest'); key('Delete'); await sleep(800);
    await setFilter('');
  `);
  const expanded = await evaluate(cdp, s, `
    const [root] = await chrome.bookmarks.getTree();
    const find = (n, t) => (n.title === t && !n.url ? n : (n.children || []).reduce((a, c) => a || find(c, t), null));
    return ['1', find(root, 'Work').id, find(root, 'Projects').id, find(root, 'Dev docs').id];
  `);
  await evaluate(cdp, s, `localStorage.setItem('bk:expanded', ${JSON.stringify(JSON.stringify(expanded))}); return 1;`);

  // 1 — the tree with a selected bookmark
  await go(s, `${base}/manager.html#folder:0`);
  await evaluate(cdp, s, `${HELPERS} select('Grafana — Production overview'); list.focus(); return 1;`);
  await shot(s, SCENES[0]);

  // 2 — activity and log
  await go(s, `${base}/manager.html#activity`);
  await shot(s, SCENES[1]);

  // 3 — the palette, dark
  await go(s, `${base}/manager.html#folder:0`, 'dark');
  await evaluate(cdp, s, `${HELPERS} key('k', { ctrlKey: true }); await sleep(150); return 1;`);
  await shot(s, SCENES[2], true);

  // 4 — cleanup: a stale reading list, a selection with bulk actions
  await go(s, `${base}/manager.html#view:stale`);
  await evaluate(cdp, s, `${HELPERS}
    await setFilter('in:reading');
    list.focus(); key('Home'); for (let i = 0; i < 4; i++) key('ArrowDown', { shiftKey: true });
    await sleep(200); return 1;
  `);
  await shot(s, SCENES[3]);

  // 5 — duplicates in dark mode, with the context menu open
  await go(s, `${base}/manager.html#view:dups`, 'dark');
  await evaluate(cdp, s, `${HELPERS} select('Hacker News'); list.focus(); await contextMenu('Hacker News', 260); return 1;`);
  await shot(s, SCENES[4], true);

  // promo tile: dark, the name and one line, and a slice of the heatmap
  const t = await openPage(cdp, 'about:blank', { width: 440, height: 280 });
  const { result: { frameTree } } = await cdp.send('Page.getFrameTree', {}, t);
  const ramp = ['#1d2433', '#22355a', '#2c4f8f', '#3f6fd0', '#6b9bf6', '#b5d0ff'];
  let seed = 11;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  let cells = '';
  for (let col = 0; col < 9; col++) {
    for (let row = 0; row < 7; row++) {
      const heat = Math.min(5, Math.floor(rnd() * 3 + (col / 8) * 3.2 + (row % 6 ? 0 : -1)));
      cells += `<rect x="${col * 20}" y="${row * 20}" width="16" height="16" rx="3.5" fill="${ramp[Math.max(0, heat)]}"/>`;
    }
  }
  await cdp.send('Page.setDocumentContent', {
    frameId: frameTree.frame.id,
    html: `<!doctype html><html><head><style>
      html,body{margin:0;width:440px;height:280px;overflow:hidden;background:#12151c;color:#f2f3f5;
        font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
      .text{position:absolute;left:30px;top:50%;transform:translateY(-50%);z-index:1}
      img{width:64px;height:64px;display:block;margin-bottom:16px}
      h1{font-size:40px;font-weight:700;letter-spacing:-.02em;margin:0;line-height:1}
      p{font-size:20px;color:#aeb7c6;margin:12px 0 0;line-height:1.3}
      svg{position:absolute;right:-26px;top:70px;
        -webkit-mask-image:linear-gradient(to right,transparent,#000 55%);mask-image:linear-gradient(to right,transparent,#000 55%)}
    </style></head><body>
      <div class="text"><img src="${base}/icons/128.png" alt=""><h1>Heatmark</h1><p>Understand your<br>bookmarks.</p></div>
      <svg width="180" height="140" viewBox="0 0 180 140">${cells}</svg>
    </body></html>`,
  }, t);
  await sleep(600);
  const promo = await cdp.send('Page.captureScreenshot', { format: 'png' }, t);
  writeFileSync(join(OUT, 'promo-small-440x280.png'), Buffer.from(promo.result.data, 'base64'));
  console.log('  store/promo-small-440x280.png');
} finally {
  await cdp?.close();
  server.kill();
}
