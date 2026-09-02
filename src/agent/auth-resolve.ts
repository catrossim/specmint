/**
 * Auth 解析器：把 `config.auth` + CLI `--auth <role>` 收敛成一份可直接喂给 Playwright 的 auth 上下文。
 *
 * 优先级（与决策矩阵一致）：
 *   1. CLI `--auth <role>` 显式覆盖一切（role 文件不存在 → fail-fast）
 *   2. `config.auth.storageState`（最高覆盖力，包含 cookies + localStorage）
 *   3. `config.auth.extraHTTPHeaders` / `config.auth.headers`（轻量兜底）
 *   4. `config.auth.cookies`（最弱兜底，需要 newContext 之后 addCookies）
 *   5. 全空 → 返回 `role: 'none'`，调用方负责 warning
 *
 * 设计要点：
 * - `${ENV_VAR}` 占位符在 config 段全部展开，复用 `expandAuthEnv` / `expandAuthHeaders` / `expandAuthCookies`
 * - `fingerprint` 只 hash 路径 / key 名，**绝不 hash value**，避免泄露 token 到日志/缓存 key
 * - `storageStatePath` 是相对 cwd 的展示用路径，落到 `generation.usedAuth` 做审计
 */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve as pathResolve } from 'node:path';
import {
  expandAuthCookies,
  expandAuthEnv,
  expandAuthHeaders,
  type AuthCookieSpec,
  type AuthSpec,
} from '../config.js';

export type ResolvedAuthRole = 'cli' | 'config' | 'config-inline' | 'none';

export interface ResolvedAuth {
  role: ResolvedAuthRole;
  /** 喂给 `browser.newContext({ storageState })` */
  storageState?: string;
  /** 喂给 `browser.newContext({ extraHTTPHeaders })` */
  extraHTTPHeaders?: Record<string, string>;
  /**
   * 仅在没有 storageState 且 cookies 显式配置时存在。
   * 喂给 `context.addCookies()`，必须在 `newContext()` 之后调用。
   */
  cookies?: AuthCookieSpec[];
  /**
   * 缓存指纹：不同登录态 → 不同 cache 文件，避免互相污染。
   * 由路径 / key 名 hash 得出，绝对不会包含 secret value。
   */
  fingerprint: string;
  /**
   * 用于落盘到 `generation.usedAuth.storageStatePath` 的展示路径。
   * 仅 role 为 `cli` / `config` 时存在。
   */
  storageStatePath?: string;
  /**
   * 用于落盘到 `generation.usedAuth.headerKeys` 的 key 列表（值不落盘）。
   */
  headerKeys?: string[];
}

/** `.specmint/auth/storage/` 默认目录（与 `auth init` / `auth refresh` 子命令约定一致）。 */
const AUTH_STORAGE_DIR = '.specmint/auth/storage';

/**
 * 把任意对象序列化成短 fingerprint（8 字符 hex）。
 * 仅用于"两个 auth 上下文是否相同"的等价性判断，不是加密用途。
 */
function fingerprint(input: string): string {
  return createHash('sha1').update(input).digest('hex').slice(0, 8);
}

/**
 * 主入口：合并 config.auth 与 cliRole，得到 ResolvedAuth。
 *
 * @param cfg       config.auth 段（可能 undefined）
 * @param cliRole   CLI `--auth <role>` 显式指定的角色名
 * @param cwd       用于校验 storageState 文件是否存在 + 落盘展示路径（默认 process.cwd()）
 */
export function resolveAuth(
  cfg: AuthSpec | undefined,
  cliRole: string | undefined,
  cwd: string = process.cwd(),
): ResolvedAuth {
  // 1. CLI --auth <role> 优先
  if (cliRole) {
    // 锚定到 cwd：避免用户在 monorepo 子目录跑时路径漂移，也方便测试隔离 tmp 目录
    const path = pathResolve(cwd, AUTH_STORAGE_DIR, `${cliRole}.json`);
    if (!existsSync(path)) {
      throw new Error(
        `[auth] storageState 不存在: ${path}\n` +
          `请先运行: specmint auth refresh ${cliRole}（首次使用需先 specmint auth init ${cliRole} 生成 setup 模板）`,
      );
    }
    return {
      role: 'cli',
      storageState: path,
      fingerprint: fingerprint(`cli:${path}`),
      storageStatePath: path,
    };
  }

  // 2. config.auth.storageState
  if (cfg?.storageState) {
    const expanded = expandAuthEnv(cfg.storageState, 'auth.storageState');
    if (!existsSync(expanded)) {
      throw new Error(
        `[auth] config.auth.storageState 指向的文件不存在: ${expanded}\n` +
          `请检查 config 或运行: specmint auth refresh <role>`,
      );
    }
    return {
      role: 'config',
      storageState: expanded,
      fingerprint: fingerprint(`config:${expanded}`),
      storageStatePath: expanded,
    };
  }

  // 3. headers / extraHTTPHeaders（合并展开，extraHTTPHeaders 字段优先同 key）
  const mergedHeaders = expandAuthHeaders({
    ...cfg?.headers,
    ...cfg?.extraHTTPHeaders,
  });
  if (mergedHeaders && Object.keys(mergedHeaders).length > 0) {
    const keys = Object.keys(mergedHeaders).sort();
    return {
      role: 'config-inline',
      extraHTTPHeaders: mergedHeaders,
      fingerprint: fingerprint(`headers:${keys.join(',')}`),
      headerKeys: keys,
    };
  }

  // 4. cookies（最低兜底，Playwright 需要 addCookies 而非 newContext 参数）
  const expandedCookies = expandAuthCookies(cfg?.cookies);
  if (expandedCookies && expandedCookies.length > 0) {
    const names = expandedCookies.map((c) => c.name).sort();
    return {
      role: 'config-inline',
      cookies: expandedCookies,
      fingerprint: fingerprint(`cookies:${names.join(',')}`),
      // cookies 没有 headerKeys，但可以为审计字段提供一个等价标记
      headerKeys: [],
    };
  }

  // 5. 全空
  return {
    role: 'none',
    fingerprint: fingerprint('none'),
  };
}

/**
 * 把 ResolvedAuth 折算成 `CaseUsedAuth`（用于落盘审计）。
 * 仅传递 role/路径/key，secret value 永不落盘。
 */
export function toCaseUsedAuth(auth: ResolvedAuth): {
  role: 'cli' | 'config' | 'config-inline' | 'none';
  storageStatePath?: string;
  headerKeys?: string[];
} {
  const out: ReturnType<typeof toCaseUsedAuth> = { role: auth.role };
  if (auth.storageStatePath !== undefined) out.storageStatePath = auth.storageStatePath;
  if (auth.headerKeys && auth.headerKeys.length > 0) out.headerKeys = auth.headerKeys;
  return out;
}