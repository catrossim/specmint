---
name: specmint
description: |
  Playwright 测试用例的生命周期管理：用例以标准 Playwright TS 文件形式存在，
  必须经人工裁决（review）后才能进入执行与 CI。当用户提到测试页面、管理测试用例、
  审核用例、跑测试时调用。本 skill 只做路由，具体操作看下方分流表。
triggers:
  - 测试页面
  - 管理测试用例
  - 审核用例
  - 跑测试
  - web 测试
  - 用例生命周期
---

specmint 管理测试用例的**生命周期**，不代替你写测试逻辑。

核心原则：**用例是纯 Playwright TS 代码**（确定的逻辑，不是自然语言描述），
specmint 负责纳管、校验、人工裁决、执行、归档。

<!-- include: layout.md -->

---

## 生命周期（核心模型）

```
① 写用例        宿主 agent / 人工 写 .spec.ts  → 见 specmint-author
      ↓
② 纳管+校验     specmint adopt（静态校验，红线拒绝入仓）  verdict=pending
      ↓
③ 人工裁决     specmint review → approved / needs-fix / rejected   ← 不可跳过
      ↓
④ 执行         specmint run（仅 approved 可跑）→ 批次归档
      ↓
⑤ 失败修复     specmint heal（仅 needs-fix）→ 回到 ②
```

**关键约束**：

- 未裁决（pending）的用例**永远不会被 `run` 执行** —— 这是硬卡口，不是提示
- 已 approved 的用例**内容一旦变更，自动回落 pending**，必须重新裁决
- `source.type=imported` 表示由宿主 agent / 人工纳管，`generated` 表示由 specmint 生成

---

## 该用哪个 skill

| 你要做的事 | 用哪个 skill |
|---|---|
| 写新用例 / 生成 Playwright 用例 / 把已有 spec 纳管进库 | **`specmint-author`** |
| 审核用例 / 跑测试 / 重跑失败 / 查看历史 / 修用例 / 配 CI 门禁 | **`specmint-operate`** |
| 页面需要登录 / 配 storageState / 多角色切换 | **`specmint-auth`** |

一次会话常需串起多步，典型顺序：
`specmint-author`（写+纳管）→ `specmint-operate`（裁决+执行）→ 失败则回到 author 修改。

---

## 三步快速路径

```bash
# 1. 写用例到 .specmint/cases/<group>/<name>.spec.ts（纯 Playwright TS）
# 2. 纳管（静态校验 + 生成元数据）
specmint adopt .specmint/cases/auth/login-success.spec.ts --priority P0

# 3. 裁决后执行
specmint review set auth/login-success --verdict approved
specmint run
```

---

## 静态校验 vs 静态可达性 vs 跑测（v0.7.0 起）

specmint 提供**三层**「跑之前」的检查，按代价从小到大排列：

| 层 | 命令 | 启动浏览器 | 检查什么 | 退出码 |
|---|---|---|---|---|
| 静态校验（**风格**） | `specmint lint` | 否 | 断言 / `waitForTimeout` / 易碎定位器 / 调试残留 / 契约 testId | `9 = LINT_FAILED` |
| 静态可达性（**逻辑**） | `specmint verify`（v0.7.0 新） | 否 | 空 test 体 / 定位器 vs 契约 testId | `15 = VERIFY_FAILED` |
| 动态执行 | `specmint run` | 是 | 实际页面交互 + 断言 | `7 = TEST_FAILED` |

**关键差异**：

- `lint` 抓**代码风格**——同一段代码可能 lint 通过但跑起来挂（如 `getByTestId('x')` 中 `x` 不存在）
- `verify` 抓**可达性**——确认 test 体能真被执行，且所有 `getByTestId` 都在契约中声明
- `run` 抓**运行时**——动态行为正确性

CI 推荐链路：`specmint lint && specmint verify && specmint run`（从廉到贵逐层 fail-fast）。

**`verify` v0.7.0 上线的两条规则**：

- `empty-test-body`：`test('x', async () => {})` 这类空体用例 → error
- `locator-not-in-contract`：`getByTestId('x')` 中的 `x` 不在 `.specmint/contract.json` 声明的 testIds → error

已知留白（v0.8+ 跟踪）：编译检查（TS 7 移除程序化 API）/ 路径可达性（需 `contract.routes`）/ 缺 await 检测。

**退出码速查**：

| 退出码 | 名称 | 触发命令 | 含义 |
|---|---|---|---|
| 0 | OK | 全部 | 成功 |
| 4 | NOT_FOUND | run / list / auth | 名字拼错 / 路径不在用例库 |
| 7 | TEST_FAILED | run | Playwright 执行失败 |
| 9 | LINT_FAILED | lint | 静态校验未通过 |
| 11 | AUTH_EXPIRED | run / auth | storageState 缺失或失效 |
| 15 | VERIFY_FAILED | verify（v0.7.0 新） | 静态可达性未通过 |

完整退出码表见各命令的 `--help` 与 `docs/USAGE.md`。

<!-- include: contract.md -->
