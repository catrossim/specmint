/**
 * 失败重试工具（指数退避 + 抖动）
 *
 * 设计动机：
 * - LLM 调用偶发超时 / 限流 / 网络抖动，每次都要人肉重跑很烦
 * - 区分"可重试错误"（网络/超时/限流/5xx）和"不可重试错误"（用户/配置/4xx）
 *   → 避免对"参数写错"这类问题傻乎乎重试 3 次浪费 30s
 *
 * 退避策略：
 * - delay = min(baseDelayMs * 2^attempt, maxDelayMs) ± 25% 抖动
 * - 默认：baseDelayMs=1000, maxDelayMs=30000, retries=3
 * - 抖动避免"雷鸣群效应"：客户端同时重试撞上限
 *
 * 默认可重试错误识别（基于 err.message / err.code / err.name / status 启发式）：
 * - network: ECONNRESET / ETIMEDOUT / ECONNREFUSED / EAI_AGAIN / ENOTFOUND / EPIPE
 * - timeout: AbortError / "timeout" / "timed out"
 * - rate limit: 429 / "rate limit" / "too many requests"
 * - 5xx: status 500-599
 *
 * 注意：
 * - 用 AbortSignal 时本工具不接 signal，调用方在 fn 内部自行处理取消
 * - 不可重试错误会立即抛错（不再重试）
 */
export interface RetryOptions {
  /** 最大重试次数（不含首次），默认 3 → 总共最多 4 次尝试 */
  retries?: number;
  /** 首次退避（ms），默认 1000 */
  baseDelayMs?: number;
  /** 单次退避上限（ms），默认 30000 */
  maxDelayMs?: number;
  /** 抖动比例 0~1，默认 0.25（±25%） */
  jitter?: number;
  /** 重试前回调，用于打日志 */
  onRetry?: (info: { attempt: number; delayMs: number; error: Error }) => void;
  /** 自定义可重试判定；不传则用默认 isRetryable */
  isRetryable?: (err: unknown) => boolean;
}

export interface RetryContext {
  attempt: number;       // 当前是第几次尝试（0-based：首次=0）
  totalAttempts: number; // 总尝试次数 = 1 + retries
}

const DEFAULT_RETRIES = 3;
const DEFAULT_BASE_MS = 1000;
const DEFAULT_MAX_MS = 30_000;
const DEFAULT_JITTER = 0.25;

/**
 * 默认可重试判定。覆盖网络抖动、超时、限流、5xx。
 * 启发式基于 err.message / err.name / err.code / 错误对象 status 字段。
 */
export function isRetryableError(err: unknown): boolean {
  if (err === null || typeof err !== 'object') return false;
  const e = err as Record<string, unknown>;
  const msg = String(e['message'] ?? '').toLowerCase();
  const name = String(e['name'] ?? '').toLowerCase();
  const code = e['code'];
  const status = typeof e['status'] === 'number' ? e['status'] : null;

  // 1. 网络层错误码
  if (typeof code === 'string') {
    const c = code.toUpperCase();
    if (
      c === 'ECONNRESET' ||
      c === 'ETIMEDOUT' ||
      c === 'ECONNREFUSED' ||
      c === 'EAI_AGAIN' ||
      c === 'ENOTFOUND' ||
      c === 'EPIPE'
    ) {
      return true;
    }
  }

  // 2. 显式 status：429 / 5xx
  if (status !== null) {
    if (status === 429) return true;
    if (status >= 500 && status < 600) return true;
  }

  // 3. AbortError / timeout（基于名称）
  if (name === 'aborterror') return true;

  // 4. 关键字模糊匹配（兜底，覆盖 LLM SDK 自定义错误）
  if (/timeout|timed out|reset by peer|connection (closed|reset)|fetch failed/i.test(msg)) {
    return true;
  }
  if (/rate limit|too many requests|429/i.test(msg)) {
    return true;
  }
  if (/5\d\d\b|internal server error|bad gateway|service unavailable|gateway timeout/i.test(msg)) {
    return true;
  }

  return false;
}

export function computeDelay(attempt: number, baseMs: number, maxMs: number, jitter: number): number {
  const exp = Math.min(maxMs, baseMs * Math.pow(2, attempt));
  const j = exp * jitter;
  // ±jitter 的随机偏移
  const offset = (Math.random() * 2 - 1) * j;
  return Math.max(0, Math.floor(exp + offset));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 带退避的重试调用。
 *
 * @example
 *   const data = await withRetry(() => fetch(url).then(r => r.json()), {
 *     retries: 3,
 *     baseDelayMs: 1000,
 *     onRetry: ({ attempt, delayMs, error }) =>
 *       logger.warn(`第 ${attempt} 次失败 ${delayMs}ms 后重试: ${error.message}`),
 *   });
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const retries = Math.max(0, opts.retries ?? DEFAULT_RETRIES);
  const baseDelayMs = opts.baseDelayMs ?? DEFAULT_BASE_MS;
  const maxDelayMs = opts.maxDelayMs ?? DEFAULT_MAX_MS;
  const jitter = Math.max(0, Math.min(1, opts.jitter ?? DEFAULT_JITTER));
  const isRetryable = opts.isRetryable ?? isRetryableError;
  const onRetry = opts.onRetry;

  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt >= retries) break;
      if (!isRetryable(err)) break;
      const delayMs = computeDelay(attempt, baseDelayMs, maxDelayMs, jitter);
      const e = err instanceof Error ? err : new Error(String(err));
      onRetry?.({ attempt: attempt + 1, delayMs, error: e });
      await sleep(delayMs);
    }
  }
  throw lastErr;
}