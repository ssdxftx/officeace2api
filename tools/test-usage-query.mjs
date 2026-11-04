#!/usr/bin/env node
/** 用量查询回归：仅原生 assert + 临时目录；runner 自动发现，无真实服务/账号依赖。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { UsageStore, usageDayKey, classifyUsageError } from '../src/stats.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'o2a-usage-query-'));
const canonicalRoot = fs.realpathSync(root);
const stores = [];
const BASE = new Date(2026, 2, 12, 12).getTime();
const local = (day, hour = 12, minute = 0, second = 0, ms = 0) => new Date(2026, 2, day, hour, minute, second, ms).getTime();
const iso = (ms) => new Date(ms).toISOString();
const keyA = 'unit-key-a-1234';
const keyB = 'unit-key-b-5678';
const keyId = (key) => `key_${createHash('sha256').update(key).digest('hex').slice(0, 16)}`;
const emptyMetric = { count: 0, p50: null, p95: null, avg: null };
const counters = ['requests', 'ok', 'failed', 'cancelled', 'prompt_tokens', 'completion_tokens', 'total_tokens', 'cached_tokens', 'attempts', 'attemptKnownRequests', 'usageKnownRequests'];
let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (err) { failed += 1; console.error(`  ✗ ${name}\n${err.stack}`); }
}
function store(options = {}) {
  const result = new UsageStore({ now: () => BASE, flushMs: 60_000, ...options });
  stores.push(result);
  return result;
}
function add(s, id, options = {}) {
  return s.record({ ts: BASE, requestId: id, model: 'alias-a', requestedModel: 'requested-a', resolvedModel: 'model-a',
    accountId: 'acct-a', accountLabel: 'Account A', apiKey: keyA, ok: true, latencyMs: 100,
    usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 999 }, ...options });
}
function all(s, options = {}) { return s.query({ range: 'all', source: 'all', ...options }); }
function assertCounters(q, expected) {
  for (const [k, value] of Object.entries(expected)) assert.equal(q.totals[k], value, k);
  assert.equal(q.totals.requests, q.totals.ok + q.totals.failed + q.totals.cancelled);
  assert.equal(q.totals.total_tokens, q.totals.prompt_tokens + q.totals.completion_tokens);
  for (const field of ['byModel', 'byApiKey', 'byAccount', 'daily']) {
    for (const key of counters) assert.equal(Object.values(q[field]).reduce((sum, b) => sum + b[key], 0), q.totals[key], `${field}.${key}`);
  }
  assert.equal(Object.values(q.errors).reduce((sum, n) => sum + n, 0), q.totals.failed);
}
function legacyDocument() {
  return {
    since: iso(new Date(2025, 0, 1).getTime()),
    totals: { requests: 900, ok: 870, failed: 30, prompt_tokens: 10_000, completion_tokens: 2400, total_tokens: 17_500, cached_tokens: 321 },
    byModel: { old: { requests: 900, ok: 870, failed: 30, prompt_tokens: 10_000, completion_tokens: 2400, total_tokens: 17_500, avgLatencyMs: 91 } },
    byApiKey: { [keyA]: { requests: 450, total_tokens: 12_000 } },
    daily: { '2025-01-01': { requests: 55, ok: 53, failed: 2, prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } },
    errors: { '限流 429': 29, '其他': 1 },
    recent: [
      { ts: iso(BASE), model: 'old', ok: true, prompt_tokens: 10, completion_tokens: 2, cached_tokens: 3, latencyMs: 30, requestId: 'old-ok', attempts: [] },
      { ts: iso(local(11)), model: 'old', ok: false, prompt_tokens: null, completion_tokens: null, cached_tokens: 0, latencyMs: 0, error: 'client disconnected', requestId: 'old-cancel', attempts: [] },
      { ts: 'bad timestamp', model: 'old', ok: true, requestId: 'bad-ts' },
    ],
  };
}

try {
  test('空库响应契约、默认筛选、缺测性能和 snapshot 白名单', () => {
    const s = store();
    const q = s.query();
    assert.deepEqual(Object.keys(s.snapshot()).sort(), ['since', 'totals', 'byModel', 'byApiKey', 'recent', 'daily', 'errors'].sort());
    assertCounters(q, Object.fromEntries(counters.map((k) => [k, 0])));
    assert.equal(q.range.from, '2026-03-12');
    assert.equal(q.range.to, '2026-03-12');
    assert.deepEqual(q.page, { offset: 0, limit: 50, total: 0 });
    assert.deepEqual(q.facets, { models: [], accounts: [], apiKeys: [] });
    for (const name of ['ttftMs', 'latencyMs', 'queueMs', 'tps']) assert.deepEqual(q.performance[name], emptyMetric);
    assert.equal(q.coverage.limit, 10_000);
    assert.equal(q.coverage.retentionDays, 30);
    assert.equal(q.coverage.recordedSince, iso(BASE));
    assert.equal(q.coverage.earliestRecordAt, null);
    assert.equal(q.coverage.timeZone, Intl.DateTimeFormat().resolvedOptions().timeZone);
    assert.equal(q.coverage.partial, true); // 创建于中午，当日上午并非已采集的 0。
    assert.equal(all(s).coverage.partial, false);
    assert.equal(q.historicalTotals.requests, 0);
  });

  test('旧文件累计原值保留、recent 迁移与缺失字段不推算', () => {
    const file = path.join(root, 'legacy.json');
    const old = legacyDocument();
    const text = JSON.stringify(old);
    fs.writeFileSync(file, text);
    const s = store({ file });
    const snap = s.snapshot();
    assert.equal(snap.since, old.since);
    for (const [k, value] of Object.entries(old.totals)) assert.equal(snap.totals[k], value, k);
    for (const [k, value] of Object.entries(old.byModel.old)) assert.equal(snap.byModel.old[k], value, k);
    for (const [k, value] of Object.entries(old.daily['2025-01-01'])) assert.equal(snap.daily['2025-01-01'][k], value, k);
    assert.deepEqual(snap.errors, old.errors);
    assert.equal(snap.byApiKey[keyId(keyA)].requests, 450);
    assert.equal(snap.byApiKey[keyId(keyA)].total_tokens, 12_000);
    assert.equal(snap.byApiKey[keyId(keyA)].label, '••••1234');
    assert.equal(snap.totals.attempts, null);
    assert.equal(snap.totals.usageKnownRequests, null);
    assert.equal(fs.readFileSync(file, 'utf8'), text, '读取时不覆盖旧文件');
    const q = all(s);
    assertCounters(q, { requests: 2, ok: 1, failed: 0, cancelled: 1, total_tokens: 12, attempts: 0, usageKnownRequests: 1 });
    assert.equal(q.historicalTotals.requests, 900);
    assert.equal(q.historicalTotals.total_tokens, 17_500);
    assert.equal(q.coverage.partial, true);
    assert.match(q.coverage.message, /旧版.*recent/);
    assert.match(q.coverage.message, /1 条旧记录/);
    assert.equal(q.performance.ttftMs.count, 0);
    assert.equal(q.performance.latencyMs.count, 1);
    assert.equal(q.recent[1].latencyMs, null);
    assert.equal(q.recent[0].attemptCount, null);
    assert.equal(q.recent[0].apiKeyId, 'unknown', '不从累计 Key 桶猜历史请求身份');
    s.flush();
    const persisted = fs.readFileSync(file, 'utf8');
    assert.equal(persisted.includes(keyA), false);
    assert.equal(JSON.parse(persisted).history.length, 2);
    assert.equal(JSON.parse(persisted).historyCoverage.legacy, true);
    const reloaded = store({ file });
    assert.deepEqual(all(reloaded), q, '重启不复制 recent、不回填 unknown attempt/metrics');
    add(reloaded, 'after-upgrade');
    assert.equal(reloaded.snapshot().totals.requests, 901);
    assert.equal(all(reloaded).totals.requests, 3);
    reloaded.flush();
    const again = store({ file });
    assert.equal(again.snapshot().totals.requests, 901);
    assert.equal(all(again).totals.requests, 3);
    assert.equal(all(again).coverage.partial, true);
  });

  test('旧格式缺 daily/errors 时升级，超龄旧明细不影响累计', () => {
    const file = path.join(root, 'old-minimal.json');
    fs.writeFileSync(file, JSON.stringify({ totals: { requests: 7, ok: 7, failed: 0, total_tokens: 100 }, recent: [{ ts: '2020-01-01T00:00:00.000Z', ok: true, model: 'old' }] }));
    const s = store({ file });
    const q = all(s);
    assert.equal(q.totals.requests, 0);
    assert.equal(q.historicalTotals.requests, 7);
    assert.deepEqual(s.snapshot().daily, {});
    assert.deepEqual(s.snapshot().errors, {});
    assert.equal(q.coverage.partial, true);
    assert.match(q.coverage.message, /时间窗口/);
    assert.equal(q.coverage.earliestRecordAt, null);
  });

  test('本地午夜和整日闭区间：to 的下一天 00:00 被排除', () => {
    const s = store();
    add(s, 'before', { ts: local(11, 23, 59, 59, 999) });
    add(s, 'start', { ts: local(12, 0) });
    add(s, 'end', { ts: local(12, 23, 59, 59, 999) });
    add(s, 'after', { ts: local(13, 0) });
    assert.equal(s.query().totals.requests, 2);
    const q = s.query({ range: 'custom', from: '2026-03-12', to: '2026-03-12' });
    assert.deepEqual(q.recent.map((r) => r.requestId), ['end', 'start']);
    assert.deepEqual(Object.keys(q.daily), ['2026-03-12']);
    assert.equal(q.daily['2026-03-12'].completed, 2);
    assert.equal(s.query({ now: new Date(local(11, 20)) }).totals.requests, 1);
    assert.equal(s.query({ range: 'custom', from: '2026-03-13', to: '2026-03-13' }).totals.requests, 1);
  });

  test('today/7d/30d/all/custom 使用相同保留明细和自然日边界', () => {
    const s = store();
    add(s, 'outside-30d', { ts: new Date(2026, 1, 10, 23, 59, 59, 999).getTime() });
    add(s, 'at-30d', { ts: new Date(2026, 1, 11, 0).getTime() });
    add(s, 'before-7d', { ts: local(5, 23, 59, 59, 999) });
    add(s, 'at-7d', { ts: local(6, 0) });
    add(s, 'yesterday', { ts: local(11) });
    add(s, 'today', { ts: local(12) });
    assert.equal(s.query().totals.requests, 1);
    assert.equal(s.query({ range: '7d' }).totals.requests, 3);
    assert.equal(s.query({ range: '7d' }).range.from, '2026-03-06');
    assert.equal(s.query({ range: '30d' }).totals.requests, 5);
    assert.equal(s.query({ range: '30d' }).range.from, '2026-02-11');
    assert.equal(all(s).totals.requests, 5);
    assert.equal(s.query({ range: 'custom', from: '2026-03-05', to: '2026-03-11' }).totals.requests, 3);
    assert.equal(s.snapshot().totals.requests, 6);
  });

  test('日期存在性、闰年和非法 filters/空值一律显式报错', () => {
    const s = store();
    for (const bad of [null, [], false, 'today', 0, new Date()]) assert.throws(() => s.query(bad), TypeError);
    for (const field of ['range', 'source', 'outcome', 'model', 'accountId', 'apiKeyId', 'limit', 'offset', 'now']) {
      for (const value of [null, '', [], {}]) assert.throws(() => s.query({ [field]: value }), (err) => err instanceof TypeError || err instanceof RangeError, `${field}=${JSON.stringify(value)}`);
    }
    for (const field of ['from', 'to']) {
      for (const value of [undefined, null, '', 0, []]) assert.throws(() => s.query({ range: 'custom', from: '2026-03-01', to: '2026-03-12', [field]: value }), TypeError);
    }
    for (const day of ['2025-02-29', '2026-02-30', '2026-04-31', '2026-13-01', '2026-00-01', '2026-01-00', '2026-3-01', '2026-01-01T00:00:00Z', '0000-01-01', ' 2026-01-01']) {
      assert.throws(() => s.query({ range: 'custom', from: day, to: '2026-12-31' }), RangeError, day);
    }
    assert.equal(s.query({ range: 'custom', from: '2024-02-29', to: '2024-02-29' }).range.from, '2024-02-29');
    assert.equal(s.query({ range: 'custom', from: '0099-02-28', to: '0099-02-28' }).range.from, '0099-02-28');
    assert.throws(() => s.query({ range: 'custom', from: '2026-03-13', to: '2026-03-12' }), RangeError);
    assert.throws(() => s.query({ range: 'today', from: '2026-03-01' }), RangeError);
    assert.throws(() => s.query({ range: 'year' }), RangeError);
    assert.throws(() => s.query({ source: 'internal' }), RangeError);
    assert.throws(() => s.query({ outcome: 'success' }), RangeError);
    assert.throws(() => s.query({ typo: true }), TypeError);
    assert.throws(() => s.query({ now: 'not a date' }), RangeError);
    for (const limit of [0, -1, 201, 1.5, NaN, Infinity]) assert.throws(() => s.query({ limit }), RangeError);
    for (const offset of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => s.query({ offset }), RangeError);
    assert.deepEqual(s.query({ limit: '2', offset: '3' }).page, { offset: 3, limit: 2, total: 0 });
    assert.throws(() => s.record(null), TypeError);
    assert.throws(() => s.record({ ts: 'bad timestamp' }), TypeError);
    assert.equal(s.snapshot().totals.requests, 0);
  });

  test('模型/账号/Key/source/outcome 与时间交叉筛选和同口径桶', () => {
    const s = store();
    add(s, 'r1', { ts: local(6) });
    add(s, 'r2', { ok: false, error: '429 Too Many Requests', attemptCount: 3 });
    add(s, 'r3', { model: 'alias-b', requestedModel: 'requested-b', resolvedModel: 'model-b' });
    add(s, 'r4', { ts: local(11), accountId: 'acct-b', accountLabel: 'Account B', apiKey: keyB, outcome: 'cancelled', ok: false });
    add(s, 'r5', { endpoint: '/admin/api/models/probe' });
    add(s, 'r6', { endpoint: '/admin/api/action', model: 'alias-b', resolvedModel: 'model-b', accountId: 'acct-b', apiKey: keyB, ok: false, error: '503 unavailable' });
    add(s, 'r7', { ts: local(11), apiKey: keyB });
    const base = all(s, { limit: 200 });
    assertCounters(base, { requests: 7, ok: 4, failed: 2, cancelled: 1, attempts: 9 });
    assert.equal(s.query({ range: 'all' }).totals.requests, 5);
    assert.equal(s.snapshot().totals.requests, 5, 'probe/admin 不污染旧概览累计');
    assert.equal(s.snapshot().totals.failed, 1);
    const cross = s.query({ range: 'custom', from: '2026-03-11', to: '2026-03-12', model: 'model-a', accountId: 'acct-a', apiKeyId: keyId(keyA), source: 'proxy', outcome: 'failed' });
    assert.deepEqual(cross.recent.map((r) => r.requestId), ['r2']);
    assertCounters(cross, { requests: 1, failed: 1, attempts: 3, total_tokens: 12 });
    assert.equal(cross.byApiKey[keyId(keyA)].label, '••••1234');
    assert.equal(cross.byAccount['acct-a'].label, 'Account A');
    assert.deepEqual(cross.facets, base.facets, 'facets 不受页码或当前交叉筛选影响');
    for (const source of ['proxy', 'probe', 'admin', 'all']) for (const outcome of ['ok', 'failed', 'cancelled', 'all']) for (const model of ['model-a', 'model-b']) {
      const q = all(s, { source, outcome, model });
      const expected = base.recent.filter((r) => (source === 'all' || r.source === source) && (outcome === 'all' || r.outcome === outcome) && r.resolvedModel === model);
      assert.deepEqual(q.recent.map((r) => r.requestId), expected.map((r) => r.requestId));
      assertCounters(q, { requests: expected.length });
    }
    assert.equal(all(s, { model: 'alias-a' }).totals.requests, 5);
    assert.equal(all(s, { model: 'requested-a' }).totals.requests, 6);
    assert.equal(all(s, { model: 'not-recorded' }).totals.requests, 0);
    assert.equal(all(s, { accountId: 'acct-b', apiKeyId: keyId(keyB) }).totals.requests, 2);
  });

  test('分页逆序、相同毫秒稳定顺序、结果与存储相互隔离', () => {
    const s = store();
    for (let i = 1; i <= 5; i += 1) add(s, `p${i}`, { attempts: [{ attempt: 1, error: 'diagnostic' }] });
    const q = all(s, { limit: 2, offset: 1 });
    assert.deepEqual(q.recent.map((r) => r.requestId), ['p4', 'p3']);
    assert.deepEqual(q.page, { limit: 2, offset: 1, total: 5 });
    assert.equal(q.totals.requests, 5);
    assert.equal(all(s, { offset: 50 }).recent.length, 0);
    q.recent[0].attempts[0].error = 'changed';
    q.historicalTotals.requests = -1;
    assert.equal(all(s).recent[1].attempts[0].error, 'diagnostic');
    assert.equal(s.snapshot().totals.requests, 5);
    add(s, 'older-but-inserted-last', { ts: local(11) });
    assert.equal(all(s).recent.at(-1).requestId, 'older-but-inserted-last');
  });

  test('性能 nearest-rank 分位数排除 null/异常值，真实 0 仍是样本', () => {
    const s = store();
    for (const [i, value] of [10, 20, 100].entries()) add(s, `perf${i}`, { ttftMs: value, latencyMs: value * 10, tps: value / 10, queueMs: i === 0 ? 0 : null });
    for (const [i, value] of [null, undefined, '', false, NaN, Infinity, -5, []].entries()) add(s, `missing${i}`, { ttftMs: value, latencyMs: value, queueMs: value, tps: value });
    const q = all(s);
    assert.deepEqual(q.performance.ttftMs, { count: 3, p50: 20, p95: 100, avg: 130 / 3 });
    assert.deepEqual(q.performance.queueMs, { count: 1, p50: 0, p95: 0, avg: 0 });
    assert.deepEqual(q.performance.tps, { count: 3, p50: 2, p95: 10, avg: 13 / 3 });
    assert.deepEqual(q.byModel['model-a'].performance, q.performance);
    assert.deepEqual(q.byApiKey[keyId(keyA)].performance, q.performance);
    assert.deepEqual(q.byAccount['acct-a'].performance, q.performance);
    assert.deepEqual(q.daily['2026-03-12'].performance, q.performance);
    const empty = all(s, { model: 'not-there' });
    assert.deepEqual(empty.performance.latencyMs, emptyMetric);
    const s2 = store();
    add(s2, 'zero', { latencyMs: 0, ttftMs: 0, queueMs: 0, tps: 0 });
    for (const value of Object.values(all(s2).performance)) assert.deepEqual(value, { count: 1, p50: 0, p95: 0, avg: 0 });
  });

  test('取消独立计数、客户端断连与中途断流分离、explicit outcome 优先', () => {
    const s = store();
    add(s, 'cancel-1', { outcome: 'cancelled', ok: false, error: 'client disconnected', attemptCount: 0 });
    add(s, 'cancel-2', { ok: false, error: 'client disconnected' });
    add(s, 'cancel-3', { ok: false, errorCode: 'CLIENT_DISCONNECTED' });
    add(s, 'cancel-4', { ok: false, error: 'operation aborted' });
    add(s, 'truncate', { ok: false, errorCode: 'UPSTREAM_TRUNCATED', error: '上游连接中途断开，这条回复不完整' });
    add(s, 'network', { ok: false, error: 'fetch failed: ECONNRESET' });
    add(s, 'timeout', { ok: false, error: 'request ETIMEDOUT' });
    add(s, 'explicit-fail', { ok: true, outcome: 'failed', error: '429 rate limit' });
    add(s, 'explicit-ok', { ok: false, outcome: 'ok' });
    add(s, 'explicit-cancel', { outcome: 'cancelled', error: '429 rate limit' });
    const q = all(s);
    assertCounters(q, { requests: 10, ok: 1, failed: 4, cancelled: 5, attempts: 9 });
    assert.deepEqual(q.errors, { '上游中途断流': 1, '网络错误': 1, '超时': 1, '限流 429': 1 });
    assert.equal(q.daily['2026-03-12'].completed, 5);
    assert.equal(s.snapshot().totals.failed, 4);
    assert.equal(s.snapshot().totals.cancelled, 5);
    assert.equal(all(s, { outcome: 'cancelled' }).totals.failed, 0);
    assert.deepEqual(all(s, { outcome: 'cancelled' }).errors, {});
    for (const message of ['UPSTREAM_TRUNCATED', 'ERR_STREAM_PREMATURE_CLOSE', 'stream interrupted', '上游中途断流']) assert.equal(classifyUsageError(message), '上游中途断流');
    assert.equal(classifyUsageError('client disconnected'), '客户端取消');
    assert.equal(classifyUsageError('request ETIMEDOUT'), '超时');
  });

  test('三种缓存字段兼容，缓存为输入子集，不再次加到 total', () => {
    const s = store();
    for (const extra of [{ prompt_tokens_details: { cached_tokens: 60 } }, { cached_tokens: 60 }, { prompt_cache_hit_tokens: 60 }]) add(s, 'cache', { usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 9999, ...extra } });
    assertCounters(all(s), { requests: 3, prompt_tokens: 300, completion_tokens: 30, total_tokens: 330, cached_tokens: 180, usageKnownRequests: 3 });
    assert.equal(s.snapshot().totals.total_tokens, 330);
    const zero = add(s, 'cache-zero', { usage: { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 0 }, cached_tokens: 9 } });
    assert.equal(zero.cached_tokens, 0);
    const fallback = add(s, 'cache-fallback', { usage: { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: NaN }, cached_tokens: '4' } });
    assert.equal(fallback.cached_tokens, 4);
  });

  test('异常 token 值、缺分量和 usageKnown 保守处理，重启保持 null', () => {
    const file = path.join(root, 'tokens.json');
    const s = store({ file });
    const invalid = add(s, 'invalid', { usage: { prompt_tokens: -10, completion_tokens: Infinity, total_tokens: 999, cached_tokens: NaN } });
    for (const field of ['prompt_tokens', 'completion_tokens', 'total_tokens', 'cached_tokens']) assert.equal(invalid[field], null);
    assert.equal(invalid.usageKnown, false);
    for (const [i, value] of [null, false, '', [], {}, NaN, Infinity, -1, 1e100].entries()) {
      const row = add(s, `bad-${i}`, { usage: { prompt_tokens: value, completion_tokens: value, cached_tokens: value } });
      assert.equal(row.prompt_tokens, null);
      assert.equal(row.completion_tokens, null);
      assert.equal(row.cached_tokens, null);
    }
    const onlyTotal = add(s, 'total-only', { usage: { total_tokens: 800 } });
    assert.equal(onlyTotal.total_tokens, null);
    assert.equal(onlyTotal.usageKnown, false);
    const partial = add(s, 'partial', { usage: { prompt_tokens: 10, cached_tokens: 400, total_tokens: 500 } });
    assert.equal(partial.prompt_tokens, 10);
    assert.equal(partial.completion_tokens, null);
    assert.equal(partial.total_tokens, 10);
    assert.equal(partial.cached_tokens, 10);
    assert.equal(partial.usageKnown, false);
    const numeric = add(s, 'numeric', { usage: { prompt_tokens: '12', completion_tokens: '3', cached_tokens: '5', total_tokens: '15' } });
    assert.equal(numeric.total_tokens, 15);
    assert.equal(numeric.usageKnown, true);
    add(s, 'explicit-unknown', { usageKnown: false, usage: { prompt_tokens: 1, completion_tokens: 1, cached_tokens: -1 } });
    const aliased = add(s, 'aliases', { usage: { input_tokens: 2, output_tokens: 3 } });
    assert.equal(aliased.total_tokens, 5);
    const before = all(s);
    assertCounters(before, { total_tokens: 32, usageKnownRequests: 2 });
    for (const value of Object.values(before.totals)) assert.ok(Number.isFinite(value) && value >= 0);
    s.flush();
    assert.deepEqual(all(store({ file })), before);
  });

  test('脱敏持久化、白名单 attempts 和重试 usage 不重复入账', () => {
    const file = path.join(root, 'sanitized.json');
    const s = store({ file });
    const secret = 'sk-example-long-secret-TAIL';
    const attempts = Array.from({ length: 10 }, (_, index) => ({ attempt: index + 1, model: `candidate-${index + 1}`, accountId: 'a'.repeat(200),
      cred: `https://user:password@fixture.invalid/?api_key=${secret}&access_token=other-token`, status: -1, code: 'x'.repeat(100), error: `Bearer another-secret ${secret} ${'x'.repeat(800)}`,
      apiKey: secret, headers: { authorization: secret }, body: secret,
      usage: { prompt_tokens: 500, completion_tokens: 50, total_tokens: 1000, apiKey: secret } }));
    const row = add(s, 'sanitized', { apiKey: secret, attemptCount: 12, requestId: `rid-${secret}`, error: `api_key=${secret} Bearer second-secret`,
      credential: 'https://user:password@fixture.invalid/?token=third-secret', attempts, usage: { prompt_tokens: 2, completion_tokens: 1 } });
    assert.equal(row.apiKeyId, keyId(secret));
    assert.equal(row.apiKeyLabel, '••••TAIL');
    assert.equal(row.attemptCount, 12);
    assert.equal(row.attempts.length, 8);
    assert.equal(row.attempts[0].attempt, 3);
    assert.equal(row.attempts[0].model, 'candidate-3');
    assert.equal(row.attempts[0].usage.total_tokens, 550);
    assert.equal(row.attempts[0].status, 0);
    assert.equal(row.attempts[0].accountId.length, 120);
    assert.equal(row.attempts[0].code.length, 80);
    assert.equal(row.attempts[0].error.length, 500);
    assert.equal(own(row, 'apiKey'), false);
    assert.equal(own(row.attempts[0], 'body'), false);
    assertCounters(all(s), { requests: 1, attempts: 12, total_tokens: 3 });
    const inferred = add(s, 'inferred-attempts', { attempts });
    assert.equal(inferred.attemptCount, 10);
    const short = add(s, 'short-key', { apiKey: 'xy' });
    assert.equal(short.apiKeyLabel, '••••');
    s.flush();
    const text = fs.readFileSync(file, 'utf8');
    for (const raw of [secret, 'user:password', 'other-token', 'another-secret', 'second-secret', 'third-secret']) assert.equal(text.includes(raw), false, raw);
    const persisted = JSON.parse(text);
    assert.equal(persisted.history.length, 3);
    assert.equal(own(persisted.byApiKey, secret), false);
    assert.deepEqual(all(store({ file })).recent, all(s).recent);
  });

  test('endpoint/probe 标记默认推断，显式 source 可覆盖默认', () => {
    const s = store();
    add(s, 'implicit-proxy');
    add(s, 'implicit-probe', { endpoint: '/admin/api/models/probe?token=secret', ok: false });
    add(s, 'legacy-probe-flag', { endpoint: '/v1/chat/completions', probe: true });
    add(s, 'implicit-admin', { endpoint: '/admin/api/actions', ok: false });
    add(s, 'explicit-proxy', { endpoint: '/admin/api/models/probe', source: 'proxy' });
    add(s, 'explicit-admin', { endpoint: '/v1/chat/completions', source: 'admin' });
    assert.equal(all(s).totals.requests, 6);
    assert.equal(all(s, { source: 'proxy' }).totals.requests, 2);
    assert.equal(all(s, { source: 'probe' }).totals.requests, 2);
    assert.equal(all(s, { source: 'admin' }).totals.requests, 2);
    assert.equal(s.snapshot().totals.requests, 2);
    assert.equal(s.snapshot().byModel['model-a'].requests, 2);
    assert.equal(s.snapshot().byApiKey[keyId(keyA)].requests, 2);
    assert.equal(s.snapshot().daily['2026-03-12'].requests, 2);
    assert.deepEqual(s.snapshot().errors, {});
  });

  test('未知身份有可筛选桶；原型关键字只作桶名', () => {
    const s = store();
    add(s, 'unknown', { accountId: '', accountLabel: '', apiKey: undefined, model: '__proto__', resolvedModel: '__proto__' });
    const q = all(s, { model: '__proto__', accountId: 'unknown', apiKeyId: 'unknown' });
    assertCounters(q, { requests: 1 });
    assert.equal(Object.hasOwn(q.byModel, '__proto__'), true);
    assert.equal(q.byApiKey.unknown.label, '未记录 Key');
    assert.equal(q.byAccount.unknown.label, '未记录账号');
    assert.deepEqual(q.facets.accounts, [{ id: 'unknown', label: '未记录账号' }]);
    assert.equal({}.requests, undefined);
  });

  test('10000 条真实上限裁剪、200 条 snapshot、迁移重启保留覆盖标记', () => {
    const file = path.join(root, 'bounded.json');
    const s = store({ file });
    for (let i = 0; i < 10_005; i += 1) s.record({ model: 'cap', requestId: `cap-${i}`, ok: true, usage: { prompt_tokens: 1, completion_tokens: 1 } });
    const q = all(s, { limit: 200 });
    assert.equal(q.coverage.retainedRecords, 10_000);
    assert.equal(q.page.total, 10_000);
    assert.equal(q.recent.length, 200);
    assert.equal(q.recent[0].requestId, 'cap-10004');
    assert.equal(s.data.history[0].requestId, 'cap-5');
    assertCounters(q, { requests: 10_000, total_tokens: 20_000 });
    assert.equal(q.historicalTotals.requests, 10_005);
    assert.equal(s.snapshot().recent.length, 200);
    assert.equal('history' in s.snapshot(), false);
    assert.equal(q.coverage.partial, true);
    assert.match(q.coverage.message, /上限已裁剪 5 条/);
    s.flush();
    const reloaded = store({ file });
    const again = all(reloaded);
    assert.equal(again.page.total, 10_000);
    assert.equal(again.historicalTotals.requests, 10_005);
    assert.match(again.coverage.message, /上限已裁剪 5 条/);
    assert.equal(again.coverage.partial, true);
    assert.throws(() => store({ historyLimit: 10_001 }), RangeError);
    assert.throws(() => store({ retentionDays: 31 }), RangeError);
  });

  test('30 个自然日窗口裁剪、日累计保留与可注入 now', () => {
    let now = BASE;
    const s = store({ now: () => now });
    add(s, 'expired', { ts: new Date(2026, 1, 10, 23, 59, 59, 999).getTime() });
    add(s, 'oldest-kept', { ts: new Date(2026, 1, 11, 0).getTime() });
    add(s, 'current');
    const q = all(s);
    assert.equal(q.totals.requests, 2);
    assert.equal(q.historicalTotals.requests, 3);
    assert.equal(q.coverage.earliestRecordAt, iso(new Date(2026, 1, 11, 0).getTime()));
    assert.match(q.coverage.message, /时间窗口已淘汰 1 条/);
    const next = all(s, { now: local(13) });
    assert.equal(next.totals.requests, 1);
    assert.match(next.coverage.message, /时间窗口已淘汰 2 条/);
    now = local(13);
    assert.equal(s.snapshot().totals.requests, 3);
    assert.equal(s.snapshot().daily['2026-02-10'].requests, 1);
    const small = store({ historyLimit: 3 });
    for (let i = 0; i < 5; i += 1) add(small, `small-${i}`);
    assert.equal(all(small).coverage.limit, 3);
    assert.equal(all(small).totals.requests, 3);
  });

  test('reset 先归档完整内存含未 flush 明细，成功后重置并保持唯一备份', () => {
    const file = path.join(root, 'reset.json');
    const s = store({ file });
    add(s, 'flushed');
    s.flush();
    add(s, 'pending');
    add(s, 'pending-probe', { source: 'probe' });
    const { archiveFile } = s.reset();
    assert.equal(path.dirname(archiveFile), root);
    assert.match(path.basename(archiveFile), /^reset\.backup-.*\.json$/);
    const backup = JSON.parse(fs.readFileSync(archiveFile, 'utf8'));
    assert.equal(backup.totals.requests, 2);
    assert.equal(backup.history.length, 3);
    assert.equal(backup.recent[0].requestId, 'pending');
    assert.equal(backup.recent.every((row) => row.source === 'proxy'), true);
    assert.equal(backup.history.at(-1).requestId, 'pending-probe');
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).totals.requests, 0);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).history.length, 0);
    assert.equal(all(s).totals.requests, 0);
    assert.equal(all(store({ file })).totals.requests, 0);
    const next = s.reset();
    assert.notEqual(next.archiveFile, archiveFile);
    assert.equal(JSON.parse(fs.readFileSync(archiveFile, 'utf8')).history.length, 3);
    const memory = store();
    add(memory, 'memory');
    assert.deepEqual(memory.reset(), { archiveFile: null });
    assert.equal(all(memory).totals.requests, 0);
  });

  test('reset 备份写入失败与主文件替换失败都保留原内存', () => {
    const blocker = path.join(root, 'not-a-directory');
    fs.writeFileSync(blocker, 'fixture');
    const s = store();
    add(s, 'must-survive');
    s.file = path.join(blocker, 'usage.json');
    assert.throws(() => s.reset());
    assert.equal(s.snapshot().totals.requests, 1);
    assert.equal(all(s).recent[0].requestId, 'must-survive');
    const directoryTarget = path.join(root, 'directory-target.json');
    fs.mkdirSync(directoryTarget);
    const mainFail = store();
    add(mainFail, 'main-failure');
    mainFail.file = directoryTarget;
    assert.throws(() => mainFail.reset());
    assert.equal(mainFail.snapshot().totals.requests, 1);
    const archives = fs.readdirSync(root).filter((name) => name.startsWith('directory-target.backup-'));
    assert.equal(archives.length, 1);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, archives[0]), 'utf8')).history[0].requestId, 'main-failure');
  });

  test('attemptKnownRequests 区分未知历史与真实零尝试', () => {
    const s = store();
    add(s, 'unknown-attempts', { attemptCount: null });
    add(s, 'zero-attempts', { attemptCount: 0, outcome: 'cancelled' });
    add(s, 'known-attempts', { attemptCount: 3 });
    const q = all(s);
    assertCounters(q, { requests: 3, attempts: 3, attemptKnownRequests: 2 });
    assert.equal(q.byModel['model-a'].attemptKnownRequests, 2);
    assert.equal(q.byApiKey[keyId(keyA)].attemptKnownRequests, 2);
    assert.equal(q.byAccount['acct-a'].attemptKnownRequests, 2);
    assert.equal(q.daily['2026-03-12'].attemptKnownRequests, 2);
    const zero = all(s, { outcome: 'cancelled' });
    assert.equal(zero.totals.attempts, 0);
    assert.equal(zero.totals.attemptKnownRequests, 1);
    const file = path.join(root, 'attempt-coverage.json');
    fs.writeFileSync(file, JSON.stringify(legacyDocument()));
    const legacy = store({ file });
    assert.equal(all(legacy).totals.attempts, 0);
    assert.equal(all(legacy).totals.attemptKnownRequests, 0);
    assert.equal(legacy.snapshot().totals.attemptKnownRequests, null);
    add(legacy, 'new-observation', { attemptCount: 0 });
    assert.equal(all(legacy).totals.attemptKnownRequests, 1);
    assert.equal(legacy.snapshot().totals.attemptKnownRequests, null);
  });

  test('有限大分量跨请求聚合后不因超过单条上限而清零', () => {
    const s = store();
    const value = Number.MAX_SAFE_INTEGER;
    for (let i = 0; i < 3; i += 1) add(s, `large-${i}`, { usage: { prompt_tokens: value, completion_tokens: value } });
    const q = all(s);
    assert.equal(q.totals.prompt_tokens, value * 3);
    assert.equal(q.totals.completion_tokens, value * 3);
    assert.equal(q.totals.total_tokens, (value + value) * 3);
    assert.equal(s.snapshot().totals.total_tokens, (value + value) * 3);
    assert.ok(Number.isFinite(q.totals.total_tokens));
  });

  test('服务器时区 UTC+8 与 DST 自然日查询边界', () => {
    const previous = process.env.TZ;
    try {
      for (const zone of ['Asia/Shanghai', 'America/New_York']) {
        process.env.TZ = zone;
        const anchor = new Date(2026, 2, 9, 12).getTime();
        const s = store({ now: () => anchor });
        s.record({ ts: new Date(2026, 2, 8, 0), ok: true, model: 'tz', requestId: 'start' });
        s.record({ ts: new Date(2026, 2, 8, 23, 59, 59, 999), ok: true, model: 'tz', requestId: 'end' });
        s.record({ ts: new Date(2026, 2, 9, 0), ok: true, model: 'tz', requestId: 'next' });
        const q = s.query({ range: 'custom', from: '2026-03-08', to: '2026-03-08' });
        assert.equal(q.totals.requests, 2, zone);
        assert.deepEqual(Object.keys(q.daily), ['2026-03-08']);
        assert.equal(usageDayKey(new Date(2026, 2, 8, 0)), '2026-03-08');
        assert.equal(s.query({ range: '7d' }).range.from, '2026-03-03');
        assert.equal(q.coverage.timeZone, zone);
      }
    } finally {
      if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous;
    }
  });
} finally {
  for (const s of stores) clearInterval(s.timer);
  // 只清理本脚本 mkdtemp 的确切目录，先确认 realpath 和命名空间。
  assert.equal(fs.realpathSync(root), canonicalRoot);
  assert.ok(path.basename(root).startsWith('o2a-usage-query-'));
  fs.rmSync(root, { recursive: true, force: true });
}
function own(value, key) { return Object.prototype.hasOwnProperty.call(value, key); }
console.log(`\n用量查询测试：${passed} 通过 / ${failed} 失败`);
process.exitCode = failed ? 1 : 0;
