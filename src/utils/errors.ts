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