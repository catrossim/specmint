/**
 * Case meta 归一化层
 *
 * 职责：
 * - 把 PI（LLM）输出的可能不规范的字段值转换成稳定的存储格式
 * - 不抛错，只返回 warnings（除非调用方选择 throw）
 *
 * 设计原则：
 * - 不修改类型签名，只接受 unknown 输入
 * - 失败字段返回 null + warnings，不阻塞其他字段
 * - 同义词映射（中文/英文）面向国内 QA 团队习惯
 */
import { PRIORITIES, type Priority } from '../store/types.js';

const PRIORITY_ALIAS_MAP: Record<string, Priority> = {
  紧急: 'P0',
  最高: 'P0',
  CRITICAL: 'P0',
  BLOCKER: 'P0',
  URGENT: 'P0',
  高: 'P1',
  HIGH: 'P1',
  中: 'P2',
  MEDIUM: 'P2',
  NORMAL: 'P2',
  低: 'P3',
  LOW: 'P3',
  MINOR: 'P3',
};

const KEBAB_CASE_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export interface NormalizeResult<T> {
  value: T;
  warnings: string[];
}

/**
 * 把任意输入归一化成 Priority 枚举。
 * - 直接命中（P0/P1/P2/P3，大小写/空格不敏感）→ 返回
 * - 中文/英文同义词映射 → 返回
 * - 其他 → 返回 null，调用方决定是警告还是报错
 */
export function normalizePriority(v: unknown): Priority | null {
  if (typeof v !== 'string') return null;
  const up = v.trim().toUpperCase().replace(/\s+/g, '');
  if (!up) return null;
  if ((PRIORITIES as readonly string[]).includes(up)) return up as Priority;
  return PRIORITY_ALIAS_MAP[up] ?? null;
}

/**
 * 标签归一化：小写化、kebab-case、去空、去重、保序。
 * 不保留原大小写差异，倾向于稳定可比较的存储格式。
 */
export function normalizeTags(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of v) {
    if (typeof item !== 'string') continue;
    const t = item
      .trim()
      .toLowerCase()
      .replace(/\s+/g, '-');
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

/**
 * group 归一化：必须是 kebab-case。失败返回 null（不强行转换拼音/中文）。
 */
export function normalizeGroup(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim().toLowerCase();
  if (!t) return null;
  return KEBAB_CASE_RE.test(t) ? t : null;
}

/**
 * 模块名归一化：保留原文 + 去首尾空白。不做翻译。
 */
export function normalizeModule(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

/**
 * auth 角色名归一化：kebab-case，引用 `.specmint/auth/<auth>.setup.ts`。
 * 失败返回 null（不强行转换）。
 */
export function normalizeAuth(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim().toLowerCase();
  if (!t) return null;
  return /^[a-z0-9]+(-[a-z0-9]+)*$/.test(t) ? t : null;
}

/**
 * 关联单号归一化：去空、去重、保序。
 */
export function normalizeTickets(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of v) {
    if (typeof item !== 'string') continue;
    const t = item.trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

/**
 * 聚合入口：归一化一组字段，返回值 + warnings。
 *
 * 调用方拿到 warnings 后可决定：
 * - 全部 warning 不阻塞（PI generate 时推荐）
 * - 必填字段失败抛错（save_case 工具的强制场景）
 */
export function normalizeCaseMeta(
  raw: Partial<{
    priority: unknown;
    tags: unknown;
    group: unknown;
    module: unknown;
    linkedTickets: unknown;
    auth: unknown;
  }>,
): NormalizeResult<{
  priority: Priority | null;
  tags: string[];
  group: string | null;
  module: string | null;
  linkedTickets: string[];
  auth: string | null;
}> {
  const warnings: string[] = [];

  const priority = normalizePriority(raw.priority);
  if (raw.priority !== undefined && raw.priority !== null && raw.priority !== '' && priority === null) {
    warnings.push(
      `priority 字段 "${String(raw.priority)}" 无法识别，已忽略（应为 ${PRIORITIES.join('|')} 或同义词）`,
    );
  }

  const tags = normalizeTags(raw.tags);

  let group: string | null = null;
  if (raw.group !== undefined && raw.group !== null && raw.group !== '') {
    group = normalizeGroup(raw.group);
    if (group === null) {
      warnings.push(
        `group 字段 "${String(raw.group)}" 不是合法的 kebab-case（小写字母/数字/连字符），已忽略`,
      );
    }
  }

  let moduleName: string | null = null;
  if (raw.module !== undefined && raw.module !== null && raw.module !== '') {
    moduleName = normalizeModule(raw.module);
    if (moduleName === null) {
      warnings.push(`module 字段 "${String(raw.module)}" 为空，已忽略`);
    }
  }

  const linkedTickets = normalizeTickets(raw.linkedTickets);

  let auth: string | null = null;
  if (raw.auth !== undefined && raw.auth !== null && raw.auth !== '') {
    auth = normalizeAuth(raw.auth);
    if (auth === null) {
      warnings.push(
        `auth 字段 "${String(raw.auth)}" 不是合法的 kebab-case，已忽略`,
      );
    }
  }

  return { value: { priority, tags, group, module: moduleName, linkedTickets, auth }, warnings };
}