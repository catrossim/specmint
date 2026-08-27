/**
 * delete 子命令：删除用例（spec + meta + POM）
 *
 * 交互确认：
 * - TTY + 无 --yes：询问 y/N
 * - 非 TTY + 无 --yes：要求 --yes
 */
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { createStores } from '../store/index.js';
import { loadConfig } from '../config.js';
import { CliError, ExitCode } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

export interface DeleteOptions {
  yes?: boolean;
  json?: boolean;
}

export async function deleteCommand(name: string, options: DeleteOptions): Promise<void> {
  if (!options.yes) {
    if (!input.isTTY) {
      throw new CliError({
        code: ExitCode.USAGE_ERROR,
        message: '非交互模式下删除用例需要 --yes 确认',
      });
    }
    const rl = createInterface({ input, output });
    try {
      const answer = await rl.question(`删除用例 ${name}？此操作不可撤销 (y/N) `);
      if (answer.trim().toLowerCase() !== 'y') {
        logger.info('已取消');
        return;
      }
    } finally {
      rl.close();
    }
  }

  const cwd = process.cwd();
  const config = loadConfig(cwd);
  const { caseStore } = createStores(cwd);

  caseStore.delete(name);

  if (options.json) {
    process.stdout.write(JSON.stringify({ ok: true, deleted: name }, null, 2) + '\n');
  } else {
    logger.info(`已删除用例 ${name}`);
  }
}