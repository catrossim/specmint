# Changelog

specmint 项目的所有重要变更都会记录在这里。版本号遵循 [Semantic Versioning](https://semver.org/)。

## 版本说明

- **当前发布版本**：`0.7.0`（详见下方段落）
- 内部迭代以 `v2` / `v2.1` / `v2.2` / `v2.3` / `v2.4` / `v2.5` / `v2.6` / `v2.7` / `v2.8` / `v2.9` 标识，本文件作为对外权威变更日志。
- 自 `0.1.0` 起，每个 npm release 都会在此新增一段 `## [x.y.z] - YYYY-MM-DD`。

---

## [0.7.0] - 2026-09-02（内部 v2.9）

在「lint → run」之间补上**静态可达性层**，并把 lint 升级为可配置化、把 auth 错误码从「隐式」变「可预测」。三件事互不依赖：

### 新增

- **`specmint verify [target]`**：静态可达性校验（lint 之上、run 之下）。不启动浏览器，仅做静态分析。v0.7.0 上线两条规则：
  - `empty-test-body` — `test('x', async () => {})` 这类"啥都没做"的用例 → error
  - `locator-not-in-contract` — `getByTestId('x')` 中的 `x` 不在 `.specmint/contract.json` 声明的 testIds 集合 → error
  - 退出码 `15 = VERIFY_FAILED`
  - 不在 v0.7.0 范围（已知留白）：**编译检查**（TS 7 移除了程序化 `transpileModule` API，待 TS 提供兼容 sync API 后补上，v0.8+ 跟踪） / 路径可达性（需 contract.routes 字段）/ 缺 await 检测
- **`.specmint/lint-rules.json`**：lint 规则 severity 覆盖配置（v0.7.0 新）。位置固定，路径不可改。文件不存在 → 默认行为不变；存在 → 按 `rules` map 应用 `error` | `warn` | `off`，被 `adopt` 与 `lint` 共用同一套配置：
  ```json
  {
    "extends": "specmint:recommended",
    "rules": {
      "debug-leftover": "error",
      "wait-for-timeout": "warn",
      "brittle-selector": "off"
    }
  }
  ```
  未知规则 id → `logger.warn` 后忽略；规则 value 不是 `error`/`warn`/`off` → `CliError(IO_ERROR)`。
  仍不支持运行时 JS plugin（避免引入 Node API 依赖 CLI 体积），仅 JSON 配置级别。
- **auth 运维四命令**（v0.7.0 新）：此前登录态出问题只能靠人肉排查（storageState 是否过期、setup 是否缺断言、多角色是否都还能过）。新增四条：
  - `specmint auth doctor [--expiry-hours <n>]` —— 一行诊断所有 role：storageState 缺失 / 过期（阈值默认 24h）/ setup 缺断言 / Cookie 域名与 `runner.baseURL` 不匹配。有问题退 `1`，可直接作 CI 前置 gate
  - `specmint auth debug <name>` —— headed + 慢动作跑 setup 文件，人工观察登录过程卡在哪一步
  - `specmint auth lint` —— 静态扫 setup 文件：明文密码（启发式 warn）/ 缺 `page.context().storageState()` 调用 / 缺 `expect(page).toHaveURL(...)` 成功断言 / storageState 产物不存在。命中后三类退 `13 = AUTH_INCOMPLETE_SETUP`
  - `specmint auth matrix [--roles a,b] [--grep <p>]` —— 多角色矩阵跑同一批用例并输出 pass/fail 对比表；任一角色失败退 `7 = TEST_FAILED`
- **`run --auth <role>` 执行集语义补全**（v0.7.0）：无显式目标（无 pattern / `--grep` / `--patterns`）时，按 `meta.auth === <role>` 过滤执行集，并自动注入 `storageState = .specmint/auth/storage/<role>.json`；已指定显式目标时 `--auth` 只注入 storageState、不按 `meta.auth` 过滤，并打印语义警告避免误解。退出码 `10-14` 为 auth 子系统保留段（详见 `src/utils/errors.ts`）。

### 修复（关键）

- **`run --auth <name>` 退出码细化**：旧实现不区分「名字拼错」与「storageState 缺失」两类典型错误——`run --auth=typo` 时只有「没匹配用例」warning（exit 4），但 storageState 真的不存在时要把错误推到 Playwright 阶段才暴露（exit 7 + 模糊的 `Cannot find module`）。v0.7.0 起：
  - **名字拼错**（`listAuth()` 中没注册）→ `NOT_FOUND (4)`：`auth 角色 "typo" 未注册，用 \`specmint auth list\` 查看已注册的`
  - **storageState 缺失/失效**（role 注册但 `.specmint/auth/storage/<role>.json` 不存在或解析失败）→ `AUTH_EXPIRED (11)`：`auth 角色 "admin" 的 storageState 不存在：...，请运行 \`specmint auth refresh admin\``
  - 早返逻辑上移到 verdict gate 之前，避免与 verdict 卡口互锁
- **`run` 默认路径 storageState 预检**：当 `options.storageState` 是从 `authName` 派生的默认路径（而非用户显式 `--storage-state` 指定）时，提前校验文件存在性——把「storageState 缺失」错误从 Playwright 阶段（exit 7）提前到 specmint 阶段（exit 11 + 可读 hint）
- **`run --auth` commander 解析别名映射**：旧实现 `--auth` 解析到 `options.auth`，但 `RunOptions` 期望 `authName`，导致 `--auth` 标志完全未生效、走到 Playwright 阶段才报 `Cannot find module`。v0.7.0 起在 cli.ts 的 `run` action 中显式映射 `options.auth → options.authName`

### 重构

- `utils/spec-lint.ts`：`LintOptions` 新增 `overrides` 字段；`applyOverrides()` 在 issues 收集完成后应用 severity 调整（`off` 跳过 / `warn`/`error` 重新归桶），未知规则 id 走 `logger.warn` 后忽略；`KNOWN_RULE_IDS` 从 `LINT_RULES` 派生导出
- `commands/run.ts`：把 `--auth` 早返逻辑（NOT_FOUND vs AUTH_EXPIRED 区分）+ storageState 默认路径派生与预检上移到 verdict gate 初始化之后、verdict gate 应用之前的位置（避免 `options.patterns` 被 gate 改写后 `!options.patterns` 条件永远 false）

### 文档

- `README.md` §3 命令表新增 `verify` 与 lint 覆盖配置说明；§5 当前状态段落新增 v0.7.0 子段
- `skills/specmint/SKILL.md`：在路由表加 `verify`，并在「lint vs verify」段明确两类工具的边界
- `skills/specmint-author/SKILL.md`：补 `.specmint/lint-rules.json` 配置示例 + `lint` 规则 id 全列表
- `skills/specmint-auth/SKILL.md`：补 `AUTH_EXPIRED (11)` 与 `NOT_FOUND (4)` 的 `run --auth` 退出码对照表
- `skills/specmint-operate/SKILL.md`：补 `run --auth <name>` 早返逻辑与修复路径
- `skills/_shared/contract.md`：退出码表补齐 `9 / 10-15`（该文件会被 4 个 skill 拼接，改一处生效四处）
- `docs/USAGE.md`：升级到 v0.7.0——§4 新增「纳管与静态校验」小节（`adopt` / `lint` / `verify` + `.specmint/lint-rules.json`）、auth 运维四命令、§3 补 `contentHash` / `review.*` 字段、§11 补退出码 `9-15`、§13 补 v0.6.0 与 v0.7.0 升级指南
- `examples/`：快速上手与 6 步教程接入 `adopt` + `verify`，CI 示例补 `lint` / `verify` 卡口；`docs/element-contract.md` 说明契约 testId 与 `verify` 的校验关系
- **提示文案修复**：`auth login` 是一个**不存在的子命令**，但 `generate` / `auth-resolve` 的错误提示与 `examples/with-auth/` 都在引导用户执行它。全部改为 `specmint auth init <role>` + `specmint auth refresh <role>`（`scripts/test-auth.ts` 的断言同步更新）

### 升级步骤（v0.6.0 → v0.7.0）

完全向后兼容：

1. **无需任何操作**：所有 v0.6.0 调用行为字节级一致
2. **可选**：在项目根创建 `.specmint/lint-rules.json` 启用 lint 覆盖（默认行为不变）
3. **可选**：CI 流水线加一个 `specmint verify` 步骤作为 lint 与 run 之间的额外卡口（exit 15 = 失败）

---

## [0.6.0] - 2026-09-02（内部 v2.8）

定位转向：从「自然语言 → Playwright 自动转换」转向「Playwright 用例生命周期管理」。用例是**纯 Playwright TS 代码**（确定的逻辑，不是自然语言 DSL），specmint 负责纳管、校验、人工裁决、执行、归档。详见 README §1 与 [docs/review.md](./docs/review.md) §2.1。

### 新增

- **`specmint adopt`**：把已存在的 spec.ts 纳入用例库。只写 meta.json，不动用例代码。行为：
  - 默认跑 lint：error（缺 priority / 无断言 / `waitForTimeout` / 易碎定位器等）**拒绝入仓**，warn 放行但打印
  - 支持单文件 / glob / 整库三种 target 形式
  - 元数据优先级：CLI 参数 > spec.ts 头部 `@specmint module:/priority:/tag:/ticket:` 注释 > 文件路径推导
  - `--group` 与文件所在目录不一致时拒绝（adopt 不移动文件，避免静默改路径）
  - `--force` 全量覆盖字段（默认只补缺失，保留裁决状态）
  - `--keep-verdict` 逃生舱：内容变更时保留原 verdict 不回落 pending（CI 重纳管场景）
  - 输出 `--json` 格式供 agent 解析
- **`specmint lint`**：静态校验 spec.ts（adopt 内部调用同一套规则）：
  - **error 红线**：`missing-playwright-import` / `no-test-block` / `no-assertion` / `wait-for-timeout` / `brittle-selector` / `group-mismatch` / `missing-priority`
  - **warn 软规则**：`debug-leftover`（`console.*` / `debugger`）/ `unknown-testid`（未在 `contract.json` 声明的 `data-testid`）
  - `--strict` 让 warn 也算失败
  - 新退出码 `9 = LINT_FAILED`
- **审核可信度机制**：meta.json 新增 `contentHash = sha256(spec.ts).slice(0,16)`。每次 `adopt` 时重算，已 `approved` 的用例若内容变化，**自动回落 pending**，`reviewer` / `reviewedAt` 清空

### 修复（关键）

- **`run` / `rerun` verdict 卡口 fail-open 漏洞关闭**：此前 `run <file>` 接到「不在 `caseStore` 中的 spec 路径」会**静默放行**，等于绕过整个裁决流程。v0.6.0 起，未纳管文件**拒绝执行**并退出码 4（NOT_FOUND）。回归探针：写一个 `x.spec.ts`（无 meta.json）→ `specmint run x.spec.ts` 应被卡口拦下。
- **重复告警去重**：`run` 在 verdict 卡口 + 单文件匹配两个分支都触发 `list()`，旧实现每条缺 meta 用例都打两条 warning。新实现用进程级 `Set` 去重，且提示语改为 `已跳过（纳管：specmint adopt <file> --priority P0）`，直接给 agent 可执行的下一步。
- **`skill export` 路径 bug 关闭**：旧实现用 `process.cwd()` 定位 `skills/specmint/SKILL.md`，但该路径不在 npm `files` 列表里 —— 用户在自己项目里跑必然 NOT_FOUND。改用 `import.meta.url` 定位包内目录（dist/commands → ../../skills）。

### 重构

- **`skill export` 拆分为 4 个 skill**（旧的单文件 SKILL.md 18KB 太长）：
  - `specmint`（薄路由：生命周期 + 路由表 + 三步快速路径）
  - `specmint-author`（写 + 纳管 + lint 规则）
  - `specmint-operate`（裁决 + 执行 + 修复 + CI）
  - `specmint-auth`（登录态）
  - `_shared/layout.md` 与 `_shared/contract.md` 公共片段由 `export` 时自动按 `<!-- include: x.md -->` 拼接
  - 默认输出到 `./skills-export/<name>/`（不再回写源目录），`--install` 一键装到 `.codebuddy/skills/<name>/` 或 `.claude/skills/<name>/`
- **`run` / `rerun` 的路径处理重构**：`spec-files.ts` 统一处理三种 target 形态（单文件 / glob / 整库）与 Windows 反斜杠归一化。`case-store.list()` 复用同一套路径判定，避免与 spec-files 规则漂移
- **`spec-lint` 模块化**：lint 规则从 `commands/lint.ts` 抽出到 `utils/spec-lint.ts`，供 `adopt` 共用（DRY）
- **`init` 的 nextSteps 重写**：双路径并列（路径 A `adopt` 推荐、路径 B `generate` 可选），`$` 提示符仅套在命令上、注释行用裸行

### 文档

- `README.md`：定位语、§1 应用场景、§2 快速开始（路径 A 优先）、§3 命令表（+adopt/lint）、§5 当前状态（v0.6.0 段落）全部按新方向重写
- `docs/review.md`：新增 §2.1「关键卡口强化（v0.6.0+）」详述 fail-closed、审核可信度、重复告警去重三类变更
- `skills/specmint/SKILL.md`：从单文件 18KB 缩到 ~8KB 路由版；新增 3 个细分 skill；`_shared/` 公共片段

### 包分发

- `package.json` 的 `files` 字段新增 `"skills"`，npm 包分发时带上新拆分后的 4 个 skill + `_shared`

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

## [0.5.2] - 2026-09-02

`specmint run` 的 "No tests found" 根因修复与 review verdict 卡口加固（代码审查修复版）。

### Fixed

- **`run`：全量 / 派生场景 "No tests found"（P0）**——review verdict 卡口开启（`review.requireBeforeRun=true`）时，全量跑、`--priority` / `--auth` / `--module` / `--group`、pattern 多匹配等派生分支原先把 case 内部名经 `--grep` 传给 Playwright，但 `--grep` 只匹配测试 full title（中文场景名），任何平台都永远匹配不到。现改用 `patterns`（多个 positional args，按文件路径正则匹配），与 `<casesDir>/<name>.spec.ts` 一一对应。
- **`rerun`：多条失败用例必挂（P0）**——失败用例名列表原先用空格 join 成单个 pattern 传给 Playwright（单个 argv 元素、含空格的"路径正则"），多条失败用例时必报 "No tests found"。现改为 patterns 数组逐条传递。
- **嵌套同名误执行（P1）**——`login-success` 与 `auth/login-success` 并存时，`<name>.spec.ts` 形式的 pattern 会作为后缀子串误命中嵌套同名文件。pattern 现一律用完整 `specPath`（相对 cwd、正斜杠）+ 逐字符转义 + `$` 锚定生成，互不串扰。
- **单名分支 verdict 反查撞车（P1）**——pattern 收敛到单个用例时，下方"单文件模式"gate 按文件名 `endsWith` 反查会在嵌套同名场景误拦 / 误放。现单名分支内联完成 verdict 判定（blocked 已在匹配时过滤，非 approved 就地提示），跳过反查。
- **单文件直传在 Windows 反斜杠 / 绝对路径 / macOS `/tmp` 软链下 gate 静默失效（P2）**——`specmint run cases\auth\x.spec.ts` 或传绝对路径时，verdict 反查按字面字符串比较命不中；macOS 上 `/tmp` 是 `/private/tmp` 的软链，process.cwd() 与用户传入的 `/tmp/...` 跨根，`pathRelative` 会算出 `../../../tmp/...` 这种鬼东西。现统一 realpath 化 cwd 与用户路径后再 resolve → relative → 正斜杠归一化；命中不到库内用例时给出提示（原先静默跳过检查）。
- **executor `pattern` / `patterns` 并存防御（P2）**——两者同时传入时 positional args 会取并集、静默扩大执行集；现 patterns 优先并告警忽略 pattern。

### 内部

- 兜底 verdict gate 由"字符串反解 pattern"改为按 `specPath` 精确反查（pattern ↔ specPath 一一对应），消除反解转义 regex 的脆弱性；不在库内的 pattern 原样保留交 Playwright 匹配。

---

## [0.5.1] - 2026-09-01

Windows 兼容性修复（内部 v2.7 增量）。0.5.0 在 Windows 上无法运行：`specmint run` 与 `specmint auth refresh` 直接抛 `spawn npx ENOENT`（Windows 上 npx 是 `npx.cmd`，无 shell 时 Node 找不到可执行文件）；`auth init` 生成的 setup.ts 模板中 `STORAGE_STATE` 残留为用户机器绝对路径；reviewer 审计人静默退化为 `'unknown'`（Windows 上 `process.env.USER` 不存在）；用例扫描 `pages` / `node_modules` 比较大小写敏感（NTFS 不敏感目录下被误读为用例）；`npm run build` 在 Windows 上裸调 `chmod` 失败。另随本版首次发布此前已提交的 playwright peerDependencies 化（见文末附节）。

### 关键改动

- **新增 `src/runner/spawn-playwright.ts`**：跨平台 Playwright CLI 启动助手
  - 优先 `createRequire(cwd/package.json)` 解析用户项目 CLI 直连（`spawn(process.execPath, [cliPath, 'test', ...args])`）—— 不经 shell，天然规避 Windows cmd 下含空格路径参数被撕裂的问题（如 `C:\Users\John Doe\...`）
  - 解析候选兼容 playwright ≥ 1.38 的 `exports` 字段限制（已对照 1.58.0 真实包结构验证）：`@playwright/test/cli`（exports 键精确匹配）→ 借道 `playwright/package.json` 定位包根拼 `cli.js` → 无 exports 老版本裸 subpath 兜底
  - 解析失败回退 `npx`（win32 加 `shell: true`），仅 warn 一次
  - `child.on('error')` 捕获 ENOENT / EINVAL 转友好 CliError，提示确认 playwright 已安装、npm 在 PATH
- **`src/runner/executor.ts`**：
  - 删除内联 `spawnPlaywright` / `PW_TEST_RUNNER` / `PW_TEST_BIN_ARGS`（消除与 auth.ts 之间的实现漂移，与 `spawn-env.ts` 注释中"统一收口"的既定设计意图对齐）
  - `RunResult.command` 改用助手返回的实际启动命令串（直连模式显示 `node <cliPath> test ...`，回退模式显示 `npx playwright test ...`）
- **`src/commands/auth.ts`**：
  - `auth refresh` 改用新助手
  - `auth init` 第 124 行 `storageStatePath.replace(cwd + '/', '')` → `relative(cwd, storageStatePath).replace(/\\/g, '/')`，复用 `case-store.ts:72,231` 既有正确范式；模板中 `STORAGE_STATE` 始终是正斜杠相对路径
- **`src/commands/review.ts`**：`defaultReviewer` 兜底链补 `process.env.USERNAME`（Windows）与 `process.env.LOGNAME`（*nix 兜底），不再静默退化为 `'unknown'`；`src/config.ts` 与 `src/cli.ts` 中 reviewer 推断链的自描述文案同步
- **`src/store/case-store.ts`**：
  - 用例目录扫描（walk）的 `pages` / `node_modules` 比较改大小写不敏感（NTFS 兼容 `Pages/`、`NODE_MODULES/` 等）
  - `CaseSummary.specPath` / `metaPath` / `pageObjectFile` 补 `.replace(/\\/g, '/')` 归一化（与同文件既有范式一致）——修复 Windows 下 run.ts 单文件 verdict gate 按路径字符串匹配永不命中、静默失效的问题
- **`package.json`**：
  - `build` 脚本 `chmod +x` 包到 `node -e "if (process.platform !== 'win32') ..."`，Windows 本地 / CI 构建不再失败
  - version `0.5.0` → `0.5.1`
  - 删除 `files` 中悬空的 `templates` 条目（模板经 tsc 编译进 dist，仓库无根级 templates 目录）

### 向后兼容

- **macOS / Linux 行为不变**：直连模式与原 `spawn('npx', args)` 行为等价，省掉一层 npx 解析开销
- **`run` / `refresh` 命令退出码与历史记录 `command` 字段含义不变**：仍为退出码 + 实际启动命令串；显示串更接近真实调用链
- **未安装 playwright 的项目**：仍按既有逻辑在 `init` 探测时 warn，不引入新的 fail-fast 节点

### 验收

- macOS / Linux：`npm run typecheck` 通过；`specmint run` / `specmint auth refresh` 行为与 0.5.0 一致；CLI 解析候选已对照本仓库 node_modules 中 playwright 1.58.0 真实包结构实测（`@playwright/test/cli` 与借道 `playwright/package.json` 均命中，旧裸候选确认抛 `ERR_PACKAGE_PATH_NOT_EXPORTED`）
- Windows：用户侧验证 `specmint run` 不再 ENOENT；`auth init` 生成的 setup.ts 中 `STORAGE_STATE` 为正斜杠相对路径；`npm run build` 本地可构建

### 附：playwright peerDependencies 化（随本版首次发布，commit f765404）

playwright 依赖约束从 `dependencies` 收紧的精确版本 1.58.0 改为 `peerDependencies` 的开放范围（>=1.58.0）。**各接入项目可自行决定** playwright / @playwright/test 的具体版本（如 `1.69.0`、`^1.58.0`、内网镜像版本等），specmint 不再强制带一份 1.58.0 进去。

#### 动机

- specmint 包内对 `@playwright/test` 仅 `import type`（`src/runner/playwright.config.ts` / `reporter.ts`），运行时一律走用户 cwd 的 playwright CLI（`src/runner/executor.ts`）。**实际生效的就是接入项目自己安装的版本**——specmint 一侧根本没必要锁
- 之前的 `dependencies: "playwright": "1.58.0"` 精确锁定会让装了更高版本 playwright 的接入项目被 npm `dedupe` / `peer` 冲突伤到，常见表现是锁了一两份或强制 fallback
- 接入方在 CI / 内网镜像 / 公司统一前端基建下经常需要固定特定版本，硬锁定是阻碍

#### 关键改动

- `package.json`
  - `dependencies` 中移除 `playwright` 与 `@playwright/test`
  - 新增 `peerDependencies`：`"playwright": ">=1.58.0"`、`"@playwright/test": ">=1.58.0"`，二者 `peerDependenciesMeta.optional: false`（npm v7+ 默认会装）
  - `devDependencies` 保留 `playwright@1.58.0` 与 `@playwright/test@1.58.0`，用于 specmint 自身的开发 / `tsc --noEmit` 类型校验
- `src/commands/init.ts`
  - 新增 `probePlaywright(cwd)`：用 `createRequire(cwd/package.json)` 从用户项目解析 `playwright` 与 `@playwright/test/package.json`，避免误读到 specmint 自带的 devDependency
  - `InitResult` 新增 `playwright` 字段（`{ "@playwright/test": string|null, playwright: string|null }`），CICD / 集成测试可据此判断下一步是否需要 `npm install`
  - `nextSteps` 第 2 步依据探测结果动态生成：
    - 都没装：`npm install -D playwright @playwright/test` + blocker 警示
    - 只缺一个：补齐明确版本号
    - 都装好：打印已检测到的版本（便于排错）
  - 完全没装时打印 `⚠ 未检测到 playwright / @playwright/test`，避免 run/generate 阶段才报"找不到模块"
- `README.md`
  - 「当前状态」段删除"`playwright` 1.58.0（用户业务项目无需单独安装）"措辞
  - 改为明确列出 `peerDependencies` 政策：用户自定版本、`specmint init` 检测、executor 走用户项目的 playwright CLI

#### 向后兼容

- **当前已安装 specmint 的项目不受影响**：之前的 1.58.0 已经躺在 `node_modules` 里，新版 specmint 不会再拖一份，对应的 playwright CLI 解析依旧命中已存在的版本
- **如果接入方清掉 lockfile 重装**：peer 缺失会触发 npm v7+ 自动安装（"需要安装 peerDep"），初次 init 后用户可改 package.json 调整到自家偏好的版本
- **强制最低版本约束** `>=1.58.0`：specmint 0.5.0 之前的所有内部实现都基于该版本 API；低于 1.58.0 的接入项目升级 specmint 时需先升 playwright

---

## [0.5.0] - 2026-09-01

generate 命令登录态注入链路贯通（内部 v2.6 增量）。此前 `generate --url` 在 `explorePage` 阶段根本不向 Playwright 注入任何登录态，需要登录的 URL 拿到的就是未登录 DOM，生成的用例全部基于登录页写出来。本次发布把"配置侧已具备但没接上"的能力补完：CLI `--auth <role>` 显式覆盖 + `config.auth.storageState` 默认走通 + 缓存按登录态隔离 + 落盘审计。

### 新增能力

- **CLI `--auth <role>`**：显式指定登录态角色，覆盖 `config.auth.storageState`。对应 `.specmint/auth/storage/<role>.json`；文件不存在时 fail-fast 提示 `specmint auth login --role <name>`（`src/cli.ts` / `src/agent/auth-resolve.ts`）
- **Auth 解析器 `resolveAuth`**（`src/agent/auth-resolve.ts`）：合并 `config.auth` + CLI `--auth <role>`，按优先级解析：
  1. `--auth <role>` → `role: 'cli'`
  2. `config.auth.storageState` → `role: 'config'`
  3. `config.auth.headers` / `extraHTTPHeaders` / `cookies` → `role: 'config-inline'`
  4. 全空 → `role: 'none'`（仅 warning，不 fail）

  `${ENV_VAR}` 占位符在所有路径展开（复用 `config.ts` 的 `expandAuthEnv/Headers/Cookies`）
- **Playwright 注入**：`ExploreOptions` 扩展 `storageState` / `extraHTTPHeaders` / `cookies`，`browser.newContext()` 时透传；cookies 仅在 storageState 缺失时 `addCookies()` 兜底（避免与 storageState 内嵌 cookies 冲突）
- **缓存指纹隔离**：`explorePage` 接受 `cache.storageStateFingerprint`，不同登录态 → 不同 cache 文件，避免 admin 抓的 DOM 被 user 角色复用。fingerprint 只 hash 路径/key，**绝不 hash value**
- **`generation.usedAuth` 审计字段**：每个用例 meta 落盘时记录 `role: 'cli' | 'config' | 'config-inline' | 'none'`、`storageStatePath`、`headerKeys[]`。**不存 token / cookie value**，避免泄露到 git
- **启发式登录页 warning**（`src/commands/generate-helpers.ts`）：探索结束后，若 `role === 'none'` 且 title/URL 含 login/signin/oauth/sso/登录 或 snapshot 含 `type=password`，打 warning 提示用户跑 `specmint auth login`，**不 fail-fast**

### 配置增量

`.specmint/config.json`：

```jsonc
{
  "auth": {
    // 任选其一，priority: storageState > headers/extraHTTPHeaders > cookies
    "storageState": ".specmint/auth/storage/admin.json",  // value 支持 ${ENV_VAR}
    // 或
    "headers":        { "Authorization": "Bearer ${CI_TOKEN}" },
    "extraHTTPHeaders": { "X-Tenant": "${TENANT}" },
    "cookies": [{ "name": "sid", "value": "${SID}", "sameSite": "Lax" }]
  }
}
```

### CLI 增量

```bash
# 项目级单一身份（最常见）
specmint generate --url https://app.example.com/dashboard --description "查看订单列表"
# → 自动用 config.auth.storageState

# 临时切角色（多角色项目）
specmint generate --url https://app.example.com/admin --auth admin --description "审核订单"
# → 覆盖 config 默认，用 .specmint/auth/storage/admin.json

# 忘登录了
specmint generate --url https://app.example.com/dashboard --description "..."
# → warning: 看起来是登录页，请先跑 specmint auth login
# → 不 fail，按未登录态生成
```

### 落盘审计示例

```jsonc
// .specmint/cases/order-list.spec.json
{
  "generation": {
    "mode": "agent",
    "model": "anthropic/...",
    "exploredUrl": "https://app.example.com/dashboard",
    "selectorPolicy": "testid",
    "usedAuth": {
      "role": "config",
      "storageStatePath": ".specmint/auth/storage/admin.json",
      "headerKeys": []
    }
  }
}
```

### 兼容说明

- **完全向后兼容**：未配置 `auth` 段的项目跑 `generate --url` 行为与 v0.4 字节级一致（仅多一行 warning，role=none 时）
- **缓存击穿风险**：旧无 fingerprint 的 cache 视为"未登录态"快照，新调用拿到 fingerprint 后会重新抓一次；旧缓存自然失效，不需主动清理
- **新加的 `usedAuth` 字段是 optional**：旧 case 文件 / `manual` 模式落盘不受影响
- **不在本次范围**：OAuth 流程编排 / token 自动刷新 / Playwright projects 多角色拆分（v2.7+ 议题）

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