#!/usr/bin/env node
// Headless-Chrome screenshots of the simulator for before/after comparisons,
// driven over the DevTools protocol (Node's built-in WebSocket — no npm deps).
//
//   node tools/shot.mjs --out shots/ --shots tools/shots.json [--q high] [--seed 7]
//   node tools/shot.mjs --out shots/ --name spawn --pose 0,1.5,8,0,-5,0 --env midday
//   node tools/shot.mjs --test tools/physics-test.js      (no screenshots; exit 1 on failure)
//
// Each shot: {name, pose:[x,y,z,yawDeg,pitchDeg,rollDeg], env, q, wait, w, h}.
// Console errors and uncaught exceptions from the page are printed, and the
// process exits non-zero if any occurred.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, mkdtempSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, arr) => {
  if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true]);
  return acc;
}, []));

const OUT = resolve(args.out || 'shots');
const PORT = 8765 + Math.floor(Math.random() * 500);
const CDP = 9333 + Math.floor(Math.random() * 500);
const W = +(args.w || 1280), H = +(args.h || 720);
const sleep = ms => new Promise(r => setTimeout(r, ms));

let shots;
if (args.test) shots = [{ name: 'test' }];
else if (args.shots) shots = JSON.parse(readFileSync(args.shots, 'utf8'));
else shots = [{ name: args.name || 'shot', pose: args.pose ? args.pose.split(',').map(Number) : null, env: args.env, wait: +(args.wait || 2500) }];
mkdirSync(OUT, { recursive: true });

const server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1', '-d', ROOT], { stdio: 'ignore' });
const profile = mkdtempSync(join(tmpdir(), 'fpv-shot-'));
const chromeArgs = [
  '--headless=new', `--remote-debugging-port=${CDP}`, `--user-data-dir=${profile}`,
  `--window-size=${W},${H}`, '--hide-scrollbars', '--mute-audio', '--no-first-run',
  '--no-default-browser-check', '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader',
  ...(args.gl ? [`--use-angle=${args.gl}`] : []),
];
const chrome = spawn(args.chrome || 'google-chrome', chromeArgs, { stdio: 'ignore' });

let failures = 0;
async function main() {
  let version;
  for (let i = 0; i < 100 && !version; i++) {
    try { version = await (await fetch(`http://127.0.0.1:${CDP}/json/version`)).json(); } catch { await sleep(100); }
  }
  if (!version) throw new Error('chrome did not start');
  const target = await (await fetch(`http://127.0.0.1:${CDP}/json/new?about:blank`, { method: 'PUT' })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const pending = new Map();
  ws.onmessage = ev => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); return; }
    if (msg.method === 'Runtime.consoleAPICalled') {
      const t = msg.params.type;
      const text = msg.params.args.map(a => a.value ?? a.description ?? '').join(' ');
      if (t === 'error') { failures++; console.log('  [console.error]', text); }
      else if (t === 'warning' || args.verbose) console.log(`  [console.${t}]`, text.slice(0, 300));
    } else if (msg.method === 'Runtime.exceptionThrown') {
      failures++;
      const d = msg.params.exceptionDetails;
      console.log('  [exception]', d.exception?.description || d.text, d.url || '', d.lineNumber ?? '');
    } else if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
      console.log('  [log.error]', msg.params.entry.text, msg.params.entry.url || '');
    }
  };
  const send = (method, params = {}) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'eval failed');
    return r.result?.result?.value;
  };
  await send('Runtime.enable'); await send('Page.enable'); await send('Log.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });

  const q = args.q || 'high';
  const seed = args.seed || 7;
  const url = `http://127.0.0.1:${PORT}/index.html?seed=${seed}&autostart=1&freeze=1&nosw=1${q === 'none' ? '' : '&q=' + q}${args.stats ? '&stats=1' : ''}${shots[0].env ? '&env=' + shots[0].env : ''}${args.params ? '&' + args.params : ''}`;
  await send('Page.navigate', { url });
  const t0 = Date.now();
  while (!(await evaluate('!!(window.__fpv && window.__fpv.ready)').catch(() => false))) {
    if (Date.now() - t0 > 60000) throw new Error('page never became ready');
    await sleep(200);
  }
  console.log(`ready in ${Date.now() - t0} ms — ${await evaluate("(()=>{const gl=__fpv.renderer.getContext();const d=gl.getExtension('WEBGL_debug_renderer_info');return d?gl.getParameter(d.UNMASKED_RENDERER_WEBGL):'?'})()")}`);

  if (args.test) {
    const src = readFileSync(args.test, 'utf8');
    const res = await evaluate(`(async () => { ${src} })()`);
    for (const r of res.results) console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.info ? '  — ' + r.info : ''}`);
    const bad = res.results.filter(r => !r.ok).length;
    console.log(`${res.results.length - bad}/${res.results.length} passed`);
    failures += bad;
    ws.close();
    return;
  }

  let curEnv = shots[0].env;
  for (const s of shots) {
    if (s.env && s.env !== curEnv) { await evaluate(`__fpv.setEnv(${JSON.stringify(s.env)})`); curEnv = s.env; }
    if (s.q) await evaluate(`__fpv.setQuality(${JSON.stringify(s.q)})`);
    if (s.pose) await evaluate(`__fpv.setPose(${s.pose.join(',')})`);
    if (s.eval) await evaluate(s.eval);
    await sleep(s.wait ?? 2500);
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    const file = join(OUT, `${s.name}.png`);
    writeFileSync(file, Buffer.from(shot.result.data, 'base64'));
    console.log(`  saved ${file}`);
  }
  ws.close();
}

main().catch(e => { console.error('FAILED:', e.message); failures++; }).finally(() => {
  chrome.kill('SIGKILL'); server.kill('SIGKILL');
  process.exit(failures ? 1 : 0);
});
