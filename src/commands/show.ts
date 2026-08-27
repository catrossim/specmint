/**
 * show 子命令：查看用例详情（含 spec 与 POM 代码）
 *
 * 任务 2 增强：详情中显式输出 priority / group / module / linkedTickets 四个结构化字段。
 */
import { createStores } from '../store/index.js';
import { loadConfig } from '../config.js';
import { CliError, ExitCode } from '../utils/errors.js';

export interface ShowOptions {
  json?: boolean;
}

export async function showCommand(name: string, options: ShowOptions): Promise<void> {
  const cwd = process.cwd();
  const config = loadConfig(cwd);
  const { caseStore } = createStores(cwd);

  const data = caseStore.readWithCode(name);
  if (!data) {
    throw new CliError({ code: ExitCode.NOT_FOUND, message: `用例 ${name} 不存在` });
  }

  if (options.json) {
    process.stdout.write(JSON.stringify({ ok: true, case: data }, null, 2) + '\n');
    return;
  }

  const lines: string[] = [];
  lines.push(`# ${data.name}`);
  lines.push('');
  lines.push(data.description);
  lines.push('');
  lines.push(`**Priority:** ${data.priority ?? '(未分级)'}`);
  lines.push(`**Group:** ${data.group ?? '(未分类)'}`);
  lines.push(`**Module:** ${data.module ?? '(未分类)'}`);
  if (data.linkedTickets && data.linkedTickets.length > 0) {
    lines.push(`**Tickets:** ${data.linkedTickets.join(', ')}`);
  }
  lines.push(`**Tags:** ${data.tags.length > 0 ? data.tags.join(', ') : '(none)'}`);
  lines.push(`**Status:** ${data.stats.lastStatus}`);
  lines.push(`**Created:** ${data.createdAt}`);
  lines.push(`**Updated:** ${data.updatedAt}`);
  lines.push(`**Run Count:** ${data.stats.runCount}`);
  if (data.stats.averageDurationMs > 0) {
    lines.push(`**Avg Duration:** ${data.stats.averageDurationMs}ms`);
  }
  lines.push('');
  lines.push('## spec.ts');
  lines.push('');
  lines.push('```ts');
  lines.push(data.code);
  lines.push('```');
  if (data.pageObjectCode) {
    lines.push('');
    lines.push('## page object');
    lines.push('');
    lines.push('```ts');
    lines.push(data.pageObjectCode);
    lines.push('```');
  }
  process.stdout.write(lines.join('\n') + '\n');
}