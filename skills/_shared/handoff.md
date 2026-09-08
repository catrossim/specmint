## 生成器交接契约（生成 → 纳管 的唯一接口）

用例可以来自任何地方：内置 `specmint generate`（LLM）、外部生成 skill（能真的打开页面
探索 DOM）、宿主 agent、或人工手写。**进 specmint 管理体系之前，产物必须满足下面这套
契约**；契约之内由 specmint 负责，契约之外由生成方负责。

### 落盘契约

| 项 | 要求 |
|---|---|
| 路径 | `.specmint/cases/<group>/<name>.spec.ts`，`group` 必须等于用例名第一段，两段均 kebab-case |
| 语言 | 标准 Playwright TS：`import { test, expect } from '@playwright/test'` |
| 内容 | 确定的代码逻辑 + 具体 matcher（`.toHaveURL` / `.toBeVisible`）；禁止 Gherkin / 伪代码 / specmint 私有 DSL |
| 定位器 | `getByRole` > `getByLabel` > `getByPlaceholder` > `getByTestId` > `getByText`；禁用 `nth-child` / `xpath=` / 后代选择器 |
| 等待 | 禁用 `page.waitForTimeout()`，用 `expect()` 自动等待 |
| `meta.json` | **生成方不要写** —— 由 `specmint adopt` 生成（唯一例外：`specmint generate` 内部已写，无需再 adopt） |
| 退出 | 生成方**不调用** `specmint adopt` / `review` / `run`（避免流程分叉与状态污染） |

### 文件头元数据（推荐，团队共享时免命令行参数）

```ts
/**
 * @specmint module: 用户认证
 * @specmint group: auth
 * @specmint priority: P0
 * @specmint tag: smoke, happy-path
 * @specmint description: 管理员登录成功跳转 dashboard
 */
```

元数据优先级：**CLI 参数 > 文件头 `@specmint` 注释 > 文件路径推导**。

### 职责边界

| 角色 | 负责 | 不负责 |
|---|---|---|
| 生成方 | 写对的代码（定位器、断言、等待、文件头注释） | 纳管、裁决、执行、归档 |
| `specmint` | 纳管、校验、裁决、执行、归档、失败修复 | 替生成方重写逻辑（`heal` 是唯一例外，且修完仍需重新裁决） |

### 生成方产出后，specmint 侧的固定动作

```bash
specmint adopt ".specmint/cases/**/*.spec.ts" --priority P0   # S2 纳管（幂等）
specmint lint && specmint verify                              # S3 校验
specmint review                                               # S4 人工裁决
specmint run                                                  # S5 执行（仅 approved）
```

没有 S2，spec.ts 会被 `caseStore.list()` 静默跳过 —— `run` / `review` / verdict 卡口
全都看不见它。
