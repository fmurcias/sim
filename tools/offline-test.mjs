#!/usr/bin/env node
// Offline/PWA check: load once online (service worker installs and precaches),
// then cut the network, reload, and require the simulator to become flyable.
//   node tools/offline-test.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 9100 + Math.floor(Math.random() * 500), CDP = 9700 + Math.floor(Math.random() * 500);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1', '-d', ROOT], { stdio: 'ignore' });
const chrome = spawn('google-chrome', ['--headless=new', `--remote-debugging-port=${CDP}`,
  `--user-data-dir=${mkdtempSync(join(tmpdir(), 'fpv-off-'))}`, '--window-size=960,540', '--mute-audio',
  '--no-first-run', '--enable-unsafe-swiftshader', '--disable-background-timer-throttling'], { stdio: 'ignore' });

let ok = false;
try {
  let v; for (let i = 0; i < 100 && !v; i++) { try { v = await (await fetch(`http://127.0.0.1:${CDP}/json/version`)).json(); } catch { await sleep(100); } }
  const t = await (await fetch(`http://127.0.0.1:${CDP}/json/new?about:blank`, { method: 'PUT' })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise(r => ws.onopen = r);
  let id = 0; const pend = new Map();
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
  const send = (method, params = {}) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async x => (await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true })).result?.result?.value;
  const waitFor = async (expr, ms) => { const t0 = Date.now(); while (!(await ev(expr).catch(() => false))) { if (Date.now() - t0 > ms) return false; await sleep(300); } return true; };
  await send('Runtime.enable'); await send('Network.enable'); await send('Page.enable');
  const url = `http://127.0.0.1:${PORT}/index.html?seed=3&q=low`;

  await send('Page.navigate', { url });
  if (!await waitFor('!!(window.__fpv && window.__fpv.ready)', 90000)) throw new Error('online load never became ready');
  console.log('online load ready');
  if (!await waitFor(`navigator.serviceWorker.controller !== null || (navigator.serviceWorker.ready.then(()=>true))`, 30000)) throw new Error('no service worker');
  if (!await waitFor(`caches.open('fpv-sim-v3').then(c=>c.keys()).then(k=>k.length>=45)`, 120000)) throw new Error('precache incomplete');
  console.log('precached:', await ev(`caches.open('fpv-sim-v3').then(c=>c.keys()).then(k=>k.length)`), 'entries');

  await send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await send('Page.reload', { ignoreCache: false });
  await sleep(1500);
  ok = await waitFor('!!(window.__fpv && window.__fpv.ready)', 90000);
  console.log(ok ? 'PASS  offline reload became ready' : 'FAIL  offline reload never became ready');
  ws.close();
} catch (e) {
  console.log('FAIL ', e.message);
} finally {
  chrome.kill('SIGKILL'); server.kill('SIGKILL');
  process.exit(ok ? 0 : 1);
}
