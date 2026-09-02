# specmint 人工裁决（review / verdict）

> 适用版本：specmint v0.3.0+
> 适用人群：建立用例审核流程的团队负责人 / CI 维护者

`review` 把人工仲裁从「写个字段」升级为运行时执行关卡：裁决结果（verdict）直接决定 `run` / `heal` 是否放行某个用例，避免未审核 / 待修复 / 已废弃的用例污染 CI 产物。

---

## 1. 状态机

```
pending ──[a]pprove──→ approved ──[r]eject──→ rejected ──(人工回归)
   │                      │
   │                      └─[n]eeds-fix──→ needs-fix ──(heal)──┐
   ├─[s]kip────────────→ skipped (历史保留)                    │
   │                     ↑                                      │
   └─────────────────────┴──────────[ 任何 ]──────────────────┘
```

verdict 状态机共 5 态：`pending` / `approved` / `needs-fix` / `rejected` / `skipped`。

---

## 2. 与 run / heal 的联动

| 命令 | 默认行为 | 放宽标志 |
|---|---|---|
| `specmint run` | 仅跑 `verdict=approved` | `--include-pending` / `--include-needs-fix` / `--include-rejected` / `--force` / `--no-require-review` |
| `specmint rerun` | 与 run 一致 | 与 run 一致 |
| `specmint heal` | 仅修 `verdict=needs-fix` | `--include-pending` / `--include-approved` / `--include-rejected` / `--force` / `--no-require-review` |

> **v0.5.2+ 行为明确**（v0.5.1 及更早的实现与上表不一致，属实现 bug，v0.5.2 已修复）：
>
> - **全量跑与派生分支都走卡口**：裸 `specmint run`（无参数）以及 `--priority` / `--auth` / `--module` / `--group` 派生分支，此前在卡口开启时会报 `No tests found` 或绕过卡口把 pending / needs-fix / rejected 一起跑掉；v0.5.2 起与上表一致。
> - **嵌套同名用例互不串扰**：`login-success` 与 `auth/login-success` 是两个独立用例，`specmint run login-success` 只跑根级那条，不会连带执行 `auth/login-success`（反之亦然）。
> - **单文件直传走同一套卡口**：`specmint run .specmint/cases/x.spec.ts`、绝对路径、Windows 反斜杠路径都能正确反查 verdict（此前这些形式会被静默跳过检查）。

### 2.1 关键卡口强化（v0.6.0+）

v0.6.0 起围绕「审核可信度」与「失败关闭（fail-closed）」做了三类卡口硬化，配套新命令 `specmint adopt` / `specmint lint`：

**1. 未纳管文件拒绝执行（fail-closed）**

旧行为：`run` 把「无 meta.json 的 spec 文件」当成「不需要裁决也能跑」静默放行 —— 这是 fail-open 漏洞，等于绕过整个裁决流程。

v0.6.0 行为：任何路径形态（单文件、glob、绝对路径、反斜杠）只要不在 `caseStore`（=无 meta.json），**拒绝执行**并退出码 4（NOT_FOUND），提示「先用 `specmint adopt <file> --priority P0` 纳管」。

> 这一改让 `specmint adopt` 不再是「可选的便利命令」而是 **run 路径的必要前置**：不纳管就不可能跑。这是把卡口语义从「过滤已纳管用例」升级为「未纳管用例一律不可见」。

**2. 审核可信度：内容变更自动回落 pending**

`meta.json` 新增 `contentHash = sha256(spec.ts).slice(0,16)`，每次 `adopt` 时重新计算：

- 用例内容未变 → 保留原 verdict（包括 approved）
- 内容变化（哪怕只加一行注释） → verdict 自动回落 `pending`，`review.reviewer` / `reviewedAt` 清空

逃生舱：`adopt --keep-verdict`（CI 重纳管场景不强制回落）。

**3. 重复告警去重 + 提示语改进**

`run` 在 verdict 卡口与单文件匹配两个分支都会触发 `list()`，旧实现每次调用都重复打「缺 meta.json」warning，5 条用例触发 10+ 行刷屏。v0.6.0 用进程级 Set 去重，且提示语改为：

> `用例 X 缺少 meta.json，已跳过（纳管：specmint adopt <file> --priority P0）`

——直接把可执行的下一步告诉 agent / 用户。

---

## 3. REPL 翻页裁决（默认入口）

```bash
$ specmint review
[1/12] auth/login-success                       pending
  spec: 用户在登录页输入正确的账号密码，点击登录，跳转到首页
  > 选择裁决 [a/p/n/r/s/q]: _
```

单键裁决：`a` approved / `n` needs-fix / `r` rejected / `s` skipped / `q` 退出。逐条翻页，无需重新加载列表。

REPL 默认只看 `verdict=pending`。想重新翻已裁决项（重审）：

```bash
specmint review --include-decided   # REPL 翻全部（含 approved/needs-fix/rejected）
```

非 TTY（脚本/CI 场景）自动降级为 `specmint review list`，可加 `--all` 查看全部：

---

## 4. 脚本 / CI 场景

```bash
# 单条裁决
specmint review set auth/login-success --verdict approved --reviewer alice
specmint review set auth/login-failure --verdict needs-fix --reason "selector 飘"

# 批量过滤
specmint review list --verdict needs-fix

# 查看详情
specmint review show auth/login-success
```

---

## 5. 配置

```jsonc
{
  "review": {
    "requireBeforeRun":  true,                              // run 卡口开关
    "requireBeforeHeal": true,                              // heal 卡口开关
    "pendingOnGenerate": true,                              // generate 后是否提示进入 review REPL
    "reviewerSource":    "git-user",                        // 默认裁决人来源：git-user / env / none
    "blockedOnRun":      ["pending", "needs-fix", "rejected"],
    "blockedOnHeal":     ["pending", "approved", "rejected", "skipped"]
  }
}
```

完全关闭卡口（回到 v0.2.0 老行为）：

```jsonc
{
  "review": {
    "requireBeforeRun":  false,
    "requireBeforeHeal": false
  }
}
```

或在运行时加 `--no-require-review` / `--force`。

---

## 6. 回滚到 v0.2.0 老行为

如果 CI 突然少跑用例，或团队还没建立 review 流程，可在 `.specmint/config.json` 中：

```jsonc
{ "review": { "requireBeforeRun": false, "requireBeforeHeal": false } }
```

无需改任何代码，所有 v0.2.0 的命令 / 标志 / 行为都保留。
