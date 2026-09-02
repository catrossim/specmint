/**
 * spec-lint 插件化配置加载（v0.7.0 新增）
 *
 * 设计原则：
 * - 默认行为不变（无配置文件时，LINT_RULES 默认 severity 生效）
 * - 配置存在时，仅做 severity override，不允许新增 / 删除内置规则
 * - 'off' 完全禁用某条规则；'warn' 降级；'error' 升级
 * - 不做运行时 JS plugin（避免引入 Node API 依赖 CLI 体积）
 *
 * 配置文件位置：`.specmint/lint-rules.json`（与 config.json / contract.json 同策略，路径不可改）
 *
 * 文件格式：
 * ```json
 * {
 *   "extends": "specmint:recommended",
 *   "rules": {
 *     "debug-leftover": "error",
 *     "brittle-selector": "off"
 *   }
 * }
 * ```
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CliError, ExitCode } from './errors.js';
import { logger } from './logger.js';
import { STORAGE_LAYOUT } from '../config.js';

/** 每条规则的覆盖值；'off' = 完全禁用 */
export type LintRuleSeverity = 'error' | 'warn' | 'off';

/** 覆盖 map：key 是规则 id，value 是目标 severity */
export type LintRulesOverrides = Record<string, LintRuleSeverity>;

const VALID_SEVERITY: ReadonlySet<string> = new Set(['error', 'warn', 'off']);

/**
 * 加载 `.specmint/lint-rules.json` 覆盖配置。
 *
 * 行为：
 * - 文件不存在 → 返回 {}（默认行为不变）
 * - readFileSync 异常 / JSON.parse 失败 / 结构不合法 → CliError(IO_ERROR)
 * - rule value 不是 'error'|'warn'|'off' → CliError(IO_ERROR)
 * - rule key 不在已知规则 id 集合中 → 在 spec-lint 应用阶段 logger.warn（不在此处做，
 *   避免 utils/lint-plugin 与 utils/spec-lint 形成循环依赖）
 */
export function loadLintRulesOverrides(cwd: string): LintRulesOverrides {
  const path = join(cwd, STORAGE_LAYOUT.lintRulesFile);

  if (!existsSync(path)) {
    logger.debug('lint-rules config not found, use defaults', { path });
    return {};
  }

  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (err) {
    throw new CliError({
      code: ExitCode.IO_ERROR,
      message: `lint 配置文件读取失败：${(err as Error).message}`,
      hint: `检查文件权限与编码：${path}`,
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new CliError({
      code: ExitCode.IO_ERROR,
      message: `lint 配置文件 JSON 解析失败：${(err as Error).message}`,
      hint: `用 JSON 校验工具检查语法：${path}`,
    });
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new CliError({
      code: ExitCode.IO_ERROR,
      message: 'lint 配置文件根节点必须是 JSON 对象',
      hint: `参考配置结构：${path}`,
    });
  }

  const obj = parsed as Record<string, unknown>;

  // extends 字段（v0.7.0 仅接受 specmint:recommended，留口用于未来扩展更多预设）
  if (obj.extends !== undefined && obj.extends !== 'specmint:recommended') {
    throw new CliError({
      code: ExitCode.IO_ERROR,
      message: `不支持的 extends：${String(obj.extends)}（当前仅支持 "specmint:recommended"）`,
      hint: '省略 extends 字段即可',
    });
  }

  // rules 字段
  const rulesRaw = (obj.rules as Record<string, unknown> | undefined) ?? {};
  if (typeof rulesRaw !== 'object' || Array.isArray(rulesRaw)) {
    throw new CliError({
      code: ExitCode.IO_ERROR,
      message: 'lint 配置文件 rules 字段必须是对象',
      hint: `参考配置结构：${path}`,
    });
  }

  const overrides: LintRulesOverrides = {};
  for (const [key, value] of Object.entries(rulesRaw)) {
    if (!VALID_SEVERITY.has(String(value))) {
      throw new CliError({
        code: ExitCode.IO_ERROR,
        message: `规则 "${key}" 的 severity 必须是 "error" | "warn" | "off"，实际是 ${JSON.stringify(value)}`,
        hint: `参考配置结构：${path}`,
      });
    }
    overrides[key] = value as LintRuleSeverity;
  }

  return overrides;
}