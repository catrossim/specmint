/**
 * specmint 配置加载器
 *
 * 设计原则：
 * - 文件不存在时返回默认值（保证 init 前也能跑部分命令）
 * - 解析失败抛 CliError(IO_ERROR)，给清晰提示
 * - 浅合并：用户覆盖嵌套字段时需提供完整值（避免半配置状态）
 * - 忽略未知字段（如 $schema、已被废弃的 storage、runner.configPath），向前兼容
 *
 * 路径策略：
 * - specmint 所有产物（包括配置文件本身）都收纳在 `.specmint/` 下
 * - 不可在配置文件中改路径——减少决策成本 + 避免配置漂移
 * - 配置文件位置：`.specmint/config.json`（老位置 `specmint.config.json` 兼容读取 + 引导迁移）
 *
 * 默认值（DEFAULT_CONFIG）保持最小可工作集合；如需改 model / browser / selectorPolicy
 * 直接在 .specmint/config.json 里写即可。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ReviewVerdict } from './store/types.js';
import { CliError, ExitCode } from './utils/errors.js';
import { logger } from './utils/logger.js';

export type AgentDelegate = 'sdk' | 'cli';
export type ExploreWaitUntil = 'load' | 'domcontentloaded' | 'networkidle';
export type GenerationStyle = 'page-object-optional' | 'page-object-required' | 'inline-only';
/** `review` 段裁决人字段的回填来源：CLI 显式 > env > git config > '$USER' */
export type ReviewerSource = 'cli' | 'env' | 'git-user';

export interface ReviewConfig {
  /**
   * `run --all` 默认仅跑 verdict=approved；关掉此开关可回到老行为（跑全部 enabled 用例）。
   * 配合 `blockedOnRun` 可精细控制哪些 verdict 被默认排除。
   */
  requireBeforeRun: boolean;
  /**
   * `generate` 落盘时是否默认写入 review.verdict='pending'。
   * 默认 true：所有新用例必须经过人工裁决才能进入 run。
   */
  pendingOnGenerate: boolean;
  /**
   * 裁决人字段的自动回填来源优先级。
   * - `cli`：只用 CLI --reviewer；未传则用 'unknown'（最严格）
   * - `env`：CLI > $SPECMINT_REVIEWER > $USER > git config user.name
   * - `git-user`（默认）：CLI > $SPECMINT_REVIEWER > $USER > `git config user.name`
   */
  reviewerSource: ReviewerSource;
  /**
   * 被默认排除的 verdict 集合（run / rerun / heal 默认行为）。
   * 默认 ['pending','needs-fix','rejected']，即仅 verdict='approved' 时自动跑。
   * - 'pending' 通常是 AI 生成后没看过的，跳过最安全
   * - 'needs-fix' 是明确标了要改的，跑多半挂
   * - 'rejected' 是废弃的，CI 静默跳过
   * 如想允许跑某类 verdict，配 `--include-pending/--include-needs-fix/--include-rejected`，
   * 或在 config 中清空此数组。
   */
  blockedOnRun: ReviewVerdict[];
  /**
   * P1：heal 是否启用 verdict 卡口。默认仅 `verdict=needs-fix` 的用例可被 heal。
   * 关掉此开关可回到老行为（任何 verdict 都尝试 heal）。
   * 配合 `blockedOnHeal` 可精细控制哪些 verdict 被默认排除。
   */
  requireBeforeHeal: boolean;
  /**
   * P1：被默认排除的 verdict 集合（heal 命令默认行为）。
   * 默认 ['pending','approved','rejected','skipped']，即仅 verdict='needs-fix' 可被 heal。
   * 如想允许 heal 其它 verdict，配 `--include-pending/--include-approved/--include-rejected`，
   * 或在 config 中清空此数组。
   */
  blockedOnHeal: ReviewVerdict[];
}

export interface AutoTestConfig {
  version: string;
  agent: {
    /**
     * 形如 "anthropic/claude-sonnet-latest"。
     * 未设置时由 pi-agent ModelRuntime 选第一个已认证的 model。
     * 推荐通过 `specmint models select` 选择；不要手填不在 pi-agent 目录里的 id。
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
    /**
     * 探索快照缓存：避免同 URL 重复启动浏览器（实测省 5~15s/用例）。
     *
     * - `enabled=false` 跳过读写（CLI `--no-explore-cache` 也能关闭单次调用）
     * - `ttlMs` 默认 10 分钟，过期自动失效
     * - `dir` 默认 `.specmint/cache/explore`，文件命名 `<key>.json`
     *
     * 注意：快照里不含登录态；如需按角色缓存，调用方可在 storageState 指纹里
     * 注入角色标识，详见 agent/explore-cache.ts 的 storageStateFingerprint。
     */
    cache?: {
      enabled?: boolean;
      ttlMs?: number;
      dir?: string;
    };
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
    /** 单用例超时（毫秒），默认 30000。映射到 Playwright `timeout`。 */
    timeoutMs?: number;
    /**
     * 浏览器通道：解决内网/受限环境无法下载 Playwright 自带 chromium 的痛点。
     * - `auto`（默认）：检测链 chromium → 系统 Chrome → 系统 Edge
     * - `chromium`：强制用 Playwright 自带（未下载会报错）
     * - `chrome` / `msedge`：强制用对应系统浏览器
     */
    browserChannel: 'auto' | 'chromium' | 'chrome' | 'msedge';
    /**
     * 被测目标 baseURL，注入到 Playwright `use.baseURL`。
     *
     * 优先级（env 最高，符合 12-factor）：
     *   process.env.BASE_URL > process.env.SPECMINT_BASE_URL > runner.baseURL > 'http://localhost:3000'
     *
     * 支持 `${ENV_VAR}` 展开（与 auth.storageState 一致）。
     */
    baseURL?: string;
  };
  /**
   * 鉴权 / 注入配置（落到 Playwright `extraHTTPHeaders` + `storageState`）。
   *
   * - 字段值支持 `${ENV_VAR}` 占位符（仅本段允许；path 字段不允许）
   * - `headers` 与 `extraHTTPHeaders` 等价，合并传给 Playwright
   * - `storageState` 路径相对 cwd（建议放在 `.specmint/auth/storage/`）
   * - 未设置则完全跳过——公开页测试场景适用
   *
   * 与 setup.ts 的关系：本段是"项目默认态"（单一身份）；
   * 多角色 / 动态登录通过 `.specmint/auth/*.setup.ts` + Playwright project 拆分处理。
   */
  auth?: {
    headers?: Record<string, string>;
    extraHTTPHeaders?: Record<string, string>;
    cookies?: AuthCookieSpec[];
    storageState?: string;
  };
  /**
   * P1：人工裁决（人工仲裁）配置。
   * - `requireBeforeRun=true`：run --all 默认仅跑 verdict=approved
   * - `blockedOnRun`：细粒度控制哪些 verdict 被默认排除
   * - 与 run 命令的 --include-* / --force / --no-require-review 标志叠加生效
   */
  review?: ReviewConfig;
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
  sameSite: 'Strict' | 'Lax' | 'None';
  expires?: number;
}

/**
 * `AutoTestConfig.auth` 段的具名类型，便于在 agent 层（auth-resolve 等）做类型标注。
 * 字段语义参见 AutoTestConfig.auth 的注释。
 */
export type AuthSpec = NonNullable<AutoTestConfig['auth']>;

export const DEFAULT_CONFIG: AutoTestConfig = {
  version: '1',
  agent: {
    // 不写默认值——model 由 pi-agent 决定。
    // 用 `specmint models select` 锁定到具体 provider/model。
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
    cache: {
      enabled: true,
      ttlMs: 600_000, // 10 分钟
      dir: '.specmint/cache/explore',
    },
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
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    timeoutMs: 30_000,
    browserChannel: 'auto',
  },
  review: {
    requireBeforeRun: true,
    pendingOnGenerate: true,
    reviewerSource: 'git-user',
    // 默认仅 verdict='approved' 自动跑；其余用 CLI 标志开启
    blockedOnRun: ['pending', 'needs-fix', 'rejected'],
    // P1：默认仅 verdict='needs-fix' 可被 heal；其余用 --include-* / --force 放开
    requireBeforeHeal: true,
    blockedOnHeal: ['pending', 'approved', 'rejected', 'skipped'],
  },
};

/**
 * specmint 在仓库内的固定布局常量。
 *
 * 任何自定义路径的需求一律不提供；如确需在非 cwd 运行，可在外部 chdir
 * 或把 .specmint/ 软链接到期望位置。
 */
export const STORAGE_LAYOUT = {
  root: '.specmint',
  cases: '.specmint/cases',
  pages: '.specmint/cases/pages',
  reports: '.specmint/reports',
  configFile: '.specmint/config.json',
  playwrightConfig: '.specmint/playwright.config.ts',
  authDir: '.specmint/auth',
  authStorage: '.specmint/auth/storage',
  /**
   * 前端元素契约文件。前端/AI 代码生成方按约定将带 data-testid 的元素清单
   * 落盘到该路径；specmint 在 generate 阶段读取并注入 prompt。
   * 缺失/为空/损坏时静默降级（null + debug 日志），与现状字节级一致。
   */
  contractFile: '.specmint/contract.json',
} as const;

export interface LoadConfigResult {
  config: AutoTestConfig;
  /** 当前实际使用的配置文件路径（绝对路径） */
  configPath: string;
}

export function loadConfig(cwd: string = process.cwd()): AutoTestConfig {
  return loadConfigDetailed(cwd).config;
}

/**
 * 与 loadConfig 类似，但额外返回配置文件位置信息（供 init 提示用户）。
 */
export function loadConfigDetailed(cwd: string = process.cwd()): LoadConfigResult {
  const primaryPath = join(cwd, STORAGE_LAYOUT.configFile);

  if (!existsSync(primaryPath)) {
    return { config: deepClone(DEFAULT_CONFIG), configPath: primaryPath };
  }

  const config = parseConfigFile(primaryPath);
  return { config, configPath: primaryPath };
}

function parseConfigFile(path: string): AutoTestConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (err) {
    throw new CliError({
      code: ExitCode.IO_ERROR,
      message: `解析 ${path} 失败：${(err as Error).message}`,
      hint: '请运行 `specmint init --force` 重置为默认配置',
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
  const overrideExplore = override.explore as Record<string, unknown> | undefined;
  const baseExploreCache = (base.explore.cache ?? {}) as Record<string, unknown>;
  const overrideExploreCache = (overrideExplore?.cache as Record<string, unknown> | undefined) ?? {};
  // 用户可在 config 里写 `review: null` / `review: false` 显式禁用 review 段；
  // cast 拓宽类型让后面的 null/false 比较有意义。
  const overrideReview = override.review as Partial<ReviewConfig> | null | false | undefined;
  const baseReview = base.review ?? DEFAULT_CONFIG.review!;
  return {
    version: '1',
    agent: { ...base.agent, ...((override.agent as object | undefined) ?? {}) },
    explore: {
      ...base.explore,
      ...(overrideExplore ?? {}),
      // 单独合并 cache 子对象，避免 `enabled=false` 被默认 `true` 覆盖
      cache: { ...baseExploreCache, ...overrideExploreCache },
    },
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
    // review 段：浅合并 + 子段替换；用户禁用 review 时可在 config 写 `review: null`/`false`
    review: overrideReview === null || overrideReview === false
      ? undefined
      : {
          ...baseReview,
          ...(overrideReview ?? {}),
        },
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
