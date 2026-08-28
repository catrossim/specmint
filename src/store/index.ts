/**
 * Store 工厂：基于 cwd 与固定的 .auto-test/ 布局实例化 CaseStore / HistoryStore。
 *
 * 路径不可配置：所有路径常量都在 config.ts 的 STORAGE_LAYOUT 中固定，意图：
 * - 减少用户决策成本
 * - 避免不同人 / 不同机器的配置漂移
 * - 让仓库根目录是 .gitignore 的唯一权威
 * - 把所有 auto-test 产物（含两个配置文件）都收纳在 .auto-test/ 下
 */
import { resolve as resolvePath } from 'node:path';
import { STORAGE_LAYOUT } from '../config.js';
import { CaseStore } from './case-store.js';
import { HistoryStore } from './history-store.js';

export interface StorageLayout {
  /** 绝对路径 */
  root: string;
  casesDir: string;
  pageObjectsDir: string;
  reportsDir: string;
  configPath: string;
  authDir: string;
  authStorage: string;
}

export interface Stores {
  storage: StorageLayout;
  caseStore: CaseStore;
  historyStore: HistoryStore;
}

function toAbsolute(relPath: string, cwd: string): string {
  return resolvePath(cwd, relPath);
}

export function createStores(cwd: string): Stores {
  const storage: StorageLayout = {
    root: toAbsolute(STORAGE_LAYOUT.root, cwd),
    casesDir: toAbsolute(STORAGE_LAYOUT.cases, cwd),
    pageObjectsDir: toAbsolute(STORAGE_LAYOUT.pages, cwd),
    reportsDir: toAbsolute(STORAGE_LAYOUT.reports, cwd),
    configPath: toAbsolute(STORAGE_LAYOUT.configFile, cwd),
    authDir: toAbsolute(STORAGE_LAYOUT.authDir, cwd),
    authStorage: toAbsolute(STORAGE_LAYOUT.authStorage, cwd),
  };
  const caseStore = new CaseStore({
    cwd,
    casesDir: storage.casesDir,
    pageObjectsDir: storage.pageObjectsDir,
  });
  const historyStore = new HistoryStore({ cwd, reportsDir: storage.reportsDir });
  return { storage, caseStore, historyStore };
}

export { CaseStore } from './case-store.js';
export { HistoryStore } from './history-store.js';