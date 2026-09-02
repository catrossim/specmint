#!/usr/bin/env tsx
/**
 * Smoke test: 覆盖 auth-resolve 的核心契约（不引入测试框架）。
 *
 * 跑法: pnpm tsx scripts/test-auth.ts
 * 通过: 进程退出 0；任一 assert 失败立即抛错，退出 1。
 *
 * 覆盖矩阵：
 *  1. CLI --auth <role> 优先（命中 → role=cli，storageState 路径正确）
 *  2. CLI --auth 角色文件不存在 → 抛 CliError 友好提示
 *  3. config.auth.storageState 命中 → role=config，fingerprint 与路径相关
 *  4. config.auth.headers / extraHTTPHeaders 命中 → role=config-inline，仅存 key 名
 *  5. config.auth.cookies 命中 → role=config-inline
 *  6. 全空 → role=none
 *  7. fingerprint 仅依赖路径/key（不依赖 value），同一 storageState 路径 → 同一 fingerprint
 *  8. toCaseUsedAuth 折算结果正确（不泄露 value）
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveAuth, toCaseUsedAuth } from '../src/agent/auth-resolve.js';
import { looksLikeLoginPage } from '../src/commands/generate-helpers.js';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(label: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    passed++;
    process.stdout.write(`  ✓ ${label}\n`);
  } else {
    failed++;
    failures.push(label);
    process.stdout.write(`  ✗ ${label}` + (detail !== undefined ? ` :: ${JSON.stringify(detail)}` : '') + '\n');
  }
}

function assertThrows(label: string, fn: () => unknown, matcher: RegExp): void {
  try {
    fn();
    failed++;
    failures.push(label);
    process.stdout.write(`  ✗ ${label} :: 期望抛错但没抛\n`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (matcher.test(msg)) {
      passed++;
      process.stdout.write(`  ✓ ${label}\n`);
    } else {
      failed++;
      failures.push(label);
      process.stdout.write(`  ✗ ${label} :: 抛错信息不匹配: ${msg}\n`);
    }
  }
}

// 准备临时目录：模拟 `.specmint/auth/storage/<role>.json`
const tmp = mkdtempSync(join(tmpdir(), 'specmint-auth-test-'));
process.stdout.write(`tmp cwd: ${tmp}\n`);

const cliRoleDir = join(tmp, '.specmint', 'auth', 'storage');
mkdirSync(cliRoleDir, { recursive: true });
writeFileSync(join(cliRoleDir, 'admin.json'), JSON.stringify({ cookies: [], origins: [] }));
writeFileSync(join(cliRoleDir, 'viewer.json'), JSON.stringify({ cookies: [], origins: [] }));

const configStorage = join(tmp, 'project-storage.json');
writeFileSync(configStorage, JSON.stringify({ cookies: [], origins: [] }));

process.stdout.write('\n[1] CLI --auth <role> 优先\n');
{
  const r = resolveAuth(undefined, 'admin', tmp);
  assert('role=cli', r.role === 'cli');
  assert(
    'storageState 路径绝对化到 cwd',
    r.storageState === join(tmp, '.specmint/auth/storage/admin.json'),
  );
  assert('fingerprint 非空且稳定', typeof r.fingerprint === 'string' && r.fingerprint.length === 8);
  assert(
    'storageStatePath 用于落盘',
    r.storageStatePath === join(tmp, '.specmint/auth/storage/admin.json'),
  );
  // 同样路径同样 fingerprint（同一身份两次跑应该复用缓存）
  const r2 = resolveAuth({ storageState: configStorage }, 'admin', tmp);
  assert(
    'CLI 覆盖 config.auth.storageState',
    r2.storageState === join(tmp, '.specmint/auth/storage/admin.json') && r2.role === 'cli',
  );
}

process.stdout.write('\n[2] CLI --auth 角色文件不存在 → 抛错友好提示\n');
assertThrows(
  '缺角色文件抛错',
  () => resolveAuth(undefined, 'ghost', tmp),
  /storageState 不存在.*ghost/,
);
assertThrows(
  '提示信息指向真实存在的 specmint auth refresh',
  () => resolveAuth(undefined, 'ghost', tmp),
  /specmint auth refresh/,
);

process.stdout.write('\n[3] config.auth.storageState 命中\n');
{
  const r = resolveAuth({ storageState: configStorage }, undefined, tmp);
  assert('role=config', r.role === 'config');
  assert('storageState 指向 config 路径', r.storageState === configStorage);
  assert('storageStatePath 暴露给审计', r.storageStatePath === configStorage);
}

process.stdout.write('\n[4] config.auth.headers / extraHTTPHeaders 命中\n');
{
  const r = resolveAuth(
    {
      headers: { Authorization: 'Bearer secret-abc' },
      extraHTTPHeaders: { 'X-Tenant': 'tenant-1' },
    },
    undefined,
    tmp,
  );
  assert('role=config-inline', r.role === 'config-inline');
  assert('extraHTTPHeaders 已合并', Object.keys(r.extraHTTPHeaders ?? {}).length === 2);
  assert('value 不进 fingerprint（key-only hash 区分）',
    r.fingerprint === resolveAuth(
      { headers: { Authorization: 'Bearer DIFF-secret' }, extraHTTPHeaders: { 'X-Tenant': 'DIFF' } },
      undefined, tmp,
    ).fingerprint,
  );
  // headerKeys 已剥离 value
  const audit = toCaseUsedAuth(r);
  assert('headerKeys 仅含 key 名', Array.isArray(audit.headerKeys) && !audit.headerKeys!.some(k => k.includes('secret')));
}

process.stdout.write('\n[5] config.auth.cookies 命中\n');
{
  const r = resolveAuth(
    {
      cookies: [
        { name: 'sid', value: 'secret-sid-value', sameSite: 'Lax' },
        { name: 'csrf', value: 'secret-csrf-value', sameSite: 'Lax' },
      ],
    },
    undefined,
    tmp,
  );
  assert('role=config-inline', r.role === 'config-inline');
  assert('cookies 已展开', (r.cookies ?? []).length === 2);
  assert('fingerprint 不依赖 cookie value',
    r.fingerprint === resolveAuth(
      { cookies: [{ name: 'sid', value: 'DIFF', sameSite: 'Lax' }, { name: 'csrf', value: 'DIFF', sameSite: 'Lax' }] },
      undefined, tmp,
    ).fingerprint,
  );
}

process.stdout.write('\n[6] 全空 → role=none\n');
{
  const r = resolveAuth(undefined, undefined, tmp);
  assert('role=none', r.role === 'none');
  assert('无 storageState/headers/cookies', !r.storageState && !r.extraHTTPHeaders && !r.cookies);
  const r2 = resolveAuth({}, undefined, tmp);
  assert('空对象也视为 role=none', r2.role === 'none');
}

process.stdout.write('\n[7] fingerprint 稳定性 + 不泄露 value\n');
{
  const fpA = resolveAuth({ headers: { Authorization: 'Bearer A' } }, undefined, tmp).fingerprint;
  const fpB = resolveAuth({ headers: { Authorization: 'Bearer B' } }, undefined, tmp).fingerprint;
  assert('同 key 不同 value → 同一 fingerprint', fpA === fpB);
  // 不同 key → 不同 fingerprint
  const fpC = resolveAuth({ headers: { 'X-Diff': 'x' } }, undefined, tmp).fingerprint;
  assert('不同 key → 不同 fingerprint', fpA !== fpC);
}

process.stdout.write('\n[8] toCaseUsedAuth 折算（不存 value）\n');
{
  const r = resolveAuth(
    { storageState: configStorage, headers: { Authorization: 'Bearer SECRET' } },
    undefined,
    tmp,
  );
  const audit = toCaseUsedAuth(r);
  assert('role 透传', audit.role === 'config');
  assert('storageStatePath 透传', audit.storageStatePath === configStorage);
  assert('headerKeys 不含 value', !JSON.stringify(audit).includes('SECRET'));
}

process.stdout.write('\n[9] looksLikeLoginPage 启发式探测\n');
{
  // title/URL 命中
  assert('title 含 Login 命中', looksLikeLoginPage('Login - App', 'https://x.com/dashboard'));
  assert('URL 含 /signin 命中', looksLikeLoginPage('Home', 'https://x.com/signin'));
  assert('URL 含 oauth 命中', looksLikeLoginPage('Home', 'https://x.com/oauth/callback'));
  assert('中文"登录"命中', looksLikeLoginPage('登录 - 应用', 'https://x.com'));
  // snapshot 命中
  assert('snapshot 含 password input 命中', looksLikeLoginPage('Home', 'https://x.com', '[type=password]', ''));
  assert('snapshot 含 password 关键字命中', looksLikeLoginPage('Home', 'https://x.com', 'Enter your password below', ''));
  // 无命中
  assert('干净的 dashboard 不命中', !looksLikeLoginPage('Dashboard', 'https://x.com/dashboard'));
  assert('snapshot 干净不命中', !looksLikeLoginPage('Dashboard', 'https://x.com/dashboard', 'Welcome, user', 'Click button'));
}

// 清理
rmSync(tmp, { recursive: true, force: true });

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  process.stdout.write(`\n失败用例:\n  - ${failures.join('\n  - ')}\n`);
  process.exit(1);
}
process.exit(0);