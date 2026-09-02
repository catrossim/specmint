---
name: specmint-author
description: |
  编写和纳管 Playwright 测试用例。当用户需要写新测试用例、生成 Playwright 用例、
  把已有 spec.ts 纳入 specmint 管理、或用例静态校验不通过时调用。
  产物是标准 Playwright TS 文件，写完必须 specmint adopt 纳管。
triggers:
  - 写测试用例
  - 生成 playwright 用例
  - 编写 e2e 测试
  - 纳管用例
  - adopt 用例
  - 用例校验不通过
---

你负责**写用例并纳管进 specmint**。

<!-- include: layout.md -->

---

## 铁律：产物是纯 Playwright TS 代码

- ✅ 写**确定的代码逻辑**：`await expect(page).toHaveURL(/dashboard/)`
- ❌ 不写自然语言步骤描述（`Given/When/Then`、Gherkin、伪代码）
- ❌ 不引入 specmint 私有 DSL —— 用例文件脱离 specmint 也要能直接跑
- 断言必须是具体的 matcher，不能只写 `expect(x)` 不带 `.toBeXxx/.toHaveXxx`

---

## 工作流（三步，缺一不可）

### 第 1 步：写 spec.ts

落盘位置：`.specmint/cases/<group>/<name>.spec.ts`

命名：group 与用例名第一段一致（`auth/login-success` → `cases/auth/login-success.spec.ts`），
两段均 kebab-case。

元数据就近写在文件头部注释里（可选，但推荐——团队共享时不用每次传命令行）：

```ts
/**
 * @specmint module: 用户认证
 * @specmint group: auth
 * @specmint priority: P0
 * @specmint ticket: AUTH-101
 * @specmint tag: smoke, happy-path
 * @specmint description: 管理员登录成功跳转 dashboard
 */
```

`description` 若省略，会自动取 `test.describe('...')` 的标题。

### 第 2 步：adopt 纳管（**不做这步，specmint 看不见这个用例**）

```bash
specmint adopt .specmint/cases/auth/login-success.spec.ts --priority P0
specmint adopt "auth/**/*.spec.ts" --priority P1          # 批量（glob）
specmint adopt --priority P2 --module 订单管理            # 整个用例库
specmint adopt <file> --priority P0 --json                 # agent 解析用
```

为什么必须 adopt：没有 `meta.json` 的 spec.ts 会被 `list()` 静默跳过，
`run` / `review` / verdict 卡口全部看不见它。

元数据优先级：**CLI 参数 > 文件头部 `@specmint` 注释 > 文件路径推导**。

adopt 的语义（重要）：

- **只写 meta.json，绝不覆写你的 spec.ts 代码**
- 幂等：重复 adopt 只补缺失字段，**保留裁决历史与运行统计**
- 已 approved 的用例若内容变更 → **自动回落 pending**，需重新裁决
  （逃生舱：`--keep-verdict` 保留原裁决，CI 重纳管场景用）
- `--force` 全量覆盖字段（默认只补缺失）

### 第 3 步：自验（在提交审核前跑通）

```bash
npx playwright test .specmint/cases/auth/login-success.spec.ts
```

**先自己跑通再交给人工裁决** —— 未跑通的用例会浪费审核人的时间。
你拥有完整的源码访问能力（grep / 读文件 / 终端），能自己定位 `data-testid`、
组件封装与路由约定，这是你比任何生成器都强的地方，务必用上。

---

## 静态校验红线（adopt 时默认执行）

`error` 会**拒绝纳管**，`warn` 打印但放行：

| 规则 | 级别 | 要求 |
|---|---|---|
| `missing-playwright-import` | error | 必须 `import { test, expect } from '@playwright/test'` |
| `no-test-block` | error | 至少有一个 `test(...)` 块 |
| `no-assertion` | error | 至少有一个具体 matcher（`.toHaveURL` / `.toBeVisible` 等） |
| `wait-for-timeout` | error | 禁用 `page.waitForTimeout()`，用 `expect()` 自动等待 |
| `brittle-selector` | error | 禁用 `nth-child` / `nth-of-type` / `xpath=` / 后代选择器 / 属性选择器 |
| `debug-leftover` | warn | 禁止 `console.*` / `debugger` |
| `unknown-testid` | warn | `data-testid` 未在 `contract.json` 契约中声明 |

定位器优先级：`getByRole` > `getByLabel` > `getByPlaceholder` > `getByTestId` > `getByText`。

单独校验不纳管：`specmint lint [file|glob] [--strict] [--json]`

---

## 常见错误

| 现象 | 原因 / 处理 |
|---|---|
| `缺少 priority` | 加 `--priority P0`，或在文件头写 `// @specmint priority: P0` |
| `group-mismatch` | `--group` 与文件所在目录不一致；改参数或移动文件（adopt 不移动文件） |
| 被 `wait-for-timeout` 拒绝 | 换成 `await expect(locator).toBeVisible()` 这类自动等待 |
| 被 `brittle-selector` 拒绝 | `locator('div > span')` 改成 `getByRole(...)` / `getByTestId(...)` |
| 纳管后 `list` 仍看不到 | 确认 meta.json 已生成；`specmint list --json` 核对 |
| 想跳过校验强纳管 | `--no-lint`（仅存量迁移用，新写用例不要跳过） |

---

## adopt 不处理 setup 文件（v0.7.0 起明确）

`specmint adopt` 只扫描 `.specmint/cases/` 下的 `*.spec.ts` 与对应的 `*.meta.json`。

**`specmint adopt 不会扫描也不会纳管**：

- `.specmint/auth/<name>.setup.ts` —— auth setup 文件由 `specmint auth init` 生成 / 用户手写
- `.specmint/auth/storage/<name>.json` —— storageState 二进制 / JSON 产物
- 任何 `.specmint/` 子目录下的非 cases 文件

setup 文件不进 `caseStore`，所以不会被 `run` / `review` / `list` 等命令列出——这是设计上的隔离，不是 bug。

setup 文件本身的静态校验见 `specmint auth lint <name>`（明文密码 / 缺 storageState 调用 / 缺断言等）。

---

## 自定义 lint 规则 severity（v0.7.0 起）

默认 lint 规则的 severity 在 `utils/spec-lint.ts` 里硬编码。要做团队定制，在项目根放：

`.specmint/lint-rules.json`：

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

- 字段 value：`error`（升级）/ `warn`（降级）/ `off`（完全禁用）
- 文件不存在 → 默认行为不变（无需配置即开箱即用）
- 未知规则 id → `logger.warn` 后忽略（不影响其它规则）
- 非法 value → `IO_ERROR`（不是 lint 失败，立即报错）

**`adopt` 与 `lint` 共用同一份配置**——改了 `.specmint/lint-rules.json` 后两条命令的判定同时生效。

**完整规则 id 列表**（v0.7.0）：

| id | 默认 severity | 含义 |
|---|---|---|
| `missing-playwright-import` | error | 必须 `import { test, expect } from '@playwright/test'` |
| `no-test-block` | error | 至少有一个 `test(...)` 块 |
| `no-assertion` | error | 至少有一个具体 matcher |
| `wait-for-timeout` | error | 禁用 `page.waitForTimeout()` |
| `brittle-selector` | error | 禁用 `nth-child` / `xpath=` / 后代选择器 / 属性选择器 |
| `debug-leftover` | warn | 禁止 `console.*` / `debugger` |
| `unknown-testid` | warn | `data-testid` 未在契约中声明 |

不在以上列表的 rule id 在配置文件中会被静默忽略（带 warn）。

**不支持**运行时 JS plugin（避免引入 Node API 依赖 CLI 体积），仅 JSON 配置级别。

---

## 完成后

告诉用户：用例已纳管且为 `pending`，**必须经人工裁决才能执行**，
下一步用 `specmint-operate`（或直接 `specmint review`）。

<!-- include: contract.md -->
