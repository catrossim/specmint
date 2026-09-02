/**
 * skill export 子命令：批量导出 agent skill 定义
 *
 * 数据源：包内 `skills/` 目录（随 npm 包分发，见 package.json 的 files 字段）。
 *
 * 修复记录：
 * - 旧实现用 `process.cwd()` 定位 `skills/specmint/SKILL.md`，而该目录并不在 npm 包的
 *   files 列表里 —— 用户在自己项目里跑 `specmint skill export` 必然 NOT_FOUND。
 *   现在改为从 `import.meta.url` 推导包内目录，源码态（src/commands）与产物态
 *   （dist/commands）层级一致，都是 `<root>/skills`。
 *
 * 目录约定：
 * ```
 * skills/
 * ├── _shared/*.md          # 公共片段，用 <!-- include: x.md --> 引用（下划线开头，不导出）
 * ├── specmint/SKILL.md     # 每个子目录 = 一个 skill，目录名即 skill 名
 * ├── specmint-author/SKILL.md
 * └── ...
 * ```
 *
 * 输出：
 * - 默认写到 `./skills-export/<name>/SKILL.md`（不再回写源目录，避免产物与源文件混淆）
 * - `--install` 额外安装到 IDE 加载目录：`.codebuddy/skills/<name>/` 或 `.claude/skills/<name>/`
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CliError, ExitCode } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

export type SkillTarget = 'codebuddy' | 'claude-code';

export interface SkillExportOptions {
  target?: SkillTarget;
  /** 一键安装到 IDE skill 加载目录（codebuddy: .codebuddy/skills/） */
  install?: boolean;
  json?: boolean;
  /** 只导出指定 skill（逗号分隔）；默认全部 */
  only?: string;
}

export interface ExportedSkill {
  name: string;
  path: string;
  /** full = 完整 frontmatter；compact = 剥离 triggers（claude-code） */
  mode: 'full' | 'compact';
}

export interface SkillExportResult {
  ok: boolean;
  target: SkillTarget;
  skills: ExportedSkill[];
  /** 输出根目录（相对 cwd） */
  outputDir: string;
  installDir?: string;
}

/** `_shared` 片段的引用语法：`<!-- include: layout.md -->` */
const INCLUDE_RE = /^<!--\s*include:\s*([A-Za-z0-9._-]+\.md)\s*-->$/;

/**
 * 定位包内 skills 目录。
 *
 * 源码态 src/commands/skill-export.ts 与产物态 dist/commands/skill-export.js
 * 相对包根的层级一致（都是 `<root>/<src|dist>/commands/`），因此统一上溯两级。
 * 兜底尝试 cwd（便于 fork 后本地调试）。
 */
function resolveSkillsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, '..', '..', 'skills'),
    resolve(process.cwd(), 'skills'),
  ];
  for (const dir of candidates) {
    if (existsSync(dir) && statSync(dir).isDirectory()) return dir;
  }
  throw new CliError({
    code: ExitCode.NOT_FOUND,
    message: '找不到包内 skills/ 目录',
    hint: `已尝试：${candidates.join('、')}。请确认 specmint 安装完整（npm 包需包含 skills/ 目录）`,
  });
}

/** 列出所有可导出的 skill 目录名（跳过 `_` 开头的共享片段目录） */
function listSkillNames(skillsDir: string): string[] {
  return readdirSync(skillsDir)
    .filter((entry) => {
      if (entry.startsWith('_')) return false;
      const full = join(skillsDir, entry);
      return statSync(full).isDirectory() && existsSync(join(full, 'SKILL.md'));
    })
    .sort((a, b) => a.localeCompare(b));
}

/**
 * 展开 `_shared` 片段引用。
 * - 每行独立匹配，片段内容按原样插入（保持缩进上下文由片段自己负责）
 * - 支持嵌套一层（片段里再 include）；超过 3 层视为循环引用并报错
 */
function renderIncludes(content: string, sharedDir: string, depth = 0): string {
  if (depth > 3) {
    throw new CliError({
      code: ExitCode.IO_ERROR,
      message: 'skill 片段引用层级过深（可能存在循环 include）',
      hint: `检查 ${sharedDir} 下的片段是否互相引用`,
    });
  }

  const lines = content.split(/\r?\n/);
  const out: string[] = [];
  for (const line of lines) {
    const m = INCLUDE_RE.exec(line.trim());
    if (!m) {
      out.push(line);
      continue;
    }
    const fragmentPath = join(sharedDir, m[1]!);
    if (!existsSync(fragmentPath)) {
      throw new CliError({
        code: ExitCode.NOT_FOUND,
        message: `skill 片段不存在：${m[1]}`,
        hint: `期望路径：${fragmentPath}`,
      });
    }
    const fragment = readFileSync(fragmentPath, 'utf-8').replace(/\s+$/, '');
    out.push(renderIncludes(fragment, sharedDir, depth + 1));
  }
  return out.join('\n');
}

/**
 * claude-code 版本：剥离 YAML frontmatter 中的 triggers 列表
 * （claude-code 不识别 triggers 字段，保留会报 frontmatter 错误）
 */
function renderForClaudeCode(input: string): string {
  const fmMatch = input.match(/^---\n([\s\S]*?)\n---\n/);
  if (!fmMatch) return input;
  const fm = fmMatch[1]!;
  const body = input.slice(fmMatch[0].length);
  const cleanedFm = fm.replace(/\ntriggers:\n(?:\s+-\s+.*\n?)+/g, '\n');
  return `---\n${cleanedFm}\n---\n${body}`;
}

/** target 对应的 IDE skill 加载根目录 */
function installRootFor(target: SkillTarget): string {
  return target === 'codebuddy'
    ? join(process.cwd(), '.codebuddy', 'skills')
    : join(process.cwd(), '.claude', 'skills');
}

export async function skillExportCommand(
  options: SkillExportOptions,
): Promise<SkillExportResult> {
  const target: SkillTarget = options.target ?? 'codebuddy';
  if (target !== 'codebuddy' && target !== 'claude-code') {
    throw new CliError({
      code: ExitCode.USAGE_ERROR,
      message: `不支持的 target: ${target}`,
      hint: '可选: codebuddy | claude-code',
    });
  }

  const skillsDir = resolveSkillsDir();
  const sharedDir = join(skillsDir, '_shared');

  let names = listSkillNames(skillsDir);
  if (options.only && options.only.trim() !== '') {
    const wanted = options.only.split(',').map((s) => s.trim()).filter(Boolean);
    for (const w of wanted) {
      if (!names.includes(w)) {
        throw new CliError({
          code: ExitCode.NOT_FOUND,
          message: `skill "${w}" 不存在`,
          hint: `可选：${names.join(', ')}`,
        });
      }
    }
    names = wanted;
  }

  if (names.length === 0) {
    throw new CliError({
      code: ExitCode.NOT_FOUND,
      message: `skills/ 下没有可导出的 skill（缺 SKILL.md）：${skillsDir}`,
    });
  }

  const outputRoot = join(process.cwd(), 'skills-export');
  const exported: ExportedSkill[] = [];

  for (const name of names) {
    const sourcePath = join(skillsDir, name, 'SKILL.md');
    const expanded = renderIncludes(readFileSync(sourcePath, 'utf-8'), sharedDir);
    const rendered = target === 'codebuddy' ? expanded : renderForClaudeCode(expanded);

    const outPath = join(outputRoot, name, 'SKILL.md');
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, rendered, 'utf-8');

    exported.push({
      name,
      path: outPath,
      mode: target === 'codebuddy' ? 'full' : 'compact',
    });
  }

  let installDir: string | undefined;
  if (options.install) {
    installDir = installRootFor(target);
    for (const item of exported) {
      // 直接复用已渲染内容，避免二次渲染导致两处产物不一致
      const content = readFileSync(item.path, 'utf-8');
      const destDir = join(installDir, item.name);
      mkdirSync(destDir, { recursive: true });
      writeFileSync(join(destDir, 'SKILL.md'), content, 'utf-8');
      item.path = join(destDir, 'SKILL.md');
    }
  }

  const result: SkillExportResult = {
    ok: true,
    target,
    skills: exported,
    outputDir: outputRoot,
    ...(installDir ? { installDir } : {}),
  };

  if (options.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } else {
    for (const item of exported) {
      logger.info(`✓ ${item.name.padEnd(18)} → ${item.path}`);
    }
    logger.info(
      `\n共 ${exported.length} 个 skill（target=${target}，mode=${exported[0]?.mode}）`,
    );
    if (options.install && installDir) {
      logger.info(`已安装到 ${installDir}；重启 IDE 后生效`);
    } else {
      logger.info(`如需安装到 IDE：specmint skill export --target ${target} --install`);
    }
  }

  return result;
}
