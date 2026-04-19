# 分享 Atlas 给朋友

> 这个教程给**你的朋友看**——教他们怎么把 Atlas 装进自己的 Obsidian，不需要任何技术背景。
>
> 如果你想把插件上架 Obsidian 官方市场（让所有人都能搜到），看 [PUBLISHING.md](./PUBLISHING.md)。

---

## 方式一：给朋友发压缩包（最简单）

### 你要做的

1. 把项目根目录的这个压缩包发给朋友：

   ```
   atlas-knowledge.zip
   ```

   里面只有 3 个文件：`main.js`、`manifest.json`、`styles.css`。

2. 把下面这段「朋友安装指南」一起发过去。

### 朋友要做的（复制下面这段发给他）

> 🎉 **Atlas 插件安装指南**
>
> Atlas 是一个 Obsidian 插件，让 AI 自动把你的笔记分类整理。
>
> **步骤**：
>
> 1. 下载 `atlas-knowledge.zip`，解压
> 2. 打开 Obsidian，在任何一个 Vault 里：
>    - **Mac**：`Cmd+,` 打开设置 → 左侧选「关于」→ 找到「Vault 位置」旁边的文件夹图标，点开
>    - **Windows**：`Ctrl+,` → 同上
> 3. 进入 `.obsidian/plugins/` 目录（没有就新建一个）
> 4. 在里面新建一个叫 `atlas-knowledge` 的文件夹
> 5. 把刚才解压得到的 3 个文件（`main.js`、`manifest.json`、`styles.css`）**全部放进去**
> 6. 回到 Obsidian：设置 → 第三方插件 → 如果看到「安全模式」开着就先关掉 → **刷新已安装的插件列表**
> 7. 在列表里找到 **Atlas - AI Knowledge Categorizer**，打开右边的开关
> 8. 左侧边栏会出现一个 🪄 图标，点它打开整理面板
>
> **第一次使用**：
>
> 1. 进入 Atlas 的空状态页面，点「配置 AI 服务」
> 2. 选一个 AI Provider（推荐 **DeepSeek**，便宜又快；或 **Ollama** 本地免费）
> 3. 填 API Key（DeepSeek 在 https://platform.deepseek.com 注册）
> 4. 回到面板点「开始」—— AI 会自动扫描你的笔记并建立分类体系
>
> **界面语言**：设置 → Atlas → 界面语言（中/英/跟随 Obsidian）
>
> 有问题随时问我！

---

