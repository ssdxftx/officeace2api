#!/usr/bin/env node
/**
 * 环境变量覆盖配置（容器部署用）
 *
 * 容器里 config.json 通常挂在卷上、甚至镜像重建就没了，所以这几个值必须能
 * 从环境变量注入：监听地址/端口、API Key、手工上游、面板口令。
 *
 * 这里的重点不是"读到没"，而是**边界**：
 *   · 空串等于没设（compose 里 `${VAR:-}` 未定义时会传出空串）；
 *   · `OFFICEACE2API_ADMIN_TOKEN` 设了以后，`ensureAdminToken` 不许再生成
 *     一个新口令盖掉它 —— 否则每次重启面板口令都变。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, ensureAdminToken } from '../src/config.mjs';

let pass = 0;
let fail = 0;
function check(name, actual, expected) {
  const ok = typeof expected === 'object'
    ? JSON.stringify(actual) === JSON.stringify(expected)
    : Object.is(actual, expected);
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}  期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  }
}

const ENV_KEYS = [
  'OFFICEACE2API_PORT',
  'OFFICEACE2API_HOST',
  'OFFICEACE2API_KEYS',
  'OFFICEACE2API_BASE_URL',
  'OFFICEACE2API_AUTHORIZATION',
  'OFFICEACE2API_ADMIN_TOKEN',
];
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

function withEnv(vars, fn) {
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, vars);
  try {
    return fn();
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'o2a-cfgenv-'));
const missing = path.join(dir, 'no-such-config.json');

console.log('【1】环境变量覆盖');
{
  const cfg = withEnv(
    {
      OFFICEACE2API_PORT: '18000',
      OFFICEACE2API_HOST: '0.0.0.0',
      OFFICEACE2API_KEYS: ' sk-a , sk-b ,, ',
      OFFICEACE2API_BASE_URL: 'https://up.example/v1',
      OFFICEACE2API_AUTHORIZATION: 'Bearer sk-up',
      OFFICEACE2API_ADMIN_TOKEN: 'env-token',
    },
    () => loadConfig(missing),
  );
  check('port 是数字', cfg.listen.port, 18000);
  check('host', cfg.listen.host, '0.0.0.0');
  check('keys 去空白去空项', cfg.apiKeys, ['sk-a', 'sk-b']);
  check('baseUrl', cfg.upstream.baseUrl, 'https://up.example/v1');
  check('authorization', cfg.upstream.authorization, 'Bearer sk-up');
  check('admin.token', cfg.admin.token, 'env-token');
}

console.log('\n【2】空串 = 没设（compose 的 ${VAR:-} 会传空串）');
{
  const cfg = withEnv(
    {
      OFFICEACE2API_PORT: '',
      OFFICEACE2API_HOST: '',
      OFFICEACE2API_KEYS: '',
      OFFICEACE2API_BASE_URL: '',
      OFFICEACE2API_AUTHORIZATION: '',
      OFFICEACE2API_ADMIN_TOKEN: '',
    },
    () => loadConfig(missing),
  );
  check('port 保持默认', cfg.listen.port, 7864);
  check('host 保持默认', cfg.listen.host, '127.0.0.1');
  check('keys 保持默认', cfg.apiKeys, ['sk-officeace']);
  check('baseUrl 保持默认', cfg.upstream.baseUrl, '');
  check('admin.token 保持默认', cfg.admin.token, '');
}

console.log('\n【3】文件里写死的值被环境变量盖掉，没设的项不受影响');
{
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(
    file,
    JSON.stringify({
      listen: { host: '127.0.0.1', port: 7864 },
      apiKeys: ['sk-from-file'],
      admin: { enabled: true, token: 'file-token' },
    }),
  );
  const cfg = withEnv({ OFFICEACE2API_PORT: '19000' }, () => loadConfig(file));
  check('port 被覆盖', cfg.listen.port, 19000);
  check('host 沿用文件', cfg.listen.host, '127.0.0.1');
  check('keys 沿用文件', cfg.apiKeys, ['sk-from-file']);
  check('admin.token 沿用文件', cfg.admin.token, 'file-token');
}

console.log('\n【4】环境变量给了口令就不再自动生成/写回');
{
  const file = path.join(dir, 'config2.json');
  fs.writeFileSync(file, JSON.stringify({ admin: { enabled: true, token: '' } }));
  const cfg = withEnv({ OFFICEACE2API_ADMIN_TOKEN: 'stable-token' }, () => loadConfig(file));
  check('ensureAdminToken 返回 null', ensureAdminToken(cfg), null);
  check('口令仍是环境变量那个', cfg.admin.token, 'stable-token');
}

console.log('\n【5】没给口令时仍会自动生成（老行为不变）');
{
  const file = path.join(dir, 'config3.json');
  fs.writeFileSync(file, JSON.stringify({ admin: { enabled: true, token: '' } }));
  const cfg = withEnv({}, () => loadConfig(file));
  const generated = ensureAdminToken(cfg);
  check('生成了口令', typeof generated, 'string');
  check('生成长度足够', generated.length >= 24, true);
  check('口令已写进 config', cfg.admin.token, generated);
}

console.log(`\n═══ 结果：${pass} 通过 / ${fail} 失败 ═══`);
process.exit(fail ? 1 : 0);
