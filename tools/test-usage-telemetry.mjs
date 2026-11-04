#!/usr/bin/env node
/**
 * 请求级用量遥测回归：本地 mock 上游 + createApp + 只捕获 record 的 UsageStore 存根。
 * 不加载 config / stats，不读写 data，不连接正在运行的实例或外网。
 * 跑：node tools/test-usage-telemetry.mjs
 */

import http from 'node:http';
import { EventEmitter } from 'node:events';
import { createApp } from '../src/server.mjs';
import { CredentialPool } from '../src/pool.mjs';
import { ModelRegistry } from '../src/models.mjs';
import { createChatAccumulator, createSseDecoder } from '../src/upstream.mjs';

let pass = 0;
let fail = 0;
function check(name, actual, expected) {
  if (Object.is(actual, expected)) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}  期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  }
}
async function test(name, fn) {
  console.log(`\n【${name}】`);
  try { await fn(); }
  catch (err) { fail += 1; console.error(`  ✗ ${err.stack || err}`); }
}
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}
async function bounded(promise, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timeout`)), 6000); }),
    ]);
  } finally { clearTimeout(timer); }
}
function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}
async function close(server) {
  if (!server?.listening) return;
  const stopped = new Promise((resolve) => server.close(resolve));
  server.closeAllConnections?.();
  await stopped;
}
const frame = (value) => `data: ${JSON.stringify(value)}\n\n`;
function head(res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  res.flushHeaders();
}
function chunk(res, delta = {}, extra = {}) {
  res.write(frame({ choices: [{ index: 0, delta, finish_reason: null }], ...extra }));
}
function finish(res, usage = { prompt_tokens: 10, completion_tokens: 60, total_tokens: 70 }) {
  res.write(frame({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], ...(usage ? { usage } : {}) }));
  res.end('data: [DONE]\n\n');
}
function success(res, usage) {
  head(res);
  chunk(res, { role: 'assistant', content: 'Hello' });
  finish(res, usage);
}
function rejectUpstream(res, status = 503, code = 'MOCK_BUSY') {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { code, message: status === 429 ? 'rate limited' : 'mock upstream busy' } }));
}

async function fixture(script, options, run) {
  const records = [];
  const changes = new EventEmitter();
  const calls = [];
  const requestIds = [];
  const timers = new Set();
  const upstreamErrors = [];
  const after = (res, ms, fn) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (!res.destroyed) fn();
    }, ms);
    timers.add(timer);
    res.once('close', () => { clearTimeout(timer); timers.delete(timer); });
  };
  const upstream = http.createServer(async (req, res) => {
    try {
      const bytes = [];
      for await (const value of req) bytes.push(value);
      const body = JSON.parse(Buffer.concat(bytes).toString('utf8'));
      calls.push({ body, at: Date.now() });
      await script({ req, res, body, call: calls.length, after });
    } catch (err) {
      upstreamErrors.push(String(err.stack || err));
      res.destroy();
    }
  });
  let app;
  try {
    const upstreamPort = await listen(upstream);
    const config = {
      listen: { host: '127.0.0.1', port: 0 },
      apiKeys: ['sk-telemetry-test'],
      admin: { enabled: false, token: 'test-admin' },
      upstream: {
        maxRetries: options.maxRetries ?? 1,
        retryBackoffMs: 1,
        timeoutSeconds: 30,
        earlyHeaderMs: options.earlyHeaderMs ?? 0,
        includeUsage: true,
      },
      models: {
        alias: { public: 'model-a' }, extra: ['model-a', 'model-b'], hidden: [],
        minMaxTokens: 0, maxMaxTokens: 0,
        fallback: options.fallback ? { public: ['model-b'] } : {},
      },
    };
    const pool = new CredentialPool({ maxInFlightPerCredential: 1, queueTimeoutMs: 1000, stateFile: '' });
    if (options.credential !== false) {
      pool.add({
        baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
        headers: { Authorization: 'Bearer mock-only' },
        accountId: 'acct-mock', userId: 'user-mock', source: 'telemetry-test',
      });
    }
    if (options.acquireDelay) {
      const acquire = pool.acquire.bind(pool);
      pool.acquire = async (...args) => { await delay(options.acquireDelay); return acquire(...args); };
    }
    // 明确只实现 record：无需另一 agent 正在修改的 UsageStore。
    const usage = { record(entry) { records.push(structuredClone(entry)); changes.emit('record'); } };
    app = createApp({
      config, pool, registry: new ModelRegistry(config.models), usage,
      accounts: { get: () => null }, startedAt: Date.now(), version: 'telemetry-test',
      requestRediscover: () => {},
    });
    app.server.on('request', (_req, res) => requestIds.push(res.getHeader('X-Request-Id')));
    const base = `http://127.0.0.1:${await listen(app.server)}`;
    const headers = { Authorization: 'Bearer sk-telemetry-test', 'Content-Type': 'application/json' };
    const request = (body = {}, extra = {}) => fetch(`${base}${extra.endpoint || '/v1/chat/completions'}`, {
      method: 'POST', headers: { ...headers, ...extra.headers }, signal: extra.signal,
      body: JSON.stringify({ model: 'public', messages: [{ role: 'user', content: 'telemetry' }], stream: true, ...body }),
    });
    const chat = async (body, extra) => {
      const res = await request(body, extra);
      return { res, text: await res.text() };
    };
    const record = async () => {
      if (!records.length) await bounded(new Promise((resolve) => changes.once('record', resolve)), 'record');
      // 让响应收尾的 promise 回调也走完，抓重复记录而不是只认第一条。
      await new Promise((resolve) => setImmediate(resolve));
      return records.at(-1);
    };
    const verify = async ({ outcome = 'ok', attemptCount = calls.length, model = 'model-a' } = {}) => {
      const row = await record();
      check('一个 client request 只落一条', records.length, 1);
      check('requestId 对应 HTTP 请求', row.requestId, requestIds[0]);
      check('requestedModel 保留别名', row.requestedModel, 'public');
      check('resolvedModel 是实际路由', row.resolvedModel, model);
      check('model 与 resolvedModel 一致', row.model, model);
      check('outcome', row.outcome, outcome);
      check('ok 只表示成功', row.ok, outcome === 'ok');
      check('attemptCount 是实际尝试数', row.attemptCount, attemptCount);
      check('queueMs 是非负观测值', Number.isFinite(row.queueMs) && row.queueMs >= 0, true);
      check('耗时包含 acquire 等待', row.latencyMs >= row.queueMs, true);
      check('所有在途计数均已归还', pool.list().every((c) => c.inFlight === 0), true);
      return row;
    };
    await run({ app, base, headers, pool, records, calls, config, request, chat, record, verify });
    check('mock 上游无测试异常', upstreamErrors.length, 0);
  } finally {
    for (const timer of timers) clearTimeout(timer);
    await close(app?.server);
    await close(upstream);
  }
}

await test('1 accumulator：role / usage / heartbeat / 空工具骨架不是首内容', () => {
  const realNow = Date.now;
  let now = 1000;
  Date.now = () => now;
  try {
    const acc = createChatAccumulator('model-a');
    const decoder = createSseDecoder();
    acc.push(decoder.push(Buffer.from(': ping\n\n')));
    check('心跳不设置 firstDataAt', acc.state.firstDataAt, 0);
    acc.push([{ data: { choices: [{ delta: { role: 'assistant', content: '' } }] } }]);
    check('firstDataAt 保留旧首帧语义', acc.state.firstDataAt, 1000);
    now = 1100;
    acc.push([{ data: { choices: [], usage: { completion_tokens: 9 } } }]);
    acc.push([{ data: { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-0', type: 'function', function: { name: '', arguments: '' } }] } }] } }]);
    check('元数据不设置首内容', acc.state.firstContentAt, 0);
    now = 1300;
    acc.push([{ data: { choices: [{ delta: { reasoning_content: 'think' } }] } }]);
    check('reasoning_content 设置首内容', acc.state.firstContentAt, 1300);
    now = 1800;
    acc.push([{ data: { choices: [{ delta: { content: 'answer' } }] } }]);
    check('后续正文不重置首内容', acc.state.firstContentAt, 1300);
    check('旧 firstDataAt 未改变', acc.state.firstDataAt, 1000);
    for (const [name, delta] of [
      ['正文', { content: 'x' }], ['reasoning', { reasoning: 'r' }],
      ['工具函数名', { tool_calls: [{ index: 0, function: { name: 'weather' } }] }],
      ['工具参数', { tool_calls: [{ index: 0, function: { arguments: '{' } }] }],
      ['旧 function_call', { function_call: { arguments: '{' } }],
    ]) {
      const next = createChatAccumulator();
      next.push([{ data: { choices: [{ index: 1, delta }] } }]);
      check(`${name}（含非零 choice）也是有效首内容`, next.state.firstContentAt, 1800);
    }
    const error = createChatAccumulator();
    error.push([{ data: { error: { message: 'mock' }, usage: { completion_tokens: 3 } } }]);
    check('错误帧不设置首内容', error.state.firstContentAt, 0);
    check('错误同帧 usage 保留', error.state.usage.completion_tokens, 3);
  } finally { Date.now = realNow; }
});

await test('2 流式成功：响应头、heartbeat、role、usage 都早于有效内容', () => fixture(({ res, after }) => {
  head(res);
  res.write(': upstream heartbeat\n\n');
  after(res, 40, () => chunk(res, { role: 'assistant', content: '' }));
  after(res, 80, () => res.write(frame({ choices: [], usage: { completion_tokens: 1 } })));
  after(res, 200, () => chunk(res, { content: 'Hello' }));
  after(res, 500, () => finish(res));
}, { earlyHeaderMs: 10 }, async (f) => {
  const r = await f.chat();
  check('流式 HTTP 200', r.res.status, 200);
  check('本地保活心跳已发出', r.text.includes(': ping'), true);
  check('正文与 DONE 保留', r.text.includes('Hello') && r.text.includes('[DONE]'), true);
  const row = await f.verify();
  check('TTFT 等到内容而非首帧', row.ttftMs >= 180, true);
  check('TTFT 小于总耗时', row.ttftMs < row.latencyMs, true);
  check('有效窗口大于 200ms 才有 TPS', row.tps > 0, true);
  check('TPS 使用首内容后的窗口', row.tps, Math.round(60000 / (row.latencyMs - row.ttftMs)));
  check('无重试的失败链为空', row.attempts.length, 0);
}));

await test('3 非流式 TTFT/TPS 始终 null；兼容 /v1/completions', () => fixture(({ res, after }) => {
  head(res);
  chunk(res, { content: 'Hello' });
  after(res, 280, () => finish(res));
}, {}, async (f) => {
  const r = await f.chat({ stream: false, prompt: 'test' }, { endpoint: '/v1/completions' });
  check('非流式 JSON 内容正确', JSON.parse(r.text).choices[0].message.content, 'Hello');
  const row = await f.verify();
  check('非流式 ttftMs=null', row.ttftMs, null);
  check('非流式 tps=null', row.tps, null);
  check('保留 endpoint', row.endpoint, '/v1/completions');
  check('原始 usage 保留', row.usage.completion_tokens, 60);
}));

await test('4 首块即末块 TPS=null，HTTP 开始时钟包含慢请求体', () => fixture(({ res }) => success(res), {}, async (f) => {
  const data = JSON.stringify({ model: 'public', stream: true, messages: [{ role: 'user', content: 'slow body' }] });
  const response = await bounded(new Promise((resolve, reject) => {
    const req = http.request(`${f.base}/v1/chat/completions`, {
      method: 'POST', headers: { ...f.headers, 'Content-Length': Buffer.byteLength(data) },
    }, (res) => {
      res.resume();
      res.on('end', () => resolve(res));
    });
    req.on('error', reject);
    req.write(data.slice(0, 20));
    setTimeout(() => req.end(data.slice(20)), 150);
  }), 'slow request body');
  check('慢请求体仍成功', response.statusCode, 200);
  const row = await f.verify();
  check('TTFT 包含读请求体的时间', row.ttftMs >= 130, true);
  check('不足有效窗口的 TPS 留 null', row.tps, null);
}));

await test('5 只有 role/usage 的流不虚构 TTFT/TPS', () => fixture(({ res, after }) => {
  head(res); chunk(res, { role: 'assistant', content: '' });
  after(res, 240, () => finish(res));
}, {}, async (f) => {
  await f.chat();
  const row = await f.verify();
  check('无有效内容 ttftMs=null', row.ttftMs, null);
  check('usage 有输出 token 也不虚构 TPS', row.tps, null);
}));

for (const reset of [false, true]) {
  await test(`6 上游${reset ? 'RST' : '无结束标记 EOF'}：失败也保留首内容与 usage`, () => fixture(({ res, after }) => {
    head(res); chunk(res, { role: 'assistant' });
    after(res, 30, () => chunk(res, { content: 'partial' }, { usage: { prompt_tokens: 5, completion_tokens: 12, total_tokens: 17 } }));
    after(res, 300, () => reset ? res.destroy() : res.end());
  }, {}, async (f) => {
    const r = await f.chat();
    check('下游收到补充错误帧', r.text.includes('UPSTREAM_TRUNCATED'), true);
    const row = await f.verify({ outcome: 'failed' });
    check('断流错误码', row.errorCode, 'UPSTREAM_TRUNCATED');
    check('断流已知 usage 保留', row.usage.completion_tokens, 12);
    check('断流 TTFT 可观测', row.ttftMs >= 20, true);
    check('断流有效窗口 TPS 可观测', row.tps > 0, true);
    check('最终失败尝试已记录', row.attempts.length, 1);
    check('失败记录关联账号', row.accountId, 'acct-mock');
    check('真实上游断流才罚账号', f.pool.list()[0].fail, 1);
  }));
}

await test('7 流内错误：错误与 usage 同帧，不能记成功', () => fixture(({ res, after }) => {
  head(res); chunk(res, { role: 'assistant' });
  after(res, 20, () => chunk(res, { content: 'partial' }));
  after(res, 260, () => {
    res.write(frame({ error: { code: 'ModelArts.81111', message: 'rate limited' }, usage: { completion_tokens: 7 } }));
    res.end('data: [DONE]\n\n');
  });
}, {}, async (f) => {
  await f.chat();
  const row = await f.verify({ outcome: 'failed' });
  check('流内错误码', row.errorCode, 'ModelArts.81111');
  check('流内错误同帧 usage', row.usage.completion_tokens, 7);
  check('流内失败链包含当前尝试', row.attempts[0].model, 'model-a');
  check('流内错误非取消', row.status, 200);
}));

await test('8 重试成功：attemptCount 包括成功一发，queueMs 累计而非退避时间', () => fixture(({ res, call }) => {
  if (call === 1) rejectUpstream(res); else success(res);
}, { maxRetries: 2, acquireDelay: 35 }, async (f) => {
  await f.chat();
  const row = await f.verify({ attemptCount: 2 });
  check('上游实际打了两次', f.calls.length, 2);
  check('成功记录保留失败链', row.attempts.length, 1);
  check('失败链关联模型', row.attempts[0].model, 'model-a');
  check('失败链第一次编号', row.attempts[0].attempt, 1);
  check('acquire 等待已累计', row.queueMs >= 60, true);
  check('没有把上游/退避算进 queueMs', row.queueMs < row.latencyMs, true);
}));

await test('9 非流式部分用量重试：尝试 usage 和终态 usage 分开', () => fixture(({ res, call, after }) => {
  if (call > 1) { success(res, { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 }); return; }
  head(res); chunk(res, { content: 'discarded' }, { usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 } });
  after(res, 20, () => res.end());
}, { maxRetries: 2 }, async (f) => {
  await f.chat({ stream: false });
  const row = await f.verify({ attemptCount: 2 });
  check('最终 usage 不跨尝试相加', row.usage.completion_tokens, 4);
  check('已知重试消耗单独保留', row.attempts[0].usage.completion_tokens, 3);
  check('聚合重试仍无 TTFT', row.ttftMs, null);
  check('聚合重试仍无 TPS', row.tps, null);
}));

await test('10 fallback 内也重试：整串只记录一条，计数和模型连续', () => {
  let fallbackCalls = 0;
  return fixture(({ res, body }) => {
    if (body.model === 'model-a') rejectUpstream(res, 429, 'ModelArts.81111');
    else if (++fallbackCalls === 1) rejectUpstream(res);
    else success(res);
  }, { maxRetries: 2, fallback: true, acquireDelay: 25 }, async (f) => {
    const r = await f.chat();
    check('fallback 响应头保留', r.res.headers.get('x-fallback-model'), 'model-b');
    const row = await f.verify({ attemptCount: 4, model: 'model-b' });
    check('整个串实际请求数', f.calls.length, 4);
    check('保留三条失败链', row.attempts.length, 3);
    check('fallback 尝试编号连续', row.attempts.map((a) => a.attempt).join(','), '1,2,3');
    check('尝试对应每次实际模型', row.attempts.map((a) => a.model).join(','), 'model-a,model-a,model-b');
    check('跨模型 acquire 累计', row.queueMs >= 80, true);
    check('TTFT 包含 fallback 前全部等待', row.ttftMs >= row.queueMs, true);
  });
});

await test('11 fallback 最终失败也只一条记录', () => fixture(({ res }) => rejectUpstream(res), {
  fallback: true,
}, async (f) => {
  const r = await f.chat({ stream: false });
  check('fallback 最终错误响应', r.res.status, 502);
  const row = await f.verify({ outcome: 'failed', model: 'model-b', attemptCount: 2 });
  check('两模型失败链都在', row.attempts.map((a) => a.model).join(','), 'model-a,model-b');
  check('失败非流式 ttftMs=null', row.ttftMs, null);
  check('失败非流式 tps=null', row.tps, null);
}));

for (const stage of ['connect', 'prime', 'http-error-body']) {
  await test(`12 取消 ${stage}：不重试、不罚账号、只记录 cancelled`, () => fixture(({ res }) => {
    if (stage === 'prime') { head(res); res.write(': waiting\n\n'); }
    if (stage === 'http-error-body') {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.flushHeaders(); res.write('{"error":');
    }
  }, { maxRetries: 2, earlyHeaderMs: 20 }, async (f) => {
    const ac = new AbortController();
    const r = await f.request({}, { signal: ac.signal });
    await r.body.getReader().read(); // 等下游保活头/心跳，证明 runCompletion 已开始。
    ac.abort();
    const row = await f.verify({ outcome: 'cancelled', attemptCount: 1 });
    check('取消使用独立状态', row.status, 499);
    check('取消不罚账号', f.pool.list()[0].fail, 0);
    check('取消前无有效内容 TTFT=null', row.ttftMs, null);
    check('未知 usage 不伪造', row.usage, null);
    check('取消不触发重试', f.calls.length, 1);
  }));
}

await test('13 流式内容后取消：已知 usage、TTFT 和耗时保留', () => fixture(({ res, after }) => {
  head(res); chunk(res, { role: 'assistant' });
  after(res, 30, () => chunk(res, { content: 'partial' }));
  after(res, 300, () => res.write(frame({ choices: [], usage: { prompt_tokens: 9, completion_tokens: 11, total_tokens: 20 } })));
}, {}, async (f) => {
  const ac = new AbortController();
  const r = await f.request({}, { signal: ac.signal });
  const reader = r.body.getReader();
  let text = '';
  while (!text.includes('total_tokens')) {
    const item = await bounded(reader.read(), 'partial usage');
    if (item.done) throw new Error('mock stream ended before cancellation');
    text += Buffer.from(item.value).toString();
  }
  ac.abort();
  const row = await f.verify({ outcome: 'cancelled' });
  check('取消保留 usage', row.usage.completion_tokens, 11);
  check('取消保留有效 TTFT', row.ttftMs >= 20, true);
  check('取消保留耗时', row.latencyMs >= 280, true);
  check('取消有足够窗口仍可观测 TPS', row.tps > 0, true);
  check('取消不罚账号', f.pool.list()[0].fail, 0);
}));

await test('14 非流式聚合取消：保留 usage，但 TTFT/TPS 仍 null', () => {
  const sent = deferred();
  return fixture(({ res }) => {
    head(res); chunk(res, { content: 'partial' }, { usage: { completion_tokens: 5 } }); sent.resolve();
  }, {}, async (f) => {
    const ac = new AbortController();
    const pending = f.chat({ stream: false }, { signal: ac.signal }).catch(() => null);
    await bounded(sent.promise, 'aggregate start');
    await delay(80); ac.abort(); await pending;
    const row = await f.verify({ outcome: 'cancelled' });
    check('聚合取消保留真实 usage', row.usage.completion_tokens, 5);
    check('聚合取消 TTFT=null', row.ttftMs, null);
    check('聚合取消 TPS=null', row.tps, null);
    check('聚合取消不罚账号', f.pool.list()[0].fail, 0);
  });
});

await test('15 finish_reason 后 close 是成功，而非取消', () => fixture(({ res, after }) => {
  head(res); chunk(res, { content: 'complete' });
  after(res, 30, () => res.write(frame({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })));
  // 故意不送 usage / [DONE]；模拟 DSH 读到 finish_reason 后主动结束。
}, {}, async (f) => {
  const ac = new AbortController();
  const r = await f.request({}, { signal: ac.signal });
  const reader = r.body.getReader();
  let text = '';
  while (!text.includes('"finish_reason":"stop"')) {
    const item = await bounded(reader.read(), 'finish_reason');
    text += Buffer.from(item.value).toString();
  }
  ac.abort();
  const row = await f.verify();
  check('完成后 close 的状态是成功', row.status, 200);
  check('未等到 usage 仍保留未知', row.usage, null);
  check('完成后 close 不罚账号', f.pool.list()[0].fail, 0);
  check('完成后 close 标记账号成功', f.pool.list()[0].ok, 1);
}));

for (const cancel of [false, true]) {
  await test(`16 真实池满排队${cancel ? '时取消，上游次数为零' : '后成功，调度不变'}`, () => fixture(({ res }) => success(res), {
    earlyHeaderMs: 15,
  }, async (f) => {
    const held = f.pool.pick('model-a', { trackInFlight: true });
    const ac = new AbortController();
    const pending = f.chat({}, { signal: ac.signal }).catch(() => null);
    await delay(60);
    if (cancel) ac.abort();
    await delay(90);
    f.pool.release(held);
    await pending;
    const row = await f.verify({ outcome: cancel ? 'cancelled' : 'ok', attemptCount: cancel ? 0 : 1 });
    check('实际 acquire 等待已记录', row.queueMs >= 150, true);
    check('queueWaits 调度器仍工作', f.pool.stats().queueWaits, 1);
    check('取消排队不发上游请求', f.calls.length, cancel ? 0 : 1);
    check('排队路径不罚账号', f.pool.list()[0].fail, 0);
  }));
}

await test('17 池空失败也有完整元数据，实际尝试次数为零', () => fixture(() => {}, {
  credential: false,
}, async (f) => {
  const r = await f.chat();
  check('池空 HTTP 503', r.res.status, 503);
  const row = await f.verify({ outcome: 'failed', attemptCount: 0 });
  check('池空错误码', row.errorCode, 'no_credential');
  check('池空 TTFT=null', row.ttftMs, null);
  check('池空 TPS=null', row.tps, null);
}));

await test('18 非流式无 usage 时不把聚合默认零当成真实计量', () => fixture(({ res }) => success(res, null), {}, async (f) => {
  const r = await f.chat({ stream: false });
  check('兼容响应依然给默认 usage', JSON.parse(r.text).usage.total_tokens, 0);
  const row = await f.verify();
  check('统计里的未知 usage 为 null', row.usage, null);
}));

await test('19 前置鉴权/模型校验不扩大统计边界', () => fixture(({ res }) => success(res), {}, async (f) => {
  const a = await f.chat({}, { headers: { Authorization: 'Bearer wrong' } });
  check('前置鉴权 HTTP 401', a.res.status, 401);
  const b = await f.chat({ model: 'missing-model' });
  check('前置模型校验 HTTP 404', b.res.status, 404);
  check('没有调用 record', f.records.length, 0);
  check('没有访问上游', f.calls.length, 0);
}));

console.log(`\n═══ 结果：${pass} 通过 / ${fail} 失败 ═══`);
process.exit(fail ? 1 : 0);
