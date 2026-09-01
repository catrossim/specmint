/**
 * 跨平台 Playwright CLI 启动助手
 *
 * 解决 Windows 下 `spawn('npx', ...)` ENOENT 的痛点：
 * - Windows 上 npx 是 `npx.cmd`，无 shell 直接 spawn 会被 Node 抛 ENOENT
 * - 简单 `shell: true` 又会被 cmd 撕裂含空格的路径参数（如 C:\Users\John Doe\...）
 *
 * 策略：
 * 1. 优先 createRequire(cwd/package.json) 解析用户项目 Playwright CLI 直连（候选顺序见 resolveCli）：
 *    → '@playwright/test/cli'（1.38+ exports 键 "./cli" 精确映射到包内 cli.js）
 *    → 借道 'playwright/package.json' 定位包根后拼 cli.js（playwright 的 exports 未暴露 ./cli.js）
 *    → 无 exports 字段的老版本走裸 subpath resolve
 *    spawn(process.execPath, [cliPath, 'test', ...args])，不经 shell，无参数转义问题
 * 2. 解析失败回退 npx（win32 下 shell: true；其他平台裸 spawn）
 *    → warn 一次，不打日志噪音
 * 3. 错误处理：child 'error' 事件 ENOENT/EINVAL → 友好 CliError，提示确认 playwright 已安装
 *
 * 设计依据：
 * - 锚定 createRequire(join(cwd, 'package.json')) 与 browser-channel.ts 一致，
 *   保证解析到的是用户项目那份 @playwright/test（而非 specmint 自带 devDep）
 * - 不在模块顶层 import '@playwright/test'，避免 "Requiring @playwright/test second time"
 */
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { CliError, ExitCode } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

export interface PlaywrightSpawnOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export interface PlaywrightSpawnResult {
  exitCode: number;
  signal: NodeJS.Signals | null;
  /** 实际启动命令（展示 / --json 输出用；history 落库走 process.argv，见 executor.ts createRun） */
  command: string;
}

/**
 * 启动 `playwright test ...` 子进程并等待结束。
 *
 * @param args 紧跟 `playwright test` 之后的参数（如 ['--config', path, '--grep', name]）
 *             —— **不包含** `'playwright'` 与 `'test'` 前缀
 * @param options.cwd 用户项目根（解析 createRequire 锚点 + spawn cwd）
 * @param options.env 透传给子进程的 env
 */
export function spawnPlaywrightTest(
  args: string[],
  options: PlaywrightSpawnOptions,
): Promise<PlaywrightSpawnResult> {
  // 锚定用户项目（而非 specmint 包内），避免误解析到 specmint devDep 里的 playwright
  const cwdRequire = createRequire(join(options.cwd, 'package.json'));

  const resolved = resolveCli(cwdRequire);
  if (resolved) {
    return runDirect(resolved, args, options);
  }

  // 解析失败：理论上 init 已做探针，这里只是双保险。
  // 兜底走 npx（win32 加 shell），并 warn 一次。
  logger.warn(
    '[specmint] 未能在用户项目解析 playwright CLI，回退到 npx 启动（性能较慢，遇含空格路径有参数转义风险）',
  );
  return runViaNpx(args, options);
}

/**
 * CLI 解析候选（按优先级，兼容 playwright 1.38+ 的 exports 字段限制）：
 *
 * 注意：playwright ≥ 1.38 的 package.json 带 "exports" 字段，subpath resolve 必须精确匹配键：
 * - @playwright/test 的 exports 有 "./cli": "./cli.js" → '@playwright/test/cli' 可直接解析
 * - playwright 的 exports **不含** ./cli.js 键 → 裸 resolve('playwright/cli.js') 会抛
 *   ERR_PACKAGE_PATH_NOT_EXPORTED，需借道 './package.json'（exports 恒导出）定位包根后拼 cli.js
 * - 无 exports 字段的老版本允许任意 subpath → 裸候选兜底
 */
function resolveCli(cwdRequire: NodeJS.Require): string | null {
  // 1) 首选：@playwright/test 的 exports 键精确匹配（specmint peer dep 推荐项）
  try {
    return cwdRequire.resolve('@playwright/test/cli');
  } catch {
    // 落到下一候选
  }
  // 2) 借道 playwright/package.json 定位包根后拼 cli.js，existsSync 兜底防版本布局变化
  try {
    const pkgJsonPath = cwdRequire.resolve('playwright/package.json');
    const cliPath = join(dirname(pkgJsonPath), 'cli.js');
    if (existsSync(cliPath)) return cliPath;
  } catch {
    // 落到下一候选
  }
  // 3) 兜底：无 exports 字段的老版本走裸 subpath
  for (const spec of ['@playwright/test/cli.js', 'playwright/cli.js']) {
    try {
      return cwdRequire.resolve(spec);
    } catch {
      // 继续下一个候选
    }
  }
  return null;
}

/** 仅展示层：含空白字符的参数加引号避免歧义（不影响真实 spawn 参数传递） */
function displayArgs(args: string[]): string {
  return args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ');
}

function runDirect(
  cliPath: string,
  args: string[],
  options: PlaywrightSpawnOptions,
): Promise<PlaywrightSpawnResult> {
  // 展示用 `node` 简写；真实 spawn 仍用 process.execPath 绝对路径
  const display = `node ${cliPath} test ${displayArgs(args)}`;
  return new Promise((resolve, reject) => {
    const child: ChildProcess = spawn(process.execPath, [cliPath, 'test', ...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: 'inherit',
    });
    bindEvents(child, display, resolve, reject);
  });
}

function runViaNpx(
  args: string[],
  options: PlaywrightSpawnOptions,
): Promise<PlaywrightSpawnResult> {
  const display = `npx playwright test ${displayArgs(args)}`;
  return new Promise((resolve, reject) => {
    const child: ChildProcess = spawn('npx', ['playwright', 'test', ...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: 'inherit',
      // win32: npx 是 .cmd，无 shell 直接 spawn 必 ENOENT；POSIX 平台无需 shell
      shell: process.platform === 'win32',
    });
    bindEvents(child, display, resolve, reject);
  });
}

function bindEvents(
  child: ChildProcess,
  display: string,
  resolve: (r: PlaywrightSpawnResult) => void,
  reject: (e: Error) => void,
): void {
  child.on('error', (err) => {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      reject(
        new CliError({
          code: ExitCode.NOT_FOUND,
          message: 'Playwright CLI 启动失败：找不到可执行文件',
          hint: '请确认当前项目已安装 playwright（或 @playwright/test），且 npm 在 PATH 中。可执行 `npx playwright --version` 自检',
          details: { command: display, errno: err.message },
        }),
      );
      return;
    }
    if (code === 'EINVAL') {
      // 常见于 Windows 下无 shell 直接 spawn .cmd/.bat（Node 因 CVE-2024-27980 修复后拒绝该行为）
      reject(
        new CliError({
          code: ExitCode.GENERIC_ERROR,
          message: 'Playwright CLI 启动失败：子进程参数或环境非法（EINVAL）',
          hint: '多为 Windows 下直接启动 .cmd 导致；请反馈 issue 并附 details.command',
          details: { command: display, errno: err.message },
        }),
      );
      return;
    }
    reject(err);
  });
  child.on('exit', (code, signal) => {
    resolve({
      exitCode: code ?? 1,
      signal: signal as NodeJS.Signals | null,
      command: display,
    });
  });
}