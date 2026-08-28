/**
 * 包内 Playwright 配置定位。
 *
 * 优先级：
 *   1. CLI --config <path>（用户显式覆盖 —— 逃生舱）
 *   2. <runnerDir>/playwright.config.js（dist 态，由 tsc 输出）
 *   3. <runnerDir>/playwright.config.ts（tsx dev 态）
 *
 * 不回退到用户目录的 .auto-test/playwright.config.ts —— 那是历史 init 产物，
 * 内联残缺 reporter 会再次触发"onEnd 缺失 → run.json 不 finalize"链式 bug。
 */
import { existsSync } from 'node:fs';
import { dirname, resolve as resolveFile } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CliError, ExitCode } from '../utils/errors.js';

const RUNNER_DIR = dirname(fileURLToPath(import.meta.url));

export function resolveRunnerConfigPath(explicit?: string): string {
  if (explicit) {
    const abs = resolveFile(explicit);
    if (!existsSync(abs)) {
      throw new CliError({
        code: ExitCode.USAGE_ERROR,
        message: `指定的 --config 文件不存在：${abs}`,
        hint: '请确认路径无误，或省略 --config 走默认包内配置',
      });
    }
    return abs;
  }
  const jsCandidate = resolveFile(RUNNER_DIR, 'playwright.config.js');
  if (existsSync(jsCandidate)) return jsCandidate;
  const tsCandidate = resolveFile(RUNNER_DIR, 'playwright.config.ts');
  if (existsSync(tsCandidate)) return tsCandidate;
  throw new CliError({
    code: ExitCode.USAGE_ERROR,
    message: '找不到包内 Playwright 配置',
    hint: '请先运行 `npm run build`（或 `pnpm build`）生成 dist/runner/playwright.config.js',
  });
}