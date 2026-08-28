/**
 * 模板快路径入口：description → 模板匹配 → 参数合并 → 渲染
 *
 * 守门机制（宁缺毋滥）：
 * - 自动模式：requiredParams 缺任一 → 返回 miss，调用方静默回退 LLM 路径
 * - 显式模式（--template <name>）：模板不存在直接抛错；参数不足返回 miss（调用方报错提示 --set）
 *
 * 参数优先级：overrides（CLI --set） > extract（快照/描述） > 模板默认
 */
import type {
  TemplateContext,
  TemplateDefinition,
  TemplateFastPathHit,
  TemplateFastPathMiss,
  TemplateParams,
  ParamSource,
} from './types.js';
import { parseInteractiveElements } from './params.js';
import { loginFlow } from './login-flow.js';
import { formSubmit } from './form-submit.js';
import { listSearch } from './list-search.js';
import { detailPage } from './detail-page.js';

export const TEMPLATES: TemplateDefinition[] = [loginFlow, formSubmit, listSearch, detailPage];

export const TEMPLATE_NAMES: string[] = TEMPLATES.map((t) => t.name);

export type { TemplateFastPathHit, TemplateFastPathMiss } from './types.js';

export type TemplateFastPathResult = TemplateFastPathHit | TemplateFastPathMiss;

function matchTemplate(description: string, forcedName?: string): TemplateDefinition | null {
  if (forcedName) {
    const t = TEMPLATES.find((t) => t.name === forcedName);
    if (!t) {
      throw new Error(
        `--template "${forcedName}" 不存在。可用: ${TEMPLATE_NAMES.join(', ')}`,
      );
    }
    return t;
  }
  for (const t of TEMPLATES) {
    if (t.exclude?.some((re) => re.test(description))) continue;
    if (t.keywords.some((re) => re.test(description))) return t;
  }
  return null;
}

/**
 * 尝试模板快路径。
 * 返回 miss 时调用方回退 LLM；返回 render 时直接落盘（零 LLM 调用）。
 */
export function tryTemplateFastPath(
  description: string,
  ctx: TemplateContext,
  forcedName?: string,
): TemplateFastPathResult {
  const template = matchTemplate(description, forcedName);
  if (!template) {
    return { miss: true, reason: forcedName ? '' : '没有命中任何模板关键词' };
  }

  const elements = parseInteractiveElements(ctx.explore?.interactiveElements);
  const extracted = template.extract(ctx, elements);

  // 参数合并：override > extract；记录来源
  const params: TemplateParams = {};
  const sources: Record<string, ParamSource> = {};
  const paramKeys = new Set<string>([
    ...Object.keys(extracted),
    ...Object.keys(ctx.overrides),
    ...template.requiredParams,
  ]);
  for (const key of paramKeys) {
    const ov = ctx.overrides[key];
    if (ov !== undefined && ov !== '') {
      params[key] = ov;
      sources[key] = 'override';
      continue;
    }
    const ex = extracted[key];
    if (ex !== undefined && ex !== '') {
      params[key] = ex;
      sources[key] = key === 'keyword' || key === 'titlePattern' ? 'description' : 'snapshot';
    }
  }

  // 守门：必需参数缺任一（含空数组，如 fields 提取不到）→ miss（不硬凑）
  const isMissing = (v: unknown): boolean =>
    v === undefined || v === '' || (Array.isArray(v) && v.length === 0);
  const missing = template.requiredParams.filter((k) => isMissing(params[k]));
  if (missing.length > 0) {
    return {
      miss: true,
      reason: `模板 ${template.name} 缺少参数: ${missing.join(', ')}`,
    };
  }

  const render = template.render(params, { description });
  return { templateName: template.name, render, params, sources };
}
