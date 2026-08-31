# specmint 前端元素契约（小白完整指南）

> 适用版本：specmint v0.3.0+
> 阅读时长：~10 分钟
> 适用人群：完全没接触过"元素契约"的工程师 / 测试 / 前端 / 产品

---

## 1. 这是什么？我为什么要关心？

### 一句话定义

**元素契约** = 团队维护的一份 JSON 文件，告诉 specmint"前端页面里这些元素叫什么、用什么定位器"。specmint 在生成 Playwright 用例时读这份契约，生成的脚本就用契约里约定的名字，不再"拍脑袋"命名。

### 类比理解

想象你在一家餐厅点菜：

| 场景 | 没有契约 | 有契约 |
|---|---|---|
| 你说"我要那个辣的汤" | 服务员可能端来酸辣汤、可能端来麻辣汤、可能端来冬阴功，**看心情** | 服务员看一眼菜单（契约）说"您要的是『川味酸辣汤』对吧"，**准确无误** |
| 服务员拿起笔记录 | 笔记可能是"辣的汤""那种辣的""红汤"——**写法漂移** | 按菜单编号记录"汤-03"——**稳定一致** |

specmint + 元素契约 = 服务员 + 菜单。

### 解决什么问题？

- **测试脚本命名风格统一**：所有人（人写的、AI 写的、不同时期写的）生成的 testid 都长一样
- **对接 AI 生成的前端代码**：很多前端代码已经是 AI 生成的，契约可以让 specmint 直接消费 AI 输出的元素清单
- **重构抗性**：UI 改样式、加 class、加 wrapper，testid 不变 → 用例不破
- **可读性**：看测试脚本就知道"这个按钮是干啥的、在哪"

### 我一定要用吗？

**不一定要用**。契约**完全可选**：
- 没契约 → specmint 按现有策略（语义定位器优先）生成，行为字节级一致
- 有契约 → specmint 按契约约定生成，更精确

什么时候**强烈建议用**：
- 团队 ≥ 3 人
- 已经在前端代码里大量用 `data-testid`
- 前端代码由 AI 生成/部分生成
- 想让 AI 生成的测试脚本"听指挥"

---

## 2. 前置知识

| 需要的 | 用途 | 怎么获得 |
|---|---|---|
| Node.js ≥ 18 | 运行 specmint | [nodejs.org](https://nodejs.org) |
| 文本编辑器（VS Code / Sublime / 记事本都行） | 编辑 JSON 文件 | 已装 |
| 知道 `data-testid` 是 HTML 属性 | 理解契约里 `testId` 字段对应什么 | [MDN 文档](https://developer.mozilla.org/zh-CN/docs/Web/HTML/Global_attributes/data-*) 一段话 |
| 知道 Playwright 定位器（`getByTestId` / `getByRole`） | 看懂生成的测试脚本 | [Playwright 文档](https://playwright.dev/docs/locators) |

**你不需要懂**：JSON Schema、AST 解析、TypeScript、HTTP。契约文件就是普通的 JSON 文本。

---

## 3. 五步上手

### 第 1 步：确认项目已经初始化

```bash
cd /path/to/your-project
ls -la .specmint/
```

你应该看到：
```
.specmint/
├── config.json
└── ...
```

如果没看到，说明项目还没初始化，跑：
```bash
npx specmint init
```

### 第 2 步：创建契约文件

在项目根目录创建 `.specmint/contract.json`：

```bash
touch .specmint/contract.json
```

### 第 3 步：填入契约内容（最简版本）

用编辑器打开 `.specmint/contract.json`，粘贴：

```json
{
  "version": "1",
  "elements": [
    {
      "name": "login-submit-button",
      "testId": "login-submit-btn",
      "role": "button",
      "text": "登录",
      "description": "登录页主提交按钮"
    },
    {
      "name": "email-input",
      "testId": "email-input",
      "role": "textbox",
      "label": "邮箱",
      "description": "登录页邮箱输入框"
    }
  ]
}
```

**保存文件**。

### 第 4 步：提交到 git（建议）

```bash
git add .specmint/contract.json
git commit -m "feat: add element contract for login page"
```

契约文件应该入 git——它是**团队约定**，不是用户私有配置。

### 第 5 步：跑 generate 验证

```bash
npx specmint generate "登录页输入邮箱、密码、点登录按钮，断言跳转到首页"
```

打开生成的 `.specmint/cases/auth/login-success.spec.ts`，你会看到定位器长这样：

```ts
await page.getByTestId('email-input').fill('test@example.com');   // ← 来自契约
await page.getByTestId('login-submit-btn').click();               // ← 来自契约
await expect(page).toHaveURL(/\/home/);
```

**而不是** LLM 自由发挥的：
```ts
await page.locator('input[type="email"]').fill('test@example.com');  // ✗ 风格漂移
await page.getByRole('button', { name: '登录' }).click();           // OK 但不是契约约定的 testid
```

**完成！** 契约生效了。

---

## 4. JSON 结构详解

### 最小骨架

```json
{
  "version": "1",
  "elements": []
}
```

**空 elements 数组等价于无契约**——specmint 不会报错，但也不会注入任何内容。建议先用这个骨架跑通链路，再逐步加元素。

### 完整字段说明

| 字段 | 必填 | 类型 | 用途 | 示例 |
|---|---|---|---|---|
| `version` | ✅ | `"1"` | 契约格式版本（当前仅 `"1"`） | `"1"` |
| `elements` | ✅ | 数组 | 元素清单 | (见下) |
| `elements[].name` | ✅ | 字符串 | 元素标识（在契约内全局唯一） | `"login-submit-btn"` |
| `elements[].testId` | ❌ | 字符串 | 对应 HTML `data-testid` 属性值 | `"login-submit-btn"` |
| `elements[].role` | ❌ | 字符串 | 对应 ARIA role（`button`/`textbox`/`link` 等） | `"button"` |
| `elements[].label` | ❌ | 字符串 | 对应 `<label>` 文本 | `"邮箱"` |
| `elements[].text` | ❌ | 字符串 | 元素可见文本 | `"登录"` |
| `elements[].description` | ❌ | 字符串 | 用途说明，会渲染到 LLM prompt | `"登录页主提交按钮"` |

### 字段怎么选？

每个元素至少填一个能让 specmint "定位到它"的字段：

| 想用 Playwright 的什么方法？ | 必填字段 |
|---|---|
| `getByTestId('xxx')` | `testId` |
| `getByRole('xxx', { name: 'xxx' })` | `role` + `text` |
| `getByLabel('xxx')` | `label` |
| `getByText('xxx')` | `text` |
| `getByPlaceholder('xxx')` | （目前契约未显式支持，可放 `text` + `description` 说明） |

### 字段越多越好吗？

不是。每个元素填**够用就行**：
- 只声明 `testId` → specmint 用 `getByTestId`
- 声明 `testId + role + text` → specmint 优先用 `testId`，按 `selectorPolicy.prefer` 备选

---

## 5. 多场景示例

### 场景 A：登录页（4 个元素）

```json
{
  "version": "1",
  "elements": [
    {
      "name": "login-email-input",
      "testId": "auth-email",
      "role": "textbox",
      "label": "邮箱",
      "description": "登录表单邮箱字段"
    },
    {
      "name": "login-password-input",
      "testId": "auth-password",
      "role": "textbox",
      "label": "密码",
      "description": "登录表单密码字段"
    },
    {
      "name": "login-submit-btn",
      "testId": "auth-submit",
      "role": "button",
      "text": "登录",
      "description": "登录表单提交按钮"
    },
    {
      "name": "login-error-msg",
      "testId": "auth-error",
      "role": "alert",
      "description": "登录失败时的错误提示"
    }
  ]
}
```

### 场景 B：列表页（3 个元素）

```json
{
  "version": "1",
  "elements": [
    {
      "name": "order-list-table",
      "testId": "order-table",
      "role": "table",
      "description": "订单列表表格"
    },
    {
      "name": "order-row",
      "testId": "order-row",
      "role": "row",
      "description": "订单列表单行"
    },
    {
      "name": "order-create-btn",
      "testId": "order-create",
      "role": "button",
      "text": "新建订单",
      "description": "新建订单入口按钮"
    }
  ]
}
```

### 场景 C：表单提交页（2 个元素）

```json
{
  "version": "1",
  "elements": [
    {
      "name": "feedback-textarea",
      "testId": "feedback-content",
      "role": "textbox",
      "label": "反馈内容",
      "description": "反馈表单文本域"
    },
    {
      "name": "feedback-submit-btn",
      "testId": "feedback-submit",
      "role": "button",
      "text": "提交反馈",
      "description": "反馈表单提交按钮"
    }
  ]
}
```

### 场景 D：完整混合（10+ 个元素）

参考 `.specmint/contract.json` 本身的写法——一个项目通常把所有页面的元素都放一份契约，按场景/页面分组（建议用 `description` 注明）。

---

## 6. 怎么生成契约本身？

### 手工维护（推荐起步）

1. 打开前端代码（React/Vue）
2. 找到所有 `data-testid="xxx"` 的元素
3. 把 `xxx` 填到 `testId` 字段
4. 加 `role` / `label` / `text` 让契约更完整
5. 提交 git

**适用场景**：< 30 个元素的小项目、前端改动不频繁。

### AI 半自动生成（推荐规模化）

把前端代码 + 让 LLM 帮你提契约：

```
你是一名前端工程师。读取 src/auth/LoginForm.tsx 与 src/auth/LoginPage.tsx，
提取所有带 data-testid、aria-label、<label htmlFor=> 的元素，
按以下 JSON 结构输出：

{
  "version": "1",
  "elements": [
    { "name": "<id>", "testId": "<值>", "role": "<role>", "label": "<label>", "description": "<用途>" }
  ]
}
```

把 LLM 输出存到 `.specmint/contract.json` 并 git commit。

### 工具扫描（P1 规划中）

未来 specmint 会提供 `specmint contract scan` 子命令，自动扫源码生成契约。当前版本不支持，请用前两种方式。

---

## 7. 与 AI 生成的前端代码协同

### 工作流

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│  PRD / 需求描述 │ → │  AI 生成前端代码 │ → │  AI 提取契约     │
│  (人类写)        │    │  (Cursor/Copilot│    │  (Claude/CodeB) │
│                 │    │   等)            │    │                 │
└─────────────────┘    └─────────────────┘    └─────────────────┘
                                                      │
                                                      ↓
                                              .specmint/contract.json
                                                      │
                                                      ↓ (git commit)
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│  Playwright 跑测│ ← │  specmint 读契约 │ ← │  PRD 描述需求    │
│  (CI / 本地)     │    │  + 生成 Playwright │  (人类写)         │
│                 │    │    脚本           │    │                 │
└─────────────────┘    └─────────────────┘    └─────────────────┘
```

**关键点**：
1. 前端契约从 AI 生成代码时一次性提取 → 入 git
2. PRD 描述测试场景 → specmint 读契约 + PRD → 生成 Playwright 脚本
3. 整个链路里"AI 生成元素契约"和"AI 生成测试脚本"使用的是**同一份契约**，自然对齐

### 提示词模板：让 AI 提取契约

```
你是 QA 工程师。读取 src/ 下的所有 .tsx/.vue 文件，按以下 JSON 结构提取
所有带 data-testid / aria-label / 关联 label 的可交互元素：

{
  "version": "1",
  "elements": [
    {
      "name": "<kebab-case 标识符>",
      "testId": "<data-testid 值，若有>",
      "role": "<button/textbox/link/checkbox 等>",
      "label": "<label 文本，若有>",
      "text": "<元素可见文本，若有>",
      "description": "<用途简述>"
    }
  ]
}

要求：
- name 全局唯一，建议 "{页面}-{元素}" 命名（如 login-submit-btn）
- 找不到的信息就省略，不要硬填
- 只输出 JSON，不要解释
```

---

## 8. 常见问题 FAQ

### Q1：契约文件不存在会怎样？

**A**：完全没影响——specmint 静默跳过契约注入，行为与现状字节级一致。契约是**完全可选**的增强机制。

### Q2：契约里 `elements: []` 会怎样？

**A**：等价于契约不存在，specmint 跳过注入。建议先用空契约跑通链路，再逐步扩充。

### Q3：契约 JSON 写错了会怎样？

**A**：
- JSON 语法错（漏逗号、引号不对）→ 立即报错 `契约文件 JSON 解析失败：...`，附错误位置
- `version` 写了 `"2"` → 报错 `契约 version 不匹配`
- `elements` 不是数组 → 报错 `契约 elements 字段必须是数组`

报错是好事——避免契约格式错位时静默加载产生不可预期的 LLM 输出。

### Q4：我能改契约文件路径吗？

**A**：不能。契约文件固定在 `.specmint/contract.json`，这是项目原则（与 `config.json` 同策略）。原因：
- 减少决策成本（团队不用讨论放哪）
- 避免配置漂移（所有机器一致）
- 写文档/工具集成时不用"看情况分支"

### Q5：契约改了之后旧的用例脚本要重生成吗？

**A**：
- 新生成用例 → 自动用新契约
- 已存在用例 → 不会自动重生；用 `specmint heal <name>` 时会读新契约辅助修复

### Q6：specmint 命令找不到契约怎么办？

**A**：
```bash
# 1. 确认路径
ls -la .specmint/contract.json

# 2. 确认 JSON 合法
cat .specmint/contract.json | python3 -m json.tool

# 3. 看 specmint 日志（debug 级）
SPECMINT_LOG=debug npx specmint generate "..."
# 应该看到：[DEBUG] contract loaded { path: '.../contract.json', elementCount: 3 }
```

### Q7：我能用 YAML 写契约吗？

**A**：当前版本只支持 JSON（结构化强、IDE 校验友好、AI 直接消费）。YAML/ TOML 等暂不支持。

### Q8：契约要不要脱敏？

**A**：契约里只放**元素标识和定位器**（testid / role / label），**不要放业务数据**（用户名、订单号、密码）。契约是入 git 的，任何敏感信息都会泄露。

### Q9：AI 生成的契约里有错怎么办？

**A**：
- 让 AI 重生成（提供更精确的提示词 / 限定输出范围）
- 手工修正后 commit
- 用 `SPECMINT_LOG=debug` 看 specmint 是否正确加载

### Q10：契约里要不要声明不可见元素（如 hidden input）？

**A**：不建议。契约是给"测试脚本要操作的元素"用的，hidden / disabled 的元素既不是用户操作目标，也不是断言目标。specmint 生成用例时不会主动操作这些元素，契约里写了反而让 LLM 困惑。

---

## 9. 与现状的对比

| 维度 | 无契约（现状） | 有契约（推荐） |
|---|---|---|
| 定位器选择 | LLM 自由发挥，按 selectorPolicy.prefer 优先级 | LLM 按契约选，契约内元素强制使用约定 |
| 命名一致性 | 不保证（不同时间/不同人生成的 testid 风格可能不同） | 完全一致（契约是单一来源） |
| 对接 AI 前端代码 | LLM 看不到前端有哪些元素，"靠猜" | LLM 看到完整元素清单，"按图施工" |
| 维护成本 | 零 | 维护一份 JSON（< 30 元素：手工；> 30 元素：AI 辅助） |
| 契约缺失行为 | — | 静默降级，行为字节级一致 |
| 对 `data-testid` 依赖度 | 弱（优先 role/label/placeholder） | 强（契约里可显式声明） |

---

## 10. 下一步

1. **起步**：用第 5 步的最简示例跑通一次，确认契约生效
2. **扩展**：根据真实项目页面，逐步扩充 `elements` 数组
3. **自动化**：用第 7 节的提示词让 AI 从前端代码提取契约
4. **集成到 CI**：把契约文件纳入 PR review（codeowners），确保改动有人 review

---

## 11. 相关资源

- specmint 主文档：[README.md](../README.md)
- specmint 使用手册：[docs/USAGE.md](./USAGE.md)
- Playwright 定位器文档：<https://playwright.dev/docs/locators>
- ARIA role 速查：<https://www.w3.org/TR/wai-aria-1.2/#role_definitions>
- `data-testid` 是否是好实践的讨论：<https://github.com/testing-library/testing-library-docs/issues/106>