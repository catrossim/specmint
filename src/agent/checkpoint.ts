/**
 * 批量生成的中断恢复（checkpoint）
 *
 * 动机：
 * - 跑 10 条用例跑到第 8 条时 Ctrl-C / 网络断开 / 进程被 OOM kill
 * - 重新跑要从头再来 = 浪费前 7 条的 LLM 调用（几分钟～几十分钟）
 * - 落一份进度到磁盘：每条完成 → 增量写 → 重跑时自动跳过已完成
 *
 * 设计取舍：
 * - state file 用原子写（writeFileSync → rename），避免半写入损坏
 * - 失败容忍：读损坏 state 视为不存在，不抛错
 * - 跳过语义：按 description 字符串精确匹配（trim 后），ok/false 都跳过
 *   → 用户可以"重跑失败的"，但要新建 state（不然旧的失败会被跳过）
 * - 完成态清理：所有 description 完成且全部成功 → 删除 state file
 *   → 部分失败保留 state（方便诊断 + 手动重跑失败项）
 *
 * 文件命名：`<dir>/generate-<startedAt>-<shortId>.state.json`
 *   - startedAt 让 ls 能按时间排序
 *   - shortId（4 字符 base32）避免同秒多个 state 重名
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface BatchState {
  /** state 文件版本，便于不兼容升级时清理 */
  version: 1;
  /** 唯一标识（短 hash） */
  id: string;
  /** 起始时间戳（ms） */
  startedAt: number;
  /** 最近更新时间戳（ms） */
  updatedAt: number;
  /** 工作目录（用于校验 resume 时是否同 cwd） */
  cwd: string;
  /** 原始描述列表（保留顺序） */
  descriptions: string[];
  /** 探索 URL（可空） */
  url?: string;
  /** 用例优先级（避免 resume 时改了优先级导致错位） */
  priority: string;
  /** 并发度（resume 时不强校验，仅记录） */
  concurrency: number;
  /** 已完成的条目（按 description 去重，后续按时间序追加） */
  completed: BatchStateCompletion[];
  /** 全部完成的最终标记（部分失败时为 false） */
  finished: boolean;
  /** finished 时的总耗时 */
  finishedAt?: number;
  totalDurationMs?: number;
}

export interface BatchStateCompletion {
  description: string;
  ok: boolean;
  /** 用例名（LLM 推断），用于日志展示 */
  name?: string;
  /** spec 文件路径，便于 resume 后快速检查 */
  specPath?: string;
  durationMs: number;
  error?: string;
}

export const DEFAULT_CHECKPOINT_DIR = '.specmint/runs';

/**
 * 生成 state id：
 * - `generate-<startedAt>-<shortHash>` 形式
 * - shortHash 用 process.pid + 时间戳 + 4 字节随机数混合
 */
export function createStateId(startedAt: number): string {
  const seed = `${process.pid}-${startedAt}-${randomBytes(4).toString('hex')}`;
  const short = createHash('sha256').update(seed).digest('hex').slice(0, 6);
  return `generate-${startedAt}-${short}`;
}

export function stateFilePath(dir: string, id: string): string {
  return join(dir, `${id}.state.json`);
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/**
 * 原子写：写到同目录的临时文件，然后 rename 到目标位置。
 * 避免崩溃时留下半写入的损坏文件。
 */
function atomicWriteSync(file: string, content: string): void {
  const tmp = `${file}.tmp-${randomBytes(3).toString('hex')}`;
  writeFileSync(tmp, content, 'utf-8');
  renameSync(tmp, file);
}

/**
 * 创建新 state 文件。返回 state 对象（已落盘）。
 */
export function createState(
  dir: string,
  payload: {
    cwd: string;
    descriptions: string[];
    url?: string;
    priority: string;
    concurrency: number;
  },
): BatchState {
  const startedAt = Date.now();
  const id = createStateId(startedAt);
  const state: BatchState = {
    version: 1,
    id,
    startedAt,
    updatedAt: startedAt,
    cwd: payload.cwd,
    descriptions: payload.descriptions.slice(),
    url: payload.url,
    priority: payload.priority,
    concurrency: payload.concurrency,
    completed: [],
    finished: false,
  };
  writeState(dir, state);
  return state;
}

/**
 * 读取 state。返回 null 表示文件不存在或损坏（绝不抛错）。
 */
export function loadState(file: string): BatchState | null {
  if (!existsSync(file)) return null;
  try {
    const raw = readFileSync(file, 'utf-8');
    const parsed = JSON.parse(raw) as BatchState;
    if (parsed.version !== 1) return null;
    if (!Array.isArray(parsed.descriptions)) return null;
    if (!Array.isArray(parsed.completed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * 写入 state。原子写。失败仅警告，不抛错。
 */
export function writeState(dir: string, state: BatchState): void {
  try {
    ensureDir(dir);
    const file = stateFilePath(dir, state.id);
    state.updatedAt = Date.now();
    atomicWriteSync(file, JSON.stringify(state, null, 2));
  } catch (err) {
    // 写入失败不能影响主流程：仅 stderr 打 warn
    process.stderr.write(
      `[checkpoint] 写入失败（已忽略）: ${(err as Error).message}\n`,
    );
  }
}

/**
 * 合并一条完成结果到 state（同 description 覆盖旧记录），并写回磁盘。
 * 用于 runBatch 中每条用例跑完后调用。
 */
export function recordCompletion(
  dir: string,
  state: BatchState,
  completion: BatchStateCompletion,
): void {
  // 替换已存在的同名 completion（防止重跑被错误追加成多条）
  const idx = state.completed.findIndex(
    (c) => c.description === completion.description,
  );
  if (idx >= 0) {
    state.completed[idx] = completion;
  } else {
    state.completed.push(completion);
  }
  writeState(dir, state);
}

/**
 * 把已完成/失败的 description 转成 Set，便于 runBatch 过滤。
 */
export function completedSet(state: BatchState): Set<string> {
  return new Set(state.completed.map((c) => c.description));
}

/**
 * 标记 state 完成（finished=true，写 finishedAt + totalDurationMs）。
 */
export function finishState(
  dir: string,
  state: BatchState,
  totalDurationMs: number,
  allOk: boolean,
): void {
  state.finished = allOk;
  state.finishedAt = Date.now();
  state.totalDurationMs = totalDurationMs;
  writeState(dir, state);
}

/**
 * 删除 state 文件。成功完成时调用清理；部分失败保留（供诊断）。
 */
export function deleteState(dir: string, state: BatchState): void {
  const file = stateFilePath(dir, state.id);
  if (existsSync(file)) {
    try {
      unlinkSync(file);
    } catch {
      // 忽略
    }
  }
}