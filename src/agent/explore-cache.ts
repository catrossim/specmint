/**
 * explorePage 快照缓存
 *
 * 动机：
 * - explorePage 每次都会启动浏览器、goto 页面、跑 2 个 page.evaluate，
 *   即便用 headless chromium，单次 5~15s 是常态。
 * - generate 同 URL 多次迭代时（调整 prompt、试不同 --priority、批量衍生用例），
 *   重复打开浏览器毫无收益。
 *
 * 设计取舍：
 * - 缓存 key 由「URL + 探索参数 + 可选 storageState hash」拼接 sha256 得到，
 *   任一参数变化都会 miss，避免脏读。
 * - TTL 默认 10 分钟，可配；过期自动失效，无需主动清理。
 * - 读/写失败一律不抛错——降级为 miss / 静默 noop,不让缓存层成为故障源。
 * - 不引入新依赖（只用 node:crypto / node:fs），启动期零开销。
 *
 * 缓存目录：
 * - 默认 .auto-test/cache/explore/<key>.json
 * - 由 config.explore.cache.dir 覆盖
 */
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import { logger } from '../utils/logger.js';
import type { ExploreResult } from './explore.js';

export interface ExploreCacheKeyParams {
  url: string;
  headless: boolean;
  timeoutMs: number;
  maxElements: number;
  waitUntil: 'load' | 'domcontentloaded' | 'networkidle';
  /** 可选：与登录态绑定的额外指纹，避免不同角色复用同一份快照 */
  storageStateFingerprint?: string;
}

export interface ExploreCacheEntry {
  /** 缓存文件版本，便于以后不兼容升级时清理 */
  version: 1;
  key: string;
  createdAt: number;
  expiresAt: number;
  params: ExploreCacheKeyParams;
  result: Omit<ExploreResult, 'fromCache' | 'durationMs'> & { durationMs: number };
}

export interface ReadCacheOptions {
  dir: string;
  /** 当前时间，便于测试注入 */
  now?: () => number;
}

export interface WriteCacheOptions {
  dir: string;
  ttlMs: number;
  /** 当前时间，便于测试注入 */
  now?: () => number;
}

/** 计算缓存 key（稳定排序参数 → sha256 hex 前 32 字符） */
export function computeCacheKey(params: ExploreCacheKeyParams): string {
  const normalized = {
    u: params.url.trim(),
    h: params.headless,
    t: params.timeoutMs,
    m: params.maxElements,
    w: params.waitUntil,
    s: params.storageStateFingerprint ?? '',
  };
  const json = JSON.stringify(normalized, Object.keys(normalized).sort());
  return createHash('sha256').update(json).digest('hex').slice(0, 32);
}

function cacheFilePath(dir: string, key: string): string {
  return join(dir, `${key}.json`);
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

/**
 * 读取缓存。命中且未过期时返回 ExploreResult(fromCache=true)；
 * miss / 过期 / 损坏 一律返回 null，不抛错。
 */
export function readExploreCache(
  params: ExploreCacheKeyParams,
  opts: ReadCacheOptions,
): ExploreResult | null {
  const key = computeCacheKey(params);
  const file = cacheFilePath(opts.dir, key);
  if (!existsSync(file)) return null;

  const now = opts.now ? opts.now() : Date.now();
  try {
    const raw = readFileSync(file, 'utf-8');
    const entry = JSON.parse(raw) as ExploreCacheEntry;
    if (entry.version !== 1) return null;
    if (entry.key !== key) return null;
    if (!entry.expiresAt || entry.expiresAt <= now) return null;
    if (typeof entry.result?.accessibilitySnapshot !== 'string') return null;
    if (typeof entry.result?.interactiveElements !== 'string') return null;

    return {
      url: entry.result.url,
      title: entry.result.title,
      accessibilitySnapshot: entry.result.accessibilitySnapshot,
      interactiveElements: entry.result.interactiveElements,
      durationMs: 0,
      fromCache: true,
    };
  } catch (err) {
    logger.debug(
      `[explore-cache] 读取失败，按 miss 处理: ${(err as Error).message}`,
      { file },
    );
    return null;
  }
}

/**
 * 写入缓存。失败仅 warn，不影响主流程。
 *
 * 选择「先写再返回」而非异步 flush：explorePage 是 CLI 命令调用栈内的一次性动作，
 * 写盘开销（<10ms）相对浏览器启动开销（5~15s）可忽略；阻塞保证命令退出前缓存落盘。
 */
export function writeExploreCache(
  params: ExploreCacheKeyParams,
  result: ExploreResult,
  opts: WriteCacheOptions,
): void {
  try {
    ensureDir(opts.dir);
    const key = computeCacheKey(params);
    const now = opts.now ? opts.now() : Date.now();
    const entry: ExploreCacheEntry = {
      version: 1,
      key,
      createdAt: now,
      expiresAt: now + Math.max(0, opts.ttlMs),
      params,
      result: {
        url: result.url,
        title: result.title,
        accessibilitySnapshot: result.accessibilitySnapshot,
        interactiveElements: result.interactiveElements,
        durationMs: result.durationMs,
      },
    };
    const file = cacheFilePath(opts.dir, key);
    writeFileSync(file, JSON.stringify(entry), 'utf-8');
    logger.debug(
      `[explore-cache] 已写入: key=${key} ttl=${opts.ttlMs}ms`,
      { file, expiresAt: entry.expiresAt },
    );
  } catch (err) {
    logger.warn(
      `[explore-cache] 写入失败（已忽略）: ${(err as Error).message}`,
    );
  }
}

/** 默认缓存目录：.auto-test/cache/explore */
export const DEFAULT_EXPLORE_CACHE_DIR = '.auto-test/cache/explore';

/**
 * 列出某目录下所有缓存文件的轻量元数据，便于做 `auto-test explore cache list` /
 * `auto-test explore cache clear` 之类的诊断命令（暂不实现 CLI，留口子）。
 */
export interface CacheFileMeta {
  key: string;
  file: string;
  sizeBytes: number;
  createdAt: number;
  expiresAt: number;
}

export function listCacheFiles(dir: string): CacheFileMeta[] {
  if (!existsSync(dir)) return [];
  try {
    const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
    const out: CacheFileMeta[] = [];
    for (const f of files) {
      const file = join(dir, f);
      try {
        const raw = readFileSync(file, 'utf-8');
        const entry = JSON.parse(raw) as ExploreCacheEntry;
        const sizeBytes = statSync(file).size;
        out.push({
          key: entry.key ?? f.replace(/\.json$/, ''),
          file,
          sizeBytes,
          createdAt: entry.createdAt,
          expiresAt: entry.expiresAt,
        });
      } catch {
        // 忽略损坏文件
      }
    }
    return out;
  } catch {
    return [];
  }
}