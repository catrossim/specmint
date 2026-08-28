/**
 * 轻量级 Promise 并发限流器
 *
 * 设计动机：
 * - 引入 p-limit 会带来额外依赖（~30KB），对一个本来零依赖的 CLI 工具不划算
 * - 仅 60 行代码、零依赖实现核心 API
 * - 复用同一个 Limit 实例可在多批任务间共享并发配额
 *
 * 用法：
 *   const limit = createLimit(2);
 *   const results = await Promise.allSettled([
 *     limit.run(() => workA()),
 *     limit.run(() => workB()),
 *     limit.run(() => workC()),
 *   ]);
 *   // 最多 2 个并发，第 3 个排队等待
 *
 * 行为约定：
 * - run(fn) 立刻返回 Promise，不阻塞调用方
 * - 保持 FIFO 调度：先入队的任务先启动
 * - 单个任务失败不会阻塞队列中其他任务（finally 推进游标）
 * - 调用方应自行用 Promise.allSettled 或 try/catch 处理部分失败
 */
type Task<T> = {
  run: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
};

export class Limit {
  private readonly concurrency: number;
  private readonly queue: Array<Task<unknown>> = [];
  private active = 0;

  constructor(concurrency: number) {
    if (!Number.isFinite(concurrency) || concurrency < 1) {
      throw new RangeError(
        `Limit: concurrency 必须为 ≥ 1 的正整数, 收到 ${concurrency}`,
      );
    }
    this.concurrency = Math.floor(concurrency);
  }

  /** 当前在飞的任务数（含已启动但未 settle 的） */
  get activeCount(): number {
    return this.active;
  }

  /** 当前排队等待的任务数 */
  get pendingCount(): number {
    return this.queue.length;
  }

  /**
   * 提交一个异步任务，返回的 Promise 在轮到该任务执行时才会启动。
   * 队列满时调用方立刻拿到 Promise，不会阻塞。
   */
  run<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const task: Task<T> = { run: fn, resolve, reject };
      this.queue.push(task as Task<unknown>);
      // 让 microtask 推进队列，避免同步堆栈无限增长
      queueMicrotask(() => this.tick());
    });
  }

  /**
   * 等所有已提交任务完成。
   * 注意：此方法不会"等待"未提交的更多任务；它只等待当前 in-flight + queue 中的任务。
   * 用于确保优雅退出前所有任务都跑完。
   */
  async drain(): Promise<void> {
    while (this.active > 0 || this.queue.length > 0) {
      // 让出宏任务，等一批任务完成
      await new Promise<void>((r) => setTimeout(r, 0));
    }
  }

  private tick(): void {
    // 一次性把可用槽位都填上
    while (this.active < this.concurrency && this.queue.length > 0) {
      const task = this.queue.shift();
      if (!task) break;
      this.active++;
      task
        .run()
        .then(
          (v) => task.resolve(v),
          (e) => task.reject(e),
        )
        .finally(() => {
          this.active--;
          this.tick();
        });
    }
  }
}

export function createLimit(concurrency: number): Limit {
  return new Limit(concurrency);
}