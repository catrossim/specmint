/**
 * auto-test.config.json 加载器
 *
 * 设计原则：
 * - 文件不存在时返回默认值（保证 init 前也能跑部分命令）
 * - 解析失败抛 CliError(IO_ERROR)，给清晰提示
 * - 浅合并：用户覆盖嵌套字段时需提供完整值（避免半配置状态）
 * - 忽略未知字段（如 $schema），向前兼容
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CliError, ExitCode } from './utils/errors.js';

export type AgentDelegate = 'sdk' | 'cli';
export type ExploreWaitUntil = 'load' | 'domcontentloaded' | 'networkidle';
export type GenerationStyle = 'page-object-optional' | 'page-object-required' | 'inline-only';

export interface AutoTestConfig {
  version: string;
  agent: {
    model: string;
    delegate: AgentDelegate;
    systemPromptAdditions: string;
  };
  explore: {
    enabledByDefault: boolean;
    headless: boolean;
    timeoutMs: number;
    maxElements: number;
    waitUntil: ExploreWaitUntil;
  };
  generation: {
    selectorPolicy: { prefer: string[]; avoid: string[] };
    language: string;
    comments: string;
    style: GenerationStyle;
  };
  runner: {
    configPath: string;
    defaultBrowser: string;
    trace: string;
    screenshot: string;
  };
  storage: {
    casesDir: string;
    pageObjectsDir: string;
    reportsDir: string;
  };
}

export const DEFAULT_CONFIG: AutoTestConfig = {
  version: '1',
  agent: {
    model: 'anthropic/claude-sonnet-latest',
    delegate: 'sdk',
    systemPromptAdditions: '',
  },
  explore: {
    enabledByDefault: false,
    headless: true,
    timeoutMs: 15000,
    maxElements: 200,
    waitUntil: 'domcontentloaded',
  },
  generation: {
    selectorPolicy: {
      prefer: ['getByRole', 'getByLabel', 'getByPlaceholder', 'getByTestId', 'getByText'],
      avoid: ['nth-child', 'nth-of-type', 'complex-css', 'xpath'],
    },
    language: 'zh',
    comments: 'verbose',
    style: 'page-object-optional',
  },
  runner: {
    configPath: './playwright.config.ts',
    defaultBrowser: 'chromium',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  storage: {
    casesDir: './tests',
    pageObjectsDir: './tests/pages',
    reportsDir: './reports',
  },
};

export function loadConfig(cwd: string = process.cwd()): AutoTestConfig {
  const path = join(cwd, 'auto-test.config.json');
  if (!existsSync(path)) return deepClone(DEFAULT_CONFIG);

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (err) {
    throw new CliError({
      code: ExitCode.IO_ERROR,
      message: `解析 auto-test.config.json 失败：${(err as Error).message}`,
      hint: '请运行 `auto-test init --force` 重置为默认配置',
    });
  }

  if (!raw || typeof raw !== 'object') {
    throw new CliError({
      code: ExitCode.IO_ERROR,
      message: 'auto-test.config.json 必须是 JSON 对象',
    });
  }

  return mergeConfig(DEFAULT_CONFIG, raw as Record<string, unknown>);
}

function mergeConfig(base: AutoTestConfig, override: Record<string, unknown>): AutoTestConfig {
  return {
    version: '1',
    agent: { ...base.agent, ...((override.agent as object | undefined) ?? {}) },
    explore: { ...base.explore, ...((override.explore as object | undefined) ?? {}) },
    generation: {
      ...base.generation,
      ...((override.generation as object | undefined) ?? {}),
      selectorPolicy: {
        ...base.generation.selectorPolicy,
        ...(((override.generation as Record<string, unknown> | undefined)?.selectorPolicy as object | undefined) ?? {}),
      },
    },
    runner: { ...base.runner, ...((override.runner as object | undefined) ?? {}) },
    storage: { ...base.storage, ...((override.storage as object | undefined) ?? {}) },
  };
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}