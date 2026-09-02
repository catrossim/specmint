/**
 * 用例库与运行历史的共享类型
 *
 * 设计原则：
 * - 这些类型与 .meta.json / run.json 落盘结构严格对应，修改字段请同步更新模板与 storage 实现
 * - 所有时间字段使用 ISO 8601 字符串
 * - 所有"枚举"用字面量联合表达，确保序列化/反序列化安全
 */

// ============================================================================
// 用例（Case）
// ============================================================================

/**
 * 优先级枚举
 * - P0：冒烟测试 / 核心主流程 / 阻塞性场景
 * - P1：重要功能 / 常规回归
 * - P2：次要功能 / 边界条件
 * - P3：建议性 / 低优先级
 *
 * 注意：所有写入路径（generate / update）会严格校验 enum 值；不规范写法
 * （"高"/"high"/"p0"）由 normalizePriority() 归一化后再校验。
 */
export const PRIORITIES = ['P0', 'P1', 'P2', 'P3'] as const;
export type Priority = (typeof PRIORITIES)[number];

export type CaseGenerationMode = 'description-only' | 'explore-assisted';
export type CaseSourceType = 'generated' | 'manual' | 'imported';
export type CaseStatus =
  | 'never'
  | 'passed'
  | 'failed'
  | 'skipped'
  | 'timedOut'
  | 'interrupted';

export interface SelectorPolicy {
  prefer: string[];
  avoid: string[];
}

export interface CaseGeneration {
  mode: CaseGenerationMode;
  /**
   * 生成时使用的模型标识（如 "anthropic/claude-sonnet-latest"）。
   * 可选——未设置时由 pi-agent ModelRuntime 选第一个可用 model。
   */
  model?: string;
  /** 仅在 explore-assisted 模式下有值 */
  exploredUrl: string | null;
  selectorPolicy: SelectorPolicy;
  /**
   * 生成时实际注入的登录态上下文（仅 explore-assisted 模式有意义）。
   * **只存 role/路径/key，不存实际 token/cookie 值**，避免敏感信息落盘。
   * 详见 CaseUsedAuth。
   */
  usedAuth?: CaseUsedAuth;
}

/**
 * 记录"这条用例生成时用了哪种登录态"，便于回放/审计/分享时知道身份上下文。
 *
 * - `role`：`'cli'`（CLI `--auth <role>` 显式指定）/ `'config'`（config.auth.storageState） /
 *   `'config-inline'`（headers/cookies 兜底）/ `'none'`（未登录态跑过）
 * - `storageStatePath`：相对 cwd 的 storageState 文件路径（仅 role 为 cli/config 时存在）
 * - `headerKeys`：注入的 extraHTTPHeaders 的 key 列表（值不落盘）
 */
export interface CaseUsedAuth {
  role: 'cli' | 'config' | 'config-inline' | 'none';
  storageStatePath?: string;
  headerKeys?: string[];
}

export interface CaseSource {
  type: CaseSourceType;
  /** 原始需求描述（生成）或触发命令（手动导入） */
  input: string;
  /** pi-agent 调用 trace 文件相对路径（可选，由 generate 子命令写入） */
  agentTrace?: string;
}

export interface CaseStats {
  runCount: number;
  lastStatus: CaseStatus;
  lastRunAt: string | null;
  lastRunId: string | null;
  /** 加权平均（按出现次数线性累加），单位 ms */
  averageDurationMs: number;
}

/** 人工裁决结果枚举（缺失视为 'pending'）。 */
export const REVIEW_VERDICTS = ['pending', 'approved', 'needs-fix', 'rejected', 'skipped'] as const;
export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number];

/** 人工裁决状态。 */
export interface ReviewState {
  verdict: ReviewVerdict;
  /** 裁决人 / 渠道标识；缺失时回落到 defaultReviewer() */
  reviewer?: string;
  /** ISO 8601 时间戳 */
  reviewedAt?: string;
  /** 备注；`""` 表示显式清空，`undefined` 表示未设置 */
  note?: string;
}

export interface PageObjectRef {
  enabled: boolean;
  /** 相对 casesDir 的 POM 文件路径，如 "./pages/login.page.ts" */
  file: string | null;
}

export interface CaseMeta {
  name: string;
  description: string;
  /**
   * 用例优先级（任务 2 引入）。
   * - 必填语义，但**类型可选**保证老 meta.json 不报错
   * - 写入时由 validateCaseMeta() 严格校验 enum
   * - 缺失时 list / run 视为"未分级"
   */
  priority?: Priority;
  /** 所属功能模块分组（kebab-case，例如 "auth"）。可选。 */
  group?: string;
  /** 模块中文名（用于跨项目报告归类），例如 "用户认证"。可选。 */
  module?: string;
  /** 关联的 Jira / 需求单号。可选。 */
  linkedTickets?: string[];
  /**
   * 关联的 auth 角色名（阶段 2 引入）。
   * 引用 `.specmint/auth/<auth>.setup.ts`；未设置表示公开页 / 无登录需求。
   * list / run 时可按 --auth <name> 过滤。
   */
  auth?: string;
  createdAt: string;
  updatedAt: string;
  tags: string[];
  source: CaseSource;
  generation: CaseGeneration;
  pageObject: PageObjectRef;
  stats: CaseStats;
  /**
   * spec.ts 内容哈希（sha256 前 16 位），由 adopt / updateCode 写入。
   *
   * 用途：检测「已裁决用例被偷偷改过」。adopt 时若发现当前内容哈希与本字段不一致，
   * 且 verdict=approved，则自动回落 pending——审核过的东西被改了就不再是原来那个 approved。
   * 这是人工审核可信度的基础，缺失该字段时跳过检测（兼容历史 meta）。
   */
  contentHash?: string;
  /**
   * 人工裁决（人工仲裁）状态。缺失或 verdict 未设视为 'pending'。
   * 仅作为元信息持久化；不参与 run / heal 的执行语义（待 P1 接入）。
   */
  review?: ReviewState;
}

/** 列表展示用的精简视图（不含 stats 全量） */
export interface CaseSummary {
  name: string;
  description: string;
  priority?: Priority;
  auth?: string;
  /** 功能模块中文名（来自 meta.module），便于按模块聚合展示 */
  module?: string;
  /** 功能模块分组（来自 meta.group，与 name 前缀一致），与物理子目录对应 */
  group?: string;
  tags: string[];
  status: CaseStatus;
  lastRunAt: string | null;
  /** 相对 cwd */
  specPath: string;
  metaPath: string;
  pageObjectFile: string | null;
  /**
   * 人工裁决结果。缺失或 meta.review.verdict 未设时视为 'pending'。
   * 供 `specmint review list --pending` 与 `list` 的 REVIEW 列使用。
   */
  reviewVerdict?: ReviewVerdict;
}

/** 含代码的完整用例视图（供 agent 生成/修复时使用） */
export interface CaseWithCode extends CaseMeta {
  code: string;
  pageObjectCode?: string;
}

// ============================================================================
// 运行（Run）
// ============================================================================

export type RunStatus =
  | 'running'
  | 'passed'
  | 'failed'
  | 'timedOut'
  | 'interrupted'
  | 'error';

export interface TestAttachment {
  name: string;
  /** 相对 cwd */
  path: string;
  contentType: string;
}

export interface TestError {
  message: string;
  stack?: string;
}

export interface TestResult {
  /** 形如 "tests/login.spec.ts::test.describe('登录') > login success" */
  testId: string;
  title: string;
  /** 关联的用例名（spec 文件名去后缀），用于 stats 关联 */
  caseName: string;
  status: CaseStatus;
  durationMs: number;
  /** 当前第几次 retry（0 表示首次） */
  retry: number;
  error?: TestError;
  attachments: TestAttachment[];
  startedAt: string;
  finishedAt: string;
}

export interface RunTotals {
  passed: number;
  failed: number;
  skipped: number;
  timedOut: number;
  interrupted: number;
  durationMs: number;
}

export interface RunConfigSnapshot {
  configPath: string;
  baseURL: string | null;
  retries: number;
  workers: number;
  browser: string;
}

export interface RunRecord {
  runId: string;
  startedAt: string;
  finishedAt: string | null;
  status: RunStatus;
  pattern: string | null;
  /** 触发命令的 argv 字符串 */
  command: string;
  totals: RunTotals;
  results: TestResult[];
  config: RunConfigSnapshot;
  /** 可选：批次语义标签（来自 CLI --label），与 runId 末段一致 */
  label?: string;
  notes?: string;
}

export interface RunSummary {
  runId: string;
  startedAt: string;
  finishedAt: string | null;
  status: RunStatus;
  totals: RunTotals;
  failedTests: string[];
}