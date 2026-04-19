# 发布到 Obsidian 官方市场

本文档给插件作者看。用户不需要看这个。

## 一次性准备（只做一次）

### 1. 确认 GitHub 仓库

- 仓库名：`NPjuan/atlas`（与 manifest.json 的 id 对齐）
- 默认分支：`main`
- 仓库设为 public

### 2. 提交所有代码到 main

```bash
git add .
git commit -m "chore: prepare for Obsidian community plugin submission"
git push
```

### 3. 打第一版 Release

两种方式，选一种：

**方式 A：手动**

```bash
npm run build
git tag 0.1.0
git push --tags
```

然后到 GitHub Release 页面手动创建 release 0.1.0，上传三个 asset：
- `main.js`
- `manifest.json`
- `styles.css`

**方式 B：自动（推荐）**

本仓库已内置 `.github/workflows/release.yml`。只要推送一个纯数字 tag，会自动构建并创建 release：

```bash
git tag 0.1.0
git push --tags
```

推完 tag 后在 GitHub Actions 页面看构建进度，成功后 Release 自动出现。

### 4. 提交到 obsidian-releases

1. Fork https://github.com/obsidianmd/obsidian-releases 到你自己的 GitHub
2. 本地 clone 下来，checkout 一个新分支
3. 修改 `community-plugins.json`，**在数组末尾追加**（别破坏 JSON 语法）：

```json
{
  "id": "atlas-knowledge",
  "name": "Atlas - AI Knowledge Categorizer",
  "author": "ekkopan",
  "description": "Let AI organize your notes into a clean taxonomy and auto-sort them into folders. Build a living map of your knowledge.",
  "repo": "NPjuan/atlas"
}
```

4. commit + push + 到 GitHub 提 PR 到 `obsidianmd/obsidian-releases:master`

PR 标题：

```
Add plugin: Atlas - AI Knowledge Categorizer
```

PR 正文模板见下方【PR 模板】。

### 5. 等审核

- 自动 bot 会先跑一轮检查（几分钟内）→ 常见警告：tag 格式、asset 缺失、description 超长等
- 然后人工审核（平均 2-4 周）
- 被打回 → 修代码 → push 到你的 fork 分支 → PR 自动更新

### 6. 合并后

PR merge 后**几分钟内**全球 Obsidian 用户能在 Community Plugins 里搜到。

---

## 日常更新（每次发新版）

```bash
# 1. 改代码、写测试
# 2. 跑测试确保全绿
npm test

# 3. 自动升版本号（同步 manifest/package/versions.json）
npm run version 0.2.0

# 4. 生产构建验证
npm run build

# 5. 提交 + 打 tag + 推
git add .
git commit -m "Release 0.2.0"
git tag 0.2.0
git push && git push --tags
```

推完 tag 后 GitHub Actions 自动创建 Release。用户 Obsidian 打开时会自动拉新版，点 Update 即可升级。

**不用再改 community-plugins.json，也不用再提 PR。**

---

## 常见审核打回点自查

- [x] manifest.json 的 `id` 和 community-plugins.json 里 id 一致
- [x] `minAppVersion` 是你实际测试过的版本
- [x] `description` 英文，< 250 字符，清晰说明插件功能
- [x] 没有 `innerHTML = 用户输入` 类的 XSS
- [x] 没有 `eval` / `new Function`
- [x] 不在笔记 frontmatter 里添加自定义字段（只改 `tags`）
- [x] CSS 只用 `.mece-*` / `.atlas-*` 前缀，不污染全局
- [x] `onunload` 清理了所有监听器（用 `registerEvent` 自动清理）
- [x] API Key 不硬编码，用户设置里填
- [x] 不上传 Vault 内容到除用户配置的 AI Provider 之外的服务器
- [x] 有开源 License（MIT）
- [x] Release asset 是 `main.js / manifest.json / styles.css` 三个单独文件，不是 zip

---

## PR 模板

提交到 `obsidianmd/obsidian-releases` 时，PR 正文可以照抄这个：

```markdown
## Describe your changes

Adding Atlas - AI Knowledge Categorizer, an Obsidian plugin that uses AI to
organize your notes into a MECE taxonomy and automatically sorts them into
corresponding folders.

**Key features:**
- Scans all notes in a selected folder and asks an AI provider (Claude / OpenAI
  / DeepSeek / Ollama) to build a 3-level MECE taxonomy
- Assigns tags to each note based on the taxonomy; user reviews and confirms
  all changes before write
- Optionally moves notes into folders matching their tags (zero file
  modification otherwise — only frontmatter `tags` is touched)
- Persistent Organizer panel with drag-and-drop to reassign categories
- Force-directed graph view for browsing by tag clusters

**Data safety:**
- Note content is sent only to the AI provider the user explicitly configures
- Ollama provider runs fully local; nothing leaves the machine
- No telemetry, no third-party beacons

## Checklist before submitting a PR

- [x] I have tested the plugin on the latest version of Obsidian
- [x] My plugin complies with all items on the [developer policies](https://docs.obsidian.md/Developer+policies)
- [x] My plugin has a **unique ID** that is not already used by another plugin
- [x] The plugin does not use any closed-source / obfuscated code
- [x] The plugin does not clone existing functionality without adding value
- [x] README clearly explains what the plugin does and how to use it
- [x] manifest.json is valid and uses the correct `id`
- [x] Release includes `main.js`, `manifest.json`, `styles.css` as separate
      assets (not a zip)
```

---

## 有用的链接

- [Plugin Guidelines](https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines)
- [Developer Policies](https://docs.obsidian.md/Developer+policies)
- [Submit your plugin](https://docs.obsidian.md/Plugins/Releasing/Submit+your+plugin)
- [obsidian-releases repo](https://github.com/obsidianmd/obsidian-releases)
