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
  /** 生成时使用的模型标识（来自 auto-test.config.json 的 agent.model） */
  model: string;
  /** 仅在 explore-assisted 模式下有值 */
  exploredUrl: string | null;
  selectorPolicy: SelectorPolicy;
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

export interface PageObjectRef {
  enabled: boolean;
  /** 相对 casesDir 的 POM 文件路径，如 "./pages/login.page.ts" */
  file: string | null;
}

export interface CaseMeta {
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  tags: string[];
  source: CaseSource;
  generation: CaseGeneration;
  pageObject: PageObjectRef;
  stats: CaseStats;
}

/** 列表展示用的精简视图（不含 stats 全量） */
export interface CaseSummary {
  name: string;
  description: string;
  tags: string[];
  status: CaseStatus;
  lastRunAt: string | null;
  /** 相对 cwd */
  specPath: string;
  metaPath: string;
  pageObjectFile: string | null;
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