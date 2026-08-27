/**
 * auto-test 配置加载器
 *
 * 设计原则：
 * - 文件不存在时返回默认值（保证 init 前也能跑部分命令）
 * - 解析失败抛 CliError(IO_ERROR)，给清晰提示
 * - 浅合并：用户覆盖嵌套字段时需提供完整值（避免半配置状态）
 * - 忽略未知字段（如 $schema、已被废弃的 storage、runner.configPath），向前兼容
 *
 * 路径策略：
 * - auto-test 所有产物（包括配置文件本身）都收纳在 `.auto-test/` 下
 * - 不可在配置文件中改路径——减少决策成本 + 避免配置漂移
 * - 配置文件位置：`.auto-test/config.json`（老位置 `auto-test.config.json` 兼容读取 + 引导迁移）
 *
 * 默认值（DEFAULT_CONFIG）保持最小可工作集合；如需改 model / browser / selectorPolicy
 * 直接在 .auto-test/config.json 里写即可。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CliError, ExitCode } from './utils/errors.js';
import { logger } from './utils/logger.js';

export type AgentDelegate = 'sdk' | 'cli';
export type ExploreWaitUntil = 'load' | 'domcontentloaded' | 'networkidle';
export type GenerationStyle = 'page-object-optional' | 'page-object-required' | 'inline-only';

export interface AutoTestConfig {
  version: string;
  agent: {
    /**
     * 形如 "anthropic/claude-sonnet-latest"。
     * 未设置时由 pi-agent ModelRuntime 选第一个已认证的 model。
     * 推荐通过 `auto-test models select` 选择；不要手填不在 pi-agent 目录里的 id。
     */
    model?: string;
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
    defaultBrowser: string;
    trace: string;
    screenshot: string;
  };
  /**
   * 鉴权 / 注入配置（落到 Playwright `extraHTTPHeaders` + `storageState`）。
   *
   * - 字段值支持 `${ENV_VAR}` 占位符（仅本段允许；path 字段不允许）
   * - `headers` 与 `extraHTTPHeaders` 等价，合并传给 Playwright
   * - `storageState` 路径相对 cwd（建议放在 `.auto-test/auth/storage/`）
   * - 未设置则完全跳过——公开页测试场景适用
   *
   * 与 setup.ts 的关系：本段是"项目默认态"（单一身份）；
   * 多角色 / 动态登录通过 `.auto-test/auth/*.setup.ts` + Playwright project 拆分处理。
   */
  auth?: {
    headers?: Record<string, string>;
    extraHTTPHeaders?: Record<string, string>;
    cookies?: AuthCookieSpec[];
    storageState?: string;
  };
}

/**
 * Playwright storageState 中 cookie 字段的最小子集。
 * cookies 在阶段 2（auth 子系统）才完整支持；这里先在 schema 里暴露，便于渐进式迁移。
 */
export interface AuthCookieSpec {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
  expires?: number;
}

export const DEFAULT_CONFIG: AutoTestConfig = {
  version: '1',
  agent: {
    // 不写默认值——model 由 pi-agent 决定。
    // 用 `auto-test models select` 锁定到具体 provider/model。
    model: undefined,
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
    defaultBrowser: 'chromium',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
};

/**
 * auto-test 在仓库内的固定布局常量。
 *
 * 任何自定义路径的需求一律不提供；如确需在非 cwd 运行，可在外部 chdir
 * 或把 .auto-test/ 软链接到期望位置。
 */
export const STORAGE_LAYOUT = {
  root: '.auto-test',
  cases: '.auto-test/cases',
  pages: '.auto-test/cases/pages',
  reports: '.auto-test/reports',
  configFile: '.auto-test/config.json',
  playwrightConfig: '.auto-test/playwright.config.ts',
  authDir: '.auto-test/auth',
  authStorage: '.auto-test/auth/storage',
} as const;

/** 老版本配置文件路径（仅用于一次性迁移提示，不推荐继续使用） */
const LEGACY_CONFIG_PATHS = ['auto-test.config.json'] as const;

export interface LoadConfigResult {
  config: AutoTestConfig;
  /** 当前实际使用的配置文件路径（绝对路径） */
  configPath: string;
  /** 是否使用了老路径（用于在 init / print 时输出迁移提示） */
  fromLegacy: boolean;
}

export function loadConfig(cwd: string = process.cwd()): AutoTestConfig {
  return loadConfigDetailed(cwd).config;
}

/**
 * 与 loadConfig 类似，但额外返回配置文件位置信息（供 init 提示用户）。
 */
export function loadConfigDetailed(cwd: string = process.cwd()): LoadConfigResult {
  const primaryPath = join(cwd, STORAGE_LAYOUT.configFile);
  const primaryExists = existsSync(primaryPath);

  if (!primaryExists) {
    // 兼容老路径：找到就加载，但提示迁移
    for (const legacyRel of LEGACY_CONFIG_PATHS) {
      const legacyPath = join(cwd, legacyRel);
      if (existsSync(legacyPath)) {
        logger.warn(
          `[config] 检测到老位置配置 ${legacyRel}，将加载但推荐迁移到 ${STORAGE_LAYOUT.configFile}`,
        );
        const config = parseConfigFile(legacyPath);
        return { config, configPath: legacyPath, fromLegacy: true };
      }
    }
    return { config: deepClone(DEFAULT_CONFIG), configPath: primaryPath, fromLegacy: false };
  }

  const config = parseConfigFile(primaryPath);
  return { config, configPath: primaryPath, fromLegacy: false };
}

function parseConfigFile(path: string): AutoTestConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (err) {
    throw new CliError({
      code: ExitCode.IO_ERROR,
      message: `解析 ${path} 失败：${(err as Error).message}`,
      hint: '请运行 `auto-test init --force` 重置为默认配置',
    });
  }

  if (!raw || typeof raw !== 'object') {
    throw new CliError({
      code: ExitCode.IO_ERROR,
      message: `${path} 必须是 JSON 对象`,
    });
  }

  return mergeConfig(DEFAULT_CONFIG, raw as Record<string, unknown>);
}

function mergeConfig(base: AutoTestConfig, override: Record<string, unknown>): AutoTestConfig {
  const overrideAuth = override.auth as Partial<AutoTestConfig['auth']> | undefined;
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
    auth: overrideAuth ? mergeAuth(base.auth, overrideAuth) : base.auth,
    // 已废弃字段（storage / runner.configPath）会被静默忽略，不抛错（向前兼容）
  };
}

function mergeAuth(
  base: AutoTestConfig['auth'] | undefined,
  override: Partial<AutoTestConfig['auth']> | undefined,
): AutoTestConfig['auth'] {
  if (!base && !override) return undefined;
  return {
    headers: { ...(base?.headers ?? {}), ...(override?.headers ?? {}) },
    extraHTTPHeaders: {
      ...(base?.extraHTTPHeaders ?? {}),
      ...(override?.extraHTTPHeaders ?? {}),
    },
    cookies: override?.cookies ?? base?.cookies,
    storageState: override?.storageState ?? base?.storageState,
  };
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * 展开字符串中的 ${ENV_VAR} 占位符。仅 auth 段使用，不污染 path 字段。
 *
 * 缺失时：warning + 返回空串（fail-fast 让 CI 立刻知道是配置问题，
 * 但不至于在加载阶段就 throw 中断所有命令）。
 */
export function expandAuthEnv(value: string, source: string): string {
  if (!value.includes('${')) return value;
  return value.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (_, name: string) => {
    const envVal = process.env[name];
    if (envVal === undefined || envVal === '') {
      logger.warn(`[config.auth] ${source} 中 \${${name}} 未设置，使用空串`);
      return '';
    }
    return envVal;
  });
}

/**
 * 递归展开 Record<string, string> 里的 ${ENV_VAR}，用于 auth.headers / extraHTTPHeaders。
 */
export function expandAuthHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!headers) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = expandAuthEnv(v, `auth.headers.${k}`);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * 展开 cookies 数组（value 字段可能含 ${ENV_VAR}）。
 */
export function expandAuthCookies(
  cookies: AuthCookieSpec[] | undefined,
): AuthCookieSpec[] | undefined {
  if (!cookies || cookies.length === 0) return undefined;
  return cookies.map((c) => ({
    ...c,
    value: expandAuthEnv(c.value, `auth.cookies.${c.name}.value`),
  }));
}