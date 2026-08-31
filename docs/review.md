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
