# auto-test 使用说明

中文使用手册，面向使用者。开发者信息见 [README.md](../README.md)，端到端冒烟流程见 [examples/e2e-verify.md](../examples/e2e-verify.md)。

---

## 这是什么

`auto-test` 是一套面向 **AI agent** 的页面测试工具。底层用 [Playwright](https://playwright.dev/)，测试脚本由 LLM（默认对接本地 `pi-agent`）按你的描述直接生成。

## 能做什么

- **生成用例**：用中文描述业务场景 → 自动打开页面分析 DOM/可交互元素 → 生成可读性好的 Playwright 脚本
- **运行用例**：单条跑、按 tag 跑、并行、headless/headed、UI 调试
- **自动修复**：用例失败时，把错误信息喂给 LLM，让它自动改选择器/断言
- **记录历史**：每次运行都落盘到 `reports/runs/<时间戳>/run.json`
- **重跑**：一键重跑上次失败
- **导出 skill**：把工具自身导出为 agent 可加载的 skill

---

## 1. 安装（5 分钟）

环境要求：Node.js 20+

```bash
# 1. 初始化项目（生成目录结构 + 默认配置）
auto-test init

# 2. 安装 npm 依赖
npm install

# 3. 安装 Playwright 浏览器
npx playwright install chromium
```

**版本对齐提醒**：本项目锁定 `@playwright/test@1.58.0` / `playwright@1.58.0`，对应 `chromium-1208`。如果你本地已装其他 Playwright 版本的浏览器，Playwright 启动时会报"Executable doesn't exist"，需要按版本重装：

| Playwright | chromium | headless_shell |
|---|---|---|
| 1.57.x | 1200 | 1200 |
| **1.58.x（项目锁定）** | **1208** | **1208** |
| 1.59.x | 1217 | 1217 |
| 1.60.x | 1223 | 1223 |
| 1.62.x | 1234 | 1234 |

浏览器缓存路径：
- macOS：`~/Library/Caches/ms-playwright/`（不是 `~/.cache/...`）
- Linux：`~/.cache/ms-playwright/`
- Windows：`%LOCALAPPDATA%\ms-playwright\`

---

## 2. 快速开始（10 分钟跑通第一个用例）

### 2.1 启动示例 server

```bash
node examples/serve.mjs
# → http://localhost:4000
```

保持终端打开，另开终端继续。

### 2.2 设置 baseURL

```bash
export AUTO_TEST_BASE_URL=http://localhost:4000
```

### 2.3 用自然语言生成用例

```bash
auto-test generate \
  "登录：admin/admin123 登录成功跳转 dashboard，错误密码显示用户名或密码错误" \
  --url http://localhost:4000/login-demo.html \
  --name login-demo
```

发生了什么：
1. 打开浏览器访问 `--url` 指定页面
2. 提取 a11y 树 + 可交互元素
3. 把描述 + 页面快照喂给 LLM
4. LLM 调用 `save_case` 工具生成 `tests/login-demo.spec.ts` + `tests/login-demo.meta.json`

### 2.4 运行

```bash
auto-test run login-demo
# ✓ 1 passed (Xs)
```

### 2.5 查看历史

```bash
auto-test history
```

输出示例：
```
2026-08-27 15:30:42  login-demo           ✓ passed   1.2s
2026-08-27 14:00:11  login-flow           ✗ failed   3.4s
```

---

## 3. 子命令详解

所有子命令都支持 `--json` 输出结构化结果（便于 agent 解析）。

### 3.1 `auto-test init`

初始化项目结构与默认配置。

```bash
auto-test init                # 已有配置时跳过
auto-test init --force        # 强制覆盖
auto-test init --json
```

生成：
- `tests/` 用例目录
- `tests/pages/` Page Object 目录
- `reports/runs/` 运行历史
- `auto-test.config.json` 默认配置
- `playwright.config.ts`（若不存在）

### 3.2 `auto-test generate <description>`

根据描述生成测试用例。两种模式：

**纯描述模式**（快，准确性中等）：
```bash
auto-test generate "登录失败时显示用户名或密码错误" --name login-error
```

**页面探索模式**（推荐，准确度高）：
```bash
auto-test generate \
  "登录：admin/admin123 登录成功跳转 dashboard，错误密码显示用户名或密码错误" \
  --url http://localhost:4000/login-demo.html \
  --name login-flow
```

常用选项：
- `-u, --url <url>`：启用页面探索模式
- `-n, --name <name>`：用例名（kebab-case，必填或自动生成）
- `--page-object`：同步生成 Page Object 文件
- `--tag <tag>`：附加标签，可多次传入

### 3.3 `auto-test run [pattern]`

运行测试用例。

```bash
auto-test run                          # 跑 tests/ 下所有用例
auto-test run login-flow               # 跑指定用例（kebab-case 自动补 .spec.ts）
auto-test run login-*                  # glob 匹配标题
auto-test run --browser firefox        # 指定浏览器
auto-test run --headed                 # 有头模式（可见浏览器）
auto-test run --ui                     # 打开 Playwright UI（交互调试）
auto-test run --debug                  # 调试模式（断点）
auto-test run --workers 4              # 并行 worker
auto-test run --retries 2              # 失败重试
auto-test run --grep "登录"            # 按标题过滤
auto-test run --json                   # JSON 输出
```

退出码：
- `0`：全部通过
- `7`：存在失败用例

### 3.4 `auto-test rerun`

一键重跑最近一次失败的用例。

```bash
auto-test rerun                # 重跑最近一次失败
auto-test rerun --from <id>    # 指定来源 run ID
```

工作流程：
1. 读 `reports/runs/<id>/run.json` 找失败用例名
2. 拼 `--grep` 过滤后跑一次

### 3.5 `auto-test heal <name>`

让 LLM 自动修复失败用例。

```bash
auto-test heal login-flow
auto-test heal login-flow --from <runId>
```

工作流程：
1. 读最近一次失败的错误信息
2. 喂给 LLM（带原始 spec.ts + 失败日志）
3. LLM 调用 `update_case` 工具覆盖原文件
4. 修复后再跑一次验证

### 3.6 `auto-test list`（别名 `ls`）

列出所有用例。

```bash
auto-test list
auto-test list --tag smoke
auto-test list --json
```

输出列：name / status / tags / lastRunAt / duration。

### 3.7 `auto-test history`

查看运行历史。

```bash
auto-test history
auto-test history --limit 20
auto-test history --case login-flow     # 只看指定用例的历史
auto-test history --json
```

每次运行的完整记录在 `reports/runs/<时间戳>/run.json`，包含：
- 总览（totals、durationMs）
- 每个 spec 的结果（status、duration、error、retry、stdout/stderr）
- 附件路径（trace.zip、screenshots）

### 3.8 `auto-test show <name>`

查看用例详情。

```bash
auto-test show login-flow
auto-test show login-flow --json
```

输出：name / createdAt / lastRunAt / stats / tags + spec 内容预览。

### 3.9 `auto-test delete <name>`（别名 `rm`）

删除用例。

```bash
auto-test delete login-flow          # 交互式确认
auto-test delete login-flow --yes    # 跳过确认（脚本场景）
```

会同时删除 `tests/<name>.spec.ts` 和 `tests/<name>.meta.json`。

### 3.10 `auto-test skill export`

把工具自身导出为 agent 可加载的 skill。

```bash
auto-test skill export                          # 默认 codebuddy 格式
auto-test skill export --target claude-code
```

输出位置：`./skills/auto-test/SKILL.md`。把这个目录拷到 agent 的 skills 目录（如 `~/.codebuddy/skills/`），agent 即可自动发现并调用本工具。

---

## 4. 配置文件

`auto-test.config.json`：

```json
{
  "agent": {
    "model": "minimax-cn",        // LLM 标识，格式 "provider/model" 或仅 "provider"
    "delegate": "sdk",            // 当前仅支持 sdk
    "systemPromptAdditions": ""   // 追加到 LLM 的系统提示
  },
  "explore": {
    "enabledByDefault": false,    // generate 是否默认开启探索模式
    "headless": true,             // 探索时浏览器是否 headless
    "timeoutMs": 15000,           // 探索超时
    "maxElements": 200,           // a11y 树最大节点数
    "waitUntil": "domcontentloaded"
  },
  "generation": {
    "selectorPolicy": {
      "prefer": ["getByRole", "getByLabel", "getByPlaceholder", "getByTestId", "getByText"],
      "avoid": ["nth-child", "nth-of-type", "complex-css", "xpath"]
    },
    "language": "zh",             // 生成代码注释 + 用例名 语言
    "comments": "verbose",        // verbose | minimal | none
    "style": "page-object-optional"
  },
  "runner": {
    "configPath": "./playwright.config.ts",
    "defaultBrowser": "chromium",
    "trace": "on-first-retry",
    "screenshot": "only-on-failure"
  },
  "storage": {
    "casesDir": "./tests",
    "pageObjectsDir": "./tests/pages",
    "reportsDir": "./reports"
  }
}
```

> **配置优先级**：CLI 参数 > 环境变量 > 配置文件 > 内置默认值。

环境变量：
- `AUTO_TEST_BASE_URL`：所有用例共享的 base URL（会注入到 `process.env.BASE_URL`，spec 中可用）
- `AUTO_TEST_CONFIG`：配置文件路径（默认 `./auto-test.config.json`）

---

## 5. 常见场景

### 场景 1：从描述直接生成（无目标 URL）

适合还没打开页面的场景，比如纯描述业务规则：

```bash
auto-test generate \
  "购物车：加入 3 件商品后，结算按钮显示总价 ¥299" \
  --name cart-total
```

### 场景 2：批量脚本场景

```bash
# CI 中跑全部 smoke 用例
auto-test run --tag smoke --json > result.json
test $(jq '.totals.failed' result.json) -eq 0
```

### 场景 3：选择器漂移 → heal 自动修

```bash
# 1. 产品改版，选择器失效
auto-test run login-flow
# ✗ Test timeout exceeded: getByRole('button', { name: '登录' }) not found

# 2. 让 LLM 自动修
auto-test heal login-flow
# ✓ Spec updated. Re-running...
# ✓ 1 passed

# 3. 提交
git diff tests/login-flow.spec.ts
git add tests/login-flow.spec.ts tests/login-flow.meta.json
git commit -m "chore: auto-heal login-flow after selector change"
```

### 场景 4：让 agent 自动发现并使用工具

```bash
auto-test skill export --target codebuddy
cp -r ./skills/auto-test ~/.codebuddy/skills/
```

之后 agent 看到 SKILL.md 后会自动知道 `auto-test generate ...` / `auto-test run ...` 的用法，可直接在对话中让 agent 帮你写。

---

## 6. 故障排查

### Q1. generate 报 "启动浏览器失败"
没装 chromium：
```bash
npx playwright install chromium
```

### Q2. generate 报 "Executable doesn't exist at .../chromium-XXXX/chrome"
本地装的 chromium 版本与 Playwright 不匹配。先看实际装的版本：
```bash
ls ~/Library/Caches/ms-playwright/   # macOS
```
按 Playwright 版本对应表选择正确的 Playwright 版本（见 §1），或直接装新版本：
```bash
npm install playwright@1.58.0 @playwright/test@1.58.0 --save-exact
npx playwright install chromium
```

### Q3. run 报 "Cannot find module './dist/runner/reporter.js'"
没编译。两种方式：
```bash
npm run build                # 编译
# 或开发态直接用 tsx：
npx tsx src/cli.ts run ...
```

### Q4. rerun 报 "no failed tests"
最近一次运行全部通过，先跑一次失败用例。

### Q5. heal 报 "没有失败记录"
要先有失败记录才能 heal：
```bash
auto-test run login-flow    # 制造一次失败
auto-test heal login-flow
```

### Q6. pi-agent 报 "AuthStorage 错误"
需要配置 API Key。本项目默认用 pi-agent 的 SDK：`@earendil-works/pi-coding-agent`，参见 [pi.dev SDK 文档](https://pi.dev/docs/latest/sdk)。

### Q7. LLM 生成的用例断言写宽了导致 strict mode 失败
这是 LLM 的常见小瑕疵，正好是 `heal` 的典型场景：
```bash
auto-test heal <name>
```

### Q8. tsx 报错 "__name is not defined"（页面探索）
已知 tsx/esbuild 转译问题，已在 `src/agent/explore.ts` 中通过字符串形式 `page.evaluate` 规避。如果遇到，看下 `dist/` 是否过期：
```bash
npm run build
```

### Q9. 想看 trace / 截图
```bash
# run 时打开 trace
auto-test run --ui    # 或 --debug

# 或在 config 中开启 trace: "on"
# 跑完后：
npx playwright show-trace reports/runs/<id>/trace.zip
```

### Q10. 想给 agent 用，但 agent 不识别
确认 SKILL.md 在 agent 能发现的位置：
- codebuddy：`~/.codebuddy/skills/auto-test/SKILL.md`
- claude-code：`~/.claude/skills/auto-test/SKILL.md`

然后让 agent 重启或刷新。

---

## 7. 文件位置速查

| 内容 | 位置 |
|---|---|
| 用例脚本 | `tests/<name>.spec.ts` |
| 用例元数据 | `tests/<name>.meta.json` |
| Page Object | `tests/pages/<name>.ts` |
| 配置文件 | `auto-test.config.json` |
| Playwright 配置 | `playwright.config.ts` |
| 运行历史（run 详情） | `reports/runs/<时间戳>/run.json` |
| 运行附件（trace、截图） | `reports/runs/<时间戳>/*` |
| Skill 导出产物 | `skills/auto-test/SKILL.md` |

---

## 8. 下一步

- 端到端冒烟流程：[examples/e2e-verify.md](../examples/e2e-verify.md)
- 架构与扩展：[README.md](../README.md)
- 接入 agent：[skill export 命令](#310-auto-test-skill-export)