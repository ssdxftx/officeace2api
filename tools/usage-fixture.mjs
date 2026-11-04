import { createApp } from '../src/server.mjs';
import { CredentialPool } from '../src/pool.mjs';
import { ModelRegistry } from '../src/models.mjs';
import { UsageStore } from '../src/stats.mjs';

/** Isolated in-memory fixture: no account discovery, no config writes, no upstream calls. */
export async function createUsageFixture({ count = 80, token = 'usage-fixture-admin' } = {}) {
  const usage = new UsageStore({ flushMs: 60000 });
  const models = ['deepseek-v4.1-flash-1017', 'glm-5.2', 'deepseek-v4.1-flash'];
  const accountRows = [{ id: 'fixture-a', label: '主力账号', enabled: true }, { id: 'fixture-b', label: '备用账号', enabled: true }];
  for (let i = 0; i < count; i++) {
    const date = new Date();
    date.setDate(date.getDate() - (i % 7));
    date.setHours(9 + (i % 4), i % 60, 0, 0);
    const cancelled = i % 19 === 18;
    const failed = !cancelled && i % 23 === 22;
    const stream = i % 11 !== 0;
    const prompt = 55000 + i * 431, output = 1600 + i * 33;
    usage.record({
      ts: date.toISOString(), model: models[i % 3], resolvedModel: models[i % 3], requestedModel: i % 3 === 0 ? 'chat-fast' : models[i % 3],
      apiKey: i % 2 ? 'sk-fixture-team-0001' : 'sk-fixture-agent-0002', accountId: accountRows[i % 2].id,
      requestId: 'fixture-request-' + String(i).padStart(4, '0'), endpoint: '/v1/chat/completions', source: 'proxy',
      ok: !failed && !cancelled, outcome: cancelled ? 'cancelled' : failed ? 'failed' : 'ok',
      error: cancelled ? 'client disconnected' : failed ? 'upstream timeout' : '', errorCode: failed ? 'UPSTREAM_TIMEOUT' : '',
      status: failed ? 504 : cancelled ? 499 : 200, stream, latencyMs: 7500 + i * 219,
      ttftMs: stream ? 2100 + i * 35 : null, queueMs: 8 + i * 3, tps: stream ? 135 + i : null,
      attemptCount: i % 17 === 16 ? 2 : 1,
      attempts: i % 17 === 16 ? [{ attempt: 1, model: models[i % 3], accountId: 'fixture-b', status: 429, code: 'RATE_LIMITED', error: 'rate limited' }] : [],
      usage: cancelled || failed ? null : { prompt_tokens: prompt, completion_tokens: output, total_tokens: prompt + output, prompt_tokens_details: { cached_tokens: Math.floor(prompt * .79) } },
    });
  }
  for (let i = 0; i < 3; i++) usage.record({ model: 'probe-model-' + i, probe: true, endpoint: '/admin/api/models/probe', ok: false, status: 403, error: 'model not authorized', latencyMs: 100 + i });
  const pool = new CredentialPool();
  const registry = new ModelRegistry({ extra: models });
  const config = {
    listen: { host: '127.0.0.1', port: 0 }, apiKeys: ['sk-fixture-only'], admin: { token },
    upstream: { maxRetries: 1, timeoutSeconds: 2, includeUsage: true }, models: { alias: {}, hidden: [], extra: models },
    quota: {}, pool: {}, log: { level: 'info' },
  };
  const app = createApp({
    config, usage, pool, registry, version: '1.1.0-test', startedAt: Date.now() - 7200000,
    accounts: { list: () => accountRows, get: (id) => accountRows.find((a) => a.id === id), status: () => ({ total: 2, enabled: 2, healthy: 2 }), size: () => 2 },
    credits: { view: () => ({ summary: { ok: 2, accounts: 2, remaining: 12980.97 }, items: [] }) },
    authFlow: { appStatus: () => null, list: () => [] }, register: { stats: () => ({}), list: () => [] },
  });
  await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(0, '127.0.0.1', resolve); });
  return {
    app, usage, token, base: 'http://127.0.0.1:' + app.server.address().port,
    async close() { clearInterval(usage.timer); app.server.closeIdleConnections?.(); await new Promise((resolve) => app.server.close(resolve)); },
  };
}
