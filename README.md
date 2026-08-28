# specmint

> 面向 agent 的 Playwright 页面测试 CLI 工具：自然语言生成用例、可重跑、历史可追溯。

底层基于 [Playwright](https://playwright.dev/) 与本地 [pi-coding-agent](https://github.com/badlogic/pi-mono)。0 造轮子：复用 `@playwright/test` runner / retry / trace / HTML report，通过 SDK Extensions 注入结构化的用例库工具，让 LLM 直接落盘。

---

## 特性

- **自然语言生成用例**：根据描述或结合真实页面探索生成可读性好的 `.spec.ts` 脚本
- **两种生成模式**：纯描述生成（快） / 页面探索生成（先用 Playwright 打开 URL 提取 a11y 快照，准确度更高）
- **强约束可读性**：强制语义定位器（`getByRole` / `getByLabel` / `getByTestId`），禁止易碎选择器，关键步骤中文注释
- **少样本示例库**：内置 `login-flow` / `form-submit` / `list-search` / `detail-page` 等场景示例，prompt 自动匹配，输出风格稳定
- **探索快照缓存**：相同 URL 的 a11y 快照落盘复用（默认 TTL 10 分钟），实测每次生成省 5–15s 浏览器启动
- **CLI 强制归类**：`--module` / `--group` 一键锁定用例模块与分组，避免 PI 自由发挥污染目录
- **按模块 / 分组过滤**：`list` 与 `list_cases` 支持 `--module` / `--group`，大型用例库检索更高效
- **重跑与历史**：失败用例一键重跑，每次运行落盘到 `reports/runs/<batchId>/run.json`，可追溯
- **批次号友好**：`run` 默认产物目录用 `YYYY-MM-DD_HHMMSS` 命名；加 `--label <slug>` 可拼成 `2026-08-27_150059-smoke`，一眼看出谁跑、什么时候跑
- **test-results 按批次号组织**：Playwright 的 screenshots/videos/traces 全部落到 `.specmint/reports/runs/<batchId>/artifacts/`，不再污染项目根
- **可重入自愈**：`heal` 子命令把失败用例与日志委托给 pi-agent 自动修复
- **面向 agent 友好**：所有命令支持 `--json` 输出，结构化错误，退出码语义清晰
- **skill 一键导出**：`skill export` 生成 CodeBuddy / Claude Code 可加载的 SKILL.md

---

## 安装

```bash
# 0. 初始化项目（生成目录结构 + 默认配置；不再生成 playwright.config.ts，配置全在包内）
npx specmint init

# 1. 安装 npm 依赖
npm install

# 2. 安装 Playwright 浏览器（至少 chromium）
#    内网/受限环境可省略这步；specmint 会自动回退到系统 Chrome/Edge
npx playwright install chromium
```

需要 Node.js 20+。

**Playwright 版本与浏览器 revision 的对应关系（重要）**：本项目锁定了 `@playwright/test@1.58.0` / `playwright@1.58.0`，对应 `chromium-1208` 与 `chromium_headless_shell-1208`。如果你本地已经装过 Playwright 浏览器但版本号不一致（如 1.50 / 1.55 / 1.59 / 1.62 等），需要按对应版本重新安装，否则 `chromium.launch()` 会报"Executable doesn't exist"。

版本对应速查：
| Playwright | chromium | headless_shell |
|---|---|---|
| 1.57.x | 1200 | 1200 |
| **1.58.x（项目锁定）** | **1208** | **1208** |
| 1.59.x | 1217 | 1217 |
| 1.60.x | 1223 | 1223 |
| 1.62.x | 1234 | 1234 |

如果你想升级 Playwright，记得先 `npx playwright install chromium` 让浏览器跟上。

浏览器缓存路径：
- macOS：`~/Library/Caches/ms-playwright/`
- Linux：`~/.cache/ms-playwright/`
- Windows：`%LOCALAPPDATA%\ms-playwright\`

---

## 快速开始（5 分钟跑通全链路）

```bash
# 1. 启动示例应用（另开终端）
node examples/serve.mjs
# → http://localhost:4000

# 2. 设置 baseURL（executor 透传给子进程 BASE_URL，不再断链）
#    也可以写到 .specmint/config.json runner.baseURL，env 仍可临时覆盖
export SPECMINT_BASE_URL=http://localhost:4000

# 3. 用 generate 生成用例（探索模式）
npx specmint generate \
  "登录：admin/admin123 登录成功跳转 dashboard，错误密码显示用户名或密码错误" \
  --url http://localhost:4000/login-demo.html \
  --name login-e2e

# 4. 运行
npx specmint run login-e2e

# 5. 查看历史 / 重跑失败 / 修复
npx specmint history
npx specmint rerun
npx specmint heal login-e2e
```

完整端到端步骤见 [`examples/e2e-verify.md`](./examples/e2e-verify.md)。

---

## 子命令一览

详细使用手册：[docs/USAGE.md](./docs/USAGE.md)

| 命令 | 用途 |
|---|---|
| `init` | 初始化项目结构与默认配置 |
| `generate <description>` | 生成测试用例；支持 `--url` / `--module` / `--group` / `--priority` / `--no-explore-cache` / `--page-object` |
| `run [pattern]` | 运行用例；透传 `--browser` / `--workers` / `--retries` / `--headed` / `--ui` / `--debug` / `--grep` / `--label <slug>` |
| `rerun [--from <runId>]` | 重跑最近一次（或指定）失败用例 |
| `list [--tag <tag>] [--module <m>] [--group <g>]` | 列出用例库，支持按模块 / 分组过滤 |
| `show <name>` | 查看用例详情（含 spec 与 POM 代码） |
| `delete <name> [--yes]` | 删除用例 |
| `history [--limit N] [--case <name>]` | 查看运行历史 |
| `heal <name> [--from <runId>]` | 自动修复失败用例 |
| `skill export [--target codebuddy\|claude-code]` | 导出 agent skill 定义到 `./skills/specmint/SKILL.md` |

所有子命令支持 `--json` 输出。

---

## Agent 调用样例

### 全局约定

- 所有子命令支持 `--json`，错误统一为 `{ ok: false, error: { code, message, hint } }`
- 退出码语义见下文"输出契约"
- 推荐先调用 `specmint skill export` 把 SKILL.md 加载到 agent，让 agent 自动学会调用方式

### 推荐流程

```bash
# 1. 生成用例（探索模式）
specmint generate "登录：admin/admin123 登录成功跳转 dashboard" \
  --url https://example.com/login \
  --name login-success \
  --json

# 解析返回的 savedCase.specPath / metaPath，决定下一步

# 2. 运行
specmint run login-success --json

# 3. 如果失败，查看历史拿 runId
specmint history --json

# 4. 重跑
specmint rerun --json

# 5. 自愈
specmint heal login-success --json
```

### 退出码（process.exitCode）

| 码 | 含义 |
|---|---|
| 0 | 成功 |
| 1 | 通用错误 |
| 2 | 参数错误（USAGE） |
| 3 | 子命令未实现 |
| 4 | 资源不存在 |
| 5 | 重复创建 |
| 6 | agent 调用失败 |
| 7 | 测试失败 |
| 8 | IO 错误 |

---

## 输出契约（--json）

### generate

```json
{
  "ok": true,
  "mode": "explore-assisted",
  "description": "...",
  "durationMs": 4321,
  "toolCalls": [{ "name": "save_case", "input": { "name": "login-success", ... } }],
  "savedCase": {
    "name": "login-success",
    "specPath": "/abs/path/tests/login-success.spec.ts",
    "metaPath": "/abs/path/tests/login-success.meta.json",
    "pageObjectPath": null
  },
  "content": "LLM 输出文本..."
}
```

### run

```json
{
  "ok": true,
  "runId": "2026-08-27T10-30-00-000Z",
  "exitCode": 0,
  "status": "passed",
  "durationMs": 12345,
  "command": "npx playwright test tests/login-success.spec.ts",
  "startedAt": "2026-08-27T10:30:00.000Z"
}
```

### history

```json
{
  "ok": true,
  "count": 3,
  "items": [
    {
      "runId": "...",
      "startedAt": "...",
      "finishedAt": "...",
      "status": "passed",
      "totals": { "passed": 3, "failed": 0, "skipped": 0, "timedOut": 0, "interrupted": 0, "durationMs": 4321 },
      "failedTests": []
    }
  ]
}
```

### list

```json
{
  "ok": true,
  "count": 2,
  "items": [
    {
      "name": "login-success",
      "description": "...",
      "tags": ["smoke"],
      "status": "passed",
      "lastRunAt": "...",
      "specPath": "tests/login-success.spec.ts",
      "metaPath": "tests/login-success.meta.json",
      "pageObjectFile": null
    }
  ]
}
```

---

## 架构

```
src/
├── cli.ts                # commander 入口
├── config.ts             # specmint.config.json 加载
├── commands/             # 各子命令实现
├── agent/                # pi-agent SDK 集成 + Extensions + prompt + 页面探索
│   ├── explore.ts        # 页面探索：a11y 快照 + CLI 约束注入
│   ├── explore-cache.ts  # 探索快照缓存（URL + storageState 指纹 + TTL）
│   ├── checkpoint.ts     # agent 运行断点（可恢复）
│   └── templates/        # 内置少样本示例库（login-flow / form-submit / list-search / detail-page）
├── store/                # 用例库 + 运行历史
├── runner/               # executor (CLI spawn) + reporter (结果落盘)
├── templates/            # spec / POM / meta 骨架
└── utils/                # logger + errors + 并发控制 + 重试 + 模板渲染
```

数据流：

```
generate  → CaseStore.save → tests/*.spec.ts + *.meta.json
run       → HistoryStore.createRun → 生成 batchId (YYYY-MM-DD_HHMMSS[-<slug>])
            → spawn playwright test 子进程（注入 SPECMINT_OUTPUT_DIR / SPECMINT_JSON_OUTPUT_FILE）
              ├─ artifacts → .specmint/reports/runs/<batchId>/artifacts/  (screenshots/videos/traces)
              └─ results.json → .specmint/reports/runs/<batchId>/results.json
            → reporter.onTestEnd → HistoryStore.appendResult + CaseStore.applyRunStats
            → reporter.onEnd → HistoryStore.finalizeRun
rerun     → HistoryStore.getLatestFailedTestNames → runTests(pattern)
history   → HistoryStore.listRuns
heal      → pi-agent.update_case → CaseStore.updateCode
skill     → 写入 ./skills/specmint/SKILL.md
```

## 批次号与产物落点

`run` 命令每次执行都会生成一个**批次号**（batchId）作为该次运行的唯一目录名：

```
YYYY-MM-DD_HHMMSS[-<slug>]
```

| 形态 | 示例 | 说明 |
|------|------|------|
| 默认 | `2026-08-27_150059` | 短、自带自然排序、shell 安全 |
| 带 `--label` | `2026-08-27_150059-smoke` | 拼上 kebab-case 语义标签，便于一眼识别 |
| 冲突 | `2026-08-27_150059-smoke-2` | 同批次号已存在时自动追加 `-2` / `-3` |

每个批次号对应一个目录，里面整齐地放齐所有产物：

```
.specmint/reports/runs/<batchId>/
├── run.json                # specmint 结构化历史（runId / label / cases / totals / results）
├── results.json            # Playwright JSON reporter 输出
└── artifacts/              # Playwright outputDir（screenshots / videos / traces）
    └── <test-name>-.../
```

**子进程注入**：executor 在 spawn playwright CLI 时会注入两个环境变量：

- `SPECMINT_OUTPUT_DIR` → `.specmint/reports/runs/<batchId>/artifacts`
- `SPECMINT_JSON_OUTPUT_FILE` → `.specmint/reports/runs/<batchId>/results.json`

自 v2.3 起 `playwright.config.ts` 完全在包内（`dist/runner/playwright.config.{js,ts}`），executor 通过 `import.meta.url` 定位并以 `--config` 指向包内配置。`outputDir` / JSON reporter 落点由这两 env 决定；即使 env 缺失，仍会回退到 `./test-results` / `./reports/runs/.tmp/results.json`，但**强烈建议**保持 env 注入启用，让 test-results 也待在 `.specmint/` 内。

**`--label` 校验**：kebab-case（`^[a-z][a-z0-9-]*[a-z0-9]$`），长度 1–32。合法示例：`smoke`、`p0-regression`、`nightly-batch-2`。

---

## 配置

`specmint.config.json` 关键字段：

```json
{
  "agent": { "model": "anthropic/claude-sonnet-latest", "delegate": "sdk" },
  "explore": {
    "headless": true,
    "timeoutMs": 15000,
    "maxElements": 200,
    "cache": { "enabled": true, "ttlMs": 600000, "dir": ".specmint/cache/explore" }
  },
  "generation": {
    "selectorPolicy": {
      "prefer": ["getByRole", "getByLabel", "getByPlaceholder", "getByTestId", "getByText"],
      "avoid": ["nth-child", "nth-of-type", "complex-css", "xpath"]
    }
  },
  "storage": { "casesDir": "./tests", "reportsDir": "./reports" }
}
```

修改后立即生效，无需重启。

**探索快照缓存**：相同 URL（+ storageState 指纹）的 a11y 快照会落到 `.specmint/cache/explore/` 复用，`ttlMs` 内多次生成不会重复打开浏览器。需要强制刷新时加 `--no-explore-cache` 或直接删除目录。

---

## 开发

```bash
# 开发态执行（无需编译）
npx tsx src/cli.ts <subcommand>

# 编译为 dist/
npm run build

# 跑单元 typecheck
npm run typecheck
```

---

## License

MIT — 详见 [LICENSE](./LICENSE)。

---

## 更新日志

完整变更记录（v2 → v2.3）见 [CHANGELOG.md](./CHANGELOG.md)。当前发布版本 `0.1.0` 聚合了所有内部迭代能力。

---

## 发布

维护者发布新版本的检查清单：

```bash
# 1. 跑全量质量门
npm run typecheck
npm run build
npm pack --dry-run                # 确认包内容（142 文件、145 KB）

# 2. 确认无遗留
git status                        # 工作树干净
cat package.json | head -10       # 确认 version 正确

# 3. 更新版本号（CHANGELOG.md 同步加新段）
npm version patch                 # 0.1.0 → 0.1.1
# 或 minor / major

# 4. 发布到 npm（默认公共 registry）
npm publish                       # 真正的发布
# 验证：npm info specmint

# 5. 提交 tag + 推仓库
git push --follow-tags
```

**预发布通道**：

```bash
# Beta / RC（带 dist-tag，安装时用 npm install specmint@beta）
npm version 0.2.0-beta.1
npm publish --tag beta
```
