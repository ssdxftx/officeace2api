/** Filtered usage API helpers; no credentials or request bodies in exports. */
const FILTERS = ['range', 'from', 'to', 'model', 'accountId', 'apiKeyId', 'source', 'outcome', 'limit', 'offset'];

export function usageFiltersFromQuery(query) {
  const filters = {};
  for (const key of FILTERS) if (query.has(key)) filters[key] = query.get(key);
  return filters;
}

// Keep spreadsheet programs from treating user-controlled identifiers as formulas.
export function usageCsvCell(value) {
  if (value === null || value === undefined) return '""';
  let text = String(value);
  if (typeof value !== 'number' && /^[\s\uFEFF]*[=+\-@\t\r]/u.test(text)) text = "'" + text;
  return '"' + text.replace(/"/g, '""') + '"';
}

const COLUMNS = [
  ['时间', (r) => r.ts],
  ['请求 ID', (r) => r.requestId],
  ['请求模型', (r) => r.requestedModel || r.model],
  ['实际模型', (r) => r.resolvedModel || r.model],
  ['来源', (r) => r.source],
  ['结果', (r) => r.outcome || (r.ok ? 'ok' : 'failed')],
  ['账号 ID', (r) => r.accountId],
  ['API Key 标识', (r) => r.apiKeyId],
  ['API Key 尾号', (r) => r.apiKeyLabel],
  ['流式', (r) => !!r.stream],
  ['总耗时 ms', (r) => r.latencyMs],
  ['首 Token ms', (r) => r.ttftMs],
  ['排队 ms', (r) => r.queueMs],
  ['输出 Tokens/s', (r) => r.tps],
  ['上游尝试数', (r) => r.attemptCount],
  ['已上报用量', (r) => !!r.usageKnown],
  ['输入 Tokens', (r) => r.prompt_tokens],
  ['输出 Tokens', (r) => r.completion_tokens],
  ['缓存 Tokens', (r) => r.cached_tokens],
  ['HTTP 状态', (r) => r.status || null],
  ['错误码', (r) => r.errorCode],
  ['错误摘要', (r) => r.error],
];

/** Synchronous snapshot: event-loop arrivals cannot shift pages during this export. */
export function exportUsageCsv(store, filters = {}) {
  const fixed = { ...filters, now: Date.now(), offset: 0, limit: 200 };
  const first = store.query(fixed);
  const rows = [...first.recent];
  for (let offset = 200; offset < first.page.total; offset += 200) {
    rows.push(...store.query({ ...fixed, offset }).recent);
  }
  const csv = '\uFEFF' + [
    COLUMNS.map(([name]) => usageCsvCell(name)).join(','),
    ...rows.map((row) => COLUMNS.map(([, get]) => usageCsvCell(get(row))).join(',')),
  ].join('\r\n') + '\r\n';
  return { csv, count: rows.length, coverage: first.coverage, range: first.range };
}
