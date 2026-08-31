# Changelog

specmint 项目的所有重要变更都会记录在这里。版本号遵循 [Semantic Versioning](https://semver.org/)。

## 版本说明

- **当前发布版本**：`0.3.0`（内部 v2.5 增量，详见 [0.3.0] 段）
- 内部迭代以 `v2` / `v2.1` / `v2.2` / `v2.3` / `v2.4` / `v2.5` 标识，本文件作为对外权威变更日志。
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

---

## [0.4.0] - 2026-08-31

### Fix
- `run "classes/"` 这类含 `/` 的目录/路径前缀 pattern 原先被 fast-path 当作"已知文件路径"直接交给 playwright，下方"单文件模式 verdict gate"按 `m.specPath === resolvedPattern` 找不到匹配后被静默跳过，verdict 卡口完全失效。现统一走 `caseStore.list({ pattern, module, group })` + `applyVerdictGate` 派生，与 `--priority` / `--authName` 完全对齐（`src/commands/run.ts`）。

### Feat
- `run` 命令新增 `--module <module>` 与 `--group <group>` 选项：精确匹配 `meta.module` / `meta.group`，可与 `pattern` / `--grep` 叠加；无 `pattern` 时与 `--priority` / `--authName` 一致派生 grep 并过 verdict gate（`src/cli.ts`、`src/commands/run.ts`）。

### Docs
- `skills/specmint/SKILL.md` / `SKILL.codebuddy.md` / `SKILL.claude-code.md` `run` 命令行同步追加 `--module` / `--group`，并说明 `pattern` 支持目录前缀。
- `docs/USAGE.md` "运行" 段新增 `--module` / `--group` 与目录前缀示例。

## [0.3.0] - 2026-08-30

review 元数据升级为**真正的执行关卡**（内部 v2.5 增量）。本次发布把 `meta.review.verdict` 从静态标签升级为运行时过滤维度：`specmint run` 默认仅跑 `verdict=approved` 的用例；`specmint heal` 默认仅修 `verdict=needs-fix` 的用例；CI 流水线能精准避免「未裁决 / 需修复 / 已废弃」三类用例污染产物。新增 REPL 翻页裁决器，把人工仲裁从被动填字段变为主动流水线一环。

### 新增能力

- **`review` REPL 翻页裁决队列**（v0.3 默认入口）：`specmint review`（无子命令）首次进 TTY → 翻页列表 + 单键裁决；非 TTY 降级为 `review list`。支持 `[a]pproved / [n]eeds-fix / [r]ejected / [s]kipped / [q]uit` 单键操作
- **`review set <case>` 子命令**：脚本/CI 场景，按 `--verdict --reviewer --reason` 直接更新 meta.review，不进 REPL
- **`review list` 子命令**：列所有用例的裁决状态，支持 `--verdict needs-fix` 过滤、JSON 输出
- **`review show <case>` 子命令**：查看单个用例的裁决状态 + case 描述 + 最近修改时间
- **`generate` 末尾挂点**：TTY 模式下 generate 完成后提示"新用例待裁决，是否现在打开 review REPL"；非 TTY / 配置 `review.pendingOnGenerate=false` 时跳过
- **`run` verdict 卡口**：`specmint run` 默认仅跑 `verdict=approved` 的用例；用 `--include-pending` / `--include-needs-fix` / `--include-rejected` 放宽；`--force` 完全关闭卡口；`--no-require-review` 等价于 `requireBeforeRun=false`
- **`heal` verdict 卡口**：`specmint heal` 默认仅修 `verdict=needs-fix` 的用例；用 `--include-pending` / `--include-approved` / `--include-rejected` 放宽；`--force` 完全关闭卡口；`--no-require-review` 等价于 `requireBeforeHeal=false`
- **`rerun` verdict 卡口**：与 `run` 共用同一套过滤语义
- **`list --verdict` 过滤**：按 verdict 过滤用例

### 配置增量

`.specmint/config.json`：

```jsonc
{
  "review": {
    "requireBeforeRun": true,            // 是否对 run / rerun 启用 verdict 卡口
    "requireBeforeHeal": true,           // 是否对 heal 启用 verdict 卡口
    "pendingOnGenerate": true,           // generate 后是否提示进入 review REPL
    "reviewerSource": "git-user",        // 默认裁决人来源：git-user / env / none
    "blockedOnRun":  ["pending", "needs-fix", "rejected"],     // run 默认排除
    "blockedOnHeal": ["pending", "approved", "rejected", "skipped"]  // heal 默认排除
  }
}
```

完全关闭 review 卡口（回到 v0.2.0 老行为）：

```jsonc
{
  "review": {
    "requireBeforeRun": false,
    "requireBeforeHeal": false
  }
}
```

或在运行时传 `--no-require-review`。

### CLI 增量

```bash
# 进入 REPL 翻页裁决
npx specmint review

# 脚本/CI：单条裁决
npx specmint review set auth/login-success --verdict approved --reviewer alice
npx specmint review set auth/login-failure --verdict needs-fix --reason "selector 飘"

# 查看状态
npx specmint review show auth/login-success
npx specmint review list --verdict needs-fix

# run：默认仅 approved；放宽
npx specmint run                                # 默认仅 verdict=approved
npx specmint run --include-pending              # 加上 pending
npx specmint run --include-needs-fix --force    # 全部都跑（不推荐在 CI 用）
npx specmint run --no-require-review            # 完全关闭卡口

# heal：默认仅 needs-fix
npx specmint heal auth/login-failure             # 仅 verdict=needs-fix
npx specmint heal auth/login-failure --include-rejected  # 也尝试修 rejected
npx specmint heal auth/login-failure --force    # 完全关闭卡口

# list 按 verdict 过滤
npx specmint list --verdict needs-fix
```

### 升级步骤（v0.2.0 → v0.3.0）

**默认行为有变**（这是 minor 但行为相关的变更，所以 bump 到 0.3.0 而非 0.2.x）：

1. **CI 流水线可能突然少跑用例**：v0.2.0 默认跑全部 enabled 用例，v0.3.0 默认仅跑 verdict=approved。首次升级前请先：
   - 用 `npx specmint review list` 看看当前用例的 verdict 状态
   - 用 `npx specmint review set <case> --verdict approved` 把想保留 CI 跑的所有用例标 approved
   - 或者临时加 `--no-require-review` 一次过渡
2. **想保留 v0.2.0 老行为**：在 `.specmint/config.json` 设 `review.requireBeforeRun = false` / `review.requireBeforeHeal = false`
3. **想用 REPL 流程**：从 `npx specmint review` 开始（首次进 TTY）

向后兼容：

- 旧 `.specmint/` 项目无 verdict 的用例视作 `verdict=pending`，会被 run 默认排除（这正是 v0.3.0 的目的：强制人工看完一遍再让 CI 跑）
- 老的 `specmint run` / `specmint heal` 完整保留，加 `--no-require-review` / `--force` 即等价老行为

### 不在本次范围

- review show 加 diff 视图
- REPL 批量裁决
- heal 给出 verdict 改进建议
- verdict 时间线历史
- 留给 v0.4.0+

---

## [0.2.0] - 2026-08-29

前端元素契约特性上线（内部 v2.4 增量）。新增 `.specmint/contract.json` 契约文件机制：specmint 在 generate 阶段读取契约并注入 prompt，让 LLM 按约定生成 Playwright 定位器，避免命名风格漂移。

### 新增能力

- **契约文件加载**：固定路径 `.specmint/contract.json`（与 `config.json` 同策略，"路径不可配置"）。契约缺失/为空时静默降级为 null，行为与现状字节级一致
- **契约 prompt 注入**：`buildGeneratePrompt` 在定位器策略段后条件插入 `<contract>` XML 段，模块保持单向依赖（`contract.ts` 是叶子模块）
- **宽容降级 + fail-fast**：JSON.parse 失败 / version 不匹配 / elements 非数组 → `CliError(IO_ERROR)`，其余一律宽容
- **完整指南**：[docs/element-contract.md](./docs/element-contract.md) 含 JSON 结构、4 个场景示例、AI 协同工作流、10 条 FAQ

### 配置增量

无。契约文件结构与位置均固定，不入 `.specmint/config.json`。

### 升级步骤（v0.1.0 → v0.2.0）

无需操作，向后兼容。如需使用契约特性，按 `docs/element-contract.md` 第 5 步创建 `.specmint/contract.json` 即可。