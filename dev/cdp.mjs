// Minimal Chrome DevTools Protocol helpers shared by e2e.mjs and screenshots.mjs.
// No dependencies: a headless Chromium is launched with a throwaway profile and driven over
// its browser websocket (flattened sessions).

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer().listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

// Poll an HTTP URL until it answers (or throw after `ms`).
export async function waitForHttp(url, ms = 10000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try { if ((await fetch(url)).ok) return; } catch { /* not up yet */ }
    await sleep(100);
  }
  throw new Error(`${url} did not come up within ${ms} ms`);
}

// Launch Chromium headless with a temporary profile. Returns { send, close, pageErrors, port, stderr }.
export async function launch(chromePath, extraArgs = []) {
  const port = await freePort();
  const profile = mkdtempSync(join(tmpdir(), 'heatmark-cdp-'));
  // CI runners (Ubuntu 24.04) block the user-namespace sandbox, so Chromium aborts at startup.
  const sandbox = process.env.CI ? ['--no-sandbox'] : [];
  const proc = spawn(chromePath, [
    '--headless=new', `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`,
    '--no-first-run', '--no-default-browser-check', ...sandbox, ...extraArgs, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  proc.stderr.on('data', (d) => (stderr += d));

  let version = null;
  for (let i = 0; i < 100 && !version; i++) {
    try { version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); } catch { await sleep(100); }
  }
  if (!version) {
    proc.kill();
    throw new Error(`Chromium did not start:\n${stderr.slice(-2000)}`);
  }

  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let seq = 0;
  const pending = new Map();
  const pageErrors = [];
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, timer } = pending.get(msg.id);
      clearTimeout(timer);
      pending.delete(msg.id);
      resolve(msg);
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      pageErrors.push(d.exception?.description || d.text);
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      pageErrors.push(msg.params.args.map((a) => a.value ?? a.description).join(' '));
    }
  };

  // Every command times out, so a crashed browser fails the run instead of hanging it.
  const send = (method, params = {}, sessionId, timeout = 30000) => new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP ${method} timed out`)); }, timeout);
    pending.set(id, { resolve, timer });
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });

  const targets = async () => (await fetch(`http://127.0.0.1:${port}/json/list`)).json();

  const close = async () => {
    try { ws.close(); } catch { /* already closed */ }
    proc.kill();
    await sleep(300);
    rmSync(profile, { recursive: true, force: true });
  };

  return { send, close, targets, pageErrors, get stderr() { return stderr; } };
}

// Open a new tab, attached and ready; optionally emulate a viewport.
export async function openPage(cdp, url = 'about:blank', viewport = null) {
  const { result: { targetId } } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { result: { sessionId } } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Page.enable', {}, sessionId);
  if (viewport) await cdp.send('Emulation.setDeviceMetricsOverride', { mobile: false, deviceScaleFactor: 1, ...viewport }, sessionId);
  if (url !== 'about:blank') await cdp.send('Page.navigate', { url }, sessionId);
  return sessionId;
}

// Evaluate an async function body in the page and return its (JSON) result.
export async function evaluate(cdp, sessionId, body) {
  const r = await cdp.send('Runtime.evaluate', { expression: `(async () => { ${body} })()`, awaitPromise: true, returnByValue: true }, sessionId);
  if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
  return r.result.result.value;
}
