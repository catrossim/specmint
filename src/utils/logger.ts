/**
 * 轻量日志器
 *
 * 设计原则：
 * - 默认写 stderr，便于与 `--json` 输出（stdout）分离
 * - 级别可通过环境变量 `SPECMINT_LOG` 控制：`debug` | `info` | `warn` | `error`
 * - 提供 `setJsonMode()` 切换到结构化输出，便于后续接入
 */
type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };

class Logger {
  private threshold: number;
  private jsonMode = false;

  constructor() {
    const envLevel = (process.env.SPECMINT_LOG ?? 'info').toLowerCase() as Level;
    this.threshold = LEVELS[envLevel] ?? LEVELS.info;
  }

  setLevel(level: Level): void {
    this.threshold = LEVELS[level];
  }

  setJsonMode(enabled: boolean): void {
    this.jsonMode = enabled;
  }

  private log(level: Level, msg: string, meta?: Record<string, unknown>): void {
    if (LEVELS[level] < this.threshold) return;

    if (this.jsonMode) {
      const payload = { level, time: new Date().toISOString(), msg, ...meta };
      process.stdout.write(JSON.stringify(payload) + '\n');
      return;
    }

    const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
    const prefix = `[${level.toUpperCase()}]`;
    stream.write(`${prefix} ${msg}\n`);
  }

  debug(msg: string, meta?: Record<string, unknown>): void {
    this.log('debug', msg, meta);
  }
  info(msg: string, meta?: Record<string, unknown>): void {
    this.log('info', msg, meta);
  }
  warn(msg: string, meta?: Record<string, unknown>): void {
    this.log('warn', msg, meta);
  }
  error(msg: string, meta?: Record<string, unknown>): void {
    this.log('error', msg, meta);
  }
}

export const logger = new Logger();
export type { Level };