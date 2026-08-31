# specmint 发布流程

> 适用人群：维护者 / Release Manager

---

## 1. 发布前检查清单

```bash
# 1. 跑全量质量门
npm run typecheck
npm run build
npm pack --dry-run                # 确认包内容（142 文件、145 KB）

# 2. 确认无遗留
git status                        # 工作树干净
cat package.json | head -10       # 确认 version 正确

# 3. 更新版本号（CHANGELOG.md 同步加新段）
npm version patch                 # 0.3.0 → 0.3.1
# 或 minor / major

# 4. 发布到 npm（默认公共 registry）
npm publish                       # 真正的发布
# 验证：npm info specmint

# 5. 提交 tag + 推仓库
git push --follow-tags
```

---

## 2. 预发布通道

```bash
# Beta / RC（带 dist-tag，安装时用 npm install specmint@beta）
npm version 0.3.1-beta.1
npm publish --tag beta
```

---

## 3. 开发态常用命令

```bash
# 开发态执行（无需编译）
npx tsx src/cli.ts <subcommand>

# 编译为 dist/
npm run build

# 跑单元 typecheck
npm run typecheck
```
