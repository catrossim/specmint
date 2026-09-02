# specmint

> **Playwright 测试用例的生命周期管理器**
> 写用例 → `adopt` 纳管 → `review` 人工裁决 → `run` CI 执行

specmint 不代替你写测试逻辑，而是给已经存在的 Playwright TS 用例**加一层组织、审核与卡口**：

- 用例产物就是**标准 Playwright TS**（确定的代码，不是自然语言 DSL），脱离 specmint 仍可直接 `npx playwright test` 跑
- `adopt` 把外部写好的 spec.ts 纳入用例库（生成 `meta.json`、跑 lint 红线）
- `review` 是硬卡口：**未裁决的用例永远不会被 `run` 执行**
- 已审核用例内容若变更，自动回落 pending，需重新裁决（审核可信度）
- 路径不可配置、产物可整体退出（删掉 `.specmint/`，spec.ts 仍是普通 Playwright 测试）

定位上，specmint 是**给"用 agent 写 Playwright 用例"的团队提供一套统一管理机制**：CodeBuddy / Claude Code / 人工写出来的 spec.ts 散落各处时不可信；纳入用例库 + 走审核后才进 CI。

可选路径：

- `adopt` 路径（**推荐**）—— agent / 人工写好 Playwright 后纳管，无需 LLM
- `generate` 路径 —— specmint 调 LLM 起草原型，需先 `models select`（v0.5.0 起）

**全平台支持**（v0.5.1+）：Windows / macOS / Linux 三端行为一致——子进程走 `src/utils/cross-platform.ts` 的 `spawnProcess()`（自动兼容 `npx.cmd` shim / `shell: true`），路径用 `path.posix` 归一化，Windows 上不再出现 `spawn ENOENT`、反斜杠路径污染 setup.ts 等问题。

---

## 1. 应用场景

**适合**

- **用 AI Coding IDE（CodeBuddy / Claude Code）写 Playwright 的团队** — agent 在 IDE 里直接产出 `*.spec.ts`，但散落的 spec 不可信；specmint 把它们**纳管进库**，强制走人工裁决才进 CI
- **新接入 Web 项目的团队** — 用 `adopt` 路径跳过"先造框架再写用例"的几周冷启动；用例就是标准 Playwright TS，新人立刻能上手
- **回归测试自动化 + CI 卡口** — PR 合并前要求对应模块的用例 `verdict=approved`，未裁决的用例**永远不会被执行**
- **混合来源的用例管理** — 一部分由 `generate`（LLM）起草，一部分由宿主 agent / 人工手写，全部走同一套裁决流程

**不太适合**

- 已是大型老项目的团队（迁移成本高于收益）
- 纯 API / 移动端 / 跨端测试（本项目仅针对 Web UI）
- 不接受任何人工介入的全自动 CI（specmint 的核心约束是「未裁决不可跑」）

对比传统 Playwright：specmint 不替换 `@playwright/test`，而是在它之上加一层「组织 + 审核 + 卡口」。其余断言、fixture、retries、trace、HTML 报告仍由 Playwright 自身完成。

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
```

### 2.3 路径 A（推荐）：写 Playwright 用例 → 纳管

> 不需要配 LLM，任何已能产 Playwright 用例的人 / agent 都能参与。

```bash
# 1) 写用例：.specmint/cases/auth/login-success.spec.ts（标准 Playwright TS）
#    推荐在文件头部用 @specmint 注释预填元数据：
#
#    /**
#     * @specmint module: 用户认证
#     * @specmint priority: P0
#     * @specmint tag: smoke
#     */
#    import { test, expect } from '@playwright/test';
#    test.describe('登录流程', () => {
#      test('合法凭据登录成功', async ({ page }) => {
#        await page.goto('/login-demo.html');
#        await page.getByLabel('用户名').fill('admin');
#        await page.getByLabel('密码').fill('admin123');
#        await page.getByTestId('login-submit').click();
#        await expect(page).toHaveURL(/dashboard\.html/);
#      });
#    });

# 2) adopt：静态校验 + 生成 meta.json（缺 priority 时拒绝入仓）
npx specmint adopt .specmint/cases/auth/login-success.spec.ts --priority P0

# 3) 也可以批量：
npx specmint adopt "auth/**/*.spec.ts" --priority P1
npx specmint adopt --priority P2 --module 订单管理            # 整库纳管
```

### 2.4 路径 B：用 LLM 生成用例（可选）

```bash
npx specmint models select       # 选 LLM；首次必做
npx specmint generate \
  "在登录页输入正确账号密码，点击登录，跳转到 dashboard" \
  --url http://localhost:4000 \
  --priority P0
```

### 2.5 裁决 + 跑测（两条路径共用）

```bash
npx specmint lint                            # 静态校验（adopt 时默认已跑过）
npx specmint verify                          # 静态可达性（v0.7.0 新，空 test 体 / 契约外 testId）
npx specmint review                          # REPL 翻页裁决（a/p/n/r/s/q 单键）
npx specmint review set auth/login-success --verdict approved
npx specmint run                             # 仅跑 verdict=approved（卡口默认开启）
```

### 2.6 跑通后看什么

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
| `init` | 在当前目录生成 `.specmint/config.json` + 目录结构（cases / auth / reports / cache） |
| `adopt [target]` | **（v0.6.0 新）** 把已存在的 spec.ts 纳入用例库。只写 meta.json，不动用例代码；默认跑 lint（缺 priority 拒绝入仓）。支持单文件 / glob / 整库。元数据优先级：CLI > 文件注释 > 路径推导 |
| `lint [target]` | **（v0.6.0 新）** 静态校验 spec.ts：缺 import / 无 test / 无断言 / `waitForTimeout` / 易碎定位器 → error 拒绝入仓；`console.log` / `debugger` / 未声明 testid → warn。**v0.7.0+** 支持 `.specmint/lint-rules.json` 规则 severity 覆盖 |
| `verify [target]` | **（v0.7.0 新）** 静态可达性校验（lint 之上、run 之下）：空 test 体 / 定位器未在契约声明 → error。不启动浏览器。退出码 `15 = VERIFY_FAILED` |
| `generate <描述>` | 用 LLM 生成用例（逗号分隔多个）。v0.5.0+ 支持 `--auth <role>` 探索阶段注入登录态 |
| `run [pattern]` | 跑用例；**默认仅跑 `verdict=approved`**，卡口默认开启。**v0.7.0+** `--auth <name>` 区分 `NOT_FOUND (4)`（名字拼错）与 `AUTH_EXPIRED (11)`（storageState 缺失） |
| `rerun [--from <runId>]` | 重跑最近一次失败用例 |
| `list [filters]` | 列表展示用例；支持 tag / module / group / priority / auth / verdict 过滤 |
| `show <name>` | 查看用例详情（spec + meta + POM） |
| `delete <name>` | 删除用例 |
| `history` | 查看运行历史 |
| `heal <name>` | 自动修复失败用例（仅 `verdict=needs-fix`） |
| `review list\|set\|show` | 人工裁决 / REPL 翻页（见 [docs/review.md](./docs/review.md)） |
| `skill export [--install]` | **（v0.6.0 重写）** 批量导出 4 个 skill（specmint / author / operate / auth），含 `_shared` 片段拼接；`--install` 一键装到 `.codebuddy/skills/` 或 `.claude/skills/` |
| `models list\|current\|select` | 切换 agent model（数据源：pi-coding-agent） |
| `auth list\|init\|refresh\|generate\|doctor\|debug\|lint\|matrix` | 管理 auth 角色（登录态 / 持久化 / 运维诊断，见 §3.2） |

### 3.1 最常用的 5 条命令

```bash
# 1. 纳管用例（写好的 Playwright 用例进库 + 静态校验）
npx specmint adopt .specmint/cases/auth/login-success.spec.ts --priority P0

# 2. 人工裁决（TTY 进 REPL：a/p/n/r/s/q 单键；或 review set 批量）
npx specmint review
npx specmint review set auth/login-success --verdict approved

# 3. 跑测（仅执行 verdict=approved，缺裁决自动退出码 4）
npx specmint run

# 4. 失败重跑
npx specmint rerun

# 5. 自愈失败用例（先把 verdict 改为 needs-fix，再 heal）
npx specmint heal auth/login-success
```

### 3.2 auth 子命令速查表（v0.7.0 新增四命令）

目标 URL 需要登录时，**业务 spec 不需要写任何 auth 配置**——specmint 在 runner 层自动注入 `storageState`。你只需要把登录步骤做成 setup 文件，specmint 帮你复用 Cookie 到所有用例。

```bash
# === 接入流程（首次 / 换密码 / 加新角色时）===

# 1. 生成 setup 模板（手写登录步骤，最稳）
npx specmint auth init <role>            # 例: auth init admin

# 2. 跑一次 setup 生成 storageState
ADMIN_PASSWORD=xxx npx specmint auth refresh admin

# 3. 写进 .specmint/config.json（提交到 git，团队共享）
#    { "auth": { "storageState": ".specmint/auth/storage/admin.json" } }

# === 日常命令 ===

npx specmint auth list                   # 看所有 role + 时长 + Cookie 数 + setup 完整性
npx specmint auth doctor                 # 一行诊断（过期 / 缺断言 / 域名不匹配）
npx specmint auth lint                   # 静态扫描 setup 文件（明文密码 / 缺 storageState）
npx specmint auth debug admin            # headed 模式逐步看登录过程
npx specmint auth matrix --roles admin,editor  # 多角色矩阵跑 + 对比表

# === 让 PI 起草登录步骤（登录页结构复杂时）===

npx specmint auth generate --name admin --url https://example.com/login \
  "用 admin 账号登录，登录后跳转到 /dashboard"

# === 临时切换角色跑测 ===

npx specmint run --auth editor           # CLI 覆盖 config
SPECMINT_NO_AUTH=1 npx specmint run      # 完全不走 auth（公开页 demo）
```

**关键 UX 改进**（v0.7.0 起）：

- `auth doctor` 在跑测前发现 4 类常见问题：storageState 缺失 / 过期（>24h） / Cookie 域名与 baseURL 不匹配 / setup 文件缺断言。退出码 1 让 CI 可用作 gate。
- `auth lint` 把 setup 文件的 4 类违规标出来：明文密码（启发式 warn）/ 缺 `storageState()` 调用 / 缺 `expect(page).toHaveURL(...)` / storageState 不存在。
- `auth list` 现在显示每个 role 的"上次刷新时间 / Cookie 数 / setup 完整性"，避免靠人肉记忆判断。
- `init` 末尾会问"目标 URL 是否需要登录"，CI 自动跳过。

> 完整流程 / 多角色切换 / 审计字段见 [`docs/USAGE.md`](./docs/USAGE.md) 第 4 章 + [`examples/with-auth/`](./examples/with-auth/)。

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
| [**CHANGELOG.md**](./CHANGELOG.md) | 版本变更记录（v0.1.0 → v0.7.0） |

---

## 5. 当前状态

- 当前发布版本：**`0.7.0`**

  **v0.7.0 新增与修复**

  - **`specmint verify [target]`**（新命令）：lint 之上、run 之下的静态可达性校验，不启动浏览器
    - `empty-test-body`：`test('x', async () => {})` 这类空体用例 → error
    - `locator-not-in-contract`：`getByTestId('x')` 中的 `x` 不在 `.specmint/contract.json` 声明的 testIds → error
    - 退出码 `15 = VERIFY_FAILED`
    - 已知留白：编译检查（TS 7 移除程序化 API）/ 路径可达性（需 contract.routes）/ 缺 await 检测
  - **`.specmint/lint-rules.json`**（新配置）：lint 规则 severity 覆盖（`error` / `warn` / `off`），被 `adopt` 与 `lint` 共用，文件不存在视为「无覆盖」（默认行为不变）
  - **auth 运维四命令**（新命令）：`doctor`（一行诊断：过期 / 缺断言 / Cookie 域名不匹配，有问题退 1）/ `debug <name>`（headed 慢动作逐步看登录过程）/ `lint`（静态扫 setup：明文密码 / 缺 `storageState()` / 缺成功断言，退 13）/ `matrix [--roles a,b]`（多角色矩阵跑 + pass/fail 对比表，失败退 7）
  - **`run --auth <role>` 执行集语义补全**：无显式目标时按 `meta.auth === <role>` 过滤执行集 + 自动注入 `storageState`；有显式目标（pattern / `--grep`）时只注入登录态并打印语义警告
  - **`run --auth <name>` 退出码细化**（关键修复）：现在区分
    - `NOT_FOUND (4)`：名字拼错（`listAuth()` 中没注册）
    - `AUTH_EXPIRED (11)`：role 已注册但 `.specmint/auth/storage/<role>.json` 缺失/失效
    - 旧实现会把 storageState 缺失错误推到 Playwright 阶段，退出码 7 + 模糊 `Cannot find module`；v0.7.0 起前置到 specmint 阶段，给可读 hint（`specmint auth refresh <name>`）
  - **`run` 默认路径 storageState 预检**：当 `options.storageState` 是从 `authName` 派生的默认路径时，提前校验存在性，避免把「缺失」错误推到 Playwright 阶段
  - **`run --auth` commander 别名映射**：旧实现 `--auth` 解析到 `options.auth`，与 `RunOptions.authName` 不匹配导致标志完全失效；v0.7.0 在 cli.ts 的 `run` action 中显式映射

- 上一版 **`0.6.0`**
  - **定位转向**：specmint 从「自然语言→Playwright 自动转换」转向「Playwright 用例生命周期管理」。用例是**纯 Playwright TS 代码**（确定的逻辑，不是自然语言 DSL），specmint 负责纳管、校验、人工裁决、执行、归档。详见本文 §1
  - **v0.6.0 新命令**：
    - `specmint adopt` — 把已存在的 spec.ts 纳管进用例库（写 meta.json，不动代码）。支持单文件 / glob / 整库；缺 priority 拒绝入仓；文件注释 `@specmint module:/priority:/tag:/ticket:` 可作为元数据默认值
    - `specmint lint` — 静态校验规则化（adopt 内部调用同一套规则）。红线：无 import / 无 test / 无断言 / `waitForTimeout` / 易碎定位器；软规则：`console.log` / `debugger` / 未声明 testid
  - **核心修复**：`run` / `rerun` 失败开放（fail-open）漏洞关闭 —— 直传未纳管文件路径（无 meta.json）时**拒绝执行**（回归探针见 [docs/review.md §4](./docs/review.md#4运行时卡口)）
  - **审核可信度**：已 `approved` 的用例内容若变更（`contentHash` 变化），自动回落 `pending`，需重新裁决。`--keep-verdict` 逃生舱保留原裁决（CI 重纳管场景）
  - **SKILL 重构**：旧的 `skills/specmint/SKILL.md` 拆分 + 新增 3 个，合计 4 个：specmint（路由）/ specmint-author（写+纳管）/ specmint-operate（审+跑+修）/ specmint-auth（登录态）；`_shared/layout.md` 与 `_shared/contract.md` 公共片段由 export 时自动拼接
  - **路径修复**：`skill export` 从 `process.cwd()` 推导源目录的旧 bug 关闭 —— 改用 `import.meta.url` 定位包内目录；输出从 `./skills/specmint/`（回写源目录）改为 `./skills-export/<name>/`，`--install` 一键装到 `.codebuddy/skills/` 或 `.claude/skills/`
  - 配套 `package.json` 的 `files` 已加 `"skills"`，随 npm 包分发
- Node：≥ 20
- 自带依赖：`@earendil-works/pi-coding-agent` ^0.84.0、`commander` ^15.0.0、`typebox` ^1.0.0
- **Peer 依赖（用户项目自行决定版本）**：`playwright` / `@playwright/test` 必须 ≥ 1.58.0。specmint **不再强制锁定**版本，集成方可在自己的 `package.json` 写任何兼容版本（例如固定 `1.69.0`、`>=1.58.0 <2.0.0` 等）。executor 实际调用的是用户 cwd 的 `npx playwright test`，运行时用的就是接入项目自带的版本。`specmint init` 会检测当前项目里是否已装这两个包，并在 `nextSteps` 给出推荐安装命令。
- License：[MIT](./LICENSE)
