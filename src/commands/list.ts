import { createStores } from '../store/index.js';
import { logger } from '../utils/logger.js';
import type { Priority } from '../store/types.js';

export interface ListOptions {
  tag?: string;
  priority?: Priority[];
  auth?: string;
  /** 按模块中文名过滤 */
  module?: string;
  /** 按功能分组（kebab-case）过滤 */
  group?: string;
  json?: boolean;
}

export async function listCommand(options: ListOptions): Promise<void> {
  const cwd = process.cwd();
  const { caseStore, storage } = createStores(cwd);
  const summaries = caseStore.list({
    tag: options.tag,
    priority: options.priority,
    auth: options.auth,
    module: options.module,
    group: options.group,
  });

  if (options.json) {
    process.stdout.write(JSON.stringify({ ok: true, root: storage.root, count: summaries.length, items: summaries }, null, 2) + '\n');
    return;
  }

  if (summaries.length === 0) {
    const filterMsg = [
      options.tag ? `tag=${options.tag}` : null,
      options.priority ? `priority=${options.priority.join(',')}` : null,
      options.auth ? `auth=${options.auth}` : null,
      options.module ? `module=${options.module}` : null,
      options.group ? `group=${options.group}` : null,
    ].filter(Boolean).join(' ');
    logger.info(filterMsg ? `没有匹配 ${filterMsg} 的用例` : '用例库为空');
    return;
  }

  const nameW = Math.max(4, ...summaries.map((s) => s.name.length));
  const prioW = 3;
  const statusW = Math.max(6, ...summaries.map((s) => s.status.length));
  const authW = Math.max(4, ...summaries.map((s) => (s.auth ?? '-').length));
  // 模块中文名长度差异大，至少给 8 列宽避免被截断
  const moduleW = Math.max(6, ...summaries.map((s) => (s.module ?? '-').length));

  const header = [
    'NAME'.padEnd(nameW),
    'PRI',
    'AUTH'.padEnd(authW),
    'MODULE'.padEnd(moduleW),
    'STATUS'.padEnd(statusW),
    'TAGS',
  ];
  process.stdout.write(header.join('  ') + '\n');
  process.stdout.write('-'.repeat(header.join('  ').length) + '\n');

  for (const s of summaries) {
    const prio = (s.priority ?? '-').padEnd(prioW);
    const auth = (s.auth ?? '-').padEnd(authW);
    const mod = (s.module ?? '-').padEnd(moduleW);
    const tags = s.tags.length > 0 ? s.tags.join(',') : '-';
    process.stdout.write(
      [s.name.padEnd(nameW), prio, auth, mod, s.status.padEnd(statusW), tags].join('  ') + '\n',
    );
    process.stdout.write(`  ${s.description}\n`);
  }
}