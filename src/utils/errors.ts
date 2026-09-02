/**
 * 结构化错误与退出码常量
 *
 * 设计原则：
 * - 错误面向 agent 消费，固定结构 `{ code, message, hint }`
 * - 退出码语义清晰，便于 shell 脚本/CI 判断
 */
export const ExitCode = {
  OK: 0,
  GENERIC_ERROR: 1,
  USAGE_ERROR: 2,        // 参数错误
  NOT_IMPLEMENTED: 3,    // 子命令尚未实现
  NOT_FOUND: 4,          // 资源不存在
  ALREADY_EXISTS: 5,     // 重复创建
  AGENT_ERROR: 6,        // pi-agent 调用失败
  TEST_FAILED: 7,        // 用例运行失败
  IO_ERROR: 8,           // 文件读写失败
  LINT_FAILED: 9,        // spec 静态校验未通过（lint / adopt）
  // --- auth 子系统细分（10-19）---
  // 关键设计：所有 auth 子命令共享一组细分码，使得 `auth doctor` / `auth refresh` / `auth lint`
  // 失败时退出码语义稳定，CI/上层脚本可基于退出码做差异化处理。
  AUTH_NOT_FOUND: 10,         // storageState 文件缺失
  AUTH_EXPIRED: 11,           // storageState 距上次刷新超过阈值（warn-only 默认；非 0 退出）
  AUTH_LOGIN_FAILED: 12,      // setup 文件登录步骤失败（refresh 子进程非 0 退出）
  AUTH_INCOMPLETE_SETUP: 13,  // setup 文件缺 storageState 调用 / 缺登录成功断言（lint 检出）
  AUTH_DOMAIN_MISMATCH: 14,   // Cookie 域名与 config.baseURL 不匹配
  // --- v0.7.0 新增 ---
  VERIFY_FAILED: 15,          // spec 静态可达性校验未通过（lint 之上、run 之下）
} as const;
export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];

export type ErrorPayload = {
  code: ExitCodeValue;
  message: string;
  hint?: string;
  details?: unknown;
};

export class CliError extends Error {
  readonly code: ExitCodeValue;
  readonly hint?: string;
  readonly details?: unknown;

  constructor(payload: ErrorPayload) {
    super(payload.message);
    this.name = 'CliError';
    this.code = payload.code;
    this.hint = payload.hint;
    this.details = payload.details;
  }

  toJSON(): ErrorPayload {
    return {
      code: this.code,
      message: this.message,
      hint: this.hint,
      details: this.details,
    };
  }
}

/** 构造"子命令尚未实现"错误的便捷工厂 */
export function notImplementedError(cmd: string, task: string): CliError {
  return new CliError({
    code: ExitCode.NOT_IMPLEMENTED,
    message: `子命令 "${cmd}" 尚未实现`,
    hint: `正在等待计划任务 "${task}" 完成。当前可用的子命令：init`,
  });
}