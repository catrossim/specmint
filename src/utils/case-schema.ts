/**
 * Case meta 校验层
 *
 * 设计原则：
 * - 仅校验"有明确域"的字段（enum、regex、类型）
 * - 文本描述类字段只校验非空，不限制长度（避免过度设计）
 * - 返回 errors 数组而非 boolean，便于聚合错误信息
 *
 * 严格度分级：
 * - name / priority：严格，错了抛错
 * - group / module / linkedTickets / tags：宽松，错了 warning + 跳过
 */
import { PRIORITIES, type CaseMeta, type Priority } from '../store/types.js';

/**
 * name：支持 "<group>/<kebab-case>" 多段形式（按 / 分隔，每段是 kebab-case）
 * group / module 等单段字段：仅单段 kebab-case
 */
const SEGMENTED_NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*(\/[a-z0-9]+(-[a-z0-9]+)*)*$/;
const SINGLE_KEBAB_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export interface ValidationError {
  field: string;
  message: string;
}

/**
 * 校验 meta 对象（部分字段也可传入）。
 *
 * 严格字段（errors 中含）：
 * - name：必须是 kebab-case
 * - priority：必须是 Priority enum
 *
 * 宽松字段（不报 errors，由 normalize 层处理）：
 * - group / module / linkedTickets / tags
 */
export function validateCaseMeta(meta: Partial<CaseMeta>): ValidationError[] {
  const errors: ValidationError[] = [];

  if (typeof meta.name !== 'string' || !meta.name.trim()) {
    errors.push({ field: 'name', message: 'name 是必填字符串' });
  } else if (!SEGMENTED_NAME_RE.test(meta.name)) {
    errors.push({
      field: 'name',
      message: `name "${meta.name}" 不是合法格式（仅小写字母/数字/连字符，可按 <group>/<name> 分组）`,
    });
  }

  if (meta.priority !== undefined && meta.priority !== null) {
    if (!(PRIORITIES as readonly string[]).includes(meta.priority as string)) {
      errors.push({
        field: 'priority',
        message: `priority 必须是 ${PRIORITIES.join('|')} 之一，当前 ${String(meta.priority)}`,
      });
    }
  }

  if (meta.group !== undefined && meta.group !== null && meta.group !== '') {
    if (typeof meta.group !== 'string' || !SINGLE_KEBAB_RE.test(meta.group)) {
      errors.push({ field: 'group', message: 'group 必须是 kebab-case' });
    }
  }

  if (
    meta.module !== undefined &&
    meta.module !== null &&
    (typeof meta.module !== 'string' || meta.module.length === 0)
  ) {
    errors.push({ field: 'module', message: 'module 必须是非空字符串' });
  }

  if (meta.linkedTickets !== undefined && meta.linkedTickets !== null) {
    if (!Array.isArray(meta.linkedTickets)) {
      errors.push({ field: 'linkedTickets', message: 'linkedTickets 必须是字符串数组' });
    } else if (!meta.linkedTickets.every((t) => typeof t === 'string')) {
      errors.push({ field: 'linkedTickets', message: 'linkedTickets 元素必须是字符串' });
    }
  }

  if (meta.tags !== undefined && meta.tags !== null) {
    if (!Array.isArray(meta.tags)) {
      errors.push({ field: 'tags', message: 'tags 必须是字符串数组' });
    } else if (!meta.tags.every((t) => typeof t === 'string')) {
      errors.push({ field: 'tags', message: 'tags 元素必须是字符串' });
    }
  }

  if (meta.auth !== undefined && meta.auth !== null && meta.auth !== '') {
    if (typeof meta.auth !== 'string' || !SINGLE_KEBAB_RE.test(meta.auth)) {
      errors.push({ field: 'auth', message: 'auth 必须是 kebab-case（引用 .auto-test/auth/<auth>.setup.ts）' });
    }
  }

  return errors;
}

/**
 * 校验失败抛错（用于落盘前最后一道关卡）。
 */
export function throwIfInvalid(meta: Partial<CaseMeta>): void {
  const errors = validateCaseMeta(meta);
  if (errors.length > 0) {
    const detail = errors.map((e) => `${e.field}: ${e.message}`).join('；');
    throw new Error(`Case meta 校验失败：${detail}`);
  }
}

export { SEGMENTED_NAME_RE, SINGLE_KEBAB_RE, PRIORITIES };
export type { Priority };