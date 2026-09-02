## 项目布局（路径不可配置）

specmint 的所有产物都在 `.specmint/` 下，项目根零污染：

```
.specmint/
├── config.json                  # 配置（含 review 卡口、baseURL、auth）
├── contract.json                # 前端元素契约（可选，无则跳过相关校验）
├── cases/                       # 用例库 —— 唯一可信来源
│   ├── <group>/<name>.spec.ts   # 用例代码（标准 Playwright）
│   ├── <group>/<name>.meta.json # 元数据（优先级/模块/裁决状态/运行统计）
│   └── pages/<name>.page.ts     # Page Object（可选）
├── auth/                        # 登录态：setup.ts + storage/<role>.json
├── reports/runs/<batchId>/      # 批次产物：run.json + results.json + artifacts/
└── cache/explore/               # 探索快照缓存
```

**硬性约定**：

- 路径**不可配置** —— 不提供改 root / casesDir / reportsDir 的选项（减少决策成本、避免团队内配置漂移）
- 用例名与物理目录一致：`auth/login-success` → `cases/auth/login-success.spec.ts`，`group` 必须等于用例名第一段
- `pages/` 下的文件是 Page Object，不是用例，不会被收集执行
- **用例产物就是标准 Playwright TS 文件** —— specmint 不引入任何自然语言中间层（不是 Cucumber / Gherkin）。用确定的代码逻辑表达断言，不用自然语言描述步骤。
- 产物可整体退出：删掉 `.specmint/` 后，`cases/` 下的 `.spec.ts` 仍是任何 Playwright 项目可直接执行的普通测试文件

**元数据 meta.json 关键字段**（由 `specmint adopt` 生成，不要手改）：

| 字段 | 说明 |
|---|---|
| `priority` | P0/P1/P2/P3，必填，冒烟集靠它筛选 |
| `group` / `module` | 功能分组（kebab-case）/ 模块中文名，用于检索与报告归类 |
| `linkedTickets` | 关联需求单号 |
| `auth` | 关联的登录态角色 |
| `review.verdict` | 裁决状态，决定能否被执行（见 operate skill） |
| `contentHash` | 用例内容哈希，用于检测「已审核用例被改动」 |
