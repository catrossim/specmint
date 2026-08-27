/**
 * list 子命令：列出用例库
 */
import { CaseStore } from '../store/case-store.js';
import { loadConfig } from '../config.js';
import { logger } from '../utils/logger.js';

export interface ListOptions {
  tag?: string;
  json?: boolean;
}

export async function listCommand(options: ListOptions): Promise<void> {
  const cwd = process.cwd();
  const config = loadConfig(cwd);
  const caseStore = new CaseStore({ cwd, casesDir: config.storage.casesDir });

  const summaries = caseStore.list({ tag: options.tag });

  if (options.json) {
    process.stdout.write(JSON.stringify({ ok: true, count: summaries.length, items: summaries }, null, 2) + '\n');
    return;
  }

  if (summaries.length === 0) {
    logger.info(options.tag ? `没有 tag=${options.tag} 的用例` : '用例库为空');
    return;
  }

  for (const s of summaries) {
    const tags = s.tags.length > 0 ? ` [${s.tags.join(', ')}]` : '';
    const status = ` (${s.status})`;
    process.stdout.write(`${s.name}${tags}${status}\n`);
    process.stdout.write(`  ${s.description}\n`);
    process.stdout.write(`  ${s.specPath}`);
    if (s.lastRunAt) {
      process.stdout.write(` · last run: ${s.lastRunAt}`);
    }
    process.stdout.write('\n');
  }
}