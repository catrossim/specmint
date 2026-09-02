# specmint

> **把自然语言用例自动转成可执行的 Playwright E2E 套件**
> AI 起草 → 本地仲裁 → `npx specmint run` 直接落地 CI

specmint 是一条端到端的 Web UI 测试流水线：你用一句话描述"在登录页输入正确账号密码、点击登录、跳转到首页"，它会自动生成可维护的 Playwright 测试 + Page Object Module + 中文 spec，并在 `run` 时由 `pi-coding-agent` 引导真实浏览器回放。仲裁关卡、auth 角色管理、产物批次落点都内置齐全。

**全平台支持**（v0.5.1+）：Windows / macOS / Linux 三端行为一致——子进程走 `src/utils/cross-platform.ts` 的 `spawnProcess()`（自动兼容 `npx.cmd` shim / `shell: true`），路径用 `path.posix` 归一化，Windows 上不再出现 `spawn ENOENT`、反斜杠路径污染 setup.ts 等问题。

---

## 1. 应用场景

**适合**

- **新接入 Web 项目的团队** — 没有现成 E2E 框架，又想跳过"先造框架再写用例"的几周冷启动
- **回归测试自动化** — PRD/Story 写完即可生成对应用例，避免测试工程师手写 spec / POM
- **CI 卡口 / 准入门禁** — PR 合并前要求对应模块的 specmint 用例 verdict=approved
- **AI Coding IDE 用户**（CodeBuddy / Claude Code） — 安装 `skill` 后可在 IDE 中直接脚手架整个 repo

**不太适合**

- 已是大型老项目的团队（迁移成本高于收益）
- 纯 API / 移动端 / 跨端测试（本项目仅针对 Web UI）
- 不希望把测试逻辑交给 LLM 起草的合规场景

对比传统 Playwright：specmint 不替换 `@playwright/test`，而是把"写 spec + 写 POM + 维护 selector"这三件事压成一句话。其余断言、fixture、retries、trace、HTML 报告仍由 Playwright 自身完成。

---

## 2. 快速开始（基于 examples，5 分钟跑通）

> 前置：Node ≥ 20。`specmint` 自带 `pi-coding-agent` / `playwright` / `@playwright/test`，**安装 specmint 即可，无需额外 npm 装依赖**；唯一额外动作是下载一次 Chromium 二进制（`npx playwright install chromium`）。本演示直接用仓库自带的 `examples/` 作为被测目标，**无需准备任何业务项目**。

### 2.1 启动 demo 服务

仓库自带两个静态页面 + 零依赖静态服务器，作为 demo 的被测目标：

```bash
git clone https://github.com/catrossim/specmint
cd specmint
node examples/serve.mjs          # 起 http://localhost:4000（默认入口 /login-demo.html）
```

浏览器访问 `http://localhost:4000` 应看到登录页（admin/admin123 登录成功跳到 `dashboard.html`）。

### 2.2 在 examples 里初始化 specmint playground

```bash
cd examples                      # 直接在 examples 目录起 specmint，演示与源码同仓
npx specmint init                # 生成 .specmint/ 目录结构 + .gitignore 追加
npx specmint models select       # 选 LLM（首次需要）；写入 .specmint/config.json 的 agent.model
```

### 2.3 用一句话生成用例

```bash
npx specmint generate \
  "在登录页输入正确账号密码，点击登录，跳转到 dashboard" \
  --url http://localhost:4000 \
  --priority P0

# 查看生成结果（spec + POM + 中文步骤）
npx specmint show auth/login-success
```

### 2.4 裁决 + 跑测

```bash
npx specmint review               # TTY 进 REPL 翻页裁决（a/p/n/r/s/q 单键）
npx specmint run --no-auth        # 公开页场景跑测；用例已 approved 即默认跑
```

### 2.5 跑通后看什么

| 想了解 | 看这里 |
|---|---|
| 完整 6 步教程（从零接入真实业务项目） | [**examples/e2e-verify.md**](./examples/e2e-verify.md) |
| 手写用例的代码结构（spec + 语义定位器） | [**examples/login-flow.spec.ts**](./examples/login-flow.spec.ts) |
| examples/ 目录约定 + 速查表 | [**examples/README.md**](./examples/README.md) |
| 鉴权 / auth 子系统 / CI 集成 / FAQ | [**examples/e2e-verify.md §5–6**](./examples/e2e-verify.md) |

完整使用手册（配置 / 命令清单 / PI 输出契约 / 缓存 / 批次号 / 退出码 / 升级指南等）见 [**docs/USAGE.md**](./docs/USAGE.md)。

---

## 3. 关键命令

> 完整选项请 `specmint <cmd> --help`，或看 [**docs/USAGE.md §3**](./docs/USAGE.md#3-子命令一览)。

| 命令 | 用途 |
|---|---|
| `init` | 在当前目录生成 `specmint.config.json` + `.specmint/` 目录结构 |
| `generate <描述>` | 自然语言批量生成用例（逗号分隔多个）；**v0.5.0+ 支持 `--auth <role>`**，探索阶段自动注入登录态（覆盖 `config.auth.storageState`，多角色用，详见 [examples/with-auth](./examples/with-auth/)） |
| `run [pattern]` | 跑用例；默认仅跑 `verdict=approved` |
| `rerun [--from <runId>]` | 重跑最近一次失败用例 |
| `list [filters]` | 列表展示用例；支持 tag / module / group / priority / auth / require-review 过滤 |
| `show <name>` | 查看用例详情（spec + POM） |
| `delete <name>` | 删除用例 |
| `history` | 查看运行历史 |
| `heal <name>` | 自动修复失败用例（仅 `verdict=needs-fix`） |
| `review list\|set\|show` | 人工裁决 / REPL 翻页（见 [docs/review.md](./docs/review.md)） |
| `skill export [--install]` | 导出 `SKILL.md` 到 `./skills/specmint/`，可同步安装到 IDE |
| `models list\|current\|select` | 切换 agent model（数据源：pi-coding-agent） |
| `auth list\|init\|refresh\|generate` | 管理 auth 角色（登录态 / 持久化） |

### 3.1 最常用的 5 条命令

```bash
# 1. 生成
npx specmint generate "在登录页输入正确账号密码 → 跳转首页"

# 2. 审查 + 裁决（TTY 进 REPL）
npx specmint review

# 3. 跑
npx specmint run

# 4. 失败重跑
npx specmint rerun

# 5. 自愈失败用例
npx specmint heal <case-name>
```

---

## 4. 文档导航

| 文档 | 内容 |
|---|---|
| [**docs/USAGE.md**](./docs/USAGE.md) | 完整使用手册（13 章节）：项目布局、配置、命令清单、PI 输出契约、缓存、批次号与产物落点、退出码、FAQ、升级指南 |
| [**docs/review.md**](./docs/review.md) | 人工裁决状态机 / REPL 翻页 / 脚本裁决 / 运行时卡口 / v0.2.0 行为回滚 |
| [**docs/element-contract.md**](./docs/element-contract.md) | 探查阶段元素契约（spec / POM 之间必须遵守的命名 / 引用规则） |
| [**docs/RELEASING.md**](./docs/RELEASING.md) | 维护者发布流程 / 预发布通道 / 开发态常用命令 |
| [**examples/README.md**](./examples/README.md) | examples 目录约定 + 三种典型场景（从零接入 / 手写用例 / [with-auth 登录态注入](./examples/with-auth/)） |
| [**examples/e2e-verify.md**](./examples/e2e-verify.md) | 从零接入真实业务项目的完整 6 步流程（含 CI / FAQ） |
| [**examples/login-flow.spec.ts**](./examples/login-flow.spec.ts) | 手写用例样例：spec 结构 / 语义定位器 / 用例分组 |
| [**examples/with-auth/**](./examples/with-auth/) | **v0.5.0 新增**：generate 登录态注入端到端演示（`--auth <role>` 覆盖 / 缓存指纹隔离 / `generation.usedAuth` 审计） |
| [**CHANGELOG.md**](./CHANGELOG.md) | 版本变更记录（v0.1.0 → v0.5.2） |

---

## 5. 当前状态

- 当前发布版本：**`0.5.2`**
  - v2.7 增量 A（[0.5.1](./CHANGELOG.md#051---2026-09-01)）：Windows 全平台兼容——`spawn('npx')` ENOENT 修复 / 路径归一化 / `process.env.USERNAME` 兜底 / NTFS pages 目录大小写不敏感 / 构建脚本去 chmod
  - v2.7 增量 B（[0.5.2](./CHANGELOG.md#052---2026-09-02)）：`run` / `rerun` 执行集修复——verdict 卡口开启时全量跑与 `--priority` / `--auth` / `--module` / `--group` 派生不再报 "No tests found"；`rerun` 多条失败用例修复；嵌套同名用例不再互相串扰；单文件直传支持绝对路径与反斜杠路径的卡口检查
- Node：≥ 20
- 自带依赖：`@earendil-works/pi-coding-agent` ^0.84.0、`commander` ^15.0.0、`typebox` ^1.0.0
- **Peer 依赖（用户项目自行决定版本）**：`playwright` / `@playwright/test` 必须 ≥ 1.58.0。specmint **不再强制锁定**版本，集成方可在自己的 `package.json` 写任何兼容版本（例如固定 `1.69.0`、`>=1.58.0 <2.0.0` 等）。executor 实际调用的是用户 cwd 的 `npx playwright test`，运行时用的就是接入项目自带的版本。`specmint init` 会检测当前项目里是否已装这两个包，并在 `nextSteps` 给出推荐安装命令。
- License：[MIT](./LICENSE)
