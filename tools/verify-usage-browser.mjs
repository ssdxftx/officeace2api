#!/usr/bin/env node
/** Real Chromium UI checks, using CDP and Node built-ins only. No package install. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createUsageFixture } from './usage-fixture.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = (name) => args.includes(name) ? args[args.indexOf(name) + 1] : '';
const liveRoot = option('--live-root');
const chrome = option('--browser') || ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find((p) => fs.existsSync(p));
if (!chrome) { console.log('SKIP: specify an installed Chromium executable using --browser'); process.exit(2); }
const out = path.join(ROOT, 'out', 'usage-review-' + new Date().toISOString().replace(/[:.]/g, '-'));
fs.mkdirSync(out, { recursive: true });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'o2a-usage-browser-'));
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let fixture, base, token;
if (liveRoot) {
  base = option('--base') || 'http://127.0.0.1:7864';
  assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/);
  const health = await (await fetch(base + '/healthz')).json();
  assert.equal(path.resolve(health.root).toLowerCase(), path.resolve(liveRoot).toLowerCase(), 'live root must match the running service');
  token = JSON.parse(fs.readFileSync(path.join(liveRoot, 'config.json'), 'utf8')).admin.token;
} else {
  fixture = await createUsageFixture(); base = fixture.base; token = fixture.token;
}
const portServer = net.createServer();
await new Promise((resolve) => portServer.listen(0, '127.0.0.1', resolve));
const debugPort = portServer.address().port;
await new Promise((resolve) => portServer.close(resolve));
const child = spawn(chrome, ['--headless=new', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=' + debugPort,
  '--user-data-dir=' + profile, '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-features=Translate',
  '--window-size=1680,1080', 'about:blank'], { stdio: 'ignore', windowsHide: true });
let childError;
child.on('error', (err) => { childError = err; });
let socket, seq = 0;
const pending = new Map(), exceptions = [], tests = [];
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++seq;
  const timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP timeout: ' + method)); }, 15000);
  pending.set(id, { resolve, reject, timer });
  socket.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
};
const until = async (expression, label = expression) => {
  for (let i = 0; i < 100; i++) { if (await evaluate(expression)) return; await wait(100); }
  throw new Error('UI wait timeout: ' + label);
};
const record = (name, condition) => { assert.ok(condition, name); tests.push(name); console.log('PASS ' + name); };
const setSelect = async (selector, value) => evaluate(`(() => { const el=document.querySelector(${JSON.stringify(selector)}); el.value=${JSON.stringify(value)}; el.dispatchEvent(new Event('change',{bubbles:true})); })()`);
const click = async (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
const screenshot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.writeFileSync(path.join(out, name), Buffer.from(r.data, 'base64'));
};
try {
  let target;
  for (let i = 0; i < 150; i++) {
    if (childError) throw childError;
    try { target = (await (await fetch('http://127.0.0.1:' + debugPort + '/json/list')).json()).find((t) => t.type === 'page'); if (target) break; } catch { /* startup */ }
    await wait(100);
  }
  assert.ok(target, 'Chromium CDP starts');
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  socket.onmessage = (e) => {
    const message = JSON.parse(e.data);
    if (message.id) {
      const p = pending.get(message.id); if (!p) return;
      clearTimeout(p.timer); pending.delete(message.id);
      if (message.error) p.reject(new Error(message.error.message)); else p.resolve(message.result || {});
    } else if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
  };
  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1680, height: 1080, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: base + '/admin/?token=' + encodeURIComponent(token) + '#usage' });
  await until('typeof U !== "undefined" && U !== null', 'initial usage query');
  const initial = await evaluate('({count:U.page.total,cards:document.querySelectorAll("#usCards .card").length,models:Object.keys(U.byModel),keyLabels:[...document.querySelectorAll("#usKey option")].map(o=>o.textContent)})');
  record('five metric cards render with real query data', initial.cards === 5);
  if (!liveRoot) record('fixture API requests exclude model probes', initial.count === 80);
  record('usage key selectors show masked labels', initial.keyLabels.every((s) => !s.includes('sk-fixture')));
  record('URL access token is removed after login', await evaluate('!location.search.includes("token")'));
  record('TTFT and latency cards are present', await evaluate('document.querySelectorAll(".us-perf").length === 4'));
  await screenshot(liveRoot ? 'usage-live-desktop.png' : 'usage-test-desktop.png');
  await click('#usMetric [data-metric="tokens"]');
  record('Tokens chart switches units and legends', await evaluate('document.querySelector("#usLegend").textContent.includes("输入") && document.querySelector("#usLegend").textContent.includes("输出")'));
  await click('#usMetric [data-metric="cached_tokens"]');
  record('cache chart uses cached input Tokens', await evaluate('document.querySelector("#usLegend").textContent.includes("缓存输入")'));
  await click('#usMetric [data-metric="requests"]');
  if (initial.models.length) {
    await setSelect('#usModel', initial.models[0]);
    await until('U && Object.keys(U.byModel).length <= 1');
    record('model filter applies to cards and request rows', await evaluate('U.recent.every(r=>r.model===usageFilter.model) && Object.values(U.byModel).reduce((n,m)=>n+m.requests,0)===U.totals.requests'));
  }
  await click('#usReset'); await until('U && usageFilter.model === "" && usageFilter.source === "proxy"');
  await setSelect('#usSource', 'probe'); await until('U && usageFilter.source === "probe"');
  record('probe source has separate requests', await evaluate('U.recent.every(r=>r.source==="probe")'));
  if (!liveRoot) record('three isolated fixture probes', await evaluate('U.page.total === 3'));
  await click('#usReset'); await until('U && usageFilter.source === "proxy"');
  await click('#callFilter [data-f="cancelled"]'); await until('U && usageFilter.outcome === "cancelled"');
  record('cancelled filter excludes failures', await evaluate('U.totals.failed===0 && U.recent.every(r=>r.outcome==="cancelled")'));
  await click('#usReset'); await until('U && usageFilter.outcome === "all"');
  await setSelect('#callPageSize', '25'); await until('U && U.page.limit === 25');
  if (initial.count > 25) {
    const firstIds = await evaluate('U.recent.map(r=>r.requestId)');
    await click('#callNext'); await until('U && U.page.offset === 25');
    const secondIds = await evaluate('U.recent.map(r=>r.requestId)');
    record('pagination loads another non-overlapping page', secondIds.every((id) => !firstIds.includes(id)));
    await click('#callPrev'); await until('U && U.page.offset === 0');
  }
  if (initial.count > 0) {
    await click('#callBody details summary');
    await evaluate('loadUsage()');
    record('request details remain open across refresh', await evaluate('document.querySelectorAll("#callBody details[open]").length === 1'));
  }
  await setSelect('#usRange', 'custom'); await until('U && usageFilter.range === "custom"');
  await evaluate('document.querySelector("#usFrom").value="2026-11-05";document.querySelector("#usTo").value="2026-11-01";changeUsageFilters();');
  record('invalid dates clear stale statistics and show validation', await evaluate('U===null && usageError.includes("开始日期")'));
  await click('#usReset'); await until('U && usageFilter.range === "7d"');
  const exported = await evaluate('(async()=>{ const r=await fetch("/admin/api/usage/export.csv?"+usageParams(false),{headers:H()}); const s=await r.text(); return {status:r.status,count:Number(r.headers.get("X-Usage-Records")),csv:s.includes("请求 ID")}; })()');
  record('CSV endpoint exports the selected dataset', exported.status === 200 && exported.csv);
  if (!liveRoot) record('CSV includes all filtered records, not one page', exported.count === 80);
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await evaluate('window.scrollTo(0,0)'); await wait(150);
  await screenshot(liveRoot ? 'usage-live-mobile.png' : 'usage-test-mobile.png');
  record('390px mobile layout has no document-level horizontal overflow', await evaluate('document.documentElement.scrollWidth <= window.innerWidth + 2'));
  await setSelect('#usRange', 'custom'); await until('U || usageError');
  record('mobile custom date controls stay within viewport', await evaluate('document.documentElement.scrollWidth <= window.innerWidth + 2'));
  await click('#usReset'); await until('U && usageFilter.range === "7d"');
  record('no JavaScript runtime exceptions', exceptions.length === 0);
  fs.writeFileSync(path.join(out, 'browser-checks.json'), JSON.stringify({ mode: liveRoot ? 'live-readonly' : 'isolated-fixture', base, checks: tests, exceptions, screenshots: fs.readdirSync(out).filter((f) => f.endsWith('.png')) }, null, 2));
  console.log('RESULT ' + JSON.stringify({ pass: tests.length, out }));
} catch (err) {
  if (socket?.readyState === WebSocket.OPEN) await screenshot('failure.png').catch(() => {});
  fs.writeFileSync(path.join(out, 'browser-checks.json'), JSON.stringify({ checks: tests, exceptions, error: err.message }, null, 2));
  console.error(err.stack); console.error('ARTIFACTS ' + out); process.exitCode = 1;
} finally {
  if (socket?.readyState === WebSocket.OPEN) { await send('Browser.close').catch(() => {}); socket.close(); }
  child.kill();
  if (fixture) await fixture.close();
  // Verify this is exactly the temporary profile created by this process before deleting it.
  const resolved = path.resolve(profile);
  if (path.dirname(resolved) === path.resolve(os.tmpdir()) && path.basename(resolved).startsWith('o2a-usage-browser-')) {
    await wait(250);
    try { fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* browser can release locks asynchronously */ }
  }
}
