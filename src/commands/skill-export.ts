/**
 * skill export 子命令：导出 agent skill 定义
 *
 * 产出 ./skills/auto-test/SKILL.md，遵循 CodeBuddy / Claude Code skill 规范
 * （YAML frontmatter + 触发词 + 调用样例 + 输出契约）。
 *
 * 参考了 plan 中提到的 skill-creator Extension 风格（YAML 头 + 描述 + 工作流示例）。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '../utils/logger.js';

export type SkillTarget = 'codebuddy' | 'claude-code';

export interface SkillExportOptions {
  target?: SkillTarget;
  json?: boolean;
}

export interface SkillExportResult {
  ok: boolean;
  target: SkillTarget;
  path: string;
}

const SUBCOMMAND_CATALOG = [
  'init: 初始化项目（创建目录、写入 auto-test.config.json）',
  'generate <description>: 生成测试用例（可选 --url 触发页面探索）',
  'run [pattern]: 运行用例（透传 retry/workers/headed/ui/debug 等）',
  'rerun [--from <runId>]: 重跑最近一次（或指定）失败用例',
  'list [--tag <tag>]: 列出用例库',
  'show <name>: 查看用例详情（含 spec 与 POM 代码）',
  'delete <name> [--yes]: 删除用例',
  'history [--limit N] [--case <name>]: 查看运行历史',
  'heal <name> [--from <runId>]: 自动修复失败用例',
  'skill export [--target codebuddy|claude-code]: 导出本 skill 定义',
].join('\n- ');

const OUTPUT_CONTRACT = `
## 输出约定

- 所有命令支持 \`--json\` 输出
- 错误结构化: \`{ ok: false, error: { code, message, hint } }\`
- 退出码:
  - 0: 成功
  - 2: 参数错误
  - 3: 子命令未实现
  - 4: 资源不存在
  - 5: 重复创建
  - 6: agent 调用失败
  - 7: 测试失败
  - 8: IO 错误
`.trim();

const BEST_PRACTICES = `
## 最佳实践

1. **生成用例前可加 \`--url\` 探索页面**，提高定位准确度
2. **\`--page-object\` 模式**生成 POM 文件，提升可维护性
3. **\`--json\` 输出**便于 agent 解析
4. **\`rerun\` 一键重跑**失败用例，避免手动筛选
5. **\`heal <name>\`** 把失败用例 + 错误日志委托给 pi-agent 自动修复
6. 用例库与运行历史以纯文件存储，可 git 管理
`.trim();

const CALL_EXAMPLES = `
## 调用样例

\`\`\`bash
# 初始化项目
auto-test init

# 生成用例（纯描述）
auto-test generate "登录：用户名密码登录后跳转首页" --name login-success

# 带页面探索的生成
auto-test generate "完整登录流程" --url https://example.com/login

# 运行
auto-test run

# 查看最近 5 次运行历史
auto-test history --limit 5

# 重跑最近一次失败用例
auto-test rerun

# 修复失败用例
auto-test heal login-success
\`\`\`
`.trim();

export async function skillExportCommand(
  options: SkillExportOptions,
): Promise<SkillExportResult> {
  const target: SkillTarget = options.target ?? 'codebuddy';
  if (target !== 'codebuddy' && target !== 'claude-code') {
    throw new Error(`不支持的 target: ${target}（可选: codebuddy | claude-code）`);
  }

  const skillContent = generateSkillContent(target);
  const outDir = join(process.cwd(), 'skills', 'auto-test');
  const outFile = join(outDir, 'SKILL.md');

  mkdirSync(outDir, { recursive: true });
  writeFileSync(outFile, skillContent, 'utf-8');

  const result: SkillExportResult = { ok: true, target, path: outFile };

  if (options.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } else {
    logger.info(`skill 已写入 ${outFile}`);
  }

  return result;
}

function generateSkillContent(target: SkillTarget): string {
  const frontmatter = renderFrontmatter(target);
  return `${frontmatter}
# auto-test

面向 agent 的 Playwright 页面测试 CLI 工具：自然语言生成用例、可重跑、历史可追溯。

## 子命令

- ${SUBCOMMAND_CATALOG}

${CALL_EXAMPLES}

${OUTPUT_CONTRACT}

${BEST_PRACTICES}
`;
}

function renderFrontmatter(target: SkillTarget): string {
  if (target === 'codebuddy') {
    return `---
name: auto-test
description: |
  Playwright 页面测试 CLI 工具。当用户需要测试 Web 页面、生成/重跑 Playwright
  用例、查看测试历史、自动修复失败用例时调用。底层 pi-coding-agent + Playwright。
triggers:
  - 测试页面
  - 生成 Playwright 用例
  - 自动化测试
  - 重跑失败测试
  - 修复测试用例
  - web 测试
---
`;
  }
  return `---
name: auto-test
description: Playwright 页面测试 CLI 工具：自然语言生成用例、可重跑、历史可追溯。
---
`;
}