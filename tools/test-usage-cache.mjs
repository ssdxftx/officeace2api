/**
 * 缓存 token 记账测试
 *
 * 上游的字段有两种常见形态：OpenAI 的 `prompt_tokens_details.cached_tokens`
 * 和直给 `usage.cached_tokens`。算错不会报错，只会让面板上的命中率说谎，
 * 所以两种都测一遍。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { UsageStore } from '../src/stats.mjs';

let pass = 0;
let fail = 0;
function check(name, actual, expected) {
  const ok = Object.is(actual, expected);
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}  期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'o2a-usage-'));
const store = new UsageStore({ file: path.join(dir, 'usage.json'), flushMs: 60_000 });

store.record({
  model: 'm1',
  usage: { prompt_tokens: 1000, completion_tokens: 10, total_tokens: 1010, prompt_tokens_details: { cached_tokens: 600 } },
  ok: true,
  latencyMs: 1000,
});
store.record({
  model: 'm1',
  usage: { prompt_tokens: 500, completion_tokens: 5, total_tokens: 505, cached_tokens: 200 },
  ok: true,
  latencyMs: 1000,
});
store.record({
  model: 'm2',
  usage: { prompt_tokens: 100, completion_tokens: 1, total_tokens: 101 },
  ok: true,
  latencyMs: 1000,
});
// 模型可用性探测是开机自检，不能进用量：否则每天复核黑名单都会把成功率拉低。
store.record({
  model: 'probe-only',
  usage: null,
  ok: false,
  endpoint: '/admin/api/models/probe',
  probe: true,
  latencyMs: 5,
});

const snap = store.snapshot();
check('总计缓存 token', snap.totals.cached_tokens, 800);
check('m1 缓存 token', snap.byModel.m1.cached_tokens, 800);
check('m2 没有缓存字段时为 0', snap.byModel.m2.cached_tokens, 0);
check('最近记录带缓存', snap.recent[0].cached_tokens, 0);
check('最近记录第二条带缓存', snap.recent[1].cached_tokens, 200);
check('探测不计入请求总数', snap.totals.requests, 3);
check('探测不计入失败数', snap.totals.failed, 0);
check('探测不进最近调用', snap.recent.length, 3);
check('探测模型不进按模型统计', snap.byModel['probe-only'], undefined);

store.timer?.unref?.();
fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n═══ 结果：${pass} 通过 / ${fail} 失败 ═══`);
process.exit(fail ? 1 : 0);
