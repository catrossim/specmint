import { runTests } from '../runner/executor.js';
import { loadConfig } from '../config.js';
import { createStores } from '../store/index.js';
import { ExitCode } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { relative as pathRelative, resolve as pathResolve } from 'node:path';
import type { Priority } from '../store/types.js';

export interface RunOptions {
  browser?: string;
  headed?: boolean;
  ui?: boolean;
  debug?: boolean;
  workers?: string;
  retries?: string;
  grep?: string;
  priority?: Priority[];
  header?: string[];
  storageState?: string;
  /** CLI --auth <name> */
  authName?: string;
  /** CLI --no-auth */
  noAuth?: boolean;
  json?: boolean;
  /** CLI --label <slug>：批次语义标签 */
  label?: string;
}

export async function runCommand(
  pattern: string | undefined,
  options: RunOptions,
): Promise<void> {
  const cwd = process.cwd();
  const config = loadConfig(cwd);
  const { caseStore, storage } = createStores(cwd);

  const workers = options.workers !== undefined ? parseInt(options.workers, 10) : undefined;
  const retries = options.retries !== undefined ? parseInt(options.retries, 10) : undefined;

  let resolvedPattern: string | undefined;
  if (pattern) {
    if (pattern.includes('/') || pattern.endsWith('.ts')) {
      resolvedPattern = pattern;
    } else {
      const matches = caseStore.list({ pattern });
      if (matches.length === 0) {
        logger.warn(`未找到与 "${pattern}" 匹配的用例`);
        process.exitCode = ExitCode.NOT_FOUND;
        return;
      }
      if (matches.length === 1) {
        const match = matches[0]!;
        resolvedPattern = pathRelative(
          cwd,
          pathResolve(storage.casesDir, `${match.name}.spec.ts`),
        );
      } else {
        resolvedPattern = undefined;
        options.grep = options.grep ?? matches.map((m) => m.name).join('|');
      }
    }
  }

  if (options.priority && options.priority.length > 0 && !options.grep && !pattern) {
    const items = caseStore.list({ priority: options.priority });
    if (items.length === 0) {
      logger.warn(`没有匹配 priority=${options.priority.join(',')} 的用例`);
      process.exitCode = ExitCode.NOT_FOUND;
      return;
    }
    options.grep = items.map((m) => m.name).join('|');
  }

  // --auth 过滤（同时默认 storageState = .auto-test/auth/storage/<auth>.json）
  if (options.authName && !options.grep && !pattern) {
    const items = caseStore.list({ auth: options.authName });
    if (items.length === 0) {
      logger.warn(`没有匹配 auth=${options.authName} 的用例`);
      process.exitCode = ExitCode.NOT_FOUND;
      return;
    }
    options.grep = items.map((m) => m.name).join('|');
  }
  if (options.authName && !options.storageState && !options.noAuth) {
    options.storageState = `.auto-test/auth/storage/${options.authName}.json`;
  }

  const result = await runTests({
    pattern: resolvedPattern,
    browser: options.browser ?? config.runner.defaultBrowser,
    headed: options.headed,
    ui: options.ui,
    debug: options.debug,
    workers: Number.isFinite(workers) ? workers : undefined,
    retries: Number.isFinite(retries) ? retries : undefined,
    grep: options.grep,
    runnerConfigPath: storage.runnerConfigPath,
    cwd,
    casesDir: storage.casesDir,
    reportsDir: storage.reportsDir,
    auth: {
      headers: options.header && options.header.length > 0 ? options.header : undefined,
      storageState: options.storageState,
      noAuth: options.noAuth === true,
    },
    label: options.label,
  });

  if (options.json) {
    process.stdout.write(JSON.stringify({ ok: result.exitCode === 0, ...result }, null, 2) + '\n');
  } else {
    logger.info(`runId: ${result.runId}`);
    logger.info(`status: ${result.status}`);
    logger.info(`exitCode: ${result.exitCode}`);
  }

  if (result.exitCode !== 0) {
    process.exitCode = ExitCode.TEST_FAILED;
  }
}