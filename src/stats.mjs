/**
 * 用量统计：保留兼容累计；有界 history 专供查询，绝不随 /state 广播。
 * 新记录只留脱敏身份及白名单诊断字段，不保存请求/响应正文或认证头。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createLogger } from './logger.mjs';
import { writeFileAtomic } from './util.mjs';

const log = createLogger('stats');
const HISTORY_LIMIT = 10_000;
const RETENTION_DAYS = 30;
const RECENT_LIMIT = 200;
const SOURCES = new Set(['proxy', 'probe', 'admin']);
const OUTCOMES = new Set(['ok', 'failed', 'cancelled']);
const METRICS = ['ttftMs', 'latencyMs', 'queueMs', 'tps'];
const COUNTERS = ['requests', 'ok', 'failed', 'cancelled', 'prompt_tokens', 'completion_tokens', 'total_tokens', 'cached_tokens', 'attempts', 'attemptKnownRequests', 'usageKnownRequests'];
const QUERY_FIELDS = new Set(['range', 'from', 'to', 'model', 'accountId', 'apiKeyId', 'source', 'outcome', 'limit', 'offset', 'now']);
const KEY_ID = /^key_[a-f0-9]{16}$/;
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/** 空值、布尔、负数及不安全/非有限数都不是一个观测值。 */
function numberOrNull(v) {
  if (typeof v !== 'number' && (typeof v !== 'string' || !v.trim())) return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n <= Number.MAX_SAFE_INTEGER ? n : null;
}
function integerOrNull(v) {
  const n = numberOrNull(v);
  return n !== null && Number.isSafeInteger(n) ? n : null;
}
function timestamp(v, name = 'now') {
  if (!(v instanceof Date) && typeof v !== 'number' && typeof v !== 'string') throw new TypeError(`${name} 应为日期、时间戳或日期字符串`);
  if (typeof v === 'string' && !v.trim()) throw new TypeError(`${name} 为空`);
  const ms = v instanceof Date ? v.getTime() : new Date(v).getTime();
  if (!Number.isFinite(ms)) throw new RangeError(`${name} 日期无效`);
  return ms;
}
/** 本机时区的 YYYY-MM-DD；UTC 日期会把东八区凌晨归到前一天。 */
export function usageDayKey(ts = Date.now()) {
  const d = new Date(timestamp(ts));
  return `${String(d.getFullYear()).padStart(4, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function localMidnight(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d;
}
function shiftDay(date, count) {
  const d = new Date(date);
  d.setDate(d.getDate() + count); // 自然日而非 24h，兼容 DST。
  return d;
}
function parseDay(value, name) {
  if (typeof value !== 'string' || !value) throw new TypeError(`${name} 应为 YYYY-MM-DD`);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new RangeError(`${name} 应为 YYYY-MM-DD`);
  const [, y, m, day] = match.map(Number);
  if (y < 1 || y > 9999) throw new RangeError(`${name} 年份无效`);
  const d = new Date(0);
  d.setHours(0, 0, 0, 0);
  d.setFullYear(y, m - 1, day); // Date(y, ...) 把 00..99 自动变成 1900..1999。
  if (d.getFullYear() !== y || d.getMonth() !== m - 1 || d.getDate() !== day) throw new RangeError(`${name} 日期不存在`);
  return d;
}

function sanitizeText(value, max = 200, secrets = []) {
  let text = typeof value === 'string' || typeof value === 'number' ? String(value) : '';
  for (const secret of secrets) if (secret) text = text.split(secret).join('[REDACTED]');
  return text
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/_.~=-]+/gi, '$1 [REDACTED]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@')
    .replace(/((?:[?&]|\b)(?:api[_-]?key|access[_-]?token|refresh[_-]?token|security[_-]?token|secret[_-]?access[_-]?key|secret|password|authorization|token|key)["']?\s*[:=]\s*["']?)(?:\[REDACTED\]|[^\s,;"'&#}\]]+)/gi, '$1[REDACTED]')
    .replace(/\bsk-[a-z0-9_-]{6,}\b/gi, '[REDACTED]')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .slice(0, max);
}
function keyIdentity(entry = {}) {
  if (typeof entry.apiKey === 'string' && entry.apiKey) {
    const raw = entry.apiKey;
    return {
      id: `key_${createHash('sha256').update(raw).digest('hex').slice(0, 16)}`,
      label: raw.length > 4 ? `••••${raw.slice(-4).replace(/[\u0000-\u001f\u007f]/g, '*')}` : '••••',
    };
  }
  if (typeof entry.apiKeyId === 'string' && KEY_ID.test(entry.apiKeyId)) {
    const label = typeof entry.apiKeyLabel === 'string' && /^••••[^\u0000-\u001f\u007f]{0,4}$/.test(entry.apiKeyLabel) ? entry.apiKeyLabel : '••••';
    return { id: entry.apiKeyId, label };
  }
  return { id: 'unknown', label: '未记录 Key' };
}
/** 保留明确分量，不从 total_tokens 猜 input/output，也不再加一次缓存。 */
function normalizeUsage(usage, usageKnown) {
  const u = isObject(usage) ? usage : {};
  const prompt = numberOrNull(u.prompt_tokens ?? u.input_tokens);
  const completion = numberOrNull(u.completion_tokens ?? u.output_tokens);
  const candidates = [u.prompt_tokens_details?.cached_tokens, u.cached_tokens, u.prompt_cache_hit_tokens];
  let cached = candidates.map(numberOrNull).find((v) => v !== null);
  if (cached === undefined) {
    const explicitlyInvalid = own(u, 'cached_tokens') || own(u, 'prompt_cache_hit_tokens') || (isObject(u.prompt_tokens_details) && own(u.prompt_tokens_details, 'cached_tokens'));
    cached = !explicitlyInvalid && (prompt !== null || completion !== null) ? 0 : null;
  }
  // cached 是 input 的子集；异常上报不应造成超过 100% 的命中率。
  if (cached !== null && prompt !== null) cached = Math.min(cached, prompt);
  return {
    prompt_tokens: prompt, completion_tokens: completion,
    total_tokens: prompt === null && completion === null ? null : (prompt ?? 0) + (completion ?? 0),
    cached_tokens: cached,
    usageKnown: prompt !== null && completion !== null && usageKnown !== false,
  };
}
function inferSource(endpoint) {
  if (/(?:^|[/:_-])probe(?:[/?#:_-]|$)/i.test(endpoint)) return 'probe';
  if (/^\/?admin(?:[/?#]|$)/i.test(endpoint)) return 'admin';
  return 'proxy';
}
function isClientCancellation(message) {
  return /client[ _-]*(?:disconnected|disconnect|gone|closed|cancelled|canceled)|客户端.*(?:断开|取消|关闭)|(?:request|operation)[ _-]*(?:was[ _-]*)?(?:aborted|cancelled|canceled)|^abort(?:error)?\b|^cancelled$|^canceled$/i.test(message);
}
/** 客户端取消和上游中途断流是不同结果，先区分再做粗分类。 */
export function classifyUsageError(message = '') {
  const s = String(message || '').toLowerCase();
  if (!s) return '未知';
  if (isClientCancellation(s)) return '客户端取消';
  if (/upstream[_ -]?truncated|err_stream_premature_close|premature(?:ly)?[ _-](?:close|closed|end)|stream.*(?:truncat|interrupt)|中途断(?:流|开)|回复不完整/.test(s)) return '上游中途断流';
  if (s.includes('timeout') || s.includes('timed out') || s.includes('超时') || s.includes('etimedout')) return '超时';
  if (s.includes('abort') || s.includes('取消')) return '客户端取消';
  if (s.includes('429') || s.includes('rate limit') || s.includes('ratelimit') || s.includes('too many') || s.includes('限流')) return '限流 429';
  if (s.includes('401') || s.includes('unauthorized') || s.includes('invalid api key') || s.includes('鉴权')) return '鉴权失败';
  if (s.includes('81004') || s.includes('81009') || s.includes('模型没权限') || s.includes('model not authorized') || s.includes('model_not_available') || s.includes('invalid model')) return '模型无权限';
  if (s.includes('403') || s.includes('forbidden') || s.includes('权限')) return '无权限 403';
  if (s.includes('81001') || s.includes('bad request') || s.includes('invalid request') || s.includes('参数')) return '请求参数';
  if (s.includes('502') || s.includes('503') || s.includes('504') || s.includes('bad gateway') || s.includes('unavailable')) return '上游 5xx';
  if (s.includes('econn') || s.includes('fetch failed') || s.includes('network') || s.includes('socket') || s.includes('dns')) return '网络错误';
  return '其他';
}
function sanitizeAttempts(attempts, secrets) {
  if (!Array.isArray(attempts)) return [];
  return attempts.slice(-8).filter(isObject).map((a) => {
    const result = {
      attempt: integerOrNull(a.attempt) ?? 0,
      credential: sanitizeText(a.credential || a.cred, 200, secrets),
      accountId: sanitizeText(a.accountId, 120, secrets),
      status: integerOrNull(a.status) ?? 0,
      code: sanitizeText(a.code || a.errorCode, 80, secrets),
      error: sanitizeText(a.error, 500, secrets),
    };
    if (a.model !== undefined || a.resolvedModel !== undefined) result.model = sanitizeText(a.model || a.resolvedModel, 200, secrets);
    if (isObject(a.usage)) result.usage = normalizeUsage(a.usage, a.usageKnown);
    return result;
  });
}
function normalizeRecord(entry, now, { legacy = false } = {}) {
  if (!isObject(entry)) return null;
  let ts;
  try { ts = new Date(timestamp(entry.ts ?? (legacy ? undefined : now), 'ts')).toISOString(); } catch { return null; }
  const secrets = typeof entry.apiKey === 'string' && entry.apiKey ? [entry.apiKey] : [];
  const text = (value, max) => sanitizeText(value, max, secrets);
  const key = keyIdentity(entry);
  const endpoint = text(entry.endpoint || '/v1/chat/completions', 300).split(/[?#]/)[0];
  const model = text(entry.model || entry.resolvedModel || entry.requestedModel || 'unknown', 200);
  const error = text(entry.error, 1000);
  const errorCode = text(entry.errorCode, 80);
  const cancelled = entry.cancelled === true || entry.canceled === true || entry.clientGone === true || (!entry.ok && isClientCancellation(`${errorCode} ${error}`.trim()));
  const outcome = OUTCOMES.has(entry.outcome) ? entry.outcome : cancelled ? 'cancelled' : entry.ok ? 'ok' : 'failed';
  const attempts = sanitizeAttempts(entry.attempts, secrets);
  const allAttempts = Array.isArray(entry.attempts) ? entry.attempts : [];
  const observedAttempts = allAttempts.reduce((max, a) => Math.max(max, integerOrNull(a?.attempt) ?? 0), allAttempts.length);
  const attemptCount = own(entry, 'attemptCount') && entry.attemptCount === null ? null : integerOrNull(entry.attemptCount) ?? (observedAttempts || (legacy ? null : 1));
  const row = {
    ts, model,
    requestedModel: text(entry.requestedModel || entry.model || model, 200),
    resolvedModel: text(entry.resolvedModel || entry.model || model, 200),
    apiKeyId: key.id, apiKeyLabel: key.label,
    ok: outcome === 'ok', outcome,
    source: SOURCES.has(entry.source) ? entry.source : entry.probe === true ? 'probe' : inferSource(endpoint),
    stream: !!entry.stream, endpoint,
    credential: text(entry.credential, 200),
    accountId: text(entry.accountId, 120),
    accountLabel: text(entry.accountLabel || entry.accountId, 200),
    requestId: text(entry.requestId, 200),
    error, errorCode, status: integerOrNull(entry.status) ?? 0,
    attemptCount, attempts,
    ...normalizeUsage(isObject(entry.usage) ? entry.usage : entry, entry.usageKnown),
  };
  for (const metric of METRICS) row[metric] = numberOrNull(entry[metric]);
  // 旧版把缺省 latency 写作 0；迁移时保守地视为缺测。
  if (legacy && row.latencyMs === 0) row.latencyMs = null;
  return row;
}

function emptyCounters() { return Object.fromEntries(COUNTERS.map((k) => [k, 0])); }
function put(map, key, value) {
  // 上游可给出 __proto__/constructor，它们只是普通桶名。
  Object.defineProperty(map, key, { value, enumerable: true, writable: true, configurable: true });
  return value;
}
function bucket(map, key, extra = {}) {
  return own(map, key) && isObject(map[key]) ? map[key] : put(map, key, { ...emptyCounters(), ...extra });
}
function addCounters(target, row) {
  const delta = {
    requests: 1, ok: row.outcome === 'ok' ? 1 : 0, failed: row.outcome === 'failed' ? 1 : 0,
    cancelled: row.outcome === 'cancelled' ? 1 : 0,
    prompt_tokens: row.prompt_tokens ?? 0, completion_tokens: row.completion_tokens ?? 0,
    total_tokens: row.total_tokens ?? 0, cached_tokens: row.cached_tokens ?? 0,
    attempts: row.attemptCount ?? 0, attemptKnownRequests: row.attemptCount !== null ? 1 : 0,
    usageKnownRequests: row.usageKnown ? 1 : 0,
  };
  for (const k of COUNTERS) {
    if (target[k] === null) continue;
    // 单条观测有上界，累计则可能超过 MAX_SAFE_INTEGER；不要因此把累计清零。
    const previous = typeof target[k] === 'number' && Number.isFinite(target[k]) && target[k] >= 0 ? target[k] : (numberOrNull(target[k]) ?? 0);
    const sum = previous + delta[k];
    target[k] = Number.isFinite(sum) ? sum : null;
  }
}
function historicalBucket(value) {
  const source = isObject(value) ? value : {};
  const result = { ...source };
  const hasHistory = (numberOrNull(source.requests) ?? 0) > 0;
  // 缺失的历史分量保持未知，不伪装成从 0 开始的完整累计。
  for (const key of COUNTERS) if (!own(source, key)) result[key] = hasHistory ? null : 0;
  return result;
}
function historicalMap(value) {
  const result = {};
  if (isObject(value)) for (const [key, item] of Object.entries(value)) if (isObject(item)) put(result, key, historicalBucket(item));
  return result;
}
function loadKeyBuckets(value) {
  const result = {};
  if (!isObject(value)) return result;
  for (const [oldKey, valueBucket] of Object.entries(value)) {
    if (!isObject(valueBucket)) continue;
    const key = oldKey === 'unknown' ? { id: 'unknown', label: '未记录 Key' }
      : KEY_ID.test(oldKey) ? keyIdentity({ apiKeyId: oldKey, apiKeyLabel: valueBucket.label }) : keyIdentity({ apiKey: oldKey });
    const item = historicalBucket(valueBucket);
    item.label = key.label;
    if (!own(result, key.id)) put(result, key.id, item);
    else for (const field of COUNTERS) {
      result[key.id][field] = result[key.id][field] === null || item[field] === null ? null
        : (numberOrNull(result[key.id][field]) ?? 0) + (numberOrNull(item[field]) ?? 0);
    }
  }
  return result;
}
function freshData(now) {
  const since = new Date(now).toISOString();
  return {
    since, totals: emptyCounters(), byModel: {}, byApiKey: {}, recent: [], daily: {}, errors: {},
    historyVersion: 1, history: [],
    historyCoverage: { legacy: false, droppedByLimit: 0, droppedByAge: 0, invalidRecords: 0, recordedSince: since },
  };
}
function performance(rows) {
  const result = {};
  for (const metric of METRICS) {
    const values = rows.map((row) => row[metric]).filter((v) => v !== null && Number.isFinite(v) && v >= 0).sort((a, b) => a - b);
    const count = values.length;
    // nearest-rank：分位数使用实际样本，不对缺失样本插值。
    result[metric] = {
      count, p50: count ? values[Math.ceil(count * 0.50) - 1] : null,
      p95: count ? values[Math.ceil(count * 0.95) - 1] : null,
      avg: count ? values.reduce((sum, n) => sum + n, 0) / count : null,
    };
  }
  return result;
}
function queryBuckets(rows, keyFor, labelFor) {
  const grouped = new Map();
  for (const row of rows) {
    const key = keyFor(row);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(row);
  }
  const result = {};
  for (const [key, group] of grouped) {
    const item = emptyCounters();
    for (const row of group) addCounters(item, row);
    item.completed = item.ok + item.failed;
    item.performance = performance(group);
    item.avgLatencyMs = item.performance.latencyMs.avg;
    if (labelFor) item.label = labelFor(group[group.length - 1]);
    put(result, key, item);
  }
  return result;
}
function pageInteger(value, name, fallback, min, max) {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^-?\d+$/.test(value))) throw new TypeError(`${name} 应为整数`);
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new RangeError(`${name} 应在 ${min}..${max} 之间`);
  return n;
}
function enumFilter(value, name, allowed, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string') throw new TypeError(`${name} 应为字符串`);
  if (!allowed.includes(value)) throw new RangeError(`${name} 无效`);
  return value;
}
function dimensionFilter(value, name) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${name} 应为非空字符串`);
  if (value.length > 300) throw new RangeError(`${name} 过长`);
  return value;
}
function normalizeFilters(filters, now, data) {
  if (!isObject(filters) || (Object.getPrototypeOf(filters) !== Object.prototype && Object.getPrototypeOf(filters) !== null)) throw new TypeError('filters 应为对象');
  for (const field of Object.keys(filters)) if (!QUERY_FIELDS.has(field)) throw new TypeError(`未知筛选字段: ${field}`);
  const kind = enumFilter(filters.range, 'range', ['today', '7d', '30d', 'all', 'custom'], 'today');
  const source = enumFilter(filters.source, 'source', ['proxy', 'probe', 'admin', 'all'], 'proxy');
  const outcome = enumFilter(filters.outcome, 'outcome', ['all', 'ok', 'failed', 'cancelled'], 'all');
  const model = dimensionFilter(filters.model, 'model');
  const accountId = dimensionFilter(filters.accountId, 'accountId');
  const apiKeyId = dimensionFilter(filters.apiKeyId, 'apiKeyId');
  const limit = pageInteger(filters.limit, 'limit', 50, 1, 200);
  const offset = pageInteger(filters.offset, 'offset', 0, 0, Number.MAX_SAFE_INTEGER);
  const at = filters.now === undefined ? now : timestamp(filters.now);
  const today = localMidnight(at);
  let start;
  let end = shiftDay(today, 1);
  let from;
  let to = usageDayKey(today);
  const labels = { today: '今天', '7d': '近 7 天', '30d': '近 30 天', all: '全部留存记录', custom: '自定义' };
  if (kind === 'custom') {
    start = parseDay(filters.from, 'from');
    const lastDay = parseDay(filters.to, 'to');
    if (start > lastDay) throw new RangeError('from 应早于或等于 to');
    end = shiftDay(lastDay, 1);
    from = filters.from;
    to = filters.to;
  } else {
    if (filters.from !== undefined || filters.to !== undefined) throw new RangeError('from/to 仅用于 custom 范围');
    start = shiftDay(today, kind === '7d' ? -6 : kind === '30d' ? -29 : 0);
    from = usageDayKey(start);
    if (kind === 'all') {
      from = data.history.length ? usageDayKey(data.history[0].ts) : usageDayKey(data.since);
      if (data.history.length) to = [to, usageDayKey(data.history[data.history.length - 1].ts)].sort().at(-1);
      if (from > to) from = to;
      start = -Infinity;
      end = Infinity;
    }
  }
  return { kind, source, outcome, model, accountId, apiKeyId, limit, offset, now: at, start: Number(start), end: Number(end), range: { from, to, label: labels[kind] } };
}

export class UsageStore {
  /** now/historyLimit/retentionDays 供确定性测试使用；生产上限固定封顶。 */
  constructor({ file, flushMs = 5000, now = () => Date.now(), historyLimit = HISTORY_LIMIT, retentionDays = RETENTION_DAYS } = {}) {
    if (typeof now !== 'function') throw new TypeError('now 应为时钟函数');
    this.now = () => timestamp(now());
    this.historyLimit = pageInteger(historyLimit, 'historyLimit', HISTORY_LIMIT, 1, HISTORY_LIMIT);
    this.retentionDays = pageInteger(retentionDays, 'retentionDays', RETENTION_DAYS, 1, RETENTION_DAYS);
    this.file = file;
    this.data = freshData(this.now());
    this.dirty = false;
    this.load();
    this.timer = setInterval(() => this.flush(), flushMs);
    this.timer.unref?.();
  }
  load() {
    if (!this.file) return;
    let doc;
    try { doc = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch (err) {
      if (err.code !== 'ENOENT') log.warn('统计文件读取失败，保留现有内存统计', { error: String(err?.message || err) });
      return;
    }
    if (!isObject(doc)) return;
    const now = this.now();
    const legacy = !Array.isArray(doc.history);
    const previous = isObject(doc.historyCoverage) ? doc.historyCoverage : {};
    let recordedSince;
    try { recordedSince = new Date(timestamp(previous.recordedSince)).toISOString(); } catch { recordedSince = new Date(now).toISOString(); }
    let since;
    try { since = new Date(timestamp(doc.since)).toISOString(); } catch { since = this.data.since; }
    const rawHistory = legacy ? (Array.isArray(doc.recent) ? doc.recent.slice().reverse() : []) : doc.history;
    const history = rawHistory.map((row) => normalizeRecord(row, now, { legacy: legacy || !doc.historyVersion })).filter(Boolean);
    history.sort((a, b) => a.ts.localeCompare(b.ts));
    this.data = {
      ...this.data, ...doc, since,
      totals: historicalBucket(doc.totals), byModel: historicalMap(doc.byModel), byApiKey: loadKeyBuckets(doc.byApiKey),
      daily: historicalMap(doc.daily), errors: isObject(doc.errors) ? { ...doc.errors } : {},
      historyVersion: 1, history,
      historyCoverage: {
        legacy: legacy || previous.legacy === true || (!doc.historyVersion && (numberOrNull(doc.totals?.requests) ?? 0) > history.length),
        droppedByLimit: integerOrNull(previous.droppedByLimit) ?? 0,
        droppedByAge: integerOrNull(previous.droppedByAge) ?? 0,
        invalidRecords: (integerOrNull(previous.invalidRecords) ?? 0) + rawHistory.length - history.length,
        recordedSince,
      },
    };
    // 只迁移可观察的 recent，累计值不由它重算；升级标记随 flush 持久化。
    this.dirty = true;
    this.prune(now);
    this.refreshRecent();
  }
  refreshRecent() {
    const recent = [];
    for (let i = this.data.history.length - 1; i >= 0 && recent.length < RECENT_LIMIT; i -= 1) {
      if (this.data.history[i].source === 'proxy') recent.push(this.data.history[i]);
    }
    this.data.recent = recent;
  }
  prune(now = this.now()) {
    const cutoff = shiftDay(localMidnight(now), 1 - this.retentionDays).toISOString();
    const history = this.data.history;
    let expired = 0;
    while (expired < history.length && history[expired].ts < cutoff) expired += 1;
    if (expired) {
      history.splice(0, expired);
      this.data.historyCoverage.droppedByAge += expired;
    }
    const overflow = Math.max(0, history.length - this.historyLimit);
    if (overflow) {
      history.splice(0, overflow);
      this.data.historyCoverage.droppedByLimit += overflow;
    }
    if (expired || overflow) { this.dirty = true; this.refreshRecent(); }
  }
  record(entry) {
    const now = this.now();
    const row = normalizeRecord(entry, now);
    if (!row) throw new TypeError('entry 应为包含有效时间的请求记录');
    // 概览累计只含代理请求；探测/管理调用仅进入 source 可查询的明细。
    if (row.source === 'proxy') {
      addCounters(this.data.totals, row);
      const m = bucket(this.data.byModel, row.resolvedModel || row.model, { avgLatencyMs: null });
      const previousRequests = numberOrNull(m.requests) ?? 0;
      addCounters(m, row);
      if (row.latencyMs !== null) {
        const oldAverage = numberOrNull(m.avgLatencyMs);
        m.avgLatencyMs = oldAverage === null ? row.latencyMs : Math.round((oldAverage * previousRequests + row.latencyMs) / (previousRequests + 1));
      }
      if (row.apiKeyId !== 'unknown') addCounters(bucket(this.data.byApiKey, row.apiKeyId, { label: row.apiKeyLabel }), row);
      addCounters(bucket(this.data.daily, usageDayKey(row.ts)), row);
      // 保留已有日累计；筛选日桶由 history 重建，绝不掺用此处累计。
      if (row.outcome === 'failed') {
        const kind = classifyUsageError(`${row.errorCode} ${row.error}`.trim());
        this.data.errors[kind] = (numberOrNull(this.data.errors[kind]) ?? 0) + 1;
      }
    }
    const history = this.data.history;
    history.push(row);
    if (history.length > 1 && history[history.length - 2].ts > row.ts) history.sort((a, b) => a.ts.localeCompare(b.ts));
    this.prune(now);
    this.refreshRecent();
    this.dirty = true;
    return structuredClone(row);
  }
  coverage(filters) {
    const meta = this.data.historyCoverage;
    const beforeRecording = filters.kind !== 'all' && filters.start < Date.parse(meta.recordedSince);
    const partial = meta.legacy || meta.droppedByLimit > 0 || meta.droppedByAge > 0 || meta.invalidRecords > 0 || beforeRecording;
    const windowStart = shiftDay(localMidnight(filters.now), 1 - this.retentionDays).toISOString();
    const messages = [`查询仅统计留存明细，最多 ${this.historyLimit} 条、最近 ${this.retentionDays} 个服务器本地自然日；历史累计保留旧值、新增累计仅含 proxy，均不参与筛选。`];
    if (meta.legacy) messages.push('旧版仅从 recent 迁移，遗失的旧明细及未采集的身份、尝试和性能字段未作推算，历史覆盖不完整。');
    if (meta.droppedByLimit) messages.push(`记录上限已裁剪 ${meta.droppedByLimit} 条。`);
    if (meta.droppedByAge) messages.push(`时间窗口已淘汰 ${meta.droppedByAge} 条。`);
    if (meta.invalidRecords) messages.push(`${meta.invalidRecords} 条旧记录缺少有效时间，未进入查询。`);
    if (beforeRecording) messages.push('所选范围包含连续采集开始之前的时段。');
    messages.push('缺测性能保留 null；token 仅相加明确的输入/输出分量，usageKnownRequests 表示分量完整的请求数。');
    return {
      partial: !!partial, message: messages.join(''),
      earliestRecordAt: this.data.history[0]?.ts ?? null,
      retainedRecords: this.data.history.length, limit: this.historyLimit,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'local',
      retentionDays: this.retentionDays, recordedSince: meta.recordedSince, windowStart,
    };
  }
  query(filters = {}) {
    // 验证成功后才维护存储；无效查询不产生副作用。
    let f = normalizeFilters(filters, this.now(), this.data);
    this.prune(f.now);
    if (f.kind === 'all') f = normalizeFilters(filters, f.now, this.data);
    const rows = this.data.history.filter((row) => {
      const ts = Date.parse(row.ts);
      return ts >= f.start && ts < f.end && (f.source === 'all' || row.source === f.source) &&
        (f.outcome === 'all' || row.outcome === f.outcome) &&
        (f.model === undefined || [row.resolvedModel, row.model, row.requestedModel].includes(f.model)) &&
        (f.accountId === undefined || (row.accountId || 'unknown') === f.accountId) &&
        (f.apiKeyId === undefined || row.apiKeyId === f.apiKeyId);
    });
    const totals = emptyCounters();
    const errors = {};
    for (const row of rows) {
      addCounters(totals, row);
      if (row.outcome === 'failed') {
        const kind = classifyUsageError(`${row.errorCode} ${row.error}`.trim());
        errors[kind] = (errors[kind] || 0) + 1;
      }
    }
    const models = new Set();
    const accounts = new Map();
    const apiKeys = new Map();
    for (const row of this.data.history) {
      for (const model of [row.resolvedModel, row.model, row.requestedModel]) if (model) models.add(model);
      accounts.set(row.accountId || 'unknown', row.accountLabel || row.accountId || '未记录账号');
      apiKeys.set(row.apiKeyId, row.apiKeyLabel);
    }
    const options = (map) => Array.from(map, ([id, label]) => ({ id, label })).sort((a, b) => a.id.localeCompare(b.id));
    return {
      since: this.data.since, totals,
      byModel: queryBuckets(rows, (row) => row.resolvedModel || row.model),
      byApiKey: queryBuckets(rows, (row) => row.apiKeyId, (row) => row.apiKeyLabel),
      byAccount: queryBuckets(rows, (row) => row.accountId || 'unknown', (row) => row.accountLabel || row.accountId || '未记录账号'),
      daily: queryBuckets(rows, (row) => usageDayKey(row.ts)),
      errors, performance: performance(rows),
      recent: structuredClone(rows.slice().reverse().slice(f.offset, f.offset + f.limit)),
      page: { offset: f.offset, limit: f.limit, total: rows.length },
      facets: { models: [...models].sort(), accounts: options(accounts), apiKeys: options(apiKeys) },
      coverage: this.coverage(f), range: f.range, historicalTotals: { ...this.data.totals },
    };
  }
  flush() {
    if (!this.file) return;
    this.prune();
    if (!this.dirty) return;
    try {
      writeFileAtomic(this.file, JSON.stringify(this.data, null, 2), { mode: 0o600 });
      this.dirty = false;
    } catch (err) { log.warn('统计落盘失败', { error: String(err?.message || err) }); }
  }
  snapshot() {
    this.prune();
    const { since, totals, byModel, byApiKey, recent, daily, errors } = this.data;
    return { since, totals, byModel, byApiKey, recent, daily, errors };
  }
  reset() {
    const now = this.now();
    const next = freshData(now);
    let archiveFile = null;
    if (this.file) {
      const parsed = path.parse(this.file);
      const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
      archiveFile = path.join(parsed.dir, `${parsed.name}.backup-${stamp}-${randomUUID().slice(0, 8)}${parsed.ext || '.json'}`);
      // 归档完整内存（包括未 flush 的请求和 history）后，再替换主文件。
      // 任一步失败都抛错，内存原样保留。
      writeFileAtomic(archiveFile, JSON.stringify(this.data, null, 2), { mode: 0o600 });
      writeFileAtomic(this.file, JSON.stringify(next, null, 2), { mode: 0o600 });
    }
    this.data = next;
    this.dirty = !this.file;
    return { archiveFile };
  }
}
