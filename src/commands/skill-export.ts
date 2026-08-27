/**
 * skill export 子命令：导出 agent skill 定义
 *
 * 产出 ./skills/auto-test/SKILL.md，遵循 CodeBuddy / Claude Code skill 规范。
 *
 * 数据源策略：
 * - 优先读 skills/auto-test/SKILL.md（仓库内最新内容，由 docs/USAGE.md / examples/e2e-verify.md 同步）
 * - 找不到则报错（提示先维护 SKILL.md）
 *
 * 两个 target 区别：
 * - codebuddy：完整 YAML frontmatter（description + triggers）
 * - claude-code：简化 frontmatter（仅 description）
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CliError, ExitCode } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

export type SkillTarget = 'codebuddy' | 'claude-code';export interface SkillExportOptions {
  target?: SkillTarget;
  /** 一键安装到 IDE skill 加载目录（CodeBuddy: .codebuddy/skills/） */
  install?: boolean;
  json?: boolean;
}

export interface SkillExportResult {
  ok: boolean;
  target: SkillTarget;
  path: string;
  /** 渲染模式：'full' = 用仓库 SKILL.md；'compact' = 简化版（claude-code） */
  mode: 'full' | 'compact';
}

/**
 * 仓库内 SKILL.md 路径（数据源）
 */
function repoSkillPath(): string {
  return join(process.cwd(), 'skills', 'auto-test', 'SKILL.md');
}

/**
 * 渲染目标 SKILL.md
 * - codebuddy：直接拷贝仓库 SKILL.md（已经是 codebuddy 格式）
 * - claude-code：剥离 triggers 段
 */
export async function skillExportCommand(options: SkillExportOptions): Promise<SkillExportResult> {
  const target: SkillTarget = options.target ?? 'codebuddy';
  if (target !== 'codebuddy' && target !== 'claude-code') {
    throw new CliError({
      code: ExitCode.USAGE_ERROR,
      message: `不支持的 target: ${target}`,
      hint: '可选: codebuddy | claude-code',
    });
  }

  const sourcePath = repoSkillPath();
  if (!existsSync(sourcePath)) {
    throw new CliError({
      code: ExitCode.NOT_FOUND,
      message: `找不到源 SKILL.md：${sourcePath}`,
      hint: '请确认仓库内 skills/auto-test/SKILL.md 存在',
    });
  }

  const raw = readFileSync(sourcePath, 'utf-8');
  const rendered = target === 'codebuddy' ? raw : renderForClaudeCode(raw);

  const outDir = join(process.cwd(), 'skills', 'auto-test');
  let outFile = join(outDir, `SKILL.${target}.md`);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(outFile, rendered, 'utf-8');

  // 可选：--install 一键安装到 IDE skill 加载目录
  if (options.install) {
    const installDir = installDirFor(target);
    const installFile = join(installDir, 'SKILL.md');
    mkdirSync(installDir, { recursive: true });
    writeFileSync(installFile, rendered, 'utf-8');
    outFile = installFile;
  }

  const result: SkillExportResult = {
    ok: true,
    target,
    path: outFile,
    mode: target === 'codebuddy' ? 'full' : 'compact',
  };

  if (options.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } else {
    logger.info(`✓ skill (${target}) 已写入 ${outFile}`);
    logger.info(`  mode: ${result.mode}`);
  }
  return result;
}

/**
 * claude-code 版本：剥离 YAML frontmatter 中的 triggers 列表
 * （claude-code 不识别 triggers 字段，保留会报 frontmatter 错误）
 */
function renderForClaudeCode(input: string): string {
  // 匹配 YAML frontmatter（--- 开头到 --- 结束）
  const fmMatch = input.match(/^---\n([\s\S]*?)\n---\n/);
  if (!fmMatch) return input;
  const fm = fmMatch[1]!;
  const body = input.slice(fmMatch[0].length);

  // 移除 triggers 段（description 保留，triggers 删掉）
  const cleanedFm = fm.replace(/\ntriggers:\n(?:\s+-\s+.*\n?)+/g, '\n');
  return `---\n${cleanedFm}\n---\n${body}`;
}

/**
 * target 对应的 IDE skill 加载目录。
 * - codebuddy：项目级 .codebuddy/skills/<name>/
 * - claude-code：项目级 .claude/skills/<name>/
 */
function installDirFor(target: SkillTarget): string {
  const name = 'auto-test';
  if (target === 'codebuddy') return join(process.cwd(), '.codebuddy', 'skills', name);
  return join(process.cwd(), '.claude', 'skills', name);
}
