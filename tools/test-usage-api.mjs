import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { usageFiltersFromQuery, usageCsvCell, exportUsageCsv } from '../src/usage-api.mjs';
import { createUsageFixture } from './usage-fixture.mjs';

let checks = 0;
const check = (name, fn) => { fn(); ++checks; console.log('PASS ' + name); };
const html = fs.readFileSync(new URL('../src/admin.html', import.meta.url), 'utf8');
check('admin inline JavaScript parses', () => new vm.Script(html.match(/<script>([\s\S]*?)<\/script>/)[1]));
check('filters whitelist excludes tokens', () => assert.deepEqual(usageFiltersFromQuery(new URLSearchParams('range=7d&source=proxy&token=secret&admin=true')), { range: '7d', source: 'proxy' }));
check('CSV escapes quotes and multiline', () => assert.equal(usageCsvCell('a"b\nc'), '"a""b\nc"'));
for (const input of ['=1+1', '+cmd', '-formula', '@SUM(A1)', '  =HYPERLINK("x")', '\t=1']) {
  check('CSV formula prefix ' + JSON.stringify(input), () => assert.ok(usageCsvCell(input).startsWith('"\'')));
}
check('CSV keeps null blank', () => assert.equal(usageCsvCell(null), '""'));
check('CSV keeps numeric zero', () => assert.equal(usageCsvCell(0), '"0"'));

const fixture = await createUsageFixture({ count: 260 });
const headers = { 'x-admin-token': fixture.token };
const get = async (url, authenticated = true) => {
  const res = await fetch(fixture.base + url, { headers: authenticated ? headers : {} });
  const text = await res.text();
  let data = null; try { data = JSON.parse(text); } catch { /* CSV or HTML */ }
  return { res, text, data };
};
try {
  const forbidden = await get('/admin/api/usage', false);
  check('usage endpoint requires admin authentication', () => assert.equal(forbidden.res.status, 401));
  const forbiddenExport = await get('/admin/api/usage/export.csv', false);
  check('export endpoint requires admin authentication', () => assert.equal(forbiddenExport.res.status, 401));
  const r = await get('/admin/api/usage?range=7d&source=proxy&limit=25');
  check('usage query returns 200', () => assert.equal(r.res.status, 200));
  check('usage query is non-cacheable', () => assert.equal(r.res.headers.get('cache-control'), 'no-store'));
  check('query has all 260 API requests but only one page', () => { assert.equal(r.data.totals.requests, 260); assert.equal(r.data.page.total, 260); assert.equal(r.data.recent.length, 25); });
  check('query has no raw API keys', () => { assert.ok(!r.text.includes('sk-fixture-team-0001')); assert.ok(!r.text.includes('sk-fixture-agent-0002')); });
  check('all cards, model groups and days agree', () => {
    assert.equal(Object.values(r.data.byModel).reduce((n, v) => n + v.requests, 0), r.data.totals.requests);
    assert.equal(Object.values(r.data.daily).reduce((n, v) => n + v.requests, 0), r.data.totals.requests);
    assert.equal(r.data.totals.ok + r.data.totals.failed + r.data.totals.cancelled, r.data.totals.requests);
  });
  const next = await get('/admin/api/usage?range=7d&source=proxy&limit=25&offset=25');
  check('second page has different requests but unchanged totals', () => {
    assert.deepEqual(next.data.totals, r.data.totals);
    const ids = new Set(r.data.recent.map((v) => v.requestId));
    assert.ok(next.data.recent.every((v) => !ids.has(v.requestId)));
  });
  const byModel = await get('/admin/api/usage?range=7d&source=proxy&model=glm-5.2&outcome=ok');
  check('intersected model and outcome filters apply everywhere', () => {
    assert.ok(byModel.data.recent.every((v) => v.model === 'glm-5.2' && v.ok));
    assert.equal(byModel.data.totals.requests, byModel.data.totals.ok);
    assert.deepEqual(Object.keys(byModel.data.byModel), ['glm-5.2']);
  });
  const probe = await get('/admin/api/usage?range=7d&source=probe');
  check('probe requests are isolated from proxy metrics', () => assert.equal(probe.data.page.total, 3));
  for (const query of ['range=invalid', 'range=custom&from=2026-02-30&to=2026-03-01', 'range=custom&from=2026-11-05&to=2026-11-01', 'offset=-1', 'source=invalid']) {
    const bad = await get('/admin/api/usage?' + query);
    check('invalid query gets 400: ' + query, () => { assert.equal(bad.res.status, 400); assert.equal(bad.data.error.code, 'invalid_usage_filter'); });
  }
  const csv = await get('/admin/api/usage/export.csv?range=7d&source=proxy&limit=25&offset=100');
  check('CSV exports all matching rows rather than current page', () => { assert.equal(csv.res.status, 200); assert.equal(csv.res.headers.get('x-usage-records'), '260'); assert.equal(csv.text.trim().split('\r\n').length, 261); });
  check('CSV download headers and privacy', () => {
    assert.match(csv.res.headers.get('content-type'), /text\/csv/);
    assert.match(csv.res.headers.get('content-disposition'), /attachment; filename="usage-/);
    assert.equal(csv.res.headers.get('cache-control'), 'no-store');
    assert.ok(!csv.text.includes('sk-fixture-team-0001'));
  });
  const filteredCsv = exportUsageCsv(fixture.usage, { range: '7d', source: 'proxy', model: 'glm-5.2', outcome: 'ok' });
  check('CSV and query share exact filters', () => assert.equal(filteredCsv.count, byModel.data.page.total));
  const state = await get('/admin/api/state');
  check('normal state stays bounded with no query history leakage', () => {
    assert.equal(state.res.status, 200); assert.equal(state.data.usage.history, undefined); assert.equal(state.data.usage.recent, undefined); assert.ok(state.data.recent.length <= 200);
  });
  const page = await get('/admin/');
  check('new admin page is served', () => { assert.equal(page.res.status, 200); assert.match(page.text, /用量与性能/); assert.match(page.text, /重置筛选/); });
  console.log(`\nPASS ${checks} usage API, CSV and static UI checks`);
} finally { await fixture.close(); }
