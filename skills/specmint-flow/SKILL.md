---
name: specmint-flow
description: |
  把「生成用例」与「管理用例」串成一条流水线：探索/生成 → adopt 纳管 → lint/verify
  校验 → review 人工裁决 → run 执行 → heal 修复回环。当用户要"从零到跑通"、
  "批量生成并纳管"、"把一个会生成 Playwright 用例的 skill 接进 specmint"、
  或需要端到端串起 generate 与 adopt/review/run 时调用。
triggers:
  - 从零到跑通
  - 串联流程
  - 批量生成用例
  - 生成并纳管
  - 接入生成 skill
  - 生成用例流程
  - 端到端流程
---

你负责**把生成与管理串成一条流水线**。

`specmint-author` 管「写+纳管」、`specmint-operate` 管「审+跑+修」，两者之间是断点：
外部生成 skill / `specmint generate` 产出用例后，没人负责把它推进到「已裁决并执行」。
**本 skill 就是这条链路**，只定义阶段、交接契约与失败分支，具体命令细节仍看 author / operate。

<!-- include: layout.md -->

---

## 流水线总览

```
S0 准备 ──► S1 生成 ──► S2 纳管 ──► S3 校验 ──► S4 裁决 ──► S5 执行 ──► 归档
  init      3 种来源     adopt       lint       review      run        reports/
  deps                  （幂等）     verify    （人工）      │
                                                            └─ 失败 ─► heal ─► 回 S4
```

**阶段不可跳过**：S2 缺 → 用例隐形；S3 缺 → 带病进审核；S4 缺 → `run` 退出码 4；
S5 缺 → 不知道用例到底能不能过。

| 阶段 | 命令 | 产出 | 卡点 |
|---|---|---|---|
| S0 | `specmint init` + 依赖校验 | `.specmint/` | 无 `.specmint/` 则后续全废 |
| S1 | `specmint generate` / 外部生成 skill / 手写 | `.spec.ts` | 纯 Playwright TS |
| S2 | `specmint adopt` | `*.meta.json` | 缺 priority 拒绝入仓 |
| S3 | `specmint lint` → `verify` → `npx playwright test` | 校验结论 | error 必须修，不能绕过 |
| S4 | `specmint review` | `review.verdict` | **只能人工**，agent 不得代批 |
| S5 | `specmint run` | `reports/runs/<batchId>/` | 仅 `approved` 可跑 |

---

## S0 准备

```bash
[ -d .specmint ] || specmint init            # 幂等：已有就跳过（--force 才会覆盖）
npx playwright --version                     # playwright 缺失 → npm i -D @playwright/test playwright
ls ~/.cache/ms-playwright/ | grep chromium   # 无浏览器也能跑：runner.browserChannel=auto 会回退系统 Chrome
```

被测页需要登录 → **先切 `specmint-auth`** 建好 role 与 storageState，再进 S1
（`generate`/`run` 都能用 `--auth <role>` 注入）。

---

## S1 生成：三种来源，统一出口

### 来源 A：内置 `specmint generate`（LLM，需先选 model）

```bash
specmint models select                        # 首次必做
specmint generate "管理员登录成功跳转 dashboard" \
  --url http://localhost:4000 --priority P0
```

- `--priority` **必填**（P0/P1/P2/P3），否则退 `2 = USAGE_ERROR`
- `--url` 开启页面探索（同 URL 多用例只探索一次，结果进 `.specmint/cache/explore/`）
- `--auth <role>` 探索阶段注入登录态；`--page-object` 同步生成 POM
- 批量：少量用逗号（`specmint generate "用例1, 用例2"`）或管道（`printf 'a\nb' | specmint generate`）；
  **≥10 条用 `--batch-file specs.txt`**（每行一条，`#` 注释），配 `--concurrency 2`
- 快路径：`--template login-flow|form-submit|list-search|detail-page` 跳过 LLM（~50ms）
- 批量断点：`--checkpoint <dir>` / `--resume <file>`（部分失败保留现场）
- **generate 内部已写 meta.json**，S2 可跳过（除非要补元数据，此时 adopt 是幂等的）

### 来源 B：外部「生成 Playwright 用例」的 skill（推荐，能真开页面看 DOM）

市面上/团队内任何会产出 Playwright 用例的 skill（能探索页面的如 `browser-use`、
`agent-browser` 一类，或纯代码生成的）都可以接到本流水线：**它只负责 S1，产完立刻交回**。

调用它的 prompt 模板（把 `<...>` 换成实际值）：

```
用 <generator-skill> 打开 <url>，探索 <页面/流程>，产出 Playwright TS 用例，
直接写到 .specmint/cases/<group>/<name>.spec.ts：
- 只写标准 Playwright TS，不写 Gherkin / 伪代码 / 自然语言步骤
- 定位器优先级 getByRole > getByLabel > getByPlaceholder > getByTestId > getByText
- 禁止 waitForTimeout，用 expect 自动等待
- 文件头写 @specmint module: / priority: / tag: 注释
- 不要写 .meta.json，也不要调用任何 specmint 命令 —— 纳管由我接手
```

外部 skill 常产出的脏东西，**收回后先自查**：`waitForTimeout`、后代/`nth-child` 选择器、
`console.log`、`test('x', async () => {})` 空体、未在 `contract.json` 声明的 testId。
这些在 S3 会被拦，但先自查能省一轮往返。

### 来源 C：宿主 agent / 人工手写

直接写 `.specmint/cases/<group>/<name>.spec.ts`（见 `specmint-author`）。
你有源码访问能力（grep / 读文件 / 终端）能直接定位 `data-testid`，比任何生成器都准。

<!-- include: handoff.md -->

---

## S2 纳管（来源 B / C 必做，来源 A 可跳过）

```bash
specmint adopt .specmint/cases/auth/login-success.spec.ts --priority P0   # 单条
specmint adopt "auth/**/*.spec.ts" --priority P1                          # 批量 glob
specmint adopt --priority P2 --module 订单管理                            # 整库
```

- 只写 `meta.json`，**绝不改你的 spec.ts**
- 幂等：重复 adopt 只补缺失字段，保留裁决历史与运行统计
- 已 `approved` 的用例内容变更 → 自动回落 `pending`（CI 重纳管可用 `--keep-verdict`）

---

## S3 校验（三层，从廉到贵）

```bash
specmint lint      # 风格：断言 / waitForTimeout / 易碎定位器 / 调试残留   退 9
specmint verify    # 可达性：空 test 体 / testId 未在契约声明               退 15
npx playwright test .specmint/cases/auth/login-success.spec.ts   # 自跑，先跑通再交审
```

**先自跑通再交人工裁决** —— 未跑通的用例浪费审核人的时间。
命中 error 就回到 S1/S2 修 spec 再 `adopt`，**不要用 `--no-lint` 绕过**。

---

## S4 裁决（人工，不可代批）

```bash
specmint review                                   # TTY：REPL 翻页（a/p/n/r/s/q）
specmint review set auth/login-success --verdict approved
specmint review list --verdict pending --json     # CI 查残留
```

作为 agent：**主动提醒用户裁决，不要自己标 `approved`**（人工审核的意义就在此；
用户明确要求批量放行的除外）。

---

## S5 执行与失败回环

```bash
specmint run --priority P0        # 仅 approved；pending 全被过滤 → 退 4
specmint history --limit 5        # 失败看历史
specmint review set <name> --verdict needs-fix && specmint heal <name>
```

`heal` 修完后用例仍是 `pending` → 回 S4 重新裁决 → 再回 S5。

---

## 退出码驱动的分支表（照着跳，别猜）

| 阶段 | 退出码 | 含义 | 下一跳 |
|---|---|---|---|
| S1 `generate` | `2` | 缺 description / `--priority` | 补齐参数重试 |
| S1 `generate` | `11` | `--auth` 的 storageState 缺失 | `specmint auth refresh <role>` |
| S2 `adopt` | `2` | 缺 priority / group 与目录不一致 | 补 `--priority`，或移动文件 |
| S2 `adopt` | `9` | 静态校验红线 | 修 spec → 重新 adopt（不要 `--no-lint`） |
| S3 `lint` | `9` | 风格违规 | 同上 |
| S3 `verify` | `15` | 空 test 体 / testId 未在契约 | 补 test 体 / 把 testId 写进 `contract.json` |
| S3 自跑 | 非 0 | 用例真的挂 | 回到 S1 修代码 |
| S4 `review` | `4` | 用例名拼错 | `specmint list --json` 核对 |
| S5 `run` | `4` | 卡口过滤（多为 pending）或路径未纳管 | `specmint review` / `specmint adopt` |
| S5 `run` | `7` | 用例执行失败 | `history` → `needs-fix` → `heal` → 回 S4 |
| S5 `run` | `11` | auth 过期 | `specmint auth refresh <role>` / `--no-auth` |

完整码表见 `_shared/contract.md`（导出后已内联在文末）。

---

## 一条命令串起来（批量场景模板）

```bash
set -e
specmint init                                                   # S0（已有则跳过）
specmint generate --batch-file specs.txt --priority P1 \
  --url http://localhost:4000 --concurrency 2 --checkpoint .specmint/runs/   # S1
specmint adopt --priority P1                                    # S2（幂等，补外部产物）
specmint lint && specmint verify                                # S3
specmint review                                                 # S4（人工）
specmint run --priority P1                                      # S5
```

CI 变体（无人值守，禁止代替人工放行）：

```bash
specmint lint && specmint verify
PENDING=$(specmint review list --verdict pending --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).count||0))")
[ "$PENDING" -eq 0 ] || { echo "存在 $PENDING 条未裁决用例"; exit 1; }
specmint run --priority P0
```

---

## 反模式（做了就破坏卡口）

| 反模式 | 后果 |
|---|---|
| 生成完直接 `run` | pending 被卡口过滤 → 退 4，白跑 |
| `--no-lint` / `--force` / `--no-require-review` 绕过 | 脏用例进库，卡口形同虚设 |
| agent 代批 `review set approved` | 人工裁决失去意义 |
| 外部生成 skill 自己写 `meta.json` / 自己 `run` | 流程分叉，状态不一致 |
| 一次 `heal` 完直接跑 | heal 后是 pending，必须重新裁决 |
| 一个 spec 文件塞多个不相关流程 | 无法按用例粒度裁决，建议拆成 `<group>/<name>` |

---

## 完成后

向用户汇报：**新增/纳管 N 条、pending M 条、本批执行结果**，并给出下一步命令
（通常是 `specmint review`）。

<!-- include: contract.md -->
