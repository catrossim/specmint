/**
 * 前端元素契约子系统（P0 极简版）
 *
 * 契约文件固定在 `.specmint/contract.json`（与 `configFile` 同策略，"路径不可配置"）。
 * 契约只承担"LLM 看到的内容"这一角色：
 *   - 缺失 / elements:[] → 静默降级为 null，跳过 prompt 注入，与现状字节级一致
 *   - JSON.parse 失败 / version 不匹配 / elements 非数组 → CliError(IO_ERROR)
 *
 * 明确不做（保持极简）：
 *   - name 唯一性校验（契约是声明性元素清单，错位元素一律忽略即可）
 *   - 与 selectorPolicy.prefer 交叉校验（语义不交叉）
 *   - 错误聚合（fail-fast 与项目惯例一致）
 *   - 契约扫描 / 自动注入（推迟到 P1）
 *
 * 模块依赖方向：contract.ts 是叶子模块，不依赖 prompts.ts；
 * 契约段是字符串，由调用方（generate.ts）渲染后传入 PromptInput.contractSection。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CliError, ExitCode } from './utils/errors.js';
import { logger } from './utils/logger.js';
import { STORAGE_LAYOUT } from './config.js';

/** 单个元素契约条目（扁平结构，便于直接渲染到 markdown 表格） */
export interface ContractElement {
  /** 元素标识，如 login-submit-button */
  name: string;
  /** data-testid 值（getByTestId 目标） */
  testId?: string;
  /** ARIA role（getByRole 目标） */
  role?: string;
  /** 表单 label（getByLabel 目标） */
  label?: string;
  /** 文本内容（getByText / placeholder 等） */
  text?: string;
  /** 用途说明，会渲染进 prompt 帮助 LLM 理解 */
  description?: string;
}

/** 契约文件根对象 */
export interface Contract {
  version: '1';
  elements: ContractElement[];
}

const CONTRACT_VERSION = '1' as const;

/**
 * 加载契约。固定路径 `${cwd}/${STORAGE_LAYOUT.contractFile}`。
 *
 * 降级策略：
 *   - 文件不存在 → null + logger.debug
 *   - elements 为空数组 → null + logger.debug
 *
 * 失败策略（与 `loadConfig` 错误语义一致）：
 *   - readFileSync 异常 / JSON.parse 失败 / 结构不合法 → CliError(IO_ERROR)
 */
export function loadContract(cwd: string): Contract | null {
  const path = join(cwd, STORAGE_LAYOUT.contractFile);

  if (!existsSync(path)) {
    logger.debug('contract file not found, skip injection', { path });
    return null;
  }

  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (err) {
    throw new CliError({
      code: ExitCode.IO_ERROR,
      message: `契约文件读取失败：${(err as Error).message}`,
      hint: `检查文件权限与编码：${path}`,
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new CliError({
      code: ExitCode.IO_ERROR,
      message: `契约文件 JSON 解析失败：${(err as Error).message}`,
      hint: `用 JSON 校验工具检查语法：${path}`,
    });
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new CliError({
      code: ExitCode.IO_ERROR,
      message: '契约文件根节点必须是 JSON 对象',
      hint: `参考契约结构：${path}`,
    });
  }

  const obj = parsed as Record<string, unknown>;
  if (obj.version !== CONTRACT_VERSION) {
    throw new CliError({
      code: ExitCode.IO_ERROR,
      message: `契约 version 不匹配（期望 "${CONTRACT_VERSION}"，实际 "${String(obj.version)}"）`,
      hint: `当前 specmint 仅支持 version "${CONTRACT_VERSION}"`,
    });
  }

  if (!Array.isArray(obj.elements)) {
    throw new CliError({
      code: ExitCode.IO_ERROR,
      message: '契约 elements 字段必须是数组',
      hint: `参考契约结构：${path}`,
    });
  }

  if (obj.elements.length === 0) {
    logger.debug('contract is empty, skip injection', { path });
    return null;
  }

  const contract: Contract = {
    version: CONTRACT_VERSION,
    elements: obj.elements as ContractElement[],
  };

  logger.debug('contract loaded', {
    path,
    elementCount: contract.elements.length,
  });
  return contract;
}

/**
 * 渲染契约为 prompt 注入段（XML 标签风格，与 `<accessibility-snapshot>` `<pageObject>` 一致）。
 * 输出稳定的 markdown 表格，便于 LLM 直接对照。
 */
export function renderContractSection(contract: Contract): string {
  const lines: string[] = [];
  lines.push(
    `<contract version="${contract.version}" source="${STORAGE_LAYOUT.contractFile}" elementCount="${contract.elements.length}">`,
  );
  lines.push('测试契约约定（强约束）：');
  lines.push('- 优先使用契约中声明的定位器；未声明的元素按现状策略（语义定位器优先）');
  lines.push('- 严禁捏造契约外的 data-testid；如发现新元素，反馈给用户先扩充契约');
  lines.push('- 契约同时声明了 testId/role/label/text 多个字段时，按 selectorPolicy.prefer 优先级选择');
  lines.push('契约元素清单：');
  lines.push('| name | testId | role | label | text | description |');
  lines.push('| --- | --- | --- | --- | --- | --- |');
  for (const el of contract.elements) {
    lines.push(
      `| ${esc(el.name)} | ${esc(el.testId)} | ${esc(el.role)} | ${esc(el.label)} | ${esc(el.text)} | ${esc(el.description)} |`,
    );
  }
  lines.push('</contract>');
  return lines.join('\n');
}

function esc(v: string | undefined): string {
  return v === undefined || v === null ? '—' : String(v);
}