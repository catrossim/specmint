# Changelog

specmint 项目的所有重要变更都会记录在这里。版本号遵循 [Semantic Versioning](https://semver.org/)。

## 版本说明

- **当前发布版本**：`0.1.0`（首次对外发布）
- 内部迭代以 `v2` / `v2.1` / `v2.2` / `v2.3` 标识，本文件作为对外权威变更日志。
- 自 `0.1.0` 起，每个 npm release 都会在此新增一段 `## [x.y.z] - YYYY-MM-DD`。

---

## v0.1.0（首次发布，2026-08）

首次以 npm 包形式对外发布。功能集等于内部 v2.3（含 v2 / v2.1 / v2.2 的全部能力）。

### 关键改动（v2，2026-08）

- **目录布局**：所有 specmint 产物（含两个配置）都在 `.specmint/` 下，项目根零污染
- **路径不可配置**：`.specmint/` 强制约定，不支持在 `config.json` 里改 root / `casesDir` / `reportsDir`
- **配置位置**：`specmint.config.json` → `.specmint/config.json`；`playwright.config.ts` → `.specmint/playwright.config.ts`
- **用例优先级**：`priority`（`P0|P1|P2|P3`）强制必填；`generate` 命令必须 `--priority P0`
- **PI 输出契约**：归一化层兜底（"高" / p0 / urgent → `P0`）
- **用例分组**：`group/name.spec.ts` 形式（如 `auth/login-success`）
- **auth 子系统**：`.specmint/auth/<name>.setup.ts` + `.specmint/auth/storage/<name>.json`
- **Playwright projects**：自动拆 auth-setup + e2e（setup 空时跳过）

#### v2 新命令

- `specmint auth list / init / refresh / generate`
- `specmint models list / current / select`
- `specmint list --priority P0,P1 --auth admin`
- `specmint run --auth admin --header "K=V" --no-auth`

#### v2 升级步骤

1. 删除项目根的 `specmint.config.json` 和 `playwright.config.ts`（如有）
2. 删除项目根的 `tests/` 和 `reports/`（如有）
3. `npx specmint init`（重建 `.specmint/` 布局）
4. `npx specmint models select`（首次选择 LLM）
5. `npx specmint auth init admin`（如有登录态需求）
6. `npx specmint generate "<描述>" --priority P0`（开始生成）

---

## v2.1 增量（2026-08）

### 新增能力

- **少样本示例库**：agent 提示词内联 `login-flow` / `form-submit` / `list-search` / `detail-page` 四个场景的完整样例，自动按描述关键词匹配，输出风格更稳
- **探索快照缓存**：`src/agent/explore-cache.ts` 把 (URL + storageState) → a11y 快照落盘到 `.specmint/cache/explore/`，TTL 默认 10 分钟；同 URL 反复生成时直接复用，省掉浏览器启动
- **CLI 强制归类**：`generate` 新增 `--module` / `--group`，直接覆盖 PI 输出，绕过归一化层，避免脏目录
- **list / list_cases 过滤**：新增 `--module` / `--group` 过滤，配合大量用例的检索更顺手
- **可恢复断点**：`src/agent/checkpoint.ts` 把每次 generate 的中间态落盘，遇到异常可恢复
- **工具层扩展**：`src/utils/concurrency.ts`（并发控制）、`src/utils/prompt.ts`（模板渲染）、`src/utils/retry.ts`（重试）下沉通用能力

### 配置增量

`.specmint/config.json`：

```jsonc
{
  "explore": {
    "cache": {
      "enabled": true,        // 是否启用快照缓存
      "ttlMs": 600000,        // 10 分钟；过期的快照会被忽略并重建
      "dir": ".specmint/cache/explore"  // 缓存目录
    }
  }
}
```

### CLI 增量

```bash
# 强制归类到「用户认证」模块 / auth 分组（v2.1+）
npx specmint generate "登录成功" \
  --url http://localhost:4000/login \
  --module 用户认证 --group auth \
  --priority P0

# 强制刷新探索快照
npx specmint generate "..." --url ... --no-explore-cache

# 按模块 / 分组检索用例（v2.1+）
npx specmint list --module 用户认证 --group auth --json
```

### 兼容说明

- 完全向后兼容 v2：旧 `.specmint/` 项目无需改动；首次运行会按需自动创建 `cache/` 子目录
- 关闭缓存只需 `explore.cache.enabled = false` 或运行时加 `--no-explore-cache`
- 升级前可删除 `.specmint/cache/` 强制冷启动（不会影响用例与报告）

---

## v2.2 增量（2026-08）

### 新增能力

- **test-results 按批次号组织**：Playwright 的 `outputDir`（screenshots / videos / traces）现在指向 `.specmint/reports/runs/<batchId>/artifacts/`，不再污染项目根
- **批次号友好**：默认 `YYYY-MM-DD_HHMMSS`（如 `2026-08-27_150059`），自带自然排序、shell 安全
- **可选 `--label <slug>`**：`specmint run --label smoke` 拼成 `2026-08-27_150059-smoke`，一眼看出谁跑、什么时候跑
- **JSON 报告不再中转**：`results.json` 直接落到 `<batchId>/results.json`，删除旧 `.tmp/` 间接层

### 子进程 env 约定

executor 在 spawn `playwright test` 前注入：

| env | 值 |
|-----|----|
| `SPECMINT_OUTPUT_DIR` | `.specmint/reports/runs/<batchId>/artifacts` |
| `SPECMINT_JSON_OUTPUT_FILE` | `.specmint/reports/runs/<batchId>/results.json` |

`playwright.config.ts` 模板（`init` 生成）从这两个 env 决定 `outputDir` 和 JSON reporter 落点。

### batchId 冲突处理

同 batchId 已存在时自动追加 `-2` / `-3` …（最多 `-999`，再回退毫秒）。

### CLI 增量

```bash
# 加语义标签：批次号 = 2026-08-27_150059-smoke
npx specmint run --priority P0 --label smoke

# CI 跑 nightly 批次
npx specmint run --priority P0 --label nightly-batch-2
```

### 兼容说明

- 完全向后兼容 v2.1：旧 `.specmint/reports/runs/<ISO>/` 目录仍可读
- 项目根遗留的 `test-results/` / `playwright-report/` 手动 `rm -rf` 清理一次即可
- `playwright.config.ts` 模板升级：手动加入 `outputDir: process.env.SPECMINT_OUTPUT_DIR ?? './test-results'` 与 JSON reporter 同样从 env 读取

---

## v2.3 增量（2026-08）

### 新增能力

- **包内配置接管**：`.specmint/playwright.config.ts` 与 `.specmint/specmint-reporter.ts` 不再生成为用户文件，统一在 specmint 包内 `dist/runner/playwright.config.{js,ts}` 自带；executor 通过 `import.meta.url` 定位并 `--config` 指向。彻底消灭"模板内联版 vs 包内版"双实现漂移
- **深度自定义逃生舱**：`specmint run --config <path>` 可显式指定自定义 Playwright 配置
- **浏览器通道自动回退**：`runner.browserChannel: "auto"`（默认），检测链 chromium → 系统 Chrome → 系统 Edge。**内网/受限环境无需下载 Playwright chromium**，开箱即用
- **失败现场默认保留**：`runner.trace` 默认从 `on-first-retry` 提升为 `retain-on-failure`，heal 时 LLM 有页面现场可看；磁盘占用可控（仅失败用例产生，约 1-5 MB / 用例）
- **`BASE_URL` 透传修复**：executor 显式注入 `BASE_URL = SPECMINT_BASE_URL ?? ...` 给子进程（之前仅 `...process.env` 不带过去，`SPECMINT_BASE_URL` 等于没生效）
- **登录态按需启用**：auth-setup project 仅在检测到 `*.setup.ts` 时才挂载，根治"占位 setup 失败连坐真实用例 → did not run"与"无 setup 时跑空"两个独立 bug
- **InitResult 接口裁剪**：`init` 不再返回 `wrotePlaywrightConfig` / `wroteAutoTestReporter` / `wroteAdminSetup` 字段（不再生成）
- **env 协议收口**：所有 `SPECMINT_*` env 由 `src/runner/spawn-env.ts` 统一注入，run/rerun/auth refresh 三入口共用同一协议

### 配置增量

`.specmint/config.json` `runner` 段新增字段：

```jsonc
"runner": {
  "defaultBrowser": "chromium",
  "trace": "retain-on-failure",   // 默认提升（v2.2 是 on-first-retry）
  "screenshot": "only-on-failure",
  "timeoutMs": 30000,              // 新增：单用例超时
  "browserChannel": "auto"         // 新增：auto | chromium | chrome | msedge
}
```

### 内网/受限环境

```bash
# 1. auto 模式（默认）：无需任何配置；chromium 缺失自动回退系统 Chrome/Edge
npx specmint run

# 2. 显式固定系统 Chrome（CI 容器常用）
# .specmint/config.json runner.browserChannel: "chrome"

# 3. 用内网镜像下载 Playwright chromium
PLAYWRIGHT_DOWNLOAD_HOST=https://<内网镜像>/ npx playwright install chromium
```

### 升级步骤（v2.2 → v2.3）

```bash
# 1. 删旧 init 产物（包内配置接管，不再生成）
rm .specmint/playwright.config.ts .specmint/specmint-reporter.ts
rm .specmint/auth/admin.setup.ts   # 占位 setup，避免连坐

# 2. 重新 init（幂等；检测到旧文件会给出"可删除"提示）
npx specmint init

# 3. config.json runner 段新增 timeoutMs / browserChannel；trace 默认变 retain-on-failure
#    如果你以前设过 trace=on-first-retry，手动改回
```

### CLI 增量

```bash
# 显式指定自定义 Playwright 配置（高级选项）
npx specmint run --config ./my-playwright.config.ts

# 强制使用系统 Chrome（跳过 auto 检测）
# 在 config.json 里设 runner.browserChannel: "chrome"
```