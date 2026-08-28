/**
 * 模板快路径（template fast-path）类型定义
 *
 * 设计动机：
 * - 高频场景（登录/表单/列表/详情）的 spec 结构高度收敛，LLM 生成 ~30s/条且质量不稳定
 * - 模板 = 纯函数渲染，~50ms/条，零 LLM 调用
 * - 守门机制：requiredParams 缺任一 → 静默回退 LLM 路径，宁缺毋滥
 */
import type { ExploreResult } from '../explore.js';

/** 从 interactiveElements 文本行解析出的结构化交互元素 */
export interface InteractiveElement {
  tag: string;
  id: string;
  role: string;
  type: string;
  name: string;
  testid: string;
  ariaLabel: string;
  text: string;
}

/** 表单字段参数（form-submit 模板用） */
export interface FormField {
  /** 人类可读字段名（用于注释/断言文案） */
  label: string;
  /** 直接可用的定位器表达式，如 "page.getByLabel('客户名称')" */
  locator: string;
  /** 填充值（按 input type 推导的合法样例） */
  value: string;
}

/** 模板参数值：定位器/URL 是字符串，表单字段是数组 */
export type TemplateParamValue = string | FormField[];

export type TemplateParams = Record<string, TemplateParamValue>;

/** 参数来源（日志/调试用） */
export type ParamSource = 'override' | 'snapshot' | 'description' | 'default';

export interface TemplateRenderResult {
  /** kebab-case 用例名（不含 group 前缀，前缀由调用方按 CLI --group 统一加） */
  name: string;
  /** 完整 .spec.ts 源码 */
  code: string;
  /** 中文模块名（CLI --module 可覆盖） */
  module: string;
  /** kebab-case 分组（CLI --group 可覆盖） */
  group: string;
  tags: string[];
}

export interface TemplateContext {
  /** CLI --set key=value（最高优先级） */
  overrides: Record<string, string>;
  /** explore 结果（description-only 模式下为 null） */
  explore: ExploreResult | null;
  /** CLI -u URL（explore 模式下与 explore.url 相同） */
  url?: string;
  /** 原始需求描述（部分模板从描述提取关键词，如 list-search 的搜索词） */
  description: string;
}

export interface TemplateDefinition {
  name: string;
  /** description 命中任一关键词即候选该模板（与 EXAMPLE_KEYWORDS 对齐） */
  keywords: RegExp[];
  /** description 命中任一排除词则跳过该模板（如"注册"不该走登录模板） */
  exclude?: RegExp[];
  /** 必需参数名；合并后缺任一 → miss */
  requiredParams: readonly string[];
  /** 从快照/描述提取参数（优先级低于 overrides） */
  extract: (ctx: TemplateContext, elements: InteractiveElement[]) => Partial<TemplateParams>;
  render: (params: TemplateParams, meta: { description: string }) => TemplateRenderResult;
}

/** tryTemplateFastPath 的命中结果 */
export interface TemplateFastPathHit {
  templateName: string;
  render: TemplateRenderResult;
  params: TemplateParams;
  sources: Record<string, ParamSource>;
}

/** tryTemplateFastPath 的未命中结果（miss 不抛错，调用方回退 LLM） */
export interface TemplateFastPathMiss {
  miss: true;
  reason: string;
}
