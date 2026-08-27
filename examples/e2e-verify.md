# 端到端冒烟验证指南

本指南帮助用户在本地完整跑通 `generate → run → rerun → history → heal → skill export` 全链路。

## 0. 前置条件

```bash
# 0.1 已完成项目初始化
auto-test init

# 0.2 安装 npm 依赖
npm install

# 0.3 安装 Playwright 浏览器（至少 chromium）
npx playwright install chromium

# 0.4 编译（如用 dist/ 路径跑）
npm run build
```

**版本对齐提醒**：项目锁定 `@playwright/test@1.58.0` / `playwright@1.58.0`，对应 `chromium-1208`。如果你本地已装其他版本的 chromium，需要按对应版本重装（参考 README 的版本对应表）。浏览器缓存路径：
- macOS：`~/Library/Caches/ms-playwright/`（注意不是 `~/.cache/...`）
- Linux：`~/.cache/ms-playwright/`
- Windows：`%LOCALAPPDATA%\ms-playwright\`

开发态也可以直接用 tsx（无需编译）：

```bash
npx tsx src/cli.ts <subcommand>
```

## 1. 启动示例应用

```bash
node examples/serve.mjs
# → http://localhost:4000
```

保持该终端打开，另开终端执行后续命令。

## 2. 设置 baseURL

```bash
export AUTO_TEST_BASE_URL=http://localhost:4000
```

## 3. 用 generate 生成用例（探索模式）

```bash
auto-test generate \
  "登录：admin/admin123 登录成功跳转 dashboard，错误密码显示用户名或密码错误" \
  --url http://localhost:4000/login-demo.html \
  --name login-e2e \
  --json
```

观察点：
- 日志中打印 `tool_call: save_case(login-e2e)`
- 生成 `tests/login-e2e.spec.ts` 与 `tests/login-e2e.meta.json`
- JSON 输出含 `savedCase` 字段

## 4. 运行用例

```bash
auto-test run login-e2e
```

观察点：
- Playwright 子进程输出测试结果
- `reports/runs/<timestamp>/run.json` 被自动创建
- `reports/runs/<timestamp>/trace.zip` 由 Playwright 自动写出
- meta.json 的 `stats.lastStatus` 被更新为 `passed`

## 5. 查看历史

```bash
auto-test history --json
```

观察点：
- 输出含本次运行 runId
- `totals.passed >= 1`、`status: passed`

## 6. 制造失败 + rerun

```bash
# 6.1 人为破坏用例（选择器漂移）
sed -i.bak 's/data-testid="login-submit"/data-testid="login-submit-XX"/' \
    tests/login-e2e.spec.ts

# 6.2 再次运行，预期失败
auto-test run login-e2e
# → exitCode != 0

# 6.3 一键重跑失败用例
auto-test rerun
```

观察点：
- rerun 自动筛选最近一次失败，拼接 spec 文件名 pattern
- 新的 runId，与原失败 run 区分开

## 7. heal 自动修复

```bash
auto-test heal login-e2e
```

观察点：
- pi-agent 接收失败错误信息
- 调用 `update_case` 工具覆盖 `tests/login-e2e.spec.ts`
- 重跑应当通过

## 8. skill export

```bash
auto-test skill export --target codebuddy
# → ./skills/auto-test/SKILL.md
```

把 `./skills/auto-test/SKILL.md` 加入 agent 的 skills 目录（如 `~/.codebuddy/skills/`），agent 即可自动发现并调用本工具的全部子命令。

## 9. 清理

```bash
# 停止 server
kill %1

# 清理示例产物
rm -rf tests/*.spec.ts tests/*.meta.json tests/*.bak
rm -rf reports/runs/*
```

## 常见问题

- **generate 报 "启动浏览器失败"**：未运行 `npx playwright install chromium`
- **run 报 "Cannot find module './dist/runner/reporter.js'"**：未编译 `npm run build`（或用 tsx 跑开发态）
- **rerun 报 "no failed tests"**：当前没有失败记录，先跑一次失败用例
- **heal 报 "没有失败记录"**：先 `auto-test run` 制造一次失败
- **pi-agent 报 AuthStorage 错**：配置 API Key（参见 pi-coding-agent 文档）